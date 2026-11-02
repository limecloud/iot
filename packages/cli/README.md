# LimeIoT CLI

本地网关和独立控制面使用不同身份与工具目录。入口为仓库根的 `npm run cli --`；程序只输出 JSON/NDJSON，错误写入 stderr，不在终端输出会话材料。

## 离线物模型校验

先构建 `cargo build --locked -p limeiot-model-validator`，将组件加入 PATH，或在当前进程指定绝对路径：

```sh
LIMEIOT_MODEL_VALIDATOR="$PWD/target/debug/limeiot-model-validator" \
  npm run cli -- model validate --input "contracts/models/lamp.json"
```

输入为模型正文，无需会话或网络。有效退出0，无效退出2，组件/IO故障退出5。JSON报告包含输入摘要、候选模型修订和错误位置；校验不会发布或安装模型。完整边界见[校验合同](../../contracts/model-validation.md)。

比较两个定义时，准备含完整 `baseline`、`candidate` 模型的 comparison.json：

```sh
LIMEIOT_MODEL_VALIDATOR="$PWD/target/debug/limeiot-model-validator" \
  npm run cli -- model compare --input "comparison.json"
```

兼容退出0，模型错误或兼容性未通过退出2，故障退出5。先读 valid，再读 compatible；定义无效时 compatible 为 null。写入和上报按相反的值域包含方向检查，不改变产品或设备绑定，见[兼容性合同](../../contracts/model-compatibility.md)。

## 离线固件校验

```sh
cargo build --locked -p limeiot-model-validator --bin limeiot-ota
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota schema
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota verify \
  --input "verification.json" --image "firmware.bin"
```

verification.json完整包含manifest、独立确认的trust和device快照。Rust核对签名、硬件/版本/模型、安全代次、分区、电源/忙碌状态，再流式校验实际镜像；Node只转交进程参数。成功退出0，无效或不满足条件退出2，IO/组件故障退出5。当前无需会话，不联网、不修改文件或设备；成功不授予安装权限。输入结构、32 KiB边界、错误和测试向量见[OTA合同](../../contracts/ota.md)。

### 下载并校验制品

```sh
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota download \
  --input "verification.json" --output-dir ".dev/firmware-staging-001"
```

只访问签名与本地信任允许的HTTPS源；私有CA可增加 `--ca-file "/absolute/path/ca.crt"`。原请求和开始回执先落盘，完整校验通过才生成firmware.bin及verified回执。禁止重定向、自动重试、压缩和鉴权信息。成功0、策略/镜像不符2、已有目录4、网络/IO故障5；已存在目录保持不变且零GET，失败与中断不自动续传。恢复读取原目录receipt.json，不能根据文件存在自动安装；具体持久化和传输边界见OTA合同。

### 固件密钥与签名包

使用 `ota keygen --output-dir NEW_DIR` 生成独立PKCS8文件和公开指纹，随后用 `ota sign --input RECIPE --trust TRUST --key KEY --image IMAGE --output-dir NEW_DIR` 准备签名包。配方版本/安全代次须与实际C3镜像一致，身份和下载路径由实际字节、配方及密钥共同决定。两个操作均离线，只创建新私有目录，不修改信任或发布服务；签名成功不表示已安装。完整字段、回执和恢复见 [签名制品合同](../../contracts/ota-release.md)，检查入口 `npm run test:ota:sign`。

本地入库使用 `ota publish --bundle BUNDLE --trust TRUST --repository REPOSITORY --base-url HTTPS_BASE`。根目录须已存在，base-url须与签名配方完全相同。重新验证包/实际镜像/独立策略后，独占写入artifacts/制品ID并最后提交published.json；NAS只读HTTPS仅提供已提交镜像和清单。0为本地stored，2为输入/策略不符，4为已有ID，5为IO/组件故障；不联网、不发布远端、不安装，失败不覆盖或续写。检查入口 `npm run test:ota:publish`、`npm run test:ota:repository`。

## 本地网关

```sh
npm run cli -- schema
npm run cli -- devices list --space-id space-demo
```

本地使用 `LIMEIOT_ENDPOINT`、`LIMEIOT_TOKEN_FILE` 或开发会话变量。完整安装见 [本地开发](../../deploy/dev/README.md)。

