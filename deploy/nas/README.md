# NAS 与 Linux 本地安装

本目录提供完整本地工作台和网关基础包，均可安装在 NAS 或常开的 Linux 主机。完整本地版把控制面、数据库和网关放在同一台机器，不依赖官网、云账号或模型服务。官网与文档中心在独立的 `iotweb` 仓库。

2026-11-02：本轮 Linux ARM64 工作台验收镜像已通过真实 Compose 安装、显式迁移、统一登录、10个同页菜单、MQTT 控制、产品校验/签名发布、明确配对/WSS、故障维护及完整备份恢复。回执为 `.dev/nas-platform-6939c2d0e130e891/result.json`，记录实际镜像 ID；设备使用软件模拟器。x86_64、指定 NAS 实机、可选 Ollama 和官方云公网链路仍需分别验收。未发布正式镜像或升级用户设备，其他新增协议能力以各自证据为准。

## 选择部署方式

现场网关负责 MQTT、设备协议、SQLite 和断网联动，可运行在 NAS、软路由或独立 Linux 小主机。控制面板可以和网关部署在同一台主机，不要求购买云服务。

| 方式 | 现场运行 | 控制面板 |
| --- | --- | --- |
| 完整本地版 | Rust 网关、MQTT、Go 控制面、MySQL | 本机统一工作台，公网不可用仍可使用 |
| 网关基础包 | Rust 网关、MQTT、SQLite | 本地设备控制与维护，也可显式配对官方云 |
| 官方云配现场网关 | Rust 网关、MQTT、SQLite | 使用官方 iotweb，无需自建 NAS 控制面 |

完整本地版与通用 Console/Admin 共用 `packages/control-ui/src/workspace`。设备、自动化、执行记录和设备接入复用 Home 的本地组件；产品、物模型校验与签名发布使用本地 Go 控制面。构建不依赖相邻私有 `iotweb`。完整入口目前使用简体中文；独立 Console/Admin 可通过语言控件切换中英文。

## 完整本地版安装

需要 Docker Engine、Compose、Python 3 和 OpenSSL。使用拥有数据目录的非 root 用户，在 `iot` 根目录执行；替换实际 NAS 局域网地址：

```sh
python3 "deploy/nas/manage.py" init --mode private \
  --directory "$PWD/.dev/nas-platform" \
  --origin "https://192.168.1.20:8443"

docker compose --env-file ".dev/nas-platform/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" build gateway control

docker compose --env-file ".dev/nas-platform/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" up -d --wait control-mysql

docker compose --env-file ".dev/nas-platform/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" run --rm migrate

docker compose --env-file ".dev/nas-platform/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" up -d
```

需要软件模拟灯和按钮时，最后一条命令增加 `--profile simulation`，放在 `up` 之前。真实设备须按设备证书及接入流程配置。

信任 `authority/ca.crt` 后访问初始化时的 HTTPS 地址。根路径是统一工作台，使用 `secrets/owner-token` 一次登录控制面和本地网关；凭据只交换为各自的 HttpOnly Cookie，不写浏览器持久存储。`/admin/` 使用独立 `platform-secrets/admin-token`，没有家庭所有者权限。`/local/` 为独立维护入口，Go 或 MySQL 故障时仍可连接 Rust 网关。

`platform-secrets/` 另存 AES 密钥、Ed25519 模型签名私钥、MySQL root、运行、迁移和备份凭据。运行服务只挂载自己需要的文件；控制面运行账号没有建表权限，迁移账号仅由显式迁移容器使用。MySQL 数据保存在 `mysql/`，不映射宿主数据库端口。

网关仅允许配对本次安装的精确 origin，使用本地 CA 验证 HTTPS/WSS。第一次远程链路配对仍需创建空间、生成配对信息、在同一页的“本地配对批准”中核对并批准，不自动赋予权限。设备控制和已部署自动化本身不依赖配对。在设备和操作记录页，通过顶部空间选择器选择“本机网关”可直接使用本地能力；选择已管理空间则复用通用工作台的远程设备和操作记录。自动化与设备接入仍明确作用于本机网关。网关访问自身 HTTPS 入口必须可达，因此正式安装使用 NAS 局域网地址或容器可解析的域名，不把容器自己的 `127.0.0.1` 作为配对目标。

