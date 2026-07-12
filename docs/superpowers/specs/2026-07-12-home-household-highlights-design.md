# Culina P0.3 首页三问与家庭高亮设计规格

> 日期：2026-07-12
>
> 状态：交互、数据流、迁移与上线方案已逐段确认；经独立审计修订，等待书面规格重新批准
>
> 产品语境：移动优先的中国家庭厨房工具
>
> 业务时区：第一阶段统一使用 `Asia/Shanghai`
>
> 对应产品问题：P0 第三点——首页信息过多，主任务不够聚焦
>
> 前置依赖：PR 72 `feature/home-action-center` 与 PR 73 `feature/inventory-reconciliation`

## 1. 结论

首页继续作为 Culina 的家庭厨房工作台，但从“把所有业务摘要都铺出来”收敛为只回答三个问题：

1. 今天吃什么；
2. 今天必须处理什么；
3. 家里发生了什么。

本期不删除活动审计能力，也不新建第二套家庭动态事实表。`ActivityLog` 继续保存完整审计事实，并增加一组显式、结构化、默认关闭的首页高亮字段。只有业务事务明确写入高亮类型和家庭可读摘要时，该条活动才有资格进入首页；AI 内部步骤、收藏切换、资料同步和普通 CRUD 仍保留审计，但不会重新污染首页。

首页视觉不是重画一套新风格，而是在 PR 72/73 的现有工作台上做信息架构收敛：

- 桌面端保留四项统计，候选充足时同时展示 3 个“今天吃什么”推荐；
- 手机端完整保留现有 Hero、快捷操作和四项统计，只展示 1 个推荐；
- 桌面与手机都保留 7 天紧凑日历；
- 桌面端把问题 2 和问题 3 放在约 `56% / 44%` 的左右两列；
- 手机端问题 2 和问题 3 必须上下单列；
- 首页家庭动态桌面最多 5 条、手机最多 3 条；完整审计统一从家庭工作区查看。

## 2. 目标与成功标准

### 2.1 产品目标

- 用户打开首页后，能按“决定吃什么 → 处理必要事项 → 了解家庭结果”的顺序完成阅读。
- 首页只展示需要行动的事项和已经完成的家庭结果，不展示系统内部流水。
- 保留家庭熟悉的统计、推荐、周计划和手机顶部结构，避免为了减负而丢失核心导航能力。
- 首页家庭动态失败时只影响该局部区域，不阻塞统计、推荐、日历或行动入口。
- 完整审计仍然可筛选、可分页、可追责，并严格按家庭隔离。

### 2.2 可验收结果

- 首页不再发起无上限的 `GET /api/activity-logs`。
- 首页家庭动态全部来自结构化高亮接口，不使用中文摘要猜测、实体类型猜测或前端黑名单。
- 一次用户认可的业务事务最多产生一条首页高亮；失败、拒绝、回滚和幂等重放不会产生重复高亮。
- 桌面端首屏保持四项统计、候选充足时 3 个推荐和完整 7 天紧凑日历；手机端保持原 Hero、快捷操作、四项统计、1 个推荐和可横向滚动的 7 天日历；候选不足按第 6.3 节真实降级，不复制数据。
- 桌面端问题 2/3 为两列，内部均为纵向列表；手机端恢复为上下单列。
- “查看完整记录”进入家庭工作区现有活动查看器，而不是打开首页自有的第二套审计弹窗。

## 3. 与 P0.1、P0.2 及当前 PR 的关系

### 3.1 PR 72：P0.1 首页行动中心

PR 72 已提供本期必须复用的基础：

- 聚合后的 `InventoryActionGroup`；
- `homeEligibleInventoryActionGroups` 与 `homeInventoryActionGroups`；
- 过期、临期、低库存的稳定优先级；
- 集中处理、稍后提醒、暂时保留和日期纠错入口；
- 首页四项统计的新口径；
- 后台任务铃铛与业务提醒的职责分离。

本期不得再建立第二个后端“首页待办聚合”接口，也不得恢复按库存批次平铺的首页提醒。

### 3.2 PR 73：P0.2 快速盘点与采购批量入库

PR 73 已提供本期必须复用的基础：

- 快速盘点和 `scope=suggested` 的建议确认入口；
- 原子采购入库；
- 盘点、采购入库及其撤销的结构化操作记录；
- 行版本、冲突恢复和幂等操作边界；
- Ingredient、非精确 Ingredient 与 Food 的统一产品流程。

首页只复用这些入口与现有数据，不在首屏预取完整盘点明细。用户打开快速盘点后，才请求 reconciliation detail。

### 3.3 2026-07-12 实时 PR 状态

写本规格时已经重新查询 GitHub：

- PR 72：`OPEN`、`MERGEABLE`，全部检查通过；
- PR 73：`OPEN`、`CONFLICTING`；
- PR 73 的 base 是 `feature/home-action-center`，即它当前显式依赖 PR 72；
- PR 73 的 `Backend Service Tests` 与 `Backend Search Tests` 失败，其余检查通过；
- PR 73 当前 head 为 `e91495c921d731501a358c9bd8c8a222c6b14541`；
- PR 73 当前迁移 revision 为 `3f4a5b6c7d8e`。

P0.3 必须基于刷新后的 PR 73 状态实施。先确定并完成 PR 72 → PR 73 的真实合并/更新顺序，再从二者最终合并后的共同基线开始 P0.3；不得继续把两个开放 PR 的当前 shape 当作稳定基线。PR 73 未解决冲突且所有质量门未转绿前，P0.3 不得合并。开始实施和合并前都要再次刷新 PR 状态，不能把本节的时间点快照当成永久事实。

## 4. 本期范围

### 4.1 包含

- 收敛桌面和手机首页为三个问题；
- 保留四项统计、桌面最多且候选充足时 3 个推荐、手机 1 个推荐；
- 把当前完整周计划压缩为 7 天紧凑日历；
- 桌面问题 2/3 两列和手机单列布局；
- `ActivityLog` 首页高亮字段、枚举、约束和索引；
- `log_activity()` 的显式高亮参数；
- 第一阶段业务事件准入规则；
- 首页专用 `GET /api/activity-highlights`；
- 首页与家庭工作区的 React Query 读取拆分；
- 首页家庭动态 loading、empty、error、stale-cache 状态；
- 从首页直接进入家庭活动查看器；
- 从紧凑日历进入对应周的完整菜单区域；
- 相关缓存失效、前后端测试、响应式 smoke、迁移和上线回滚方案。

### 4.2 不包含

- 删除或弱化完整活动审计；
- 新建通用通知系统或重做通知已读、去重、自动过期；
- 新建独立 `HouseholdHighlight` 事实表；
- 对历史活动日志做首页高亮回填；
- 用摘要文本、动作枚举或实体类型推断历史高亮；
- 家庭自定义时区；
- 首页任意实体图片或 AI 生成封面；
- 首页第二套后端待办聚合 API；
- 连续轮询家庭动态；
- 完整周菜单编辑器重做；
- 新增成员角色切换、停用、移除或其他成员生命周期 API；
- PR 72/73 已定义的库存、盘点、采购入库业务规则重写；
- 为本期单独增加 feature flag；
- 业务实现代码。本规格批准后另写实施计划。

## 5. 方案选择

### 5.1 方案 A：继续读取完整审计并在前端过滤

做法是保留首页的 `/api/activity-logs`，再按 `action`、`entity_type`、摘要关键词和前端黑名单筛选。

不采用，原因是：

- 同一 `CREATE` 或 `UPDATE` 既可能是家庭有意义结果，也可能只是内部资料更新；
- 中文摘要不是稳定契约；
- AI 与批量事务会产生多条内部活动，前端无法知道哪一条代表用户认可的最终结果；
- 每新增业务动作都要继续维护脆弱的排除规则。

