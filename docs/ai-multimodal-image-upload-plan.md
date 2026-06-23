# AI 多模态图片上传开发方案

更新时间：2026-06-23

本文档定义 Culina AI 工作台支持用户上传图片后的目标体验、跨端协议、后端执行链路、前端实现拆分和验证计划。图片上传是 AI 对话输入能力，不改变 Culina 现有 AI 安全边界：模型只能读取家庭上下文、理解图片并生成回复、卡片或草稿；正式业务写入仍必须经过 `draft -> approval -> commit`。

## 1. 目标

最终体验对齐常见多模态聊天产品：

- 用户可以在 AI 工作台 composer 中上传、粘贴或拖拽图片。
- 用户可以只发图片，也可以同时发文字和图片。
- 图片在用户消息气泡中以缩略图展示，历史消息可重新查看。
- AI 能结合图片和家庭上下文回答问题，例如识别食材、根据一张菜图生成菜谱草稿、把一顿饭整理成餐食记录草稿。
- 图片识别结果必须表达不确定性，不把模型判断直接写入正式库存、菜谱、购物清单或餐食记录。

## 2. 非目标

第一阶段不做以下能力：

- 不支持音频、视频、PDF 或任意文件附件。
- 不做图片编辑、抠图、OCR 批量导入或相册管理。
- 不允许模型直接写入正式业务表。
- 不把图片永久绑定到模型输出的草稿实体，除非用户在审批或后续流程中明确确认。
- 不把原始图片 bytes、base64 或可访问 URL 写入 run input、SSE、日志或 message metadata。

## 3. 当前实现基线

现有 AI 工作台具备以下能力：

- `AIChatRequest` 当前只有 `message`、`conversation_id`、`client_message_id`、`client_run_id`、`quick_task` 和 `subject`。
- `AIMessage.parts` 已承载 `text`、`result_card`、`draft`、`approval_request`、`human_input_request`、`error_recovery` 和 `run_activity`。
- SSE 已支持 `message_delta` 和 `message_part`，前端通过 `run_id` 合并本地流式消息和远端消息。
- 媒体上传已有 `/api/media/upload`、`MediaAsset`、家庭隔离、内容类型校验和 MinIO 存储。
- `BaseChatProvider` 当前只接收 `system: str` 和 `user: str`，OpenAI-compatible provider 实际构造的是纯文本 `HumanMessage(content=user)`。

因此，多模态支持需要同时扩展：

- AI 请求输入。
- AI 消息 part 合约。
- 媒体归属绑定。
- provider 多模态内容块。
- Orchestrator 用户 payload。
- 前端 composer 和消息渲染。

## 4. 设计原则

1. 图片是一等消息 part，不塞进 `subject.extra` 或 prompt 字符串。
2. 前端只提交 `media_id`，不提交图片 URL、object key 或 base64。
3. 后端按当前 membership 的 `family_id` 校验每个 `media_id`。
4. 图片识别只产生建议、回复、卡片或草稿，正式写入继续走审批。
5. provider 不支持视觉输入时必须明确失败，不能静默忽略图片。
6. 不破坏现有文本对话、SSE、审批恢复和 human input 恢复。
7. 图片缩略预览优先使用 `MediaAsset.variants.thumb` 或 `variants.card`，避免移动端直接加载原图。
8. 所有新增字段必须同步更新后端 schema、前端类型、API client、消息渲染和测试。

## 5. API 合约

### 5.1 发送消息请求

扩展 `AIChatRequest`：

```python
class AIChatAttachmentIn(BaseModel):
    type: Literal["image"] = "image"
    media_id: str = Field(max_length=64)
    client_attachment_id: str | None = Field(default=None, max_length=120)


class AIChatRequest(BaseModel):
    message: str = Field(default="", max_length=2000)
    conversation_id: str | None = Field(default=None, max_length=64)
    client_message_id: str | None = Field(default=None, max_length=120)
    client_run_id: str | None = Field(default=None, max_length=64)
    quick_task: str | None = Field(default=None, max_length=80)
    subject: AISubjectIn | None = None
    attachments: list[AIChatAttachmentIn] = Field(default_factory=list, max_length=6)
```

校验规则：

- `message.strip()` 或 `attachments` 至少有一个存在。
- 第一阶段 `attachments` 只允许 `type="image"`。
- 单次最多 6 张图片。
- 每个 `media_id` 必须存在且属于当前 `family_id`。
- 媒体必须是图片，且来源可以是 `upload` 或后续允许的家庭内 AI 图。

前端类型同步：

