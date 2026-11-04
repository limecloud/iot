# 本地模拟开发

本入口启动真实 Mosquitto 2.0.22、Rust 网关及灯光/按钮两个 MQTT 5 模拟客户端。模拟设备的状态与回执独立保存，网关只通过网络取得它们。无需模型服务、互联网账号或真实开发板。

## 依赖与启动

Zigbee开关的软件闭环入口：`npm run test:zigbee:onoff-gateway`检查家庭网页与温度自动化；`npm run test:zigbee:onoff-native`检查Swift/Kotlin客户端库的开关、丢响应和重启后原键恢复；`npm run test:control -- --property-bridge`检查隔离Go/MySQL控制面通过HTTPS/WSS控制同一类开关。原生入口需要Swift、JDK21和Android工具链，云入口需要本地Docker/MySQL测试镜像。这些入口使用软件NCP，不访问真实设备或生产服务。NAS打包安装与恢复见[NAS入口](../nas/README.md#zigbee-开关)，整体范围见[当前进度](../../docs/24-实施计划与进度.md)。

使用 Rust stable、Node.js 24.21+ 的 24.x、Python 3.12+。项目内构建 Broker 另需 CMake、C 编译器和 OpenSSL 开发库：

```sh
npm ci
python3 "tools/bootstrap-broker.py"
npm run dev
```

已有 Mosquitto 时，可通过 `LIMEIOT_MOSQUITTO` 指定其二进制完整路径，跳过构建。下载源、版本和 SHA-256 固定在脚本中；第三方源码与产物留在忽略目录 `.dev/tools`。

HTTP 监听 `127.0.0.1:17880`，Broker 监听 `127.0.0.1:18884`。状态、虚拟设备回执、随机实验凭据和日志位于 `.dev/local`，再次启动沿用原操作和规则；配置与数据库不匹配时拒绝覆盖。Ctrl+C 只关闭本次启动的子进程。

Rust网关接收SIGINT和SIGTERM时会结束事件流并取消、等待协议子任务；HTTP在途请求最多排空3秒。结果不明的操作继续查原编号。`npm run test:gateway:shutdown`验证保持事件流及串口读取时的退出和重启，具体范围见[进程启停合同](../../contracts/runtime-lifecycle.md)。

## 家庭界面与原生客户端

打开 `http://127.0.0.1:17880`，使用 `.dev/local/session.env` 中的 `LIMEIOT_TOKEN` 登录。界面直接消费同一网关API，支持设备属性控制、规则预演/启停、执行记录和原操作恢复。凭据换取HttpOnly会话，写操作校验Origin和CSRF；退出撤销会话，重启需重新登录。PWA只缓存静态资源，API不进入离线缓存。

NAS安装使用[HTTPS入口与备份恢复](../nas/README.md)。iOS原生工程见[Swift/SwiftUI](../../apps/ios/README.md)，Android见[Kotlin/Compose](../../apps/android/README.md)；原生应用连接受信HTTPS地址。CLI和原生库自动化检查可以使用独立回环实验入口，不放宽应用发布版的TLS验证。

## Agent 与 CLI

在另一个终端进入仓库：

```sh
source ".dev/local/session.env"
npm run cli -- schema
npm run cli -- capabilities list --space-id space-demo
npm run cli -- devices list --space-id space-demo
npm run cli -- rules validate --space-id space-demo --input "contracts/examples/button-light.json"
npm run cli -- rules deploy --space-id space-demo --input "contracts/examples/button-light.json"
```

回到开发终端输入 `button` 并回车。另一个终端查询结果：

```sh
npm run cli -- runs list --space-id space-demo
npm run cli -- events list --space-id space-demo --after 0
npm run cli -- events stream --space-id space-demo --after 0
```

`commands get COMMAND_ID --space-id space-demo` 查询同一个操作；命令创建接受 `--input FILE`，格式由 `schema commands.create` 提供。创建输入必须使用当前模型修订、唯一幂等键和未来 30 秒内的期限。HTTP 接收 202 表示已受理，不能当作设备完成。CLI 遇到 `unknown` 返回退出码 6，明确失败返回 7；保留原 ID 查询。

`commands list`查询最近100条操作；通过`--cursor`继续读取。受理响应丢失后使用`commands resolve IDEMPOTENCY_KEY --space-id space-demo`恢复原命令。`rules stop RULE_ID --input FILE`使用`{"revision":"sha256:..."}`校验当前修订后停用规则，保留原运行记录。

规则支持事件、属性阈值和每周定时触发、类型化属性设置与模型动作、比较/all/any条件、冷却和固定部署修订。延时、Shell和未登记动作拒绝。`rules simulate --input FILE --space-id space-demo` 接受 `{rule,event}`，返回拟执行动作，不改变设备或部署；输入定义见[规则合同](../../contracts/rules.md)。需要等待设备结果再进入下一阶段时，使用独立的[执行计划](../../contracts/execution-plans.md)。

## 代码与验证

### 可选网关配对

先按 [控制面](../../server/README.md) 运行独立实例，再离线生成本地机器密钥；输出只含公钥与gateway_id，不含私钥：

```sh
target/debug/limeiot-gateway identity-init "$PWD/.dev/local/gateway-identity.pk8"
LIMEIOT_CONTROL_ALLOWED_ORIGINS="http://127.0.0.1:17890" \
LIMEIOT_GATEWAY_KEY_FILE="$PWD/.dev/local/gateway-identity.pk8" npm run dev
```

`.dev/local` 须已由首次开发启动创建。已有密钥不要重新生成；文件0600且不能为符号链接。非回环控制面使用HTTPS，私有CA通过 `LIMEIOT_CONTROL_CA_FILE` 指定。未配置时仍可正常使用本地设备与规则。

控制面API先创建空间及120秒配对请求，在家庭界面“网关配对”粘贴返回JSON，核对目标账号、origin与范围后批准。CLI发现入口为 `schema control-pairings.create`，完整生命周期见 [合同](../../contracts/control-pairing.md)。配对码不交给模型，CLI输入文件与机器密钥按凭据管理。响应丢失后按原键resolve、再reconcile核实原绑定，不重新claim；配对建立不表示远程可用。

`npm run test:pairing` 运行临时MySQL/真实Go与Rust、CLI、Chromium及NAS配对恢复；`npm run test:control` 可独立验证控制面。本地开发不需要私有官网仓库。

已配对后可在网关启动命令增加 `LIMEIOT_CONTROL_RELAY_ENABLED=1`，启用机器连接层。连接会重新核对原绑定、发送心跳，断线退避重连，不重发claim或设备命令。`control-pairings list --space-id space-demo`输出独立connection状态。远程设备读取、命令及原操作核实使用控制面Console、原生云入口或独立[控制面CLI](../../packages/cli/README.md)，通过`control schema`发现工具，使用控制面自身会话。`npm run test:relay`验证连接，`npm run test:remote`验证远程软件链路；协议见[连接合同](../../contracts/control-relay.md)。

### 本地模型草案

先独立启动 Ollama 并安装所选模型，再以命令级配置启动网关：

```sh
LIMEIOT_OLLAMA_MODEL="your-local-model" \
LIMEIOT_OLLAMA_URL="http://127.0.0.1:11434" npm run dev
```

将 `your-local-model` 替换为已安装的本地模型，质量验证状态见[实施计划](../../docs/24-实施计划与进度.md)。在家庭界面的自动化页输入联动需求，生成后检查全部动作，依次选择“预演草案”和“启用草案”。Swift/Kotlin 原生端使用相同流程。生成或预演均不操作设备。未配置模型时仍可手动创建规则。

Agent 使用 `schema drafts.create` 读取正式输入，`drafts create --space-id space-demo --input FILE` 创建，`drafts resolve ORIGINAL_KEY --space-id space-demo` 查询原记录。输入文件包含 `space_id`、`idempotency_key`、`prompt`、`expires_at`；期限在未来 120 秒内。HTTP 映射见[接口规范](../../docs/16-API事件与CLI规范.md)。响应丢失后先查询原键，不自动更换键重调模型。

`npm run test:inference` 以假提供方验证故障合同；显式配置已安装的模型后运行 `npm run test:inference:live`，才会调用真实 Ollama，验证中文需求、缺失能力拒绝、无自动执行、预演、明确部署、MQTT 回执及重启记录。证据写入忽略目录 `.dev/ollama/verification.json`；失败保留实际状态，不自动换模型或重试。

| 路径 | 职责 |
| --- | --- |
| `contracts/` | 当前模型、规则、业务输入及可执行工具目录 |
| `gateway/crates/core` | 自有模型、会话、命令和规则语义 |
| `gateway/crates/runtime` | SQLite、MQTT、HTTP/SSE 适配与装配 |
| `tools/simulator` | 独立虚拟设备与回执 |
| `packages/cli` | 消费同一工具目录，输出 JSON/NDJSON |
| `apps/home` | 由网关同源提供的React家庭PWA |
| `apps/ios`、`apps/android` | Swift/SwiftUI及Kotlin/Compose原生客户端 |
| `tests/e2e.test.mjs` | 真实进程、Broker、CLI 与重启故障验证 |

```sh
npm run check
npm test
npm run test:e2e
npx playwright install chromium
npm run test:browser
npm run test:ios
npm run test:android
```

端到端测试使用动态回环端口、独立状态目录和随机凭据，完成后关闭自己的进程。日志保存在 `.dev/run-*`，不读取现有服务数据库。关键状态与事件在一个 SQLite 事务中提交；内存总线只通知读取耐久事件。发送意图先提交，发送后的失联或重启保留 `unknown`，不自动补发。

## 本地文字转语音

网页可在“音频 → 上传音频”点击“开始录音”，允许麦克风后录制最多60秒，再点击“完成录音”和“上传音频”。需要HTTPS或本机安全上下文；后台/离线/离页会停止采音并放弃尚未上传的录音。录音不会自动上传或调用模型，已有WAV仍可直接选择。

组合入口位于“音频 → 语音对话”：启用ASR、文字和TTS服务后，明确选择已上传录音、语言和声音，依次得到识别、回答与合成媒体。后台/离线/离页暂停，回来只查询原任务，需明确继续。CLI用`npm run cli -- voice-turns schema`发现输入和恢复命令；完整预算、账本与清文见[有限语音回合合同](../../contracts/voice-turns.md)。生成不授权或播放，流式语音与真实模型质量另验。`npm run test:recording`运行PCM及浏览器录音检查；浏览器须支持模拟麦克风，可通过`LIMEIOT_BROWSER_EXECUTABLE`指定独立测试浏览器。

先启用[媒体服务](../../contracts/media.md)，再为同一个网关进程配置 `LIMEIOT_TTS_URL`、`LIMEIOT_TTS_MODEL` 与 `LIMEIOT_TTS_VOICES`。本地提供方须接受 `POST /v1/audio/speech`并返回完整PCM WAV，具体格式、期限与隐私边界见[语音合同](../../contracts/speech.md)。Ollama规则草案不提供TTS。

仓库提供可选的[sherpa CPU服务](../../providers/sherpa-tts/README.md)，使用项目私有Python环境和仓库外模型。先准备固定摘要配置、核对声音编号并启动服务，再将网关指向其本地origin。服务不下载模型，模型许可、真实音质和目标部署性能须单独核对；机器配置见[Schema](../../providers/sherpa-tts/config.schema.json)。

在输入JSON中填写text、voice、retain_seconds及未来90秒内的expires_at，然后执行：

```sh
npm run cli -- schema speech-syntheses.create
npm run cli -- speech-syntheses create --space-id space-demo --input ".dev/speech-input.json" --idempotency-key speech-01
npm run cli -- speech-syntheses resolve speech-01 --space-id space-demo
```

成功仅返回media_id；到原音频管理入口创建音箱授权，再单独播放。unknown继续占用语音预算，明确放弃输出使用 `speech-syntheses discard speech-01 --space-id space-demo`，不保证提供方已停止计算。`npm run test:speech`运行合同及软件旅程，不验证真实模型质量。

家庭网页打开“音频 → 文字转语音”，填写文本、声音和保留时间，再点击“生成音频”。成功后到“播放授权”选择音箱并明确授权，最后在设备页播放。断线或结果未知时使用“查询原任务”；需要放弃时单独确认。浏览器须支持安全上下文和Web Locks，记录不可用时暂停提交。`npm run test:speech:web`运行语音网页和已有音频旅程，使用确定性提供方及软件音箱。

## Zigbee运行中接入

将[v2协调器示例](zigbee-coordinator.example.json)复制为本安装的来源配置，替换串口、协调器IEEE和ID，使用绝对路径设置`LIMEIOT_ZIGBEE_CONFIG`后启动网关。不预建待添加的逻辑设备；由所有者CLI查询已知目标IEEE/端点、核对候选并明确绑定，已提交绑定才驱动采样。步骤见[CLI](../../packages/cli/README.md#运行中接入只读来源)，字段及v13恢复规则见[来源合同](../../contracts/observation-sources.md)。

来源配置不开放入网，不迁移已有静态设备；静态来源语义仍受原配置摘要保护。家庭网页打开“设备接入”，在“Zigbee设备”中查询、核对并确认添加；已接入列表支持明确撤销和重新接入，丢响应到“接入操作记录”查询原操作，不重新提交。完整浏览器边界见[来源合同](../../contracts/observation-sources.md#家庭网页接入与恢复)，原生客户端入口待开发。软件检查入口为`npm run test:zigbee:gateway`，不连接硬件。

## 当前运行边界

开发脚本只监听回环地址；CLI使用所有者Bearer，浏览器与原生端使用独立会话。网关校验精确Host/Origin；非回环监听必须配置HTTPS来源并放在受控TLS入口之后。NAS清单不发布内部HTTP或明文MQTT。Broker禁止匿名并限制各设备Topic；这些能力不等于设备mTLS/认领、多用户授权或公网远程交付。

最多 64 台设备、4096 个命令、64 条规则、1024 个运行和 4096 个事件去重身份；达到上限拒绝新写入。事件读取每批最多 100 条，保留最近约 5000 条，过旧游标明确返回 `event_gap`。当前持久化采用小规模聚合快照；规模化和正式迁移需另行实现。

本地图片观察先启用媒体服务，再设置`LIMEIOT_VISION_URL`与`LIMEIOT_VISION_MODEL`，按需设置`LIMEIOT_VISION_CA_FILE`。家庭网页打开“视觉”；CLI使用`schema vision-observations.create`、`vision-observations create/resolve/discard`。只接单张静态PNG/JPEG与明确问题，图片和问题只保存摘要，结果不控制设备。完整边界见[视觉合同](../../contracts/vision.md)，软件入口`npm run test:vision`；真实视觉质量与完整NAS容器另验。

本地文字生成同样先启用媒体存储，再设置`LIMEIOT_TEXT_URL`与`LIMEIOT_TEXT_MODEL`，私有CA用`LIMEIOT_TEXT_CA_FILE`。家庭网页“对话”保留当前页面的有限上下文，后台、离线和离开时清除；CLI使用`schema text-generations.create`及`text-generations create/resolve/discard`。模型只返回文字，不能控制设备。正文输入不入快照，输出默认保留10分钟，原请求只查不补发；完整限制见[文字合同](../../contracts/text.md)，协议验证入口`npm run test:text`。已安装的真实模型使用[真实验收入口](../../contracts/text.md#真实模型验收)`npm run test:text:live`；它要求明确标签与私网数字地址，创建独立软件安装，不自动下载或替换模型。

没有实机、NAS 镜像、多用户授权、ESP-IDF SDK、证书生命周期、签名 OTA、Go 控制面或生态桥接验收。官网与文档中心在 `iotweb`，不属于本地模拟进程。
