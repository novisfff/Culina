# Culina

Culina 是一个移动优先的家庭饮食管理 Web/PWA，用于管理家庭成员、食物、菜谱、食材库存、购物清单、餐食记录、照片和基于家庭上下文的 AI 助手。

## 功能范围

- 家庭、成员、Owner/Member 权限与操作者追踪
- 食物、菜谱、食材、库存、购物清单和每日餐食记录
- 图片上传、AI 生成图片与 MinIO 媒体存储
- 基于家庭库存、历史记录和菜谱的 AI 推荐、草稿与审批
- 移动优先、温暖家庭化、照片驱动的 Web/PWA 界面

## 技术栈

- 前端：React 18、TypeScript、Vite、React Query、Vitest
- 后端：FastAPI、SQLAlchemy 2、Alembic、Pydantic、pytest
- 数据与媒体：MySQL、MinIO
- 部署：Docker Compose、nginx
- AI：后端 Workspace、Planner、Skill、Tool、草稿审批与可选模型 provider

## 目录结构

```text
Culina/
  frontend/   # React + Vite 前端、PWA 资源、前端测试
  backend/    # FastAPI 后端、数据库模型、迁移、服务、AI runtime、后端测试
  deploy/     # Docker Compose、部署环境变量、nginx 编排
  docs/       # 前端、后端、AI 助手开发规范
  AGENTS.md   # AI 辅助开发工具的项目级指南
```

## 本地开发

### 1. 安装前端依赖

```bash
npm run frontend:install
```

前端依赖安装在 `frontend/node_modules`，构建产物输出到 `frontend/dist`。

### 2. 准备环境变量

```bash
cp frontend/.env.example frontend/.env
cp backend/.env.example backend/.env
```

前端默认连接 `http://127.0.0.1:8010`：

```bash
VITE_API_BASE_URL=http://127.0.0.1:8010
```

后端本地配置在 `backend/.env`。首次本地开发建议至少确认：

- `JWT_SECRET`
- `MYSQL_*`
- `MINIO_*`
- `INITIAL_ADMIN_*`
- `INITIAL_FAMILY_*`
- `AI_PROVIDER`

AI provider 默认可保持 disabled；未配置真实模型时，后端按降级逻辑运行。

### 3. 启动 MySQL 和 MinIO

```bash
npm run db:up
```

该命令使用 `deploy/docker-compose.yml` 启动本地 MySQL 与 MinIO：

- MySQL：`127.0.0.1:3306`
- MinIO API：`127.0.0.1:9000`
- MinIO Console：`http://127.0.0.1:9001`

### 4. 初始化后端

```bash
npm run backend:venv
npm run backend:init-db
npm run backend:migrate
```

后端启动时，如果数据库中没有用户，会根据 `backend/.env` 中的 `INITIAL_ADMIN_*` 和 `INITIAL_FAMILY_*` 创建初始家庭和 Owner 管理员。

### 5. 启动开发服务

后端：

```bash
npm run backend:dev
```

前端：

```bash
npm run dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://127.0.0.1:8010`
- 健康检查：`http://127.0.0.1:8010/api/health`

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动前端开发服务器 |
| `npm run build` | 前端 TypeScript 检查、Vite 构建和 bundle 预算检查 |
| `npm test` | 运行前端 Vitest |
| `npm run preview` | 预览前端构建产物 |
| `npm run db:up` | 启动本地 MySQL 和 MinIO |
| `npm run db:down` | 停止本地 MySQL 和 MinIO |
| `npm run db:logs` | 查看本地 MySQL 和 MinIO 日志 |
| `npm run backend:venv` | 创建后端虚拟环境并安装依赖 |
| `npm run backend:init-db` | 初始化本地 MySQL |
| `npm run backend:migrate` | 执行 Alembic 迁移 |
| `npm run backend:dev` | 启动 FastAPI 开发服务 |
| `npm run backend:test` | 运行后端 pytest |
| `npm run deploy:up` | 使用 Docker Compose 构建并启动完整系统 |
| `npm run deploy:down` | 停止完整部署环境 |
| `npm run deploy:logs` | 查看完整部署环境日志 |

前端子目录可用命令：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

## Docker 部署

部署配置位于 [`deploy/`](deploy/)，完整说明见 [`deploy/README.md`](deploy/README.md)。

首次部署前复制配置：

```bash
cp deploy/.env.example deploy/.env
```

启动完整系统：

```bash
npm run deploy:up
```

默认访问地址：

```text
http://localhost:8080
```

Compose 会启动 MySQL、MinIO、FastAPI 后端和 nginx 前端。nginx 托管前端构建产物，并代理 `/api` 到后端、`/media` 到 MinIO。

## 测试与质量检查

前端：

```bash
npm --prefix frontend run test
npm --prefix frontend run build
```

后端：

```bash
npm run backend:test
```

AI 助手契约相关：

```bash
backend/.venv/bin/python -m pytest backend/tests/test_ai_agent_infra.py -q
npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
```

## 开发规范

项目规范集中在 [`docs/`](docs/)：

- [前端代码规范](docs/frontend-code-standards.md)
- [后端代码规范](docs/backend-code-standards.md)
- [AI 助手规范](docs/ai-assistant-standards.md)

AI 辅助开发工具应先阅读 [`AGENTS.md`](AGENTS.md)，再按对应模块规范修改代码。

## 关键约定

- 所有家庭业务数据必须按 `family_id` 隔离。
- 新增、编辑、删除等用户可见动作需要维护操作者和活动日志。
- 数据库 schema 变更必须新增 Alembic migration。
- React Query key 和缓存失效集中维护在 `frontend/src/api/queryKeys.ts` 与 `frontend/src/api/cacheInvalidation.ts`。
- 图片上传和 AI 生成图片通过后端 media service 与 MinIO 管理。
- AI 正式写入必须经过 `draft -> approval -> commit`，模型不直接执行业务写入。