```ts
type AiChatAttachment = {
  type: 'image';
  media_id: string;
  client_attachment_id?: string;
};

type AiChatPayload = {
  message: string;
  conversation_id?: string;
  client_message_id?: string;
  client_run_id?: string;
  quick_task?: string;
  subject?: Record<string, unknown>;
  attachments?: AiChatAttachment[];
};
```

### 5.2 消息 part

扩展消息 part 类型：

```python
AIMessagePartType = Literal[
    "text",
    "image",
    "result_card",
    "draft",
    "approval_request",
    "human_input_request",
    "error_recovery",
    "run_activity",
]


class AIMessageImageDTO(BaseModel):
    media_id: str
    asset: MediaAssetOut
    alt: str = ""


class AIMessagePartDTO(BaseModel):
    id: str
    type: AIMessagePartType
    text: str | None = None
    image: AIMessageImageDTO | None = None
    ...
```

前端类型同步：

```ts
export type AiMessagePartType =
  | 'text'
  | 'image'
  | 'result_card'
  | 'draft'
  | 'approval_request'
  | 'human_input_request'
  | 'error_recovery'
  | 'run_activity';

export interface AiMessageImagePartData {
  media_id: string;
  asset: MediaAsset;
  alt: string;
}

export interface AiMessagePart {
  id: string;
  type: AiMessagePartType;
  text?: string | null;
  image?: AiMessageImagePartData | null;
  ...
}
```

用户消息示例：

```json
{
  "role": "user",
  "content": "看看这张图还能做什么",
  "content_type": "parts",
  "parts": [
    {
      "id": "ai_part_text_1",
      "type": "text",
      "text": "看看这张图还能做什么"
    },
    {
      "id": "ai_part_image_1",
      "type": "image",
      "image": {
        "media_id": "photo_123",
        "asset": {
          "id": "photo_123",
          "url": "/media/family_xxx/photo.jpg",
          "variants": {
            "thumb": {
              "url": "/media/family_xxx/variants/photo_123/thumb.webp"
            }
          }
        },
        "alt": "用户上传的图片"
      }
    }
  ]
}
```

### 5.3 兼容策略

- 历史纯文本消息继续保持 `content_type="text"` 或 `parts=[text]`。
- 新发送的含图片消息统一使用 `content_type="parts"`。
- `content` 保留纯文本摘要：
  - 有文字：使用用户文字。
  - 只有图片：`上传了 1 张图片` 或 `上传了 3 张图片`。
- 历史列表标题继续基于 `content` 或 `conversation.prompt`，不读取图片 bytes。

## 6. 媒体与数据归属

### 6.1 上传流程

前端发送 AI 图片消息时按以下顺序：

1. 用户在 composer 选择、粘贴或拖拽图片。
2. 前端调用 `api.uploadMedia(file, 'upload', alt)`。
3. 上传成功后本地附件草稿保存返回的 `MediaAsset`。
4. 发送 AI 消息时只提交 `attachments[].media_id`。

### 6.2 后端绑定

后端创建用户消息后，将图片绑定到 AI 消息：

```python
bind_media_assets(
    db,
    family_id=membership.family_id,
    media_ids=[attachment.media_id for attachment in payload.attachments],
    entity_type="ai_message",
    entity_id=user_message.id,
)
```

绑定规则：

- 如果图片已经绑定到其他业务实体，第一阶段不复用为 AI 附件，避免跨场景所有权模糊。
- 如果需要允许“引用已有食物/菜谱图片提问”，后续应走专门的 `subject` 引用能力，而不是把已绑定媒体重新绑定到 AI 消息。
- 删除会话时，`AIMessage` 会删除；是否删除绑定媒体需单独决策。第一阶段建议保留媒体资产但解除绑定，避免误删用户上传图片。后续可增加媒体清理任务。

### 6.3 缩略图策略

当前 `save_generated_asset` 会生成 variants，普通 `save_upload` 需要补齐 variants：

- 上传成功后生成 `thumb`、`card`、`large`。
- AI 消息缩略图使用 `thumb`。
- 图片查看大图使用 `large`，没有 variants 时降级到原图 URL。

## 7. Provider 多模态输入

### 7.1 内容块抽象

新增 provider 输入抽象：

```python
ProviderTextBlock = dict[str, str]
ProviderImageBlock = dict[str, Any]
ProviderUserContent = str | list[dict[str, Any]]
```

推荐 dataclass：

```python
@dataclass(slots=True)
class ProviderImageInput:
    media_id: str
    content_type: str
    payload: bytes
    filename: str


@dataclass(slots=True)
class ProviderUserInput:
    text: str
    images: list[ProviderImageInput] = field(default_factory=list)
```

