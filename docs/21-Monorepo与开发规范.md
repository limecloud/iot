# Monorepo 与开发规范

更新日期：2026-11-01。状态：目标工程结构与已实现子集并存；已建立 Cargo workspace、网关核心/适配器、CLI、模拟器、合同及开发验收入口，具体范围见24。其余目录按实际需求建立。

## 1. 目录与责任

```text
iot/
  contracts/                  # 正式机器合同和兼容矩阵
    thing-model/ mqtt/ api/ automation/ tools/ packages/
  firmware/
    components/limeiot_core/ # 原生生命周期与通信
    boards/ drivers/ products/
  gateway/
    crates/                  # 核心、状态、规则、任务、身份与Port
    adapters/                # MQTT、无线、生态和存储实现
  services/
    control-plane/           # NAS/云共用，单Go module
      cmd/api/ cmd/migrate/
      internal/              # 领域用例、装配与LimeCloud适配器
    intelligence/            # 模型和媒体应用服务，按实际隔离需求建立
  applications/              # 玩具、家庭、教育等应用，业务各自内聚
  apps/
    console/                 # 通用用户/开发者控制台，官方云和私有化复用
    admin/                   # 通用实例管理，官方云复用其开源基础能力
    home/                    # NAS本地家庭PWA
    ios/                     # Swift/SwiftUI原生客户端与LimeIoTKit
    android/                 # Kotlin/Compose原生客户端与JVM核心
  packages/
    cli/ sdk-typescript/ ui/ # CLI、生成绑定和共享表现
  hardware/                  # BOM、板卡、装配与夹具
  tools/                     # 模拟器、生成器、回放与诊断
  tests/                     # 跨模块合同、集成及实机任务
  docs/                      # 需求、规范、证据入口
  deploy/
    nas/                     # Compose清单、持久化与本地入口
    cloudflare/              # Worker静态资源和固定代理
    railway/                 # Go镜像、迁移和健康检查合同
```

目录是责任边界，不意味着每项都必须独立服务或包。当前使用单 Cargo Workspace、npm Workspaces、Swift Package/Xcode工程与Gradle多模块；云端按实际实现建立单Go module。无复用需求时不拆通用框架。

### 1.1 MVP实际建立的范围

已建立`contracts/`、`gateway/`、`firmware/`、`packages/cli/`、模拟器、`apps/home`、`apps/ios`、`apps/android`及开发/NAS部署入口。固件含C核心、ESP-IDF适配器/产品工程和离线配置工具，验证范围见[固件入口](../firmware/README.md)。Go控制面和Console/Admin在对应功能实施时建立。官网和文档中心在私有 `limecloud/iotweb` 统一构建，文档站源码为 `iotweb/src/docs`；本仓库 `docs/` 保留工程规范和公开合同说明，不建立文档站应用。`applications/` 和独立 `intelligence/` 在实际出现需求时再建立。

| 部分 | 选型 | 与LimeCloud的关系 |
| --- | --- | --- |
| 网关 | Rust/Tokio、SQLite、可替换MQTT适配器 | IoT专属领域，自主实现 |
| 固件 | ESP-IDF C/C++、CMake、板级配置 | C3原生SDK；不移植Cloud后端代码 |
| 服务端 | Go/Gin、`database/sql`及MySQL驱动、同进程任务/Outbox | 沿用模块化单体方法；独立Go module，不共享其私有包或数据表 |
| 前端 | React、TypeScript、Vite、Tailwind、i18next/react-i18next；家庭界面PWA | 开源Console/Admin/Home共用合同；官网和文档在iotweb内使用Astro统一构建 |
| iOS | Swift 6、SwiftUI、URLSession、Keychain，iOS 17+ | 独立原生界面，复用IoT API合同；不依赖Cloud私有包 |
| Android | Kotlin、Jetpack Compose、Keystore，API 26+ | 独立原生界面，JVM核心隔离HTTP传输与界面 |
| Agent工具 | Node.js CLI、JSON/NDJSON、共享Schema及生成SDK | 沿用动作合同、原操作查询；不以Shell文本作为MCP业务API |
| 工作区 | npm Workspaces + Cargo Workspace + Swift Package + Gradle模块；规划单Go module | 一个IoT仓库管理；Cloud保持独立仓库/API依赖 |

2026-11-01参考工作树：Go 1.26.0声明、toolchain 1.26.10、Gin 1.11.0、Node≥22.12.0、pnpm 10.28.2、React 19.2.3、TypeScript 5.9.3、Vite 7.3.1。它们是参考观察，IoT实施时须结合ESP-IDF/Rust及部署环境验证后锁定，不把“与Cloud版本完全一致”作为无必要约束。