### 固件信任与升级计划

```sh
npm run cli -- schema ota-changes.create
npm run cli -- invoke ota-changes.create --space-id space-demo \
  --input "firmware-change.json" --idempotency-key firmware-change-001 \
  --state-dir ".dev/owner-operations"
npm run cli -- ota-changes resolve firmware-change-001 --space-id space-demo
npm run cli -- ota-tasks list --space-id space-demo
```

正文支持独立固件 `trust.add/revoke` 和 `tasks.plan/approve/execute/reconcile/cancel`。先独立核对指纹，计划使用签名清单与当前设备报告，再读取任务修订明确批准；另行明确execute才创建安装意图。可能已发送后恢复为unknown并保留设备占用，reconcile只查询原安装日志。成功必须有匹配的新启动、目标版本及镜像健康证据，不能根据原决定applied推断已安装。

原请求在POST前落入独立私有目录；已有记录只GET原决定，404或丢响应退出6，不自动补发。业务拒绝退出7、修订或异参冲突退出4。恢复旧批准/执行决定不重新激活任务；当前状态通过 `ota-tasks.get` 读取。完整输入与状态见 [升级任务合同](../../contracts/ota-tasks.md)，检查入口为 `npm run test:ota:tasks`。网关执行合同、C3安装提供方及产品配置/健康门禁已接通；实机按用户要求跳过，本地制品仓库/NAS HTTPS已接入，正式托管另行发布。

### 安装签名模型和绑定设备

这些命令直接调用本地网关，使用本地所有者身份；与 `control releases` 的发布操作分开：

```sh
npm run cli -- schema model-changes.create
npm run cli -- model-trusts list --space-id space-demo
npm run cli -- model-installations list --space-id space-demo
npm run cli -- device-models get "device-lamp" --space-id space-demo
npm run cli -- invoke model-changes.create --space-id space-demo \
  --idempotency-key "owner-approved-change" --input "model-change.json" \
  --state-dir "/absolute/private/gateway-state"
npm run cli -- model-changes resolve "owner-approved-change" --space-id space-demo
```

