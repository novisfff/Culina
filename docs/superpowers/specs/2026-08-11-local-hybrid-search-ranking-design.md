# Culina 无 Rerank 本地融合重排设计

日期：2026-08-11

## 1. 背景

Culina 当前统一搜索使用以下链路：

```text
MySQL 关键词召回
  + text-embedding-v4 查询向量
  + Qdrant 语义召回
  -> 固定权重本地融合
  -> 可选 rerank
  -> 返回食材、食物、菜谱和个人餐食计划
```

当前 rerank 使用候选名称文本和完整搜索文档文本进行二次判断。每个非精确候选最多发送两份文档，候选数上限为 50，因此一次搜索最多可以形成 100 份 rerank 文档。该路径可以提高结果纯度，但 token 用量、网络延迟和 provider 不确定性都明显高于本地计算。

产品决定继续保留 rerank 能力和配置控制，但日常部署大概率不开启 rerank。本设计因此把本地排序从“provider 不可用时的简单降级”升级为完整、正式、可解释的搜索排序路径，同时保留现有 `text-embedding-v4 + Qdrant` 语义召回。

## 2. 当前事实与问题

### 2.1 当前本地分数

当前实现使用：

```text
local_score =
  keyword_score * 0.45
  + semantic_score * 0.50
  + business_score * 0.05 * relevance_score
  + title_match_bonus
  + exact_name_bonus
```

其中关键词分、Qdrant cosine 分和业务分直接进入同一个加权和。

### 2.2 当前主要缺口

1. 名称完全匹配有硬保护，但标题前缀、标题包含和结构化关键词命中会因为关键词分过早封顶而失去强弱差异。
2. `literal_score` 已经计算，但 rerank 关闭或失败时不会进入本地排序。
3. 短查询没有独立的关键词权重和字面分层，强语义结果可能超过明显的标题包含结果。
4. `business_score` 被裁剪到 `[0, 1]`，导致“最近刚吃过”“库存不足”等负向信号只能抵消正向奖励，不能独立降序。
5. 当前紧凑匹配会删除整个关键词字段的空格，可能把两个独立 token 拼成不存在的词。
6. `SEARCH_RERANK_SEMANTIC_MIN_SCORE` 实际控制本地语义候选准入，配置职责与名称不一致。
7. 现有搜索测试覆盖规则、权限和失败降级，但没有固定的本地排序质量集和 MRR、nDCG 等质量门槛。

## 3. 目标

本次改造必须达到：

1. rerank 关闭时，本地排序直接承担完整的排序、弱结果下沉和解释职责。
2. rerank 失败时返回与正常无 rerank 路径一致的本地结果，同时保留已有降级状态和错误码。
3. 名称和标题直接命中稳定优先，尤其保护中文短查询。
4. 同义词、场景和自然语言意图继续通过 `text-embedding-v4 + Qdrant` 获得召回。
5. 前几名以高置信结果为主，弱语义和详情命中保留在结果后部而不是直接全部丢弃。
6. 关键词、语义、双路共识和家庭业务信号分别建模，不再假设所有原始分数天然等价。
7. 业务信号允许轻量正向和负向调整，但不能让无关候选仅凭库存或历史信号进入前排。
8. 排序全程确定性、可解释、可离线测试，不增加新的外部模型、网络请求或 NLP 依赖。
9. 保持家庭隔离、个人餐食计划隔离、现有 API 结构和 AI 候选确认边界。
10. rerank 链路继续由现有配置控制，不删除、不强制关闭。

## 4. 非目标

本次不做：

- 删除 rerank 客户端、配置、计量或 provider 测试。
- 替换 `text-embedding-v4`、Qdrant collection、向量维度或文档 embedding 内容。
- 引入学习排序模型、中文分词服务或第三方 NLP 依赖。
- 为不同实体类型设置固定配额或强制多样性。
- 修改全局搜索 UI、列表 UI 或 AI 草稿审批规则。
- 将搜索分数作为实体自动绑定、正式写入或权限判断依据。
- 引入 v1/v2 本地排序版本开关、shadow 双算、灰度路径或旧算法回退。
- 因本次排序改造重建搜索文档或 Qdrant 向量索引。

## 5. 核心决策

采用“置信分层 + 层内动态融合”：

