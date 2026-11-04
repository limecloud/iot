# Zigbee协调器入网与操作恢复

本合同定义本地网关的有限入网管理。宿主配置决定协调器身份与串口，适配器核对NCP的IEEE和角色。操作改变协调器入网策略；协议受理不代表设备已加入，也不创建平台绑定、MQTT身份或OTA授权。设备发现与明确接入继续使用[观测来源合同](observation-sources.md)。

机器形状见[Schema](zigbee-operations.schema.json)，工具入口见[目录](tools/catalog.json)。底层报文沿用[ZNP合同](zigbee-diagnostics.md#有限协调器入网窗口)：0明确关闭、1–120秒有限开放，只支持已有网络的本协调器单播，不创建网络、广播或永久开放。

## 读取与明确提交

所有入口要求当前本地所有者会话或Bearer，浏览器写请求继续校验Origin和CSRF，空间必须匹配。当前不扩展云中继的远程权限。

| 方法 | 路径，统一前缀`/api/v1/spaces/{space_id}` | 工具 |
| --- | --- | --- |
| GET | `/zigbee-coordinators` | `zigbee-coordinators.list` |
| POST | `/zigbee-operations` | `zigbee-changes.create` |
| GET | `/zigbee-operations/by-key/{key}` | `zigbee-changes.resolve` |
| GET | `/zigbee-operations` | `zigbee-operations.list` |

协调器列表只返回配置v2中的可管理项目，最多4项，不扫描端口。每项包含`coordinator_id`、`coordinator_ieee`、`revision`和`timeout_ms`，不暴露串口路径。revision由宿主对完整配置和版本标识计算。

提交正文只有`coordinator_id`、当前`expected_revision`和`duration_seconds`，必须提供唯一的`Idempotency-Key`。拒绝重复JSON键、未知字段、非整数、超限期限和客户端串口。配置修订不同返回`revision_conflict`；协调器不存在或串口任务繁忙时，在记录和发送前拒绝。

```sh
node packages/cli/src/main.mjs schema zigbee-changes.create
node packages/cli/src/main.mjs invoke zigbee-coordinators.list --space-id space-demo
```

核对返回的协调器和完整修订后，准备`join.json`：

```json
{
  "coordinator_id": "home-znp",
  "expected_revision": "sha256:替换为列表返回的完整修订",
  "duration_seconds": 60
}
```

修订占位符不能直接执行。按所有者明确意图提交，再按原键查询：

```sh
node packages/cli/src/main.mjs invoke zigbee-changes.create --space-id space-demo \
  --idempotency-key join-original --input "./join.json" --state-dir "/absolute/private/state"
node packages/cli/src/main.mjs invoke zigbee-changes.resolve --space-id space-demo --id join-original
```

网关入口不需要停止网关。入网、发现、访谈、属性查询和已绑定设备采样共用原串口actor、会话和单slot；连续管理请求之间仍服务到期采样。成功入网不重置AF编号、端点注册或健康来源的阈值基线。

## 耐久意图与结果

发送入网请求前，网关先将完整原请求、JCS摘要、宿主协调器视图、operation_id、连续sequence和时间写入SQLite。复用原`events`表的`zigbee.commissioning`事件，不增加表或变更领域快照版本。提交成功后才把任务交给actor，首次写盘失败零网络发送。每条新请求只发送一次入网命令，不自动延长、重试或补发关闭。

| status | 含义 |
| --- | --- |
| `unknown` | 尚无耐久保存的成功回执，可能未发送、正在处理、超时、取消、故障或回执保存失败 |
| `protocol_accepted` | 已取得完整协议成功响应、复核协调器IEEE并耐久保存结果 |

初始unknown的reason为`not_confirmed`，completed_at为null。actor结束后只保存一次结果：成功包含`result { coordinator_ieee, duration_seconds, observed_at }`且reason为null；失败保留unknown并记录错误码。completed_at表示本地记录完成时间，不表示窗口关闭或设备入网。

首次HTTP响应可能先返回初始unknown，随后同键查询补上超时等原因；这不产生第二次网络写入。回执写盘失败继续公开原unknown，不在内存伪造成功。最多256个原请求，每个最多两条事件，达到上限拒绝新增，不自动裁剪。重载检查摘要、原字段、顺序、唯一标识和唯一结果转换；损坏记录拒绝启动。

同键同参返回原操作，不受配置移除、结果未知或重启影响；同键异参返回`idempotency_conflict`。GET原键不存在不能作为自动重发依据。HTTP断开或调用方取消不撤销已提交意图，任务归actor所有；停机取消在途IO，重启只加载记录，永不重放未完成操作。

## 未知状态与关闭

unknown操作的`blocked_until`为创建时间加配置操作期限，再加请求开放秒数。它仅用于禁止在可能仍开放期间换键延长，不宣称真实窗口何时关闭。时间到达后，原记录仍保持unknown；另一条请求仍须所有者新的明确意图。

同一协调器IEEE存在尚未到期的unknown时，新的开放请求返回`zigbee_operation_unresolved`。明确关闭可用新键和duration_seconds 0提交，仍受队列、存储、容量和修订检查；关闭不会改写先前未知操作。

CLI在首次POST前把原请求写入私有目录、同步并回读。保存失败零POST，本地已有同键记录时只GET原键。坏回执、响应丢失和404均保留原记录，不能自动换键。unknown退出6，协议受理退出0，同键冲突退出4；不会自动触发发现或绑定。

## 恢复与验证范围

NAS备份原SQLite时一并保存这些事件，恢复后只展示原请求和结果。配置缺少协调器时仍可读取历史，不能新提交入网。Linux容器制品和硬件效果分别验收。

`npm run test:nas:zigbee -- --image "limeiot/verification:YOUR_TEST_TAG" --platform "linux/arm64"`另行验证实际Linux镜像与打包网页。容器内软件NCP记录一次60秒未知开放和一次独立关闭；关闭HTTP响应丢失后只GET原键恢复。重建与新目录备份恢复后，原两条操作及四条耐久事件原字节保持，新NCP收到零入网补发；缺少协调器时可读历史，新请求拒绝。阶段结果见[NAS入网恢复证据](../docs/evidence/2026-11-04-zigbee-commissioning-nas.json)。

`npm run test:zigbee:gateway-commissioning`运行持久化检查与真实Rust/SQLite/MQTT/Unix伪终端软件旅程，检查同会话采样、阈值联动、响应丢失、原键恢复、提交失败、备份和重启零补发。SIGKILL无法运行RAII恢复TTY；崩溃测试确认此限制后，由夹具显式恢复自己的伪终端再启动网关，不把该清理计为产品能力。

## 家庭网页

本地家庭网页的“设备接入 → Zigbee 入网”支持选择协调器、填写1–120秒开放时长，核对协调器IEEE后明确开放；关闭使用独立核对与“确认关闭”。准备和取消不保存原请求、不发送入网命令。成功仅显示协议受理，之后仍须发现、读取端点、查询完整候选并明确添加设备。

每次确认先通过Web Locks取得当前空间的独占锁，重新读取协调器和历史，核对完整配置视图未变化；再保存并逐字回读本机原请求，成功后才发出一次POST。记录仅包含origin、空间、原键与原change，不包含凭据、串口或协议manifest。已观察过的记录被移除或改写后，当前页面阻止新写；浏览器存储不提供密码学防篡改保证。

未知记录只查询原键。404、坏回执和重复JSON键保持未知，不自动重发；刷新及网关重启后的历史读取也不补发。没有服务端记录的本机原请求阻止换键开放；已有unknown按blocked_until阻止新的开放，明确关闭仍为另一条所有者请求。核对最长60秒，输入变化、后台、离线或离页清除核对，迟到响应不能恢复。

浏览器需在HTTPS或回环安全上下文中支持Web Locks，存储失败时零POST。`npm run test:zigbee:commissioning-web`覆盖新网页旅程及现有接入、发现网页回归，使用真实Rust网关、SQLite、MQTT模拟灯和Unix伪终端软件NCP。软件入网受理不验证真实设备加入或空口窗口计时。

## 原生客户端

Swift/Kotlin通过独立ZigbeeClient消费同一合同，复用原GatewayClient的本地会话、CSRF、严格整数JSON与安全存储适配器。在“设置 → Zigbee 设备”的入网区选择协调器与时长，先准备核对，再明确开放或关闭；准备与取消零POST。原请求使用独立的`origin#zigbee-operations`存储，最多256条，和观测绑定、身份、OTA记录分离。

新提交跨实例互斥，重新读取协调器完整视图与历史，核对当前修订和未知窗口，保存并逐字回读原请求后才POST。核对60秒过期、输入变化、后台、离页、断线或连接关闭时失效；保存等待期间取消后零POST，已保存原请求保留。普通读取期限12秒，明确入网提交35秒。首次成功HTTP响应可能仍为初始unknown，只能按原键查询后续结果。

已有同键同参只GET，即使旧核对已经过期；同键异参拒绝。404、坏回执和重复JSON键不补发。服务端未完成unknown可取得一次结束结果，已经完成的结果不得变化；读取新结果还核对原请求、摘要、协调器视图、sequence和时间关系。其他客户端已创建的历史也可按原键查询，不伪造成本机原请求。原生进程和网关重启不会重放；明确关闭是独立原请求，不覆盖先前未知。

`node tools/test-observation-native.mjs ios`与`android`分别运行合同、实际状态层和相关回归；Android另生成Debug APK与lint结果，Swift检查HomeStore类型、SwiftUI语法及工程文件。`npm run test:zigbee:native`包含原生宿主进程到真实Rust/SQLite/MQTT/软件NCP的入网与接入旅程。宿主文件夹具不证明Keychain/Keystore或完整App页面运行。

当前交付网关HTTP、CLI/Agent、家庭网页及Swift/Kotlin入网入口。Linux ARM64本地验证镜像已包含入网与发现，正式云版本未更新；完整iOS工具链、Android启动及其他既有缺口单独记录，实机按用户要求跳过。ARM64容器内PTY结果不提升AMD64、USB透传或空口验收。
