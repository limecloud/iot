# API、事件与 CLI 规范

更新日期：2026-11-02。状态：目标合同与已实现子集并存。本地网关可执行操作以 `contracts/tools/catalog.json` 和 CLI `schema` 为准，运行方式见 [本地开发](../deploy/dev/README.md)。独立Go控制面的HTTP见 [control.openapi.yaml](../contracts/control.openapi.yaml)，CLI使用独立的 `contracts/tools/control.json`与`control schema`，不将云动作加入本地身份工具目录。本文件还包含尚未实现的任务、媒体、模型及包管理目标。OpenAPI、JSON Schema 和工具投影应从同一正式动作定义生成。

## 1. 业务入口

| operation_id | 目标 HTTP | 语义 |
| --- | --- | --- |
| `spaces.list` | `GET /api/v1/spaces` | 当前主体可见空间 |
| `devices.list` | `GET /api/v1/spaces/{space_id}/devices` | 有界设备列表 |
| `devices.get` | `GET /api/v1/spaces/{space_id}/devices/{device_id}` | 单设备详情 |
| `models.get` | `GET /api/v1/model-releases/{revision}` | 精确模型正文 |
| `commands.create` | `POST /api/v1/spaces/{space_id}/commands` | 校验、幂等受理控制 |
| `commands.get` | `GET /api/v1/spaces/{space_id}/commands/{command_id}` | 原命令与证据 |
| `drafts.create` | `POST /api/v1/spaces/{space_id}/rule-drafts` | 幂等创建文字联动草案，202 仅表示推理已受理 |
| `drafts.list` | `GET /api/v1/spaces/{space_id}/rule-drafts` | 有界草案列表 |
| `drafts.get` | `GET /api/v1/spaces/{space_id}/rule-drafts/{draft_id}` | 查询原草案、状态和错误 |
| `drafts.resolve` | `GET /api/v1/spaces/{space_id}/rule-drafts/by-key/{key}` | 丢失响应后按原键恢复，不重调模型 |
| `rules.validate` | `POST /api/v1/spaces/{space_id}/rules:validate` | 显式校验规则 |
| `rules.simulate` | `POST /api/v1/spaces/{space_id}/rules:simulate` | 无实机副作用的模拟 |
| `rules.deploy` | `POST /api/v1/spaces/{space_id}/rule-deployments` | 部署固定版本 |
| `tasks.get` | `GET /api/v1/spaces/{space_id}/tasks/{task_id}` | 任务原状态 |
| `tasks.cancel` | `POST /api/v1/spaces/{space_id}/tasks/{task_id}:cancel` | 请求取消原任务 |
| `capabilities.list` | `GET /api/v1/spaces/{space_id}/capabilities` | 当前可见能力与合同 |
| `models.invoke` | `POST /api/v1/spaces/{space_id}/model-invocations` | 有预算的模型调用 |
| `media.create` | `POST /api/v1/spaces/{space_id}/media` | 取得受控上传任务 |
| `packages.validate` | `POST /api/v1/spaces/{space_id}/packages:validate` | 校验组合包 |
| `packages.deploy` | `POST /api/v1/spaces/{space_id}/package-deployments` | 部署固定组合包 |

每项正式入口有认证、scope、资源和字段限制；尚未支持的动作不得出现在可执行目录中。列表采用有上限的 `limit`、不透明 `cursor` 和 `next_cursor`，游标绑定当前空间、主体及筛选条件，换条件时重新开始分页。

草案正式输入见 `contracts/draft-request.schema.json`。CLI 将 `space_id` 映射到路径、`idempotency_key` 映射到 `Idempotency-Key` 请求头；HTTP 正文仅为 `prompt/expires_at`。需求不超过 512 字符和 2048 字节，截止时间在未来 120 秒内。响应含 `draft_id`、状态、请求/上下文摘要、提供方/模型、可选规则/修订、用量和错误。`completed` 不表示部署或执行；原生端和 PWA 均需预演与明确启用。并发忙返回 429 `inference_busy`，未配置模型返回 503；不自动重试或切云。其余状态与恢复语义见 [11](11-AI与Agent接入设计.md)。

本地 `control-pairings.create/list/get/resolve/approve/reconcile/revoke` 已实现，使用 `/api/v1/spaces/{space_id}/control-pairings`，输入映射与冻结审批见 [正式配对合同](../contracts/control-pairing.md)。`approve` 须本人核对 `review_revision`；`reconcile` 在已批准后只查询原云绑定，不能重发claim。CLI遇到unknown返回6，保留原键与link_id；active只表示绑定建立，不提供远程执行权。code和密钥不得进入模型上下文。

`control-pairings.list` 另返回独立connection投影，状态为disabled/unpaired/connecting/connected/disconnected，默认关闭；连接状态不写入配对耐久状态。Console所有者读取网关连接的HTTP合同及已实现WSS帧见 [机器连接](../contracts/control-relay.md)。当前固定远程动作仅设备/模型读取、命令创建与原命令查询；控制面Cookie及CSRF独立，不复用本地Bearer。

