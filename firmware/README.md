# 设备固件

本目录提供自研 C 设备核心、ESP-IDF 适配器和桌面灯/按钮产品工程。核心通过真实 MQTT Broker 与 Rust 网关联调；ESP32-C3 目标尚未编译、烧录或完成实机验收。当前没有发布可安装镜像。

## 目录与边界

| 目录 | 职责 |
| --- | --- |
| `components/limeiot_core` | 模型校验、应用会话、状态、事件、命令期限和耐久回执 |
| `components/limeiot_espidf` | MQTT 5 mTLS、NVS、随机数、SHA-256、时钟与有界工作队列 |
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
```

`test:firmware` 校验生成文件并以 ASan/UBSan 运行 9 组核心检查，以及 2 项真实 Broker/Rust 网关联调。宿主驱动的观测来源为 `host-fixture`，不代表物理硬件。宿主检查在 macOS/Linux 使用 OpenSSL；固件适配器使用 ESP-IDF 的密码库。

`test:provisioning` 使用 `.dev/firmware-tools/venv/bin/python`；可用 `LIMEIOT_FIRMWARE_PYTHON` 指定已安装固定依赖的解释器。

## ESP32-C3 构建准备

工程声明使用 ESP-IDF **v6.1**，源修订 `fff9895c82d744c7237be8847347bdd1b07c6643`。组件版本声明为 MQTT 1.1.0、cJSON 1.7.19、led_strip 3.1.1。尚未生成经目标构建验证的组件锁文件。

先按官方方式取得 SDK、必要子模块与 ESP32-C3 工具链。将 `IDF_TOOLS_PATH` 指向本项目 `.dev/esp-tools`，避免全局安装；Python 推荐使用项目虚拟环境。加载官方 `export.sh` 后，下列命令是待验证的目标构建入口：

```sh
idf.py -C "firmware/products/desk-node" \
  -B "$PWD/.dev/firmware-build/lamp" \
  -DIDF_TARGET=esp32c3 \
  -DSDKCONFIG="$PWD/.dev/firmware-build/lamp/sdkconfig" build

idf.py -C "firmware/products/desk-node" \
  -B "$PWD/.dev/firmware-build/button" \
  -DIDF_TARGET=esp32c3 \
  -DSDKCONFIG="$PWD/.dev/firmware-build/button/sdkconfig" \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.button" build
```

2026-11-01：官方 Git 克隆/按需检出遇到 HTTP/2 断流和 early EOF，固定修订归档下载超时。已停止重复获取，源文件及工具链不完整，本次未执行芯片编译。宿主通过不能替代该检查。

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

## 产品与恢复

采购候选为 ESP32-C3-Zero-M，尚无板卡支持证据。灯角色使用 WS2812，默认 GPIO10、一颗；按钮为外接 GPIO3 对地、内部上拉、40 ms 去抖。接线前按实际板卡修订核实引脚、电压与恢复入口；代码拒绝绑带 GPIO2/8/9 和 USB GPIO18/19。未采购、未实测的引脚不能视为固定 BOM。

灯样机将驱动上限限制为满量程的 20%；模型亮度 100% 表示产品允许上限。`driver.applied` 只证明驱动返回成功，不表示独立光学测量。离线按钮事件不补发。

开发板没有可信 RTC，冷启动后在物理 USB 控制台输入 `time <Unix秒>`；随后保持 CA、主机名、证书有效期验证。不开启未认证 SNTP 或任意证书回退。关闭开发时钟选项时，需要产品实现受保护时钟，当前示例直接停止启动。

NVS 配置或命令日志损坏时停止，不自动擦除身份。分区表预留双 OTA 槽，待验证镜像在应用启动后 90 秒内未完成 IoT 握手会请求回滚；计时包含等待时钟和配网。尚未实现签名清单、下载和升级发布，不能据此宣称 OTA 完成。
