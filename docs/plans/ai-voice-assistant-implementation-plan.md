# AI 助手语音能力落地方案

更新时间：2026-07-03

状态：设计稿，待确认后实施。

## 1. 背景

Culina 已经有两条 AI 对话入口：

- 主 AI 工作台：`AiWorkspace` 通过 `/api/ai/chat/stream` 走 `WorkspaceOrchestratorAgent`，支持多 Skill、工具调用、草稿审批、图片附件和 SSE 文本流。
- 做菜页小灶：`CookingAssistantPanel` 通过同一套 `streamChatAi`，但传入 `quick_task=cooking_assistant`、`subject.source=recipe_cook_page`、`persist_history=false`，只服务当前做菜现场。

这两条入口的语音能力不能混成一个模式。主 AI 涉及菜谱、库存、购物清单、餐食记录和审批写入，误识别风险更高；做菜页场景更适合语音，因为用户手上可能不方便，需要看步骤、计时、切换页面和听短回复。

第一版语音目标：

1. 主 AI 助手只接入语音输入。
2. 做菜页小灶接入语音输入和语音输出。
3. 做菜页支持实时电话式对话，但不接纯 Speech-to-Speech。
4. 第一版模型供应商同时支持 OpenAI 和阿里云百炼 DashScope。

第一版的关键边界：所有语音能力都只是现有文本 Agent 的输入/输出层。语音识别后的最终文本仍进入现有 agent loop，assistant 回复文本再交给 TTS 播报；不让实时语音大模型直接接管业务主循环。

## 2. 当前代码基础

### 2.1 主 AI 工作台

关键文件：

- `frontend/src/components/ai/AiWorkspace.tsx`
- `frontend/src/components/ai/AiMobilePage.tsx`
- `frontend/src/components/ai/useAiStreamMutations.ts`
- `frontend/src/api/aiApi.ts`
- `backend/app/api/ai.py`
- `backend/app/ai/workspace_service.py`
- `backend/app/ai/workflows/orchestrator/`

当前主 AI 发送链路：

```text
用户输入文本/图片
  -> AiWorkspace.sendMessage()
  -> aiApi.streamChatAi()
  -> POST /api/ai/chat/stream
  -> AIApplicationService.stream_chat()
  -> WorkspaceGraphRunner / WorkspaceOrchestratorAgent
  -> SSE message_delta / message_part / progress / response
```

第一版主 AI 语音只应在 `sendMessage()` 前增加“录音转文字填入 composer”，不要改变 AI run、approval 或 SSE 协议。

### 2.2 做菜页小灶

关键文件：

- `frontend/src/components/recipes/RecipeCookView.tsx`
- `frontend/src/components/recipes/CookingAssistantPanel.tsx`
- `frontend/src/components/recipes/useCookingAssistantStream.ts`
- `frontend/src/components/recipes/useCookingAssistantState.ts`
- `frontend/src/components/recipes/cookingAssistantModel.ts`
- `frontend/src/components/recipes/useRecipeCookState.ts`
- `backend/app/ai/skills/catalog/cooking-assistant/SKILL.md`
- `backend/app/ai/skills/catalog/cooking-assistant/skill.yaml`
- `backend/app/ai/tools/catalog/ui.py`
- `backend/app/ai/workflows/orchestrator/profiles.py`

当前做菜页小灶发送链路：

```text
用户输入文字
  -> CookingAssistantPanel.handleUserMessage()
  -> useCookingAssistantStream.sendMessage()
  -> aiApi.streamChatAi({
       quick_task: "cooking_assistant",
       subject: buildCookingAssistantSubject(...),
       persist_history: false
     })
  -> cooking_assistant profile
  -> cooking-assistant Skill
  -> ui.propose_actions / recipe.read_by_id / inventory.read_available_items
  -> SSE 文本和 result_card
  -> parseCookingUiActionsCard()
  -> executeCookingUiActions()
```

`buildCookingAssistantSubject()` 已经提供当前菜谱、当前步骤、前后步骤、食材、缺料、计时器、活动 tab 和最近小灶对话。`ui.propose_actions` 已经要求工具调用后有一句短自然语言总结，适合后续 TTS 播报。

## 3. 产品范围

### 3.1 主 AI 助手

第一版只做语音输入：

- 在桌面和移动 composer 增加麦克风按钮。
- 用户点击录音，停止后上传音频转写。
- 转写结果填入输入框，默认不自动发送。
- 用户仍需点击发送，避免误触发草稿、审批或复杂任务。
- 不朗读主 AI 回复。
- 不支持主 AI 电话模式。

### 3.2 做菜页小灶

第一版做三种语音交互：

1. 按住/点击录音输入。
   - 转写结果可以直接发送给小灶。
   - 发送前需要展示短暂可取消状态，例如“识别到：下一步，正在发送”。

2. 小灶回复播报。
   - 只播报 assistant 自然语言文本。
   - 不直接读工具卡片内部字段。
   - 遇到页面动作卡片时，依赖 AI 后续短文本播报，例如“好了，已经切到下一步”。

3. 电话模式。
   - 用户进入“小灶通话”后可连续说话。
   - 支持打断、静音、挂断、字幕和连接状态。
   - 第一版采用 Agent-backed phone mode：语音层负责听说和状态机，业务判断仍走现有 `cooking_assistant` agent loop。
   - 电话模式只服务做菜页，不进入主 AI 工作台。

### 3.3 第一版非目标

