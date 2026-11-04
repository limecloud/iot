# 本地 AI 能力目录

`GET /api/v1/spaces/{space_id}/ai-catalog` 提供当前空间的只读发现。机器合同为 [ai-catalog.schema.json](ai-catalog.schema.json)，工具操作为 `ai-catalog.list`。沿用本地所有者会话或 Bearer 认证，其他空间返回 403，匿名返回 401。

## 发现与调用

```sh
node packages/cli/src/main.mjs schema ai-catalog.list
node packages/cli/src/main.mjs ai-catalog list --space-id space-demo
node packages/cli/src/main.mjs invoke ai-catalog.list --space-id space-demo
```

凭据和网关地址沿用 [CLI 配置](../packages/cli/README.md)。Agent 从 `definitions` 选择能力，检查对应部署，再以 `create_operation`、`input_schema` 和正式工具目录构造调用。调用、恢复和清除仍遵循各能力合同，不绕过原请求保存、预算、期限或明确授权。发现本身不创建任务、连接提供方、下载模型或发布设备命令。

家庭网页、NAS 私有工作台及 SwiftUI/Compose 的“设置 → AI 服务”提供统一目录入口。查看详情后可进入已有自动化、对话、视觉或音频页面，打开页面不启动推理。目录查询失败、校验失败或离线时清除旧调用入口；配置在网关重启后重新发现。原生页面在后台、离页与会话变化时取消读取并清除目录，返回前台重新读取，不持久保存目录或探测提供方。

原生 SDK 使用 `try await gateway.aiCatalog(space: "space-demo")`（Swift）或 `gateway.aiCatalog("space-demo")`（Kotlin），复用已认证的网关连接。`AiCatalog.parse` 可离线校验原始 JSON：最多32 KiB、8层、2048节点，重复键与损坏字段拒绝；条目提供稳定能力编号、定义、部署与配置。入口只从经过校验的能力枚举选择本地页面，不采用服务端URL作为导航目标。

## 响应

| 字段 | 含义 |
| --- | --- |
| `definitions` | 五类已实现能力的稳定编号、模态、输入合同、任务合同及创建/恢复操作 |
| `deployments` | 当前进程实际装配的提供方身份和配置；未配置能力不生成部署条目 |
| `health` | 每类能力一项；有部署为 `unknown`，没有部署为 `not_configured`；`checked_at` 为 `null` |
| `routing` | 按当前固定配置选择，不自动切换或回退提供方 |

能力分别为 `automation.rule_draft`、`text.generate`、`vision.understand`、`audio.transcribe`、`audio.synthesize`。规则草案的设备上下文由网关构造，不表示调用者能提交任意设备上下文。该旧接口没有完整任务 Schema，`task_schema` 为 `null`；规则结果仍按 [规则合同](rule.schema.json) 校验并经预演和明确启用。

`configuration` 从现有 `/capabilities` 的服务段直接投影，包括实际输入输出限制、并发、声音或语言选项；不维护第二套限制注册表。新接口不会改变原 `/capabilities.models` 的含义，该字段仍表示设备物模型。

部署 `identity` 复用已有任务的 `adapter/revision/model/data_location`。规则草案仅有原 Ollama 模型标识，没有部署修订，因此 `revision` 为 `null`。其他修订是当前适配配置的身份，不等于模型权重摘要；模型标签也不能证明权重版本或质量。服务 URL、CA 文件路径、凭据和媒体正文不进入目录。

部署的 `license`、`cost_policy`、`resource_requirements`、`quality` 当前均为 `null`，表示目录未登记或核验。平台的 MIT 许可不能替代模型及权重许可，未知费用也不能解释为免费。

## 一致性与边界

JS、Swift与Kotlin消费者核对空间、版本、完整定义、唯一部署、适配器身份、已有能力限制和逐项健康状态；各自复用既有文字、视觉、ASR、TTS校验器。重复项、配置与健康矛盾、虚构健康、隐式云回退或越权设备执行声明均拒绝。原生共享向量来自本Schema与现有服务合同，并由JS消费者交叉检查。

目录只表示平台能力及当前配置。提供方停止时仍可能“已配置，健康未检测”；实际调用通过原任务返回失败或未知。目录不会代替健康探测、许可治理、质量评估、动态政策路由或多模型调度。所有能力都没有直接设备执行权，媒体合成不自动授权或播放。

## 验证

```sh
npm run test:ai-catalog
npm run test:ai-catalog:native
```

入口构建家庭网页、Console/Admin 和网关，运行真实 Rust/SQLite/MQTT 上的 API/CLI 旅程以及 390px/1440px 浏览器旅程。覆盖未配置发现、五类服务投影、损坏响应拒绝、发现零推理、明确调用、不可达提供方下的手动控制、配置撤回和重启。提供方为协议夹具；该入口不构建 NAS 镜像，不启动完整原生 App，不验证真实模型质量或实机。

原生入口另外构建Swift库、运行实际目录状态层与Home状态回归，检查SwiftUI语法/工程，以及Android合同、状态、APK和lint；随后以独立Swift/JVM进程连接真实Rust/SQLite/MQTT，验证五能力发现、配置撤回及明确灯控。SwiftUI完整类型检查需要iOS SDK；宿主状态层和APK构建结果不替代完整App或系统安全存储运行。
