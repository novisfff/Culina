# 后端代码优化与重构审查

更新时间：2026-05-28

## 审查范围

本次主要检查 `backend/app` 下的 FastAPI 后端代码，包括：

- API 层：`backend/app/api/*.py`
- 服务层：`backend/app/services/*.py`、`backend/app/ai/*.py`
- 数据模型与 schema：`backend/app/models/domain.py`、`backend/app/schemas/domain.py`
- 配置、认证、数据库依赖：`backend/app/core/*.py`、`backend/app/db/*.py`
- 测试：`backend/tests/*.py`

验证结果：

- 使用系统 Python 直接运行 `pytest -q` 会因为未使用后端虚拟环境而缺少 `langgraph`、`jose` 依赖。
- 使用项目虚拟环境运行 `backend/.venv/bin/python -m pytest -q` 通过：`42 passed, 10 subtests passed`，有 1 个旧 PBKDF2 兼容路径触发的 `passlib` Python 3.13 弃用警告。
- `backend/.venv/bin/python -m compileall -q backend/app backend/tests` 通过。
- `npm --prefix frontend run test` 通过：`62 passed`。
- `npm --prefix frontend run build` 通过；Vite 提示主 chunk 超过 500KB，属于既有前端体积优化项。

## 总体判断

当前后端已经能支撑主要业务流程，测试覆盖了菜谱、库存扣减和 AI agent 的核心路径，说明业务闭环不是临时拼接出来的。

主要问题集中在三个方向：

- 路由层承载了过多业务规则，尤其是菜谱、食物推荐、库存扣减、计划菜单相关逻辑。
- 查询和序列化偏“先全量加载再内存计算”，家庭数据量变大后会出现明显性能瓶颈。
- 配置、媒体上传、认证策略仍偏本地开发模式，上生产前需要补安全边界。

## 优先级 P0：上线前建议先处理

### 1. 配置中存在硬编码数据库密码和 JWT 默认密钥

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/core/config.py:13`
- `backend/app/core/config.py:17`
- `backend/app/core/config.py:18`

问题：

- 默认 MySQL 地址、`root` 用户、明文密码和 JWT secret 都在代码中。
- 即使 `.env` 会覆盖，代码默认值仍容易被误用到测试、预发布或生产环境。

建议：

- 生产敏感项不要给真实默认值。`mysql_password`、`jwt_secret`、AI key 等应从环境变量读取。
- 增加 `environment` 配置，非 `local/test` 环境下如果 secret 仍是默认值则启动失败。
- `.env.example` 保留占位符，不保留真实密码。

落地：

- `Settings` 已新增 `environment` 和安全校验，非本地/测试环境会拒绝空 `MYSQL_PASSWORD` 或空/默认 `JWT_SECRET`。
- 真实数据库地址、`root` 用户和明文密码默认值已移除，`.env.example` 改为占位符。
- 新增 `MEDIA_MAX_UPLOAD_BYTES` 配置，供上传安全限制复用。

### 2. 媒体上传缺少文件大小和真实内容校验

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/services/media.py:45`
- `backend/app/services/media.py:51`
- `backend/app/services/media.py:52`
- `backend/app/services/media.py:15`

问题：

- 只通过 `UploadFile.content_type` 判断类型，客户端可伪造。
- `upload.file.read()` 一次性读入内存，没有大小限制。
- 允许上传 `image/svg+xml`，并通过 `/media` 静态服务暴露；SVG 需要额外做安全处理，否则可能带来脚本或外链风险。

建议：

- 增加最大文件大小限制，例如 5MB 或 10MB。
- 使用图片解码库或文件签名校验真实类型。
- 用户上传默认禁止 SVG，AI 生成 SVG 与用户上传 SVG 分开处理；如必须支持 SVG，先做白名单清洗。
- 写文件前先校验，失败时不要留下半成品文件。

落地：

