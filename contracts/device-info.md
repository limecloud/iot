# 当前设备信息

`device_info` 是原生设备在当前应用会话中的自报信息，供网关读取版本、硬件目标及升级条件。它不证明物理硬件真实、制品可信或调用者具有安装权限。

## MQTT 输入

Topic 为 `limeiot/v1/{space_id}/{device_id}/up/device_info`，QoS 1、非 Retained；复用 v1 信封、设备身份、当前模型绑定、`boot_id`、`session_id` 与递增 `seq`。`body` 直接使用 [ota.schema.json](ota.schema.json) 的 `$defs/device`，不额外包一层 `device`，不复制该结构。

所有字段必须完整提供，包括未知电量时的 `battery_percent: null`。未知字段、身份或模型不一致、无效值均拒绝，失败不替换原报告。MQTT 原文最多 16 KiB，最大深度 16、2048 个节点；重复 JSON 键和不安全数字拒绝。

版本使用三段无前导零的 u32 值；标识和值域复用共享 Rust OTA 校验。报告本身不令设备进入 ready，仍须当前握手和完整状态快照。旧会话、旧启动代次、冲突或乱序消息按既有会话规则拒绝。

## 本地读取与有效期

本地设备列表与详情的 `device_info` 为 null 或以下结构：

| 字段 | 含义 |
| --- | --- |
| `device` | 完整的 `$defs/device` 自报正文 |
| `boot_id` / `session_id` / `seq` | 报告绑定的启动、应用会话和序列 |
| `received_at` | 网关接收报告的 UTC 时间 |
| `fresh` | 本次读取时重新计算的有效性 |

`fresh=true` 同时要求当前模型授权有效、设备 ready、最近消息年龄在 `[0, 15秒)`，报告属于同一设备/模型/启动/会话且报告序列不超过当前序列，独立报告年龄在 **`[0, 5秒)`**，以及设备值域有效。未来接收时间拒绝；恰好 5 秒已失效。重复报告和其他状态、事件或心跳不延长报告有效期。

当前报告缓存只保存在会话内存，不进入 SQLite 状态快照或备份；重启、Broker 恢复、新握手、离线、模型换绑或撤销清除。升级任务可以另存baseline/approval作为历史观测，恢复时不会将其写回当前报告。存储提交失败时不公布新报告；只有临时缓存变化时也须正确更新内存。过期报告可以留作本进程诊断，但 `fresh=false`，不可据此安装。远程 RPC 继续使用独立投影，本次未新增远程读取权限。

## 固件适配

C 核心的可选 `read_device_info` 端口在完整快照发布成功后读取并发布报告；读取失败或值域非法时不发布。端口与属性驱动在同一工作线程调用。ESP-IDF 适配器只转发端口，产品负责真实取值。

当前 C3 开发产品使用应用描述中的版本和安全代次、实际备用 OTA 分区容量，以及 NVS 中的硬件修订。`CONFIG_LIMEIOT_BOARD_ID` 默认 `c3-development`；未核实的采购候选型号不能作为已验证板卡上报。产品标识分别为 `desk-node-lamp` 与 `desk-node-button`。

ESP-IDF 引导程序描述的整数版本 N 映射为 `0.0.N`，不是 ESP-IDF 版本号；当前默认 N 为 1。待确认状态读取失败时保守报告 `pending_update=true`。USB 有线开发样机声明外接电源，电量为 null，没有电池测量。安装器尚未实现，`safe_to_update` 固定 false。

宿主测试端口明确报告 `chip=host`、`board=host-fixture` 和虚拟容量，不能作为 C3 实机证据。当前 Rust 模拟器不提供该报告，缺失报告不妨碍普通控制，但无法作为当前升级条件。

## 与 OTA 的关系

[离线校验与宿主下载](ota.md) 仍消费调用者提供的冻结 `device` 输入。[本地升级任务](ota-tasks.md) 在计划、明确批准和执行预检时读取当前报告；`fresh`本身不产生授权。设备下载、验证/写入、执行阶段耐久意图、启动确认与回滚仍待实现。

发现入口为 `tools/catalog.json` 的 `device_information`。验证覆盖 Rust 领域/存储故障检查、11 组 C 核心检查及真实 Broker → C 核心 → Rust → 本地 HTTP；目标编译与实机验收分别记录。
