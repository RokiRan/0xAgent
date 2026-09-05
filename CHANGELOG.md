# Changelog

本项目的重要变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- **android: OLED 防烧屏** — 日志/配置界面 30s 无任何触摸自动盖全黑层（OLED 像素熄灭，三星 OLED 屏防烧屏）；点一下揭开回日志页并重新计时 30s。基于 `dispatchTouchEvent` 分发前拦截重置计时，不影响原有点击/滚动语义；揭开黑屏的首次点击不会穿透误开配置面板（MainActivity）
- **android: ASR 双引擎** — AsrHelper 重构为按资产存在性自动择引擎：首选 SenseVoice-small int8（`assets/asr2/`，中英日韩粤，~239MB，走 Git LFS），兜底 streaming zipformer 中英双语（`assets/asr/`）；对外 API（available/recognize/beginSession/Session.feed/peek/finish）与引擎无关，GazeListener 听写、MicHelper、测试页无需感知差异
- **android: 语音识别测试页** — AsrTestActivity「按住说话，松开出结果」，配置面板入口直达
- **android: 仓库文档** — 新增 `android/README.md`（构建/部署/无障碍/能力/保活/验证全手册）与本 CHANGELOG

### Changed

- **android: 录音上限 30s → 120s**（MicHelper），配合 SenseVoice 非流式整段解码
- **repo: 大模型文件改走 Git LFS** — `android/app/src/main/assets/asr2/model.int8.onnx`（239MB，超 GitHub 100MB 硬限制）。clone 后需 `git lfs pull` 才能构建出 SenseVoice 引擎的 APK，否则自动回落 zipformer

## [2026-09-06]

### Added

- **android: bus-agent 安卓 app** — 手机变 0xAgent 实例，27 工具含硬件感知（3a6d790）
- **频道图片附件端到端** — agent send_photo 上传 → registry /files 落地 → gateway /bus-files 代理 → webui 渲染（e30f9fb）
- **android: 人脸检测可视化测试页** — 配置面板入口，实时预览 + 端侧判定（586c11f）
- **android: 注视触发听写** — 虹膜注视估计，看镜头 200ms 起录、移开 500ms 结束（ba150dd）

### Changed

- **android: ASR 换中英双语 sherpa 流式模型**（173ad09）

### Removed

- **android: 废弃的 ML Kit face-mesh 依赖** — APK -16MB（8074286）

## [2026-08-26]

### Added

- **agent 底层能力接线** — 生产路径接工具循环，planner/memory/MCP 补全（3b15e9d）