```text
查询归一化与类型识别
        ↓
MySQL 关键词召回 + Qdrant 语义召回
        ↓
候选合并与特征提取
        ↓
本地置信分层
        ↓
层内动态融合排序
        ↓
┌ rerank 开启：作为最终精排与过滤
└ rerank 关闭/失败：直接返回完整本地排序
```

层级决定跨候选的大方向，层内分数只负责同级候选的细排。这样可以避免不同召回来源的原始分数尺度直接冲掉明确的字面证据。

本次直接替换当前本地算法，不保留旧本地排序实现。

## 6. 模块边界

### 6.1 `query_analysis.py`

新建 `backend/app/services/search/query_analysis.py`，只负责确定性查询分析。

建议接口：

```python
class SearchQueryKind(str, Enum):
    LITERAL = "literal"
    INTENT = "intent"
    MIXED = "mixed"


@dataclass(frozen=True)
class SearchQueryProfile:
    original_text: str
    normalized_text: str
    compact_text: str
    kind: SearchQueryKind
    effective_length: int
    intent_keys: tuple[str, ...]


analyze_search_query(query: str) -> SearchQueryProfile
```

职责：

- 使用 `unicodedata.normalize("NFKC", value)` 做全半角基础归一。
- 转为小写，合并连续空白。
- 将 Unicode 分隔符和标点用于 token 边界，不删除字符后直接拼接不同 token。
- 生成只保留字母、数字和中日韩统一表意字符的 `compact_text`。
- 识别已有产品意图：餐次、日期、快手/简单、库存/补货、计划、状态和记录。
- 不记录、持久化或输出原始查询到结构化诊断。

查询类型规则：

- 没有命中意图词：`literal`。
- 查询有效内容完全由意图词构成：`intent`。
- 命中意图词且仍有剩余实体文本：`mixed`。

首版意图词表固定为：

```text
quick:
  快手、简单、省时、快、速成、容易、新手

meal:
  早餐、午餐、午饭、晚餐、晚饭、加餐、夜宵

inventory:
  库存、补货、快没了、低库存、不足、采购、买、临期、到期、快过期、家里有

date:
  今天、明天、本周、这周、这星期

plan:
  计划、安排、菜单、待做

history_status:
  完成、做过、吃过、记录、跳过
```

分类时按同组和跨组的最长词优先匹配，将全部命中的意图 span 替换为空格，再次执行 NFKC、标点和空白归一：

- 没有任何意图 span：`literal`。
- 移除意图 span 后没有字母、数字或中文字符：`intent`。
- 移除后仍有有效字符：`mixed`。

词表只在 `query_analysis.py` 定义一份。`scoring.py` 的业务意图判断消费 `SearchQueryProfile.intent_keys`，不再维护另一套近似字符串集合。

即使查询被识别为 `intent`，名称完全匹配和标题直接命中仍然使用最高置信层，不被查询类型降级。

### 6.2 `ranking_features.py`

新建 `backend/app/services/search/ranking_features.py`，把关键词、向量、搜索文档和业务信号转换为统一排序特征。

建议接口：

```python
class LiteralMatchKind(str, Enum):
    NONE = "none"
    DETAIL = "detail"
    COMPACT_KEYWORD = "compact_keyword"
    STRUCTURED_KEYWORD = "structured_keyword"
    TITLE_CONTAINS = "title_contains"
    TITLE_PREFIX = "title_prefix"
    EXACT_NAME = "exact_name"


@dataclass(frozen=True)
class SearchRankingCandidate:
    entity_type: str
    entity_id: str
    keyword_score: float
    semantic_score: float
    keyword_rank: int | None
    semantic_rank: int | None
    literal_match: LiteralMatchKind
    literal_confidence: float
    trusted_keyword_match: bool
    detail_only_match: bool
    dual_source_match: bool
    signed_business_score: float
    positive_reasons: tuple[str, ...]


build_ranking_candidate(
    *,
    profile: SearchQueryProfile,
    entity_type: str,
    entity_id: str,
    document: SearchDocument | None,
    exact_name_match: bool,
    keyword_hit: KeywordSearchHit | None,
    keyword_rank: int | None,
    semantic_score: float,
    semantic_rank: int | None,
    business_reasons: Sequence[SearchReason],
) -> SearchRankingCandidate
```

职责：

