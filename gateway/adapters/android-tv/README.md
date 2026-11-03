# Android TV 受限 ADB 适配器

`limeiot-android-tv` 是第一方 Rust 适配库，由网关消费已经耐久标记的命令；不建立第二套命令账本。当前支持固定电视上的九种按键及白名单应用启动，结果最多为 submitted。小米MiTV4-ANSM0单样本已通过本机网关/网页正式绑定及右、返回、主页的有限控制实验；NAS出口、其余按键、应用启动和完整套件另验，证据见[实施进度](../../../docs/24-实施计划与进度.md#450-小米电视网页与网关adb实机联调)与[型号台账](../../../docs/30-设备支持矩阵与证据台账.md#8-dev-cand-08-网页与网关adb控制)。

## 运行前提与配置

复用所有者已允许的 ADB 连接、已安装的 adb 可执行文件及独立本地服务器；适配器不安装工具、不开放电视调试、不执行 connect/start-server/kill-server。服务器必须位于127.0.0.1，端口为1024以上且不使用默认5037；当前目标仅支持固定 RFC1918 IPv4 TCP 地址，不支持 USB、任意主机或客户端覆盖目标。

通过绝对路径 `LIMEIOT_TV_CONFIG` 配置独立文件，启动时读取为宿主接入候选；缺省不准备候选。文件保留 `bindings` 字段名，但它不自动新增或替换数据库中的执行绑定。以下为结构示意，路径、指纹、序列号与应用授权须来自实际所有者确认，不能直接作为真实设备配置使用：

```json
{
  "schema_version": 1,
  "bindings": [{
    "device_id": "device-tv",
    "adapter_id": "living-room-tv-adb",
    "config": {
      "schema_version": 1,
      "adb_path": "/path/to/adb",
      "state_directory": "/path/to/private/android-home",
      "server_port": 5049,
      "target": "192.168.31.94:5555",
      "fingerprint": "replace/with/exact:build/version:user/release-keys",
      "device_serial": "replace-with-approved-serial",
      "applications": [{ "application_id": "com.example.player", "category": "leanback" }],
      "timeout_ms": 3000
    }
  }]
}
```

配置严格拒绝未知字段、重复 JSON 键，以及重复逻辑设备、适配 ID、目标或序列号；最多16个候选，每候选最多32个授权应用。`category` 仅接受 leanback/launcher，分别使用标准 LEANBACK_LAUNCHER/LAUNCHER Intent。单操作总预算50–5000ms，还受原命令期限限制。

设备须已绑定与执行端兼容的精确模型，首轮使用[仅动作模型](../../../contracts/models/android-tv-remote.json)。每个 route.revision 为上述 config 对象规范化后的完整 JCS 摘要；模型动作的路径、语义、risk、idempotent、输入范围及输出证据由 supports_model 核对。宿主配置及资源在打开数据库前验证，当前设备与模型是否匹配在候选查询、明确绑定及调度时检查。

### 已有空间的明确接入与配置迁移

1. 保持核心初始配置与已有数据库的摘要一致，按原模型安装/绑定用例准备逻辑设备；不要通过修改核心 routes 或删除数据库接入。
2. 准备宿主候选并启动网关。家庭网页的“电视接入与应用”或 CLI 可读取候选及当前 execution-binding；核对实际电视地址、构建、序列号和应用授权。
3. 所有者明确提交 bindings.bind，固定候选 route、当前绑定修订和模型修订。提交成功后才探测并建立新适配会话；bound 与电视当前可用分别判断。已有首次启动静态 routes 仍可运行，但不再要求新接入修改启动 routes。
4. 更改 config 后重启网关，旧路由仍保存；与新候选摘要不符时不执行。读取新候选和当前修订，再明确绑定。宿主配置没有热加载入口，修改文件不自动迁移授权。
5. 撤销保存持久阻断记录，清除会话并阻止 MQTT 回退；没有候选仍可查询和撤销。恢复旧绑定操作只返回原决定，不重新启用路径。

HTTP、机器合同、在途/OTA互斥和恢复规则见[执行路由与绑定](../../../contracts/execution-routes.md)，可执行命令见[CLI](../../../packages/cli/README.md#电视适配绑定与应用发现)。现有空间完整浏览器到假ADB旅程已通过；旧配置若缺失或分流模型动作，当前ADB提供方不会激活，须明确修复绑定。具体软件证据及实机缺口见24第4.7节。

## 身份、发现与执行

每次发现或执行都通过一次固定远端只读命令 `getprop ro.build.fingerprint && getprop ro.serialno` 读取两项身份，对照固定配置；不拼入配置值或业务输入，不在失败后退回两次查询。仅接受恰好两个完整的LF/CRLF行，缺失、截断、额外输出、无效UTF-8、标准错误或任一身份不匹配均拒绝。合并查询减少ADB客户端与远端Shell的启动开销，不放宽整次操作期限。指纹不是唯一身份，缺少可核对序列号时拒绝执行。序列号与 ADB 授权也不构成硬件密码学证明，逻辑设备的归并仍需所有者在设备侧确认。

应用通过 Android 6/API23 已有的 `pm list packages -e` 发现。发现表示包已安装且启用，不证明存在启动 Activity、APK 发布者身份或应用已到前台；启动前重新发现，并核对当前配置白名单。应用 ID 必须是有界的 ASCII 多段包名，拒绝命令、Intent、组件和目标地址注入。公开 Adapter 方法不能替代网关的耐久与当前授权检查。

网关按当前绑定修订保存后台探测的应用缓存，GET只读返回 fresh、observed_at 和每个包的 authorized；缓存严格小于15秒才有效。网页将已发现与已授权分别展示，未授权包不能从列表启动；修改白名单需要宿主配置迁移与明确绑定，不通过网页发现结果自动授权。

业务调用只生成 `input keyevent <固定键码>`，或向固定允许包发送 `am start -W -a MAIN -c <固定类别> -p <允许包>`。不执行宿主 Shell，不提供任意电视 Shell、安装、卸载、音量写入、截图、刷机或去广告能力。退出成功且输出符合预期才报告 submitted；启动应用还需 Status: ok，不能将其报告为 observed。

子进程使用清空后的环境、固定 PATH/locale、独立 ANDROID_USER_HOME/ADB_VENDOR_KEYS 和显式服务器地址，不继承网关令牌。stdin关闭，stdout限制128KiB、stderr限制4KiB；超时、越界或读取失败后终止并回收当前子进程。已经调用业务进程后结果不明保持 unknown，不自动重试、换启动类别或改用 MQTT；原始进程诊断不进入命令错误。

每绑定串行执行，排队也消耗原期限；只读预检后再由核心检查当前授权。网关约每5秒重新探测，失联清除适配会话。停机或结果提交失败不能证明电视没有执行，恢复只查原操作。

## 验证

运行 `npm run test:tv`；套件构建workspace，新增已有空间旅程固定定位离线模型校验器并尊重显式LIMEIOT_MODEL_VALIDATOR，详见CLI。单适配器故障与模型准入入口为 `cargo test --locked -p limeiot-android-tv`。Rust与浏览器旅程共用[假ADB](../../../tests/fixtures/android-tv/adb.py)，只记录本地模拟副作用，不访问电视。API23命令选择依据AOSP android-6.0.1_r81的 [Pm.java](https://android.googlesource.com/platform/frameworks/base/+/android-6.0.1_r81/cmds/pm/src/com/android/commands/pm/Pm.java)；固定身份查询的命令传递与远端 `sh -c` 依据同版本的 [commandline.cpp](https://android.googlesource.com/platform/system/core/+/android-6.0.1_r81/adb/commandline.cpp) 和 [services.cpp](https://android.googlesource.com/platform/system/core/+/android-6.0.1_r81/adb/services.cpp)。源码依据不替代指定电视的实际命令、权限和厂商差异验收。

TV Agent、音量/静音回读、宿主配置热加载、跨执行端切换及通用进程插件合同仍有独立实现工作。现有 NAS 内部网络不能直接推导可达电视；本适配器尚未随 NAS 镜像构建/验证。
