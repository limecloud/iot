# 已受理实时设备事件投影

[English](device-events.en.md) | [投影 Schema](device-event.schema.json)

当前本地 HTTP 轮询与 SSE 复用同一耐久事件通道：`GET /api/v1/spaces/{space}/events?after={cursor}`、`GET /api/v1/spaces/{space}/events/stream`。SSE 通过 `Last-Event-ID` 恢复游标，继续使用当前本地鉴权及会话撤销规则；没有增加控制面转发或直接订阅设备 MQTT 的权限。

网关收到SIGINT/SIGTERM时主动结束SSE，不新增业务事件或确认结果。重连后继续原游标；重启后浏览器重新登录。排空期限及串口回收见[进程启停](runtime-lifecycle.md)。

## 已实现的正文

通道外层为 `{event_id,type,space_id,payload}`。外层 `event_id` 是网关数据库游标，和设备业务事件 ID 不同。对于新的实时 `device.event`，`payload` 为 `{occurred_at,data}`：外层采集时间由原 Store 生成，`payload.data` 为 [DeviceEvent](../gateway/crates/core/src/device_events.rs) 的严格白名单投影：

| 字段 | 语义 |
| --- | --- |
| device_id、model_revision | 通过当前授权与精确绑定模型校验的来源 |
| boot_id、session_id、message_id、seq | 本次已通过会话、报文身份和序列校验的来源上下文；不能作为控制凭据 |
| event_id、path | 设备业务事件 ID 与模型事件路径 |
| occurred_at、received_at | 设备原发生时间文本（保留时区及小数写法）、核心校验使用的网关接收时间 |
| body_digest | 原事件 body 的 RFC 8785 JCS SHA-256，与耐久 `device:event_id` 去重摘要一致；不含原 body 的额外字段 |
| data | 已通过该精确模型事件 Schema 的业务数据 |

只投影完整 `ingest` 成功、首次出现、非历史且处于实时窗口的事件。复用当前实时窗口：发生时间不早于接收前5秒，不晚于接收后2秒。设备与 `event_id` 构成原耐久业务去重键；相同业务事件换信封、重连或重启后也不重新投影。相同键内容变化仍按原合同拒绝，不生成新证据。

模型、会话、序列、主题、Schema 或时间校验失败不产生业务投影。合法但历史、过期或重复的消息可能沿原通道产生 `payload.data=null` 的通知，消费者应忽略；它们不代表新事件。未识别的原 body 字段、原始信封及传输凭据不作为事件投影保存。业务 `data` 仍受产品数据政策约束，模型作者不能把凭据设计成业务数据。

## 提交、恢复与边界

原去重与规则副作用、投影记录沿原 Store 事务先提交，再公布内存变化和通知 SSE；提交失败没有可读取的投影。成功记录在网关重启后仍可按原游标读取。现有每页100条、有界约5000条保留、`event_gap` / SSE `gap` 和会话失效语义保持不变。游标过旧需重新读取所关注对象的当前状态；不能把有界事件日志当作完整历史或高频遥测仓库。

投影表明网关接受了来源及符合模型的数据，不独立证明物理结果、内容真实性或长任务完成。产品仍需按原任务、代次、动作和具体观测核对；不得仅凭路径名称把触摸事件变为停车或节目完成证据。非事件消息的通道输出形状保持原行为。

## 观测来源决定通知

托管来源绑定、撤销、拒绝和修订冲突沿同一耐久通道发布`observation.operation`，`payload.data`为[来源合同](observation-sources.md)定义的Operation。它是原请求决定，不是设备采样；消费者应重新读取当前绑定与设备状态，不能用历史applied结果重新激活已撤销来源。来源token不进入事件。

## 验证入口

```sh
cargo test --locked -p limeiot-core --test device_events
cargo build --locked -p limeiot-gateway -p limeiot-simulator
node --test "tests/device-events.test.mjs"
```

核心反例覆盖重复、恢复、历史/过期、错模型、错会话、非法序列、Schema、未来时刻和同键异参。隔离集成覆盖真实 HTTP/MQTT/SQLite、SSE/轮询一致、提交失败无投影、严格字段、重启读取与不重放；软件模拟不能替代真实玩具或传感器验收。
