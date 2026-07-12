# Culina P0.2 快速盘点与采购批量入库设计规格

> 日期：2026-07-11
>
> 状态：设计已完成交互确认并吸收仓库核验意见，等待书面规格最终批准
>
> 产品语境：移动优先的中国家庭厨房工具
>
> 业务日期：第一阶段统一使用 Asia/Shanghai
>
> 对应产品问题：P0 第二点——数据维护成本过高，缺少快速纠错机制

## 1. 结论

本期交付两个共享一致性基础的家庭库存闭环：

1. 快速盘点与库存确认；
2. 采购完成批量入库。

两个流程共享：

- 结构化库存操作记录；
- 整数行版本令牌；
- 多对象原子事务；
- 人工确认时间、确认人和确认来源；
- 15 分钟内的条件式整次撤销；
- Ingredient、非精确 Ingredient、Food 三类适配逻辑；
- 本地可恢复草稿；
- 结构化冲突恢复；
- 后续库存新鲜度、做菜确认扣减可复用的基础。

本设计不把 Culina 变成家庭 ERP，也不要求家庭成员逐批次完成仓库式盘点。默认交互按家庭成员理解的“食材或成品整体”展开，只有发现异常时才进入批次明细。

## 2. 已确认的核心产品决策

以下决策已经在设计讨论中逐项确认：

1. 第一份规格同时覆盖快速盘点和采购完成批量入库。
2. Ingredient 与 Food 统一产品入口，但不强行统一底层库存模型。
3. 盘点默认按食材整体快速确认，异常时才展开 Ingredient 批次。
4. “只记录有无”的 Ingredient 增加家庭级模糊状态。
5. 模糊状态包含：还在、少量、充足、没有了。
6. 少量只产生补货建议，不自动创建采购项。
7. 批量采购由用户显式勾选本次买到的项目。
8. 精确数量默认带出计划采购量，用户只修改差异。
9. 部分买到时，实际数量入库，原采购项保留剩余数量并继续未完成。
10. 公共购买日期、档案存放位置和到期规则自动带出，仅编辑例外。
11. 盘点动作先保存在本地草稿，完成时由后端原子提交。
12. 操作提交后 15 分钟内、且所有对象均无后续变化时，允许整次撤销。
13. 盘点数量差异独立记为盘点调整，不算消费，也不算销毁。
14. 非精确状态按整个家庭中的 Ingredient 保存，不按批次或位置分别保存。
15. 精确 Ingredient 继续以 InventoryItem 为当前库存事实来源，Food 继续以 Food 聚合字段为当前库存事实来源。
16. IngredientInventoryState 是非精确 Ingredient 当前状态、位置和日期的唯一事实来源；新写入不再创建 quantity = 1 的占位 InventoryItem。
17. 历史非精确占位 InventoryItem 只作迁移兼容和历史证据，不参与当前可用性、到期提醒、搜索、菜谱或 AI 判断。

## 3. 与 P0 第一项的关系

P0 第一项已有独立规格和实施计划：

- docs/superpowers/specs/2026-07-11-home-action-center-design.md
- docs/superpowers/plans/2026-07-11-home-action-center.md

本设计不得重复或覆盖其中已规划的职责。

共享边界：

- P0 第一项处理首页行动中心、到期分组、过期销毁、暂时保留、稍后提醒和日期纠错。
- 本期处理库存盘点、采购批量入库、结构化操作记录和撤销。
- P0 第一项计划新增 InventoryItem.row_version；如果已经实施，本期必须复用。
- P0 第一项计划创建 frontend/src/features/inventory；本期在同一业务目录增加职责明确的新文件。
- P0 第一项的 InventoryActionDialog 继续负责到期动作，本期不将采购或整次盘点塞入该 Dialog。
- 后台任务中心仍只展示真正的异步后台任务，不承载库存提醒或库存撤销。

实施时必须先检查当前 Alembic head、模型和 feature 目录，不能机械地再次创建同名字段或文件。

## 4. 仓库现状与根因

### 4.1 当前库存 API 缺少纠错边界

当前库存 API 主要包括：

    GET  /api/inventory
    GET  /api/inventory/overview
    POST /api/inventory
    POST /api/inventory/consume
    POST /api/inventory/dispose
    POST /api/inventory/dispose-expired

当前没有：

- 单个批次更新接口；
- 批量确认现有库存；
- 一次提交多个“确认、清零、数量变化”；
- 盘点操作记录；
- 盘点撤销；
- 独立人工确认时间；
- 库存数据新鲜度。

因此快速盘点不能只做前端 checklist，必须新增后端原子业务边界。

### 4.2 updated_at 不能代表人工确认

当前 InventoryItem 和 Food 的 updated_at 会被多种动作更新：

- 普通消费；
- 做菜自动扣减；
- 销毁；
- AI 批准后的正式写入；
- 修改备注；
- Food 资料编辑。

这些动作不能证明家庭成员真的看过冰箱，因此必须增加独立确认字段。

### 4.3 已有两种数量跟踪模式

Ingredient 已有：

- track_quantity：记录精确数量；
- not_track_quantity：只记录有无。

本期不为精确 Ingredient 增加模糊数量，也不允许同一库存同时保存精确数字和“少量/充足”作为两套真相。

新增“少量/充足”只服务 not_track_quantity，并按家庭中的 Ingredient 整体保存。

### 4.4 当前采购完成不是原子事务

现有 Ingredient 流程为：

    createInventory()
    然后 updateShoppingItem(done=true)

现有 Food 流程也为：

    restockFoodStock()
    然后 updateShoppingItem(done=true)

这会出现：

- 库存已经增加；
- 采购项仍未完成；
- 用户重试后重复入库。

首页、Ingredient 工作区和 Food 工作区都必须切换到同一个原子 intake endpoint。

### 4.5 当前没有安全撤销基础

ActivityLog 只有动作、实体、摘要和时间，没有结构化前后快照，无法安全恢复。

本期不做通用撤销，而是只为新建的盘点和采购入库 operation 保存必要快照，并在严格版本条件下允许整次撤销。

### 4.6 当前非精确 Ingredient 可能有重复占位批次

当前每次为 not_track_quantity 创建库存时，内部仍可能生成 quantity = 1 的 InventoryItem，后端没有保证只创建一次。

因此模糊状态不能放在每个库存批次上，否则同一食材可能同时出现少量、充足和还在。

这些占位批次当前还承载 purchase_date、expiry_date、storage_location、status 和 notes，并被库存总览、食材工作区、菜谱可用性、搜索和 AI 库存读取使用。因此不能只停止创建占位批次而丢弃这些信息；本期必须把非精确食材仍需要的家庭级当前元数据一起迁移到 IngredientInventoryState，并同步切换所有读取路径。

## 5. 本期范围

### 5.1 包含

