# Culina 混合检索层设计方案

更新时间：2026-06-27

本文档定义 Culina 食材、食物和菜谱检索能力的落地方案。目标是用混合检索直接替换当前关键词检索，并把搜索结果按家庭饮食场景进行业务重排。

## 1. 背景与目标

当前检索主要依赖 `q` 参数和关键词匹配：

- 食材：`/api/ingredients` 使用 `Ingredient.name`、`Ingredient.category` 的 `ilike`。
- 食物：`/api/foods` 使用 `Food.name`、`Food.category` 的 `ilike`。
- 菜谱：`/api/recipes` 将标题、tips、食材和步骤拼接后做包含匹配。

这能解决“番茄”“牛奶”“鸡胸肉”这类字面检索，但对以下需求不足：

- “清淡晚饭”“小朋友能吃”“快手下饭菜”这类意图检索。
- “西红柿”和“番茄”、“土豆”和“马铃薯”这类同义表达。
- 备注、步骤、tips 中表达的语义被用户用不同说法查询。
- AI tool 需要稳定地从家庭数据中找到候选食材、食物和菜谱。

本方案的目标：

1. 支持关键词检索、语意检索和混合检索。
2. 所有检索结果必须按 `family_id` 隔离。
3. MySQL 继续作为业务真源和关键词检索层。
4. Qdrant 作为向量索引层，只存索引，不承载业务真源。
5. 后端 search service 负责召回合并、业务重排和降级。
6. 搜索入口默认使用混合检索，关键词检索只作为调试和降级能力保留。

## 2. 总体架构

```text
业务表
  Ingredient / Food / Recipe
        |
        | 构建检索文档
        v
MySQL search_documents
  - 检索文本
  - 关键词索引
  - 内容 hash
  - 向量索引状态
        |
        | 后台 embedding 索引任务
        v
Qdrant culina_search
  - embedding vector
  - family_id / entity_type / entity_id payload

查询请求
  -> MySQL 关键词召回
  -> Qdrant 语意召回
  -> 后端合并去重
  -> 加载业务实体
  -> 业务重排
  -> 返回稳定 API 响应
```

职责边界：

- MySQL：业务数据、事务、权限、关键词检索、检索文档元数据。
- Qdrant：向量相似度召回和 payload filter。
- 后端 search service：检索文本构建、embedding 调用、索引同步、混合排序、`match_reason` 规则生成和降级策略。
- 前端和 AI tools：只调用后端 API，不直接访问 Qdrant。

## 3. 数据模型

### 3.1 MySQL: `search_documents`

新增表 `search_documents`：

```text
id                  varchar(64) primary key
family_id           varchar(64) not null
entity_type         varchar(32) not null
entity_id           varchar(64) not null
title_text          varchar(255) not null default ''
keyword_text        text not null
detail_text         mediumtext not null
semantic_text       mediumtext not null
metadata_json       json not null
content_hash        char(64) not null
document_builder_version varchar(32) not null
embedding_model     varchar(120) not null default ''
embedding_dimensions int not null default 0
vector_status       varchar(32) not null default 'pending'
vector_error        text null
vector_attempt_count int not null default 0
last_vector_attempt_at datetime null
indexed_at          datetime null
created_at          datetime not null
updated_at          datetime not null
```

约束和索引：

```text
unique key uq_search_documents_entity (family_id, entity_type, entity_id)
index ix_search_documents_family_scope (family_id, entity_type, updated_at)
index ix_search_documents_vector_status (vector_status, last_vector_attempt_at, updated_at)
fulltext key ft_search_documents_title (title_text) with parser ngram
fulltext key ft_search_documents_keyword (keyword_text) with parser ngram
fulltext key ft_search_documents_detail (detail_text) with parser ngram
```

说明：

- `semantic_text` 用于生成 embedding，不直接作为高权重关键词字段。
- `metadata_json` 只放检索和重排需要的轻量元数据，不复制完整业务对象。
- `document_builder_version` 标识检索文档构建规则，规则变化时必须触发重建。
- `content_hash` 由 `entity_type + entity_id + semantic_text + metadata_json + embedding_model + embedding_dimensions + document_builder_version` 计算。
- `embedding_dimensions` 必须与 Qdrant collection vector size 一致。
- `vector_status` 取值建议为 `pending | indexed | stale | failed | disabled`。
- `vector_attempt_count` 和 `last_vector_attempt_at` 用于 worker 重试退避和排查失败任务。
- Qdrant 丢失时可通过 `search_documents` 重建向量索引。

`vector_status` 状态语义：

```text
pending   新建或首次需要生成向量
stale     业务内容、embedding 配置或 document builder 变化后需要重新生成向量
indexed   当前 MySQL 检索文档已经成功写入 Qdrant
failed    最近一次 embedding 或 Qdrant 写入失败，可重试
disabled  当前环境关闭向量索引，只参与关键词检索
```

状态流转规则：

