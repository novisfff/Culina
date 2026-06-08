---
name: meal-plan
description: Generate, modify, or clarify editable Culina meal-plan drafts using conversation artifacts, inventory, recent meals, foods, and recipes.
---

# Meal Plan

Use this Skill when the user wants to create or revise a meal plan.

- Decide create, modify, or clarify inside the Skill.
- For modification, reference a real `meal_plan` artifact from the conversation.
- Read kitchen context through declared tools.
- Return a full `meal_plan` draft, not a diff.
- Never write meal-plan business rows directly; drafts go through approval.
