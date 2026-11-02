# 属性写入与动作调用合同

当前命令共用 `commands.create/get/resolve`、设备身份、当前模型修订、期限与原操作账本。请求结构见 [command-request.schema.json](command-request.schema.json)，本地发现目录见 [catalog.json](tools/catalog.json)，远程投影见 [OpenAPI](control.openapi.yaml)。动作定义见 [物模型校验](model-validation.md)；结果证据的类型化来源为 [protocol.rs](../gateway/crates/core/src/protocol.rs)，校验规则由 [engine.rs](../gateway/crates/core/src/engine.rs) 执行。

新命令将原账本受理序号编码到command_id并令下行message_id与其一致；用户客户端仍将ID作为不透明值。设备可选择 [回执确认扩展](command-receipts.md) 保存耐久退休边界并回收已确认结果；未协商设备不接收额外握手字段或确认，历史命令ID仍可查询，既有期限、授权与副作用语义保持原合同。

## 输入与模型

`operation` 严格包含 `type`、`path`、`value`。`property.set` 的 value 是属性目标值；`action.invoke` 的 value 是动作输入，按绑定模型的 `input` 校验，不另增 `arguments` 字段。

```json
{
  "type": "action.invoke",
  "path": "remote.press",
  "value": { "key": "home" }
}
```

这是 operation 子对象，不能作为完整命令直接提交。完整请求另需空间、设备、精确模型修订、原幂等键和期限；HTTP 按对应入口将空间与幂等键映射到路径和请求头。命令到期时间必须晚于受理时间，且不超过其后30秒；遥控交互应选择更短期限。模型中的 `risk` 是风险元数据，不自动授予权限，也不表示后端已有按风险分级的批准流程。

Schema 1 保留属性/事件子集，`actions` 必须为空；Schema 2 支持类型化动作。路径为 `service_id.member_id`，两段分别最多64个 ASCII 字符。设备只可执行实际绑定模型中的能力，不能仅凭品类名称或存在一份电视模型获得控制权。

## 结果证据

`confirmed` 的动作结果必须携带严格的 `action_result` 证据。例如上述输入对应：

```json
{
  "type": "action_result",
  "path": "remote.press",
  "input_digest": "sha256:77abdb28f9e099bb4458e7ea695b998de74270d0bfc60f4691c812bb70be406f",
  "output": {},
  "completion": "submitted",
  "observed_at": "2026-11-02T00:00:00Z"
}
```

时间为示例，不能用于新请求。网关核对原设备/会话/命令、path、原 `operation.value` 的 RFC 8785 JCS 摘要、输出 Schema，以及与模型一致的 completion；`observed_at` 不早于 issued_at 前2秒，不晚于接收当前时间后2秒。消息仍受会话、序列与去重约束。

| completion | 已确认的范围 | 呈现与限制 |
| --- | --- | --- |
| `submitted` | 执行端报告输入已提交给目标执行系统 | 显示“输入已提交”，不能推导焦点、前台应用或物理结果 |
| `observed` | 执行端报告模型定义所要求的效果已被观测 | 提供方须有相应回读/观测依据；字段和 Schema 校验本身不能证明效果真实发生 |

动作回执不直接修改属性 `reported`；状态观测使用独立上报。属性写入的 confirmed 仍要求 `device_result` 中对应 reported 值等于原目标值。MQTT PUBACK、HTTP 受理、ADB 退出码各自只说明相应阶段。

设备报告 unknown 时沿用 `error=execution_unknown`、`evidence.type=device_result` 的现行合同；这是未能确认执行结果的通用证据，不是动作成功证据。confirmed/failed 终态拒绝冲突结果覆盖。

## 顺序、重复与恢复

同键同请求回读原命令，同键异参冲突；传输消息身份与业务命令身份分别保留。每设备最多32条 accepted/dispatched 命令，超限为 `device_queue_full`。网关按持久受理序号分发，同设备最多一条未到期 dispatched；排队期间仍检查期限、会话和当前授权。