### 5.2 方案 B：新建独立家庭高亮表

做法是让业务事务同时写审计表和高亮表。

不采用，原因是：

- 同一业务结果出现两套持久化事实；
- 事务、幂等、撤销、演员和时间信息需要重复维护；
- 第一阶段只需要在现有审计事实中标记少量首页准入事件，新表成本高于收益。

### 5.3 方案 C：扩展 `ActivityLog`，显式选择首页准入

这是采用方案。

每条活动仍是一条审计事实，新增的 `highlight_kind` 和 `highlight_summary` 只表达“这条事实是否同时适合首页”。默认 `log_activity()` 不写高亮，因此所有旧调用天然保持 audit-only；只有经过本规格事件矩阵审查的业务成功边界才显式传入结构化高亮。

该方案同时满足：

- 单一事实来源；
- 默认不曝光；
- 与旧代码兼容；
- 能在同一事务中保证业务结果和高亮一起提交或一起回滚；
- 后续可按稳定类型扩展图标和统计，而不暴露原始内部实体。

## 6. 首页信息架构与视觉设计

### 6.1 全局阅读顺序

桌面端顺序：

1. 现有桌面页面头；
2. 四项统计；
3. 问题 1“今天吃什么”，候选充足时包含 3 个推荐，并包含紧凑 7 天日历；
4. 问题 2“今天必须处理什么”与问题 3“家里发生了什么”的双列区。

手机端顺序：

1. 完整保留现有手机 Hero；
2. 四项统计条；
3. 问题 1“今天吃什么”，包含 1 个推荐和可横向滚动的紧凑 7 天日历；
4. 问题 2“今天必须处理什么”；
5. 问题 3“家里发生了什么”；
6. 现有底部导航与安全区。

页面继续使用 Culina 的暖白、米色、克制品牌橙、柔和绿/黄/紫和浅棕边框。首页是产品工作台，不使用营销 Hero、冷灰后台表格、科技蓝主按钮或大面积 AI 渐变。

### 6.2 四项统计

桌面和手机都保留 PR 72 已落地的四项统计与口径：

1. 在库食材；
2. 需处理食材；
3. 待采购；
4. 本周做菜。

视觉继续使用现有柔和语义色。统计区不能因为家庭动态加载而进入全局 loading，也不因高亮接口错误而消失。

### 6.3 问题 1：今天吃什么

#### 推荐数量与翻页

- 桌面端展示窗口的 `pageSize=3`，按钮文案“换一批”；
- 手机端展示窗口的 `pageSize=1`，按钮文案“换一个”；
- 两端复用同一份推荐 API 数据，但使用各自独立的分页游标和 page size；
- 手机端不能对桌面端当前三项结果简单执行 `slice(0, 1)`，否则连续点击会从第 1 项跳到第 4 项；
- 手机端一次只渲染一张完整推荐卡，不露出下一张卡片的边缘，也不保留推荐横向 scroller；
- 当源数据数量 `N >= pageSize` 时，每个窗口必须填满对应 page size；末页用环形窗口从开头补足，但同一窗口内不得重复；
- 当 `0 < N < pageSize` 时只展示现有的 `N` 个真实推荐，不复制、伪造或渲染空占位卡；`N=0` 时进入空态；
- 桌面游标每次前进 3 项，手机游标每次前进 1 项；按钮分别只在 `N > 3`、`N > 1` 时可用；
- 推荐为空时继续使用已有家庭化空态，不阻塞日历和后续两个问题。

“开始做”或对应食物主操作继续使用品牌橙；“换一批/换一个”、加入菜单和查看详情保持次级视觉强度。

桌面问题 1 内部先展示三张推荐卡，再展示紧凑日历；手机问题 1 内部先展示一张完整推荐卡，再展示紧凑日历。两端都不能把紧凑日历恢复成独立的大型周计划编辑面板。

#### 7 天紧凑日历

保留完整周结构，但从首页移除当前占空间较大的：

- 3 个周计划汇总卡；
- 早餐、午餐、晚餐、加餐的完整编辑行；
- 首页内的大型周计划编辑面板。

紧凑日历必须保留：

- 上一周、回到本周、下一周；
- 连续 7 天；
- 今天态和选中态；
- 每天的计划数量或餐次状态点；
- 选中日期的简短餐食摘要；
- “查看完整周菜单”入口。

桌面端 7 天在一行内稳定展示。手机端 7 天卡片必须是真正可横向滚动的固定宽度项，不能通过缩小文字把所有日期硬塞进屏幕；选中日期摘要位于日期条下方。所有日期和导航触控目标保持 44px 级热区，并提供 `aria-pressed`、可读按钮名称和可见焦点。

“查看完整周菜单”使用当前紧凑日历选中的 `planDate`，进入食物工作区的对应周菜单区域；它只定位周菜单，不自动打开任意计划项。第 10.7 节定义统一导航协议。

### 6.4 问题 2：今天必须处理什么

问题 2 继续复用 PR 72/73 的现有能力，不增加第二套后端聚合。

内容形态：

- 桌面和手机都使用纵向行动行，不使用窄列里的横向小卡片；
- 默认最多展示 3 条；
- 高优先级库存行动沿用 PR 72 的排序、分组和去重，但合并输入必须使用尚未截断的 `homeEligibleInventoryActionGroups`；
- 待采购数量来自现有 `pendingShoppingCount`；
- 采购行动文案必须是事实，例如“5 项待采购”“登记本次购买”；
- 禁止写“5 项采购可入库”，因为当前采购行没有“已经买到、等待入库”的持久化状态；
- 用户点击“登记本次购买”时打开 PR 73 的共享采购入库流程；
- “建议再确认”作为低强调的区块辅助入口，打开 `scope=suggested` 快速盘点；打开前不预取 reconciliation detail；
- “查看全部”进入食材工作区的完整优先处理视图。

首页行动候选的确定顺序为：

1. PR 72 已排序的过期、今天到期和 1～3 天内临期分组；
2. 有未完成采购项时的一条聚合采购行动；
3. 尚未被采购项覆盖的低库存分组；
4. 取前 3 条。

同一 Ingredient 已在未完成采购清单中时，PR 72 的去重规则继续生效，不再同时展示一个重复的低库存行动。“建议再确认”是区块辅助入口，不占用上述 3 条业务行动名额，也不伪造“有差异”或未加载的盘点数量。

前端纯函数必须先把未截断 eligible 列表拆成 urgent expiry 与 low-stock，再插入最多一条聚合采购行动，最后统一执行 `slice(0, 3)`。不得先使用已经截断为 3 条的 `homeInventoryActionGroups` 再插入采购行动。输出使用首页专用的 `HomeRequiredAction` 判别联合类型，不把采购行动伪装成 `InventoryActionGroup`：

```ts
type HomeRequiredAction =
  | { kind: 'inventory'; group: InventoryActionGroup }
  | { kind: 'shopping'; pendingCount: number };
```

“查看全部”可见性按截断前的合并候选总数计算。`homeInventoryActionGroups` 可继续服务 PR 72 的旧消费者，但不是本期问题 2 的唯一输入。

### 6.5 问题 3：家里发生了什么

问题 3 使用家庭结果时间线：

- 桌面最多展示接口返回的 5 条；
- 手机从同一份 5 条响应中展示前 3 条，不发第二次请求；
- 每条显示固定类型图标、演员名、家庭可读结果摘要和时间；
- 不按数组下标轮换图标；
- 不把餐食照片、菜单图片或其他无关实体图片按下标配给活动；
- 图标由 `highlight_kind` 映射，未知类型使用通用家庭图标；
- 演员无法解析时显示“家庭成员”；
- “查看完整记录”进入家庭工作区活动查看器。

