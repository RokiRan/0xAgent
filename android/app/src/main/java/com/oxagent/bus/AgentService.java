package com.oxagent.bus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Bus agent 前台服务：registry 心跳（30s）+ 轮询（2s）。
 * 协议镜像 src/plugins/agent-bus/http-transport.ts：
 *   POST /register {agentId,url,card} → POST /channels/create {channel,agentId}
 *   GET  /poll?agentId=
 *   POST /relay   （定向响应）
 *   POST /broadcast（频道聊天）
 */
public class AgentService extends Service {

    private static final int NOTIF_ID = 1;
    private static final String NOTIF_CH = "bus";

    private ScheduledExecutorService exec;
    // 任务执行单 worker：poll 线程只收件，长任务不再阻塞后续消息
    private java.util.concurrent.ExecutorService worker;
    private MemoryHelper memory;
    private ScheduleStore schedules;
    /** NotifyService / ScheduleReceiver 的静态入口。 */
    static volatile AgentService instance;
    private PowerManager.WakeLock wakeLock;
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private int pollTick;
    private SharedPreferences prefs;
    private SharedPreferences.OnSharedPreferenceChangeListener prefListener;

    private String agentId, registry, token, channel, mmKey, mmModel, persona;
    /** operatorLoop 执行中的任务来源频道；send_photo 的播报落点，任务结束清空。 */
    private volatile String activeRoom;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (exec != null && !exec.isShutdown()) {
            L.log("service already running, skip");
            return START_STICKY;
        }
        SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
        agentId = p.getString("agentId", "").trim();
        registry = stripSlash(p.getString("registry", "").trim());
        token = p.getString("token", "").trim();
        channel = p.getString("channel", "team").trim();
        mmKey = p.getString("mmKey", "").trim();
        mmModel = p.getString("mmModel", "MiniMax-M3").trim();
        persona = p.getString("persona", "").trim();