- 不保存原始录音到 `MediaAsset`。
- 不把语音文件作为家庭媒体资源展示。
- 不给主 AI 增加自动语音输出。
- 不让语音绕过草稿审批、做菜完成确认或高风险页面确认。
- 不直接通过语音扣库存、完成计划、写餐食记录或修改菜谱。
- 不在浏览器暴露 OpenAI 或 DashScope API Key。
- 第一版不支持电话外呼、SIP 电话号码或真实电话网关。
- 第一版不做长录音、会议纪要或通话分析类批量转写。
- 第一版不做纯 Speech-to-Speech，不让 OpenAI Realtime 或 Qwen-Omni-Realtime 直接成为做菜业务主循环。

## 4. 供应商能力矩阵

### 4.1 架构选择

语音应用常见有三种路径，但第一版只采用前两种。第三种只用于定义反向边界，避免实施时误把实时语音大模型接成业务主循环；它不是第一版的交付范围，也不在本文档里继续展开二期设计。

```text
Pipeline:
  STT 语音转文本
  -> 现有文本 AI agent
  -> TTS 文本转语音

Agent-backed phone mode:
  实时 ASR / VAD / 字幕
  -> 最终用户文本
  -> 现有 cooking_assistant agent loop
  -> assistant 文本 / ui_actions
  -> TTS 流式或短音频播报

Speech-to-Speech:
  实时音频输入
  -> 实时多模态/语音模型
  -> 实时音频输出
  -> 工具调用/页面动作
```

主 AI 和普通做菜录音使用 Pipeline，因为它能复用现有文本 agent、审批、安全边界和日志。

第一版做菜页电话模式使用 Agent-backed phone mode，不规划纯 Speech-to-Speech：

- 语音层负责实时听写、VAD、字幕、打断、静音、挂断和 TTS 播放。
- 业务判断、工具调用、页面动作和高风险确认仍走现有 `AIApplicationService.stream_chat()`、`cooking_assistant` profile、`ui_actions` 校验。
- OpenAI Realtime 或 DashScope Qwen-Omni-Realtime 不进入第一版方案，不作为第一版接口、配置、测试或验收目标。
- 第一版不为 Speech-to-Speech 预留 provider function calling、WebRTC 会话控制、实时模型工具 schema 或页面动作直连协议。

### 4.2 OpenAI

第一版建议默认模型：

| 能力 | 默认模型 | 接入方式 | 用途 |
| --- | --- | --- | --- |
| STT | `gpt-4o-mini-transcribe` | Audio transcriptions | 主 AI 和做菜页短语音输入 |
| 高质量 STT | `gpt-4o-transcribe` | Audio transcriptions | 可选配置 |
| TTS | `gpt-4o-mini-tts` | Audio speech | 做菜页回复播报 |
| 电话模式 | `gpt-4o-mini-transcribe` + `gpt-4o-mini-tts` | VAD 断句后转写 + TTS | 非 Speech-to-Speech 的 Agent-backed phone mode |

OpenAI 语音输入文件接口支持 `mp3`、`mp4`、`mpeg`、`mpga`、`m4a`、`wav`、`webm`，文件上限 25 MB。前端 `MediaRecorder` 录制 `audio/webm` 时可以直接走该链路。

OpenAI TTS 使用 `audio/speech`，输入包括模型、文本和 voice。第一版 voice 配置化，不硬编码到业务逻辑。

OpenAI 第一版电话模式不接 `gpt-realtime-2`，而是走 Agent-backed phone mode：

```text
浏览器
  -> 后端 /api/ai/realtime/cooking/session
  -> 后端 VAD / 断句 / 转写
  -> AIApplicationService.stream_chat(quick_task="cooking_assistant")
  -> ui_actions / assistant 文本
  -> TTS 播报
```

`gpt-realtime-2`、WebRTC、server-side controls 和实时模型 function calling 不纳入第一版规划。若未来重新评估，也必须作为单独二期方案，不影响本方案第一版落地。

### 4.3 阿里云百炼 DashScope

第一版建议默认模型：

| 能力 | 默认模型 | 接入方式 | 用途 |
| --- | --- | --- | --- |
| STT 短语音 | `fun-asr-flash-2026-06-15` | DashScope HTTP 同步调用 | 主 AI 和做菜页短语音输入 |
| STT 长音频预留 | `qwen3-asr-flash-filetrans` | DashScope HTTP 异步任务 | 后续长录音转写，不进入第一版 |
| STT 实时字幕 | `qwen3-asr-flash-realtime` | WebSocket | 电话模式字幕或实时 Pipeline 备用 |
| STT 实时增强 | `fun-asr-realtime` | WebSocket | 需要热词、句级/字级时间戳时备用 |
| TTS 播报 | `qwen3-tts-flash` 或 `qwen3-tts-instruct-flash` | HTTP / 流式输出 | 做菜页普通播报 |
| TTS 实时 | `qwen3-tts-flash-realtime` 或 `qwen3-tts-instruct-flash-realtime` | WebSocket | 低延迟播报 |
| 电话模式 | `qwen3-asr-flash-realtime` + `qwen3-tts-flash-realtime` | WebSocket ASR + WebSocket TTS | 非 Speech-to-Speech 的 Agent-backed phone mode |

DashScope 关键注意点：

