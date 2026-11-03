# ZNP串口适配器

第一方Rust实现TI ZNP的MT会话、固定SYS诊断与已有设备的ZDO只读访谈，协议类型留在适配器内部。当前提供独立`limeiot-znp`组件，由本地CLI调用；没有装配进网关或授予候选设备身份。

```sh
cargo build --locked -p limeiot-zigbee-znp
node packages/cli/src/main.mjs zigbee schema
npm run test:zigbee
```

参数、报文、期限、取消、错误与上游依据以[正式合同](../../../contracts/zigbee-diagnostics.md)及[Schema](../../../contracts/zigbee-diagnostics.schema.json)为准。测试通过Unix伪终端与软件NCP运行实际串口代码，实机按用户要求跳过。

`frame`只处理有界MT字节，`session`管理请求及失败关闭，`zdo`解释访谈，`serial`隔离Unix平台，CLI只转交有界参数。复用现有Tokio、serde和libc，不引入外部IoT核心、串口库或通用插件框架。
