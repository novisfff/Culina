# Provider 上游实时流式修复

## 目标与范围

按用户给定方案，将 OpenAI-compatible Chat/Responses 的直连和部署出口代理路径改为真实增量接收。普通 JSON、媒体、WebSocket 接口保持不变；不改前端事件合同，不迁移数据库，不重发已发送但结果未知的调用。

## 设计

- `ProviderTransport.stream_request` 是独立 context manager，返回有状态码、响应头、受限字节迭代器和显式关闭能力的响应；不退回缓冲接口。
- 直连继续使用已授权 IP、原 Host 和 TLS SNI/证书验证；读取使用 `HTTPResponse.read1`，不能等待填满固定大小。代理流式路径使用现有 httpx 底层依赖 `httpcore.HTTPProxy.stream` 及公开 NetworkBackend（显式锁定现有 1.0.9 版本），不读取环境代理、不自动重试或重定向；CONNECT/absolute URL 固定到本次授权 IP。独立 TLS stream wrapper 保留原始目标 SNI/证书验证，HTTPS 代理本身的 TLS 层不受覆盖。
- 响应头预检和实际字节累计均受 `response_max_bytes` 限制。请求 identity 编码，对不遵守的压缩响应失败关闭，避免解压后大小绕过。
- SSE 增量 UTF-8 解码，支持 CR/LF/CRLF、注释、多 data 行、任意网络分块；完整事件立即向上交付。Chat 的 `[DONE]` 和 Responses 的终结事件结束网络读取；无终结标记的断流不能当成功结算。
- 正常、错误、超限、取消和消费者提前关闭均关闭 response/client/socket。连接和等待响应头仍由已有 connect/request timeout 限定。响应体等待使用有界预取（一个 chunk 队列），在调用线程检查取消；读线程只操作网络，不访问 Session 或执行业务。取消中断 socket 并退出读取，浏览器断开不等于 Run 取消。
- Runner 的 dispatch fencing 保留；额外只读取消检查与发送 guard 分开，不能每个 chunk 重做 dispatch/commit。最终 usage 继续走原 ledger；部分输出/EOF/关闭标记 uncertain，不将未知调用再次派发。消费侧显式关闭流，不依赖垃圾回收。Responses 的纯文本 stream_generate 与工具循环共用内部增量生成器，避免 Transport 修好后仍在 provider 层整轮缓冲。

## 验收

真实本地 HTTP 与代理服务使用 Event 闸门，首条 SSE 消费先于尾块放行；覆盖 UTF-8/行/事件分块、尾 usage、终止与截断、大小上限、网络超时、等待中的取消、close、IP 固定与拒绝重定向、发送清单和 usage 契约。保留上一项租约恢复改动及用户前端修改；不调用真实付费 Provider。