- `fun-asr-flash-2026-06-15` 支持 5 分钟以内音频同步调用，可流式或非流式返回结果，适合第一版“录音后转文字”。如果当前 API 只接受公网音频 URL，后端需要生成短时临时 URL 后调用，不能把原始录音落成家庭媒体资源。
- `qwen3-asr-flash-filetrans` 是异步文件转写，最长可到 12 小时，且只接受公网音频 URL；任务结果里的 `transcription_url` 默认 24 小时有效。它不是第一版普通语音输入的默认路径。
- `qwen3-asr-flash-realtime` 是 WebSocket 实时识别模型，推荐输入 `pcm` 或 `opus`。浏览器 `MediaRecorder` 常见的 `audio/webm` 不能直接假设可用，DashScope 实时链路需要在前端 AudioWorklet 或后端代理里转成 PCM16、16 kHz、单声道。
- `qwen3-asr-flash-realtime` 当前不返回时间戳；需要热词或句级/字级时间戳时使用 `fun-asr-realtime` 或 Paraformer，而不是 Qwen-ASR Realtime。
- 实时 ASR 默认服务端 VAD。对话场景建议把静音断句阈值调短，例如 400ms；需要明确发送时机时改用 Manual/commit 模式。
- 非实时 TTS 非流式响应包含音频 URL，默认 24 小时有效；流式响应通过 SSE 返回 Base64 编码 PCM 片段，最后一个包也包含完整音频 URL。
- 普通 TTS 播报第一版由后端代理输出音频 bytes 或 chunk stream，不把 DashScope 的 24 小时 URL 暴露为前端持久状态。
- Qwen-TTS Realtime 有 `server_commit` 和 `commit` 两种模式。做菜对话逐轮回复优先用 `commit`，长段连续播报再用 `server_commit`。
- 实时 TTS 通过 WebSocket 双向流式协议提供低延迟输出，支持音量、语速、语调、码率和多种音频格式；回调里不能做阻塞业务逻辑，需要写入独立音频缓冲区。
- `qwen3-tts-flash-realtime` 适合作为默认实时播报；`qwen3-tts-instruct-flash-realtime` 只在需要指令控制语速、情绪或风格时启用。
- `cosyvoice-v3.5-plus` 和 `cosyvoice-v3.5-flash` 仅北京地域可用，且仅支持声音设计/声音复刻场景，没有系统音色；第一版不作为默认音色方案。
- Qwen-Omni-Realtime 不进入第一版方案。第一版只使用 ASR/TTS 能力拼接现有 agent loop，不创建 Qwen-Omni-Realtime 会话。
- 百炼北京和新加坡地域 API Key、域名不同。配置里必须显式带 region、workspace id 和 base URL；生产环境建议创建独立业务空间并只授权语音相关模型。

第一版 DashScope 推荐走后端代理，原因：

- 不在浏览器暴露 DashScope API Key。
- 统一做 `family_id`、用户权限、做菜 session 校验。
- 页面动作只来自现有小灶 agent loop，再由 Culina 后端转成前端 `ui_actions`；DashScope 实时语音模型不参与业务工具调用。
- OpenAI 和 DashScope 的音频输入、实时 ASR、TTS 事件格式不同，后端适配后能给前端暴露统一事件。

## 5. 后端设计

### 5.1 新增模块

建议新增：

```text
backend/app/api/ai_audio.py
backend/app/schemas/ai_audio.py
backend/app/services/ai_audio/
  __init__.py
  config.py
  schemas.py
  providers.py
  openai_audio.py
  dashscope_audio.py
  transcription.py
  speech.py
  realtime.py
```

`backend/app/api/ai.py` 已经很大，不继续塞音频路由。新增 `ai_audio.py` 后在 `backend/app/api/router.py` include。

### 5.2 配置项

在 `backend/app/core/config.py` 增加配置：

```text
AI_AUDIO_ENABLED=false

AI_STT_PROVIDER=disabled
AI_STT_API_BASE=
AI_STT_API_KEY=
AI_STT_MODEL=
AI_STT_LANGUAGE_HINT=zh
AI_STT_AUDIO_FORMAT=auto
AI_STT_SAMPLE_RATE=16000
AI_STT_HOTWORDS=
AI_STT_TIMEOUT_SECONDS=45
AI_STT_MAX_UPLOAD_BYTES=10485760
AI_STT_MAX_DURATION_SECONDS=60

AI_TTS_PROVIDER=disabled
AI_TTS_API_BASE=
AI_TTS_API_KEY=
AI_TTS_MODEL=
AI_TTS_VOICE=
AI_TTS_FORMAT=mp3
AI_TTS_SAMPLE_RATE=24000
AI_TTS_LANGUAGE_TYPE=Chinese
AI_TTS_STREAMING=false
AI_TTS_TIMEOUT_SECONDS=45

AI_REALTIME_PROVIDER=disabled
AI_REALTIME_API_BASE=
AI_REALTIME_API_KEY=
AI_REALTIME_MODEL=
AI_REALTIME_VOICE=
AI_REALTIME_AUDIO_FORMAT=pcm
AI_REALTIME_INPUT_SAMPLE_RATE=16000
AI_REALTIME_OUTPUT_SAMPLE_RATE=24000
AI_REALTIME_VAD_SILENCE_MS=400
AI_REALTIME_TIMEOUT_SECONDS=300

DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=
DASHSCOPE_REGION=cn-beijing
DASHSCOPE_HTTP_API_BASE=
DASHSCOPE_WEBSOCKET_API_BASE=
```

这里的 `AI_REALTIME_*` 只表示“实时 ASR/TTS 电话模式”的配置命名，不代表接入 OpenAI Realtime 或 Qwen-Omni-Realtime 这类纯 Speech-to-Speech 会话模型。

兼容策略：