- `pending | stale | failed -> indexed`：embedding 生成成功且 Qdrant upsert 成功。
- `pending | stale | failed -> failed`：embedding provider 或 Qdrant 异常。
- `indexed -> stale`：`content_hash`、`embedding_model`、`embedding_dimensions` 或 `document_builder_version` 变化。
- `pending | stale | failed | indexed -> disabled`：部署配置显式关闭向量索引。
- `disabled -> pending`：重新启用向量索引后，由重建脚本或 worker 标记待索引。

`indexed` 只能表示索引写入成功，不表示业务实体仍可直接返回。任何搜索结果返回前仍必须回 MySQL 业务表二次加载和校验。

### 3.2 Qdrant: `culina_search`

查询使用的 collection alias：

```text
culina_search
```

Qdrant 原生 point id 使用由业务 key 稳定映射出来的 UUID：

```text
uuid5("culina-search:{entity_type}:{entity_id}")
```

业务 point id 仍使用 `{entity_type}:{entity_id}`，但保存在 payload 的 `_culina_point_id` 字段中，供 scroll cleanup 和删除路径按业务 key 处理。这样可以兼容 Qdrant 对 point id 只能使用 unsigned integer 或 UUID 的限制，同时保持业务层不依赖 Qdrant 内部 id。

payload：

```json
{
  "_culina_point_id": "recipe:recipe_xxx",
  "family_id": "family_xxx",
  "entity_type": "recipe",
  "entity_id": "recipe_xxx",
  "embedding_model": "embedding-model-name",
  "content_hash": "sha256...",
  "document_builder_version": "v1",
  "embedding_dimensions": 1024,
  "updated_at": "2026-06-27T10:00:00Z"
}
```

向量配置：

- distance：`Cosine`
- vector size：由 `SEARCH_EMBEDDING_DIMENSIONS` 决定，启动或迁移时显式配置。
- payload index：为 `family_id`、`entity_type` 建 payload index，保证过滤稳定。

Qdrant 不保存菜名、备注、步骤、家庭业务数据正文。需要展示结果时必须回 MySQL 加载业务实体，并用业务表的 `family_id` 做二次校验。

模型、维度或 document builder 变化时不要原地复用旧 collection。生产环境推荐使用版本化 collection 和 alias：

```text
collection: culina_search_v1
alias: culina_search
```

重建完成并校验后，将 alias 从旧 collection 切到新 collection。切换失败时保留旧 collection 继续提供服务。第一版实现可以先把 `QDRANT_COLLECTION=culina_search` 当作普通 collection 使用；等需要无停机重建时，再补 alias 创建、切换和回滚脚本。

## 4. Embedding 模型与上下文

### 4.1 模型配置

第一版不在方案中绑定具体 embedding 模型。实现只定义可配置的 provider、模型名和向量维度，由部署环境选择实际模型。

选型要求：

- 支持中文语义相似度，能覆盖食材、食物、菜谱和家庭饮食场景。
- query embedding 和 document embedding 必须使用同一个模型和维度。
- 模型、维度、归一化规则变化时，必须触发全量重建 Qdrant collection 或新建 collection 切换。
- 向量维度必须与 Qdrant collection 配置一致。
- 成本、延迟和可用性由部署环境评估，不写死在业务代码中。

配置必须独立于聊天模型：

```text
SEARCH_EMBEDDING_PROVIDER=
SEARCH_EMBEDDING_API_BASE=
SEARCH_EMBEDDING_API_KEY=
SEARCH_EMBEDDING_MODEL=
SEARCH_EMBEDDING_DIMENSIONS=
SEARCH_EMBEDDING_TIMEOUT_SECONDS=30
```

provider 类型可以按部署需要实现，例如：

- `openai`：接入 OpenAI embedding API。
- `dashscope`：接入阿里云通义 embedding 模型。
- `local`：接入本地 embedding 服务。
- `disabled`：关闭语意索引，搜索自动降级关键词检索。

embedding provider 必须通过统一接口暴露：

```text
EmbeddingClient.embed_text(text: str) -> list[float]
EmbeddingClient.embed_batch(texts: list[str]) -> list[list[float]]
```

禁止在业务路由、AI tool 或 Qdrant store 中直接调用具体厂商 SDK。

### 4.2 生成 embedding 的上下文

embedding 输入只使用 `semantic_text`。`semantic_text` 是为检索构造的语义摘要，不是业务对象的完整 JSON，也不是前端展示文本。

构建原则：

- 只包含帮助检索的字段：名称、分类、标签、餐别、食材、步骤摘要、tips、备注等。
- 不包含 `family_id`、`created_by`、`updated_by`、媒体 URL、MinIO object key、token、权限字段、活动日志正文。
- 不包含完整库存批次明细，例如每一批购买日期、剩余量、过期日期；这类动态业务信号用于重排，不进入 embedding。
- 不包含完整 meal log 历史；最近吃没吃、常不常吃用于业务分，不进入 embedding。
- 菜谱步骤可以进入 `semantic_text`，但要按“标题/摘要/关键点/正文截断”的顺序控制长度。
- 用户自由备注可以进入 `semantic_text`，但只保存在 MySQL `search_documents` 中；Qdrant payload 不保存正文。

