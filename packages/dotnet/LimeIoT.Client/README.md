# LimeIoT .NET 本地客户端

原生 Windows 产品消费的通用 HTTPS 用户会话 SDK，目标 .NET 10。支持显式空间选择、真实设备与模型读取、类型化动作、完整原请求核对和原幂等键查询；默认关闭重定向，不自动重试命令。

`ISessionStore` 由宿主通过系统安全存储实现；执行端设备证书不交给该用户会话客户端。`CommandIntent` 提交前的耐久保存仍由产品完成。HTTPS、原始请求、成功证据外壳均核对；JCS 摘要与精确物模型由网关权威校验，不以本库证明本机效果。

当前 API 用于本地用户入口，不声明已接入云原生 OAuth、mTLS 设备通道或已完成 Windows UI/真机验收。检查入口为同级 `LimeIoT.Client.Checks` 控制台项目。

`TextGenerationClient` 支持当前正式的本地 `ollama-text-v1` 有界文字接口：先保存原键与正文摘要，超时后仅 GET 原任务，验证回答摘要与原空间/输入，回答正文仅保留于返回对象。存储满 128 条时拒绝新增，不自动删记录；暂不提供流式输出、云文字代理、正文清除接口或模型质量保证。整数 JSON 规范化仅用于此接口，未作为通用 JCS 实现发布。

```sh
dotnet run --project packages/dotnet/LimeIoT.Client.Checks
```

检查覆盖凭据隔离、显式空间、原回执绑定、响应丢失恢复、Unicode 摘要向量及保存失败零提交。
