# 自动化规则

[rule.schema.json](rule.schema.json) 是机器格式，CLI/HTTP 发现使用同一份 [catalog.json](tools/catalog.json)。Rust 的 [AST](../gateway/crates/core/src/protocol.rs) 与 [引擎](../gateway/crates/core/src/engine.rs) 负责能力、授权及执行校验；设计扩展见 [自动化 DSL](../docs/10-自动化DSL与执行引擎.md)。

## 格式与能力

`version=1`，接受设备事件、属性阈值边沿或每周定时触发、有界 `conditions`、1–16 个操作与 0–86400000 毫秒的整数冷却。触发精确选择 `event`、`property` 或 `schedule`，定时分支不包含device；每个操作精确选择 `set` 或 `invoke`，不得同时填写、缺省或用 null 占位。未知字段被拒绝；参数中的 null 仅在目标物模型明确允许时有效。

```json
{
  "version": 1,
  "id": "button-tv",
  "trigger": { "device": "device-button", "event": "button.pressed" },
  "conditions": [],
  "actions": [
    { "device": "device-lamp", "invoke": { "path": "remote.press", "input": { "key": "home" } } }
  ],
  "cooldown_ms": 10000
}
```

示例要求 `device-lamp` 已实际绑定 [电视模型](models/android-tv.json)，不能直接用于默认灯模型。完整文件见 [button-tv.json](examples/button-tv.json)，旧属性规则见 [button-light.json](examples/button-light.json)。

| DSL 操作 | 命令映射 | 校验 |
| --- | --- | --- |
| `set: {path, value}` | `property.set`，参数为 `operation.value` | 目标属性存在、可写且值匹配 Schema |
| `invoke: {path, input}` | `action.invoke`，`input` 映射到 `operation.value` | 目标动作存在且输入匹配其 input Schema |

校验和部署检查设备触发来源、每个条件和目标设备及当前模型授权；定时来源由网关时钟提供。设备重新绑定模型时，所有关联规则都必须与候选模型兼容，否则返回 `bound_rules_incompatible`，保留原绑定和规则。`risk` 等模型元数据不代表已经实现通用风险审批器；设备执行端仍须核对其独立授权、应用白名单及动作限制。

## 属性阈值边沿

[environment-light.json](examples/environment-light.json)适用于显式启用第三节点的新NAS配置：

```json
{"device":"device-environment","property":{"path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}}
```

`property`必须包含path、unit、edge、threshold和hysteresis，edge精确为rising或falling。来源必须为具有read/notify及声明单位的数值属性；threshold按属性Schema校验，unit必须与当前模型一致，不进行隐式单位转换。hysteresis为有限非负数，整数属性要求整数；重新武装边界须位于属性范围内。上例是28℃阈值、1℃滞回。

首次有效读数只建立基线。rising在读数小于等于threshold-hysteresis时武装，随后新样本严格大于threshold时触发；falling方向相反，在大于等于threshold+hysteresis时武装，严格小于threshold时触发。等于阈值不触发。每个边沿只消耗一次，冷却期间的边沿同样消耗，冷却结束不补发。

只有当前在线会话的confirmed样本参与判断。采样时刻必须不晚于处理时刻且未超过物模型max_age_ms；相邻采样时刻严格增加、间隔不超过max_age_ms且source一致。重复/倒序采样不改变基线；unknown、estimated、过期、未来观测、采样间断、会话变化或离线后重新建立基线，不跨越缺口推断边沿。部署新修订和重启同样清空基线。基线只在本次运行内存中保存；已提交的运行、命令、冷却与证据仍耐久保存，未知命令不补发。

属性预演保留顶层`event`容器，内部填写device_id、path、historical以及previous/current两份观测。每份观测包含value、observed_at、quality、source；两份均须新鲜、同源、时刻递增，并从重新武装侧越过阈值。预演只检查给定样本，不读取或修改运行中的边沿基线。实际运行的`property_trigger`保存来源、路径及前后采样，命令继续使用统一账本、路由、期限与执行证据。

