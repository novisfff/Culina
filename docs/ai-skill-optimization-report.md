# AI Skill 优化与完善分析报告

更新时间：2026-06-17

## 1. 结论摘要

当前 `backend/app/ai` 的 Skill 体系方向是正确的：Planner 只负责选择 Skill，`ToolCallingSkill` 让模型在白名单内自主 tool call，正式写入统一走 `draft -> approval -> commit`，并由 Tool、Runtime、审批 Service 做服务端校验。这比把参数抽取、业务判断和写入都硬编码在 Planner 或 Skill 里更适合 Culina 的自然语言工作台。

本报告基于 2026-06-17 当前工作区状态重新评估。当前分支已经做了一轮 prompt 与运行时优化：Skill 文档开始区分“自主决策空间”和“执行规则”，`ToolCallingSkill` 已向模型暴露 tool `output_schema`，并已为库存查询和即时推荐增加 Runtime 卡片兜底。因此后续重点不再是继续堆 prompt 禁令，而是把准确性继续下沉到工具 schema、脚本、normalizer、审批服务和评测用例。

主要问题不在“缺少安全边界”，而在 Skill 指令层仍偏流程手册化、局部重复、工具语义不够丰富、纯计算脚本能力偏弱。现在的写法能保证安全，但容易让模型变成照步骤执行，降低它根据上下文灵活选择工具、少问问题、生成更自然方案的能力。

建议下一阶段采用“宽松推理空间 + 硬约束下沉”的原则：

- Skill 文档只保留目标、边界、关键证据要求和少量决策启发。
- 准确性、ID 归属、字段枚举、审批、冲突和跨家庭隔离继续由 Tool / Draft normalizer / Approval service 强制。
- 对可编辑、低风险字段允许模型合理补全；对身份、数量、单位、删除、不可逆影响等阻塞字段才强制澄清。
- 用更强的 Tool schema、脚本和评测用例提高准确性，而不是继续堆叠更多 prompt 禁令。

## 2. 当前架构评估

### 2.1 已经做得比较好的部分

- `SKILL.md` 已成为 manifest 与指令入口，catalog 中 8 个 Skill 都走统一 `ToolCallingSkill`。
- `SkillExecutor` 会按 `approval_policy` 限制 side effect：普通查询只能 read，审批型 Skill 允许 read + draft，不暴露 write tool。
- 模型返回草稿但没有调用 draft tool 时会失败，避免模型在最终 JSON 中伪造草稿。
- Runtime 会拒绝未声明 card type、未声明 draft type，并捕获 draft tool 的真实输出作为唯一草稿来源。
- `draft_validation.py` 已经承担大量真实实体校验、字段归一化、跨家庭拒绝和当前用户范围约束。
- `intent.request_clarification` 已成为统一澄清工具，库存单位换算也有 pending clarification 的续接机制。
- 现有测试已经覆盖 catalog 合同、tool scope、非法卡片/草稿拒绝、脚本沙箱、库存单位澄清、做菜计划绑定和复合 Skill 执行。

### 2.2 主要风险

当前 Skill 文档里有大量“必须先 A 再 B”“不得 X”“固定流程”的句子。这些句子有一部分是必要安全边界，但也有一部分只是推荐策略。两者混在一起会造成三个问题：

1. 模型遇到上下文足够明确的简单请求时，也可能机械调用过多工具或过早追问。
2. 后续业务规则变化时，同一约束同时散落在 `SKILL.md`、Tool description、JSON schema、draft normalizer 和测试里，容易出现文档与真实行为不一致。
3. Skill 越写越长后，模型会更难区分“必须遵守的硬规则”和“可以灵活处理的建议”。

## 3. 总体优化方向

### 3.1 把 Skill 指令分层

建议每个 `SKILL.md` 固定成五段：

1. `任务目标`：这个 Skill 帮用户完成什么。
2. `适用与不适用`：只负责路由边界，不写细流程。
3. `可自主决定的部分`：允许模型根据上下文选择工具、补全非关键字段、组织文案和推荐理由。
4. `必须依赖工具的事实`：真实 ID、库存数量、日期、批次、已有计划、已有记录等。
5. `硬性禁止`：直接写入、跨家庭引用、编造业务 ID、绕过审批、不可逆操作不确认。