- 为关键词和向量召回保留各自 rank；缺失来源使用 `None`，不伪造 rank。
- 对 provider 或测试输入的非有限分数、负数和超范围分数做安全归一。
- 从 `SearchDocument.metadata_json` 读取结构化检索值，不从 `semantic_text` 反向推断业务含义。
- 区分标题、结构化关键词、普通关键词和详情正文证据。
- 计算双路命中，但详情正文碰巧命中不视为可信共识。
- 复用 `scoring.py` 中已有的库存、临期、可做性、最近食用等业务信号生成逻辑。

`KeywordSearchHit` 同步增加确定性的召回模式：

```python
class KeywordMatchMode(str, Enum):
    MYSQL_FULLTEXT = "mysql_fulltext"
    SUBSTRING = "substring"
    SAFE_COMPACT = "safe_compact"
```

同一候选可以包含多个 `match_modes`。特征提取使用 `match_modes + matched_fields + SearchDocument` 复核字面证据；不能仅因为 compact fallback 曾经召回该候选就把它标记为可信关键词命中。

结构化检索值：

- 食材：名称、分类。
- 食物：名称、分类、口味标签、场景标签、适合餐次。
- 菜谱：标题、场景标签、食材名称。
- 餐食计划：食物名、菜谱标题、日期、餐次、状态。

### 6.3 `local_ranking.py`

新建 `backend/app/services/search/local_ranking.py`，只做纯计算，不访问数据库或 provider。

建议接口：

```python
class SearchConfidenceLevel(IntEnum):
    EXACT = 0
    TITLE = 1
    STRONG = 2
    RELEVANT = 3
    WEAK = 4


@dataclass(frozen=True)
class LocalRankingScore:
    confidence_level: SearchConfidenceLevel
    keyword_confidence: float
    semantic_confidence: float
    agreement_bonus: float
    business_adjustment: float
    within_level_score: float
    final_score: float


def rank_local_candidates(
    profile: SearchQueryProfile,
    candidates: list[SearchRankingCandidate],
) -> list[tuple[SearchRankingCandidate, LocalRankingScore]]
```

职责：

- 判定唯一置信层。
- 校准关键词与语义置信度。
- 根据查询类型选择层内权重。
- 应用有符号业务微调。
- 生成稳定排序和最终分数。

### 6.4 `scoring.py`

`backend/app/services/search/scoring.py` 继续负责：

- 各实体类型的业务信号候选。
- 正向和负向业务权重。
- 确定性的 `match_reason` 文案。
- 负向理由不展示的规则。

它不再拥有关键词、语义和业务分的最终固定加权公式。

### 6.5 `hybrid.py`

`backend/app/services/search/hybrid.py` 收敛为编排层：

1. 分析查询。
2. 执行精确名称、关键词和向量召回。
3. 合并候选并记录来源 rank。
4. 回 MySQL 加载当前家庭业务实体和动态信号。
5. 构建排序特征。
6. 调用唯一的本地排序实现。
7. 按现有配置决定是否进入 rerank。
8. 分页并返回。

向量召回不变量：

- 全局搜索同时包含个人餐食计划和其他 scope 时，继续分别执行带 `user_id` 的餐食计划查询和仅带 `family_id` 的其他实体查询。
- 两组 Qdrant 结果合并后按 `semantic_score` 降序、原组内 `semantic_rank` 升序、`entity_type` 和 `entity_id` 排序，再截取统一 `semantic_limit`。
- 合并后的顺序重新赋予全局 `semantic_rank`。
- 不使用两个独立查询中都从 1 开始的原始 rank 直接交错候选，避免低相似度 scope 候选挤掉更高相似度候选。

## 7. 查询归一化与安全紧凑匹配

### 7.1 字符归一化

本地特征比较时，查询和候选字段使用相同的 NFKC、小写和空白规则。该规则只作用于查询分析和本地排序，不改变现有搜索文档内容，因此不需要重新生成 embedding 或重建 Qdrant。

### 7.2 标题匹配

标题和名称允许生成整体 `compact_text`，用于识别：

- 完全相同。
- 查询是标题前缀。
- 标题包含查询。

### 7.3 关键词匹配

关键词和结构化元数据按原始 token 分别匹配：