上下文按实体类型构建：

- 食材 embedding 上下文：名称、分类、默认单位、默认储存方式、保质期规则、食材备注。
- 食物 embedding 上下文：名称、类型、分类、口味标签、场景标签、适合餐别、来源、日常说明、备注。
- 菜谱 embedding 上下文：标题、场景标签、难度、耗时、份量、食材清单、步骤摘要、关键点、tips。

查询 embedding 上下文只使用用户查询本身，不拼接家庭数据：

```text
用户查询：{q}
```

不要把当前家庭库存、最近餐食或用户画像拼进 query embedding。家庭上下文应通过 Qdrant `family_id` filter 和后端业务重排体现，避免同一个查询因为上下文拼接导致向量空间不稳定。

### 4.3 长度控制和版本化

`semantic_text` 需要稳定、可重复生成：

- 字段顺序固定。
- 空字段跳过。
- 列表字段去重后按原业务顺序或稳定排序输出。
- 多余空白归一化。
- 单个实体 embedding 输入建议控制在 2,000 到 4,000 中文字符以内。

建议截断策略：

```text
名称/标题：不截断
分类/标签/餐别：不截断
食材清单：保留全部食材名，数量和备注过长时截断
步骤：优先保留 title、summary、key_points，再追加 text 的前若干字符
备注/tips：保留前 300 到 500 字
```

`content_hash` 必须覆盖：

```text
entity_type
entity_id
embedding_model
embedding_dimensions
semantic_text
metadata_json
document_builder_version
```

当模型、维度或 document builder 规则变化时，必须 bump `document_builder_version` 或更新 embedding 配置，触发重建索引。

`semantic_text` 由 SearchDocument builder 从业务实体生成，不从 `title_text + keyword_text + detail_text` 二次拼接生成。关键词字段可以为了倒排索引保留重复词、同义词或低权重正文，`semantic_text` 必须保持自然、去重和稳定。

## 5. 检索文档构建

统一在 `backend/app/services/search/` 下实现 document builder，不在路由中拼接搜索文本。

建议目录：

```text
backend/app/services/search/
  __init__.py
  documents.py
  embeddings.py
  indexing.py
  keyword_store.py
  vector_store.py
  vector_indexing.py
  hybrid.py
  scoring.py
```

第一版可以先把关键词、语意合并和基础 `match_reason` 放在 `hybrid.py` 中；当业务重排信号增加后，再把业务分和 reason candidates 下沉到 `scoring.py`，避免 `hybrid.py` 继续膨胀。

### 5.1 食材文档

来源：`Ingredient`

```text
title_text:
  name

keyword_text:
  name
  category
  default_unit
  default_storage
  default_expiry_mode

detail_text:
  notes
  unit conversion labels
  low stock threshold description

semantic_text:
  食材：{name}
  分类：{category}
  默认单位：{default_unit}
  储存方式：{default_storage}
  保质期规则：{default_expiry_mode/default_expiry_days}
  备注：{notes}
```

metadata 示例：

```json
{
  "name": "番茄",
  "category": "蔬菜",
  "default_unit": "个",
  "default_storage": "冷藏",
  "quantity_tracking_mode": "track_quantity"
}
```

### 5.2 食物文档

来源：`Food`

```text
title_text:
  name

keyword_text:
  name
  type
  category
  flavor_tags
  scene_tags
  suitable_meal_types
  source_name
  purchase_source
  scene

detail_text:
  notes
  routine_note

semantic_text:
  食物：{name}
  类型：{type}
  分类：{category}
  口味：{flavor_tags}
  场景：{scene_tags/scene}
  适合餐别：{suitable_meal_types}
  来源：{source_name/purchase_source}
  日常说明：{routine_note}
  备注：{notes}
```

metadata 示例：

```json
{
  "name": "酸奶",
  "type": "ready_made",
  "category": "乳制品",
  "flavor_tags": ["清爽"],
  "scene_tags": ["早餐", "加餐"],
  "suitable_meal_types": ["breakfast", "snack"],
  "favorite": true,
  "rating": 4,
  "repurchase": true
}
```

### 5.3 菜谱文档

来源：`Recipe`、`RecipeIngredient`、`RecipeStep`

```text
title_text:
  title

keyword_text:
  title
  scene_tags
  difficulty
  ingredient_names
  step titles
  step summaries
  key points

detail_text:
  tips
  ingredient notes
  step text
  step tips

semantic_text:
  菜谱：{title}
  场景：{scene_tags}
  难度：{difficulty}
  耗时：{prep_minutes} 分钟
  份量：{servings} 人份
  食材：{ingredient_name + quantity + unit + note}
  步骤：{step title + summary + text + key_points + tip}
  小贴士：{tips}
```

metadata 示例：

```json
{
  "title": "番茄鸡蛋汤",
  "difficulty": "easy",
  "prep_minutes": 15,
  "scene_tags": ["晚餐", "清淡"],
  "ingredient_names": ["番茄", "鸡蛋", "葱"]
}
```