其中第 4、5 段应尽量短，因为真正的准确性要靠 tool schema、draft normalizer 和审批 service。

### 3.2 明确“什么时候可以自由，什么时候必须追问”

建议引入通用决策规则，并放到 Runtime system prompt 或 `docs/ai-assistant-standards.md`，避免每个 Skill 重复写：

| 场景 | 建议行为 |
| --- | --- |
| 可编辑的偏好、备注、分类、理由 | 可以基于用户原话和家庭上下文合理补全，确认卡里让用户改。 |
| 名称或目标唯一，且 tool 结果明确 | 不要追问，直接生成草稿或回答。 |
| 多个真实候选且会影响写入目标 | 必须澄清或让用户选择。 |
| 数量、单位、日期、餐别会影响库存/计划/记录 | 缺失时追问；可安全默认时在正文说明默认值。 |
| 删除、销毁、完成计划、扣减库存 | 必须生成审批草稿，不能用普通文本承诺已完成。 |
| 用户要求的对象不存在 | 不编造 ID；可建议先创建上游资料，并允许 Planner 串联上游 Skill。 |

这样既给模型自由度，又不会牺牲关键准确性。

### 3.3 强化工具语义，而不是继续加 prompt 禁令

`ToolCallingSkill._system_prompt()` 当前已经提供 tool name、description、side effect、requires_confirmation、input schema 和 output schema。这一步有助于模型提前理解工具返回字段，比只在调用后观察实际结果更稳定。

建议：

- 通用 `COUNT_OUTPUT` 已从业务工具输出中移除，食物、食材、库存、菜谱、餐食计划、餐食记录和购物清单读取工具都已改为领域化 output schema；后续重点是继续细化 tool description 和使用提示。
- Tool description 不只写“搜索当前家庭食材资料”，还应说明何时用、返回字段可作为哪些 draft 字段的证据。
- 对常用 read tool 增加 `usage_hints`，例如“exact=true 用于用户已给出完整名称时消歧”。

### 3.4 让结果卡更多由 Runtime 生成

当前 Runtime 已经为 `inventory_summary` 和 `today_recommendation` 增加兜底：模型调用相关 read tool 但没有返回卡片、且没有生成草稿或澄清时，Runtime 会基于工具输出补齐结构化卡片。这是正确方向。

后续建议继续扩展这个模式：

- 即时推荐兜底目前只能从已有 food/recipe 搜索结果中选前几个候选，推荐理由较弱；可以增加专用推荐脚本或 result normalizer，让模型负责选择候选和理由，Runtime 负责字段补齐。
- 餐食记录、食材档案和食物资料的纯查询场景，如果未来需要稳定 UI，也可以增加 summary card，但不建议为了卡片而扩大前端复杂度。
- `intent.request_clarification` 的兜底模式可以继续保留为通用标准：模型负责问题语义，Runtime 负责候选归一化。

这样模型可以自由组织回答，但 UI 稳定性不依赖模型记住 card JSON。

### 3.5 扩展 Skill Script 的确定性能力

当前脚本能力比上一轮已有增强：

- `meal-planning/scripts/expand_meal_slots.py` 已支持把日期范围和餐别展开成确定性计划槽位。
- `meal-planning/scripts/validate_meal_plan.py` 只校验必填字段和 mealType。
- `meal-planning/scripts/render_plan_preview.py` 只做文本预览。
- `recipe-draft/scripts/lint_recipe_draft.py` 已能检查菜谱草稿的标题、份数、耗时、难度、食材和步骤。
- `shopping-list/scripts/normalize_ingredient.py` 支持别名详情、置信度和是否需要确认，但词典仍较窄。
- `shopping-list/scripts/merge_ingredients.py` 只按名称和单位合并。

建议继续增强纯计算脚本：

