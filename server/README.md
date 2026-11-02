# Go 控制面

开源 Go/Gin 模块化单体，MySQL 8.4 持久化账户会话、云空间、配对与审计。独立构建，不导入 LimeCloud 或官网私有包。消费方的 `Sessions`、`Registry`、`IdentityProvider` 接口分别隔离存储与外部身份。

当前提供账户、配对、受限远程 API 及可选同源 Console/Admin 页面，已与 Rust 本地审核、明确批准、原绑定恢复及家庭 PWA 接通。可选WSS提供机器认证、保活、设备/物模型读取、命令创建及原操作查询，独立控制面CLI与Swift/Kotlin控制面库已接入这些任务；两端云界面已有源码，Android APK通过构建，手机运行待验收。现有NAS家庭控制不依赖此服务。

## 验证

需要 Go 1.26.10、Docker，以及本地已有 `mysql:8.4` 镜像。从仓库根运行：

```sh
npm run test:control
```

命令创建自己的无宿主挂载临时 MySQL，仅发布随机回环端口；生成独立测试库/凭据，执行显式迁移、真实 HTTP/OIDC 提供方夹具、Go race 和 vet，并构建/启动真实 API 进程验证登录、建空间及重启后的原会话恢复，结束后关闭并清理自己创建的进程和容器。不会读取已有数据库。报告保存在忽略目录 `.dev/control-test/report.json`。直接 `go test ./...` 会跳过 MySQL 联调，不能替代此命令。

根目录运行 `npm run test:pairing` 额外构建家庭 PWA/Rust，验证真实 Go/MySQL、Rust、CLI、Chromium 和 NAS 恢复。覆盖云提交后丢失响应、重启不重发 claim、只读 status 恢复、本地/云撤销、迟到结果及配对码不进事件/SQLite明文；NAS恢复使用原机器私钥。报告为 `.dev/pairing-test/report.json`，不代表 WSS、真实身份提供方或 NAS 容器验收。

`npm run test:relay` 使用同样的隔离MySQL，另由测试CA签发真实HTTPS/WSS服务证书，复验上述三项检查并验证Rust出站连接、持续心跳、重启/断流重连、移除CA拒绝连接、本地设备继续控制和两侧撤销。报告为 `.dev/relay-test/report.json`。Go TLS负例同时覆盖origin/空间/主体/revision/签名篡改、跨连接重放、重复连接不替换和浏览器身份拒绝；Node/Go/Rust固定向量复签通过。它不证明设备远程转发或Cloudflare/Railway部署。

提供方夹具验证签名、issuer、audience/azp、nonce、PKCE、单次 flow、当前 userinfo、外部故障及退出；不代表已登记真实 LimeCloud 客户端或获得其账号/模型能力。

`npm run test:remote` 复用上述检查，增加真实WSS/MySQL/MQTT模拟设备闭环：设备与模型读取、同键/并发/异参、明确拒绝、回执丢失、原键过期恢复、Go/Rust进程重启、两侧撤销、跨空间及Admin隔离。报告为 `.dev/remote-test/report.json`。MySQL检查包含v1显式升级v2、迁移历史缺口拒绝、当前owner/scope/绑定在写事务内复核、原结果耐久恢复和迟到状态不降级。宿主进程与模拟设备通过不代表NAS整套容器、真实硬件或公网部署通过。

## 私有运行

物模型校验与定义兼容性比较通过 `ModelValidator` 窄接口调用共享Rust组件。先构建 `cargo build --locked -p limeiot-model-validator`，将二进制加入 PATH，或给API进程设置 `LIMEIOT_MODEL_VALIDATOR=/absolute/path/to/limeiot-model-validator`。仅这些检查需要该组件；缺失时返回503 `validator_unavailable`，不影响账户、空间及就绪探针。两种模式共用单次3秒、最多4个并发进程、输出64KiB与每地址每分钟30次预算；不调用shell、不保存报告或改变产品草稿。当前Console和Origin/CSRF隔离保持有效，详见[校验](../contracts/model-validation.md)与[兼容性](../contracts/model-compatibility.md)合同。`npm run test:models`从核心根运行专用隔离验收。

