# 物模型定义兼容性合同

当前检查器 `limeiot.model-compatibility/1.1.0` 比较同一模型标识的两个定义，判断候选定义能否继续支持旧控制器与旧读取者。规则只在 `limeiot-core` 实现；独立进程、Go 和 CLI 共用它。结构见[报告 Schema](model-compatibility-report.schema.json)，69份共享用例见[测试向量](model-compatibility-vectors.json)。单模型规则沿用[定义校验合同](model-validation.md)。

比较没有副作用，不保存产品、报告或发布记录，不签名、安装或切换设备绑定。通过不证明硬件实现了新能力，也不批准对现有设备下发新值。

## 输入与报告

输入对象必须恰好含 `baseline` 和 `candidate`。原文及 JCS 封装最多 16416 字节，根深度 0，深度最多 17，最多 4097 个值节点；拒绝重复键、非法 Unicode、不安全数字和未知封装字段。进程最多读取 16417 字节判断超限。

两个模型分别提取为 JCS，再执行完整定义校验，各自仍受 8192 字节、深度 16、2048 节点限制。控制面另外要求每个模型的原始子正文也不超过 8192 字节，与草稿输入边界一致。

| 字段 | 含义 |
| --- | --- |
| `version` / `checker` | 当前为 1 / `limeiot.model-compatibility/1.1.0` |
| `comparison_digest` | 整个输入封装的 JCS SHA-256，保留两份输入的方向 |
| `baseline` / `candidate` | 各自的完整定义校验报告，含源摘要、候选规范修订和问题 |
| `valid` | 两个定义是否都有效；不表示兼容 |
| `compatible` | 定义均有效时为布尔值，否则为 null |
| `issues` | 最多 32 个 JSON Pointer 和稳定 code，不返回解析器诊断 |

封装安全或结构失败：摘要及两个子报告均为 null，valid=false、compatible=null，问题为 `invalid_comparison_document`。安全封装内的模型错误保留封装摘要与两个子报告；顶层问题为 `invalid_baseline_model` 或 `invalid_candidate_model`，具体错误位于对应子报告。只有 valid=true 才进入兼容性检查；compatible=true 时顶层 issues 必须为空。

## 兼容性规则

按机器 id 匹配服务、属性、动作和事件，数组及权限顺序不决定兼容性。模型修订仍摘要完整规范投影，顺序变化可能产生不同修订。

| 定义变化 | 结果 / code |
| --- | --- |
| model_id 不同 | 拒绝作为同一模型升级，`model_id_changed` |
| 候选版本未严格递增 | 三段 uint32 数值比较，`model_version_not_increased` |
| 删除已有服务、属性、事件 | `service_removed` / `property_removed` / `event_removed` |
| 修改已有 semantic_id、unit、max_age_ms | `semantic_id_changed` / `unit_changed` / `freshness_changed` |
| 移除已有访问权限 | `access_removed` |
| 新增服务、属性、事件或权限 | 定义层允许，仍不证明设备能力 |
| 写入 Schema 不再接受所有旧输入 | `write_schema_incompatible` |
| 读取或通知 Schema 的新输出不能被旧 Schema 接受 | `output_schema_incompatible` |
| 事件的新输出不能被旧 Schema 接受 | `event_schema_incompatible` |
| 删除已有动作 | `action_removed` |
| 动作输入不再接受全部旧输入 / 新输出不能被旧读取者接受 | `action_input_incompatible` / `action_output_incompatible` |
| 改变动作幂等性、风险或完成范围 | `action_idempotency_changed` / `action_risk_changed` / `action_completion_changed` |

写入要求 `旧值域 ⊆ 新值域`，读取、notify 和事件要求 `新值域 ⊆ 旧值域`。读写属性同时检查两种方向。例如旧亮度为 0–100：只写属性放宽到 0–150 可通过；只读属性放宽到 0–150 不通过；读写属性放宽或收紧均不通过。