- `meal-planning`: 已增强日期、重复餐次和重复食物预校验；后续可继续做候选评分和计划覆盖检测。
- `shopping-list`: 已新增从 meal_plan 缺失食材、库存和待买项生成采购候选的脚本，并支持常见单位同义词；后续继续扩展食材别名词典和跨单位换算提示。
- `recipe-draft`: 已增强步骤与食材引用一致性提示；后续可继续做份量合理性提示。
- `inventory-analysis`: 用户数量表达解析、批次处理摘要、入库/消耗/销毁操作预检查。

脚本只做纯计算，不访问数据库；真实业务事实仍来自 Tool。

## 4. 分 Skill 观察与建议

### 4.1 `inventory_analysis`

优点：

- 查询和写操作边界清楚，纯查询不创建草稿，入库/消耗/销毁必须走 `inventory_operation`。
- 单位不匹配已走 `pendingClarification -> create_unit_conversion_operation_draft`，方向正确。

问题与建议：

- `SKILL.md` 对查询工具选择写得很细，建议改成“优先调用最小必要 read tool”，把各工具适用场景放入 tool description。
- `inventory_summary` 卡片兜底已经下沉到 Runtime，这是正确方向；后续应补覆盖测试，确保纯查询不建草稿且稳定出卡。
- `inventory.read_low_stock_items` 当前实现已经是单层 items 输出，没有发现低库存项平方级重复问题；后续仍建议保留 Tool 级回归测试，防止列表归一化再次污染模型判断。
- 可以增加一个库存操作预检查脚本，帮助模型在调用 draft tool 前发现缺数量、缺原因、混合操作单位不一致等问题。

### 4.2 `meal_plan`

优点：

- 即时推荐与正式计划已在同一 Skill 内区分，符合当前规范。
- 正式计划强制使用真实 `foodId`，避免生成库外食物写入计划。

问题与建议：

- 即时推荐卡片已有 Runtime 兜底，但推荐质量仍主要依赖模型是否正确读取库存、最近餐食、食物和菜谱。建议进一步用脚本或 normalizer 稳定候选排序与推荐理由。
- 正式计划目前对“库外新菜”的自由度偏低。用户说“安排三天晚餐，想吃青椒牛肉”而食物库不存在时，模型只能阻断。更好的体验是 Planner 支持 `food_profile` 或 `recipe_draft -> meal_plan` 的串联，先创建资料审批，再继续计划。
- `workflows.md` 已与 operation draft 能力对齐：正式计划修改优先生成 `operations`，仅当前运行中的草稿修改才基于 artifact 生成完整草稿版本。
- `script.expand_meal_slots` 已补齐日期范围展开；`script.validate_meal_plan` 已增强日期、餐别、重复计划槽位和重复食物预校验，后续可继续加入食物/菜谱关联和计划覆盖检测。

### 4.3 `shopping_list`

优点：

- 支持独立创建、从计划派生、修改、完成和恢复待买。
- `sourceDraftId` 的来源限制比较明确。

问题与建议：

- `shopping_list` 当前已经允许 `ingredient.search/read_by_id`，处理“买鸡胸肉 500g”或常见别名时能主动确认真实食材单位。`script.suggest_items_from_sources` 已用于从计划、库存缺口和待买项综合生成采购候选，后续可以继续接入更丰富的单位同义词和跨单位换算提示。
- `workflows.md` 已与 operation draft 能力对齐：正式购物项修改、标记买到、恢复待买或删除优先生成 `operations`，仅当前运行中的草稿修改才基于 artifact 生成完整草稿版本。
- 别名归一化脚本已经返回“原名、归一名、置信度、是否需要确认”，但词典仍较窄。建议把常见中文食材别名维护成可测试字典，并覆盖单位同义词、地域叫法和常见错别字。

### 4.4 `meal_log`

优点：

- 食物必须来自真实 food，记录、补充详情和评分都走草稿审批。
- 更新详情和评分动作边界清晰。

问题与建议：

- 对“普通记录一餐”可以允许更多非关键字段自由补全，例如心情、备注、份量默认值，但要在确认卡里可编辑。
- 当前缺少删除餐食记录能力是合理的，Skill 已明确不支持删除。
- 如果后续要把餐食记录和库存扣减建议联动，建议由确认后的业务 Service 生成建议，不要让 `meal_log` 直接扣库存。

