# Culina 餐食记录减负与家庭记忆设计规格

> 日期：2026-07-14
>
> 状态：已完成需求 grilling、方案确认、规格复核与外部实施审计；implementation plan 已生成，尚未开始实现
>
> 产品语境：移动优先、照片驱动、低维护的中国家庭饮食记录
>
> 需求来源：`docs/plans/2026-07-11-family-kitchen-product-assessment.md` 第 7 节——“餐食记录的价值表达不够强”

## 一、结论

本方案把餐食记录从“需要补完的资料任务”改成“已经发生的一顿饭”，再用可解释的家庭记忆回馈用户。

核心闭环是：

1. 用户用较少步骤记录一顿包含多道 Food 的饭，找不到现有 Food 时也可以先按菜名记下；
2. 系统立即把这顿饭视为完整记录，不显示欠账或完成度；
3. 候选餐按数量渐进展示，不让“加入已有餐 / 另记一顿”变成每次必填的技术字段；
4. 刚提交错误时可在短时间内撤销本次快速记录产生的餐食或菜品，不把库存和菜单等独立事实混入撤销；
5. 评分以时间线内的非阻塞轻提示出现，照片、参与家人和评论继续作为主动补充项；
6. 后端根据真实餐食次数、日期和评分实时计算家庭记忆；
7. “吃过的”页面用照片、家庭语言和事实证据表达回报。

采用的架构是继续让现有 `MealLog` 表示“一顿饭”，让 `MealLogFood` 表示这顿饭里的 Food。不新增 Meal 表，不新增家庭记忆持久化表，不使用 AI 判断家庭记忆事实。

## 二、当前实现判断

### 2.1 已有正确基础

- `MealLog.food_entries` 已经支持一顿饭包含多道 Food。
- `POST /api/meal-logs` 已经能创建多条 `MealLogFood`。
- 餐食记录已经有家庭隔离、操作者字段、活动日志、媒体绑定、逐菜评分和参与成员。
- 做菜完成会生成餐食记录，菜单计划可关联 `meal_log_id`。
- 前端已经把最小 MealLog 视为有效记录，并用“基础记录 / 已丰富”替代旧的“待补充 / 已完成”。
- AI `meal_log` 草稿已支持多道 Food 和可选成品库存扣减。

### 2.2 仍然存在的问题

- 页面仍以“基础记录数量、已丰富数量、未评分、照片数、评论数”表达完成度，欠账心智只是换了名字。
- 记录成功后自动进入大型补充弹窗，用户仍必须先处理一个四段表单才能回到生活流程。
- 时间线显示“菜单计划 / 手动补录”等技术来源，而不是突出家庭成员关心的菜品、照片与共同用餐信息。
- Food 快速记餐一次只围绕一道 Food 组织，缺少共享的多菜组合器。
- 首页“记一餐”只能先搜索已有 Food；第一次吃的新菜、临时外食或尚未建档的剩菜找不到 Food 时，记录流程会中断。
- 非计划 `/api/meal-logs/quick-add` 当前会静默追加到同日同餐别最新 MealLog，违反“显式组合、绝不静默合并”的产品决定。
- 当前没有整顿饭删除或短时撤销；完全误记后只能把记录改造成另一顿，和低维护目标冲突。
- `MealLog` 没有乐观并发版本，无法可靠处理多成员同时追加或纠正菜品组合。
- 现有评分、参与人和媒体更新会直接修改 `MealLogFood` 或 `MediaAsset` 子行；仅重复赋值 `MealLog.updated_by` 不保证 SQLAlchemy 一定更新父行，因此新增 `row_version` 后还必须显式推进父版本。
- 现有 `MealLogFood` 使用稳定 entry ID 承载评分；如果历史组合纠错只按 `food_id` 全量删除重建，会丢失评分、备注和 UI 身份。
- 普通 MealLog 创建没有业务幂等键；网络超时后的重试可能重复创建 MealLog、重复扣库存或重复完成计划项。
- MealLog 前端仍使用设备本地 `todayKey()`，而后端家庭日期固定使用 `Asia/Shanghai`，午夜附近可能出现“今天”和洞察窗口不一致。
- 家庭记忆尚无后端规则接口；在前端基于当前已加载列表计算会受到查询范围和分页影响。
- MealLog 当前不属于全局搜索索引实体；本需求不应顺带扩展向量或全局搜索索引。

## 三、目标与非目标

### 3.1 目标

- “吃过什么”本身即为完整记录。
- 一次提交可记录一顿饭的多道 Food。
- 做菜完成、菜单完成、Food 快速记餐和外卖“再吃一次”最终进入同一家庭时间线。
- 同日同餐别存在候选记录时，由用户明确选择加入或另记，但只在确有候选时展示必要决策。
- 找不到已有 Food 时允许在 Composer 内按菜名快速创建最小 Food，并在同一事务中继续记餐。
- 餐食菜品组合支持后续添加、移除和修改份数。
- 直接快速记餐后提供 15 分钟命令级撤销，只回退本次新建餐或新加菜品。
- 评分以非阻塞方式收集，为“值得回购”等记忆提供可信证据。
- 家庭记忆由确定性规则实时派生，并展示计算证据。
- 家庭记忆和时间线优先使用真实餐食照片或 Food 封面。
- 所有读写继续按当前 membership 的 `family_id` 隔离。

### 3.2 非目标

- 不新增成员身份、儿童档案或成员级喜好反馈。
- 首期不生成“孩子最喜欢”等无法由当前数据证明的结论。
- 不使用大模型生成、选择或润色家庭记忆。
- 不持久化、收藏、隐藏或定期推送记忆卡片。
- 不强制同一家庭、日期和餐别只能有一条 MealLog。
- 不按时间窗口自动合并记录。
- 不提供无条件的任意历史 MealLog 删除；首期纠错范围是餐食详情编辑和直接快速记录的 15 分钟撤销。
- 不在 MealLogFood 中持久化脱离 Food 的自由文本菜名。
- 快速记录不扣减库存、不完成菜单；修改历史餐食组合也不自动恢复库存或撤销已完成菜单。
- 不为 Recipe cook、AI 审批或其他既有领域命令新增通用逆向事务；它们首期只复用餐食归组和详情纠错能力。
- 不新建通用产品埋点平台。
- 不把 MealLog 加入全局或向量搜索索引；首期继续使用“吃过的”当前数据集内搜索。
- 不在本需求中引入可配置家庭时区；前后端统一使用当前业务时区 `Asia/Shanghai`。

## 四、已确认的产品决策

### 4.1 记录与回报一起建设

完整目标分成两个可独立验收的交付阶段：

1. 记录减负：让一顿饭更快、更准确地进入时间线；
2. 记忆回报：让积累的数据产生可解释的家庭价值。

两阶段属于同一闭环，不能用仅改文案或仅加记忆卡代替。

### 4.2 只做家庭级记忆

当前数据只知道一顿饭有哪些参与人和每道 Food 的总体评分，不知道某位成员喜欢哪道 Food。首期只使用家庭级表达：

- 家里最近常吃；
- 一个月没吃；
- 值得回购、值得再点或值得再去；
- 最近常选。

### 4.3 记忆实时派生

家庭记忆由后端读取真实 MealLog 后实时计算：

- 不建 `family_memories` 表；
- 不运行定时任务；
- 餐食被补录、纠正或评分后，下次读取自然得到新结果；
- 证据不足时返回空结果，不用弱结论填满页面。

### 4.4 一顿饭显式组合

