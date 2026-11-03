# DLNA 播放适配器

宿主装配在`gateway/crates/runtime/src/integrations/dlna.rs`，由统一Registry管理；本库与其宿主模块均不依赖电视接入模块。媒体应用通过平台凭证接口提供短时播放授权，由集成层转换成DLNA类型。独立选择可用`cargo build --locked -p limeiot-gateway --no-default-features --features dlna`；默认发行版包含它，静态集成随网关二进制升级，不支持热安装。工程边界见 [21第1.4节](../../../docs/21-Monorepo与开发规范.md#14-核心集成与独立工程)。

固定局域网目标的 Rust UPnP AV 执行端，复用核心设备、绑定与命令账本。配置、证据与失败语义以[正式合同](../../../contracts/dlna.md)为准，参考模型为[音箱模型](../../../contracts/models/dlna-speaker.json)。

准备现有音频HTTP服务、音箱实际描述地址/控制路径和经过所有者核对的UDN。音频必须是音箱可读取的有限文件；本适配器不托管、转码或验证音频内容/格式。下面是需替换地址、UDN和有效期的配置示意：

```json
{
  "schema_version": 1,
  "bindings": [{
    "device_id": "device-speaker",
    "adapter_id": "speaker-dlna",
    "config": {
      "schema_version": 1,
      "target": "192.168.1.50:49152",
      "description_path": "/description.xml",
      "av_transport_path": "/AVTransport/control",
      "rendering_control_path": "/RenderingControl/control",
      "udn": "uuid:owner-verified-renderer",
      "playback_volume": 10,
      "volume_limit": 20,
      "media": [{"media_id":"chime","url":"http://192.168.1.10:18090/chime.wav","expires_at":"2030-01-01T00:00:00Z"}],
      "timeout_ms": 3000
    }
  }]
}
```

1. 新空间在核心配置中登记音箱逻辑设备及正式模型修订，不配置原生MQTT身份；已有设备先通过内置模型绑定流程选择音箱模型。保留原始核心config摘要，不能修改已有库的启动配置绕过绑定。
2. 设置进程配置 `LIMEIOT_AUDIO_CONFIG` 为这份文件的绝对路径。启动只校验候选，不探测、不授予控制。
3. 网页设备页读取接入信息、核对目标与音频后明确绑定；或CLI调用`execution-adapters.list`、`execution-bindings.get`取得精确修订，再用`execution-changes.create`提交bindings.bind。引用与原键保存方式沿用[CLI说明](../../../packages/cli/README.md)。
4. 连接后通过commands.create提交`action.invoke`，path=`playback.play`、value=`{"media_id":"chime"}`。Stop与设置音量分别为playback.stop/{}和playback.set_volume/{volume:0..volume_limit}；每次命令使用明确期限和原幂等键。
5. 超时/丢响应只查询原命令；读取unknown不会重播。修改目标或媒体授权后重启，核对新候选并明确重新绑定；旧route不会自动升级。

配置中未来时间只是格式示意，实际应为适合该段音频的短有效期。URL中不得携带云模型密钥、平台令牌或身份资料。普通HTTP与UDN不提供强身份认证，音箱网络及媒体服务访问须由部署所有者控制；不会连接公网、跟随重定向或访问代理。

NAS部署需把文件只读挂载给网关，媒体地址须从音箱网络可达。已有NAS镜像没有因此自动更新，容器网段/防火墙/Range拉取须独立验证。Android与iOS专用音箱界面、SSDP自动发现、状态/静音、媒体管理和语音链路继续交付。

软件检查：`cargo test --locked -p limeiot-dlna` 或仓库 `npm run test:audio`。后者使用回环模拟渲染器和WAV服务；不会扫描或操作用户音箱。实机按用户要求跳过。