- Ingredient 精确库存快速确认；
- Ingredient 批次数量、日期、位置纠错；
- 漏记批次补录；
- 非精确 Ingredient 家庭级模糊状态；
- Food 聚合库存确认和调整；
- 按存放范围盘点；
- 建议确认列表；
- 本地可恢复草稿；
- 原子提交和结构化冲突；
- 采购多选；
- 实际购买数量确认；
- 部分购买；
- 自由文本仅完成或关联后入库；
- Ingredient、Food、非精确 Ingredient 的采购入库；
- 操作记录、操作详情和条件式撤销；
- 首页和工作区旧双 mutation 清理；
- 人工确认新鲜度基础；
- 版本令牌和旧写入路径兼容。

### 5.2 不包含

- 做菜完成后的逐食材实际扣减确认；
- “这次不扣库存”；
- 在做菜完成弹窗改变全局跟踪模式；
- 重复 Ingredient 检测与合并；
- 无效测试数据自动清理；
- 菜谱或 AI 推荐正式降权；
- 完整库存事件溯源；
- Food 批次化；
- 跨设备恢复未提交草稿；
- 多人共同编辑同一盘点草稿；
- 家庭自定义时区；
- 为精确 Ingredient 或 Food 增加少量/充足；
- AI 自动发起整次盘点或自动撤销。

## 6. 用户流程：快速盘点

### 6.1 入口

库存工作区提供“快速盘点”。

范围：

- 建议确认；
- 冷藏；
- 冷冻；
- 常温；
- 全部。

如果 P0 第一项已上线，首页“长期未确认”行动可以导航到该入口，但快速盘点不能依赖首页才能使用。

### 6.2 默认展示单位

列表按家庭成员理解的对象展示：

    西红柿
    当前共 6 个 · 冷藏 · 2 个批次

    卤牛肉
    当前 2 份 · 冷藏

    盐
    只记录有无 · 当前少量

Ingredient 批次只有在“调整数量”或展开详情时出现。

### 6.3 精确 Ingredient 动作

- 确认无误：确认当前总量和观察到的批次仍可信，不改数量；
- 调整数量：展开批次，填写实际剩余量；
- 没有了：把本次盘点范围内全部物理剩余量大于 0 的批次调整为 0，包括已经过期但仍记录为存在的批次。

批次展开支持：

- 修改实际剩余量；
- 将不存在的批次调整为 0；
- 增加漏记批次；
- 修改购买日期；
- 修改到期日期；
- 修改存放位置；
- 可选盘点备注。

### 6.4 非精确 Ingredient 动作

- 还在：present_unknown；
- 少量：low；
- 充足：sufficient；
- 没有了：absent。

非精确 Ingredient 使用家庭级整体状态：

- 还在、少量或充足时保留当前 purchase_date、expiry_date、storage_location、inventory_status 和 notes，用户展开例外信息时可以修正；
- 采购入库会用本次购买日期、显式或默认位置、到期规则和状态更新同一条 State；
- 没有了时清空 purchase_date 和 expiry_date，避免已经不存在的食材继续产生到期提醒；
- 没有了时 storage_location 回落为空，展示和下次补充默认使用 Ingredient.default_storage；
- 快速确认有无不是食品安全复核，不更新 P0 第一项的过期复核或提醒延后字段。

少量提交后：

- 已有同 ingredient_id 的未完成采购项：显示已在采购清单；
- 没有：显示一键加入采购；
- 不自动写购物清单。

### 6.5 Food 动作

- 确认无误；
- 调整数量；
- 没有了。

Food 仍是聚合库存，不显示 Ingredient 批次。

### 6.6 到期边界

盘点确认库存是否存在，不代表过期后仍可食用。

- 过期状态始终保留；
- 确认无误不更新过期复核字段；
- 不延长提醒；
- 不执行 snooze；
- 不把盘点确认解释成食品安全判断。

按冷藏、冷冻或常温盘点时，“完整观察集合”统一定义为：

- 当前存放范围内所有物理剩余量大于 0 的 InventoryItem；
- 包括已过期批次；
- 不包括范围之外的批次；
- 不包括 remaining_quantity = 0 的历史批次。

confirm_all 只确认当前范围内的批次；adjust_batches 只调整当前范围内的批次；set_absent 清零当前范围内全部物理剩余批次。范围外批次虽然不进入 observed_batches，但其并发变化仍会递增 Ingredient.row_version，并按保守策略使本次提交返回 409。

### 6.7 草稿与提交

盘点期间只更新本地草稿。

未触碰项目：

- 不进入 payload；
- 不更新确认时间；
- 不因为打开页面就被视为确认。

提交前展示：

    确认无误             9 项
    库存数量调整         2 项
    标记少量             1 项
    调整为没有           1 项
    新增漏记批次         1 项

提交由后端全有或全无地处理。

## 7. 用户流程：采购批量入库

### 7.1 入口

购物清单提供“登记本次购买”。

点击单项“买到了”时：

- 打开同一流程；
- 当前项预选；
- 可以继续选择本次一起买到的其他项目。

从批量入口打开时不默认全选。

### 7.2 三步流程

    选择本次买到的项目
        ↓
    核对实际数量与例外信息
        ↓
    确认入库

### 7.3 精确数量

- 实际数量默认计划值；
- 用户只修改差异；
- 实际量小于计划量时显示入库 X、还差 Y；
- 实际量大于计划量时按实际量全部入库；
- 单位使用现有 Ingredient 换算规则；
- 无法换算时拒绝，不能猜测。

### 7.4 部分购买

    actual = 0
    → 不写库存，采购项保持未完成
    → 前端将该项视为本次未买到并取消选中
    → 后端拒绝 actual = 0 的 stock_and_fulfill 空操作

    0 < actual < planned
    → 实际数量入库
    → 原采购项数量改为剩余量
    → 原采购项保持未完成

    actual >= planned
    → 实际数量全部入库
    → 原采购项完成

### 7.5 非精确 Ingredient

- 不提交伪数量；
- 买到后默认建议 sufficient；
- 默认值必须可见；
- 用户可以改为 present_unknown 或 low；
- 买到后不能提交 absent；
- 在同一事务中创建或更新 IngredientInventoryState，不创建 InventoryItem；
- 本次 purchase_date、expiry_date、storage_location、inventory_status 和 notes 写入 State；
- 如果家庭原本已有该食材，本次仍更新家庭级整体元数据，UI 必须明确“只记录整体有无，不区分多个批次”。

### 7.6 公共和智能默认

- 公共购买日期默认家庭业务当天；
- Ingredient 存放位置取 default_storage；
- 买后 N 天到期自动计算；
- 无到期模式保持空；
- 手动日期必须确认；
- Food 使用现有 stock_unit 和 storage_location；
- Food 没有可靠规则时不猜测到期日；
- 每项都能展开修改例外。

### 7.7 自由文本

自由文本项目可以：

- 仅标记已买，不进入库存；
- 关联现有 Ingredient 或 Food 后在同一事务入库。