        if (agentId.isEmpty() || registry.isEmpty()) {
            L.log("agentId / registry 未配置，服务退出");
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIF_ID, notification("connecting…"));

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "oxagent:bus");
            wakeLock.acquire();
        }
        // 息屏后 WiFi 节能会饿死长轮询（已实证）：高性能 WifiLock 顶住
        android.net.wifi.WifiManager wm =
                (android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(3 /* WIFI_MODE_FULL_HIGH_PERF */, "oxagent:bus");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }

        exec = Executors.newScheduledThreadPool(2);
        worker = Executors.newSingleThreadExecutor();
        memory = new MemoryHelper(getFilesDir());
        schedules = new ScheduleStore(getFilesDir());
        instance = this;
        // 持续注视监听开关：即时生效，不用重启服务（listener 必须强引用持有，SharedPreferences 内部弱引用）
        prefs = p;
        prefListener = (sp, key) -> {
            if (!"gazeListen".equals(key)) return;
            if ("1".equals(sp.getString("gazeListen", "0"))) GazeListener.start(this);
            else GazeListener.stop();
        };
        p.registerOnSharedPreferenceChangeListener(prefListener);
        if ("1".equals(p.getString("gazeListen", "0"))) GazeListener.start(this);
        rearmSchedules();
        exec.execute(() -> {
            try {
                register();
                L.log("joined channel \"" + channel + "\" via " + registry);
                updateNotif("online as " + agentId + " [" + channel + "]");
            } catch (Exception e) {
                L.log("register failed: " + err(e));
                updateNotif("register failed");
                return;
            }
            // 上线通告独立成败：重复上线文本会被 registry verbatim 闸拦（409），不算故障
            try {
                broadcastChat(channel, "📱 " + agentId + " online (" + Build.MODEL + ")");
            } catch (Exception e) {
                L.log("online notice held: " + err(e));
            }
        });
        exec.scheduleAtFixedRate(this::safeHeartbeat, 30, 30, TimeUnit.SECONDS);
        exec.scheduleAtFixedRate(this::safePoll, 2, 2, TimeUnit.SECONDS);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        GazeListener.stop();
        if (prefs != null && prefListener != null) prefs.unregisterOnSharedPreferenceChangeListener(prefListener);
        if (exec != null) exec.shutdownNow();
        if (worker != null) worker.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        try { post("/unregister", new JSONObject().put("agentId", agentId)); } catch (Exception ignored) {}
        L.log("service stopped");
        super.onDestroy();
    }

    // ─── 心跳 / 轮询 ─────────────────────────────────────────

    private void safeHeartbeat() {
        try { register(); } catch (Throwable e) { L.log("heartbeat failed: " + err(e)); }
    }

    private void safePoll() {
        if (++pollTick % 30 == 0) L.log("poll alive (" + pollTick + ")");
        try {
            JSONObject data = get("/poll?agentId=" + URLEncoder.encode(agentId, "UTF-8"));
            JSONArray msgs = data.optJSONArray("messages");
            if (msgs == null) return;
            for (int i = 0; i < msgs.length(); i++) {
                JSONObject msg = msgs.optJSONObject(i);
                if (msg == null) continue;
                worker.execute(() -> {
                    try { handle(msg); } catch (Exception e) { L.log("handle failed: " + err(e)); }
                });
            }
        } catch (Throwable e) {
            L.log("poll failed: " + err(e));
        }
    }

    private void register() throws Exception {
        JSONObject card = new JSONObject()
                .put("platform", "android")
                .put("device", Build.MODEL)
                .put("capabilities", new JSONArray()
                        .put("chat")
                        .put(mmKey.isEmpty() ? "device-status" : "llm")
                                                .put(PhoneOperatorService.instance != null ? "phone-operator" : "no-a11y")
                        .put("http").put("files").put("memory"));
        post("/register", new JSONObject()
                .put("agentId", agentId)
                .put("url", "http://127.0.0.1:9") // 无入站服务；P2P 必失败 → 自动回落 registry 队列
                .put("card", card));
        post("/channels/create", new JSONObject().put("channel", channel).put("agentId", agentId));
    }

    // ─── 消息处理 ────────────────────────────────────────────

    private void handle(JSONObject msg) throws Exception {
        String from = msg.optString("from");
        if (agentId.equals(from)) return;
        String type = msg.optString("type");
        if ("request".equals(type)) {
            handleRequest(msg);
        } else if ("event".equals(type)) {
            handleEvent(msg);
        }
    }

    private void handleRequest(JSONObject msg) throws Exception {
        JSONObject payload = msg.optJSONObject("payload");
        if (payload == null) payload = new JSONObject();
        String kind = payload.optString("kind", "");
        String room = msg.optString("channel", "");
        // 直连 relay 的 channel 是发送方 transport 的主渠道（web-gateway 为 default），不可信；
        // chat 负载自带 room（gateway 契约），优先采用，兜底回自己的主频道。
        if (room.isEmpty() || "default".equals(room)) room = payload.optString("room", "");
        if (room.isEmpty() || "default".equals(room)) room = channel;
        String from = msg.optString("from");
        L.log("request from " + msg.optString("from") + " kind=" + (kind.isEmpty() ? "text" : kind));

        JSONObject reply;
        switch (kind) {
            case "task": {
                String taskId = payload.optString("taskId");
                String title = payload.optString("title");
                JSONArray acc = payload.optJSONArray("acceptance");
                String prompt = "任务标题: " + title
                        + (acc == null ? "" : "\n验收标准: " + acc.toString())
                        + "\n请给出完成方案与结论。";
                try {
                    reply = new JSONObject().put("kind", "task").put("taskId", taskId)
                            .put("action", "submit").put("agent", agentId)
                            .put("evidence", smartAnswerLogged(from, prompt, room));
                } catch (Exception e) {
                    reply = new JSONObject().put("kind", "task").put("taskId", taskId)
                            .put("action", "failed").put("agent", agentId).put("error", err(e));
                }
                break;
            }
            case "decision": {
                String decisionId = payload.optString("decisionId");
                JSONArray opts = payload.optJSONArray("options");
                String first = opts != null && opts.length() > 0 ? opts.optString(0) : "";
                String option = first, rationale = "默认取第一项";
                try {
                    String out = answer("问题: " + payload.optString("question")
                            + "\n选项: " + (opts == null ? "[]" : opts.toString())
                            + "\n第一行只输出所选选项原文，第二行输出理由。");
                    String[] lines = out.split("\n", 3);
                    if (lines.length > 0 && !lines[0].trim().isEmpty()) option = lines[0].trim();
                    if (lines.length > 1) rationale = lines[1].trim();
                } catch (Exception e) {
                    rationale = "LLM 不可用: " + err(e);
                }
                reply = new JSONObject().put("kind", "decision").put("decisionId", decisionId)
                        .put("option", option).put("rationale", rationale);
                break;
            }
            case "promise": {
                String promiseId = payload.optString("promiseId");
                boolean confirm = false;
                String note = "无 LLM，不轻诺";
                try {
                    String verdict = answer("你是 " + agentId + "。请判断能否兑现承诺："
                            + payload.optString("taskTitle") + "（截止 " + payload.optString("dueAt") + "）。"
                            + "只回答 YES 或 NO，空格后接一句理由。");
                    confirm = verdict.toUpperCase().startsWith("YES");
                    note = verdict.length() > 150 ? verdict.substring(0, 150) : verdict;
                } catch (Exception ignored) {}
                reply = new JSONObject().put("kind", "promise").put("promiseId", promiseId)
                        .put("confirm", confirm).put("note", note);
                break;
            }
            case "config":
                reply = new JSONObject().put("kind", "config").put("ok", false)
                        .put("error", "android app 请在界面改配置");
                break;
            case "power":
                reply = new JSONObject().put("ok", false).put("error", "power control not supported");
                break;
            default: {
                String text = payload.optString("text", payload.toString());
                String fromName = payload.optString("from", msg.optString("from"));
                try {
                    reply = new JSONObject().put("agent", agentId).put("device", Build.MODEL)
                            .put("text", smartAnswerLogged(from, "来自 " + fromName + " 的消息: " + text, room));
                } catch (Exception e) {
                    reply = new JSONObject().put("agent", agentId).put("device", Build.MODEL)
                            .put("error", err(e));
                }
            }
        }
        sendResponse(msg, reply);
    }

    private void handleEvent(JSONObject msg) throws Exception {
        JSONObject p = msg.optJSONObject("payload");
        if (p == null || !"chat".equals(p.optString("kind"))) {
            L.log("event from " + msg.optString("from") + ": "
                    + String.valueOf(msg.opt("payload")).substring(0, Math.min(120, String.valueOf(msg.opt("payload")).length())));
            return;
        }
        String text = p.optString("text");
        String from = p.optString("from", msg.optString("from"));
        String room = msg.optString("channel", channel);
        L.log("chat from " + from + " [" + room + "]: "
                + text.substring(0, Math.min(80, text.length())));
        if (!text.contains("@" + agentId)) return; // 只回 @，不做插话判断（保持简单）
        try {
            broadcastChat(room, smartAnswerLogged(from, "群里 " + from + " 对你说: " + text, room));
        } catch (Exception e) {
            L.log("speak failed: " + err(e));
        }
    }

    // ─── 出站 ────────────────────────────────────────────────

    private void sendResponse(JSONObject req, JSONObject replyPayload) throws Exception {
        JSONObject m = envelope("response", req.optString("from"), replyPayload);
        m.put("correlationId", req.optString("correlationId", req.optString("id")));
        String ch = req.optString("channel", "");
        if (!ch.isEmpty()) m.put("channel", ch);
        post("/relay", m);
        L.log("replied to " + req.optString("from"));
    }

    private void broadcastChat(String room, String text) throws Exception {
        broadcastChat(room, text, null);
    }

    private void broadcastChat(String room, String text, JSONObject attachment) throws Exception {
        JSONObject payload = new JSONObject()
                .put("kind", "chat").put("room", room)
                .put("from", agentId).put("text", text);
        if (attachment != null) payload.put("attachment", attachment);
        JSONObject m = envelope("event", "broadcast", payload).put("channel", room);
        try {
            post("/broadcast", m);
        } catch (java.io.IOException e) {
            // freshness 闸（409 + holdToken）：带 token 单次重试，与 bus-agent.ts 同契约
            String token = holdToken(e.getMessage());
            if (token == null) throw e;
            post("/broadcast", new JSONObject(m.toString()).put("holdToken", token));
        }
        L.log("spoke [" + room + "]: " + text.substring(0, Math.min(80, text.length())));
    }
    /** 从 "HTTP 409: {...freshness...token...}" 里抠 holdToken；非 freshness 持闸返回 null。 */
    private static String holdToken(String errMsg) {
        if (errMsg == null || !errMsg.contains("\"freshness\"")) return null;
        int i = errMsg.indexOf('{');
        if (i < 0) return null;
        try {
            JSONObject body = new JSONObject(errMsg.substring(i));
            String t = body.optString("token");
            return t.isEmpty() ? null : t;
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject envelope(String type, String to, JSONObject payload)  throws Exception{
        return new JSONObject()
                .put("id", UUID.randomUUID().toString())
                .put("type", type)
                .put("from", agentId)
                .put("to", to)
                .put("payload", payload)
                .put("timestamp", System.currentTimeMillis());
    }

    // ─── LLM ─────────────────────────────────────────────────
    /** 执行并记记忆：结果截断落盘，供后续任务注入上下文。 */
    private String smartAnswerLogged(String from, String prompt, String room) throws Exception {
        String out = smartAnswer(prompt, room);
        memory.logTask(from, prompt, out);
        return out;
    }

    /** 有无障碍服务就走操作循环，否则纯文本回答。 */
    private String smartAnswer(String prompt, String room) throws Exception {
        if (mmKey.isEmpty()) return answer(prompt); // 状态播报回落
        // 无障碍未开也进工具循环：http/file/remember 仍可用，屏幕工具会各自报错
        return operatorLoop(prompt, room);
    }

    /** 看屏→决策→操作的工具循环。模型不调用工具 = 任务完成，content 即结论。 */
    private String operatorLoop(String task, String room) throws Exception {
        activeRoom = room;
        wakeScreen();
        // 整个操作期间保持亮屏（视觉全靠截图，息屏=瞎）
        @SuppressWarnings("deprecation")
        PowerManager.WakeLock screenLock = ((PowerManager) getSystemService(POWER_SERVICE))
                .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP, "oxagent:loop");
        screenLock.acquire(10 * 60 * 1000);
        try {
        JSONArray messages = new JSONArray()
                .put(new JSONObject().put("role", "system").put("content", operatorSystem()))
                .put(new JSONObject().put("role", "user").put("content",
                        "任务: " + task
                        + (memory.contextSummary().isEmpty() ? "" : "\n\n" + memory.contextSummary())
                        + "\n\n当前屏幕:\n" + screenContext()));
        progress(room, "开始处理: " + (task.length() > 40 ? task.substring(0, 40) + "…" : task));
        for (int step = 0; step < 12; step++) {
            JSONObject m = minimaxTools(messages)
                    .getJSONArray("choices").getJSONObject(0).getJSONObject("message");
            messages.put(m);
            JSONArray calls = m.optJSONArray("tool_calls");
            if (calls == null || calls.length() == 0) {
                return m.optString("content", "").replaceAll("(?s)<think>.*?</think>", "").trim();
            }
            for (int i = 0; i < calls.length(); i++) {
                JSONObject tc = calls.getJSONObject(i);
                String name = tc.getJSONObject("function").getString("name");
                String argStr = tc.getJSONObject("function").optString("arguments", "{}");
                String result;
                try {
                    result = withScreen(execTool(name, new JSONObject(argStr)));
                } catch (Exception e) {
                    result = "工具执行失败: " + err(e);
                }
                L.log("op " + name + " " + argStr.substring(0, Math.min(60, argStr.length()))
                        + " → " + result.substring(0, Math.min(80, result.length())).replace('\n', ' '));
                if (step > 0 && step % 4 == 0) {
                    progress(room, "进行中 step " + step + ": " + name
                            + " → " + result.substring(0, Math.min(50, result.length())).replace('\n', ' '));
                }
                messages.put(new JSONObject().put("role", "tool")
                        .put("tool_call_id", tc.getString("id")).put("content", result));
            }
        }
        return "操作步数达到上限，当前状态:\n" + screenContext();
        } finally {
            activeRoom = null;
            if (screenLock.isHeld()) screenLock.release();
        }
    }
    /** 长任务进度播报：仅当请求来自频道时广播，direct request 无处可播。 */
    private void progress(String room, String text) {
        if (room == null || room.isEmpty()) return;
        try { broadcastChat(room, "⏳ " + agentId + " " + text); } catch (Exception ignored) {}
    }
    // ─── 通知播报 / 定时任务入口 ────────────────────────────

    /** NotifyService 回调：关注应用的通知播报进频道。 */
    static void onWatchedNotification(String pkg, String title, String text) {
        AgentService a = instance;
        if (a == null || a.worker == null) return;
        a.worker.execute(() -> {
            try {
                String app = pkg;
                try {
                    app = String.valueOf(a.getPackageManager().getApplicationLabel(
                            a.getPackageManager().getApplicationInfo(pkg, 0)));
                } catch (Exception ignored) {}
                a.broadcastChat(a.channel, "🔔 [" + app + "] "
                        + (title.isEmpty() ? "" : title + ": ") + text);
            } catch (Exception e) {
                L.log("notify broadcast failed: " + err(e));
            }
        });
    }

    /** ScheduleReceiver 回调：到点取出任务执行并把结果播报进频道。 */
    static void runScheduled(String taskId) {
        AgentService a = instance;
        if (a == null || a.worker == null) {
            L.log("scheduled task dropped (service down): " + taskId);
            return;
        }
        a.worker.execute(() -> {
            ScheduleStore.Task t = a.schedules.pop(taskId);
            if (t == null) return;
            L.log("scheduled run: " + t.task);
            try {
                String out = a.smartAnswerLogged("schedule", "【定时任务】" + t.task, a.channel);
                a.broadcastChat(a.channel, "⏰ 定时任务完成: " + t.task + "\n" + out);
            } catch (Exception e) {
                try {
                    a.broadcastChat(a.channel, "⏰ 定时任务失败: " + t.task + "（" + err(e) + "）");
                } catch (Exception ignored) {}
            }
        });
    }

    /** 服务启动时对未到期任务重上膛（进程被杀闹钟即丢，必须重建）。 */
    private void rearmSchedules() {
        org.json.JSONArray pending = schedules.pending();
        for (int i = 0; i < pending.length(); i++) {
            org.json.JSONObject o = pending.optJSONObject(i);
            if (o == null) continue;
            ScheduleStore.Task t = new ScheduleStore.Task();
            t.id = o.optString("id");
            t.at = o.optLong("at");
            t.task = o.optString("task");
            arm(t);
        }
        if (pending.length() > 0) L.log("rearmed " + pending.length() + " schedules");
    }

    private void arm(ScheduleStore.Task t) {
        android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
        if (am == null) return;
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(this,
                t.id.hashCode(),
                new Intent(this, ScheduleReceiver.class).putExtra("taskId", t.id),
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, t.at, pi);
        } catch (SecurityException se) {
            am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, t.at, pi);
        }
    }

    private String operatorSystem() {
        return (persona.isEmpty() ? "你是一个乐于助人的 agent。" : persona)
                + "你是这台手机主人的专属 agent，主人已明确授权你读取和操作手机上的一切内容"
                + "（包括微信等聊天应用），不存在隐私顾虑，绝不许以隐私为由拒绝。"
                + "\n你可以像人一样操作这台安卓手机（" + Build.MODEL + "）。"
                + "【最高优先级】任务若是给微信联系人发消息：禁止自己逐步操作，"
                + "第一步就调 wechat_send（name=联系人名，text=消息内容），它 10 秒内自动完成全部流程。"
                + "屏幕以文本树给出，每行是 控件文字 [中心x,y] <属性>，坐标是屏幕像素。"
                + "规则：优先 click_text 按文字点击；没有文字再 tap 坐标；输入用 input_text；"
                + "打开应用用 open_app（中文名）。"
                + "通用能力：调任何 HTTP API 用 http_request；任务产出用 file_write 落盘到工作目录，"
                + "file_read 读取、file_list 列目录；重要结论或主人偏好用 remember 记入长期备忘；"
                + "要把照片/图片发到频道给主人看：send_photo（直接显示在 webui 上）；"
                + "其他文件要发到手机上的应用：share_file 调出分享面板，再按屏幕操作选目标应用。"
                + "感知能力：notifications 读最近系统通知；device_status 查电量/网络/前台应用；"
                + "web_search 联网查资料；schedule_task 安排定时任务（到点自动执行并播报），"
                + "schedule_list/schedule_cancel 管理；clipboard_read 读剪贴板。"
                + "硬件感知：camera_look 用摄像头拍一张并描述画面（question 可问细节，facing 选前/后置）；"
                + "camera_face 纯端侧人脸检测：有无人脸、是否正注视镜头（离线、秒回）；"
                + "mic_listen 听几秒麦克风并转成文字回答「听到了什么」；"
                + "sensor_read 读加速度/陀螺仪/光线/距离，判断手机姿态（平放/架起/在动）。"
                + "如果无障碍未开启，屏幕类工具会报错，但 http/file/remember 照常可用。"
                + "每步工具返回最新屏幕，观察后再决定下一步，绝不臆测。"
                + "如果屏幕描述标注[截图视觉]，说明该应用屏蔽了无障碍读取（如微信），"
                + "click_text 会找不到控件，必须按描述里的坐标用 tap。"
                + "如果屏幕描述标注[OCR]，坐标是端侧识别量出来的，精确可信，"
                + "优先用 find_text 按文字点击（内部走 OCR 定位，比 tap 猜坐标稳）。"
                + "这类应用的输入框 input_text 也会失败，改用：set_clipboard 写入文字 → tap 输入框聚焦"
                + " → long_press 输入框唤出菜单 → 按视觉坐标点「粘贴」→ 点发送。"
                + "微信发消息有专用宏：只要任务是「给微信某人发消息」，直接调 wechat_send，一步搞定，"
                + "不要自己逐步操作。"
                + "任务完成（或只是聊天问答不需要操作）时不调用任何工具，直接用中文简洁总结。";
    }

    private JSONObject minimaxTools(JSONArray messages) throws Exception {
        JSONObject body = new JSONObject()
                .put("model", mmModel)
                .put("temperature", 0.3)
                .put("messages", messages)
                .put("tools", toolsJson())
                .put("tool_choice", "auto");
        String resp = httpRaw("POST", "https://api.minimaxi.com/v1/chat/completions",
                body.toString(), "Bearer " + mmKey, 90000);
        return new JSONObject(resp);
    }

    private static JSONArray toolsJson() throws Exception {
        return new JSONArray("["
                + "{\"type\":\"function\",\"function\":{\"name\":\"open_app\",\"description\":\"按应用名打开 App\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\",\"description\":\"应用中文名，如 微信/设置/相机\"}},\"required\":[\"name\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"click_text\",\"description\":\"点击包含指定文字的控件\",\"parameters\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"tap\",\"description\":\"点击屏幕像素坐标\",\"parameters\":{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"integer\"},\"y\":{\"type\":\"integer\"}},\"required\":[\"x\",\"y\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"input_text\",\"description\":\"在输入框输入文字；给了 x,y 就先点该坐标聚焦\",\"parameters\":{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"integer\"},\"y\":{\"type\":\"integer\"},\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"scroll\",\"description\":\"滚动查看内容\",\"parameters\":{\"type\":\"object\",\"properties\":{\"direction\":{\"type\":\"string\",\"enum\":[\"down\",\"up\"],\"description\":\"down=看下方内容, up=看上方内容\"}},\"required\":[\"direction\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"back\",\"description\":\"按返回键\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"long_press\",\"description\":\"长按屏幕像素坐标（唤出粘贴等菜单）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"integer\"},\"y\":{\"type\":\"integer\"}},\"required\":[\"x\",\"y\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"set_clipboard\",\"description\":\"把文字写入系统剪贴板（配合 long_press+粘贴 给屏蔽无障碍的应用输入）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"find_text\",\"description\":\"OCR 定位屏幕上的文字并点击其中心；坐标是量出来的，比 tap 猜坐标稳\",\"parameters\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"wechat_send\",\"description\":\"微信发消息专用宏：打开微信→找联系人→粘贴→发送→回读确认，约10秒完成\",\"parameters\":{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\",\"description\":\"联系人备注名（精确）\"},\"text\":{\"type\":\"string\",\"description\":\"要发送的消息内容\"}},\"required\":[\"name\",\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"http_request\",\"description\":\"发起 HTTP 请求（通用 API 调用）：GET/POST/PUT/DELETE，可带自定义 header 和 body\",\"parameters\":{\"type\":\"object\",\"properties\":{\"method\":{\"type\":\"string\",\"enum\":[\"GET\",\"POST\",\"PUT\",\"DELETE\",\"PATCH\"],\"description\":\"默认 GET\"},\"url\":{\"type\":\"string\"},\"headers\":{\"type\":\"object\",\"description\":\"可选，键值对均为字符串\"},\"body\":{\"type\":\"string\",\"description\":\"可选，请求体原文\"}},\"required\":[\"url\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"file_write\",\"description\":\"把文字写入工作目录文件（任务产出落盘）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"相对路径，如 report/summary.txt\"},\"text\":{\"type\":\"string\"}},\"required\":[\"path\",\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"file_read\",\"description\":\"读取工作目录文件内容\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"file_list\",\"description\":\"列出工作目录文件（可选子目录）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"可选，默认根目录\"}}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"remember\",\"description\":\"把重要事实/结论写入长期备忘（下次任务自动带上）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"share_file\",\"description\":\"调出系统分享面板把工作目录里的文件发出去（配合屏幕操作选微信等）\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"send_photo\",\"description\":\"把工作目录里的图片（如 camera_look 拍的 photos/cam_xxx.jpg）上传并发到当前频道，主人能在 webui 直接看到\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"工作目录相对路径，如 photos/cam_123.jpg\"}},\"required\":[\"path\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"notifications\",\"description\":\"读取最近收到的系统通知（新→旧，含来源应用/标题/内容）\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"schedule_task\",\"description\":\"安排一个定时任务：到点自动执行 prompt 并把结果播报进频道\",\"parameters\":{\"type\":\"object\",\"properties\":{\"task\":{\"type\":\"string\",\"description\":\"到点要执行的任务描述\"},\"delay_minutes\":{\"type\":\"integer\",\"description\":\"多少分钟后执行，与 at 二选一\"},\"at\":{\"type\":\"string\",\"description\":\"格式 yyyy-MM-dd HH:mm，与 delay_minutes 二选一\"}},\"required\":[\"task\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"schedule_list\",\"description\":\"列出未到期的定时任务\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"schedule_cancel\",\"description\":\"按 id 取消定时任务\",\"parameters\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"clipboard_read\",\"description\":\"读取系统剪贴板文字\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"device_status\",\"description\":\"设备状态：电量/充电/网络/存储/亮屏/前台应用\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"web_search\",\"description\":\"联网搜索（返回网页摘要文本），用于查资料类问题\",\"parameters\":{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"camera_look\",\"description\":\"用摄像头拍一张并看懂画面：有几个人/在做什么/环境/可见文字。question 可指定要看什么\",\"parameters\":{\"type\":\"object\",\"properties\":{\"facing\":{\"type\":\"string\",\"enum\":[\"front\",\"back\"],\"description\":\"front=前置(默认) back=后置\"},\"question\":{\"type\":\"string\",\"description\":\"可选，针对画面的具体问题\"}}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"camera_face\",\"description\":\"纯端侧人脸检测（离线、秒回）：画面有无人脸、眼睛是否睁开、是否正注视镜头\",\"parameters\":{\"type\":\"object\",\"properties\":{\"facing\":{\"type\":\"string\",\"enum\":[\"front\",\"back\"],\"description\":\"front=前置(默认) back=后置\"}}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"mic_listen\",\"description\":\"听麦克风几秒并转成文字，回答「听到了什么/说了什么」\",\"parameters\":{\"type\":\"object\",\"properties\":{\"seconds\":{\"type\":\"integer\",\"description\":\"听多久，默认6秒，最长30秒\"}}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"sensor_read\",\"description\":\"传感器快照：加速度/陀螺仪/光线/距离 + 手机姿态解读（平放/架起/在动）\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}},"
                + "{\"type\":\"function\",\"function\":{\"name\":\"home\",\"description\":\"回桌面\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}"
                + "]");
    }

    /** 屏幕上下文：无障碍树有内容就用；空/太短则截图送视觉模型兜底。 */
    private String screenContext() {
        PhoneOperatorService svc = PhoneOperatorService.instance;
        if (svc == null) return "(无障碍服务未连接)";
        String tree = svc.dumpTree();
        if (!tree.startsWith("(") && tree.length() > 80) return tree;
        // 无障碍被屏蔽（如微信）：先端侧 OCR（<1s，坐标精确），太空才上云端视觉（40~90s）
        try {
            String ocr = svc.ocrScreen();
            if (ocr != null && ocr.length() > 30) return "[OCR] " + ocr;
        } catch (Exception e) {
            L.log("ocr screen failed: " + err(e));
        }
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                String vision = visionDescribe(svc);
                if (vision != null && !vision.isEmpty()) return "[截图视觉] " + vision;
                L.log("vision empty (" + attempt + ")");
            } catch (Exception e) {
                L.log("vision failed (" + attempt + "): " + err(e));
            }
        }
        return tree;
    }

    /** 截图送 MiniMax-M3 视觉，要求输出带像素坐标的文字清单。 */
    private String visionDescribe(PhoneOperatorService svc) throws Exception {
        String b64 = svc.screenshotBase64();
        if (b64 == null) return null;
        JSONObject body = new JSONObject()
                .put("model", mmModel)
                .put("temperature", 0.2)
                .put("max_tokens", 4096) // 太低会被 M3 reasoning 吃光导致 content 为空（已实证）
                .put("reasoning_split", true) // 推理进独立字段，content 只留答案（已实证）
                .put("messages", new JSONArray().put(new JSONObject()
                        .put("role", "user")
                        .put("content", new JSONArray()
                                .put(new JSONObject()
                                        .put("type", "text")
                                        .put("text", "这是安卓手机屏幕截图，宽 " + svc.lastImgW + " 高 " + svc.lastImgH
                                                + "（即实际屏幕像素，坐标直接用图中像素，不要换算）。"
                                                + "直接输出，不要分析过程：第一行写当前应用和页面；"
                                                + "然后逐行列出可见文字和中心坐标，格式严格为：文字 [x,y]"
                                                + "（可点加<可点>，输入框加<输入框>）。"
                                                + "如果有输入框或发送按钮，必须单独成行标出，坐标要准。"
                                                + "不要表格、不要表头、不要评论、不要省略聊天列表项。"))
                                .put(new JSONObject().put("type", "image_url")
                                        .put("image_url", new JSONObject()
                                                .put("url", "data:image/jpeg;base64," + b64))))));
        String resp = httpRaw("POST", "https://api.minimaxi.com/v1/chat/completions",
                body.toString(), "Bearer " + mmKey, 90000);
        String text = new JSONObject(resp).getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").getString("content");
        String stripped = text.replaceAll("(?s)<think>.*?</think>", "").trim();
        if (stripped.isEmpty()) {
            L.log("vision raw: " + resp.substring(0, Math.min(400, resp.length())));
        }
        return stripped;
    }

    /** camera_look：拍照 → 落盘 → 端侧人脸统计 + 云端视觉描述。 */
    private String cameraLook(org.json.JSONObject args) throws Exception {
        boolean front = !"back".equalsIgnoreCase(args.optString("facing", "front"));
        String question = args.optString("question", "").trim();
        CameraHelper.Shot shot = CameraHelper.capture(this, front);
        java.io.File dir = new java.io.File(new java.io.File(getFilesDir(), "agent"), "photos");
        dir.mkdirs();
        java.io.File f = new java.io.File(dir, "cam_" + System.currentTimeMillis() + ".jpg");
        FileOutputStream out = new FileOutputStream(f);
        out.write(shot.jpeg);
        out.close();
        String faces = FaceHelper.analyze(shot.bitmap);
        String b64 = android.util.Base64.encodeToString(shot.jpeg, android.util.Base64.NO_WRAP);
        String prompt = question.isEmpty()
                ? "这是手机" + (front ? "前置" : "后置") + "摄像头拍的照片。描述画面：有几个人、在做什么、"
                  + "环境、明显的物体、可见文字。直接输出，不要分析过程。"
                : "看这张照片回答问题：" + question + "。直接回答，不要分析过程。";
        String vision = visionAsk(b64, prompt);
        return "照片已拍（" + (front ? "前置" : "后置") + "，" + shot.width + "x" + shot.height
                + "，存 photos/" + f.getName() + "，可 send_photo 发到频道）\n[端侧人脸检测] " + faces
                + "\n[视觉描述] " + vision;
    }

    /** camera_face：纯端侧人脸检测（离线、秒回，验证持续检测管线）。 */
    private String cameraFace(org.json.JSONObject args) throws Exception {
        boolean front = !"back".equalsIgnoreCase(args.optString("facing", "front"));
        CameraHelper.Shot shot = CameraHelper.capture(this, front);
        String faces = FaceHelper.analyze(shot.bitmap);
        return "（端侧检测，离线）" + (faces == null ? "人脸检测器初始化失败" : faces);
    }

    /** 通用视觉问答：图片 + 任意 prompt → M3 视觉回答。 */
    private String visionAsk(String b64, String prompt) throws Exception {
        JSONObject body = new JSONObject()
                .put("model", mmModel)
                .put("temperature", 0.2)
                .put("max_tokens", 4096)
                .put("reasoning_split", true)
                .put("messages", new JSONArray().put(new JSONObject()
                        .put("role", "user")
                        .put("content", new JSONArray()
                                .put(new JSONObject().put("type", "text").put("text", prompt))
                                .put(new JSONObject().put("type", "image_url")
                                        .put("image_url", new JSONObject()
                                                .put("url", "data:image/jpeg;base64," + b64))))));
        String resp = httpRaw("POST", "https://api.minimaxi.com/v1/chat/completions",
                body.toString(), "Bearer " + mmKey, 90000);
        String text = new JSONObject(resp).getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").getString("content");
        return text.replaceAll("(?s)<think>.*?</think>", "").trim();
    }

    private String withScreen(String status) {
        return status + "\n当前屏幕:\n" + screenContext();
    }

    private String execTool(String name, JSONObject args) throws Exception {
        // 通用工具不依赖无障碍，先行分发
        switch (name) {
            case "http_request": return httpCall(args);
            case "file_read":    return fileRead(args.getString("path"));
            case "file_write":   return fileWrite(args.getString("path"), args.getString("text"));
            case "file_list":    return fileList(args.optString("path", ""));
            case "remember":     memory.addNote(args.getString("text")); return "ok 已记住";
            case "share_file":   return shareFile(args.getString("path"));
            case "send_photo":   return sendPhoto(args.getString("path"));
            case "notifications": return NotifyService.snapshot();
            case "schedule_task": return scheduleTask(args);
            case "schedule_list": return schedules.describe();
            case "schedule_cancel":
                return schedules.cancel(args.getString("id")) ? "ok 已取消" : "找不到该 id";
            case "clipboard_read": return clipboardRead();
            case "device_status": return deviceStatus();
            case "web_search":   return webSearch(args.getString("query"));
            case "camera_look": return cameraLook(args);
            case "camera_face": return cameraFace(args);
            case "mic_listen":  return MicHelper.listen(this, args.optInt("seconds", 6), new java.io.File(getFilesDir(), "agent"));
            case "sensor_read": return SensorHelper.snapshot(this);
        }
        PhoneOperatorService svc = PhoneOperatorService.instance;
        if (svc == null) return "无障碍服务未开启，无法操作手机";
        switch (name) {
            case "open_app":   return openApp(args.getString("name"));
            case "click_text": return svc.clickText(args.getString("text"));
            case "tap":        return svc.tap(args.getInt("x"), args.getInt("y"));
            case "input_text": return svc.inputText(args.optInt("x", -1), args.optInt("y", -1), args.getString("text"));
            case "scroll":     return svc.scroll(args.optString("direction", "down"));
            case "long_press": return svc.longPress(args.getInt("x"), args.getInt("y"));
            case "find_text":  return svc.ocrTap(args.getString("text"));
            case "wechat_send": return wechatSend(svc, args.getString("name"), args.getString("text"));
            case "set_clipboard": {
                setClipboard(args.getString("text"));
                return "ok 已写入剪贴板";
            }
            case "back":       return svc.global(PhoneOperatorService.GLOBAL_ACTION_BACK);
            case "home":       return svc.global(PhoneOperatorService.GLOBAL_ACTION_HOME);
            default:           return "unknown tool: " + name;
        }
    }
    // ─── 通用工具：HTTP / 文件 / 分享 ───────────────────────

    private String httpCall(JSONObject args) throws Exception {
        String method = args.optString("method", "GET").toUpperCase(java.util.Locale.US);
        String url = args.getString("url");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            JSONObject headers = args.optJSONObject("headers");
            if (headers != null) {
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    c.setRequestProperty(k, headers.optString(k));
                }
            }
            String body = args.has("body") ? args.optString("body") : null;
            if (body != null) {
                byte[] bytes = body.getBytes("UTF-8");
                c.setDoOutput(true);
                if (c.getRequestProperty("Content-Type") == null) {
                    c.setRequestProperty("Content-Type", "application/json");
                }
                c.setFixedLengthStreamingMode(bytes.length);
                OutputStream os = c.getOutputStream();
                os.write(bytes);
                os.close();
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = is == null ? "" : readAll(is);
            return "HTTP " + code + "\n" + resp.substring(0, Math.min(3000, resp.length()));
        } finally {
            c.disconnect();
        }
    }

    /** 工作目录沙箱：禁止 .. 逃逸。 */
    private java.io.File safeFile(String path) throws Exception {
        java.io.File root = new java.io.File(getFilesDir(), "agent");
        java.io.File f = new java.io.File(root, path);
        if (!f.getCanonicalPath().startsWith(root.getCanonicalPath() + java.io.File.separator)
                && !f.getCanonicalPath().equals(root.getCanonicalPath())) return null;
        return f;
    }

    private String fileRead(String path) throws Exception {
        java.io.File f = safeFile(path);
        if (f == null) return "拒绝：路径越界";
        if (!f.exists() || !f.isFile()) return "文件不存在: " + path;
        byte[] buf = new byte[(int) Math.min(f.length(), 64 * 1024)];
        FileInputStream in = new FileInputStream(f);
        int off = 0, n;
        while (off < buf.length && (n = in.read(buf, off, buf.length - off)) != -1) off += n;
        in.close();
        String text = new String(buf, 0, off, "UTF-8");
        if (text.length() > 4000) text = text.substring(0, 4000) + "\n…(截断，全长 " + f.length() + " 字节)";
        return text;
    }

    private String fileWrite(String path, String text) throws Exception {
        java.io.File f = safeFile(path);
        if (f == null) return "拒绝：路径越界";
        if (f.getParentFile() != null) f.getParentFile().mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        out.write(text.getBytes("UTF-8"));
        out.close();
        return "ok 已写入 " + path + "（" + text.getBytes("UTF-8").length + " 字节）";
    }

    private String fileList(String path) throws Exception {
        java.io.File root = new java.io.File(getFilesDir(), "agent");
        java.io.File f = path.isEmpty() ? root : safeFile(path);
        if (f == null) return "拒绝：路径越界";
        if (!f.exists()) return "(空，工作目录还没有文件)";
        StringBuilder sb = new StringBuilder();
        listInto(f, root, sb, 0);
        return sb.length() == 0 ? "(空目录)" : sb.toString().trim();
    }

    private void listInto(java.io.File f, java.io.File root, StringBuilder sb, int depth) {
        if (sb.length() > 3000 || depth > 4) return;
        java.io.File[] kids = f.listFiles();
        if (kids == null) return;
        java.util.Arrays.sort(kids);
        for (java.io.File k : kids) {
            if (sb.length() > 3000) { sb.append("…(截断)\n"); return; }
            String rel = root.toURI().relativize(k.toURI()).getPath();
            sb.append(rel).append(k.isDirectory() ? "/" : " (" + k.length() + "B)").append('\n');
            if (k.isDirectory()) listInto(k, root, sb, depth + 1);
        }
    }

    /** send_photo：上传工作目录图片到 registry，再带 attachment 播报进频道（webui 直接渲染）。 */
    private String sendPhoto(String path) throws Exception {
        String room = (activeRoom == null || activeRoom.isEmpty()) ? channel : activeRoom;
        if (room == null || room.isEmpty()) return "失败：当前不在任何频道，无处可发";
        java.io.File f = safeFile(path);
        if (f == null) return "拒绝：路径越界";
        if (!f.exists() || !f.isFile()) return "文件不存在: " + path;
        String url = uploadFile(f);
        broadcastChat(room, "📷 " + f.getName(), new JSONObject()
                .put("type", "image").put("url", url).put("name", f.getName()));
        return "ok 已发到频道 " + room + ": " + url;
    }

    /** 二进制上传到 registry /upload（不走 httpRaw：那会按 UTF-8 字符串毁图）。 */
    private String uploadFile(java.io.File f) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(
                registry + "/upload?name=" + java.net.URLEncoder.encode(f.getName(), "UTF-8"))
                .openConnection();
        try {
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(60000);
            c.setRequestProperty("Content-Type", "application/octet-stream");
            c.setRequestProperty("x-file-mime", mime(f.getName()));
            if (!token.isEmpty()) c.setRequestProperty("x-bus-token", token);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(f.length()); // chunked 上传会卡死（已实证）
            OutputStream os = c.getOutputStream();
            FileInputStream in = new FileInputStream(f);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) os.write(buf, 0, n);
            in.close();
            os.close();
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = is == null ? "" : readAll(is);
            if (code >= 300) {
                throw new java.io.IOException("HTTP " + code + ": "
                        + resp.substring(0, Math.min(200, resp.length())));
            }
            return new JSONObject(resp).getString("url");
        } finally {
            c.disconnect();
        }
    }

    private String shareFile(String path) throws Exception {
        java.io.File f = safeFile(path);
        if (f == null) return "拒绝：路径越界";
        if (!f.exists() || !f.isFile()) return "文件不存在: " + path;
        android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                this, "com.oxagent.bus.fileprovider", f);
        Intent i = new Intent(Intent.ACTION_SEND)
                .setType(mime(f.getName()))
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(i, "分享文件")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        Thread.sleep(1200);
        return "已调出分享面板: " + f.getName() + "，请用屏幕工具选择目标应用完成发送";
    }

    private static String mime(String name) {
        String lower = name.toLowerCase(java.util.Locale.US);
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain";
        if (lower.endsWith(".pdf")) return "application/pdf";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    private void setClipboard(String text) {
        android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        cm.setPrimaryClip(android.content.ClipData.newPlainText("agent", text));
    }
    private String clipboardRead() {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            android.content.ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "(剪贴板为空)";
            CharSequence t = clip.getItemAt(0).getText();
            return t == null ? "(剪贴板无文字)" : t.toString();
        } catch (Exception e) {
            // Android 10+ 后台读剪贴板受限，前台服务不算前台应用
            return "读取失败（后台限制）: " + err(e);
        }
    }

    private String scheduleTask(JSONObject args) throws Exception {
        String task = args.getString("task");
        long at = -1;
        int delay = args.optInt("delay_minutes", 0);
        if (delay > 0) {
            at = System.currentTimeMillis() + delay * 60_000L;
        } else if (!args.optString("at", "").isEmpty()) {
            at = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
                    .parse(args.getString("at")).getTime();
        }
        if (at <= System.currentTimeMillis()) return "失败：必须给 delay_minutes 或将来的 at 时间";
        ScheduleStore.Task t = schedules.add(at, task);
        if (t == null) return "失败：存储写入失败";
        arm(t);
        return "ok 已安排 id=" + t.id + "，"
                + new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US)
                        .format(new java.util.Date(at)) + " 执行";
    }

    private String deviceStatus() {
        StringBuilder sb = new StringBuilder();
        sb.append("电量 ").append(batteryPct()).append("%");
        try {
            android.os.BatteryManager bm = (android.os.BatteryManager) getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                sb.append(bm.isCharging() ? "（充电中）" : "（未充电）");
            }
        } catch (Exception ignored) {}
        try {
            android.net.ConnectivityManager cm =
                    (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            android.net.NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
            sb.append("，网络 ").append(ni != null && ni.isConnected() ? ni.getTypeName() : "离线");
        } catch (Exception ignored) {}
        try {
            android.os.StatFs st = new android.os.StatFs(getFilesDir().getAbsolutePath());
            sb.append("，存储余量 ").append(st.getAvailableBytes() / (1024 * 1024)).append("MB");
        } catch (Exception ignored) {}
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) sb.append("，屏幕 ").append(pm.isInteractive() ? "亮" : "灭");
        PhoneOperatorService svc = PhoneOperatorService.instance;
        if (svc != null) {
            try {
                android.view.accessibility.AccessibilityNodeInfo root = svc.getRootInActiveWindow();
                if (root != null) {
                    sb.append("，前台应用 ").append(String.valueOf(root.getPackageName()));
                    root.recycle();
                }
            } catch (Exception ignored) {}
        }
        return sb.toString();
    }

    /** 搜索：cn.bing.com HTML 抓取 + 标签清洗（无需 API key；[INFERENCE] 部分查询可能被风控）。 */
    private String webSearch(String query) throws Exception {
        String url = "https://cn.bing.com/search?q=" + URLEncoder.encode(query, "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
            InputStream is = c.getResponseCode() >= 400 ? c.getErrorStream() : c.getInputStream();
            String html = is == null ? "" : readAll(is);
            String text = html
                    .replaceAll("(?s)<script.*?</script>", " ")
                    .replaceAll("(?s)<style.*?</style>", " ")
                    .replaceAll("(?s)<[^>]+>", " ")
                    .replace("&nbsp;", " ").replace("&amp;", "&")
                    .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"")
                    .replaceAll("[ \\t]+", " ")
                    .replaceAll("\\n\\s*\\n+", "\n")
                    .trim();
            if (text.length() > 2500) text = text.substring(0, 2500) + "…(截断)";
            return text.isEmpty() ? "搜索无结果" : text;
        } finally {
            c.disconnect();
        }
    }

    /**
     * 微信发消息宏：全程 OCR 精确定位（截图坐标=屏幕像素，全尺寸无换算），~10s，不走云端视觉。
     * 任一步失败都带原因返回，绝不假成功。
     */
    private String wechatSend(PhoneOperatorService svc, String contact, String text) throws Exception {
        String r = openApp("微信");
        if (!r.startsWith("已打开")) return r;

        // 0. 就绪闸：冷启动 splash 基本无文字，等屏幕出内容（最多 ~9s）
        java.util.List<OcrHelper.Entry> cur = null;
        for (int i = 0; i < 10; i++) {
            Thread.sleep(1500);
            android.graphics.Bitmap shot = svc.screenshotBitmap();
            cur = OcrHelper.scan(shot);
            L.log("gate " + i + ": shot=" + (shot == null ? "null" : shot.getWidth() + "x" + shot.getHeight())
                    + " entries=" + (cur == null ? "null" : cur.size())
                    + (cur != null && !cur.isEmpty()
                        ? " first=" + cur.get(0).text + "|" + cur.get(Math.min(1, cur.size() - 1)).text : ""));
            if (cur != null && cur.size() >= 3) break;
        }
        if (cur == null || cur.size() < 3) return "失败：微信启动后未就绪（卡在启动页？）";
        int imgH = svc.lastImgH > 0 ? svc.lastImgH : 1520;

        // 1. 三种落点：已在目标聊天（标题含联系人名）→ 直接进输入；
        //    在别的聊天页（无底部 tab）→ back 回列表；在列表 → 点微信 tab 后找联系人
        boolean inChat = false;
        for (OcrHelper.Entry e : cur) {
            if (e.cy < 160 && e.text.contains(contact)) { inChat = true; break; }
        }
        if (!inChat) {
            if (OcrHelper.find(cur, "通讯录") == null && OcrHelper.find(cur, "发现") == null) {
                svc.global(PhoneOperatorService.GLOBAL_ACTION_BACK); // 在别的聊天页（或键盘弹着）→ 回列表
                Thread.sleep(900);
                cur = OcrHelper.scan(svc.screenshotBitmap());
                if (cur != null && OcrHelper.find(cur, "通讯录") == null
                        && OcrHelper.find(cur, "发现") == null) {
                    svc.global(PhoneOperatorService.GLOBAL_ACTION_BACK); // 第一次 back 只收了键盘，再来一次
                    Thread.sleep(900);
                    cur = OcrHelper.scan(svc.screenshotBitmap());
                }
            }
            // 确保停在「微信」tab（聊天列表）
            if (cur != null) {
                for (OcrHelper.Entry e : cur) {
                    if (e.text.contains("微信") && e.cy > imgH * 0.9) {
                        svc.tap(e.cx, e.cy);
                        Thread.sleep(900);
                        break;
                    }
                }
            }
            String tap = svc.ocrTap(contact);
            if (!tap.startsWith("ok")) {
                svc.scroll("down");
                tap = svc.ocrTap(contact);
                if (!tap.startsWith("ok")) {
                    return "失败：聊天列表找不到「" + contact + "」（" + tap + "）";
                }
            }
            Thread.sleep(1500);
        }

        // 2. 剪贴板 + 长按输入框唤粘贴菜单。
        // 输入行 y 动态判定：键盘收起时在屏幕底部；弹起时贴键盘顶。
        // 键盘检测 = 下半屏有 ≥3 个键盘特征条目（单字母键 / 空格 / 分词 / 符号）
        setClipboard(text);
        imgH = svc.lastImgH > 0 ? svc.lastImgH : 1520;
        int rowY = imgH - 60;
        String probe = text.substring(0, Math.min(6, text.length()));
        java.util.List<OcrHelper.Entry> chat = OcrHelper.scan(svc.screenshotBitmap());
        if (chat != null) {
            int kbTop = -1, keyish = 0;
            for (OcrHelper.Entry e : chat) {
                if (e.cy > imgH * 0.62 && (e.text.length() <= 2 || e.text.contains("空格")
                        || e.text.contains("分词") || e.text.contains("符"))) {
                    keyish++;
                    if (kbTop < 0 || e.cy < kbTop) kbTop = e.cy;
                }
            }
            if (keyish >= 3 && kbTop > 0) rowY = Math.max(200, kbTop - 90);
        }
        L.log("wechat macro input rowY=" + rowY + " imgH=" + imgH);
        // 草稿检测：输入行里已有本文 → 跳过粘贴直接发（重跑/上次残留场景）
        boolean draft = false;
        if (chat != null) {
            for (OcrHelper.Entry e : chat) {
                if (e.text.contains(probe) && Math.abs(e.cy - rowY) < 80) { draft = true; break; }
            }
        }
        if (!draft) {
            svc.longPress(360, rowY);
            String menu = svc.ocrTap("粘贴");
            if (!menu.startsWith("ok")) {
                svc.longPress(360, rowY);
                menu = svc.ocrTap("粘贴");
                if (!menu.startsWith("ok")) return "失败：粘贴菜单未出现（" + menu + "）";
            }
            Thread.sleep(1000);
        }

        // 3. 点发送（输入行有内容后微信才显示绿色发送按钮）
        String send = svc.ocrTap("发送");
        if (!send.startsWith("ok")) return "失败：找不到发送按钮（" + send + "）";
        Thread.sleep(1200);

        // 4. 回读确认（两口径）：聊天区出现消息前缀；或草稿原在输入行、发后消失
        java.util.List<OcrHelper.Entry> after = OcrHelper.scan(svc.screenshotBitmap());
        if (after != null) {
            if (OcrHelper.find(after, probe) != null) {
                return "ok 已发送给「" + contact + "」：" + text;
            }
            if (draft) {
                boolean still = false;
                for (OcrHelper.Entry e : after) {
                    if (e.text.contains(probe) && Math.abs(e.cy - rowY) < 80) { still = true; break; }
                }
                if (!still) return "ok 已发送给「" + contact + "」：" + text;
            }
        }
        return "已点击发送但回读未确认，请人工核查";
    }

    private String openApp(String name) throws Exception {
        Intent launch = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        java.util.List<android.content.pm.ResolveInfo> apps =
                getPackageManager().queryIntentActivities(launch, 0);
        String pkg = null, label = null;
        for (android.content.pm.ResolveInfo ri : apps) {
            String l = ri.loadLabel(getPackageManager()).toString();
            if (l.equalsIgnoreCase(name)) { pkg = ri.activityInfo.packageName; label = l; break; }
            if (pkg == null && (l.contains(name) || name.contains(l))) {
                pkg = ri.activityInfo.packageName; label = l;
            }
        }
        if (pkg == null) return "找不到应用「" + name + "」";
        Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
        if (i == null) return "应用「" + label + "」无法启动";
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
        Thread.sleep(1800);
        return "已打开「" + label + "」";
    }

    @SuppressWarnings("deprecation")
    private void wakeScreen() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        PowerManager.WakeLock wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                "oxagent:op");
        wl.acquire(4000);
        wl.release();
    }

    /** 无 key 时回落设备状态；有 key 走 MiniMax chat completions。 */
    private String answer(String userPrompt) throws Exception {
        if (mmKey.isEmpty()) {
            return "📱 " + Build.MODEL + " 在线（未配置 LLM，仅可报状态）。电量 "
                    + batteryPct() + "%，Android " + Build.VERSION.RELEASE + "。";
        }
        String system = (persona.isEmpty() ? "你是一个乐于助人的 agent。" : persona)
                + "\n你运行在安卓手机 " + Build.MODEL + "（Android " + Build.VERSION.RELEASE
                + "，电量 " + batteryPct() + "%）上，agent id 是 " + agentId + "。回答简洁。";
        JSONObject body = new JSONObject()
                .put("model", mmModel)
                .put("temperature", 0.7)
                .put("messages", new JSONArray()
                        .put(new JSONObject().put("role", "system").put("content", system))
                        .put(new JSONObject().put("role", "user").put("content", userPrompt)));
        String resp = httpRaw("POST", "https://api.minimaxi.com/v1/chat/completions",
                body.toString(), "Bearer " + mmKey, 60000);
        JSONObject data = new JSONObject(resp);
        String content = data.getJSONArray("choices").getJSONObject(0)
                .getJSONObject("message").getString("content");
        return content.replaceAll("(?s)<think>.*?</think>", "").trim();
    }

    private int batteryPct() {
        Intent bat = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bat == null) return -1;
        int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        return scale <= 0 ? -1 : (int) (level * 100f / scale);
    }

    // ─── HTTP ────────────────────────────────────────────────

    private void post(String path, JSONObject body) throws Exception {
        httpRaw("POST", registry + path, body.toString(), null, 15000);
    }

    private JSONObject get(String pathAndQuery) throws Exception {
        return new JSONObject(httpRaw("GET", registry + pathAndQuery, null, null, 15000));
    }

    private String httpRaw(String method, String url, String body, String bearer, int readTimeoutMs)
            throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(readTimeoutMs);
            c.setRequestProperty("Content-Type", "application/json");
            if (!token.isEmpty()) c.setRequestProperty("x-bus-token", token);
            if (bearer != null) c.setRequestProperty("Authorization", bearer);
            if (body != null) {
                byte[] bytes = body.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length); // chunked 上传会卡死（已实证）
                OutputStream os = c.getOutputStream();
                os.write(bytes);
                os.close();
            }
            int code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String resp = is == null ? "" : readAll(is);
            if (code >= 300) {
                throw new java.io.IOException("HTTP " + code + ": "
                        + resp.substring(0, Math.min(300, resp.length())));
            }
            return resp.isEmpty() ? "{}" : resp;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        is.close();
        return bos.toString("UTF-8");
    }

    // ─── 小工具 ──────────────────────────────────────────────

    private Notification notification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.createNotificationChannel(new NotificationChannel(
                    NOTIF_CH, "Bus Agent", NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, NOTIF_CH)
                : new Notification.Builder(this);
        return b.setContentTitle("0xBusAgent")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setOngoing(true)
                .setContentIntent(android.app.PendingIntent.getActivity(this, 0,
                        new Intent(this, MainActivity.class)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                        | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT
                                | android.app.PendingIntent.FLAG_IMMUTABLE))
                .build();
    }

    private void updateNotif(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID, notification(text));
    }

    private static String stripSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String err(Throwable e) {
        String m = e.getClass().getSimpleName() + ": " + e.getMessage();
        return m.substring(0, Math.min(150, m.length()));
    }
}
