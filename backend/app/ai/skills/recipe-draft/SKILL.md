---
name: recipe-draft
display_name: 菜谱草稿
version: 1.0.0
description: 生成可编辑、可确认的结构化菜谱草稿。
category: recipe
runner: toolcall
risk_level: medium
allowed_tools:
  - ingredient.search
  - recipe.create_draft
forbidden_tools:
  - recipe.commit
requires_confirmation:
  - recipe.create
context_policy:
  - ingredients
workflow_files:
  - workflows.md
hitl_files:
  - hitl.md
example_files:
  - examples.md
script_files: []
output_contract: SkillExecutionResult
output_types:
  - recipe_draft
draft_types:
  - recipe
approval_policy: draft_then_confirm
can_continue_from:
  - recipe
intent: recipe_draft
agent_key: recipe_draft_agent
examples:
  - 帮我生成一份番茄鸡蛋面的菜谱。
  - 把这个菜谱补全。
---

# 菜谱草稿 Skill

## 目标

根据用户请求生成结构化菜谱草稿，供用户编辑和确认。

## 工具使用规则

- 使用菜谱草稿 schema 生成结构化结果。
- 只调用 `recipe.create_draft` 校验草稿。
- 不直接创建正式 Recipe。

## Human-in-the-loop 规则

确认前不得写入正式菜谱。确认后由后端审批流程创建菜谱并同步食物资料。