CLI/API支持验证、预演、明确部署及停用。Web、SwiftUI与Compose表单可创建和编辑单操作阈值规则，选择上升/下降、输入阈值与滞回；温度和湿度按常用单位输入，再精确换算到协议整数，超精度输入不截断。预演使用标记为simulation.ui的两份示例采样，不能据此判断实际传感器已经越界。修改规则后须重新预演，保留原规则ID及完整单步操作；多操作、未知版本和无法无损回填的条件不通过简化表单覆盖。三端冷却以秒输入并精确换算到整数毫秒，最多三位小数。

本地TUI支持1–16步阈值规则的创建、编辑、排序、预演及启停，保留毫秒冷却。与网页复用[十进制表单模块](../packages/protocol/threshold-form.mjs)，采样来源为simulation.tui；取消不改变部署，预演不生成设备命令。来源发现与任务恢复见[终端任务](terminal-tasks.md)。

## 每周定时

[bedtime-light.json](examples/bedtime-light.json)表示每天上海时间22:00关灯：

```json
{"schedule":{"time":"22:00","time_zone":"Asia/Shanghai","weekdays":[1,2,3,4,5,6,7]}}
```

time严格为5个ASCII字符HH:MM，time_zone为显式IANA时区，weekdays为非空且不重复的ISO星期，周一=1、周日=7。未知时区、额外字段、混合设备触发或null拒绝；不提供cron、秒级、一次性日期、天文时间或时间窗口条件。时区计算经独立[定时模块](../gateway/crates/core/src/rule_schedule.rs)隔离，固定chrono-tz版本。夏令时跳过的本地时间当天不执行，重复时刻只选第一次；半小时切换与整日跳过沿同一规则处理。

`rules.validate`额外返回schedule_preview，包含scheduled_at、local_date、local_time和time_zone，表示严格晚于当前网关时刻的下一次发生。预演使用`{"rule":完整规则,"event":{"scheduled_at":"校验返回的UTC时刻"}}`，不填写device_id或伪造设备事件；时刻必须精确落在该定时规则上。客户端不另实现夏令时算法，条件仍读取当前真实快照。

部署以当前UTC时刻建立schedule_cursor。运行中的网关按秒推进耐久高水位，回拨不倒退；正常轮询跨过计划时刻且间隔、迟到均不超过5秒才执行。更大的跳时和漏轮询直接跳过，重启或Broker重连后的第一次轮询仅建立新基线，不补做停机期间的计划。相同ID和内容重复部署保留原游标与冷却；新修订重新建基线，不补部署之前的时刻。这不是离线补偿调度器，也不承诺毫秒精度。

定时不刷新任何设备last_seen或观测。实际触发保存run.schedule_trigger的原UTC发生时刻、本地日期/时间及时区，event_id由规则修订和原证据摘要生成；游标、条件判断、预算、运行与命令沿既有Store事务一同提交，失败不公布半次结果。条件未满足、设备离线、预算不足或命令失败均不重试该次计划。冷却、FIFO、授权、OTA互斥和unknown只查询政策继续复用。

定时受理与已有命令/OTA的发送意图分属两次耐久提交，任一发送意图提交失败均不发布消息。运行记录仍有1024条容量上限，满容量或其他调度错误记录rules.schedule_failed日志，不阻塞已有命令出队；不自动清理历史记录。调度失败未提交的游标保持原值，错过5秒窗口后按漏发政策跳过。

Web、SwiftUI与Compose源码支持单操作定时的创建、完整回填、修改、取消及停用；TUI和CLI/API支持1–16步。定时只要求有执行目标，不依赖触发设备；时间、时区、星期或其他字段变化后必须重新预演。网页显示本次校验计算的下一次时间，原生表单只输入与展示固定时区，SDK向网关获取预演时刻。AI生成范围保持无条件事件与set，不生成定时。

## 条件判断

`conditions`顶层为AND，空数组保持无条件规则的原行为。比较格式为`{device,property,operator,value,unit?}`，如[按钮条件灯光](examples/button-conditional-light.json)。数值支持eq/ne/lt/lte/gt/gte，布尔和文本只支持eq/ne；严格按当前模型Schema检查值域，不进行字符串、布尔或单位转换。来源必须可read；模型声明unit时必须显式提供完全相同的unit，没有单位时必须省略。文本按完整值区分大小写。

