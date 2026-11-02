# 固件签名与本地制品发布

本合同定义离线密钥生成、签名包准备和本地不可覆盖的制品仓库。正式来源为 [输入与输出Schema](ota-release.schema.json)、[工具目录](tools/ota.json) 和共享Rust规则。签名与仓库导入不表示公网已发布、已批准升级或已安装。

## 工具

先构建独立组件；Node CLI只转交参数和退出状态，私钥不通过环境变量、JSON输入或模型上下文传递。

```sh
cargo build --locked -p limeiot-model-validator --bin limeiot-ota
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota keygen \
  --output-dir ".dev/firmware-key"
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota sign \
  --input "release.json" --trust "firmware-trust.json" \
  --key ".dev/firmware-key/private.pk8" --image "firmware.bin" \
  --output-dir ".dev/signed-firmware"
```

`ota schema` 返回全部Schema与 `schema_resources` 映射，消费者按映射注册资源后解析相对引用，无需联网获取Schema。签名输入见 [示例](examples/ota-release.json)。父目录须已存在，输出目录必须全新；参数重复或未知返回2。

## 独立密钥与信任

`keygen` 使用系统随机源生成Ed25519 PKCS8 DER，写入 `private.pk8`，同时保存和输出 `public.json`。公钥描述包含用途device-firmware、规范Base64公钥和原始公钥SHA-256指纹，不含下载来源、产品范围或授权策略，不能作为完整trust直接使用。