- 单个 token 可做 NFKC 和紧凑比较。
- 只允许连续的单个中文字符 token 合并，例如 `鸡 肉` 可以形成 `鸡肉`。
- 不允许任意多字 token 跨边界拼接，例如 `三黄鸡 肉类` 不能因为去空格而形成 `三黄鸡肉类` 后命中 `鸡肉`。
- 详情正文只提供弱证据，不参与安全 token 合并。

`keyword_store.py` 的 compact fallback 必须复用同一安全 token matcher，并在 `KeywordSearchHit.match_modes` 中标记 `SAFE_COMPACT`。MySQL Fulltext 和普通 substring 分别标记 `MYSQL_FULLTEXT`、`SUBSTRING`。多个召回结果合并时同时合并 `matched_fields` 和 `match_modes`，不丢失来源证据。

## 8. 置信分层合同

每个候选按从 L0 到 L4 的顺序判定，进入第一个满足的唯一层级。

### 8.1 L0：完全名称匹配

满足：

- 当前业务实体的名称或标题与归一化查询完全相同。

该命中继续直接查询业务表，因此即使搜索文档暂时缺失也可进入结果。

### 8.2 L1：标题直接命中

满足任一：

- 名称或标题以查询开头。
- 名称或标题包含查询。

### 8.3 L2：强相关

满足任一：

- 结构化关键词精确命中。
- 可信关键词命中且 `semantic_score >= 0.60`。
- 纯语义命中且 `semantic_score >= 0.82`。

### 8.4 L3：一般相关

满足任一：

- 普通非详情关键词命中。
- 纯语义命中且 `semantic_score >= 0.74`。
- 任意非详情关键词与向量双路命中，且 `semantic_score >= 0.48`。

### 8.5 L4：弱相关

满足任一：

- 仅详情正文命中。
- 纯语义分位于 `[0.48, 0.74)`。

纯语义低于 `0.48` 且没有任何关键词证据的候选不进入本地排序。

层级判定不设置实体类型配额。全局搜索仍按相关性统一排列食材、食物、菜谱和个人餐食计划。

## 9. 分数校准与层内融合

### 9.1 关键词置信度

字面证据基准：

```text
名称或标题前缀：      0.95
名称或标题包含：      0.90
结构化 token 命中：  0.80
安全紧凑关键词命中：  0.70
详情正文命中上限：    0.35
```

完全名称匹配由 L0 保护，不依赖关键词置信度决定跨层顺序。

关键词置信度计算：

```text
field_cap =
  title_text   -> 0.95
  keyword_text -> 0.80
  detail_text  -> 0.35

keyword_confidence = max(
  literal_confidence,
  clamp(raw_keyword_score, 0, 1) * field_cap
)
```

这样保留 MySQL 分数在同类证据内的差异，同时阻止详情全文分与标题直接命中处于同一尺度。

### 9.2 语义置信度

使用当前 `0.48` 作为语义候选下限：

```text
semantic_confidence =
  clamp((semantic_score - 0.48) / (1.00 - 0.48), 0, 1)
```

效果：

- `semantic_score = 0.48` 只代表可以进入弱候选，不自动获得显著排序分。
- 高分之间的差异继续保留。
- 当前 `0.74` 和 `0.82` 阈值继续承担一般相关和强相关层级判断。

### 9.3 双路共识奖励

双路奖励仅在以下条件同时满足时生效：

- 候选具有非详情关键词证据。
- `semantic_score >= 0.48`。

详情正文命中与弱向量碰巧重合不视为可信共识。

### 9.4 查询类型权重

同一层级内部使用：

```text
literal:
  keyword_confidence * 0.60
  + semantic_confidence * 0.35
  + agreement_bonus，最高 0.05

mixed:
  keyword_confidence * 0.45
  + semantic_confidence * 0.45
  + agreement_bonus，最高 0.10

intent:
  keyword_confidence * 0.30
  + semantic_confidence * 0.60
  + agreement_bonus，最高 0.10
```

每组理论最大值为 `1.0`。

### 9.5 有符号业务微调

业务信号合计后裁剪到 `[-1, 1]`：

```text
signed_business_score =
  clamp(sum(business_signal_weights), -1, 1)

business_adjustment =
  signed_business_score * 0.05 * base_relevance

within_level_score =
  clamp(base_relevance + business_adjustment, 0, 1)
```

边界：