类型与图标语义：

| `kind` | 首页语义 | 固定图标方向 |
| --- | --- | --- |
| `shopping` | 采购入库与撤销 | 购物车/购物袋 |
| `inventory` | 盘点、库存纠错、集中处理 | 食材/库存箱 |
| `meal_plan` | 菜单安排变化 | 日历 |
| `meal` | 做菜完成与餐食记录 | 锅/餐具 |
| `family` | 当前版本仅包含邀请成员成功 | 家庭成员 |

### 6.6 桌面与手机布局

桌面工作区和横屏平板使用：

```text
问题 1：推荐 + 紧凑日历（整行）

问题 2：今天必须处理什么（约 56%） | 问题 3：家里发生了什么（约 44%）
```

问题 2 内部是最多 3 条行动行；问题 3 内部是最多 5 条时间线。两列都必须使用 `minmax(0, 1fr)`、`min-width: 0` 和长文案省略/换行策略，避免窄桌面溢出。

手机使用独立 `HomeMobileDashboard` 结构，问题 2 和问题 3 必须上下单列。不得把桌面双列 JSX 通过缩放或简单隐藏当成手机实现。

### 6.7 手机顶部结构硬约束

以下现有结构必须完整保留：

- Culina 品牌与 Logo；
- 全局搜索；
- 后台任务铃铛；
- Kitchen Hero 图片；
- 家庭名称与口号；
- 位置、成员数、本周协作 chips；
- “新增食材”和“查看记录”双快捷操作；
- 四项统计条。

“本周协作”的结构和文案位置不变，但数值改为本周有意义的家庭高亮总数，不再统计所有原始审计动作。手机高频按钮和图标按钮保持 44px 级热区，页面不得产生页面级或非设计性的横向溢出。首页第一阶段只保留两处受控横滑：现有位置、成员数、本周协作的 Hero meta chips，以及新增紧凑日历；它们各自在自己的容器内滚动，不能带动整个页面横移。推荐、问题 2 和问题 3 不使用横滑来容纳更多内容。

## 7. 活动高亮数据模型

### 7.1 枚举

在 `backend/app/core/enums.py` 增加：

```python
class ActivityHighlightKind(str, Enum):
    SHOPPING = "shopping"
    INVENTORY = "inventory"
    MEAL_PLAN = "meal_plan"
    MEAL = "meal"
    FAMILY = "family"
```

该枚举描述首页展示语义，不等同于底层 `ActivityAction` 或 `entity_type`。

### 7.2 `ActivityLog` 字段

在 `ActivityLog` 增加两个可空字段：

```python
highlight_kind: ActivityHighlightKind | None
highlight_summary: str | None
```

持久化建议：

- `highlight_kind` 使用项目现有 `SqlEnum(..., native_enum=False)` 风格；
- `highlight_summary` 使用 `String(255)`；
- 两字段均可空，以保证旧后端和旧调用兼容；
- 增加显式成对约束：两者必须同时为空或同时非空；
- 增加 `(family_id, created_at, highlight_kind)` 组合索引，服务当前家庭按时间倒序查询。

语义：

- 两字段都为空：只进入完整审计；
- 两字段都非空：进入完整审计，并有资格进入首页；
- 只写其中一个：模型/服务校验拒绝，数据库约束兜底拒绝。

历史数据不回填。旧 `summary` 保持原样，完整审计序列化也不需要暴露高亮内部字段。

### 7.3 结构化写入对象

`backend/app/services/activity.py` 增加一个不可变的结构化值对象，例如：

```python
@dataclass(frozen=True)
class ActivityHighlight:
    kind: ActivityHighlightKind
    summary: str
```

并扩展：

```python
def log_activity(..., highlight: ActivityHighlight | None = None) -> ActivityLog:
    ...
```

规则：

- 默认 `highlight=None`，现有调用全部继续 audit-only；
- `ActivityHighlight.summary` 在 `log_activity()` 服务边界去除首尾空白并校验非空、最长 255 字符，规范化结果写入 `highlight_summary`；
- 原始审计 `ActivityLog.summary` 的既有写入行为不在本期统一重写，不能把上述规则误应用成对全部旧审计摘要的行为变更；
- `highlight_summary` 不包含演员名，例如写“完成 5 项采购入库”，不写“星星完成 5 项采购入库”；
- 前端用当前家庭解析出的演员名与该摘要组合展示；
- 业务调用不得直接传自由字符串作为类型，也不得通过 `entity_type` 自动映射类型。

## 8. 高亮准入与事务规则

### 8.1 总体不变量

1. 高亮只能由业务成功边界显式写入。
2. 高亮与其代表的业务结果使用同一个 SQLAlchemy session 和同一次事务提交。
3. 失败、审批拒绝、`409`、`422`、数据库提交失败或事务回滚都不留下高亮。
4. 一次用户认可的业务事务最多一条高亮。
5. 同一业务事务内部可以继续保留多条细粒度审计，但只能选择一条事务级活动承载高亮。
6. 如果现有批量流程没有事务级活动，可新增一条聚合审计活动，并只在该条写高亮。
7. 支持幂等键的业务接口重放时返回原业务结果，不再创建第二条活动或高亮。
8. 两次没有共享幂等身份的独立用户操作仍视为两个业务事务。
9. AI 的工具调用、草稿、推理步骤、pending approval 和内部同步永远不产生高亮。
10. AI 已批准业务只有通过第 8.2 节的显式结果分类与归约后才可写一条聚合高亮；必要的逐项审计可以保留，但逐项审计不得带高亮。
11. 最外层业务编排者是本次事务唯一的 highlighter owner；做菜调用餐食创建、AI 批量调用单项计划等嵌套流程时，内层服务只写 audit-only 活动，由外层成功边界写最终聚合高亮，不能提交后再删除重复高亮。

关键测试断言统一为：

```text
第一次请求：业务结果 1，高亮 1
幂等重放：业务结果仍为 1，高亮仍为 1
```

### 8.2 AI approval 与 composite 高亮归约

当前 `composite_operation.v1` 可以在一次审批中组合 ingredient、inventory、food、recipe、recipe_cook、meal_plan、shopping_list 和 meal_log 等多个领域，但 payload 没有可信的 `primary_domain`、`primary_outcome` 或 `highlight_kind`。因此第一阶段不允许按第一个步骤、步骤数量、中文摘要或任意“主领域”猜测首页类型，也不新增第六种 generic 高亮类型。

在 AI draft registry 增加显式、默认关闭的结果分类能力。每个非 composite draft spec 可选提供一个纯函数 classifier，输入至少包含已提交 payload 与实际成功的 `business_entity`，并把该 operation 内部的同 kind 批量结果先聚合，最终只输出 `ActivityHighlight | None`：

- 普通 CRUD、收藏、评分、照片补充、shopping-list 新增/编辑/勾选等 audit-only 结果返回 `None`；
- 只有第 8.3 节矩阵中允许的实际业务结果才返回候选；
- 不能只根据 draft type 或 composite step 的 `domain` 判定，因为同一领域同时存在 eligible 与 audit-only 操作；
- 摘要必须来自实际成功结果，不从模型预期、预览文本或未执行步骤生成。

普通非 composite 审批：

- 零个候选：只保留现有完整审计，不产生首页高亮；
- 一个候选：由最外层 approval success 边界新增一条事务级 `ActivityLog`，使用 `entity_type="AIOperation"`、当前 `operation.id` 和 `ActivityAction.UPDATE`，并在该条写入候选高亮；
- 内层 draft executor 产生的所有活动仍显式或默认 `highlight=None`。