禁止：

- title.includes；
- 子串自动匹配；
- 牛奶匹配牛奶麦片；
- 油匹配酱油。

## 8. 数据模型

### 8.1 新增枚举

InventoryOperationType：

- reconciliation；
- shopping_intake。

InventoryOperationStatus：

- applied；
- reverted。

InventoryOperationEntityType：

- ingredient；
- inventory_item；
- non_tracked_ingredient_state；
- food；
- shopping_list_item。

InventoryOperationChangeType：

- create；
- update；
- delete。

InventoryAvailabilityLevel：

- present_unknown；
- low；
- sufficient；
- absent。

InventoryConfirmationSource：

- manual_entry；
- reconciliation；
- shopping_intake。

ActivityAction 增加 revert。

### 8.2 inventory_operations

字段：

    id
    family_id
    operation_type
    status
    client_request_id
    request_hash
    actor_id
    applied_at
    revertible_until
    reverted_at
    reverted_by
    summary_json
    created_at
    updated_at

约束：

    UNIQUE(family_id, client_request_id)
    INDEX(family_id, applied_at)
    INDEX(family_id, status, revertible_until)

相同 request ID、相同规范化 payload 返回第一次结果；相同 ID、不同 payload 返回 409。

### 8.3 inventory_operation_lines

字段：

    id
    operation_id
    sequence
    entity_type
    entity_id
    change_type
    before_snapshot
    after_snapshot
    before_row_version
    after_row_version
    change_metadata
    snapshot_schema_version
    created_at

约束：

    UNIQUE(operation_id, sequence)
    UNIQUE(operation_id, entity_type, entity_id)

同一实体在一次 operation 中只保留一条最终 before/after。

一次 operation 只要创建、更新或删除某个 Ingredient 的 InventoryItem 或 IngredientInventoryState，就必须额外保存一条 ingredient 集合版本守卫 line；同一 Ingredient 无论改多少批次仍只保存一条。该守卫参与撤销前版本校验，防止 operation 之后新增或修改了同食材的其他批次，却因为原 operation line 没直接引用那些批次而被错误撤销。

### 8.4 快照白名单

InventoryItem 快照：

- 库存身份和家庭；
- 数量、消费量、销毁量；
- 单位和原始录入单位；
- 状态、日期、位置、备注和阈值；
- 人工确认信息；
- row_version。

IngredientInventoryState 快照：

- State ID、family_id 和 ingredient_id；
- availability_level；
- inventory_status；
- purchase_date、expiry_date；
- storage_location、notes；
- 人工确认信息；
- expiry_alert_snoozed_until、expiry_reviewed_at、expiry_reviewed_by；
- row_version。

Ingredient 集合版本守卫快照：

- Ingredient ID、family_id；
- quantity_tracking_mode；
- row_version；
- change_metadata.role = collection_version_guard。

它不用于恢复 Ingredient 档案字段，只用于证明该 Ingredient 的批次或 State 集合在 operation 后没有其他变化。撤销成功时和其他实体一样继续递增 Ingredient.row_version，不回退旧版本。

Food 快照只保存库存相关字段：

- stock_quantity；
- stock_unit；
- storage_location；
- expiry_date；
- inventory confirmation 字段；
- row_version。

ShoppingListItem 快照：

- 目标 ID；
- 标题、数量、单位、quantity_mode；
- display_label、reason、done；
- row_version。

不保存认证、token、密码、完整用户资料或 AI 对话。

### 8.5 ingredient_inventory_states

字段：

    id
    family_id
    ingredient_id
    availability_level
    inventory_status
    purchase_date
    expiry_date
    storage_location
    notes
    expiry_alert_snoozed_until
    expiry_reviewed_at
    expiry_reviewed_by
    last_confirmed_at
    last_confirmed_by
    last_confirmation_source
    row_version
    created_at
    updated_at
    created_by
    updated_by

约束：

    UNIQUE(family_id, ingredient_id)
    INDEX(family_id, availability_level)
    INDEX(family_id, storage_location, availability_level)
    INDEX(family_id, expiry_date)
    INDEX(family_id, last_confirmed_at)

expiry_reviewed_by 和 last_confirmed_by 使用可空 User 外键并 ON DELETE SET NULL；所有查询仍必须先按 family_id 限定，外键本身不代替家庭归属校验。

状态记录不存在表示当前没有可用状态且从未确认；显式 absent 表示有人确认过没有。

字段语义：

- availability_level 是当前有无和模糊余量的唯一事实；
- inventory_status 使用现有 InventoryStatus，默认 fresh；
- purchase_date、expiry_date、storage_location 和 notes 是非精确食材的家庭级当前元数据，不表达批次历史；
- absent 时 purchase_date、expiry_date 和 storage_location 为 null，notes 可以保留家庭成员的说明；
- absent 时 expiry_alert_snoozed_until、expiry_reviewed_at 和 expiry_reviewed_by 同时清空；
- present_unknown、low、sufficient 时 storage_location 必须非空，默认取 Ingredient.default_storage 或“常温”；
- expiry_date 可以为空，规则继续复用 Ingredient.default_expiry_mode/default_expiry_days；
- 到期提醒、暂时保留、稍后提醒和日期纠错复用 P0 第一项已经确认的语义；日期变化必须清空旧 review/snooze，普通盘点确认不得改写这些字段；
- last_confirmed_* 只记录人工手工补充、采购入库或快速盘点，不从历史 updated_at 推断。

非精确 State 的“物理存在”和“当前可用于做菜”必须分开：

    physically_present = availability_level in (present_unknown, low, sufficient)
    usable_for_recipe = physically_present and (expiry_date is null or expiry_date >= business_date)

库存盘点按 physically_present 纳入位置范围，因此过期的盐或酱料仍可被确认、纠错或设置没有；菜谱可用性、meal ideas 和可食用库存统计按 usable_for_recipe 判断，不能因为状态仍是 sufficient 就把过期食材当可用。首页和库存总览仍展示这条 State，并以过期行动优先处理。

### 8.6 非精确 Ingredient 的唯一事实来源

新版本上线后：

- 普通手工补充通过专用 State 写入边界创建或更新 IngredientInventoryState；
- 来源于 ShoppingListItem 的补充通过 shopping intake 更新 State；
- 快速盘点通过 reconciliation 更新 State；
- AI 批准后的非精确补充复用同一个 State service；
- 上述路径一律不再创建 quantity = 1 的 InventoryItem。

当前状态读取必须统一切换：

- GET /api/inventory/overview；
- Ingredient 工作区及 storage groups；
- 首页行动中心的到期和当前在库统计；
- recipe cook preview、recipe cook 和可用性判断；
- 搜索文档与 hybrid search；
- AI inventory summary、meal ideas 和相关只读工具。

历史 not_track_quantity InventoryItem：

