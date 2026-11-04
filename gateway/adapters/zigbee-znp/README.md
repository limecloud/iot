# ZNP串口适配器

第一方Rust实现TI ZNP的MT会话、固定SYS诊断、协调器邻居发现、已有设备的ZDO访谈、环境属性与固定On/Off，协议类型留在适配器内部。提供独立`limeiot-znp`组件供本地CLI调用；网关可选集成通过库API装配固定环境观测，配置与来源隔离见[观测来源合同](../../../contracts/observation-sources.md)。诊断候选不取得平台身份。

```sh
cargo build --locked -p limeiot-zigbee-znp
node packages/cli/src/main.mjs zigbee schema
node packages/cli/src/main.mjs zigbee neighbors --serial "/dev/ttyUSB0" \
  --coordinator-ieee 0102030405060708
npm run test:zigbee
```

参数、报文、期限、取消、错误与上游依据以[正式合同](../../../contracts/zigbee-diagnostics.md)及[Schema](../../../contracts/zigbee-diagnostics.schema.json)为准。测试通过Unix伪终端与软件NCP运行实际串口代码，实机按用户要求跳过。

`neighbors`分页读取短地址0的协调器邻居表，最多64条，前后核对预期协调器IEEE，不修改网络。结果可能含旧邻居，也可能遗漏路由器下的设备；后续须访谈、读属性并明确绑定。独立组件不能与正在占用NCP的网关并行打开串口。`npm run test:zigbee:discovery`运行会话、分页PTY和严格合同检查，覆盖实际64条容量、页变化、取消及拒绝部分输出。

`Session.permit_join`及独立CLI `zigbee permit-join --serial "/dev/ttyUSB0" --coordinator-ieee 0102030405060708 --duration-seconds 60`提供已有协调器的有限入网窗口，0明确关闭，最大120秒。固定单播到协调器，写前核对IEEE与角色、写后再核对IEEE；不重试、不广播、不创建平台绑定。执行失败保留unknown与禁止重试标记；成功仅为protocol_accepted，不证明设备加入或窗口仍开放。`npm run test:zigbee:commissioning`验证精确报文、取消、状态未知、会话连续性与正式合同。运行中网关的耐久意图、同actor写入口和CLI原键查询已接入，见[入网管理](../../../contracts/zigbee-operations.md)；家庭网页与Swift/Kotlin已提供独立入网核对和原操作查询，完整原生App及硬件效果另验。独立串口命令仍须先释放NCP。

运行中网关使用同一会话的`Session.neighbors`和`Session.interview_ieee`，通过本地HTTP/CLI提供邻居发现与端点访谈，不另开串口。IEEE访谈每次重新解析短地址，前后复核设备/协调器；不注册AF或读取属性。会话中插入发现和访谈保持已有AF编号和注册状态，失败或取消关闭传输。正式请求及结果见[网关发现Schema](../../../contracts/observation-discovery.schema.json)，组合检查入口为`npm run test:zigbee:gateway-discovery`。

`Session.read_on_off/set_on_off`及CLI `zigbee read-onoff/set-onoff`提供固定On/Off端点的读取与明确开关。控制前精确核对Basic指纹与manufacturer_code，成功仅为协议受理，实际状态另行读取；超时或取消保留未知，最多一个控制命令，无Toggle或自动重试。主机端点239与环境240分开，AF编号仍全会话唯一。参数与边界见[On/Off合同](../../../contracts/zigbee-diagnostics.md#固定onoff端点)，检查入口`npm run test:zigbee:onoff`。运行网关另通过[属性桥接](../../../contracts/property-bridges.md)接原命令、同串口调度、网页与自动化；独立CLI直接调用前仍须释放NCP。

`frame`只处理有界MT字节，`session`管理请求及失败关闭，`zdo`解释访谈，`discovery`解释邻居表，`zcl`复用AF端点、编号和回执关联，`environment/on_off`分别映射固定属性与命令，`serial`隔离Unix平台，CLI转交有界参数并校验回执。复用现有Tokio、serde和libc，不引入外部IoT核心、串口库或通用插件框架。
