# 设备加密存储

本合同定义C3固件可选的 `hmac-nvs-v1` 档位。设备生命周期和身份绑定由平台控制；底层复用固定ESP-IDF 6.1的HMAC和NVS XTS-AES，通过 [storage.c](../firmware/components/limeiot_espidf/src/storage.c) 隔离。准备回执使用 [device-storage.schema.json](device-storage.schema.json)。

## 构建与离线准备

加载固定SDK环境后构建：

```sh
npm run build:firmware -- --storage hmac --hmac-key-id 0
```

密钥块编号必须明确为0–5；默认开发档位保持明文，不接受该参数。加密构建输出按版本、代次、档位及块编号隔离，灯/按钮均使用独立的 `partitions.hmac.csv`。本命令只构建，不连接设备或写eFuse。

离线准备沿用 [固件配置](../firmware/README.md#身份与离线配置)，另提供该设备独立的32字节HMAC根密钥文件和同一块编号：

```sh
".dev/firmware-tools/venv/bin/python" "firmware/tools/provision.py" \
  --config ".dev/device-config.json" --output ".dev/device-encrypted-001" \
  --hmac-key-file "/private/device-hmac.bin" --hmac-key-id 0
```

密钥文件必须是当前用户所有的普通文件，权限不允许组/其他用户访问，单一硬链接，路径不含符号链接；长度精确32字节，拒绝全0/全FF。根密钥须由受控流程随机产生且每设备独立，工具不能通过文件长度证明随机性或跨设备唯一性。生产根密钥、烧录与硬件锁定属于独立制造流程，当前命令不生成或写入硬件密钥。

输出新0700目录，完成后仅包含0600的 `nvs.bin`、`storage-binding.bin` 和最后耐久提交的 `provisioning.json`；已有目录不覆盖。Wi-Fi、设备证书私钥、完整策略等明文只在临时私有目录供官方生成器读取，成功/正常失败后清理；进程被强制终止可能留下受权限保护的暂存目录，不承诺安全擦除。根密钥和派生XTS密钥不写入交付目录。回执公开指纹只用于核对准备材料，不能证明实体芯片已具有该密钥。

## 分区与绑定格式

| 分区 | 偏移 | 大小 | 行为 |
| --- | --- | --- | --- |
| nvs | 0x9000 | 0x6000 | 加密配置与设备身份 |
| journal | 0x12000 | 0xe000 | 加密命令回执与独立OTA日志 |
| ota_0 / ota_1 | 0x20000 / 0x200000 | 各0x1e0000 | 原应用槽位置与容量 |
| coredump | 0x3e0000 | 0x1f000 | 此档位为绑定区预留末页 |
| li-security | 0x3ff000 | 0x1000 | data子类型0x40、readonly绑定元数据 |

这是一套明确的分区档位，不通过OTA自动迁移旧明文安装；固件升级不会替换分区表或认领所有权。配置镜像、绑定镜像、构建块编号及实际芯片预置根密钥必须匹配。不要混用开发档位的分区表。

绑定镜像前208字节的格式如下，其余填FF。整数均为单字节；标识ASCII、首字符字母/数字，其后允许字母/数字/下划线/短横线，长度1–64。

| 字节偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 8 | `LI-NVS1`及结尾NUL |
| 8 / 9 | 各1 | 版本1、密钥块编号 |
| 10 / 11 | 各1 | device_id与space_id字节长度 |
| 12 / 76 | 各64 | 标识正文，剩余零填充 |
| 140 | 32 | 随机nonce |
| 172 | 4 | 保留字节，必须全0 |
| 176 | 32 | HMAC-SHA256(root_key, 前176字节) |

XTS两个32字节密钥分别使用标准HMAC-SHA256派生，输入是固定SDK的32位小端EKEY_SEED `0xAEBE5A5A` 或TKEY_SEED `0xCEDEA5A5` 各重复8次。Python仅适配这一SDK格式，NVS布局和加密由固定官方生成器实现；不定义新的加密算法。

## 启动与拒绝路径

初始化nvs或journal之前，适配器要求明确的HMAC_UP块，确认密钥读保护、写保护和用途写保护，检查只读绑定分区的类型、大小、版本、块编号、规范标识和MAC。跨设备密文或错误根密钥在进入NVS初始化前被拒绝。读取配置后，再核对设备/空间、`storage_ver=1` 及 `storage_key_id`，不让可解密材料自动改变身份。

只从已注册HMAC方案读取现有安全配置，调用 `nvs_flash_secure_init_partition`，随后清除临时派生密钥。适配器不使用可能生成密钥的 `nvs_flash_init`，不调用密钥生成、eFuse写入或整分区擦除接口；失败不降级明文。默认档位拒绝带加密档位标记的配置。NVS内部初始化/掉电恢复仍由固定SDK处理，不把宿主接口计数等同于真实Flash零写入证明。

HMAC绑定认证设备/空间及密钥材料，NVS的XTS加密不提供完整分区的消息认证，也不检测同设备旧备份回退。可选[本机身份记录](device-enrollment.md#c3本机密钥与证书导入)另有逐记录硬件HMAC；这不扩展为整个journal分区认证。该能力保护静态存储，不能代替Secure Boot、完整Flash保护、设备密钥生命周期、物理认领或自动换证。当前不把HMAC档位称为完整量产安全方案。

## 验证与当前边界

设置完整固定版本的 `IDF_PATH` 或 `LIMEIOT_IDF_PATH` 后，运行 `npm run test:firmware:storage`。检查包括正式回执Schema、独立官方HMAC派生/解密/原版解析器CRC与全部身份/配网字段，以及实际C适配器的缺钥、保护不足、损坏、错绑、错误方案、读取/派生/NVS失败。宿主原生API为显式夹具，C检查使用ASan/UBSan；默认离线策略/CA配置另作回归。

CA-only的`identity.mode=device-local`必须使用本档位，准备回执增加可选`device_local_identity=true`；配置无叶证书或设备私钥，相关NVS标记由官方解析器独立核对。旧完整凭据模式继续兼容，不自动切换身份模式。

当前已完成灯/按钮两档目标编译，实机读保护、eFuse状态、Flash掉电及板上恢复按用户要求跳过，hardware=false。设备本机密钥/CSR和导入按独立合同验证；物理认领与换证继续独立推进。结果见 [实施进度](../docs/24-实施计划与进度.md)。
