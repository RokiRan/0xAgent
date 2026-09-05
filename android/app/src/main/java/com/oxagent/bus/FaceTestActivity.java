package com.oxagent.bus;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.mlkit.vision.face.Face;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 本地人脸检测可视化测试页（前置摄像头）：
 * TextureView 实时预览 + ImageReader JPEG 分析帧 → FaceHelper.detect（端侧、离线）
 * → overlay 画框与「正注视/未注视」判定（阈值与 camera_face 工具同一来源）。
 * 竖屏锁定，预览拉伸铺满——检测框与画面共用同一线性映射，天然对齐。
 */
public class FaceTestActivity extends Activity {

    private static final int C_BG = 0xFF000000;
    private static final int C_TEXT = 0xFFF0F0F0;
    private static final int REQ_PERM = 42;

    private TextureView preview;
    private OverlayView overlay;
    private FrameLayout root;
    private FrameLayout previewBox; // 按画面真实比例信箱式居中，黑边由 root 底色兜底
    private TextView status;
    private HandlerThread bg;
    private Handler bgHandler;
    private CameraDevice device;
    private CameraCaptureSession session;
    private ImageReader reader;
    private volatile boolean busy; // 上一帧还在检测就丢新帧，不排队
    private int frameSeq;
    private int sensorOrientation = 270;
    /** 重力实测的物理朝向（0/90/180/270）。显示被竖屏锁定时 display rotation 恒 0，不可信。 */
    private volatile int deviceDeg = 0;
    private android.view.OrientationEventListener orientationListener;
    /** 最近一次虹膜视线分析结果（bg 线程写，UI 线程读）。 */
    private volatile MeshHelper.Gaze lastMesh;
    private int meshMs;
    /** 进页面前 gaze listener 是否在跑（退出时按开关恢复）。 */
    private boolean gazeWasRunning;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        // 独占冲突：持续注视监听持着前置相机时，本页打不开/被抢回（预览冻住）。
        // 进页面先停掉它，退出时按开关恢复。
        gazeWasRunning = GazeListener.running();
        if (gazeWasRunning) {
            // 异步停：shutdown 里若正在听写会 join 录音线程 + asr 收尾解码，UI 线程直调有 ANR 风险
            new Thread(GazeListener::stop, "gaze-pause").start();
            L.log("进入人脸测试页，已暂停持续注视监听");
        }
        root.setBackgroundColor(C_BG);