- 保留原记录，不在本期物理删除；
- 不参与当前 availability、expiry、storage scope、recipe readiness、search 或 AI 结果；
- 不允许普通编辑、消费、销毁或新的到期动作继续改变当前状态；
- 只允许迁移、审计和受控跟踪模式切换代码读取；
- API 如需暴露历史上下文必须显式标为 legacy，不得混入当前 InventoryItem 列表。

P0 第一项集成必须复用同一套 inventoryActionModel 和 InventoryActionDialog：Action group 以 target_kind = inventory_item | ingredient_inventory_state 区分目标，State 的销毁语义是原子设置 absent，State 的提醒与日期纠错更新 State 自身字段。不得复制第二套非精确到期弹窗，也不得把 State ID 伪装成 InventoryItem ID。

### 8.7 现有表新增字段

Ingredient：

    row_version

InventoryItem：

    row_version
    last_confirmed_at
    last_confirmed_by
    last_confirmation_source

Food：

    row_version
    inventory_last_confirmed_at
    inventory_last_confirmed_by
    inventory_confirmation_source

ShoppingListItem：

    row_version

## 9. 精确库存盘点调整

当前剩余量：

    remaining = quantity - consumed_quantity - disposed_quantity

盘点实际剩余量 actual_remaining 写入：

    new_quantity =
        consumed_quantity
        + disposed_quantity
        + actual_remaining

示例：

    原 quantity       10
    consumed          2
    disposed          1
    原 remaining       7
    用户确认 remaining 5
    新 quantity        8

这样：

- consumed 不变；
- disposed 不变；
- remaining 为 5；
- operation delta 为 -2；
- 不污染消费和浪费统计。

盘点不覆盖 entered_quantity 和 entered_unit。新增漏记批次才写新的 entered 数据。

## 10. Food 聚合规则

Food 第一版不批次化。

采购数量：

    new_stock = current_stock + actual_purchase

盘点：

    stock_quantity = user_confirmed_total

单位：

- 必须与 stock_unit 一致；
- 不做不存在的 Food 单位换算。

到期日：

- 当前库存为 0：使用本次确认的到期日期；
- 新旧都有日期：保留较早日期；
- 只有一个日期：保留非空日期；
- 都为空：继续为空。

存放位置：

- Food 只有一个全局位置；
- 修改时必须明确影响全部 Food 库存；
- 不伪装成只修改本次购买批次。

## 11. 人工确认新鲜度

第一版不用伪精确百分比分数，只使用：

- never_confirmed；
- current；
- stale。

第一版不输出 changed_since_confirmation。现有 InventoryItem、Food 和 State 的 row_version 只承担并发保护；尤其 Food 的备注、图片、评分和库存字段共用同一行，普通资料编辑造成的版本变化不能被解释为库存自确认后发生变化。后续真正把新鲜度接入推荐或 AI 前，应增加只在库存相关字段变化时递增的 inventory_revision/confirmed_inventory_revision，或等价的 inventory_changed_at，再单独设计该状态。

建议重新确认周期：

| 对象 | 周期 |
|---|---:|
| Food | 7 天 |
| 冷藏 Ingredient | 14 天 |
| 冷冻 Ingredient | 30 天 |
| 常温 Ingredient | 30 天 |
| 非精确 Ingredient | 30 天 |

精确 Ingredient 组：

- 任一当前盘点范围内物理剩余量大于 0 的批次从未确认：整组 never_confirmed；
- 任一当前盘点范围内物理剩余量大于 0 的批次 stale：整组 stale；
- 全部当前：整组 current；
- 组级上次确认显示最早批次确认时间。

非精确 Ingredient 直接根据 IngredientInventoryState.last_confirmed_at 计算；历史占位 InventoryItem 的确认时间和 updated_at 均不参与。Food 根据 inventory_last_confirmed_at 计算。

自动扣减、消费、销毁和 AI 只读不能更新人工确认时间。

## 12. API 合约

### 12.1 API 列表

    GET  /api/inventory/reconciliation
    POST /api/inventory/reconciliations

    GET  /api/inventory/states
    PUT  /api/inventory/states/{ingredient_id}

    POST /api/shopping-list/intakes

    GET  /api/inventory/operations
    GET  /api/inventory/operations/{operation_id}
    POST /api/inventory/operations/{operation_id}/revert

现有 Inventory、Food 和 Shopping 输出扩展 row_version 与确认字段。新增 IngredientInventoryStateOut；库存 overview、首页 projection 和 AI serializer 通过服务层合并 State，不把 State 伪装成 InventoryItemOut。

GET /api/inventory/states 返回当前家庭的 IngredientInventoryStateOut，可选按 ingredient_ids 筛选；包含显式 absent，便于工作区区分“已确认没有”和“从未建立状态”。现有 GET /api/inventory 只返回 track_quantity 的当前 InventoryItem，不返回 State，也不混入历史 not_track_quantity 占位行。

现有 POST /api/inventory 只创建 track_quantity 的 InventoryItem。对 not_track_quantity 调用返回结构化 422 presence_state_required，前端普通“补充库存”必须根据 quantity_tracking_mode 调用 inventory-state endpoint，不能继续依赖旧占位兼容行为。

### 12.2 盘点读取

查询参数：

    scope=all|refrigerated|frozen|room_temperature|suggested
    storage_location=<optional>

返回：

- business_date；
- business_timezone；
- generated_at；
- summary；
- 三类判别联合 groups。

精确 Ingredient 返回 Ingredient 版本和当前查询范围内全部物理剩余量大于 0 的观察批次版本，包括过期批次。

非精确 Ingredient 返回 state ID、版本、availability、家庭级日期/位置/状态元数据和待买去重结果。

非精确 Ingredient 的范围归属只看 State.storage_location；同一 State 最多进入一个存放范围。State 不存在或 availability_level=absent 时不进入冷藏、冷冻、常温或 suggested 的当前库存盘点列表。迁移创建且 last_confirmed_at=null 的 present_unknown State 才会作为 never_confirmed 进入 suggested。

Food 返回聚合库存版本和确认状态。

### 12.3 精确 Ingredient 提交

动作：

- confirm_all；
- set_absent；
- adjust_batches。

必须提交：

- expected_ingredient_row_version；
- observed_batches 完整 ID 与版本集合。

observed_batches 的“完整”只针对本次 scope：

- scope=all：家庭内该 Ingredient 所有 remaining_quantity > 0 的批次；
- scope=refrigerated/frozen/room_temperature：该位置范围内所有 remaining_quantity > 0 的批次；
- 包含已过期批次；
- 不包含 remaining_quantity = 0 的历史批次；
- 不包含范围外批次。

服务端先按同一 scope 重建当前集合并比较 ID 与 row_version；随后仍校验 expected_ingredient_row_version，因此范围外新建、编辑、消费或销毁造成的 Ingredient 集合版本变化也会保守返回 409，而不会静默合并。

adjust_batches 另外提交：