### 4.5 `recipe_draft`

优点：

- 新增、更新、删除、收藏都统一为 `recipe` 草稿。
- 允许未匹配食材保留名称并把 `ingredient_id` 设为 `null`，这给菜谱生成保留了必要自由度。

问题与建议：

- 生成菜谱前“调用 `ingredient.search` 获取当前家庭食材资料”可以改成“需要绑定真实食材 ID 或复用库存/档案时调用”，否则开放式新菜谱会产生无效搜索。
- `recipe_draft` 已加入 `script.lint_recipe_draft` 做结构检查，并会提示步骤未覆盖的食材。后续可继续检查食材单位是否异常、步骤顺序是否遗漏关键动作。
- 删除影响摘要最好由 read tool 或 service 生成，不建议靠模型从菜谱详情里推断同步食物、计划项和媒体影响。

### 4.6 `recipe_cook`

优点：

- 已把“做菜”从菜谱管理拆出，避免菜谱编辑和库存扣减混在一个 Skill。
- 对 `planItemId` 与 `recipeId` 的绑定要求清楚，且 Tool/Service 也会再次校验。

问题与建议：

- 文档是当前最流程化的 Skill，包含大量固定步骤。建议保留硬边界：必须真实菜谱、计划项必须按 recipeId 过滤、必须 preview、必须 draft；其余如份数默认、是否查计划、是否记录餐食可改成策略建议。
- `recipe.preview_cook` 当前没有发现重复的 `if recipe is None` 嵌套；后续更需要关注缺料场景的用户可操作出口。
- 缺料时“可以生成确认信息但执行会失败”的体验不够好。建议让 draft tool 或 preview 返回可操作选项：调整份数、先加入购物清单、继续但不扣缺失项。不要只把失败留到审批后。

### 4.7 `ingredient_profile`

优点：

- 作为库存、菜谱、购物清单的上游资料能力已经补齐。
- 更新时要求真实 `targetId` 和 `baseUpdatedAt`，符合冲突保护要求。

问题与建议：

- 这个 Skill 同时承担查询和写草稿，但没有结构化查询卡片。用户问“鸡蛋支持哪些单位”时，文本回答可以满足；如果后续要做更稳定 UI，可增加 `ingredient_profile_summary` 输出类型。
- “同名或近似名称结果不能自动猜测为唯一目标”可以更细化：只在写入目标不唯一时追问；纯查询可以列候选摘要，不必阻断。
- 保存单位换算为副单位的链路可以与库存单位澄清进一步打通：库存 Skill 产生的 `clarificationResolution` 可作为 ingredient_profile 更新草稿的上游 artifact。

### 4.8 `food_profile`

优点：

- 已明确创建食物资料时的最小必填字段，且允许基于用户原话推断类型和分类。
- 对品牌、价格、评分、库存、过期日期等无证据字段有清晰禁止。

问题与建议：

- 类型和分类映射写在 Skill 文档中，后续会难维护。建议抽成纯计算脚本或共享常量，例如 `script.infer_food_profile_defaults`，返回可编辑默认值和置信度。
- 更新与收藏走同一个 `food_profile.create_draft` 是可以的，但 Skill 文档可以补一条：如果用户只是问资料详情，不要生成草稿。

## 5. 优先级建议

### P0：当前已完成的测试与文档对齐

1. Runtime 自动生成 `inventory_summary`、`today_recommendation` 卡片已有回归测试，覆盖“模型漏卡但已调用 read tool”的情况。
2. `ToolCallingSkill` 暴露 `output_schema` 已有测试，确保 tool records 里同时包含 input/output schema。
3. `meal-planning/workflows.md` 和 `shopping-list/workflows.md` 已与当前 operation draft 能力对齐。
4. `inventory.read_low_stock_items` 已有单层输出回归测试，避免低库存项重复污染卡片。

### P1：提升自由度和稳定性的结构改造

