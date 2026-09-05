package com.oxagent.bus;

import android.content.Context;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

/**
 * 端侧语音识别（sherpa-onnx，完全离线），双引擎按资产存在性择一：
 *   1. SenseVoice-small int8（assets/asr2/，中英日韩粤，~239MB）——首选，质量远高于 zipformer；
 *      非流式模型，Session 内部缓冲 PCM，peek 做节流全量重解码，finish 出终稿。
 *   2. streaming zipformer small 中英双语（assets/asr/，~20MB）——兜底，真流式但质量差。
 * 对外 API（available/recognize/beginSession/Session.feed/peek/finish）与引擎无关，
 * 调用方（GazeListener 听写、MicHelper、AsrTestActivity）无需感知差异。
 * 本机系统识别服务（Bixby trampoline）拒绝第三方绑定（bind error 10，已实证），
 * 这是唯一可行的端侧 ASR 路线。
 */
public class AsrHelper {

    private static final int ENGINE_NONE = 0;
    private static final int ENGINE_SENSEVOICE = 1;
    private static final int ENGINE_ZIPFORMER = 2;

    private static volatile int engine = ENGINE_NONE;
    private static volatile boolean initFailed;
    private static volatile OfflineRecognizer offline;  // sensevoice
    private static volatile OnlineRecognizer online;    // zipformer 兜底

    private static synchronized int init(Context ctx) {
        if (engine != ENGINE_NONE || initFailed) return engine;
        // SenseVoice 优先：模型在 assets 才启用（没打包时回落 zipformer）
        try {
            if (assetExists(ctx, "asr2/model.int8.onnx")) {
                OfflineSenseVoiceModelConfig sv = new OfflineSenseVoiceModelConfig();
                sv.setModel("asr2/model.int8.onnx");
                sv.setLanguage("auto");
                sv.setUseInverseTextNormalization(true);
                OfflineModelConfig model = new OfflineModelConfig();
                model.setSenseVoice(sv);
                model.setTokens("asr2/tokens.txt");
                model.setNumThreads(4);
                model.setDebug(false);
                FeatureConfig feat = new FeatureConfig();
                feat.setSampleRate(16000);
                feat.setFeatureDim(80);
                OfflineRecognizerConfig cfg = new OfflineRecognizerConfig();
                cfg.setFeatConfig(feat);
                cfg.setModelConfig(model);
                offline = new OfflineRecognizer(ctx.getAssets(), cfg);
                engine = ENGINE_SENSEVOICE;
                L.log("sherpa asr ready: sensevoice");
                return engine;
            }
        } catch (Throwable t) {
            L.log("sensevoice asr init failed, fallback zipformer: " + t);
            offline = null;
        }
        try {
            OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
            transducer.setEncoder("asr/encoder-epoch-99-avg-1.int8.onnx");
            transducer.setDecoder("asr/decoder-epoch-99-avg-1.int8.onnx");
            transducer.setJoiner("asr/joiner-epoch-99-avg-1.int8.onnx");
            OnlineModelConfig model = new OnlineModelConfig();
            model.setTransducer(transducer);
            model.setTokens("asr/tokens.txt");
            model.setNumThreads(2);
            model.setDebug(false);
            FeatureConfig feat = new FeatureConfig();
            feat.setSampleRate(16000);
            feat.setFeatureDim(80);
            OnlineRecognizerConfig cfg = new OnlineRecognizerConfig();
            cfg.setFeatConfig(feat);
            cfg.setModelConfig(model);
            cfg.setEnableEndpoint(true);
            online = new OnlineRecognizer(ctx.getAssets(), cfg);
            engine = ENGINE_ZIPFORMER;
            L.log("sherpa asr ready: zipformer（兜底，assets 无 sensevoice）");
        } catch (Throwable t) {
            initFailed = true;
            L.log("sherpa asr init failed: " + t);
        }
        return engine;
    }