- 同一天、同一餐别允许存在多条 MealLog。
- Meal Composer 一次可以选择多道 Food。
- 没有候选时直接使用 `target.kind = new`，不展示归组控件。
- 只有一条候选时使用“和今晚这顿一起记吗？”一类家庭语言确认，同时展示该餐已有菜名和图片；早餐、午餐、晚餐主操作为“记在一起”，加餐主操作为“另记一顿”。
- 多条候选时才展开选择列表；正餐预选最近一条，加餐预选“另记一顿”。
- 所有默认值都必须在提交前可见且可改。
- “明显候选”首期只表示恰好一条同家庭、同业务日期、同餐别记录，不根据 `created_at`、菜名或时间窗口猜测用户意图。
- 后端不再按日期和餐别自行查找并静默追加。
- Composer 通过候选读取接口取得完整候选集，不根据已加载的时间线、筛选结果或分页数据猜测候选数量。

### 4.5 记录后使用行内轻评分

记录提交成功后：

- 先关闭 Composer，并把新记录展示在时间线；
- 新记录临时展开逐菜评分区域；
- 用户可以评分，也可以直接滚动、导航或离开；
- 不打开大型补充弹窗；
- 不显示“跳过后待补充”、未完成、红点或任务数量；
- 照片、参与家人和评论留在餐食详情中主动编辑。

行内评分只是一条可忽略的邀请，不改变 MealLog 的有效性。

### 4.6 来源降为追溯信息

时间线不显示“菜单计划、手动补录、做菜生成、AI 创建”等来源 badge，也不提供来源筛选。

来源关系与活动日志继续保留。详情页可在确有追溯价值时使用家庭语言展示，例如“完成做菜后自动记下”，但不得把来源当成记录状态或主要元信息。

### 4.7 支持组合纠错

餐食详情支持：

- 添加 Food；
- 移除 Food；
- 修改 servings；
- 至少保留一道 Food。

历史详情不提供无条件删除整顿饭。修改记录只修正“这顿吃了什么”，不反向补偿已经发生的库存扣减、CookLog 或菜单完成事实；刚提交错误使用下述快速记录撤销，不把历史编辑伪装成库存回滚。

### 4.8 找不到 Food 时先按菜名记

- Composer 的 Food 输入同时承担搜索和新建入口，不把用户导航到完整 Food 编辑器。
- 有匹配结果时优先选择现有 Food；无合适结果时显示“按‘酸汤牛肉’记下”一类动作。
- 用户只需提供菜名；入口无法确定来源时，再补一次“家里做 / 外卖 / 外食 / 买来即食”的轻量类型选择。
- 后端在快速记录事务内创建真实、当前家庭的最小 Food，再创建 MealLogFood；不保存游离文本，不通过两个独立请求留下半成品。
- 最小 Food 立即是有效资料，不显示“待完善”或欠账；其他图片、来源和描述以后均为主动增强。
- 快速记录允许创建 `selfMade + recipe_id = null` 的家常菜身份，只代表“吃过这道菜”，不生成 Recipe 草稿。现有 Recipe 同步生成的 Food 仍遵守 `recipe_id` 唯一约束；同名项不自动合并。
- 只出现过一顿、未收藏、未补库存且没有来源信息的最小 Food 不进入首页 Food 推荐；再次食用、收藏、补库存或补充来源后自动取得推荐资格，不增加新的持久化状态。

### 4.9 撤销快速记录，不裸删 MealLog

- 直接 `POST /api/meal-logs/record` 成功后提供 15 分钟“刚记错了，撤销”动作。
- 快速记录只允许新建一顿或向已有餐追加 Food；不修改原有 entry、参与人、备注、媒体或评分。
- 撤销按记录 operation 保存的新增 entry ID 删除本次影响：没有其他 entry 的新 MealLog 被删除；已有餐或已被家人继续追加的新 MealLog 只移除本次新增 entry。
- 同次创建的最小 Food 在未被修改且没有其他引用时一并删除；否则保留 Food 资料，撤销仍视为成功，因为用户要恢复的是餐食记录而非强制销毁资料。
- 快速记录不扣库存、不完成菜单，因此无需补偿这些独立业务事实。库存、菜单计划、Recipe cook 和 AI 审批只提供各自的查看或纠错入口。
- 撤销作用于 record operation，不接受客户端直接按 MealLog ID 猜测影响范围；超时、无权限或已撤销时不重放写入。

## 五、页面信息架构

### 5.1 页面命名与主任务

用户可见名称使用“吃过的”，不使用“餐食记录中心”。页面只承担三件事：

1. 快速记一餐；
2. 回看家庭时间线；
3. 查看由历史产生的家庭记忆。

页面头提供唯一主 CTA“记一餐”。

### 5.2 家庭记忆区域

证据足够时，在时间线之前显示最多 4 条互不重复的记忆。每条包含：

- 记忆类型；
- Food 名称；
- Food 真实封面；
- 关键证据，例如“近 30 天吃了 4 顿”“上次是 38 天前”“2 次评分，平均 4.5 分”。

页面不展示“记忆总数”或空记忆占位卡。接口返回空数组时，整个区域不渲染。

### 5.3 时间线条目

一条 MealLog 只呈现：

- 日期和餐别；
- Food 组合；
- 有值时才显示的评分摘要、参与人数、照片数量、记录人；
- 照片或封面图；
- 新记录可出现的行内轻评分。

明确删除：

- 基础记录 / 已丰富；
- 待补充数量；
- 未评分；
- 空的照片、评论和参与人计数；
- 来源 badge；
- “补充这餐”作为默认主动作。

### 5.4 图片策略

家庭记忆：

1. 使用命中 Food 的当前封面媒体；
2. 无封面时复用现有 `MediaWithPlaceholder`。

时间线：

1. 优先使用 MealLog 的第一张真实餐食照片；
2. 否则使用第一道 Food 的封面；
3. 多道 Food 使用图片上的 `+N` 表达，不并排堆叠多张小图；
4. 无图时使用现有占位策略。

所有缩略图必须使用稳定 `aspect-ratio`、`object-fit: cover` 和固定尺寸，避免加载导致布局位移。图片 URL 继续通过现有 media serializer、`resolveAssetUrl` 和 `MediaWithPlaceholder` 处理。

### 5.5 响应式

桌面端：

- 家庭记忆使用一行紧凑图片条目；
- 时间线保持适合扫描的密度；
- 不恢复四块大指标卡。

移动端：

- 使用现有 `MealLogMobileView` 的独立结构；
- 家庭记忆可横向展示，但首屏必须看到下一段时间线的内容提示；
- 主 CTA、评分星级和条目点击区不小于 44px；
- 处理底部导航和 safe area；
- 不把桌面两栏弹窗压缩到手机。

## 六、共享记录规则与分层视图

### 6.1 入口

以下入口复用候选识别、Food 解析和 MealLog 写入规则，但不强制共用一份大表单或同一副作用事务：

- “吃过的”页面的“记一餐”使用完整多 Food Composer；
- Food 卡片的“记到今天”和外卖、外食“再吃一次”使用预填 Food 的紧凑快速记录视图；
- 菜单计划的“记到今天”仍由计划完成命令拥有状态变更；
- 做菜完成确认仍由 Recipe cook 事务拥有 CookLog、食材库存和计划状态。

入口可以预填 Food、日期、餐别、计划项和做菜结果；日期、餐别和候选判断共用同一规则，但计划和做菜不能借快速记录顺带改变库存或计划状态。