使用`{"all":[…]}`或`{"any":[…]}`组合。每个数组最多16项，组不能为空；顶层条件起算最多4层，整条规则最多32个比较或组节点。正式Schema限制层数及每组大小，Rust另检查总节点数。未知字段、null单位、对象/数组比较、缺值和不支持的操作符被拒绝。所有条件来源在校验/部署时检查模型授权；设备换绑必须保留其比较能力、单位和值域，否则bound_rules_incompatible，原绑定和规则保持不变。

实际求值只读网关的当前在线设备会话和confirmed观测。观测不得来自未来、不得超过属性max_age_ms；设备无当前会话、30秒内无有效消息、属性缺失、模型授权不可用或质量非confirmed均为不满足，ne也不能把未知变成满足。any中另一个有效分支满足时仍可通过；所有分支均求值以保留原因。新消息只更新其自身来源的在线事实，不刷新其他设备观测。重启先清除在线状态，必须重新建立当前会话与观测。

预演的触发使用调用者提供的事件/边沿样本，条件使用网关当前快照；调用者不能以条件示例值替代真实快照。非空条件响应含trigger_matched及condition_evaluation，前者只表示触发样例有效，后者记录evaluated_at、完整条件、每节点matched、模型修订、原观测及不可用原因。最终matched同时要求触发与条件满足；proposed_actions在最终未匹配时为空。预演仍为executed=false，不部署或产生命令。运行中的条件同样保存到run.condition_evaluation，后续采样、改规则或重启不覆盖原证据；空条件规则不增加这些字段，旧规则摘要与序列化保持兼容。

触发到达但条件未满足时，保存error=rule_conditions_not_met、空command_ids及条件证据，消耗原事件身份/阈值边沿，但不更新last_run、不消耗命令预算、不在条件后来满足时补发。后续独立触发可再次判断；已进入冷却的事件仍沿用原冷却门禁。条件满足后继续检查预算和逐步命令受理。条件证据、事件去重、冷却及命令统一事务保存；失败不公布半次结果。

CLI/API与TUI支持完整条件规则；家庭网页、SwiftUI与Compose源码提供单操作规则的完整条件树编辑、回填、取消与启停。条件来源为全部可read的数值、布尔和文本属性，不要求notify或单位；模型单位仍须精确保留。网页和TUI共用[条件表单](../packages/protocol/condition-form.mjs)，原生界面分别使用[Swift条件编辑器](../apps/ios/Sources/LimeIoTKit/ConditionEditor.swift)和[Kotlin条件编辑器](../apps/android/core/src/main/kotlin/run/limeai/iot/core/ConditionEditor.kt)。值域、精度与限额无效时不能预演，不截断原树；未知版本、缺失来源或不能无损回填的规则拒绝编辑。原生宿主库、应用构建与端上运行分别验收，当前证据见[进度](../docs/24-实施计划与进度.md)。

家庭网页与Agent终端共用[预演核对](../packages/protocol/rule-simulation.mjs)：验证完整规则摘要、valid、executed=false、simulation=true、trigger_matched=true、原条件树、逐节点判断及完整proposed_actions。当前条件未满足时，必须核对matched=false与空预计操作，才可明确启用等待未来触发；无效触发、缺失或不一致证据不能进入部署核对。空条件继续要求matched=true。准备与修改不发送设备命令，TUI沿用原任务与条件修订恢复机制。网页和TUI执行记录显示原条件及观测，AI草案继续只生成空条件。时间窗口条件及延时仍是后续工作，每周定时按上节执行。

Swift/Kotlin的GatewayClient对同一完整规则先校验再预演；原生RuleProof核对valid、校验修订与预演修订一致、simulation=true、executed=false、有效触发、原条件树、逐节点判断及完整预计操作。修订采用网关对本次规则的校验结果，不在原生端实现另一套通用JCS数字规范化。任何缺失或不一致证据都拒绝，未满足条件只能以空预计操作进入明确启用。界面保存完整已核对规则，修改或取消后禁用旧预演，规则运行记录显示冻结条件证据。云设备入口不因此新增NAS规则API。

