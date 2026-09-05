package com.oxagent.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.UUID;

/**
 * 定时任务存储：filesDir/schedules.json，一次性任务 {id, at, task}。
 * 闹钟由 AgentService 负责上膛（服务启动时对未到期任务重上膛）；
 * 到点 ScheduleReceiver 回调 → pop 出任务执行并移除。
 */
public class ScheduleStore {

    public static class Task {
        public String id;
        public long at;
        public String task;
    }

    private final File file;
    private JSONArray items = new JSONArray();

    public ScheduleStore(File filesDir) {
        file = new File(filesDir, "schedules.json");
        load();
    }

    public synchronized Task add(long at, String task) {
        try {
            Task t = new Task();
            t.id = UUID.randomUUID().toString().substring(0, 8);
            t.at = at;
            t.task = task;
            items.put(new JSONObject().put("id", t.id).put("at", at).put("task", task));
            save();
            return t;
        } catch (Exception e) {
            return null;
        }
    }

    /** 列出未到期任务描述（新→旧按时间升序原文返回）。 */
    public synchronized String describe() {
        if (items.length() == 0) return "(无定时任务)";
        StringBuilder sb = new StringBuilder();
        long now = System.currentTimeMillis();
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at");
            long leftMin = Math.max(0, (at - now) / 60000);
            sb.append("- id=").append(o.optString("id"))
                    .append(" ").append(new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US)
                            .format(new java.util.Date(at)))
                    .append("（").append(leftMin).append(" 分钟后）: ")
                    .append(o.optString("task")).append('\n');
        }
        return sb.toString().trim();
    }

    public synchronized Task pop(String id) {
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o == null || !id.equals(o.optString("id"))) continue;
            Task t = new Task();
            t.id = id;
            t.at = o.optLong("at");
            t.task = o.optString("task");
            items.remove(i);
            save();
            return t;
        }
        return null;
    }

    public synchronized boolean cancel(String id) {
        return pop(id) != null;
    }

    /** 服务启动时取出全部未到期任务用于重上膛。 */
    public synchronized JSONArray pending() {
        JSONArray out = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < items.length(); i++) {
            JSONObject o = items.optJSONObject(i);
            if (o != null && o.optLong("at") > now) out.put(o);
        }
        return out;
    }

    private void load() {
        if (!file.exists()) return;
        try {
            FileInputStream in = new FileInputStream(file);
            byte[] buf = new byte[(int) file.length()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) != -1) off += n;
            in.close();
            items = new JSONArray(new String(buf, "UTF-8"));
        } catch (Exception e) {
            L.log("schedules load failed: " + e.getMessage());
            items = new JSONArray();
        }
    }

    private void save() {
        try {
            FileOutputStream out = new FileOutputStream(file);
            out.write(items.toString().getBytes("UTF-8"));
            out.close();
        } catch (Exception e) {
            L.log("schedules save failed: " + e.getMessage());
        }
    }
}
