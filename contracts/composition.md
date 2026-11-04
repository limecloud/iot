# 声明式事件组合包

[机器Schema](composition.schema.json)定义首版软件组合包。CLI提供`composition schema/compile/plan`，把已声明的设备角色编译成[正式DSL事件规则](rules.md)，复用网关校验、预演、部署、命令、去重和恢复。首个可运行样板为[触摸伴读灯](../examples/compositions/reading-companion/README.md)。

## 输入和编译

包包含schema_version、package_id、version、name、modules、rule和sample_event_data，未知字段拒绝。package_id为1–64位小写字母、数字或连字符，首位字母；version为无前导零的三段数字，每段最多六位。包正文最多32KiB、8层和2048节点；重复键、非法Unicode和不安全JSON数字沿共享JSON边界拒绝。

modules声明1–8个角色及各自精确model_revision。rule中的device填写角色名，每个声明必须实际使用，不能引用未声明角色。首版只接受事件触发、空conditions和1–16个静态set操作；其他DSL能力继续使用原规则入口。sample_event_data仅作为预演输入，不发布设备事件。

bindings是角色到实际device_id的JSON对象，最多4KiB，角色必须精确对应modules。一个设备只绑定一个角色；同设备的多个属性共用该角色。设备ID和最终实例ID为1–128位ASCII字母、数字、下划线或连字符。

编译只替换规则ID、触发设备和操作设备，保留路径、值、顺序及整数毫秒冷却。包内rule.id为模板标识，最终值由必填`--id`指定。编译输出不是可执行脚本，不接受远程代码、安装钩子或隐式模块发现。

| 输出 | 含义 |
| --- | --- |
| package_digest | 完整包的规范JSON SHA-256，版本相同而正文不同也会改变 |
| bindings_digest | 角色绑定的规范JSON SHA-256 |
| rule_revision | 最终规则的规范JSON SHA-256，与网关预演修订核对 |
| expected_models | 角色、实际设备和预期物模型修订 |
| required_permissions | 从实际规则派生的事件读取和属性写入清单，供审阅，不授予权限 |
| rule / simulation_input | 可交给现有规则工具的完整输入 |
| gateway_checked / deployed | 离线编译均为false；在线规划只把前者设为true |

摘要复用现有[规范JSON模块](../packages/protocol/model-validation.mjs)。摘要能绑定内容，不证明发布者身份、签名、硬件归属或物理兼容。

## 在线规划

`composition plan`使用现有本地所有者Bearer或私有Token文件，要求HTTPS或loopback HTTP，不跟随重定向。先逐个读取实际设备，核对设备身份、ready及精确物模型修订，再调用rules.validate和rules.simulate。预演复用[完整规则证据检查](../packages/protocol/rule-simulation.mjs)，拒绝执行标记、修订或预计操作不符。返回前再次核对设备绑定，响应有5秒期限、64KiB及节点/深度上限。

规划只调用设备GET和无设备副作用的验证/预演POST，不部署、不发命令、不调用模型。checked_at表示本次检查时刻；gateway_origin与space_id绑定被检查的实例。规划不冻结设备绑定，两个读取之间及规划之后仍可能发生变化，不能将检查结果当作长期许可。

```mermaid
flowchart LR
    A[组合包与角色绑定] --> B[编译完整DSL规则]
    B --> C[实际模型核对与预演]
    C --> D[所有者明确部署]
    D --> E[现有规则引擎与命令账本]
```

正式部署继续使用rules.deploy；执行时由网关按当前模型、授权、会话、路由、队列和期限核验。首版没有持久的包安装对象，不提供包签名信任、部署后精确模型锁定、跨规则事务或新增权限审批。兼容模型换绑仍沿原规则合同，不会因为包的预检查修订而自动阻止。

## 执行和恢复

触发一次事件后，操作按现有DSL顺序受理，同设备沿原FIFO处理。多步受理不承诺每步物理效果或跨步骤原子性；下一步不等待上一步成功。模型或设备离线时沿既有拒绝/unknown政策，不调用LLM决定重试或补偿。

