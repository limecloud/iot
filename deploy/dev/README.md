# 本地模拟开发

本入口启动真实 Mosquitto 2.0.22、Rust 网关及灯光/按钮两个 MQTT 5 模拟客户端。模拟设备的状态与回执独立保存，网关只通过网络取得它们。无需模型服务、互联网账号或真实开发板。

## 依赖与启动

使用 Rust stable、Node.js 24.21+ 的 24.x、Python 3.12+。项目内构建 Broker 另需 CMake、C 编译器和 OpenSSL 开发库：

```sh
npm ci
python3 "tools/bootstrap-broker.py"
npm run dev
```

已有 Mosquitto 时，可通过 `LIMEIOT_MOSQUITTO` 指定其二进制完整路径，跳过构建。下载源、版本和 SHA-256 固定在脚本中；第三方源码与产物留在忽略目录 `.dev/tools`。

HTTP 监听 `127.0.0.1:17880`，Broker 监听 `127.0.0.1:18884`。状态、虚拟设备回执、随机实验凭据和日志位于 `.dev/local`，再次启动沿用原操作和规则；配置与数据库不匹配时拒绝覆盖。Ctrl+C 只关闭本次启动的子进程。

## 家庭界面与原生客户端

打开 `http://127.0.0.1:17880`，使用 `.dev/local/session.env` 中的 `LIMEIOT_TOKEN` 登录。界面直接消费同一网关API，支持设备属性控制、规则预演/启停、执行记录和原操作恢复。凭据换取HttpOnly会话，写操作校验Origin和CSRF；退出撤销会话，重启需重新登录。PWA只缓存静态资源，API不进入离线缓存。

NAS安装使用[HTTPS入口与备份恢复](../nas/README.md)。iOS原生工程见[Swift/SwiftUI](../../apps/ios/README.md)，Android见[Kotlin/Compose](../../apps/android/README.md)；原生应用连接受信HTTPS地址。CLI和原生库自动化检查可以使用独立回环实验入口，不放宽应用发布版的TLS验证。

## Agent 与 CLI

在另一个终端进入仓库：

```sh
source ".dev/local/session.env"
npm run cli -- schema
npm run cli -- capabilities list --space-id space-demo
npm run cli -- devices list --space-id space-demo
npm run cli -- rules validate --space-id space-demo --input "contracts/examples/button-light.json"
npm run cli -- rules deploy --space-id space-demo --input "contracts/examples/button-light.json"
```

回到开发终端输入 `button` 并回车。另一个终端查询结果：

```sh
npm run cli -- runs list --space-id space-demo
npm run cli -- events list --space-id space-demo --after 0
npm run cli -- events stream --space-id space-demo --after 0
```

`commands get COMMAND_ID --space-id space-demo` 查询同一个操作；命令创建接受 `--input FILE`，格式由 `schema commands.create` 提供。创建输入必须使用当前模型修订、唯一幂等键和未来 30 秒内的期限。HTTP 接收 202 表示已受理，不能当作设备完成。CLI 遇到 `unknown` 返回退出码 6，明确失败返回 7；保留原 ID 查询。

`commands list`查询最近100条操作；通过`--cursor`继续读取。受理响应丢失后使用`commands resolve IDEMPOTENCY_KEY --space-id space-demo`恢复原命令。`rules stop RULE_ID --input FILE`使用`{"revision":"sha256:..."}`校验当前修订后停用规则，保留原运行记录。

规则仅实现事件触发、类型化属性设置、冷却和固定部署修订。条件、计划、延时、Shell 和未登记动作均拒绝。`rules simulate --input FILE --space-id space-demo` 接受 `{rule,event}`，返回拟执行动作，不改变设备或部署；输入定义见工具合同。

## 代码与验证

### 可选网关配对

先按 [控制面](../../server/README.md) 运行独立实例，再离线生成本地机器密钥；输出只含公钥与gateway_id，不含私钥：

```sh
target/debug/limeiot-gateway identity-init "$PWD/.dev/local/gateway-identity.pk8"
LIMEIOT_CONTROL_ALLOWED_ORIGINS="http://127.0.0.1:17890" \
LIMEIOT_GATEWAY_KEY_FILE="$PWD/.dev/local/gateway-identity.pk8" npm run dev
```

`.dev/local` 须已由首次开发启动创建。已有密钥不要重新生成；文件0600且不能为符号链接。非回环控制面使用HTTPS，私有CA通过 `LIMEIOT_CONTROL_CA_FILE` 指定。未配置时仍可正常使用本地设备与规则。

