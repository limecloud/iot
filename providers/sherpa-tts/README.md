# 本地 sherpa TTS 提供方

独立CPU服务，将本地sherpa-onnx VITS模型适配成平台的[有限语音HTTP接口](../../contracts/speech.md)。平台核心只依赖`SpeechProvider`和PCM WAV，不导入sherpa类型；此服务没有设备凭据、播放接口或网关数据目录。

## 配置模型

准备支持sherpa VITS的`model.onnx`、`lexicon.txt`、`tokens.txt`和可选的`phone.fst`、`date.fst`、`number.fst`。配置格式见[Schema](config.schema.json)，[AISHELL-3示例](aishell3.example.json)固定了本次研究模型的文件SHA-256和声音21。更换模型须重新核对每份文件、采样率和实际说话人编号，不接受HTTP请求指定文件路径。

模型目录由安装者预置，不自动联网下载或执行模型附带代码。模型文件须为普通文件，单份ONNX最多64MiB、其他文件各8MiB，合计最多96MiB。配置最多8KiB，声音最多32项，CPU线程1–4个。启动及每次计算都核对配置修订与文件摘要；挂载目录应只读，升级使用新目录并重启服务。

**模型许可独立于引擎。** sherpa-onnx采用Apache-2.0，NumPy保留其分发包内许可。示例模型来自[官方VITS说明](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)，[AISHELL-3数据集](https://www.openslr.org/93/)标注Apache-2.0；模型归档和所查说明未提供明确权重许可。本仓库只提供服务代码和摘要示例，不分发权重；该模型目前仅作兼容性研究，不是已确认可商业分发的产品模型。

## 本机运行

在项目私有环境安装固定版本，不修改系统Python：

```sh
python3 -m venv ".dev/sherpa-tts/venv"
".dev/sherpa-tts/venv/bin/python" -m pip install -r "providers/sherpa-tts/requirements.txt"
".dev/sherpa-tts/venv/bin/python" -I "providers/sherpa-tts/server.py" \
  --config "providers/sherpa-tts/aishell3.example.json" \
  --model-directory "/absolute/path/to/model" --port 8000
```

默认仅监听`127.0.0.1`。启动会实际装载模型并核对声音；`GET /healthz`返回当前服务是否可接受请求、计算槽位是否占用、模型ID和配置修订，不表示音质通过。私网监听须显式设置`--listen`和允许的精确`--allowed-host`；服务只面向可信网关，不提供账号认证、CORS或公网入口。

为已启用媒体服务的网关进程设置`LIMEIOT_TTS_URL=http://127.0.0.1:8000`、与配置一致的`LIMEIOT_TTS_MODEL`及逗号分隔的`LIMEIOT_TTS_VOICES`。家庭网页、CLI和API继续走网关，浏览器不直接调用推理服务。

## 请求与资源

仅`POST /v1/audio/speech`处理推理，字段为`model`、`input`、`voice`、`response_format:"wav"`、`speed:1`。拒绝未知字段、重复JSON键、异常Unicode和控制字符。文本最多1000个Unicode标量及4096个UTF-8字节，HTTP正文最多8KiB。只接收明确Content-Length的JSON，拒绝压缩和分块请求、重复长度、浏览器Origin及未获准Host。

同时最多4个HTTP连接、1个计算，不排队。请求头及正文合计最多5秒；每次计算使用独立Python子进程，80秒总期限，stdout最多4MiB，stderr丢弃，不继承网关凭据。期限、超量或服务退出均终止并回收原子进程，不重新调用模型。输出为单声道PCM16 WAV，8–48kHz，最多60秒且不超过4MiB；超过任一上限拒绝完整结果，不发布截断音频。

正文仅在HTTP读取、内存及子进程匿名管道中传递，不进入参数、临时文件或请求日志。网关的摘要任务、unknown预算及原键恢复仍为唯一业务事实源。客户端断线或网关明确放弃不表示服务已取消；网关阻止迟到结果入库。服务重启不恢复请求，不保存任务历史。

## NAS 可选部署

在基础`compose.yaml`和`compose.media.yaml`后叠加[compose.sherpa.yaml](../../deploy/nas/compose.sherpa.yaml)，与外部服务的`compose.speech.yaml`二选一。示例：

```sh
LIMEIOT_TTS_MODELS_DIR="/absolute/path/to/model" \
LIMEIOT_TTS_CONFIG_FILE="/absolute/path/to/provider.json" \
LIMEIOT_TTS_MODEL="vits-icefall-zh-aishell3" \
LIMEIOT_TTS_VOICES="mandarin" \
docker compose --env-file "/absolute/path/to/installation/compose.env" \
  -f "deploy/nas/compose.yaml" -f "deploy/nas/compose.media.yaml" \
  -f "deploy/nas/compose.sherpa.yaml" up -d --build
```

配置和模型只读挂载。服务只接入独立internal网络，不发布主机端口，不挂载网关秘密或数据库；默认2 CPU、768MiB内存、64 PID和只读根文件系统，可通过`LIMEIOT_TTS_CPUS`与`LIMEIOT_TTS_MEMORY_LIMIT`调整。镜像只安装固定依赖，不包含模型。没有GPU或设备权限。

网关不依赖此服务的启动或健康状态。模型加载失败、计算挂起或服务退出不阻塞本地设备控制与已部署联动；语音原任务继续按合同查询和明确放弃，不自动重算。`up --wait`会汇总语音服务故障，不能仅凭它的退出码判断网关是否可用。

当前Compose隔离配置已渲染检查，Linux x86_64/ARM64的CPython 3.14依赖轮子已核对存在；这不等于镜像已经构建、运行或在NAS上完成性能验收。

## 验证

`npm run test:speech:provider`执行无模型的Python边界及Compose检查。真实模型检查不自动下载或跳过缺失条件：

```sh
LIMEIOT_SPEECH_PYTHON="/absolute/path/to/private/venv/bin/python" \
LIMEIOT_SPEECH_MODEL_DIRECTORY="/absolute/path/to/vits-icefall-zh-aishell3" \
npm run test:speech:provider:live
```

真实入口验证并发拒绝、实际音频上限、390px网页生成、原字节入库与软件音箱Range拉取、明确授权播放、CLI查询、重启及丢失真实提供方响应后不重新合成。播放终端是软件夹具，非人工听感或物理发声验收；实机按用户要求跳过。