- 如果 provider 是 `openai`，默认复用 `AI_API_KEY` 和 `AI_API_BASE`，但允许通过 `AI_STT_*`、`AI_TTS_*`、`AI_REALTIME_*` 独立覆盖。
- 如果 provider 是 `dashscope`，必须读取 DashScope 专用 key/base/model，避免和文本 LLM provider 混淆。`DASHSCOPE_HTTP_API_BASE` 和 `DASHSCOPE_WEBSOCKET_API_BASE` 可以由 `DASHSCOPE_WORKSPACE_ID` 与 `DASHSCOPE_REGION` 推导，但生产配置要允许显式覆盖。
- `.env.example` 和 `deploy/docker-compose.yml` 必须同步增加这些变量。

### 5.3 Provider 抽象

后端不要让 API 路由直接调用 OpenAI 或 DashScope SDK。抽象为：

```python
class TranscriptionProvider(Protocol):
    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult: ...

class SpeechProvider(Protocol):
    def synthesize(self, request: SpeechRequest) -> SpeechResult: ...

class RealtimeVoiceProvider(Protocol):
    def create_cooking_session(self, request: CookingRealtimeSessionRequest) -> CookingRealtimeSession: ...
```

返回 DTO 建议：

```text
TranscriptionResult:
  text: str
  language: str | None
  duration_seconds: float | None
  provider: str
  model: str
  raw_metadata: dict

SpeechResult:
  content_type: str
  audio_bytes: bytes | None
  audio_stream: Iterator[bytes] | None
  external_url: str | None
  external_url_expires_at: datetime | None
  provider: str
  model: str

CookingRealtimeSession:
  provider: "openai" | "dashscope"
  mode: "agent_backed_websocket"
  session_id: str
  websocket_url: str | None
  expires_at: datetime | None
```

### 5.4 API 设计

#### 5.4.1 语音转文字

```http
POST /api/ai/audio/transcriptions
Content-Type: multipart/form-data

file: audio blob
surface: main_ai | recipe_cook_page
language_hint?: zh | en | auto
provider?: openai | dashscope
```

响应：

```json
{
  "text": "下一步",
  "language": "zh",
  "provider": "dashscope",
  "model": "fun-asr-flash-2026-06-15",
  "duration_seconds": 1.8
}
```

校验：

- 必须登录。
- 文件类型只允许 `audio/webm`、`audio/wav`、`audio/mpeg`、`audio/mp4`、`audio/x-m4a`。
- 默认最大 60 秒或 10 MB。
- 不持久化原始音频。
- 错误时返回可展示的中文错误。

DashScope adapter 细节：

- 普通录音输入优先调用 `fun-asr-flash-2026-06-15` 同步路径；第一版默认非流式返回完整文本，需要流式字幕再单独接实时 ASR。
- 如果 DashScope 当前模型只接受公网音频 URL，后端先把本次录音写入短生命周期临时对象，拿到 URL 后调用 provider，识别完成后删除临时对象或等待 TTL 过期。
- 长音频 `qwen3-asr-flash-filetrans` 只作为后续能力预留，它需要 `X-DashScope-Async: enable` 和任务轮询/回调，不进入第一版普通录音输入。
- 临时对象不能绑定为 `MediaAsset`，不能出现在家庭媒体列表，也不能被 AI 当作用户上传图片/音频资源引用。
- 如果需要使用 `context`、热词或语言参数，统一从 `AI_STT_LANGUAGE_HINT`、`AI_STT_HOTWORDS` 和当前做菜菜谱标题/食材名构造，不允许前端传任意 provider 原始参数。

#### 5.4.2 文本转语音

```http
POST /api/ai/audio/speech
Content-Type: application/json

{
  "surface": "recipe_cook_page",
  "text": "好了，已经切到下一步。",
  "voice": "default",
  "provider": "openai"
}
```

响应：

- 普通模式：返回 `audio/mpeg` 或 `audio/wav`。
- 后续可选：支持 chunked streaming。
- DashScope 非流式返回的 provider URL 只允许后端内部下载或代理，不作为 API 响应 JSON 字段暴露给前端。
- DashScope SSE 流式需要请求头 `X-DashScope-SSE: enable`；返回 Base64 PCM 时，后端需要解码为 bytes 后再输出。如果前端直接播放能力不足，第一版优先返回完整音频 bytes。

校验：

- 第一版只允许 `surface=recipe_cook_page`。
- 文本最长建议 300 字，避免把完整 Markdown、卡片和长解释拿去播报。
- 后端对文本做简短清洗：去掉 Markdown 表格、JSON、内部字段名和过长空白。
- 生产环境必须在 UI 上明确这是 AI 合成语音。

DashScope adapter 细节：

- `qwen3-tts-flash` 是普通播报默认模型；只有需要自然语言指令控制语速、语调、情绪或风格时才切到 `qwen3-tts-instruct-flash`。
- 普通播报优先选择浏览器可直接播放的 `mp3` 或 `wav`。如果 provider 返回 PCM，需要后端封装 WAV 头或转码后再返回。
- provider 返回的音频 URL 默认 24 小时有效，不能进入数据库或前端缓存作为长期资源。
- 记录指标时保留 provider、model、voice、文本长度、首包延迟和总耗时，不记录原始 provider payload。

#### 5.4.3 做菜实时电话会话

统一接口形态：

```http
POST /api/ai/realtime/cooking/session
Content-Type: application/json

{
  "provider": "openai | dashscope",
  "recipe_id": "recipe_xxx",
  "cook_session_id": "recipe_xxx:plan_xxx",
  "session_revision": 123,
  "subject": { ...buildCookingAssistantSubject(...) }
}
```