1. 领域化 output schema 已覆盖现有 read tool；后续继续细化字段说明和 tool description。
2. 为食物、食材、菜谱、餐食记录等纯查询场景评估是否需要 Runtime summary card，不需要 UI 卡片的场景保持文本即可。
3. 把通用澄清规则、可默认规则和不可编造规则继续沉淀到共享 Runtime prompt 或标准文档，减少各 Skill 重复。
4. 继续精简各 `SKILL.md`，把硬规则和策略建议分段，减少固定流程句式。

### P2：增强模型可用工具，而不是限制模型

1. meal plan、shopping list 和 recipe 的基础脚本增强已落地；后续可继续补候选评分、计划覆盖检测和份量合理性提示。
2. shopping list 采购派生脚本已支持常见单位同义词；后续可继续把地域叫法和跨单位换算提示纳入候选结果。
3. 已建立基础自然语言 Skill eval 用例，覆盖少问、必须澄清、真实推荐和不可逆审批；后续扩展到更多跨 Skill 串联和失败恢复场景。
4. 利用现有质量诊断接口沉淀指标：澄清率、草稿失败率、审批通过率、Tool 调用失败率、用户重试率。

## 6. 推荐的 Skill 文档改写模板

```markdown
# {Skill 名称}

## 任务目标

- 用 2-4 条说明这个 Skill 帮用户完成什么。

## 适用范围

- 适用场景。
- 不适用场景；需要时说明应交给哪个 Skill。

## 自主决策空间

- 可以根据用户原话和工具结果合理补全哪些可编辑字段。
- 可以选择哪些工具组合，不要求固定顺序。
- 可以在不影响写入安全时减少追问。

## 必须依赖工具的事实

- 真实业务 ID、库存批次、日期范围、当前用户计划、已有记录等。
- 哪些字段必须来自 read tool 或 draft tool。

## 硬性边界

- 不直接写正式业务表。
- 不编造业务 ID、库存数量、过期日期、价格、评分等事实。
- 需要确认的动作必须调用 draft tool。
- 目标不唯一、数量/单位阻塞、删除/销毁等场景必须澄清。
```

这个模板会让模型保留自然语言推理和表达能力，同时把准确性锚定在工具与审批链路上。

## 7. 建议验收方式

文档和 prompt 优化不应只靠人工观察，建议建立一个轻量 Skill eval：

| 类型 | 示例 | 验收点 |
| --- | --- | --- |
| 少问问题 | “盒装牛奶，类型即食，适合早餐，帮我建资料” | 不追问，生成 food_profile 草稿。 |
| 必须澄清 | “把那个番茄菜谱删了”且有多个候选 | 返回 clarification_request。 |
| 自由推荐 | “今晚吃什么，别太麻烦” | 读取库存/最近餐食，返回 1-3 个真实 food/recipe 推荐，不建草稿。 |
| 串联能力 | “没有青椒牛肉的话帮我补上并安排明晚” | 先 food/recipe 草稿，再计划，或明确说明需先确认上游资料。 |
| 准确性 | “消耗 2 个鸡蛋” | 引用真实 ingredient/inventory item，不支持单位时走单位澄清。 |
| 不可逆动作 | “过期的都扔掉” | 读取过期批次，生成 dispose 草稿，等待确认。 |

通过这些 eval，可以判断“放松 Skill prompt”是否真的减少无效追问，同时不降低准确性。

## 8. 建议下一步

建议按以下顺序推进：

1. 先补 P0 测试和 workflows 文档对齐，确认当前运行时兜底与 output schema 暴露稳定。
2. 继续细化 read tool 的字段说明、使用提示和输出语义。
3. 选 `inventory_analysis` 和 `meal_plan` 两个最常用 Skill 继续做指令精简和脚本增强试点。
4. 在现有基础 eval 上扩展到 10-20 条自然语言用例，持续观察澄清率、草稿失败率和审批通过率。
5. 再批量精简其他 Skill，并把通用规则沉淀到共享 prompt / 标准文档。

核心目标不是让 Skill 变得更“松”或更“严”，而是把自由度放在模型擅长的理解、组合、表达和可编辑默认值上，把准确性放在工具、schema、normalizer、审批和测试上。
