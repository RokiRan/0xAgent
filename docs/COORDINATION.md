# 多 Agent 协调设计宣言（0xAgent）

> 著录规范（抄自 cumora `docs/COORDINATION.md`）：每条反模式必须附**事故日期、
> 可复现的观测签名、修复物**三件套，缺一即退化为风格偏好清单。
> 总原则：**竞态用代码机制解决，误判用提示词解决，两者永不混用。**

## 反模式清单

### 1. 宽 cap 等于没有 cap

- **事故日期**：2026-08-24
- **观测签名**：team 房间最近 1 小时 34 条 agent 广播，`/metrics` 中 `lapping`/`hard_cap`
  拦截 0 次。三个 agent 在纯技术话题上互相 judge 恒 YES（「话题与专长相关 → YES」永远成立），
  互评无限续轮。
- **根因**：human-present 的 discussion cap 取 20/轮，三 agent 互评永远用不满，
  硬地板从未触发。闸门「存在但不可达」等于没有闸门。
- **修复物**：cap 20 → 6（≈ 2-3 agent × 2 次交换一轮），人不在场时回落严格 lapping；
  常量上方钉回归注释（`http-transport.ts` two-tier floor 处）。
- **教训**：闸门的数值要按「一轮正常讨论实际用多少」校准，不是按「容忍多少浪费」校准。
  调大 cap 前先重读本条。

### 2. 成员籍靠一次性 join，重启即失

- **事故日期**：2026-08-23
- **观测签名**：registry 部署重启后，所有 agent 对房间消息的回复全部 403
  （`Sender not in channel`）。web-gateway 只在 `connect()` 时 join 过一次 channel，
  registry 内存状态丢失后 gateway 变成「房间里不存在的人」，fan-out 全灭且 UI 无报错。
- **根因**：成员籍被当作一次性动作而非需要持续维持的事实。
- **修复物**：`BUS_CHANNELS` 经 BusGateway 构造参数传入 `HttpTransport.channels`，
  30s 心跳每次重 join（自愈）；`server.ts` channels 配置处钉回归注释。
- **教训**：任何「启动时做一次」的外部状态登记，都要问一句——对端重启后谁把它补回来？
  答案是心跳/读时自愈，不是重部署。

### 3. 计数器在被看不见的东西重置

- **事故日期**：2026-08-24（与 #1 同次调查）
- **观测签名**：广播风暴期间 `lapping` 拦截数为 0，与预期不符。
- **根因**：调查中发现 gateway fan-out 的人类消息未带 `human:true` 标记时，
  agent 间的 relay 也会污染 rounds；且旧代码 k3-agent 不受新 prompt 约束仍在轮转。
  **registry 侧闸门是唯一对所有版本 agent 都生效的防线。**
- **修复物**：human 标记只打在人类消息上；lapping/cap 全部在 registry 写入临界区裁决，
  agent 侧 judge 只是软层。
- **教训**：多版本 agent 共存是常态。行为约束若只在新版 agent 的 prompt/代码里，
  旧版 agent 就是永远绕过的洞。关键闸门必须在 registry/服务端。

### 4. 假完成没有外力拦截（本轮修复前）

- **事故日期**：2026-08-24（预防性著录，机制先于事故落地）
- **观测签名**：agent 提交任务 evidence 全文直接追加，review 前无任何对账；
  「好的我来做」式确认与真实交付在 schema 上等价。
- **修复物**：验收门（`task-board.ts` verifyCompletion）——submit 进 review 前小脑
  对账 acceptance × evidence，`complete=false` 自动退回返工带 next_step，
  连续 2 次不过标红留人裁；验收器自身故障按 `complete:false` 处理。
- **教训**（cumora §10）：验收真相源必须是 agent 无法凭空生成的东西——
  另一个模型的对账、DB 行状态、或人类的裁定，绝不能是声明者自己的措辞。

## 常量校准记录

| 常量 | 值 | 出处 | 校准依据 |
|---|---|---|---|
| human-present discussion cap | 6/轮 | 反模式 #1 | 一轮正常讨论 ≈ 2-3 agent × 2 次交换 |
| human-present 窗口 | 10 min | 既有设计 | 人类注意力衰减的经验拍频 |
| hold-token TTL | 120 s | 既有设计（cumora 同值） | HELD 重跑以秒计，长 TTL 会把让出的 hold 变成「未来绕闸弹药」 |
| MAX_VERIFY_REJECTS | 2 | 反模式 #4 | 返工第 3 次的边际收益 < 烧掉的 token，交人裁 |
| rate floor | 30 msg/min/agent | 既有设计（cumora 同值） | 内容盲的激活地板，判断留给 judge |
