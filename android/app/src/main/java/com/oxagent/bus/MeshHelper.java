package com.oxagent.bus;

import android.content.Context;
import android.graphics.Bitmap;

import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker.FaceLandmarkerOptions;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;

import java.util.List;

/**
 * 端侧人脸关键点（MediaPipe FaceLandmarker + face_landmarker.task，完全离线）：
 * 478 点含虹膜（ML Kit face-mesh 只暴露 468 点无虹膜，已实证，故走 tasks API）。
 * 输出虹膜在眼窝里的相对位置（rx/ry，居中≈0.5），用于「头眼分离」的注视判定——
 * 补偿 FaceHelper 头姿态代理的两个盲区（头正眼下瞟误判注视 / 头偏眼回看误判未注视）。
 * 索引用 MediaPipe 标准编号：虹膜中心 468/473，眼角 33/133、362/263，眼睑 159/145、386/374。
 */
public class MeshHelper {

    // MediaPipe 标准关键点索引（subject 视角的左/右）
    private static final int L_IRIS = 468, R_IRIS = 473;
    private static final int L_OUTER = 33, L_INNER = 133;
    private static final int R_INNER = 362, R_OUTER = 263;
    private static final int L_TOP = 159, L_BOTTOM = 145;
    private static final int R_TOP = 386, R_BOTTOM = 374;

    public static class Gaze {
        public int points;          // 关键点数量，478=含虹膜
        public float lrx = -1, lry = -1, rrx = -1, rry = -1; // 虹膜相对位置，-1=取不到
        /** 双眼 rx 分裂度：基线 ≤0.15，转眼 ≥0.21（眼动仪核心特征）。 */
        public float split() {
            return (lrx < 0 || rrx < 0) ? 0 : Math.abs(lrx - rrx);
        }
        /**
         * 严格注视判据（仅在头正时使用，阈值来自 5 组姿势实测）：
         * rx∈[0.35,0.65]；ry∈[0.35,0.58]（上瞟 ry 冲高 0.58+，下瞟崩 0.30-）；Δrx≤0.20（转眼特征）。
         */
        public boolean irisStrict() {
            return band(lrx, 0.35f, 0.65f) && band(rrx, 0.35f, 0.65f)
                    && band(lry, 0.35f, 0.58f) && band(rry, 0.35f, 0.58f)
                    && split() <= 0.20f;
        }
        private static boolean band(float v, float lo, float hi) {
            return v >= lo && v <= hi;
        }
        @Override public String toString() {
            return String.format(java.util.Locale.US,
                    "pts=%d L(%.2f,%.2f) R(%.2f,%.2f) Δ%.2f%s",
                    points, lrx, lry, rrx, rry, split(), irisStrict() ? " 注视" : "");
        }
    }

    private static volatile FaceLandmarker landmarker;
    private static volatile boolean initFailed;

    private static FaceLandmarker get(Context ctx) {
        if (landmarker != null || initFailed) return landmarker;
        synchronized (MeshHelper.class) {
            if (landmarker == null && !initFailed) {
                try {
                    FaceLandmarkerOptions opts = FaceLandmarkerOptions.builder()
                            .setBaseOptions(BaseOptions.builder()
                                    .setModelAssetPath("face_landmarker.task").build())
                            .setRunningMode(RunningMode.IMAGE)
                            .setNumFaces(1)
                            .build();
                    landmarker = FaceLandmarker.createFromOptions(ctx.getApplicationContext(), opts);
                    L.log("face landmarker ready");
                } catch (Throwable t) {
                    initFailed = true;
                    L.log("face landmarker init failed: " + t);
                }
            }
        }
        return landmarker;
    }

