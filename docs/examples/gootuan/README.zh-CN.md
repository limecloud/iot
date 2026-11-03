# Gootuan 灯光与触摸示例

[English](README.md) | [集成说明](../../integrations/gootuan/README.zh-CN.md)

本例消费当前正式合同，不定义新合同，也不是完整机器人模型。模型仅包含两个普通灯光属性与一个有界合成触摸事件；触摸后两台虚拟灯开启。端点刻意复用已有装配器的 `device-button`、`device-lamp` ID，二者绑定相同模型。

| 文件 | 作用 |
| --- | --- |
| [model.json](model.json) | Schema 1 候选，无动作、电机、相机或语音 |
| [rule.json](rule.json) | 现有事件/set规则，两步独立受理 |
| [event.json](event.json) | 规则预演事件，集成程序补充实时事件 ID/时间 |
| [verify.mjs](verify.mjs) | 正式 Schema/共用 Rust 校验及可选隔离软件旅程 |

```sh
npm ci
cargo build --locked -p limeiot-model-validator -p limeiot-gateway -p limeiot-simulator
node "docs/examples/gootuan/verify.mjs"
```

运行 HTTP/MQTT/SQLite 时，按[本地开发](../../../deploy/dev/README.md)提供项目内 Broker：

```sh
python3 "tools/bootstrap-broker.py"
node "docs/examples/gootuan/verify.mjs" --integration
```

默认检查无网络副作用。`--integration` 只在新建隔离本地测试栈中明确部署并执行规则，验证预演零副作用、部署后两台虚拟结果、重复/历史事件不再触发执行，然后停用规则。示例冷却时间设为零，避免冷却掩盖意外重放。产物留在被忽略的 `.dev/gootuan-example-*`，结果记录不含凭据。

不能把虚构 ID 提交生产空间，或把模型当作签名发布。规则不是等待物理完成的工作流，也不是同步时钟；没有实现玩具运动、安全停止、看图、语音、跳舞或合唱。停用后续触发不取消已受理命令，实际验证范围见[案例记录](../../integrations/gootuan/verification.json)。
