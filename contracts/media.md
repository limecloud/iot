# 本地有限音频服务

本合同对应 [media.schema.json](media.schema.json)。首期实现本地所有者的有限 PCM WAV 存储、短时播放授权与独立局域网 HTTP 出口，供[DLNA执行端](dlna.md)使用。统一多模态提供方、应用会话、ASR/TTS 和转码仍按 [33](../docs/33-多模态模型与媒体服务.md) 后续实现。

## 启用与部署

默认关闭。为网关进程同时设置以下配置：

| 配置 | 要求 |
| --- | --- |
| `LIMEIOT_MEDIA_LISTEN` | IPv4 私网、回环或 `0.0.0.0` 加非零端口，如 `0.0.0.0:17882` |
| `LIMEIOT_MEDIA_ORIGIN` | 音箱可达的规范普通 HTTP IPv4 origin，如 `http://192.168.1.10:17882`；私网或回环，端口须与 listen 相同，无路径、尾斜杠、用户信息、查询或片段 |
| `LIMEIOT_MEDIA_DB` | 可选；默认 `${LIMEIOT_DB}.media.json`。父目录须已存在，文件名以 `.media.json` 结束，不得与核心 SQLite 同路径 |

音箱候选配置设置 `managed_media:true`、`media:[]`，重启后明确批准新配置修订的执行绑定。原静态配置默认 `managed_media:false`，省略该字段时配置摘要保持兼容。两种来源不能在同一个候选内混用。

控制接口继续使用原 HTTPS 与所有者会话/Bearer，浏览器写操作需要精确 Origin 与 CSRF。HTTP 媒体端口只提供音频 GET/HEAD，不承载管理接口。普通 HTTP 无传输加密，路径凭证和正文仅适用于受控本地网络；固定来源 IPv4 是网络限制，不是音箱密码学身份。

