# 设备固件

本目录提供自研 C 设备核心、ESP-IDF 适配器和桌面灯/按钮产品工程。核心通过真实 MQTT Broker 与 Rust 网关联调；ESP32-C3 的灯和按钮目标均已编译生成开发镜像，尚未烧录或完成实机验收。当前没有发布正式可安装镜像。

## 目录与边界

| 目录 | 职责 |
| --- | --- |
| `components/limeiot_core` | 模型校验、应用会话、状态、事件、命令期限、耐久回执与固件安装前校验 |
| `components/limeiot_espidf` | MQTT 5 mTLS、NVS、随机数、SHA-256/Ed25519、时钟与有界工作队列 |
| `products/desk-node` | ESP32-C3 开发样机，Kconfig 选择灯或按钮 |
| `generated` | 正式物模型生成的 C 绑定，不手工编辑 |
| `tools` | 模型生成与离线 NVS 配置 |
| `tests` | 同一核心的宿主端口、故障注入和合同验证 |

公共头文件 `limeiot.h` 不暴露 ESP-IDF、MQTT 或 cJSON 类型。驱动通过读写端口实现产品能力；网络、耐久存储、时钟和密码库在适配器内使用。当前支持布尔/整数属性和单整数字段事件，浮点、动作、多字段事件与完整模型生成尚未实现。

命令执行前先提交耐久意图，执行后保存结果。意图后断电、驱动结果不明或回执保存失败都保留 `unknown`，不自动再执行。32 个日志槽只回收已报告且过期的记录；容量不足拒绝新命令。设备重连建立新应用会话，旧会话及过期命令拒绝执行。

## 宿主验证

需要 Rust、Node.js 24、C11 编译器、CMake、Python 3、OpenSSL 开发包和 `pkg-config`。第三方源码及构建输出只保存在忽略的 `.dev` 目录。

在 `iot` 根目录执行：

```sh
python3 "tools/bootstrap-broker.py"
npm run test:firmware
python3 "tools/bootstrap-firmware.py" --provisioning
npm run test:provisioning
npm run test:firmware:ota
```

`test:firmware` 校验生成文件并以 ASan/UBSan 运行 11 组核心检查，以及 11 项真实 Broker/Rust 网关联调，含设备 OTA 耐久拒绝、受控安装与原结果恢复。`test:firmware:ota` 包含 37 项签名、策略、配置、日志、启动凭据、传输与镜像健康专项。宿主驱动的观测来源为 `host-fixture`，不代表物理硬件。宿主检查在 macOS/Linux 使用 OpenSSL；固件适配器使用 ESP-IDF 的密码库。

`test:provisioning` 使用 `.dev/firmware-tools/venv/bin/python`；可用 `LIMEIOT_FIRMWARE_PYTHON` 指定已安装固定依赖的解释器。`test:firmware:ota` 使用相同环境运行4组C真实性、7组安装前策略、3组完整信任解码、12组设备执行日志、6组传输、4组镜像健康和1组NVS配置检查，交叉核对Node/Rust正式向量，仍以ASan/UBSan运行。

默认宿主检查不依赖完整ESP-IDF SDK。追加固定SDK的绝对路径，可再用其未修改的官方NVS解析器检查实际生成的5份NVS镜像、CRC、跨页策略块和独立CA，并把恢复字节交给C核心预检：

```sh
npm run test:firmware:ota -- --idf-path "/absolute/path/to/verified/esp-idf-v6.1"
```

## ESP32-C3 目标构建