模型发布HTTP见[签名发布合同](../contracts/model-release.md)。新增显式迁移v5，保留v1–v4原字节；发布、原决定和审计在同事务提交。部署者另行准备独立Ed25519 PKCS#8 PEM私钥，使用绝对路径变量 `LIMEIOT_MODEL_RELEASE_KEY_FILE`，文件仅运行身份可读（0600），不把真实密钥写进仓库。缺配置关闭新签名，非法配置拒绝启动；旧制品和原决定可继续读取。当前 `/api/console/v1/publisher` 分配当前主体命名空间，`POST /api/console/v1/products/{product}/releases` 要求草稿修订和上一发布ID，`GET /api/catalog/v1/model-releases/{release}` 只公开已提交模型。尚未接入发布界面、控制面发布CLI和网关安装，不能视为设备全链已交付。

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

迁移由部署者显式执行；API只检查版本与校验和，不自动执行DDL。当前v1保留初始表，v2增加远程原命令表，v3增加原生授权表与配额guard，v4增加发布者产品及草稿原决定表，按序保存每版摘要；v1–v3原字节不变，未知版本、历史缺口和旧摘要改变均拒绝。MySQL DDL不具备整体事务性，失败可能保留已建表，应调查错误并使用同一固定版本恢复。迁移只适用于本模块管理的专用库，不可将 `CREATE IF NOT EXISTS` 当作既有表差异修复器。

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
| `LIMEIOT_<受众>_INSTALLATION_ID` / `LIMEIOT_<受众>_SPACE_ID` | 可选、必须成对；仅 production Cloud，用于固定已批准安装的专用入口。授权请求显式传入，ID Token 与每次 UserInfo 同时核对；公共 Console 通常留空，按当前用户发现安装 |

固定回调为 `<对应 origin>/api/console/v1/auth/callback` 和 `<对应 origin>/api/admin/v1/auth/callback`。通用 OIDC 只请求 `openid profile`，指定 Cloud 环境时补充 `email`；成员与网关控制权留在 IoT，不把平台登录 scope 当家庭授权。私有模式可同时配置 OIDC，本地凭据继续独立工作。

每次授权使用独立、HttpOnly/SameSite=Lax 的短期流程 Cookie，按随机 state 区分，多个标签页不会互相覆盖。每个受众最多保留 8 个待完成流程，5 分钟后过期；取消授权会消费并清除对应流程。回调仍要求原浏览器 Cookie、单次 state、nonce 和 PKCE，兼容部署前已发起的旧式短期流程。反向代理只转发当前受众的 Cookie，回调仅转发与其 state 对应的流程 Cookie。

discovery 的授权/token/userinfo/JWKS/撤销端点须与 issuer 同 scheme/host，HTTP 客户端禁止重定向，不关闭 TLS 校验。需要跨 origin 的身份提供方须先评审适配合同。当前无自动刷新令牌，外部令牌到期后重新登录。

边缘代理可配置 `LIMEIOT_CONTROL_EDGE_TOKEN_FILE`；启用后业务回源请求必须携带固定 `X-LimeIoT-Edge-Token`。只有验证后才接受本平台代理写入的 `X-LimeIoT-Client-IP` 供限流。代理必须覆盖这两个头，禁止直接暴露带共享凭据的后端；不信任任意 `X-Forwarded-*`。

未设置 `LIMEIOT_CONTROL_LISTEN` 时优先使用平台 `PORT`，监听 `0.0.0.0`；没有 `PORT` 则默认回环17890。`GET /health/live` 只检查进程存活，`GET /health/ready` 用两秒期限检查当前数据库/迁移版本。只有这两个精确 GET 路径允许平台探针免 Host 和边缘凭据，不返回业务或配置细节；其他 API 继续严格检查。就绪不依赖 LimeCloud 或模型在线。

## API

正式入口见 [OpenAPI](../contracts/control.openapi.yaml) 与 [配对证明](../contracts/control-pairing.md)。认证路径 `/api/console/v1/auth/*` 与 `/api/admin/v1/auth/*` 分开；创建空间、申请配对、列表和撤销位于 Console，Admin 只提供实例状态与脱敏绑定摘要。