## 6. 查询 API

### 6.1 列表 API 替换为混合检索

现有食材、食物、菜谱列表接口的 `q` 参数直接改为混合检索：

```http
GET /api/ingredients?q=番茄&limit=20&offset=0
GET /api/foods?q=清淡晚饭&limit=20&offset=0
GET /api/recipes?q=快手下饭菜&limit=20&offset=0
```

实现要求：

- 有 `q` 时默认执行关键词召回 + 语意召回 + 业务重排。
- 无 `q` 时保持各列表原有排序、筛选和分页语义。
- `search_mode` 不作为公开产品参数暴露；后端内部和测试可保留 `keyword | semantic | hybrid` 模式用于调试和降级。
- Qdrant 或 embedding 不可用时，接口自动降级关键词召回。
- 列表 API 为保持原响应形状，不额外返回 `search_mode` 或 `degraded`；降级信息记录在服务日志、指标或 trace 中。
- 统一 `/api/search` 可以返回 `search_mode` 和 `degraded`，用于全局搜索、调试和 AI tool trace。

### 6.2 新增统一搜索 API

新增：

```http
GET /api/search?q=清淡晚饭&scopes=recipes,foods,ingredients&limit=20&offset=0
```

响应建议：

```json
{
  "items": [
    {
      "entity_type": "recipe",
      "entity_id": "recipe_xxx",
      "score": 0.86,
      "keyword_score": 0.42,
      "semantic_score": 0.91,
      "business_score": 0.25,
      "match_reason": ["语意接近清淡晚饭", "家里可做", "15 分钟内"],
      "entity": {}
    }
  ],
  "total": 20,
  "query": "清淡晚饭",
  "search_mode": "hybrid",
  "degraded": false
}
```

统一搜索主要服务：

- 全局搜索框。
- AI tool 候选检索。
- 未来公共菜谱库和家庭库混合检索。

## 7. 混合检索流程

### 7.1 关键词召回

MySQL 关键词召回返回 top N，例如 80 条：

```text
keyword_score =
  title_match_score * 0.55 +
  keyword_match_score * 0.35 +
  detail_match_score * 0.10
```

加权规则：

- 名称、标题精确相等：强加分。
- 名称、标题前缀匹配：较强加分。
- 分类、标签、食材名命中：中等加分。
- 备注、步骤正文命中：低加分。

MySQL `FULLTEXT` 不可用时，第一版允许降级为 `LIKE`，但 search service 接口不变。

MySQL 关键词检索实现要求：

- 中文 `FULLTEXT` 使用 `ngram parser`。
- 部署环境需要确认 `ngram_token_size`，建议以 2 为默认值评估中文短词效果。
- 关键词查询要先做归一化：trim、合并空白、全半角基础归一、大小写归一。
- 关键词字段权重必须在后端 search service 内固定，不允许路由或 AI tool 各自实现一套权重。
- 查询为空时不进入检索链路，保持原列表排序。
- 如果本地或测试环境没有启用 ngram parser，可在 keyword store 中降级到 `LIKE`，但测试应覆盖 FULLTEXT SQL 生成和 LIKE fallback 两条路径。

### 7.2 语意召回

后端生成 query embedding，然后调用 Qdrant：

```text
collection alias: culina_search
filter:
  family_id == current family_id
  entity_type in scopes
limit: semantic_limit
```

Qdrant 返回的相似度归一化为 `semantic_score`。如果使用 cosine distance，需要统一转换为越大越好的分数。

语意召回只返回候选 ID，不直接返回业务数据。

### 7.3 合并去重

合并 key：

```text
{entity_type}:{entity_id}
```

同一个候选可能同时来自关键词和语意召回。缺失的分数按 0 处理，但保留召回来源。

候选合并后必须回 MySQL 加载业务实体。可以由 search service 自身加载，也可以由 API 层基于候选 ID 加载，但加载时必须再次检查：

- `family_id` 必须等于当前 membership 的 `family_id`。
- 实体必须仍然存在。
- 已删除或跨家庭实体丢弃。

### 7.4 业务重排

初始分数：

```text
final_score =
  keyword_score * 0.40 +
  semantic_score * 0.45 +
  business_score * 0.15
```

精确意图保护：

- `title_text == q` 或 `name == q`：额外加分。
- `title_text` / `name` 以 `q` 开头：额外加分。
- 查询很短时，例如 1-2 个中文词，关键词权重应提高，避免语意结果冲掉精确命中。

业务分按实体类型计算。第一版可以先实现 `business_score = 0`，只做关键词和语意混排；但接口和排序结构必须保留 `business_score` 字段，后续补业务重排时不再改变响应契约。

当前第一批业务重排信号已经接入食材、食物和菜谱：食材接入库存存在、临期和低库存信号；食物接入适合餐别、即食/成品库存可用、临期优先、自制菜可做性和最近食用降分；菜谱复用库存可用性计算生成“家里可做 / 食材基本够”，复用餐食和做菜记录生成“最近少吃”加分和“最近刚吃过”降分。