- 现有批次 update；
- 新批次 create；
- actual_remaining_quantity；
- 单位、日期、位置和状态。

新批次使用 client_line_id，不允许客户端伪造数据库 ID。

### 12.4 非精确 Ingredient 提交

提交：

- ingredient ID；
- expected Ingredient version；
- state ID；
- expected state version；
- availability_level；
- inventory_status；
- purchase_date、expiry_date；
- storage_location、notes。

状态原本不存在时，state ID 和 expected version 都为 null。服务端锁父 Ingredient 并用唯一约束处理并发创建。

PUT /api/inventory/states/{ingredient_id} 使用相同 payload 和并发规则，服务于普通手工补充。availability_level=absent 时服务端强制清空 purchase_date、expiry_date 和 storage_location。

### 12.5 Food 提交

动作：

- confirm；
- set_stock。

set_stock 提交：

- expected row version；
- stock quantity；
- stock unit；
- location；
- expiry date。

没有了统一表示 stock_quantity = 0。

### 12.6 Shopping intake

顶层：

    client_request_id
    purchase_date
    items

每项：

    shopping_item_id
    expected_shopping_item_row_version
    action

action：

- stock_and_fulfill；
- complete_without_inventory。

精确 Ingredient 提交实际数量、单位、状态、日期和位置。

非精确 Ingredient 提交 resulting_availability_level、inventory_status、日期、位置和 notes，不提交伪数量，不创建 InventoryItem。

Food 提交实际数量、单位、日期和位置。

自由文本可以在同一请求中关联真实目标。

### 12.7 Operation

列表默认最近 20 条，最大 50。

详情返回家庭成员可理解的变化，不原样暴露内部 snapshot。

撤销接口天然幂等；重复撤销返回当前 reverted 状态，不重复修改数据。

## 13. 并发、锁与幂等

### 13.1 版本令牌

updated_at 不作为并发令牌。

使用整数 row_version：

    1, 2, 3...

服务端：

1. 稳定排序；
2. SELECT FOR UPDATE；
3. family_id 校验；
4. expected version 校验；
5. 业务校验；
6. 写入；
7. 版本递增；
8. 保存 after version；
9. 一次提交。

所有旧写入路径也必须递增版本。

### 13.2 Ingredient 集合版本

仅比较现有 InventoryItem 版本不能发现新建批次。

因此：

- 客户端提交 observed batch ID set；
- 服务端按本次 scope 比较当前物理剩余量大于 0 的 batch ID set，包括过期批次；
- 所有 InventoryItem 写入同时 bump Ingredient.row_version；
- 所有 IngredientInventoryState 创建、更新、到期动作和设置 absent 同时 bump State.row_version 与 Ingredient.row_version。

### 13.3 全局锁顺序

    1. InventoryOperation（撤销时）
    2. Ingredient，按 ID
    3. Food，按 ID
    4. IngredientInventoryState，按 ID 或 ingredient_id
    5. InventoryItem，按 ID
    6. ShoppingListItem，按 ID

不同业务 service 使用相同顺序。

### 13.4 幂等

client_request_id 由前端草稿创建时生成。

- 同 ID、同 hash：返回原结果；
- 同 ID、不同 hash：409；
- 原操作撤销后相同 ID 重试：返回 reverted，不重新执行；
- 新操作必须使用新 ID。

请求 hash 基于规范化业务 payload，数量用稳定十进制，字段顺序不影响。

### 13.5 事务

一次请求只有一次 commit。

任何错误：

- rollback；
- 无部分库存；
- 无部分采购完成；
- 无半个 operation；
- 无虚假成功 ActivityLog。

不使用 207，不提供部分成功。

## 14. 撤销

撤销条件：

1. operation 属于当前家庭；
2. operation 仍是 applied；
3. 当前时间不晚于 revertible_until；
4. 当前用户是原操作者或 Owner；
5. 所有实体当前版本等于 operation line 的 after version；
6. 新建批次没有被消费、销毁或后续修改。

第 5 条包括 ingredient 集合版本守卫。只要同一 Ingredient 的任一其他批次或 State 在 operation 后变化，撤销整次返回 operation_modified_after_apply，不做部分恢复。

撤销是整次原子操作，不支持部分撤销。

恢复后 row_version 继续增加，不回退：

    提交前 4
    提交后 5
    撤销后 6

新建对象在安全条件下删除；更新对象恢复 before snapshot 白名单字段。

## 15. 权限与家庭隔离

Owner 和 Member 都可以：

- 查看盘点；
- 提交盘点；
- 批量采购入库；
- 查看家庭 operation；
- 撤销自己的 operation。

只有 Owner 可以撤销其他成员的 operation，但不能绕过时间和版本条件。

请求不接受 family_id、actor_id、created_by、updated_by 或 reverted_by。

每个 Ingredient、Food、InventoryItem、State、ShoppingItem 和 Operation 都独立按当前 membership.family_id 校验。

跨家庭资源统一返回 404，避免泄露存在性。

## 16. 跟踪模式切换

快速盘点和采购流程不提供顺手切换全局模式。

现有 Ingredient 编辑器必须增加安全护栏。

精确到非精确：

- 有剩余默认建议 present_unknown；
- 无剩余默认建议 absent；
- 用户可以确认 low 或 sufficient；
- 不删除历史精确批次；
- 模式切换事务创建或更新 IngredientInventoryState，并把用户明确选择的家庭级位置、日期、状态写入 State；
- 原精确批次从切换成功起转为历史，不再参与当前状态读取；
- 单纯改变档案模式不能伪造人工确认。

非精确到精确：

- 不能把旧占位数量 1 当真实库存；
- 用户必须确认当前没有，或填写真实初始库存；
- 模式变化和初始库存处理同一事务；
- 原 IngredientInventoryState 转为 absent 并清空当前日期、位置，保留审计和 operation 之外不再参与当前精确库存读取；
- 任一校验失败，模式也不能改变。

模式切换属于 Ingredient 档案编辑，不提供本期 15 分钟 operation 撤销。

## 17. 后端职责拆分

新增：

    backend/app/api/inventory_states.py
    backend/app/api/inventory_reconciliation.py
    backend/app/api/inventory_operations.py
    backend/app/api/shopping_intake.py
    backend/app/schemas/inventory_operations.py
    backend/app/schemas/inventory_states.py
    backend/app/repos/inventory_operations.py
    backend/app/services/ingredient_inventory_state.py
    backend/app/services/inventory_confirmation.py
    backend/app/services/inventory_reconciliation.py
    backend/app/services/inventory_operation_history.py
    backend/app/services/inventory_operation_locking.py
    backend/app/services/inventory_versions.py
    backend/app/services/shopping_intake.py

主要 service：

- ingredient_inventory_state：非精确 State 唯一读写、默认值、历史隔离和序列化；
- inventory_confirmation：状态和新鲜度；
- inventory_reconciliation：三类盘点适配；
- shopping_intake：四类采购适配；
- inventory_operation_history：展示、撤销和快照；
- inventory_operation_locking：统一锁顺序；
- inventory_versions：版本校验和 Ingredient 集合版本。

