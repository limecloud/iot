# 积木小狗豆豆

这个软件样板把已有录音、语音识别、角色提示、多轮文字和语音合成组成有限陪伴会话。每次明确提交一段录音，豆豆根据当前问题和先前问答生成回复；默认最多四轮、十分钟。生成的音频仍须独立授权和播放。

## 家庭网页

在本地家庭工作台打开“陪伴”，选择“积木小狗豆豆”和实际声音后开始。默认四轮、十分钟，也可在开始前选择自定义角色。通过下方“上传音频”明确录音并上传，再选择“本轮录音”发送；下一轮会带入本页此前问答。

页面重载或离开后不恢复历史正文，只查询原任务或结束；生成音频仍在下方单独授权播放。网页与CLI使用独立账本，不互相接管会话。运行`npm run test:companion:web`检查软件旅程，正式行为见[家庭网页合同](../../../contracts/companion.md#家庭网页)。

## CLI准备

使用Node 24及当前源码CLI，连接已配置媒体、ASR、文字和TTS的本地网关或NAS实例，配置方式见[语音回合](../../../contracts/voice-turns.md)。先在家庭网页“音频”中明确录音并上传，或上传符合合同的WAV，再用`media list --space-id space-demo`取得真实media_id。

[policy.json](policy.json)声明角色、语言、声音与预算。先按实际TTS的voices修改voice，再开始会话；运行中修改政策会被拒绝。这个样板不验证真实识别率、音质或儿童内容质量，协议夹具的软件检查见下方。

在核心仓库根目录执行以下命令，创建本次私有工作目录，并将公开模板复制成CLI接受的私有文件：

```sh
export LIMEIOT_PUPPY_DIR="$(node -e 'const fs=require("node:fs");fs.mkdirSync(".dev",{recursive:true});const d=fs.mkdtempSync(".dev/puppy-");for(const n of ["policy.json","context-empty.json"])fs.writeFileSync(d+"/"+(n==="context-empty.json"?"context.json":n),fs.readFileSync("examples/companions/block-puppy/"+n),{flag:"wx",mode:0o600});console.log(d);')"
umask 077
node packages/cli/src/main.mjs companion schema
```

使用本地开发实例时，在该终端加载`.dev/local/session.env`；NAS使用自己的HTTPS地址和私有Token文件。会话及媒体均使用对应实例的身份，不能混用。

## 第一轮

创建唯一会话编号。开始只核对并固定三类模型，尚不推理：

```sh
node packages/cli/src/main.mjs companion start \
  --space-id space-demo --state-dir "$LIMEIOT_PUPPY_DIR/state" \
  --policy "$LIMEIOT_PUPPY_DIR/policy.json" --id puppy-UNIQUE
```

将下面的media-YOUR_UPLOADED_ID替换成实际上传编号。准备输入后，明确请求本轮回答：

```sh
node -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({media_id:process.argv[2]}),{mode:0o600});' "$LIMEIOT_PUPPY_DIR/reply.json" "media-YOUR_UPLOADED_ID"
node packages/cli/src/main.mjs companion reply \
  --space-id space-demo --state-dir "$LIMEIOT_PUPPY_DIR/state" \
  --policy "$LIMEIOT_PUPPY_DIR/policy.json" \
  --context "$LIMEIOT_PUPPY_DIR/context.json" \
  --input "$LIMEIOT_PUPPY_DIR/reply.json" --wait --emit-context \
  > "$LIMEIOT_PUPPY_DIR/round-1.json"
```

检查phase为succeeded、turn中的transcript/answer，以及生成的media_id。它们分别表示识别、文字回答与音频引用，不表示音箱已经发声。`--emit-context`是明确导出明文历史的选择，本例将输出保存在私有工作目录；平台自己的会话账本只保留摘要。

## 第二轮

只有第一轮完整成功时，才更新下一轮上下文：

```sh
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(r.phase!=="succeeded"||!r.context)throw Error("turn_not_complete");fs.writeFileSync(process.argv[2],JSON.stringify(r.context),{mode:0o600});' "$LIMEIOT_PUPPY_DIR/round-1.json" "$LIMEIOT_PUPPY_DIR/context.json"
```

明确上传下一段录音，更新reply.json中的media_id，再运行相同reply命令并将输出保存为round-2.json。第二轮文字请求携带第一轮问答。调用者可以一直在内存中持有历史；本例文件只是开发者明确选择的保存方式。

历史丢失、被修改、超过文字上下文限制，或政策/模型发生变化时，会话拒绝下一阶段。它不会用空历史冒充连续对话，不截断上下文，也不会为了得到更短回答额外调用模型。用量按实际已占用轮次计算，失败或unknown不自动退款。

## 中断与结束

Ctrl+C会取消当前CLI操作并释放正常进程锁，已经提交的任务可能仍在运行。随后只查询原回合：

```sh
node packages/cli/src/main.mjs companion resolve \
  --space-id space-demo --state-dir "$LIMEIOT_PUPPY_DIR/state"
```

unknown退出码为6，保留原任务，不创建替代回合。需要推进尚未创建的阶段时，使用continue并提供原政策及准确context；不能重发reply或换会话编号作为重试。

明确结束整个会话无需恢复角色文件或历史：

```sh
node packages/cli/src/main.mjs companion stop \
  --space-id space-demo --state-dir "$LIMEIOT_PUPPY_DIR/state"
```

stop先保存停止决定，再清除各轮成功的文字回答并放弃未决输出。stop_settled为true后，才可用新编号开始下一会话。原录音和生成音频沿媒体TTL及独立删除/授权合同处理，已授权音箱播放另行停止。你自己保存的轮次输出和context文件仍由你管理。

## 软件验证

```sh
npm run test:companion
```

入口验证真实Rust/MQTT/SQLite、三类协议提供方、两轮上下文、部署变化拒绝、轮数/期限、历史丢失、原键恢复、停止清文及CLI进程中断，并回归现有v1语音网页。模型输出是固定夹具，未访问玩具或麦克风；完整范围见[会话合同](../../../contracts/companion.md)。

SwiftUI/Compose也提供本地“设置 → 音频 → 陪伴”入口，默认使用豆豆的角色说明，允许开始前修改，最多四轮、十分钟。原生后台或离页清除历史，返回只查询，停止后才可开始新会话；生成音频另行授权播放。合同与验证边界见[原生客户端](../../../contracts/companion.md#原生客户端)。