所有者独立核对指纹并配置 [固件trust](ota.schema.json#/$defs/trust)。`sign` 必须显式读取该trust，核对用途、有效期、产品、来源、撤销与安全代次，以及私钥实际公钥/指纹。工具不从待签配方或旧包自动建立信任。正式固件使用专用密钥，与模型发布、设备身份和HTTPS CA分别管理；仓库公开测试种子不得用于产品。

输入只接受普通文件，Unix拒绝最终路径符号链接和FIFO，不阻塞等待特殊文件。私钥最多4096字节，Unix权限不允许组或其他用户访问。新目录0700、文件0600；工具不修改已有文件权限。其他系统的ACL需要由运行环境管理，不能把Unix检查扩展为跨平台安全存储证明。

## 配方与实际镜像

配方必须完整提供schema/version、image_format、target、firmware_version、compatibility、security_epoch、download_base_url、issued_at、expires_at；未知/重复字段、非法类型或超过32KiB/16层/2048节点拒绝。目标、版本、安全代次、有效期及下载来源复用OTA正式合同，不需要发布者伪造设备电量或运行状态。

当前image_format仅支持esp32c3，target须为riscv32/esp32c3。工具检查应用镜像头、C3芯片标记、1–16个分段及长度、应用描述魔数、XOR校验和和附加SHA-256，拒绝截断或尾随字节。配方版本与安全代次必须等于镜像应用描述，实际项目名进入回执。当前不支持无附加摘要、已追加原生Secure Boot签名或其他芯片的签名输入；这些格式需独立适配，不自动降级为任意二进制。

镜像不超过32MiB并须包含完整C3应用结构，工具读取有界字节快照并从该快照计算长度/摘要，输出的也是同一份字节。该格式检查不证明Flash布局、硬件兼容或设备可启动；设备仍执行原生镜像验证、项目名/版本/安全代次和写入回读检查。配方示例的0.2.0要求实际先构建0.2.0，不能为0.1.0镜像填写更高版本。

## 身份与签名

先计算以下对象的RFC8785摘要，将sha256:前缀替换为artifact-，形成不可变制品身份：

```text
{schema:"limeiot.ota-artifact-identity",version:1,
 signing_key_id,recipe:完整配方,size_bytes:实际长度,sha256:实际镜像摘要}
```

下载地址为 `download_base_url + artifact_id + "/firmware.bin"`，base须为以斜杠结尾的规范HTTPS地址。镜像、配方、下载基础地址或签名密钥改变都会得到新身份；同一输入/密钥产生相同清单和回执。旧版外部清单的身份规则保持兼容，不将该生成规则倒推为所有历史制品的证明。

清单严格使用 `LimeIoT Device Firmware v1\n` 与原 [OTA签名域](ota.md)，签名后立即由共享Rust验签并校验独立策略。完整清单不超过16KiB，兼容设备C核心字节预算。签名不读取设备、不创建升级任务，也不更改本地trust。

## 输出与恢复

新目录只保存以下四份文件：

| 文件 | 内容 |
| --- | --- |
| release.json | 完整配方 |
| firmware.bin | 已检查的实际镜像快照 |
| manifest.json | 完整Ed25519签名清单 |
| receipt.json | 最后提交的ready回执，绑定配方/清单/镜像摘要与密钥指纹 |

私钥与完整信任策略不复制进包。前三份文件及目录先fsync，随后创建并fsync回执、再次同步目录。发布消费者必须重新验证清单、实际镜像和原回执，不能仅依据文件存在或ready文本。最终IO返回失败也可能已有耐久文件，调用者只读检查原目录；工具不清理、不覆盖或自动续签，另行选择新目录需要明确操作。

成功0；参数、配方、镜像、私钥或策略不符2；输出已存在4；随机源、组件或IO错误5。失败只输出稳定错误码，不回显私钥内容或输入路径。错误发生在输出创建前时不生成目录；创建后的IO失败保留部分文件，不推断已发布。

## 验证与边界

`npm run test:ota:sign` 覆盖公开描述/权限、正式Schema发现、Node独立验签、Rust实际镜像校验、内容身份/密钥更换、不覆盖、拒绝输入及真实HTTPS下载。`npm run test:ota` 验证原校验/下载行为。实际灯/按钮构建产物另以生成的测试专用密钥运行签名、Rust验证、C验签及C预检；设备快照是显式宿主夹具，不能解释为实机安装。

## 本地仓库与NAS HTTPS

`publish` 是显式的本地文件写入适配，不联网、不读取私钥、不修改信任或启动容器：

```sh
LIMEIOT_OTA_TOOL="$PWD/target/debug/limeiot-ota" npm run cli -- ota publish \
  --bundle ".dev/signed-firmware" --trust "firmware-trust.json" \
  --repository ".dev/nas/firmware" --base-url "https://NAS_ADDRESS:18443/artifacts/"
```

仓库根须已存在且为普通目录，Unix不允许组/其他用户写入；最终目录路径拒绝符号链接。运行者管理可信的父路径，仓库只允许该所有者写入。base-url必须与配方完全相同；内置NAS入口使用实际HTTPS origin加 `/artifacts/`，不会替调用者修改已签地址。

导入前重新读取独立trust，验证当前有效期、用途、指纹、产品、撤销、下载来源及安全代次下限。源包须恰好包含四个正式文件；逐一重新验证原生镜像和版本/代次，并从同一字节快照重建内容身份、完整statement、清单摘要和回执。回执未知字段、错误摘要或仅有ready文本均不能通过。文件写入后、提交前再次按该信任快照与当前时间预检；执行期间外部策略文件变化不属于同一快照。

通过后独占创建 `artifacts/<artifact_id>/`，新目录0700、文件0600，复制已验证快照。四文件及目录同步后，写入并同步publication.pending.json，最后通过独占硬链接原子建立published.json并同步目录。发布回执为status=stored，绑定制品ID、清单摘要、镜像长度/摘要和签名下载地址。私钥和完整trust不进入仓库。

相同ID即使内容相同也返回4，已有目录、符号链接或中断目录均不覆盖或自动续写。IO错误可能发生在已提交之后；恢复先只读检查原published.json和实际镜像/清单，不据失败退出推断没有写入。文件系统所有者仍可人工改动，工具的不覆盖约束不等于操作系统强制只读。

NAS的edge仅以只读卷挂载仓库。只有published.json提交标记存在时，才允许GET/HEAD读取精确制品路径下的firmware.bin和manifest.json；其他文件、目录列表、未提交目录和写请求均拒绝。静态文件禁用符号链接并使用不可变缓存头。该入口提供制品字节，不授予安装权限；下载器和设备仍验证签名、当前策略及完整实际字节。撤销/到期不自动删除缓存，消费者必须继续拒绝。

返回0表示本地入库完成，2表示参数/策略/包/仓库条件不符，4表示制品目录已存在，5表示组件或IO故障。新安装创建空仓库；NAS备份包含存在的firmware目录，备份期间须停止所有发布写入。恢复旧备份没有制品时创建空仓库，再从独立保留的签名包按相同origin和配方明确导入；备份有制品也不代表已安装，见 [NAS说明](../deploy/nas/README.md)。

`npm run test:ota:publish` 验证严格重验、并发冲突、拒绝覆盖、篡改/撤销及中断目录；`npm run test:ota:repository` 使用隔离的真实NAS Nginx配置和HTTPS CA，覆盖隐藏未提交制品、GET/HEAD、写请求/内部元数据拒绝及正式下载器。可传入 `--lamp-image`、`--button-image` 验证实际目标镜像，省略时只使用合法格式夹具。正式密钥交付、生产托管和原生Secure Boot格式仍待完成；实机验收按用户要求跳过，不计为通过。
