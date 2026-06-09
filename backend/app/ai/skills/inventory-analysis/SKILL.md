---
name: inventory-analysis
display_name: 库存分析
version: 1.0.0
description: 回答库存、临期和低库存相关问题，返回库存概览，不创建草稿。
category: inventory
runner: markdown
risk_level: low
allowed_tools:
  - inventory.read_summary
  - inventory.read_expiring_items
  - inventory.read_available_items
forbidden_tools:
  - inventory.consume
requires_confirmation: []
context_policy:
  - inventory
workflow_files:
  - workflows.md
hitl_files: []
example_files:
  - examples.md
script_files: []
output_contract: SkillExecutionResult
output_types:
  - inventory_summary
draft_types: []
approval_policy: none
can_continue_from: []
intent: inventory
agent_key: inventory_agent
examples:
  - 快过期食材有哪些？
  - 库存怎么样？
---

# 库存分析 Skill

## 目标

基于家庭库存上下文回答库存状态、临期食材、低库存和可用食材问题。

## 工具使用规则

- 只能使用只读库存工具。
- 不创建草稿。
- 不扣减库存。
- 不写业务数据。

## 输出格式

返回自然语言总结，可附带 `inventory_summary` card。
