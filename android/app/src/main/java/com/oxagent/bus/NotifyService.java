package com.oxagent.bus;

import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 通知监听：全量缓冲（内存 50 条，供 notifications 工具读取）；
 * 关注名单（prefs "notifyWatch"，逗号分隔包名）内的通知即时播报进频道。
 * 开启：settings put secure enabled_notification_listeners com.oxagent.bus/com.oxagent.bus.NotifyService
 */
public class NotifyService extends NotificationListenerService {

    private static final int MAX_BUF = 50;
    private static final long DEDUPE_MS = 60_000;

    private static final List<JSONObject> buffer = new ArrayList<>();
    private static final Map<String, Long> lastSpoke = new HashMap<>();

    @Override
    public void onListenerConnected() {
        L.log("通知监听已连接");
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String pkg = sbn.getPackageName();
            if (getPackageName().equals(pkg)) return; // 自己的前台服务通知，忽略
            android.app.Notification n = sbn.getNotification();
            if (n == null || n.extras == null) return;
            CharSequence t = n.extras.getCharSequence(android.app.Notification.EXTRA_TITLE);
            CharSequence x = n.extras.getCharSequence(android.app.Notification.EXTRA_TEXT);
            String title = t == null ? "" : t.toString().trim();
            String text = x == null ? "" : x.toString().trim();
            if (title.isEmpty() && text.isEmpty()) return;

            JSONObject o = new JSONObject()
                    .put("t", System.currentTimeMillis())
                    .put("pkg", pkg)
                    .put("title", title)
                    .put("text", text.length() > 200 ? text.substring(0, 200) : text);
            synchronized (buffer) {
                buffer.add(0, o);
                while (buffer.size() > MAX_BUF) buffer.remove(buffer.size() - 1);
            }

            if (watched(pkg) && debounce(pkg + "|" + title + "|" + text)) {
                AgentService.onWatchedNotification(pkg, title, text);
            }
        } catch (Exception e) {
            L.log("notify handle failed: " + e.getMessage());
        }
    }

    /** 最近通知快照（新→旧），供 notifications 工具。 */
    public static String snapshot() {
        synchronized (buffer) {
            if (buffer.isEmpty()) return "(无通知缓冲；若刚开启监听，等新通知进来)";
            StringBuilder sb = new StringBuilder();
            int n = Math.min(20, buffer.size());
            for (int i = 0; i < n; i++) {
                JSONObject o = buffer.get(i);
                sb.append("- ").append(o.optString("pkg"))
                        .append(" | ").append(o.optString("title"))
                        .append(" | ").append(o.optString("text")).append('\n');
            }
            return sb.toString().trim();
        }
    }

    private boolean watched(String pkg) {
        String watch = getSharedPreferences("cfg", MODE_PRIVATE)
                .getString("notifyWatch", "com.tencent.mm,com.android.mms,com.samsung.android.messaging");
        for (String w : watch.split(",")) {
            if (w.trim().equals(pkg)) return true;
        }
        return false;
    }

    /** 同内容 60s 内只播报一次。 */
    private static boolean debounce(String key) {
        long now = System.currentTimeMillis();
        Long last = lastSpoke.get(key);
        if (last != null && now - last < DEDUPE_MS) return false;
        lastSpoke.put(key, now);
        if (lastSpoke.size() > 200) lastSpoke.clear();
        return true;
    }
}