所有已认证写操作需精确 `Origin` 与当前 `X-CSRF-Token`。GET session 返回 CSRF，外部凭据留在加密数据库字段。机器 review/claim/status 将 code 放 JSON 请求体，禁止放 URL、日志或模型；status只读原绑定，不创建或激活。控制面不代理任意 HTTP，不接受 Admin 凭据执行家庭设备动作。

## 出站机器连接

网关显式启用后连接 `/api/gateway/v1/connect`，固定子协议 `limeiot.relay.v1`；一次性挑战由当前绑定的公钥验签，不使用浏览器Cookie或配对码。最多128条连接、每客户端每分钟30次尝试；心跳每5秒重新检查当前绑定，12秒无有效心跳关闭。当前进程退出主动关闭WebSocket，连接表不持久化；仅支持单副本。

Console所有者可读取 `GET /api/console/v1/spaces/{space}/gateways/{gateway}/connection`；Admin凭据不能读取家庭连接。connected仅表示当前传输已认证，不表示设备在线或已执行。完整证明、边缘转发和撤销边界见 [机器连接合同](../contracts/control-relay.md)。

## 受限远程控制

当前Console所有者可通过 `/api/console/v1/spaces/{space}/devices` 分页读取设备，通过 `model-releases/{revision}` 读取模型；需要原绑定的devices.read。POST `remote-commands` 需要commands.write，正文含request_key、gateway_id、binding_revision、device_id、model_revision、expires_at和operation，完整Schema见OpenAPI。

新请求只在网关当前在线时受理。MySQL先提交unknown意图再发送一次；每空间最多保留1024条，满后拒绝新操作。同一原键同参只返回旧记录，异参409，原期限过去也不重新发送。调用方须先耐久保存完整参数及原键，响应丢失后GET `remote-commands/by-key/{key}` 恢复；不能换键补发。

GET原操作只读云记录；显式POST `remote-commands/{remote}/reconcile`、正文 `{}`，仅查询网关同来源的原remote_id。未找到、网络断流和重启不能证明设备没执行。accepted/dispatched表示网关观察状态；confirmed附带原设备结果。终态与已观察到的unknown不被迟到受理结果覆盖，网络错误不擦除已有证据。已发送操作遇到断网时，仍须核实原结果。

WSS每连接最多16个待返回请求，单次等待8秒；委托最长10秒，本地在受理及分发前分别复核。没有离线控制队列或自动重放；连接重建不扫描unknown重发。当前只支持单副本，连接不跨实例路由。机器授权、MQTT信封、本地命令列表和浏览器Cookie不通过此接口开放。

## Console 与 Admin

在仓库根执行 `npm run build:control`，为Go进程配置绝对构建路径：

```sh
export LIMEIOT_CONSOLE_WEB_DIR="/absolute/iot/apps/console/dist"
export LIMEIOT_ADMIN_WEB_DIR="/absolute/iot/apps/admin/dist"
```

打开对应origin的 `/console/` 或 `/admin/`。未配置目录时返回 `web_not_installed`。仅提供index和构建资产，拒绝目录列表、源码路径和符号链接逃逸；页面保留对应受众的Host与边缘回源检查。HTML不缓存，带hash的静态资产可缓存；CSP限制为本站脚本和连接。

Console支持空间创建与原键恢复、网关配对/撤销、设备及物模型读取、布尔/数值属性控制和原操作查询。操作记录只包含当前浏览器保存的本人原操作；配对码仅保存在页面内存，刷新后使用原键恢复配对信息。发送前保存完整原请求，存储失败不发送；命令恢复只查询原记录或显式reconcile，不重发create。退出、刷新及重新登录保留原操作身份。

Admin通过独立身份读取 `/api/admin/v1/status` 的存储可用性、已认证机器连接数/容量，以及最近1000条脱敏绑定摘要；不能使用该身份执行家庭设备控制。模型定义及兼容性检查归Console；正式签名发布、固件/OTA任务、接入治理和完整审计页面仍待实现。