- 库存可用、临期且查询相关、家里可做、最近少吃等正向信号轻量加分。
- 最近刚吃过、库存不足等负向信号实际降分。
- 业务信号最多改变同一层内 5% 的相关性，不改变置信层级。
- `base_relevance = 0` 时业务信号不能单独产生排序分。
- 正向理由可进入 `match_reason`；负向理由只影响分数，不展示给用户。

### 9.6 最终分数

```text
final_score = (4 - confidence_level) + within_level_score
```

范围：

```text
L0: 4.x
L1: 3.x
L2: 2.x
L3: 1.x
L4: 0.x
```

稳定排序键：

```text
confidence_level 升序
within_level_score 降序
literal_confidence 降序
best_available_source_rank 升序
entity_type 升序
entity_id 升序
```

`best_available_source_rank` 是非空 `keyword_rank` 和 `semantic_rank` 的最小值；两者都为空时排在有来源 rank 的候选之后。

`score` 只用于当前响应内的相对顺序，不定义为跨查询、跨 provider 或跨排序模式可比较的概率。

## 10. Rerank 兼容

### 10.1 rerank 关闭

- 不调用 rerank provider。
- 不产生 rerank 用量。
- 直接返回本地置信分层结果。
- `search_mode` 继续是 `hybrid`。
- `degraded = false`，因为关闭 rerank 是合法配置。

### 10.2 rerank 开启并成功

- 本地排序决定进入 rerank 的候选顺序。
- 继续跳过名称完全匹配候选。
- 继续使用现有候选上限、文档构造、provider 合同、计量和结果 bucket。
- provider 成功后，现有 rerank 结果仍是最终排序；本地分作为同 bucket tie-break。

### 10.3 rerank 开启但失败

- embedding 和关键词召回已经成功的候选不丢失。
- 返回与正常关闭 rerank 时相同的完整本地排序。
- 保留 `degraded = true` 和现有 `degradation_code`。
- 不进行第二次 provider 发送。

## 11. 配置

直接删除：

```text
SEARCH_RERANK_SEMANTIC_MIN_SCORE
```

直接新增：

```text
SEARCH_SEMANTIC_MIN_SCORE=0.48
```

同步修改：

- `backend/app/core/config.py`
- `backend/.env.example`
- `deploy/.env.example`
- `deploy/docker-compose.yml` 中相关传递项（如存在）
- 当前部署环境配置
- 搜索测试配置辅助

不保留旧配置兼容读取。`SEARCH_RERANK_MIN_SCORE`、`SEARCH_LITERAL_FALLBACK_MIN_SCORE`、`SEARCH_RERANK_CANDIDATE_LIMIT` 和 rerank provider 配置继续保留，仅服务 rerank 路径。

配置校验：

- `SEARCH_SEMANTIC_MIN_SCORE` 必须位于 `[0, 1)`。
- `0.74` 和 `0.82` 是本地排序合同常量，不作为环境变量暴露。
- 动态权重、字面置信度和业务调整上限是代码常量，不增加日常运行时调参面。

## 12. API 与消费者合同

现有字段保持：

```text
score
keyword_score
semantic_score
business_score
match_reason
```

新语义：

- `score` 可以位于 `0.x` 到 `4.x`，只表示当前响应内相对顺序。
- `keyword_score` 和 `semantic_score` 继续返回召回层原始归一化分，便于调试。
- `business_score` 允许位于 `[-1, 1]`。
- `match_reason` 最多返回三个确定性正向理由，按字面证据、语义证据、正向业务证据的候选权重统一排序并去重；负向业务理由不输出。

消费者约束：

- 前端继续只使用结果顺序和 `match_reason` 展示，不根据分数区间生成文案。
- 列表 API 继续按本地结果顺序回载实体。
- AI search tool 可以返回分数作为候选元数据，但不能基于固定分数自动绑定真实实体。
- 多候选或目标不明确时，AI 继续请求用户选择。
- 不新增前端字段，不需要 UI 迁移。

## 13. 失败处理

### 13.1 embedding 或 Qdrant 不可用

- 保留现有关键词降级。
- 本地置信分层基于精确名称和关键词证据工作。
- 返回现有 embedding/vector 降级状态。

### 13.2 非法分数

- `None`、字符串、NaN、Infinity 和无法解析的值归一为 `0`。
- 关键词和语义原始分最终裁剪到 `[0, 1]`。
- 非法分数不能破坏稳定排序或产生不可序列化响应。

