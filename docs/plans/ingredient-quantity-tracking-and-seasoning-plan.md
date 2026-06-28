# 食材数量追踪与调料分类落地方案

更新时间：2026-06-26

## 1. 背景与目标

本方案覆盖两个关联需求：

- 需求 3：食材数量体系增加“不记录数量”机制，优先级 P1。
- 需求 4：食材体系新增“调料”大类，并评估是否需要独立机制和页面，优先级 P2。

目标不是只给调料加一个前端标签，而是在食材档案层建立稳定的数量追踪模式，让库存判断、做菜扣库存、采购清单、AI 草稿和前端展示都共享同一条业务规则。

## 2. 当前实现分析

### 2.1 数据模型现状

当前 `Ingredient` 只有自由文本 `category`、`default_unit`、`unit_conversions`、`default_low_stock_threshold` 等数量相关字段，没有数量追踪开关。`InventoryItem` 的 `quantity`、`unit`、`consumed_quantity`、`disposed_quantity` 均为必填数量模型；`ShoppingListItem` 也要求 `quantity` 和 `unit`。

相关文件：

- `backend/app/models/domain.py`
- `backend/app/schemas/ingredients.py`
- `backend/app/schemas/inventory.py`
- `backend/app/schemas/shopping.py`
- `backend/app/services/serializers.py`
- `frontend/src/api/types.ts`
- `frontend/src/api/ingredientsApi.ts`

### 2.2 库存可用性与做菜现状

做菜预览、菜谱可做性、菜谱列表按可做性排序、普通做菜提交和 AI 做菜确认都复用 `backend/app/services/inventory_usage.py` 的 `build_cook_inventory_plan()`。该函数当前对每个菜谱食材都执行：

1. 读取未过期且剩余数量大于 0 的库存批次。
2. 按食材主单位做单位换算。
3. 汇总可用数量。
4. 数量不足则生成 `shortages`。
5. 数量充足则生成具体批次扣减计划。

因此“不记录数量”的根规则应优先落在 `inventory_usage.py`，否则普通做菜、AI 做菜、菜谱发现和可做性排序会出现不一致。

### 2.3 手动库存操作与 AI 草稿现状

手动入库、消费、销毁位于 `backend/app/services/inventory_operations.py`。AI 库存操作草稿校验位于 `backend/app/ai/tools/draft_validation.py`，目前入库和消耗都强制数量，销毁也围绕库存批次数量校验。

如果只改做菜路径，不改这里，会出现：

- 前端不要求数量，但后端入库仍拒绝。
- AI 生成调料补货或消耗草稿仍要求数量。
- 手动消费调料仍按数量扣减，破坏“不记录数量”的用户预期。

### 2.4 前端食材工作台现状

食材工作台已有分类筛选和分类预设，当前预设中存在 `调味料`、`酱料`，但没有统一的“调料”大类。库存、采购、消费弹窗都以数量为核心输入。

相关文件：

