# 当前工具与模型合同

[有界执行计划](execution-plans.md)（[English](execution-plans.en.md)）与[机器 Schema](execution-plans.schema.json)定义本地所有者的分阶段多设备编排、类型化任务完成、原键恢复及明确解除占用。复用原命令账本；取消不等于物理急停，不提供节拍同步或云转发。

[已受理实时设备事件](device-events.md)（[English](device-events.en.md)）和[严格投影 Schema](device-event.schema.json)定义本地轮询/SSE中可消费的设备事件数据、原身份与去重摘要。投影与原状态先耐久提交，重复/历史/过期或非法事件不产生新业务投影；不扩展云端转发或授予设备控制权。

[有限DLNA播放](dlna.md)、[宿主配置Schema](dlna-config.schema.json)与[音箱模型](models/dlna-speaker.json)定义固定目标、短时媒体ID、明确绑定、限幅音量/停止/播放及每一步授权。候选目录增加kind=dlna变体，CLI与家庭PWA复用既有执行和原操作合同；协议受理与HTTP拉取不等于实际发声，软件证据与剩余能力见24。可选[本地有限音频服务](media.md)及[媒体Schema](media.schema.json)提供上传、授权、撤销、删除与独立HTTP出口，已接CLI/AI、家庭网页、NAS配置与媒体备份恢复；新NAS镜像与原生媒体界面另行交付。没有麦克风接管或通用插件IPC。

