package com.oxagent.bus;

import android.content.Context;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineRecognizer;
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

/**
 * 端侧语音识别（sherpa-onnx + 流式 zipformer 中文 14M int8 模型，完全离线）。
 * 模型在 assets/asr/，首次加载 ~1-2s，识别器单例复用。
 * 本机系统识别服务（Bixby trampoline）拒绝第三方绑定（bind error 10，已实证），
 * 这是唯一可行的端侧 ASR 路线，也覆盖未来「持续监听」场景。
 */
public class AsrHelper {

    private static volatile OnlineRecognizer recognizer;
    private static volatile boolean initFailed;

    private static OnlineRecognizer get(Context ctx) {
        if (recognizer != null || initFailed) return recognizer;
        synchronized (AsrHelper.class) {
            if (recognizer == null && !initFailed) {
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
                    recognizer = new OnlineRecognizer(ctx.getAssets(), cfg);
                    L.log("sherpa asr ready");
                } catch (Throwable t) {
                    initFailed = true;
                    L.log("sherpa asr init failed: " + t);
                }
            }
        }
        return recognizer;
    }

    /** 是否可用（模型/库加载成功）。 */
    public static boolean available(Context ctx) {
        return get(ctx) != null;
    }

    /** 识别一段 16kHz mono PCM16，返回文字；失败返回 null。 */
    public static String recognize(Context ctx, byte[] pcm, int len) {
        OnlineRecognizer rec = get(ctx);
        if (rec == null) return null;
        OnlineStream stream = null;
        try {
            stream = rec.createStream("");
            int n = len / 2;
            float[] samples = new float[n + 16000]; // 尾部补 1s 静音冲刷端点
            for (int i = 0; i < n; i++) {
                samples[i] = (short) ((pcm[2 * i + 1] << 8) | (pcm[2 * i] & 0xff)) / 32768.0f;
            }
            stream.acceptWaveform(samples, 16000);
            stream.inputFinished();
            while (rec.isReady(stream)) {
                rec.decode(stream);
            }
            return rec.getResult(stream).getText();
        } catch (Throwable t) {
            L.log("sherpa asr decode failed: " + t);
            return null;
        } finally {
            if (stream != null) stream.release();
        }
    }
}
