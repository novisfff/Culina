# Culina 部署指南

`deploy/` 目录只放 Docker Compose 编排和部署环境变量示例。各服务自己的镜像文件放在对应服务目录：

- 后端镜像：`../backend/Dockerfile`
- 前端镜像：`../frontend/Dockerfile`
- 前端 nginx 配置：`../frontend/nginx.conf`

## 服务组成

Compose 会启动四类服务：

- `mysql`：MySQL 8.4 数据库
- `minio`：对象存储，保存上传图片和 AI 生成图片
- `backend`：FastAPI 后端服务，启动时自动执行 Alembic 迁移
- `frontend`：nginx 托管 Vite 构建产物，并代理 `/api`（包括实时语音 WebSocket）到后端

## 配置

首次部署前，先复制一份本地配置：

```bash
cp deploy/.env.example deploy/.env
```

本地体验可以直接使用默认值。生产环境请至少修改：

- `ENVIRONMENT`
- `JWT_SECRET`
- `MYSQL_PASSWORD`
- `MYSQL_ROOT_PASSWORD`
- `MINIO_ROOT_PASSWORD`
- `FRONTEND_ORIGIN`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_PASSWORD`
- `INITIAL_ADMIN_DISPLAY_NAME`
- `INITIAL_FAMILY_NAME`

如果浏览器通过前端 nginx 同源访问后端，保持 `VITE_API_BASE_URL` 为空即可。只有后端 API 暴露在独立公网地址时，才需要设置这个变量。

## 启动

在仓库根目录运行：

```bash
npm run deploy:up
```

也可以进入 `deploy/` 目录直接运行：

```bash
docker compose up -d --build
```

启动后访问：

```text
http://localhost:8080
```

如果 `8080` 端口已被占用，可以在 `deploy/.env` 中修改 `FRONTEND_PORT`。

MinIO 控制台默认映射到 `http://localhost:9001`。S3 API 默认映射到 `localhost:9000`，只用于本地后端开发；bucket 保持私有，浏览器图片统一使用后端签发的短时 `/api/media/{media_id}/content` capability URL。nginx 不再把 `/media/...` 直接代理到 MinIO。

实时语音会话通过同源 `/api/ai/realtime/.../ws` 建立 WebSocket。nginx 转发 Upgrade/Connection，并使用 360 秒读写超时覆盖默认 300 秒会话上限。连接认证使用 45 秒单用途 ticket 的 WebSocket 子协议，不把普通 access token 或 ticket 放进 URL。

nginx access log 只记录不含查询字符串的 `$uri`；后端容器同时关闭 Uvicorn access log，避免媒体 capability 被上游重复记录。应用异常日志也只记录 path。

## 查看日志

```bash
npm run deploy:logs
```

或：

```bash
cd deploy
docker compose logs -f
```

## 停止

```bash
npm run deploy:down
```

该命令会停止容器，但保留命名卷。MySQL 数据保存在 `culina_mysql_data`，图片对象保存在 `culina_minio_data`。

## 初始管理员

后端启动时，如果数据库中没有任何用户，会根据 `deploy/.env` 中的 `INITIAL_ADMIN_*` 和 `INITIAL_FAMILY_*` 配置自动创建初始家庭和 Owner 管理员。已有用户时不会覆盖现有数据。

## 迁移旧本地图片

旧版本会把图片写入后端本地目录。切换到 MinIO 后，先确保 MySQL 和 MinIO 已启动，然后在仓库根目录运行：

```bash
npm run backend:migrate-media
```

脚本会读取 `media_assets.file_path` 中仍指向本地文件的记录，把文件上传到 MinIO，并把 `file_path` 更新为 MinIO object key、把 `url` 更新为 `/media/...`。迁移成功后，前端图片访问会统一经过 nginx 的 `/media/...` 代理。


## AI Run 租约版本的首次升级

`c5d6e7f8a9b0` 新增 `ai_run_execution_leases`。首次发布这项变更时：

1. 停止接收新的聊天/恢复请求，尽量让正在执行的业务提交结束。
2. **停止全部旧版后端执行进程**，不要与没有 fence 的旧版本滚动混跑。旧线程可能已经向外部模型发出请求，停止进程不代表请求未计费。
3. 执行 Alembic migration（Compose 后端入口会执行），再启动全部新版本实例。
4. 验证后台 `ai-run-recovery` 扫描正常，关注 `Recovered abandoned AI run` 和 `AI Run recovery scan failed` 日志。回收器不会自动调用模型或重跑业务。

默认 `AI_RUN_LEASE_SECONDS=90`、`AI_RUN_HEARTBEAT_SECONDS=15`、`AI_RUN_RECOVERY_INTERVAL_SECONDS=10`。租约至少覆盖三个心跳周期；心跳和扫描间隔必须为正值。修改时需显式传入后端容器环境。数据库正常且无持续锁冲突时，失联记录通常在最后一次成功心跳后约 90～100 秒收口；未领取记录与恢复 claim 也有宽限期。普通待审批/待输入无需持续心跳。

结果未知会进入 failed 并告知未自动重发、手动重试可能再次计费。待确认项、已提交业务和已有结果卡保留；取消中的孤儿任务会完成取消。不要直接批量重置状态或重放旧 prompt。

回滚同样先停止所有新版本执行进程；旧版本运行时不再提供上述恢复与 fence 保证。不要让新版本进程在租约表被降级删除后继续运行。

真实锁验证需要专用 MySQL 测试库（库名以 `_test` 结尾）：

```bash
cd backend
# CULINA_TEST_MYSQL_URL 通过受控环境注入，不写入仓库。
.venv/bin/python -m pytest -q tests/ai_infra/test_run_execution_mysql.py tests/ai_infra/test_human_input_resume_mysql_concurrency.py
```

这些测试不调用真实模型。内存 SQLite 测试不能证明 InnoDB 锁、跨实例时钟或真实并发行为；共享单连接的 SQLite fixture 不启动后台心跳，以免提交其他 Session 的事务。

## Provider 上游实时流式版本

本项不增加数据库迁移；更新后端依赖并重启后端。`httpcore==1.0.9` 是原 httpx 底层依赖的显式版本约束，流式出口代理通过其公开 NetworkBackend 保留 CONNECT 后的目标域名证书验证。升级 httpcore 时需同时跑 `test_provider_stream_tls.py`。

- 配置 `FAMILY_MODEL_EGRESS_PROXY_URL` 时，代理必须支持指向**已授权 IP:port** 的 CONNECT（HTTPS 目标）和 absolute-form 请求（HTTP 目标）；不能依赖目标域名重新做 DNS。原始域名仍用于 Host/SNI 和证书校验。如果代理 ACL 只接受域名 CONNECT，发布前需调整受控出口规则，不得通过关闭证书校验或恢复未固定 DNS 绕过。
- 上游需支持 identity 编码和标准 SSE 结束标记；非合规压缩响应、超限、截断或非法 SSE 会失败关闭，不自动重发。计费记录保持 uncertain，正常结束且缺少 usage 才沿用 estimated 结算。
- 沿用现有连接/读取超时配置。响应头返回前的取消仍受连接/请求超时约束；进入响应体后，取消轮询在调用线程运行，空闲读取也能主动中断。浏览器断线仍不取消持久 Run。
- 本地回归覆盖直连、HTTP 出口代理和 HTTPS 出口代理的真实 socket/TLS 行为，不能代替实际部署代理/CDN 是否额外缓冲的验收。发布后可用无副作用短提示词检查首字到达时间；未知结果不要自动重试探测。