完整本地版备份同时包含 SQLite、MySQL SQL 快照、签名密钥、机器身份、证书和固件制品。先停止写入服务，保持 MySQL 运行：

```sh
docker compose --env-file ".dev/nas-platform/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" \
  --profile simulation stop control gateway lamp button
python3 "deploy/nas/manage.py" backup --directory "$PWD/.dev/nas-platform" \
  --output "$PWD/.dev/nas-platform-backup"
```

备份命令检查此安装项目的写入服务均已停止，不会自动停止其他实例。备份完成后按安装时相同参数执行 `up -d`。恢复到空目录后，先启动新 MySQL，导入快照，再显式验证迁移，最后启动服务：

```sh
python3 "deploy/nas/manage.py" restore --directory "$PWD/.dev/nas-platform-restored" \
  --backup "$PWD/.dev/nas-platform-backup"
docker compose --env-file ".dev/nas-platform-restored/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" up -d --wait control-mysql
python3 "deploy/nas/manage.py" restore-control --directory "$PWD/.dev/nas-platform-restored"
docker compose --env-file ".dev/nas-platform-restored/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" run --rm migrate
docker compose --env-file ".dev/nas-platform-restored/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.platform.yaml" up -d
```

原安装需先停止，避免端口冲突及同一机器身份同时连接。恢复仅允许空控制面数据库；重复导入被拒绝，不覆盖现有表。

## 网关基础包初始化

需要 Docker Engine、Compose、Python 3 和 OpenSSL。使用拥有数据目录的普通用户初始化。下面使用 NAS 的局域网 IP，替换为实际地址；地址须与浏览器及原生客户端访问的地址完全一致。

在 `iot` 根目录执行：

```sh
python3 "deploy/nas/manage.py" init \
  --directory "$PWD/.dev/nas" \
  --origin "https://192.168.1.20:8443"
docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" --profile simulation up --build -d
```

只有独立 `docker-compose` 命令时，用它替换 `docker compose`。镜像可在 ARM64 或 x86_64 Linux 上分别构建；本机容器环境验证与具体 NAS 型号实机验收分开记录。

初始化生成以下文件，不覆盖非空目录，也不回显凭据：

| 路径 | 用途 |
| --- | --- |
| `secrets/owner-token` | 所有者登录凭据 |
| `secrets/gateway-identity.pk8` | 独立Ed25519机器身份及配对材料加密来源，0600 |
| `secrets/*-password`、`secrets/mqtt-passwords` | 独立网关/设备密码及 Broker 摘要 |
| `config/gateway.json`、`config/mqtt-acl` | 初始模型绑定与设备 Topic 授权；动态模型/绑定保存在SQLite |
| `data/` | SQLite WAL、事件与虚拟设备文件 |
| `firmware/` | 不可覆盖的本地固件制品缓存，仅edge以只读卷挂载 |
| `tls/server.crt`、`tls/server.key` | HTTPS 服务证书和私钥 |
| `authority/ca.crt`、`authority/ca.key` | 本地 CA 与签发材料 |
| `device-authority/` | 独立设备 CA 私钥、签发数据库和已签证书，仅管理命令使用 |
| `broker-tls/` | 设备 Broker 服务证书/私钥、设备 CA 公钥与撤销列表 |
| `compose.env`、`installation.json` | 安装路径、所有者 UID/GID 与精确来源 |

`authority`、`device-authority` 不挂载到运行容器。公开 Web 入口只挂载 HTTPS 服务证书目录；Broker 只挂载 `broker-tls`，不会取得 CA 签发私钥。备份包含私钥，保存在仅所有者可读的介质中。

## 打开家庭界面