`BaseChatProvider` 兼容扩展：

```python
def generate(
    self,
    *,
    system: str,
    user: str | ProviderUserInput,
    response_schema: dict[str, Any] | None = None,
) -> ChatProviderResult:
    ...

def generate_with_tools(
    self,
    *,
    system: str,
    user: str | ProviderUserInput,
    tools: list[ToolDefinition],
    ...
) -> ChatProviderResult:
    ...
```

### 7.2 OpenAI-compatible 转换

当 `user` 包含图片时，将文本和图片转换为 LangChain 多模态 content：

```python
HumanMessage(content=[
    {"type": "text", "text": user.text},
    {
        "type": "image_url",
        "image_url": {
            "url": f"data:{image.content_type};base64,{encoded}"
        },
    },
])
```

注意：

- data URL 只在 provider 调用内存中构造，不持久化。
- provider 日志只记录 `media_id`、`content_type`、图片数量和尺寸，不记录 base64。
- 如果响应 schema 和 tool calling 同时存在，继续沿用现有 final response JSON schema 注入方式。

### 7.3 Capability 校验

配置层增加模型能力判断：

```python
supports_vision: bool
```

可选实现方式：

- 显式环境变量：`AI_SUPPORTS_VISION=true`。
- 或根据模型名默认判断，再允许环境变量覆盖。

带图片请求且 provider 不支持 vision 时：

- 后端返回 400。
- 错误文案：`当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。`
- 前端保留文字和图片草稿，允许用户稍后重试。

## 8. Orchestrator 与 Skill 集成

### 8.1 当前消息上下文

`SkillContext` 增加附件元数据：

```python
current_message_attachments: list[dict[str, Any]]
```

Orchestrator 的 user payload 增加：

```json
{
  "currentMessage": "看看这张图还能做什么",
  "currentAttachments": [
    {
      "type": "image",
      "mediaId": "photo_123",
      "name": "fridge.jpg",
      "alt": "用户上传的图片",
      "source": "current_message"
    }
  ]
}
```

模型实际通过 provider content block 看到图片；payload 中的附件元数据用于让模型在 structured result、工具调用理由和最终回复中引用“这张图片”，而不是引用内部 URL。

### 8.2 Timeline

`build_planner_conversation()` 输出历史消息时增加附件摘要，不包含图片 bytes：

```json
{
  "id": "ai_message_123",
  "role": "user",
  "content": "看看这张图还能做什么",
  "attachments": [
    {
      "type": "image",
      "mediaId": "photo_123",
      "alt": "用户上传的图片"
    }
  ],
  "artifacts": []
}
```

第一阶段只把当前消息图片送入 provider。历史图片只作为摘要进入 timeline，避免每轮都把旧图片重复发给模型导致成本和延迟不可控。后续如果需要“继续看上一张图”，可以通过明确的引用策略选择最近 N 张图片。

### 8.3 Skill 行为规则

所有相关 Skill 的 `SKILL.md` 需要补充图片输入规则：

- `recipe_draft`：可以根据图片生成菜谱草稿，但必须标注图片识别的不确定项；关键食材不确定时用 `human.request_input` 追问。
- `meal_log`：可以根据图片生成餐食记录草稿；餐别、日期、参与人等缺失时追问或使用用户文字。
- `ingredient_profile`：可以根据图片生成食材档案草稿；品类不确定时不得直接给出强断言。
- `inventory_analysis`：可以根据图片回答“这是什么、可能怎么处理”，但不能凭图片直接修改库存。
- `food_profile`：可以根据图片创建或更新食物资料草稿，确认前不写入正式食物。

通用规则：

- 不做医疗、营养诊断式承诺。
- 不把图片识别结果描述为绝对事实。
- 不根据图片猜测家庭成员身份、健康状态或敏感信息。
- 对低置信度识别使用“看起来像 / 可能是 / 需要你确认”。

## 9. 前端实现设计

### 9.1 状态拆分

新增 `useAiAttachmentState.ts`：

```ts
type AiComposerAttachment = {
  clientAttachmentId: string;
  status: 'uploading' | 'ready' | 'failed';
  fileName: string;
  previewUrl: string;
  asset?: MediaAsset;
  errorMessage?: string;
};
```

职责：

- 接收 `File[]`。
- 调用 `api.uploadMedia`。
- 维护上传中、成功、失败状态。
- 支持删除附件。
- 发送成功后清空。
- 发送失败时保留附件草稿。

