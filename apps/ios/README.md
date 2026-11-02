# iOS 原生客户端

使用 Swift 6、SwiftUI 和 URLSession，最低 iOS 17。`LimeIoT.xcodeproj` 是可打开的 iPhone/iPad 应用工程，`Package.swift` 提供独立、可编译的 `LimeIoTKit` 客户端库。没有 WebView、跨平台 UI 框架或官网源码依赖。

应用提供家庭网关与云服务两类入口。NAS入口支持设备开关/亮度、状态和回执、事件规则预演/启用/停用、关联运行及退出；云入口支持独立授权、空间/设备与原操作。当前本地规则表单支持布尔属性联动；完整 DSL 可通过 API/CLI 使用已实现子集。

NAS与云界面均按绑定模型解析动作，提供遥控方向键、应用启动及通用参数控件；Schema 1空动作模型保留属性界面。记录显示原按键/应用ID及完成范围，submitted只显示“输入已提交”；动作沿用耐久原键，丢响应后只查询原操作。应用ID仍须执行端发现和授权白名单，控件存在不表示真实电视适配器或TV Agent已实现。

仓库根目录 `npm run test:actions:native` 分别运行Swift/Kotlin宿主库、真实HTTP/MQTT与虚拟设备，需要Swift、JDK21和Android构建工具。云属性/动作旅程使用 `npm run test:control:native`，每端每个旅程验证丢响应/重启后原键恢复。结果与手机端上缺口见 [实施进度](../../docs/24-实施计划与进度.md)。

自动化页支持“用一句话设置”：网关配置本地模型后生成草案，展示触发、全部动作、冷却和原文，预演通过后明确启用。生成前在 Keychain 只保存原空间与幂等键，写入失败不发送；丢失响应或应用重启后查询原记录，不自动重发。修改需求清空预演证明；模型未配置仍可手工设置。推理模型配置见[NAS说明](../../deploy/nas/README.md)。

## 构建和连接

使用 Xcode 16 或更新版本打开 `LimeIoT.xcodeproj`，选择 iOS 模拟器或自己的签名团队后运行。命令行构建：

```sh
xcodebuild -project "LimeIoT.xcodeproj" -scheme LimeIoT \
  -sdk iphonesimulator -configuration Debug \
  -derivedDataPath "../../.dev/ios-derived" CODE_SIGNING_ALLOWED=NO build
```

输入 NAS 的精确 HTTPS Origin，例如 `https://192.168.1.20:8443`，不附带路径或末尾斜杠，然后输入安装目录中的所有者凭据。使用本地 CA 时，先在设备/模拟器安装并启用信任。应用不绕过 TLS，不接受任意证书。

会话保存在 Keychain，所有者原始凭据不长期保存。会话恢复需网关再次验证；退出撤销服务器会话。重启网关后需重新登录。控制前保存原操作的幂等身份，本地写入失败时不发送。响应丢失、代理5xx或响应无法解析时保留身份，重新登录后仍查询原操作，不在断网时排队发送新控制。设备操作界面当前显示最近100条，完整分页合同由API/CLI提供。

NAS快照读取失败（包括HTTP 503）时保留上次观测，并禁用设备控制；只有再次成功读取快照后才恢复控制。该状态处理已在macOS宿主类型检查，iOS整包运行仍需完整Xcode与iOS SDK。

应用图标沿用官网已有品牌包；图标的专有许可范围见 [品牌素材](../BRAND.md)，其余客户端代码遵循仓库代码许可。

## 云入口状态

SwiftUI云入口已接入源码，仍需完整Xcode编译与手机验收。在连接页选择“云服务”，输入Console的精确HTTPS origin；它可以是私有控制面地址，不要求官方云已经发布。点击“登录”后显示8位授权码，再由“打开浏览器”进入同站Console，本人登录、输入码并明确批准。App前台每3秒查询，后台或离开云入口时取消轮询；网络/授权错误暂停轮询，使用“继续查询”或“结束本次登录”处理原请求。

Keychain适配器供NAS与云库复用，云记录使用独立的`limeiot.control:v1:<origin>`键。启动/返回前台时核实原会话，未完成授权沿用原证明；503保留材料，可用“恢复会话”再次核实。结束本次登录先请求服务端取消，确认后才清理材料。恢复/登录后选择空间，读取当前有效网关、设备分页与物模型；当前合同每空间仅一个有效网关，设备页校验绑定修订。云界面只提供实际已实现的设备能力，不调用NAS规则API。

独立`ControlClient`实现原生随机键/S256 PKCE、授权恢复、领取/验证/保存独立会话、取消、退出、空间/网关/设备分页/物模型读取和远程控制；协议见 [原生授权](../../contracts/control-native.md)。`SessionStore`必填，身份Token不交给界面。

界面先明确调用`beginAuthorization()`取得仅供用户查看的授权码和同站`verificationUri`，由系统浏览器批准后调用`pollAuthorization()`。库先核对当前Console主体、CSRF与期限，再保存材料；界面只取得状态和主体，不持有Token。原请求保存失败不发送，响应丢失沿用原证明，503保留会话，401清理；`restoreSession()`核实原身份，`logout()`仅结束子会话。库不自动打开浏览器、后台轮询或写重试，同一实例并发动作返回busy。