返回：

```json
{
  "provider": "dashscope",
  "mode": "agent_backed_websocket",
  "session_id": "voice_session_xxx",
  "websocket_url": "/api/ai/realtime/cooking/sessions/voice_session_xxx/ws",
  "expires_at": "2026-07-03T12:30:00Z"
}
```

第一版电话模式链路：

```text
browser audio chunk
  -> Culina realtime voice gateway
  -> ASR / VAD adapter
  -> user_transcript_delta / user_transcript_done
  -> AIApplicationService.stream_chat(
       quick_task="cooking_assistant",
       subject=voice session snapshot,
       persist_history=false
     )
  -> assistant text / result_card
  -> parse result_card into ui_actions event
  -> provider TTS / playback queue
```

这条链路是“实时语音网关 + 现有文本 agent”的组合，不是 Speech-to-Speech。网关只负责音频输入输出、字幕和状态机，不能自行决定业务动作。

服务端必须保存短生命周期 session state：

```text
session_id
family_id
user_id
provider
recipe_id
cook_session_id
session_revision
subject snapshot
created_at
expires_at
status
last_user_transcript
last_ai_run_id
```

第一版可放内存 TTL cache；如果要支持多实例部署，再改成 Redis 或数据库表。

实时代理细节：

- 第一版不创建 OpenAI Realtime / DashScope Qwen-Omni-Realtime 的 Speech-to-Speech 会话。
- OpenAI 路径可以先用 VAD 断句后的 `gpt-4o-mini-transcribe` + `gpt-4o-mini-tts` 实现电话式体验；如果后续接 OpenAI 实时转写，也只作为 ASR adapter，不作为业务主循环。
- DashScope 路径优先使用 `qwen3-asr-flash-realtime` + `qwen3-tts-flash-realtime`。provider 原始事件只在 `dashscope_audio.py` 内部解析。
- Qwen-ASR Realtime 输入统一为 PCM16、16 kHz、单声道或 provider 推荐的 Opus。若浏览器只提供 WebM/Opus 容器，代理层必须先解封装或转码。
- Qwen-ASR Realtime 事件里 `conversation.item.input_audio_transcription.text` 作为字幕增量，`conversation.item.input_audio_transcription.completed` 作为最终用户文本。
- Qwen-TTS Realtime 逐轮对话使用 `commit` 模式；后端发送 `input_text_buffer.append` 后显式 `input_text_buffer.commit`，并把 `response.audio.delta` 转成前端可播放音频块。
- WebSocket 回调线程只负责收包和入队，不做工具执行、数据库访问或音频转码，避免阻塞导致卡顿。

### 5.5 电话模式工具调用

第一版电话模式不把 provider 实时模型 function call 暴露为业务入口。页面动作仍由现有 `cooking_assistant` agent loop 生成：

```text
user_transcript_done
  -> AIApplicationService.stream_chat()
  -> cooking_assistant profile / skill
  -> ui.propose_actions
  -> SSE result_card
  -> voice gateway forwards:
       { type: "ui_actions", card: ... }
  -> frontend parseCookingUiActionsCard()
  -> executeCookingUiActions()
  -> frontend returns execution result to voice gateway
  -> voice gateway optionally asks TTS to speak short follow-up
```

纯 Speech-to-Speech 不属于第一版，因此第一版不新增 provider 实时模型可直接调用的业务 tool schema。页面动作来源仍只有现有 `cooking_assistant` agent loop 产出的 `ui_actions`。


高风险动作：

- `reset_cook_session`
- `delete_timer`
- `finish_cooking`
- `open_shopping_dialog`

这些动作保持前端确认。电话模式下需要语音提示：

```text
“这个会影响当前进度，我先给你弹个确认。”
“完成烹饪会进入确认流程，你确认后系统再处理库存和记录。”
```

### 5.6 权限和数据边界

所有音频 API 都必须使用 `get_current_auth`。

做菜电话 session 必须校验：

- 当前用户属于当前 family。
- `recipe_id` 是当前 family 的菜谱。
- `subject.source` 必须是 `recipe_cook_page`。
- `subject.extra.surface` 必须是 `recipe_cook_page`。
- `subject.extra.recipeTitle/currentStep/ingredients/timers` 只作为当前页面快照，不作为正式写入依据。

不允许：

- 通过电话模式调用主 AI 的任意 Skill。
- 把 write tool 暴露给 provider 语音模型或前端。
- 用语音直接批准 AI approval。
- 用语音直接确认做菜完成并扣库存。

## 6. 前端设计

### 6.1 新增文件

建议新增：

```text
frontend/src/api/aiVoiceApi.ts
frontend/src/hooks/useVoiceRecorder.ts
frontend/src/hooks/useVoiceTranscription.ts
frontend/src/hooks/useVoicePlayback.ts
frontend/src/components/ai/AiVoiceInputButton.tsx
frontend/src/components/recipes/CookingVoiceControls.tsx
frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts
frontend/src/components/recipes/cookingVoiceModel.ts
```

样式放入：

```text
frontend/src/styles/03-recipe-workspace.css
frontend/src/styles/07-mobile.css
```

主 AI 相关小样式如果已有 AI composer 规则足够，优先复用，不新增大段全局样式。

### 6.2 `useVoiceRecorder`

职责：