在访问设备上安装并信任本次生成的 `authority/ca.crt`，或者使用自己的受信服务证书替换 `tls/server.crt` 和 `tls/server.key`。iOS 手动安装本地 CA 后，还需在系统证书信任设置中启用信任。Android 客户端允许系统及用户安装的 CA，始终验证证书和主机名。

浏览器打开初始化时的 HTTPS 地址，使用本地 `secrets/owner-token` 登录。iOS 和 Android 原生客户端使用相同地址及凭据；工程见 [iOS](../../apps/ios/README.md)、[Android](../../apps/android/README.md)。

家庭界面支持设备开关/亮度、原操作恢复、事件联动校验/预演/启用/停用、执行记录及关联运行。浏览器凭据交换为 HttpOnly 会话；写请求校验 Origin 与 CSRF。网关重启后重新登录，操作与部署记录继续保留。

`simulation` Profile 启用两个独立设备进程。触发按钮事件：

```sh
printf '%s\n' '{"data":{"count":1}}' | \
  docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" --profile simulation attach button
```

若 Compose 不支持管道 attach，使用 `docker attach` 连接本项目的 button 容器，输入一行 `{"data":{"count":1}}`。先在界面启用规则，再查看关联运行与设备回执。断开 attach 时保留容器运行。

## 网络和数据

由Nginx入口发布HTTPS和设备mTLS 8883，可通过 `LIMEIOT_MQTT_TLS_PORT` 调整后者的NAS映射端口。`LIMEIOT_BIND_HOST` 默认 `0.0.0.0`，仅供宿主反向代理或本机验证时可设为 `127.0.0.1`。Nginx连接入口网络和内部网络；网关只连接内部网络，不直接发布端口。MQTT入口透传TCP，TLS与设备证书仍由Broker验证；Nginx不持有设备CA或Broker私钥。

网关HTTP位于内部容器网络，明文MQTT只在该网络命名空间的回环地址监听。Nginx通过Docker内置DNS每5秒刷新网关地址，网关替换后入口无需重建。HTTPS入口保留精确Host；网关拒绝其他Host、跨来源请求和明文远程来源。自有NAS反向代理必须保留相同边界，不直接发布内部HTTP。内部网络限制核心服务外连，入口网络负责接收和返回宿主连接，不宣称Nginx本身具有网络层出站隔离。

基础包不调用公网服务。断公网不影响已经运行的网关、设备模拟器和规则；首次构建仍需取得基础镜像与依赖。家庭 PWA 只缓存静态外壳，API 与家庭状态不写入离线缓存。断开网关后禁用控制，不能把旧观测当作在线状态。

SQLite 数据目录使用可靠的本地磁盘，不放 SMB/NFS 挂载。当前为单网关实例的小规模耐久快照，容量上限见 [本地开发](../dev/README.md)。不要同时启动多个网关写同一数据库。

## 可选网关配对

独立控制面部署与迁移见 [server](../../server/README.md)。先由安装者批准实际HTTPS origin，再叠加出站网络：

```sh
LIMEIOT_CONTROL_ALLOWED_ORIGINS="https://control.example.com" \
docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.control.yaml" \
  --profile simulation up --build -d
```

将域名替换为实际控制面，可用逗号列出最多8个精确origin，不含路径或末尾斜线。原生设备仍只连本地Broker；这个覆盖只增加网关出站网络，不发布内部HTTP。私有控制面CA放在安装目录 `config/control-ca.crt`，并在命令中增加 `LIMEIOT_CONTROL_CA_FILE="/config/control-ca.crt"`。TLS主机名验证始终开启。

新安装已生成 `secrets/gateway-identity.pk8`。旧安装尚无此文件时，在**确认从未有机器密钥或配对记录**后，使用已构建的 `target/debug/limeiot-gateway identity-init "/absolute/nas/secrets/gateway-identity.pk8"` 离线生成；只创建新文件，拒绝覆盖。原密钥丢失时从可信备份恢复，不另生成密钥冒充原机器。

