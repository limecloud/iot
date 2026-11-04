# 执行路由、明确绑定与适配器结果

本合同继续定义动作执行；同一设备的可写属性使用独立的[属性桥接授权](property-bridges.md)，不经动作绑定/组合/撤销API取得权限。属性协议受理与独立读回确认保留在原命令账本。

[有限DLNA播放](dlna.md)也复用本执行合同：宿主候选由LIMEIOT_AUDIO_CONFIG准备，route固定完整config的JCS修订，所有者明确bind/revoke，动作仍由核心耐久意图/FIFO及原结果恢复；kind=dlna候选与媒体ID格式见其独立合同。SOAP/XML只在适配器内处理，不创建第二种CommandRequest、MQTT身份或通用插件IPC。电视与音箱候选合计16个，不能重复逻辑设备或adapter ID。

当前实现第一方动作路由、现有空间明确绑定/组合/撤销，复用[命令合同](commands.md)与原操作账本。命令执行类型为 [execution.rs](../gateway/crates/core/src/execution.rs)，绑定决定为 [execution_binding.rs](../gateway/crates/core/src/execution_binding.rs)，机器合同为 [execution-bindings.schema.json](execution-bindings.schema.json)；ADB 实现与宿主配置见[电视适配器](../gateway/adapters/android-tv/README.md)。通用插件IPC、宿主配置热加载及外部更新提供方仍未实现；离线/unknown始终不自动切换路径。协议夹具/假ADB组合已有 [24第4.14节](../docs/24-实施计划与进度.md#414-显式能力组合与文档同步) 的历史通过证据；Agent受控模型及本机日志迁移已有实现，真实JVM组合未通过，最近假ADB专项亦保留失败，见 [第4.16节](../docs/24-实施计划与进度.md#416-tv-agent测试启动与当前验证状态)。

## 绑定与命令

网关启动配置的设备绑定可选 `routes`，键为模型内动作路径，值严格包含 `adapter_id` 与 `revision`。`adapter_id` 使用平台 identifier，`revision` 为 `sha256:` 加64位小写十六进制；ADB 路由修订等于完整类型化适配配置的 RFC 8785 JCS 摘要。空 routes 省略，保留原配置摘要与原生 MQTT 路径。

```json
{
  "remote.press": {
    "adapter_id": "living-room-tv-adb",
    "revision": "sha256:<完整适配配置的64位摘要>"
  }
}
```

以上是 `routes` 示意，摘要占位不可直接提交。当前外部路由仅接受 completion=submitted、输出为严格空对象的动作：output.kind=object、properties/required为空、additional=false。核心首次绑定、快照恢复、后续模型换绑复用 `execution::supports_action` 检查；ADB 的模型准入也复用它。ADB 进一步要求所有服务无属性/事件，动作路径、语义、risk、idempotent 与提供方支持相容，输入是参考定义支持的子集。`bindings.bind` 仍将完整动作集合交给同一候选；`bindings.compose` 按下述分区明确选择原生路径，其余动作交给一个候选。精确参考模型见 [android-tv-remote.json](models/android-tv-remote.json)，它与含音量/静音的 [android-tv.json](models/android-tv.json) 具有不同模型 ID 与摘要。Schema 检查不替代执行时的包名语法与当前应用授权。

内部结果固定生成 output={}，不能绑定需要非空输出或observed证据的动作。签名模型通过发布与安装校验，不自动代表执行端支持；不兼容换绑返回 bound_routes_incompatible，原绑定、会话与命令不变。旧快照若已含不兼容绑定，启动以 storage_corrupt 拒绝，不改写快照或补发命令。修复证据与剩余工作见 [24 第4.5节](../docs/24-实施计划与进度.md#45-静态执行模型兼容检查)。

命令受理时由网关固定 `execution_route`，客户端不能在 CommandRequest 中指定或覆盖它。字段缺省表示原生 MQTT 路径；外部命令另固定适配会话，并继续保存原 request/request_digest、序号和期限。远程回执仍使用既有投影，不透传内部连接配置或新增写入参数。

核心初始配置仍须与已有数据库的 config_hash 一致，不能通过改 routes 或删库绕过。`LIMEIOT_TV_CONFIG` 是单独的宿主候选配置：启动时加载并验证，配置中的 `bindings` 不自动修改已存设备路由。已有空间应通过以下明确用例接入；型号支持、动态能力子集与通用插件分发不由一份配置推导。

## 明确绑定、撤销与原决定

以下本地入口复用所有者会话或 Bearer；浏览器写入继续校验 Origin 与 CSRF。它们未自动进入独立控制面的远程工具目录。

| 工具 | HTTP | 用途 |
| --- | --- | --- |
| `execution-adapters.list` | `GET /api/v1/spaces/{space_id}/execution-adapters` | 读取宿主准备的候选、配置修订及模型兼容性 |
| `execution-bindings.get` | `GET /api/v1/spaces/{space_id}/devices/{id}/execution-binding` | 读取当前模型、绑定修订、状态和路由 |
| `device-applications.list` | `GET /api/v1/spaces/{space_id}/devices/{id}/applications` | 读取当前绑定的应用发现缓存与授权标记 |
| `execution-changes.create` | `POST /api/v1/spaces/{space_id}/execution-operations` | 明确绑定、组合或撤销；正文为 change，头为单个 Idempotency-Key |
| `execution-changes.resolve` | `GET /api/v1/spaces/{space_id}/execution-operations/by-key/{id}` | 只读恢复原决定 |

绑定正文为 `type=bindings.bind`、`device_id`、完整 `route`、`expected_binding_revision` 和 `expected_model_revision`；撤销为 `type=bindings.revoke`、`device_id` 和 `expected_binding_revision`。先查询当前绑定与候选，再填写精确修订；客户端不能在变更中传 ADB 目标、工具路径、凭据或任意命令。电视候选的`paths`是当前模型中ADB实际支持、按字典序排列的唯一动作路径；`compatible=true`表示该集合非空，不代表能接管整个模型，也不证明电视身份、在线或所有者已批准。没有可执行路径时`compatible=false`、`paths=[]`。精确输出结构见 [televisionAdapter](execution-bindings.schema.json#/$defs/televisionAdapter)，网页、CLI及原生端的严格候选消费者同步校验。

网关在同一次 SQLite 提交中核对当前宿主候选、绑定/模型修订及模型权限，保存完整原请求、JCS 摘要、决定、绑定变更与审计。新绑定还要求设备无 OTA 占用、无 dispatched 命令且 adapter_id 未被其他设备占用。返回 HTTP 200 后仍须读取 status：applied、conflict 或 rejected；拒绝原因位于 reason。写盘失败不发布新内存状态。每空间最多保存256个绑定操作，达到上限后仍可读取已有原决定，不回收原键。

绑定视图 state 为 native、bound、composed 或 revoked；bound/composed 只表示已有计划，各执行端仍需当前会话。composed 另含 `native_paths`，其余视图省略该字段。revision 对设备、当前模型、routes 和含 generation 的绑定记录求完整摘要，每次变更生成新 generation，防止“绑定→撤销→原路由”复用旧基线。绑定、组合或撤销清除适配会话、ready 和 device_info；原 accepted 命令拒绝。换绑要求排空 dispatched，撤销可立即进行并将其保留为 unknown。撤销以 route=null 的持久记录阻止两端新命令与 MQTT 回退，不能通过清空 routes 重新启用原生路径。

CLI 与网页先保存完整原请求，失败零 POST。丢响应、404 或无法验证回执时保留原键并查询；CLI 同键同参再次 create 也只 GET。异参为 idempotency_conflict；恢复历史 applied 只返回当时的 result，不重新绑定已撤销设备。当前状态必须另读 execution-bindings.get。

## 显式能力组合与原生证明

组合复用 `execution-changes.create`，不会创建第二个Device或Command账本。请求字段如下；占位值必须替换为读取到的真实修订和会话：

```json
{
  "type": "bindings.compose",
  "device_id": "device-tv",
  "route": {"adapter_id": "living-room-tv-adb", "revision": "sha256:<64位配置摘要>"},
  "native_paths": ["apps.launch"],
  "expected_native_session": "<当前原生session_id>",
  "expected_binding_revision": "sha256:<64位绑定摘要>",
  "expected_model_revision": "sha256:<64位模型摘要>"
}
```

- `native_paths` 为1–64条按字典序排列且唯一的动作路径，沿用模型的服务/动作本地ID规则；它必须是模型全部动作的非空真子集。剩余动作全部固定到该route，两部分无重叠、无缺口，且必须属于宿主候选实际支持的路径。当前仅支持一个原生执行端和一个外部候选，动作须submitted、严格空输出；模型可以含只读属性，完整状态仍由同一原生会话上报，外部端不取得属性写权或观测来源。含可写属性或事件的模型仍拒绝；普通bind继续要求仅动作且候选覆盖全部动作。
- 原生设备以精确相同的逻辑模型修订发送hello，并可在body声明 `execution_paths`：1–64条唯一、模型内的动作路径。声明不产生执行权。批准组合须有新鲜native_ready、匹配的 `expected_native_session`，且声明覆盖所选 `native_paths`；声明可为超集，未选路径仍交给既定适配器。没有声明不能批准组合，旧原生设备的非组合握手保持兼容。
- 每次新hello重新验证覆盖关系；缺声明或能力收缩至不能覆盖计划时拒绝，不静默改路由。声明、原生/适配会话均不持久化；重启保留计划，重新握手/探测后才开放对应路径。设备证书证明获准逻辑身份，不单独证明ADB与Agent属于同一物理电视，归属仍须所有者核对。
- 组合与bind共用模型/绑定修订、候选、授权、在途命令及OTA互斥检查和原决定账本。命令只走固定路径，离线或unknown不切换执行端；同一设备的FIFO跨MQTT/适配器成立，不能越过另一端在先的accepted命令。

组合设备投影增加 `action_availability: {"apps.launch": true, "remote.press": false}`，按每条路径的当前会话、模型信任与OTA占用计算；它不是权限授予，也不承诺下一次发送一定成功。声明了执行路径的设备另投影`native_execution={session_id,ready,paths}`，结构见 [nativeExecution](execution-bindings.schema.json#/$defs/nativeExecution)。其中ready只反映当前原生会话的新鲜度、模型信任、撤销及OTA门禁，独立于适配器提供的设备总ready；paths与会话均为易失事实，重启不能从快照恢复。没有原生声明时省略该字段。

家庭网页可创建显式组合：重新读取设备原生证明、绑定和候选，核对同一设备/模型修订；将当前原生声明的模型动作交给Agent，剩余动作须非空且全部在ADB候选paths内。页面展示两端职责并要求所有者核对电视后确认，再保存完整原请求及原会话、提交compose；服务器仍在同一耐久事务中复核所有前置条件。结果未知或页面重开仅查询原操作，不能重发或自动换路径。只读音频模型不显示普通bind入口；Agent离线时不能以ADB在线批准组合。通用CLI仍可显式指定合法分区。

TV Agent可通过材料v2显式选择android-tv-remote逻辑模型，hello只声明apps.launch，按键仍由已批准的外部路由执行。旧应用模型日志向遥控配置的单向迁移保留全部原记录/unknown/拒绝边界，详见 [设备合同](tv-agent.md)。本机迁移不变更网关模型绑定或自动compose；已有网关设备跨内置模型已通过独立JVM软件旅程，见 [24第4.19节](../docs/24-实施计划与进度.md#419-内置模型绑定与跨模型软件闭环)，实际电视另验。原应用/遥控配置的实际JVM与假ADB组合软件结果见[4.22](../docs/24-实施计划与进度.md#422-adb身份预检合并与实际jvm组合软件验收)；音频组合当前使用协议夹具，实际JVM音频、Android系统与实机仍另验。

## 宿主配置迁移与应用发现

宿主配置在进程启动时读取。调整目标、应用白名单、超时或其他 config 字段后，其完整 JCS 修订会变化；重启保留原绑定，但新候选与旧路由不匹配时不探测、不执行。所有者读取新候选和当前绑定，核对设备并明确重新绑定，之后才重新建立会话。移除候选也不会删除绑定历史或撤销记录，查询/撤销仍可使用；当前没有热加载接口或自动接管路径。

候选列表向当前所有者返回目标、构建指纹、序列号和应用授权，不返回宿主工具路径、私钥或完整内部配置。应用由后台只读探测按 binding_revision 缓存，严格小于15秒才 fresh=true；GET 不临时触发 ADB 扫描。缓存过期返回 fresh=false、observed_at=null 和空 items；当前没有匹配候选时返回 execution_offer_unavailable。每个已发现包独立标记 authorized，发现不授予启动权；启动仍走原命令用例，并在执行前重新发现、检查身份和当前白名单。旧绑定的探测结果不能激活新绑定。

组合中只有 `apps.launch` 实际路由至该ADB时，applications入口才提供它的发现/授权列表；原生启动路径返回execution_offer_unavailable，网页不展示ADB应用发现按钮。ADB白名单不能当作原生应用授权，后者由实际设备消费者另行核对。

## 在线、分发与当前授权

原生设备继续通过 MQTT hello/state 建立会话。适配器通过内部 `adapter_seen` 登记已绑定设备、路由修订、会话及观测时间，15秒后失效；这些会话不进入快照，重启后重新探测。设备投影的 ready 可由当前有效绑定提供，属性观测仍按原生观测的新鲜度处理，不补造 reported。

`prepare_dispatch` 仅取得原生 MQTT 命令；`prepare_adapter_dispatch` 仅取得指定适配器命令。两者共用单设备顺序、队列上限、模型/远程授权、期限和 OTA 互斥。变为 dispatched 的状态及事件先在 SQLite 提交，提交失败不返回可执行工作。

ADB 先做只读身份与应用预检，再调用核心 `recheck_adapter_dispatch`，核对原 dispatched 命令、请求摘要、当前路由/模型/适配会话、期限、远程授权与 OTA 互斥。拒绝时零业务动作，不自动选择另一条路径。Broker 断线仅使 MQTT 设备会话和命令降级，外部适配绑定不随之失效。

## 结果与恢复

适配结果走内部入口，必须绑定原 command_id、完整 request_digest、route 和 session_id。原生 MQTT result 拒绝更新外部路由命令；适配器不发布虚假的设备 hello/state/result。

| 适配阶段 | 命令结果 | 证据范围 |
| --- | --- | --- |
| submitted | confirmed + 严格 action_result | 类型化输入已提交；核心重算 input_digest 并校验模型输出、completion 与时间 |
| rejected | failed + 明确错误 | 预检、当前授权或进程启动前明确拒绝，未发送业务动作 |
| unknown | unknown / execution_unknown | 进程已启动后超时、异常退出、输出异常等，可能已产生副作用 |

动作结果不修改 reported；输入提交不证明界面达成。断连或重启后，accepted 拒绝、可能已发送的 dispatched 变为 unknown；原键查询不补发。迟到结果只归原命令，confirmed/failed 冲突终态仍拒绝。适配器没有设备侧原操作日志时，不能从网关账本证明物理 exactly-once。

## 快照与验证

当前快照校验读取版本1–11；基础路径提交写10，含定时记录时写11且不回退，具体以[自动化合同](rules.md)为准。本次增加候选路径和原生投影不改变快照格式。版本4及以前拒绝夹带 routes/execution_route，版本5及以前拒绝夹带 execution_registry，版本6起须显式包含它。v6保存绑定generation、撤销记录与原决定；v7新增可选native_paths与compose原决定。v6夹带这些新字段/决定拒绝，旧绑定不自动改为组合；会话、能力声明和应用缓存不持久化。恢复分别校验bind完整动作集或compose完整分区、模型证据范围、路由占用，以及历史决定与原请求/结果的对应关系；残缺路由不能隐式变为原生路径。OTA 的版本4 execution字段要求继续生效。格式不符或未来版本拒绝且不改写快照；v8增加内置模型绑定来源与原决定，v1–7夹带新动作/绑定/结果拒绝，详见 [模型合同](model-release.md#本地信任安装和设备绑定)；v9保存属性阈值规则及采样证据，v10保存条件证据，v11保存定时游标与运行证据。不支持对应快照版本的旧二进制不能读取新库。迁移仅使用隔离测试库，未操作用户数据库。

`npm run test:tv` 构建当前网页/Rust，执行核心路由、明确绑定/组合、适配器故障及CLI边界检查，再以Chromium、真实HTTP/mTLS/MQTT/SQLite和假ADB验证耐久提交、单路径发送、丢响应/重启与Broker独立性。新增组合旅程对同一目标逻辑电视统计两端效果，验证单路径离线、原键不复活与网页撤销；原生端为协议夹具。现有空间旅程继续覆盖网页接入、应用发现、配置迁移和禁用轮询后的事件刷新；夹具定位离线校验器，详见[CLI说明](../packages/cli/README.md#电视适配绑定与应用发现)。实际结果见 [24第4.14节](../docs/24-实施计划与进度.md#414-显式能力组合与文档同步)。`cargo test --locked -p limeiot-gateway` 另覆盖提交失败、绑定写盘原子性及旧/损坏快照恢复，其运行结果单独登记。真实Agent、手机端上、NAS镜像与电视实机分别验收。