- 上传入口已限制最大文件大小，默认 30MB，可通过 `MEDIA_MAX_UPLOAD_BYTES` 调整。
- 上传入口已基于 PNG/JPEG/WEBP/BMP 文件签名校验真实内容，并要求与声明的 content type 匹配。
- 用户上传 SVG 已禁用；AI 生成 SVG 仍走后端生成资产保存路径。
- 新增测试覆盖 SVG 拒绝和伪造 content type 拒绝。

### 3. AI 图片生成在请求线程中同步执行

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/api/media.py:75`
- `backend/app/api/media.py:120`
- `backend/app/ai/images/generation.py`
- `backend/app/ai/images/jobs.py`

问题：

- 图片生成和远程下载在 API 请求里同步完成，超时时间最长 120-180 秒。
- 高并发下会占用 Web worker，请求重试也容易造成重复生成。

建议：

- 将图片生成改为异步任务模型：创建任务、返回任务 ID、前端轮询或订阅状态。
- `MediaAsset` 或新增 `image_generation_jobs` 记录 `pending/running/succeeded/failed`。
- 给 provider 调用加统一的超时、重试、熔断和日志上下文。

落地：

- `POST /api/media/ai-render` 已改为返回图片生成任务，避免在创建请求中同步等待远程 provider。
- 新增 `GET /api/media/ai-render/{job_id}` 轮询接口；任务成功后在轮询阶段保存生成的 `MediaAsset`。
- 前端 `aiImages` 工具已改为自动创建任务并轮询，现有图片生成入口无需业务组件逐个改造。
- provider 超时已接入 `AI_TIMEOUT_SECONDS` 配置。
- 轮询保存结果已加一次性 finalization 保护，避免并发轮询重复落库生成资产。
- 新增测试覆盖任务创建、轮询完成、重复轮询不重复落库和生成资产落库。

## 优先级 P1：近期最值得重构

### 1. 拆出菜谱库存可用性与扣减服务

位置：

- `backend/app/api/recipes.py:82`
- `backend/app/api/recipes.py:90`
- `backend/app/api/recipes.py:132`
- `backend/app/api/recipes.py:357`
- `backend/app/api/inventory.py:35`
- `backend/app/api/inventory.py:39`
- `backend/app/api/inventory.py:43`
- `backend/app/api/foods.py:19`

问题：

- 库存剩余量、到期排序、单位换算、可用性摘要等逻辑分散在 `recipes.py` 和 `inventory.py`。
- `foods.py` 直接导入 `app.api.recipes._recipe_availability_summary`，这是跨路由私有函数依赖，说明业务服务边界已经反向渗透到 API 层。

建议：

- 新增 `backend/app/services/inventory_usage.py` 或 `recipe_availability.py`。
- 将 `_remaining_quantity`、`_expiry_sort_key`、`_build_cook_inventory_plan`、`_recipe_availability_summary` 移入服务层。
- API 层只负责参数解析、权限、调用服务和响应序列化。
- 把服务返回值定义为 dataclass 或 Pydantic model，减少 `dict` 的隐式字段约定。

落地：

- 新增 `backend/app/services/inventory_usage.py`，集中提供库存剩余量、过期排序、单位换算、可用库存批量预取、菜谱可用性摘要、做菜扣减计划和单食材消费计划。
- `recipes.py`、`inventory.py`、`foods.py` 已改为调用该服务，不再跨 API 导入菜谱私有函数。
- 做菜预览、实际扣库存和直接消费库存共用同一套扣减顺序与单位换算逻辑，服务返回 dataclass 结果，路由只负责错误映射和响应组装。
- 单位换算异常明确透出为 400，服务内部只对可降级的单位换算异常做兜底，避免吞掉非预期错误。

### 2. `recipes.py` 过大且职责混杂

位置：

- `backend/app/api/recipes.py` 共约 995 行
- `_sync_recipe_food`：`backend/app/api/recipes.py:271`
- 推荐 discovery：`backend/app/api/recipes.py:535`
- 做菜扣库存：`backend/app/api/recipes.py:867`

问题：

- 同一个路由文件同时处理 CRUD、子表替换、媒体同步、食物同步、搜索排序、推荐、统计、做菜扣库存、计划项完成。
- 任何小改动都容易影响多个业务面。

建议拆分：

- `app/services/recipes.py`：菜谱创建/更新/删除与子表替换。
- `app/services/recipe_food_sync.py`：菜谱和自制食物的同步。
- `app/services/recipe_recommendations.py`：discovery、stats、排序评分。
- `app/services/cooking.py`：做菜、预览、库存扣减、生成餐食记录。
- `app/api/recipes.py` 保留薄路由，或按 `recipe_cooking.py`、`recipe_discovery.py` 拆路由。

落地：

- 新增 `backend/app/services/recipe_food_sync.py`，统一菜谱保存、做菜生成餐食、菜谱计划补建 Food 的同步入口。
- 新增 `backend/app/services/recipe_recommendations.py`，承接菜谱列表加载、搜索文本、discovery 推荐、可用性批量 map 和统计聚合。
- 做菜相关库存计划已迁入 `inventory_usage.py`，`recipes.py` 从约 995 行收敛到约 540 行，保留路由、权限、事务提交和响应组装。
- 本次没有继续拆成多个 router 文件，原因是现有测试和前端路由契约稳定，先把高风险业务规则迁到服务层，后续 P2 可再按 cooking/discovery 子路由拆文件。

### 3. 查询策略容易出现 N+1 和全量加载

位置：

- `backend/app/api/recipes.py:392`
- `backend/app/api/recipes.py:498`
- `backend/app/api/recipes.py:507`
- `backend/app/api/recipes.py:581`
- `backend/app/api/foods.py:312`
- `backend/app/repos/media.py:11`

问题：

- `GET /api/recipes` 先加载全家庭菜谱，再在 Python 内存中搜索、筛选、排序、分页。
- 按可用性排序或筛选时，会对每个菜谱调用库存可用性计算；可用性计算又按每个原料查询库存。
- 多个列表接口通过 `get_media_assets_for_family` 加载家庭全部媒体，再构建 media map。

建议：

- 基础筛选、分页、排序尽量下推到 SQL。
- 库存可用性计算先一次性加载家庭库存，并按 `ingredient_id` 建索引。
- 媒体查询增加按实体批量查询接口，例如 `get_media_assets_for_entities(family_id, entity_type, entity_ids)`。
- 推荐接口可以保留内存评分，但输入数据应批量预取，避免每道菜/每个食物再次查询。

落地：

- `backend/app/repos/media.py` 新增 `get_media_assets_for_entities`，列表和详情响应按当前实体 ID 批量加载媒体。
- 菜谱、食物、食材、餐食记录、食物场景接口已改为只查询当前响应需要的媒体，不再为了一个列表加载家庭全部媒体。
- 菜谱列表的难度筛选、时间/更新时间排序、分页已下推到 SQL；搜索、场景筛选和可用性排序仍保留 Python 处理，并在需要时延后分页以保持结果正确。
- 菜谱与食物推荐在计算可用性前会批量预取相关 `ingredient_id` 的可用库存，避免每个菜谱再单独查库存批次。

### 4. Schema 校验还不够靠前

位置：

- `backend/app/schemas/domain.py:182`
- `backend/app/schemas/domain.py:354`
- `backend/app/schemas/domain.py:377`
- `backend/app/api/recipes.py:125`
- `backend/app/api/inventory.py:76`

问题：

- 一些基础约束在路由函数里手写，例如份量、评分、库存数量。
- `CreateRecipeRequest.auto_create_food` 存在于 schema 中，但 `create_recipe` 当前总会同步创建/关联 Food，参数没有被使用。

建议：

- 用 `Field(gt=0)`、`Field(ge=1, le=5)`、`min_length` 等把基础校验放到 Pydantic。
- 对需要业务上下文的校验保留在服务层。
- 明确 `auto_create_food` 是否仍是产品需求；如果要保留，`create_recipe` 应尊重它，否则删除字段，避免误导前端。

落地：

- 库存录入/消费、过期处理、菜谱原料、菜谱创建/更新、做菜份数和评分等基础约束已前移到 Pydantic schema。
- `CreateRecipeRequest.auto_create_food` 已从后端 schema 和前端类型/提交逻辑中移除；当前产品行为明确为“菜谱始终确保存在一个关联的自制 Food”。
- `scene_tags` 作为菜谱正式字段保留在请求、响应、序列化和前端 payload 中，避免 schema 清理时误丢场景筛选能力。
- 原有需要数据库上下文的校验仍留在路由或服务层，例如食材归属、库存单位换算、计划项归属和媒体绑定权限。

### 5. 菜谱和食物同步逻辑存在重复入口

位置：

- `backend/app/api/recipes.py:271`
- `backend/app/api/recipe_meta.py:48`
- `backend/app/api/recipe_meta.py:57`

问题：

- `_sync_recipe_food` 是较完整的同步逻辑，会处理媒体复制、名称、来源等字段。
- `_load_food_for_recipe` 在计划菜单里也会为菜谱创建 Food，但逻辑更简化，且未设置 `created_by/updated_by`，也没有复用媒体同步。

建议：

- 将“确保菜谱存在对应 Food”的能力统一到 `recipe_food_sync` 服务。
- 所有创建菜单计划、做菜、菜谱保存都调用同一个 `ensure_food_for_recipe`。
- 统一决定是否复制菜谱媒体、默认餐别、默认场景和审计字段。

落地：

- `ensure_food_for_recipe` 已统一处理自制 Food 创建、断链修复、名称/来源同步、审计字段和可选媒体复制。
- 菜谱创建、菜谱更新、菜谱计划创建/更新、做菜生成餐食均调用该服务，不再维护两套补建 Food 逻辑。
- 保持既有业务约定：菜谱同步只维护自制 Food 的身份与来源字段，不覆盖用户维护的画像标签；新建自制 Food 默认晚餐、默认场景为“日常”。
- 菜谱媒体复制只在菜谱保存同步 Food 时发生，做菜和计划补建只确保关联 Food 存在，避免在非编辑流程里意外改媒体。

## 优先级 P2：可持续性优化

### 1. 引入更清晰的事务边界

处理状态：已完成（2026-05-28）。

位置：

- API 中多处直接 `db.commit()`，例如 `backend/app/api/recipes.py:750`、`backend/app/api/foods.py:400`、`backend/app/api/recipe_meta.py:389`

问题：

- 当前每个路由自己提交事务，服务逻辑提取后容易出现“服务里提交还是路由里提交”的不一致。

建议：

- 约定 API 层控制 commit/rollback，服务层只修改 session 并返回结果。
- 或引入轻量 Unit of Work 依赖，在请求生命周期统一提交。
- 文档化异常时的事务行为，特别是文件写入、AI 生成和数据库写入之间的一致性。

落地：

- 新增 `backend/app/db/transactions.py`，统一提供 `commit_session(db, on_error=None)`，提交失败时自动 rollback。
- API 层继续作为事务边界，服务层只负责修改 session 和返回结果，不在服务内部提交事务。
- 所有 API 中的裸 `db.commit()` 已替换为 `commit_session(db)`；seed 初始化也使用同一提交 helper。
- 媒体上传和 AI 图片生成落库使用 `on_error` 清理文件，避免数据库提交失败后留下孤立文件。

### 2. 统一时间来源

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/core/utils.py:12`
- `backend/app/api/recipes.py:134`
- `backend/app/api/recipes.py:542`
- `backend/app/api/inventory.py:181`
- `backend/app/api/foods.py:311`

