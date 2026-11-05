# LimeIoT .NET 客户端

原生 Windows 产品消费的通用 HTTPS 用户会话 SDK，目标 .NET 10。`GatewayClient` 支持本地网关；`ControlClient` 支持明确批准后的独立云会话。二者共用 `ISessionStore` 窄接口，分别存储身份；默认关闭重定向，不自动重试命令。

`ISessionStore` 由宿主通过系统安全存储实现；执行端设备证书不交给该用户会话客户端。`CommandIntent` 提交前的耐久保存仍由产品完成。HTTPS、原始请求、成功证据外壳均核对；JCS 摘要与精确物模型由网关权威校验，不以本库证明本机效果。

用户客户端不消费 mTLS 执行端身份。SDK、测试夹具不代表 Windows UI、DPAPI/系统安全存储、正式云提供方或真机验收；检查入口为同级 `LimeIoT.Client.Checks` 控制台项目。

本地 `SnapshotAsync` 在 `Device.Reported` 中保留网关属性观测及时间、质量和来源；缺少观测时保持空值，不补造设备状态。`CommandIntent.Create` 默认仍为 `action.invoke`，可显式传入 `type: "property.set"`。本地 confirmed 属性回执必须包含匹配原路径和值的 `device_result`，动作回执继续核对六字段 `action_result`。模型选择、可写 Schema、逐次用户确认与提交前意图耐久保存由宿主完成；SDK 不自动提交或重试。

`ControlClient.BeginAuthorizationAsync("windows")` 在任何 POST 前保存并回读原键、PKCE verifier 与平台，同 origin 恢复不创建新键。宿主显示授权码并由用户打开返回的同站 URL，在系统浏览器明确批准；库不自动打开网页、批准或后台轮询。原生创建/领取/取消不携带 Cookie、Origin、Authorization。领取核对 origin、Console audience、主体、期限和当前会话后才保存材料；Console 请求使用独立 Cookie/Origin/CSRF，401 清材料但保留恢复记录，503 保留会话待核实。取消成功撤销原授权和子会话；子会话退出保留父浏览器登录。

`PrepareCommandAsync` 固化空间、主体、网关绑定、设备、模型、原键、操作与 20 秒期限。`SubmitCommandAsync` 保存 attempted 后只发一次；超时后、重建客户端后，乃至原键 GET 返回 404 时都只查询。`ResolveCommandAsync(key, reconcile: true)` 只核实原 remote_id，且先保存 GET 得到的身份再发送核实请求。`CommandRecordsAsync()` 恢复当前主体所有空间的本机记录，传入空间时过滤；恢复原操作不需要原设备仍在线。未发送记录或终态/明确拒绝可用 `ForgetCommandAsync` 明确清理；已尝试但未知的记录不得丢弃。每 origin 最多 128 条，满额不自动删记录。

云结果核对完整原请求、原远程身份及终态连续性；confirmed 核对本地原回执、属性值或六字段动作证据。RFC8785 摘要、精确模型及设备执行仍由 Go/Rust 权威校验，SDK 不独立证明系统效果。返回的可变 JSON 与耐久状态分离，调用方修改返回对象不会改变原请求。正式协议见 [原生云授权](../../../contracts/control-native.md) 和 [受限远程](../../../contracts/control-relay.md)。

`TextGenerationClient` 支持当前正式的本地 `ollama-text-v1` 有界文字接口：先保存原键与正文摘要，超时后仅 GET 原任务，验证回答摘要与原空间/输入，回答正文仅保留于返回对象。存储满 128 条时拒绝新增，不自动删记录；暂不提供流式输出、云文字代理、正文清除接口或模型质量保证。整数 JSON 规范化仅用于此接口，未作为通用 JCS 实现发布。

```sh
dotnet run --project packages/dotnet/LimeIoT.Client.Checks
```

检查覆盖本地与云凭据隔离、四平台授权证明恢复、跨空间原记录、回执绑定、丢响应和 404 不重发、撤销、存储失败零提交，以及 Unicode 文字摘要向量。

真实云库联调由仓库的 `node tools/test-control.mjs --native-clients` 运行；显式传入 `LIMEIOT_DOTNET`（.NET 10 绝对路径）时加入 .NET 属性/动作旅程，需先构建网关/模拟器和 Console/Admin，并准备 Swift、JDK/Android 工具链。测试使用独立 MySQL、CA 和文件存储，先验证默认客户端拒绝不受信 CA，再仅在测试适配器信任该 CA并核对主机名；不修改生产 TLS 或系统信任。
