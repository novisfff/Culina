---
name: meal-record
key: meal_log
display_name: 餐食记录
version: 1.0.0
description: 把自然语言用餐描述整理为可编辑餐食记录草稿。
category: recording
runner: meal_log
risk_level: medium
allowed_tools:
  - food.search
  - meal_log.read_recent
  - meal_log.create_draft
forbidden_tools:
  - meal_log.commit
requires_confirmation:
  - meal_log.create
context_policy:
  - foods
  - meal_logs
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files: []
output_contract: SkillExecutionResult
output_types:
  - meal_log_draft
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

## 目标

把用户的用餐描述整理成可编辑、可确认的餐食记录草稿。

## 工具使用规则

- 优先匹配已有家庭食物。
- 不确定食物时使用未关联名称。
- 只生成 `meal_log` 草稿。
- 不直接写 `MealLog`。
