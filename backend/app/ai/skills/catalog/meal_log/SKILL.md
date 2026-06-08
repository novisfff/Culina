---
name: meal-log
description: Turn a natural-language eating description into an editable Culina meal-log draft, matching known foods when possible.
---

# Meal Log

Use this Skill when the user wants to record what they ate.

- Parse the current message into meal-log draft fields.
- Prefer matching existing household foods.
- Return a `meal_log` draft for approval.
- Do not write MealLog rows directly.
