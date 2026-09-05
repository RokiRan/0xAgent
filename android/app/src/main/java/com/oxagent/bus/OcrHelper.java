package com.oxagent.bus;

import android.graphics.Bitmap;
import android.graphics.Rect;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 端侧 OCR（ML Kit 中文模型，完全离线）：截图 → 每行文字 + 精确像素中心坐标。
 * 微信等屏蔽无障碍读取的应用用它替代云端视觉：~0.3s、免费、坐标是量出来的不是猜的。
 */
public class OcrHelper {

    public static class Entry {
        public final String text;
        public final int cx, cy;
        Entry(String text, int cx, int cy) { this.text = text; this.cx = cx; this.cy = cy; }
    }

    private static volatile TextRecognizer recognizer;
    private static volatile boolean initFailed;

    private static TextRecognizer get() {
        if (recognizer != null || initFailed) return recognizer;
        synchronized (OcrHelper.class) {
            if (recognizer == null && !initFailed) {
                try {
                    recognizer = TextRecognition.getClient(
                            new ChineseTextRecognizerOptions.Builder().build());
                    L.log("ocr recognizer ready");
                } catch (Throwable t) {
                    L.log("ocr init failed: " + t);
                    initFailed = true;
                }
            }
        }
        return recognizer;
    }

    /** 同步 OCR（最多等 20 秒，首次加载模型慢）。不可用/失败返回 null，无文字返回空表。 */
    public static List<Entry> scan(Bitmap bmp) {
        TextRecognizer r = get();
        if (r == null || bmp == null) return null;
        final List<Entry> out = new ArrayList<>();
        final CountDownLatch latch = new CountDownLatch(1);
        try {
            r.process(InputImage.fromBitmap(bmp, 0))
                    .addOnSuccessListener(text -> { collect(text, out); latch.countDown(); })
                    .addOnFailureListener(e -> { L.log("ocr failed: " + e.getMessage()); latch.countDown(); });
        } catch (Throwable t) {
            L.log("ocr process threw: " + t);
            return null;
        }
        try { latch.await(20, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        return out;
    }

    private static void collect(Text text, List<Entry> out) {
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                Rect r = line.getBoundingBox();
                String t = line.getText();
                if (r != null && t != null && !t.trim().isEmpty()) {
                    out.add(new Entry(t.trim(), r.centerX(), r.centerY()));
                }
            }
        }
    }

    /** dump：「文字 [x,y]」逐行，截断 2500 字符。 */
    public static String dump(List<Entry> entries) {
        StringBuilder sb = new StringBuilder();
        for (Entry e : entries) {
            sb.append(e.text).append(" [").append(e.cx).append(',').append(e.cy).append("]\n");
            if (sb.length() > 2500) break;
        }
        return sb.toString().trim();
    }

    /** 定位：整行精确等值优先（区分「哈哈」和「哈,哈」群），否则包含匹配取最短、同长取最靠上。 */
    public static Entry find(List<Entry> entries, String needle) {
        Entry best = null;
        for (Entry e : entries) {
            if (e.text.equals(needle)) return e;
            if (e.text.contains(needle)) {
                if (best == null || e.text.length() < best.text.length()
                        || (e.text.length() == best.text.length() && e.cy < best.cy)) {
                    best = e;
                }
            }
        }
        return best;
    }
}