### 6.2 字段与默认值

- 日期：使用 `businessDateKey(new Date(), 'Asia/Shanghai')` 计算业务今天，可切换近期日期；
- 餐别：按当前时间或入口上下文预选；
- Food：使用可输入 combobox 搜索、多选、移除和调整份数，无匹配时可按名称创建最小 Food；
- 目标：由候选数量决定是否展示新建或加入确认，不作为固定表单字段常驻；
- 成品库存：快速记录表单不显示扣减开关或数量输入；记录成功后可提供次级“处理库存”入口，打开独立库存动作，不与“吃过什么”绑定提交；
- 可选内容：不在 Composer 首屏要求照片、家人或评论。

### 6.3 候选 MealLog

候选必须满足：

- 属于当前家庭；
- 日期与 Composer 日期一致；
- 餐别一致；
- 仍能被当前请求重新读取。

候选按以下三态呈现：

1. `0` 条：不渲染目标选择，提交时显式发送 `target.kind = new`；
2. `1` 条：在 Food 组合下方显示一句确认，正餐使用“和今晚这顿一起记吗？”，加餐使用“要和这次加餐记在一起吗？”；同时显示候选已有 Food 名称、真实餐食照片或第一道 Food 封面，按钮直接表达“记在一起 / 另记一顿”；
3. `2+` 条：才展开候选列表，每项展示餐别、已有 Food 组合、图片和记录时间；列表末尾始终保留“另记一顿”。

正餐多候选时预选最近一条，加餐预选新建。单候选确认和多候选列表都必须在提交前展示最终完整组合，但不使用 `MealLog ID`、`target` 或“existing”等技术文案。

日期和餐别稳定后，前端请求 `GET /api/meal-logs/candidates?date=&meal_type=`；接口固定按当前家庭、日期和餐别返回所有可加入候选及其 Food 图片摘要。提交时后端仍必须重新读取并锁定用户明确选择的目标；候选缺失或过期不能触发后端自动改选另一条 MealLog。

候选图片统一使用稳定比例缩略图：优先 MealLog 第一张真实餐食照片，其次第一道 Food 封面，最后复用 `MediaWithPlaceholder`。单候选不得为了确认再打开嵌套弹窗；移动端在 Composer 内使用可点击确认行，多候选在同一滚动区展开，避免遮挡键盘和底部安全区。

### 6.4 最小 Food 快速创建

用户输入名称后，combobox 继续展示当前家庭的搜索结果。没有合适结果时，在结果末尾提供“按‘{name}’记下”，而不是显示空状态或要求先去 Food 库建档。

快速创建只收集：

```text
client_food_id: Composer 内临时 ID
name: trim 后 1..120 字符
type: selfMade | takeout | diningOut | readyMade
```

入口已知 Food 类型时直接预填；首页通用入口无法判断时显示四个短选项“家里做 / 外卖 / 外食 / 买来即食”，默认不替用户猜。`instant` 和 `packaged` 仍可在完整 Food 编辑器中细化，快速入口的“买来即食”落为 `readyMade`。

后端创建时使用与 `FoodType` 对应的稳定默认分类，其他列表、文本、库存和媒体字段使用现有空默认值。名称相似只用于前端提示，不由后端静默合并到同名 Food；用户明确选择已有项才复用。

新 Food 和 MealLog 属于同一快速记录事务。任一名称、类型、家庭边界或目标版本校验失败时两者一起回滚。成功后响应返回已创建的 `FoodOut`，前端更新或失效 Food 查询，不在本地伪造正式 Food ID。

### 6.5 提交后撤销入口

快速记录成功后，不强制把用户跳转到“吃过的”。App 级共享餐食动作状态在当前页面显示轻量结果条：主文案“已记下”，包含本次 Food 名称或缩略图，并提供“撤销”“查看记录”和可完全忽略的紧凑评分。结果条不使用危险红色制造压力，也不把评分变成下一步任务。

- 撤销入口在 record operation 的 `revertible_until` 前可用，并按秒级倒计时更新可用性；服务端时间是最终判断。
- record 响应立即写入共享状态；`GET /api/meal-logs/record-operations?active=true` 在首页、Food、食材 / 成品库存、外卖 / 外食和历史页等可发起普通 record 的页面启用，刷新后恢复当前操作者最近一条仍有效的结果条，不能只依赖瞬时 toast。
- “查看记录”导航到返回的 MealLog；历史页也可把 active operation 映射到对应时间线条目，但不要求用户先切换到历史页才能发现撤销。
- 移动端提示不得遮挡底部导航、Composer 或 safe area，触控目标不小于 44px。
- 撤销提交中禁用重复点击并显示明确进度；成功后移除新建餐或刷新已有餐，失败时保留当前时间线和可读错误。
- Recipe cook、菜单完成、AI 审批和历史详情编辑不写入这份普通 record 结果状态，也不显示快速记录撤销；它们首期只提供各自的“查看记录 / 修改记录”。

## 七、后端领域设计

### 7.1 持久化模型

给 `MealLog` 新增：

```text
row_version: Integer, not null, default 1
```

并设置 SQLAlchemy `version_id_col`。新增 Alembic migration，不修改旧 migration。

同时新增：

- MealLog `(family_id, date, meal_type, created_at)` 复合索引，覆盖时间线范围、候选餐和洞察日期过滤；
- MealLogFood `(meal_log_id, food_id)` 非唯一复合索引，支持组合 diff 和按一顿饭去重聚合。

不新增 Meal 或 Memory 表。不强制新增 `(meal_log_id, food_id)` 唯一约束，因为历史数据可能已有重复 entry 且其评分、备注合并语义不明确。新写入在 service 层拒绝同一 payload 的重复 `food_id`，洞察查询按 MealLog 和 Food 去重。

为保证快速记录可安全重试及短时撤销，新增技术性命令表 `meal_log_record_operations`：

```text
id
family_id
client_request_id
request_hash
status: applied | reverted
target_kind: new | existing
meal_log_id: not null，保留原业务 ID，不设级联删除外键
created_entry_ids_json
created_food_ids_json
result_json
revert_result_json: nullable
created_by
applied_at
revertible_until
reverted_at
reverted_by
created_at / updated_at
unique (family_id, client_request_id)
```

该表同时承担幂等 claim 和快速记录的短时恢复边界，不是 Meal 或家庭记忆模型。`result_json` 保存首次 record 的精确响应，`revert_result_json` 保存首次成功撤销的精确响应；除此之外不保存任意对象快照，也不记录库存或计划补偿数据。

operation 必须在任何 Food、MealLog、entry 或活动副作用之前 claim。existing target 直接使用请求中的 MealLog ID；new target 在 claim 前通过 `create_id("meal")` 预分配 MealLog ID，operation claim 和后续 `MealLog` 创建必须使用同一个 ID。并发相同 request ID 的失败 claim 方丢弃自己的未落库预分配 ID，并重放唯一胜者保存的 operation/result；已提交 operation 的 `meal_log_id` 永远非空。

### 7.2 领域服务

拆分两个聚焦 service，避免一个通用 command 同时承担快速记录、历史纠错和其他业务副作用：