工程使用 ESP-IDF **v6.1**，源修订 `fff9895c82d744c7237be8847347bdd1b07c6643`。MQTT 1.1.0、cJSON 1.7.19、led_strip 3.1.1、libsodium 1.0.22~1 的版本及组件摘要已保存在 [dependencies.lock](products/desk-node/dependencies.lock)，两个角色均已通过目标构建。libsodium来自[乐鑫官方组件](https://components.espressif.com/components/espressif/libsodium/versions/1.0.22~1)，使用ISC许可，分发时保留[原许可](third_party/libsodium.LICENSE)；密码库只在ESP适配器中出现。锁文件随源码保留，下载组件和镜像输出不入库。

先按官方方式取得 SDK、必要子模块与 ESP32-C3 工具链。将 `IDF_TOOLS_PATH` 指向本项目 `.dev/esp-tools`，避免全局安装；Python 使用该目录内的 SDK 虚拟环境。加载官方 `export.sh` 后，统一入口会核对 SDK 修订和生成绑定，并分别构建两个角色：

在 `iot` 根目录执行，将第一行改为已核对修订、含 Git 元数据的 SDK 实际路径。`IDF_GITHUB_ASSETS` 使用乐鑫官方资产镜像，仅对本次 shell 生效：

```sh
export IDF_PATH="/absolute/path/to/verified/esp-idf-v6.1"
export IDF_TOOLS_PATH="$PWD/.dev/esp-tools"
export IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"
python3 "$IDF_PATH/tools/idf_tools.py" --non-interactive install --targets=esp32c3
python3 "$IDF_PATH/tools/idf_tools.py" --non-interactive install ninja cmake
python3 "$IDF_PATH/tools/idf_tools.py" --non-interactive install-python-env
source "$IDF_PATH/export.sh"
```

```sh
npm run build:firmware
npm run build:firmware -- --role lamp
npm run build:firmware -- --role button
npm run build:firmware -- --role all --firmware-version 0.2.0
```

入口先reconfigure并检查实际配置，再build和检查实际镜像中的版本/安全代次。输出按版本、代次、配置和角色隔离，如 `.dev/firmware-build/v0.2.0-e0-development/lamp/`；同目录的build-info.json记录实际长度/摘要及SDK修订，只作为构建记录，不代替签名。只构建、不烧录，组件缓存默认保存在 `.dev/esp-component-cache`。以下为默认0.1.0的对应原生命令，直接调用idf.py时仍须自行核对实际配置与镜像：

```sh
idf.py -C "firmware/products/desk-node" \
  -B "$PWD/.dev/firmware-build/v0.1.0-e0-development/lamp" \
  -DIDF_TARGET=esp32c3 \
  -DSDKCONFIG="$PWD/.dev/firmware-build/v0.1.0-e0-development/lamp/sdkconfig" reconfigure build

idf.py -C "firmware/products/desk-node" \
  -B "$PWD/.dev/firmware-build/v0.1.0-e0-development/button" \
  -DIDF_TARGET=esp32c3 \
  -DSDKCONFIG="$PWD/.dev/firmware-build/v0.1.0-e0-development/button/sdkconfig" \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.button" reconfigure build
```

版本仅接受不带前导零的major.minor.patch，各段uint32且总长不超过原生31字节。默认安全代次0、不启用原生eFuse防降级。非零代次要求显式 `--native-anti-rollback`，C3范围0–16；例如 `npm run build:firmware -- --role lamp --firmware-version 0.2.0 --security-epoch 1 --native-anti-rollback`。该配置生成原生防降级固件，实际运行其引导/确认流程会按ESP-IDF策略更新eFuse，可能阻止旧代次回退；普通开发不需要开启，构建命令本身不连接设备或写eFuse。不将提高版本号与提高安全代次绑定。

2026-11-02：使用乐鑫官方 [v6.1 发布包](https://dl.espressif.com/github_assets/espressif/esp-idf/releases/download/v6.1/esp-idf-v6.1.zip)，SHA-256 `cdeea7db47b90064ef185b2a1f1b33d17bcb13469a9f8cc20e06c4c4cdb4cc16` 与 GitHub 官方发布记录一致，解压后 Git 修订和全部递归子模块匹配。C3 工具链、Ninja、CMake 与 Python 环境均安装到项目 `.dev/esp-tools`。此前 Git 断流和不完整归档保留为历史，不再作为当前 SDK 来源。

加入完整本地OTA策略加载后的灯镜像为 1,169,584 字节，按钮为 1,148,976 字节；每个 OTA 槽为 1,966,080 字节，分别剩余 796,496 和 817,104 字节。esptool 校验两份镜像的芯片类型、校验和及验证摘要通过。当前镜像声明 4 MB Flash、DIO/80 MHz、C3 v0.3 及以上支持修订，仍须按实物核对。链接报告中的静态内存余量不能替代 TLS、Wi-Fi 和运行时堆内存测量。

## 当前设备信息

可选 `read_device_info` 端口在完整快照成功后读取版本、硬件和升级条件，C 核心校验后发布 `device_info`。读取失败或字段无效不发布；网关按当前模型、启动/会话及独立5秒期限判断有效性，报告只存会话内存。字段与限制见 [正式合同](../contracts/device-info.md)。

C3 产品从实际应用/引导程序描述和备用分区读取值；整数引导程序版本 N 映射为 `0.0.N`，不使用 SDK 版本替代。板卡标识默认 `CONFIG_LIMEIOT_BOARD_ID="c3-development"`，USB 样机声明外接电源、电量未知。开发产品仅在独立HTTPS CA、完整固件策略与本次镜像健康确认均满足时报告 `safe_to_update=true`；状态读取失败、待确认或启动目标不一致仍拒绝升级。宿主报告明确使用 `host/host-fixture` 和虚拟容量，不代表实机。

## 身份与离线配置

先按 [NAS 说明](../deploy/nas/README.md) 初始化，并为绑定设备签发独立证书。为单个设备创建仅所有者可读的 JSON；路径相对该 JSON 文件解析：

```json
{
  "space_id": "space-demo",
  "device_id": "device-lamp",
  "hardware_rev": "c3-prototype-1",
  "wifi": { "ssid": "replace-with-local-ssid", "password": "replace-with-local-password" },
  "broker": { "host": "192.168.1.20", "port": 8883 },
  "identity": {
    "ca": "lamp/ca.crt",
    "certificate": "lamp/device.crt",
    "private_key": "lamp/private.key"
  }
}
```

证书 CN 必须等于 `device_id`，明确包含 clientAuth，用于该设备 CA；私钥必须与证书匹配。配置和私钥权限必须为仅所有者可读。不要填入网页 HTTPS 证书或所有者 Token。

```sh
".dev/firmware-tools/venv/bin/python" "firmware/tools/provision.py" \
  --config ".dev/device-config.json" --output ".dev/device-nvs-lamp"
```

工具仅创建新目录，不联网或烧录。生成 `nvs.bin` 为 24 KiB，对应本产品分区表 `nvs`、偏移 `0x9000`；与其他板卡或分区表不能混用。输出中的 CSV、PEM 和 NVS 均含敏感配置，权限为 0600。

这是开发样机的**未加密 NVS**。尚未完成物理认领流程、安全启动、Flash/NVS 加密、硬件密钥保护或自动证书轮换，不作为量产身份方案。

可选顶层字段 `ota_signing_key` 包含独立确认的 `public_key` 和 `signing_key_id`。前者是规范Base64的32字节Ed25519公钥；后者是 `sha256:` 加该公钥原始字节SHA-256。两者均须提供，额外字段、错误指纹、非规范Base64拒绝。不要从待安装清单自动提取并信任密钥；仓库公开测试种子不能用于真实产品。

工具将这对值写入NVS的 `ota_public_key/ota_key_id`，产品启动重新核对。两项均缺失表示未配置信任锚；部分缺失、损坏或指纹不符会停止启动。仅配置公钥不会开启升级能力，还需完整策略、独立传输信任及本次镜像健康确认。

可选顶层 `ota_policy` 为完整的 `limeiot.ota-trust` 对象，字段遵循 [正式Schema](../contracts/ota.schema.json#/$defs/trust)。它必须由设备所有者独立确认，不能从待安装清单或下载服务自动取得。必填字段如下：

| 字段 | 内容 |
| --- | --- |
| schema / version / purpose | `limeiot.ota-trust` / `1` / `device-firmware` |
| public_key / signing_key_id | 独立确认的Ed25519公钥及其SHA-256指纹 |
| product_ids / download_origins | 1–16个产品与1–8个规范HTTPS origin |
| minimum_security_epoch / minimum_battery_percent | u32安全代次下限与0–100电量下限 |
| revoked_artifact_ids | 0–128个不重复制品ID，空列表也须显式提供 |
| not_before / expires_at | 有序的规范UTC整秒有效期 |

只提供ota_policy时，工具同时写入其中独立确认的公钥；若同时提供ota_signing_key，两处必须完全一致。未知/缺失字段、布尔冒充整数、重复键/列表、坏指纹及不规范来源均拒绝，输入校验失败不创建输出目录。输出增加 `ota_policy_configured` 标志，不代表设备已启用安装。

策略以规范排序的ASCII JSON保存为0600的 `ota-policy.json`，通过NVS二进制块 `ota_policy` 与u8标记 `ota_policy_ver=1` 写入原24KiB配置分区，支持超过3999字节的跨页策略。配置与身份合计超出分区容量时生成失败，不修改分区布局。产品启动严格检查标记、长度、JSON与独立公钥一致性；标记/块缺一、未知版本或损坏均停止。两项均无的旧配置可运行，但没有完整策略就不能通过ESP安装前接口。

`li_ota_trust_decode` 严格解码完整信任对象并拥有其内容，`li_ota_trust_policy` 返回只读策略，`li_ota_trust_destroy` 释放对象；策略必须覆盖ESP适配器整个生命周期。解码阶段不使用墙钟，过期策略可保留普通控制启动，实际升级仍由可信时间预检拒绝。当前策略变更使用离线重新生成配置及明确的设备维护流程，未提供MQTT信任更新接口。

### 独立OTA传输配置与镜像健康

在现有初始化JSON中显式添加以下字段，同时提供完整 `ota_policy`：

```json
{ "ota_transport": { "ca": "ota/ca.crt" } }
```

CA路径相对初始化文件解析，工具只接受不超过3999字节的PEM CA证书或CA链。拒绝叶证书、私钥、过期CA、夹杂其他内容、未知字段和缺少完整策略的配置；不会自动继承MQTT身份CA。输出 `ota_https_trust_configured` 表示材料已写入NVS，不表示设备已通过健康检查。独立CA以 `ota_https_ca` 字符串和 `ota_ca_ver=1` 保存；标记/内容缺一、未知版本或无完整策略均停止启动。ESP适配器重新解析CA并确认CA用途，HTTPS连接仍验证有效期和主机名。

固定ESP-IDF v6.1引导程序在双槽初始空白otadata下成功加载首个OTA镜像后，会写入原生VALID记录（`bootloader_utility.c::set_actual_ota_seq`）。平台不自行修补缺失或损坏的启动元数据，也不将读取失败当作健康。首次VALID镜像和升级后PENDING_VERIFY镜像均须等驱动、身份配置、可信时钟及IoT握手就绪，再调用 `li_espidf_confirm_running_image`。接口核对运行/选择分区与原生镜像；仅对PENDING_VERIFY请求原生确认，再回读VALID。失败或确认已生效但返回错误，均不开放OTA；已有VALID不重写启动状态。

产品只在本次健康确认、当前运行/选择一致、原生VALID、完整策略和独立CA同时满足时声明可升级。真正执行仍重查当前会话、期限、电源、签名、撤销和兼容性。4组宿主故障检查编译实际SDK健康门禁，原生调用为显式夹具；5份实际NVS镜像经官方解析器检查CRC、策略及CA字节，包括完整撤销列表与CA共存。它们不代表板上启动/回滚实测；实机验收按用户要求跳过。

## 设备固件签名真实性

公共接口 [limeiot_ota.h](components/limeiot_core/include/limeiot_ota.h) 提供 `li_ota_key_decode/validate` 与 `li_ota_authenticate`，密码学通过SHA-256和Ed25519字节端口注入。ESP侧使用 `li_espidf_ota_crypto`；宿主检查使用独立OpenSSL端口。公共头不暴露第三方类型。

真实性检查使用与Rust相同的固件签名域，覆盖除顶层signature以外的完整清单，并返回完整清单JCS摘要与密钥指纹。固件合同采用ASCII字符串和安全整数子集；规范化递归处理数组中的对象，排序ASCII键、编码JSON转义和整数。拒绝重复键、未知顶层字段、非法JSON、NUL、非ASCII字符串、非安全整数/小数/指数，以及16KiB/16层/2048节点越界；失败清空输出证明。

该接口只验证签名真实性及根字段，不执行完整安装策略，也不读取当前设备状态。需要安装前检查时使用下面的 `li_ota_preflight`；真实性结果不能作为安装授权。两者都不会联网、写分区、持久保存执行意图或重启。

## 设备安装前校验

`li_ota_preflight` 每次重新验签并严格校验完整statement、target、compatibility与download结构。版本各段须在u32范围；型号、硬件修订、协议1、模型修订、明确升级路径、引导程序、安全代次、实际备用容量、电源和忙碌状态均须满足条件。拒绝未知字段、缺失字段、类型错误和重复数组项。

产品提供独立本地 `li_ota_policy_t`：已确认的公钥、产品范围、下载origin、撤销制品、最低安全代次/电量和UTC整秒有效期。数组、指针和密钥须在调用期间保持有效且不被并发修改。C3从上述NVS配置严格解码策略并传入适配器，策略不得来自ota_install报文，不会由清单自动补齐。

本机身份来自 `li_config_t`；`li_ota_environment_t` 在密码学与结构检查后重新调用当前设备信息及可信时间端口，禁止以网关设备快照替代。时间端口须独立验证时钟可信度；有效期包含关系为 `policy.not_before <= issued_at < expires_at <= policy.expires_at`，执行时须满足 `issued_at <= now < expires_at`。缺端口、读取失败或未知电量均不能推断为允许升级。

下载URL精确匹配独立配置的HTTPS origin，支持小写ASCII DNS、规范IPv4/IPv6和非默认端口，供NAS制品源使用。拒绝凭据、query/fragment、反斜杠、空白、根路径、点路径及百分号编码的点路径；不接受会被规范化的默认443端口、主机大小写、IPv4缩写/八进制或非规范IPv6。解析不发起网络请求。

ESP侧 `li_espidf_ota_preflight` 只使用初始化时配置的完整策略、固件信任锚、现有产品驱动和可信墙钟，要求当前连接就绪。产品须串行调用；无完整策略、无信任锚或策略密钥不同会拒绝。调用方不能为每条下行另传宽松策略覆盖启动时的撤销或来源范围。公共头不暴露供应商类型。

成功返回签名清单摘要、制品身份、目标版本/安全代次、镜像长度/摘要、URL与有效期，失败清空整个候选对象。这是瞬时预检结果；实际执行前、耗时下载后及写分区前仍须重检，不能当作长期安装许可。安装器在耗时暂存后再次预检；单次预检不证明实际镜像已验证或设备可以启动。

## 设备执行日志

公共头 [limeiot_ota_log.h](components/limeiot_core/include/limeiot_ota_log.h) 提供独立日志，不授予安装权限。调用方须在 `prepare` 前及真实副作用前校验会话、本机事实和当前策略；日志只校验安装Envelope结构、摘要绑定与执行状态，不替代完整清单验签和安装前预检。

`li_ota_log_prepare` 将完整原Envelope的JCS文本、原请求/清单摘要、当前基线与intent同快照耐久保存。`advance` 仅允许本次运行中的intent→installing→awaiting_boot，开始安装重查可信毫秒期限。同设备最多一个未决任务；重复原请求只读返回 `LI_IGNORED`，相同任务或执行ID的异参返回 `LI_CONFLICT`。查询缺失也返回 `LI_IGNORED`，仅表示未知，不能解释为未安装。

`li_ota_log_open` 恢复的未决记录标记recovered，禁止继续推进或重新安装，只能查询及凭新的独立本机证据收敛。成功/回滚要求新boot、精确目标/基线版本、安全代次、完整镜像SHA-256及pending_update=false；intent不能直接报告成功/回滚。终态不可修改，相同结果重复只读。

存储端口成功必须表示整个快照已原子耐久提交。返回失败即使可能已写入，当前对象也进入故障状态：后续查询/修改返回 `LI_STORAGE`，须关闭并重新读取实际存储。快照包含版本、空间/设备绑定和SHA-256损坏校验；校验和不提供存储认证。未知版本、损坏、重复ID和多个未决记录均拒绝恢复，不自动清空。

ESP适配器使用原 `journal` 分区的独立 `ota` 命名空间及 `state` 二进制块；原 `receipts` 的32槽控制回执保持独立，分区布局不变。日志上限4条、32KiB，实际可写容量还受共享NVS空间和原子替换开销限制；空间不足拒绝，禁止擦除控制回执。仅终态且原期限已过的记录可在新prepare中回收。未决/故障日志阻止属性驱动写入。

12组宿主检查使用真实文件、fsync/rename和独立进程重开，覆盖耐久提交前后报错、重复请求、期限、状态机、启动凭据、版本兼容、结果证据、配额与损坏恢复。它们不证明C3断电/NVS原子性或实机安装；MQTT消费者及可选安装提供方见下文。

## 有界传输与备用区校验

[limeiot_ota_transfer.h](components/limeiot_core/include/limeiot_ota_transfer.h) 提供 `li_ota_transfer_run`，将 HTTPS、备用存储、流式摘要与当前授权分别隔离为窄端口。调用方必须先完成独立本机预检，并将 guard 绑定本次耐久 installing 记录、当前会话、策略和本机事实。此接口不构成安装授权。

传输只发一次 GET，不重试或续传；仅接受 HTTP 200、无压缩及精确声明长度（如有）。使用 1KiB 缓冲，拒绝超长、截断及无进展；每个 IO 前后核对授权、单调钟和30秒总预算。总预算不是硬实时终止保证，端口还须限制单次阻塞。写入结束先调用原生镜像验证，再回读原清单声明长度内的全部实际字节，核对 SHA-256，最后复查授权才返回 image_verified。失败时没有成功证明，计数不表示失败写入未发生。

ESP 的 `li_espidf_ota_stage` 使用独立 HTTPS CA、证书及主机名验证和5秒网络调用超时，关闭重定向；只对非运行中的备用 APP 分区执行 `esp_ota_begin/write/end`，随后从分区回读。这个低层接口不选择启动分区或重启；消费者可通过下述独立安装提供方调用，开发产品按完整策略、独立传输信任及本次镜像健康状态决定是否允许升级。原生镜像验证只取得目标编译证据，未在板上执行。

6组新增检查通过真实回环 HTTPS、临时文件和独立 Node 摘要，覆盖 CA/主机名、HTTP响应、长度/摘要、存储/回读/摘要故障、授权丢失、预算和时钟。宿主 source 使用独立 OpenSSL 实现，finish 是文件夹具；此结果不等于 ESP TLS、Flash 写入或启动验收。

## 受控设备安装

在连接前通过 li_ota_device_set_installer 配置 current/stage/activate/restart 四个窄端口。完整预检和原请求耐久保存后，先提交 installing，再下载和写备用区。传输期间持续检查当前连接代次、原会话、可信时间、单调钟、原任务期限、本地公钥/来源/撤销、安全代次、电源和设备条件；整秒时钟下将任务期限向下取整，最多提前不足一秒拒绝。整体30秒预算在IO边界检查，不能保证硬实时终止。

暂存证明须包含精确接收/写入/回读长度和原摘要。完整重新预检、运行基线复核后，先提交 awaiting_boot，才允许调用启动选择。ESP端再次回读备用区摘要，核对应用版本、安全代次和项目名，并在选择前复查guard。选择成功后先耐久绑定本机启动凭据，再报告进度并重启；选择报错也保留awaiting_boot，不推断启动配置未变。日志提交失败、部分写入或缺少本机证据均停止，恢复与重复请求不重新安装。

ESP选项 ota_https_ca_pem 非空时配置提供方，要求已有独立完整固件策略；CA须覆盖适配器生命周期。底层传输接口仍不授予安装权限。开发产品从离线初始化的独立传输CA接入提供方；未配置时传入NULL并保持safe_to_update=false，完整配置仍须经过本次镜像健康门禁。启动结果观察器已接SDK，离线签名包准备已通过独立工具实现，HTTPS托管/发布待接入，见 [签名制品合同](../contracts/ota-release.md)。

新增3组真实MQTT/HTTPS旅程验证Rust计划/批准/执行、C消费者、文件暂存与激活前耐久顺序；覆盖传输中断线/掉电源/失去可信时钟/撤销、错误响应/镜像、存储门禁、提交后报错、激活前后报错及重启不补装。宿主激活和重启仅记录审计，文件finish不解析ESP镜像；目标编译与宿主证据不等于Flash、真实启动、回滚和运行资源验收。安装工作区使用有界堆分配，分配失败不开始安装。

## 启动结果恢复

启动选择成功后，安装器先将本机凭据耐久绑定到原awaiting_boot，再请求重启。提交返回失败也停止，不重新选择或安装。日志版本2新增boot_binding，版本1只读兼容，合法修改后升级；旧未决没有凭据，不自动补齐。li_ota_device_set_boot_observer配置只读本机观察器，li_tick最多每秒核对恢复未决的新启动，结果先耐久保存再发布。终态原查询重新核对当前证据，不修改日志或重新安装；旧安装期限或撤销不阻止历史结果恢复。

ESP凭据绑定目标分区地址和实际启动序号。选择前要求现有启动分区仍是当前运行分区，选择后核对目标NEW及CRC有效记录，拒绝借用选择前已有的相同NEW记录。恢复按原清单完整长度回读实际目标字节，核对原生镜像、应用版本、安全代次和项目名；当前目标运行/选择一致且原生VALID才证明成功。回滚还要求原目标INVALID或ABORTED，当前运行/选择为精确已确认VALID基线，原版本、代次和基线摘要均匹配。读取前后启动元数据须保持一致。旧凭据、待确认、仅版本相同或仅运行基线都保持未知。

37项专项包含12组日志和4组镜像健康检查；11条真实MQTT旅程含3组启动恢复检查与Rust/SQLite成功收敛、提交前后故障和丢结果恢复。宿主启动状态来自显式文件夹具，不代表ESP原生启动、Flash或回滚实测。开发产品已接独立HTTPS CA和本次镜像健康确认；缺少配置或原生启动元数据时不开放安装。实机验收按用户要求跳过。

## 产品与恢复

安装/查询消费通过 [limeiot_ota_device.h](components/limeiot_core/include/limeiot_ota_device.h) 在连接前接入C核心。`li_receive` 按精确topic处理ota_install/ota_query，拒绝retain、坏结构、跨设备/模型及非当前boot/session。完整原安装重复先读日志，不重新预检或写盘；异参冲突。查询须带原请求与清单摘要，期限最多30秒；缺失或恢复未决保持未知，不生成虚假的未执行回执。

新请求先验证独立策略公钥下的签名、读取本机基线并执行完整预检，预检不满足时耐久保存拒绝；满足条件且已配置提供方时执行下述安装流程。未配置安装提供方时，即使预检通过也保存 `ota_installer_unavailable`，不下载或写分区。已有终态/本次运行中的明确进度只有在当前运行镜像、版本、代次及已确认启动与记录一致时，才通过当前会话递增seq上报ota_result。查询不更新原日志，过期安装或已撤销策略不阻止查询历史结果；无完整策略仍可查询。

ESP使用独立可信墙钟与产品设备读数，校验当前运行分区的镜像结构，再流式计算 `esp_image_verify` 返回image_len范围的SHA-256，作为本机基线。此基线检查不代替安装结果对原清单声明长度的实际字节校验。故障/未知或待确认启动不报告终态。3条新增真实MQTT检查覆盖原请求、当前会话查询、丢上行、存储故障和Rust网关/SQLite终态恢复；宿主运行字节和可升级标志仅为显式测试夹具，不作为硬件证据。

采购候选为 ESP32-C3-Zero-M，尚无板卡支持证据。灯角色使用 WS2812，默认 GPIO10、一颗；按钮为外接 GPIO3 对地、内部上拉、40 ms 去抖。接线前按实际板卡修订核实引脚、电压与恢复入口；代码拒绝绑带 GPIO2/8/9 和 USB GPIO18/19。未采购、未实测的引脚不能视为固定 BOM。

灯样机将驱动上限限制为满量程的 20%；模型亮度 100% 表示产品允许上限。`driver.applied` 只证明驱动返回成功，不表示独立光学测量。离线按钮事件不补发。

开发板没有可信 RTC，冷启动后在物理 USB 控制台输入 `time <Unix秒>`；随后保持 CA、主机名、证书有效期验证。不开启未认证 SNTP 或任意证书回退。关闭开发时钟选项时，需要产品实现受保护时钟，当前示例直接停止启动。

NVS 配置或命令日志损坏时停止，不自动擦除身份。分区表预留双 OTA 槽，待验证镜像在应用启动后 90 秒内未完成健康确认会请求回滚；计时包含等待时钟和配网。首次原生VALID镜像可继续等待初始化，但确认前不允许OTA。

共享Rust核心和离线 `ota verify` 已实现独立固件清单验签、设备快照预检及本地镜像校验；`ota download` 提供宿主受控HTTPS制品下载，完整验证后写入新私有目录。入口为 [OTA合同](../contracts/ota.md)，检查为 `npm run test:ota`。[耐久升级任务](../contracts/ota-tasks.md) 已接API/CLI、明确执行、MQTT安装/原查询与设备证据；批准不触发安装，发送意图先提交，恢复未知不重发。

C3端已接入ota_install/ota_query与ota_result，配置完整时通过消费者、备用区写入、启动选择和新启动结果恢复执行受控升级；未配置独立CA或未通过本次健康确认时不允许安装。早期OTA工具向量只是文本，不能烧录；目标构建生成独立C3镜像。本地不可覆盖仓库与NAS只读HTTPS入口已实现，正式托管未发布；实机回滚验收按用户要求跳过。

## 签名固件准备

先构建所需版本的C3应用，再按 [固件签名制品合同](../contracts/ota-release.md) 生成专用密钥、独立确认trust并执行ota sign。工具从实际镜像核对版本/安全代次、校验和与原生摘要；错误配方不能给旧镜像标高版本。当前灯/按钮实际构建产物均通过签名、Rust验证、C验签和C预检，使用临时生成的测试专用密钥及明确宿主设备快照，不代表正式发布或安装。

`ota publish` 明确将完整签名包和独立trust导入本地仓库，重新验证全部内容及当前策略，已有ID与中断目录均不覆盖。NAS仅暴露已提交的镜像和清单；完整步骤与恢复边界见同一合同。实际0.2.0灯/按钮开发镜像已通过隔离NAS HTTPS入口及正式Rust下载器，基线为显式0.1.0宿主快照；这不证明真实设备安装/启动。
