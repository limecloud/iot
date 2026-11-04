# 本地文字生成

`text.generate`提供有限文字回答和调用方显式传入的多轮上下文。输入、任务和结果见[text.schema.json](text.schema.json)，工具目录包含`text-generations.create/resolve/discard`。Ollama只是一种外部推理适配器；本功能不生成设备命令、规则、播放授权或工具调用。

## 配置与调用

配置现有媒体存储后，设置`LIMEIOT_TEXT_URL`和`LIMEIOT_TEXT_MODEL`；私有CA可配置`LIMEIOT_TEXT_CA_FILE`。提供方逐次解析并固定全部本地地址，禁用代理、跳转及重试；公网地址拒绝。模型、提供方和CA摘要绑定部署修订。未配置时已有原任务仍可查询和清文。

| 操作 | 接口 | 结果 |
| --- | --- | --- |
| 创建 | `POST /api/v1/spaces/{space}/text-generations`，唯一`Idempotency-Key` | 首次202，原键原输入200 |
| 查询 | `GET /api/v1/spaces/{space}/text-generations/by-key/{key}` | 原任务；不存在404 |
| 清除/放弃 | `POST /api/v1/spaces/{space}/text-generations/by-key/{key}/discard`，空正文或`{}` | 原任务的新观测 |

沿用本地所有者会话、Origin/CSRF或独立CLI Bearer；当前空间必须匹配。本功能未向云中继暴露。

请求示例：

```json
{
  "instructions": "用简短中文回答，帮助用户学习。",
  "messages": [
    {"role": "user", "content": "我喜欢积木。"},
    {"role": "assistant", "content": "你喜欢搭什么？"},
    {"role": "user", "content": "我刚才说喜欢什么？"}
  ],
  "retain_seconds": 600,
  "expires_at": "2030-01-01T00:01:00.000Z"
}
```

示例期限须替换为当前时间之后90秒以内的时刻。消息按user/assistant交替，以user开始和结束，最多15条；单条最多2048字符，角色说明最多1024字符，说明与消息合计最多8192个UTF-8字节。空白消息、控制字符、system/tool角色、未知字段、重复JSON键和亚毫秒期限拒绝。字节和交替约束由网关语义校验，不能仅凭客户端Schema通过断言已受理。

## 执行、预算与恢复

先耐久保存完整输入摘要、上下文字节数/消息数、期限及部署身份，再调用一次提供方。输入正文不进入快照、日志或原请求记录。固定4096上下文token、最多1024输出token；结果最多2048字符/8192 UTF-8字节，实际可得用量记录在`usage`。一个服务最多一个在途调用、128条任务；running或unknown任务阻止新键调用。使用量缺失记null，不伪造计量。

完整返回且模型身份、assistant角色、结束原因、正文及用量均通过校验才为succeeded。工具调用、错误模型、截断、坏JSON或过量正文失败；网络失联、5xx、跳转、期限和重启中断保持unknown。未完成调用的预算不因重启自动释放，不补发。响应丢失或404只查询原键，不换键提交；相同键不同上下文或期限返回409。

成功正文按请求保留60–3600秒；到期或明确清除后只保留原摘要和清除时间，重启不恢复正文。放弃running/unknown使任务为discarded，迟到结果丢弃；这不证明提供方停止计算。在途调用仍占用实际执行槽，直到返回、中断或到期。本功能不自动清除任务证据或恢复用量。

媒体快照v5保存文字任务，读取v1–5；旧版本夹带非空文字任务、坏摘要或不一致结果在恢复写入前拒绝。音频、转写和视觉任务共存，后续写入不能降低版本。NAS备份保持原快照字节；备份可能包含尚在保留期的生成结果，应按私有数据管理。

## 上下文与会话边界

服务端不自动回填旧消息，也没有隐式跨用户记忆。客户端只在当前获准交互中明确提供上下文；切换参与者、暂停或删除会话时由应用清除内存并阻止旧结果进入新会话。长期记忆、监护/机构政策、完整会话管理、流式输出和语音流水线仍是独立交付项。本功能的文本回答不能当作专业咨询、教学效果、设备动作或模型质量验收。

