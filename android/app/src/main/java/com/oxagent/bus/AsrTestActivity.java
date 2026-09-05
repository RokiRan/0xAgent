package com.oxagent.bus;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 端侧语音识别测试页：按住底部按钮说话，松开出结果。
 * AudioRecord 16kHz mono PCM16 → AsrHelper.Session 流式听写，
 * 按住期间实时回显部分结果（Session.peek），松开 finish() 出终稿。
 * 与持续注视监听互斥（都占麦克风）：进页面暂停，退出按开关恢复（同 FaceTestActivity）。
 */
public class AsrTestActivity extends Activity {

    private static final int C_BG = 0xFF000000;
    private static final int C_TEXT = 0xFFF0F0F0;
    private static final int C_LOG = 0xFFA9F5C0;
    private static final int C_BTN = 0xFF2A3346;
    private static final int C_BTN_REC = 0xFF8B2E2E;
    private static final int MAX_HOLD_MS = 300_000;
    private static final int REQ_PERM = 43;

    private TextView status;
    private TextView live;
    private TextView logView;
    private Button hold;

    private volatile boolean recording;
    private volatile boolean stopReq;
    private AsrHelper.Session session;
    private Thread recThread;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean gazeWasRunning;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        gazeWasRunning = GazeListener.running();
        if (gazeWasRunning) {
            new Thread(GazeListener::stop, "gaze-pause").start();
            L.log("进入语音识别测试页，已暂停持续注视监听");
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(C_BG);

        status = new TextView(this);
        status.setTextColor(C_TEXT);
        status.setTextSize(14);
        status.setPadding(dp(12), dp(10), dp(12), dp(6));
        status.setText("检查识别模型…");
        root.addView(status);

        live = new TextView(this);
        live.setTextColor(0xFF9AA4B2);
        live.setTextSize(13);
        live.setPadding(dp(12), 0, dp(12), dp(6));
        live.setText("实时：");
        root.addView(live);

        logView = new TextView(this);
        logView.setTextColor(C_LOG);
        logView.setTextSize(12);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setPadding(dp(12), dp(4), dp(12), dp(4));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(logView);
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        hold = new Button(this);
        hold.setText("按住说话");
        hold.setTextSize(18);
        hold.setBackgroundColor(C_BTN);
        hold.setTextColor(C_TEXT);
        hold.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == MotionEvent.ACTION_DOWN) { startRec(); return true; }
            if (ev.getAction() == MotionEvent.ACTION_UP || ev.getAction() == MotionEvent.ACTION_CANCEL) {
                stopRec();
                return true;
            }
            return false;
        });
        LinearLayout.LayoutParams holdLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(96));
        holdLp.setMargins(dp(12), dp(6), dp(12), dp(14));
        root.addView(hold, holdLp);

        setContentView(root);

        // 模型首载 1-3s（sensevoice 更大），预热避免首次按住卡顿
        new Thread(() -> {
            String eng = AsrHelper.engineName(this);
            ui.post(() -> status.setText(eng != null
                    ? "模型就绪（sherpa " + eng + "，离线）。按住底部按钮说话。"
                    : "识别模型不可用，见主界面日志。"));
        }, "asr-warm").start();
    }

    private void startRec() {
        if (recording) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_PERM);
            return;
        }
        session = AsrHelper.beginSession(this);
        if (session == null) {
            status.setText("识别模型不可用");
            return;
        }
        recording = true;
        stopReq = false;
        hold.setText("● 录音中…松开出结果");
        hold.setBackgroundColor(C_BTN_REC);
        status.setText("录音中（最长 " + (MAX_HOLD_MS / 1000) + " 秒）");
        recThread = new Thread(this::recLoop, "asr-test-rec");
        recThread.start();
    }

    private void stopRec() {
        stopReq = true;
    }
    
    // sensevoice 的实时 peek 已下线：offline createStream(hotwords) 路径在 1.13.7 上会崩进程
    //（已实证：按住期间 peekThread CreateStream 警告后 60ms 进程死亡）。
    // 按住期间只回显峰值/时长，松开 finish() 出终稿。


    private void recLoop() {
        int rate = 16000;
        long lastUiPost = 0;
        byte[] buf = new byte[3200]; // 100ms 一块
        AudioRecord rec = null;
        String err = null;
        long started = System.currentTimeMillis();
        int peak = 0;
        try {
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, rate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(min, rate * 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                err = "麦克风初始化失败（被占用？）";
            } else {
                rec.startRecording();
                while (!stopReq && System.currentTimeMillis() - started < MAX_HOLD_MS) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n <= 0) continue;
                    session.feed(buf, n);
                    for (int i = 0; i + 1 < n; i += 2) {
                        int v = Math.abs((buf[i + 1] << 8) | (buf[i] & 0xff));
                        if (v > peak) peak = v;
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastUiPost > 500) {
                        lastUiPost = now;
                        int p = peak;
                        long secs = (now - started) / 1000;
                        ui.post(() -> live.setText("录音中… 峰值 " + p + "，" + secs + "s"));
                    }
                }
                rec.stop();
            }
        } catch (Throwable t) {
            err = "录音失败: " + t.getMessage();
        } finally {
            if (rec != null) rec.release();
        }
        // 收尾解码前停掉 peek 轮询，避免与 finish 争抢长解码
        stopReq = true;
        String text = null;
        if (err == null) {
            try { text = session.finish(); } catch (Throwable ignored) {}
        }
        session.release();
        session = null;
        recording = false;

        final String fErr = err;
        final String fText = text == null ? null : text.trim();
        final int fPeak = peak;
        final long dur = (System.currentTimeMillis() - started) / 1000;
        ui.post(() -> {
            hold.setText("按住说话");
            hold.setBackgroundColor(C_BTN);
            String line;
            if (fErr != null) {
                status.setText(fErr);
                line = fErr;
            } else if (fText == null || fText.isEmpty()) {
                status.setText("没识别出文字（峰值 " + fPeak + "，录了 " + dur + "s）");
                line = "（空）峰值 " + fPeak + "，" + dur + "s";
            } else {
                status.setText("识别完成（" + dur + "s，峰值 " + fPeak + "）");
                line = fText;
            }
            String ts = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
            logView.setText("[" + ts + "] " + line + "\n" + logView.getText());
        });
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == REQ_PERM) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startRec();
            else status.setText("无麦克风权限");
        }
    }

    @Override
    protected void onDestroy() {
        stopReq = true;
        if (recThread != null) {
            try { recThread.join(3000); } catch (InterruptedException ignored) {}
        }
        boolean wantOn = "1".equals(getSharedPreferences("cfg", MODE_PRIVATE)
                .getString("gazeListen", "0"));
        if (gazeWasRunning && wantOn && !GazeListener.running()) {
            GazeListener.start(this);
            L.log("退出语音识别测试页，已恢复持续注视监听");
        }
        super.onDestroy();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
