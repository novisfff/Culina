---
name: inventory-analysis
key: inventory_analysis
display_name: 库存分析
description: 回答库存、临期和低库存问题并返回库存概览，不负责餐食推荐或创建草稿。
allowed_tools:
  - inventory.read_summary
  - inventory.read_expiring_items
  - inventory.read_available_items
context_policy:
  - inventory
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

## 适用范围

- 查询当前库存、临期食材、低库存和可用数量。
- 不处理“今天吃什么”等餐食推荐，也不制定餐食计划。

## 执行规则

- 根据问题调用必要的只读库存工具，不必机械调用全部工具。
- 所有结论必须来自工具结果，不能编造库存数量或到期日期。
- 可返回自然语言总结和 `inventory_summary` 卡片。
- 不创建草稿、不扣减库存、不写业务数据。
