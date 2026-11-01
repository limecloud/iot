# Go 控制面

开源 Go/Gin 模块化单体，MySQL 8.4 持久化账户会话、云空间、配对与审计。独立构建，不导入 LimeCloud 或官网私有包。消费方的 `Sessions`、`Registry`、`IdentityProvider` 接口分别隔离存储与外部身份。

当前提供账户和配对 API，已与 Rust 本地审核、明确批准、原绑定恢复及家庭 PWA 接通。可选WSS机器认证、保活和连接状态已实现；设备动作转发、远程工具、Console/Admin 页面仍待实现。OIDC 回调目的地已保留，但本模块当前不提供这些页面。现有 NAS 家庭控制不依赖此服务。

## 验证

需要 Go 1.26.10、Docker，以及本地已有 `mysql:8.4` 镜像。从仓库根运行：

```sh
npm run test:control
```

命令创建自己的无宿主挂载临时 MySQL，仅发布随机回环端口；生成独立测试库/凭据，执行显式迁移、真实 HTTP/OIDC 提供方夹具、Go race 和 vet，并构建/启动真实 API 进程验证登录、建空间及重启后的原会话恢复，结束后关闭并清理自己创建的进程和容器。不会读取已有数据库。报告保存在忽略目录 `.dev/control-test/report.json`。直接 `go test ./...` 会跳过 MySQL 联调，不能替代此命令。

根目录运行 `npm run test:pairing` 额外构建家庭 PWA/Rust，验证真实 Go/MySQL、Rust、CLI、Chromium 和 NAS 恢复。覆盖云提交后丢失响应、重启不重发 claim、只读 status 恢复、本地/云撤销、迟到结果及配对码不进事件/SQLite明文；NAS恢复使用原机器私钥。报告为 `.dev/pairing-test/report.json`，不代表 WSS、真实身份提供方或 NAS 容器验收。

`npm run test:relay` 使用同样的隔离MySQL，另由测试CA签发真实HTTPS/WSS服务证书，复验上述三项检查并验证Rust出站连接、持续心跳、重启/断流重连、移除CA拒绝连接、本地设备继续控制和两侧撤销。报告为 `.dev/relay-test/report.json`。Go TLS负例同时覆盖origin/空间/主体/revision/签名篡改、跨连接重放、重复连接不替换和浏览器身份拒绝；Node/Go/Rust固定向量复签通过。它不证明设备远程转发或Cloudflare/Railway部署。

提供方夹具验证签名、issuer、audience/azp、nonce、PKCE、单次 flow、当前 userinfo、外部故障及退出；不代表已登记真实 LimeCloud 客户端或获得其账号/模型能力。

## 私有运行

先创建独立 MySQL 数据库及专用账户；业务服务不需要创建/修改表权限，迁移账户单独配置。以下文件由部署者按自己的实例准备，限制访问并排除版本控制：

| 文件 | 内容 |
| --- | --- |
| `control.key` | 32随机字节的64位十六进制文本，AES-256-GCM 密钥 |
| `console.token` | 至少32字节的随机本地所有者凭据 |
| `admin.token` | 独立的至少32字节随机实例管理员凭据 |
| `mysql.dsn` | 驱动 DSN，例如 `USER:PASSWORD@tcp(127.0.0.1:3306)/DATABASE?charset=utf8mb4` |

密钥与数据库须一起安全备份。不要在浏览器永久存储本地凭据；登录仅生成 HttpOnly Cookie。本地凭据轮换后，使用旧凭据建立的本站会话在下次访问时失效。

```sh
export LIMEIOT_CONTROL_MODE=private
export LIMEIOT_CONTROL_LISTEN=127.0.0.1:17890
export LIMEIOT_CONTROL_ORIGIN=http://127.0.0.1:17890
export LIMEIOT_CONTROL_KEY_FILE="/absolute/private/control.key"
export LIMEIOT_CONSOLE_TOKEN_FILE="/absolute/private/console.token"
export LIMEIOT_ADMIN_TOKEN_FILE="/absolute/private/admin.token"
export LIMEIOT_CONTROL_MYSQL_DSN_FILE="/absolute/private/mysql.dsn"
cd server
go run ./cmd/migrate
go run ./cmd/api
```

