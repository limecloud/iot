# LimeIoT

AI-first 的开源智能物联与能力组合平台。连接文字、视觉、图像、语音等多模态智能与真实设备，支持开发者和商家组合出玩具、机器人、智能家居、教育、陪伴等产品，并向企业、教室、健身等空间扩展。以自研物模型、Rust 本地网关和统一工具合同支撑 Agent 开发与运行。

仓库：<https://github.com/limecloud/iot>。中文名称：青柠物联。

当前源码版本为 **v0.7.0**，变更与验收边界见 [版本记录](CHANGELOG.md)。版本标签不代表已发布镜像、手机安装包或完成硬件验收。

## 当前状态

已实现首个可运行的本地模拟闭环：自研物模型与规则子集、Rust 网关、SQLite 耐久状态与事件日志、MQTT 5 适配器、灯光/按钮模拟设备、HTTP/SSE 和 JSON CLI。已验证命令幂等、设备回执、按钮联动、重复与历史事件拒绝、丢失回执及重启恢复。

已加入 NAS 家庭 PWA、所有者会话、规则预演/启停、原操作恢复、HTTPS 和一致性备份恢复。Linux ARM64整套容器已通过HTTPS、MQTT命令、设备mTLS/ACL/撤销及恢复检查，入口为 `npm run test:nas:container`；x86_64及指定NAS型号待验收。iOS使用Swift/SwiftUI，Android使用Kotlin/Jetpack Compose；独立库已联调，Android调试APK构建通过，两端App实际运行仍待验收。ESP-IDF灯/按钮均已通过C3目标编译，入口为 `npm run build:firmware`；烧录、实机认领、OTA、正式云和生态适配仍在开发。当前ARM64完整本地版另通过14菜单、统一登录、产品签名发布、配对/WSS、故障维护及空数据库恢复，同版网关的文字/TTS/ASR/视觉通过独立协议夹具容器检查，证据见[NAS整包验收](docs/evidence/2026-11-04-text-nas-container.json)。完整状态见 [实施计划](docs/24-实施计划与进度.md)。

已加入本地 Ollama 文字联动草案，CLI、家庭 PWA 和原生客户端共用生成、原键恢复、预演和明确启用流程。模型经窄接口适配，只取得设备/物模型上下文，不拥有部署或设备执行权限。合同与故障检查通过，真实模型的完整意图质量验收尚未通过。配置与检查见[本地模型](deploy/dev/README.md)。有限文字对话与单张图片观察已接入 API、CLI、家庭网页和 SwiftUI/Compose 页面源码；文字对话支持本页有限上下文，见[文字合同](contracts/text.md)。声明式事件组合包已接通CLI、家庭网页和原生客户端源码，详见[组合包合同](contracts/composition.md)；通用Agent与更多组合类型仍在开发。

已加入[本地有限语音识别](contracts/transcription.md)的HTTP适配、API、CLI、家庭网页与SwiftUI/Compose页面源码：选择已上传录音并固定摘要，原任务不重发，识别文本随源录音到期/删除清除，不执行设备操作。NAS媒体快照v3支持转写结果与未知任务恢复。原生库与实际状态层只持久保存去正文观测，后台/离线/退出清文，原任务恢复由 `npm run test:transcription:native:state` 验证。[独立sherpa ASR服务](providers/sherpa-asr/README.md)提供Paraformer Small/Whisper Tiny适配，上游录音经网页、CLI和重启未知恢复的软件集成已通过，25秒分段避免静默截断。两模型在合成中文语音上的质量检查未通过；ARM64协议容器恢复已通过；家庭环境质量、转换权重分发许可、完整原生运行和其他架构继续验收。

已加入[本地图片观察](contracts/vision.md)：通过独立 Ollama 适配器分析单张静态 PNG/JPEG，提供API、CLI、家庭网页“视觉”入口及SwiftUI/Compose“设置 → 图片观察”页面源码。图片和问题正文不入快照，原键查询不重发，未知任务保留预算，结果可明确清除并按期限清文；后台/离线/退出清输入与正文，返回后完成正文需明确查询，观察不产生设备命令。媒体快照v4保留旧版本读取及TTS/ASR共存，`npm run test:vision`验证软件链路，原生合同、库和实际状态层分别见 `test:vision:native:contract`、`test:vision:native`、`test:vision:native:state`。ARM64协议容器恢复已通过；真实视觉模型质量、系统图片选择、完整原生界面运行和其他架构仍待验收。

