# 固件制品校验与下载

当前实现 `device-firmware` 制品的清单验签、设备快照预检、本地镜像校验和受控HTTPS下载。Rust 核心是规则来源，`limeiot-ota` 提供 CLI，Node CLI 只转交参数及退出码。`verify`只读且不联网；`download`只访问签名与本地信任允许的来源，并写入新建私有目录。两者均不签名、创建设备升级任务、修改信任、写分区或重启设备。

## 输入与发现

[ota.schema.json](ota.schema.json) 是自包含结构 Schema，根对象必须完整包含 `manifest`、`trust` 和 `device`。[工具目录](tools/ota.json) 由 `ota schema` 连同 Schema 一起输出。未知字段、重复 JSON 键、非法 Unicode、不安全数字及缺失字段均拒绝；可空字段也必须显式提供。原文和 JCS 投影各不超过 32 KiB，最大深度 8、2048 个节点。

```sh
cargo build --locked -p limeiot-model-validator --bin limeiot-ota
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota schema
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota verify \
  --input "verification.json" --image "firmware.bin"
```

也可将 `limeiot-ota` 加入 PATH 后直接调用。组件配置必须是绝对路径；路径不从 JSON 取出，也不通过 shell 执行。输入、镜像和可选CA须为普通文件；Unix 入口以 `O_NONBLOCK | O_NOFOLLOW` 打开，拒绝符号链接、目录和 FIFO。错误不回显路径或输入。Node 包装进程对verify最多等待10秒、download最多35秒，不继承账号令牌或其他业务环境变量。

## 清单与签名

清单完整字段为 `schema=limeiot.ota-manifest`、`version=1`、`algorithm=Ed25519`、`signing_key_id`、`statement` 和 `signature`。`statement.kind` 只支持 `device-firmware`；网关程序、模型和媒体制品不可借用此用途。

签名消息为 UTF-8 字节 `LimeIoT Device Firmware v1\n`，拼接 RFC 8785 JCS 编码的清单对象，且只移除顶层 `signature`。`\n` 是一个换行字节。schema、version、algorithm 和 signing_key_id 同样受签名保护。公钥为32字节，签名为64字节，均使用规范带填充标准 Base64；密钥标识为 `sha256:` 加公钥原始字节 SHA-256 的64位小写十六进制。

模型签名域、模型信任材料和设备 MQTT CA 均不能替代 OTA 信任。算法使用 ring 的 Ed25519，不自研密码算法。平台清单验签不替代 ESP Secure Boot 对实际应用镜像的验证。

设备C接口 `li_ota_authenticate` 已独立实现同一签名域和完整清单摘要，ESP适配器使用官方libsodium；公钥来自初始化配置。它仅验证真实性和清单根字段，不提供完整statement Schema/时效/撤销/兼容/电源/来源预检，成功不能替代本合同的完整安装条件。输入限16KiB、16层、2048节点及ASCII/安全整数子集，详见 [固件SDK](../firmware/README.md)。

设备SDK另提供 `li_ota_preflight`：重新验签、严格检查完整statement，并读取本机身份/当前设备信息及独立可信时间，检查本合同的有效期、撤销、目标、兼容、安全代次、容量、电源与忙碌条件。`li_ota_policy_t` 由产品从独立本地配置提供，不从安装下行建立信任。ESP包装接口还核对已配置公钥和连接就绪状态。URL匹配规范HTTPS的ASCII DNS、IPv4/IPv6与非默认端口；拒绝凭据、查询、片段、点路径和规范化歧义。失败清空候选，成功只产生当前预检结果，不验证实际镜像，不保存执行意图或授予持久安装许可；MQTT安装器接线仍待实现。

