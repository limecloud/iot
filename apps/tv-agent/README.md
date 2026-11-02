# 电视设备 Agent

本目录独立于手机控制端 `apps/android`，包含设备 JVM 核心与独立 Android 电视应用。本机能力仅有应用启动，可选择独立应用模型或显式组合所用的遥控逻辑模型；使用设备 MQTT 5/mTLS、会话/期限、耐久尝试与回执，以及当前本机授权。应用提供设备材料核对、Keystore 加密、私有 SQLite、Leanback 启动入口与可见连接服务；源码、构建、宿主沙箱和真实电视验收分别记录。

正式边界见 [设备核心合同](../../contracts/tv-agent.md) 与 [回执确认合同](../../contracts/command-receipts.md)，角色、路径与权限见 [电视设计](../../docs/34-电视终端与AndroidTV接入.md)。当前0.3.0受控模型/日志迁移实现及真实JVM组合未通过项见 [24第4.15节](../../docs/24-实施计划与进度.md#415-tv-agent模型配置与日志迁移文档同步)；0.2.0日志回收、宿主与隔离协议结果保留于 [第4.13节](../../docs/24-实施计划与进度.md#413-电视命令回执确认与安全回收)，不扩展为当前源码最终通过。

## 构建与验证

需要 JDK21；协议旅程另需仓库 Rust/Node 工具、OpenSSL 和测试 Broker，Android 任务需 Android SDK 36/build-tools 36.0.0 并设置 `ANDROID_HOME`。复用手机工程现有 Gradle wrapper，两个工程分别配置和构建，不依赖手机核心库：

```sh
sh "apps/android/gradlew" --no-daemon -p "apps/tv-agent" :core:test
npm run test:tv-agent
npm run test:tv-agent:android
```

第一条执行设备核心单元检查；需要独立环境的 `MqttJourneyTest` 会明确跳过。第二条构建Rust、执行JVM检查，再串行运行原回收旅程及新增真实JVM/假ADB组合旅程，各自创建独立CA/Broker/网关与JVM进程；后者当前在compose后等待两动作可用时失败，后续副作用与恢复断言尚未通过。第三条运行Android宿主沙箱、构建调试APK并执行lint；Robolectric的SDK/原生测试库首次会下载。它们均不连接真实电视或读写用户数据库。请顺序运行同一Gradle工程的任务。

`core` 和 `app` 输出 Java 8 字节码，使用 Kotlin、Jackson流式解析、Paho MQTT5和OkHttp主机校验；依赖在各模块独立锁定。APK 位于 `app/build/outputs/apk/debug/app-debug.apk`，包名 `run.limeai.iot.television`，minSdk=23、targetSdk=36、versionCode=3/versionName=0.3.0。这是调试构建；真实Keystore/TLS、系统运行政策和指定电视仍需端上验收。

## 本机导入与运行

已有网关应用模型设备跨到内置遥控模型的完整绑定路线尚未验证；本机材料/日志迁移不会更改网关绑定。下述组合配置用于已经准备相同逻辑模型的设备，不通过修改config_hash、用户数据库或放宽模型发布规则接管旧设备。

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

## 代码边界

| 位置 | 职责 |
| --- | --- |
| `Document.kt` | 有界严格JSON、当前整数/字符串子集JCS与时间 |
| `DeviceAgent.kt` | 单设备会话、精确模型、命令消费和耐久回执 |
| `DeviceModelProfile.kt` | 两种内置逻辑模型、规范摘要及固定本机执行路径 |
| `DeviceJournal.kt` | 原报文/结果校验、日志v1/v2/v3及保留记录的单向迁移 |
| `DeviceTls.kt` | 独立设备CA、证书用途/身份和密钥匹配 |
| `DeviceEnrollment.kt` | 严格本机材料、身份摘要与Broker地址校验 |
| `DeviceMqtt.kt` | Paho传输、有界消息、重连与当前连接检查 |
| `DeviceAgentTest.kt` | 重复、未知、存储故障、撤权、期限及恢复 |
| `MqttJourneyTest.kt` | 根目录Node旅程驱动的独立JVM设备及文件硬件夹具 |
| `app/AndroidAgentStore.kt` | Keystore加密及SQLite身份、授权与耐久记录 |
| `app/AndroidApplications.kt` | 当前授权、明确组件启动及单次运行许可 |
| `app/AgentRuntime.kt` / `AgentService.kt` | 单连接生命周期、可见服务与停止 |
| `app/TelevisionActivity.kt` | 遥控器可操作的材料确认、连接、授权及诊断 |

Android通过 `DeviceStorage`、`ApplicationPort`、`DeviceClock` 接入设备核心；应用端口只依赖当前授权函数，便于独立检查系统API。没有复制网关模型或命令状态机，也没有增加通用Android设备SDK或插件宿主。宿主API23启动检查不覆盖该系统的SQLite/Keystore实际运行；存储故障使用支持的原生SQLite沙箱，最终范围见24。
