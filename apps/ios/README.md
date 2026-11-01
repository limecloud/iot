# iOS 原生客户端

使用 Swift 6、SwiftUI 和 URLSession，最低 iOS 17。`LimeIoT.xcodeproj` 是可打开的 iPhone/iPad 应用工程，`Package.swift` 提供独立、可编译的 `LimeIoTKit` 客户端库。没有 WebView、跨平台 UI 框架或官网源码依赖。

应用提供家庭网关连接、设备开关/亮度、状态和回执、事件规则预演/启用/停用、关联运行及退出。当前规则表单支持布尔属性联动；完整 DSL 可通过 API/CLI 使用已实现子集。

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

应用图标沿用官网已有品牌包；图标的专有许可范围见 [品牌素材](../BRAND.md)，其余客户端代码遵循仓库代码许可。

## 结构和验证

| 路径 | 职责 |
| --- | --- |
| `Sources/LimeIoTKit` | 类型化合同、HTTPS/会话、传输适配和网关操作 |
| `App/HomeStore.swift` | 当前会话、快照、操作恢复和界面状态 |
| `App/SecureStore.swift` | Keychain 存储适配 |
| `App/Views.swift` | 原生设备、规则、运行和设置界面 |
| `Tests/LimeIoTKitTests` | 可独立运行的合同与真实网关检查 |

在本目录执行 `swift run ClientChecks` 检查整数编码、HTTPS 地址、凭据隔离、CSRF、控制/草案超时不重发及原草案查询。无完整 Xcode 的 Swift 命令行环境也能运行该检查；它不是 iOS 界面编译。

在仓库根目录执行 `npm run test:ios`，会启动独立 Broker、网关、模拟设备与假 Ollama 提供方，验证会话、亮度回执、原操作查询、草案幂等/无自动部署/预演/明确启用、规则生命周期和退出。提供方仅验证 HTTP 合同，不代表模型质量。本机已通过库编译、4项合同检查及真实网关联调、状态管理与Keychain适配的macOS类型检查，以及全部Swift语法检查；没有完整Xcode/iOS SDK，尚未编译iOS整包。模拟器/实机布局、Keychain行为、局域网授权与前后台切换仍须通过 Xcode 和设备验证。