LimeCloud客户端适配放在Go服务的外部适配包，基于其正式协议/生成合同接入。物模型、设备驱动、规则和硬件定义留在IoT；不把相邻`../cloud`路径、Git子模块或生产数据库设为本仓库构建前提。

### 1.2 开源与私有仓库边界

`limecloud/iot` 是开源核心 monorepo，覆盖固件、网关、控制面、CLI/SDK、工程规范、NAS 界面和完整自部署需要的通用 Console/Admin。官网与文档中心已在私有 `limecloud/iotweb` 仓库维护，共用一个域名；官网构建不依赖本仓库的相邻检出。官方商业运营扩展按真实需求私有维护；完整自部署必需功能保留在开源核心。

GitHub可见性以仓库为单位，公开monorepo不能通过目录或分支设置实现私有源码。私有官网不作为开源构建/测试前提，不通过相邻路径或私有子模块强制拉取。私有侧消费正式版本的SDK/UI包或API合同，并保留适用许可与归属；不复制维护第二套核心。

## 2. 合同驱动与 Agent 可读性

正式 `contracts/` 是实现阶段唯一机器合同来源，生成 Rust/Go/TypeScript/C 绑定和工具投影。`docs/examples/` 当前是设计夹具，迁入正式合同时同步消费者，避免长期维护两套互不校验定义。

代码目录提供职责、入口、必要上下文、构建与验证说明。Agent 可从文档机器目录找到具体规范、正负例和验证入口；能力状态和型号证据不由 README 文字猜测。

## 3. 依赖原则

核心只依赖自有实体与消费方窄接口，适配器依赖核心。外部 SDK、厂商协议、数据库与模型服务经明确边界使用；普通算法和基础标准库不做无意义包装。

KISS：优先直接函数和组合；YAGNI：未进入阶段的目录、框架与通用插件系统不预建；DRY：模型、权限、错误、状态与语言来源唯一；SOLID：领域、执行、协议与表现分责，不建立包含所有功能的服务对象。

## 4. 构建与验证入口

当前实际入口为`npm run build`、`npm run check`、`npm test`、`npm run test:e2e`、`npm run test:browser`、`npm run test:ios`、`npm run test:android`、`npm run test:firmware`、`npm run test:provisioning`、`npm run test:inference`和`npm run dev`。`test:inference`及原生联调使用明确的假提供方，不证明模型质量；显式配置真实已安装模型后，`npm run test:inference:live`验证实际推理与模拟设备执行链。原生应用整包分别使用Xcode和Gradle。固件宿主检查与目标芯片构建分开记录；后者尚未通过，不发布可安装镜像或已验收烧录命令。

Rust 使用 fmt/clippy/test，Go 使用 fmt/vet/test，前端使用类型检查/测试/构建，固件使用固定 ESP-IDF 工具链。工具链和依赖锁定，安装使用项目级环境，不隐式修改系统设置或全局包。

规划中 Console/Admin 输出静态制品，`home` 随 NAS/网关镜像打包；官网与 `/docs/` 在 iotweb 输出一个制品。私有集中控制面复用 Console/Admin，官网不是 NAS 必装服务。网关镜像目标为 `linux/amd64` 与 `linux/arm64`，Go 服务复用同一 Dockerfile 构建 Railway/NAS 目标。当前只有本机模拟验收，不将镜像规划或交叉编译等同实机通过。

开源 Console/Admin 与控制面规划使用同一 IoT release 清单，关联固件、网关和合同修订；官网及文档中心使用 iotweb 自己的修订和发布记录，核对所引用的产品版本。修改 `contracts/` 时检查受影响消费者；只改指南无需构建所有固件。具体部署目标见 [22](22-本地开发部署与运维.md)。

## 5. 变更与版本

每项变更同步原领域、合同、消费者、指南和有意义的验证；不为未发布内部实现保留无需求的兼容层。已发布合同、持久记录、安全代次和设备历史的变更须有明确迁移。

软件采用三段语义版本；协议、模型、动作合同、硬件、映射和包分别版本化。发行清单描述兼容组合，不强制所有固件和服务锁步。

## 6. 代码与测试质量

使用当前代码库一致的注释语言，注释解释不明显的不变量与边界。测试验证业务语义、失败和恢复，避免复制实现逐行断言；低影响纯文档修改不扩张应用测试范围。

用户或其他会话的改动应保留；未经明确请求不创建分支、提交、推送或发布。源提交、构建输入和实机版本必须对应，防止用旧制品验收新源码。

## 7. 交付完成标准

需求/用例有映射，合同可解析，消费者一致，权限和失败路径完整，模拟与实机证据分开，制品有来源和恢复说明。仅能构建、页面存在或示例通过不能判为产品交付。
