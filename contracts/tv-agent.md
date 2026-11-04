# 电视设备 Agent 核心合同

当前消费者位于 [apps/tv-agent/core](../apps/tv-agent/core/)。这是设备身份下的 MQTT 消费者，复用 [命令](commands.md) 和 [设备通信](../docs/06-MQTT报文与设备通信规范.md)；不是手机控制 SDK、通用推理 Agent 或第二套网关。当前实现和验证范围以 [24](../docs/24-实施计划与进度.md) 为准。

## 电视交互边界

电视原生界面按总览、连接设置、应用授权、设备维护、诊断信息分区，具体导航与视觉规范见[体验设计](../apps/tv-agent/DESIGN.md)。页面读取既有Runtime，不另存连接或授权事实；导航、重建和返回不得建立连接、授予音频权限或复活确认。系统文件导入沿用下述材料及本机身份合同，当前没有扫码或短码配对协议。UI调整不改变模型、MQTT、日志、密钥或APK更新状态合同；可构建、宿主测试和指定实机验收分别记录。

## 本机材料导入

[本机材料Schema](tv-agent-enrollment.schema.json)由设备核心严格解析。v1/v2是含PKCS8私钥的旧材料导入格式，Android文件选择器仅接受这两版；v3仅用于已核对本机请求产生的凭据引用，不接受外部文件指定KeyStore alias。正文最多32KiB，重复键、未知字段、错误版本和不完整材料拒绝；Broker沿用显式ssl地址及主机校验。材料不包含所有者Token、ADB密钥或其他设备身份。证书用途、有效期、签发与持钥匹配通过后，电视显示逻辑模型修订及CA/设备证书SHA-256指纹，用户与可信来源核对并明确保存；保存不自动连接或授权应用。

[打包工具](../tools/tv-agent-enrollment.py)使用已有离线签发目录，不新增签发或网络接口；只读本人私有普通文件，拒绝覆盖已有输出，材料写入新的0600文件并耐久提交。输出仅含身份、公开指纹和文件路径。导入是现有开发证书的本机确认流程，不等同于完整生产认领、自动轮换或Agent/ADB归并。文件本身含设备私钥，须通过所有者控制的介质交付，不能放进日志、URL或模型上下文。

## 持钥与CSR基础接口

`DeviceSigningKey.from(privateKey, publicKey)`接受可由系统Provider签名的EC私钥句柄，先以随机挑战验证持钥与公钥匹配；不读取私钥编码。`certificateRequest(identity)`使用固定Bouncy Castle PKCS#10组件生成P-256/SHA-256、精确单CN、无附加属性或扩展的公开CSR，返回PEM、CSR DER SHA-256与SPKI DER SHA-256。该方法只生成请求，不分配管理请求ID或提供耐久幂等；调用者必须提交原键引用、原CSR与请求绑定后才能交付，恢复时返回原CSR，不能重新生成。

`DeviceTls.create`新增接受`DeviceSigningKey`的重载，直接向JSSE提供客户端KeyManager；仅在请求EC客户端证书、签发者匹配时提供设备链，不提供服务端身份。原PEM入口仍可用，解析后走同一持钥与证书校验，不再将设备私钥复制到临时KeyStore。两条路径均核对CA、有效期、设备CN、clientAuth、签发者/签名和公钥；Broker主机名继续由现有传输检查，不提供跳过选项。

Android基础端口`AndroidIdentityKeys`明确创建P-256签名密钥或读取已存在密钥；重复创建拒绝，读取缺失密钥不重新生成。alias限本应用固定前缀与32位小写十六进制；它是本机引用，不是设备身份或外部授权。独立窄接口`IdentityKeyRetirement`仅在已提交的原清理意图下，核对实际公钥后删除指定旧身份键并重查缺席，与建钥/读钥共用锁；不能删除材料加密AES键。端口不自动认领、清理或回退，不能在缺少耐久原请求的情况下直接作为生产接入流程使用。不可导出不等于TEE/StrongBox，按实际系统分别验证。

