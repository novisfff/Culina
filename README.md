# Culina

Culina 是一个移动优先的家庭菜谱管理工具原型，包含：

- 家庭成员与操作者追踪
- 食物、菜谱、食材、库存、购物清单
- 每日餐食记录与照片上传
- 基于家庭上下文的 AI 助手
- 温暖家庭风格的 Web/PWA 界面
- 真实后端：FastAPI + SQLAlchemy 2 + Alembic + MySQL

## 目录结构

```text
Culina/
  frontend/   # React + Vite 前端
  backend/    # FastAPI + SQLAlchemy + Alembic 后端
  deploy/     # Docker Compose 与部署配置示例
  docs/       # PRD 与项目文档
```

## 前端启动

```bash
npm run frontend:install
npm run dev
```

前端源码和依赖现在都位于 [frontend/](/Users/zyf/IdeaProjects/Culina/frontend)，根目录命令会自动代理到该目录；`node_modules` 和 `dist` 也都只在 `frontend/` 下生成。

默认会连接 `http://127.0.0.1:8010`，如果你想改地址，可在 [frontend/.env](/Users/zyf/IdeaProjects/Culina/frontend/.env) 中配置，示例见 [frontend/.env.example](/Users/zyf/IdeaProjects/Culina/frontend/.env.example)：

```bash
VITE_API_BASE_URL=http://127.0.0.1:8010
```

## 后端初始化与启动

如果远程数据库不可用，先启动本地 Docker MySQL：

```bash
npm run db:up
```

Compose 文件位于 [deploy/docker-compose.yml](/Users/zyf/IdeaProjects/Culina/deploy/docker-compose.yml)。`npm run db:up` 会启动本地 MySQL 和 MinIO；MySQL 监听 `127.0.0.1:3306`，数据库名为 `culina`，默认应用账号为 `culina / culina_local_password`。

如需覆盖端口、库名、密码或 MinIO 配置，可复制 [deploy/.env.example](/Users/zyf/IdeaProjects/Culina/deploy/.env.example) 为 `deploy/.env` 后修改；后端当前默认读取 [backend/.env](/Users/zyf/IdeaProjects/Culina/backend/.env) 中的本地连接配置，示例见 [backend/.env.example](/Users/zyf/IdeaProjects/Culina/backend/.env.example)。

## Docker 部署整套系统

部署配置位于 [deploy/](/Users/zyf/IdeaProjects/Culina/deploy)，包含 MySQL、FastAPI 后端和 nginx 前端。完整部署指南见 [deploy/README.md](/Users/zyf/IdeaProjects/Culina/deploy/README.md)。

第一次启动：

```bash
npm run backend:venv
npm run backend:init-db
npm run backend:migrate
```

启动后端：

```bash
npm run backend:dev
```

后端默认端口是 `8010`，数据库配置写在 [backend/.env](/Users/zyf/IdeaProjects/Culina/backend/.env)。
如果数据库中还没有用户，后端启动时会根据 [backend/.env](/Users/zyf/IdeaProjects/Culina/backend/.env) 中的 `INITIAL_ADMIN_*` 和 `INITIAL_FAMILY_*` 配置自动创建初始家庭和管理员。

## 构建与测试

前端构建：

```bash
npm run build
```

前端测试：

```bash
npm test
```

也可以直接进入 [frontend/](/Users/zyf/IdeaProjects/Culina/frontend) 单独运行 `npm run dev`、`npm run build`、`npm test`。

## 当前实现说明

- 前端已从浏览器 `localStorage` 主状态切换为真实 REST API + React Query
- 后端使用 MySQL 持久化家庭、成员、食材、库存、菜谱、食物、餐食记录、活动流和 AI 对话
- 成员账号由 Owner 创建，当前不开放公开注册
- 图片上传和 AI 生成图片保存到 MinIO，前端通过 nginx 的 `/media/...` 代理访问
- AI 默认走后端降级逻辑；如果补齐 provider 配置，可继续接入真实模型
- PRD 文档见 [docs/prd-v1-family-kitchen.md](/Users/zyf/IdeaProjects/Culina/docs/prd-v1-family-kitchen.md)