- `record_meal`：锁定并校验当前家庭的已有 Food 和目标 MealLog；在同一事务创建最小 Food；只新建 MealLog 或追加新的 MealLogFood；记录 operation、活动日志和 15 分钟截止时间；不处理库存、计划、媒体、参与人或原有 entry 修改。
- `update_meal_composition`：供餐食详情纠错使用；在版本校验后按 entry ID 做完整 diff，保留已有 entry 的 ID、rating 和 created_at；不生成撤销 operation，不反向补偿库存或菜单。
- 两个 service 修改已有 MealLog 时都通过统一 helper 恰好推进一次父版本并维护 `updated_by`；新建 MealLog 保持默认 `row_version = 1`。所有写入在调用方事务内完成，失败整体回滚。

路由只负责认证、schema、HTTP 错误映射和 commit，不继续扩大 `backend/app/api/meal_logs.py` 的业务规则。

Recipe cook 继续拥有 CookLog、食材库存和菜单完成事务，但复用候选校验与 MealLog entry 写入 helper，避免出现第二套归组语义。

AI MealLog 审批提交继续走 `draft -> approval -> commit`，其 commit handler 复用 `record_meal` 或 `update_meal_composition` 的底层写入 helper，但不创建面向普通 UI 的可撤销 record operation；模型仍不能直接调用写工具。

本需求不创建 MealLog 搜索文档，也不为 MealLog 调用 `enqueue_search_index_job`。最小 Food 创建和撤销删除继续复用现有 Food 搜索索引新增 / 删除队列，保证之后能搜到且不留下无效索引。当前“吃过的”搜索继续在已加载 MealLog 数据集中完成；若以后引入服务端分页，再单独设计 MealLog 过滤 API，不借用无关的全局向量搜索。

### 7.3 快速记录与候选命令

新增：

```text
GET  /api/meal-logs/candidates?date=&meal_type=
POST /api/meal-logs/record
```

候选接口只返回当前家庭、相同日期和餐别的候选 MealLog，包含稳定 ID、`row_version`、已有 Food 摘要和图片回退所需媒体。它不按客户端当前列表、创建时间或 Food 相似度自动挑选目标。

`POST /record` 只表达“这次又吃了什么”，请求契约为：

```text
client_request_id
date
meal_type
target:
  kind: new
  或
  kind: existing
  meal_log_id
  expected_row_version
new_foods[]:
  client_food_id
  name
  type
entries[]:
  food_id, 引用已有 Food 时提供
  或 client_food_id, 引用本请求 new_foods 时提供
  servings
```

规则：

- `entries` 只包含本次新吃的 Food，至少一项；target 为 existing 时不接受旧 `entry_id`，不能移除或编辑既有 entry；
- 每个 entry 必须且只能提供 `food_id` 或 `client_food_id`；`client_food_id` 在本请求内唯一且必须命中 `new_foods`；
- `new_foods` 名称 trim 后必须为 1 至 120 字符，类型只接受快速入口允许的四种 FoodType；`selfMade` 允许 `recipe_id = null`，后端不生成 Recipe，也不因同名自动改绑已有 Food；
- target 为 existing 时，后端验证家庭、日期、餐别和 `expected_row_version`；候选过期返回 `409`，前端重新读取候选并要求确认；
- 新建或新追加的 entry 不得重复同一 `food_id`；历史重复 entry 不改写；
- 内联 Food 的 `family_id`、审计字段、默认分类和其他默认字段只由服务端生成；Food、MealLog、operation 和活动日志同一事务提交；
- 快速记录不接受库存扣减、计划项、参与人、媒体、评分、备注或心情字段；新建 MealLog 的参与人由服务端默认当前操作者，其他内容由各自已有命令或餐食详情处理。

new target 的 claim 生命周期固定为：标准化请求并计算 hash → `create_id("meal")` 预分配候选 MealLog ID → 以该 ID 插入 / flush operation → 锁定业务资源并创建使用同一 ID 的 MealLog。existing target 则把请求 MealLog ID 传给 claim。唯一约束冲突时回滚失败 claim，重新读取胜者 operation；只有胜者能继续产生业务副作用。

命令成功统一返回 `200`：

```text
meal_log: MealLogOut
created_foods: FoodOut[]
outcome: created | appended | replayed
operation:
  id
  status
  revertible_until
  can_revert
```

新增历史纠错接口：

```text
PATCH /api/meal-logs/{meal_log_id}/composition
```

它接收完整 `food_entries` 和必填 `expected_row_version`，按 entry ID diff 支持添加、移除和调整 servings / note，至少保留一道 Food；不创建 record operation，不回滚库存或菜单。`MealLogOut`、前端 `MealLog` 和 serializer 同步增加 `row_version`。

版本冲突统一返回 `409`，detail 包含稳定错误 code、最新 `MealLogOut` 和 recovery hint，前端不得依赖英文异常文本判断冲突。前端迁移完成后删除旧 quick-add 的静默查找并追加行为，不保留另一套自动合并规则。

### 7.4 父版本推进与既有更新接口

新增 `bump_meal_log_collection(meal_log, user_id)`，显式执行：

```text
meal_log.row_version += 1
meal_log.updated_by = user_id
```

所有修改 MealLog 业务视图的路径都必须先校验 expected version，再恰好调用一次该 helper：

- `record` 追加 MealLogFood；
- `PATCH /api/meal-logs/{id}/composition` 添加、删除或修改 MealLogFood；
- `PATCH /api/meal-logs/{id}` 更新参与人、备注、心情、媒体或评分；
- recipe cook 向已有 MealLog 追加 entry；
- AI `update_details` 和 `rate_food` commit；
- 未来任何 deduction suggestion 或 MealLog media 变更。

不能依赖“重新赋值同一个 updated_by”触发父表 UPDATE。同一用户连续评分时该值可能没有变化，只有显式 bump 才能保证其他客户端看到新版本。

REST `UpdateMealLogRequest` 增加必填 `expected_row_version`。现有 AI `meal_log.v1` 待审批草稿继续使用 `baseUpdatedAt` 兼容校验；AI adapter 先发现并按序锁定 Food，再锁 MealLog，在锁内验证时间戳、读取当前 `row_version` 并调用共享 service。首期不强制把存量 AI 草稿升级为新 schema，避免同版本切断待审批请求。

所有 MealLog stale 响应由一个共享完整序列化边界生成：

```python
build_meal_log_conflict_detail(
    db,
    *,
    family_id: str,
    meal_log_id: str,
    code: str,
    recovery_hint: str,
) -> dict
```

主动 expected-version 不匹配和 SQLAlchemy `StaleDataError` 都返回同一 detail 形状。`StaleDataError` 处理必须先 `db.rollback()`，再重新读取当前家庭的 MealLog、entries/Food、deduction suggestions 与 MealLog media，最后通过 `serialize_meal_log(..., media_map)` 生成完整 `MealLogOut`；不得在 route 中手拼缺照片或缺评分的简化 current。

### 7.5 快速记录幂等与撤销语义

`client_request_id` 由快速记录视图打开一次时生成并保存在草稿 state 中，失败重试必须复用，用户明确放弃并重新开始才生成新 ID。后端对标准化业务 payload 计算 SHA-256：

- hash 包含 target、expected row version、new Food 和本次新增 entry；不包含 `client_request_id` 和 transport-only 字段；
- 同一家庭、同一 request ID、相同 hash 返回已保存 `result_json`，outcome 为 `replayed`，不重复创建 Food、MealLog、entry 或活动；
- 同一 request ID、不同 hash 返回 `409 idempotency_key_reused`；并发同一 request ID 由唯一约束决出唯一写入者；
- claim 参数必须包含最终 `meal_log_id`：existing 使用请求目标，new 使用 claim 前预分配 ID；并发 loser 只能读取 winner 的 ID 和 `result_json`，不得用自己的预分配 ID继续写入；
- record operation、内联 Food、MealLog、entry 和活动日志在同一事务中提交；已撤销 operation 收到原 record 请求时返回 `409 record_operation_reverted`，不得重新应用。