`restoreCertificateRequest(identity,pem)`验证保存的原CSR：单PEM、规范DER、精确单CN、空属性、P-256公钥、ECDSA/SHA-256及签名；返回原PEM及重算指纹，不重新签名。Android已接初次请求与公开证书导入，软件证据见 [24第4.28节](../docs/24-实施计划与进度.md#428-tv初次本机身份与公开证书软件闭环)。受控双键轮换与激活证明的软件实现见 [下节](#保留原身份的受控轮换)；Android实际EC持钥、正向mTLS和电视系统仍单独验收。

## 初次本机身份与原请求恢复

[公开配置Schema](tv-agent-identity.schema.json)只含`schema_version=1`、`request_id`、`space_id`、`device_id`、`broker`、`model_profile`与单PEM `ca_pem`，最多16KiB。电视严格核对CA格式、有效期、CA/keyCertSign用途及未知critical扩展，展示身份与CA指纹供所有者独立确认。配置准备工具的`--ca-file`模式只读公开CA，不读取旧身份目录、设备私钥或签发证书；与旧`--identity-directory`模式互斥，输出新的0600文件且不覆盖已有输出。

只有没有既有身份的设备可创建初次请求。Android先保存`prepared`原配置及随机本机引用，再提交`creating`，只有完成本次转换的调用可以建P-256键；恢复`creating`只加载原键，缺钥拒绝且不补建。CSR全文、DER摘要与SPKI指纹提交为`pending`并回读后才交付。重复原配置返回原CSR字节，不同请求/配置冲突；“恢复原申请”和“导出原申请”均不分配新身份。

管理者按 [签发合同](device-enrollment.md) 独立核对SPKI指纹后inspect/sign；未知结果只resolve原请求。电视只导入单份不超过4KiB的`device.crt`，不导入管理回执`enrollment.json`。证书须匹配原设备CN、CA、P-256公钥和本机持钥，显式CA:false、精确digitalSignature/clientAuth、ECDSA/SHA-256、有效期及未知critical扩展均校验；Broker、模型和信任继续取自原配置。

明确保存时，在同一SQLite事务写入v3凭据和`active`原请求。v3含模型、公开CA/证书、`key_reference`、SPKI指纹和`request_id`，禁止`private_key_pem`；v1/v2反向禁止引用字段。每次加载核对active记录、凭据及实际原键；丢钥、记录缺失或错配拒绝，不清数据或回退PEM。重复导入同证书只读，其他证书要求独立轮换；旧材料也不能覆盖pending或active本机请求。已有PEM身份不能走初次签发迁入，v3身份须通过下述本机明确改模用例扩展能力。

初次身份阶段的数据库v2增加加密身份记录表；当前数据库v3另增轮换表，1→3及2→3迁移保留原材料、授权和完整日志，未知版本与损坏拒绝。KeyStore不参加SQL事务，身份建钥/写入结果不确定时冻结当前对象，停止连接和后续写入；用户明确“重新核对已保存记录”关闭重开，读取实际状态后恢复原申请。该入口不清除数据、不重新生成缺失密钥。完整恢复约束见 [34第5.5.5节](../docs/34-电视终端与AndroidTV接入.md#555-初次接入的耐久状态设计)，不可导出密钥不随SQLite备份恢复。

## 本机引用身份的明确模型扩展

仅当前证书有效、已激活且实际持钥可核对的v3身份提供“扩展设备能力配置”。允许应用→遥控/音频应用/音频遥控、遥控→音频遥控、音频应用→音频遥控；相同配置不写入，回退或交叉移除能力拒绝。改模不创建或删除密钥，不换证，不重新签发CSR，不修改设备、空间、Broker或CA。PEM材料沿既有导入流程处理，文件导入不能覆盖本机引用身份。

内部`LocalIdentityRecord`未改模时继续编码v1；改模后编码v2，额外保存当前`model_profile`。v2只接受active状态、相对原申请的严格能力扩展；原`setup`、CSR及其摘要、请求ID、公钥、引用和证书指纹保留。加载时当前材料模型必须与该明确选择精确相等，不能用“兼容旧历史”代替身份一致性。CSR与激活证明仍按原申请核验；重复原证书预览/激活返回当前选择，不回退到申请时模型。之后的新轮换使用当前模型。SQLite仍v3、材料仍v3、轮换外层格式及加密绑定保持，各版本独立。

预览不写入，绑定原SQLite完整凭据/身份/全部轮换密文字节、原命令日志、应用授权和实际持钥状态的连续性摘要。Runtime沿`ApkInstallOwner → 运行锁`顺序串行核对：连接worker已经完全退出、无阻断APK任务、无待完成换钥/管理撤旧或正在删除的旧键。页面明确展示当前与目标能力、设备及证书摘要；审阅仅存本进程，绑定不可复活的本次前台许可。取消、后台、页面重建、开始或停止连接均使旧审阅失效；伪造、重复或已消费的确认拒绝。提交重新核对全部记录摘要和门禁，审批不能通过Intent、Bundle或文件继承。

同一原SQLite事务更新材料的模型、迁移后的完整命令日志、当前身份选择，以及存在时最新active轮换的候选选择。保留每条历史Envelope/confirmed/failed/unknown/未决、high_watermark、应用授权、原轮换申请/回执/激活证明；其他历史轮换行不改写。任一步失败全部回滚；可能写入或提交后读回失败冻结当前对象。用户重开读取实际配置后重新审阅，不能重放旧确认或清除记录。旧程序不理解身份BLOB v2或日志v4时必须拒绝读取，不能降级丢数据。

保存成功保持连接停止，不发放本次音频运行授权，不修改网关设备模型或执行绑定。网关明确换绑、Agent重连声明和ADB明确组合分别推进；改模不是APK/固件升级，也不证明电视已具备系统输入权限。软件/宿主验证与实机验收分别见[实施进度](../docs/24-实施计划与进度.md#471-本机引用身份的明确模型扩展与记录连续性)。

## 保留原身份的受控轮换

已有v1/v2 PEM或v3本机身份均通过明确的`requestRotation(request_id)`换钥，保持设备、空间、CA、Broker和模型。旧凭据在新键暂存期间继续保留；只有没有未完成原轮换时才接受新请求。每个请求先保存`prepared`与唯一引用，再提交`creating`；恢复仅加载原键，`pending`提交回读后才导出原CSR。不同ID不能替换未完成请求，恢复不重新签名或补建缺失密钥。

电视依次选择原`rotate-csr`导出的`enrollment.json`和`device.crt`，再明确确认切换。此回执仅用于轮换核对，不能作为初次接入材料。核心按 [管理合同](device-enrollment.md#保留旧身份的密钥轮换) 严格解析v2结果：拒绝重复/未知字段、错误类型与原请求摘要，核对空间/设备/CA、原CSR与新SPKI、前证书序列号/DER指纹、新证书序列号/DER指纹及日期。证书另经固定CA、用途、设备CN、持钥和有效期验证；回执不提供信任锚、模型或新授权。

原前证书仍为issued且尚未激活的候选才能首次切换。凭据、当前本机请求与该轮换的active决定同一SQLite事务提交，应用授权及完整原日志零改写；失败回滚，不确定结果冻结并重开读取实际状态。重复同请求/证书只读；新身份缺钥或错配拒绝，不回退旧凭据。

`activationProof(request_id)`只在该原请求已经切换、当前证书和原键一致时签署管理合同限定的六行消息，不暴露通用签名入口。证明先加密保存并回读，再允许导出；重开及重复导出返回相同字节，加载时重新核对签名。历史轮换独立保留，下一轮暂存期间仍可按原ID恢复上一轮证明；当前证书已被后续轮换替代时拒绝冒用旧键签名。

管理者明确调用`complete-rotation`，再向电视提供该原操作的完成JSON。电视核对原摘要、挑战、当前证书及激活/撤销/CRL标志后，仅记录管理完成观测；原证明未耐久保存时不能记录完成。公开JSON不提供独立签名管理证明，也不证明Broker重载或旧连接关闭。NAS继续独立验证证明和实际CA/CRL；管理者须另行重载Broker，分别核对旧身份拒绝与新身份连接。未完成管理核对前，电视不创建下一轮候选。

SQLite数据库v3仅增加`rotations`表，显式支持1→3及2→3，保留原身份表、凭据、授权和命令日志。每个请求独立加密，最多128条历史轮换，满容量拒绝，不自动删除未知/历史记录。材料为v3，内部身份记录为v1/明确改模后的v2，命令日志按模型使用v2/v3/v4，各版本体系独立。旧键不参与当前连接或回退；明确受控清理见 [清理规则](#已撤销旧密钥的受控清理)，过期维护见下节。不提供自动清理、自动续期、CA迁移或物理认领。轮换阶段证据见 [24第4.29节](../docs/24-实施计划与进度.md#429-tv双键轮换激活证明与撤旧软件闭环)，清理阶段见 [第4.30节](../docs/24-实施计划与进度.md#430-tv已撤销旧密钥的受控清理与文档同步)，宿主与实际Android结果分开。

## 过期身份的受控维护

`AndroidAgentStore.maintenance()`仅从已保存材料读取身份资料，返回不提供TLS工厂、私钥编码或设备控制入口的`DeviceMaintenanceIdentity`。它继续验证固定CA当前有效、旧叶证书签名/用途/设备CN/公钥、实际持钥及原身份/轮换记录，只允许叶证书到期；未来证书、过期CA、错绑、缺钥或损坏记录仍拒绝。普通`load()`、材料导入和每次`tls()`仍要求证书当前有效，不从维护对象恢复连接权。界面将过期身份标为“仅可维护”，禁用开始连接。

用户停止连接后明确选择“申请或恢复过期身份”，以`requestExpiredRecovery(request_id)`推进原请求。设备/空间/CA/Broker/模型、应用授权及完整命令日志保持连续。当前叶证书必须实际到期；有效证书走普通换钥。没有候选时先提交恢复与建钥意图再创建不同新键；已有未完成普通换钥时，必须另行明确确认沿原ID进入维护，完整保留原候选、密钥引用和CSR字节。新ID仍拒绝，候选丢钥不补建，普通换钥或证书预览不能自动批准过期维护。

恢复复用原prepared/creating/pending/active、原CSR回读、原子切换和限定激活证明。内部轮换记录v3增加固定`recovery_reason=certificate_expired`及`recovery_origin`，并保留v2全部旧键清理资料；来源只能为`expired_identity`或`pending_rotation`。普通轮换仍写内部v2，旧v1/v2保持可读，SQLite仍v3且不增加表。旧v1未完成记录进入维护时，只从当前已验证身份取得旧引用/公开证书，不枚举猜alias；历史active v1继续保持untracked。

`expired_identity`仅接受管理v3恢复回执，管理用途必须纳入原请求摘要；不能去字段降为v2，普通轮换也不能消费恢复回执。`pending_rotation`可核对原管理v2意图，或尚无原签发时以相同CSR/ID取得的管理v3恢复意图，前证书状态允许issued或expired；签发状态未知仍只查询原操作。两者都严格匹配原请求、前后证书及候选键，切换后固定原摘要和挑战，不能替换另一格式或另一次签发。首次切换必须尚未激活/撤旧，候选证书本身须当前有效。

管理者使用[原恢复合同](device-enrollment.md#过期身份的受控管理端恢复)的`recover-csr`，回执与新证书核对后由用户明确切换。新证书必须当前有效且匹配原候选键，随后沿用原ID导出耐久激活证明、`complete-rotation`、管理完成核对、Broker重载及已撤销旧键的独立清理。公开管理JSON不证明Broker已应用CRL，设备侧也不能仅凭本地资料判断CA账本是否撤销旧证书。

本流程不恢复旧证书、过期CA或丢失的设备私钥，不更改TLS时间校验，不提供自动续期、归属认领或旧备份防回退。软件和端上实际证据分别记录在[进度](../docs/24-实施计划与进度.md)。

`DeviceTls`保存CA与叶证书共同的有效窗口，缓存的SocketFactory也在创建连接前后核对当前时间；到期拒绝新连接。`DeviceMqtt`在连接/重连、握手后、消息消费、发布和副作用许可中重新检查，已连接会话到期后退出，不循环尝试恢复过期身份。尝试已提交但动作尚未调用时不执行，原结果耐久保存；不能因无法发布结果自动重放。维护界面停止新增应用授权并保留撤权，实际连接仍使用严格的`load()`及`tls()`。

## 已撤销旧密钥的受控清理

清理是停止连接后独立确认的本机用例。新内部轮换记录v2保存原旧键引用与公开旧证书；既有v1保持原格式可读，不猜测或枚举alias认领旧键。预览零写入，须有已切换的原轮换、已保存的激活证明及管理完成观测；公开管理JSON本身不能授权删除，还须核验固定CA签署的CRL、原旧证书序列号/DER及SPKI指纹和实际旧键公钥。当前身份键、最新候选键及与当前公钥相同的键均拒绝清理；可清理历史轮换，无需读取已被后续清理的中间代私钥。

`DeviceRevocationProof`只接收单份ASCII PEM CRL，最多16KiB，拒绝非规范DER。校验原CA的有效期、cRLSign用途、issuer及ECDSA/SHA-256签名，要求`thisUpdate ≤ 核验时间 < nextUpdate`。CRL必须包含原旧序列号且不能撤销当前证书；原旧证书可以过期，但仍核对签发与精确历史目标。未知critical扩展、delta CRL、分布点/间接CRL语义、entry certificateIssuer、未来撤销日期及removeFromCRL等不支持的原因拒绝。CRL不证明Broker已加载或旧连接已断开，管理者仍须另行重载并验证。

用户核对原请求、旧证书/公钥与CRL指纹并明确确认后，先在SQLite提交`deleting`、原CRL及批准时刻，再调用KeyStore删除；确认alias缺席后提交`retired`并回读。删除、提交或回读结果不确定时冻结对象，关闭重开后只恢复原决定。意图前旧键缺失必须拒绝，不能冒报已清理；意图后缺失可收敛为完成。恢复使用原批准时刻重新核验保存的CRL，即使CRL后来到期也不替换原证明；新清理仍按当前时刻核验。单条轮换记录最多32KiB，预览与写入前检查组合容量，超限零删除；CRL以最多8段、每段2048字符保存。

| 清理状态 | 含义与允许行为 |
| --- | --- |
| `untracked` | 旧v1无旧键引用，保持记录，不自动匹配或删除 |
| `not_applicable` | 原身份为旧PEM材料，没有本机旧alias可清理 |
| `waiting` | 切换、原证明或管理完成核对尚未齐备，不清理 |
| `retained` | 旧键保留，可提供CRL并预览，仍需明确确认 |
| `deleting` | 原清理意图已提交，重开后恢复原决定，不另换CRL |
| `retired` | 删除后已确认缺席并提交结果；重复核对不再删除 |

清理保持当前凭据、授权、完整命令日志及轮换历史，数据库仍为v3，不新建清理表。内部轮换v1/v2/v3与管理回执v2/v3是不同格式；旧程序不理解新内部记录时须拒绝，不能清数据降级。删除不可恢复，不保证Flash旧页、备份或历史导出材料安全擦除，也不提供旧备份防回退保证。AndroidKeyStore实际删除、电视交互及进程恢复仍待端上验收；宿主替身与测试APK编译不补算。

## Android端口与运行边界

[app模块](../apps/tv-agent/app/)与手机控制APK分别构建，minSdk=23。单设备私有SQLite保存加密材料、应用授权和原日志，使用DELETE日志与FULL同步事务；损坏处理拒绝打开，不采用默认删除数据库恢复。设备材料由AndroidKeyStore的AES-GCM密钥加密，解密不重新生成丢失密钥。旧v1/v2材料导入固定空间/设备/CA绑定，同身份同模型换证保留授权和原日志，身份或CA改变拒绝；从应用启动模型切换遥控组合模型时，先按旧格式完整验证记录，在同一SQLite事务内更新加密材料及日志v3，保留所有原Envelope、结果、unknown、未决尝试和high_watermark。事务失败两者一起回滚，禁止从组合模型退回旧模型。v3按已保存的初次或轮换请求激活，不接受上述旧材料导入和模型迁移入口，换钥只走独立轮换用例；退役/换所有者另走撤销与重新认领，不以清记录代替。

应用端口只使用已启用、导出且满足权限条件的Leanback启动入口，限定包和组件，提交前重新检查本机白名单和本次运行许可。Android10及以上仅在电视终端页面可见时接受启动，普通前台服务不绕过系统后台启动限制。停止、撤权与系统调用共用执行边界锁；旧运行许可永久关闭，不能借用新连接恢复动作。

用户从可见页面开始连接，私有前台服务持有单一MQTT运行实例和通知停止入口；Activity离开/重建不新建连接。服务使用connectedDevice类型及必要的网络/前台通知权限，不执行系统网络配置变更。服务为START_NOT_STICKY，不注册开机自动启动；进程回收后保留记录，用户再次开始时使用新boot/session，不自行重放旧动作。Keystore、系统服务、后台政策及真实应用启动仍需端上验证，宿主Android沙箱不替代实机证据。

## 能力和模型

Android真实系统验证另有独立instrumentation入口，环境与初始失败见 [24第4.20节](../docs/24-实施计划与进度.md#420-tv-agent-android端上验证入口与当前阻塞)，独立启动诊断、实际AOT/安全组及剩余阻塞见 [第4.24节](../docs/24-实施计划与进度.md#424-独立启动诊断与android安全组端上验证)。API36手机模拟器、API23、电视系统和物理设备分别验收；测试材料、目标Activity与宿主控制信号仅在测试APK或私有目录存在，不增加正式应用的接入、授权或控制接口。

原有两种固定资源配置如下；新增音频配置及运行门禁见[音频协议](#音频精确模型命令与完整状态)。原配置：`android-tv-agent`使用[应用启动模型](models/android-tv-agent.json)，`android-tv-remote`使用[遥控逻辑模型](models/android-tv-remote.json)。材料v1只读映射到前者，v2/v3必须显式填写model_profile，未知值拒绝；打包工具以--model-profile选择，默认应用启动。v3固定初次请求的模型，当前不提供模型变更入口。两个模型源文件由Gradle直接复制为资源，按Rust规范投影省略动作output中的空properties/required后计算JCS摘要；不能对原始文件排版直接求摘要，也不接受任意模型正文或摘要覆盖。

应用 ID 仍须通过实际安装、可启动入口和当前本机白名单检查。原两个配置的本机执行能力均只有apps.launch。遥控逻辑模型用于核心的显式compose，hello.execution_paths只声明apps.launch，remote.press须另行绑定适配器；Agent即使收到遥控按键也拒绝。实时消息必须匹配当前精确模型，旧模型仅用于验证历史日志及原结果查询。音量、静音、跨应用输入、安装与电视OS更新不由本合同授权，物理归属及系统权限另验。

本机材料/日志变更不修改网关Device模型绑定，也不批准ExecutionBinding。当前组合旅程从已经准备遥控逻辑模型的设备开始，已有网关应用模型设备跨到内置遥控模型已通过明确CLI换绑、本机日志迁移及网关/JVM重启的软件旅程，见 [24第4.19节](../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)，实际电视另验；不能修改config_hash、用户数据库或绕过模型发布规则代替。实际JVM Agent/假ADB组合的软件旅程已通过，范围见 [24第4.22节](../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)；原生应用端口仍是文件夹具，不证明Android系统执行或物理归属。

## 连接与会话

生产传输只接受显式 `ssl://host:port`，无用户名、路径、查询或片段。设备使用 NAS 独立设备 CA、单设备 EC 客户端证书与匹配的 EC 签名密钥；旧材料通过PKCS#8导入，v3通过本机引用读取原键。Client ID 固定为证书对应设备 ID；拒绝证书用途、有效期、签发关系或密钥不匹配。不使用信任所有证书、跳过时间或主机名检查的引导方式。

Paho 承担 MQTT 5；其默认主机校验调用 API 24 方法，设备传输改用 OkHttp 的主机/SAN 验证器以面向 API 23。链、时间与主机名校验均保留；API 23 端上兼容仍须以 Android 构建及运行证明，JVM 通过不能替代。自动 MQTT 重连关闭，由工作线程重建 clean-start、零会话期限的连接，不恢复旧发送队列。

每次进程启动生成新的 boot_id，每次连接生成随机挑战；welcome 必须匹配设备、模型、Topic 和挑战，且只能接收一次。认证时间结合设备单调时钟检查期限；时钟倒退停止本会话。原两个配置ready后每两秒上报空属性完整快照，不能补造音量或其他状态；新音频配置使用独立实际采样的完整快照，见[音频协议](#音频精确模型命令与完整状态)。重连重新握手，不沿用旧 session。

hello声明receipt_ledger=1，welcome须明确支持并提供原网关账本的command_sequence。设备先耐久恢复拒绝旧命令的high_watermark，再进入ready；网关历史低于本机边界时拒绝连接。原结果查询、确认与两端备份限制统一见 [回执确认合同](command-receipts.md)。旧网关未协商本扩展时新版Agent不进入控制状态。

入站应用报文限16KiB、深度16、2048节点，拒绝重复键、未知字段、无效UTF-8/Unicode、浮点数和超出安全整数范围的元数据。retained下行和非当前设备Topic均不执行。传输回调队列16项，溢出使本连接失效；控制只处理单线程收到的当前会话命令。

## 耐久回执与副作用

`DeviceStorage` 是消费方定义的小接口：读取和耐久提交完整有界记录。平台实现须使用设备私有存储，并证明返回成功前已提交；返回失败可能已写入，不能继续使用旧内存。JVM旅程的文件后端仅是测试适配器，不能作为 Android 存储已经实现的证据。

应用启动配置写日志版本2，遥控组合配置写版本3；日志固定空间、设备、当前模型修订与high_watermark，保存最多128条/1MiB尚未回收的完整原命令与结果。仅在网关原结果事务提交成功、设备核对完整原包及结果摘要后耐久回收最终结果；未知或可能已开始的记录继续保留，容量不足仍拒绝。版本1/2必须属于原应用启动模型，允许向遥控配置单向迁移；版本3必须属于遥控模型，其条目可以保留旧应用启动模型的完整原包。构造时只读校验，直接设备核心的模型变更在发hello前耐久提交；Android则在本机确认材料时原子迁移。原模型/会话/结果不改写，退休边界不回退。旧程序不能读v3，当前程序也拒绝反向模型变更；坏版本、错归属、越界序号和损坏原结果不重写。容量不增加，不能删库解锁。

1. 校验当前会话、唯一消息/命令、输入、issued_at/expires_at及最长30秒窗口；已知拒绝耐久保存为 failed。
2. 外部副作用前先提交原命令，result=null代表可能开始的尝试。提交失败阻断整个对象，零调用外部入口。
3. 再检查当前连接、应用授权/可启动性与期限，然后只调用一次 `ApplicationPort.submit`。其返回最多证明输入提交，开始调用后的异常保持unknown。
4. 结果耐久提交后才发布。最终提交失败停止对象；重新打开只读取实际日志，不再次启动应用。

同一会话、相同完整原命令重投仅返回保留的已有结果；未决尝试返回 execution_unknown。相同 command_id 或 message_id 对应不同原命令拒绝；新命令的两个ID必须绑定相同序号且高于退休边界。已回收命令在新会话中重包也拒绝。重启不恢复旧动作；待确认最终结果通过当前会话的up/receipt核对，最多每两秒一条，不直接重放旧会话result。设备本地回执不证明物理 exactly-once，也不替代网关原操作账本。

## 验证入口

JDK21及项目工具就绪后，在仓库根目录执行 `npm run test:tv-agent`。入口先构建Rust和Home网页，再执行`:core:test :core:journeyRuntime`：纯JVM故障检查与测试类编译在网络旅程之前完成，独立TLS测试在缺少专用环境时显式跳过。Gradle导出本机`core/build/journey/runtime.json`，Node读取其中的JDK21、classpath及固定`MqttJourneyMain`，直接启动设备Java进程；该入口复用`MqttJourneyTest`，不在设备启动或重启时执行Gradle。缺少产物时明确失败，重新编译后再运行；原`:core:mqttJourney`任务保留。

后半由Node串行运行回收、已有设备跨模型换绑、JVM/假ADB组合及实际JVM音频网页组合四条旅程，分别创建临时CA、mTLS Broker、Rust网关、SQLite和独立JVM进程。编译不占连接等待期限，期限与业务断言均未放宽。核心检查、入口导出、实际网络运行和Android端上分别记结果；直接Java原回收旅程与Android宿主/调试APK/lint已复验通过，见 [24第4.17节](../docs/24-实施计划与进度.md#417-tv-agent独立jvm回收与android软件复验)。默认核心任务的网络项仍跳过；实际JVM/假ADB组合的后续软件通过结果见 [24第4.22节](../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)，不提升为本轮整套或端上通过。

应用入口是文件审计夹具。软件检查分别记录真实网络、证书、耐久顺序和进程恢复，不将其提升为 Android APK、真实应用启动、Android端上共存、自动配对或实机验收。真实JVM核心与假ADB同一逻辑设备的组合旅程由tests/tv-agent-composition.test.mjs独立执行，最终结果只在24登记。

`npm run test:tv-agent:audio`定向执行`tests/tv-agent-audio.test.mjs`，运行实际DeviceAgent/DeviceMqtt和网页；`FileAudioFixture`仅替代系统音频端口，独立采样文件混音器。每次原生效果前，复核设备日志中原命令的未决尝试，以及本轮网关快照版本、原命令dispatched、无外部路由和完整原生路径分区。模拟setter生效后异常必须保留unknown，重启仅核对原结果，不能重复setter。音量submitted不代替实际状态，外部按键不进入原生端口。已通过范围和未运行的相邻回归见[4.72](../docs/24-实施计划与进度.md#472-实际jvm音频与网页及adb组合软件闭环)，不构成Android AudioManager或电视验收。

## APK离线预检

`tools/tv-agent-apk.py`是独立宿主工具，输出不是安装授权、OTA任务或设备更新回执。它不读取ADB、设备数据库、账户或网络。输入固定基线与候选文件、各自完整小写SHA-256（64位、不带前缀）、独立核对的签名证书SHA-256、SDK build-tools路径、目标API（23–36）及1个或多个不重复的`--device-abi`。ABI接受armeabi、armeabi-v7a、arm64-v8a、x86、x86_64、riscv64；仅验证打包目录有交集，无lib目录视为不依赖打包本机库，不证明实际依赖可运行。

工具以只读且不跟随最终符号链接的方式打开源文件，复制到私有临时目录并核对整包摘要，SDK只处理该副本。aapt2读取编译AndroidManifest，apksigner对给定API执行真实签名验证，要求旧/新包均为run.limeai.iot.television、单一签名证书与固定指纹完全一致、候选版本码严格递增。复制后及检查后重新核对字节；不以文件名、签名主题或自报版本替代安装身份。v1签名警告计数会返回，固定整包摘要仍必须核对，不能仅依赖签名覆盖META-INF。

此实现只接受独立基础APK；拆分/必需split类型、共享UID、versionCodeMajor、额外库/必需硬件/配置/SDK扩展及testOnly拒绝。debuggable候选默认拒绝，`--allow-debug`仅显式放行开发包。签名轮换、多签名和降级另需实现，不自动接受。每份APK上限256MiB及20,000条ZIP记录；SDK进程各自10秒及256KiB实时输出上限，失败不透传SDK或APK可控诊断文本。

成功退出0，JSON为schema_version=1、status=offline_checks_passed，并包含：

- target：调用者提供的api_level/abis；baseline、candidate：整包/签名摘要、包名、版本码、min_sdk/target_sdk/max_sdk、debuggable、permissions、native_abis及signature_warning_count。
- added_permissions及debug_candidate_explicitly_allowed只描述变化，不授予Android权限。
- installation_authorized、device_state_verified、storage_compatibility_verified固定为false。临时副本在检查结束后回收，报告不包含可执行安装句柄；未来安装器须重新暂存并核对同一摘要。

拒绝退出1，返回schema_version=1、status=rejected、reason及installation_authorized=false；缺文件、SDK缺失或无法读取等系统错误统一apk_inspection_failed，不打印私有文件内容。参数解析错误沿用argparse行为。两个摘要、证书指纹和目标资料的可信来源由调用者独立核对，本工具不执行发布批准或确认设备当前状态。

用法和验证见 [TV Agent说明](../apps/tv-agent/README.md#apk离线预检)；实际安装器、用户取消/中断后的原会话查询、KeyStore/SQLite及完整原日志的更新连续性仍按 [13第10.1节](../docs/13-OTA与制品交付规范.md#101-tv-agent-更新与设备记录连续性) 分阶段交付。不得将本工具的离线结果转述为实机升级、存储迁移、健康或回滚通过。

## APK安装任务账本

`ApkInstallJournal`是APK专用的原任务账本，`AndroidApkInstallStore`以独立私有`tv-apk-install.db`保存。后续Android系统适配层与连接启动保护见下节；产品更新界面和完整运行门禁仍未接通，不增加MQTT/HTTP更新动作、OTA kind或安装授权。离线预检、账本和系统适配层各自承担材料检查、耐久意图与平台调用，不能相加成实际升级通过。

计划固定requestId、原binding（空间/设备/CA指纹）、旧/新APK摘要、同一签名证书指纹、旧/新版本码、候选长度、continuityDigest及preflightDigest；内部摘要为sha256加冒号及64位小写十六进制，区别于离线CLI的无前缀参数。候选版本严格递增，长度1–256MiB。连续性摘要必须由后续提供方读取实际身份/授权/完整日志等形成，预检摘要只引用被核对的报告，两者不是授权Token或已完成验证的证明。

当前写入格式为schema_version=3、operations数组，每条包含plan、重算一致的request_digest、phase、session_id、local_health、recovered_from及recovery_result；兼容读取v1/v2，缺失的新字段按空处理。严格拒绝未知字段、重复请求/会话、坏摘要/阶段/健康组合和未来版本。最多128条历史/1MiB，不自动回收原键。failed/cancelled及明确接受后的local_health_accepted/local_package_recovered释放新任务占用，旧请求再次prepare只返回原记录；异参同键拒绝。installed_unverified继续占用，仅可按[本机健康接受](#安装后本机健康核对与明确接受)核对并明确接受；本机决定不等于完整远程更新验收。

| 阶段 | 本层实际语义 |
| --- | --- |
| prepared | 原计划已保存，未产生系统会话或授权；仅此阶段可本地取消 |
| creating | 创建会话前的意图已耐久；失败/丢返回仍留此阶段，不重新创建 |
| created | 原session_id已保存；系统会话与候选资料仍须提供方核对 |
| staged | 提供方提交的同一会话读回摘要/长度与计划一致；本层不读取或写入APK |
| committing | 系统提交前意图已耐久；返回成功或抛异常均不自动改为安装完成 |
| pending_user | 原系统结果要求用户交互；重开/查询不再次commit或自动弹界面 |
| installed_unverified | 原系统结果报告已安装；身份/记录、当前包及健康仍未验证 |
| local_health_accepted | 新代码/候选整包、原记录与有效持钥经本机重验并明确接受；可手动连接，联网控制另验 |
| local_package_recovered | 原提交结果未知；候选新进程和完整本机状态重验并明确接受，原来源/迟到系统结果另存；可手动连接 |
| failed / cancelled | 原会话系统失败/取消，或prepared的本地取消；历史保留且不重建原请求 |

createSession在外部创建前先保存creating；返回的正session_id再耐久保存。返回丢失时，resolveCreation只接受由未来提供方从当前自有系统会话读取的声明，核对原request_digest、固定包名、长度与唯一会话；零匹配不能证明从未创建，多匹配拒绝，不自行创建替代会话。声明不能由导入文件或客户端伪造。API23没有SessionInfo.isSealed（API26）/isCommitted（API29），不能套用新API或用缺少会话推定可以重装。

commit要求已保存staged，强制调用verifyCurrent：意图保存前及保存后、真正submit之前各核对一次。后续提供方须核对当前安装身份、材料/授权、实际暂存字节、原binding与连续性、运行停止/在途原命令及系统政策；本阶段仅定义并测试这个回调边界，没有实际资格检查实现。第二次核对失败时零submit，保留committing供独立恢复，不改回可重试阶段。systemResult仅接受原请求/会话，待提供方在非导出结果入口校验来源；相同结果只读，冲突终态拒绝，系统安装成功不提升为完整更新成功。

存储接口以原完整文档字节进行原子compareAndSet。SQLite在同一事务比较旧文档、保存新文档，使用实际连接的DELETE日志/FULL同步；冲突或提交异常阻断当前核心实例。可能写入后存储异常还冻结该存储实例，必须关闭并重开读取实际耐久状态，不能用内存猜测重发。重开/快照读取无系统副作用；新库和文档版本独立于身份库v3及材料/命令日志，未知版本与损坏拒绝，不删除、重置或迁移原身份库。不承诺旧备份防回退或真实掉电恢复。

原账本基础的软件结果、失败记录与冻结输入见 [24第4.53节](../docs/24-实施计划与进度.md#453-apk安装原任务账本与sqlite恢复基础)，后续系统适配层见下节。更新前的当前包核对已在下方提供方基线门禁接入；产品更新入口、实际系统确认/取消、进程跨更新、完整记录/KeyStore连续性与健康接受仍是后续门槛。

## Android安装会话与私有回执适配层

`AndroidApkInstaller`将原账本接到`AndroidApkSessions`，后者实际调用PackageInstaller创建/打开会话、写入、fsync、读回与commit。内部端口仅对应APK系统机制，不是通用更新插件；产品入口通过原Runtime队列/Owner接入，构造时必须提供verifyCurrent并组合停止/身份、实际材料/连续性、当前包基线和安装来源政策门禁，不能传空回调作为产品资格检查。具体产品交互和本机健康接受见后续章节，实际在途命令共存与真实更新继续独立验收。

创建固定MODE_FULL_INSTALL、包名、候选长度及系统保存的`LimeIoT update <request_digest>/<candidate_bytes>`标签；API31及以上明确要求USER_ACTION_REQUIRED。创建意图提交后再核对一次资格，失败时零系统创建且保留creating。恢复只读当前UID的mySessions，再核对installerPackageName、原请求摘要、包名和规范化声明长度。API23没有getSize（API27），声明长度从原系统会话标签读取，不借助隐藏字段；API27及以上还要求系统长度一致。该元数据只识别原创建意图，不证明暂存字节，后续仍完整读回核对。

stage仅接受原created会话。新写入以64KiB块检查资格及长度/摘要，fsync并关闭输出后从同一会话读回；已有文件仅在恰好一个base.apk时读回，不自动覆盖部分/错误写入、放弃或重建会话。读回长度和SHA-256必须完全一致才能保存staged。commit在账本提交意图前后分别核对资格、自有会话及完整暂存字节；第二次失败保留committing、零submit。原committing/pending_user/终态查询不产生新commit，Binder异常继续沿原任务恢复。此处的同步不承诺Flash掉电或旧备份防回退。

系统结果使用显式广播PendingIntent，data固定原requestId、request_digest与session_id，API31及以上显式可变，以接收系统填充的状态；不使用一次性PendingIntent。ApkInstallResultReceiver在清单中exported=false，后台单线程接收后重开原SQLite，核对组件、action、完整路由、原摘要/会话及可选包名。未知/错配状态和冲突终态不写原记录；系统取消记录cancelled，成功仍installed_unverified。系统确认Intent不入库且不自动启动，用户交互见原安装任务一节，丢失临时确认后继续保留pending且不重提交；非导出入口及路由核对也不是独立签名的系统安装证明。

AgentRuntime已增加新连接启动保护：在创建RunPermit前读取更新账本，未决/待验证任务或账本读取失败均拒绝新连接。这不停止已有连接，也不替代开始更新前的完整停止/在途命令门禁；installed_unverified继续阻止新连接与另一更新，明确本机健康接受见最后一节。提供方和接收器共用进程Owner锁，跨实例保存仍使用原字节CAS，已有身份库保持独立。

宿主软件范围、API23修复与原始结果见 [24第4.54节](../docs/24-实施计划与进度.md#454-android安装会话与私有回执软件适配)。实际安装/系统确认、安装来源授权、安装后的当前包与完整身份/记录/KeyStore连续性、更新后健康和型号验收仍独立待交付，不提升第二种实际更新机制或正式OTA类别。

## 当前已安装APK的基线核对

`AndroidInstalledApk.verifyBaseline`只从PackageManager读取固定自身包run.limeai.iot.television，核对PackageInfo/ApplicationInfo包名、当前进程UID、独立基础包形态及完整版本码。API23–27使用GET_SIGNATURES，API28起强制GET_SIGNING_CERTIFICATES，缺少现代信息不回退；只接受唯一当前签名、无历史轮换，现代历史必须与当前证书一致。证书为有界、完整且无尾随数据的X.509 DER，其SHA-256必须与原计划同签名指纹一致。shared UID、split、非正版本及大于Int.MAX_VALUE的完整版本均拒绝，不截断高位。

基础包路径只取系统sourceDir，要求绝对路径及1–256MiB普通文件，64KiB有界流式读取实际完整SHA-256，并核对通道长度、读前后路径元数据及重新读取的PackageManager事实。实际版本/摘要必须与原baseline一致；损坏、不可读、系统读取异常或变化均阻断。这依赖Android系统保护安装路径，不是文件inode锁，也不承诺抵抗root/被篡改系统；不从用户传入路径推定当前安装事实。

AndroidApkInstaller默认组合该读取器：创建意图前后各核对一次，暂存前后各一次，提交意图前后各在会话读回前后核对一次。逐块verifyCurrent继续核对运行资格，不重复扫描整包。首次创建前不匹配保留prepared；创建意图后不匹配零系统创建且保留creating；暂存末尾不匹配不推进staged；提交意图后不匹配零submit且保留committing。原创建恢复、staged查询以及committing/pending_user/终态查询不触发新基线扫描或重发。

该核对仅证明更新前基线，不能接受更新后的新包为健康，也不验证preflightDigest/continuityDigest的真实来源。测试可以显式注入当前包夹具；产品不能用空verifyInstalled或verifyCurrent绕过门禁。完整停止/在途原命令、产品交互、身份/完整记录/KeyStore连续性及健康仍待接入；来源授权/政策读取见下节。宿主结果见 [24第4.55节](../docs/24-实施计划与进度.md#455-当前安装包基线核对与提供方接入) 与[脱敏证据](../docs/evidence/2026-11-03-tv-apk-baseline.json)，不提升真实电视或第二种实际更新机制验收。

## 安装来源授权与系统策略

`AndroidApkInstallPolicy`为Android提供方的只读系统门禁。清单声明REQUEST_INSTALL_PACKAGES，读取固定自身包的GET_PERMISSIONS确认声明；声明不等于来源获准，也不等于用户确认安装。不请求系统签名权限，不使用可信来源/设备所有者或静默安装例外。

API23–25按AOSP安装器读取Settings.Secure.INSTALL_NON_MARKET_APPS，缺失/关闭为待用户授权；API26起只使用PackageManager.canRequestPackageInstalls，不回退旧开关。所有版本核对UserManager.DISALLOW_INSTALL_APPS和DISALLOW_INSTALL_UNKNOWN_SOURCES；API29起另验DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY。管理员限制、缺少声明、系统服务/读取异常分别阻断，不自动修改设置、AppOps、限制或权限。策略读取是当前快照，系统保留最终安装决定。

AndroidApkInstaller默认组合此门禁，与原verifyCurrent在创建/暂存/提交及逐块读取、写入前、fsync前共同检查。写入中失权停止后续块，不推进staged；耐久创建意图后失权零系统创建、保留creating；耐久提交意图后失权零submit、保留committing。未知创建/提交及待用户/终态查询不以授权变化重新创建或提交。原调用方仍必须提供完整身份/预检来源/停止/在途资格检查，不能用空回调代替产品门禁。

sourceAuthorizationIntent只为将来可见页面上的明确用户操作构造跳转：API26起固定MANAGE_UNKNOWN_APP_SOURCES及自身package URI，旧版使用SECURITY_SETTINGS。只返回可用、导出且有调用权限的系统应用Activity，并固定其组件；API24起额外使用MATCH_SYSTEM_ONLY，API23通过返回的应用标志核对。缺少或不可访问的系统设置页返回明确故障；已授权返回空，管理员限制不提供绕过入口。方法不启动Activity，不把设置页返回当作授权，返回后必须重新核对原任务全部门禁。

来源界面尚未接到产品更新入口。实际厂商策略、系统确认、完整停止/在途、跨更新记录/KeyStore与健康仍需独立验收。AOSP Android6/7/8原始参考、5项API边界和新增11方法/19次宿主执行结果见 [24第4.56节](../docs/24-实施计划与进度.md#456-安装来源授权与系统策略门禁) 及[脱敏证据](../docs/evidence/2026-11-03-tv-apk-policy.json)；这是公开源码核对与宿主软件证据，不是小米系统逆向或实机授权结果。

## 更新期间的运行Owner与停止边界

AgentRuntime新增内部withApkInstallation入口，在原单线程存储队列执行同步安装操作，重开独立更新库并组合现有AndroidApkInstaller；不新增网络动作或产品更新界面。进入前及提供方的运行资格回调均要求permit和连接引用同时为空。stop仅撤销旧许可、请求连接关闭；直到原run返回并完成清理才清除permit，因此“已请求停止”不能通过更新门禁。入口不自动停止或重启连接。

提供方、回执及Runtime统一使用同一ReentrantLock，固定Owner→运行锁的嵌套顺序。连接启动先保留已有运行许可的幂等返回；新启动只tryLock，不在主线程等待APK读写。Owner被其他线程占用或由当前线程重入时拒绝新连接；得到Owner后仍核对原更新账本，未决/待验证或坏账本继续拒绝。原任务查询、prepared取消或异常释放Owner都不会自动恢复连接，用户必须再次明确开始。

内部操作在整个同步阶段持有Owner，原存储队列上的维护/授权操作不会与该阶段并行。独立SQLite的CAS、原请求/会话恢复和默认当前包/来源政策检查保持原语义；完成/失败结果回到主线程，异常也释放Owner。该锁只覆盖本进程中的入口，不承诺外部进程数据库写入或root对抗。

可信预检现由后续文件材料入口核对原签名身份、完整报告与候选字节；原verifyMaterials回调入口保留用于宿主故障注入，不能传空回调宣称产品合格。原记录摘要由下方独立门禁强制读取和核对；运行线程退出、更新前材料/摘要与跨更新健康分别验收。实际MQTT在途原命令、安装后完整记录/AndroidKeyStore连续性和健康仍需独立核对。installed_unverified保持占用。

宿主结果见 [24第4.57节](../docs/24-实施计划与进度.md#457-运行owner与更新前线程退出门禁)及[脱敏证据](../docs/evidence/2026-11-03-tv-apk-quiescence.json)。新测试使用实际Runtime线程/队列、原许可生命周期及宿主SQLite，连接端口受控且不运行MQTT；原不透明日志字节保留不能替代有效confirmed/unknown日志或完整更新验收。

## 更新前原记录连续性摘要

AndroidAgentStore.apkContinuity在原库单一事务内取得维护身份、原初次请求、授权、完整命令字节及全部轮换行。解密前限制原表行数与载荷；复用正式DeviceJournal恢复解析器校验confirmed/failed/unknown/JsonNull和high_watermark，只返回绑定、摘要与计数，不迁移日志、不回收记录、不导出凭据或alias。授权读取与写入复用相同包名校验并核对slot。未配置且没有原身份请求时拒绝生成绑定；prepared/creating/pending原请求可只读保留，creating缺钥不重试创建。

摘要v1绑定当前SQLite版本、agent凭据密文字节、原journal精确字节（含null区别）、identity原密文、每条rotation的number/request_id/binding/原密文、完整授权及已记录引用的实际公钥/缺席状态。使用有界行摘要组成canonical文档，不以SQLite物理页摘要为存储合同；重新加密即使明文相同也改变摘要。独立APK任务库不纳入该摘要，避免计划摘要与自身阶段递归。没有新增数据库版本或表；既有helper打开/配置和受支持旧库升级仍单独适用。

历史轮换解密并严格解析，核对相邻候选/前证书/公钥关系；最新身份与轮换继续使用原持钥验证。原已批准deleting/retired状态允许相应旧键缺席，retired又出现或保留键无批准却丢失则拒绝；存在键重新核对实际公钥/原CSR。原CRL、批准时刻和未知删除状态精确保留，不因当前日期重新批准历史决定、不要求已退休中间私钥复活。此层验证记录保全与当前观察状态，不重新证明每项历史管理操作或完整信任迁移。

AgentRuntime.readApkContinuity在原单线程队列与APK Owner内要求旧worker完全退出，再返回实际摘要。withApkInstallation组合的生产提供方在创建、暂存前后及提交边界强制将实际绑定/摘要与原计划比较，材料回调之后再核对，变化报apk_install_continuity_changed；每64KiB仍只做轻量停止/来源/材料资格检查，不重复整库扫描。失败保留原任务/会话，未知提交查询继续只读且不重新核验或重发，没有自动连接或系统交互。

宿主结果见 [24第4.58节](../docs/24-实施计划与进度.md#458-更新前原记录连续性摘要与边界核对)与[证据](../docs/evidence/2026-11-03-tv-apk-continuity.json)。这是更新前的软件门禁；后续签名材料入口已在软件层接入预检来源，产品确认/返回恢复、实际安装、安装后完整身份/授权/日志/KeyStore连续性和健康尚未交付。系统成功仍保持installed_unverified占用，正式OTA类别与通用插件准入不提升。

## 签名预检材料与当前APK信任锚

tools/tv-agent-apk.py保留原无安装授权的JSON输出。可选signed-output在同一轮官方SDK预检通过后，将原报告和实际候选长度封装为签名JAR；必须同时提供signing-java-home、keystore、key-alias、store-pass-env和key-pass-env，缺项/无口令/不匹配证书/已存在输出拒绝。JDK keytool只导出公开证书并核对独立给定的原APK签名指纹，jarsigner通过Keystore签名，口令只用环境变量名传递，私钥不导出。SHA256withRSA或SHA256withECDSA与SHA-256内容摘要固定选择，不使用TSA或发布/安装操作。签名包生成失败不得视作已交付，输出不覆盖原文件。

签名载荷为UTF-8 preflight.json，严格字段为schema=limeiot.tv-apk-preflight、version=1、candidate_bytes和preflight。后者保持原schema_version=1离线报告，installation_authorized/device_state_verified/storage_compatibility_verified仍必须false。candidate_bytes绑定实际候选长度1–256MiB。计划沿用原preflight_digest，取完整载荷的DeviceDocument/JCS摘要；没有APK任务或身份库版本迁移。仅原JSON报告、文件名或随包提供的证书都不能作为信任来源。

JAR总长最多1MiB，仅接受preflight.json、META-INF/MANIFEST.MF、META-INF/LIMEIOT.SF及一个LIMEIOT.RSA或LIMEIOT.EC签名块，可另有META-INF/目录。重复/额外条目拒绝，载荷解压最多64KiB、各元数据最多256KiB。标准JarFile开启验签并完整读完载荷后，要求恰好一个CodeSigner、1–8项证书路径，以叶证书DER指纹匹配系统当前已装自身包的原签名；随包CA链不建立额外信任。SHA-256清单和载荷摘要分别核对。过期/撤销的TLS身份不参与APK签名信任，当前APK原有的多签/轮换限制不放宽。

VerifiedApkPreflight严格校验报告字段、固定包名、旧/新摘要/版本/签名、API23–36目标及ABI、权限差异和debug声明；开发候选还要求本地allowDebug明确允许。AndroidApkMaterials从PackageManager取得自身签名并扫描实际基线，重验JAR来源与候选实际整包字节；不会在电视运行SDK工具或自行实现APK密码算法。报告认证发布者的预检事实，系统安装器仍独立决定APK是否可安装，来源政策、用户批准与存储兼容不由该签名授予。

AgentRuntime.prepareApkInstallation在原Owner/队列、worker完全退出后组合实际材料与原库摘要，耐久保存原计划。文件形式withApkInstallation延迟加载材料，只在实际效果资格检查时读取；轻量块检查只核对计划/目标/文件状态，安装边界重新验签和完整候选摘要，再核对原记录摘要。原始文件应保留或由用户重新选择同一材料；未知提交查询不要求文件仍存在，不重新预检、创建或提交。本机导入/私有路径及权限审阅由下节接入；原安装与系统交互见最后一节，健康接受继续独立交付。

验证见 [24第4.59节](../docs/24-实施计划与进度.md#459-签名预检材料与实际候选来源接入)和[证据](../docs/evidence/2026-11-03-tv-apk-materials.json)。实际JDK/SDK验签和宿主系统事实夹具分别记录；Android6公开源码及6项SDK API边界不能替代实际Android JarVerifier/系统签名取证。未安装或连接电视，installed_unverified仍占用，正式OTA类别、第二种实际更新机制与通用插件准入不提升。

## 本机更新材料导入与可见批准

TelevisionActivity通过非导出的ApkUpdateActivity进入“更新材料与批准”。使用系统ACTION_OPEN_DOCUMENT选择同次发布的签名预检与APK，输入URI只在本次导入使用；显示名、外部路径、持久URI权限和系统确认Intent均不写入计划。副本保存在noBackupFilesDir/apk-imports/apk-UUID目录，固定preflight.jar/candidate.apk；目录名与规范路径严格校验，不接受穿越、符号链接或额外文件。

每项先独占创建part，最多64KiB流式复制，要求非空、正读取进度、文件fd.sync、同目录重命名及目录Os.fsync；新目录和丢弃也请求父目录同步。每份报告最多1MiB、候选最多256MiB，最多128项、累计逻辑文件长度最多512MiB，part和历史副本同样计入。源读取/同步/进程中断保留原目录与part，不覆盖、自动重读URI或换任务。额度不代表设备必然有足够空间，I/O异常保留原副本供核对；这些同步调用不构成已验证的实机断电保证。

未批准导入不占用安装账本。重启从私有目录列出原申请，可继续尚未选择的APK、核对完整材料或明确丢弃；已有part须明确丢弃重选，不覆盖中断写入。仅原账本从未记录的导入允许明确删除副本；即使原计划已取消，也保留其材料与历史，不自动清理或腾挪。副本目录异常会阻止新增导入，但不能隐藏原账本或妨碍取消尚未创建会话的计划。

预览从当前系统APK签名取锚并完整核对材料，展示旧新版本、长度、APK摘要、签名、开发标志及新增/移除权限。开发包默认不勾选，须另行明确允许；签名报告的debug声明不能代替本机决定。批准在原Runtime队列/Owner内重新验签、核对完整候选和原审阅对象，取得当前连续性摘要，在worker完全退出且页面仍可见时仅保存PREPARED计划。预览、取消文件选择、暂不批准、后台完成及重开页面均不创建系统会话、提交安装或自动连接。

已准备计划阻止新连接，可明确cancelPrepared；取消不依赖材料仍可读取，仅适用于尚未创建会话的原计划。原安装推进及来源设置/临时系统确认交互现由下节接通；实机安装与安装后完整健康仍须后续交付。开发包允许仅用于此次明确批准，后续效果仍须重验本机开发包决定及全部原门禁。installed_unverified不释放，未知提交不重新发送。

宿主私有文件、实际Runtime/SQLite及平台Views/SAF返回夹具验证见[24第4.60节](../docs/24-实施计划与进度.md#460-电视更新材料持久导入与可见批准)和[证据](../docs/evidence/2026-11-03-tv-apk-imports.json)。源码页面与宿主生命周期通过不提升为Android电视交互、系统选择器、实际Android验签、安装或断电恢复验收；正式OTA类别、第二种实际更新机制与通用插件准入保持原状态。

## 原安装任务与系统确认交互

PREPARED/CREATED/STAGED原计划在可见页面再次审阅后，通过continueApkUpdate沿原账本创建、流式暂存/核对及单次提交。重验原审阅对象/预检摘要、完整实际候选、当前基线、来源政策、连续性和worker退出；每次onResume创建独占RunPermit，onPause永久停止该许可，旧调用不能借之后重新可见继续。开发包每次显式继续或打开系统确认仍单独允许，旧签名声明和先前批准不代授本次决定。

“核对安装来源设置”只启动已解析并固定的系统设置组件；返回只刷新原记录，RESULT_OK不授予来源权限，也不自动继续。创建返回丢失保留CREATING，显式“查询原安装记录”只匹配当前自有原会话；无会话不足以证明未创建，不补建。COMMITTING/PENDING_USER/INSTALLED_UNVERIFIED/终态的继续或查询只返回原记录，缺材料也不重发，不把会话消失改成失败。

非导出回执先验证原请求/摘要/会话并完成账本CAS，然后ApkInstallConfirmations最多保存一个进程内临时确认入口。仅接受系统返回的有界非空action、固定package/可选component及唯一原session extra；拒绝URI/type、selector、clipData、categories或额外载荷。再次解析为可访问、启用、导出且有系统标记的原package组件，只转交action/显式组件/原session，不转交输入flags/URI授权。损坏或不支持的Intent不撤回PENDING_USER、不覆盖已有合法入口；状态变化通知可见页面刷新，后台不弹出活动。

“核对并打开原系统确认”再次完整核对签名/候选/当前连续性、来源政策和实际自有原会话；主线程最终在Owner下重验同一前台许可、原账本、来源、会话及轻量文件状态，完整核对超过5秒则拒绝本次打开。系统页面返回仅刷新，真正成功/失败/取消仍由原系统回执推进；成功继续INSTALLED_UNVERIFIED，不解除连接阻断。此5秒仅限制检查到启动的延迟，不代替效果边界或抵抗特权外部写入。

确认Intent不序列化到文件/Bundle/数据库。进程重启保留原账本和私有材料，但临时入口可能丢失；此时显示原PENDING_USER及“入口不可用”，查询原任务，不重复commit或自行构造隐藏确认action。公开AOSP中createDetailsIntent指向原安装来源应用，不是系统确认恢复。原系统重复回执可再次提供入口，不能据此承诺所有厂商或跨进程确认自动恢复；不支持的厂商载荷保留待核对。

宿主Runtime/SQLite、系统会话与回执夹具、Views来源设置返回及公开AOSP依据见[24第4.61节](../docs/24-实施计划与进度.md#461-原安装任务推进与系统确认交互)和[证据](../docs/evidence/2026-11-03-tv-apk-interaction.json)。软件入口接通不代表实际安装、Android系统确认/取消、跨更新完整身份/授权/命令/键连续性或健康完成；不新增健康终态、正式OTA类别或通用插件准入。

## 安装后本机健康核对与明确接受

仅INSTALLED_UNVERIFIED可核对并接受本机健康。AndroidInstalledApk复用原整包扫描，同时要求编译期BuildConfig.VERSION_CODE等于原候选版本，当前进程applicationInfo/sourceDir/packageCodePath与系统当前自身基础包路径一致，再验完整候选版本、长度、SHA-256及唯一签名。旧代码不能仅因PackageManager已显示新版本就宣布新包健康；不支持split/shared UID/多签与轮换的原边界继续保持。依赖系统保护安装路径，不承诺抵抗root或被篡改系统。

AndroidApkHealth在原Runtime队列/Owner、worker完全退出后只读核对原连续性摘要，覆盖原身份/密文、应用授权、完整confirmed/failed/unknown/unresolved日志、序号、原轮换与清理决定及实际键状态；普通load/tls要求当前有效凭据和实际持钥解析，随后只读应用发现，再复核已装候选和原摘要。复用DeviceSigningKey.from的随机挑战核对实际私钥句柄，不新增任意签名入口，不补建/删除键、不迁移或改判原命令，不建立Socket或启动应用。应用发现成功不代表授权目标可启动或远程控制成功。

页面“核对更新后状态”只展示本机检查；“接受本机健康”在同一不可复活的前台RunPermit下再次完整核对并比较本次审阅，最终重验可见/退出门禁后CAS保存LOCAL_HEALTH_ACCEPTED及有界local_health记录。预览、页面返回与生命周期不接受健康。接受只解除原更新对手动连接的阻断，不自动连接、重放命令或再次安装；联网与远程操控仍单独验收。COMMITTING/PENDING_USER不因候选版本变化或会话消失成为成功；缺原系统成功回执时仅可按[独立恢复](#提交结果未知时的本机独立恢复)另行完整核对并明确接受，否则继续阻断。健康核对不依赖导入文件仍存在。

APK账本BLOB当前写schema_version=3，兼容读取v1/v2，下一次正常CAS写v3；SQLite结构/版本仍1，身份库不变。local_health绑定原计划摘要、实际候选摘要/长度/签名、编译版本、原连续性摘要、当前设备证书指纹与有界应用发现数，只能与LOCAL_HEALTH_ACCEPTED或独立恢复的LOCAL_PACKAGE_RECOVERED同时存在。旧程序拒绝v3，不能降版本冒读。核对失败不写；CAS冲突或提交结果未知冻结原实例，重开只取实际耐久阶段，不能重新安装。重复原系统成功保持已接受决定，冲突失败/取消回执不能覆盖它。

这是本机健康决定，不等于完整远程升级验收。源码与宿主结果见[24第4.62节](../docs/24-实施计划与进度.md#462-安装后本机健康核对与明确接受)和[证据](../docs/evidence/2026-11-03-tv-apk-health.json)。实机包替换、AndroidKeyStore跨更新与断电、厂商交互和完整控制旅程未验收；正式OTA kind仍device-firmware，第二种实际机制与通用插件准入不提升。

## 提交结果未知时的本机独立恢复

当前为部分交付：新增15方法/24次执行通过，最后完整回归为核心56过/3跳、App217过/2跳，合计273过/5跳，2项失败。两轮针对性修复仍未解除既有API23安装流程超时，第三轮重复失败后中止，阶段验收阻塞；APK构建与lint通过（0错误/4既有警告）。详细失败与范围见本阶段证据。

仅原COMMITTING/PENDING_USER可进入独立恢复；会话消失或PackageManager显示新版本本身均不足以释放阻断。核对必须使用未按标签过滤的PackageInstaller.mySessions，读取失败、超过128项或仍有任何本应用会话均拒绝。先核对空会话，再复用完整候选整包/唯一签名、编译版本/当前进程加载路径、原连续性、当前有效凭据与实际持钥检查，完成后再次查询原始会话列表。CREATING/PREPARED/CREATED/STAGED不支持此路径；创建未知仍只查询原会话，不能补建。

页面“核对已运行候选包”只读预览；所有者必须在同一不可复活的前台许可下明确“接受本机恢复”。接受时重新完整核对原阶段/session和本次审阅，最终运行锁内再验可见许可、worker完全退出及第三次原始会话列表为空，才CAS保存LOCAL_PACKAGE_RECOVERED。保留原计划、session、local_health与recovered_from，不伪造原系统安装成功。只解除手动连接阻断，不创建/打开/放弃/提交安装会话，不自动连接、启动应用或重放命令。取消核对、旧对话框或页面返回均不接受恢复。

恢复后迟到的原系统PENDING只读；首个原安装成功/失败/取消终态单独保存recovery_result，不覆盖本机恢复决定和原缺回执来源。相同终态重复只读，冲突终态拒绝。相同来源和健康的重复恢复只读，阶段/session或审阅变化必须重新核对；普通LOCAL_HEALTH_ACCEPTED路径仍仅接受原系统成功。

APK账本BLOB统一写v3、兼容读取v1/v2/v3，新增recovered_from/recovery_result仅供LOCAL_PACKAGE_RECOVERED使用；local_health仅允许两个明确接受终态。来源限定committing/pending_user，迟到结果不能为pending。v1/v2不得声称新恢复阶段；旧程序拒绝v3。SQLite结构/版本仍1，身份库不变。CAS冲突或耐久结果未知冻结原实例，重开只读实际耐久决定。

软件验证见[24第4.63节](../docs/24-实施计划与进度.md#463-提交结果未知时的本机独立恢复)及[证据](../docs/evidence/2026-11-03-tv-apk-recovery.json)。这是已运行候选的本机独立决定，实际Android包替换、厂商会话生命周期、跨更新AndroidKeyStore及联网控制仍待验收。

## Android媒体音频接口基础

> 下述音频基础与协议段落记录4.64/4.65冻结快照，其未接线与lint范围仅适用于对应阶段。当前本机授权及Runtime接线见[本次运行授权](#本次运行音频授权与电视端接线)。

当前仅提供AudioState/AudioPort和AndroidAudio系统端口，尚未接入DeviceAgent命令、MQTT、精确音频模型、本机运行授权页面或网页控制。原应用/遥控组合模型的执行能力不因此增加。

AudioState保留系统实际minimum/maximum/index/muted；百分比按实际刻度最近取整、中点向上，Long中间值避免溢出，静音独立于零音量。AndroidAudio仅访问STREAM_MUSIC，API23–27使用公开零下界，API28起读取系统最小值；前后重验范围、原不可复活RunPermit、本机授权、当前凭据、普通MODIFY_AUDIO_SETTINGS权限及固定音量策略。无效范围、采样中范围变化或撤权均拒绝。音量与明确静音/取消静音调用flags=0，不主动请求系统音量面板；实际厂商表现待验。

setter返回只表示系统调用已提交，不能生成实际状态或回显请求值；后续状态必须另行真实读取。原15级音量请求5%可能回读7%，不能修改全局property confirmed的相等规则。后续精确模型拟以只读audio.volume/audio.muted与独立调节动作表达该语义，当前未发布或宣告能力。

新增12方法/19次宿主执行通过（核心5、API23/28应用14），Debug APK构建通过；音频源码未另跑lint。两项既有APK回调超时继续保留。系统范围、读数和权限为明确夹具，没有访问电视、模拟器、实际音频服务或安装APK；实际音量/静音和厂商面板表现尚未验收。见[24第4.64节](../docs/24-实施计划与进度.md#464-android媒体音频接口与量化基础)及[证据](../docs/evidence/2026-11-03-tv-audio-port.json)。

## 音频精确模型、命令与完整状态

> 本节保留4.65冻结范围；当前本机身份改模见[明确模型扩展](#本机引用身份的明确模型扩展)，网关与网页组合见[执行合同](execution-routes.md#显式能力组合与原生证明)。

设备核心新增固定资源[音频应用模型](models/android-tv-audio-agent.json)与[音频遥控模型](models/android-tv-audio-remote.json)，原两个模型定义/摘要保持。audio.volume/audio.muted只读并通知，audio.set_volume接受percent安全整数0–100，audio.set_muted接受真正的布尔muted；额外字段、错误类型和旧模型收到音频命令均拒绝。调节动作completion=submitted、输出严格为空，不把请求值写成实际状态，也不改变网关property confirmed等值规则。

hello仅在音频端口获准且实际读取成功后声明apps.launch/audio.set_volume/audio.set_muted，remote.press仍不能由Agent执行。welcome后的完整快照及每次heartbeat独立读取实际刻度和静音，生成audio.volume/audio.muted、采样时刻与tv-agent.audio来源；读失败停止该会话，不发布空快照或沿用缓存。命令结果仍只确认输入提交，采样状态与执行结果独立。

音频动作复用原有序ID、耐久result=null意图、执行前二次授权/连接/期限核对、unknown不重放及精确摘要回收。系统调用开始后的异常保留unknown；提交前/耐久后存储异常均冻结原消费者，重开只取实际日志。DeviceAgent/DeviceMqtt保留旧构造入口，应用动作继续使用原Envelope和结果语义。

原应用模型继续写命令日志v2，原遥控模型写v3，两个新音频模型写v4；v1/v2只属于原应用模型，v3只属于原遥控模型，v4必须匹配新音频模型精确修订。每条历史Envelope仍按其自己的固定模型校验动作，不能将旧模型包伪装成音频输入。迁移只允许增加音频或遥控逻辑能力：应用→遥控/音频应用/音频遥控、遥控→音频遥控、音频应用→音频遥控；禁止任何反向或交叉丢能力迁移。保留全部原命令/结果/unknown/未决和high_watermark，容量仍128条/1MiB。旧程序不理解v4须拒绝，不能清数据降级。

Android旧PEM材料明确确认时在原SQLite事务中同时保存新材料与完整迁移日志，故障两者回滚，应用授权保持。SQLite仍v3、身份/轮换格式及APK更新账本BLOB v3不变；命令日志v4与这些版本独立。现有v3本机引用身份仍固定原模型，未增加改模入口。材料Schema及准备工具支持四个精确配置，但准备材料与保存记录均不授予音频控制。新模型未加入网关内置目录，Android Runtime在本机授权接通前明确拒绝启动其连接。

核心71过/3跳，应用定向28次通过；新增11方法/11次执行通过，另有1项公开配置工具旅程、19组Schema检查及2份共享Rust模型校验通过，Debug APK构建通过。音频源码未另跑lint，完整应用回归未运行，4.63两项APK回调超时保留。 Android产品连接仍以本机音频授权功能尚未开放为由拒绝启动新音频模型；网关内置模型目录、音频MQTT旅程、本机运行授权与网页控制未接通。没有电视探测、连接、操作、安装或模拟器，实际音频与完整平台未验收。 见[4.65](../docs/24-实施计划与进度.md#465-音频精确模型命令日志与完整状态)及[证据](../docs/evidence/2026-11-03-tv-audio-protocol.json)。

## 本次运行音频授权与电视端接线

> 本节验证数字与待办记录4.66快照；已有v3身份改模的当前规则见[明确模型扩展](#本机引用身份的明确模型扩展)。

音频模型的连接现由本机明确的单次运行批准控制，取代4.65无条件拒绝音频模型的临时门禁。普通MODIFY_AUDIO_SETTINGS权限、导入材料、打开页面或启动Service都不能代授。电视页面“开始连接”先核对通知权限，再展示空间、设备与作用期；仅“允许并开始本次连接”发放进程内一次批准。批准不进入Intent、Bundle或存储。

AudioRunConsent与Runtime/AndroidAudio共用运行锁，审阅绑定不可复活的前台代次及当前完整设备/模型修订/连接/CA/证书摘要。离开或重建页面使未消费审阅失效；开始时消费一次批准，worker加载真实凭据后再次比较并绑定原RunPermit。伪造批准对象、不同run或变化摘要均拒绝，消费后、绑定前撤权也不能恢复。已消费并绑定的运行可按页面说明继续后台，原应用启动仍遵循已有前台政策。

停止、撤权、worker退出或进程结束清除批准；撤权同时停止原许可并关闭连接。原端口和原审阅不会被新批准复活，排队页面更新在运行锁内重新读取授权。旧运行未清理前仍阻止APK更新；原Owner→运行锁顺序、完整worker退出门禁与原两个非音频启动入口保持。SQLite、身份/轮换记录和APK账本格式不变，无新依赖。

核心71过/3跳，应用定向32次通过，其中新增16方法/16次执行全过；Debug APK构建和当前全部音频源码lint通过（0错误/4项警告）。完整应用回归未运行，4.63两项APK回调超时保留且未重试。 连接/online/音频/权限为明确宿主夹具，实际Runtime线程、设备核心、AndroidAudio调用与宿主原生SQLite运行；未执行DeviceMqtt.run、Socket或真实系统Service调度。没有电视探测、连接、操作、APK安装或模拟器。网关内置目录、音频MQTT旅程、属性与动作组合、网页控制及已有v3本机身份改模仍待交付。 实际系统音频、厂商表现、电视交互和完整平台未验收。见[4.66](../docs/24-实施计划与进度.md#466-本次运行音频授权与电视端接线)及[证据](../docs/evidence/2026-11-03-tv-audio-consent.json)。
