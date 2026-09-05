package com.oxagent.bus;

import android.graphics.Bitmap;
import android.graphics.Rect;
import android.media.Image;

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
    private static volatile FaceDetector fastDetector;
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

    /** FAST 模式检测器（测试页实时流用）：帧率优先，欧拉角/眼睛睁开概率照常输出。 */
    private static FaceDetector getFast() {
        if (fastDetector == null) {
            synchronized (FaceHelper.class) {
                if (fastDetector == null) {
                    try {
                        FaceDetectorOptions opts = new FaceDetectorOptions.Builder()
                                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                                .build();
                        fastDetector = FaceDetection.getClient(opts);
                    } catch (Throwable t) {
                        L.log("fast face detector init failed: " + t);
                        return null;
                    }
                }
            }
        }
        return fastDetector;
    }

    /** 头部端正（不含眼睛条件）：|Y|<15° |X|<20°。 */
    public static boolean headStraight(Face f) {
        return Math.abs(f.getHeadEulerAngleY()) < 15 && Math.abs(f.getHeadEulerAngleX()) < 20;
    }

    /** 双眼睁开（>0.6，取不到概率时不否决）。 */
    public static boolean eyesOpen(Face f) {
        Float le = f.getLeftEyeOpenProbability();
        Float re = f.getRightEyeOpenProbability();
        if (le != null && le < 0.6f) return false;
        if (re != null && re < 0.6f) return false;
        return true;
    }

    /** 正对镜头判定（唯一阈值源，analyze 与测试页共用）：头部偏转 |Y|<15° |X|<20° 且双眼睁开。 */
    public static boolean lookingAtCamera(Face f) {
        float ey = f.getHeadEulerAngleY(); // 左右转头，0=正对
        float ex = f.getHeadEulerAngleX(); // 抬头低头，0=平视
        Float le = f.getLeftEyeOpenProbability();
        Float re = f.getRightEyeOpenProbability();
        boolean eyesOpen = (le == null || le > 0.6f) && (re == null || re > 0.6f);
        return Math.abs(ey) < 15 && Math.abs(ex) < 20 && eyesOpen;
    }

    /**
     * 同步结构化检测（最多等 20 秒，首次加载模型慢）。
     * 返回人脸列表（空表=无人脸）；null = 检测器不可用/超时/失败（错误细节进日志）。
     * 调用方必须传已旋正的 Bitmap（InputImage rotationDegrees 恒 0）。
     */
    public static List<Face> detect(Bitmap bmp) {
        FaceDetector d = get();
        if (d == null) return null;
        final List<Face>[] box = new List[1];
        final Exception[] err = new Exception[1];
        CountDownLatch latch = new CountDownLatch(1);
        d.process(InputImage.fromBitmap(bmp, 0))
                .addOnSuccessListener(faces -> { box[0] = faces; latch.countDown(); })
                .addOnFailureListener(e -> { err[0] = e; latch.countDown(); });
        try {
            if (!latch.await(20, TimeUnit.SECONDS)) {
                L.log("face detect timeout");
                return null;
            }
        } catch (InterruptedException ie) {
            return null;
        }
        if (err[0] != null) {
            L.log("face detect failed: " + err[0].getMessage());
            return null;
        }
        return box[0];
    }

    /**
     * 实时流检测（FAST 模式，零拷贝）：直接吃 YUV Image，rotationDegrees 告诉检测器
     * 如何转正（按传感器安装角计算，不用预旋位图）。返回的框坐标仍在原始帧坐标系。
     */
    public static List<Face> detectFast(Image img, int rotationDegrees) {
        FaceDetector d = getFast();
        if (d == null) return null;
        final List<Face>[] box = new List[1];
        final Exception[] err = new Exception[1];
        CountDownLatch latch = new CountDownLatch(1);
        d.process(InputImage.fromMediaImage(img, rotationDegrees))
                .addOnSuccessListener(faces -> { box[0] = faces; latch.countDown(); })
                .addOnFailureListener(e -> { err[0] = e; latch.countDown(); });
        try {
            if (!latch.await(5, TimeUnit.SECONDS)) {
                L.log("fast face detect timeout");
                return null;
            }
        } catch (InterruptedException ie) {
            return null;
        }
        if (err[0] != null) {
            L.log("fast face detect failed: " + err[0].getMessage());
            return null;
        }
        return box[0];
    }

    /** 文本版检测（工具用）。不可用返回 null，无人脸返回 "无人脸"。 */
    public static String analyze(Bitmap bmp) {
        FaceDetector d = get();
        if (d == null) return null;
        List<Face> faces = detect(bmp);
        if (faces == null) return "人脸检测失败或超时（详见日志）";
        if (faces.isEmpty()) return "画面中无人脸";

        StringBuilder sb = new StringBuilder();
        sb.append("检测到 ").append(faces.size()).append(" 张人脸：");
        int looking = 0;
        for (int i = 0; i < faces.size(); i++) {
            Face f = faces.get(i);
            Rect b = f.getBoundingBox();
            Float le = f.getLeftEyeOpenProbability();
            Float re = f.getRightEyeOpenProbability();
            boolean isLooking = lookingAtCamera(f);
            if (isLooking) looking++;
            sb.append("\n#").append(i + 1)
                    .append(" 位置[").append(b.centerX()).append(",").append(b.centerY())
                    .append("] 大小").append(b.width()).append("x").append(b.height())
                    .append(" 头部偏转Y=").append((int) f.getHeadEulerAngleY())
                    .append("° X=").append((int) f.getHeadEulerAngleX()).append("°")
                    .append(" 左眼睁开=").append(le == null ? "?" : String.format(java.util.Locale.US, "%.2f", le))
                    .append(" 右眼睁开=").append(re == null ? "?" : String.format(java.util.Locale.US, "%.2f", re))
                    .append(isLooking ? " → 正注视摄像头" : " → 未注视摄像头");
        }
        sb.append("\n结论：").append(looking > 0 ? looking + " 人正在看镜头" : "没有人看镜头");
        return sb.toString();
    }
}