### 13.3 搜索文档暂时缺失

- 完全名称命中继续依赖当前业务表，可以正常进入 L0。
- 其他候选必须具有当前家庭的 `SearchDocument` 和仍存在的业务实体。
- Qdrant 残留 point 不直接进入响应。

### 13.4 无候选

- 返回空列表、`total = 0`，保持现有 API 合同。

## 14. 隐私与数据边界

- 所有关键词、搜索文档、业务信号和业务实体查询继续按当前 `family_id` 隔离。
- 个人餐食计划继续同时按 `family_id + user_id` 隔离。
- 动态业务信号只在当前请求中读取，不写入 Qdrant payload。
- 排序诊断不记录查询正文、搜索文档、实体 ID、家庭 ID 或用户 ID。
- AI 搜索结果仍只是候选，不改变 `draft -> approval -> service commit` 正式写入边界。

## 15. 可观测性

增加不含业务正文的结构化诊断字段：

```text
query_profile
keyword_candidate_count
semantic_candidate_count
dual_source_count
level_0_count
level_1_count
level_2_count
level_3_count
level_4_count
local_ranking_duration_ms
rerank_used
degradation_code
```

要求：

- 不记录原始查询和归一化查询。
- 不记录候选名称、实体 ID、家庭 ID、用户 ID或搜索文档内容。
- `local_ranking_duration_ms` 只覆盖特征完成后的纯排序阶段。
- `rerank_used` 表示本次请求是否实际发出 provider 请求，不等同于 provider 是否配置。

## 16. 离线质量评测

### 16.1 数据集

新增 80 条不含真实家庭隐私的合成案例：

- 20 条名称完全匹配、前缀和包含查询。
- 15 条同义词和纯向量查询。
- 15 条场景、日期、库存和计划等意图查询。
- 10 条实体词与意图词混合查询。
- 10 条弱相关、跨 token、单字和详情正文噪声查询。
- 10 条库存、临期、可做性和最近食用业务上下文查询。

覆盖：

- 食材、食物、菜谱、餐食计划四种实体。
- 同家庭不同用户的餐食计划边界。
- 关键词单路、向量单路和双路命中。
- rerank 关闭和 rerank 失败的相同本地结果。

每个候选标注相关性：

```text
3：目标或明显最佳结果
2：高度相关
1：弱相关，可出现在后部
0：无关，不应进入前排
```

CI 使用固定关键词分、固定语义分和合成业务信号，不调用真实 embedding、Qdrant 或 rerank。

### 16.2 质量门槛

```text
完全名称或标题直接命中 Top-1：100%
MRR@10：                         >= 0.90
nDCG@10：                        >= 0.85
存在 L0-L2 时，L4 进入 Top-5：   0 条
Recall@20：                      不低于改造前固定基线
相同输入重复排序：               100% 一致
```

改造前固定基线由实施前运行当前本地算法生成，只保存聚合指标和合成案例 ID，不保留真实搜索数据。

### 16.3 可选人工对照

允许在明确人工触发时，用同一组合成查询分别运行本地排序和已配置 rerank，生成差异报告。该流程：

- 不进入 CI。
- 不自动定时运行。
- 不使用真实家庭查询或文档。
- 只有操作者明确触发时才产生 provider token 和费用。

## 17. 性能与用量验收

无 rerank 路径必须满足：

- rerank HTTP 调用数为 `0`。
- `rerank_requests`、`rerank_documents` 和 rerank token 用量为 `0`。
- 查询 embedding 保持一次请求。
- 160 个特征完整候选的纯本地排序基准 p95 不超过 `20ms`。
- 性能基准生成报告，不作为容易受 CI 主机抖动影响的单测门禁。
- 搜索 API 总延迟不再包含 rerank 网络等待。

rerank 开启时，不改变现有候选上限、超时、用量治理或计费合同。

## 18. 测试策略

### 18.1 查询分析

覆盖：

- NFKC 全半角归一。
- 空白和标点边界。
- `literal / intent / mixed` 分类。
- 单字和双字中文查询。
- 实体名称同时包含意图词时仍由候选字面证据获得 L0/L1。

### 18.2 特征提取

覆盖：