前端提交中禁用重复提交，但不能把按钮禁用当作幂等保障。

新增：

```text
GET  /api/meal-logs/record-operations?active=true
POST /api/meal-logs/record-operations/{operation_id}/revert
```

`GET` 只返回当前操作者在 15 分钟窗口内、状态为 `applied` 的快速记录摘要，并重新计算 `can_revert`；返回 operation ID、关联 MealLog ID、Food 摘要、`revertible_until` 和 `can_revert`，不返回内部 entry ID 列表。前端据此在所有普通 record 入口页面恢复最近结果条，并可在历史页挂回对应时间线条目；家庭 Owner 仍可通过已知 operation ID 调用 revert，但首期不在普通时间线批量展示其他成员的撤销入口。

撤销规则：

- 只允许 operation 的原操作者或家庭 Owner，在 `revertible_until` 之前发起；所有读取继续约束当前 `family_id`；
- 先锁 operation 并完成家庭、操作者 / Owner、状态和截止时间校验；再预读 effect entry 对应 Food ID，与 `created_food_ids_json` 合并后按 ID 排序锁定所有 Food；之后才锁关联 MealLog，并重新校验 effect entry 仍属于该 MealLog；
- 删除 `created_entry_ids_json` 中仍存在且仍属于该 MealLog 的 entry。删除后为空则删除 MealLog；若该 MealLog 已有家人继续新增的 entry，则保留 MealLog 和其余 entry；
- 撤销后保留的 MealLog 必须恰好推进一次父版本；删除整顿新餐时不再执行无意义版本更新；
- entry 删除后，在已经锁住的 Food 上重新检查创建默认值、版本及 MealLog、计划、库存、购物、媒体等全部引用；仅通过检查的本次最小 Food 才删除，否则保留 Food且撤销仍成功。不得先锁 MealLog 再尝试锁 Food，也不得在未锁 Food 时做“检查后删除”；
- 快速记录不产生库存、计划或 CookLog 副作用，因此撤销不恢复这些领域事实，也不需要对象快照或全量三方恢复；
- 首次撤销成功把 operation 标记为 `reverted`，记录 `reverted_at / reverted_by`，把完整响应写入 `revert_result_json`，并新增 REVERT 活动，不删除原活动审计；对已撤销 operation 重复调用不重新读取或修改业务对象，直接返回该已保存结果，仅把 `replayed` 置为 `true`。

撤销响应为：

```text
status: reverted
meal_log: MealLogOut | null
removed_food_ids: string[]
replayed: boolean
```

### 7.6 做菜完成扩展

Recipe cook 的确认契约增加可选目标：

```text
target_meal_log_id
expected_meal_log_row_version
```

未提供目标时新建 MealLog；提供目标时必须验证家庭、日期、餐别和版本，再把本次 Food 加入已有组合。Recipe cook 继续使用现有 `completion_request_id` 幂等机制，必须把 target MealLog ID 和 expected version 加入 canonical completion hash 与持久化结果，重放时不得再次追加 entry。

非 Recipe 菜单完成不新增 completion operation 表，但必须对响应丢失安全收敛。服务先无锁预读 plan item 以发现 Food 和已保存 MealLog ID，再按全局顺序锁定 Food、发现到或请求中的目标 MealLog、最后锁 plan item 并重新校验发现集合。锁后的第一项 plan 业务判断是已完成重放，必须先于 base timestamp stale 校验：若 item 已是 `cooked` 且保存了 `meal_log_id`，重试没有显式 target 时返回该当前 MealLog；显式 target 与已保存 `meal_log_id` 相同也返回当前 MealLog；显式 target 不同返回 `409 food_plan_item_already_completed`。仅未完成 item 才继续校验 `food_plan_item_base_updated_at` 并写入，重试不得生成第二顿饭。

待审批的旧 recipe cook 草稿没有目标字段时继续按现有语义新建 MealLog。AI recipe cook 草稿若支持选择已有餐，必须在审批表单中展示该目标并由用户确认，不能由模型静默决定。

Recipe cook 使用独立 completion operation，首期不返回快速记录的可撤销 operation，也不展示“撤销餐食”按钮；否则必须同时逆转 CookLog、食材库存和计划状态，不能只删除 MealLog。

全局锁顺序统一为：命令 / operation claim（如有） -> recipe（如有） -> sorted Food 与库存目标 -> target MealLog -> plan item。`record` 不锁库存或计划；composition、REST details/rating、AI details/rating、MealLog media bind 等写路径也不得先锁 MealLog 再锁 Food。

当待锁 Food 集合只能从 MealLog entry 推导时，采用“无锁发现 Food IDs → 按 ID 排序锁 Food → 锁 MealLog → 重新读取并校验 target-set 未变化”的模式；集合变化则返回结构化 conflict 或按命令既定重试边界重来，不能在持有 MealLog 锁后补锁新发现的 Food。每条路径的首个业务校验都在全部所需锁取得后执行，且 stale version 是锁后的第一项业务校验。

## 八、家庭记忆规则

### 8.1 接口

新增：

```text
GET /api/meal-logs/insights
```

响应项使用稳定枚举：

```text
kind: frequent_recent | missed | repurchase | repeated_choice
food: id, name, food_type, cover media
evidence:
  meal_count
  last_eaten_on
  rating_count
  average_rating
  window_days
```

不返回预先拼好的营销句子。后端返回事实和稳定 kind，前端使用中文映射生成“家里最近常吃”等短文案。

### 8.2 计算口径

所有次数均按 distinct MealLog 计算，同一 Food 在同一顿饭出现多条历史 entry 也只计一次。

历史重复 entry 的评分使用两级聚合，避免重复行放大某一顿饭的权重：

1. 先按 `(meal_log_id, food_id)` 分组，对该顿饭所有非空 rating 求平均，得到一条 meal-level rating；
2. `rating_count` 统计存在 meal-level rating 的 distinct MealLog 数；
3. `average_rating` 再对 meal-level rating 求平均；
4. “最近一次评分”取日期、MealLog created_at、MealLog ID 排序后最新一顿的 meal-level rating。

没有非空 rating 的重复 entry 不进入评分分母。该规则只影响洞察读取，不在 migration 中改写历史评分。

#### 家里最近常吃

- 窗口：后端 `today_for_family(..., timezone_name='Asia/Shanghai')` 得到的业务今天向前 30 天，含边界；
- 门槛：至少出现在 3 顿；
- 排序：餐数降序、最近日期降序、Food ID 升序；
- 最多 3 个候选。

#### 一个月没吃

- 历史至少出现在 2 顿；
- 最近一次距今 30 至 180 天，含边界；
- 超过 180 天不主动翻旧账；
- 排序：历史餐数降序、距今天数降序、Food ID 升序；
- 最多 3 个候选。

#### 值得回购、再点或再去

- Food 类型只包括 `readyMade`、`instant`、`packaged`、`takeout`、`diningOut`；
- 至少有 2 次有效评分；
- 平均评分至少 4.0；
- 最近一次评分至少 4.0；
- 最近一次用餐不超过 180 天；
- `readyMade`、`instant`、`packaged` 映射为“值得回购”；
- `takeout` 映射为“值得再点”；
- `diningOut` 映射为“值得再去”。

#### 最近常选