- `frontend/src/components/ingredients/workspaceModel.ts`
- `frontend/src/components/ingredients/ingredientWorkspaceForms.ts`
- `frontend/src/components/ingredients/useIngredientActionState.ts`
- `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- `frontend/src/components/ingredients/IngredientConsumeOverlay.tsx`
- `frontend/src/lib/ui.ts`
- `frontend/src/lib/ingredientUnits.ts`

## 3. 方案总原则

### 3.1 数量追踪模式是食材档案属性

新增食材级字段：

```text
quantity_tracking_mode
```

建议枚举值：

```text
track_quantity
not_track_quantity
```

含义：

- `track_quantity`：现有行为，按数量、单位、换算、低库存阈值、库存扣减判断。
- `not_track_quantity`：只关心该食材在当前家庭是否存在可用库存记录；不按数量和单位判断是否足量；做菜完成时不强制扣减。

不建议只使用 `category == "调料"` 推导业务规则。分类是用户可编辑的信息架构，数量追踪模式是库存规则。调料可以默认不记录数量，但用户应能把某些调料改为记录数量，例如昂贵香料、奶油、黄油、番茄酱大包装等。

### 3.2 “存在”要有明确口径

对于 `not_track_quantity` 食材，“存在”建议定义为：

- 当前家庭有该食材的至少一个库存批次；
- 该批次未被完全销毁；
- 如有 `expiry_date`，未过期；
- 不要求 `remaining_quantity > 0`。

原因：历史数据中库存批次仍有数量字段，未来兼容也需要避免把已销毁或已过期批次误判为可用。若产品希望“不记录数量的调料过期也不提醒”，应通过 `default_expiry_mode = none` 和前端默认值实现，而不是让库存可用性忽略过期。

### 3.3 不记录数量不等于不管理库存

`not_track_quantity` 仍保留以下能力：

- 食材档案、图片、存放位置、备注。
- 库存批次作为“家里有/已补充”的存在记录。
- 可选的购买日期、开封状态、到期日。
- 采购清单中表达“需要补充”。

它不参与：

- 低库存数量阈值提醒。
- 菜谱可做性的数量缺口计算。
- 做菜完成时的自动数量扣减。
- 消费弹窗里的数量扣减。

## 4. 后端落地设计

### 4.1 枚举与迁移

新增枚举：

```python
class IngredientQuantityTrackingMode(str, Enum):
    TRACK_QUANTITY = "track_quantity"
    NOT_TRACK_QUANTITY = "not_track_quantity"
```

落点：

- `backend/app/core/enums.py`
- `backend/app/models/domain.py`
- 新增 Alembic migration

迁移策略：

1. `ingredients` 表新增 `quantity_tracking_mode`，非空，默认 `track_quantity`。
2. 回填已有数据为 `track_quantity`，避免改变现有家庭库存行为。
3. 不自动把历史 `调味料`、`酱料` 改成 `not_track_quantity`，避免无提示改变用户已有库存扣减习惯。
4. 后续可提供一次性“推荐转换调料”入口，由用户确认后批量改为不记录数量。

### 4.2 Ingredient API 与序列化

同步新增字段：

- `IngredientOut.quantity_tracking_mode`
- `CreateIngredientRequest.quantity_tracking_mode`
- `UpdateIngredientRequest.quantity_tracking_mode`
- `serialize_ingredient()`
- 前端 `Ingredient` 类型和 `ingredientsApi` payload

校验规则：

- `track_quantity`：保持现有 `default_unit`、`unit_conversions`、`default_low_stock_threshold` 校验。
- `not_track_quantity`：仍保留 `default_unit` 作为兼容显示和菜谱用量输入兜底，但前端不强制突出；`default_low_stock_threshold` 应存为 `null` 或后端在请求中拒绝非空阈值，推荐后端归一化为 `null`。

### 4.3 库存批次兼容策略

为降低 schema 冲击，第一阶段不把 `InventoryItem.quantity` 改成 nullable。对 `not_track_quantity` 入库时：

- API 可允许前端不传数量，或传 `quantity = null`。
- Service 内部创建库存批次时用哨兵值 `1` 和食材主单位保存。
- 返回给前端时增加显示语义字段，避免 UI 把它当成“1瓶”：
  - `quantity_tracking_mode`
  - `tracks_quantity`
  - 可选 `presence_status: "available" | "missing" | "expired" | "disposed"`

如果不想增加多个字段，最小可先在 `InventoryItemOut` 返回 `quantity_tracking_mode`，前端通过关联食材判断展示。但长期建议后端直接序列化出库存批次的追踪模式，避免前端在购物/库存列表里反复关联。

不建议第一阶段把 `inventory_items.quantity`、`unit`、`shopping_list_items.quantity` 改成 nullable。那会同时放大数据库、Pydantic、AI schema、前端表单和历史数据兼容范围，超出 P1 最小可落地范围。

### 4.4 库存判断与做菜扣减

核心改造点：`backend/app/services/inventory_usage.py`。

建议新增 helper：

```python
def tracks_quantity(ingredient: Ingredient) -> bool: ...

def is_presence_available(item: InventoryItem, *, today: date) -> bool: ...