路由只负责认证、schema、调用 service、HTTP 映射和一次提交。

## 18. 现有后端路径改造

必须同步检查：

- inventory.py；
- shopping_list.py；
- foods.py；
- ingredients.py；
- inventory_operations.py；
- inventory_usage.py；
- inventory_overview.py；
- food_stock.py；
- serializers.py；
- AI inventory/shopping/food operations；
- recipe cook 和普通消费、销毁。

规则：

- 手工入库写 manual_entry；
- not_track_quantity 手工补充写 IngredientInventoryState，POST /api/inventory 不再创建占位批次；
- 消费和销毁不更新确认；
- dispose-expired 改为稳定排序和 FOR UPDATE；
- Food 手工补货可以确认；
- 来源于 ShoppingItem 的任何入库必须走 intake；
- AI 批准写入复用统一 service；
- AI 只读不写确认；
- inventory_usage、inventory_overview、search/hybrid、AI inventory/meal ideas、recipe cook 全部从 State 判断非精确可用性；
- P0 第一项的首页分组和到期动作读取 State 的 expiry_date，历史占位批次不得继续生成行动项。

## 19. 活动日志

普通单项手工入库保留现有活动。

快速盘点和批量采购各写一条聚合活动：

    林然完成了一次冰箱盘点：确认 9 项，调整 3 项
    林然登记了本次购买：完成 5 项，部分买到 2 项
    林然撤销了刚才的采购入库

每项细节进入 InventoryOperation detail，不用 ActivityLog 刷屏。

## 20. 前端架构

新增：

    frontend/src/api/inventoryStatesApi.ts
    frontend/src/api/inventoryOperationsApi.ts

    frontend/src/features/inventory/inventoryReconciliationModel.ts
    frontend/src/features/inventory/useInventoryReconciliationState.ts
    frontend/src/features/inventory/useInventoryReconciliationActions.ts
    frontend/src/features/inventory/InventoryReconciliationDialog.tsx

    frontend/src/features/inventory/shoppingIntakeModel.ts
    frontend/src/features/inventory/useShoppingIntakeState.ts
    frontend/src/features/inventory/useShoppingIntakeActions.ts
    frontend/src/features/inventory/ShoppingIntakeDialog.tsx

    frontend/src/features/inventory/InventoryOperationBanner.tsx
    frontend/src/features/inventory/InventoryMaintenanceDialogs.tsx

新增样式：

    frontend/src/styles/11-inventory-maintenance.css

修改：

- api types、client、query keys、cache invalidation；
- IngredientWorkspace；
- IngredientHubPage；
- IngredientWorkspacePanels；
- IngredientMobileView；
- 现有 Ingredient overlay/action Hook；
- 首页现有 State、Actions 和 Dialogs；
- App mutation 连接；
- UI kit 无障碍能力。

普通手工补充必须同时改造：

- track_quantity 继续使用 createInventory/POST /api/inventory；
- not_track_quantity 改用 upsertIngredientInventoryState/PUT /api/inventory/states/{ingredient_id}；
- Ingredient 工作区并行读取 GET /api/inventory 和 GET /api/inventory/states，再由 view model 形成统一展示；
- API 类型、query key 和 cache invalidation 同步覆盖 State；
- workspaceModel 不再用 quantity-disposed 判断非精确有无；
- 首页、存放位置分组和最近补充信息读取 State projection。

不新建重复的 useHomeDashboardState、useHomeDashboardActions、useIngredientOverlayState 或 useIngredientActionState。

## 21. 前端草稿

存储 key：

    culina:inventory-reconciliation-draft:{familyId}:{userId}

采购草稿使用同样按家庭和用户隔离的独立 key。

草稿保存：

- schemaVersion；
- familyId；
- userId；
- clientRequestId；
- scope；
- createdAt、savedAt；
- 用户操作意图。

有效期 24 小时。

恢复时请求最新数据并重放：

- 版本一致：保留；
- 版本变化：冲突；
- 实体消失：移出有效提交；
- 新实体出现：加入列表但不自动确认；
- tracking mode 变化：原动作无效。

离线可以继续编辑草稿，但不能乐观提交真实库存。

## 22. 前端 UI

### 22.1 移动端盘点

使用接近全高的任务 sheet：

- 顶部范围 chip；
- 已检查进度；
- 三类温暖库存卡；
- 精确 Ingredient 的确认、调整、没有；
- 非精确四状态 chip；
- Food 聚合提示；
- 底部 MobileActionBar；
- 提交前摘要。

### 22.2 桌面盘点

采用双区布局：

- 左侧库存卡片；
- 右侧本次摘要；
- 底部统一动作。

不使用企业后台式密集表格。

### 22.3 采购 UI

三步：

1. 显式选择；
2. 只编辑差异；
3. 确认摘要。

手动到期、单位错误和 Food 全局位置变化就地提示。

### 22.4 成功与撤销

成功后保留结果状态：

    本次购买已登记
    可在 14:32 前撤销

提供：

- 完成；
- 撤销本次操作。

关闭后在库存或购物面板显示最近可撤销操作 Banner。

## 23. 现有前端双 mutation 清理

必须移除：

- pendingShoppingToComplete；
- createInventory 后 updateShoppingItem(done=true)；
- restockFoodStock 后 updateShoppingItem(done=true)；
- 首页相同双写；
- “库存已登记但采购项仍未完成”的部分成功分支。

普通手工补库存仍保留。

只要动作来源是 ShoppingListItem，就必须走 shopping intake endpoint。

## 24. 错误体验

结构化错误兼容：

- detail 字符串；
- detail 对象。

结构化 detail 至少包含：

    code
    message
    conflicts
    field_errors

404：

- 资源不存在；
- 资源不属于当前家庭；
- operation 不属于当前家庭；
- 跨家庭访问不返回可区分的 403。

403：

- Member 尝试撤销其他家庭成员的 operation；
- 其他已经确认属于同一家庭、但权限不足的操作。

409 code：

- stale_version；
- scope_changed；
- tracking_mode_changed；
- idempotency_key_reused；
- operation_expired；
- operation_not_revertible；
- operation_modified_after_apply。

409 前端行为：

- Dialog 保持打开；
- 草稿不清空；
- 重新请求最新数据；
- 非冲突动作保留；
- 冲突项置顶；
- 用户重新确认。

422 code：

- invalid_quantity；
- incompatible_unit；
- manual_expiry_required；
- invalid_date_range；
- invalid_availability_level；
- invalid_target；
- presence_state_required；
- duplicate_request_item；
- empty_operation。

422 前端行为：

- 定位到具体项目和字段；
- 顶部显示剩余错误数；
- 可聚焦第一错误。

提交中：

- 禁止重复；
- 禁止关闭；
- 禁止移动端拖动退出。

