# LimeIoT

AI-first 的开源智能物联与能力组合平台。连接文字、视觉、图像、语音等多模态智能与真实设备，支持开发者和商家组合出玩具、机器人、智能家居、教育、陪伴等产品，并向企业、教室、健身等空间扩展。以自研物模型、Rust 本地网关和统一工具合同支撑 Agent 开发与运行。

仓库：<https://github.com/limecloud/iot>。中文名称：青柠物联。

## 当前状态

已实现首个可运行的本地模拟闭环：自研物模型与规则子集、Rust 网关、SQLite 耐久状态与事件日志、MQTT 5 适配器、灯光/按钮模拟设备、HTTP/SSE 和 JSON CLI。已验证命令幂等、设备回执、按钮联动、重复与历史事件拒绝、丢失回执及重启恢复。

已加入 NAS 家庭 PWA、所有者会话、规则预演/启停、原操作恢复、HTTPS 容器清单和一致性备份恢复。iOS 使用 Swift/SwiftUI，Android 使用 Kotlin/Jetpack Compose；两端客户端库已通过真实网关与模拟设备联调，Android 调试 APK 已构建通过。C 设备核心、NAS 设备 mTLS 与离线 NVS 工具已通过宿主验证；ESP-IDF 目标编译、实机认领、OTA、云控制面和生态适配仍在开发。完整状态见 [实施计划](docs/24-实施计划与进度.md)。

已加入本地 Ollama 文字联动草案，CLI、家庭 PWA 和原生客户端共用生成、原键恢复、预演和明确启用流程。模型经窄接口适配，只取得设备/物模型上下文，不拥有部署或设备执行权限。合同与故障检查通过，真实模型的完整意图质量验收尚未通过。配置与检查见[本地模型](deploy/dev/README.md)。语音、视觉、通用 Agent 与组合包仍在开发。

已加入独立 [Go/Gin/MySQL 控制面](server/README.md)：私有凭据、标准OIDC、受众隔离会话、空间、Ed25519配对与撤销历史。Rust网关和家庭PWA已支持本地审核、明确批准、未知结果核实及NAS机器密钥备份恢复。`npm run test:pairing` 使用临时MySQL、真实Go/Rust/Broker及浏览器验证；`test:control` 可独立检查控制面。远程中继、Console/Admin页面和真实LimeCloud接入仍在开发。

可选出站WSS机器连接已接通，包含一次性挑战、当前绑定核对、心跳和撤销，`npm run test:relay` 验证真实TLS、两端重连及本地继续控制。配置见 [NAS](deploy/nas/README.md)，协议见 [机器连接](contracts/control-relay.md)；当前连接只认证和保活，尚不转发设备动作。

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

Agent 入口：[llms.txt](llms.txt)、[机器文档目录](docs/catalog.json)、[需求追踪](docs/requirements.json)、[工具合同](contracts/tools/catalog.json)。执行 `npm run cli -- schema` 发现本版本工具；在线能力通过 `capabilities list --space-id space-demo` 获取。设计示例不自动变成设备控制输入。

首个MVP为桌面互动环境灯：三个低压Wi-Fi节点＋本地网关，交付NAS私有化版和Cloudflare + Railway上的LimeIoT官方云服务版，按需接入LimeCloud账号和模型。硬件采购与预算见 [BOM](docs/19-硬件选型采购与BOM.md)，部署边界见 [部署设计](docs/22-本地开发部署与运维.md)。

本仓库管理开源核心、工程规范及规划中的自部署管理界面。品牌官网和文档中心的页面、主题与指南源码在私有 `iotweb` 仓库的 `src/docs` 维护，共用官网域名的 `/docs/` 路径；不在本仓库建立文档站应用。范围见 [开源与商业化](docs/25-开源许可生态与商业化.md)。

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
