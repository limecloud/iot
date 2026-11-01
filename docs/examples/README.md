# 设计示例与一致性向量

这些文件是设计阶段的机器可读夹具，供 Agent 理解输入、输出与失败语义。Schema 仅覆盖本组例子所需的规范子集，不是已经发布的正式合同；不用于生产部署。

| 文件 | 用途 |
| --- | --- |
| [thing-model.json](thing-model.json) / [button-model.json](button-model.json) | 灯光和按钮模型正文 |
| [thing-model.schema.json](thing-model.schema.json) | 该模型示例子集校验 |
| [command-request.json](command-request.json) / [command-request.schema.json](command-request.schema.json) | CLI/Agent 的业务输入，不携带设备会话；由网关转换为 MQTT 命令 |
| [mqtt-command.json](mqtt-command.json) | 当前会话、有效期限、合法属性写入 |
| [mqtt-command-expired.json](mqtt-command-expired.json) | 结构合法但已过期 |
| [mqtt-command-conflict.json](mqtt-command-conflict.json) | 同命令身份、不同请求的冲突 |
| [mqtt-command-invalid-value.json](mqtt-command-invalid-value.json) | 报文合法但亮度超出模型范围 |
| [mqtt-result.json](mqtt-result.json) / [mqtt-state.json](mqtt-state.json) | 原命令结果与实际观测 |
| [mqtt-command.schema.json](mqtt-command.schema.json) / [mqtt-result.schema.json](mqtt-result.schema.json) | 两类报文示例校验 |
| [automation.json](automation.json) / [automation.schema.json](automation.schema.json) | 按钮触发灯光的声明式规则 |
| [capability-catalog.json](capability-catalog.json) | 计划中的工具发现结构，不代表已部署能力 |
| [capability-package.json](capability-package.json) | 有界互动灯光组合，未签名，不可部署 |
| [model-invocation.json](model-invocation.json) | 有本地数据政策与预算的模型调用 |
| [ota-manifest.json](ota-manifest.json) | 无实际镜像和签名的清单示例，必须拒绝安装 |
| [expected-results.json](expected-results.json) | 固定时间、会话和逐例预期 |

结构检查范围：物模型、业务命令输入、MQTT 命令/结果、自动化有对应 Schema；其余 JSON 先检查解析及明确的引用不变量，不声称已通过尚未编写的正式 Schema。`expected-results.json` 的 `json_parse_only` 表示这个范围。未签名组合包与无效 OTA 清单是拒绝安装的负例，不是可运行制品。

所有ID、设备和时间均为虚构。模型摘要为正文规范化后的真实SHA-256；本组采用ASCII键、字符串与整数，是RFC 8785 JCS可用常规排序JSON等价表示的子集。正式生成器必须实现完整JCS，不能将该子集算法推广到任意数值和Unicode键。

先验证JSON与Schema，再依据固定时间、会话、模型和历史命令进行语义检查。结构合法不代表当前授权通过、设备存在或可产生真实副作用；发送和结果示例分开，初始state为关灯，随后result为设备报告开灯。

工具目录仅为局部设计示例；实际目录必须按当前主体与空间生成，并提供正式动作的完整输入/输出合同。样例中的恢复动作保留原 command_id；模型输出或传输 ACK 均不产生独立的执行证据。