- 申请麦克风权限。
- 使用 `MediaRecorder` 录制音频。
- 管理状态：`idle`、`requesting_permission`、`recording`、`stopping`、`error`。
- 输出 `{ blob, mimeType, durationMs }`。
- 支持超时自动停止。
- 页面卸载时停止 tracks。

不负责：

- 上传。
- 业务发送。
- TTS 播放。

### 6.3 `useVoiceTranscription`

职责：

- 调用 `aiVoiceApi.transcribeAudio()`。
- 管理 `transcribing`、`error`、`transcript`。
- 将 provider 错误转换为用户可读文案。
- 支持 abort。

主 AI 使用方式：

```text
录音完成
  -> transcribe
  -> onDraftChange(transcript)
  -> textarea focus
```

做菜页使用方式：

```text
录音完成
  -> transcribe
  -> 展示“识别到：xxx”
  -> 默认 1 秒内可取消
  -> assistant.sendMessage(transcript)
```

### 6.4 `useVoicePlayback`

职责：

- 调用 `aiVoiceApi.synthesizeSpeech()`。
- 管理播放队列。
- 支持停止、静音、打断。
- 只播放最后一条需要播报的小灶回复。
- 记录 `lastSpokenMessageId`，避免 live sync 或 rerender 重复播报。

播报规则：

- 只播 assistant 的自然语言文本 part。
- 不播用户消息。
- 不播 progress tool card。
- 不播空文本。
- 不播超过 300 字的长回答，长回答只播摘要或第一句，后续优化再做摘要 TTS。
- 用户开始说话时立即停止当前 TTS。

### 6.5 主 AI UI

改动点：

- `AiWorkspace` 桌面 composer 加麦克风按钮。
- `AiMobilePage` 移动 composer 加麦克风按钮。
- 使用已有 icon button 风格，按钮需要 `aria-label` 和 `title`。
- 录音中按钮显示停止态，转写中显示 loading 态。

状态文案：

```text
录音中...
正在识别...
没听清，可以再说一次
麦克风权限没有打开
```

主 AI 不自动发送。原因：主 AI 可能创建草稿或进入审批，必须让用户看见转写文本后再提交。

### 6.6 做菜页 UI

`CookingAssistantPanel` composer 改为：

```text
[输入框] [麦克风] [发送/停止]
```

头部或 composer 附近增加：

```text
[播报开关] [通话按钮]
```

电话模式 UI：

```text
小灶通话中
  00:23
  正在听 / 小灶在说 / 连接中 / 已静音
  实时字幕区域
  [静音] [挂断]
```

移动端必须考虑：

- 底部安全区。
- 键盘打开时电话条不遮挡输入框。
- 做菜页已经有浮动小灶面板，电话状态条不要再开一个大弹窗压住步骤。
- 触控目标不低于 44px。

### 6.7 电话模式前端事件

统一语音网关事件为：

```ts
type CookingRealtimeVoiceEvent =
  | { type: 'status'; status: 'connecting' | 'listening' | 'speaking' | 'muted' | 'closed' | 'failed'; message?: string }
  | { type: 'user_transcript_delta'; text: string }
  | { type: 'user_transcript_done'; text: string }
  | { type: 'assistant_transcript_delta'; text: string }
  | { type: 'assistant_transcript_done'; text: string }
  | { type: 'ui_actions'; card: AiResultCard }
  | { type: 'tool_result'; message: string; status: 'executed' | 'needs_confirmation' | 'rejected' }
  | { type: 'error'; message: string };
```

`useCookingRealtimeVoiceSession` 只向 `CookingAssistantPanel` 暴露统一状态，不让页面关心 OpenAI/DashScope 原始事件，也不让页面直接处理 provider function call。

## 7. 数据与日志

第一版不新增持久化表。

可以记录的内容：

- 转写后的用户文本，作为已有 AI message 或做菜 session 的小灶消息。
- 小灶回复文本。
- provider/model/duration/latency 的匿名运行指标。

不记录：

- 原始音频 bytes。
- API Key。
- 完整 provider raw payload，除非本地开发环境显式开启并走现有 trace 脱敏策略。
- 用户浏览器麦克风权限状态之外的隐私信息。

如果后续要做语音质量分析，再新增独立 `AIVoiceInteraction` 表，但第一版不需要。

## 8. 安全与失败处理

### 8.1 安全边界

语音只是新的输入输出方式，不改变 AI 权限模型：

```text
主 AI:
  语音 -> 文本输入框 -> 用户点击发送 -> 现有 AI run

做菜小灶:
  语音 -> ASR/VAD -> cooking_assistant profile
  页面动作 -> ui_actions -> 前端校验 -> 可执行或等待确认
```

正式写入仍必须走：

```text
draft -> approval -> commit
```

做菜完成仍必须走做菜页完成确认。

### 8.2 常见失败

| 场景 | 处理 |
| --- | --- |
| 浏览器不支持 MediaRecorder | 隐藏语音按钮或提示当前浏览器不支持 |
| 用户拒绝麦克风权限 | 提示打开浏览器麦克风权限 |
| 转写失败 | 保留输入框内容，提示重试 |
| TTS 失败 | 文本仍正常展示，不阻断 AI 回复 |
| 电话连接失败 | 回退到普通小灶文字/录音模式 |
| 电话模式中 provider 断开 | 展示“通话已断开”，保留小灶面板 |
| 实时工具调用参数非法 | 返回工具错误，让模型短句说明“页面状态刚更新，请再说一遍” |
| sessionRevision 不匹配 | 不执行动作，要求用户再说一遍 |

### 8.3 限制策略

第一版默认：