## 属性依赖环路

校验、预演和部署共用[静态依赖检查](../gateway/crates/core/src/rule_graph.rs)。以设备和属性路径作为节点，属性阈值触发到每个set目标建立有向边；invoke尚无效果声明，因此保守连接目标设备全部已部署或候选阈值来源。任何自环或跨规则闭环返回`rule_cycle`，即使规则设置了冷却、滞回或不同方向。替换时先排除同ID旧规则，再检查新图；停用移除对应边。检查失败不改变部署、边沿基线、命令或审计事件。

恢复已有快照时也先检查依赖图，环路快照以`storage_corrupt`拒绝，正文、版本及审计不改写，不静默停用或删除规则。依赖图检查自身不增加持久字段；定时由下述v11快照承载，已有事件规则不改变摘要。

静态图只覆盖声明的属性写入和上述动作保守关系，定时本身不作为属性图来源。物理反馈、设备未声明的其他属性/事件副作用、外部生态回声没有完整因果证据。下述执行预算限制总量；时间窗口条件、去抖及跨设备因果链/深度仍待开发，不能把静态图与总量预算视为完整循环防护。

## 自动化执行预算

当前固定策略为每个空间滚动60秒最多受理64条自动化命令，事件、阈值与定时、set与invoke、全部部署共用。每次运行先检查完整actions长度；剩余名额不足时，运行保存`error="automation_budget_exceeded"`及空command_ids，本次不受理任何步骤。其他已匹配的小规则仍可使用剩余名额；预算不提供跨规则或设备原子性。

计数从[原命令账本](../gateway/crates/core/src/rule_budget.rs)的run_id和网关issued_at计算，包含时间区间`(now-60秒, now]`内的全部已受理命令，失败、过期、拒绝或unknown均不退款。时钟回拨导致的未来记录也保守计入；无法解析原时刻时停止该次运行并报告storage_corrupt。此策略依赖可信网关时钟，不能防止人为调快时钟或旧库回退。没有独立易失计数器或自动删除历史记录，停用、换名、改修订和重启均不清零；预算自身不引入新的快照字段。

预算拒绝仍耐久消耗本次事件身份/阈值边沿并更新规则冷却，不排队、不在窗口恢复后补发；只有后续独立事件或新边沿可再次运行。运行、事件去重、冷却与命令同一事务保存，提交失败不公布其中任何变更。单条规则预算足够后，其他受理错误仍按原部分执行语义处理，已经受理的命令继续占额。

校验、预演及部署不消耗执行预算，预演不承诺实际触发时还有名额。所有者手动控制继续接受独立的授权、期限、设备队列和容量检查。运行原因由runs.list读取，Web、SwiftUI及Compose执行记录显示“自动化操作过于频繁，本次未执行”；此为拒绝记录，不证明设备动作已经发生。因果追踪、单设备速率及专业执行器的物理保护不由本策略覆盖。

## 预演与明确部署

1. `rules.validate` 检查规则并返回规范摘要。
2. `rules.simulate` 检查规则和事件样本，返回 `simulation=true`、`executed=false`、`matched` 及完整 `proposed_actions`，不创建命令或部署。
3. 所有者通过 `rules.deploy` 明确启用。相同 ID 和内容返回相同修订；变更内容产生新修订，已生成的运行和命令保留。
4. `rules.stop` 必须携带当前修订，停止后续触发；不会取消已受理命令或补偿已有副作用。

部署可选条件头：创建使用 `If-None-Match: *`，更新使用带双引号的精确 `If-Match` 修订。两者互斥，格式错误返回invalid_request，当前基线不符返回revision_conflict；核对与部署在同一耐久更新内执行。未传条件头保持原行为。本地终端固定使用条件头，并在提交前展示完整差异；详见[终端任务合同](terminal-tasks.md)。

预演不证明设备在线、路由已获准或动作必能执行。每次触发仍由命令入口重新校验当前授权、会话、路由、期限、队列和 OTA 互斥。

