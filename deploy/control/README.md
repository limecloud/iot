# 控制面与通用 Web

Console、Admin 与 Go 控制面可使用同一 origin，路径分别为 `/console/`、`/admin/` 和独立 `/api/console/v1`、`/api/admin/v1`。两类会话保持隔离；官网和同站文档仍由独立 `iotweb` 发布。本目录不依赖官网仓库、LimeCloud 私有包或平台数据库。

## 本机及 NAS 私有实例

完整 NAS 安装见 [同机工作台安装](../nas/README.md#完整本地版安装)：网关、Go 控制面和 MySQL 由一组 Compose 管理，对外共用一个 HTTPS 入口；根路径整合本地任务，`/local/` 保留独立维护入口。以下步骤适用于单独安装控制面的情况。


按 [控制面运行说明](../../server/README.md) 准备专用 MySQL、独立密钥、所有者及管理员凭据和 origin。业务账户只需业务读写权限，DDL 使用单独迁移账户显式执行。

在仓库根构建：

```sh
npm ci
npm run build:control
cargo build --locked -p limeiot-model-validator
go -C server run ./cmd/migrate
LIMEIOT_MODEL_VALIDATOR="$PWD/target/debug/limeiot-model-validator" \
LIMEIOT_CONSOLE_WEB_DIR="$PWD/apps/console/dist" \
LIMEIOT_ADMIN_WEB_DIR="$PWD/apps/admin/dist" \
go -C server run ./cmd/api
```

这里沿用已配置的 `LIMEIOT_*` 服务变量。只允许字面回环 HTTP；局域网和公网安装使用精确 HTTPS origin，由反向代理保留原 Host。网页和 API 同源，前端不保存长期登录凭据，不缓存家庭 API，不安装跨站 Service Worker。

1. 打开 `<origin>/console/`，使用所有者凭据或已登记的 OIDC 登录。
2. 创建空间，在“网关管理”申请读取/控制权限并生成配对信息。
3. 在 NAS 本地家庭界面的“网关配对”粘贴信息，核对账号和权限后批准。
4. 按 [NAS 配置](../nas/README.md) 显式启用出站 WSS，回到控制台读取设备与原操作。
5. 管理员另行打开 `<origin>/admin/`；该身份只查看实例状态和脱敏绑定摘要。

远程控制前在当前浏览器保存完整原操作；存储失败不发送。响应丢失或重新登录后，使用“查询结果”。空间和配对请求恢复沿用原请求键，命令恢复只读取原记录及显式核实，不重发 create。

## 容器与 Railway 制品

```sh
docker build -f "deploy/control/Dockerfile" -t limeiot-control:local .
```

构建输出包含 Go 服务、独立显式迁移程序、Rust物模型校验器和两份静态 Web，不包含官网或文档源码。运行用户为10001，密钥文件应只对该运行身份可读，通过只读 secret 挂载配置；不把 Secret 写进镜像、构建参数或浏览器。校验器默认从 PATH 发现，也可用 `LIMEIOT_MODEL_VALIDATOR` 指定绝对路径；缺失时仅校验接口返回503，不影响其他服务入口。

macOS ARM64 开发机也可在项目内交叉构建 Linux ARM64/AMD64 制品，减少容器中的编译开销：

```sh
npm run test:control:artifacts
npm run build:control:artifacts -- --platform linux/arm64 --output "$PWD/.dev/control-arm64-build"
python3 "tools/build-control-artifacts.py" verify --directory "$PWD/.dev/control-arm64-build"
python3 "tools/build-control-artifacts.py" image --directory "$PWD/.dev/control-arm64-build" \
  --tag "limeiot/verification:control-arm64-local"
```

Go 版本取固定的 `1.26.10`，关闭 CGO，两个程序分别构建；Rust 工具链与[网关构建](../nas/README.md#项目内-linux-交叉构建)共用缓存与锁。需要 Node.js 24.21+、Python 3.12+、已有项目依赖及 Docker。依赖首次取得仍需联网。输出清单包含源码、工具链和全部制品摘要，验证静态 Go ELF、动态 Rust ELF、两份网页及正式 Dockerfile 的运行层；构建过程中输入变化则拒绝打包。工具仅组装本地 `limeiot/verification` 镜像，不执行迁移或发布。

已有可信且验证通过的同平台 NAS 制品时，`build` 可追加 `--rust-artifacts "/absolute/nas-artifacts"`，只复用其中的校验器。工具必须核对原制品、全部 Rust/Cargo 源码、字面量 `include_str!`/`include_bytes!` 所引用合同与固定工具链；新增构建脚本、动态 include、源码或嵌入文件变化均拒绝复用。Go 与 Console/Admin 仍从当前源码构建。`image --runtime-base` 仅接受运行依赖前缀匹配的同平台本地镜像，不能使用网关的运行依赖层冒充控制面基础层。

API 默认使用平台 `PORT`。Railway 选择本 Dockerfile、仓库根为构建上下文，就绪探针为 `/health/ready`；迁移应作为独立、获准的发布步骤运行 `limeiot-migrate`，不作为 API 启动动作。LimeCloud/OIDC 应用需真实登记后配置，不能以开发夹具代替。

可选模型签名使用独立私钥的只读Secret文件及 `LIMEIOT_MODEL_RELEASE_KEY_FILE` 绝对路径，容器运行身份须有读取权限且文件模式为0600。不要复用会话加密密钥、设备证书私钥或网关机器私钥。未提供时新发布503，历史下载与原决定读取仍工作；配置了错误材料则拒绝启动。发布v5迁移须单独执行，API不自动升级，详见[发布合同](../../contracts/model-release.md)。

本地构建、宿主进程浏览器联调与容器验收分别报告。当前Linux ARM64完整本地工作台已通过Compose安装、显式迁移、16菜单、统一业务、控制面故障维护和新目录空数据库恢复，见[整包证据](../../docs/evidence/2026-11-04-companion-nas.json)。本轮Go与Console/Admin从当前源码构建，Rust校验器按依赖校验复用；镜像内文件逐项核对。未据此声明x86_64、NAS实机或Cloudflare/Railway正式部署通过。

通用 Console/Admin 复用 `packages/control-ui/src/workspace`，与完整 NAS 采用相同的导航、主题、产品校验和发布组件。2026-11-02 已通过 Go race/vet 与10项真实 MySQL、HTTP、WSS、Rust/MQTT和浏览器回归；包含受众隔离、手机授权、原请求恢复和不重放。容器安装与恢复使用独立检查 `npm run test:nas:platform`，结果不与宿主进程检查混用。
