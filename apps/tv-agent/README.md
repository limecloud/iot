# 电视设备 Agent

本目录独立于手机控制端 `apps/android`，包含设备 JVM 核心与独立 Android 电视应用。本机能力仅有应用启动，可选择独立应用模型或显式组合所用的遥控逻辑模型；使用设备 MQTT 5/mTLS、会话/期限、耐久尝试与回执，以及当前本机授权。应用提供设备材料核对、Keystore 加密、私有 SQLite、Leanback 启动入口与可见连接服务；源码、构建、宿主沙箱和真实电视验收分别记录。

正式边界见 [设备核心合同](../../contracts/tv-agent.md) 与 [回执确认合同](../../contracts/command-receipts.md)，角色、路径与权限见 [电视设计](../../docs/34-电视终端与AndroidTV接入.md)。0.3.0受控模型/日志迁移实现见 [24第4.15节](../../docs/24-实施计划与进度.md#415-tv-agent模型配置与日志迁移文档同步)，入口拆分见4.16，跨模型与实际JVM/假ADB组合软件结果分别见 [4.19](../../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)、[4.22](../../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)，Android端上诊断、安全组及阻塞见 [4.24](../../docs/24-实施计划与进度.md#424-独立启动诊断与android安全组端上验证)；0.2.0历史结果保留于4.13，不扩展为当前源码最终通过。

## 构建与验证

2026-11-03真实MiTV4-ANSM0/API23验证已取得AES-GCM/错误主机名2项、P-256不可导出/CSR/重开1项和一次实际目标Activity启动的证据；完整旅程仍未通过。第二条命令为confirmed/submitted，但未得到第二条Activity生命周期记录；测试目标改为singleTask后仅构建/lint通过，尚未安装复验。用户因家人观看暂停电视调试，自有Agent测试进程已停止；后续不自动恢复实机动作。详情及前台服务限制见 [24第4.51节](../../docs/24-实施计划与进度.md#451-tv-agent-api23兼容修复与实机阶段暂停) 和 [型号台账](../../docs/30-设备支持矩阵与证据台账.md#9-dev-cand-08-tv-agent-api23阶段验证)。

需要 JDK21；协议旅程另需仓库 Rust/Node24 工具、OpenSSL 和测试 Broker，Android 任务需 Android SDK 36/build-tools 36.0.0 并设置 `ANDROID_HOME`。复用手机工程现有 Gradle wrapper，两个工程分别配置和构建，不依赖手机核心库：

```sh
sh "apps/android/gradlew" --no-daemon -p "apps/tv-agent" :core:test :core:journeyRuntime
npm run test:tv-agent
npm run test:tv-agent:android
npm run test:tv-agent:runtime
```

第一条执行设备核心单元检查并导出网络旅程入口；需要独立环境的 `MqttJourneyTest` 会明确跳过。第二条构建Rust、执行第一条Gradle任务，再串行运行原回收、已有设备跨内置模型绑定及真实JVM/假ADB组合旅程，各自创建独立CA/Broker/网关与JVM进程。第三条运行Android宿主沙箱、构建调试APK并执行lint；Robolectric的SDK/原生测试库首次会下载。它们均不连接真实电视或读写用户数据库。请顺序运行同一Gradle工程的任务。

第四条为独立Android端上检查，另需SDK内现有的API36 Google APIs ARM64系统镜像、emulator、platform-tools和avdmanager。入口先创建并核对本任务AVD/ADB及系统启动，再生成私有CA、启动真实网关/Broker与构建APK；只安装到核对归属后的模拟器，不连接用户设备。安装后仅对本任务的应用与测试APK显式执行AOT speed编译，结果记录compilation_profile，普通debug冷启动ANR另行保留。使用生产Keystore、SQLite、MQTT/TLS、Service和Leanback启动端口，分别检查密文绑定/损坏拒绝、可达但名称不匹配的TLS拒绝、单次目标Activity启动、后台/撤权拒绝及新进程恢复。应用仍使用正式TLS校验；凭据只进入隔离测试APK的assets，不加入正式APK。每次结果保留在`.dev/tv-agent-android-runtime-*/report.json`，失败不算通过，具体状态见24。当前镜像是API36手机系统，不能替代API23、电视系统、遥控器完整交互、实际Agent/ADB组合或物理归属验收。

仅定位启动时，在相同JDK21/SDK环境执行`node "tools/test-tv-agent-android-runtime.mjs" --boot-only`。该模式不构建/安装APK或启动业务栈，逐次保存有界ADB输出、退出/超时、boot值与归属到`boot-probes.jsonl`；仍使用原180秒预算。`mode=boot_diagnostic`的passed只证明启动，native_app_runtime保持false。已有52.6秒启动通过，以及完整入口中实际AOT和安全组2项通过；业务旅程先在焦点断言失败，后续焦点前置修正虽已编译，两次复验均止于启动，完整入口仍未通过，详见24第4.24节。最新顺序先启动再构建，也未消除ADB离线，达到本轮上限后不继续重跑。

已有当前Rust构建时，可先执行第一条，再单独运行Node旅程：

```sh
node --test --test-concurrency=1 "tests/tv-agent.test.mjs" "tests/tv-agent-model-binding.test.mjs" "tests/tv-agent-composition.test.mjs"
```

`:core:journeyRuntime`在编译测试类后生成`core/build/journey/runtime.json`，包含Gradle所选JDK21可执行文件、测试classpath及`MqttJourneyMain`入口。Node直接启动Java，由该入口复用原`MqttJourneyTest`及断言；设备启动与重启均不再启动Gradle，连接期限和业务断言保持原值。入口缺失时明确失败；源码、构建输出或JDK位置变化后须重新生成。此文件含本机绝对路径，仅供测试，不随APK交付；`:core:mqttJourney`任务仍保留。

内置模型路径可独立运行 `npm run test:model-bundles`：核心/存储/共享协议与CLI、网页、设备核心及已有设备跨模型JVM旅程，包含必要构建，不依赖ADB。该旅程只在私有测试Broker阻断退休确认以保留实际confirmed/unknown记录，经CLI明确换绑、材料/日志迁移及网关/JVM重启核对；结果见 [24第4.19节](../../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)。它不替代实际Agent/ADB组合、Android端上或实机验收。

较早软件复验见 [24第4.17节](../../docs/24-实施计划与进度.md#417-tv-agent独立jvm回收与android软件复验)：直接Java启动的原回收旅程通过，两个JVM完成132次文件应用提交、日志回收及旧快照/网关重启核对；12项Android宿主、0.3.0调试APK与lint也已复验通过，lint为0错误/3警告。核心24项通过、默认网络项1项跳过仍沿用4.16结果，跳过不计网络通过。真实JVM/假ADB组合与假ADB专项的原失败保留；隔离三次只读探测合计4.1秒，超过发现共用3秒期限，只说明当时超时条件。新增独立Android入口、真实Keystore单项与端上未通过项见 [第4.20节](../../docs/24-实施计划与进度.md#420-tv-agent-android端上验证入口与当前阻塞)。整套通过、实际Android运行与物理共存分别验收。

实际JVM Agent/假ADB组合的后续软件验收已通过，见 [24第4.22节](../../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)。三个JVM、同一逻辑设备，原生与假ADB各两次模拟效果；验证单路径离线、两端撤销、网关/JVM重启及unknown保留不重放。等待新原生启动时同时核对apps.launch可用，不以ADB维持的聚合ready代替。ADB身份查询已合并为固定只读命令，仍核对两项身份和原期限；Android端上完整入口及物理归属继续未验收。

`core` 和 `app` 输出 Java 8 字节码，使用 Kotlin、Jackson流式解析、Paho MQTT5和OkHttp主机校验；依赖在各模块独立锁定。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`，包名 `run.limeai.iot.television`，minSdk=23、targetSdk=36、versionCode=3/versionName=0.3.0。这是调试构建；真实Keystore/TLS的分项证据与系统运行政策、完整指定电视验收分别记录。

外部Broker配置仍只接受`ssl://`。Paho1.2.5默认TLS模块引用API24才有的`SNIHostName`，已用其公开传输SPI接入`VerifiedMqttTls`，仅内部使用`limeiot-ssl`。系统分层TLS工厂接收原始host，保持独立CA、客户端证书、握手期限及OkHttp严格主机名校验；不回退明文或系统CA。APK合并第一方与Paho的SPI服务声明。这是固定依赖的传输兼容修复，不是通用设备插件机制；实际正向mTLS使用旧PEM材料路线，不能替代本机EC身份的完整签发/连接验收。

## 本机导入与运行

已有网关应用模型设备跨到内置遥控模型已通过独立JVM软件旅程，见 [24第4.19节](../../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)，实际电视与Agent/ADB组合另验；本机材料/日志迁移不会更改网关绑定。下述组合配置用于已经准备相同逻辑模型的设备，不通过修改config_hash、用户数据库或放宽模型发布规则接管旧设备。

1. 所有者先在网关登记独立设备、绑定 [Agent模型](../../contracts/models/android-tv-agent.json)，按 [设备身份工具](../../deploy/nas/README.md#设备证书) 签发该设备证书。组合场景须先在网关准备android-tv-remote逻辑模型，材料显式选择该profile，连接后再由所有者批准compose；流程不自动新增设备或合并ADB。
2. 使用已有私有签发目录打包；目录须属于当前用户且仅本人可访问，输出必须为新文件：

```sh
python3 "tools/tv-agent-enrollment.py" \
  --identity-directory ".dev/tv-credentials" \
  --broker "ssl://nas.example.local:8883" \
  --model-profile "android-tv-agent" \
  --output ".dev/tv-credentials/enrollment.json"
```

3. 通过所有者控制的介质交付文件。在电视应用选择“导入设备材料”，与可信来源核对空间、设备、Broker和CA/设备证书指纹后保存；不会自动连接。材料含设备私钥，不放入日志、URL或模型上下文，CA签发私钥和所有者Token均不导入。
4. 在电视端勾选允许的应用，再明确“开始连接”。连接通知和页面均提供停止入口；停止后旧运行许可不复活。材料v2包含model_profile，旧v1仍可读；组合场景选择android-tv-remote，本机确认模型和指纹后单向迁移，仍只执行apps.launch。凭据与完整旧日志同事务保存，保留unknown/未决与high_watermark；同身份同模型换证保留日志与授权，改变空间/设备/CA被拒绝，没有清空日志或切身份解锁入口。

应用只启动已安装、启用且可用的Leanback入口，并在调用前再次检查授权。Android10及以上仅在本页面可见时允许启动，普通前台服务不绕过后台启动限制；不使用无障碍、系统签名或任意Shell。Android13及以上开始前需要通知许可。服务为用户主动启动的 `connectedDevice` 前台服务；声明网络状态权限以满足该类型合同，不修改系统网络设置。进程回收、开机和系统停止后不自动恢复连接，用户再次开始时建立新boot/session。

应用离开或Activity重建不复制连接。SQLite使用FULL同步事务，损坏/未知版本拒绝打开；Keystore解密失败不生成替代密钥或清数据。独立应用模型写日志v2，遥控组合模型写v3，均最多128条/1MiB未回收原命令，网关保存最终结果并确认后耐久回收，保留high_watermark；未知记录不清理，满容量仍拒绝。旧日志只读加载，首次实际提交写对应版本；组合模型必须在hello前耐久完成迁移；旧程序不兼容时不得清数据降级。回执查询、单边备份恢复和联合旧备份限制见 [正式合同](../../contracts/command-receipts.md)。调试APK安装、生产认领/续签、APK更新提供方与Android端上Agent/ADB共存分别验收，不能由本机导入或宿主沙箱通过推断。

## 本机持钥与CSR基础层

核心提供无需导出私钥的`DeviceSigningKey`、持钥TLS及标准P-256 CSR生成/恢复；Android已接初次本机请求、公开证书确认、SQLite恢复与电视界面。旧PEM材料仍可独立导入；已有身份走独立受控轮换，不能通过初次请求覆盖。初次与双键轮换已有软件证据，见 [24第4.29节](../../docs/24-实施计划与进度.md#429-tv双键轮换激活证明与撤旧软件闭环)；实际API23 EC不可导出/CSR/重开单项结果见4.51，完整身份接入、轮换与运行仍待验收。

初次流程为：所有者准备公开配置 → 电视导入并核对CA/身份 → 明确申请并保存原CSR → 导出并独立核对SPKI → 管理端按原请求签发/恢复 → 电视只导入`device.crt`并明确保存 → 授权应用并开始连接。公开配置格式见 [Schema](../../contracts/tv-agent-identity.schema.json)，其准备方式如下（输出目录须为本人私有目录，输出文件必须不存在）：

```sh
python3 "tools/tv-agent-enrollment.py" \
  --ca-file ".dev/nas/broker-tls/ca.crt" \
  --space-id "space-demo" --device-id "device-lamp" --request-id "tv-initial-001" \
  --broker "ssl://nas.example:8883" --model-profile "android-tv-agent" \
  --output ".dev/tv-public/identity-setup.json"
```

在仓库根执行；示例NAS/输出目录替换为实际已准备路径。工具只读公开CA、不读取设备私钥、不签发或联网。初次流程不导入管理端`enrollment.json`；轮换仅在独立入口核对原回执。v3凭据仅由本机原请求产生，外部选择器仍只收旧v1/v2材料。数据库v3保留式读取v1/v2，分别保留身份表并新增轮换表；结果不确定时选择“重新核对已保存记录”，再“恢复原申请”，不得清数据或重建身份。状态/故障规则见 [34第5.5.5节](../../docs/34-电视终端与AndroidTV接入.md#555-初次接入的耐久状态设计)。

在JDK21及已有私有Python密码库环境就绪后，可单独运行6项持钥/CSR检查，包括临时NAS原合同签发及真实双向TLS；测试私钥句柄由JCA宿主夹具承接，不是AndroidKeyStore端上证据：

```sh
LIMEIOT_TV_AGENT_IDENTITY_ROOT="$PWD" \
LIMEIOT_TV_AGENT_IDENTITY_PYTHON="$PWD/.dev/firmware-tools/venv/bin/python" \
sh "apps/android/gradlew" --no-daemon -p "apps/tv-agent" :core:test --tests "*DeviceSigningKeyTest"
```

可将Python路径替换为按 [签发合同](../../contracts/device-enrollment.md#准备与发现) 准备的私有环境，不需要安装全局依赖。测试只在`.dev/tv-key-csr-*`新建隔离NAS材料并留下公开结果，不访问用户NAS；临时目录中的CA及Broker私钥仍需作为测试秘密保管。默认`:core:test`在缺少明确环境时跳过该管理签发项，纯JVM持钥/CSR与TLS检查仍运行。

`IdentityKeyRuntimeTest`的EC不可导出、CSR、重开及缺钥不补建方法已在真实API23通过，见4.51；另一个删除测试方法未运行，不将其编译计为端上通过。使用相同环境执行`:app:testDebugUnitTest --tests "*LocalIdentityStoreTest"`验证存储/故障与实际NAS签发→重开→同键mTLS；未配置管理环境时该集成项显式跳过。`npm run test:tv-agent:android`还运行公开配置工具与严格Schema检查。软件、构建与端上状态分别见 [24第4.29节](../../docs/24-实施计划与进度.md#429-tv双键轮换激活证明与撤旧软件闭环)，完整身份流程见 [34第5.5节](../../docs/34-电视终端与AndroidTV接入.md#55-本机身份接入与保留原记录的换钥方案)。

## 保留原记录的换钥

已有PEM材料与本机引用身份共用以下受控流程；已有身份不能用“首次连接配置”换键。每次身份变更前先停止连接，保持原空间、设备、CA、Broker和模型。

1. 选择“申请或恢复换钥”，填写新的管理请求ID。未完成请求重复操作只恢复原键和CSR；结果不确定时先“重新核对已保存记录”，再恢复原换钥。新键暂存时原身份保留。
2. “导出原换钥申请”，独立核对页面上的新SPKI指纹、前证书序列号与DER指纹。管理者按 [原轮换合同](../../contracts/device-enrollment.md#保留旧身份的密钥轮换) 明确`rotate-csr`；丢响应只`resolve-csr`，不换ID重签。
3. “导入换钥回执与证书”，依次选择同次签发的`enrollment.json`及`device.crt`，核对后明确切换。回执在此用于核对原轮换，不是初次接入材料；证书、当前请求与切换决定同事务保存，原授权和完整日志保留。
4. “导出原激活证明”，将文件内的十六进制签名交管理者，用原ID明确`complete-rotation`。证明耐久保存后才输出，重复导出和重开返回同一份。
5. 将原`complete-rotation`或`resolve-csr`的完整JSON响应保存为公开文件，选择“核对管理端撤旧结果”。界面只记录与原操作一致的管理完成观测；管理者仍须另行重载Broker并核对旧身份拒绝、新身份连接。完成核对后才可申请下一轮。

当前SQLite v3保留式读取v1/v2并新增轮换表，不能清库或卸载重装恢复身份。历史轮换最多128条，满容量拒绝，不自动回收；旧KeyStore alias只经下述明确受控流程清理。正式解析、事务、证明及恢复语义见 [设备合同](../../contracts/tv-agent.md#保留原身份的受控轮换)。轮换阶段软件证据保留在 [24第4.29节](../../docs/24-实施计划与进度.md#429-tv双键轮换激活证明与撤旧软件闭环)，清理阶段检查见 [第4.30节](../../docs/24-实施计划与进度.md#430-tv已撤销旧密钥的受控清理与文档同步)：42项身份宿主检查及原12项Android边界检查通过，核心30通过/1项专用MQTT跳过，应用与测试APK构建通过，lint 0错误/6警告。当前过期维护及更新后的检查范围见 [第4.33节](../../docs/24-实施计划与进度.md#433-tv过期身份维护与持续有效期软件闭环)。AndroidKeyStore EC、交互、进程恢复和电视系统仍待端上验证，不能由构建或宿主替身补算。

## 过期身份恢复

已保存的设备证书到期后，页面显示“证书已过期，仅可维护”，不能开始连接。维护读取仍检查原CA、设备身份、用途及实际持钥；CA到期、原键丢失或资料损坏不能通过本流程修复。不要清数据、卸载或换ID重新接入。

1. 停止连接，选择“申请或恢复过期身份”。没有候选时保存唯一请求ID；如果已保存换钥申请，确认沿该原申请进入维护，保留原CSR及密钥，不能另建候选或换ID。
2. 使用“导出原换钥申请”，将原CSR、新公钥指纹、前证书序列号及指纹交管理者独立核对。没有原签发意图时，明确调用[恢复合同](../../contracts/device-enrollment.md#过期身份的受控管理端恢复)中的`recover-csr`；已有普通换钥签发或响应不明时，只`resolve-csr`原操作，不能重新签发。
3. 使用“导入换钥回执与证书”，选择原操作回执和当前有效的新证书，核对后明确切换。新恢复须使用管理v3；由原普通换钥进入维护时，可以核对该原操作的v2回执，不能删字段或改用途伪装新恢复。原空间、设备、CA、模型、应用授权及完整命令记录保留。
4. 导出原激活证明，沿原ID完成`complete-rotation`并核对管理完成结果。管理者重载Broker并检查连接后，才能按下节独立核对并清理原旧键。

维护对象不提供TLS或私钥导出，普通读取与连接继续拒绝过期证书。内部恢复记录v3、管理恢复回执v3和设备材料v3属于不同格式；数据库仍v3，旧内部v1/v2保持可读。原请求、候选缺钥和切换不确定时均保留原记录，不自动补建或转用另一用途。当前软件与端上证据分别见[实施进度](../../docs/24-实施计划与进度.md)；该单台电视分项结果与用户暂停状态见4.51，其他实机继续跳过。

已经连接时证书到期，也会停止接受新控制并结束连接；缓存TLS工厂不能建立新连接。页面和运行时阻止增加应用授权，仍可撤权。原尝试和结果继续保存，未能发送的结果不会变成重新启动应用的理由。软件验证及未验收范围见 [24第4.33节](../../docs/24-实施计划与进度.md#433-tv过期身份维护与持续有效期软件闭环)。

## 核对并清理已撤销旧密钥

这是删除旧签名键的独立操作。先完成上述原轮换及管理撤旧核对；管理者另行重载Broker，验证旧身份拒绝、新身份可连接。新身份、授权和命令记录保持连续，旧键删除后无法恢复。

1. 停止连接，选择“核对并清理已撤销旧密钥”，选中原轮换请求。较早v1记录显示无法定位旧键，不自动匹配；旧PEM路线没有本机旧alias，不适用。
2. 选择管理端固定CA签署的完整CRL文件。应用核对签名、时效、原旧证书和公钥以及当前证书未被撤销；仅有管理完成JSON不能删除。CRL最多16KiB，组合后的原记录超过32KiB也会拒绝，原数据保持。
3. 核对确认页上的原请求、旧证书/公钥和CRL指纹，再明确“确认删除该旧密钥”。应用先耐久保存原意图，再删除并核对缺席，最后保存完成；取消预览不删除。
4. 若结果不确定，先“重新核对已保存记录”，再选择同一请求的“恢复原清理”。恢复使用已保存CRL和原批准时刻，不替换证明；CRL后来到期不重做原批准，新清理仍须有效CRL。意图前旧键已丢失会拒绝，不能算清理成功。

新内部轮换记录v2与旧v1共存，数据库仍v3，材料v3、内部身份v1和日志v2/v3独立演进。精确状态与恢复规则见 [清理合同](../../contracts/tv-agent.md#已撤销旧密钥的受控清理)。不自动清理历史记录，不保证备份或Flash安全擦除；实际Android删除及进程恢复测试仅已编译，尚未端上运行。

## 代码边界

| 位置 | 职责 |
| --- | --- |
| `Document.kt` | 有界严格JSON、当前整数/字符串子集JCS与时间 |
| `DeviceAgent.kt` | 单设备会话、精确模型、命令消费和耐久回执 |
| `DeviceModelProfile.kt` | 两种内置逻辑模型、规范摘要及固定本机执行路径 |
| `DeviceJournal.kt` | 原报文/结果校验、日志v1/v2/v3及保留记录的单向迁移 |
| `DeviceTls.kt` | 独立设备CA、证书用途/身份和密钥匹配 |
| `DeviceSigningKey.kt` | EC持钥验证、P-256公开CSR、限定轮换证明与客户端KeyManager，不读取私钥编码 |
| `DeviceRotationReceipt.kt` / `LocalRotationRecord.kt` | 严格原管理回执、独立轮换历史与耐久激活证明，保留原请求并校验当前身份 |
| `DeviceRevocationProof.kt` / `KeyRetirementRecord.kt` | 固定CA的严格CRL校验及原清理意图/批准时刻恢复，不凭管理JSON删除 |
| `AndroidIdentityKeys.kt` | AndroidKeyStore明确创建/读取及核对公钥后的受控删除，由耐久原意图控制；不提供自动缺钥补建 |
| `DeviceEnrollment.kt` | 严格本机材料、身份摘要与Broker地址校验 |
| `DeviceIdentitySetup.kt` / `LocalIdentityRecord.kt` | 公开配置、耐久原请求与指纹恢复；本机引用不由外部文件提供 |
| `DeviceMqtt.kt` / `VerifiedMqttTls.kt` | Paho传输、API23兼容TLS SPI、有界消息、重连与当前连接检查 |
| `DeviceAgentTest.kt` | 重复、未知、存储故障、撤权、期限及恢复 |
| `MqttJourneyTest.kt` | 根目录Node旅程驱动的独立JVM设备及文件硬件夹具 |
| `MqttJourneyMain.kt` | 测试专用Java入口，复用同一协议旅程及失败断言 |
| `app/AndroidAgentStore.kt` | Keystore加密及SQLite身份、授权与耐久记录 |
| `app/AndroidApplications.kt` | 当前授权、明确组件启动及单次运行许可 |
| `app/AgentRuntime.kt` / `AgentService.kt` | 单连接生命周期、可见服务与停止 |
| `app/TelevisionActivity.kt` | 遥控器可操作的材料确认、连接、授权及诊断 |

Android通过 `DeviceStorage`、`ApplicationPort`、`DeviceClock` 接入设备核心；应用端口只依赖当前授权函数，便于独立检查系统API。没有复制网关模型或命令状态机，也没有增加通用Android设备SDK或插件宿主。宿主API23启动检查不覆盖该系统的SQLite/Keystore实际运行；存储故障使用支持的原生SQLite沙箱，最终范围见24。

## APK离线预检

现有工具比较两个固定APK，检查包名、单签名证书、版本递增、目标API与打包ABI；不连接电视或执行安装。需要Python3、JDK21与已安装的Android build-tools 36.0.0，确保apksigner可找到JDK。SHA-256参数均为64位小写十六进制，不带sha256前缀；基线/候选整包摘要与签名证书指纹须从独立可信资料核对，不能只对未知下载现场算摘要便视为已批准。

```sh
python3 "tools/tv-agent-apk.py" \
  --build-tools "$ANDROID_HOME/build-tools/36.0.0" \
  --baseline "/private/approved-old.apk" --baseline-sha256 "<基线整包摘要>" \
  --candidate "/private/approved-new.apk" --candidate-sha256 "<候选整包摘要>" \
  --signer-sha256 "<签名证书DER摘要>" \
  --device-api 23 --device-abi armeabi-v7a --device-abi armeabi
npm run test:tv-agent:apk
```

示例占位值必须替换。普通调用默认拒绝调试候选；仅受控开发样本额外传`--allow-debug`，不放行testOnly或其他错误。包名固定run.limeai.iot.television；暂不支持split、共享UID、证书轮换、多签名或降级，也不自动接受额外系统库/硬件要求。输出会列出新增权限；offline_checks_passed始终保留installation_authorized/device_state_verified/storage_compatibility_verified=false。ABI是打包目录检查，非ELF加载或设备运行证明。

专项入口使用官方工具生成真实签名的隔离测试APK，核对篡改、错误签名、API23的v2-only拒绝、API/ABI、版本、拆分依赖及进程预算；没有ADB或模拟器前提。工具路径可用LIMEIOT_ANDROID_BUILD_TOOLS和LIMEIOT_ANDROID_PLATFORM_JAR指定；默认复用ANDROID_HOME或本仓库开发SDK。13项及隔离TV Agent版本码3→4候选包的离线结果见 [24第4.52节](../../docs/24-实施计划与进度.md#452-tv-agent-apk离线预检与签名制品验证)，输出边界见 [合同](../../contracts/tv-agent.md#apk离线预检)。版本4仅为测试构建覆盖，根工程版本保持0.3.0/3；没有安装到电视或发布。

## APK安装账本基础

`core/ApkInstallJournal.kt`保存原请求及创建/提交前意图，`app/AndroidApkInstallStore.kt`用独立私有`tv-apk-install.db`进行原字节CAS与FULL同步事务；身份库tv-agent.db及其v3格式保持独立。重复请求、存储冲突/丢返回、未知创建/提交与系统结果均保留原记录，查询或重开不调用系统安装。最多128条历史/1MiB，达到上限拒绝，不清旧记录。

本阶段没有PackageInstaller实现、界面入口或运行门禁接线。创建/提交与资格核对端口在测试中为显式夹具，系统回执也由夹具注入；不能据此报告实际安装、当前包核对、用户确认或健康。系统“已安装”只保存installed_unverified并继续阻止新更新，后续仍需身份/授权/完整原日志和健康接受流程。

验证沿用已有`npm run test:tv-agent:android`入口，或在已配置JDK21/SDK36环境执行下列完整Gradle任务；命令不连接ADB、电视或模拟器：

```sh
sh "apps/android/gradlew" --no-daemon -p "apps/tv-agent" \
  :core:test :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

专用12项核心与7项原生SQLite宿主检查分别覆盖耐久意图、12种提交前/后故障、CAS冲突、创建丢返回、未知提交、待用户状态/重复结果、重开与独立身份库不变。实际结果见 [24第4.53节](../../docs/24-实施计划与进度.md#453-apk安装原任务账本与sqlite恢复基础)，字段和阶段语义见 [合同](../../contracts/tv-agent.md#apk安装任务账本)。宿主SQLite与错误处理不证明AndroidKeyStore、系统安装器、Flash掉电或真实电视更新。

## Android安装会话适配层

后续新增`AndroidApkInstaller`与`AndroidApkSessions`，以PackageInstaller完成固定原会话的写入/fsync/完整读回/提交，并通过非导出的`ApkInstallResultReceiver`保存原结果。创建/提交前强制调用资格端口；API23从系统保存的原标签核对声明长度，API27起额外核对getSize，实际字节始终读回。API31起要求用户动作及显式可变广播PendingIntent；不自动弹确认界面、不重建部分会话、不重发未知提交。

AgentRuntime在新建连接许可前拒绝未决/待验证更新或不可读的更新库。产品更新入口、安装来源授权界面、预检来源验证、停止已有连接与在途门禁、系统确认交互、完整连续性和健康接受仍待接入，不能绕过这些前提直接使用空资格回调。软件测试继续使用上方Gradle任务，平台参数、字节端口夹具及回执投递的精确结果见 [24第4.54节](../../docs/24-实施计划与进度.md#454-android安装会话与私有回执软件适配)与[合同](../../contracts/tv-agent.md#android安装会话与私有回执适配层)。这些代码没有安装或连接电视。

## 当前安装包基线核对

AndroidApkInstaller已默认使用AndroidInstalledApk，在创建、暂存及提交关键边界核对系统当前自身包、UID、完整版本码、唯一DER签名与实际基础包SHA-256。API23走旧签名接口，API28起必须有现代签名信息；shared UID、split、多签/轮换、版本高位、错摘要、包读取前后变化均拒绝。逐块资格检查不重复扫描整包，未知提交查询保持只读。实现和文件系统信任边界见[合同](../../contracts/tv-agent.md#当前已安装apk的基线核对)。

新增12个测试方法在API23/28/31共执行16项通过，全部核心/App共149通过/5项既有跳过，Debug APK与lint通过；离线lint为0错误/4既有警告，没有新增警告，原两条依赖新版本提示未在离线运行发出。测试读取真实宿主文件，包/签名元数据、安装会话和完整运行资格仍是明确夹具，文件并非系统实际已装APK。结果见 [24第4.55节](../../docs/24-实施计划与进度.md#455-当前安装包基线核对与提供方接入)；冻结APK未安装，电视保持暂停。

该层不验证预检/连续性材料的可信来源，不完成来源授权界面、停止已有连接/在途门禁或健康接受；产品仍无更新入口。当前包软件核验不能代替实际电视核验或更新后的记录/KeyStore连续性。

## 安装来源与系统策略门禁

AndroidApkInstaller已默认组合AndroidApkInstallPolicy：清单声明与实际来源授权分别核对，API23–25读Secure未知来源开关，API26起读按应用来源授权，各版本核对用户/管理员限制，API29起另验全局未知来源限制。逐块和关键边界失权即阻断，不改设置、不自动重试原提交。可供用户主动打开的系统设置Intent只构造和核对目标，不自动弹出；产品更新页面尚未接入。精确行为见[合同](../../contracts/tv-agent.md#安装来源授权与系统策略)。

新增11方法/19次宿主执行通过，全部核心/App共168通过/5项既有跳过，Debug APK和lint通过（0错误/4既有警告、无新增警告）。设置/限制/解析器为Robolectric夹具，没有修改宿主或电视设置，没有启动设置页或模拟器。AOSP参考、失败修复和冻结证据见 [24第4.56节](../../docs/24-实施计划与进度.md#456-安装来源授权与系统策略门禁)；实际厂商安装和完整更新验收继续独立。

## 更新前停止与运行Owner

AgentRuntime的内部更新入口已组合原提供方与独立更新库，要求旧运行线程实际退出并清理后才能开始；stop已撤销许可但线程尚未退出时继续拒绝。提供方/回执/启动统一Owner→运行锁顺序，新连接tryLock立即拒绝忙Owner，已有连接的重复开始仍不结束当前服务。原未决账本继续阻断重连，失败/取消不会自动重连。原记录摘要已由下方独立连续性门禁接入，可信预检材料和产品交互仍待补齐，见[合同](../../contracts/tv-agent.md#更新期间的运行owner与停止边界)。

新增5项宿主Runtime检查通过，全部核心/App共173通过/5项既有跳过，Debug APK及lint通过（0错误/4既有警告，无新增）。线程、队列与SQLite实际运行，连接端口明确为夹具；没有MQTT网络、实机安装或完整在途记录验收。证据和静态复核后的复验见 [24第4.57节](../../docs/24-实施计划与进度.md#457-运行owner与更新前线程退出门禁)，电视继续暂停。

## 更新前原记录摘要

新增只读DeviceJournalInspection与Android原库连续性摘要，覆盖合法confirmed/failed/unknown/未决日志及序号上界、原身份请求、授权、全部轮换/原清理决定和实际键状态。Runtime在原队列/Owner内读取，在安装关键边界强制匹配原计划；状态变化拒绝效果，旧键按原清理决定缺席无需补建。原始字节、未知状态和原批准时间均保留，规则见[合同](../../contracts/tv-agent.md#更新前原记录连续性摘要)。

新增15项宿主执行通过；核心45过/3跳、App143过/2跳，Debug APK/lint通过（0错误/4既有警告）。精确文件字节断言覆盖已打开库内的只读事务，重开另以完整业务行摘要核对；既有helper打开会改变SQLite文件头计数，不承诺物理文件完全不变。测试使用宿主SQLite/EC及显式Vault、安装器夹具，没有实际AndroidKeyStore、网络连接或APK安装。证据见 [24第4.58节](../../docs/24-实施计划与进度.md#458-更新前原记录连续性摘要与边界核对)；后续签名材料接入见下节；产品更新及安装后健康仍待交付。

## 签名预检材料

原离线预检可另输出由同一APK签名身份认证的JAR，将下列选项追加到原命令：

```sh
--signed-output "/path/to/preflight.jar" \
--signing-java-home "/path/to/jdk" \
--keystore "/private/release.p12" --key-alias "release" \
--store-pass-env LIMEIOT_APK_STORE_PASSWORD \
--key-pass-env LIMEIOT_APK_KEY_PASSWORD
```

口令由部署者独立提供给相应环境变量，参数只传变量名；私钥不导出，已有输出不覆盖。默认SHA256withRSA，EC使用signature-algorithm=SHA256withECDSA。原JSON仍不授予安装或存储兼容资格。完整封装、用途和限制见[合同](../../contracts/tv-agent.md#签名预检材料与当前apk信任锚)。

新增VerifiedApkPreflight/AndroidApkMaterials及Runtime签名材料入口：从系统当前自身签名取信任锚，核对实际基线、签名报告与候选字节，再结合原库摘要准备原计划；API/ABI、权限差异和本地开发包批准分别核对。完整验签/摘要在效果边界执行，未知提交查询不要求文件仍存在。原回调入口只用于故障注入，产品应走文件材料入口。

核心45过/3跳、App154过/2跳、Python15项通过；新增8方法/13次执行通过，另有2条真实SDK→签名包→最终JVM验签链。APK/lint通过（0错误/4既有警告）。宿主App测试中的APK字节和系统签名元数据是明确夹具；另行SDK链使用真实隔离签名APK，均不冒称实际Android验签或安装。结果见 [24第4.59节](../../docs/24-实施计划与进度.md#459-签名预检材料与实际候选来源接入)。本机导入/保留与权限审阅见下节；系统确认恢复、真实安装和健康继续待交付。

## 本机更新材料与批准

设备页面选择“更新材料与批准”，停止连接后通过系统文件选择器依次导入同次发布的preflight.jar和APK。私有副本不参与备份，重启保留原申请；可核对版本、签名、整包摘要及新增/移除权限。开发包须另行勾选明确允许。批准会重新核对完整材料与当前原记录，并保存尚未开始安装的计划；原计划阻止连接，可明确取消以手动恢复连接。

未批准导入可明确丢弃，已进入账本的材料和历史保留；失败part不覆盖。单报告1MiB、APK256MiB、合计512MiB、最多128项，容量满时拒绝新增，不自动淘汰历史。页面后台完成不弹文件选择或确认框；副本异常仍可查看原计划、取消尚未开始的计划。

4.60阶段交付导入、审阅、保存及取消计划；后续原安装与系统来源/确认交互见下节。实际安装和更新后完整健康仍待验证，没有访问电视或启动模拟器。核心45过/3跳、App167过/2跳，新增7方法/13次执行通过，APK/lint通过（0错误/4既有警告）。宿主Views/文件/SQLite与实际电视交互分开，详见[合同](../../contracts/tv-agent.md#本机更新材料导入与可见批准)及[24第4.60节](../../docs/24-实施计划与进度.md#460-电视更新材料持久导入与可见批准)。

## 继续原系统安装

已保存计划可以选择“核对安装来源设置”，在系统允许后返回，再明确“核对并继续原安装”。页面再次展示原申请、版本/签名/摘要/权限变化，开发包须重新明确允许；Runtime沿原计划暂存、读回并提交一次。离开页面立即使本次前台许可失效，回来不会自动继续。只有系统回执改变安装结果，设置或确认页面的返回码只触发刷新。

收到合法待确认回执后，可明确“核对并打开原系统确认”。入口仅在进程内保留，每次重验原材料/连续性、来源、自有原会话和系统组件；后台回执只刷新记录。进程丢失临时入口时保留原任务，不使用重新提交或隐藏action补取。创建未知只查询原自有会话；提交未知与系统成功待验继续占用。真实系统安装、厂商交互及安装后完整健康仍待设备验证。

本阶段核心45过/3跳、App185过/2跳，新增9方法/18次宿主执行通过，Debug APK/lint通过（0错误/4既有警告）。系统会话/来源/确认均为明确夹具，没有安装或访问电视，见[合同](../../contracts/tv-agent.md#原安装任务与系统确认交互)及[24第4.61节](../../docs/24-实施计划与进度.md#461-原安装任务推进与系统确认交互)。

## 安装后本机健康核对与明确接受

系统成功后重新打开更新后的Agent，在原更新记录选择“核对更新后状态”，审阅后明确“接受本机健康”。核对实际候选整包、编译版本/加载路径、原身份/授权/命令/键及当前有效凭据；接受时完整重验。接受后仅允许手动连接，没有自动重连或命令重放。原提交未知仍阻断，不能借重新安装补取成功。

APK账本写v2、读v1/v2，SQLite与身份库结构不变；旧程序拒绝v2。核心50过/3跳、App201过/2跳，合计251过/5跳，新增13方法/21次执行通过，Debug APK与lint通过（0错误/4既有警告）。系统包/加载路径为宿主夹具，宿主EC持钥不等于AndroidKeyStore；实际安装和跨更新完整控制旅程仍待验，未访问电视。详见[合同](../../contracts/tv-agent.md#安装后本机健康核对与明确接受)、[阶段4.62](../../docs/24-实施计划与进度.md#462-安装后本机健康核对与明确接受)及[证据](../../docs/evidence/2026-11-03-tv-apk-health.json)。