已加入[本地有限文字转语音](contracts/speech.md)的API、CLI、家庭网页与SwiftUI/Compose页面源码：独立提供方输出有界PCM WAV，任务摘要与原键恢复、未知预算、明确放弃和NAS快照恢复共用平台合同。合成只生成媒体引用，须另行授权并播放。软件合同、390px网页、原生状态层真实网关旅程及ARM64协议容器恢复通过，真实引擎质量、完整原生界面运行与其他架构另验。

已上传录音可通过[有限语音回合](contracts/voice-turns.md)依次识别、生成回答并合成音频，入口为家庭网页“音频 → 语音对话”和CLI的`voice-turns schema`。网页及SwiftUI/Compose“上传音频”另支持明确录制最多60秒的16 kHz PCM WAV，完成后须独立上传；后台、离线和离页停止采音并放弃未上传录音。共用摘要账本、原键查询、后台暂停与明确继续，每阶段最多调用一次，生成不自动播放。软件验证范围以[实施进度](docs/24-实施计划与进度.md)为准；提供方与音箱为协议夹具，原生同页分步组合通过各阶段明确确认衔接，见[原生分步组合](contracts/voice-turns.md#原生分步组合)；真实模型质量、流式语音、原生自动回合与完整App另验。

可选[sherpa CPU提供方](providers/sherpa-tts/README.md)已有真实中文模型经HTTP、网页生成、媒体入库、明确授权与软件音箱逐字节拉取的通过结果。服务与核心隔离，按请求启动有界进程；模型在仓库外，固定依赖与模型摘要。NAS内部网络覆盖已提供，镜像/目标运行、权重分发许可与人工音质尚未验收。

已加入独立 [Go/Gin/MySQL 控制面](server/README.md)：私有凭据、标准OIDC、受众隔离会话、空间、Ed25519配对与撤销历史。Rust网关和家庭PWA已支持本地审核、明确批准、未知结果核实及NAS机器密钥备份恢复。`npm run test:pairing` 使用临时MySQL、真实Go/Rust/Broker及浏览器验证；`test:control` 可独立检查控制面。两端原生云入口源码已接入，实际运行和真实LimeCloud接入仍待验收。

可选出站WSS已接通受限远程API：设备/物模型读取、命令创建和原操作核实；两端当前授权、云端耐久发送意图、设备回执和断流不重放共用原合同。`npm run test:remote` 验证真实TLS/MySQL/Go/Rust/MQTT模拟链路和双进程重启；配置见 [NAS](deploy/nas/README.md)，协议见 [机器连接](contracts/control-relay.md)。默认关闭，当前单副本；不代表实机或公网部署验收。

开源 [Console/Admin](deploy/control/README.md) 已提供空间、配对、设备控制与原操作查询，以及独立管理员的实例状态和脱敏绑定摘要。两份页面由Go同源托管，已接入产品草稿、模型校验/兼容性、签名发布与原决定查询。本地网关另提供所有者明确批准的信任、安装、设备绑定与撤销，NAS界面和CLI共用Rust规则；安装不自动切换设备。`npm run test:models`与`test:model-installation`验证相应模拟链路。OTA管理和完整运营任务仍在开发。

[独立控制面CLI](packages/cli/README.md)通过`npm run cli -- control schema`发现空间/配对/设备与原操作工具，使用独立Console会话。命令先保存原请求，响应丢失后只查旧键；`npm run test:control:cli`验证相应模拟链路。账号与配对秘密保存在私有文件，不输出到模型上下文。

## 运行代码

需要 Rust、Node.js 24.21+ 的 24.x，以及本机 Mosquitto。可在项目目录内构建官方 Broker，无需全局安装：

```sh
npm ci
python3 "tools/bootstrap-broker.py"
npm run test:e2e
npm run dev
```

启动完成后，在另一终端加载开发环境并部署按钮规则：

```sh
source ".dev/local/session.env"
npm run cli -- devices list --space-id space-demo
npm run cli -- rules validate --space-id space-demo --input "contracts/examples/button-light.json"
npm run cli -- rules deploy --space-id space-demo --input "contracts/examples/button-light.json"
```

回到开发进程输入 `button` 并回车，即发送模拟按键。通过 `runs list` 查询关联的 `run_id` 和 `command_id`。详细操作、依赖和边界见 [本地模拟开发](deploy/dev/README.md)。

开发进程同时提供 `http://127.0.0.1:17880` 家庭界面，使用 `.dev/local/session.env` 中的本地所有者凭据登录。NAS 局域网部署使用 [NAS 安装说明](deploy/nas/README.md) 的 HTTPS 入口。原生工程及构建说明：[iOS](apps/ios/README.md)、[Android](apps/android/README.md)。官网和文档不需要安装到 NAS。

设备核心、ESP-IDF 产品工程及离线配置见 [固件入口](firmware/README.md)。`npm run test:firmware` 运行同一 C 核心的宿主和真实 Broker 检查，目标芯片与实机状态单独记录。

从 [文档入口](docs/README.md) 开始，首次阅读建议按 [产品需求](docs/01-产品需求PRD.md) → [总体架构](docs/03-总体技术架构.md) → [MVP 落地蓝图](docs/29-MVP端到端落地蓝图.md) → [实施计划](docs/24-实施计划与进度.md) 进行。

独立产品案例：[Gootuan 咕团](docs/integrations/gootuan/README.zh-CN.md)（[English](docs/integrations/gootuan/README.md)）提供共用平台边界、统一概念图和可执行的触摸/双虚拟灯例子；完整产品设计在[独立 Gootuan 仓库](https://github.com/limecloud/gootuan)。该案例不代表语音、视觉、机器人运动或同步合唱已经验收。

Agent 入口：[llms.txt](llms.txt)、[机器文档目录](docs/catalog.json)、[需求追踪](docs/requirements.json)、[工具合同](contracts/tools/catalog.json)。执行 `npm run cli -- schema` 发现本版本工具；在线能力通过 `capabilities list --space-id space-demo` 获取。设计示例不自动变成设备控制输入。

首个MVP为桌面互动环境灯：三个低压Wi-Fi节点＋本地网关，交付NAS私有化版和Cloudflare + Railway上的LimeIoT官方云服务版，按需接入LimeCloud账号和模型。硬件采购与预算见 [BOM](docs/19-硬件选型采购与BOM.md)，部署边界见 [部署设计](docs/22-本地开发部署与运维.md)。

本仓库管理开源核心、工程规范及自部署Console/Admin和家庭界面。品牌官网和文档中心的页面、主题与指南源码在私有 `iotweb` 仓库的 `src/docs` 维护，共用官网域名的 `/docs/` 路径；不在本仓库建立文档站应用。范围见 [开源与商业化](docs/25-开源许可生态与商业化.md)。

核心、设备集成和终端应用按独立工程组织：领域核心接收通用模型目录，ADB/DLNA可按编译feature选择，TV Agent使用自身Gradle工程交付APK，网页分别维护通用操作恢复、能力控件和接入面板。静态集成随网关程序交付，当前没有动态插件热加载。边界与构建方式见 [工程规范](docs/21-Monorepo与开发规范.md#14-核心集成与独立工程)，软件发行组合和浏览器检查分别使用`npm run test:architecture`、`npm run test:architecture:web`；实际验证与缺口以 [实施计划](docs/24-实施计划与进度.md#467-平台核心可选集成与终端工程边界重构) 为准。

## 设计原则

- 设备层、网关层、服务层、客户端四层协作；本地控制和已部署自动化可离线运行。
- 在现有设备系统与开发框架之上建设平台，首期使用 ESP-IDF；设备系统适配与商业生态接入分别验证。
- 自研物模型、MQTT 应用报文、ESP-IDF IoT Core SDK、Rust 网关、设备状态机与声明式自动化引擎。
- Zigbee、BLE、433 和 Matter 经适配器接入；外部组件的类型和私有语义不进入核心模型。
- 优先支持开发者创造新设备，存量设备按标准、公开接口或厂商授权逐型号适配。
- 提供统一多模态模型与媒体服务；Ollama及其他提供方通过适配器使用，模型调用正式工具完成获准任务。
- API、CLI、任务合同优先面向 Agent，GUI/TUI共用相同任务、权限和恢复语义。
- 通过可验证的能力组合包支撑组合玩具、清洁、陪伴、教育及其他场景应用。
- 身份生命周期和 OTA 管理由平台负责，密码算法、安全库与标准协议栈采用成熟实现。
- HA、ESPHome、zigbee2mqtt 可作为后续兼容对象，平台基础运行不依赖它们。

## 开源与商业化

代码采用 [Apache-2.0](LICENSE)，客户端内LimeIoT图标的独立范围见 [品牌素材](apps/BRAND.md)；第三方依赖与硬件文件的许可范围见 [开源与商业化](docs/25-开源许可生态与商业化.md)。

商业化方向为经过验证的开发套件、家庭套件、设备适配、部署及技术服务；基础本地能力不依赖付费云服务。
