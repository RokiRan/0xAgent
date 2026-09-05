package com.oxagent.bus;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Size;
import android.view.OrientationEventListener;

import com.google.mlkit.vision.face.Face;

import java.util.Collections;
import java.util.List;

/**
 * 持续注视监听（配置页开关 gazeListen）：前置相机常开跑 FaceHelper.detectFast，
 * 连续注视 ≥200ms 开始端侧流式听写（sherpa），连续 ≥500ms 不注视判定「说完了」，
 * 最终文字落日志。
 * 注意：开启期间独占前置相机，camera_look/camera_face 工具和 FaceTestActivity 会打不开相机（二选一）。
 */
public class GazeListener {

    private static final long START_MS = 200;          // 持续注视这么久 → 起录
    private static final long END_MS = 500;            // 持续不注视这么久 → 说完
    private static final long FRAME_TOLERANCE_MS = 450; // 帧间隔容差：小于它算注视未中断（虹膜版单帧 ~250-350ms，必须 < END_MS）

    private static GazeListener active;

    public static synchronized void start(Context ctx) {
        if (active != null) return;
        active = new GazeListener(ctx.getApplicationContext());
        active.launch();
    }

    public static synchronized void stop() {
        if (active == null) return;
        active.shutdown();
        active = null;
    }
    public static synchronized boolean running() {
        return active != null;
    }

    private final Context ctx;
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private OrientationEventListener oel;
    private int sensorOrientation = 270;
    private volatile int deviceDeg = 0;
    private volatile boolean closed;

    /** 最近一次检测到「正注视」的时间（uptimeMillis）；0=从未。帧回调唯一写者。 */
    private volatile long lastGazeAt;
    /** 最近一次虹膜分析与其时间。新鲜（<600ms）且头正时用严格判据，头偏时宽松放行。 */
    private volatile MeshHelper.Gaze lastMesh;
    private volatile long lastIrisAt;
    private long gazeSince;
    private boolean listening;
    private AsrHelper.Session asr;
    private Thread audioThread;
    private volatile boolean audioRun;

    private GazeListener(Context ctx) {
        this.ctx = ctx;
    }