- Food 类型同上；
- 最近 30 天至少出现在 2 顿；
- 评分证据不足以满足“值得回购 / 再点 / 再去”；
- 只陈述次数，不暗示喜欢。

### 8.3 去重与展示数量

页面最多展示 4 条记忆，每个 kind 最多 1 条。若同一 Food 命中多个 kind：

1. 优先保留更强证据的 `repurchase`；
2. `repeated_choice` 永远排除已命中 `repurchase` 的 Food；
3. `frequent_recent` 跳过已被更强类型选中的 Food，选择下一候选；
4. `missed` 与近期类型天然互斥。

最终顺序固定为：`frequent_recent`、`missed`、`repurchase`、`repeated_choice`。没有命中的类型不显示。

## 九、前端工程设计

### 9.1 职责拆分

遵循 `docs/frontend-code-standards.md`：

- Meal Composer 视图负责首页多 Food 记录；Food 卡片入口使用同一模型的紧凑快速记录视图，不把预填 Food 再塞回完整搜索表单；
- `use*State` 管理日期、餐别、Food 选择、候选餐、行内评分展开状态，并保存稳定 `recordClientRequestId`、历史纠错的 base snapshot 和各自未提交草稿；关闭并明确放弃后才清除；
- `use*State` 同时管理最小 Food 临时 ID、类型选择、0 / 1 / 多候选展示态和最近可撤销 record operation；
- `use*Actions` 管理候选读取、快速记录、历史组合更新、record 幂等重试、record 撤销、纠错三方冲突恢复和评分 mutation；
- `*Model` 负责候选展示态、默认归组、历史 entry diff、临时 Food 到 record payload 的转换、重复 Food 校验、图片优先级和记忆文案映射；
- `*ViewModel` 负责时间线、记忆和响应式展示数据；
- 静态餐别与 kind 文案继续放 options 映射。

不把新逻辑继续堆入 `MealLogWorkspace.tsx` 或 `EatTaskBodies.tsx`。

### 9.2 查询和失效

- 在 `frontend/src/api/queryKeys.ts` 新增 meal candidate、active record operation 和 meal insight key；
- 在 API client 增加候选读取、快速记录、历史组合更新、active record operation 读取、record 撤销和 insight 读取；
- 所有快速记录、历史组合修改、record 撤销、评分、做菜完成、菜单完成和 AI MealLog 审批成功后失效 meal logs、相关日期餐别的 meal candidates、meal insights、Food recommendations、activity highlights 及已有相关 key；
- record 创建或撤销最小 Food 时同步失效 Food 列表、Food 搜索和依赖 Food 的已有 key；推荐资格由服务端按使用次数和 Food 状态重新计算，不手工向多个缓存写入不完整对象；
- Food 名称、类型或封面变化也必须失效 meal insights，避免记忆卡保留旧文案或旧图片；
- meal insights 仅在“吃过的”历史视图启用，不跟随所有 `needsMealLogs` 页面全局请求；
- 组件和 hook 不写裸 query key。

### 9.3 图片数据

- 家庭记忆接口直接返回 Food 封面媒体 DTO；
- 时间线从 MealLog photos 与当前 Food 数据构建图片候选；
- 图片 URL 使用现有 asset helper；
- 渲染继续复用 `MediaWithPlaceholder`；
- 不在 MealLogFood 中复制可漂移的封面 URL。

### 9.4 业务日期

- Composer 默认日期、时间线“今天”、本周计数和相关测试统一使用 `businessDateKey(now, 'Asia/Shanghai')`；
- 前端不计算 insight 的 30 / 180 天资格，只展示后端 evidence；
- 纯日期加减继续使用 calendar-date helper，不把 `YYYY-MM-DD` 当 UTC instant；
- 测试覆盖设备时区不是 Asia/Shanghai 且业务日期已跨日的场景。

## 十、错误处理

### 10.1 MealLog 并发冲突

历史组合纠错的目标 MealLog 版本变化时返回 `409` 和结构化当前值。前端：

- 显示“这顿饭刚被家人更新”；
- 重新读取最新 MealLog；
- 保留打开 Composer 时的 base snapshot 和用户尚未提交的 draft；
- 以 entry ID 做 base / draft / server 三方合并：只被服务端修改的字段采用 server，只被用户修改的字段采用 draft；
- 同一字段两边改成不同值、用户删除但服务端修改、或服务端删除但用户修改时标记为冲突项，不静默选边；
- 新增 entry 使用前端临时 ID 保留在 draft，只有提交成功后替换为服务端 ID；
- 展示合并后的最终组合和冲突项；
- 必须再次由用户确认，不自动重放写入。

快速记录目标版本冲突时不进入三方合并：重新读取候选，保留本次新增 Food 草稿并要求用户重新选择。历史组合纠错请求超时后重新读取最新 MealLog；若当前组合已与提交结果一致则视为成功，否则以 entry ID 进入三方合并，不猜测写入是否完成。

### 10.2 Food 与库存边界

- Food 被删除、跨家庭或类型不允许时拒绝提交；
- 最小 Food 名称为空、过长、临时 ID 重复或类型不在快速入口集合时整笔拒绝，并保留 Composer 草稿；
- 快速记录不读取或修改成品库存，不因库存版本或单位问题阻断“吃过什么”；
- 需要扣减库存时进入独立库存动作，沿用该动作自己的版本冲突和撤销语义。

### 10.3 计划与做菜冲突

- record 目标 MealLog 日期或餐别不匹配时拒绝加入；
- 菜单计划项已经完成或版本变化时不重复完成，且不由 record 路径修改；
- Recipe cook 任一库存、计划、CookLog 或 MealLog 写入失败时同一事务回滚；
- 不在提交后通过补丁式二次写入修正 MealLog。

### 10.4 家庭记忆读取失败

- timeline 查询和 insight 查询独立；
- insight 失败不阻塞时间线；
- 失败时在记忆位置显示轻量重试；
- 成功返回空数组时不显示空状态或“数据不足”任务提示。

### 10.5 撤销失败

- `record_operation_expired`：显示“撤销时间已过，可以打开记录修改”，不继续显示可点击撤销；
- `record_operation_forbidden`：不泄露其他家庭 operation 是否存在，按现有权限错误风格处理；
- 网络超时：使用同一 operation ID 重试 revert，依赖服务端幂等结果，不在客户端猜测餐食是否已移除；
- 任何失败都不得先乐观删除时间线条目；只有服务端确认撤销后才更新 UI。

## 十一、安全与数据边界

- 所有 Food、MealLog、计划项、成员、媒体和库存引用必须按当前 membership 的 `family_id` 重新查询。
- record operation、内联最小 Food 和撤销涉及的每个 effect ID 也必须重新校验当前 membership 的 `family_id`。
- 不接受客户端传入 `family_id`、`created_by` 或 `updated_by`。
- MealLog 候选只能来自当前家庭、相同日期和相同餐别。
- 图片只使用当前家庭已绑定的 MealLog 或 Food media。
- AI 写入继续遵守 approval，不因共享 service 获得绕过审批的路径。
- 活动日志记录“记录了一顿饭”“调整了餐食内容”或“撤销了刚才的餐食记录”，不把评分、照片缺失记为待办；撤销新增审计，不删除原活动。

## 十二、分阶段交付与发布门槛

### 阶段一：记录减负

范围：

