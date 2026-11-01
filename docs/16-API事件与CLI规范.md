# API、事件与 CLI 规范

更新日期：2026-11-01。状态：目标合同；以下端点和命令尚未实现。OpenAPI、JSON Schema 和工具投影应从同一正式动作定义生成。

## 1. 业务入口

| operation_id | 目标 HTTP | 语义 |
| --- | --- | --- |
| `spaces.list` | `GET /api/v1/spaces` | 当前主体可见空间 |
| `devices.list` / `devices.get` | `GET /api/v1/spaces/{space_id}/devices[/…]` | 有界列表/详情 |
| `models.get` | `GET /api/v1/model-releases/{revision}` | 精确模型正文 |
| `commands.create` | `POST /api/v1/spaces/{space_id}/commands` | 校验、幂等受理控制 |
| `commands.get` | `GET /api/v1/spaces/{space_id}/commands/{command_id}` | 原命令与证据 |
| `rules.validate` / `rules.simulate` | `POST /api/v1/spaces/{space_id}/rules:validate` / `rules:simulate` | 显式校验与无实机模拟 |
| `rules.deploy` | `POST /api/v1/spaces/{space_id}/rule-deployments` | 部署固定版本 |
| `tasks.get` / `tasks.cancel` | `GET /api/v1/spaces/{space_id}/tasks/{task_id}` / `POST …:cancel` | 任务原状态与取消请求 |
| `capabilities.list` | `GET /api/v1/spaces/{space_id}/capabilities` | 当前可见能力与合同 |
| `models.invoke` | `POST /api/v1/spaces/{space_id}/model-invocations` | 有预算的模型调用 |
| `media.create` | `POST /api/v1/spaces/{space_id}/media` | 取得受控上传任务 |
| `packages.validate` / `packages.deploy` | `POST /api/v1/spaces/{space_id}/packages:validate` / `package-deployments` | 校验与部署组合包 |

路径中的 `…` 仅表示文档缩写，生成正式合同必须展开完整路径和参数。每项正式入口有认证、scope、资源和字段限制；尚未支持的动作不得出现在可执行目录中。

## 2. 上下文与版本

请求固定主体、space_id、应用及环境（适用时），并包含调用/任务关联。上下文来自验证的会话或 Token 绑定，正文不能覆盖它。并发任务不能共享可变全局“当前空间”。

区分软件版本、协议主版本、模型正文修订、动作合同修订、资源修订和映射版本。客户端发现精确动作及输入输出；执行再核验当前权，不能信任客户端自报“支持”。

## 3. 写入与结果

副作用提交使用 `Idempotency-Key`，需要原资源修订时使用 `If-Match` 或合同明确字段。服务端规范化请求摘要；同键同参数回读原操作，同键不同参数返回冲突。

异步受理返回 202、原 operation/task/command 引用和查询入口。成功 HTTP 表示调用或受理阶段，不等于设备动作完成。结果包含状态、当前修订、证据、观察时间和允许的下一步；部分完成保留逐项结果。

需要预览的变更提供正式 prepare 合同，冻结对象、参数摘要、差异、版本和期限；确认只提交这个准备结果。普通低风险已授权控制不强制采用重型准备流程。

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
