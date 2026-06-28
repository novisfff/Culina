---
name: food-profile
description: 查询、创建、更新或收藏当前家庭的食物资料，适用于食物库里的菜品、即食食品、外卖/堂食记录对象和可选菜谱关联；不处理食材档案、库存数量、菜谱正文、餐食计划或已吃餐食记录。
---

# 食物资料 Skill

## 适用范围

- 用户要新增、整理或补全食物资料。
- 用户要更新食物资料或设置收藏状态。
- 不用于创建菜谱、记录用餐或安排餐食计划。

## 自主决策空间

- 可以根据用户原话推断可编辑默认值，例如食物类型、分类、适合餐别和日常备注；确认前用户可以修改。
- 用户只是查询资料或候选时，可以只读取并摘要，不要生成草稿。
- 名称、类型、分类已经可稳定推断时不要重复追问；目标不唯一、更新/收藏对象不明确时再请求澄清。

## 字段取值规则

- `type` 只能从固定食物类型中选择：`selfMade`、`takeout`、`diningOut`、`readyMade`、`instant`、`packaged`，不要自定义中文类型值。
- 手动创建普通食物资料时优先使用 `takeout`、`diningOut`、`readyMade`、`instant`；`selfMade` 通常来自菜谱同步或明确的真实菜谱关联，不要为了创建普通食物资料随意使用。
- 类型映射：外卖=`takeout`，堂食/外食=`diningOut`，即食/现成/盒装/瓶装=`readyMade`，速食/方便食品=`instant`，自制/家常菜只有在真实菜谱关联或明确菜谱同步场景下才使用 `selfMade`。
- `suitable_meal_types` 只能从 `breakfast`、`lunch`、`dinner`、`snack` 中选择；用户说“正餐”时优先映射到 `lunch`、`dinner`，不要创建“正餐”等自定义值。
- `category` 可以自定义，但应优先使用前端常见类别文案，例如 `饮品`、`主食`、`蛋白质`、`零食`、`速食`、`外卖`、`餐厅菜`、`甜品`；不要为了细分随意创造很长类别。
- `rating` 只能是 1 到 5 的整数；`price` 和 `stock_quantity` 不能为负数。没有明确证据时留空，不要根据语气推断评分、价格或库存。
- `recipe_id` 必须来自当前家庭真实菜谱，并且食物名称必须与所选菜谱一致；菜谱不存在或无法确认时，不要在本 Skill 中伪造 ID，应说明需要进入菜谱管理流程。

## 执行规则

- 先调用 `food.search`，需要确认唯一目标时使用 `food.read_by_id`。
- 创建食物资料时，`name`、`type`、`category` 是 `food_profile.create_draft` 的必填字段，禁止提交空 payload 或只提交 `draftType/schemaVersion`。
- 用户原话已经给出或可稳定推断时，必须先填入草稿，不要直接追问。例如“盒装牛奶，类型是即食，适合早餐”应生成 `name=盒装牛奶`、`type=readyMade`、`category=饮品`、`suitable_meal_types=["breakfast"]`。
- 分类可以根据食物名称给可编辑默认值，例如牛奶/酸奶/豆浆/咖啡/果汁=`饮品`，面包/吐司/饭团=`主食`，鸡胸/肉/鱼/蛋=`蛋白质`。
- 只有名称、类型等关键信息在用户原话和上下文里都无法判断时，才调用 `human.request_input`，用 `choice` 或 `choice_or_text` 提供候选摘要。
- 如果设置 `recipe_id`，必须来自当前家庭真实菜谱；名称必须与所选菜谱一致。
- 不编造品牌、价格、评分、库存、过期日期或业务 ID。
- 品牌、价格、评分、库存、过期日期等没有明确证据时留空，不要编造。
- 更新和收藏必须先读取真实食物详情，并引用真实 `targetId` 与 `baseUpdatedAt`，不能只靠名称定位。
- `action=update` 的 payload 不是局部补丁；必须在现有详情基础上合成完整可编辑字段，再叠加用户要求的变化。至少保留或填写 `name`、`type`、`category`。
- 收藏和取消收藏使用 `action=set_favorite`，payload 只提供 `favorite=true/false`，不要混入食物资料更新字段。
- 收藏和取消收藏也必须走草稿审批，不直接在 Skill 中提交正式写入。
- 仅通过 `food_profile.create_draft` 生成 `food_profile` 草稿。
- 草稿需要用户确认；确认前不得写入正式 Food。
