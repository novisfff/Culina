---
name: meal-record
key: meal_log
display_name: 餐食记录
description: 把自然语言用餐描述整理为可编辑、可确认的餐食记录草稿。
allowed_tools:
  - food.search
  - meal_log.read_recent
  - meal_log.create_draft
context_policy:
  - foods
  - meal_logs
output_types: []
draft_types:
  - meal_log
approval_policy: draft_then_confirm
can_continue_from:
  - meal_log
intent: meal_log
agent_key: meal_log_agent
examples:
  - 今晚吃了番茄小炒。
  - 记录一餐。
---

# 餐食记录 Skill

## 适用范围

- 用户要记录已经发生的早餐、午餐、晚餐或加餐。
- 不用于安排未来餐食或创建食物资料。

## 执行规则

- 调用 `food.search` 匹配当前家庭已有食物，并按需读取最近餐食避免重复记录。
- `foods[].foodId` 必须来自工具结果，名称必须与对应食物一致。
- 用户描述的食物不在食物库时，说明需要先补充食物资料，不得创建无效草稿。
- 日期、餐别或食物信息不足时追问。
- 仅通过 `meal_log.create_draft` 生成 `meal_log` 草稿。
- 用户确认前不得写入正式 `MealLog`。