`li_ota_trust_decode` 严格读取本合同的完整trust对象，复制拥有的数据并验证公钥指纹及静态策略。C3离线配置支持 `ota_policy`，以版本1的NVS二进制块保存，在启动时重新解码并绑定独立公钥。旧配置或只有公钥时不授予ESP预检能力；块/版本标记缺一、未知版本或损坏停止启动。ESP预检只使用初始化策略，调用方不能按安装请求替换策略。解码不读取时间，实际时效仍在每次预检时检查；初始化和字节预算见 [固件配置](../firmware/README.md#身份与离线配置)。

`statement` 固定以下条件：

| 字段 | 规则 |
| --- | --- |
| artifact_id | `artifact-` 加64位小写十六进制，后续发布服务须保证身份不可变 |
| target | product_id、architecture、chip、board 精确匹配；hardware_revisions 为1–16个不重复修订 |
| version | 三段无前导零版本，每段为 u32；必须高于设备当前版本 |
| compatibility | protocol_version 当前为1；精确允许的 model_revisions 和 from_versions 各1–16项；minimum_bootloader_version 必须满足 |
| size_bytes / sha256 | 1–32 MiB；摘要为 `sha256:` 加64位小写十六进制 |
| security_epoch | u32，不低于设备当前值和本地信任最低值；校验不写 eFuse |
| download | 规范 HTTPS URL，精确命中本地允许 origin；禁止用户信息、query、fragment、根路径和任何重定向 |
| issued_at / expires_at | 规范 UTC 整秒时间；以可信当前时间检查 `issued_at <= now < expires_at` |

URL 的 `https://host:443`、大小写主机及点路径等解析规范化变化不会被静默接受；清单值必须已是 URL 库的规范输出。私有 NAS 可通过独立信任允许其 HTTPS origin；工具本身不会访问 URL 或检测其连通性。

## 独立信任与设备快照

`trust` 的 schema 为 `limeiot.ota-trust`，version为1，purpose为 `device-firmware`。公钥、产品范围和允许下载 origin 须由本地所有者经独立渠道确认；从清单下载到的同源材料不能自动成为可信根。当前工具只消费调用者提供的本地信任文件，不实现信任登记或更新。

信任包含1–16个 product_ids、1–8个 download_origins、minimum_security_epoch、minimum_battery_percent、最多128个 revoked_artifact_ids，以及 not_before / expires_at。数组不得重复。清单有效期必须完全落在信任有效期中；已撤销制品拒绝。所有时间使用与设备身份体系一致的可信时钟要求，不能靠重设时间绕过有效期。

`device` 必须提供精确设备/产品/架构/芯片/板卡/硬件修订、当前 firmware_version、bootloader_version、protocol_version、model_revision、security_epoch、ota_capacity_bytes，以及 external_power、battery_percent、safe_to_update、pending_update。

当前和目标版本必须在明确升级路径中；签名有效不能覆盖硬件、协议、模型、引导程序和空间不兼容。设备须满足 `safe_to_update=true`、`pending_update=false`；有外接电源，或已知电量不低于信任最低值。未知电量不能视为充足。备用分区容量使用实际可写应用容量，不以整个 Flash 容量代替。

此输入是调用者提供的快照，工具无法证明它来自真实设备，也不验证控制主体权限或快照新鲜度。后续任务服务须在明确批准和实际执行前读取当前可信设备状态，重新核对完整清单摘要、信任撤销、主体授权、版本、电源、空间和当前任务。不得据一次离线通过自动升级。

原生设备可通过 [当前设备信息](device-info.md) 上报同一设备结构；网关绑定当前应用会话，按独立5秒期限计算 `fresh`，当前缓存不进入备份。[本地升级任务](ota-tasks.md) 已接通独立信任、计划与明确批准，并读取当前报告；verify/download 仍不自行读取设备。C3开发产品仅在完整独立策略、显式HTTPS CA和本次健康确认满足时报告可升级；信息上报或目标编译不等于实机安装验收。

## 实际镜像与报告

预检失败不读取镜像内容。通过后按16 KiB缓冲流式读取，最多读取声明长度加1字节；实际长度必须精确相等，随后核对内容 SHA-256。额外字节、截断、损坏和 IO 错误分别拒绝。工具不解析 ESP 镜像结构；后续设备适配器仍须验证应用头、芯片/项目及安全启动条件。

报告版本1，verifier为 `limeiot.ota/1.0.0`，完整字段见 Schema 的 `$defs/report`。`request_digest` 绑定 JCS 后的整个 manifest/trust/device 封装；不可解析或超限时为null。`valid=true` 须同时满足完整预检和实际镜像校验，issues为空。失败至少包含一项稳定错误码。

长度不符时不报告被截断读取内容的“完整摘要”；长度正确但摘要不符时报告实际长度与摘要，valid仍为false。文件可能在校验后改变，安装实现不能重新按路径打开文件后沿用旧通过结果，须对实际写入字节重新验证。

| 退出码 | 含义 |
| --- | --- |
| 0 | 给定快照和实际文件校验通过，不代表已批准或已安装 |
| 2 | 输入、签名、信任、兼容性、镜像或参数不满足条件 |
| 5 | 文件 IO 或组件故障，不能解释为未执行的设备任务 |

当前verify操作没有任务ID或恢复请求，也没有设备副作用。本地任务另有耐久原决定、明确批准和只读恢复合同；执行阶段的unknown查询、设备下载/分区写入、启动确认与回滚仍待实现，不复用普通属性控制来模拟升级。

## 设备执行日志

设备C SDK的独立存储接口见 [limeiot_ota_log.h](../firmware/components/limeiot_core/include/limeiot_ota_log.h) 与 [固件说明](../firmware/README.md#设备执行日志)。日志接受正式 `ota_install` Envelope，保留完整JCS原文、原请求/清单摘要和本机基线；它不执行签名/完整策略预检，不作为网络安装消费者，不授予安装权限。完整安装报文与结果合同继续以 [本地升级任务](ota-tasks.md) 为准。

同设备最多一个未决记录，原请求重复只读、同任务或执行ID异参冲突；查询不读时钟、不写存储、不重新安装。恢复出的非终态禁止继续推进，须凭新的本机证据确认结果；缺失记录表示未知。成功/回滚要求新boot及精确目标/基线镜像、版本、安全代次和已确认启动，终态不可变。

原子存储返回失败后当前日志对象拒绝后续操作，调用方只能重开并读取实际落盘状态。快照版本2绑定空间/设备并保存本机boot_binding，版本1只读兼容、修改时升级，用SHA-256检测损坏；未知版本、重复ID、多个未决或不合法状态均拒绝恢复，不自动擦除。最多4条、32KiB，只有已过期终态可回收；ESP使用独立NVS命名空间，空间不足不清除普通控制回执。实际NVS可写空间可能小于编码上限。

`npm run test:firmware:ota` 包含12组日志检查，使用真实文件与独立进程覆盖提交前/后故障、冻结恢复、结果证据与配额。该证据不包含C3实机NVS断电、网络/Flash写入或启动回滚；启动恢复接口见固件说明。

## 设备有界传输端口

C接口 [limeiot_ota_transfer.h](../firmware/components/limeiot_core/include/limeiot_ota_transfer.h) 仅负责下载、备用区写入及实际回读校验。调用前须独立本机预检，guard绑定本次耐久installing记录、当前会话、策略及本机事实；它不接受网关快照作为安装授权。HTTPS、备用存储、SHA-256与guard通过窄端口隔离。

只尝试一次GET、HTTP200及identity编码；声明Content-Length时须精确一致，超额块不写入。1KiB缓冲有界处理全部字节，原生镜像验证完成后回读原清单声明长度并核对SHA-256，最后重检授权才返回image_verified。各IO前后检查授权、单调钟及30秒总预算；单次调用须另外限时，不保证硬实时30秒终止。失败计数只供诊断，不表示失败写入没有发生；不自动重试、续传、选择启动分区或重启。

ESP `li_espidf_ota_stage` 使用独立HTTPS CA、证书/主机名校验、5秒网络调用超时、禁重定向与非运行备用APP分区，已通过灯/按钮C3编译。6组宿主真实HTTPS/文件故障检查覆盖传输边界；宿主source是OpenSSL实现，finish为文件夹具。开发产品从显式离线 `ota_transport.ca` 配置提供方，不继承MQTT CA；完整策略和本次镜像健康确认也是必要条件。接口边界见 [固件说明](../firmware/README.md#独立ota传输配置与镜像健康)。

## 受控下载

```sh
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota download \
  --input "verification.json" --output-dir ".dev/firmware-staging-001"
```

私有HTTPS源可显式增加 `--ca-file "/absolute/path/ca.crt"`；PEM根证书包最多64KiB、1–16张证书。它只扩展HTTPS传输信任，不替代OTA签名公钥。客户端始终验证服务器证书和主机名，不关闭TLS检查。

先复用同一Rust解析和完整预检，再创建全新暂存目录；原请求和status=started回执持久提交后才发送GET。已有目录或符号链接返回4，不读取旧内容、不覆盖、不续传，也不再GET。目录Unix权限0700，所有本次文件0600。父目录须已存在且由调用者选择，工具不改变现有权限或网关网络配置。

只发送一次无账号凭据的GET，禁止代理、重定向和库的自动重试，明确请求identity编码。仅接受HTTP200、无压缩编码，以及与声明相同的Content-Length（如提供）；不接受206，也不发Range续传。连接最长5秒、单次读取等待最长10秒、整个HTTP传输最长30秒。当前不支持鉴权下载、URL查询令牌或代理网络。

收到内容后有界写入 `image.part`，绝不写超过声明长度的数据；发现超额帧即停止。`bytes_received`记录已接受并写入文件的字节，不包含被拒绝的超额帧。完成后对同一个文件描述符重新执行完整Rust预检和实际长度/摘要校验，以传输结束时的可信时间检查有效期。此时使用的是冻结的原信任和设备快照，不代表已查询实时撤销、设备状态或安装授权。

成功通过同目录不覆盖hard-link生成 `firmware.bin`，移除本次part名称，再原子持久保存status=verified回执。回执结构为Schema的 `$defs/download-receipt`，绑定整个请求摘要、制品身份和完整verification报告。网络、HTTP和IO故障返回5；预检、传输策略及镜像不符返回2。回执生成后同样输出JSON；目录创建前的拒绝或回执IO故障输出stderr错误对象。

失败保留 `request.json`、失败回执及可能存在的 `image.part`，不把部分文件作为成品。若目标名称被其他写入者占用，保持其内容且返回失败。若进程中断，started只是历史开始记录；不能据它推断进程仍在运行。响应丢失后读取原目录的receipt.json，不重新提交同目录。回执未成功落盘时即便有firmware.bin，也不能推断本次下载已完成；可另用离线verify核对，但仍不授予安装权限。

当前没有自动续传或后台下载服务。NAS网关默认内部网络不因本工具开放外部访问；可以在受控宿主准备制品，再由后续升级服务按独立权限交付。正式升级任务仍须在写入前重新读取真实设备和当前授权，验证实际写入字节，不能沿用暂存路径或历史成功自动安装。

## 验证与范围

运行 `npm run test:ota`。共享[测试向量](examples/ota-firmware.json) 使用 Node Ed25519 和共享 JCS 生成，由 Rust ring 独立验证；其中 seed_hex 为公开测试种子，镜像只是文本字节，不能烧录。测试覆盖签名域、篡改、独立信任、撤销、精确硬件/版本/模型、有效期、电源/忙碌状态、容量、流式读取预算、文件故障和 CLI 发现；真实HTTPS检查另覆盖独立CA、错误主机名、请求先落盘、权限、不覆盖、重定向/断流/坏摘要/超长、传输期间到期及进程中断。

Schema 仅表达结构；签名、完整版本值域和跨字段规则以共享 Rust 为准。制品校验和下载不代表完整 OTA 交付；实际固件目标编译、正式签名发布、升级任务、设备执行和断电回滚均须独立验收。

离线密钥与签名包使用独立 [签名制品合同](ota-release.md)，共享check_manifest验证制品/独立信任，设备执行继续通过check_request追加实时设备条件。签名包准备不更改现有verify/download语义。
