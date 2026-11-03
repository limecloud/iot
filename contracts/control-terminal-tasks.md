# 独立控制面终端任务

控制面菜单和 Agent 逐行 JSON 使用同一执行器、Console 会话和原请求日志。正式请求为 [control-terminal-tasks.schema.json](control-terminal-tasks.schema.json)，业务动作仍来自 [control.json](tools/control.json)；不增加后端权限或新的 HTTP 接口。本地网关终端另见 [terminal-tasks.md](terminal-tasks.md)。

## 入口与身份

```sh
node packages/cli/src/main.mjs control tui schema
node packages/cli/src/main.mjs control tui --session-file "/absolute/private/session.json"
node packages/cli/src/main.mjs control tui --snapshot --session-file "/absolute/private/session.json"
node packages/cli/src/main.mjs control tui --stdio --session-file "/absolute/private/session.json"
```

`schema` 离线返回请求 Schema、25 项业务工具及其输入定义。`--snapshot` 验证当前会话并返回 origin、主体和本进程核对任务；不读取全部业务资源。菜单提供查看与校验、执行操作、当前会话，写操作核对后输入“确认”提交。需要正文的菜单动作从 JSON 文件读取输入。

先通过 `control auth login` 登录私有实例，或通过 `control auth import` 导入本人从 Console 创建的短期会话，步骤见 [CLI](../packages/cli/README.md#独立控制面)。会话由 `--session-file` 或 `LIMEIOT_CONTROL_SESSION_FILE` 指定；可选 `--endpoint` 必须等于会话的精确 origin。不读取本地网关 Bearer、浏览器 Cookie 或 LimeCloud Token。身份、CSRF 和本地网关批准仍由现有控制面合同检查。

## 操作与核对

| op | 输入 | 行为 |
| --- | --- | --- |
| catalog | 无 | 离线返回终端请求 Schema 与业务工具 |
| state | 无 | 验证当前身份，返回本进程任务摘要 |
| read | operation_id，按工具提供 space_id/id/after/input | 执行 GET 或声明无副作用的模型校验/比较 |
| prepare | operation_id，按工具提供 space_id/id/input/output_file | 校验输入和当前会话，只建立核对，不提交业务写请求 |
| commit | task_id、review_digest | 核对匹配且未过期时，消费本次核对并调用一次执行器 |
| cancel | task_id | 清除尚未提交的核对，不取消远程操作 |

工具需要空间或资源时必须提供相应字段；不需要的字段拒绝。分页只用于支持分页的读取。配对创建须指定绝对 `output_file`，其他动作不得指定该字段。

核对包含完整业务输入、origin、主体、空间/资源、输出路径和适用的恢复操作。`review_digest` 为整个核对对象的 JCS SHA-256 摘要。任务绑定准备时的会话摘要，提交时重新验证身份；切换同一主体的另一会话也不能沿用旧核对。核对有效 60 秒，每进程最多保存 32 份尚未清理的有效核对。业务期限独立生效，核对仍有效不表示远程命令期限仍有效。

提交先消耗核对，再进行执行；并发或重复提交不能再次执行。失败、撤权、网络中断也不恢复该核对的可提交状态。核对只保存在内存，终端关闭后旧 task_id 失效；原请求日志和远程操作不受影响。

## Agent 流程

Agent 直接调用 Node 或安装的 CLI 入口，避免 npm 日志混入协议。同一进程中每行发送一份 JSON，每行得到一份 NDJSON 响应：

```json
{"op":"read","operation_id":"spaces.list"}
{"op":"prepare","operation_id":"spaces.create","input":{"request_key":"family-original","name":"我的家庭"}}
```

准备成功返回 `value.review` 和 `value.review_digest`。按已获授权的任务核对后，提交返回的精确值：

```json
{"op":"commit","task_id":"ctask-00000000-0000-4000-8000-000000000000","review_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}
```

示例 ID 和摘要仅说明格式，不能直接执行。读取和提交成功响应为 `{ "exit_code": 0, "value": ... }`；失败包含 `error.code`，需要恢复时另有 `original` 文件引用。模型无效等业务否定也可能带 `value` 与非零 `exit_code`，须逐行检查，不能只检查进程退出码。正常输入流结束时进程可退出 0；致命输入或启动错误设置进程退出码。

每行最多 32768 字节、深度 32、节点 8192，拒绝重复 JSON 键、非法 UTF-8 和不安全整数。末行可以在 EOF 结束。超长行终止本次输入流；普通格式错误返回错误行后继续。菜单 JSON 文件最多 16416 字节、深度 24、节点 4096，拒绝符号链接；各业务工具还有独立上限。终端展示转义 ANSI 和方向控制字符，机器响应保持合法 JSON。

## 原请求与恢复

提交共用现有 CLI 的私有 `operations/` 日志，先保存并同步完整原请求，再发送；落盘失败零业务写请求。核对不是耐久操作记录。关闭终端后，使用相同 origin、主体、日志目录及原键恢复，不把已提交任务当作新请求：

- 命令、草稿和模型发布再次提交同键同参时，只 GET 原记录。404 或无法验证的回执保持未知，不补发、不延长期限、不换键。
- 空间和配对沿用其服务端幂等 POST 合同回读原资源，不表示重新创建或续期。配对恢复须指定新的私有输出文件。
- `commands.resolve` 读取原云记录；显式 `commands.reconcile` 核实原网关命令，属于需核对的操作，不创建第二条设备命令。
- `cancel` 仅取消未提交核对，不能撤回已发送的命令、撤销发布或删除日志。

配对码只写入当前用户的私有输出文件，不出现在终端响应中。会话、配对文件和原请求日志不得进入 Git 或模型上下文。`accepted/dispatched` 不表示设备完成，`confirmed` 继续核对原设备结果证据。

## 验证范围

`npm run test:control:cli` 包含终端边界、原 CLI 回归和独立 Go/MySQL/TLS/WSS/MQTT 软件旅程。覆盖准备零写、单次提交、丢回执、控制面重启及原键恢复；设备为软件模拟器。完整平台、实机和正式云部署分别验收，当前状态见 [实施进度](../docs/24-实施计划与进度.md)。
