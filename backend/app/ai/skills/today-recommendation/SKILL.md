---
name: today-recommendation
display_name: 今日推荐
version: 1.0.0
description: 根据库存、临期食材、最近餐食、食物和菜谱生成今日推荐卡片，不创建草稿。
category: recommendation
runner: toolcall
risk_level: low
allowed_tools:
  - inventory.read_available_items
  - inventory.read_expiring_items
  - food.search
  - recipe.search
  - meal_log.read_recent
forbidden_tools: []
requires_confirmation: []
context_policy:
  - inventory
  - foods
  - recipes
  - meal_logs
workflow_files:
  - workflows.md
hitl_files: []
example_files:
  - examples.md
script_files: []
output_contract: SkillExecutionResult
output_types:
  - today_recommendation
draft_types: []
approval_policy: none
can_continue_from: []
intent: today_recommendation
agent_key: today_recommendation_agent
examples:
  - 今晚吃什么？
  - 今天用现有食材推荐一下。
---

# 今日推荐 Skill

## 目标

给出今天或今晚可执行的餐食建议，优先考虑临期库存并避免最近重复。

## 工具使用规则

- 读取当前可用库存。
- 读取临期食材。
- 读取最近餐食。
- 可读取食物和菜谱作为候选。
- 不创建草稿，不写业务数据。

## 输出格式

返回 `today_recommendation` card。