    private void launch() {
        thread = new HandlerThread("gaze-listen");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::init);
    }

    private void init() {
        if (ctx.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            L.log("gaze listener: 缺相机/麦克风权限（adb shell pm grant com.oxagent.bus android.permission.CAMERA android.permission.RECORD_AUDIO）");
            abort();
            return;
        }
        if (!AsrHelper.available(ctx)) {
            L.log("gaze listener: sherpa asr 不可用，无法听写");
            abort();
            return;
        }
        oel = new OrientationEventListener(ctx) {
            @Override public void onOrientationChanged(int orientation) {
                if (orientation == ORIENTATION_UNKNOWN) return;
                deviceDeg = ((orientation + 45) / 90 * 90) % 360;
            }
        };
        if (oel.canDetectOrientation()) oel.enable();
        L.log("gaze listener on（注视 " + START_MS + "ms 起录 / 移开 " + END_MS + "ms 结束）");
        openCamera();
        handler.postDelayed(this::tick, 250);
    }

    /** 初始化失败：自我了断并清 static，之后重新打开开关可重试。 */
    private void abort() {
        shutdown();
        synchronized (GazeListener.class) {
            if (active == this) active = null;
        }
    }

    private void openCamera() {
        try {
            CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
            String camId = null;
            CameraCharacteristics ch = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) {
                    camId = id;
                    ch = c;
                    break;
                }
            }
            if (camId == null) { L.log("gaze listener: 找不到前置摄像头"); scheduleRetry(); return; }

            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size[] yuvSizes = map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888);
            // 分析帧取 ≤640 宽的最大尺寸：检测够准、帧率够高（与 FaceTestActivity 同一选法）
            Size ana = null;
            for (Size s : yuvSizes) {
                if (s.getWidth() <= 640 && (ana == null || s.getWidth() > ana.getWidth())) ana = s;
            }
            if (ana == null) {
                ana = yuvSizes[0];
                for (Size s : yuvSizes) if (s.getWidth() < ana.getWidth()) ana = s;
            }
            sensorOrientation = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);

            reader = ImageReader.newInstance(ana.getWidth(), ana.getHeight(),
                    android.graphics.ImageFormat.YUV_420_888, 3);
            reader.setOnImageAvailableListener(r -> {
                Image img = r.acquireLatestImage();
                if (img == null) return;
                try {
                    int rot = (sensorOrientation + deviceDeg) % 360;
                    List<Face> faces = FaceHelper.detectFast(img, rot);
                    boolean headLooking = false, headStraight = false, eyesOpen = false;
                    if (faces != null) {
                        for (Face f : faces) {
                            if (FaceHelper.lookingAtCamera(f)) headLooking = true;
                            if (FaceHelper.headStraight(f)) headStraight = true;
                            if (FaceHelper.eyesOpen(f)) eyesOpen = true;
                        }
                    }
                    // 头眼分离（5 组姿势实测调参）：有人脸就跑 landmarker 取虹膜。
                    // 头正 → 严格判据（下瞟/上瞟/转眼全切开）；头偏 → 虹膜失真宽松放行
                    // （修「头偏眼回看」盲区）；landmarker 不可用 → 头姿态兜底
                    if (faces != null && !faces.isEmpty()) {
                        android.graphics.Bitmap upright = MeshHelper.fromYuv(img, rot);
                        if (upright != null) {
                            MeshHelper.Gaze g = MeshHelper.analyze(ctx, upright);
                            if (g != null && g.points > 473) {
                                lastMesh = g;
                                lastIrisAt = SystemClock.uptimeMillis();
                            }
                        }
                    }
                    long now = SystemClock.uptimeMillis();
                    boolean gazing;
                    MeshHelper.Gaze g = lastMesh;
                    if (g != null && now - lastIrisAt < 600 && faces != null && !faces.isEmpty()) {
                        gazing = eyesOpen && (headStraight ? g.irisStrict() : true);
                    } else {
                        gazing = headLooking;
                    }
                    if (gazing) lastGazeAt = now;
                    evalState();
                } finally {
                    img.close();
                }
            }, handler);

            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    device = d;
                    try {
                        CaptureRequest.Builder req = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        req.addTarget(reader.getSurface());
                        req.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
                        req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                        d.createCaptureSession(Collections.singletonList(reader.getSurface()),
                                new CameraCaptureSession.StateCallback() {
                                    @Override public void onConfigured(CameraCaptureSession s) {
                                        session = s;
                                        try {
                                            s.setRepeatingRequest(req.build(), null, handler);
                                            L.log("gaze listener: 前置相机已开，盯人中");
                                        } catch (Exception e) {
                                            L.log("gaze listener: 预览请求失败 " + e.getMessage());
                                            scheduleRetry();
                                        }
                                    }
                                    @Override public void onConfigureFailed(CameraCaptureSession s) {
                                        L.log("gaze listener: 相机会话配置失败");
                                        scheduleRetry();
                                    }
                                }, handler);
                    } catch (Exception e) {
                        L.log("gaze listener: 会话创建失败 " + e.getMessage());
                        scheduleRetry();
                    }
                }
                @Override public void onDisconnected(CameraDevice d) {
                    d.close();
                    device = null;
                    if (!closed) { L.log("gaze listener: 相机被断开"); scheduleRetry(); }
                }
                @Override public void onError(CameraDevice d, int e) {
                    d.close();
                    device = null;
                    if (!closed) {
                        L.log("gaze listener: 相机错误 " + e + "（可能被测试页/camera 工具占用）");
                        scheduleRetry();
                    }
                }
            }, handler);
        } catch (Exception e) {
            L.log("gaze listener: 相机异常 " + e.getMessage());
            scheduleRetry();
        }
    }

    private void scheduleRetry() {
        closeCameraOnly();
        if (!closed) handler.postDelayed(() -> { if (!closed) openCamera(); }, 5000);
    }

    /** 状态机：帧回调和 250ms tick 都调（帧断流时 tick 兜底结束听写）。 */
    private void evalState() {
        if (closed) return;
        long now = SystemClock.uptimeMillis();
        boolean gazing = lastGazeAt != 0 && now - lastGazeAt <= FRAME_TOLERANCE_MS;
        if (!listening) {
            if (gazing) {
                if (gazeSince == 0) {
                    gazeSince = now;
                } else if (now - gazeSince >= START_MS) {
                    beginListen();
                }
            } else {
                gazeSince = 0;
            }
        } else if (!gazing && now - lastGazeAt >= END_MS) {
            endListen();
        }
    }

    private void tick() {
        evalState();
        if (!closed) handler.postDelayed(this::tick, 250);
    }

    private void beginListen() {
        gazeSince = 0;
        asr = AsrHelper.beginSession(ctx);
        if (asr == null) {
            L.log("gaze listener: asr 会话创建失败，监听停止");
            abort();
            return;
        }
        listening = true;
        L.log("gaze: 持续注视 " + START_MS + "ms，开始听写");
        audioRun = true;
        audioThread = new Thread(() -> {
            int rate = 16000;
            int min = AudioRecord.getMinBufferSize(rate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord rec = new AudioRecord(MediaRecorder.AudioSource.MIC, rate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(min, rate));
            try {
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                    L.log("gaze: 麦克风初始化失败");
                    return;
                }
                rec.startRecording();
                byte[] buf = new byte[3200]; // 100ms
                while (audioRun) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n > 0) {
                        AsrHelper.Session s = asr;
                        if (s != null) s.feed(buf, n);
                    }
                }
                rec.stop();
            } catch (Exception e) {
                L.log("gaze: 录音异常 " + e.getMessage());
            } finally {
                rec.release();
            }
        }, "gaze-mic");
        audioThread.start();
    }

    private void endListen() {
        listening = false;
        audioRun = false;
        if (audioThread != null) {
            try { audioThread.join(1500); } catch (InterruptedException ignored) {}
            audioThread = null;
        }
        String text = null;
        if (asr != null) {
            try { text = asr.finish(); } catch (Throwable t) { L.log("gaze: asr 收尾失败 " + t); }
            asr.release();
            asr = null;
        }
        L.log("gaze: 移开 " + END_MS + "ms，结束听写");
        text = text == null ? "" : text.trim();
        L.log("gaze 听到：" + (text.isEmpty() ? "（没听清/无人说话）" : text));
    }

    private void closeCameraOnly() {
        try { if (session != null) session.close(); } catch (Exception ignored) {}
        session = null;
        try { if (device != null) device.close(); } catch (Exception ignored) {}
        device = null;
        try { if (reader != null) reader.close(); } catch (Exception ignored) {}
        reader = null;
    }

    private synchronized void shutdown() {
        if (closed) return;
        closed = true;
        if (listening) endListen();
        closeCameraOnly();
        if (oel != null) oel.disable();
        if (thread != null) thread.quitSafely();
        L.log("gaze listener off");
    }
}