`model-change.json`是 `trust.add`、`trust.revoke`、`models.install` 或 `devices.bind` 其中一个动作。先由所有者独立核对公钥指纹，再保存信任，明确安装后单独绑定设备。安装预期固定网关当前发布ID，首次显式为null；绑定预期固定当前模型修订和绑定修订，新设备显式为null。完整输入和边界见[本地安装合同](../../contracts/model-release.md#本地信任安装和设备绑定)。

默认原记录保存在 `~/.local/state/limeiot/gateway/model-operations`，可通过 `--state-dir`指定父目录。文件0600、目录0700；完整origin、空间、键和原输入先耐久保存，失败零发送。同键同参再次create只GET原键，404也不补发；同键异参退出4。applied退出0、conflict退出4、未知退出6、rejected退出7。历史成功只能证明当时决定，当前信任、安装头和设备绑定须分别读取，不能据历史结果恢复已撤销资源。

列表的 `next_cursor` 用 `--after "install-ID"`继续读取。`model-trusts get "trust-ID"`和`model-installations get "install-ID"`读取详情。CLI核对API资源摘要及完整原请求；密码学与兼容性由网关共享Rust执行。

### 电视适配绑定与应用发现

使用本地所有者身份，先读取宿主候选和已有逻辑设备的当前绑定；候选配置由网关宿主准备，不接受 CLI 传入 ADB 地址或任意 Shell：

```sh
npm run cli -- schema execution-changes.create
npm run cli -- execution-adapters list --space-id space-demo
npm run cli -- execution-bindings get "device-tv" --space-id space-demo
npm run cli -- invoke execution-changes.create --space-id space-demo \
  --idempotency-key "owner-approved-tv-binding" --input "tv-binding-change.json" \
  --state-dir "/absolute/private/gateway-state"
npm run cli -- execution-changes resolve "owner-approved-tv-binding" --space-id space-demo
npm run cli -- device-applications list "device-tv" --space-id space-demo
```

`tv-binding-change.json` 可为 `bindings.bind`、`bindings.compose` 或 `bindings.revoke`，完整结构见 [execution-bindings.schema.json](../../contracts/execution-bindings.schema.json)。bind固定查询所得route、expected_binding_revision和expected_model_revision，将完整动作集交给同一候选；revoke固定当前expected_binding_revision。配置、设备或模型变化时重新读取并明确决定，不复制示意摘要代替真实修订。

compose复用上面的invoke命令，输入增加native_paths与expected_native_session。以下仅示意，须替换全部占位值；原生端须使用与目标设备相同的逻辑模型，并已hello声明覆盖所选路径、完成当前会话快照：

```json
{
  "type": "bindings.compose",
  "device_id": "device-tv",
  "route": {"adapter_id": "tv-adb", "revision": "sha256:<64位候选摘要>"},
  "native_paths": ["apps.launch"],
  "expected_native_session": "<当前设备session_id>",
  "expected_binding_revision": "sha256:<64位绑定摘要>",
  "expected_model_revision": "sha256:<64位模型摘要>"
}
```

native_paths按字典序排列且唯一，须为仅动作模型的非空真子集；其余动作全部交给指定候选。当前一个原生端加一个外部候选，不支持属性/事件组合或离线切换。TV Agent材料v2可显式选择android-tv-remote逻辑模型，仍只执行并声明apps.launch；本机日志迁移不改变网关模型绑定、不批准compose。须先准备精确相同模型的网关设备，已有应用模型设备跨内置模型的完整绑定路线尚未验证。CLI可创建组合；网页当前只显示/控制/撤销组合，无创建组合的专用表单。

完整原请求默认先保存到 `~/.local/state/limeiot/gateway/execution-operations`；`--state-dir` 指定其父目录。落盘失败零 POST，同键同参再次 create 只 GET 原操作；404、丢响应或不能验证回执退出6，异参/修订冲突退出4，rejected退出7，applied退出0。恢复旧 applied 只读，不重新激活已撤销路径；另读 execution-bindings.get 核对当前状态。CLI 校验完整请求 JCS 摘要及结果与原输入的对应关系。

device-applications.list返回当前绑定的后台发现缓存，读取fresh、observed_at、binding_revision和每个包的authorized；仅当apps.launch实际路由该ADB时可用，原生路径返回execution_offer_unavailable。发现不授权；启动仍走commands.create。宿主配置变更后需重启、读取新候选并明确绑定；核心初始配置须与数据库摘要一致，不能删库绕过。绑定/组合/撤销及快照v7读取v1–6的边界见 [执行合同](../../contracts/execution-routes.md)，协议夹具通过范围见 [进度4.14](../../docs/24-实施计划与进度.md#414-显式能力组合与文档同步)，真实JVM组合未通过及当前缺口见 [4.15](../../docs/24-实施计划与进度.md#415-tv-agent模型配置与日志迁移文档同步)。

电视软件套件会构建当前网页与Rust workspace，新增旅程固定使用构建的离线模型校验器，无需全局安装；显式LIMEIOT_MODEL_VALIDATOR仍优先。仓库根运行，Node版本以package.json为准：

```sh
npm run test:tv
```

单独使用离线model validate时仍需按本文开头配置可执行路径或PATH；测试夹具的组件定位不改变生产CLI规则。4.6中validator_unavailable的失败记录保留，修复后完整软件证据见4.7，不能替代真实电视验收。

## 独立控制面

```sh
npm run cli -- control schema
npm run cli -- control schema commands.create
```

目录位于 `contracts/tools/control.json`，与本地目录分开；路径和输入约束由Go合同检查对照正式OpenAPI。目录只说明已实现动作，不能授予任何主体或空间访问权。产品草稿、远程命令、空间和配对的键为正文 `request_key`，不使用本地命令的 `Idempotency-Key` 头。

### 登录私有实例

Node.js 24.21+，使用精确HTTPS origin；HTTP只接受字面回环IP。私有CA通过Node标准的 `NODE_EXTRA_CA_CERTS` 配置，不关闭TLS验证。

```sh
npm run cli -- control auth login \
  --endpoint "https://your-private-instance.example" \
  --token-file "/absolute/private/owner-token" \
  --session-file "$PWD/.dev/control-cli/session.json"
```

凭据文件由当前用户拥有，权限0600；会话目录权限0700，CLI可以创建新目录。会话文件需为新路径，CLI拒绝覆盖现有凭据或待恢复文件。失败登录保留占位记录，排除故障后使用新的会话文件名。会话和配对输出不得加入Git、URL、日志或模型上下文。

### 使用官方云账号

在同一控制面的Console完成网页登录，展开“CLI会话”，本人明确创建最长一小时的独立会话。在受控编辑器中将材料保存为当前用户的0600文件，再导入：

```sh
npm run cli -- control auth import \
  --endpoint "https://your-control-origin.example" \
  --input "/absolute/private/cli-material.json" \
  --session-file "$PWD/.dev/control-cli/cloud-session.json"
```

导入时再次验证精确origin和当前主体；不读取浏览器Cookie，不导出LimeCloud令牌。CLI会话每次使用都检查父网页登录及当前提供方身份，父会话退出、过期或被撤销后失效；不能再次创建子会话。它拥有当前Console主体的空间管理权，网关操作仍需本地批准和当前scope。该通用流程已使用OIDC夹具验证，真实LimeCloud应用仍需登记和联调。

后续命令指定同一 `--session-file`，或在当前进程环境设置 `LIMEIOT_CONTROL_SESSION_FILE`。控制面命令不读取本地网关的 `LIMEIOT_TOKEN` 和 `LIMEIOT_ENDPOINT`。

### 空间与配对

`spaces.create`输入为 `request_key/name`，`pairings.create`为 `request_key/scopes`，实际Schema由 `control schema <operation_id>`返回。

```sh
npm run cli -- control spaces create --input "space.json" --session-file "/absolute/private/session.json"
npm run cli -- control pairings create --space-id YOUR_SPACE \
  --input "pairing-request.json" --output "/absolute/private/pairing.json" \
  --session-file "/absolute/private/session.json"
```

配对响应含秘密，必须指定新的私有 `--output` 文件；stdout只返回脱敏结果与文件引用。把文件中的配对材料交给NAS本地所有者审核，不发给模型。响应丢失时沿用相同原键与参数恢复，并指定新的输出文件；原窗口不续期。

### 产品物模型草稿

产品属于当前Console主体，不需要 `--space-id`。先发现精确输入：

```sh
npm run cli -- control schema products.create
npm run cli -- control products list --session-file "/absolute/private/session.json"
npm run cli -- control products create --input "product.json" --session-file "/absolute/private/session.json"
npm run cli -- control products get PRODUCT_ID --session-file "/absolute/private/session.json"
npm run cli -- control products save PRODUCT_ID --input "product-save.json" --session-file "/absolute/private/session.json"
npm run cli -- control products resolve ORIGINAL_KEY --session-file "/absolute/private/session.json"
```

创建输入为 `request_key/name/model`，保存另需 `expected_revision`。允许不完整模型对象，但始终为 `draft/unvalidated`；JSON保存不表示模型校验或发布，更不改变设备绑定。名称、模型大小、深度和数值限制见 [草稿合同](../../contracts/control-products.md)。列表每页16个，`next`用 `--after`继续读取。

创建和保存前记录原键、完整输入及产品ID；同键异资源也拒绝。旧记录只GET原操作，包括进程重启和404，不重复POST。HTTP200中的 `status=conflict` 为耐久修订冲突，CLI返回4并输出当时快照；保留本地输入，另读最新产品，由使用者核对后明确采用新基线和新键。未知结果返回6。

### 设备与原操作

也可使用控制面组件检查 `{ "model": 模型对象 }` 输入封装：

```sh
npm run cli -- control schema models.validate
npm run cli -- control models validate --input "model-request.json" --session-file "/absolute/private/session.json"
```

无需空间或原键，检查不保存产品或报告；草稿仍为 draft/unvalidated。HTTP200须读取valid；CLI将无效模型映射为退出2，组件不可用映射为5。

`control schema models.compare` 可发现相同的双模型封装，通过 `control models compare --input "comparison.json" --session-file "/absolute/private/session.json"` 调用控制面。兼容性检查同样无副作用、无需原键，退出0/2/5；报告不代表已发布或设备可升级。

```sh
npm run cli -- control devices list --space-id YOUR_SPACE --session-file "/absolute/private/session.json"
npm run cli -- control models get "sha256:MODEL_DIGEST" --space-id YOUR_SPACE --session-file "/absolute/private/session.json"
npm run cli -- control commands create --space-id YOUR_SPACE --input "remote-command.json" --session-file "/absolute/private/session.json"
npm run cli -- control commands resolve ORIGINAL_KEY --space-id YOUR_SPACE --session-file "/absolute/private/session.json"
npm run cli -- control commands reconcile REMOTE_ID --space-id YOUR_SPACE --session-file "/absolute/private/session.json"
```

远程命令输入包含原键、网关、绑定修订、设备、模型修订、期限和操作。新期限在未来30秒内；原参数需固定，不为恢复延长。设备列表每页最多8个，返回 `next` 时通过 `--after`读取下一页。`invoke <operation_id>`等价于分组命令，适合Agent直接采用目录中的ID。

写入前在会话目录旁的 `operations/` 保存当前origin、主体、空间与完整原请求，文件0600、目录0700，文件与目录同步完成后才提交。存储失败不发送。再次调用同键命令创建时只GET原键；即使404也不补发create。空间和配对恢复则使用服务端正式幂等合同回读原资源。异参拒绝。

`commands.resolve`只读取云记录，显式`commands.reconcile`只核实原网关命令。没有离线控制队列、自动重试或自动换键；accepted/dispatched不是设备完成，confirmed须有设备结果证据。原记录与会话分开，退出或换会话文件不清除原键；同目录、同origin和主体可继续恢复。

退出当前CLI：

```sh
npm run cli -- control auth logout --session-file "/absolute/private/session.json"
```

先撤销本站会话，再清除文件中的会话秘密；从Console导入的子会话退出不撤销父网页登录。私有实例直接登录的CLI会话独立于浏览器会话。

## 错误与验证

退出码0表示请求已受理或读取成功；2输入错误、3身份/权限、4冲突、5服务/文件故障、6结果未知、7已确认的失败/拒绝/过期。未知错误保留 `original`中的原键与文件引用；不根据网络失败推断设备未执行。

`npm run test:control:cli`使用独立临时MySQL、真实Go/Rust/WSS/TLS和MQTT模拟设备，检查会话、私有文件、原请求恢复、响应丢失及命令计数。浏览器导出与撤销由`npm run test:console`检查。它们不能替代完整NAS容器、实机、原生云入口或正式公网部署验收。

## 离线模型制品验签

构建共享Rust组件后，分别提供签名制品和通过独立渠道确认的发布者信任材料：

```sh
LIMEIOT_MODEL_VALIDATOR="/absolute/path/to/limeiot-model-validator" \
npm run cli -- model verify --input "/absolute/path/to/artifact.json" --trust "/absolute/path/to/trust.json"
```

该命令无网络和登录依赖，不写原操作文件。有效退出0，无效制品/信任退出2，组件不可用或报告错误退出5。公钥不能仅取自待验证制品并自动信任；验签不会安装模型或改变设备绑定。

## 控制面模型发布

使用已有Console会话，先发现合同并读取本人命名空间、产品和当前发布头：

```sh
npm run cli -- control schema releases.create
npm run cli -- control publisher get --session-file "/absolute/private/session.json"
npm run cli -- control releases head "product-ID" --session-file "/absolute/private/session.json"
npm run cli -- control releases create "product-ID" --input "publication.json" --session-file "/absolute/private/session.json"
npm run cli -- control releases resolve "original-key" --session-file "/absolute/private/session.json"
```

`publication.json`必须包含`request_key`、`expected_revision`、`expected_release_id`和`visibility:"public"`。首次基线为显式null；后续固定开发者已核对的上一发布ID。模型ID须属于`publisher get`返回的命名空间。列表使用`releases list "product-ID" [--after "release-ID"]`，公开制品使用`releases get "release-ID"`；当前控制面分组仍要求有效会话，离线验签不要求。

请求前将完整原输入、产品、origin和主体保存到独立私有文件。旧`releases create`只GET原键，404不补发；同键更换产品或输入返回4。published退出0、conflict退出4、未知退出6、终态rejected退出7。必须读取status，不能把HTTP200作为成功。原拒绝和冲突同样不可变；更新修订或基线后须由调用者明确创建新请求。完整服务规则见[发布合同](../../contracts/model-release.md)。