控制面API先创建空间及120秒配对请求，在家庭界面“网关配对”粘贴返回JSON，核对目标账号、origin与范围后批准。CLI发现入口为 `schema control-pairings.create`，完整生命周期见 [合同](../../contracts/control-pairing.md)。配对码不交给模型，CLI输入文件与机器密钥按凭据管理。响应丢失后按原键resolve、再reconcile核实原绑定，不重新claim；配对建立不表示远程可用。

`npm run test:pairing` 运行临时MySQL/真实Go与Rust、CLI、Chromium及NAS配对恢复；`npm run test:control` 可独立验证控制面。本地开发不需要私有官网仓库。

已配对后可在网关启动命令增加 `LIMEIOT_CONTROL_RELAY_ENABLED=1`，启用当前机器连接层。连接会重新核对原绑定、发送心跳，断线退避重连，不重发claim或设备命令。`control-pairings list --space-id space-demo` 输出独立connection状态；当前没有远程执行工具。`npm run test:relay` 使用隔离CA/HTTPS/WSS验证真实连接、撤销、重连和断开后本地控制，协议见 [连接合同](../../contracts/control-relay.md)。

### 本地模型草案

先独立启动 Ollama 并安装所选模型，再以命令级配置启动网关：

```sh
LIMEIOT_OLLAMA_MODEL="your-local-model" \
LIMEIOT_OLLAMA_URL="http://127.0.0.1:11434" npm run dev
```

将 `your-local-model` 替换为已安装的本地模型，质量验证状态见[实施计划](../../docs/24-实施计划与进度.md)。在家庭界面的自动化页输入联动需求，生成后检查全部动作，依次选择“预演草案”和“启用草案”。Swift/Kotlin 原生端使用相同流程。生成或预演均不操作设备。未配置模型时仍可手动创建规则。

Agent 使用 `schema drafts.create` 读取正式输入，`drafts create --space-id space-demo --input FILE` 创建，`drafts resolve ORIGINAL_KEY --space-id space-demo` 查询原记录。输入文件包含 `space_id`、`idempotency_key`、`prompt`、`expires_at`；期限在未来 120 秒内。HTTP 映射见[接口规范](../../docs/16-API事件与CLI规范.md)。响应丢失后先查询原键，不自动更换键重调模型。

`npm run test:inference` 以假提供方验证故障合同；显式配置已安装的模型后运行 `npm run test:inference:live`，才会调用真实 Ollama，验证中文需求、缺失能力拒绝、无自动执行、预演、明确部署、MQTT 回执及重启记录。证据写入忽略目录 `.dev/ollama/verification.json`；失败保留实际状态，不自动换模型或重试。

| 路径 | 职责 |
| --- | --- |
| `contracts/` | 当前模型、规则、业务输入及可执行工具目录 |
| `gateway/crates/core` | 自有模型、会话、命令和规则语义 |
| `gateway/crates/runtime` | SQLite、MQTT、HTTP/SSE 适配与装配 |
| `tools/simulator` | 独立虚拟设备与回执 |
| `packages/cli` | 消费同一工具目录，输出 JSON/NDJSON |
| `apps/home` | 由网关同源提供的React家庭PWA |
| `apps/ios`、`apps/android` | Swift/SwiftUI及Kotlin/Compose原生客户端 |
| `tests/e2e.test.mjs` | 真实进程、Broker、CLI 与重启故障验证 |

```sh
npm run check
npm test
npm run test:e2e
npx playwright install chromium
npm run test:browser
npm run test:ios
npm run test:android
```

端到端测试使用动态回环端口、独立状态目录和随机凭据，完成后关闭自己的进程。日志保存在 `.dev/run-*`，不读取现有服务数据库。关键状态与事件在一个 SQLite 事务中提交；内存总线只通知读取耐久事件。发送意图先提交，发送后的失联或重启保留 `unknown`，不自动补发。

## 当前运行边界

开发脚本只监听回环地址；CLI使用所有者Bearer，浏览器与原生端使用独立会话。网关校验精确Host/Origin；非回环监听必须配置HTTPS来源并放在受控TLS入口之后。NAS清单不发布内部HTTP或明文MQTT。Broker禁止匿名并限制各设备Topic；这些能力不等于设备mTLS/认领、多用户授权或公网远程交付。

最多 64 台设备、4096 个命令、64 条规则、1024 个运行和 4096 个事件去重身份；达到上限拒绝新写入。事件读取每批最多 100 条，保留最近约 5000 条，过旧游标明确返回 `event_gap`。当前持久化采用小规模聚合快照；规模化和正式迁移需另行实现。

没有实机、NAS 镜像、多用户授权、ESP-IDF SDK、证书生命周期、签名 OTA、Go 控制面或生态桥接验收。官网与文档中心在 `iotweb`，不属于本地模拟进程。