    /**
     * 同步分析。调用方必须传已旋正的 Bitmap。无人脸/不可用返回 null（细节进日志）。
     */
    public static Gaze analyze(Context ctx, Bitmap upright) {
        FaceLandmarker fl = get(ctx);
        if (fl == null) return null;
        try {
            FaceLandmarkerResult res = fl.detect(new BitmapImageBuilder(upright).build());
            if (res.faceLandmarks().isEmpty()) return null;
            List<NormalizedLandmark> lm = res.faceLandmarks().get(0);
            Gaze g = new Gaze();
            g.points = lm.size();
            if (lm.size() <= R_IRIS) {
                L.log("face landmarker: 无虹膜点（points=" + g.points + "）");
                return g;
            }
            g.lrx = ratioX(lm.get(L_IRIS), lm.get(L_OUTER), lm.get(L_INNER));
            g.lry = ratioY(lm.get(L_IRIS), lm.get(L_TOP), lm.get(L_BOTTOM));
            g.rrx = ratioX(lm.get(R_IRIS), lm.get(R_OUTER), lm.get(R_INNER));
            g.rry = ratioY(lm.get(R_IRIS), lm.get(R_TOP), lm.get(R_BOTTOM));
            return g;
        } catch (Throwable t) {
            L.log("face landmarker detect failed: " + t.getMessage());
            return null;
        }
    }

    /** 虹膜中心在外→内眼角轴上的归一化位置，居中≈0.5。 */
    private static float ratioX(NormalizedLandmark iris, NormalizedLandmark outer, NormalizedLandmark inner) {
        float denom = inner.x() - outer.x();
        if (Math.abs(denom) < 1e-6) return -1;
        return (iris.x() - outer.x()) / denom;
    }

    /** 虹膜中心在上→下眼睑轴上的归一化位置，居中≈0.5。 */
    private static float ratioY(NormalizedLandmark iris, NormalizedLandmark top, NormalizedLandmark bottom) {
        float denom = bottom.y() - top.y();
        if (Math.abs(denom) < 1e-6) return -1;
        return (iris.y() - top.y()) / denom;
    }
    /** YUV_420_888 分析帧 → 旋正位图（landmarker 只吃正立图）。FaceTestActivity/GazeListener 共用。 */
    public static Bitmap fromYuv(android.media.Image img, int rotationDegrees) {
        try {
            int w = img.getWidth(), h = img.getHeight();
            byte[] nv21 = new byte[w * h * 3 / 2];
            android.media.Image.Plane y = img.getPlanes()[0];
            java.nio.ByteBuffer yb = y.getBuffer();
            if (y.getRowStride() == w && y.getPixelStride() == 1) {
                yb.get(nv21, 0, w * h);
            } else {
                for (int row = 0; row < h; row++) {
                    yb.position(row * y.getRowStride());
                    yb.get(nv21, row * w, w);
                }
            }
            android.media.Image.Plane u = img.getPlanes()[1], v = img.getPlanes()[2];
            java.nio.ByteBuffer ub = u.getBuffer(), vb = v.getBuffer();
            int uvPix = u.getPixelStride(), uRow = u.getRowStride(), vRow = v.getRowStride();
            for (int row = 0; row < h / 2; row++) {
                for (int col = 0; col < w / 2; col++) {
                    nv21[w * h + row * w + col * 2] = vb.get(row * vRow + col * uvPix);
                    nv21[w * h + row * w + col * 2 + 1] = ub.get(row * uRow + col * uvPix);
                }
            }
            android.graphics.YuvImage yuv = new android.graphics.YuvImage(nv21,
                    android.graphics.ImageFormat.NV21, w, h, null);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            yuv.compressToJpeg(new android.graphics.Rect(0, 0, w, h), 80, bos);
            Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(bos.toByteArray(), 0, bos.size());
            if (bmp == null) return null;
            if (rotationDegrees == 0) return bmp;
            android.graphics.Matrix m = new android.graphics.Matrix();
            m.postRotate(rotationDegrees);
            return Bitmap.createBitmap(bmp, 0, 0, w, h, m, true);
        } catch (Throwable t) {
            L.log("mesh fromYuv failed: " + t.getMessage());
            return null;
        }
    }
}
