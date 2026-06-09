# 菜谱草稿 Workflow

1. 从用户消息和 subject 推断菜名、人数、食材和偏好。
2. 调用配置模型生成结构化菜谱 JSON。
3. 校验并归一化菜谱草稿。
4. 调用 `recipe.create_draft`。
5. 返回待确认草稿。
