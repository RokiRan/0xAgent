package com.oxagent.bus;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;

import androidx.exifinterface.media.ExifInterface;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.Collections;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Camera2 无预览拍照（前台服务内可后台/息屏用）：打开摄像头 → 流式请求让 AE/AF 收敛 ~1.2s
 * → 取最新帧 → 关摄像头。JPEG 解码后按 EXIF 旋正，输出 Bitmap + 重编码 JPEG。
 */
public class CameraHelper {

    public static class Shot {
        public Bitmap bitmap;   // 已旋正
        public byte[] jpeg;     // 已旋正重编码（直接可上传视觉模型/落盘）
        public int width, height;
    }

    /** 拍一张。front=true 前置。无权限/被占用/无摄像头抛异常（调用方转错误文案）。 */
    public static Shot capture(Context ctx, boolean front) throws Exception {
        if (ctx.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            throw new Exception("无相机权限（adb shell pm grant com.oxagent.bus android.permission.CAMERA）");
        }
        CameraManager cm = (CameraManager) ctx.getSystemService(Context.CAMERA_SERVICE);
        String camId = null;
        CameraCharacteristics ch = null;
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics c = cm.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing != null
                    && facing == (front ? CameraCharacteristics.LENS_FACING_FRONT
                                        : CameraCharacteristics.LENS_FACING_BACK)) {
                camId = id;
                ch = c;
                break;
            }
        }
        if (camId == null) throw new Exception("找不到" + (front ? "前置" : "后置") + "摄像头");

        StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map.getOutputSizes(ImageFormat.JPEG);
        // 取宽 ≤1600 的最大尺寸（够视觉/人脸检测用，控制 base64 体积）
        Size best = null;
        for (Size s : sizes) {
            if (s.getWidth() > 1600) continue;
            if (best == null || s.getWidth() * s.getHeight() > best.getWidth() * best.getHeight()) best = s;
        }
        if (best == null) best = sizes[0];

        HandlerThread ht = new HandlerThread("cam");
        ht.start();
        Handler h = new Handler(ht.getLooper());
        LinkedBlockingQueue<byte[]> frames = new LinkedBlockingQueue<>();
        ImageReader reader = ImageReader.newInstance(best.getWidth(), best.getHeight(), ImageFormat.JPEG, 2);
        reader.setOnImageAvailableListener(r -> {
            Image img = r.acquireLatestImage();
            if (img == null) return;
            java.nio.ByteBuffer buf = img.getPlanes()[0].getBuffer();
            byte[] b = new byte[buf.remaining()];
            buf.get(b);
            img.close();
            frames.offer(b);
        }, h);

        CameraDevice device = null;
        try {
            final CameraDevice[] devBox = new CameraDevice[1];
            final Exception[] errBox = new Exception[1];
            final java.util.concurrent.CountDownLatch openLatch = new java.util.concurrent.CountDownLatch(1);
            cm.openCamera(camId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) { devBox[0] = d; openLatch.countDown(); }
                @Override public void onDisconnected(CameraDevice d) { d.close(); errBox[0] = new Exception("相机被断开"); openLatch.countDown(); }
                @Override public void onError(CameraDevice d, int e) { d.close(); errBox[0] = new Exception("相机错误 " + e + "（可能被其他应用占用）"); openLatch.countDown(); }
            }, h);
            if (!openLatch.await(10, TimeUnit.SECONDS)) throw new Exception("打开相机超时");
            if (errBox[0] != null) throw errBox[0];
            device = devBox[0];

            CaptureRequest.Builder req = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            req.addTarget(reader.getSurface());
            req.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            req.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            req.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);

            final CameraCaptureSession[] sessBox = new CameraCaptureSession[1];
            final java.util.concurrent.CountDownLatch sessLatch = new java.util.concurrent.CountDownLatch(1);
            device.createCaptureSession(Collections.singletonList(reader.getSurface()),
                    new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession s) { sessBox[0] = s; sessLatch.countDown(); }
                        @Override public void onConfigureFailed(CameraCaptureSession s) { errBox[0] = new Exception("相机会话配置失败"); sessLatch.countDown(); }
                    }, h);
            if (!sessLatch.await(10, TimeUnit.SECONDS)) throw new Exception("创建相机会话超时");
            if (errBox[0] != null) throw errBox[0];

            sessBox[0].setRepeatingRequest(req.build(), null, h);
            // 等 AE/AF 收敛并攒帧
            byte[] jpeg = null;
            long deadline = System.currentTimeMillis() + 8000;
            long warmUntil = System.currentTimeMillis() + 1200;
            while (System.currentTimeMillis() < deadline) {
                byte[] f = frames.poll(300, TimeUnit.MILLISECONDS);
                if (f != null && System.currentTimeMillis() >= warmUntil) { jpeg = f; break; }
            }
            if (jpeg == null) throw new Exception("相机无画面输出");

            Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            if (bmp == null) throw new Exception("相机帧解码失败");
            int rot = exifRotation(jpeg);
            if (rot != 0) {
                Matrix m = new Matrix();
                m.postRotate(rot);
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
            Shot s = new Shot();
            s.bitmap = bmp;
            s.jpeg = out.toByteArray();
            s.width = bmp.getWidth();
            s.height = bmp.getHeight();
            return s;
        } finally {
            if (device != null) device.close();
            reader.close();
            ht.quitSafely();
        }
    }

    private static int exifRotation(byte[] jpeg) {
        try {
            ExifInterface exif = new ExifInterface(new ByteArrayInputStream(jpeg));
            int o = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            switch (o) {
                case ExifInterface.ORIENTATION_ROTATE_90: return 90;
                case ExifInterface.ORIENTATION_ROTATE_180: return 180;
                case ExifInterface.ORIENTATION_ROTATE_270: return 270;
                default: return 0;
            }
        } catch (Exception e) {
            return 0;
        }
    }
}