控制面所有者通过Console或API创建空间和120秒配对请求，将完整返回JSON交给本地所有者。家庭PWA打开“网关配对”，读取信息并核对目标账号、控制面与权限，再选择“批准配对”。浏览器只保存原操作键，配对码在网关中加密保存。Console与本地家庭页面使用独立身份；Admin只提供受限运营信息，不代替家庭所有者批准。

响应丢失或网关重启后使用“核实原配对”，仅查询原绑定，不重复claim。结果未知且已经批准的记录阻止新配对绕过，直到核实或明确撤销。本地撤销立即生效，不依赖云；不会自动撤销云侧记录。若要重新配对，同一机器的旧活动云绑定需由云所有者撤销。状态“已配对”仅表示绑定建立。

可选机器连接默认关闭。在上述Compose命令增加 `LIMEIOT_CONTROL_RELAY_ENABLED=1`，网关将为已批准的活动绑定建立出站WSS；只使用相同origin和原机器私钥。独立挑战、持续心跳、重启/断流重连与两侧撤销已通过真实TLS进程检查。连接状态由本地 `control-pairings.list` 的connection字段和Console连接状态API分别读取。Console与独立CLI已提供受限设备/模型读取、命令创建和原操作核实；网关离线拒绝新控制，重连不重放命令。可选云覆盖的完整容器和公网代理路径仍需分别验收。

## 设备模型接入

家庭页面的“设备接入”提供发布者信任、签名模型安装、设备绑定和原操作查询。先粘贴发布者信任材料，并填写通过独立渠道核对的公钥指纹；界面不会自动代填确认指纹。随后选择已信任发布者、粘贴签名制品，读取本地当前版本后明确安装。安装不改变设备；填写设备编号、选择已安装模型、读取当前绑定后明确绑定。

切换后设备须以新模型修订重新握手，界面不会把旧观测当作新状态。撤销信任会停止关联设备的新控制。响应丢失后保留本机完整原请求，仅查询原操作；本机记录保存失败时不提交。浏览器原记录按当前origin和空间隔离，最多128项；原记录应在同一浏览器恢复，不清空未知记录重试。底层模型、安装头和绑定均在数据库中，不修改原启动配置；备份恢复需保留两者。