    private static boolean assetExists(Context ctx, String path) {
        try (java.io.InputStream in = ctx.getAssets().open(path)) {
            return in != null;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 是否可用（任一引擎加载成功）。 */
    public static boolean available(Context ctx) {
        return init(ctx) != ENGINE_NONE;
    }
    /** 当前引擎名（"sensevoice"/"zipformer"），不可用返回 null。 */
    public static String engineName(Context ctx) {
        switch (init(ctx)) {
            case ENGINE_SENSEVOICE: return "sensevoice";
            case ENGINE_ZIPFORMER: return "zipformer";
            default: return null;
        }
    }

    /** 识别一段 16kHz mono PCM16，返回文字；失败返回 null。 */
    public static String recognize(Context ctx, byte[] pcm, int len) {
        if (init(ctx) == ENGINE_SENSEVOICE) {
            OfflineStream stream = null;
            try {
                stream = offline.createStream();
                stream.acceptWaveform(pcmToFloat(pcm, len, 8000), 16000); // 尾部补 0.5s 静音
                offline.decode(stream);
                return offline.getResult(stream).getText();
            } catch (Throwable t) {
                L.log("sensevoice decode failed: " + t);
                return null;
            } finally {
                if (stream != null) stream.release();
            }
        }
        if (engine == ENGINE_ZIPFORMER) {
            OnlineStream stream = null;
            try {
                stream = online.createStream("");
                stream.acceptWaveform(pcmToFloat(pcm, len, 16000), 16000); // 尾部补 1s 静音冲刷端点
                stream.inputFinished();
                while (online.isReady(stream)) {
                    online.decode(stream);
                }
                return online.getResult(stream).getText();
            } catch (Throwable t) {
                L.log("zipformer decode failed: " + t);
                return null;
            } finally {
                if (stream != null) stream.release();
            }
        }
        return null;
    }

    private static float[] pcmToFloat(byte[] pcm, int len, int tailSilenceSamples) {
        int n = len / 2;
        float[] samples = new float[n + tailSilenceSamples];
        for (int i = 0; i < n; i++) {
            samples[i] = (short) ((pcm[2 * i + 1] << 8) | (pcm[2 * i] & 0xff)) / 32768.0f;
        }
        return samples;
    }

    /**
     * 听写会话：持续 feed 16kHz mono PCM16 块，finish() 取最终文字。GazeListener / 测试页用。
     * sensevoice 非流式：内部缓冲样本，peek 节流全量重解码（≥1.5s 一次）；
     * zipformer：真流式边喂边解。
     */
    public static class Session {
        private final int eng;
        private final OnlineStream stream;      // zipformer
        private float[] buf = new float[16000 * 30]; // sensevoice 样本缓冲，按需翻倍
        private int bufLen;
        private String lastPeek = "";
        private long lastPeekAt;
        private Session(int eng) {
            this.eng = eng;
            this.stream = eng == ENGINE_ZIPFORMER ? online.createStream("") : null;
        }

        public synchronized void feed(byte[] pcm, int len) {
            int n = len / 2;
            if (eng == ENGINE_SENSEVOICE) {
                if (bufLen + n > buf.length) {
                    float[] bigger = new float[Math.max(buf.length * 2, bufLen + n)];
                    System.arraycopy(buf, 0, bigger, 0, bufLen);
                    buf = bigger;
                }
                for (int i = 0; i < n; i++) {
                    buf[bufLen + i] = (short) ((pcm[2 * i + 1] << 8) | (pcm[2 * i] & 0xff)) / 32768.0f;
                }
                bufLen += n;
                return;
            }
            float[] samples = new float[n];
            for (int i = 0; i < n; i++) {
                samples[i] = (short) ((pcm[2 * i + 1] << 8) | (pcm[2 * i] & 0xff)) / 32768.0f;
            }
            stream.acceptWaveform(samples, 16000);
            while (online.isReady(stream)) {
                online.decode(stream);
            }
        }

        /** 当前部分文字。sensevoice 下 ≥1.5s 才真正重解码（阻塞调用线程），其间返回上次缓存。 */
        public synchronized String peek() {
            if (eng == ENGINE_ZIPFORMER) {
                return online.getResult(stream).getText();
            }
            long now = System.currentTimeMillis();
            if (bufLen == 0 || now - lastPeekAt < 1500) return lastPeek;
            lastPeekAt = now;
            lastPeek = decodeBuf(0);
            return lastPeek;
        }

        /** 出最终文字（尾部补 0.5s 静音收尾）。 */
        public synchronized String finish() {
            if (eng == ENGINE_ZIPFORMER) {
                stream.acceptWaveform(new float[16000], 16000);
                stream.inputFinished();
                while (online.isReady(stream)) {
                    online.decode(stream);
                }
                return online.getResult(stream).getText();
            }
            return decodeBuf(8000);
        }

        private String decodeBuf(int tailSilenceSamples) {
            OfflineStream s = null;
            try {
                s = offline.createStream();
                float[] samples = new float[bufLen + tailSilenceSamples];
                System.arraycopy(buf, 0, samples, 0, bufLen);
                s.acceptWaveform(samples, 16000);
                offline.decode(s);
                return offline.getResult(s).getText();
            } catch (Throwable t) {
                L.log("sensevoice session decode failed: " + t);
                return lastPeek;
            } finally {
                if (s != null) s.release();
            }
        }

        public synchronized void release() {
            buf = new float[0];
            bufLen = 0;
            if (stream != null) {
                try { stream.release(); } catch (Throwable ignored) {}
            }
        }
    }

    /** 开始一段听写；asr 不可用返回 null。 */
    public static Session beginSession(Context ctx) {
        int eng = init(ctx);
        return eng == ENGINE_NONE ? null : new Session(eng);
    }
}
