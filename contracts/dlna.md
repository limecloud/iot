# 有限 DLNA 播放

本合同定义第一方静态 DLNA 执行端。设备与命令继续使用[执行绑定](execution-routes.md)、[命令](commands.md)和[规则](rules.md)合同；本模块不定义通用插件 IPC、媒体上传或语音会话接口。

媒体可来自原静态列表，或可选的[本地有限音频服务](media.md)。后者设置 `managed_media:true`、`media:[]`，由宿主按当前音箱执行绑定解析获准媒体，每一步业务请求继续重查原授权。两种来源不混用；默认false且序列化省略，保留原静态配置摘要。平台媒体管理API/CLI/家庭网页到DLNA已通过隔离软件链路，NAS配置、快照备份恢复及入口上限另有宿主软件结果；新镜像、原生媒体界面与语音服务继续交付。托管候选DTO可返回`managed_media:true`，供客户端区分静态媒体来源；静态候选保持原字段。

## 设备和能力

正式参考模型为 [dlna-speaker.json](models/dlna-speaker.json)，同时加入内置模型目录。仅包含 `playback.play`、`playback.stop`、`playback.set_volume` 三个动作；输入分别为 `{media_id}`、`{}`、`{volume}`。全部 `completion=submitted`、严格空对象输出、`idempotent=false`。不会把播放、音量或停止的受理当成物理效果，也不生成属性、状态或设备 MQTT 报文。

模型准入核对服务与动作语义、risk、idempotent、输出和输入子集。volume 模型范围为整数0–30，执行时还受所有者配置的更低 `volume_limit` 限制。媒体ID须为平台 identifier；正文不能提供 URL、网络目标或 SOAP 字段。

## 启动配置与明确绑定

`LIMEIOT_AUDIO_CONFIG` 指向绝对路径 UTF-8 JSON，格式见 [dlna-config.schema.json](dlna-config.schema.json)与[适配器说明](../gateway/adapters/dlna/README.md)。文件最多65,536字节、深度12、4096节点；未知字段、重复JSON键和重复设备/适配ID/目标/UDN拒绝。与电视配置合计最多16个候选，不能跨两种适配器重复逻辑设备或适配ID。启动验证不发网络请求，配置中的bindings只准备候选。

目标限定为固定私网或回环 IPv4及非零端口。描述与两项控制路径是明确绝对路径，只允许ASCII字母数字及`/._-`，禁止`//`前缀和`.`/`..`路径段。媒体URL限定规范形式的相同地址类别普通HTTP、无用户信息/查询/片段/转义路径；目标可与音箱不同，但须由所有者明确配置且音箱可达。适配器从不代理或主动下载这些音频，也不处理DNS、代理、重定向或自动重试。

完整类型化 `config` 的 RFC 8785 JCS 摘要是route.revision，包含端点、UDN、音量、媒体URL/ID/有效期与超时。修改任一字段后须重启并明确重新绑定；旧路由休眠，不能静默接管。媒体有效期可以已过期，以便保留配置和原证据，但不能再播放。

`execution-adapters.list` 保留原电视候选格式，新增严格DLNA变体：

```json
{
  "kind": "dlna",
  "device_id": "device-speaker",
  "route": {"adapter_id":"speaker-dlna","revision":"sha256:<64位配置摘要>"},
  "compatible": true,
  "target": "192.168.1.50:49152",
  "udn": "uuid:owner-verified-renderer",
  "volume_limit": 20,
  "playback_volume": 10,
  "media": [{"media_id":"chime","expires_at":"2030-01-01T00:00:00Z"}]
}
```

占位摘要不能直接提交。候选不返回媒体URL或宿主路径。`compatible`不证明在线、已认领、格式支持或获得控制授权；使用既有 `execution-changes.create` 明确bind/revoke并耐久保存原决定。首次设备模型来自启动配置，已有设备可明确选择内置模型；型号支持仍由[设备矩阵](../docs/30-设备支持矩阵与证据台账.md)登记。

## 身份与发送

已绑定目标每5秒读取固定描述，精确核对UPnP设备命名空间、唯一根device的MediaRenderer:1类型/UDN及唯一AVTransport:1、RenderingControl:1服务的控制路径；URLBase若提供须与固定根地址相同。不跟随描述内的新地址或从SSDP自动接管。每条动作执行前再次核对。UDN和IP只能提供配置一致性证据，这条普通HTTP路径不具备原生设备密钥或mTLS的身份保证。

只接受有界UTF-8 XML：单响应最多65,536字节、4096节点和20层祖先，禁用DTD/实体解析；HTTP仅接受200，SOAP回执必须是正确服务的唯一空动作Response，Fault、错命名空间、混合输出及不完整响应均拒绝。

播放顺序固定为 `SetVolume(playback_volume)` → `SetAVTransportURI(获准URL)` → `Play(Speed=1)`。默认播放音量必须不高于 `volume_limit`，上限1–30。停止只发送显式Stop，调音量只发送SetVolume。描述服务存在不代表设备实现这些动作，设备拒绝仍保留失败/未知证据。

单设备由核心FIFO协调。所有可能副作用之前，核心先耐久保存dispatched；适配器每一步再检查原命令、当前绑定/模型/会话/授权、OTA互斥、命令期限和媒体有效期。整个预检和序列共用一次50–5000ms超时与命令期限的较早值。失败行为为：

| 边界 | 结果与行为 |
| --- | --- |
| 非法输入、未授权/过期媒体、超音量上限 | failed，零网络请求 |
| 描述或发送前授权失败 | failed，零业务POST |
| 任一POST已尝试后超时、断连、SOAP Fault或异常响应 | unknown，不重试、不补发、不自动Stop |
| 播放步骤间撤权、过期或OTA占用 | 若已有POST则unknown，后续步骤零发送；不回滚前面的音量或URI |
| 完整序列协议受理 | confirmed，冻结action_result，completion=submitted；不更新reported |
| 重启、撤销、配置修订变化 | 复用原账本和路由恢复规则，不恢复旧播报，不回退MQTT |

描述探测是只读GET；不扫描子网或读取音箱麦克风。原厂抢占不能由本实现可靠识别或仲裁，因此没有检测抢占后的自动Stop或自动重播，也不承诺正在播放状态。

## 当前入口和验证

API/CLI沿用既有工具；家庭PWA提供读取候选、明确绑定/撤销、获准音频选择、限幅音量、停止及原命令查询。绑定和媒体有效期变化须重新读取，服务端始终重新校验。规则用invoke调用同一动作，示例 [button-chime.json](examples/button-chime.json)；示例沿用开发栈的device-lamp占位设备，正式配置替换为音箱逻辑ID。

`npm run test:audio` 运行适配器、宿主候选及模型回归，再以回环HTTP渲染器、实际Rust网关/SQLite/MQTT、CLI和浏览器核对受理/拉取、去重、unknown及重启。音频由测试HTTP服务提供，Range拉取与协议受理独立记录；没有实际发声证据。

本阶段没有SSDP自动发现、SCPD能力访谈、平台媒体文件管理、状态/静音/格式订阅、原厂仲裁、ASR/TTS、原生音箱专用UI或新NAS镜像。手机完整运行和实机验收按进度单列；实机“用户要求跳过”，hardware=false。
