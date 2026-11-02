# 当前工具与模型合同

`tools/catalog.json` 列出本版本已经实现的操作与输入 Schema。CLI 和 HTTP 发现端点消费同一个目录；核心按类型化 Rust 合同再次校验，调用者提供的正文不能覆盖授权空间或设备会话。

`models/` 包含灯光、按钮及 Android TV 的模型定义，修订由 RFC 8785 JCS 后的 SHA-256 计算；目录中的定义不自动成为已签名制品或型号支持证据。`examples/button-light.json` 是可校验和部署的事件规则；不含任意代码、模型调用或外部 URL。

[电视设备Agent核心](tv-agent.md) 定义独立设备消费者的mTLS、会话、应用授权和耐久回执。Agent可选择固定的 [应用模型](models/android-tv-agent.json) 或 [遥控逻辑模型](models/android-tv-remote.json)，两者本机执行能力均只有apps.launch，remote.press须另行批准外部绑定。JVM网络/恢复、组合、Android端上与物理归属分别验收，当前未通过项见 [24第4.15节](../docs/24-实施计划与进度.md#415-tv-agent模型配置与日志迁移文档同步)。

[命令回执确认与安全回收](command-receipts.md)定义有序命令ID、设备退休边界、原结果查询及提交后确认。TV Agent日志v2/v3回收已确认最终结果，unknown/未决保留；v3保留旧模型完整原包，旧会话原动作不重放。未声明此扩展的MCU/模拟器保持原握手与结果路径，网关原命令账本仍有独立4096条上限。回收历史证据见 [24第4.13节](../docs/24-实施计划与进度.md#413-电视命令回执确认与安全回收)，当前模型/日志阶段见4.15。

[电视本机材料](tv-agent-enrollment.schema.json)是严格的单设备导入格式，v1隐含应用模型、v2必须填写model_profile；[离线打包工具](../tools/tv-agent-enrollment.py)通过--model-profile选择，只使用已签发材料并写新私有文件。Android明确确认后同事务保存加密材料及单向迁移日志，保留原记录/授权；它不变更网关模型绑定、不批准compose，也不代替生产认领或物理ADB归属证明。

[执行路由与明确绑定](execution-routes.md)定义第一方路由、候选、bind/compose/revoke、会话能力证明、跨端FIFO及应用缓存；[机器Schema](execution-bindings.schema.json)与目录中的五项execution/device-applications工具为入口。快照v7读取v1–6，保留完整分区、generation、撤销与原决定，旧绑定不自动组合。[仅动作电视模型](models/android-tv-remote.json)的协议夹具/假ADB组合旅程通过，范围见 [进度4.14](../docs/24-实施计划与进度.md#414-显式能力组合与文档同步)。真实JVM Agent组合最新未通过，已有网关设备跨模型绑定完整路线、Android端上与实机另验，见4.15；网页当前显示/撤销组合，创建使用通用CLI。

当前只实现模型和 DSL 的明确子集，未知字段、未支持动作与非空条件被拒绝。完整产品规划仍在工程规范，未实现的目标不进入可执行工具目录。运行与验证见 [本地开发](../deploy/dev/README.md)。

[属性写入与动作调用](commands.md) 定义 `property.set`、`action.invoke`、动作输入/输出证据和有界顺序队列。Schema 2 支持类型化动作，Schema 1 仍要求 actions 为空；submitted 表示输入已提交。DSL 的 actions[].set 尚未扩展为 invoke。TV Agent已有Android应用与调试APK，端上运行、同设备归并与真实电视控制仍须单独验收。

`control-pairing-request.schema.json` 与 `control-pairings.*` 定义本地所有者的网关配对工具；[证明与恢复合同](control-pairing.md) 说明审核、批准、未知结果只读恢复和独立机器密钥。独立Go控制面接口见 [OpenAPI](control.openapi.yaml)，不共享本地会话或空间身份。[机器连接](control-relay.md) 及 `control-relay.schema.json` 定义可选出站WSS、受限设备/模型读取、命令创建和原操作查询。

`tools/control.json`为独立控制面CLI/Agent目录，通过 `npm run cli -- control schema`发现；不混入本地Bearer目录。Go合同检查核对目录路径、方法及输入约束与OpenAPI一致。CLI使用独立Console会话；空间/配对/命令创建前耐久保存原请求，命令恢复只查询旧记录。私有凭据登录、Console短期子会话导入、秘密输出文件与错误恢复见 [CLI](../packages/cli/README.md)。

[原生控制面授权](control-native.md) 定义系统浏览器明确批准、PKCE轮询、独立子会话、取消及远程原操作恢复。后端、Console确认页和Swift/Kotlin独立库已通过HTTPS/WSS及MQTT模拟链路；原生云界面已接入源码，Android APK构建通过，iOS整包及两端运行待验收。原生证明与浏览器Cookie隔离，不向手机导出外部Token。

[产品物模型草稿](control-products.md) 定义当前Console主体的创建/列表/读取/保存/原决定恢复，与家庭空间及已发布模型分开。正文始终draft/unvalidated，修订冲突作为不可变决定保存；HTTP200须读取status。共享客户端JSON/结果检查位于 `packages/protocol/products.mjs`，正式JCS摘要与数据库决定仍由Go承担。

[物模型校验](model-validation.md) 定义共享Rust校验器、离线CLI及Console无副作用HTTP入口，包含58个共享正反例和有界JSON报告；当前校验器为1.1.0。`model.schema.json`只表达结构子集，完整定义规则由Rust执行；输入摘要与候选模型修订分别核对，校验不会改变草稿状态或设备绑定。

[定义兼容性](model-compatibility.md) 比较完整基线与候选模型，使用相同Rust规则和69份共享向量；当前检查器为1.1.0。写入/动作保持旧输入，读取/通知/事件及动作结果保持旧读取者可接受的新输出；CLI和HTTP核对整个封装及两个子报告的摘要。结果不写产品，不证明签名、发布或硬件兼容。

[签名发布与本地安装](model-release.md) 定义发布者命名空间、冻结发布基线、不可变原决定和Ed25519制品。共享Rust承担验签和模型规则，Go编排签名发布，MySQL v5提交发布/决定/审计；本地Rust独立保存信任、安装和设备绑定。发布界面及CLI均已接入；本地四类变更见 [model-change.schema.json](model-change.schema.json)。公开下载不自举信任，安装与设备绑定必须由本地所有者分别明确操作。

[固件制品校验与下载](ota.md) 使用独立OTA签名域和本地信任，`ota schema`发现自包含机器合同，`ota verify`离线核对精确设备快照与实际镜像，`ota download`访问签名限定的HTTPS源并写入新私有目录。不创建设备升级任务；模型发布权限不能替代OTA权限，校验或下载通过不代表已批准或已安装。

[固件签名制品准备](ota-release.md) 定义独立 `ota keygen/sign`、C3实际镜像格式/元数据检查、不可变身份和ready回执。配方与输出Schema为 [ota-release.schema.json](ota-release.schema.json)，与原OTA清单/信任规则共用。工具离线准备新私有包，不托管、修改信任或批准安装。

[当前设备信息](device-info.md) 定义 `device_info` 上报及本地读取，正文复用 OTA 设备结构，绑定当前模型/启动/会话且独立有效期为5秒。报告只留在会话内存，重连或恢复清除；上报与新鲜度不授予升级权限。

[本地固件信任与升级任务](ota-tasks.md) 定义独立固件信任、计划、明确批准/执行、取消、撤销与原操作查询。网关已接API/CLI、耐久MQTT安装意图和设备回执，重启后可能已发送的任务保留unknown与占用，只查询原设备日志；成功须新启动与精确镜像健康证据。C3安装提供方与产品配置/健康门禁已接入；宿主与编译证据分别记录，实机按用户要求跳过。

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
