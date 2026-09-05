package com.oxagent.bus;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** 日志全屏（深色）+ 可折叠配置面板。纯代码 UI，无资源依赖。 */
public class MainActivity extends Activity {

    private static final int C_BG = 0xFF000000;     // 主背景
    private static final int C_PANEL = 0xFF14181F;  // 配置面板背景
    private static final int C_TEXT = 0xFFF0F0F0;   // 主文字
    private static final int C_LOG = 0xFFA9F5C0;    // 日志绿
    private static final int C_BTN = 0xFF2A3346;    // 按钮背景

    private static final String[][] FIELDS = {
            // prefsKey, label, default
            {"agentId",   "Agent ID",        "android-agent"},
            {"registry",  "Registry URL",    "http://hub.ihave2.work:9876"},
            {"token",     "Bus Token",       ""},
            {"channel",   "Channel",         "team"},
            {"mmKey",     "MiniMax API Key", ""},
            {"mmModel",   "MiniMax Model",   "MiniMax-M3"},
            {"persona",   "Persona",         "运行在安卓手机上的 agent，擅长移动端视角、现场信息"},
    };

    private SharedPreferences prefs;
    private final java.util.Map<String, EditText> inputs = new java.util.HashMap<>();
    private TextView logView;
    private ScrollView logScroll;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        // adb 注入配置：am start --es agentId x --es registry y --es token z --es autostart 1
        Intent seed = getIntent();
        SharedPreferences.Editor se = null;
        for (String[] f : FIELDS) {
            if (seed.hasExtra(f[0])) {
                if (se == null) se = prefs.edit();
                se.putString(f[0], seed.getStringExtra(f[0]));
            }
        }
        if (se != null) se.apply();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(12);
        root.setBackgroundColor(C_BG);
        root.setPadding(dp(8), dp(8), dp(8), dp(8));

        // 纯黑 + 无状态栏沉浸全屏
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        // 日志全屏打底；齿轮小图标浮在右上角；配置面板默认收起
        android.widget.FrameLayout frame = new android.widget.FrameLayout(this);

        // 配置面板：默认收起；日志页任意点击展开；30s 无操作或点返回自动收起
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(C_PANEL);
        panel.setPadding(pad, pad, pad, pad);
        // 横屏/小屏塞不下时可上下滑动
        ScrollView panelScroll = new ScrollView(this);
        panelScroll.setBackgroundColor(C_PANEL);
        panelScroll.addView(panel);
        panelScroll.setVisibility(View.GONE);

        Button back = new Button(this);
        back.setText("← 返回日志（30s 无操作自动返回）");
        back.setBackgroundColor(C_BTN);
        back.setTextColor(C_TEXT);
        panel.addView(back);

        for (String[] f : FIELDS) {
            TextView label = new TextView(this);
            label.setText(f[1]);
            label.setTextColor(C_TEXT);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            panel.addView(label);
            EditText input = new EditText(this);
            input.setSingleLine(true);
            input.setText(prefs.getString(f[0], f[2]));
            input.setTextSize(13);
            input.setTextColor(C_TEXT);
            panel.addView(input);
            inputs.put(f[0], input);
        }

        LinearLayout btns = new LinearLayout(this);
        Button start = new Button(this);
        start.setText("启动 Agent");
        Button stop = new Button(this);
        stop.setText("停止");
        for (Button b : new Button[]{start, stop}) {
            b.setBackgroundColor(C_BTN);
            b.setTextColor(C_TEXT);
        }
        btns.addView(start, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        btns.addView(stop, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        panel.addView(btns);
        Button battery = new Button(this);
        battery.setText("关闭电池优化（息屏保活必点）");
        battery.setBackgroundColor(C_BTN);
        battery.setTextColor(C_TEXT);
        battery.setOnClickListener(v -> {
            try {
                startActivity(new Intent(
                        android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                L.log("battery exemption intent failed: " + e.getMessage());
            }
        });
        panel.addView(battery);
        Button a11y = new Button(this);
        a11y.setText("开启无障碍服务（操作手机必须）");
        a11y.setBackgroundColor(C_BTN);
        a11y.setTextColor(C_TEXT);
        a11y.setOnClickListener(v ->
                startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        panel.addView(a11y);
        logView = new TextView(this);
        logView.setTextSize(11);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextColor(C_LOG);
        // 不留文本选择：tap 语义让位给「点击进配置」
        logView.setTextIsSelectable(false);
        logScroll = new ScrollView(this);
        logScroll.addView(logView);
        logScroll.setPadding(dp(8), dp(8), dp(8), dp(8));
        logScroll.setFillViewport(true); // 子视图撑满整屏，空白区点击也能进配置
        frame.addView(logScroll, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        frame.addView(panelScroll, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.Gravity.TOP));
        root.addView(frame, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        // 展开/收起 + 30s 无操作自动返回
        android.os.Handler idle = new android.os.Handler(android.os.Looper.getMainLooper());
        Runnable autoBack = () -> panelScroll.setVisibility(View.GONE);
        View.OnClickListener open = v -> {
            panelScroll.setVisibility(View.VISIBLE);
            idle.removeCallbacks(autoBack);
            idle.postDelayed(autoBack, 30_000);
        };
        logScroll.setOnClickListener(open);
        logView.setOnClickListener(open);
        back.setOnClickListener(v -> {
            idle.removeCallbacks(autoBack);
            panelScroll.setVisibility(View.GONE);
        });
        // 面板上的任何触摸都重置 30s 计时
        panelScroll.setOnTouchListener((v, ev) -> {
            idle.removeCallbacks(autoBack);
            idle.postDelayed(autoBack, 30_000);
            return false;
        });

        setContentView(root);

        start.setOnClickListener(v -> {
            saveAll();
            startForegroundService(new Intent(this, AgentService.class));
        });
        stop.setOnClickListener(v -> stopService(new Intent(this, AgentService.class)));
        if (seed.hasExtra("autostart")) {
            startForegroundService(new Intent(this, AgentService.class));
        }
    }

    private void saveAll() {
        SharedPreferences.Editor e = prefs.edit();
        for (String[] f : FIELDS) {
            EditText in = inputs.get(f[0]);
            e.putString(f[0], in.getText().toString().trim());
        }
        e.apply();
        L.log("config saved");
    }

    @Override
    protected void onResume() {
        super.onResume();
        logView.setText(L.all());
        L.setListener(line -> runOnUiThread(() -> {
            logView.append(line + "\n");
            logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
        }));
    }

    @Override
    protected void onPause() {
        super.onPause();
        L.setListener(null);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
