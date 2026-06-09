# 购物清单 Workflow

## 创建流程

1. 读取待采购项。
2. 读取可用库存。
3. 根据用户需求生成采购项。
4. 合并重复项。
5. 调用 `shopping.create_draft`。

## 从餐食计划派生

1. 从 artifacts 中找到真实 `meal_plan` 草稿。
2. 提取缺失食材。
3. 扣除已有库存。
4. 合并同类食材。
5. 返回 `shopping_list` 草稿。
