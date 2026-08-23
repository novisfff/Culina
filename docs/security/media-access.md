# 家庭媒体访问隐私模型

Culina 的家庭图片保存在私有 MinIO bucket 中。对象 key 只用于后端存储定位，不是公开标识，也不由 nginx 直接代理。

## 访问边界

后端在已经通过登录和当前 membership `family_id` 校验的业务响应中，把 `MediaAsset` 序列化为短时 capability URL。客户端也可以通过 `GET /api/media/{media_id}/access` 刷新当前家庭内某个媒体的访问 URL；跨家庭查询统一返回资源不存在。

持久化的 AI 消息、草稿和结果卡只保存媒体 ID 与稳定元数据，不保存 capability URL。读取历史记录时，后端按当前家庭批量重新加载仍存在的 `MediaAsset` 并签发新 URL；已删除或跨家庭的引用不会恢复成可读 URL。媒体响应同时包含明确到期时间，前端在懒加载前或加载失败后最多续签一次，避免把过期凭据当成永久资源。

Capability URL 只授权一个媒体 ID 和一个固定变体（原图、`thumb`、`card` 或 `large`），默认 300 秒后失效。读取时后端校验签名、过期时间、媒体 ID、家庭 ID 和变体，然后重新查询 `MediaAsset`，再从私有 bucket 读取对应对象。签名 URL 不包含 MinIO object key。

## 泄露窗口与撤销

Capability URL 是临时持有者权限：任何获得仍有效 URL 的主体，都可以在剩余有效期内读取该媒体的指定变体，不需要再次携带登录凭据。因此 API 响应、浏览器历史、监控和日志都不得长期保存完整查询字符串。

泄露窗口由短时 TTL 限制。媒体响应使用 `Cache-Control: private, no-store`；删除 `MediaAsset` 行后，后续请求会因重新查询不到该行而失效，对象删除失败也不会恢复公开访问。已经下载到客户端内存或被持有者另行复制的字节无法追回，这是 capability URL 的剩余风险。成员离开家庭后，不能再签发或刷新 URL，但离开前已经获得的 URL 最多仍可在剩余 TTL 内使用。

## 部署要求

- MinIO bucket 不得设置匿名 `s3:GetObject` policy。
- nginx 不得提供 `/media/` 到 MinIO 的直连代理。
- nginx 访问日志只记录 `$uri`，不得记录 `$request` 或 `$request_uri`。
- capability 内容路由的 nginx error log 必须抑制会携带完整请求目标的普通 upstream error；部署 smoke 必须覆盖上游失败并检查 stdout/stderr。
- 后端生产进程关闭 Uvicorn access log，避免在上游日志中记录 capability 查询字符串；请求错误日志只记录 `request.url.path`。
- 默认 TTL 为 300 秒，允许配置范围为 30–900 秒。
