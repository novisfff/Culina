# Provider Live Streaming Implementation Plan

**Goal:** 消除上游整包缓冲，同时保持安全边界、资源清理和计费确定性。
**Architecture:** 独立受限流式 Transport → 增量 SSE → 既有 provider/Runner。网络读取与调用线程取消检查隔离，业务和计费仍在原调用线程执行。
**Tech Stack:** Python、http.client、httpx/httpcore、pytest；将已安装的 httpcore 1.0.9 从间接依赖显式锁定，无新库。
**Spec:** `docs/superpowers/specs/2026-09-20-provider-live-stream-design.md`

## 约束

原地执行，不新建 worktree/分支/子代理/提交。保留已有未提交修改。普通请求不改成 generator；不得发送未经重新授权的 URL，或自动重发结果不确定的付费调用。

## 步骤

- [x] 1. 新增 `tests/family_model_settings/test_provider_streaming.py`：真实 HTTP/代理 Event 闸门，使用当前 DeferredBindingTransport 复现首事件被尾块阻塞，确认红灯。
- [x] 2. 在 `services/family_model_settings/streaming.py` 定义受限 `ProviderStreamResponse`；在 `transport.py` 增加两种 dialer 和门面的 `stream_request`，复用 authorize/safe_headers，验证流式首包、安全/大小/清理边界。
- [x] 3. 在 `ai/runtime/family_transport.py` 用增量 SSE 替换整包解析；真实 stream 生命周期从首消费到 close，HTTP 状态错误不读取敏感 body，更新测试 transport double。
- [x] 4. 对 Chat/Responses 消费者增加显式 close 和 uncertain 收口；接入 Runner 只读 cancellation guard，保留发送 fence；覆盖中断和最终 usage。
- [x] 5. 同步 `model_usage/provider_registry.py` 的新发送点；更新 AI 规范，跑 family_model_settings、provider/runtime、usage、Run lease 定向回归与 compileall/diff 检查。

## 验证记录

### 红灯与定向验证

- 改造前 `pytest -q tests/family_model_settings/test_provider_streaming.py --tb=short`：4 条首事件测试全部失败，直连/代理、Content-Length/chunked 都阻塞在未放行的尾块；改造后通过。
- 明确复现并修复：回调取消后未 close、生成器 close 未标 uncertain、Responses 文本入口整轮缓冲、保留字节迭代器时读线程未回收、SSE error 被忽略、httpcore 代理 IPv6 CONNECT 缺少方括号。回归断言保留。
- `pytest -q tests/family_model_settings/test_provider_stream_tls.py tests/family_model_settings/test_provider_streaming.py --tb=short`：**33 passed**，包括 IPv4/IPv6、原始 SNI/Host、HTTP/HTTPS 代理和错误域名证书拒绝。
- `pytest -q tests/ai_infra/test_workspace_streaming.py tests/ai_infra/test_family_llm_streaming.py tests/ai_runtime/test_family_stream_events.py tests/family_model_settings/test_provider_streaming.py tests/family_model_settings/test_provider_stream_tls.py tests/model_usage/test_llm_provider_contract.py tests/model_usage/test_provider_send_inventory.py --tb=short`：IPv6 扩展前 **131 passed**。

### 扩大回归发现的非 Transport 问题

1. 未覆盖环境的首次分类回归：**1966 passed / 53 skipped / 1 failed / 264 subtests passed**。既有 `test_credentials` 的 production Settings fixture 缺少安全的 access-token TTL 和初始管理员密码；不修改生产校验，后续命令显式使用仅测试的环境值。
2. 第二次分类回归：**1971 passed / 53 skipped / 1 failed / 264 subtests passed**。既有断线后历史清除测试的轮询 Session 与 worker 共用 SQLite StaticPool 单连接，读到了 flush 中间状态；独立 Session 关闭也可能 rollback worker。只将该测试轮询纳入已有 `_SQLITE_CHECKPOINT_LOCK`，保持全部隐私清理断言，不改生产事务或删除逻辑。

### 最终命令

在 `backend/` 下执行（密码值是合成测试配置，不是部署凭据）：

```bash
ACCESS_TOKEN_EXPIRE_MINUTES=30 INITIAL_ADMIN_PASSWORD=synthetic-stream-regression-only \
  .venv/bin/python -m pytest -q tests/family_model_settings tests/ai_infra tests/ai_runtime tests/model_usage --tb=short -ra
.venv/bin/python -m compileall -q app
PYTHONPATH=. .venv/bin/python scripts/check_model_usage_adapter_coverage.py
```

仓库根目录：`git diff --check`。

最终分类回归：**1976 passed、53 skipped、264 subtests passed**（128.81 秒）。跳过项为 51 个未配置 `CULINA_TEST_MYSQL_URL` 的 MySQL 集成用例，以及 2 个只允许在指定参考主机执行的绝对延迟测试。68 条 warning 为既有 Starlette 弃用/JWT 测试密钥长度警告。

`compileall`、发送点审计（`status=covered`，无缺失/陈旧发送点）及 `git diff --check` 全部通过。最终日志：`/tmp/culina-live-stream-gates-verified.log`；发送点报告：`/tmp/culina-live-stream-send-inventory.json`。

### 环境与发布边界

未调用真实付费 Provider、生产代理或生产数据库；未部署、提交或执行 migration；本项不新增 migration。不改前端，保留用户已有前端和前一项 Run 租约改动。连接/响应头等待的取消仍受已有网络超时限制；响应体取消可主动 shutdown。出口代理需接受 IP:port CONNECT；标准 SSE 终结标记、identity 编码、代理兼容性要求见 `deploy/README.md`。
