package com.oxagent.bus;

import java.util.ArrayDeque;

/** 进程内日志总线：Service 写，Activity 订阅。有界 300 行。 */
final class L {
    interface Listener { void onLine(String line); }

    private static final int MAX = 300;
    private static final ArrayDeque<String> lines = new ArrayDeque<>();
    private static Listener listener;

    static synchronized void log(String msg) {
        String line = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                .format(new java.util.Date()) + " " + msg;
        lines.addLast(line);
        while (lines.size() > MAX) lines.removeFirst();
        Listener l = listener;
        if (l != null) l.onLine(line);
        android.util.Log.i("0xBusAgent", msg);
    }

    static synchronized void setListener(Listener l) { listener = l; }

    static synchronized String all() {
        StringBuilder sb = new StringBuilder();
        for (String s : lines) sb.append(s).append('\n');
        return sb.toString();
    }
}