- MealLog `row_version` migration；
- record operation migration、request hash、effect ID 与 15 分钟撤销；
- 候选读取、快速记录和历史组合纠错 service / API；
- entry ID diff、评分保留和显式父版本推进；
- 首页多 Food Composer 与预填 Food 的紧凑快速记录视图；
- 0 / 1 / 多候选渐进式新建 / 加入策略与图片预览；
- 名称优先的最小 Food 事务内创建；
- 组合纠错；
- 直接 record 新建餐和加入已有餐的 entry 级撤销；
- 普通 record 在首页、Food、食材 / 成品库存、外卖 / 外食和历史页共享“已记下 / 撤销 / 查看记录 / 可选评分”结果条，刷新后可恢复；
- 做菜和菜单沿用各自命令的目标 MealLog 能力，不并入快速记录；
- 图片时间线；
- 行内轻评分；
- 移除完成度、欠账和来源表达。
- 前后端业务日期统一为 `Asia/Shanghai`；
- 旧 AI meal-log / recipe-cook 待审批草稿兼容。

发布门槛：

- 所有写入按家庭隔离；
- 多道 Food 一次提交只产生一条 MealLog；
- 相同 record request 重试只执行一次最小 Food、MealLog、entry 和活动副作用；
- 每个已提交 record operation 都有非空 MealLog ID；并发 new-target 相同 request ID 只采用唯一胜者的预分配 ID；
- 无候选不出现归组字段，单候选直接确认，多候选才展开列表；
- 候选数量来自服务端候选读取，不受已加载时间线范围影响；
- 找不到 Food 时可只输入名称和必要类型完成记录，不产生自由文本 MealLogFood 或孤立半成品；
- 快速创建的 `selfMade` Food 不生成 Recipe、不显示待完善；一次食用且无收藏、库存、来源的最小 Food 不进入首页推荐；
- 快速记录不触及库存或菜单；15 分钟内撤销只删除本次新增 entry，保留家人后来新增的内容；
- 撤销、record 和其他 MealLog 写入遵循同一 Food → MealLog 锁序；重复撤销返回首次持久化结果，不受之后的 MealLog / Food 修改影响；
- 保留 entry 的 ID 与评分不会因组合编辑丢失；
- 不再存在静默按日期餐别追加；
- 任一子行或媒体修改都会推进 MealLog 父版本，并发冲突不会覆盖家庭成员的新修改；
- 最小 Food 或目标版本校验失败不会留下半条 MealLog；
- 桌面、390px 手机和关键导航 smoke 通过。

### 阶段二：记忆回报

范围：

- insight repo/service/schema/API；
- 四类规则和证据；
- Food 封面媒体；
- 图片记忆区域；
- query key 和失效；
- 业务数据验收查询。

发布门槛：

- 所有边界日期和阈值有后端测试；
- 证据不足不生成结论；
- 同一 Food 不在首屏重复；
- 图片归属与家庭隔离测试通过；
- insight 失败不影响时间线。

## 十三、验收指标

不新增产品事件表。使用现有业务数据和人工可用性验收。

### 13.1 功能验收

- 最小 MealLog 无照片、评分、家人或评论也始终显示为完整记录；
- 常见快速记餐在进入对应记录视图后不超过 3 个决策步骤；
- 无候选时不出现“加入已有餐 / 另记一顿”，单候选使用带图片和菜名的自然语言确认，多候选才出现选择列表；
- Food 搜索无结果时可以按菜名和一次来源选择继续，保存后生成真实 Food 且不显示待完善；
- 快速创建家常菜不生成假 Recipe；一次性最小 Food 不进入首页推荐，满足重复食用、收藏、库存或来源任一条件后才取得资格；
- 多道 Food 只提交一次业务 mutation；
- 直接 record 成功后可在 15 分钟内撤销；加入已有餐的撤销只删除本次新增 entry，不删除原有 MealLog，也不触及库存或菜单；
- 普通 record 从任一入口成功后都在当前页面看到共享结果条，无需猜测并切换到“吃过的”；Recipe cook、菜单完成和 AI 审批不会误显示普通 record 撤销；
- 行内评分可完全忽略且不留下任务状态；
- 时间线不出现来源 badge、基础 / 已丰富、待补充或未评分；
- 记忆卡显示可核对的次数、日期或评分证据。

### 13.2 人工可用性验收

使用手机视口连续完成以下测试：

- 单道 Food 快速记餐；
- 三道 Food 组合记餐；
- 无候选直接记下且不出现归组控件；
- 单候选通过菜名和图片确认加入；
- 多候选展开选择并另记一顿；
- 搜不到 Food 时按菜名快速创建并记下；
- 撤销刚新建的一顿；
- 撤销刚加入已有餐的菜，确认原餐保留；
- 并发冲突后重新确认。

预填 Food 的快速记录以中位数不超过 10 秒为目标；首页多 Food 记录不超过 3 个决策步骤；无匹配 Food 的名称快速创建以中位数不超过 15 秒为目标。库存、菜单完成、撤销和并发恢复场景不计入快速路径目标。

### 13.3 上线后业务数据观察

通过 MealLog 与 MealLogFood 查询观察：

- 多道 Food MealLog 占比；
- 新记录 24 小时内获得至少一个评分的比例；
- 每周有餐食记录的家庭数和记录日期数；
- 至少命中一条家庭记忆的活跃家庭比例；
- 各 insight kind 的命中数量。

这些指标用于比较上线前后趋势，不在没有基线时承诺虚假增长百分比。

## 十四、测试矩阵

### 14.1 后端