        preview = new TextureView(this);
        overlay = new OverlayView(this);
        status = new TextView(this);
        status.setTextColor(C_TEXT);
        status.setTextSize(14);
        status.setPadding(dp(12), dp(8), dp(12), dp(8));
        status.setText("初始化相机…");
        TextView hint = new TextView(this);
        hint.setTextColor(0xFF9AA4B2);
        hint.setTextSize(11);
        hint.setPadding(dp(12), 0, dp(12), dp(8));
            hint.setText("绿框=正注视（|Y|<15° |X|<20° 且双眼睁开>0.6），红框=未注视。前置画面为自拍镜像，按传感器真实比例信箱显示。");
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM);

        // 预览与 overlay 装进同一信箱盒子：盒子按内容真实比例（分析帧经转正后）定尺寸，
        // 两者仍共享同一线性映射，检测框对齐关系不变
        previewBox = new FrameLayout(this);
        previewBox.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        previewBox.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(previewBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(status);
        root.addView(hint, hintLp);
        setContentView(root);

        bg = new HandlerThread("face-test");
        bg.start();
        bgHandler = new Handler(bg.getLooper());
        orientationListener = new android.view.OrientationEventListener(this) {
            @Override public void onOrientationChanged(int orientation) {
                if (orientation == ORIENTATION_UNKNOWN) return; // 平放时保留上次值
                deviceDeg = ((orientation + 45) / 90 * 90) % 360;
            }
        };
        if (orientationListener.canDetectOrientation()) orientationListener.enable();

        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) { if (gazeWasRunning) preview.postDelayed(() -> openCamera(), 800); // 等注视监听释放相机
                else openCamera(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { closeCamera(); return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) {}
        });
    }

    @Override
    protected void onDestroy() {
        closeCamera();
        // 退出恢复注视监听（以开关当前值为准：用户在页内改了开关就尊重新值）
        boolean wantOn = "1".equals(getSharedPreferences("cfg", MODE_PRIVATE)
                .getString("gazeListen", "0"));
        if (gazeWasRunning && wantOn && !GazeListener.running()) {
            GazeListener.start(this);
            L.log("退出人脸测试页，已恢复持续注视监听");
        }
        if (bg != null) bg.quitSafely();
        if (orientationListener != null) orientationListener.disable();
        super.onDestroy();
    }

    private void openCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM);
            return;
        }
        try {
            CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
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
            if (camId == null) { status.setText("找不到前置摄像头"); return; }

            StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            // YUV 而非 JPEG：免 HAL 编码 stall、免解码、免位图旋转（detectFast 零拷贝直读）
            Size[] yuvSizes = map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888);
            // 分析帧取 ≤640 宽的最大尺寸：检测够准、帧率够高
            Size ana = null;
            for (Size s : yuvSizes) {
                if (s.getWidth() <= 640 && (ana == null || s.getWidth() > ana.getWidth())) ana = s;
            }
            if (ana == null) ana = yuvSizes[yuvSizes.length - 1]; // 没有小尺寸就取最小
            for (Size s : yuvSizes) {
                if (ana.getWidth() > 640 && s.getWidth() < ana.getWidth()) ana = s;
            }
            // 预览流必须与分析帧同宽高比：FOV 一致，检测框的线性拉伸映射才成立
            double targetAspect = (double) ana.getWidth() / ana.getHeight();
            Size prev = map.getOutputSizes(SurfaceTexture.class)[0];
            for (Size s : map.getOutputSizes(SurfaceTexture.class)) {
                double da = Math.abs((double) s.getWidth() / s.getHeight() - targetAspect);
                double db = Math.abs((double) prev.getWidth() / prev.getHeight() - targetAspect);
                if (da < db || (da == db && s.getWidth() > prev.getWidth() && s.getWidth() <= 1600)) prev = s;
            }

            // 检测器转正角度 = 传感器安装角 + 重力实测物理朝向（与 CameraX 公式等价：
            // sensorOrientation - displayDeg，displayDeg=(360-deviceDeg)%360）。
            // 页面竖屏锁定但手机可能物理横放，display rotation 不可信，必须听重力。
            // 框坐标仍在原始帧坐标系，与预览的拉伸映射一致。
            sensorOrientation = ch.get(CameraCharacteristics.SENSOR_ORIENTATION);
            L.log("face test: sensor=" + sensorOrientation
                    + " ana=" + ana.getWidth() + "x" + ana.getHeight());

            reader = ImageReader.newInstance(ana.getWidth(), ana.getHeight(),
                    android.graphics.ImageFormat.YUV_420_888, 3);
            reader.setOnImageAvailableListener(r -> {
                Image img = r.acquireLatestImage();
                if (img == null) return;
                if (busy) { img.close(); return; }
                busy = true;
                bgHandler.post(() -> {
                    long t0 = System.currentTimeMillis();
                    try {
                        List<Face> faces = FaceHelper.detectFast(img, (sensorOrientation + deviceDeg) % 360);
                        long ms = System.currentTimeMillis() - t0;
                        int n = faces == null ? -1 : faces.size();
                        if ((++frameSeq % 20 == 0) || ms > 200 || n != 0)
                            L.log("fast detect " + ms + "ms faces=" + n
                                    + " rot=" + ((sensorOrientation + deviceDeg) % 360));
                        // 虹膜视线分析：有人脸时每 3 帧跑一次（YUV→位图有成本，数值变化慢不需要满帧率）
                        if (n > 0 && frameSeq % 3 == 0) {
                            long m0 = System.currentTimeMillis();
                            android.graphics.Bitmap upright = uprightBitmap(img,
                                    (sensorOrientation + deviceDeg) % 360);
                            if (upright != null) {
                                MeshHelper.Gaze g = MeshHelper.analyze(FaceTestActivity.this, upright);
                                meshMs = (int) (System.currentTimeMillis() - m0);
                                if (g != null) {
                                    lastMesh = g;
                                    L.log("mesh " + meshMs + "ms " + g);
                                }
                            }
                        }
                        // ML Kit 框在转正后坐标系（rawbox 与截图配对实测验证 + 用户观察转置现象）：
                        // rot 90/270 时帧宽高互换即为 overlay 的映射尺寸，坐标本身不用再转
                        int w = img.getWidth(), h = img.getHeight();
                        int rot2 = (sensorOrientation + deviceDeg) % 360;
                        int uw = rot2 % 180 != 0 ? h : w;
                        int uh = rot2 % 180 != 0 ? w : h;
                        runOnUiThread(() -> showFaces(faces, uw, uh, rot2));
                    } finally {
                        img.close();
                        busy = false;
                    }
                });
            }, bgHandler);

            SurfaceTexture st = preview.getSurfaceTexture();
            st.setDefaultBufferSize(prev.getWidth(), prev.getHeight());
            Surface surface = new Surface(st);

            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    device = d;
                    try {
                        CaptureRequest.Builder req = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        req.addTarget(surface);
                        req.addTarget(reader.getSurface());
                        req.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
                        req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                        d.createCaptureSession(Arrays.asList(surface, reader.getSurface()),
                                new CameraCaptureSession.StateCallback() {
                                    @Override public void onConfigured(CameraCaptureSession s) {
                                        session = s;
                                        try {
                                            s.setRepeatingRequest(req.build(), null, bgHandler);
                                            runOnUiThread(() -> status.setText("等待人脸…"));
                                        } catch (Exception e) {
                                            runOnUiThread(() -> status.setText("预览失败: " + e.getMessage()));
                                        }
                                    }
                                    @Override public void onConfigureFailed(CameraCaptureSession s) {
                                        runOnUiThread(() -> status.setText("相机会话配置失败"));
                                    }
                                }, bgHandler);
                    } catch (Exception e) {
                        runOnUiThread(() -> status.setText("打开失败: " + e.getMessage()));
                    }
                }
                @Override public void onDisconnected(CameraDevice d) {
                    d.close();
                    runOnUiThread(() -> status.setText("相机被断开（可能被持续注视监听抢走，请重进本页）"));
                }
                @Override public void onError(CameraDevice d, int e) {
                    d.close();
                    runOnUiThread(() -> status.setText("相机错误 " + e + "（可能被其他应用占用）"));
                }
            }, bgHandler);
        } catch (Exception e) {
            status.setText("相机异常: " + e.getMessage());
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        if (code == REQ_PERM && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
            openCamera();
        } else {
            status.setText("无相机权限（adb shell pm grant com.oxagent.bus android.permission.CAMERA）");
        }
    }

    private void showFaces(List<Face> faces, int frameW, int frameH, int rot) {
        fitPreviewBox(frameW, frameH); // 入参已是转正后尺寸
        if (faces == null) { status.setText("检测失败/超时（见日志）"); return; }
        overlay.setFaces(faces, frameW, frameH, rot);
        if (faces.isEmpty()) { status.setText("画面中无人脸"); return; }
        int looking = 0;
        for (Face f : faces) if (FaceHelper.lookingAtCamera(f)) looking++;
        String head = "检测到 " + faces.size() + " 张人脸 → "
                + (looking > 0 ? looking + " 人正注视镜头" : "没有人看镜头");
        MeshHelper.Gaze g = lastMesh;
        if (g != null) head += "\n虹膜 " + g + " (" + meshMs + "ms)";
        status.setText(head);
    }

    private void closeCamera() {
        try { if (session != null) session.close(); } catch (Exception ignored) {}
        session = null;
        try { if (device != null) device.close(); } catch (Exception ignored) {}
        device = null;
        final ImageReader r = reader;
        reader = null;
        if (r != null) {
            // 先摘监听挡新帧，再把 close 排进分析线程：在途持帧任务跑完才关 reader，
            // 否则主线程直接 close 会让任务里的 img 失效（Image is already closed 崩溃）
            r.setOnImageAvailableListener(null, null);
            if (bgHandler != null) bgHandler.post(r::close);
            else r.close();
        }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
    /** YUV 分析帧 → 旋正位图：实现收在 MeshHelper.fromYuv（GazeListener 共用）。 */
    private static android.graphics.Bitmap uprightBitmap(Image img, int rotationDegrees) {
        return MeshHelper.fromYuv(img, rotationDegrees);
    }
    /** 信箱式适配：按转正后内容真实宽高比缩放 previewBox 居中，消除整屏拉伸。入参已是转正后尺寸。 */
    private void fitPreviewBox(int cw, int ch) {
        if (root == null || previewBox == null) return;
        int vw = root.getWidth(), vh = root.getHeight();
        if (vw == 0 || vh == 0 || cw == 0 || ch == 0) return;
        double s = Math.min((double) vw / cw, (double) vh / ch);
        int bw = (int) (cw * s + 0.5), bh = (int) (ch * s + 0.5);
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) previewBox.getLayoutParams();
        if (lp.width != bw || lp.height != bh) {
            lp.width = bw;
            lp.height = bh;
            lp.gravity = android.view.Gravity.CENTER;
            previewBox.setLayoutParams(lp);
        }
    }

    /** 检测框 overlay：ML Kit 框在转正后坐标系，x 按前置自成像镜像翻转后与帧尺寸线性映射到 previewBox。 */
    private static final class OverlayView extends View {
        private final Paint boxPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private List<Face> faces = Collections.emptyList();
        private int frameW = 1, frameH = 1, rot;

        OverlayView(Context ctx) {
            super(ctx);
            boxPaint.setStyle(Paint.Style.STROKE);
            boxPaint.setStrokeWidth(4f);
            textPaint.setTextSize(30f);
            textPaint.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        }

        void setFaces(List<Face> faces, int frameW, int frameH, int rot) {
            this.faces = faces == null ? Collections.<Face>emptyList() : faces;
            this.frameW = frameW;
            this.frameH = frameH;
            this.rot = rot;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            for (int i = 0; i < faces.size(); i++) {
                Face f = faces.get(i);
                boolean looking = FaceHelper.lookingAtCamera(f);
                int color = looking ? 0xFF2ECC71 : 0xFFE74C3C;
                boxPaint.setColor(color);
                textPaint.setColor(color);
                Rect b = f.getBoundingBox();
                float sx = (float) getWidth() / frameW;
                float sy = (float) getHeight() / frameH;
                // 前置预览相对 ML Kit 转正坐标系是水平镜像的（实测：头左移框右移）→ x 翻转
                RectF r = new RectF((frameW - b.right) * sx, b.top * sy,
                        (frameW - b.left) * sx, b.bottom * sy);
                canvas.drawRect(r, boxPaint);
                Float le = f.getLeftEyeOpenProbability();
                Float re = f.getRightEyeOpenProbability();
                String label = "#" + (i + 1)
                        + " Y=" + (int) f.getHeadEulerAngleY() + "° X=" + (int) f.getHeadEulerAngleX() + "°"
                        + " 眼" + (le == null ? "?" : String.format(java.util.Locale.US, "%.2f", le))
                        + "/" + (re == null ? "?" : String.format(java.util.Locale.US, "%.2f", re))
                        + (looking ? " 正注视" : " 未注视");
                // 文字带底色保证在任意画面上可读
                float tw = textPaint.measureText(label);
                float ty = Math.max(r.top - 10, 40);
                canvas.drawRect(r.left, ty - 34, r.left + tw + 16, ty + 8, boxPaint);
                textPaint.setColor(0xFF000000);
                canvas.drawText(label, r.left + 8, ty, textPaint);
                textPaint.setColor(color);
            }
        }
    }
}
