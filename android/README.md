# Android Bus Agent（com.oxagent.bus）

把一台安卓手机变成 0xAgent 总线上的 agent 实例：接入 registry 渠道，接收任务，用无障碍 + 三层读屏操作手机，用前置摄像头感知现场，用端侧 ASR 听写，把结果回传渠道 / Web UI。

纯 Java 手搓管线，**无 Gradle、无 Android Studio 依赖**。

---

## 构建

```bash
bash android/build.sh    # 产物 android/bus-agent.apk
```

管线：aapt2 compile/link（`--extra-packages` 生成库 R、多 `-A` 挂库 assets、`--auto-add-overlay`）→ javac（classpath = android.jar + 全部 classes.jar）→ d8（`--min-api 26`，自动 multidex）→ zip 塞 classes*.dex + arm64 .so → apksigner。

**铁律**：过滤构建输出时必须 `set -o pipefail`，否则编译失败时 grep 照样命中 error 行返回 0，会拿旧 APK 部署。

**大文件**：`app/src/main/assets/asr2/model.int8.onnx`（239MB，SenseVoice ASR 模型）走 Git LFS。clone 后必须 `git lfs pull`，否则构建出的 APK 会回落到 zipformer 兜底引擎（见下文 ASR 一节）。

## 部署与配置（adb 全 headless）

```bash
adb install -r android/bus-agent.apk
adb shell am start -n com.oxagent.bus/.MainActivity \
  --es agentId android-agent --es registry http://<registry>:9876 \
  --es token <BUS_TOKEN> --es channel team --es mmKey <MiniMax key> --es autostart 1
```

每次 `install -r` 后必须重走无障碍翻转（三星坑）：

```bash
adb shell settings put secure accessibility_enabled 0
adb shell settings put secure enabled_accessibility_services com.oxagent.bus/com.oxagent.bus.PhoneOperatorService
adb shell settings put secure accessibility_enabled 1
# 成功标志：logcat / 日志页出现「无障碍服务已连接」
```

**不要 `am force-stop`**：无障碍会永久不重绑；onStartCommand 有防双跑守卫。

## 界面

- **日志页**（默认）：深色全屏日志，钉底自动跟随；上翻解除跟随，回到底部恢复
- **配置面板**：点日志区展开，30s 无操作自动收起；含全部连接参数、启动/停止、电池优化、无障碍入口，以及两个人工测试页（人脸检测、语音识别）
- **防烧屏（OLED）**：日志页/配置面板 30s 无任何触摸 → 盖全黑层（OLED 像素熄灭）；点一下揭开回日志页并重新计时 30s。任何触摸（滚动/输入/点按钮）都会重置计时。仅覆盖 MainActivity；人脸检测、语音识别两个测试页（独立 Activity）无此逻辑。黑屏期间 Android 12 的相机/麦克风隐私指示灯仍由系统显示，属正常

## 能力

### 操作手机（PhoneOperatorService + LLM 工具循环）

27 个工具：open_app / click_text / tap / input_text / scroll / back / home / long_press / set_clipboard / find_text / wechat_send / camera_look / send_photo 等。operatorLoop 最多 12 步，全程 SCREEN_BRIGHT_WAKE_LOCK。

### 三层读屏（screenContext）

1. **a11y 树**（>80 字符优先）——微信 8.0.76 对整个无障碍体系返回空树，手势仍有效
2. **端侧 OCR**（ML Kit 中文 bundled，~0.3s，坐标实测）
3. **云端视觉**（MiniMax-M3，40~90s，仅兜底；必须 `reasoning_split:true`、max_tokens ≥ 4096、全尺寸截图）

### 注视听写（GazeListener，可开关）

前置摄像头常开 + ML Kit FaceLandmarker 虹膜估计：连续注视镜头 ≥200ms 开始听写，移开 ≥500ms 结束，识别文字进日志。配置面板开关或 adb `--es gazeListen 1`。

### 端侧 ASR（AsrHelper，完全离线）

双引擎按资产存在性择一，对外 API 一致（GazeListener / MicHelper / AsrTestActivity 无感知）：

| 引擎 | 资产 | 说明 |
|------|------|------|
| SenseVoice-small int8 | `assets/asr2/`（~239MB，LFS） | 首选，中英日韩粤，质量高；非流式，Session 内缓冲 PCM，peek 节流重解码，finish 出终稿 |
| streaming zipformer small 中英双语 | `assets/asr/`（~20MB） | 兜底，真流式但质量差 |

本机系统识别服务（Bixby trampoline）拒绝第三方绑定（bind error 10，已实证），sherpa-onnx 是唯一可行的端侧 ASR 路线。录音上限 120s。

### 频道图片附件

`camera_look` 拍照落盘 → `send_photo` 上传 → registry `/files` 落地 → gateway `/bus-files` 代理 → Web UI 渲染。

## 保活（三星 SM-G9750 / Android 12 实证）

- **机器必须一直插电**；`svc power stayon true`（仅充电时生效）
- WifiLock HIGH_PERF + `dumpsys deviceidle whitelist +com.oxagent.bus`（息屏 1~2 分钟 WiFi 节能会饿死 socket）
- 锁屏 adb 去不掉，必须人手设「无」
- 健康标志：日志页 `poll alive (N)` 每 60s；操作轨迹 `op <tool> → <result>`

## 验证

```bash
# 渠道成员里应能看到 android-agent
curl -s -H 'x-bus-token: <TOKEN>' "http://<registry>:9876/channels/members?channel=team"
```

## 已知边界

- 群聊只回 @；不支持 config/power 类消息；无 filesystem/shell 工具
- OCR 对艺术字/图标有误差；宏只覆盖微信发消息，其余流程走通用工具循环
