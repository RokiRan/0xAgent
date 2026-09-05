package com.oxagent.bus;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 无障碍操作手：读屏（控件文本树+坐标）+ 手势点击/输入/滚动 + 全局动作。
 * 静态 instance 供 AgentService 的工具循环调用。
 */
public class PhoneOperatorService extends AccessibilityService {

    static volatile PhoneOperatorService instance;

    @Override
    public void onServiceConnected() {
        instance = this;
        L.log("无障碍服务已连接");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        L.log("无障碍服务已断开");
        return false;
    }

    // ─── 读屏 ────────────────────────────────────────────────

    /** 控件文本树：每行「文字 (描述) [中心x,y] <输入框|可点>」，截断 2500 字符。 */
    String dumpTree() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "(读不到屏幕，可能息屏或锁屏)";
        StringBuilder sb = new StringBuilder();
        walk(root, sb);
        String s = sb.toString().trim();
        return s.isEmpty() ? "(屏幕无可读文本)" : s.substring(0, Math.min(2500, s.length()));
    }

    private void walk(AccessibilityNodeInfo n, StringBuilder sb) {
        if (n == null || sb.length() > 2500) return;
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        boolean hasText = t != null && t.toString().trim().length() > 0;
        boolean hasDesc = d != null && d.toString().trim().length() > 0;
        if (hasText || hasDesc || n.isEditable()) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            if (!r.isEmpty() && r.width() > 0) {
                if (hasText) sb.append(t);
                if (hasDesc) sb.append(hasText ? " (" + d + ")" : d);
                sb.append(" [").append(r.centerX()).append(',').append(r.centerY()).append(']');
                if (n.isEditable()) sb.append(" <输入框>");
                else if (n.isClickable()) sb.append(" <可点>");
                sb.append('\n');
            }
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            walk(c, sb);
            if (c != null) c.recycle();
        }
    }

    // ─── 手势 ────────────────────────────────────────────────

    private boolean gestureTap(int x, int y) throws InterruptedException {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 80))
                .build();
        CountDownLatch latch = new CountDownLatch(1);
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { latch.countDown(); }
            @Override public void onCancelled(GestureDescription g) { latch.countDown(); }
        }, null);
        if (!accepted) return false;
        latch.await(2, TimeUnit.SECONDS);
        return true;
    }

    int lastImgW, lastImgH; // 最近一张截图的尺寸，供 prompt 报坐标系

    /** 截图（全尺寸 ARGB_8888；API 30+）。节流(error 3)自动缓 1.2s 重试一次；仍败返回 null。 */
    Bitmap screenshotBitmap() throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 30) return null;
        for (int i = 0; i < 2; i++) {
            Bitmap b = screenshotOnce();
            if (b != null) return b;
            Thread.sleep(1200); // ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT：1秒内连调被系统拒
        }
        return null;
    }

    private Bitmap screenshotOnce() throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 30) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final Bitmap[] holder = new Bitmap[1];
        takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(),
                new TakeScreenshotCallback() {
                    @Override public void onSuccess(ScreenshotResult res) {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(res.getHardwareBuffer(), res.getColorSpace());
                        res.getHardwareBuffer().close();
                        if (hw != null) holder[0] = hw.copy(Bitmap.Config.ARGB_8888, false);
                        latch.countDown();
                    }
                    @Override public void onFailure(int errorCode) {
                        L.log("screenshot failed: " + errorCode);
                        latch.countDown();
                    }
                });
        latch.await(6, TimeUnit.SECONDS);
        Bitmap bmp = holder[0];
        if (bmp == null) { L.log("screenshot null"); return null; }
        lastImgW = bmp.getWidth();
        lastImgH = bmp.getHeight();
        return bmp;
    }

    String screenshotBase64() throws Exception {
        Bitmap bmp = screenshotBitmap();
        if (bmp == null) return null;
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos); // 全尺寸：免 ×2 换算，省推理又准
        return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP);
    }

    /** OCR 读屏：「文字 [x,y]」逐行（<1s，坐标精确）。失败/无文字返回 null，调用方回落云端视觉。 */
    String ocrScreen() throws Exception {
        Bitmap bmp = screenshotBitmap();
        if (bmp == null) return null;
        java.util.List<OcrHelper.Entry> entries = OcrHelper.scan(bmp);
        if (entries == null || entries.isEmpty()) return null;
        return OcrHelper.dump(entries);
    }

    /** OCR 定位点击：精确等值优先，包含匹配兜底。找不到返回原因字符串。 */
    String ocrTap(String needle) throws Exception {
        Bitmap bmp = screenshotBitmap();
        if (bmp == null) return "截图失败";
        java.util.List<OcrHelper.Entry> entries = OcrHelper.scan(bmp);
        if (entries == null) return "OCR 不可用";
        OcrHelper.Entry e = OcrHelper.find(entries, needle);
        if (e == null) return "OCR 找不到「" + needle + "」";
        gestureTap(e.cx, e.cy);
        Thread.sleep(900);
        return "ok 已点击「" + e.text + "」[" + e.cx + "," + e.cy + "]";
    }

    String tap(int x, int y) throws Exception {
        boolean ok = gestureTap(x, y);
        Thread.sleep(900);
        return (ok ? "ok" : "手势被拒");
    }
    /** 长按（700ms 同点按住），用于唤出粘贴菜单。 */
    String longPress(int x, int y) throws Exception {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 700))
                .build();
        CountDownLatch latch = new CountDownLatch(1);
        boolean accepted = dispatchGesture(gesture, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { latch.countDown(); }
            @Override public void onCancelled(GestureDescription g) { latch.countDown(); }
        }, null);
        latch.await(2, TimeUnit.SECONDS);
        Thread.sleep(900);
        return accepted ? "ok" : "手势被拒";
    }

    String clickText(String text) throws Exception {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "读不到屏幕";
        AccessibilityNodeInfo target = findByText(root, text);
        if (target == null) return "找不到包含「" + text + "」的控件";
        // 优先让可点祖先执行 ACTION_CLICK，失败再按坐标手势
        AccessibilityNodeInfo n = target;
        while (n != null) {
            if (n.isClickable() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                Thread.sleep(900);
                return "ok";
            }
            n = n.getParent();
        }
        Rect r = new Rect();
        target.getBoundsInScreen(r);
        return tap(r.centerX(), r.centerY());
    }

    private AccessibilityNodeInfo findByText(AccessibilityNodeInfo root, String text) {
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
        if (nodes != null && !nodes.isEmpty()) return nodes.get(0);
        return findContains(root, text);
    }

    private AccessibilityNodeInfo findContains(AccessibilityNodeInfo n, String text) {
        if (n == null) return null;
        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        if ((t != null && t.toString().contains(text)) || (d != null && d.toString().contains(text))) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo found = findContains(n.getChild(i), text);
            if (found != null) return found;
        }
        return null;
    }

    String inputText(int x, int y, String text) throws Exception {
        if (x >= 0 && y >= 0) {
            gestureTap(x, y); // 先点出焦点
            Thread.sleep(400);
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "读不到屏幕";
        AccessibilityNodeInfo edit = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (edit == null || !edit.isEditable()) edit = findEditable(root);
        if (edit == null) return "找不到输入框";
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b);
        Thread.sleep(500);
        return (ok ? "ok" : "输入失败");
    }

    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.isEditable() && n.isVisibleToUser()) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo found = findEditable(n.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    /** direction: down = 看下方内容（SCROLL_FORWARD），up = 看上方。 */
    String scroll(String direction) throws Exception {
        AccessibilityNodeInfo sc = findScrollable(getRootInActiveWindow());
        if (sc == null) return "没有可滚动区域";
        int action = "up".equalsIgnoreCase(direction)
                ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
        sc.performAction(action);
        Thread.sleep(900);
        return "ok";
    }

    private AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo n) {
        if (n == null) return null;
        if (n.isScrollable()) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo found = findScrollable(n.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    String global(int action) throws Exception {
        performGlobalAction(action);
        Thread.sleep(900);
        return "ok";
    }
}
