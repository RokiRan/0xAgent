package com.oxagent.bus;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.io.File;
import java.io.FileOutputStream;

/**
 * 麦克风听取 + 端侧转写：AudioRecord 录 PCM → AsrHelper（sherpa-onnx，完全离线）转文字。
 * 系统识别服务不可用（Bixby 拒绝第三方绑定，已实证 bind error 10），不走 SpeechRecognizer。
 * sherpa 不可用时退化：存 WAV 到工作目录，可 share_file 发出。
 */
public class MicHelper {

    /** 听 seconds 秒，返回人说的话。 */
    public static String listen(Context ctx, int seconds, File workdir) {
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return "无麦克风权限（adb shell pm grant com.oxagent.bus android.permission.RECORD_AUDIO）";
        }
        if (seconds < 2) seconds = 2;
        if (seconds > 120) seconds = 120;

        int rate = 16000;
        byte[] pcm = new byte[rate * 2 * seconds];
        int len;
        int peak;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec = null;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, rate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate * 2));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) return "麦克风初始化失败";
            rec.startRecording();
            len = 0;
            long deadline = System.currentTimeMillis() + seconds * 1000L + 1000;
            while (len < pcm.length && System.currentTimeMillis() < deadline) {
                int n = rec.read(pcm, len, Math.min(4096, pcm.length - len));
                if (n > 0) len += n;
            }
            rec.stop();
        } catch (Exception e) {
            return "录音失败: " + e.getMessage();
        } finally {
            if (rec != null) rec.release();
        }

        peak = 0;
        for (int i = 0; i + 1 < len; i += 2) {
            int v = Math.abs((pcm[i + 1] << 8) | (pcm[i] & 0xff));
            if (v > peak) peak = v;
        }
        if (peak < 300) {
            return "听了 " + seconds + " 秒基本是静音（峰值 " + peak + "），没听到说话声。";
        }

        String text = AsrHelper.recognize(ctx, pcm, len);
        if (text != null) {
            text = text.trim();
            if (!text.isEmpty()) {
                return "听到（" + seconds + " 秒，端侧转写）：" + text;
            }
            return "有声音（峰值 " + peak + "）但端侧转写结果为空，可能不是人声语音。";
        }

        // sherpa 不可用兜底：存 WAV
        try {
            File dir = new File(workdir, "mic");
            dir.mkdirs();
            File wav = new File(dir, "record_" + System.currentTimeMillis() + ".wav");
            writeWav(wav, pcm, len, rate);
            return "端侧语音识别不可用，未能转文字。已录 " + seconds + " 秒音频（峰值 " + peak
                    + "）存到 mic/" + wav.getName() + "，可用 share_file 发给主人。";
        } catch (Exception e) {
            return "录音落盘失败: " + e.getMessage();
        }
    }

    private static void writeWav(File f, byte[] pcm, int len, int rate) throws Exception {
        FileOutputStream out = new FileOutputStream(f);
        int byteRate = rate * 2;
        java.nio.ByteBuffer h = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + len).put("WAVE".getBytes())
                .put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(rate).putInt(byteRate).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes()).putInt(len);
        out.write(h.array());
        out.write(pcm, 0, len);
        out.close();
    }
}
