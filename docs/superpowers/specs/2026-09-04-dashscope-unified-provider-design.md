# DashScope 统一 Provider 设计

## 目标

将 DashScope 接入收敛为单一 `dashscope` provider。家庭只配置一个 DashScope API Key；HTTP、流式、音频和实时语音调用由服务端根据 capability、模型和请求场景选择官方 DashScope SDK/协议。

## 约束

- 依赖 `dashscope==1.27.3`。
- 删除 `dashscope_http` 与 `dashscope_realtime` 类型，不保留读取兼容别名。
- 官方 HTTP endpoint 与 WebSocket endpoint 由服务端固定；用户不可通过 profile 覆盖。
- 保留现有 dispatch permit、usage settlement、网络白名单、媒体大小限制和 realtime ticket 安全边界。
- DashScope credential 只读取同一个 API Key secret version。

## 架构

`FamilyModelAdapterKind` 增加单一 `dashscope`。adapter registry 为其声明 LLM、多模态、图片生成、STT、TTS、realtime_audio 能力；`FamilyChatProviderFactory` 在解析到该 adapter 时构造 DashScope chat provider。chat provider 将文本请求映射到 `dashscope.Generation`，图片消息映射到 `dashscope.MultiModalConversation`，并将 SDK 响应归一化为既有 `ChatProviderResult`、流式文本和工具调用结构。音频服务继续复用现有计量与权限流程，但底层使用 DashScope SDK 和官方实时 WebSocket URL。

## 配置与网络

- `api_base_url`/`websocket_base_url` 对 `dashscope` 由服务端写入官方默认值并在校验时拒绝非官方 host。
- `auth_mode` 固定为 `api_key`。
- 前端 provider 选项只显示“DashScope”，隐藏实时/非实时两个选项和自定义 endpoint 输入。

## 错误与计量

SDK 异常映射到现有 provider transport/model usage 错误；在 dispatch 后无法确定是否发送时标记 uncertain。成功响应从 SDK usage/request id 提取计量数据；无法提取 usage 时沿用既有 settlement 失败保护。

## 验证

新增/更新测试覆盖：adapter 能力与 endpoint 固定、单 key 校验、chat 文本/图片路由、SDK 响应归一化、音频与 realtime 共用 credential，以及前端类型选项。运行定向 pytest、后端 compileall、前端 typecheck 与相关 Vitest。