业务重排边界：

- 业务分只使用已经存在的结构化字段和 service 计算结果，不从 `semantic_text` 反向解析业务含义。
- 正向信号可以进入 `match_reason`，负向信号只影响分数，默认不展示给用户。
- 没有足够结构化信号时保持中性，不为了凑理由生成猜测性文案。
- 动态信号必须按当前 `family_id` 计算，不能跨家庭复用缓存。
- 库存、最近食用、可做性等动态信号不写入 Qdrant payload；它们在查询时从 MySQL 业务表加载。

食材：

- 当前库存中存在且剩余量大于 0：加分。
- 临期或低库存并且查询意图相关：加分。
- 最近常用：加分。
- 不追踪数量的调味料在菜谱匹配中不应被错误当成缺货。
- 低库存适合在“补货”“快没了”“低库存”等查询意图中加分；普通搜索中可以作为轻量提示，不应压过名称精确匹配。

食物：

- 适合当前餐别：加分。
- 收藏、高评分、愿意复购：加分。
- 最近已经吃过：降分。
- 即食、预制或外食类库存可用且临期：加分。
- 自做菜有关联菜谱且家里可做：加分。

菜谱：

- 收藏：加分。
- 家里可做或基本可做：加分。
- 耗时短且查询包含“快手”“简单”等意图：加分。
- 最近刚吃过：降分。
- 难度、场景标签与查询意图匹配：加分。

业务分只影响排序，不得绕过正式写入、库存扣减或审批流程。

### 7.5 `match_reason` 生成

`match_reason` 用于向前端和 AI tools 解释“为什么这个结果靠前”。它必须由确定性规则生成，不调用 LLM，不让模型为每条搜索结果生成解释。

目标实现位置：

```text
backend/app/services/search/scoring.py
```

第一版允许在 `hybrid.py` 中生成基础关键词和语意理由：

- `title_text` 命中：`名称匹配` 或 `标题匹配`
- `keyword_text` 命中：`关键词匹配`
- `detail_text` 命中：`详情提到`
- 高语意分：`语意接近：{query}` 或 `适合这个搜索意图`

当库存可用、家里可做、餐别、收藏、评分、最近食用等业务信号接入后，再统一迁移到 `scoring.py` 的 reason candidate 机制。

输入来自混合检索过程中的结构化信号：

```text
keyword_match:
  - matched_fields
  - exact_name_match
  - prefix_name_match
  - matched_terms

semantic_match:
  - semantic_score
  - semantic_rank
  - semantic_threshold_bucket

business_match:
  - availability
  - prep_minutes
  - favorite
  - rating
  - suitable_meal_type
  - inventory_status
  - recent_usage
```

生成规则：

- 最多返回 3 条理由。
- 只使用短中文短语，不输出长句解释。
- 理由按贡献排序：精确关键词命中优先，其次强业务信号，再其次语意相似。
- 同类理由去重，例如“名称匹配”和“标题匹配”只保留一个。
- 负向信号默认不展示，例如“最近刚吃过”只用于降分，不作为推荐理由。
- 没有足够信号时返回空数组，前端不展示理由区域。
- `match_reason` 不是审计日志，不保证覆盖所有得分因素；详细贡献可在 debug trace 中保留结构化 reason candidates。
- `match_reason` 不调用 LLM，也不把用户备注、步骤正文或隐私文本原样拼入理由。

关键词理由示例：

```text
名称匹配
标题匹配
分类匹配
包含食材：番茄
步骤提到：焯水
```

语意理由示例：

```text
语意接近：清淡晚饭
适合这个搜索意图
```

语意理由只在 `semantic_score` 超过阈值时生成。第一版建议：

```text
semantic_score >= 0.82 -> 语意接近：{query}
0.74 <= semantic_score < 0.82 -> 适合这个搜索意图
semantic_score < 0.74 -> 不生成语意理由
```

业务理由示例：

食材：

```text
库存中有
临期优先
常用食材
```

食物：

```text
适合晚餐
已收藏
高评分
库存可用
```

菜谱：

```text
家里可做
食材基本够
15 分钟内
已收藏
最近少吃
```

实现上建议让 scoring 返回结构化 reason candidates：

```python
SearchReason(
    key="recipe_ready",
    label="家里可做",
    weight=0.18,
    source="business",
)
```

最终 response 只输出 `label` 列表。`key`、`weight`、`source` 只用于测试、调试和 trace。

### 7.6 分页与候选数量

混合检索不能简单地分别分页关键词结果和语意结果，否则合并重排后会漏掉高分候选。实现时按 `offset + limit` 扩大召回窗口：

```text
requested_window = offset + limit
keyword_limit = max(80, requested_window * 4)
semantic_limit = max(80, requested_window * 4)
merged_limit = max(120, requested_window * 6)
```

流程：

1. 关键词和语意分别召回扩大后的候选。
2. 合并去重后加载业务实体。
3. 统一计算 `final_score`。
4. 按最终排序做 `offset/limit`。