[TV受控轮换](tv-agent.md#保留原身份的受控轮换)复用管理端v2原回执、专用激活证明和撤旧语义；旧PEM及本机身份均保留原授权与完整日志。[已撤销旧键清理](tv-agent.md#已撤销旧密钥的受控清理)须有固定CA签名CRL及明确确认，先提交原意图再删键，未知只恢复原决定。SQLite仍v3，内部轮换v1/v2共存，旧v1不猜alias、PEM无本机旧alias；最新NAS/隔离Broker及宿主软件结果见 [24第4.30节](../docs/24-实施计划与进度.md#430-tv已撤销旧密钥的受控清理与文档同步)。管理完成、Broker应用和实际Android分别核对，自动清理、续期与物理认领仍未提供。

[设备公钥签发与本机身份](device-enrollment.md)及[管理端机器Schema](device-enrollment.schema.json)定义离线CSR检查、独立公钥指纹、单次签发和原序列号恢复，以及可选C3本机密钥/CSR、证书导入与耐久恢复。受控轮换通过`rotate-csr`保留旧身份，设备原子切换后提供新键激活证明，`complete-rotation`才撤销旧证书并更新CRL；须另行重启Broker。[过期身份的管理端恢复](device-enrollment.md#过期身份的受控管理端恢复)使用独立`recover-csr`及v3用途记录，要求原CA仍有效、旧证书真实到期且未撤销、不同新公钥与唯一旧证书；端侧完整维护仍待接入。管理端不接收设备私钥，USB维护不替代物理认领或变更设备归属，也不提供自动续期。`device_identity.py csr-schema`离线发现管理合同；`test:device-enrollment`验证管理链路，`test:firmware:identity`验证固定SDK密码库、两代轮换、故障恢复、NAS资料备份和真实Broker。

[设备加密存储](device-storage.md)及[离线准备回执](device-storage.schema.json)定义可选C3 HMAC NVS档位、设备/空间绑定、仅读取已保护硬件密钥、两档构建及拒绝恢复边界。此工具不连接设备或写eFuse，不代替物理认领。

[本地终端任务](terminal-tasks.md)和[机器动作Schema](tools/task-session.json)定义TUI/Agent共同的设备控制、完整多步规则、核对/单次提交与只读恢复；CLI入口为`tui`，不扩大网关授权或控制面工具目录。

`tools/catalog.json` 列出本版本已经实现的操作与输入 Schema。CLI 和 HTTP 发现端点消费同一个目录；核心按类型化 Rust 合同再次校验，调用者提供的正文不能覆盖授权空间或设备会话。

[模型来源与本地绑定](model-release.md#本地信任安装和设备绑定)区分发布者验签安装和随网关交付的只读目录。model-bundles.list/get返回精确正文及摘要，devices.bind-bundle与devices.bind共用明确换绑和原决定账本；来源严格互斥，换模不自动批准执行组合。快照v8承载新来源，v1–7夹带新动作/绑定/结果拒绝；网页与独立JVM跨模型软件证据见 [24第4.19节](../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)。

`models/` 包含灯光、按钮、[环境传感器](models/environment.json)及 Android TV 的模型定义，修订由 RFC 8785 JCS 后的 SHA-256 计算；目录中的定义不自动成为已签名制品或型号支持证据。环境模型的温度和相对湿度为只读整数，单位分别为 `celsius_x100` 和 `percent_x100`，15秒未获得新采样时过期；展示缩放不改变协议值。`examples/button-light.json` 是可校验和部署的事件规则；不含任意代码、模型调用或外部 URL。

[电视设备Agent核心](tv-agent.md) 定义独立设备消费者的mTLS、会话、应用授权和耐久回执。Agent可选择固定的 [应用模型](models/android-tv-agent.json) 或 [遥控逻辑模型](models/android-tv-remote.json)，两者本机执行能力均只有apps.launch，remote.press须另行批准外部绑定。验证方式见 [Agent说明](../apps/tv-agent/README.md#构建与验证)；初次本机身份与三条JVM回归的最新软件范围见 [24第4.28节](../docs/24-实施计划与进度.md#428-tv初次本机身份与公开证书软件闭环)，端上诊断及未通过项见 [第4.24节](../docs/24-实施计划与进度.md#424-独立启动诊断与android安全组端上验证)。JVM、Android端上及物理归属分别验收。

[命令回执确认与安全回收](command-receipts.md)定义有序命令ID、设备退休边界、原结果查询及提交后确认。TV Agent日志v2/v3回收已确认最终结果，unknown/未决保留；v3保留旧模型完整原包，旧会话原动作不重放。未声明此扩展的MCU/模拟器保持原握手与结果路径，网关原命令账本仍有独立4096条上限。回收历史证据见 [24第4.13节](../docs/24-实施计划与进度.md#413-电视命令回执确认与安全回收)，当前模型/日志阶段见4.15。

[电视本机材料](tv-agent-enrollment.schema.json)区分v1/v2旧私钥材料与仅由本机产生的v3密钥引用；另有[初次公开配置](tv-agent-identity.schema.json)冻结原请求和信任，电视导出CSR、导入公开证书并耐久恢复。v1隐含应用模型，v2/v3必须填写model_profile；[离线打包工具](../tools/tv-agent-enrollment.py)通过--model-profile选择，--identity-directory打包已签发旧材料，--ca-file只准备公开配置，两者互斥且不签发。Android明确确认后事务保存凭据与相应状态，旧材料模型迁移保留日志/授权；它不变更网关模型绑定、不批准compose，也不代替物理认领或ADB归属证明。

[执行路由与明确绑定](execution-routes.md)定义第一方路由、候选、bind/compose/revoke、会话能力证明、跨端FIFO及应用缓存；[机器Schema](execution-bindings.schema.json)与目录中的五项execution/device-applications工具为入口。当前快照v10读取v1–10，保留完整分区、generation、撤销与原决定，旧绑定不自动组合。[仅动作电视模型](models/android-tv-remote.json)的协议夹具/假ADB组合旅程通过，范围见 [进度4.14](../docs/24-实施计划与进度.md#414-显式能力组合与文档同步)。实际JVM Agent/假ADB组合软件结果见[4.22](../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)，4.16失败保留为历史；已有网关设备跨内置模型的软件路线见 [4.19](../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)，Android端上与实机另验。网页当前显示/撤销组合，创建使用通用CLI。

当前只实现模型和 DSL 的明确子集，未知字段、未支持动作与非空条件被拒绝。完整产品规划仍在工程规范，未实现的目标不进入可执行工具目录。运行与验证见 [本地开发](../deploy/dev/README.md)。

[属性写入与动作调用](commands.md) 定义 `property.set`、`action.invoke`、动作输入/输出证据和有界顺序队列。Schema 2 支持类型化动作，Schema 1 仍要求 actions 为空；submitted 表示输入已提交。[自动化规则](rules.md)支持事件或数值属性阈值触发、有界属性比较/all/any条件、actions中set/invoke严格互斥与混合操作，沿用命令链路；阈值正式示例见[温度控制灯光](examples/environment-light.json)。AI草案仍只生成事件触发的属性联动。TV Agent已有Android应用与调试APK，端上运行、同设备归并与真实电视控制仍须单独验收。

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