问题：

- 审计字段使用 `utcnow()`，业务日期使用 `date.today()` / `datetime.now()`。
- 当服务部署地区、用户时区、数据库时区不一致时，推荐餐别、过期判断、菜单计划日期可能出现边界偏差。

建议：

- 增加 `app.services.clock` 或 `core.time`，集中提供 `now_utc()`、`today_for_family()`。
- 家庭或用户维度如果未来有时区设置，过期和推荐逻辑应按家庭时区计算。

落地：

- 新增 `backend/app/services/clock.py`，集中提供 `now_utc()`、`now_for_family()`、`today_for_family()`。
- `backend/app/core/utils.py` 的 `utcnow()` 已委托到统一 clock，保持既有调用兼容。
- 库存过期判断、菜谱可用性、做菜默认日期、餐食记录摘要、食物推荐和 AI 推荐中的业务日期已统一使用 `today_for_family()` / `now_for_family()`。
- AI 推荐内部已避免同一次推荐多次计算“今天”，降低午夜边界产生不一致结果的风险。

### 3. 模型和 schema 文件过大

处理状态：已完成 schema 拆分（2026-05-28）。

位置：

- `backend/app/models/domain.py` 约 466 行
- `backend/app/schemas/domain.py` 约 815 行

问题：

- 所有领域模型和所有响应/请求 schema 都集中在单文件，查找和维护成本会继续上升。