限制：

- `/api/search` 第一版建议限制 `limit <= 50`、`offset <= 500`。
- 超过上限的深分页应返回 400，或要求前端改用更具体的筛选条件。
- 同分排序必须稳定，建议按 `final_score desc, updated_at desc, entity_id asc`。
- 列表 API 无 `q` 时继续使用原 SQL 分页，不走混合检索分页。

## 8. 索引同步

### 8.1 写入路径

食材、食物、菜谱创建或更新时：

1. 正常执行业务写入、媒体绑定和活动日志。
2. 在同一个数据库事务中构建并 upsert search document。
3. 计算 `content_hash`。
4. 如果 hash 未变化，不重新生成 embedding。
5. 如果 hash 变化，更新 `search_documents`，标记 `vector_status = stale` 或 `pending`。
6. 提交业务事务。
7. 后台任务生成 embedding 并 upsert Qdrant。

主业务事务中只写 MySQL，不调用 embedding provider 或 Qdrant。主业务写入不应因为 embedding provider 或 Qdrant 异常失败。

索引任务不需要单独建 job 表，第一版可由 `search_documents.vector_status` 驱动：

- 业务写入在同一事务中 upsert `search_documents`，并设置 `vector_status = pending | stale`。
- 后台 worker 定时扫描 `pending | stale | failed` 且满足重试间隔的记录；重试间隔按 `vector_attempt_count` 递增退避。
- worker 批量领取任务时使用行锁、`SKIP LOCKED` 或等价机制，避免多个 worker 重复处理同一文档。
- worker 处理前必须再次确认 `content_hash`、`embedding_model`、`embedding_dimensions` 和当前配置一致，避免把旧向量写回 Qdrant。
- embedding 成功且 Qdrant upsert 成功后，设置 `vector_status = indexed`、清空 `vector_error`、更新 `indexed_at`。
- embedding 或 Qdrant 失败时，设置 `vector_status = failed`、记录截断后的 `vector_error`。
- `failed` 记录必须可由重建脚本或 worker 重试，不允许永久静默丢失。
- worker 每批处理后必须提交事务，避免长事务持有大量行锁。

### 8.2 删除路径

实体删除时：

1. 删除或标记 MySQL `search_documents`。
2. 尝试删除 Qdrant point。
3. Qdrant 删除失败不影响业务删除提交。

第一版如果不单独建删除 outbox，可以接受 Qdrant 中短暂残留 stale point，因为搜索结果返回前必须回 MySQL 加载业务实体并校验 `family_id`，已删除实体会被丢弃。上线前需要补其中一种清理手段：

- 删除 outbox：记录 `{entity_type, entity_id, family_id, point_id}`，worker 重试删除 Qdrant point。
- 周期清理脚本：扫描 Qdrant payload，对 MySQL 不存在的 point 做批量删除。
- 全量重建：新建 collection，按 MySQL `search_documents` 重建后切换 alias。

### 8.3 重建任务

需要提供管理脚本：

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/rebuild_search_index.py --scope recipes
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/rebuild_search_index.py --family-id family_xxx
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/rebuild_search_index.py --all
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/rebuild_search_index.py --all --vectors
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/rebuild_search_index.py --all --cleanup-vectors
PYTHONPATH=backend backend/.venv/bin/python backend/scripts/qdrant_search_smoke.py
```

重建任务职责：

- 扫描业务表生成 search document。
- 对比 `content_hash`。
- 可选批量生成 embedding。
- 可选批量 upsert Qdrant。
- 输出 indexed / skipped / failed 统计。
- 支持按 `family_id` 和 scope 限制范围，避免调试或修复时误扫全库。
- 重建 search document 不应覆盖业务数据，也不应生成活动日志。

`--vectors` 只处理 `search_documents.vector_status in pending | stale | failed` 的文档；不带 `--vectors` 时只重建 MySQL search document。

`--cleanup-vectors` 会按 `family_id` 和 scope 扫描 Qdrant payload，与 MySQL `search_documents` 对账，删除业务已不存在、`content_hash` 不一致或 `document_builder_version` 不一致的 stale point。

`qdrant_search_smoke.py` 使用临时 collection 验证 Qdrant collection 创建、payload index、upsert、family/scope 过滤 search、scroll 和 delete。脚本默认读取 `QDRANT_URL`、`QDRANT_API_KEY` 和 `QDRANT_COLLECTION`，结束时删除临时 collection。

## 9. 配置

新增后端配置：

```text
SEARCH_HYBRID_ENABLED=true
SEARCH_KEYWORD_BACKEND=mysql
SEARCH_VECTOR_BACKEND=qdrant

SEARCH_EMBEDDING_PROVIDER=
SEARCH_EMBEDDING_API_BASE=
SEARCH_EMBEDDING_API_KEY=
SEARCH_EMBEDDING_MODEL=
SEARCH_EMBEDDING_DIMENSIONS=
SEARCH_EMBEDDING_TIMEOUT_SECONDS=30