动作按同一方向检查：`旧 input ⊆ 新 input`，`新 output ⊆ 旧 output`；既有 semantic_id、idempotent、risk、completion 必须保持一致。新增动作可在定义层兼容，仍须单独验证设备实现、授权和客户端能力；模型升级不会自动开放新控制。报告外壳仍为 version=1；历史1.0 checker 报告必须关联1.0 validator 子报告，旧声明不能用于新增动作。当前 Go 进程适配器要求1.1 checker。

类型名变化，包括嵌套的 integer→number，均拒绝。同类型按实际范围、字符串长度、枚举、对象字段及 required 证明包含关系。省略和显式默认约束等效；数值枚举以 JCS 语义比较，1 与 1.0 等效。

对象为封闭对象。写入新增可选字段可接受旧输入，新增必填字段不行；输出新增字段可能被旧读取者拒绝，即使字段可选也不通过。输出收紧范围、增加已有字段的 required 或移除可选子字段，可在剩余约束满足包含关系时通过。删除顶层已声明属性/事件仍始终拒绝。

源 Schema 含 enum 时逐值检查；目标含 enum 而源没有时，只对最多 32 个值的有限域枚举证明：boolean、有界 integer、单值 number、空字符串及其有限对象组合。其他情况无法证明就返回兼容性未通过，不按版本号或相同摘要猜测兼容。枚举优化不能隐藏嵌套类型变化。

缺失项的位置指向 baseline，变化项指向 candidate；两者都使用各自输入的数组索引。兼容性只检查可表达的合同，不能识别“标识不变但驱动业务含义改变”，该类变更仍须人工和设备验证。

## 入口与错误

独立组件：固定 `--compare` 模式，从 stdin 读取封装，stdout 输出一个报告。其他参数退出 5；原有无参数模式继续校验单个模型。兼容退出 0，定义错误或兼容性未通过退出 2，组件/IO 故障退出 5。

离线 CLI 无需会话或网络：

```sh
cargo build --locked -p limeiot-model-validator
LIMEIOT_MODEL_VALIDATOR="$PWD/target/debug/limeiot-model-validator" \
  node packages/cli/src/main.mjs model compare --input "comparison.json"
```

comparison.json 的 baseline 为旧完整模型，candidate 为待升级的完整模型。CLI 校验封装摘要、两个子报告的源摘要和规范模型摘要、状态关系及退出码；执行最多 3.5 秒，stdout 最多 64 KiB，不写原操作日志。

控制面：`POST /api/console/v1/models/compare`，输入为相同封装。Console、Host、Origin、CSRF 和边缘凭据隔离与单模型校验一致，Admin 无权调用。与 models.validate 共用每地址每分钟 30 次、全进程 4 并发、单次 3 秒、64 KiB stdout；无 shell，无请求提供的命令、参数或路径。源 JSON 安全错误为 400，定义错误和兼容性结果均为 200，必须读取 valid 和 compatible；缺组件、超时、并发满或非法报告为 503 `validator_unavailable`。

```sh
npm run cli -- control schema models.compare
npm run cli -- control models compare --input "comparison.json" \
  --session-file "/absolute/private/session.json"
```

HTTP CLI 同样退出 0/2/5，无空间参数或原键。既有产品编辑器仍只提供当前输入校验，没有发布基线或已发布状态投影。正式发布时必须从可信持久记录取得基线，再执行相同检查，不能信任调用者自行提供的历史模型。

## 验证

`cargo test --locked -p limeiot-core -p limeiot-model-validator` 执行共享向量、输入边界、有限域与类型变化、实际区间值域的方向性检查及固定进程协议。Go 的共享进程检查需显式设置 `LIMEIOT_MODEL_VALIDATOR`。

`node --test tests/model-compatibility-boundaries.test.mjs` 检查离线 CLI、报告错绑与伪造。核心 `npm run test:models` 另外构建通用 Console/Admin，创建自有无宿主卷 MySQL，运行 Go race/vet、API/CLI、浏览器权限及原草稿恢复回归；不要求相邻私有仓库。该检查不证明签名发布、设备安装、NAS 容器、硬件或官方云已交付。