## 执行、去重与恢复

每次匹配生成一个 `run_id`，按数组顺序提交操作，原键固定为 `run_id-index`，每条命令期限为触发处理时间后 5 秒。任一步受理失败停止提交后续步骤，`run.error` 保存错误；已受理步骤保留。此处不是等待上一步成功后再运行的工作流，后续步骤不以先前设备回执为条件。

同设备沿用有界 FIFO 和单条未到期 dispatched 限制；不同设备可以并行，不承诺跨设备原子性。已入队命令的执行失败不会自动回滚其他步骤。结果使用 [统一命令证据](commands.md)，`submitted` 只表示输入已提交，不表示电视界面或物理效果已观测。

事件身份按设备与 `event_id` 耐久去重，历史事件及超过实时窗口的事件不触发。冷却限制同一部署再次触发；重启不清除去重与冷却记录。已发送但缺回执的命令成为 unknown，原键查询、网关/设备重启和重复触发事件均不自动重发旧命令。新的独立事件仍可按规则产生新命令。

当前网关读取快照v1–11；未使用定时的基础路径写v10，首次出现定时游标或运行证据写v11，此后即使停用规则也不退回v10。旧事件/set/invoke规则的序列化和摘要保持不变。v9承载属性触发及采样证据，v1–8夹带这些字段拒绝；v10承载非空条件与condition_evaluation，v1–9夹带这些字段拒绝；v11承载定时、schedule_cursor与schedule_trigger，v1–10隐藏这些数据、缺游标或原定时证据矛盾均以storage_corrupt拒绝，原正文、版本和审计不改写。恢复校验后才写gateway.recovered，不改变SQLite表结构。旧二进制不得继续读取新库；回退须使用兼容版本与对应备份，不做静默转换。边沿基线不持久化，恢复后须重新采样；定时恢复按上节重新建基线。

## 消费者与验证

CLI/API与本地TUI支持1–16个混合操作的事件、阈值及定时规则。家庭网页、SwiftUI/Compose支持数值/布尔属性及动作的单操作创建、编辑、预演和部署。三端完整展示多操作规则并可停用，多操作编辑使用TUI或CLI/API，简化表单不截取首步覆盖原规则。三端均保留整数毫秒冷却。

动作通用参数目前使用 JSON 输入，由网关做精确模型校验。AI 草案继续只生成事件与属性设置；推理派生 Schema 只选择 set 分支，本次不扩展模型生成能力，不把格式正确视为意图理解正确。云控制入口不因此获得规则部署权限。

`npm run test:rules:actions` 覆盖 Rust 核心、合同发现、CLI/HTTP、真实 Broker/SQLite、虚拟设备和 Chromium；`npm run test:rules:actions:native` 覆盖 Swift/Kotlin 宿主库与同一软件链路。`npm run test:rules:thresholds`增加阈值核心、SQLite原子提交、同一C传感/灯光驱动到MQTT、CLI和多端读取/预演，需要Swift及JDK21/Android SDK。时间窗口条件、延时、长任务、通用插件、机器人运动及物理效果仍不在本合同范围。实际结果以 [进度](../docs/24-实施计划与进度.md) 为准，实机按用户要求跳过。

`npm run test:rules:budget`覆盖滚动窗口边界、整条拒绝、跨规则/阈值共享、手动控制、时钟回拨、原状态不退款、SQLite失败/重启及MQTT→HTTP/CLI/移动网页的软件旅程。

`npm run test:rules:conditions`覆盖类型/单位、组合上限、未知/过期/离线、冷却、无副作用预演、换模拒绝、AI边界、SQLite失败及v10恢复，并通过真实MQTT/HTTP/CLI查询原观测证据。

`npm run test:rules:schedules`覆盖IANA/星期、夏令时、回拨、跳时、离线恢复、SQLite原子性及v11、真实墙钟MQTT/CLI旅程、网页和PTY。`npm run test:rules:schedules:native`核对Swift/Kotlin宿主库的严格合同、网关校验/预演、创建/修改/停用及零设备命令；原生App构建和实际运行分开记录。
