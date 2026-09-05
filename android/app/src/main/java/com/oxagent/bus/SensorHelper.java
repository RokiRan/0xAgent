package com.oxagent.bus;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 传感器一次性快照：加速度/陀螺仪/光线/距离，注册监听等首个事件即取（≤1.5s），附姿态解读。
 */
public class SensorHelper {

    public static String snapshot(Context ctx) {
        SensorManager sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
        float[] accel = new float[3];
        float[] gyro = new float[3];
        float[] light = {-1};
        float[] prox = {-1};
        boolean[] hasAccel = {false};
        boolean[] hasGyro = {false};

        CountDownLatch latch = new CountDownLatch(1);
        SensorEventListener l = new SensorEventListener() {
            @Override public void onSensorChanged(SensorEvent e) {
                switch (e.sensor.getType()) {
                    case Sensor.TYPE_ACCELEROMETER:
                        System.arraycopy(e.values, 0, accel, 0, 3);
                        hasAccel[0] = true;
                        break;
                    case Sensor.TYPE_GYROSCOPE:
                        System.arraycopy(e.values, 0, gyro, 0, 3);
                        hasGyro[0] = true;
                        break;
                    case Sensor.TYPE_LIGHT:
                        light[0] = e.values[0];
                        break;
                    case Sensor.TYPE_PROXIMITY:
                        prox[0] = e.values[0];
                        break;
                }
                if (hasAccel[0] && hasGyro[0]) latch.countDown();
            }
            @Override public void onAccuracyChanged(Sensor s, int a) {}
        };

        StringBuilder missing = new StringBuilder();
        register(sm, l, Sensor.TYPE_ACCELEROMETER, missing, "加速度");
        register(sm, l, Sensor.TYPE_GYROSCOPE, missing, "陀螺仪");
        register(sm, l, Sensor.TYPE_LIGHT, missing, "光线");
        register(sm, l, Sensor.TYPE_PROXIMITY, missing, "距离");
        try {
            latch.await(1500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignore) {}
        sm.unregisterListener(l);

        StringBuilder sb = new StringBuilder();
        if (hasAccel[0]) {
            double g = Math.sqrt(accel[0] * accel[0] + accel[1] * accel[1] + accel[2] * accel[2]);
            // 姿态：以重力分量推算
            double pitch = Math.toDegrees(Math.atan2(-accel[0], Math.sqrt(accel[1] * (double) accel[1] + accel[2] * (double) accel[2])));
            double roll = Math.toDegrees(Math.atan2(accel[1], accel[2]));
            String pose;
            if (Math.abs(accel[2]) > 8.0) pose = accel[2] > 0 ? "平放屏幕朝上" : "平放屏幕朝下";
            else if (Math.abs(accel[1]) > 8.0) pose = accel[1] > 0 ? "竖直立着（如架在支架上）" : "倒竖";
            else if (Math.abs(accel[0]) > 8.0) pose = "横竖侧立";
            else pose = "倾斜拿着";
            sb.append(String.format(Locale.US, "加速度: x=%.2f y=%.2f z=%.2f m/s²（合 %.2f，%s）\n",
                    accel[0], accel[1], accel[2], g, Math.abs(g - 9.81) < 0.6 ? "静止" : "在动"));
            sb.append(String.format(Locale.US, "姿态: %s（俯仰 %.0f° 翻滚 %.0f°）\n", pose, pitch, roll));
        } else {
            sb.append("加速度: 无数据\n");
        }
        if (hasGyro[0]) {
            double w = Math.sqrt(gyro[0] * gyro[0] + gyro[1] * gyro[1] + gyro[2] * gyro[2]);
            sb.append(String.format(Locale.US, "陀螺仪: x=%.3f y=%.3f z=%.3f rad/s（%s）\n",
                    gyro[0], gyro[1], gyro[2], w < 0.05 ? "无转动" : "正在转动"));
        } else {
            sb.append("陀螺仪: 无数据\n");
        }
        if (light[0] >= 0) {
            String lvl = light[0] < 10 ? "黑暗" : light[0] < 100 ? "昏暗" : light[0] < 500 ? "室内正常" : light[0] < 2000 ? "明亮" : "强光/户外";
            sb.append(String.format(Locale.US, "光线: %.0f lux（%s）\n", light[0], lvl));
        }
        if (prox[0] >= 0) {
            sb.append(String.format(Locale.US, "距离: %.1f cm（%s）\n", prox[0], prox[0] < 4 ? "有遮挡/贴近" : "无遮挡"));
        }
        if (missing.length() > 0) sb.append("设备无传感器: ").append(missing);
        return sb.toString().trim();
    }

    private static void register(SensorManager sm, SensorEventListener l, int type, StringBuilder missing, String name) {
        Sensor s = sm.getDefaultSensor(type);
        if (s == null) {
            if (missing.length() > 0) missing.append("、");
            missing.append(name);
            return;
        }
        sm.registerListener(l, s, SensorManager.SENSOR_DELAY_NORMAL);
    }
}
