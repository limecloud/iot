# NAS 本地家庭版

本目录提供网关、家庭 Web 界面、本地 Broker 和 HTTPS 入口。设备控制、已部署联动和执行记录保存在 NAS，不依赖官网、云账号或模型服务。官网与文档中心在独立的 `iotweb` 仓库。

当前可从源码运行灯光与按钮模拟链路，设备 mTLS 签发/撤销已通过真实 Broker 检查。安装包尚无正式镜像发布，ESP-IDF 芯片编译、实际设备认领和签名 OTA 仍待交付。模拟器通过真实 MQTT 5 通信，不代表硬件已验收。

## 初始化

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
| `config/gateway.json`、`config/mqtt-acl` | 模型绑定与设备 Topic 授权 |
| `data/` | SQLite WAL、事件与虚拟设备文件 |
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

默认发布 HTTPS 和设备 mTLS 8883，可通过 `LIMEIOT_MQTT_TLS_PORT` 调整后者的 NAS 映射端口。网关 HTTP 位于内部容器网络，明文 MQTT 只在该网络命名空间的回环地址监听，不映射到 NAS 网络。TLS 入口保留精确 Host；网关拒绝其他 Host、跨来源请求和明文远程来源。自有 NAS 反向代理必须保留相同边界，不直接发布内部 HTTP。

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

控制面所有者通过API创建空间和120秒配对请求，将完整返回JSON交给本地所有者。家庭PWA打开“网关配对”，读取信息并核对目标账号、控制面与权限，再选择“批准配对”。浏览器只保存原操作键，配对码在网关中加密保存。Console/Admin页面仍待实现，当前不能依赖其入口创建请求。

响应丢失或网关重启后使用“核实原配对”，仅查询原绑定，不重复claim。结果未知且已经批准的记录阻止新配对绕过，直到核实或明确撤销。本地撤销立即生效，不依赖云；不会自动撤销云侧记录。若要重新配对，同一机器的旧活动云绑定需由云所有者撤销。状态“已配对”仅表示绑定建立。

可选机器连接默认关闭。在上述Compose命令增加 `LIMEIOT_CONTROL_RELAY_ENABLED=1`，网关将为已批准的活动绑定建立出站WSS；只使用相同origin和原机器私钥。独立挑战、持续心跳、重启/断流重连与两侧撤销已通过真实TLS进程检查。连接状态由本地 `control-pairings.list` 的connection字段和Console连接状态API分别读取。当前仅认证和保活，尚不转发设备动作；完整NAS容器与公网代理路径仍待部署验收。

## 可选本地模型

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

升级前保留备份，使用固定源码版本构建新镜像，再由 Compose 替换进程。配置合同变化时网关拒绝打开不匹配数据库；当前没有自动跨版本迁移，不删除数据库绕过检查。

## 验证

```sh
npm run test:e2e
npm run test:browser
python3 "tools/bootstrap-firmware.py" --provisioning
npm run test:provisioning
```

`tests/nas.test.mjs` 验证初始化权限、独立凭据、证书主机名、运行中备份、新目录恢复、原命令/规则/运行、恢复后证书撤销、非空目录和损坏备份拒绝。`tests/device-identity.test.mjs` 用真实 Broker 验证 mTLS、错误 CA、无证书、错误主机名、HTTPS证书混用、跨设备 ACL、撤销及重新签发。它们验证本地进程与恢复语义；正式容器启动、两种架构及 NAS 实机仍需独立记录。

`npm run test:pairing` 另外验证真实Go/MySQL与Rust配对、PWA故障恢复，以及OpenSSL生成的NAS机器私钥随一致性备份在新目录恢复后只核实原绑定、缺少密钥拒绝恢复。它不提升完整NAS容器运行状态。

`npm run test:relay` 在隔离测试环境中签发独立CA和服务证书，复验配对并检查真实WSS、心跳、断流重连、撤销与CA拒绝，且中继断开时本地模拟设备仍能完成MQTT命令。不会连接现有数据库或修改宿主CA信任。