composite 审批按每个实际成功 step 的原始 operation 与执行结果调用对应 draft classifier，收集每步零或一个候选，再按候选 kind 集合归约：

1. 没有 eligible 候选：audit-only；
2. 有候选且所有候选属于同一个 kind：按该 kind 的实际结果聚合为一条事务级高亮；
3. 候选跨两个或更多 kind：第一阶段整个 composite audit-only，不进入首页；
4. 同 kind 的多个 step 只生成一条数量化聚合摘要，不按 step 展开；
5. 跨 kind composite 不选“最重要”的一步、不新增 generic enum，也不要求模型提供可篡改的主类型字段。

例如，ingredient profile 更新加 3 条 meal-plan 变更只产生一条 `meal_plan` 聚合高亮；meal-plan 与 meal-log 同时成功属于两个 kind，第一阶段不产生首页高亮，但现有逐项活动与 `AIOperation` 审计仍保留。AI shopping-list 批量新增、编辑或勾选仍然 audit-only；只有执行结果确实落在矩阵允许的原子采购入库事务时，才可归为 `shopping` 高亮。

AI 审批的原子成功段必须调整为同一个 `db.begin_nested()` savepoint 内依次完成：

1. 执行业务 draft 或 composite 全部步骤；
2. 执行所有必须成功的 `after_success` 数据库 hook；
3. 基于实际结果完成 eligibility/kind 分类与 composite 归约；
4. 若归约得到高亮，写入事务级活动并 `flush`；
5. savepoint 成功退出后，才把 `AIOperation` 和 draft 标记为 succeeded/confirmed。

当前实现只有 draft execute 位于 savepoint 内，而 `after_success` 在 savepoint 外；当前唯一 hook `_refresh_inventory_operation_result_card` 只读写同一数据库 session，属于必须纳入 savepoint 的事务性 hook。本期必须按上述边界收紧。任一步骤、hook、分类、活动写入或 flush 失败都回滚该 savepoint，不得出现业务结果已保留但 AI operation 标记 failed、或 failed operation 留下首页高亮的状态。未来若增加不可回滚的网络、消息或文件副作用，必须拆成明确的 post-commit/outbox 路径，不能冒充本段事务性 `after_success`，也不能参与高亮准入判断。最终路由 `commit_session()` 失败时仍回滚整个外层事务。

### 8.3 第一阶段允许进入首页的结果

| 领域 | 允许高亮的结果 | 聚合要求 |
| --- | --- | --- |
| 采购 | 原子采购入库成功；采购入库整次撤销成功 | 一次 intake/revert 各最多一条 |
| 库存 | 快速盘点成功；盘点整次撤销成功；通过集中过期处理事务完成销毁 | 按一次用户提交聚合，不按批次展开 |
| 菜单计划 | 创建计划；移动日期/餐次；替换食物；移除计划 | AI 批量安排只写一条总结果 |
| 餐食 | 做菜完成；新建餐食记录；快捷记录一餐 | 做菜同时扣库存、完成计划和建记录时只写一条 `meal` 高亮 |
| 家庭 | 邀请成员成功 | 一次邀请事务一条 |

“集中过期处理”按业务事务边界判断，而不是按中文摘要或任意数量阈值判断。通过集中处理入口提交的一次选中批次销毁是一个结果；底层逐批库存变化仍可保留细粒度审计。

菜单计划的“有意义变化”只包括食物、日期、餐次或存在状态发生变化。只改备注不产生高亮。做菜事务如果同时把计划标记为已完成，以餐食结果为唯一高亮，避免同一晚餐出现“计划更新”和“做菜完成”两条首页结果。

当前仓库没有 Owner/Member 角色切换、membership 停用或成员移除的请求 schema、API 和 UI。本期不得为了高亮矩阵顺带新增这些成员生命周期能力。未来如果项目先独立增加并验收了相应业务成功边界，必须再更新本矩阵、摘要与测试后才能允许进入首页；仅仅因为 `Membership` 模型已有 role/status 字段不构成第一阶段准入。

### 8.4 只保留完整审计的活动

- 采购项普通新增、编辑、删除、勾选和取消勾选；
- 单条到期提醒稍后处理、暂时保留和日期纠错；
- 餐食照片、评分、评论、备注等补充完善；
- 菜谱收藏与取消收藏；
- Recipe、Food、Ingredient 普通 CRUD 和自动同步；
- AI tool/runtime、草稿、内部步骤、pending approval；
- 搜索索引、图片生成和其他后台任务；
- 普通家庭资料、个人资料、成员联系方式编辑；
- 任何未列入第一阶段允许矩阵的内部动作。

新增业务流程默认 audit-only。要进入首页，必须先更新本规格的准入矩阵、摘要规则和测试，不能仅在调用点随手传 `highlight`。

### 8.5 摘要示例

推荐的 actor-free 摘要：

```text
完成 5 项采购入库
撤销一次采购入库
完成冰箱盘点并修正 3 项库存
集中处理 4 个过期批次
把番茄炒蛋安排到周二晚餐
将周三晚餐换成清炒时蔬
完成晚餐并记录 3 人用餐
邀请爸爸加入家庭
```

避免：

```text
update InventoryOperation inventory-operation-xxx
AI tool shopping.apply 执行成功
星星完成 5 项采购入库
更新了一些数据
```

## 9. 首页高亮 API

### 9.1 接口

新增：

```http
GET /api/activity-highlights?limit=5
```

`limit`：

- 默认 `5`；
- 最小 `1`；
- 最大 `20`。

响应：

```json
{
  "items": [
    {
      "id": "activity-xxx",
      "kind": "shopping",
      "summary": "完成 5 项采购入库",
      "actor_id": "user-xxx",
      "actor_name": "星星",
      "created_at": "2026-07-12T08:42:00Z"
    }
  ],
  "week_highlight_count": 7
}
```

首页响应不返回：

- `family_id`；
- 原始 `action`；
- 原始 `entity_type`；
- 原始 `entity_id`；
- 业务实体图片；
- 完整审计 `summary`。

### 9.2 查询规则

- 必须认证；
- 严格使用当前 membership 的 `family_id`；
- 只查询 `highlight_kind IS NOT NULL AND highlight_summary IS NOT NULL`；
- 按 `created_at DESC, id DESC` 稳定排序；
- 演员只从当前家庭 membership 范围解析；
- 演员已离开、历史导入或无法解析时返回“家庭成员”；
- 绝不使用其他家庭中的同一用户资料补演员名；
- `week_highlight_count` 统计当前家庭在 `[Asia/Shanghai 本周一 00:00, 当前时刻]` 闭区间内的全部合格高亮，不受响应 `limit` 限制，未来时间不得计入；
- 本周起点与当前时刻先显式转换为 UTC，再针对当前 MySQL `DATETIME` 持久化约定移除 `tzinfo`，使用 naive UTC 值执行 `created_at >= week_start_utc_naive AND created_at <= now_utc_naive`；
- 查询结果不能依赖 MySQL session timezone、容器 `TZ` 或驱动隐式丢弃 offset；
- 周边界使用 `backend/app/services/clock.py` 的家庭时间工具，不在路由内复制时区算法。

即使客户端传 `limit=1`，`week_highlight_count` 仍然是本周全部高亮数。相同 `created_at` 的记录使用 `id DESC` 作为稳定次序。周边界计算必须同时通过 SQLite 单元测试和真实 MySQL 8.4 集成验证，覆盖上海时间周日 `23:59:59`、周一 `00:00:00`、UTC 日期跨日以及晚于当前时刻的异常未来记录。

### 9.3 完整审计接口保持独立

