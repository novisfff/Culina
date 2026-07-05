# Culina 计划与设计文档

`docs/` 根目录只保留当前开发规范：

- `frontend-code-standards.md`
- `backend-code-standards.md`
- `ai-assistant-standards.md`

阶段性设计、体检清单、迁移方案和功能落地计划统一放在 `docs/plans/`。

新增计划文档建议遵循：

- 文件名使用小写短横线，必要时带日期，例如 `code-quality-healthcheck-2026-06-28.md`。
- 文档开头写清背景、目标、范围和非目标。
- 方案类文档要标注涉及文件、风险、验证方式和后续拆分任务。
- 方案完成或失效后，不删除历史记录；在文档顶部补充状态说明。

## 当前前端基础组件计划

- `docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md`：前端基础组件统一化全量迁移计划，先建立 DropdownSelect、FormActions、ConfirmDialog、FormField、SearchField 和 QuantityUnitField。
