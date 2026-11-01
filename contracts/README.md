# 当前工具与模型合同

`tools/catalog.json` 列出本版本已经实现的操作与输入 Schema。CLI 和 HTTP 发现端点消费同一个目录；核心按类型化 Rust 合同再次校验，调用者提供的正文不能覆盖授权空间或设备会话。

`models/` 是灯光和按钮的固定发布正文，修订由 RFC 8785 JCS 后的 SHA-256 计算。`examples/button-light.json` 是可校验和部署的事件规则；不含任意代码、模型调用或外部 URL。

当前只实现模型和 DSL 的明确子集，未知字段、未支持动作与非空条件被拒绝。完整产品规划仍在工程规范，未实现的目标不进入可执行工具目录。运行与验证见 [本地开发](../deploy/dev/README.md)。

`control-pairing-request.schema.json` 与 `control-pairings.*` 定义本地所有者的网关配对工具；[证明与恢复合同](control-pairing.md) 说明审核、批准、未知结果只读恢复和独立机器密钥。独立 Go 控制面接口见 [OpenAPI](control.openapi.yaml)，不共享本地会话或空间身份。[机器连接](control-relay.md) 及 `control-relay.schema.json` 定义已实现的可选出站WSS认证与保活，不提供设备动作转发或远程执行工具。

## 当前会话合同

家庭Web、Swift和Kotlin客户端使用同一个所有者会话：

| 操作 | 请求 | 结果 |
| --- | --- | --- |
| 登录 | `POST /api/v1/auth/session`，JSON `{"token":"本地所有者凭据"}`，精确`Origin` | `authenticated`、`csrf_token`、`expires_at`和HttpOnly会话Cookie |
| 恢复 | `GET /api/v1/auth/session`，原Cookie | 验证当前会话，失效返回401 |
| 写操作 | 原Cookie、精确`Origin`、`X-CSRF-Token` | 共用当前领域操作与错误语义 |
| 退出 | `POST /api/v1/auth/logout`，同样的来源与CSRF校验 | 撤销服务器会话，返回204并清Cookie |

HTTPS使用`__Host-limeiot_session`、Secure、HttpOnly、SameSite=Strict、Path=/；仅回环开发HTTP使用不带Secure前缀的实验Cookie。会话有效期8小时，最多32个，重启失效。每分钟5次失败登录后限流；原始所有者凭据不作为日常客户端Bearer。CLI可继续使用Bearer，但带Origin的Bearer请求被拒绝。

所有路径校验安装时的精确Host/Origin，私有API不缓存。SSE持续检查当前会话，撤销后发送`session.expired`并结束。命令受理响应丢失时，通过`commands.resolve`按原幂等键恢复；`commands.list`每页100条，`next_cursor`用于下一页。规则停用带当前`revision`，不同版本返回`revision_conflict`，保留历史运行与命令。

客户端在发送前耐久保存原操作身份；本地保存失败时不得发送。超时、5xx、408、幂等冲突或无法识别的响应都不能证明设备操作未受理，须保留身份并查询，不生成新键重发。待查询身份与会话分开保存，会话过期或退出后保留，重新登录同一网关后继续查询；明确的4xx拒绝可以结束本次提交。
