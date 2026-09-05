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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
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
            hint.setText("绿框=正注视（|Y|<15° |X|<20° 且双眼睁开>0.6），红框=未注视。前置画面未镜像，按传感器比例拉伸显示。");
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM);

        root.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(overlay, new FrameLayout.LayoutParams(
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
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) { openCamera(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { closeCamera(); return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) {}
        });
    }

    @Override
    protected void onDestroy() {
        closeCamera();
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
                        int w = img.getWidth(), h = img.getHeight();
                        runOnUiThread(() -> showFaces(faces, w, h));
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
                @Override public void onDisconnected(CameraDevice d) { d.close(); }
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

    private void showFaces(List<Face> faces, int frameW, int frameH) {
        if (faces == null) { status.setText("检测失败/超时（见日志）"); return; }
        overlay.setFaces(faces, frameW, frameH);
        if (faces.isEmpty()) { status.setText("画面中无人脸"); return; }
        int looking = 0;
        for (Face f : faces) if (FaceHelper.lookingAtCamera(f)) looking++;
        status.setText("检测到 " + faces.size() + " 张人脸 → "
                + (looking > 0 ? looking + " 人正注视镜头" : "没有人看镜头"));
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

    /** 检测框 overlay：坐标系 = 旋正后的分析帧，线性拉伸到视图（预览同规则拉伸，天然对齐）。 */
    private static final class OverlayView extends View {
        private final Paint boxPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private List<Face> faces = Collections.emptyList();
        private int frameW = 1, frameH = 1;

        OverlayView(Context ctx) {
            super(ctx);
            boxPaint.setStyle(Paint.Style.STROKE);
            boxPaint.setStrokeWidth(4f);
            textPaint.setTextSize(30f);
            textPaint.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        }

        void setFaces(List<Face> faces, int frameW, int frameH) {
            this.faces = faces == null ? Collections.<Face>emptyList() : faces;
            this.frameW = frameW;
            this.frameH = frameH;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float sx = (float) getWidth() / frameW;
            float sy = (float) getHeight() / frameH;
            for (int i = 0; i < faces.size(); i++) {
                Face f = faces.get(i);
                boolean looking = FaceHelper.lookingAtCamera(f);
                int color = looking ? 0xFF2ECC71 : 0xFFE74C3C;
                boxPaint.setColor(color);
                textPaint.setColor(color);
                Rect b = f.getBoundingBox();
                RectF r = new RectF(b.left * sx, b.top * sy, b.right * sx, b.bottom * sy);
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