## 25. 无障碍和视觉

复用现有 UI kit。

WorkspaceOverlay 以向后兼容方式补充：

- role=dialog；
- aria-modal；
- aria-labelledby；
- 初始焦点；
- 关闭后焦点恢复；
- Escape；
- 提交中禁止关闭；
- aria-live。

视觉：

- 暖白、米色；
- current 使用柔和绿色；
- low 使用琥珀色；
- 过期和危险动作使用红色；
- 不只依赖颜色；
- 触控区约 44×44；
- 遵守 safe area 和 reduced motion。

## 26. Migration

新增一条基于真实当前 head 的 migration。

步骤：

1. 增加尚不存在的 row_version；
2. 增加确认字段；
3. 创建 ingredient_inventory_states；
4. 创建 inventory_operations；
5. 创建 inventory_operation_lines；
6. 创建索引和约束；
7. 回填非精确 present_unknown；
8. 保留旧库存批次。

旧数据：

- row_version 初始化 1；
- 确认字段保持 null；
- 不从 updated_at 推断；
- 不反向生成 operation；
- 不自动清理重复 Ingredient 或测试数据。

非精确 State 回填规则必须确定且可重复：

1. 只处理 quantity_tracking_mode = not_track_quantity 的 Ingredient；
2. 只把 quantity - disposed_quantity > 0 的历史占位批次视为仍有物理存在，不能因为 consumed_quantity 已增加就判定不存在；
3. 没有物理存在批次时不创建 State，不能把没有证据解释成 absent；
4. 存在物理批次时回填 availability_level = present_unknown；
5. 代表性上下文优先选择 expiry_date 非空且日期最早的物理存在批次；没有到期日时选择 updated_at 最新的批次；最终以 id 稳定排序；
6. inventory_status、purchase_date、expiry_date、storage_location 和 notes 从同一个代表性批次复制，不跨多行拼出一条看似精确的新事实；
7. 如果 P0 第一项字段已经存在，同一代表性批次的 expiry_alert_snoozed_until、expiry_reviewed_at 和 expiry_reviewed_by 一起复制；
8. last_confirmed_at、last_confirmed_by、last_confirmation_source 保持 null；
9. State.row_version 初始化 1，Ingredient.row_version 按 migration 规则初始化但不把回填伪装成用户写入；
10. migration 完成并部署新读路径后，全部历史非精确 InventoryItem 立即退出当前状态计算。

迁移测试必须覆盖：多个重复占位、只有过期占位、consumed_quantity = quantity 但 disposed_quantity = 0、全部已销毁、不同位置和不同到期日。实施开始时先检查唯一真实 Alembic head：如果 P0 第一项字段已经存在则复制代表行的 review/snooze；如果尚不存在则由本次 migration 按最终模型创建所需字段且 State 对应值保持 null。不得为两个假想 head 写两套并行 migration，也不得重复添加已有列。

## 27. 分阶段实施与部署检查点

本文件是一份统一产品规格，但实施计划必须拆成三个有依赖顺序、可独立验证和部署的阶段。不得把全部子系统作为一个无检查点的大任务一次执行。

### 阶段一：一致性基础与原子采购入库

交付：

- 检查并复用 P0 第一项已经存在的 row_version、到期提醒和 review 字段；
- 为尚未覆盖的 Ingredient、Food、ShoppingListItem 增加整数 row_version，并改造全部旧写入路径递增版本；
- 创建 IngredientInventoryState，包含当前状态、日期、位置、到期动作和确认基础字段；
- 完成非精确历史占位回填和所有当前读取路径切换；
- 扩展 P0 第一项共享 inventoryActionModel、InventoryActionDialog 和到期 action service，使 State 到期提醒、日期纠错、提醒延后和设置 absent 从阶段一即可正常工作；
- 普通手工补充、AI 批准补充和采购入库停止创建非精确占位 InventoryItem；
- 创建 InventoryOperation 和 InventoryOperationLine，并从第一天保存足以支持安全撤销的完整白名单 before/after snapshot；
- 实现 client_request_id、request_hash 和事务幂等；
- 实现 shopping intake 的精确 Ingredient、非精确 Ingredient、Food 和自由文本分支；
- 支持完整购买、部分购买、多买、未买和仅完成；
- 移除首页、Ingredient 和 Food 的采购双 mutation；
- 本阶段写 operation，但暂不开放 history/detail/revert UI。

阶段一验收重点是“不会重复入库、不会产生两套非精确事实、旧写入不会绕过版本”。阶段一结束时系统必须可正常手工补充和采购登记，不能等待阶段二 UI 才恢复基本功能。

### 阶段二：快速盘点

交付：

- reconciliation read/submit；
- 精确 Ingredient、非精确 Ingredient 和 Food 三类 adapter；
- 按 all/refrigerated/frozen/room_temperature/suggested 的范围定义；
- 包含过期物理批次的完整 observed set；
- confirm_all、adjust_batches、set_absent；
- 本地草稿、恢复和重放；
- 结构化 409/422 错误与冲突恢复；
- 移动端任务 sheet 和桌面双区盘点 UI；
- low 状态的显式补货建议，不自动写购物清单。

阶段二验收重点是“范围内没有漏批次、过期实物可被清零、范围外并发不会静默覆盖、草稿不会误确认未触碰项目”。

### 阶段三：撤销与维护体验

交付：

- operation list/detail；
- 15 分钟、整次、版本条件式 revert；
- 最近可撤销 Banner 和成功结果态；
- 跟踪模式切换护栏；
- never_confirmed/current/stale 的基础展示；
- WorkspaceOverlay 无障碍补强；
- 全链路 MySQL 并发、响应式、smoke 和 rollout 验收。

阶段三不得再改变阶段一 operation snapshot 的基础形状；如果撤销需要的数据在阶段一没有保存，阶段一不能称为完成。changed_since_confirmation 不属于任何阶段。

## 28. 测试策略

新增后端测试：

    backend/tests/inventory/test_ingredient_inventory_state.py
    backend/tests/inventory/test_inventory_reconciliation_api.py
    backend/tests/inventory/test_inventory_operation_history.py
    backend/tests/inventory/test_inventory_operation_revert.py
    backend/tests/inventory/test_inventory_versions.py
    backend/tests/inventory/test_inventory_mysql_concurrency.py
    backend/tests/shopping/test_shopping_intake_api.py

扩展现有：

- inventory API 和 overview；
- inventory usage 和 serializers；
- shopping API；
- Food stock；
- recipe cooking；
- search/hybrid；
- AI inventory operations 和 meal ideas；
- P0 第一项到期动作。

非精确事实来源回归测试必须证明：

