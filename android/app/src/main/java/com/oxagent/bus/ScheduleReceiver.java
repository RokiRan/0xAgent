package com.oxagent.bus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 闹钟到点回调：交给 AgentService 静态入口执行（服务不在则丢弃并记日志）。 */
public class ScheduleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String taskId = intent.getStringExtra("taskId");
        L.log("alarm fired: " + taskId);
        AgentService.runScheduled(taskId);
    }
}