已发送命令超时成为 unknown，重启恢复也不自动重发。`idempotent=true` 是动作语义声明，当前不据此启用自动重试。未知命令不保证阻止用户后续新操作，也不证明其副作用已停止；客户端恢复只查询原操作，不补发过期按键或换路径重复执行。当前[第一方静态执行路由](execution-routes.md) 已固定单条命令的执行端；动态切换与原生 TV Agent 仍需实现。

## 当前消费者与验证边界

Rust 模型/命令核心、家庭网页和模拟器已接入动作；Go 远程输入/回执与控制面 CLI 已加入动作分支。本地 HTTP/MQTT 与 Chromium 软件旅程、远程动作完整旅程及实机验收分别记录，结果以 [实施进度](../docs/24-实施计划与进度.md) 为准。

| 消费者 | 校验与职责边界 |
| --- | --- |
| Rust 核心 | 核对当前授权、绑定模型的 input/output 与 completion、设备会话、原命令及精确时间范围；拥有命令状态机 |
| Go 远程入口 | 核对原请求和完整请求摘要；confirmed 动作拒绝错误、未知/重复证据字段、错 path/输入摘要、缺失或 null 输出、非法完成范围和时间 |
| 控制面 CLI | [共享 JS 回执校验](../packages/protocol/command-receipts.mjs) 重新计算完整请求 JCS 摘要，绑定原设备、模型、期限、键与动作证据；旧 create 仍只查原键 |
| 家庭网页/模拟器 | 网页按模型生成遥控与应用启动控件，记录原操作并展示完成范围；模拟器只报告 submitted，不模拟已观测的界面效果 |
| Swift/Kotlin 客户端 | 解析模型动作，创建 action.invoke；核对完整原请求、动作证据字段、摘要格式、完成范围和时间；正式 JCS 摘要与精确模型校验由 Go/Rust 完成 |

Go 与 CLI 只验证回执外壳和原操作绑定，不能替代 Rust 的精确模型输出/完成范围校验，也不能独立证明物理效果。远程可见的回执不包含 issued_at，时间下界按 expires_at 前32秒作保守检查；Rust 仍执行 issued_at 前2秒的精确下界。远程 operation.path 与本地合同一致，总长度最多129，两段分别最多64个字符。

Swift/Kotlin 原生云客户端已分别接受属性 device_result 与动作 action_result；NAS/云界面共用按模型生成的动作控件和原操作恢复。原生界面构建、宿主库联调和手机端上运行分别验收，结果见实施进度。自动化 DSL 的 invoke、通用进程插件与 TV Agent 仍需单独实现。

[android-tv.json](models/android-tv.json) 是 Schema 2 能力组合定义，包含遥控按键、应用启动、音量和静音；它不证明任何型号已实现。应用 ID 的长度校验不替代执行端的已发现应用清单和授权白名单。当前完整属性快照要求仍适用，不能用虚构的音量/静音值使不完整适配进入 ready。

[android-tv-remote.json](models/android-tv-remote.json) 是独立的仅动作模型，不含属性/事件；原生空属性快照及外部适配会话分别提供真实接入状态。`npm run test:tv` 验证当前网页到假 ADB 的 HTTP/SQLite 路由，执行前按固定身份、已启用包和当前白名单核对；结果只确认 submitted，不能沿用为音量、实机或 TV Agent 支持。

核心专项：`cargo test --locked -p limeiot-core --test actions`。本地集成入口：`npm run test:actions`，先构建当前家庭网页及 Rust workspace，再验证回执、真实 HTTP/MQTT、虚拟动作设备、Chromium 桌面/手机视口、丢响应恢复和重启不重发。远程集成入口为 `npm run test:remote`，其动作旅程是否通过须另看实施进度，不能沿用历史属性旅程结论。这些软件夹具不能替代电视遥控、权限和故障实测，也不提供物理 exactly-once 保证。

原生本地动作入口：`npm run test:actions:native`，需 Swift、JDK 21 和 Android 构建工具；两端使用真实 HTTP/MQTT 与虚拟设备验证模型发现、遥控/应用启动、丢响应后只查原键和完成范围。`npm run test:control:native` 分别验证两端的属性与动作 HTTPS/WSS/MySQL/MQTT 旅程，每个旅程只允许一条原云命令和一条设备命令。