控制面CLI通过`control schema`发现独立目录，`control invoke <operation_id>`消费相同动作。目录含空间创建/列表、配对、绑定/连接/撤销、设备/物模型和原命令。每次调用从精确origin取得当前主体与CSRF，再执行对应HTTP动作；目录不等于当前授权。私有实例从私有凭据文件登录；官方账号从Console本人明确创建的最长一小时子会话导入，父登录失效后子会话失效，且不能再委派。Admin不提供此导出。

CLI在0600原记录和0700目录中保存origin、主体、空间与完整请求，文件/目录同步后才提交；同键异参拒绝，旧命令创建只GET原键。响应丢失返回退出码6及原文件引用，不自动重试或换键。配对秘密仅写指定私有输出文件，stdout和错误不包含登录或配对材料。完整入口与退出码见 [CLI使用](../packages/cli/README.md)，正式目录与HTTP路径/输入一致性由Go合同检查覆盖。

原生授权HTTP已实现，`control.native.create/poll/cancel/review/decide`只列在正式OpenAPI，不加入本地Bearer或控制面CLI目录。原生端使用独立原键与PKCE，浏览器决定使用Console Cookie/Origin/CSRF；Schema区分approved材料与无秘密状态。Swift/Kotlin独立库已消费授权、会话、空间/网关/设备/模型及远程命令合同，通过真实HTTPS/WSS、浏览器批准及MQTT模拟链路。原请求及发送标记先保存，旧键只查询，显式核实原结果，退出保留操作。云页面已接库和平台适配器，Android构建与两端宿主状态检查通过；iOS整包及两端运行验收仍缺证据。`hasPendingAuthorization`仅为本地恢复读取，不增加HTTP操作或自动创建授权。流程、错误与恢复见 [原生授权](../contracts/control-native.md)。

开源Console/Admin已消费对应控制面HTTP合同，安装与范围见 [控制面](../server/README.md)。`GET /api/admin/v1/status`需要当前Admin身份，仅返回存储可用性、已认证连接数/容量与采样时间，不包含家庭/主体明细。此独立运营接口不加入本地家庭工具目录；前端页面也不扩大既有授权。

控制面`products.list/create/get/save/resolve`已加入独立目录，路径不含Space；当前Console主体即私有草稿发布者。创建输入为request_key/name/model，保存另需expected_revision；draft/unvalidated不代表发布。HTTP200须区分saved/conflict，冲突原决定不可变，CLI返回4；响应丢失及404只GET原键，结果未知返回6。完整输入边界、摘要及同事务存储见 [草稿合同](../contracts/control-products.md)。

无副作用的 `models.validate`、`models.compare` 使用同一Rust组件，不需要Space或原键，不改变草稿状态。比较输入为完整baseline/candidate，先判断两者valid，再判断compatible；写入保持旧输入，上报和事件保持新值可被旧读取者接受。两种模式共享限流和并发预算，模型错误/不兼容退出2，组件故障退出5。离线 `model validate/compare` 不需要会话。完整报告、摘要绑定与边界见 [定义校验](../contracts/model-validation.md)和[兼容性](../contracts/model-compatibility.md)。

## 2. 上下文与版本

请求固定主体、space_id、应用及环境（适用时），并包含调用/任务关联。上下文来自验证的会话或 Token 绑定，正文不能覆盖它。并发任务不能共享可变全局“当前空间”。

区分软件版本、协议主版本、模型正文修订、动作合同修订、资源修订和映射版本。客户端发现精确动作及输入输出；执行再核验当前权，不能信任客户端自报“支持”。

## 3. 写入与结果

副作用提交使用 `Idempotency-Key`，需要原资源修订时使用 `If-Match` 或合同明确字段。服务端规范化请求摘要；同键同参数回读原操作，同键不同参数返回冲突。

CLI/Agent 的命令创建输入示例见 [command-request.json](examples/command-request.json)，其 `space_id` 映射到路径、`idempotency_key` 映射到请求头，其余业务字段进入正文。服务端再生成 command_id、message_id、issued_at，并绑定当前设备会话形成 [MQTT 命令](examples/mqtt-command.json)。业务输入不接受调用方伪造的设备会话或执行身份；输入中的空间选择必须与当前授权一致。该设计示例覆盖属性写入；当前属性/动作正式输入以 [command-request.schema.json](../contracts/command-request.schema.json) 和[命令合同](../contracts/commands.md)为准。

异步受理返回 202、原 operation/task/command 引用和查询入口。成功 HTTP 表示调用或受理阶段，不等于设备动作完成。结果包含状态、当前修订、证据、观察时间和允许的下一步；部分完成保留逐项结果。