现有：

```http
GET /api/activity-logs
```

继续服务家庭工作区的完整筛选、分页和审计查看，不改成首页高亮接口，也不把首页高亮过滤参数塞入该接口。

## 10. 前端数据流与职责边界

### 10.1 API 类型与查询键

在 `frontend/src/api/types.ts` 增加：

```ts
type ActivityHighlightKind = 'shopping' | 'inventory' | 'meal_plan' | 'meal' | 'family';

type ActivityHighlight = {
  id: string;
  kind: ActivityHighlightKind;
  summary: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
};

type ActivityHighlightsResponse = {
  items: ActivityHighlight[];
  week_highlight_count: number;
};
```

在 API client 增加 `getActivityHighlights(limit = 5)`，并在 `queryKeys.ts` 增加根 key 与带参数的列表 key：

```ts
activityHighlights: ['activity-highlights'] as const,
activityHighlightList: (limit = 5) =>
  ['activity-highlights', 'list', limit] as const,
```

首页读取使用 `activityHighlightList(5)`，所有 eligible mutation 使用根 key `activityHighlights` 做前缀失效。不得复用 `queryKeys.activityLogs`、不得让不同 limit 碰撞到同一缓存，也不得在组件内写裸 query key。

### 10.2 首页与家庭工作区查询拆分

`useAppWorkspaceQueries` 调整为：

- `activityHighlightsQuery` 只为首页启用；
- `activityLogsQuery` 只为家庭工作区启用；
- 第一阶段家庭工作区的 `activityLogsQuery` 保持当前完整查询语义，不改成约 20 条预览；现有 `currentUserRecentLogs`、`weekActivityCount`、Family 统计卡和成员记录数仍然基于该完整集合；
- 家庭活动查看器继续根据筛选和 `pageSize=50` 使用自己的 `activityLogList(...)`；
- 首页不再接收完整 `ActivityLog[]`；
- 首页任何状态都不得请求 `/api/activity-logs`；
- 高亮查询和 Family activity query 都不计入 `isBootLoading`，因此首页高亮或进入 Family 后的活动加载不会挡住应用壳与整个工作区；
- 首页同一份 5 条高亮供桌面和手机视图消费；
- Family 不能只接收 `activityLogsQuery.data ?? []` 后丢失查询状态；组合层必须把 success/loading/error/refetch 与数据一起传给 Family view model/presentation；
- Family 首次进入时，完整活动查询尚未成功不能伪装成统计值 `0` 或空时间线，必须呈现 Family 区域自己的 loading/error 状态。

本期只解除 Home 对完整 activity logs 的依赖，不顺带优化 Family 查询。未来若要为 Family 限制列表数量，必须先新增服务端精确 count/summary 契约并迁移 `currentUserRecentLogs`、`weekActivityCount` 等消费者；不得再从被截断的预览数组推导全量统计。

数据流：

```text
业务事务
  → ActivityLog（完整审计）
  → 可选 highlight_kind + highlight_summary
  → GET /api/activity-highlights?limit=5
  → activityHighlightsQuery
  → Home view model
  → 桌面 5 条 / 手机前 3 条

GET /api/activity-logs
  → activityLogsQuery（仅家庭工作区，第一阶段保持现有完整语义）
  → Family 统计与预览

GET /api/activity-logs?...&limit=50
  → activityLogList(...)（仅完整活动查看器）
  → 筛选、分页后的完整记录
```

### 10.3 首页 view model

`homeDashboardModel.ts` 或职责明确的新纯函数模块负责：

- 桌面推荐 `pageSize=3`；
- 手机推荐 `pageSize=1`；
- `useHomeDashboardState` 分别保存 desktop 与 mobile 推荐游标，视口切换和同页双渲染不能互相覆盖游标；
- 纯函数按 `items + cursor + pageSize` 生成第 6.3 节定义的环形窗口，并覆盖 `N=0`、`0<N<pageSize` 和末页回绕；
- 问题 2 使用未截断的 `homeEligibleInventoryActionGroups`，按 urgent expiry → 单一 shopping 聚合 → low-stock 合并后只做一次 `slice(0, 3)`；
- 输出首页专用 `HomeRequiredAction` 判别联合类型；`hasMoreHomeActions` 按截断前候选长度计算，UI 不再二次排序或 `slice`；
- 问题 3 固定 kind 图标映射；
- 未知 kind 与演员兜底；
- 高亮 count 的 successful/loading/error/stale-cache 展示状态；
- 7 天紧凑日历所需的日期、状态点和选中日摘要。

React 组件只表达桌面或手机结构，不自行做排序、去重、分页数学或缓存失效。

### 10.4 缓存失效与刷新

以下成功事务必须失效 `queryKeys.activityHighlights`：

- 采购入库及撤销；
- 盘点及撤销；
- 集中过期销毁；
- 有意义的菜单计划写入；
- 做菜完成、新建或快捷餐食记录；
- 家庭邀请成功；
- 经第 8.2 节分类后可能完成上述 eligible 结果的 AI approval。

上述规则统一维护在 `frontend/src/api/cacheInvalidation.ts`，组件和业务 hook 不自行散落 `invalidateQueries`。audit-only 的收藏、资料编辑、普通 shopping-list CRUD 和后台任务无需为了首页高亮单独失效。AI approval 成功后可以统一对根 key 做冗余失效，避免前端复刻后端 classifier；但这种刷新不代表普通 shopping-list 操作已成为 eligible。若现有集中 invalidation helper 同时覆盖 eligible 和 audit-only 变体，可以接受少量冗余刷新，但不能漏掉会创建高亮的成功路径。

刷新策略：

- mutation 成功后主动失效；
- 重新进入首页或窗口重新获得焦点时允许 React Query 刷新；
- 不设置持续轮询；
- 手机端不得为了“实时感”每几秒请求一次。

### 10.5 “本周协作”口径

首页手机 Hero 的 `sidebarActivityLabel` 使用 `week_highlight_count`：

```text
本周协作 7 次
```

该数字表示本周有意义的家庭业务结果，不再由最近 7×24 小时的原始 `activityLogs` 条数计算。时间语义改为 `Asia/Shanghai` 本周一 `00:00` 至当前时刻，而不是滑动 7 天窗口。

展示状态必须区分：

- 查询成功时展示真实数值，只有成功且 count 确实为 `0` 才显示“本周协作 0 次”；
- 首次加载且无缓存时显示“本周协作 --”，不得预填 `0`；
- 有缓存刷新时继续显示旧值；
- 无缓存错误时仍显示“本周协作 --”，问题 3 同时提供局部重试，不得把失败解释为本周没有协作。

### 10.6 完整记录导航

把 `'activity'` 加入 `FamilyOverlayMode`，形成统一导航状态：

- 将 `familyOverlayMode` 提升到 Home 与 Family 都能原子读写的应用编排层，`FamilySettings` 通过受控 props 接收状态与 `onOverlayChange`；
- `FamilyOverlayMode` 是邀请、资料、成员和 activity 等 Family overlay 的唯一业务状态；
- 删除 `HomeDashboard` 的 `isActivityViewerOpen` 与首页内 `FamilyActivityModal`；
- 删除 `FamilySettings` 的 `isActivityModalOpen` 和 `isMobileActivityPageOpen` 两个本地 boolean；
- 首页“查看完整记录”一次导航同时设置 `activeTab='family'` 与 `familyOverlayMode='activity'`；
- `overlayMode === 'activity'` 时，桌面渲染现有 `FamilyActivityModal`，手机渲染现有 `FamilyActivityMobilePage`；
- close/back 统一调用 `onOverlayChange(null)`，关闭后仍停留在 Family 页；
- 打开期间视口跨断点变化时只切换 modal/page presentation，不丢失 activity 业务状态、筛选或已加载缓存；
- 不复制过滤、分页或时间线实现。