`AiWorkspace.tsx` 只保留组合逻辑：

- `draft` 文本。
- `attachments` 状态。
- `sendMessage()` 构造本地用户消息和请求 payload。

### 9.2 Composer UI

新增 `AiComposerAttachments.tsx`：

- 展示图片缩略图。
- 上传中显示进度样式或“上传中”状态。
- 失败显示错误和移除按钮。
- 每张图片有删除按钮，按钮需有 `aria-label`。

composer 交互：

- 图片按钮使用图标按钮，触控热区不低于 44px。
- 支持 `accept="image/png,image/jpeg,image/webp,image/bmp"`。
- 支持 paste 图片。
- 桌面支持拖拽到 composer 区域。
- 有附件时允许空文本发送。
- composer 暂停时附件上传入口、删除和发送状态要保持一致。

移动端：

- 预览条放在输入框上方或输入区内上方。
- 缩略图横向滚动，避免压缩输入框。
- 底部安全区沿用 `AiMobilePage` 现有 composer 高度计算。

### 9.3 本地消息

发送前构造本地用户消息：

```ts
const parts: AiMessagePart[] = [
  text ? { id: textPartId, type: 'text', text } : null,
  ...attachments.map((attachment) => ({
    id: `local-part-${attachment.clientAttachmentId}`,
    type: 'image',
    image: {
      media_id: attachment.asset.id,
      asset: attachment.asset,
      alt: attachment.asset.alt || attachment.fileName,
    },
  })),
].filter(Boolean);
```

本地消息 `content`：

- 有文字：`text`。
- 无文字：`上传了 ${attachments.length} 张图片`。

请求 payload：

```ts
{
  message: text,
  attachments: attachments.map((item) => ({
    type: 'image',
    media_id: item.asset.id,
    client_attachment_id: item.clientAttachmentId,
  })),
}
```

### 9.4 消息渲染

新增 `AiMessageImageGrid.tsx`：

- 用户消息内渲染 `part.type === 'image'`。
- 使用 `resolveAssetUrl()`。
- 优先取 `asset.variants.thumb.url`，其次 `asset.variants.card.url`，最后 `asset.url`。
- 图片使用固定 `aspect-ratio`，避免布局跳动。
- 点击图片可第一阶段打开浏览器原图；后续可接入 lightbox。

渲染位置：

- 在 `MessageBubble` 的 timeline 中处理 `image` part。
- 文本和图片按 part 顺序展示。
- 助手消息暂不主动生成 `image` part；AI 生成图片仍走现有 media render 卡片或业务图片流程。

## 10. 后端实现步骤

### 10.1 Schema 和类型

修改：

- `backend/app/schemas/ai.py`
- `frontend/src/api/types.ts`
- `frontend/src/api/aiApi.ts`

新增：

- `AIChatAttachmentIn`
- `AIMessageImageDTO`
- `AiChatAttachment`
- `AiMessageImagePartData`

### 10.2 媒体服务

修改：

- `backend/app/services/media.py`

调整：

- `save_upload()` 为普通上传生成 variants。
- 增加可复用的 `get_media_assets_by_ids(db, family_id, media_ids)` 或使用现有 repo 查询。
- 图片读取给 provider 前做尺寸控制，建议最长边不超过 1536px，并转为 JPEG/WebP 内存 bytes。

### 10.3 Runner 创建用户消息

修改：

- `backend/app/ai/workflows/runner.py`
- `backend/app/ai/workspace_service.py`
- `backend/app/api/ai.py`

调整：

- chat 和 stream chat 参数透传 `attachments`。
- `_prepare_user_message()` 和 `_initialize()` 创建用户消息时构造 text/image parts。
- `AIAgentRun.input` 保存附件元数据，不保存图片数据。
- conversation summary 对纯图片消息使用稳定摘要。

### 10.4 Provider

修改：

- `backend/app/ai/runtime/provider.py`

调整：

- `BaseChatProvider.generate()`、`generate_with_tools()`、`stream_generate()` 接收文本或多模态输入。
- `OpenAICompatibleChatProvider` 将图片转为 `HumanMessage(content=[...])`。
- fallback/blocking tool-call 路径也必须支持同样的 content block。
- `DisabledChatProvider` 带图片时返回明确不可用错误。

### 10.5 Orchestrator

修改：

- `backend/app/ai/workflows/state.py`
- `backend/app/ai/workflows/orchestrator.py`
- `backend/app/ai/workflows/timeline.py`

调整：