需要预览的变更提供正式 prepare 合同，冻结对象、参数摘要、差异、版本和期限；确认只提交这个准备结果。普通低风险已授权控制不强制采用重型准备流程。

### 3.1 动作调用与电视接入

电视控制复用 `commands.create/get/resolve`、当前授权、原键和设备证据。当前命令支持 `property.set` 与 `action.invoke`；动作参数放在 operation.value，按精确模型 input 校验，confirmed 再核对 action_result 的输入摘要、output、completion 和时间。字段及证据范围统一见[命令合同](../contracts/commands.md)。

离散按键具有短期限、有界顺序和原命令去重，未知时只核实原操作；不跨 Agent/ADB 路径补发，不以进程退出码证明目标界面已变化。Rust 核心、Go 远程输入/回执及控制面 CLI 已加入动作分支；CLI 重新核对完整原请求 JCS 摘要和动作证据，精确模型校验仍归 Rust。远程与本地 path 均最多129个字符、每段最多64个字符。

家庭网页及Swift/Kotlin客户端按模型提供遥控、应用启动和其他动作参数，并按证据显示“输入已提交”或“效果已观测”。原生云回执现接受属性/动作；两端绑定完整原输入、核对证据外壳，正式JCS摘要与精确模型规则仍由Go/Rust验证。软件入口分别为 `npm run test:actions`、`npm run test:actions:native` 和 `npm run test:control:native`。第一方路由与受限ADB已有软件证据；DSL invoke、TV Agent及原生界面端上仍需实现或验收。具体路径见 [34](34-电视终端与AndroidTV接入.md)，当前结果统一见 [24](24-实施计划与进度.md)。

现有空间的本地执行接入另提供 execution-adapters.list、execution-bindings.get、device-applications.list、execution-changes.create/resolve，复用所有者会话或Bearer，未自动加入控制面远程目录。绑定/撤销正文、HTTP路径、当前修订、原请求先保存及只读恢复规则统一见[执行合同](../contracts/execution-routes.md)和[机器Schema](../contracts/execution-bindings.schema.json)，不另建电视命令入口。HTTP 200须读取applied/conflict/rejected；候选兼容不授信，旧applied不复活撤销。本地接入与事件刷新已有完整软件旅程，实机与生产仍另验，详见24第4.7节。

## 4. 错误与未知恢复

错误采用稳定 `code`、`message_key`、参数、字段错误、request_id、operation_ref 和 retry_class。典型代码：unauthenticated、forbidden、invalid_value、revision_conflict、unsupported_capability、command_expired、operation_unknown、provider_unavailable、budget_exceeded。

自动重试仅适用于明确安全的读或具有原键恢复语义的调用；超时、取消等待和 403 均不能证明原副作用未发生。查询原操作、重新准备和人工接管按具体合同提供，不编造通用恢复端点。

## 5. 事件订阅

本地可采用 SSE，必要双向通道采用独立 WebSocket 合同。事件含 event_id、space_id、aggregate_id/version、type、source、occurred_at、received_at、correlation_id 和有类型数据。

订阅先鉴权并持续响应撤权；以游标恢复，有界保留，游标过旧返回 gap 并提供快照重建方法。关键事件持久化语义见 [09](09-Rust网关内核设计.md)，不保证无限历史或跨设备全局顺序。

## 6. CLI 与 Agent 工具

```text
limeiot schema [operation_id]
limeiot capabilities list --space-id ID --json
limeiot devices list --space-id ID --json
limeiot commands get COMMAND_ID --space-id ID --json
limeiot rules validate FILE --space-id ID
limeiot rules simulate FILE --fixture FILE --space-id ID
limeiot models invoke --input FILE --space-id ID --json
limeiot packages inspect FILE --json
limeiot diagnose device DEVICE_ID --space-id ID --json
```

CLI 默认机器可读模式，明确支持 JSON/NDJSON 和可选 table。非交互模式缺必要输入立即返回结构化错误；不自动弹浏览器、猜空间或安装插件。`--dry-run` 仅本地预览并标明未执行远端授权，不能代替 prepare 或本人批准。

退出码建议：0 调用完成且业务结果可接受，2 参数/合同错误，3 认证/授权，4 冲突/不支持，5 外部故障，6 结果未知或需继续，7 明确业务失败。异步受理在输出中保留 accepted 状态，消费者必须按状态跟进，不凭退出码判断设备完成。

MCP 工具通过精确输入/输出 Schema 调用同一领域用例，结构化内容与可读文本同义；界面按钮也走正式工具。公开文档、Skills 和工具描述不存放密钥或当前业务事实。

## 7. 验收

验证合同生成一致性、分页完整性、字段过滤、幂等冲突、并发修订、未知恢复、断流游标和跨端同义结果。一个动作在 GUI、CLI、MCP 通过相同用例后，才声明多端完整适配。