- 单次录音最长 60 秒。
- 单次转写最大 10 MB。
- TTS 单次最多 300 字。
- 做菜电话 session 最长 10 分钟，超时自动挂断。
- 同一用户同一时间只允许一个做菜电话 session。

## 9. 分阶段实施

### 阶段 0：配置和 Provider 骨架

目标：

- 增加 `ai_audio` 后端模块。
- 增加配置、`.env.example`、deploy env。
- 增加 OpenAI 和 DashScope provider 抽象，但先只接 STT。
- 明确 DashScope 短音频临时 URL 策略和实时音频转码策略。

文件：

- `backend/app/core/config.py`
- `backend/.env.example`
- `deploy/docker-compose.yml`
- `backend/app/api/router.py`
- `backend/app/api/ai_audio.py`
- `backend/app/schemas/ai_audio.py`
- `backend/app/services/ai_audio/*`

测试：

- provider factory 选择正确 provider。
- disabled provider 返回明确错误。
- 配置缺失返回 `AI_AUDIO_*` 相关错误。
- DashScope 短音频 adapter 不返回 provider 临时 URL 给前端。

### 阶段 1：主 AI 语音输入

目标：

- 主 AI 桌面/移动 composer 支持录音转写。
- 转写结果填入输入框，不自动发送。

文件：

- `frontend/src/api/aiVoiceApi.ts`
- `frontend/src/hooks/useVoiceRecorder.ts`
- `frontend/src/hooks/useVoiceTranscription.ts`
- `frontend/src/components/ai/AiVoiceInputButton.tsx`
- `frontend/src/components/ai/AiWorkspace.tsx`
- `frontend/src/components/ai/AiMobilePage.tsx`

测试：

- hook 单测覆盖录音状态机。
- API mock 覆盖转写成功/失败。
- 主 AI composer 转写后只更新 draft，不触发 `streamChatAi`。
- OpenAI WebM 直传和 DashScope 临时 URL/转码分支都能被 mock 覆盖。

### 阶段 2：做菜页语音输入

目标：

- 小灶支持录音转写。
- 转写后可自动发送给 `useCookingAssistantStream.sendMessage()`。
- 转写失败不影响小灶历史。

文件：

- `frontend/src/components/recipes/CookingAssistantPanel.tsx`
- `frontend/src/components/recipes/useCookingAssistantStream.ts`
- `frontend/src/components/recipes/cookingVoiceModel.ts`
- `frontend/src/styles/03-recipe-workspace.css`
- `frontend/src/styles/07-mobile.css`

测试：

- 转写结果会进入小灶消息。
- `persist_history=false` 仍保持。
- 正在发送时禁用录音。

### 阶段 3：做菜页 TTS 播报

目标：

- 小灶 assistant 短回复自动播报。
- 用户可关掉播报。
- 用户再次录音或发送时停止当前播报。

文件：

- `backend/app/api/ai_audio.py`
- `backend/app/services/ai_audio/speech.py`
- `frontend/src/hooks/useVoicePlayback.ts`
- `frontend/src/components/recipes/CookingAssistantPanel.tsx`

测试：

- 不重复播报同一 message。
- 不播工具卡片。
- TTS 错误不影响文本显示。
- DashScope TTS provider URL 过期或下载失败时，前端仍展示文本回复。

### 阶段 4：做菜页电话模式

目标：

- 接入 Agent-backed phone mode。
- 语音网关负责实时 ASR/VAD/字幕/静音/挂断/TTS 播放。
- 每个最终用户语句都回到现有 `cooking_assistant` agent loop。
- 前端执行仍复用 `parseCookingUiActionsCard()` 和 `executeCookingUiActions()`。

文件：

- `backend/app/services/ai_audio/realtime.py`
- `backend/app/services/ai_audio/openai_audio.py`
- `backend/app/services/ai_audio/dashscope_audio.py`
- `frontend/src/components/recipes/useCookingRealtimeVoiceSession.ts`
- `frontend/src/components/recipes/CookingVoiceControls.tsx`
- `frontend/src/components/recipes/CookingAssistantPanel.tsx`

测试：

- 电话 session 创建不暴露 provider API key。
- 语音网关能把最终转写文本提交给 `AIApplicationService.stream_chat()`。
- DashScope ASR/TTS 链路能处理 PCM 音频块、增量字幕和 `response.audio.delta`。
- `cooking_assistant` 产出的 result_card 被转成 `ui_actions`。
- sessionRevision 不匹配时拒绝执行。
- 高风险动作进入确认状态。

## 10. 验证计划

### 10.1 后端

阶段 0 到 3：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_audio -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
```

阶段 4：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_audio -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_cooking_assistant_skill.py -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra/test_orchestrator_profiles.py -q
```

如果新增 provider SDK 或 WebSocket 代理逻辑，需要补 mock provider，不让单测依赖真实 OpenAI 或 DashScope。

### 10.2 前端

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

新增重点测试：

- 主 AI 转写不自动发送。
- 做菜页转写自动发送。
- 播报开关和重复播报保护。
- 电话模式最终转写会调用现有小灶 agent loop。
- 电话模式收到 `ui_actions` 后复用页面动作校验。
- DashScope 普通播报不会把 24 小时 provider URL 存入前端状态。
- 移动端小灶浮层、电话状态条和键盘不重叠。

### 10.3 人工验收

主 AI：

- 点击麦克风，说“帮我看看今晚吃什么”，识别结果进入输入框，不自动发送。
- 修改识别文本后点击发送，现有 AI 流程正常。

做菜页：