迁移由部署者显式执行；API 只检查版本与校验和，不自动执行 DDL。MySQL DDL 不具备整体事务性，失败可能保留已建表，应调查错误并使用同一固定版本恢复；成功版本校验和改变时拒绝继续。迁移只适用于本模块管理的专用库；当前只有初始版本，不可将 `CREATE IF NOT EXISTS` 当作既有表差异修复器。

公网/局域网用户入口使用 HTTPS 反向代理，将原 Host 保持为配置 origin 的 Host。HTTP 仅允许字面回环 IP，`localhost` 不视为可发布 origin。`LISTEN` 是内部监听地址，不是用户入口。

## 官方云与可选 OIDC

`LIMEIOT_CONTROL_MODE=cloud` 禁止本地凭据。Console/Admin 分别配置以下环境变量，受众替换为 `CONSOLE` 或 `ADMIN`：

| 变量 | 作用 |
| --- | --- |
| `LIMEIOT_<受众>_ORIGIN` | 精确 HTTPS origin，默认继承控制面 origin，可同域 |
| `LIMEIOT_<受众>_OIDC_ISSUER` | 精确 discovery issuer，支持路径 |
| `LIMEIOT_<受众>_OIDC_CLIENT_ID` | 独立登记的标准 OIDC 客户端 ID，两端必须不同 |
| `LIMEIOT_<受众>_OIDC_SECRET_FILE` | 客户端 Secret 文件，不放前端或固件 |
| `LIMEIOT_ADMIN_OPERATOR_SUBJECTS` | 显式逗号分隔的运营主体 subject 允许列表，云模式必填 |

固定回调为 `<对应 origin>/api/console/v1/auth/callback` 和 `<对应 origin>/api/admin/v1/auth/callback`。只请求 `openid profile`；成员与网关控制权留在 IoT，不把平台登录 scope 当家庭授权。私有模式可同时配置 OIDC，本地凭据继续独立工作。

discovery 的授权/token/userinfo/JWKS/撤销端点须与 issuer 同 scheme/host，HTTP 客户端禁止重定向，不关闭 TLS 校验。需要跨 origin 的身份提供方须先评审适配合同。当前无自动刷新令牌，外部令牌到期后重新登录。

边缘代理可配置 `LIMEIOT_CONTROL_EDGE_TOKEN_FILE`；启用后业务回源请求必须携带固定 `X-LimeIoT-Edge-Token`。只有验证后才接受本平台代理写入的 `X-LimeIoT-Client-IP` 供限流。代理必须覆盖这两个头，禁止直接暴露带共享凭据的后端；不信任任意 `X-Forwarded-*`。

未设置 `LIMEIOT_CONTROL_LISTEN` 时优先使用平台 `PORT`，监听 `0.0.0.0`；没有 `PORT` 则默认回环17890。`GET /health/live` 只检查进程存活，`GET /health/ready` 用两秒期限检查当前数据库/迁移版本。只有这两个精确 GET 路径允许平台探针免 Host 和边缘凭据，不返回业务或配置细节；其他 API 继续严格检查。就绪不依赖 LimeCloud 或模型在线。

## API

正式入口见 [OpenAPI](../contracts/control.openapi.yaml) 与 [配对证明](../contracts/control-pairing.md)。认证路径 `/api/console/v1/auth/*` 与 `/api/admin/v1/auth/*` 分开；创建空间、申请配对、列表和撤销位于 Console，Admin 只有脱敏绑定摘要。

所有已认证写操作需精确 `Origin` 与当前 `X-CSRF-Token`。GET session 返回 CSRF，外部凭据留在加密数据库字段。机器 review/claim/status 将 code 放 JSON 请求体，禁止放 URL、日志或模型；status只读原绑定，不创建或激活。控制面不代理任意 HTTP，不接受 Admin 凭据执行家庭设备动作。

## 出站机器连接

网关显式启用后连接 `/api/gateway/v1/connect`，固定子协议 `limeiot.relay.v1`；一次性挑战由当前绑定的公钥验签，不使用浏览器Cookie或配对码。最多128条连接、每客户端每分钟30次尝试；心跳每5秒重新检查当前绑定，12秒无有效心跳关闭。当前进程退出主动关闭WebSocket，连接表不持久化；仅支持单副本。

Console所有者可读取 `GET /api/console/v1/spaces/{space}/gateways/{gateway}/connection`；Admin凭据不能读取家庭连接。connected仅表示当前传输已认证，不表示设备在线或已执行。完整证明、边缘转发和撤销边界见 [机器连接合同](../contracts/control-relay.md)。
