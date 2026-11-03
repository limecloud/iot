# 本地 sherpa ASR 提供方

独立CPU服务，使用sherpa-onnx运行Paraformer Small或Whisper Tiny INT8模型，实现[有限语音识别合同](../../contracts/transcription.md)。网关继续只依赖`TranscriptionProvider`和WAV/JSON，不加载模型，也不向识别服务授予设备、规则或播放权限。

## 模型与许可

模型由安装者预置，不自动下载或执行归档脚本。配置固定引擎、模型ID和每份文件SHA-256，见[Schema](config.schema.json)。启动和每次识别前重新核对，配置或模型变化须重启；来源和摘要见[来源记录](model-source.json)。

| 配置 | 运行文件 | 适用范围 |
| --- | --- | --- |
| [Paraformer Small](paraformer-small.example.json) | `model.int8.onnx`、`tokens.txt` | 中文及中英混合候选，语言由模型自动识别，请求头不强制过滤语言 |
| [Whisper Tiny](whisper-tiny.example.json) | `tiny-encoder.int8.onnx`、`tiny-decoder.int8.onnx`、`tiny-tokens.txt` | 多语言兼容性研究；本次中文样本未达标，不作为已验收的中文模型 |

Paraformer制品来自[sherpa官方发布](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2)，官方说明指向[转换模型](https://modelscope.cn/models/crazyant/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-onnx/summary)，其README指向[原始模型](https://modelscope.cn/models/damo/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1/summary)。原始模型元数据声明Apache License 2.0，转换模型许可字段为空；本仓库记录该差异，不分发权重或宣称转换制品分发许可已确认。

[Whisper上游](https://github.com/openai/whisper#license)明确将代码与权重以MIT开放，[许可副本](WHISPER-LICENSE.txt)须随其模型分发保留。[Whisper ONNX制品](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2)同样来自sherpa发布。[引擎](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)为Apache-2.0，NumPy保留其分发包许可；平台许可不替代第三方许可。

配置最多8KiB，CPU线程1–4个。模型目录只接受所选引擎的明确文件名，拒绝符号链接；每份ONNX最多128MiB，词表最多8MiB，合计最多128MiB。Whisper示例解码器约85.7MiB，量化名称不表示所有张量均为INT8。只读挂载并使用新目录升级，避免运行中替换模型。

## 本机运行

使用项目私有Python环境安装固定依赖：

```sh
python3 -m venv ".dev/sherpa-asr/venv"
".dev/sherpa-asr/venv/bin/python" -m pip install -r "providers/sherpa-asr/requirements.txt"
".dev/sherpa-asr/venv/bin/python" -I "providers/sherpa-asr/server.py" \
  --config "providers/sherpa-asr/paraformer-small.example.json" \
  --model-directory "/absolute/path/to/sherpa-onnx-paraformer-zh-small-2024-03-09" --port 8001
```

默认监听`127.0.0.1`，启动实际装载模型，成功后才开放HTTP。私网监听须显式传入`--listen`与精确的`--allowed-host`。服务面向可信网关，不提供公网入口、账号认证或浏览器CORS。`GET /healthz`只表示启动加载完成及计算槽位状态，不代表识别质量通过或重新装载模型。

已启用媒体服务的网关设置：

```sh
LIMEIOT_ASR_URL="http://127.0.0.1:8001"
LIMEIOT_ASR_MODEL="paraformer-small-int8"
```

将以上设置传给网关进程；浏览器、CLI和手机继续调用网关，不直接访问模型。

## 输入、结果与故障

仅`POST /v1/audio/transcriptions`计算。正文为完整PCM16 WAV，明确`Content-Length`和`Content-Type: audio/wav`，请求头`X-Limeiot-Model`须与配置一致，`X-Limeiot-Language`为`auto`、`zh`或`en`。拒绝重复字段、压缩、分块、浏览器Origin和未获准Host。

输入最多4MiB和60秒，8–48kHz、1/2声道。服务核对RIFF及fmt/data结构，在内存中将双声道平均混为单声道，由sherpa在`accept_waveform`中重采样。按最多25秒分段识别并用换行合并，覆盖完整输入，避免Whisper对30秒后音频静默截断。分段没有VAD或词边界对齐，边界处可能识别不准。无文件上传目录、任意解码器或外部转码命令。

输出精确为`{"text":"识别文本"}`，最多2048个Unicode标量、8192个UTF-8字节，HTTP结果最多32768字节。允许空文本；拒绝非法Unicode、控制字符和超量结果，不截断后发布。识别结果不自动成为命令。Whisper可能在静音、音乐或噪声下产生幻觉；本服务没有VAD、说话人识别、唤醒词、流式识别或已验收的嘈杂环境质量。

同时最多4个HTTP连接、1个计算，不排队。请求头和正文总期限5秒，每次计算使用独立子进程，80秒期限；超时、输出超量和服务停止均终止并回收原进程。与TTS共用[有界子进程管理](../local_process.py)，不继承调用者令牌环境。音频仅经内存和匿名管道传递，转写不进入参数、临时文件或服务日志。服务无任务历史、重试或重启恢复；网关的耐久任务为业务事实源。网关放弃输出或断线不承诺提供方立即取消。

## NAS 可选部署

基础与媒体覆盖后叠加[compose.sherpa-asr.yaml](../../deploy/nas/compose.sherpa-asr.yaml)，与外部提供方的`compose.transcription.yaml`二选一；可与TTS的`compose.sherpa.yaml`并存：

```sh
LIMEIOT_ASR_MODELS_DIR="/absolute/path/to/sherpa-onnx-paraformer-zh-small-2024-03-09" \
LIMEIOT_ASR_CONFIG_FILE="/absolute/path/to/provider.json" \
LIMEIOT_ASR_MODEL="paraformer-small-int8" \
docker compose --env-file "/absolute/path/to/installation/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.media.yaml" \
  -f "deploy/nas/compose.sherpa-asr.yaml" up -d --build
```

模型与配置只读挂载。服务只接入独立internal网络，不发布主机端口、不挂载网关存储或秘密。默认2 CPU、768MiB、64 PID、只读根和cap_drop，可通过`LIMEIOT_ASR_CPUS`及`LIMEIOT_ASR_MEMORY_LIMIT`调整。镜像不含模型。网关没有对该服务的启动依赖，模型离线不阻塞基础控制；整栈`up --wait`仍会汇总模型健康失败。镜像构建、容器实际运行和NAS性能须分别验收，配置渲染不能代替它们。

## 验证

`npm run test:transcription:provider`运行无模型Python边界及配置Schema/双提供方Compose检查。真实入口默认使用Paraformer配置，可通过LIMEIOT_ASR_CONFIG指定其他配置。显式要求本地模型与至少两条有已知内容的外部WAV样本，不自动下载模型或跳过缺失条件。样本清单格式：

```json
[
  {"file":"/absolute/path/to/recording-0.wav","language":"zh","expected_patterns":["对我做了介绍","对我的研究感兴趣"]},
  {"file":"/absolute/path/to/recording-1.wav","language":"zh","expected_patterns":["三个问题","全球金融动荡的表现"]}
]
```

```sh
LIMEIOT_ASR_PYTHON="/absolute/path/to/private/venv/bin/python" \
LIMEIOT_ASR_MODEL_DIRECTORY="/absolute/path/to/sherpa-onnx-paraformer-zh-small-2024-03-09" \
LIMEIOT_ASR_SAMPLES="/absolute/path/to/samples.json" \
npm run test:transcription:provider:live
```

以上参考内容来自官方制品`test_wavs/0.wav`与`1.wav`的[公开示例输出](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html)。录音需为平台支持的规范PCM WAV；测试样本只重封装WAV头，不改变PCM帧。它们用于上游示例兼容性，不是独立标注的准确率基准。

入口验证实际识别与不同音频产生不同文本、第31秒后语音仍被识别、并发拒绝、390px网页、CLI、结果恢复、识别完毕但响应未到时重启保持unknown、原键零重放及源录音删除清文。不能据此推断儿童、口音、英语、远场或真实家庭环境质量；原生完整应用与NAS容器另验。实机按用户要求跳过。

本轮另有两条8kHz VITS合成语音质量检查，Whisper Tiny与Paraformer Small均未通过：“公园散步”等内容被误识别，另一条“请记得”也存在错字。原合成语音、参考文本、失败结果和解码配置研究分别保留在本地证据中；没有降低原断言或将这组质量检查计为通过。输入合成质量与识别模型的贡献尚未分离，中文语音闭环质量继续验收。