运行、命令和事件身份保存在原SQLite账本。原命令查询、网关重启和重复事件不重发未知操作。部署回执丢失时，读取当前部署只能证明当前状态，原提交结果仍未知；不得换实例ID掩盖不确定性。多作者并发编辑使用现有TUI的条件修订与明确核对流程。

停用沿rules.stop，携带当前修订，阻止后续触发；已经受理的命令不会因此撤回，灯也不会自动关闭。设备停止、媒体撤销、运动急停和会话取消仍各用其正式合同。

## 家庭网页

进入“自动化 → 使用组合包”，选择触摸伴读灯或粘贴符合本合同的自定义JSON。逐个选择模块，列表只显示ready且物模型修订精确匹配的设备，不自动选择。CLI与网页共用编译、实际模型核对及完整预演校验，预演不创建设备命令或部署。

预演通过后逐项展示动作及可展开的完整组合和权限内容。证明在60秒后失效；包、绑定、设备模型或ready状态变化、后台、离页、离线与会话变化均清除证明。明确点击“启用组合”后先再次核对模型，再耐久保存完整原请求，最后单次提交原规则部署，携带`If-None-Match: *`拒绝覆盖现存实例。没有新规则执行器或包安装对象，已启用列表展示全部步骤，停用沿原修订条件请求。

原请求存于当前origin的`limeiot.composition:/api/v1/spaces/SPACE_ID`，包含版本、origin、空间、完整包、角色绑定、实例ID、规则修订、提交状态及正文规范JSON摘要。恢复按64KiB、12层和4096节点检查，拒绝重复键、未知字段、跨origin/空间及重新编译不一致；摘要用于检测损坏，不证明记录来源。保存必须核对旧值、写入并回读，失败零部署。同源Web Locks隔离提交和切换组合；不支持该能力的浏览器不能启用。

只有合法原POST回执可以标记acknowledged，明确4xx拒绝可标记rejected，其余保持attempted。刷新、重新登录和“查询当前部署”只GET；当前部署与原内容相同只能说明当前已启用，不能补认原提交成功。attempted不提供重发或换实例入口。acknowledged/rejected可明确“准备其他组合”，不停止原部署。已知记录被另一标签删除、损坏或并发改写时暂停新写；用户清除所有站点数据后无法再识别过去的本地请求，应先人工核对部署。

当前网页功能属于源码交付。既有NAS镜像、原生App和正式云须分别验收，不能因网页通过而提升其范围。

## 原生离线合同

Swift与Kotlin已实现组合包解析、角色绑定编译和原请求记录校验。两端消费同一份[合同向量](../tests/fixtures/compositions/contract.json)，对齐JavaScript的规范JSON及内容摘要，覆盖Unicode排序、小数、负零、极小值、三种提交状态及损坏/跨上下文拒绝。小数解析仅由组合包显式启用，原整数JSON入口默认规则保持。

本阶段仅交付离线合同；原生在线规划、部署与持久恢复客户端、状态层及SwiftUI/Compose组合包入口尚未实现，不构成原生软件闭环。验证范围与日志见[阶段证据](../docs/evidence/2026-11-04-composition-native-contract.json)。

## 发现和验证

```sh
node packages/cli/src/main.mjs composition schema
npm run test:composition
npm run test:composition:web
```

本地composition命令是源码CLI能力，不新增HTTP操作，因此不伪装成tools/catalog.json中的网关端点。schema离线返回正式输入Schema、所引用规则Schema、绑定Schema、边界和原部署入口；compile不读取凭据，plan不写本机状态。

检查涵盖共享Schema与解析边界、角色变更、重复绑定、模型修订变化、伪造预演和超大响应，以及真实Rust/MQTT/SQLite/CLI的部署、两步确认、丢回执、原键查询、双端重启、重复事件与明确停用。物理玩具、模型推理、对话陪伴、机器人运动、NAS新制品及官网发布不由此入口验收。
