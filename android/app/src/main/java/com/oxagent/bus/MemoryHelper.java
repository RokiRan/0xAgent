package com.oxagent.bus;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 会话记忆：任务历史 + 备忘笔记，落盘 filesDir/memory.json，进程重启不丢。
 * 每条任务 {t:时间戳, from:来源, task:任务摘要, result:结果摘要}；
 * 每条笔记 {t:时间戳, text:内容}（由 remember 工具写入）。
 */
public class MemoryHelper {
    private static final int MAX_TASKS = 20;
    private static final int MAX_NOTES = 30;
    private static final int SUMMARY_CAP = 1500; // 注入 prompt 的总上限

    private final File file;
    private JSONArray tasks = new JSONArray();
    private JSONArray notes = new JSONArray();

    public MemoryHelper(File filesDir) {
        file = new File(filesDir, "memory.json");
        load();
    }

    public synchronized void logTask(String from, String task, String result) {
        try {
            JSONObject o = new JSONObject()
                    .put("t", System.currentTimeMillis())
                    .put("from", from == null ? "" : from)
                    .put("task", clip(task, 200))
                    .put("result", clip(result, 300));
            JSONArray next = new JSONArray().put(o);
            for (int i = 0; i < tasks.length() && i < MAX_TASKS - 1; i++) next.put(tasks.get(i));
            tasks = next;
            save();
        } catch (Exception e) {
            L.log("memory logTask failed: " + e.getMessage());
        }
    }

    public synchronized void addNote(String text) {
        try {
            JSONObject o = new JSONObject()
                    .put("t", System.currentTimeMillis())
                    .put("text", clip(text, 300));
            JSONArray next = new JSONArray().put(o);
            for (int i = 0; i < notes.length() && i < MAX_NOTES - 1; i++) next.put(notes.get(i));
            notes = next;
            save();
        } catch (Exception e) {
            L.log("memory addNote failed: " + e.getMessage());
        }
    }

    /** 注入 system/user prompt 的记忆摘要；无记忆时返回空串。 */
    public synchronized String contextSummary() {
        StringBuilder sb = new StringBuilder();
        if (tasks.length() > 0) {
            sb.append("【最近任务（新→旧）】\n");
            for (int i = 0; i < tasks.length() && sb.length() < SUMMARY_CAP; i++) {
                JSONObject o = tasks.optJSONObject(i);
                if (o == null) continue;
                sb.append("- ").append(fmt(o.optLong("t")))
                        .append(" 来自 ").append(o.optString("from"))
                        .append(": ").append(o.optString("task"))
                        .append(" → ").append(o.optString("result")).append('\n');
            }
        }
        if (notes.length() > 0 && sb.length() < SUMMARY_CAP) {
            sb.append("【备忘】\n");
            for (int i = 0; i < notes.length() && sb.length() < SUMMARY_CAP; i++) {
                JSONObject o = notes.optJSONObject(i);
                if (o == null) continue;
                sb.append("- ").append(fmt(o.optLong("t")))
                        .append(" ").append(o.optString("text")).append('\n');
            }
        }
        return sb.toString().trim();
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        s = s.replace('\n', ' ').trim();
        return s.length() > n ? s.substring(0, n) + "…" : s;
    }

    private static String fmt(long ts) {
        return new SimpleDateFormat("MM-dd HH:mm", Locale.US).format(new Date(ts));
    }

    private void load() {
        if (!file.exists()) return;
        try {
            FileInputStream in = new FileInputStream(file);
            byte[] buf = new byte[(int) file.length()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) != -1) off += n;
            in.close();
            JSONObject o = new JSONObject(new String(buf, "UTF-8"));
            tasks = o.optJSONArray("tasks") == null ? new JSONArray() : o.optJSONArray("tasks");
            notes = o.optJSONArray("notes") == null ? new JSONArray() : o.optJSONArray("notes");
        } catch (Exception e) {
            L.log("memory load failed: " + e.getMessage());
            tasks = new JSONArray();
            notes = new JSONArray();
        }
    }

    private void save() {
        try {
            JSONObject o = new JSONObject().put("tasks", tasks).put("notes", notes);
            File tmp = new File(file.getParentFile(), "memory.json.tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(o.toString().getBytes("UTF-8"));
            out.close();
            if (!tmp.renameTo(file)) { // 原子替换失败则退化为直写
                FileOutputStream direct = new FileOutputStream(file);
                direct.write(o.toString().getBytes("UTF-8"));
                direct.close();
            }
        } catch (Exception e) {
            L.log("memory save failed: " + e.getMessage());
        }
    }
}