### 10.7 完整周菜单导航协议

扩展现有全局食物计划导航为判别联合类型，保留已有 item 定位并新增 week 目标：

```ts
type FoodPlanNavigationRequest =
  | {
      target: 'item';
      itemId: string;
      planDate: string;
      requestId: number;
    }
  | {
      target: 'week';
      planDate: string;
      requestId: number;
    };
```

- 既有全局搜索和计划项调用者补上 `target: 'item'`，行为保持不变；
- 首页紧凑日历使用选中的日期发送 `target: 'week'`，随后进入 foods 工作区；
- `target: 'week'` 必须将计划状态切到包含 `planDate` 的自然周，聚焦或滚动到周菜单 presentation，但不得自动打开该周任意 item；
- 桌面端复用现有 week-plan section；
- 手机端使用独立的轻量周菜单 page/overlay，而不是条件隐藏桌面 JSX；复用同一周计划数据、日期选择、现有计划项详情操作和 ui-kit 基础控件，处理底部导航与 safe-area，只解决“查看对应周”的落点，不在本期重做桌面式完整周菜单编辑器或拖拽布局；
- 两端具有相同目标周和返回语义，presentation 可以不同；重复 request 依靠递增 `requestId` 被可靠消费。

## 11. Loading、空态、错误与兼容状态

### 11.1 首次加载

首页高亮无缓存且首次 fetching 时，问题 3 显示本地时间线 skeleton，“本周协作”显示 `--`。其他统计、推荐、日历和问题 2 正常展示，页面头与应用壳不进入全局 loading。

Family 完整查询与 activity viewer 各自遵循同一原则：无缓存且首次 fetching 时显示局部 skeleton/loading，不能先用空数组渲染“暂无活动”，也不能先用 `0` 渲染依赖完整活动集合的统计。

### 11.2 空态

请求成功且数组确实为空时才使用现有 `EmptyState` 语义进入空态。没有历史回填，因此新版本刚上线时允许为空：

```text
还没有家庭动态
完成采购入库、盘点、安排菜单或记录一餐后，这里会出现家庭结果。
```

不得用完整审计日志填补空态。

### 11.3 无缓存错误

首页只在问题 3 显示局部错误和重试：

```text
家庭动态暂时加载失败
稍后重试；其他首页功能仍可使用。
```

Family overview 或 activity viewer 无缓存失败时，同样在对应局部区域显示错误与显式 retry；不得显示空态、归零统计或让整个应用进入错误页。viewer hook 必须向 presentation 暴露 `isError`、可读错误状态与 `refetch`。

### 11.4 有缓存时刷新失败

- 保留旧高亮；
- 显示低强调的“刷新失败，重试”提示；
- 不清空时间线；
- 不回退到 `/api/activity-logs`。

Family overview 和 activity viewer 已有缓存但 refresh 失败时也保留旧数据，并在对应区域显示低强调错误与重试；缓存数据优先于错误空态。

### 11.5 未知数据

- 未知 `kind`：通用家庭图标；
- 未知演员：`家庭成员`；
- 缺失或无效时间：使用现有安全格式化兜底，不让组件崩溃；
- API 契约不完整时按局部错误处理，不影响其余首页。

## 12. 数据库迁移

### 12.1 迁移顺序

部署数据库为 MySQL 8.4。新增一个 additive migration：

新 migration 的 `revision` 使用 Alembic 生成的唯一 ID，`down_revision` 明确锁定为：

```python
down_revision = "3f4a5b6c7d8e"
```

如果实施前刷新发现 PR 73 的迁移图已经改变，必须先回到书面规格与实施计划更新依赖关系并重新确认；实施者不得静默改接另一个 migration head。

迁移内容：

1. 增加可空 `highlight_kind`；
2. 增加可空 `highlight_summary`；
3. 增加成对空值 check constraint；
4. 增加 `(family_id, created_at, highlight_kind)` 索引；
5. 不执行历史 `UPDATE`。

建议约束与索引名：

```text
ck_activity_logs_highlight_pair
ix_activity_logs_family_created_highlight
```

### 12.2 降级

按以下顺序：

1. 删除组合索引；
2. 删除 check constraint；
3. 删除 `highlight_summary`；
4. 删除 `highlight_kind`。

旧 `summary`、活动行和完整审计数据不受影响。

### 12.3 兼容矩阵

| 组合 | 结果 |
| --- | --- |
| 新数据库 + 旧后端 | 安全；新增字段可空 |
| 新数据库 + 新后端 + 旧前端 | 安全；旧前端继续使用完整审计 |
| 旧数据库 + 新后端 | 不安全；后端模型/API 依赖新列 |
| 旧后端 + 新前端 | 不安全；缺少高亮接口 |

因此必须先迁移，再后端，再前端。

## 13. 上线、回滚与发布门

### 13.1 部署顺序

1. 刷新 PR 72/73，解决 PR 73 冲突和失败检查；
2. 部署数据库迁移；
3. 部署后端模型、写入服务与高亮 API；
4. 验证 `/api/activity-highlights` 的认证、家庭隔离、排序和周计数；
5. 部署前端查询拆分和首页结构；
6. 使用真实业务流程完成端到端验收。

### 13.2 紧急回滚

1. 先回滚前端，停止调用新接口；
2. 再回滚后端；
3. 事故期间保留 additive 数据库列、约束和已写高亮；
4. 不在紧急回滚中执行 destructive downgrade；
5. 故障恢复后可重新部署后端与前端，已有高亮仍然有效。

### 13.3 Feature flag 决策

本期不增加 feature flag，理由是：

- schema 变更完全 additive；
- 新后端兼容旧前端；
- 首页家庭动态有局部失败状态；
- 紧急回滚可通过前端、后端顺序完成；
- 为单一区块增加长期 flag 会扩大缓存和测试状态空间。

发布门仍然是严格部署顺序、PR 73 转绿和端到端验收，而不是 feature flag。

## 14. 后端测试设计

### 14.1 模型与服务

- `log_activity()` 默认仍只写审计；
- 合法的两字段组合可提交；
- 单边为空、空白摘要和超长摘要被拒绝；
- 数据库 check constraint 在服务校验外仍能兜底；
- ActivityHighlightKind 使用稳定字符串值；
- 旧活动行保持两字段为空。

### 14.2 高亮 API

- 未认证返回 `401`；
- 只返回当前家庭；
- 其他家庭演员不会被解析；
- 只返回两字段完整的 eligible 行；
- `created_at DESC, id DESC` 稳定排序；
- 默认 limit、`1`、`20` 和越界参数；
- 当前家庭演员名与“家庭成员”兜底；
- `week_highlight_count` 不受 limit 影响；
- 周一 `00:00` 的 Asia/Shanghai 边界，以及 `[周一起点, 当前时刻]` 上下界；
- 上海周日前后、UTC 日期跨日边界和未来记录不计入；
- 传给 MySQL `DATETIME` 的比较值是显式转换后的 naive UTC，不依赖 DB session timezone；
- SQLite 单元测试与真实 MySQL 8.4 边界查询结果一致；
- 响应不泄露内部实体字段。

### 14.3 业务准入与幂等

覆盖：