- 说“下一步”，页面进入下一步，小灶播报短句。
- 说“帮我计时三分钟”，计时器开始，小灶播报短句。
- 说“完成烹饪”，弹出确认，不直接扣库存。
- 电话模式中说“暂停计时器”，页面执行或提示需要确认。
- 电话模式挂断后，普通小灶仍可继续使用。

## 11. 风险与取舍

### 11.1 为什么主 AI 不先做语音输出

主 AI 回复可能包含 Markdown、表格、草稿卡片、审批请求和多步骤说明。直接播报会出现：

- 播报过长。
- 卡片内容与自然语言重复。
- 审批状态被误解为已经写入。

第一版只做输入，后续如果要做主 AI 播报，需要先定义“可播报摘要”消息 part 或文本摘要规则。

### 11.2 为什么普通语音输入不用实时模型

普通语音输入的关键是准确和可控，不是极低延迟。Pipeline 能复用现有文本 agent 和审批边界，成本更低，行为更可测。

### 11.3 为什么电话模式先限制在做菜页

做菜页动作集合小，已有 `ui_actions` 校验和高风险确认。主 AI 能力面更大，直接电话模式会把误识别、长上下文、审批和正式写入混在一起，第一版风险过高。

### 11.4 为什么第一版不做纯 Speech-to-Speech

纯 Speech-to-Speech 会让实时语音模型成为会话主循环，成本、调试难度和行为不确定性都更高。更关键的是，它会绕开或重写现有 `cooking_assistant` agent loop、Skill、`ui.propose_actions` 和页面动作校验。

第一版先做 Agent-backed phone mode，保留电话式体验，但业务判断仍走现有 agent loop。这样可以先验证用户是否真的会在做菜页持续使用语音，同时成本和安全边界更清晰。

### 11.5 Speech-to-Speech 不进入本文档规划

第一版不规划纯 Speech-to-Speech，也不为它预留必须实现的接口、配置、测试或验收项。文档中保留这个小节，只是为了说明边界：不要在第一版实现时误接 OpenAI Realtime 或 DashScope Qwen-Omni-Realtime。

如果未来单独启动第二版，需要另开一份 Speech-to-Speech 设计文档，而不是在本文档追加第一版 backlog。届时也不能把业务写操作直接交给实时模型；实时模型最多负责自然对话和窄工具调用，后端仍要补齐 `recipeId`、`cookSessionId`、`sessionRevision`，并复用 Culina 的权限、动作校验和高风险确认。

### 11.6 DashScope 临时 URL 和音频格式

DashScope 的非实时 ASR/TTS 有些接口依赖公网 URL，且结果 URL 默认 24 小时有效。第一版把这些 URL 视为 provider 内部传输细节：后端负责临时对象、下载、代理和清理，前端只拿转写文本或可播放音频。

DashScope 实时 ASR/TTS 对音频格式更敏感。OpenAI 可直接接受浏览器 `audio/webm` 的路径不能照搬到 DashScope；实现时必须明确 PCM/Opus、采样率、声道和转码位置，否则电话模式会出现能连接但无法识别或无法播放的问题。

## 12. 参考资料

用户提供的百炼控制台文档：

- https://bailian.console.aliyun.com/cn-beijing?spm=5176.12818093_47.overview_recent.1.19c816d0bd1XTR&tab=doc#/doc/?type=model&url=2938790
- https://bailian.console.aliyun.com/cn-beijing?spm=5176.12818093_47.overview_recent.1.19c816d0bd1XTR&tab=doc#/doc/?type=model&url=2879134
- https://bailian.console.aliyun.com/cn-beijing?spm=5176.12818093_47.overview_recent.1.19c816d0bd1XTR&tab=doc#/doc/?type=model&url=2989727
- https://bailian.console.aliyun.com/cn-beijing?spm=5176.12818093_47.overview_recent.1.19c816d0bd1XTR&tab=doc#/doc/?type=model&url=2979031

本次核对的粘贴文档：

- `/Users/zyf/.codex/attachments/5a368848-f47a-4794-9fd2-98fd058851bb/pasted-text.txt`：实时语音合成。
- `/Users/zyf/.codex/attachments/de8f8fd2-3897-4008-a90f-2d8da6b8bcd6/pasted-text.txt`：非实时语音合成。
- `/Users/zyf/.codex/attachments/d18b6619-0d4c-4ca4-b1dc-6cb784ce9827/pasted-text.txt`：实时语音识别。
- `/Users/zyf/.codex/attachments/d298dc0e-881f-4d4d-b923-184d986b5f1f/pasted-text.txt`：非实时语音识别。

公开文档：

- OpenAI Voice agents: https://developers.openai.com/api/docs/guides/voice-agents
- OpenAI Speech to text: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Text to speech: https://developers.openai.com/api/docs/guides/text-to-speech
- 阿里云百炼非实时语音识别: https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide
- 阿里云百炼语音识别模型: https://help.aliyun.com/zh/model-studio/asr-model/
- 阿里云百炼实时语音合成: https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide
- 阿里云百炼语音合成模型: https://help.aliyun.com/zh/model-studio/tts-model/

仅用于边界判断，非第一版实施依据：

- OpenAI Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- OpenAI Realtime server-side controls: https://developers.openai.com/api/docs/guides/realtime-server-controls
- 阿里云百炼 Function Calling: https://help.aliyun.com/zh/model-studio/qwen-function-calling
- 阿里云百炼 Qwen-Omni-Realtime: https://help.aliyun.com/zh/model-studio/realtime