- `WorkspaceGraphState` 增加附件元数据。
- `SkillContext` 增加当前附件摘要。
- `_user_payload()` 包含 `currentAttachments`。
- provider 调用传入多模态 user input。

## 11. 数据库与迁移

第一阶段不需要新增表或字段，因为：

- `AIMessage.parts` 是 JSON。
- `AIAgentRun.input` 是 JSON。
- `MediaAsset` 已有 `entity_type` 和 `entity_id`。
- `MediaAsset.variants` 已存在。

如果后续要支持附件级权限、生命周期、引用旧图、多消息复用或精细清理，再考虑新增 `ai_message_attachments` 表。

## 12. 测试计划

### 12.1 后端测试

新增或更新 AI infra 测试：

- 纯文本消息仍可发送。
- 只有图片的消息可发送，`content` 为上传摘要。
- 文本 + 图片消息生成 `text` 和 `image` parts。
- 跨家庭 `media_id` 被拒绝。
- 不存在的 `media_id` 被拒绝。
- provider 不支持 vision 时带图片请求返回明确错误。
- `AIAgentRun.input` 不包含 base64 或原始 URL。
- Orchestrator payload 包含 `currentAttachments`。
- 正式写入仍必须产生 draft 和 approval。

推荐命令：

```bash
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
npm run backend:test
```

### 12.2 前端测试

更新：

- `frontend/src/api/aiApi.test.ts`
- `frontend/src/components/ai/AiWorkspace.test.tsx`
- `frontend/src/lib/aiWorkspaceContracts.test.ts`

覆盖：

- 发送图片时 payload 包含 `attachments`。
- 只有图片时允许提交。
- 图片上传中不能提交未完成附件。
- 上传失败保留草稿。
- 用户消息渲染图片缩略图。
- 本地消息和服务端消息继续按 `client_message_id`、`run_id` 去重。
- composer 暂停时图片入口禁用。

推荐命令：

```bash
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts src/api/aiApi.test.ts src/components/ai/AiWorkspace.test.tsx --testTimeout 10000
npm --prefix frontend run check:size
npm --prefix frontend run build
```

### 12.3 手工验收

至少验证：

- 桌面端选择图片、输入文字、发送。
- 移动端选择图片、只发图片。
- 粘贴图片。
- 上传失败提示。
- 发送后历史会话重新打开，图片仍显示。
- 视觉模型关闭或不支持时错误可理解。
- 图片生成菜谱草稿后仍需要用户确认。

## 13. 分阶段实施

### 阶段 1：后端合约和消息持久化

交付：

- `attachments` 请求字段。
- `image` message part。
- 媒体归属校验和绑定。
- 普通上传 variants。
- 后端 schema 和 serializer 测试。

风险：

- 不能破坏历史消息序列化。
- 不能破坏 AI 会话删除、列表和 pending run。

### 阶段 2：Provider 和 Orchestrator 多模态输入

交付：

- provider content block。
- OpenAI-compatible 图片输入。
- vision capability 校验。
- Orchestrator `currentAttachments`。

风险：

- tool calling + structured response + 多模态必须走同一条 provider 路径。
- blocking fallback 路径不能退回纯文本导致图片丢失。

### 阶段 3：前端 composer 和消息渲染

交付：

- 图片上传按钮、粘贴、拖拽。
- 附件预览条。
- 用户消息图片网格。
- 本地消息和请求 payload 对齐。

风险：

- 不要破坏现有 SSE 本地消息和远端消息合并。
- 移动端 composer 高度和安全区需要重新验证。

### 阶段 4：Skill 文档、体验打磨和验收

交付：

- 相关 Skill 的图片输入规则。
- 图片识别不确定性文案。
- 端到端手工验收。

风险：

- 不能让模型把图片识别当作确定事实。
- 不能绕过草稿审批。

## 14. 待确认决策

实现前需要确认：

1. 单次图片数量上限是否定为 6 张。
2. 普通上传最大 30MB 是否沿用现有 `media_max_upload_bytes`，还是 AI 附件单独限制更小。
3. 第一阶段是否允许引用已绑定到食物、菜谱、食材或餐食记录的图片。
4. 视觉模型能力是否用 `AI_SUPPORTS_VISION` 显式配置。
5. 图片点击是否第一阶段只打开原图，还是同时做轻量 lightbox。

默认建议：

- 单次最多 6 张。
- 上传仍沿用 30MB，但送模型前后端下采样。
- 第一阶段只允许新上传作为 AI 附件。
- 使用 `AI_SUPPORTS_VISION` 显式配置。
- 第一阶段打开原图，后续再做 lightbox。

