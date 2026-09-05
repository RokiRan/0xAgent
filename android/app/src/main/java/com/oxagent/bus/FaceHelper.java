package com.oxagent.bus;

import android.graphics.Bitmap;
import android.graphics.Rect;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 端侧人脸检测（ML Kit bundled 模型，完全离线）：人脸有无、眼睛睁开概率、头部姿态角。
 * 持续目标检测场景（手机架起来盯主人）也走这个管线，绝不走云端。
 */
public class FaceHelper {

    private static volatile FaceDetector detector;
    private static volatile boolean initFailed;

    private static FaceDetector get() {
        if (detector != null || initFailed) return detector;
        synchronized (FaceHelper.class) {
            if (detector == null && !initFailed) {
                try {
                    FaceDetectorOptions opts = new FaceDetectorOptions.Builder()
                            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL) // 眼睛睁开/微笑概率
                            .build();
                    detector = FaceDetection.getClient(opts);
                } catch (Throwable t) {
                    initFailed = true;
                    L.log("face detector init failed: " + t);
                }
            }
        }
        return detector;
    }

    /**
     * 同步检测（最多等 20 秒，首次加载模型慢）。不可用返回 null，无人脸返回 "无人脸"。
     */
    public static String analyze(Bitmap bmp) {
        FaceDetector d = get();
        if (d == null) return null;
        final List<Face>[] box = new List[1];
        final Exception[] err = new Exception[1];
        CountDownLatch latch = new CountDownLatch(1);
        d.process(InputImage.fromBitmap(bmp, 0))
                .addOnSuccessListener(faces -> { box[0] = faces; latch.countDown(); })
                .addOnFailureListener(e -> { err[0] = e; latch.countDown(); });
        try {
            if (!latch.await(20, TimeUnit.SECONDS)) return "人脸检测超时";
        } catch (InterruptedException ie) {
            return "人脸检测被中断";
        }
        if (err[0] != null) return "人脸检测失败: " + err[0].getMessage();
        List<Face> faces = box[0];
        if (faces == null || faces.isEmpty()) return "画面中无人脸";

        StringBuilder sb = new StringBuilder();
        sb.append("检测到 ").append(faces.size()).append(" 张人脸：");
        int looking = 0;
        for (int i = 0; i < faces.size(); i++) {
            Face f = faces.get(i);
            Rect b = f.getBoundingBox();
            float ey = f.getHeadEulerAngleY(); // 左右转头，0=正对
            float ex = f.getHeadEulerAngleX(); // 抬头低头，0=平视
            Float le = f.getLeftEyeOpenProbability();
            Float re = f.getRightEyeOpenProbability();
            boolean eyesOpen = (le == null || le > 0.6f) && (re == null || re > 0.6f);
            boolean facing = Math.abs(ey) < 15 && Math.abs(ex) < 20;
            boolean isLooking = facing && eyesOpen;
            if (isLooking) looking++;
            sb.append("\n#").append(i + 1)
                    .append(" 位置[").append(b.centerX()).append(",").append(b.centerY())
                    .append("] 大小").append(b.width()).append("x").append(b.height())
                    .append(" 头部偏转Y=").append((int) ey).append("° X=").append((int) ex).append("°")
                    .append(" 左眼睁开=").append(le == null ? "?" : String.format(java.util.Locale.US, "%.2f", le))
                    .append(" 右眼睁开=").append(re == null ? "?" : String.format(java.util.Locale.US, "%.2f", re))
                    .append(isLooking ? " → 正注视摄像头" : " → 未注视摄像头");
        }
        sb.append("\n结论：").append(looking > 0 ? looking + " 人正在看镜头" : "没有人看镜头");
        return sb.toString();
    }
}
