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
- `frontend`：nginx 托管 Vite 构建产物，并代理 `/api` 到后端、`/media` 到 MinIO

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

MinIO 控制台默认映射到 `http://localhost:9001`。S3 API 默认映射到 `localhost:9000`，主要用于本地后端开发；浏览器访问图片统一走前端 nginx 的 `/media/...` 代理。

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
