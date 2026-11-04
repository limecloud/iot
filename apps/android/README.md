# Android 原生客户端

本地“自动化 → 使用组合包”支持触摸伴读灯、自定义JSON、逐模块绑定、60秒预演和明确启用。`CompositionClient`复用原网关会话与安全存储接口，先保存并回读完整原请求再单次条件创建；丢回执保持attempted，重启只查询，停用沿原自动化列表。后台、离页、离线、输入或相关设备变化清除证明。`npm run test:composition:native`检查共享向量、实际CompositionController及真实网关跨进程恢复；宿主文件存储、Debug APK与lint不代表Keystore或完整Compose运行。详见[组合包合同](../../contracts/composition.md#原生客户端)。

本地“设置 → 音频 → 陪伴”支持自定义角色说明、实际声音和逐轮录音，默认四轮、十分钟。`CompanionClient`与`#companion:space_id`摘要账本复用原三阶段；后台/离页/离线清除内存历史，返回只GET，停止无需正文并清各轮文字。生成音频仍须独立授权播放。入口`npm run test:companion:native`检查共享账本、实际状态层及真实网关跨进程恢复，见[原生合同](../../contracts/companion.md#原生客户端)。完整原生页面、生产安全存储与真实模型质量独立验收，实机跳过。

“设置 → AI 服务”展示当前五类能力、实际模型、部署修订和限制；“已配置，健康未检测”不表示模型可用。已配置条目可进入原自动化、对话、视觉或音频页面，仍需明确调用。后台、离页、离线或会话变化会清除目录，迟到响应不恢复旧入口；查询不创建推理任务，不持久保存目录。SDK使用`gateway.aiCatalog("space-demo")`，严格合同见[AI目录](../../contracts/ai-catalog.md)。统一检查入口为`npm run test:ai-catalog:native`；宿主状态层、APK与lint检查不替代完整Compose应用或Keystore运行。

普通控制在发送前保存并回读完整原输入；`GatewayClient.create`及`resolve(space,intent)`核对空间、键、设备、模型、期限和操作，confirmed另核对属性或动作证据。错误回执不清除原请求；SDK校验摘要格式，正式JCS摘要由Rust负责。`CommandRecoveryTest`消费`tests/fixtures/commands/recovery.json`的30组共享向量，属于JVM宿主检查；APK/lint不代表Keystore故障或完整Compose运行验收。

仓库根目录执行`node tools/test-home-native-state.mjs android`，运行实际HomeViewModel的六组宿主旅程及云状态回归，并构建Debug APK和执行lint。旅程覆盖存储抛错/未真正保存时零POST、错误回执与404保留原字节、状态重建/退出后恢复、清理未保存及503离线禁写。家庭入口沿用云入口的ViewModel工厂方式，注入既有SessionStore、GatewayTransport和地址偏好回调；生产使用Keystore，在连接时创建OkHttp传输实例。测试不启动模拟器，不代表生产Keystore或Compose端上运行。

静态配置的Zigbee开关复用家庭设备页现有电源控件与GatewayClient，不增加协议专用UI。`npm run test:zigbee:onoff-native`使用真实Rust/SQLite和软件NCP，检查Swift/Kotlin客户端库的完整读回证据、丢响应原键查询、客户端进程及网关重启零补发；宿主库联调与完整App运行分别验收。配置与范围见[属性桥接合同](../../contracts/property-bridges.md)。

## Zigbee 来源接入

同页的“Zigbee 入网”支持选择协调器、填写1–120秒时长，核对IEEE后明确开放；关闭独立确认。ZigbeeClient使用`origin#zigbee-operations`保存并回读原请求，未知只查询原键，禁止换键延长未知窗口。已完成回执不可变化；后台、离页、离线或60秒过期清除核对，准备与取消零POST。共享合同与运行边界见[入网管理合同](../../contracts/zigbee-operations.md#原生客户端)。

本地“设置 → Zigbee 设备”支持选择已配置的协调器，发现已有邻居、读取端点，再查询支持的温湿度端点，核对厂商/型号后明确添加；也保留已知 IEEE/端点和设备编号的手填入口。发现和端点只在内存保留最长 60 秒，过期、输入/来源变化或暂停后清除，不创建设备或保存原请求。托管来源可先读取当前绑定再确认撤销；重新接入重新查询候选。配置接入的静态来源只展示，不接管或迁移。

`ObservationClient(gateway, store)`复用当前HTTPS会话与Keystore适配器，独立`origin#observation-operations`最多保留128条完整原请求。保存并回读成功才POST；同键仅GET，未知同设备/来源阻止换键和换编号。后台、离线、离页、输入/模型/来源变化和60秒到期清除核对；状态层取消在途任务，迟到结果不恢复页面。原请求查询不会重新启用已撤销来源。

仓库根目录执行`node tools/test-observation-native.mjs android`，检查合同、实际ObservationController、相关回归、Debug APK和lint；完整组合旅程为`npm run test:zigbee:native`，需要Swift、JDK21和Android SDK。同一Gradle工程串行运行。详情见[来源合同](../../contracts/observation-sources.md#原生客户端接入与恢复)。宿主恢复文件为夹具，不代表Keystore或Compose实际页面运行；既有完整应用启动ANR缺口保留，实机按用户要求跳过。

## 本地音频客户端库

`MediaClient(gateway, store)`使用现有NAS所有者会话与必填`SessionStore`，提供`list`、`submit`、`records`和`resolve`。`MediaChanges.upload(bytes, retainSeconds)`接受最多4MiB、60秒的16位PCM WAV；`grant`需要当前执行绑定修订，`revoke`与`delete`分别撤销授权和删除正文。接口只消费媒体ID与状态，不取得下载URL或令牌，上传/授权不自动播放。

首次POST前在`origin#media-operations`保存并回读摘要原记录，最多128项；不保存音频正文。同键同参只查询原键，404仍未知，同类未决操作阻止换键重发。跨实例共用Mutex，损坏/移除/无法保存的记录阻止新写。历史授权回执的`issued_in_process`可随网关重启变化，库核对其余原决定；当前资格以列表和网关执行时检查为准。媒体与OTA复用有界安全整数JSON解析/规范化工具，分别校验领域合同。

家庭网关“设置 → 音频”提供OpenDocument文件选择、保留时间、当前已绑定音箱、明确授权、撤销、删除确认和原操作查询。IO调度器有界读取最多4MiB+1字节，不申请广泛文件权限、不保留URI权限或正文；离开页面、后台和断线清除临时文件与确认。`targets`读取并核对当前执行绑定，兼容候选不自动授权；播放仍由设备页另行操作。云入口不增加媒体权限。

仓库根目录`npm run test:media:native`检查库；`npm run test:media:native:state`运行实际`MediaController`、有界读取器与真实Rust/SQLite/MQTT及软件音箱，覆盖本地无副作用、确认失效、取消保存后零POST、离线禁写、401、丢回执和进程/网关重启恢复。需要JDK21、Android SDK和Swift。恢复文件为宿主夹具，不代表Android Keystore、系统文件选择器或Compose运行；既有模拟器ANR状态保留，实机按用户要求跳过。

## 有限麦克风录音

“设置 → 音频 → 上传音频”支持明确开始、完成和取消录音。系统权限批准后由独立`AndroidRecordingInput`读取AudioRecord，`RecordingController`只管理本机采音；`PcmRecording`输出16 kHz单声道PCM16 WAV，最多60秒、960000帧，不补静音。完成后先关闭麦克风，再将内存文件交给`MediaController`；另行点击上传，不自动调用模型或播放。后台、离页、断线、取消或设备中断停止采音并清除未上传录音，迟到权限与回调不恢复旧状态。仅申请运行时麦克风权限，没有后台录音服务。

根目录`node tools/test-recording-native.mjs android`检查实际状态层、独立Java Sound解码、与JS逐字节一致、既有媒体回归及APK/lint；完整`npm run test:recording:native`另查两端真实Rust/SQLite上传、丢HTTP回执及新进程/网关重启只GET原键。采音与私有恢复文件为宿主夹具，不代表AudioRecord、Keystore或完整Compose运行，既有App启动ANR继续保留。同页分步组合见下段，统一回合见下方新增入口；实机按要求跳过。正式边界见[原生录音合同](../../contracts/voice-turns.md#原生有限录音)。

在同页识别录音后，点击“带入新对话”，核对问题后“发送”；回答通过“带入语音合成”填入完整文本，再明确“生成音频”。两处带入只改当前内存草稿，不发请求；提问使用新对话上下文，超长回答不截断，未决或离线时不替换输入。合成成功后继续独立授权并在设备页播放。后台/离页清文，新进程查询各原键，不自动推进或重播。检查入口`npm run test:voice-handoff:native`，正式边界见[原生分步组合](../../contracts/voice-turns.md#原生分步组合)。

“设置 → 音频 → 语音对话”另提供统一回合：选择已上传录音和声音，明确开始后依次调用ASR、文字与TTS；原任务共用v1摘要账本和5分钟期限。后台、离页或断网取消推进并清文，返回后查询原回合，明确继续才创建未创建阶段；停止需要确认，丢回执后只GET。生成音频须另行选择、授权和播放。SDK为`VoiceTurnClient`，检查入口`npm run test:voice-turns:native`，详见[原生统一回合](../../contracts/voice-turns.md#原生统一回合)。完整App、系统采音和真实模型质量保持独立验收。

## 本地文字转语音库

`SpeechClient(gateway, store)`复用NAS会话，提供`capabilities`、`submit`、`records`、`resolve`和`discard`。`SpeechRequests.input`校验输入，并将时间规范为UTC毫秒。独立`origin#speech-syntheses`最多保存128条摘要记录，每条最多8个明确放弃意图；不保存文本。首次提交和新放弃意图均先保存并回读，同键仅GET，结果未知继续阻止换键生成；跨实例共用Mutex，取消后不补发。响应必须匹配原摘要，部署与任务身份不得漂移，终态不得回退。

根目录`npm run test:speech:native:contract`执行共享JS/Schema、Swift 10组及`SpeechClientTest`的Kotlin 10项宿主检查，需要Swift和JDK21。保存调用取消或丢失确认后，同一客户端只接受上次观测或自己预期写入的完整字节，其他变化仍拒绝；恢复查询不会重新POST。

“设置 → 音频 → 文字转语音”已接入`SpeechController`和Compose：生成、自动查询running、原键恢复及明确确认放弃；成功刷新并选中对应媒体，授权保持未勾选。进入后台、离开页面、离线或会话失效时清除文本和确认，取消旧代次，迟到结果不更新页面；前台恢复只查询。

`npm run test:speech:native:state`执行7项语音状态检查、既有媒体/OTA回归、Debug APK/lint及两端实际Rust/SQLite/MQTT旅程。每端覆盖真实HTTP丢回执、独立授权播放、四次原生宿主进程和两次网关重启、unknown占用与明确放弃；提供方、音箱与恢复文件为夹具。Android Keystore、完整Compose运行和实际发声仍待验收，既有端上环境阻塞保留。

## 本地语音识别

“设置 → 音频 → 语音识别”接入 `TranscriptionController` 与 Compose。先上传音频，读取识别状态，明确选择音频和语言后开始。running自动查询，unknown保持占用，放弃须确认。后台、离开、断线或会话失效清除正文与确认；输出或源录音到期后清除正文，迟到响应不更新旧页面。

`TranscriptionClient(gateway, store)` 使用原NAS会话，`TranscriptionRequests.input(mediaId, mediaDigest, language, expiresAt)` 固定媒体摘要和UTC毫秒期限。必填安全存储的 `origin#audio-transcriptions` 最多128条原记录及每条8个放弃意图。`observation` 明确省略 `output.text`，`records` 只返回元数据，`submit/resolve` 当次返回可带易失文本。网络响应严格核对文本UTF-8摘要、标量/字节上限、保留期限及任务身份，已清除结果不得复活。

根目录 `npm run test:transcription:native:contract` 检查共享向量及两端库，`npm run test:transcription:native:state` 检查实际状态层、Debug APK/lint及真实网关恢复旅程。恢复文件和提供方为宿主夹具，不代表Keystore、Compose系统界面运行或识别质量；完整原生应用及新NAS整包独立验收，实机按用户要求跳过。

## 本地图片观察

`VisionClient(gateway, store)` 接入[正式视觉合同](../../contracts/vision.md)，`VisionRequests.input(bytes, contentType, prompt, retainSeconds, expiresAt)` 构造单张PNG/JPEG请求。图片最大2 MiB，问题最多512个Unicode码点；客户端检查大小、格式标记和问题，网关完成静态图片解码及1024像素边长校验。

本机 `origin#vision-observations` 只保存摘要、去正文观测与清除意图。原键重复只查询，unknown阻止换键；`discard` 可放弃未完成输出或清除成功正文，重复同一意图只GET。`records` 无正文，`submit/resolve` 当次返回可带文本，调用方须按期限及页面生命周期清除内存，不将结果用于自动控制。

“设置 → 图片观察”已接Compose页面与`VisionController`，使用OpenDocument选择PNG/JPEG，后台有界读取最多2 MiB并构造请求。提交后清图片与问题；后台、离线、离开、退出或会话切换清正文，迟到响应不回填。前台刷新只恢复元数据，成功正文需明确查询；放弃和清除均需确认，取消零POST。

`npm run test:vision:native:contract` 验证共享合同，`npm run test:vision:native` 验证JVM宿主库，`npm run test:vision:native:state` 验证实际状态层、真实网关恢复、共享文件读取、Debug APK和lint。系统选择器、Keystore及完整Android界面运行另验；提供方为夹具，真实模型质量独立验收。

## 环境读数

规则库支持与事件互斥的属性阈值触发、模型单位、上升/下降及滞回；严格触发解码不受宽松模型读取配置影响。`simulate`在属性规则下接收包含previous/current两份观测的JSON对象，预演不修改运行基线或创建设备命令。Compose可创建/编辑单操作阈值规则、完整展示及停用；`ThresholdEditor`按十进制解析常用单位，不截断超精度输入，并生成标记为simulation.ui的预演采样。`RuleTriggerTest`包含合同、表单和可选真实HTTP检查，根目录入口为`npm run test:rules:thresholds`。Debug APK与lint不代表Android端上运行，既有启动ANR阻塞保留。

`:core`兼容可选的`semantic_id`/`unit`，按正式环境模型显示温度和相对湿度，两位小数；旧属性继续按原值显示。NAS及云设备页面将只读属性显示为文本，过期样本保留原值并标明“已过期”。

`EnvironmentPropertyTest`检查元数据、单位、负值、零值和旧属性。根目录`node --test tests/environment-node.test.mjs`通过独立Broker/Rust/SQLite链路执行Kotlin实际HTTP读取；需Swift、JDK21及Android SDK。Debug构建、单测和lint与Android端上运行分别验收；既有模拟器启动阻塞仍保留，实机按用户要求跳过。

## 应用结构

使用 Kotlin、Jetpack Compose 和 Android Keystore，最低 Android 8/API 26，编译和目标 API 36。`:core` 是不依赖 Android SDK 的类型化客户端，`:app` 是原生 Android 应用。没有 WebView 或跨平台 UI 框架。

应用提供家庭网关与云服务两类入口。NAS入口支持设备开关/亮度、状态和回执、事件/阈值规则预演/启用/停用、关联运行及退出；云入口支持独立授权、空间/设备与原操作。本地规则表单支持数值/布尔属性和模型动作，动作参数使用JSON，先预演再明确启用；单操作编辑保留完整比较/all/any条件树及毫秒冷却，多操作规则完整展示并可停用，编辑使用TUI或CLI/API。规则执行语义见[合同](../../contracts/rules.md)，宿主软件入口为`npm run test:rules:conditions:native`和`npm run test:rules:actions:native`，Compose运行与实机另验。

“仅当”通过Compose控件选择全部可read标量属性、比较方式和值，并添加/移除嵌套组合。ConditionEditor按模型单位精确解析、检查类型/值域和4层/32项限额，无损回填失败时禁止编辑原规则；取消不提交。GatewayClient先校验再预演，RuleProof核对两次修订、触发和完整条件/动作证据；当前条件未满足仍可明确启用等待新触发。执行记录显示原条件、观测及原因，不从当前状态重建历史。APK构建/lint与Compose端上运行分开记录，既有启动ANR阻塞保留。

自动化页支持“用一句话设置”：网关配置本地模型后生成草案，展示触发、全部动作、冷却和原文，预演通过后明确启用。生成前通过 Keystore 适配器保存原空间与幂等键，写入失败不发送；丢失响应或应用重启后查询原记录，不自动重发。修改需求清空预演证明；模型未配置仍可手工设置。推理模型配置见[NAS说明](../../deploy/nas/README.md)。

## 构建和连接

定时规则在“触发方式”选择“定时”，输入HH:MM、IANA时区与重复星期；支持单操作创建、完整回填、修改、取消和停用，毫秒冷却与条件树保持完整。GatewayClient从网关校验结果获取下一次发生时刻做预演，客户端不重复实现DST。软件入口为`npm run test:rules:schedules:native`；JVM宿主、Debug APK与lint和完整Compose端上运行分别验收，原端上环境阻塞保留。语义见[定时合同](../../contracts/rules.md#每周定时)。

NAS与云界面均按绑定模型解析动作，提供方向键、应用启动及通用参数控件；Schema 1空动作模型保留属性界面。按键限模型枚举，submitted只显示“输入已提交”；应用ID仍须执行端发现和授权白名单。动作与属性共用耐久原键、失联禁用和原操作查询，控件存在不表示真实电视适配已实现。

仓库根目录 `npm run test:actions:native` 用Swift/Kotlin宿主库、真实HTTP/MQTT与虚拟设备验证模型发现、遥控/应用启动、丢响应只查原键及完成范围，联合入口另需Swift。云属性/动作旅程使用 `npm run test:control:native`。结果和手机端上缺口见 [实施进度](../../docs/24-实施计划与进度.md)。

需要 JDK 21、Android SDK Platform 36 和 Build Tools 36.0.0。Android Studio 打开本目录，或者设置当前终端的 SDK 路径后执行：

```sh
sh "gradlew" :app:assembleDebug
```

调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。正式签名材料由使用者管理，仓库不包含私钥或发布凭据。

输入 NAS 的精确 HTTPS Origin，例如 `https://192.168.1.20:8443`，以及本地所有者凭据。使用本地 CA 时先在系统安装证书。客户端接受系统/用户受信 CA，验证证书与主机名，禁止明文网络和跨来源重定向。

会话通过 Android Keystore 中的 AES-GCM 密钥加密后存入应用私有存储，使用 Origin 绑定附加认证数据；不保存所有者原始凭据。Android 12以上的云备份与设备迁移通过显式规则排除应用数据，旧版禁用备份。控制前先耐久保存原幂等身份，本地写入失败时不发送。响应丢失、代理5xx或响应无法解析时保留身份，重新登录后仍查询原操作，不自动重发或离线排队。设备操作界面当前显示最近100条，完整分页合同由API/CLI提供。

NAS快照读取失败（包括HTTP 503）时保留上次观测，并禁用设备控制；只有再次成功读取快照后才恢复控制。进入后台停止页面轮询，回到前台重新读取。

启动图标沿用官网已有品牌包，提供自适应前景及兼容图标；素材的专有许可范围见 [品牌素材](../BRAND.md)，其余客户端代码遵循仓库代码许可。

## 云入口状态

Compose云入口已接入并构建进调试APK，手机运行待验收。在连接页选择“云服务”，输入Console的精确HTTPS origin；可以使用私有控制面地址。点击“登录”查看8位授权码，由“打开浏览器”进入同站Console，本人登录、输入码并明确批准。生命周期处于STARTED时每3秒查询，后台或离开云入口时取消轮询；网络/授权错误暂停查询，可继续查询或结束原登录。

Keystore适配器供NAS与云库复用，云记录使用独立的`limeiot.control:v1:<origin>`键。启动/返回前台时核实会话，未完成授权沿用原证明；503保留材料，可用“恢复会话”再次核实。取消成功才清理材料。登录后选择空间，读取当前有效网关、设备分页与物模型；当前合同每空间仅一个有效网关，设备页校验绑定修订。云界面提供可写属性的布尔/数值控件及模型动作，不调用NAS规则API。

独立`ControlClient`实现随机键/S256 PKCE、授权恢复、独立会话、取消/退出、空间/网关/设备分页/物模型及远程控制，正式行为见 [原生授权](../../contracts/control-native.md)。安全存储必填，身份Token不交给界面。

界面先明确调用`beginAuthorization()`取得仅供用户查看的授权码和同站`verificationUri`，由系统浏览器批准后调用`pollAuthorization()`。库先核对当前Console主体、CSRF与期限，再保存材料；界面只取得状态和主体，不持有Token。原请求保存失败不发送，响应丢失沿用原证明，503保留会话，401清理；`restoreSession()`核实原身份，`logout()`仅结束子会话。库不自动打开浏览器、后台轮询或写重试，同一实例操作由Mutex串行化。

远程控制按`prepareCommand`保存完整原请求，再由`submitCommand`先保存发送标记后单次提交。响应丢失、进程重启或同键再次提交均只查原操作，404也不补发；`resolveCommand(reconcile = true)`显式核实原设备结果。记录绑定当前主体/空间，最多128条，退出后保留；`forgetCommand`允许明确放弃未尝试且无结果/拒绝的准备记录，或清理明确拒绝/终态。已尝试而结果未知的记录不能清除。confirmed须有匹配原请求的设备证据；SDK检查摘要格式和连续性，Go/Rust负责正式规范化摘要。

CloudViewModel持有当前云任务，离开STARTED生命周期或云入口时同时取消按钮任务与轮询，异步返回后复查取消，迟到读取不恢复在线。准备存储期间暂停不会继续提交；恢复前台只读取原记录，未发送记录可明确放弃，已尝试记录继续查询。取消不能撤回已发出的网络请求。

`npm run test:control:native`已通过真实HTTPS/WSS、Go/MySQL、Rust网关、MQTT模拟设备、Chromium批准和私有文件存储夹具。两端分别验证未受信CA拒绝、会话恢复、远程响应丢失/Go重启后查询原操作、只创建一条设备命令及独立退出。报告标记`native_remote=true`、`transport=https`、`native_app=false`、`hardware=false`；测试专用CA适配器不改变生产信任。此证据属于库，新增Compose页面的系统浏览器打开、Keystore与前后台行为仍需在模拟器或手机验收。

## 结构和验证

| 路径 | 职责 |
| --- | --- |
| `core/` | Kotlin 合同、会话与 HTTPS 传输适配、网关任务 |
| `core/.../ControlClient.kt` | 独立控制面授权/会话、读取及远程原操作，不复用NAS身份 |
| `app/.../HomeViewModel.kt` | 生命周期、会话、快照和操作恢复 |
| `app/.../CloudViewModel.kt` | 云授权、空间/绑定投影和原操作状态 |
| `app/.../CloudViews.kt` | Compose云登录、设备、操作记录与设置 |
| `app/.../SecureStore.kt` | Android Keystore 存储适配 |
| `app/.../MainActivity.kt` | Compose 设备、规则、运行和设置界面 |

```sh
sh "gradlew" --configure-on-demand :core:test
```

纯 JVM 检查覆盖 HTTPS 地址、原幂等键、CSRF、所有者凭据隔离、控制/草案超时不重发与原草案查询。仓库根目录的 `npm run test:android` 额外启动独立网关、真实 Broker、模拟设备与假 Ollama 提供方，验证控制回执、草案幂等/无自动部署/预演/明确启用、规则生命周期、原操作查询及撤销。提供方检查不代表模型质量。

控制面包含4组授权、4组远程与3组动作JVM合同检查，覆盖原证明保存失败不发送、S256与响应丢失后原键恢复、非法材料/跨origin/主体拒绝、会话503保留/401清理及取消/独立退出，以及远程存储失败不发送、旧键只读、未发送明确放弃、拒绝/未知/终态清理和设备证据验证。另1项真实控制面检查由仓库根目录`npm run test:control:native`设置专用环境后运行，需要Go、Docker/MySQL8.4、Swift、JDK21与Chromium；普通`:core:test`不会据缺少该环境宣称真实联调已运行。

配置Android SDK与JDK21后，在仓库根目录执行`npm run test:clients:state -- android`，顺序运行core测试、5项`CloudViewModelTest`、调试APK构建与lint。状态测试注入内存存储/HTTP夹具，验证后台不轮询/取消恢复、未知操作重建与离线只读、绑定修订/空间隔离、准备存储期间暂停零提交与明确放弃、迟到刷新不恢复online；它不是Compose运行、Keystore或手机生命周期证据。未指定平台时该命令还执行Swift宿主状态检查，需要macOS与Swift工具链。

当前API36常规Debug、Release/R8构建与lint通过（0错误、17警告），两包不包含运行检查的测试CA或debug-overrides，Release未签名发布。请顺序执行同一Gradle工程的构建、lint与JVM检查，避免多个编译进程共写缓存。历史API36 ARM64的四项NAS运行通过，当前源码最新复验启动ANR未通过，见下节；用户安装CA、云系统浏览器、其他API和字体缩放仍待验收，手机真机按用户要求跳过。

## 本地固件升级

家庭网关“设置 → 固件升级”已接入独立 `OtaClient`、`FirmwareController` 与Compose页面。独立填写公钥指纹，再创建10分钟计划；读取当前任务后批准，重新读取后才可安装，unknown只开放原设备结果查询。云入口不增加升级权限。必填SecureStore使用 `origin#ota-operations`，与会话及云记录分开；完整原请求保存并回读后只POST一次，跨实例串行，损坏/移除拒绝，404保持未知，退出/重新登录保留原记录。

在根目录运行 `npm run test:ota:native` 验证两端库，`npm run test:ota:native:state` 先编译App测试目标，再运行实际FirmwareController与Swift状态层。需要macOS/Swift、JDK21、Android SDK及仓库内Broker。状态旅程使用真实Rust/SQLite/MQTT与内存存储替身，覆盖逐次核对、取消、批准不安装、丢响应/重启/重新登录、同设备未知阻止换键，以及原设备新启动证据。它不运行Compose、Keystore或模拟器；当前运行限制见下文，实机按用户要求跳过。

## Android 模拟器运行检查


`test:android:runtime` 使用独立AVD和ADB服务，在Android 16/API36的ARM64模拟器运行实际MainActivity、Compose页面、生产SecureStore和HTTP传输适配器。当前入口按macOS Apple Silicon环境配置，不连接现有手机或复用已有AVD。

在仓库根目录执行；JAVA_HOME指向已有JDK21，SDK及模拟器依赖放在项目.dev中：

```sh
export JAVA_HOME="/absolute/path/to/jdk-21/Contents/Home"
export ANDROID_HOME="$PWD/.dev/android-toolchain/sdk"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  --install "emulator" "system-images/android-36/google_apis/arm64-v8a"
npm run test:android:runtime
```

还需要已安装的Rust、Node.js24、Python/OpenSSL和项目内Broker；安装方法见 [固件宿主检查](../../firmware/README.md#宿主验证)。运行器构建当前Rust目标，然后顺序构建调试应用和测试APK；不要同时运行本工程其他Gradle任务。

检查覆盖实际Keystore加密、独立存储适配器重建、NAS/云存储键隔离、密文搬移/损坏拒绝；实际页面登录、一次设备控制、离线禁用、后台停止刷新、回到前台刷新，以及强制结束进程后的会话恢复、无登录/命令重放与退出清理。网关使用真实Rust/MQTT和灯/按钮模拟器，设备证据不代表硬件效果。

每次生成独立HTTPS CA，明确通过 `-Plimeiot.instrumentationResources=...` 只加入该次debug资源，并保留证书/主机名验证。正常调试构建未传该属性时不读取测试CA，release也不使用该资源目录；不修改生产network_security_config.xml。该证据不代表系统浏览器或用户安装CA已通过验收。

报告、仪器测试日志和页面截图保存在.dev/android-runtime-*，目录包含测试私钥和临时凭据，不加入Git。结束时关闭本次创建的模拟器、ADB和网关进程。iOS仍需完整Xcode/iOS SDK单独验证；实机按用户要求跳过，报告保持hardware=false。

2026-11-02完整运行通过：2项Keystore、1项NAS页面旅程、1项新进程恢复，登录与命令POST各1次。原始报告为 `.dev/android-runtime-0389d7a7-b432-4ab1-9d5d-f29708032ca3/report.json`，标记native_app_runtime=true、hardware=false。早期一次新进程崩溃没有根因证据，保留失败记录，不因后续通过而宣称修复。该运行后的状态栏图标外观修复、常规构建与CA隔离单独登记在 `.dev/android-runtime-report.json`；该索引不替代 [当前进度](../../docs/24-实施计划与进度.md)。

当前最终状态：状态栏外观修复与恢复页面在线/实际开关状态加强断言之后，`.dev/android-runtime-5cf6392a-d72c-4dc0-9722-a87d381da5ba/report.json` 在首个测试阶段启动ANR，未进入Keystore测试。退出记录为reason=6、failed to complete startup，根因未确认；按仓库重试上限停止循环。历史四项通过不覆盖当前运行与新增断言。独立常规Debug启动外观检查也未观察到登录页，未标通过；没有实机操作或发布。

## 本地文字对话

“设置 → 本地对话”使用 `TextGenerationController` 与 `TextGenerationClient(gateway, store)`，遵循[正式文字合同](../../contracts/text.md)。`TextGenerationRequests.input(messages, instructions, retainSeconds, expiresAt)` 构造有界上下文；成功回答后可在当前页面继续提问，最早回答期限约束整个上下文。

本机 `origin#text-generations` 仅保存原输入摘要、去正文观测和明确清除意图。进入后台、离页、离线、退出或期限经过时清除本页消息；回到前台读取元数据，完成回答须明确查询。原键只 GET，404 和 unknown 不允许换键重发；放弃输出须确认，不能保证外部模型停止计算。原请求尚无观测时保留 unresolved，不能自动删除。

运行 `npm run test:text:native:state` 检查实际状态层、Home 接入、Debug APK 和 lint；运行 `npm run test:text:native` 验证真实 Rust 网关与两端宿主进程恢复。宿主 HTTP 夹具与真实模型效果分开验收，完整 Android App 运行和 Keystore 仍独立验收。实机按要求跳过。