本地CLI与机器合同见 [CLI](../../packages/cli/README.md#安装签名模型和绑定设备)、[发布与安装合同](../../contracts/model-release.md#本地信任安装和设备绑定)。此流程不升级固件，设备仍须实际实现所绑定能力。

## 可选本地模型

### 同机 Ollama 容器

已有同版本Ollama模型缓存时，可把推理服务和NAS装在同一台主机。先在安装目录之外准备仅当前安装者可写的模型缓存，保留Ollama的 `manifests/` 与 `blobs/` 结构；模型名称须与缓存中的名称一致。模型权重和许可由安装者选择，本平台不捆绑权重或自动下载。模型缓存不包含在NAS备份中，应另行保留或从原来源重新准备。

```sh
docker pull "ollama/ollama:0.40.13"
LIMEIOT_OLLAMA_MODEL="qwen3:0.6b" \
LIMEIOT_OLLAMA_MODELS_DIR="/absolute/path/to/preloaded-ollama-models" \
docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.ollama.yaml" \
  --profile simulation up --build -d
```

完整本地版按原安装命令保留 `compose.platform.yaml`，再在它之后增加 `-f "deploy/nas/compose.ollama.yaml"`。此覆盖与下方的外部Ollama覆盖二选一。路径必须已存在，Compose不会为它创建root所有的目录。首次使用前，安装者须确认当前UID/GID能读写模型缓存；不要指向其他账号的缓存或系统目录。

服务默认使用CPU、2核与4GiB内存上限，可通过 `LIMEIOT_OLLAMA_CPUS`、`LIMEIOT_OLLAMA_MEMORY_LIMIT` 调整。推理服务以安装者UID/GID运行，只挂载模型缓存，根文件系统只读，不挂载设备证书、MQTT或所有者凭据。模型服务与网关通过独立内部网络通信，没有宿主端口或公网出口。网关不会等待推理服务健康才启动；缺模型或推理故障不阻止本地控制和已部署联动。缓存可写以容纳Ollama元数据，服务私有临时目录在重建时清除。

镜像默认固定为0.40.13，可用 `LIMEIOT_OLLAMA_IMAGE` 明确替换经过验证的提供方镜像。Ollama仍是Rust推理适配器之后的外部服务，不参与设备状态、命令或规则部署；CPU/GPU性能、指定NAS和模型质量分别验收。当前配置检查通过，实际镜像、推理与故障检查的状态以 [实施进度](../../docs/24-实施计划与进度.md) 为准。

```sh
npm run test:nas:inference:config
npm run test:nas:inference -- --model "qwen3:0.6b" \
  --models-dir "/absolute/path/to/preloaded-ollama-models"
```

运行检查只创建本次独立Compose项目，复制缓存到私有测试目录，不修改原缓存或连接已有NAS。需要先拉取Ollama镜像；NAS镜像默认从源码构建，已有验证镜像时可显式提供 `--no-build --image limeiot/verification:YOUR_TAG`。检查要求真实Ollama产生精确的可用草案，确认预演不执行、不自动部署，再停止模型容器并验证原草案仍可读、本地MQTT控制继续确认。只检查支持的正向需求和容器隔离，不替代未支持意图拒绝质量验收。缺少镜像或权重时报失败，不改用假提供方；报告和日志保存在 `.dev/nas-inference-*`，设备证据始终为模拟设备。

### 局域网 Ollama

基础 Compose 的 `local` 网络禁止外连。已有局域网 Ollama 时，叠加模型配置，为网关增加到该主机的路由：

```sh
LIMEIOT_OLLAMA_MODEL="your-local-model" \
LIMEIOT_OLLAMA_URL="http://192.168.1.30:11434" \
docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.inference.yaml" \
  --profile simulation up --build -d
```

替换为实际安装的模型和私有地址。模型需预先下载，服务需监听容器可达的局域网接口；不要把容器内 `127.0.0.1` 写成 NAS 宿主地址。Ollama 接口只向受信网关开放，不发布到公网。HTTPS 私有 CA 可放入安装目录 `config/ollama-ca.crt`，并在上述命令增加 `LIMEIOT_OLLAMA_CA_FILE="/config/ollama-ca.crt"`；主机名与 TLS 校验保持启用。

网关仅接受回环、RFC1918 或 IPv6 ULA 地址，逐次校验全部 DNS 结果，固定解析地址、不使用代理、不跟随重定向。默认单并发且无队列，最多 90 秒、1024 输出 token。传给模型的是需求与绑定设备的事件/可写属性合同，不附加家庭状态、历史或系统凭据。推理结果保存为草案，预演后明确启用才部署规则。

模型不可用时不切云、不自动重试，设备控制与已部署联动继续工作。浏览器保存原生成键，原生端保存于 Keychain/Keystore；中断后查询原草案。网关重启会将正在生成的请求恢复为结果未知。本配置已提供出站网络声明，完整 NAS 容器及实际模型主机连通性仍须随安装验收，不能用宿主进程检查替代。

## 网页固件升级

当前源码的家庭页面和完整本地工作台均提供“固件升级”。先上传独立固件信任并填写已独立核对的公钥指纹，再选择设备/签名者、粘贴签名清单创建10分钟计划。读取当前任务后明确批准；再次读取并选择“开始安装”才发送安装指令。尚未执行的计划可以明确取消。

连接中断或响应丢失后，通过“升级原操作”查询原决定；任务未知时读取当前任务，再选择“查询设备结果”。查询不会重新安装。任务只有收到匹配的新启动、实际镜像与健康确认后才显示升级成功。浏览器记录保存失败时零发送，损坏记录保持原文并阻止新写入；未决原操作不能通过重新创建计划绕过。固件信任撤销不取消已发送的安装。

软件检查为 `npm run test:ota:web`，使用独立网关/SQLite/Broker与浏览器，不启动第二套MySQL或连接现有NAS。新页面尚未进入既有ARM64冻结镜像；从当前源码构建后使用，当前完整工作台为11项菜单。正式密钥/托管、手机OTA和新整包验收状态见 [实施进度](../../docs/24-实施计划与进度.md)。

## 固件制品仓库

新安装自动创建空的私有firmware目录，恢复保留备份中的制品；旧备份无制品时创建空目录。已有安装启用新Compose配置前，由原所有者创建该目录，例如 `mkdir -m 700 ".dev/nas/firmware"`；已存在时不覆盖或重设权限。独立构建OTA组件、准备签名包和trust后明确导入：

```sh
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota publish \
  --bundle ".dev/signed-firmware" --trust "firmware-trust.json" \
  --repository ".dev/nas/firmware" --base-url "https://NAS_ADDRESS:18443/artifacts/"
```

NAS_ADDRESS/端口须为实际初始化origin，且签名配方中的download_base_url完全相同。发布器不改写已签URL、不联网；重新验证清单、配方、回执、实际镜像和独立策略，再独占创建制品目录并原子提交标记。已有/中断目录不覆盖，成功stored不表示正式发布或设备安装。完整合同见 [固件签名与发布](../../contracts/ota-release.md)。

HTTPS入口仅为已提交制品提供GET/HEAD的firmware.bin、manifest.json；内部元数据和写请求拒绝。仓库挂载到edge为只读，不进入网关容器，不改变内部网关的外连策略。内网设备可通过初始化的HTTPS地址访问，但仍需独立配置固件签名策略和HTTPS CA。

NAS备份包含存在的firmware目录。备份期间停止所有制品发布写入，包含宿主上的ota publish；服务停机不会自动锁定外部CLI。独立保留原四文件签名包；旧备份没有制品时，恢复后使用相同origin和配方明确导入。不能仅因SQLite仍有任务或备份包含制品就推断安装成功，下载/安装继续验证独立签名、策略及实际字节。

隔离验证使用真实edge配置和回环随机HTTPS端口，支持传入实际C3目标镜像：

```sh
npm run test:ota:publish
npm run test:ota:repository -- \
  --lamp-image ".dev/firmware-build/v0.2.0-e0-development/lamp/limeiot_desk_node.bin" \
  --button-image ".dev/firmware-build/v0.2.0-e0-development/button/limeiot_desk_node.bin"
```

此项不构建网关镜像、不连接实机。省略镜像参数只验证格式夹具；软件报告和测试专用密钥留在忽略的.dev/ota-repository-*中。

## 设备证书

初始化分别生成 HTTPS CA 和设备 CA，设备使用后者验证 MQTT 服务。当前只允许为 `config/gateway.json` 中已经绑定的设备签发，未提供二维码/蓝牙认领流程。签发材料只写新目录，不回显私钥：

```sh
python3 "deploy/nas/device_identity.py" issue \
  --directory ".dev/nas" --device-id device-lamp --output ".dev/lamp"
python3 "deploy/nas/device_identity.py" issue \
  --directory ".dev/nas" --device-id device-button --output ".dev/button"
```

设备证书 CN 成为 Broker 授权身份；TLS 连接的 Client ID 同样固定为证书身份。CONNECT 中自填用户名不能提权。设备只能发布本设备上行、接收本设备下行，跨设备/空间、伪装网关和向下行发布均被 ACL 限制。宽泛订阅即使收到 SUBACK，也不会得到其他设备的数据。

将对应目录的 `ca.crt`、`device.crt`、`private.key` 交给[离线固件配置工具](../../firmware/README.md)。不要将 NAS 所有者 Token 或 HTTPS CA 私钥写入设备。

设备证书有效期 90 天，Broker 服务证书 365 天；当前没有自动续签。轮换前先撤销旧序列号，再为同一设备签发到新目录。序列号见签发命令输出或 `identity.json`：

```sh
python3 "deploy/nas/device_identity.py" revoke \
  --directory ".dev/nas" --serial 1001
docker compose --env-file ".dev/nas/compose.env" \
  -f "deploy/nas/compose.yaml" restart gateway
```

序列号仅为示例，须替换为实际设备证书序列号。撤销命令更新 CRL，但不会自行关闭现有连接；必须重启 Broker 所在的 gateway 容器后才算完成撤销。此操作会中断网关连接，结果不明的原操作继续查询，不能自动重发。

CRL 有效期 30 天，使用 `refresh-crl --directory ".dev/nas"` 刷新并重启 gateway。未完成证书/CRL续期和可信时钟准备时，设备连接会被拒绝。这些是开发身份工具，量产的认领、自动轮换、加密存储仍在开发。

## 备份与恢复

运行中的数据库通过 SQLite Backup API 取得一致快照，关联模型配置、凭据和 TLS 材料一并复制。复制签发数据库、已签证书和 CRL 时持有与管理命令相同的锁。恢复校验每个文件摘要和 SQLite 完整性，仅写入新目录，并重新生成签发配置中的绝对路径。

```sh
python3 "deploy/nas/manage.py" backup \
  --directory ".dev/nas" --output ".dev/nas-backup-20261101"
python3 "deploy/nas/manage.py" restore \
  --backup ".dev/nas-backup-20261101" --directory ".dev/nas-restored"
docker compose --env-file ".dev/nas-restored/compose.env" \
  -f "deploy/nas/compose.yaml" --profile simulation up -d
```

恢复前停止原实例。恢复继续使用原地址、凭据、规则与操作编号；会话需要重新登录，已发送但没有回执的操作保持结果未知。备份摘要检查用于发现损坏，不能代替可信备份来源或加密。

已配对实例必须同时保留原 `secrets/gateway-identity.pk8` 与数据库。私钥原始PKCS8字节也参与配对码加密，不能换成相同公钥的另一种编码。含配对记录却缺机器私钥的备份会拒绝恢复；恢复后先核实原绑定，不重新claim或创建新绑定。不要同时运行原实例和恢复实例。启用可选控制面覆盖的安装，恢复启动时继续叠加相同配置及允许origin。

升级前保留备份，使用固定源码版本构建新镜像，再由Compose替换进程。核心初始配置摘要不符时拒绝打开已有数据库。当前源码读取快照v1–6，校验后提交写入v7；保留模型/信任、OTA任务、执行证据与路由，v6保存绑定/撤销/原决定，v7增加显式组合的native_paths与compose决定。v6起须包含execution_registry，v6夹带组合字段拒绝，旧路由及OTA字段版本约束继续生效。未来版本拒绝且不改写快照，不支持v7的旧程序不能直接读新库；合同与阶段证据见 [执行合同](../../contracts/execution-routes.md)、[24第4.14节](../../docs/24-实施计划与进度.md#414-显式能力组合与文档同步)。可能已发送的动作/安装恢复unknown，只查原操作不补发，安装保留占用。不删除数据库绕过检查。迁移仅使用隔离测试库，未迁移用户库或构建当前源码NAS镜像，历史容器结果不覆盖新增能力。

电视宿主候选配置见[受限ADB](../../gateway/adapters/android-tv/README.md)与[执行合同](../../contracts/execution-routes.md)。现有空间通过本地API/CLI/网页明确绑定，宿主config修订变化后重启并重新确认；配置文件不自动接管旧路由，撤销持久阻断且不回退MQTT。当前没有将ADB可执行文件、独立服务器、凭据目录及固定电视局域网出口加入本NAS套件；内部网关不能假定直连电视。已有空间绑定到假ADB的完整浏览器旅程已通过，宿主软件证据不代表NAS容器或真实电视验收。

独立固件信任、升级计划、明确批准及原决定可通过 [本地CLI](../../contracts/ota-tasks.md) 管理。网关恢复后任务保留、批准清除，重新握手与读取当前任务后再明确批准；恢复旧决定不重启任务。当前未接入设备安装，新增源码镜像尚须独立构建验收。

## 验证

完整本地工作台使用独立检查，默认从源码构建两种测试镜像：

```sh
npm run test:nas:platform
```

它检查运行账号无 DDL、非 root/只读容器、数据库无宿主端口、统一会话和业务，以及停管理服务后的本地维护。备份在停止写入后生成，恢复到新目录的空数据库，核对产品签名版本、规则、命令记录、机器身份和 WSS 重连。报告和截图保存在 `.dev/nas-platform-*/`。`--keep` 仅在全部通过后保留恢复实例供预览，测试 CA 须由使用者自行信任。

两种NAS检查均支持显式目标架构，未指定时使用Docker服务端的原生架构：

```sh
npm run test:nas:platform -- --platform "linux/amd64"
npm run test:nas:container -- --platform "linux/arm64"
```

构建显式传入目标架构，启动前逐一核对网关、控制面、入口和数据库的实际镜像元数据，并固定镜像ID与Compose平台；启动后再核对各服务内的 `uname -m`。报告分别保存 `daemon_platform`、`target_platform`、`image_platforms` 与 `runtime_machines`。宿主支持AMD64模拟不代表整套NAS已通过，错误架构镜像在启动前拒绝。

跨架构运行需要对应架构的基础镜像、运行依赖及执行能力。为避免覆盖其他架构的本地标签，可将已核验的Nginx/MySQL镜像保存在独立 `limeiot/verification:TAG`，分别通过 `LIMEIOT_TEST_NGINX_IMAGE`、`LIMEIOT_TEST_MYSQL_IMAGE` 传入。复用完整工作台镜像时，另设置 `LIMEIOT_TEST_NAS_IMAGE`、`LIMEIOT_TEST_PLATFORM_IMAGE` 并增加 `--no-build`；所有镜像仍需通过同一架构校验，缺失时不会降低检查或改用宿主架构。

完整容器专项从源码构建唯一测试镜像，在独立目录初始化安装，并启动独立Compose项目：

```sh
npm run test:nas:container
```

需要Node.js 24、Python/OpenSSL、Docker、Compose和已安装的Playwright Chromium。也支持独立 `docker-compose` 命令。测试只绑定宿主回环随机端口，结束后关闭本次创建的容器和网络；安装、备份、恢复材料及报告留在 `.dev/nas-container-*/`。该目录包含测试私钥，按私有测试材料保管，不加入Git。

已有本次源码构建的本地镜像时可复用，避免重复构建：

```sh
npm run test:nas:container -- --image "limeiot/verification:YOUR_TEST_TAG" --no-build
```

报告逐项记录镜像ID、实际Linux架构、独立CA验证的HTTPS、非root/只读/内部网络、MQTT回执、家庭页面、设备mTLS/ACL/撤销、保留入口时替换网关，以及新目录备份恢复和原操作状态。浏览器专项只验证界面，TLS信任由显式加载本次CA的独立HTTPS连接证明。通过当前架构的容器检查不能代替其他架构或指定NAS型号实测；可选Ollama和云连接覆盖另行验收。

```sh
npm run test:e2e
npm run test:browser
python3 "tools/bootstrap-firmware.py" --provisioning
npm run test:provisioning
```

`tests/nas.test.mjs` 验证初始化权限、独立凭据、证书主机名、运行中备份、新目录恢复、原命令/规则/运行、恢复后证书撤销、非空目录和损坏备份拒绝。`tests/device-identity.test.mjs` 用真实 Broker 验证 mTLS、错误 CA、无证书、错误主机名、HTTPS证书混用、跨设备 ACL、撤销及重新签发。它们验证本地进程与恢复语义；正式容器启动、两种架构及 NAS 实机仍需独立记录。

`npm run test:pairing` 另外验证真实Go/MySQL与Rust配对、PWA故障恢复，以及OpenSSL生成的NAS机器私钥随一致性备份在新目录恢复后只核实原绑定、缺少密钥拒绝恢复。它不提升完整NAS容器运行状态。

`npm run test:relay` 在隔离测试环境中签发独立CA和服务证书，复验配对并检查真实WSS、心跳、断流重连、撤销与CA拒绝，且中继断开时本地模拟设备仍能完成MQTT命令。不会连接现有数据库或修改宿主CA信任。