`npm run test:console` 构建两份Web并运行隔离MySQL、Go race/vet、真实浏览器、WSS和MQTT模拟设备检查，报告位于 `.dev/control-web-test/report.json`。身份和API不由Service Worker缓存。安装、容器制品与Railway配置见 [控制面交付](../deploy/control/README.md)；当前未据宿主进程结果声明容器或正式云部署通过。

## 产品物模型草稿

Console的“产品”独立于家庭空间，提供当前主体的产品列表、名称和物模型JSON编辑、最新版本读取、明确采用新修订与原操作恢复。创建/保存的完整输入及attempted标记先落盘，存储失败不发请求；退出、刷新、重新登录后只GET原操作。修订冲突保留输入，不能自动覆盖。Admin不能访问草稿，原生客户端暂未提供产品编辑。

后端通过`ProductDrafts`窄接口隔离MySQL，v4显式迁移保存产品、不可变操作快照及同事务审计。每主体最多128个产品、1024条操作，满额不回收原键。`revision`是随机聚合修订，`document_digest`只表示JCS正文摘要；产品始终为draft/unvalidated，不执行正式模型校验、签名、发布或设备绑定切换。HTTP200也可能为conflict，消费者必须读status。

完整字段、幂等摘要、并发和恢复见 [草稿合同](../contracts/control-products.md)。`npm run test:products`独立运行Console/Admin构建、共享输入边界、真实临时MySQL/Go race/vet/迁移、Chromium及CLI故障检查；使用回环HTTP，不包含网关、硬件、NAS容器或正式云部署。

## 控制面 CLI

入口为 `npm run cli -- control schema`，目录`contracts/tools/control.json`与本地Bearer工具隔离，使用当前Console Cookie和CSRF。私有模式通过受控凭据文件登录；官方账号从Console显式创建独立CLI会话并导入。`POST /api/console/v1/auth/cli`只接受本人Console会话、精确Origin、CSRF与空对象，返回最长一小时的独立会话材料，不改变父Cookie或导出外部Token。每次使用子会话均重新核对原父会话及当前提供方身份；父登录退出/到期或撤销时失效，不支持再次委派。

子会话退出只撤销自身，不影响父网页登录或撤销父外部Token。会话引用保存在既有加密凭据字段，不新增迁移。CLI将会话、配对输出和原操作保存在本人私有文件；标准输出不包含秘密。发送前保存原请求，命令恢复只读取旧键；安装、完整任务与退出码见 [CLI说明](../packages/cli/README.md)。`npm run test:control:cli`使用真实隔离控制面与MQTT模拟链路，证据报告为 `.dev/control-cli-test/report.json`。

## 原生客户端授权

后端与同站 `/console/?native=<公开ID>` 确认页已接通：原生端保存原随机键/PKCE verifier后发起五分钟请求，系统浏览器登录本人Console并输入手机授权码明确批准，原生轮询领取最长一小时的独立子会话。重复创建、批准或领取不改变原期限或重复签发；取消同事务撤销子会话，父登录退出后失效。Admin及已有子会话不能批准，手机不接收外部Token。

完整HTTP、状态、安全存储要求、OIDC固定返回与取消竞争见 [原生授权合同](../contracts/control-native.md)。`npm run test:console`包含原生授权浏览器专项。Swift/Kotlin独立授权/读取/远程客户端库已通过`npm run test:control:native`：真实HTTPS/WSS、Go/MySQL、Rust、MQTT模拟设备、Chromium批准及私有文件存储，验证远程响应丢失和Go重启后只查原操作、每端仅一条设备命令及子退出。报告标记`native_remote=true`、`transport=https`、`native_app=false`、`hardware=false`。云界面随后已接入源码，宿主状态检查和Android APK/lint通过；系统浏览器打开、手机安全存储和生命周期仍待端上验收，iOS整包缺完整SDK。仅测试适配器信任本次CA，生产TLS验证保持开启。只在测试自建数据库执行v3，没有升级用户实例。
