---
name: recipe-draft
description: 创建、补全、更新、删除或收藏菜谱正文和结构化配方草稿，包括食材、步骤、份数、耗时和难度；不执行做菜扣库存、不记录餐食、不安排餐食计划。
---

# 菜谱管理 Skill

历史 artifact 默认只提供摘要和 ID；需要复用历史 AI 菜谱草稿的完整步骤、食材或审批内容时，先调用 `workspace.read_artifact`，不要根据摘要补全。

## 自主决策空间

- 生成开放式新菜谱时，可以先根据用户口味、份数和已有食材构思结构；进入可确认菜谱草稿前，必须用 `ingredient.search` 为每个会进入 `ingredient_items` 的食材召回当前家庭候选，并只绑定真实食材 ID。
- 步骤、技巧、口味标签和可编辑备注可以合理补全；份数、耗时、难度、核心食材和更新/删除目标不明确时必须澄清。
- 创建或更新菜谱草稿前，可调用 `script.lint_recipe_draft` 检查标题、份数、耗时、食材和步骤是否完整。

## 字段取值规则

- `difficulty` 只能选择 `easy`、`medium`、`hard`；不要生成“简单”“中等偏难”等自由值。
- `steps[].icon` 优先从前端步骤图标预设中选择：`pan`、`tomato`、`bowl`、`timer`、`tip`、`plate`；没有把握时用 `pan`，不要自定义图标值。
- `scene_tags` 优先使用短、可展示的场景标签，例如 `工作日晚餐`、`孩子也能吃`、`周末轻食`、`高蛋白`、`早餐`、`汤羹`；可以自定义，但不要堆叠同义词或长句。
- `prep_minutes` 和 `servings` 必须是可执行数字；不确定时给常见可编辑默认值或追问，不要写“适量时间”“多人份”等自由文本。
- `ingredient_items[].unit` 继续遵循已匹配食材的 `defaultUnit` / `supportedUnits` / `unitConversions`；没有换算关系时追问或转入食材档案流程，不要直接提交不支持单位。
- 已匹配食材的 `quantityTrackingMode=not_track_quantity` 时，菜谱配料行不需要填写结构化 `quantity` / `unit`；把“少许、喷油、按口味、出锅前撒”等用量线索写在步骤 `text` 或配料 `note` 里。
- `script.lint_recipe_draft` 只是早期质量检查，不是安全边界；调用后仍必须通过 `recipe.create_draft` 的校验和归一化生成最终草稿。

## 执行规则

- 生成可确认菜谱草稿前，先列出核心配料，并逐项调用 `ingredient.search` 召回当前家庭候选。`ingredient.search` 是混合检索候选召回，不代表最终身份绑定；只有模型基于名称、分类、默认单位、备注、`matchReason` 和上下文明确判断为同一食材时，才可使用该候选 ID。
- 原料清单要服务做菜前准备，不只写主料。会明显影响成菜或需要提前准备的主要调料、辅料和蘸料也要进入候选检索范围，例如盐、生抽、老抽、料酒、醋、糖、淀粉、食用油、姜、葱、蒜、辣椒、花椒、胡椒粉、香油、蚝油等；存在家庭食材档案且能明确匹配时，应作为 `ingredient_items` 正式配料行写入。
- 不要为了“避免缺食材档案”而把主要调料全部藏进步骤或技巧里。只有点缀项、极少量可选调味、按口味自调且不适合库存追踪的内容，才可以写入步骤、技巧或备注。
- `ingredient_items` 中的数量和单位必须以后端食材配置为准：`track_quantity` 食材优先使用候选的 `defaultUnit`；如果用户给出的是 `supportedUnits` / `unitConversions` 中支持的副单位，先换算成 `defaultUnit` 后再填写 `quantity` 和 `unit`。
- 如果用户给出的单位无法通过食材配置换算，不要硬编数量或直接保留 unsupported unit；先调用 `human.request_input` 让用户确认换算关系或改用默认单位。少许、适量、装饰用等不适合扣库存的口语用量，可以写入步骤、技巧或备注；若对应真实食材是 `not_track_quantity`，可以保留配料行但省略结构化 `quantity` / `unit`。
- 多个候选都可能可用，或候选语义接近但不确定时，调用 `human.request_input` 让用户选择已有食材或说明处理方式。
- 没有合适候选时，不要调用 `recipe.create_draft`；必须建议注入 `ingredient_profile`技能，通过 `ingredient_profile.create_draft` 先生成缺失食材档案草稿，用户确认后再继续生成菜谱草稿。
- 如果发现需要新增一个或多个食材档案，不要直接逐个开始创建。先用普通回复向用户说明整体情况：哪些食材缺失、哪些是主料/主要调料、为什么需要先补食材档案、接下来会逐项生成可确认草稿；说明后再开始调用 `ingredient_profile.create_draft`。
- 用户一次要求创建多个菜谱时，按菜谱逐个闭环处理，不要先把所有菜谱涉及的缺失食材全部创建完再回头创建菜谱。每个菜谱都按“检索/确认本菜谱食材 -> 必要时创建本菜谱缺失食材草稿 -> 生成本菜谱 `recipe.create_draft` -> 再进入下一个菜谱”的顺序推进。
- 多菜谱场景开始前，先用普通回复说明本次会按顺序处理哪些菜谱、当前先处理哪一个、后续菜谱会在前一个草稿完成后继续；如果用户要求批量但没有优先级，可以按用户列出的顺序处理。
- 更新、删除和收藏前先通过 `recipe.search` 或 `recipe.read_by_id` 确认真实目标。
- 多个相似菜谱、删除存在影响、或用户没有说明份数/目标时，调用 `human.request_input`，并给出候选摘要或影响摘要。
- `ingredient_items[].ingredient_id` 只能使用工具返回的真实 ID。
- `ingredient_items[].ingredient_id` 不能为空；主要调料没有食材档案时，不要直接忽略，应让用户选择创建食材档案、匹配已有食材，或明确只放入步骤/备注。
- 填写 `ingredient_id` 时，食材名称必须与该 ID 对应的名称一致。
- 新增可以生成结构化菜谱草稿。
- 更新、删除和收藏必须生成带 `action`、`targetId` 和 `baseUpdatedAt` 的操作草稿。
- `action=update` 的 payload 不是局部补丁；必须先读取真实菜谱详情，在现有菜谱基础上合成完整菜谱结构，再叠加用户要求的变化。payload 至少包含 `title`、`servings`、`prep_minutes`、`difficulty`、`ingredient_items` 和 `steps`。
- `action=set_favorite` 的 payload 只提供 `favorite=true/false`；`action=delete` 可以只提供删除原因，不要提交完整菜谱 payload。
- 删除审批必须展示删除影响，包括同步食物、计划项、烹饪记录和媒体处理。
- 仅通过 `recipe.create_draft` 生成 `recipe` 草稿，不直接写正式 `Recipe` 或收藏关系。
- 用户确认后由后端按操作类型写入，模型不参与最终写入判断。