NAS可选配置与`compose.media.yaml`、媒体快照备份恢复已接入，见[NAS说明](../deploy/nas/README.md#可选平台音频服务)。家庭网页及本地统一工作台的“音频”提供上传、授权、撤销、删除与原操作查询；CLI和AI共用下述正式目录。新NAS镜像、实际容器网络和原生媒体界面仍单独验收。

Swift/Kotlin原生库另提供`MediaClient`及`MediaChanges`，复用NAS会话与必填安全存储端口；库的软件旅程入口为`npm run test:media:native`。原记录使用独立`origin#media-operations`存储摘要，最多128项，同键只查询，404保持未知；跨实例写入互斥，记录损坏、移除或无法保存时停止新写。同一空间内同类未决上传，以及同音箱授权、同对象删除或同授权撤销分别阻止换键；未知授权不阻塞明确删除/撤销。`targets`只读核对候选和当前绑定的playback.play路由，不执行探测/绑定/授权；bound与有效composed均可作为目标。

原生NAS设置的音频页面接入系统文件选择、上传、逐次明确授权、撤销、删除确认与原查询；`npm run test:media:native:state`检查实际状态层与有界文件读取器。离线、后台与离开页面清除内存文件及批准，取消后的持久未知原记录仍保留；保存后取消不会发送POST。系统文件选择器、系统安全存储与完整App运行仍单独验收，宿主文件夹具不替代这些证据。

## 管理接口

| 操作 | 请求 | 结果 |
| --- | --- | --- |
| 列表 | `GET /api/v1/spaces/{space_id}/media` | `page`，包含对象元数据、当前授权与本进程拉取记录；不含正文或下载地址 |
| 变更 | `POST /api/v1/spaces/{space_id}/media-operations` | 单一 `Idempotency-Key`、`application/json` 和 `change`；耐久成功后返回 `operation` |
| 原操作 | `GET /api/v1/spaces/{space_id}/media-operations/by-key/{key}` | 原历史决定；查询不会上传、播放或重新授权 |

未启用时列表返回 `configured:false` 和空数组，变更与原操作查询返回 `media_not_configured`。接口受原空间与所有者权限限制；媒体上传路由单独允许最多 `ceil(4MiB/3)*4+4096` 字节，其他路由仍使用原限制。未知字段、重复键、过深或超量文档拒绝。

列表和原操作回执均包含精确`space_id`，客户端核对空间、原键和请求摘要。AI工具目录注册`media.list`、`media-changes.create/resolve`，`schema`返回正式输入/输出结构。CLI本地`media upload --file ...`只将WAV文件转换为同一上传变更，不能覆盖音箱目标或媒体下载地址。

网页和CLI在首次POST前保存原操作摘要，包含origin、空间、原键、JCS请求摘要与变更身份。上传记录另保存正文摘要、字节数、格式和保留时间，不保存正文；CLI使用原0700目录/0600文件并同步，网页写入后读回核对。同键异参拒绝，已有CLI创建只GET原键，404和断连保持未知，退出6；不换键自动重传。网页当前最多128条原记录，记录损坏、被移除或无法保存时停止新写操作；无回执的同类上传/授权须先核实。

变更示例：

```json
{"type":"media.upload","content_base64":"完整音频的规范base64编码","retain_seconds":600}
```

```json
{"type":"media.grant","media_id":"media-原上传返回的ID","device_id":"device-speaker","expected_binding_revision":"sha256:替换为当前执行绑定摘要","valid_for_seconds":300}
```

```json
{"type":"media.revoke","grant_id":"grant-原授权返回的ID"}
```

```json
{"type":"media.delete","media_id":"media-原上传返回的ID"}
```

示例中的音频、ID 与摘要为占位内容，实际值须符合 Schema。操作键绑定 `{space_id,idempotency_key,change}` 的 JCS SHA-256 摘要。同键同参返回原决定，异参返回 `idempotency_conflict`。响应丢失时只查询原键；查不到不能推断原请求一定没有发生，消费者不得自动新建键重发。

## 格式、保留与容量

仅接受完整 RIFF/WAVE、一个16字节 PCM `fmt ` 块和一个非空 `data` 块，16位、1或2声道、8–48kHz、最长60秒，头部与正文长度精确一致。禁止额外块、压缩编码、连续流和截断内容；不调用外部解码器或转码器。

每对象最多4MiB，活动正文合计最多32MiB。保留60–86400秒；授权5–600秒，且不得超过对象保留期。最多256个对象、512项授权、1024项变更决定，墓碑与原键不自动清除。达到记录上限时明确拒绝，当前没有扩容、分页归档或无损轮换接口，适用于有限开发试用。

到期立即拒绝读取，后台每30秒清理到期正文。删除耐久移除正文并撤销其全部授权，保留元数据和原决定；重放旧上传键不会恢复正文。快照无失败地持久化后才发布新状态，写盘失败冻结当前媒体实例，后续读写拒绝，须重新打开原持久状态核对。媒体故障不持有核心 SQLite 锁或替代命令账本。

快照版本1、文件0600，采用独立单写者锁、临时普通文件、fsync、rename及父目录fsync。未知版本、损坏内容、空间错配、不安全权限、符号链接或墙钟早于保存下界均拒绝打开，不自动修复或擦除。正文存储与控制SQLite是两个文件，不能将跨文件拷贝称为同一事务；恢复旧备份可能恢复正文，删除不承诺安全擦除所有历史副本。

## 授权与下载

授权须核对当前 managed DLNA 执行绑定及完整绑定修订，固定音箱来源 IPv4。播放命令仍只含 `media_id`，由宿主解析当前有效授权，再交给执行适配器。每步业务 POST 重查原命令、期限和授权；媒体服务不自行创建播放队列或补发命令。

随机下载地址仅在网关内部交给播放适配器，含64位小写十六进制随机路径凭证，不含平台令牌、模型密钥或所有者信息。公开列表、授权回执、CLI及AI工具均不返回下载地址、路径凭证或正文。每次下载核对精确 Host、无 Origin、路径凭证、来源 IPv4、对象期限、授权撤销、进程代次和当前执行绑定。隔离软件验收从测试进程的私有快照取得地址，仅用于验证HTTP边界。

支持完整 GET/HEAD、单个普通/后缀/开区间 Range、ETag、If-None-Match 和 If-Range；多区间或越界返回416。响应为 `audio/wav`、`no-store`、`nosniff`、`no-referrer`，不跟随重定向或代理远端URL。

网关每次启动生成新进程代次，旧地址全部失效。正文和原决定仍恢复，旧授权原键只返回旧回执，不产生新授权。`issued_in_process` 仅描述历史回执是否由当前进程签发；判断当前可下载须同时核对列表的 `active_in_process`、`binding_current` 及期限，最终以下载时检查为准。

候选目录中的托管DLNA音箱增加可选`managed_media:true`；静态候选保持原DTO。网页仅允许为当前绑定到托管配置的音箱创建播放授权，明确选择音频、音箱和期限并批准。创建授权不触发播放，仍在设备页明确调用`playback.play`。

每项授权最多保留本进程最近16次成功准备HTTP响应的记录，重启清空。它不能证明网络完整传输、设备解码或实际发声。DLNA SOAP 成功仍只表示 `submitted`，不会产生虚构的 reported 播放状态。

## 验证与剩余

核心格式、幂等、期限、删除与快照测试，以及耐久存储、单写者、失败冻结与恢复测试见 `gateway/crates/core/tests/media.rs`、`gateway/crates/runtime/src/media_store.rs`。隔离软件音箱旅程入口为 `node --test tests/media.test.mjs`，使用真实HTTP、SQLite与MQTT，不连接实机。

客户端/CLI边界与390px浏览器旅程见`tests/media-clients-boundaries.test.mjs`、`tests/media-clients-web.test.mjs`；NAS快照、原授权失效和实际Nginx媒体上限分别见`tests/nas-media.test.mjs`、`tests/media-ingress.test.mjs`。统一工作台装配检查使用控制面身份只读夹具，媒体访问真实网关；Nginx检查替换容器地址/TLS/路径为宿主隔离配置，保留生产location，不继承容器与完整私有控制面验收。证据范围见[实施进度](../docs/24-实施计划与进度.md#有限音频客户端与nas集成软件阶段)。多模态、原生媒体UI、新NAS镜像和完整平台仍在开发，实机按用户要求跳过，不视为通过。