- 完全名称、前缀、包含和结构化 token。
- `鸡 肉` 可以安全合并。
- `三黄鸡 肉类` 不产生跨多字 token 的 `鸡肉` 命中。
- 详情正文不获得可信关键词标记。
- 关键词和语义 rank 正确保留。
- NaN、Infinity 和异常分数安全归一。

### 18.3 本地排序

使用表驱动测试覆盖：

- L0 到 L4 的唯一层级判定。
- 三种查询类型权重。
- 语义分从 `0.48` 到 `1.0` 的校准边界。
- 双路奖励的准入条件。
- 正向和负向业务调整。
- 业务信号不能改变置信层。
- 稳定 tie-break。
- 最终分数范围。

### 18.4 混合搜索集成

覆盖：

- 关键词与向量合并。
- 无 rerank 的正式本地路径。
- rerank 成功后的 provider 排序。
- rerank 禁用、额度阻断、超时、HTTP 错误和无效响应后的相同本地排序。
- embedding 或 Qdrant 不可用时的关键词路径。
- 搜索文档缺失和 Qdrant 残留 point。
- 分页前完成统一排序。

### 18.5 API 与 AI 工具

覆盖：

- `/api/search` 响应字段和结果顺序。
- 食材、食物、菜谱、库存和餐食计划列表搜索顺序。
- `ingredient.search`、`food.search`、`recipe.search`、`meal_plan.search` 和候选 resolution 工具顺序。
- `businessScore` 允许负数。
- AI 不根据 `score` 自动绑定实体。

### 18.6 验证命令

至少执行：

```bash
cd backend && .venv/bin/python -m pytest tests/search -q
npm run backend:test:search
```

涉及 AI search tool 合同时执行对应 `backend/tests/ai_infra/` 定向测试。完成前执行：

```bash
npm run backend:quality
```

本次没有数据库 schema 变化，不需要 Alembic migration。

## 19. 直接升级顺序

本次不做灰度，按以下依赖顺序直接升级：

1. 增加查询分析、特征提取和纯本地排序单元及其失败测试。
2. 修复有符号业务分和安全 token 匹配。
3. 将 `hybrid.py` 接入唯一的新本地排序。
4. 保持 rerank 成功路径，改为以新本地排序作为候选选择和失败回退。
5. 直接替换语义阈值配置并同步部署文件。
6. 更新 API、AI tool 和搜索集成测试。
7. 增加 80 条离线质量集、指标脚本和性能报告。
8. 运行搜索专项、AI 定向测试和后端全量质量检查。

升级完成后，仓库内不保留旧本地排序函数、版本开关或兼容读取。

## 20. 风险与控制

### 20.1 意图词表误分类

风险：实体名称可能包含“早餐”“快手”等意图词。

控制：查询类型只改变同一层内权重；完全名称、标题前缀和标题包含仍由 L0/L1 保护。

### 20.2 分层过度保护字面结果

风险：标题包含但实际意图较弱的结果可能压过高度相关语义结果。

控制：只有名称和标题进入 L1；结构化关键词进入 L2；详情正文留在 L4。80 条质量集必须包含标题歧义和意图查询。

### 20.3 语义分分布变化

风险：未来替换 embedding 模型后，`0.48/0.74/0.82` 不再适合。

控制：模型变化必须重新运行离线质量集并显式调整代码常量；不通过环境变量静默改变排序合同。

### 20.4 分数范围变化

风险：隐藏消费者可能把 `score` 当作概率。

控制：仓库内消费者不得用固定阈值自动决策；更新 API 与 AI tool contract 测试，明确 `score` 只在单次响应内可比较。

### 20.5 业务信号降分过强

风险：最近吃过或库存不足把明确相关结果压到不相关结果之后。

控制：业务调整最多 5%，只影响同一置信层，不改变层级。

## 21. 完成定义

设计完成的实现必须同时满足：

- 新本地排序是仓库内唯一的本地融合实现。
- rerank 开关、provider、计量和失败降级链路仍可工作。
- rerank 关闭时不产生任何 rerank provider 请求或用量。
- 80 条离线质量集达到全部质量门槛。
- 搜索专项、相关 AI tool 测试和后端质量检查通过。
- API 字段保持兼容，`score` 与 `business_score` 新语义有测试和文档覆盖。
- 无数据库 migration、无向量索引重建、无前端 UI 修改。