QDRANT_URL=http://qdrant:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=culina_search
QDRANT_TIMEOUT_SECONDS=10
```

原则：

- 搜索 embedding 配置独立于聊天 `AI_PROVIDER`。
- 本地未配置 embedding 或 Qdrant 时，API 自动降级关键词检索。
- `SEARCH_HYBRID_ENABLED=false` 时只执行关键词检索，不调用 embedding、Qdrant 或 rerank。
- 生产环境如果 `SEARCH_VECTOR_BACKEND=qdrant`，启动时应检查 collection 和 vector size 是否匹配。
- `SEARCH_EMBEDDING_DIMENSIONS` 为空时视为 `0`，只有启用向量索引时才要求大于 0。

配置校验要求：

- `SEARCH_HYBRID_ENABLED=true` 且向量后端不可用时，必须允许降级关键词检索，不能阻断 API 启动。
- `SEARCH_HYBRID_ENABLED=true`、`SEARCH_VECTOR_BACKEND=qdrant` 且 `SEARCH_EMBEDDING_PROVIDER` 不是 `disabled/mock` 时，`SEARCH_EMBEDDING_MODEL` 和 `SEARCH_EMBEDDING_DIMENSIONS` 必须非空。
- Qdrant collection 已存在但 vector size 与配置不一致时，不能继续写入；应要求新建 collection 或切换 alias。
- 本地开发默认可以 `SEARCH_EMBEDDING_PROVIDER=disabled`，保证没有 embedding key 时仍能跑通关键词检索和后端测试。

## 10. 部署

Docker Compose 增加 Qdrant：

```yaml
qdrant:
  image: qdrant/qdrant:v1.12.6
  restart: unless-stopped
  ports:
    - "6333:6333"
  volumes:
    - qdrant_data:/qdrant/storage