- 采购入库和撤销，各一次高亮；
- 采购入库幂等重放不重复；
- 快速盘点和撤销，各一次高亮；
- 盘点冲突和幂等重放；
- 集中过期销毁按一次提交聚合；
- 菜单创建、移动、替换、移除产生高亮；
- 只改菜单备注不产生高亮；
- 做菜完成只产生一条 `meal` 高亮，不额外产生计划/库存高亮；
- 新建和快捷餐食记录产生高亮；
- 餐食照片、评分、评论补充不产生高亮；
- 邀请成员成功产生高亮；本期不存在角色、状态或移除高亮测试；
- 普通家庭资料和个人资料编辑不产生高亮；
- 普通 shopping-list create/update/delete/check 和对应 AI 操作保持 audit-only；
- AI approval 没有 eligible candidate 时 audit-only；
- AI approval 只有一个 eligible kind 时产生一条事务级高亮；
- AI composite 同 kind 多步骤只产生一条聚合高亮；
- AI composite 跨多个 kind 时第一阶段整体 audit-only；
- AI 内部步骤、草稿、拒绝审批不产生高亮；
- AI draft execute、`after_success`、classifier、activity 写入或 flush 任一失败时，业务结果与高亮一起回滚到 savepoint，operation/draft 进入预期 failed/retry 状态；
- `409`、`422`、业务异常、外层 commit failure 和 rollback 不留下高亮；
- 历史行不会因读取或迁移自动变为高亮。

每个幂等业务测试都使用统一断言：第一次业务结果/高亮均为 1，重放后仍均为 1。

## 15. 前端测试设计

### 15.1 Model 与 query

- API 类型和 `getActivityHighlights(5)`；
- `activityHighlights` 根 key、`activityHighlightList(limit)` 参数 key 与完整审计 key 分离，不同 limit 不碰撞；
- eligible mutation 成功后正确失效高亮；
- 首页启用高亮查询但不启用完整活动查询；
- 家庭工作区第一阶段保留完整 activity query，不被固定约 20 条的预览上限截断；Family 统计仍使用完整语义；
- 高亮查询和 Family activity query 都不进入全局 boot loading；Family 仍收到显式 query 状态；
- 推荐 `N=0/1/2/4/5/6` 的空态、数据不足、按钮启用和环形窗口边界；
- 桌面推荐 page size 为 3，`N>=3` 时每个窗口三项且窗口内不重复；
- 手机推荐 page size 为 1，连续换一个按 1、2、3、4 顺序移动；
- 两端独立游标不会互相按错误 page size 跳页；
- 问题 2 从未截断 eligible 集合按 urgent expiry → shopping → low-stock 合并，最后仅截断一次；
- `HomeRequiredAction` 分支、真实采购文案、最多 3 条及 `hasMoreHomeActions` 使用截断前长度；
- 问题 3 kind 图标映射、未知类型和未知演员兜底；
- 本周协作直接使用 API 的 `week_highlight_count`；无缓存 loading/error 显示 `--`，不能伪装成 `0`，有缓存失败保留旧值。

### 15.2 组件与状态

- 桌面和手机都保留四项统计；
- 候选充足时桌面展示 3 个推荐；手机有候选时展示 1 个；不足时只展示真实数据；
- 手机推荐只渲染一张完整卡，没有 next-card peek 或推荐横向 scroller；
- 两端都有 7 个日期；
- 桌面问题 2/3 为两列，问题 2 纵向行动、问题 3 纵向时间线；
- 手机问题 2/3 为上下单列；
- 桌面最多 5 条高亮，手机最多 3 条；
- 不存在按下标给活动配实体图片的逻辑；
- 首次 skeleton、空态、无缓存错误、缓存刷新失败和重试；
- 家庭动态失败不隐藏统计、推荐、日历和行动；
- `FamilyOverlayMode='activity'` 是唯一打开状态，首页与 Family 不再维护三个独立 boolean；
- “查看完整记录”同时导航到 Family 并按视口打开 activity modal/page，关闭后停留 Family；
- activity viewer 首次 loading 不闪 empty，无缓存错误可重试，有缓存刷新失败保留旧数据；
- Family overview 首次 loading/error 不显示伪造的 `0` 或空记录；
- `target:'week'` 导航到选中日期对应周，不自动打开任意计划项；既有 item 导航行为保持不变；
- 手机 Hero、Kitchen 图片、家庭信息 chips、双快捷操作和四项统计完整保留；
- 手机主交互保持 44px 级触控目标。

## 16. 响应式与端到端 smoke

### 16.1 视口矩阵

- `1440 × 960`；
- `1280 × 820` 与 `1180 × 820`；
- `1112 × 834`；
- `1024` 横屏触控；
- `430 × 932`；
- `390 × 844`；
- `375 × 812`；
- 小于 `360px` 的窄屏回归。

### 16.2 Smoke fixture

为 `frontend/scripts/smoke.mjs` 增加 `/api/activity-highlights` fixture，并继续将未知请求记录为失败。fixture 同时提供 5 条高亮和独立 `week_highlight_count`，确保手机只消费前三条而不是请求另一份数据。推荐 fixture 至少覆盖非 3 倍数候选，另用组件/model 测试覆盖 `N<3`；Family activity fixture 支持延迟和失败注入，验证 viewer 不闪空态。

### 16.3 Smoke 断言

- 首页没有 `/api/activity-logs` 请求；
- 桌面 3 个推荐，手机 1 个；
- 手机推荐是一张完整卡，没有下一张露边，连续换一个不跳项；
- 紧凑日历始终有 7 天；
- 手机日历 `scrollWidth > clientWidth`，确实可横向滚动；
- 手机 Hero meta chips 和日历分别可受控横滑，但根页面 `scrollWidth <= clientWidth`；
- 桌面问题 2/3 两列，内部均为一列列表；
- 手机问题 2/3 上下单列；
- 桌面 5 条高亮，手机 3 条；
- 固定 kind 图标，不存在活动与餐食图片的下标配对；
- 点击完整记录后，桌面打开 Family activity modal，手机打开 Family activity page；
- viewer 延迟返回时先显示 loading，不短暂显示 empty；失败时局部重试可用；
- 点击“查看完整周菜单”进入所选日期对应周，桌面聚焦 week section，手机打开轻量周菜单 presentation，均不自动打开 item；
- 手机原 Hero 与两个快捷操作可见；
- 页面无未知 API 请求、page error、console error 和非设计性横向溢出。

当前 GitHub `Frontend Smoke` job 设置了 `continue-on-error: true`。因此本期本地 smoke 是强制发布门；不能用 GitHub job 显示通过或允许失败替代本地执行结果。

## 17. 最终验证命令

在基于刷新后 PR 73 的实施分支上执行：

```bash
npm run db:up
npm run backend:migrate
(cd backend && .venv/bin/alembic heads)
npm run backend:typecheck
npm run backend:test
npm run backend:test:ai
npm run backend:test:service
npm run backend:test:search
npm --prefix frontend run quality
npm --prefix frontend run build
npm --prefix frontend run smoke
```

同时人工确认：

- 迁移在真实 MySQL 8.4 上成功；
- `alembic heads` 只返回一个 head；
- AI 聚合高亮改动后 Backend AI Tests 通过；
- PR 73 当前失败的 Backend Service/Search Tests 已修复并通过；
- PR 72/73 与 P0.3 合并后的 GitHub 必需检查全部绿色；
- 使用真实采购入库、盘点、菜单、餐食和家庭邀请流程验证首页结果；
- 完整审计仍保留细粒度活动，首页只出现预期的一条聚合高亮。