- 普通手工补充、shopping intake、reconciliation 和 AI 批准补充都只写一条 State；
- 连续补充不会新增 quantity = 1 的 InventoryItem；
- 历史占位存在时，overview、recipe、search、AI 和首页只读取 State；
- State=absent 时历史占位不会让食材重新变成可用；
- State expiry 能进入 P0 第一项行动中心，设置 absent 后立即退出；
- State 日期纠错清空 review/snooze，盘点确认不改写 expiry review；
- GET /api/inventory 不把 State 伪装成 InventoryItem。

新增前端测试：

    frontend/src/api/inventoryStatesApi.test.ts
    frontend/src/api/inventoryOperationsApi.test.ts
    frontend/src/features/inventory/inventoryReconciliationModel.test.ts
    frontend/src/features/inventory/InventoryReconciliationDialog.test.tsx
    frontend/src/features/inventory/shoppingIntakeModel.test.ts
    frontend/src/features/inventory/ShoppingIntakeDialog.test.tsx
    frontend/src/features/inventory/InventoryOperationBanner.test.tsx

扩展：

- queryKeys；
- cacheInvalidation；
- Ingredient workspace usage；
- mobile view；
- shopping panel；
- Home actions 和 dialogs。

## 29. MySQL 并发验收

必须使用真实 MySQL Session 和线程 barrier 验证：

1. 盘点与消费竞争；
2. 两个成员同时完成同一采购项；
3. 部分购买与采购编辑竞争；
4. 撤销与消费竞争；
5. 相同实体集合反序提交不形成稳定死锁。
6. 两个成员并发首次创建同一个 IngredientInventoryState，唯一约束和锁顺序只允许一条 State；
7. State 手工补充与 State 快速盘点竞争，陈旧 expected version 返回 409；
8. 范围外 InventoryItem 改动递增 Ingredient 版本，使范围内陈旧盘点保守返回 409。

不能用 SQLite 或 mock 声称已经验证 FOR UPDATE。

## 30. 代表性验收数据

使用专用测试家庭，不操作不可替代的真实家庭数据。

至少包含：

- Owner 和 Member；
- 鸡蛋两批；
- 牛奶计划 6 盒；
- 盐的重复旧占位行；
- 盐的唯一 State，并覆盖在库、过期、设置 absent 后历史占位不得复活三种状态；
- 需要手动到期日的面条；
- stale 冷冻肉；
- 牛奶与牛奶麦片；
- 油与酱油；
- 已有 2 份且较早到期的卤牛肉；
- 自由文本厨房纸；
- 完整、部分、历史采购项；
- never confirmed、current、stale、expired、low、sufficient、absent。

## 31. 验证命令

数据库：

    npm run db:up
    npm run backend:migrate

后端定向：

    cd backend
    .venv/bin/python -m pytest \
      tests/inventory/test_inventory_reconciliation_api.py \
      tests/inventory/test_ingredient_inventory_state.py \
      tests/inventory/test_inventory_operation_history.py \
      tests/inventory/test_inventory_operation_revert.py \
      tests/inventory/test_inventory_versions.py \
      tests/shopping/test_shopping_intake_api.py \
      tests/recipes/test_food_stock_operations.py \
      -q

MySQL 并发：

    cd backend
    .venv/bin/python -m pytest tests/inventory/test_inventory_mysql_concurrency.py -q

后端全量：

    npm run backend:typecheck
    npm run backend:test

前端定向：

    npm --prefix frontend run test -- \
      inventoryStatesApi \
      inventoryOperationsApi \
      inventoryReconciliationModel \
      InventoryReconciliationDialog \
      shoppingIntakeModel \
      ShoppingIntakeDialog \
      InventoryOperationBanner \
      useHomeDashboardActions \
      cacheInvalidation \
      queryKeys

前端全量：

    npm --prefix frontend run test
    npm --prefix frontend run typecheck
    npm --prefix frontend run build
    npm --prefix frontend run check:style-tokens
    npm --prefix frontend run smoke

代码卫生：

    git diff --check
    rg -n "pendingShoppingToComplete|库存已登记.*采购项" frontend/src
    rg -n "normalized_quantity = Decimal\(\"1\"\)|not_track_quantity" backend/app/services frontend/src

最后一条不是要求仓库中完全没有 not_track_quantity，而是人工确认没有任何当前写路径继续创建占位 InventoryItem，且所有可用性读取都已切换到 State。最后的调用链仍需人工审阅，不能只靠同一行正则。

## 32. 部署与回滚

推荐单实例部署顺序：

    备份数据库
        ↓
    停止旧后端写入
        ↓
    Alembic upgrade
        ↓
    部署新后端
        ↓
    API smoke
        ↓
    部署新前端

旧后端不知道如何维护新 row_version，因此不能长时间混跑旧、新写实例。

三个阶段分别执行一次该部署序列。阶段一是契约切换点，必须在同一维护窗口部署兼容的后端和前端：不能先部署一个会继续创建占位批次的旧写实例，也不能让旧前端长期调用已经只接受精确 Ingredient 的 POST /api/inventory。阶段二和阶段三只在各自定向、全量与 smoke 验收通过后开放对应入口。

出现问题时：

1. 隐藏新入口；
2. 保留新表和字段；
3. 回滚应用代码；
4. 不立即 downgrade；
5. 修复后重新开放。

已经切换到原子 intake 后，不建议恢复旧双 mutation。

## 33. 完成定义

只有全部满足才能称为完成：

- migration 成功；
- IngredientInventoryState 是非精确食材唯一当前事实来源；
- 所有非精确新写路径不再创建 quantity = 1 的 InventoryItem；
- 历史占位不会影响 overview、首页、菜谱、搜索或 AI；
- 三类库存可盘点；
- 批量采购支持完整、部分、多买和自由文本；
- 首页、Ingredient 和 Food 的采购来源全部原子化；
- 本地草稿可恢复；
- 409 可恢复；
- 幂等不重复写；
- 15 分钟安全撤销可用；
- MySQL 并发测试通过；
- 移动端和桌面端验证通过；
- 后端全量测试通过；
- 前端测试、构建和 smoke 通过；
- P0 第一项没有重复版本字段或重复 UI；
- 第一版新鲜度只输出 never_confirmed/current/stale，不输出 changed_since_confirmation；
- 未修改或清理用户真实家庭数据；
- 交付说明列出实际执行的验证命令和结果。

## 34. 后续独立子项目

本期完成后，按独立规格继续：

1. 做菜完成后的实际扣减确认；
2. 库存数据新鲜度进入推荐和 AI 解释；
3. 重复 Ingredient 检测、合并和数据健康治理；
4. 评估 Food 批次化；
5. 根据真实使用数据评估少量是否需要更强采购联动。

## 35. 书面规格批准门槛

本文件记录已确认的产品、数据、API、并发、UI、迁移和验证边界。

在用户批准本书面规格前：

- 不实现产品代码；
- 不执行 migration；
- 不修改 P0 第一项文档；
- 不生成最终实施任务清单。

书面规格批准后，使用 superpowers:writing-plans 生成逐任务、逐文件、逐测试的实施计划。