```

后端服务增加环境变量：

```yaml
SEARCH_HYBRID_ENABLED: ${SEARCH_HYBRID_ENABLED:-true}
SEARCH_VECTOR_BACKEND: ${SEARCH_VECTOR_BACKEND:-qdrant}
QDRANT_URL: ${QDRANT_URL:-http://qdrant:6333}
QDRANT_COLLECTION: ${QDRANT_COLLECTION:-culina_search}
SEARCH_EMBEDDING_PROVIDER: ${SEARCH_EMBEDDING_PROVIDER:-disabled}
SEARCH_EMBEDDING_API_BASE: ${SEARCH_EMBEDDING_API_BASE:-}
SEARCH_EMBEDDING_API_KEY: ${SEARCH_EMBEDDING_API_KEY:-}
SEARCH_EMBEDDING_MODEL: ${SEARCH_EMBEDDING_MODEL:-}
SEARCH_EMBEDDING_DIMENSIONS: ${SEARCH_EMBEDDING_DIMENSIONS:-}
QDRANT_API_KEY: ${QDRANT_API_KEY:-}
QDRANT_TIMEOUT_SECONDS: ${QDRANT_TIMEOUT_SECONDS:-10}
```

`QDRANT_API_KEY` 生产环境建议启用；本地开发可为空。

## 11. 降级与一致性

降级策略：

- embedding provider 不可用：只执行关键词检索。
- Qdrant 不可用：只执行关键词检索，并返回 `degraded = true`。
- 单个文档 embedding 失败：该文档仍可通过关键词召回。
- Qdrant point 缺失：通过重建任务恢复。
- MySQL search document 缺失：该实体不参与统一检索，监控应暴露缺失数量。

一致性策略：

- MySQL 是检索元数据真源。
- Qdrant 是可重建索引。
- 写入后允许短暂最终一致。
- 对用户可见的正式数据必须以 MySQL 业务表为准。
- AI tool 使用检索结果时，只能把结果作为候选，正式写入仍走现有 draft / approval / commit。
- Qdrant 中残留的已删除 point 不应出现在响应中，因为响应组装必须回 MySQL 加载实体；清理残留 point 是运维一致性问题，不是展示正确性的前提。

## 12. 安全与数据边界

必须满足：

- 所有 MySQL 查询都按当前 membership 的 `family_id` 过滤。
- 所有 Qdrant search 都带 `family_id` payload filter。
- Qdrant 返回后必须回 MySQL 二次校验 `family_id`。
- Qdrant payload 不存用户密钥、媒体 URL、完整备注正文或完整菜谱步骤。
- 搜索 API 不接受前端传来的 `family_id`。
- 统一搜索跨 scope 时，每个 scope 都必须在后端白名单内。

## 13. 观测指标

建议记录：

- 搜索请求量、p50/p95 延迟。
- keyword recall 数量。
- semantic recall 数量。
- merged candidate 数量。
- degraded 次数和原因。
- embedding 生成成功率和失败原因。
- Qdrant upsert/delete 失败次数。
- `search_documents.vector_status` 分布。
- Qdrant stale point 清理扫描数、删除数和失败数。
- 每个 scope 的 search document 缺失数，例如业务实体存在但 `search_documents` 不存在。

AI 工作台调用搜索时，可以把 search trace 挂到现有 AI trace 体系中，但默认不要记录完整用户隐私正文。

调试 trace 建议包含结构化字段：

```json
{
  "query": "清淡晚饭",
  "scopes": ["recipe", "food"],
  "keyword_recall_count": 42,
  "semantic_recall_count": 60,
  "merged_count": 78,
  "degraded": false,
  "degraded_reason": "",
  "top_items": [
    {
      "entity_type": "recipe",
      "entity_id": "recipe_xxx",
      "keyword_score": 0.4,
      "semantic_score": 0.88,
      "business_score": 0.35,
      "reason_keys": ["semantic_close", "recipe_ready"]
    }
  ]
}
```

trace 中保留 `reason_keys` 即可，默认不记录完整 `semantic_text`。

## 14. 实施步骤

### 阶段 1：检索文档和关键词层

1. 新增 `search_documents` model、schema 和 Alembic migration。
2. 实现 `documents.py`，覆盖食材、食物、菜谱。
3. 实现 MySQL keyword search。
4. 写重建脚本，先补齐所有家庭 search document。
5. `/api/search` 支持关键词召回链路，作为后续混合检索的基础。

验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/search -q
npm run backend:test
```

### 阶段 2：Qdrant 和 embedding

1. 增加 Qdrant compose 服务和配置。
2. 实现 `EmbeddingClient`。
3. 实现 `QdrantVectorStore`。
4. 重建脚本支持生成 embedding 和 upsert Qdrant。
5. `/api/search` 支持语意召回链路，作为后续混合检索的基础。

验证：

```bash
docker compose config
backend/.venv/bin/python -m pytest backend/tests/search -q
```

### 阶段 3：混合检索和业务重排

1. 实现 `hybrid.py` 合并关键词和语意候选。
2. 实现 `scoring.py` 业务重排和 `match_reason` reason candidates。
3. `/api/search` 默认支持混合检索。
4. 现有 `/api/ingredients`、`/api/foods`、`/api/recipes` 的 `q` 参数切换为混合检索。
5. 前端和 AI tools 不需要传额外模式参数，统一使用默认混合检索。

验证：

```bash
backend/.venv/bin/python -m pytest backend/tests/search -q
backend/.venv/bin/python -m pytest backend/tests/ai_infra -q
npm --prefix frontend run test
```

### 阶段 4：结果调优和观测

1. 观测关键词、语意和混合检索结果差异。
2. 调整短查询权重、精确命中保护和业务分。
3. 调整 AI tools 的候选数量、召回 scope 和重排理由。
4. 根据真实家庭数据补充同义词、分类词和业务打分规则。

### 上线前验收清单

- Alembic migration 能在空库和已有数据上执行成功。
- 重建脚本能生成食材、食物、菜谱的 `search_documents`，重复执行保持幂等。
- embedding disabled 时，`/api/search` 和三个列表 API 的 `q` 搜索都能降级关键词检索。
- Qdrant 可用时，向量 upsert、search、scroll cleanup 和 delete stale point 路径均有验证。
- 真实 Qdrant 环境下运行 `backend/scripts/qdrant_search_smoke.py` 成功，确认 HTTP contract 与当前 Qdrant 版本兼容。
- `/api/search`、`/api/ingredients?q=`、`/api/foods?q=`、`/api/recipes?q=` 都按当前 membership 的 `family_id` 隔离。
- 食材、食物、菜谱 create/update/delete 后，MySQL search document 与 Qdrant stale cleanup 行为符合预期。
- `match_reason` 只返回确定性短理由，不展示负向理由、不泄露备注或步骤正文。
- AI tools 使用统一 search service 后，exact search、ids search、分类过滤和原有返回 schema 不退化。
- 前端 API 类型、query key 和搜索请求参数与后端 contract 一致。
- `docker compose config` 能验证 Qdrant 和搜索环境变量注入正确。
- 后端搜索、AI tool、相关列表 API 和前端 API contract 测试通过。

## 15. 需要避免的实现

不要：

- 让前端直接访问 Qdrant。
- 把 Qdrant 当业务真源。
- 只做语意检索并删除关键词检索。
- 把完整家庭业务正文塞进 Qdrant payload。
- 搜索 API 接收或信任前端传来的 `family_id`。
- embedding 失败时阻断食材、食物、菜谱的正式创建或更新。
- 为了单个搜索词写硬编码分支；同义词和意图优先通过 embedding、轻量词典和通用 scoring 解决。

## 16. 默认决策

第一版默认决策：

- 数据真源：MySQL。
- 关键词检索：MySQL `FULLTEXT`，中文使用 `ngram parser`；不可用时短期降级 `LIKE`。
- 向量检索：Qdrant。
- embedding 配置：独立于聊天模型配置。
- 默认 API 模式：`hybrid`。
- 调试和降级模式：`keyword`、`semantic`。
- Qdrant 不可用：降级关键词检索。
- AI tool 候选检索：优先接入统一 `/api/search` 或内部 `SearchService`，但正式写入仍走现有审批链路。