## 18. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 旧活动没有高亮，发布初期首页为空 | 明确不回填；提供解释性空态；真实新业务结果自然填充 |
| 新调用点误把普通 CRUD 放进首页 | `highlight=None` 默认关闭；准入矩阵；业务级测试 |
| AI composite 跨 kind 时被随意归成一种高亮 | 按实际 outcome classifier 归约；同 kind 才聚合；跨 kind 第一阶段 audit-only；不新增 generic kind |
| 普通 AI shopping-list CRUD 被误称为采购入库结果 | shopping-list 操作明确 audit-only；只有矩阵允许的实际原子采购入库可成为 `shopping` 高亮 |
| 批量或 AI 操作产生多条高亮 | 最外层 approval owner 写事务级聚合活动；逐项审计不带高亮；幂等断言 |
| `after_success` 在 savepoint 外导致业务、operation 与高亮不一致 | execute、必要 hook、classifier、activity/flush 处于同一 nested savepoint；逐故障点回滚测试 |
| 手工高亮与业务结果不一致 | 同 session、同事务；commit/rollback 失败测试 |
| 演员跨家庭解析 | 当前 family membership 限定；跨家庭测试；未知演员兜底 |
| 周计数在 UTC 或未来时间边界错误 | 起止时间显式转 naive UTC；不依赖 DB timezone；SQLite 与真实 MySQL 8.4 边界测试 |
| 推荐候选不是 3 的倍数，末页卡片不足或被复制 | 环形窗口；`N<pageSize` 只展示真实项；`N=0/1/2/4/5/6` 测试 |
| 手机“换一个”跳过推荐或露出下一张 | 独立 page size/游标；完整单卡断言；不使用推荐 scroller |
| Q2 恢复虚假“可入库”文案 | 使用待采购事实和共享 intake opener；组件文案断言 |
| Q2 先截断库存行动再插入采购导致优先级错乱 | 从未截断 eligible 集合合并，最后只 `slice(0, 3)`；纯函数测试 |
| Family activity 限为 20 条后静默低估现有统计 | 第一阶段 Family 保持完整查询；未来先增加精确统计契约再限流 |
| viewer 首次 fetching 闪出 empty，或失败被当成空数据 | 显式 loading/success-empty/error/stale 分支与局部 retry |
| Home、Family 桌面和手机使用不同 activity 打开状态 | `FamilyOverlayMode='activity'` 作为唯一业务状态，视口只改变 presentation |
| 周菜单入口只切 tab、没有对应周落点 | `target:'week'` 导航协议；桌面 week section 与手机轻量 presentation smoke |
| Hero 高亮请求失败时错误显示为 0 | 无缓存 loading/error 使用 `--`；仅成功的零值显示 `0` |
| 手机受控横滑被误判为页面横溢或破坏原 Hero | 仅 Hero meta chips 与紧凑日历受控横滑；同时断言根页面无横向溢出 |
| 家庭动态失败拖垮首页 | 查询不进入 boot loading；局部 skeleton/error/stale 状态 |
| PR 73 冲突或迁移 head 漂移 | 实施和合并前重新刷新 PR/heads；冲突和失败检查为硬发布门 |

## 19. 主要实施触点

后端：

- `backend/app/core/enums.py`
- `backend/app/models/domain.py`
- `backend/app/services/activity.py`
- `backend/app/services/clock.py`
- `backend/app/services/ai_operations/composite.py`
- `backend/app/services/ai_operations/approval_decisions.py`
- `backend/app/services/ai_operations/registry_types.py`
- `backend/app/services/ai_operations/draft_specs/`
- `backend/app/schemas/activity.py`
- `backend/app/api/activity_logs.py`
- 第一阶段准入矩阵对应的 shopping、inventory、meal plan、meal、family 与 AI operation 服务
- `backend/alembic/versions/`
- `backend/tests/activity/` 及对应业务测试目录

前端：

- `frontend/src/api/types.ts`
- `frontend/src/api/foodsApi.ts`
- `frontend/src/api/queryKeys.ts`
- `frontend/src/api/cacheInvalidation.ts`
- `frontend/src/app/useAppWorkspaceQueries.ts`
- `frontend/src/app/useAppHomeViewModel.ts`
- `frontend/src/app/useAppGlobalSearchNavigation.ts`
- `frontend/src/features/home/homeDashboardModel.ts`
- `frontend/src/features/home/useHomeDashboardState.ts`
- `frontend/src/features/home/HomeDashboard.tsx`
- `frontend/src/features/home/HomeMobileDashboard.tsx`
- `frontend/src/features/family/FamilySettings.tsx`
- `frontend/src/features/family/useFamilySettingsState.ts`
- `frontend/src/features/family/FamilyActivityViewer.tsx`
- `frontend/src/components/foods/FoodWorkspace.tsx`
- `frontend/src/components/foods/useFoodPlanState.ts`
- 手机 foods 周菜单 presentation 对应的新组件与样式文件（实施计划时按刷新后结构确定）
- `frontend/src/styles/01-home-dashboard.css`
- `frontend/src/styles/07-mobile.css`
- `frontend/scripts/smoke.mjs`

实施计划必须在写代码前再次核对这些路径与刷新后的 PR 73 是否一致，并按 TDD 拆成可独立验证和提交的小任务。

## 20. 最终验收清单

- [ ] 首页只回答三个已确认问题，顺序正确。
- [ ] 四项统计全部保留；桌面候选充足时 3 推荐、手机有候选时 1 推荐，候选不足按真实数据降级。
- [ ] 推荐 `N=0` 为空态、`0<N<pageSize` 只显示真实项、`N>=pageSize` 使用无窗口内重复的环形窗口；两端游标独立。
- [ ] 桌面和手机都保留 7 天紧凑日历。
- [ ] 手机原顶部 Hero、chips 和双快捷操作完整保留。
- [ ] 手机只在 Hero meta chips 与紧凑日历中受控横滑，推荐不横滑，根页面无横向溢出。
- [ ] 桌面问题 2/3 为约 56%/44% 两列，手机为上下单列。
- [ ] 问题 2 从未截断 eligible 集合合并后只截断一次，最多 3 条，复用 PR 72/73 能力且采购文案真实。
- [ ] 问题 3 桌面最多 5 条、手机最多 3 条，只展示结构化家庭结果。
- [ ] ActivityLog 仍是唯一审计事实来源，历史日志无回填。
- [ ] 高亮字段成对、同事务、默认关闭。
- [ ] Family 第一阶段只有邀请成员成功可产生 `family` 高亮，不新增角色、状态或移除能力。
- [ ] AI approval 按实际 outcome 分类：零候选 audit-only、单 kind 聚合一条、跨 kind audit-only，普通 shopping-list CRUD 不产生高亮。
- [ ] AI execute、必要 `after_success`、classifier、高亮写入与 flush 位于同一 nested savepoint，任一步骤失败都回滚业务结果和高亮。
- [ ] 失败、拒绝、冲突、回滚和幂等重放不产生重复高亮。
- [ ] 首页使用 `/api/activity-highlights`，不再查询完整 activity logs。
- [ ] Family activity query 第一阶段保持完整语义，现有统计不因预览截断而低估。
- [ ] 本周协作使用 `[Asia/Shanghai 周一 00:00, 当前时刻]` 的 `week_highlight_count`；naive UTC 边界正确，未来记录不计入。
- [ ] 本周协作无缓存 loading/error 显示 `--`，只有成功且真实为零才显示 `0`。
- [ ] 完整记录统一使用 `FamilyOverlayMode='activity'` 进入家庭工作区查看器，桌面/手机只切换 presentation。
- [ ] 家庭动态与 Family viewer 的 loading/error/empty/stale 状态可区分，首次 loading 不闪 empty，错误可局部重试。
- [ ] “查看完整周菜单”进入选中日期对应周，桌面和手机都有明确落点且不自动打开计划项。
- [ ] MySQL 8.4 迁移、单 Alembic head、后端、前端、build 和 smoke 全部通过。
- [ ] PR 73 已无冲突，Backend Service/Search 及其余质量门全部绿色。
