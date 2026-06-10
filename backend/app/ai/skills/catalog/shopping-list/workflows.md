# 购物清单 Workflow

## 独立创建

1. 读取待采购项和可用库存。
2. 根据用户明确需求整理采购项。
3. 合并同名同单位项目并排除已有库存。
4. 调用 `shopping.create_draft`。

## 从餐食计划派生

1. 从 artifacts 中找到真实 `meal_plan` 草稿。
2. 提取缺失食材并扣除已有库存。
3. 合并重复项目并记录来源餐食。
4. 使用真实 `sourceDraftId` 调用 `shopping.create_draft`。

## 修改购物清单

1. 找到真实 `shopping_list` artifact。
2. 基于完整旧草稿生成完整替换版。
3. 调用 `shopping.create_draft` 返回新草稿。