建议：

- 按领域拆分：`schemas/ingredients.py`、`schemas/recipes.py`、`schemas/foods.py`、`schemas/media.py`、`schemas/ai.py`。
- 模型也可按领域拆分，但先拆 schema 更稳，因为模型拆分要更关注 SQLAlchemy relationship 和 Alembic 导入。

落地：

- 已按领域拆出 `schemas/media.py`、`schemas/family.py`、`schemas/ingredients.py`、`schemas/inventory.py`、`schemas/shopping.py`、`schemas/recipes.py`、`schemas/foods.py`、`schemas/meal_logs.py`、`schemas/activity.py`、`schemas/ai.py`。
- `schemas/domain.py` 保留为兼容 re-export，避免外部旧导入立即失效。
- 后端 API 和 `schemas/auth.py` 已改为直接从分域 schema 模块导入，不再依赖旧的大型 `schemas.domain`。
- 拆分后统一处理了 `date` 字段名与 `date` 类型名在 Pydantic 延迟注解下的冲突。
- SQLAlchemy 模型文件本次保持不拆；当前优先拆掉更高频变更的 schema，避免跨模块 relationship 映射带来额外迁移风险。

### 4. 清理不可达残留代码

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/api/recipe_meta.py:514`

问题：

- 文件末尾有一行 `FoodPlanItemOut,`，位于 `return` 之后，不影响语法，但明显是编辑残留。

建议：

- 直接删除。
- 后续增加 ruff/flake8，开启 `F841`、`F401`、不可达代码等基础检查。

落地：

- `recipe_meta.py` 文件末尾的不可达残留代码已删除，并通过 `compileall` 验证。

### 5. 密码哈希策略可升级

处理状态：已完成（2026-05-28）。

位置：

- `backend/app/core/security.py:11`

问题：

- 当前使用 `pbkdf2_sha256`。不是不能用，但新项目更常见的是 bcrypt 或 argon2，并配置清晰的参数。
- 测试中已看到 `passlib` 的 `crypt` 弃用警告，未来 Python 3.13 需要关注依赖兼容。

建议：

- 评估切到 `argon2` 或 `bcrypt`。
- 增加密码最小长度、复杂度或弱密码拦截。
- 登录接口后续可加限流或失败次数保护。

落地：

- 新密码已切换为 `bcrypt_sha256$` 策略：先对密码做 SHA-256 预哈希，再使用 bcrypt cost 12 存储。
- 保留旧 `$pbkdf2-sha256$` 哈希验证能力，既有用户密码不会因升级立即失效。
- 新增密码强度校验：至少 8 位，且必须同时包含字母和数字。
- malformed hash 会安全返回验证失败，避免异常数据导致登录接口 500。
- 新增 `backend/tests/test_security.py` 覆盖新策略、弱密码拒绝、旧 PBKDF2 兼容和异常 hash 安全失败。

## 重构路线进度

### 第一阶段：低风险清理（已完成）

- 删除 `recipe_meta.py:514` 的残留代码。
- 去掉敏感配置默认值，并补启动校验。
- 为上传文件加大小限制，先禁用用户上传 SVG。
- 把 `auto_create_food` 的行为定下来：已删除字段，明确菜谱始终同步自制 Food。
- 已用 `python -m compileall` 做基础编译检查；后续仍建议接入 ruff/flake8。

### 第二阶段：抽服务，保持行为不变（已完成）

- 抽 `inventory_usage`，让菜谱、库存、食物推荐共用同一套剩余量和扣减计划。
- 抽 `recipe_food_sync`，统一 `_sync_recipe_food` 和 `_load_food_for_recipe`。
- 抽 `recipe_recommendations`，把 discovery/stats 从路由移出。
- 每次抽取后跑现有测试，必要时先补当前行为测试再移动代码。

### 第三阶段：性能和异步任务（已完成 P0/P1 范围）

- 改造菜谱列表的数据库分页/筛选。
- 库存可用性计算改成批量预取。
- 媒体资源按实体批量查询，不再每次加载全家庭媒体。
- 图片生成改成任务化，前端通过任务状态拿结果。

### 第四阶段：P2 可持续性优化（已完成）

- 统一事务提交入口，API 层控制 commit/rollback，服务层不提交。
- 统一业务时间来源，为后续家庭时区配置预留入口。
- 按领域拆分后端 schema，并保留兼容 re-export。
- 新密码哈希策略升级到 bcrypt-sha256，同时保留旧 PBKDF2 验证。

### 第五阶段：AI 新架构收敛（已完成）

- 删除旧 `backend/app/services/ai.py`，AI query 不再走旧服务入口。
- `backend/app/ai/runtime` 作为通用 AI 运行架构层，只包含 provider 抽象、通用 request/result/tool schema 和 graph 执行器，不依赖库存、菜谱等业务概念。
- `backend/app/ai/kitchen` 作为 Culina 厨房业务层，包含 context、graph、tools、prompts、formatters、fallbacks、recommendations、recipe_drafts 和 service。
- `backend/app/ai/images` 统一管理 AI 生图能力，包含图片 prompt/provider/client 和异步生图 job；媒体资产落盘仍由 `backend/app/services/media.py` 负责。
- AI query 统一由 `backend/app/ai/kitchen/service.py` 组装业务请求，并通过 runtime 执行 graph。
- `kitchen/graph.py` 和 `kitchen/tools.py` 不再反向依赖旧服务层私有函数。
- 推荐模型的数据库写入从 graph 节点移到 kitchen service，graph 节点只产出 agent 状态。

## 建议补充的测试

- 媒体上传：文件大小、伪造 content type、SVG 上传策略、文件写入失败回滚。
- 认证：默认 secret 防护、过期 token、禁用用户、多家庭成员场景。
- 菜谱同步 Food：创建、更新、删除、计划菜单自动补建 Food 的一致性。
- 推荐与可用性：多菜谱、多库存批次、多单位换算下的批量计算结果。
- API 错误路径：无权限、跨家庭资源访问、非法计划状态、无效 media id。
- AI agent：provider 超时/空响应、工具失败降级、推荐写库失败、结构化菜谱生成失败路径。

## 后续推荐任务

1. 接入 ruff/flake8，并把 `compileall`、后端 pytest、前端 test/build 放进 CI。
2. 为登录接口增加限流或失败次数保护。
3. 后续如果模型继续膨胀，再评估拆分 `models/domain.py`，并同步梳理 SQLAlchemy relationship 和迁移导入。