CLI先保存只有摘要的原记录，读回失败不得提交；已有原记录只查旧键。输入文件本身含正文，由调用方管理：

```sh
npm run cli -- schema text-generations.create
npm run cli -- text-generations create --space-id space-demo --input ".dev/text-input.json" --idempotency-key text-01
npm run cli -- text-generations resolve text-01 --space-id space-demo
npm run cli -- text-generations discard text-01 --space-id space-demo
```

运行及测试状态以[实施进度](../docs/24-实施计划与进度.md)中的实际结果为准；软件提供方夹具不代表真实模型质量、完整会话或硬件运行通过。

## 真实模型验收

按[本地开发](../deploy/dev/README.md)准备MQTT测试工具和浏览器，并准备真实Ollama与明确模型标签后，在仓库根目录运行：

```sh
LIMEIOT_TEXT_URL="http://127.0.0.1:11434" \
LIMEIOT_TEXT_MODEL="your-installed-model:tag" npm run test:text:live
```

入口创建隔离的网关、SQLite和MQTT模拟设备，不连接已有家庭安装。运行前声明算术、多轮位置记忆和设备权限三个有限样本，分别经390px实际网页、CLI和API提交；真实模型响应原样交给网关，记录模型清单摘要、用量与耗时。随后检查成功任务跨重启、明确清文、计算完成但响应丢失时的unknown与零重调，以及提供方连接故障期间明确设备控制仍可确认。CLI原记录只含摘要，权限为0600。可用`LIMEIOT_BROWSER_EXECUTABLE`指定已安装Chrome，或使用Playwright已准备的Chromium。

没有模型、模型输出不满足样本或恢复检查失败，入口直接失败并保留`.dev/text-live-*/text-live-result.json`。不自动下载、替换提供方、修改输出或重试生成。少量样本不构成全面质量、家庭语音效果、NAS容器或完整原生App验收；规则草案使用独立的`test:inference:live`，各自结果不可互相替代。

NAS同机部署使用`compose.text-local.yaml`，与外部提供方的`compose.text.yaml`二选一。独立真实容器入口为`npm run test:nas:text:live -- --model "your-installed-model:tag" --models-dir "/absolute/preloaded-models"`，复用同一组预先声明的样本，另验完整容器备份/恢复及停止模型后的设备控制。部署和镜像前提见[NAS说明](../deploy/nas/README.md#可选本地文字对话)；宿主结果不替代该容器结果。

同一入口增加`--ollama-executable`时，改为正式外部模型覆盖，并启动、停止本次专用宿主进程。恢复期间外部进程保持运行，实际推理日志累计固定为4次；模型停止后不增加调用，设备控制仍需明确命令。该模式证明NAS网关与外部本地模型的链路，不证明Linux同机模型容器、资源上限或完整模型质量通过。

## 原生客户端

Swift `TextGenerationClient` 与 Kotlin `TextGenerationClient` 复用各自网关会话、CSRF 和安全存储接口。新请求先保存并回读原摘要；本地记录命名空间为 `origin#text-generations`。同键只查询，不修改输入；响应丢失、404、坏用量、摘要不符和状态回退均不触发自动重发。成功后用量与身份不得漂移，清除只能使正文不可再获取。

`records` 不含正文，`submit/resolve` 的当次结果可带正文。页面上下文只在内存，消息交替限制与 API 一致；后台、离线、离页、退出和最早回答期限经过时清除。恢复完成回答不会自动还原历史消息，也不进入新对话上下文。未取得观测的 unresolved 保留预算且不能通过本地删除解除，404 不证明服务端未受理。

共享输入与结果向量位于 `tests/fixtures/text/contract.json`。三端分别检查 Unicode、时区、摘要、用量及无效向量；原生状态与 Rust/SQLite/MQTT 组合验证使用独立模型协议夹具，不证明真实模型质量或完整原生 App 运行。