def has_available_presence(items: list[InventoryItem], *, today: date) -> bool: ...
```

`build_cook_inventory_plan()` 规则：

- 如果菜谱食材没有 `ingredient_id`，仍视为缺料，因为无法确认家庭是否有该食材。
- 如果绑定的 `Ingredient.quantity_tracking_mode == not_track_quantity`：
  - 只检查是否存在可用库存批次。
  - 存在则加入 `consumption_plan`，但 `deductions=[]`。
  - 不做单位换算，不比较 `requested_quantity`，不生成数量缺口。
  - 不存在则生成缺料，文案应表达“未配置/需补充”，数量字段可保持菜谱要求的数量以兼容现有响应。
- 如果 `track_quantity`，保持现有逻辑。

`recipe_availability_summary()` 仍把不记录数量且存在的食材计为 ready；不存在则计为 shortage。

`cook_recipe()` 和 `execute_recipe_cook_draft()` 已经按 `plan.deductions` 扣减。只要 `build_cook_inventory_plan()` 返回空 deductions，就能自然跳过扣减。但返回给前端的 `consumed_items` 应标注：

- `tracking_mode: not_track_quantity`
- `affected_item_ids: []`
- 可选 `deduction_note: "仅确认有库存，未扣减数量"`

这需要同步扩展 `CookRecipeConsumedItemOut` 和前端类型。

### 4.5 手动消费、销毁和入库

`create_inventory_batch()`：

- `track_quantity`：保持现有数量和单位转换。
- `not_track_quantity`：允许数量缺省；内部保存 `1`；低库存阈值置 `0` 或忽略；活动日志写“补充/确认已有 盐”而不是“录入库存 盐 1瓶”。

`consume_ingredient_inventory()`：

- `track_quantity`：保持现有行为。
- `not_track_quantity`：不建议提供“消费数量”操作。若保留 API 兼容，可直接返回 `affected_item_ids=[]`，不修改 `consumed_quantity`，活动日志写“记录使用 盐（不扣减数量）”。前端第一阶段应隐藏或弱化消费入口。

`dispose_inventory_quantity()`：

- 对 `not_track_quantity` 仍可用于“标记这批已经没有/丢弃/过期处理”。
- 如果请求未传数量，应把该存在记录整体 disposed。由于底层仍有哨兵数量，可把 `disposed_quantity` 设置到 `quantity - consumed_quantity`。
- 如果请求传数量，建议拒绝并提示“不记录数量的食材只能整批移除或重新补充”。

### 4.6 采购清单

采购清单需要同时兼容历史“精确数量采购”和调料类“需要补充”表达。落地策略是保留底层 `quantity/unit` 兼容字段，同时给购物项增加结构化表达字段：

```text
ingredient_id: nullable
quantity_mode: track_quantity | not_track_quantity
display_label: nullable
```

规则：

- `track_quantity`：保持现有精确数量和单位展示，例如“500g 鸡胸肉”。
- `not_track_quantity`：API 可以接收缺省数量/单位，服务端内部仍用兼容值保存，但 UI 和 AI 输出使用 `display_label`，默认“需要补充”。
- 如果传入 `ingredient_id`，后端必须校验该食材属于当前家庭，并以食材档案的 `quantity_tracking_mode` 为准，避免前端或 AI payload 伪造规则。
- 购物卡片优先按 `ingredient_id` 关联食材档案，名称只作为兼容 fallback。这样“家里的盐”也能关联到“盐”的调料档案。
- 采购清单展示层按普通食材和调料分组，调料项不展示伪数量。

这样采购清单可以稳定区分“买 500g 鸡胸肉”和“补一瓶酱油/需要补充盐”，也能让 AI shopping draft 直接生成“需要补充”式 payload。

### 4.7 AI Tool 与审批

需要同步修改：

- `backend/app/ai/tools/catalog/ingredient.py`
- `backend/app/ai/tools/catalog/inventory.py`
- `backend/app/ai/tools/catalog/shopping.py`
- `backend/app/ai/tools/draft_validation.py`
- `backend/app/ai/tools/schemas.py`
- `backend/app/services/ai_operations/ingredients.py`
- `backend/app/services/ai_operations/inventory.py`
- `backend/app/services/ai_operations/shopping.py`
- `backend/app/services/ai_operations/recipe_cook.py`

AI 规则：

- `ingredient.search/read_by_id` 返回 `quantityTrackingMode`。
- `ingredient_profile` 草稿 payload 支持 `quantity_tracking_mode`。
- `inventory_operation` 对 `not_track_quantity` 的 `restock` 允许缺省数量；`consume` 不校验数量不足；`dispose` 要求批次但不要求精确数量。
- `recipe_cook` 最终确认依赖 `build_cook_inventory_plan()`，不另写 AI 特例。
- Skill 文档需要更新：调料默认可建议为不记录数量，但模型不能仅因为名字像调料就伪造库存存在。

## 5. 前端落地设计

### 5.1 类型与模型

新增类型：

```ts
export type IngredientQuantityTrackingMode = 'track_quantity' | 'not_track_quantity';
```

`Ingredient` 增加：

```ts
quantity_tracking_mode: IngredientQuantityTrackingMode;
```

建议增加 helper：

```ts
export function tracksIngredientQuantity(ingredient: Pick<Ingredient, 'quantity_tracking_mode'>) {
  return ingredient.quantity_tracking_mode !== 'not_track_quantity';
}
```

数量展示、低库存提醒、库存卡片、采购卡片、消费入口均通过 helper 分支，不在组件里散落字符串判断。

### 5.2 食材创建与编辑

`IngredientEditorView` 增加数量追踪设置：

- 默认：`记录数量`
- 选项：`记录数量` / `只记录有无`
- 选中“调料”分类时默认切到“只记录有无”，但用户可改回。
- 选中“只记录有无”后：
  - 不展示或不强制低库存阈值。
  - 单位换算区域折叠或显示为“可选，仅用于菜谱用量展示”。
  - 默认单位可保留，避免菜谱已有用量输入失去单位。

分类预设调整：

- 新增标准分类 `调料`。
- 将现有 `调味料`、`酱料` 在 UI 预设中收敛为 `调料`，历史数据不自动改名。
- 分类筛选中继续展示历史分类，避免用户找不到旧数据。

### 5.3 库存页展示

对 `not_track_quantity` 食材：

- 有可用库存批次：显示“已有”。
- 无可用库存批次但有采购项：显示“需补充”。
- 无库存批次：显示“未配置”或“未登记”。
- 不显示“当前 1瓶”“低于 0瓶”这类伪数量。
- 不进入低库存数量提醒。
- 如有到期日且临期/过期，仍可进入临期提醒；但调料默认 `default_expiry_mode=none`，只有用户填写到期日才提醒。

`buildIngredientAlerts()` 与 `buildInventoryAlerts()` 应跳过 `not_track_quantity` 的低库存提醒，但保留过期提醒。

### 5.4 入库、消费、采购弹窗

入库弹窗：

- `track_quantity`：保持现有数量控件。
- `not_track_quantity`：把主操作文案改为“确认家里已有/补充库存”，数量控件隐藏；保存时不传数量或传兼容默认值。

消费弹窗：

- `track_quantity`：保持现有。
- `not_track_quantity`：默认不展示“记录消费”入口。若从做菜完成产生记录，显示“本次使用不扣减数量”。

采购弹窗：

- `track_quantity`：保持现有数量控件。
- `not_track_quantity`：数量控件隐藏，展示“需要补充”；提交兼容 payload，展示层用 `quantity_tracking_mode` 隐藏数量。

### 5.5 食材页是否单独做调料页面

不建议第一阶段做独立调料页面。理由：

- 当前食材工作台已有 catalog/inventory/shopping 三个面板和移动端独立体验。
- 调料和普通食材共享图片、库存存在记录、采购清单、过期处理、AI 搜索等能力。
- 独立页面会扩大导航、缓存、移动端布局和空状态成本，但业务机制尚未验证。

建议第一阶段在食材页内做：

- 分类筛选新增“调料”。
- 首页/移动端增加“调料专区”或“常备调料”入口。
- 调料专区展示三种状态：`已有`、`未配置`、`需补充`。
- 采购清单里调料分组展示在普通食材之后或单独折叠。

独立页面触发条件：

- 调料数量达到一定规模，例如超过 20 个。
- 用户需要按品牌、开封状态、替代品、常买渠道管理。
- 采购清单中调料补充成为高频入口。

## 6. 跨端契约建议

### 6.1 新增共享字段

`Ingredient`：

```json
{
  "quantity_tracking_mode": "track_quantity | not_track_quantity"
}
```

`InventoryItemOut` 建议新增：

```json
{
  "quantity_tracking_mode": "track_quantity | not_track_quantity",
  "quantity_label": "已有 | 500g",
  "presence_status": "available | missing | expired | disposed"
}
```

`CookRecipeShortageOut` 建议新增：

```json
{
  "shortage_type": "quantity | presence"
}
```

`CookRecipePreviewItemOut` / `CookRecipeConsumedItemOut` 建议新增：

```json
{
  "quantity_tracking_mode": "track_quantity | not_track_quantity",
  "deduction_note": "仅确认有库存，未扣减数量"
}
```

### 6.2 兼容策略

前端读取旧后端或旧缓存时：

- 缺省 `quantity_tracking_mode` 视为 `track_quantity`。
- 缺省 `shortage_type` 视为 `quantity`。
- 缺省 `quantity_label` 时按现有数量格式展示。

后端读取旧 payload 时：

- 缺省 `quantity_tracking_mode` 视为 `track_quantity`。
- `not_track_quantity` 且收到低库存阈值，归一化为 `null`。

## 7. 分阶段实施计划

### Phase 1：P1 数量追踪机制

后端：

1. 新增枚举、模型字段和 Alembic migration。
2. 更新 Ingredient schema、serializer、API。
3. 更新 `inventory_usage.py`，让做菜预览、可做性和做菜提交统一支持 presence 规则。
4. 更新 `inventory_operations.py`，支持不记录数量的入库、消费跳过和整批销毁。
5. 更新 AI ingredient/inventory/recipe_cook 相关 schema、tool 和审批执行。
6. 补后端测试。

前端：

1. 更新 API 类型和 payload。
2. 食材创建/编辑增加数量追踪模式。
3. 库存展示跳过伪数量和低库存数量提醒。
4. 入库、采购、消费弹窗按追踪模式调整。
5. 做菜预览和完成结果展示“只判断有无/未扣减数量”。
6. 补 Vitest。

验收标准：

- 盐配置为 `not_track_quantity`，库存中只要有一条未过期存在记录，菜谱要求 5g、10ml 或 1勺盐都不缺料。
- 同一菜谱中鸡胸肉仍按 500g 等数量精确判断。
- 做菜完成后鸡胸肉扣减，盐不扣减。
- 盐没有库存存在记录时，菜谱预览显示缺少盐，但不显示“还差 5g”作为主要文案。
- 盐不会触发低库存数量提醒。
- 手动采购盐显示“需要补充”，不强制用户填写精确数量。

### Phase 2：P2 调料分类与专区

后端：

1. 不新增强枚举分类，继续保持 `category` 自由文本，避免破坏历史自定义分类。
2. 在种子数据、AI prompt/Skill 指令和前端预设中统一推荐分类名 `调料`。
3. 如需要批量迁移，可提供后端一次性脚本或管理员工具，把 `调味料`、`酱料` 建议合并为 `调料`，但不自动执行。

前端：

1. 分类预设新增 `调料`，默认单位可为 `瓶` 或 `份`，默认存放 `常温`，默认数量追踪 `not_track_quantity`。
2. 食材页分类筛选加入调料入口。
3. 移动端食材首页增加“常备调料”区域，展示已有/未配置/需补充。
4. 采购清单按普通食材和调料分组。

验收标准：

- 新建“酱油”选择 `调料` 后默认只记录有无。
- 用户仍可把“酱油”切回记录数量。
- 历史 `调味料`、`酱料` 数据仍能被搜索和筛选看到。
- 调料采购项和普通食材采购项在 UI 上分组展示。

### Phase 3：采购清单契约增强

本阶段目标是把“需要补充”从前端文案提升为跨端契约，避免调料采购项继续伪装成“1份”。

后端：

1. `shopping_list_items` 增加 `ingredient_id`、`quantity_mode`、`display_label`。
2. `ShoppingListItemOut`、创建请求、serializer 同步这些字段。
3. 普通 Shopping API 校验 `ingredient_id` 家庭归属；关联食材时以食材档案追踪模式为准。
4. AI shopping draft schema、draft validation、approval 执行和 tool catalog 支持缺省 `quantity/unit` 的 not-track payload。

前端：

1. `ShoppingListItem` 类型、API payload、食材工作台采购卡片同步新字段。
2. 食材页创建不记录数量的采购项时提交 `quantity:null`、`unit:null`、`quantity_mode:not_track_quantity`、`display_label:"需要补充"`。
3. 菜谱缺料生成采购草稿时，presence shortage 隐藏数量控件，显示可编辑的“采购表达”。
4. 采购卡片用 `ingredient_id` 优先关联食材档案，并按调料/普通食材分组。

验收标准：

- AI 或前端创建“盐需要补充”时，不要求模型或用户填写 `5g`、`1份` 等伪数量。
- 购物项返回后仍能关联到对应调料食材，并显示“需要补充”。
- 普通食材采购仍保留精确数量和单位。
- 菜谱缺少不记录数量食材时，加入采购清单生成 presence-only payload。

## 8. 测试计划

后端测试：

- Ingredient API 创建/更新 `quantity_tracking_mode`。
- Migration 默认回填 `track_quantity`。
- `build_cook_inventory_plan()`：
  - `track_quantity` 保持原数量缺口逻辑。
  - `not_track_quantity` 存在库存时不缺料、不生成 deductions。
  - `not_track_quantity` 无库存时生成 presence shortage。
  - 未绑定 `ingredient_id` 的菜谱食材仍缺料。
- 普通 `cook_recipe()` 和 AI `execute_recipe_cook_draft()` 对不记录数量食材不扣减。
- `create_inventory_batch()` 对不记录数量食材允许缺省数量。
- AI `inventory_operation` 草稿对不记录数量食材不强制数量消费。

前端测试：

- `workspaceModel` 对不记录数量食材展示“已有/未配置/需补充”，不显示伪数量。
- `buildIngredientAlerts()` / `buildInventoryAlerts()` 跳过低库存数量提醒。
- 食材表单选择 `调料` 默认 `not_track_quantity`。
- 入库、采购、消费弹窗按模式隐藏或显示数量控件。
- 菜谱做菜按钮不因调料数量不足禁用。

建议验证命令：

```bash
npm run backend:test
npm --prefix frontend run test
npm --prefix frontend run build
```

如果只实施 Phase 1 的后端部分，可先运行相关 pytest，再运行全量后端测试。若改动了移动端调料专区或响应式布局，应补跑：

```bash
npm --prefix frontend run smoke
```

## 9. 风险与取舍

- 底层库存数量仍用哨兵值兼容，会带来“数据库里是 1，但 UI 不展示 1”的语义差异。需要通过 serializer 和前端 helper 统一屏蔽。
- 如果第一阶段直接把库存和采购数量字段改为 nullable，跨端改动会显著扩大，不建议作为 P1 首版。
- 分类保持自由文本可以保护历史数据，但也意味着 `调料` 不是权限或规则边界。真正的业务规则必须看 `quantity_tracking_mode`。
- 过期提醒是否适用于调料需要产品确认。本方案默认“用户填写了到期日就提醒；默认调料不填写到期日”。
- 做菜缺少不记录数量食材是否阻断：本方案建议阻断。因为需求规则是“只要该食材存在，就认为可用”，反向含义是不存在时不可用。若产品希望缺调料只警告不阻断，应新增 `shortage_severity`，不要复用数量追踪模式表达。

## 10. 推荐结论

推荐先做需求 3，且把它作为食材档案的通用业务机制；再做需求 4 的分类和专区体验。

首版不做独立调料页面，不改库存和采购数量字段为 nullable。首版重点是建立 `quantity_tracking_mode`，让做菜可用性、扣库存、手动库存操作、采购展示和 AI 草稿先达成一致。调料只是该机制的默认使用场景，而不是硬编码特例。