- migration upgrade 与当前数据兼容；
- 多 Food 新建与序列化；
- record 内联最小 Food 的名称、类型、临时 ID 校验，成功返回正式 Food，任一步失败整笔回滚；
- record 创建 `selfMade + recipe_id = null` 时不生成 Recipe，普通 Recipe 同步 Food 的唯一关系不受影响；
- 最小 Food 创建与撤销删除正确写入 Food 搜索索引任务，不创建 MealLog 搜索文档；
- 同名 Food 不静默复用、已有 Food 与内联 Food 混合组合、内联 Food 跨家庭不可引用；
- candidate 接口只返回当前家庭、相同日期与餐别的完整候选，不受时间线分页或筛选影响；
- record existing target 只追加新 entry，拒绝旧 entry ID、既有 entry 修改和重复 Food；
- composition correction 按 entry ID diff，保留 ID、rating、created_at，支持删除、新增和原位更新 servings / note；
- 空组合、非法 entry ID、food_id 偷换、非法 servings 拒绝；
- MealLog `row_version` 冲突在 entry/业务状态校验前返回 409；
- 同一用户连续修改 MealLogFood 或媒体仍推进父 row_version；
- REST rating/details、AI update_details/rate_food、recipe cook target 都使用同一父版本 helper；
- record 同 request ID + 同 hash 精确 replay，不重复最小 Food、MealLog、entry 和活动；
- record 同 request ID + 不同 hash 返回 `idempotency_key_reused`；
- 成功 operation 的 `meal_log_id` 非空；new target 在 claim 前预分配并由 MealLog 复用同一 ID；
- 并发 new-target 相同 request ID 只有一个 operation、一个胜者 MealLog ID 和一组业务副作用；loser 重放胜者结果；
- 撤销新建 target 时删除本次 entry；没有其他 entry 才删除 MealLog，已有家人新 entry 时保留 MealLog；
- 撤销 existing target 只删除 operation 记录的新增 entry，保留原 MealLog、原 entry ID 与评分；
- 同次最小 Food 无其他引用且未修改时删除，已补充或复用时保留且撤销仍成功；
- 快速记录和撤销都不读取或修改库存、计划和 CookLog；
- 撤销的 15 分钟边界、操作者 / Owner 权限、跨家庭隐藏、重复撤销 replay 和原 record 不可重新应用；首次撤销后再修改保留 MealLog / Food，重复撤销仍返回首次 `revert_result_json`（仅 `replayed=true`）；
- 真 MySQL 覆盖 record-vs-revert 和 reuse-created-Food-vs-revert，不发生反向锁死、引用竞态或误删 Food；
- active record operation 读取只返回当前操作者仍在窗口内的摘要，刷新后能将撤销入口恢复到正确 MealLog；
- Food、MealLog、成员、媒体、计划项跨家庭拒绝；
- 正餐与加餐只影响前端默认，不改变后端显式 target 校验；
- 最小 Food 仅出现一顿且未收藏、无库存和来源时不进入 Food 推荐，满足任一资格后可进入；
- 独立成品库存动作继续覆盖单位校验、版本冲突和事务回滚；
- 菜单完成继续由计划命令与 MealLog 同事务；服务端提交后响应丢失时，同目标或无显式目标重试返回已保存 MealLog，不重复创建，显式不同目标返回 409；
- Recipe cook 新建 / 加入 MealLog、target 字段进入 completion hash、重放不重复追加与库存回滚；
- 旧 recipe cook 草稿无 target 时仍新建 MealLog；
- AI MealLog commit 继续经过审批、旧 `baseUpdatedAt` 草稿可提交并复用 service；
- expected-version mismatch 与 `StaleDataError` 的 `detail.current` 都是完整 `MealLogOut`，覆盖 entry、rating、row_version、deduction suggestions 和照片；
- composition、details/rating、AI、media bind、record、revert 与 cook/plan writer 均覆盖 discover → sorted Food lock → MealLog lock → target-set revalidation 锁序；
- 四类 insight 的阈值前、阈值点和阈值后；
- 30、180 天边界和 `Asia/Shanghai` 业务日期；
- distinct MealLog 计数和历史重复 entry 的两级评分聚合；
- insight 去重、排序和最多 4 条；
- Food 封面媒体家庭隔离。

### 14.2 前端

- Composer 默认日期、餐别和预选 Food；
- 设备本地日期与 Asia/Shanghai 不同时仍使用业务日期；
- 快速记录生命周期内复用 record client request ID，明确放弃后才生成新 ID；
- Food 卡片预填入口使用紧凑视图，不重新要求搜索 Food；首页入口使用完整多 Food Composer；
- 快速记录视图不出现库存扣减开关或数量输入；记录后的“处理库存”打开独立动作；
- Food 搜索、多选、内联新建、来源类型选择、移除、份数与重复校验；
- 0 / 1 / 多候选分别隐藏目标、显示单行确认和展开列表；正餐与加餐主操作符合既定默认；
- 候选优先 MealLog 图片、再用 Food 封面、最后 placeholder，长菜名和 `+N` 不挤压按钮；
- 提交前显示最终组合；
- record 超时后先以相同 request ID 重试并识别 replay；target 409 后保留新增 Food 草稿、刷新候选并要求重新选择；
- composition correction 409 后保留 base / draft，按 entry ID 三方合并并要求重新确认冲突字段；
- 记录成功先关闭 Composer，再在当前 surface 显示共享 `MealRecordResultBar`；结果条包含“已记下”、Food 图片 / 名称、“撤销”“查看记录”和可忽略评分；
- 首页、Food、食材 / 成品库存、外卖 / 外食和历史页的普通 record 成功都立即显示该结果条；刷新后由 active operation 恢复并按服务端截止时间判断；撤销提交中、成功、过期、403 和网络重试状态完整；
- Recipe cook、菜单完成和 AI approval 不写入普通 record 结果状态，不显示其撤销；
- 撤销成功后正确刷新 MealLog、Food、Food 推荐、insight 和活动缓存，不额外失效库存或计划；失败前不乐观移除时间线；
- 忽略评分不产生状态；
- 组合详情添加、移除、修改份数且至少一项；
- insight kind 文案与证据格式；
- MealLog 图片、Food 封面、placeholder 三层回退；
- 无欠账文案、无来源 badge、无空计数；
- loading、empty、error 状态；
- meal insights 只在历史视图请求，MealLog 或 Food 封面变化后正确失效；
- 375、390、430px 及桌面布局。

### 14.3 验证命令

实现阶段至少执行：

```bash
npm run backend:migrate
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

在开发过程中先运行相关 pytest 和 Vitest，交付前再运行上述完整范围。

## 十五、回滚策略

- 阶段一发布前保留旧数据的可读性；新增 `row_version` 对已有 MealLog 使用默认值 1。
- `meal_log_record_operations` 是追加式技术表；UI 回滚后保留 operation effect 与 `row_version`，避免旧请求身份被重新使用或已撤销命令被再次应用。
- UI 回滚只需恢复旧入口和时间线展示，不删除新字段；新创建的多 Food MealLog 仍符合旧响应结构。
- insight 是只读派生接口，阶段二可独立隐藏前端入口，不需要数据回滚。
- 不通过降级重新启用静默合并；若组合写入出现问题，应关闭新 Composer 写入口并修复领域 service。
- 发布回滚不批量逆转已发生的库存、CookLog、菜单完成和活动日志；用户在有效窗口内发起的单次 record 撤销仍按 operation 契约执行。

## 十六、实施约束

- 先新增权威候选接口并删除后端静默合并，再建设前端 0 / 1 / 多候选交互；不要让已加载时间线决定候选数量。
- 先落地 row_version、父版本 helper、record operation 和 composition entry diff；快速记录并发只要求重新选目标，历史纠错才进入三方合并。
- `record_meal` 只创建或追加 entry；`update_meal_composition` 才执行完整 diff。不要为了少一个 endpoint 再把记录、纠错、库存和菜单合回一个通用 compose。
- 历史 composition 保留 entry ID 与 rating；不得用“删除全部 MealLogFood 后重建”缩短实现。
- 最小 Food 必须由 record service 在同一事务中创建；不要串联现有 `POST /api/foods` 与 record，也不要给 MealLogFood 增加自由文本后门。
- `selfMade + recipe_id = null` 只能通过明确的最小 Food 领域 helper 创建；不要伪造 Recipe 或修改旧 migration。完整 Food 创建表单和 Recipe 同步路径继续使用各自现有校验。
- 撤销按 record operation 保存的 entry ID 删除本次影响；不要新增全量业务快照或无边界的 `DELETE /api/meal-logs/{id}`。
- Recipe cook、菜单完成与 AI approval 首期不复用 record 撤销入口；它们继续使用各自 completion / operation 身份与事务。
- `baseUpdatedAt` 兼容只服务已持久化 AI v1 草稿，新 REST 写入以 row_version 为稳定合同；不要在同一发布中无兼容地切断旧审批。
- 所有“今天”使用 `Asia/Shanghai` 业务日期；不要让 MealLog 页面继续单独使用设备 `todayKey()`。
- 本需求不扩展 SearchDocument / SearchIndexJob 实体范围；不要把页面内筛选误做成全局搜索工程。
- 图片只引用现有 media，不在 insight 或 MealLogFood 中复制封面 URL。
- 规则常量、排序和边界必须集中定义并测试，前端不得再次实现一份统计口径。
- 阶段一和阶段二各自必须保持可发布、可验证，但最终验收以完整“低成本记录到家庭记忆回报”闭环为准。
