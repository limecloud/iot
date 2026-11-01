# MQTT 报文与设备通信规范

更新日期：2026-11-01。状态：协议 v1 设计草案；尚未发布。平台定义应用报文，传输遵循 [MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)。

## 1. 连接与 Topic

原生设备默认连接家庭网关 Broker；设备 mTLS 身份映射到设备与家庭绑定。用户名、Client ID、Topic 和正文中的 ID 均不能单独授予身份。Broker ACL 限制设备只读本设备命令、只写本设备上行，默认拒绝通配订阅和跨家庭访问。

```text
limeiot/v1/{space_id}/{device_id}/up/hello
limeiot/v1/{space_id}/{device_id}/up/state
limeiot/v1/{space_id}/{device_id}/up/event
limeiot/v1/{space_id}/{device_id}/up/result
limeiot/v1/{space_id}/{device_id}/down/welcome
limeiot/v1/{space_id}/{device_id}/down/command
limeiot/v1/{space_id}/{device_id}/availability
```

网关拥有独立受控连接身份。桥接设备由适配器生成内部观测，不伪装成持有原生设备证书的 MQTT 客户端。

## 2. 报文字段

| 字段 | 范围和含义 |
| --- | --- |
| `v` | 应用协议主版本，v1 固定整数 1 |
| `kind` | `hello`、`welcome`、`state`、`event`、`command`、`result`、`availability` |
| `message_id` | 每个逻辑消息唯一；重发保持相同 ID |
| `device_id` | 与已验证连接和 Topic 一致 |
| `model_revision` | 发布模型正文摘要；握手与业务消息一致 |
| `boot_id` / `seq` | 设备上行必须具备；每次启动新 boot_id，同启动严格递增 seq |
| `session_id` | welcome 建立的当前应用会话，后续业务消息绑定 |
| `body` | 按 kind 校验的有界数据 |

seq 范围为 0 至 `2^53-1`；达到上限前建立新启动代次。消息身份与命令身份分开，避免把状态重发误识别为动作重试。

## 3. 握手和时间

设备发送 hello，包含随机挑战、固件与硬件版本、模型修订、启动代次及能力。网关核对当前绑定后返回 welcome，包含新 session_id、挑战响应、认证时间、上行与报文限额。设备校验成功后进入 ready，并上报完整快照。

每次重连建立新应用会话，旧会话排队的命令拒绝执行。MQTT session 恢复不等于应用命令继续有效。只有当前 boot/session 的 Will 与在线事件可以改变当前连接状态。

命令有 `issued_at`、`expires_at`，以网关可信时间为依据；设备通过认证时间同步建立单调时钟映射。时间不可验证时拒绝有时效的副作用，不绕过 TLS 时间校验。首次安全引导和时钟恢复见 [12](12-身份认证与安全体系.md)。

## 4. 状态、事件和命令

状态正文含 `snapshot` 或 `delta` 类型、属性路径和值；delta 依赖的快照修订不匹配时请求完整快照。每项属性保留观测时间；云同步时间不能冒充设备观测时间。

事件正文含事件路径、事件 ID、发生时间和数据。掉线期间可缓存允许补传的历史事件，但必须标记历史；过期按键等事件不能重新触发实时规则。补传能力与规则的历史政策明确配置。

命令正文含 `command_id`、`issued_at`、`expires_at`、`operation`。v1 首个操作为 `property.set`，包含 `path` 和类型化 `value`；动作调用另定义参数 Schema。设备先校验身份/会话、期限、模型、能力、值和去重记录，再驱动硬件。

结果含原 command_id、执行状态、稳定错误码、证据类型和观测引用。Broker PUBACK 不能转换成设备确认。设备确认也只证明设备报告的阶段，不能夸大为独立物理测量。

## 5. QoS、缓存与消息限制

| 类别 | QoS | Retained | 恢复政策 |
| --- | --- | --- | --- |
| hello/welcome | 1 | 否 | 当前连接重新握手 |
| 状态 | 0 或 1，产品明确配置 | v1 不保留原始 state | 网关保存当前快照，重连重报 |
| 事件 | 1；高频类可显式采用 0 | 否 | 受限补传、去重和历史标记 |
| 命令/结果 | 1 | 否 | 原命令核对，按幂等政策处理 |
| availability/Will | 1 | 可保留 | 必须携带 boot/session，拒绝旧会话覆盖 |

建议初始上限为单包 16 KiB、有限对象深度和每设备频率配额，实施时由低端 MCU 测量确认。禁止在此通道传输固件大文件；OTA 使用独立受控下载接口。

MQTT Message Expiry 是附加传输保护，设备仍检查应用期限。删除 Broker 队列不等于撤销已到达设备的命令。

## 6. 重复、乱序与崩溃

同启动同序列同摘要视为重发；相同身份不同摘要拒绝并告警。boot_id 不在当前有效代次的消息不得覆盖最新状态，可作为有标记的历史保存。每设备保证处理顺序，不承诺跨设备全局顺序。

设备维护有界命令回执和必要的耐久去重记录，平衡写放大。执行意图持久化与实际硬件动作之间仍可能崩溃；非幂等动作处于未知时只查询或人工核对，不能换 command_id 重发。

## 7. 协议错误与验收

稳定错误包括 `unsupported_version`、`model_mismatch`、`session_mismatch`、`command_expired`、`invalid_value`、`unsupported_capability`、`duplicate_conflict`、`execution_unknown`。错误正文不回显密钥和完整恶意负载。

验证错误 Topic、跨设备发布、旧会话消息、重复/乱序、未知模型、超大包、时间回拨、队列过期和断电边界。测试向量与示例见 [examples](examples/README.md)。