远程控制按`prepareCommand`保存完整原请求，再由`submitCommand`先保存发送标记后单次提交。响应丢失、进程重启或同键再次提交均只查原操作，404也不补发；`resolveCommand(reconcile: true)`显式核实原设备结果。记录绑定当前主体/空间，最多128条，退出后保留；`forgetCommand`只清理明确拒绝或终态。结果区分unknown、accepted、dispatched和设备终态，confirmed须有匹配原请求的设备证据。SDK只验证摘要格式和连续性，Go/Rust负责正式规范化摘要。

`npm run test:control:native`已通过真实HTTPS/WSS、Go/MySQL、Rust网关、MQTT模拟设备、Chromium批准和私有文件存储夹具。两端分别验证未受信CA拒绝、会话恢复、远程响应丢失/Go重启后查询原操作、只创建一条设备命令及独立退出。报告标记`native_remote=true`、`transport=https`、`native_app=false`、`hardware=false`；测试专用CA适配器不改变生产信任。此证据属于库，新增SwiftUI云页面、系统浏览器按钮、Keychain与前后台行为仍须在完整App中验收。

## 结构和验证

| 路径 | 职责 |
| --- | --- |
| `Sources/LimeIoTKit` | 类型化合同、HTTPS/会话、传输适配和网关操作 |
| `Sources/LimeIoTKit/ControlClient.swift` | 独立控制面授权/会话、读取及远程原操作，不复用NAS身份 |
| `App/HomeStore.swift` | 当前会话、快照、操作恢复和界面状态 |
| `App/CloudStore.swift` | 云授权、前台轮询、空间/绑定投影与原操作状态 |
| `App/CloudViews.swift` | SwiftUI云登录、设备、操作记录与设置 |
| `App/SecureStore.swift` | Keychain 存储适配 |
| `App/Views.swift` | 原生设备、规则、运行和设置界面 |
| `Tests/LimeIoTKitTests` | 可独立运行的合同与真实网关检查 |

在本目录执行 `swift run ClientChecks` 检查4组本地、4组控制面授权、3组远程、3组动作及7组OTA合同，覆盖整数编码、HTTPS、凭据/CSRF、原证明保存与恢复、S256、非法材料/主体拒绝、取消/退出，以及远程存储失败不发送、旧键只读、拒绝/未知/终态清理和设备证据验证。无完整Xcode的Swift命令行环境也能运行；它不是iOS界面编译。真实控制面库检查在仓库根目录执行`npm run test:control:native`，需要Go、Docker/MySQL8.4、Swift、JDK21和Chromium。

在仓库根目录执行`npm run test:clients:state -- ios`，以macOS宿主编译实际`CloudStore`与Keychain适配源码，使用内存存储/HTTP夹具检查3组状态：后台不轮询及取消后恢复原授权、丢响应/重建客户端后未知操作不重复创建、绑定修订及空间切换隔离。它不调用真实Keychain或系统浏览器，不编译SwiftUI界面。报告为`.dev/native-state-checks/ios.json`；Xcode工程已包含两个云源码文件。

在仓库根目录执行 `npm run test:ios`，会启动独立 Broker、网关、模拟设备与假 Ollama 提供方，验证会话、亮度回执、原操作查询、草案幂等/无自动部署/预演/明确启用、规则生命周期和退出。提供方仅验证 HTTP 合同，不代表模型质量。本机已通过库编译、4项合同检查及真实网关联调、状态管理与Keychain适配的macOS类型检查，以及全部Swift语法检查；没有完整Xcode/iOS SDK，尚未编译iOS整包。模拟器/实机布局、Keychain行为、局域网授权与前后台切换仍须通过 Xcode 和设备验证。

## 本地固件升级

家庭网关“设置 → 固件升级”使用 `OtaClient`、`App/FirmwareStore.swift` 和 `App/FirmwareViews.swift`。独立填写并核对固件公钥指纹，再建立10分钟计划；读取当前完整任务后明确批准，再次读取后开始安装。unknown只查询原设备结果，不重复安装。云服务入口不提供OTA。

必填安全存储以 `origin#ota-operations` 与会话、模型和云操作隔离，最多128项。先保存并回读完整原请求，再单次POST；跨实例互斥、损坏/移除拒绝、404保持未知、同设备未知请求阻止换键。退出和重新登录不删除原记录。历史applied是已保存的操作决定，当前任务的匹配设备证据才表示升级终态。签名与兼容策略由Rust统一执行。

仓库根目录 `npm run test:ota:native` 验证库，`npm run test:ota:native:state` 用真实Rust/SQLite/MQTT与内存存储编译并运行实际FirmwareStore，检查取消、批准不安装、逐次核对、丢响应、重新登录和重启恢复。需要两端工具链；它不编译SwiftUI或运行Keychain/iOS App。iOS整包仍受完整Xcode/iOS SDK缺失阻塞，实机按用户要求跳过。
