---
name: backend-code-audit
description: Culina 后端代码审计 Skill。用于审查 backend/ 下 FastAPI、SQLAlchemy、Alembic、Pydantic schema、service、repo、serializer、权限、媒体、AI tools/skills/runtime、草稿审批或测试改动；当用户要求代码审计、review、排查后端改动风险、检查后端 PR/diff 或确认后端实现是否符合 Culina 数据边界时使用。
---

# Culina 后端代码审计

## 使用原则

默认只做审计，不修改代码。除非用户明确要求修复，否则输出问题、风险、证据和建议，不进入实现。

审计前先读取当前实现，不按通用 FastAPI 模板推断。必须优先阅读：

- `docs/backend-code-standards.md`
- 相关 `git diff` 或用户指定文件
- 受影响的 API route、schema、model、service、repo、serializer、migration 和测试
- 涉及前后端响应形状时，同步检查 `frontend/src/api/types.ts`、API client 和相关 view model
- 涉及 AI workspace、skill、tool、runtime、草稿或审批时，额外阅读 `docs/ai-assistant-standards.md`

输出使用简体中文。保持代码审计立场：问题优先，按严重度排序；没有发现问题时明确说没有发现阻断性问题，并说明仍存在的测试缺口或残余风险。

## 审计流程

1. 明确审计范围：当前 diff、指定 PR、指定文件或后端相关未提交改动。
2. 建立数据流：从路由入口追踪到权限依赖、service/repo、事务提交、serializer/schema 输出和测试。
3. 检查跨端契约：字段名、枚举值、日期格式、媒体 URL、数量单位、卡片类型、草稿类型和响应形状变化必须同步检查前端类型与调用方。
4. 检查写入路径：确认 family 隔离、操作者追踪、活动日志、事务边界、审批/正式写入分离和失败回滚。
5. 给出 findings-first 结论：每个问题都要有文件/行号、风险说明、触发场景和建议修复方向。

## 重点检查

- 家庭数据隔离：所有家庭业务数据查询和写入必须约束到当前 membership 的 `family_id`；不要信任请求体里的 `family_id`。
- 身份与权限：使用 `get_current_auth`、`get_current_user`、`get_current_membership` 或 `require_owner`；Owner 专属能力必须显式 Owner 检查。
- 审计字段：需要当前操作者的新增、编辑、删除流程必须维护 `created_by`、`updated_by` 和活动日志。
- 事务边界：写操作优先使用 `commit_session` 或现有事务辅助；同一用户动作产生的多表变更必须在同一事务中提交。
- 分层职责：路由处理 HTTP、依赖和事务收口；复杂业务规则下沉到 service/repo；不要让 route 或 serializer 承载大段业务流程。
- 模型和迁移：持久化 schema 变化必须新增 Alembic migration；不要修改旧 migration；model、schema、serializer、API 返回、测试和前端类型同步检查。
- 枚举与状态：强枚举优先放 `backend/app/core/enums.py`；避免散落自由字符串造成跨端状态漂移。
- 序列化：统一通过 schema/serializer 输出前端字段；不要让前端依赖 ORM 内部字段、关系加载副作用或数据库枚举实现细节。
- 媒体归属：上传、绑定、AI 生成和批量操作必须校验资源归属；优先复用 `backend/app/services/media.py` 和 `backend/app/repos/media.py`。
- AI 边界：Skill 只能调用 `allowed_tools`，正式写入必须走 `draft -> approval -> commit`，草稿必须来自 draft tool 校验结果，模型不能伪造最终写入。
- 测试覆盖：权限失败、跨家庭访问、正常写入、事务失败、serializer 输出和关键边界场景都应有对应测试。

## 严重度

- `P0`：跨家庭数据泄露/误写、绕过认证或 Owner 权限、正式业务数据未经审批写入、迁移会破坏已有数据、服务无法启动。
- `P1`：主要 API 路径失败、事务不一致、缓存/契约导致前端误用、schema/model/serializer 漂移、AI 草稿审批无法持久化或可被绕过。
- `P2`：局部业务边界缺陷、缺少关键失败测试、活动日志/审计字段遗漏、分层偏离导致维护风险。
- `P3`：命名、轻微重复、可读性、测试补强或小范围一致性建议；不要用 P3 噪音淹没真正风险。

## 输出格式

发现问题时：

```md
**Findings**
- `[P1]` 标题 — `backend/app/...:123`
  说明触发场景、实际风险、为什么当前实现会失败，以及建议修复方向。

**Open Questions**
- 仅列出会影响审计结论的真实疑问。

**Verification Gaps**
- 说明缺失或建议补跑的验证命令。
```

没有发现问题时：

```md
未发现阻断性后端问题。

验证缺口：说明未运行或仍建议补充的命令/场景。
```

## 验证建议

- route、权限、service、serializer 或 AI tool 变更：建议先跑相关 pytest，再视风险跑 `npm run backend:test`。
- 数据库模型和 migration 变更：检查 Alembic migration，并在可用本地库上执行迁移。
- 媒体、库存、AI 审批等多步骤流程：建议补集成式 API 测试。
- 涉及前后端契约时：建议同步跑相关前端类型/组件测试或构建检查。
- 只做审计时不要假装已经验证；最终结论必须区分“已实际运行”和“建议运行”。
