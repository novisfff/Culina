# Home Household Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 PR 72 与 PR 73 的最终共同基线上，把首页收敛为“今天吃什么、今天必须处理什么、家里发生了什么”三个问题，并用 `ActivityLog` 的显式家庭高亮契约支撑桌面、手机、Family 完整审计和周菜单导航。

**Architecture:** `ActivityLog` 继续作为唯一审计事实表，新增成对可空的结构化高亮字段；手工业务成功边界和 AI approval 最外层事务显式决定是否写入一条聚合高亮。首页读取新的限量高亮接口，Family 保留完整审计查询；前端把推荐窗口、行动合并、远端状态和导航协议放在纯 model/hook 中，桌面与手机分别负责 presentation。

**Tech Stack:** FastAPI、SQLAlchemy 2、Alembic、MySQL 8.4、Pydantic、pytest、React 18、TypeScript 5.7、React Query 5、Vitest、Playwright smoke、Culina 现有 CSS token 与响应式体系。

## Global Constraints

- 设计事实来源是 `docs/superpowers/specs/2026-07-12-home-household-highlights-design.md`；实现与该规格冲突时先停止并更新书面规格，不在代码中自行改产品口径。
- 实施前必须完成 PR 72 → PR 73 的真实合并/更新顺序，解决 PR 73 的冲突以及 Backend Service/Search 失败检查，再从二者最终合并后的干净共同基线创建执行 worktree。
- 当前组合基线的 Alembic head 是 `3f4a5b6c7d8e`。实施时若不再是该值，停止执行并更新本计划和设计规格；不得静默修改新迁移的 `down_revision`。
- `/Users/zyf/IdeaProjects/Culina/.worktrees/inventory-reconciliation` 只用于核实 PR 73 路径和函数边界；它包含现有未提交工作，实施期间不得编辑、stage 或提交该 worktree。
- 主工作区中已有的 `.claude/`、`.superpowers/brainstorm/` 以及未跟踪的旧计划/规格属于用户现场，不得纳入 P0.3 的任何提交。
- 历史 `ActivityLog` 不回填；`highlight_kind` 与 `highlight_summary` 必须同时为空或同时非空；`log_activity(..., highlight=None)` 永远保持默认 audit-only。
- 第一阶段高亮类型只有 `shopping`、`inventory`、`meal_plan`、`meal`、`family`；不增加 generic 类型，不从中文摘要、`entity_type` 或 composite 第一个 step 猜类型。
- 一次用户认可的业务事务最多写一条高亮；失败、拒绝、`409`、`422`、回滚和幂等重放不得增加高亮。
- AI execute、事务性 `after_success`、classifier、composite 归约、高亮写入与 flush 必须在同一个 `db.begin_nested()` 中；operation/draft 的 succeeded/confirmed 状态只在 savepoint 成功退出后设置。
- 当前 `after_success` 只允许同数据库 session 内可回滚动作；未来不可回滚的网络、消息或文件副作用必须走明确的 post-commit/outbox，不能放进 savepoint，也不能参与高亮准入判断。
- Family 第一阶段只有邀请成员成功可写 `family` 高亮；不增加角色切换、停用、移除或其他成员生命周期能力。
- 普通 shopping-list CRUD、菜谱收藏/评分/照片、家庭/个人/成员资料编辑和未列入准入矩阵的新流程继续 audit-only；不得仅因前端统一失效根 key 就把它们解释成 eligible。
- 首页只启用 `activityHighlightsQuery`，Family 才启用完整 `activityLogsQuery`；两者都不得进入全局 `isBootLoading`。
- Family overview 保留不截断的完整日志语义；活动 viewer 继续使用自己的 `activityLogList(...)` 与 `pageSize=50`。首次 loading/error 没有缓存时显示 `--`/局部状态，不伪造成 0 或空列表。
- 首页高亮和 Family 活动均不增加持续轮询；本期不增加 production query 参数或 feature flag。
- `week_highlight_count` 使用 `[Asia/Shanghai 本周一 00:00, 当前时刻]`，两端显式转换成 naive UTC 后查询 MySQL `DATETIME`，未来记录不计入。
- 桌面保留四项统计、候选充足时 3 个推荐和 7 天紧凑日历；手机保留原 Hero、Kitchen 图、家庭 meta chips、双快捷操作、四项统计、单个推荐和 7 天横滑日历。
- 推荐源数量为 0 时展示空态；小于 page size 时只展示真实数据；大于等于 page size 时使用窗口内不重复的环形窗口。桌面和手机游标独立，步长分别为 3 和 1。
- 问题 2 从未截断的 `homeEligibleInventoryActionGroups` 合并 urgent expiry、最多一条 shopping、low-stock，最后只执行一次 `slice(0, 3)`。
- 桌面问题 2/3 使用约 `56% / 44%` 两列；手机必须上下单列。手机只允许 Hero meta chips 与紧凑日历两处受控横滑，根页面不得横向溢出。
- `FamilyOverlayMode='activity'` 是完整记录的唯一业务打开状态；视口变化只切换 modal/page presentation，不改变业务状态。
- `target:'week'` 只定位所选自然周，不自动打开计划项；手机使用独立轻量周菜单 page/overlay。
- 前端 UI 修改必须先遵循 `frontend-ui-style`，复杂状态与响应式结构同时遵循 `frontend-ui-engineering` 和 `docs/frontend-code-standards.md`。
- 所有实现步骤测试先行；每个任务只提交列出的文件，不顺手重构无关代码。

## Execution Baseline Gate

本节是实施硬门，不产生代码提交。任何一条不满足都停止在该处。

- [ ] **Gate 1: 刷新两个前置 PR 的实时状态**

Run:

```bash
gh pr view 72 --json number,state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup
gh pr view 73 --json number,state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup
```

Expected:

- PR 72 已合并，或其最终 head 明确存在于 PR 73/最终基线；
- PR 73 已在 PR 72 之后更新，不再 `CONFLICTING`；
- PR 73 的 Backend Service Tests、Backend Search Tests 以及全部 required checks 为成功状态。

- [ ] **Gate 2: 从最终合并基线创建干净 worktree**

先使用 `superpowers:using-git-worktrees`，然后执行：

```bash
git fetch origin --prune
git worktree add /Users/zyf/IdeaProjects/Culina/.worktrees/home-household-highlights -b feature/home-household-highlights origin/main
git -C /Users/zyf/IdeaProjects/Culina/.worktrees/home-household-highlights status --short --branch
```

Expected: 新 worktree 位于 `feature/home-household-highlights`，工作树没有 tracked 或 untracked 变更。不得复用 `.worktrees/inventory-reconciliation`。

- [ ] **Gate 3: 证明 PR 72/73 最终提交都在执行基线**

重新读取两个最终 head SHA 并立即校验：

```bash
PR72_FINAL_HEAD_SHA="$(gh pr view 72 --json headRefOid --jq .headRefOid)"
PR73_FINAL_HEAD_SHA="$(gh pr view 73 --json headRefOid --jq .headRefOid)"
test -n "$PR72_FINAL_HEAD_SHA"
test -n "$PR73_FINAL_HEAD_SHA"
git merge-base --is-ancestor "$PR72_FINAL_HEAD_SHA" HEAD
git merge-base --is-ancestor "$PR73_FINAL_HEAD_SHA" HEAD
```

Expected: 两条 `merge-base` 命令退出码均为 0；不使用本规格中的旧快照 SHA。

- [ ] **Gate 4: 锁定迁移 head**

Run:

```bash
(cd backend && .venv/bin/alembic heads)
```

Expected: 只输出 `3f4a5b6c7d8e (head)`。如果输出不同，停止并让用户重新确认迁移依赖后再继续。

- [ ] **Gate 5: 建立基线测试证据**

Run:

```bash
npm run backend:test:service
npm run backend:test:search
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: 全部通过。若前置 PR 在干净最终基线上仍失败，先在 PR 73 范围内修复并完成其 review gate，不把修复混入下面 P0.3 提交。

## File Responsibility Map

### Backend

- Create `backend/alembic/versions/4a5b6c7d8e9f_add_activity_highlights.py`：只负责 additive columns、pair check、查询索引和可逆 downgrade。
- Modify `backend/app/core/enums.py`、`backend/app/models/domain.py`、`backend/app/services/activity.py`：定义高亮枚举、ORM 字段、不可变值对象与默认关闭的写入边界。
- Create `backend/app/services/activity_highlights.py`：只负责家庭隔离查询、演员解析、稳定排序和上海自然周计数。
- Create `backend/app/api/activity_highlights.py` and modify `backend/app/schemas/activity.py`、`backend/app/api/router.py`：只暴露首页最小响应契约。
- Modify shopping、inventory、food plan、meal、family 的既有成功边界：只在规格准入矩阵允许的事务级 `log_activity` 上传 `ActivityHighlight`。
- Create `backend/app/services/ai_operations/highlights.py`：只负责 draft classifier 调用、composite candidate 收集和同 kind 归约。
- Modify `backend/app/services/ai_operations/registry_types.py` 与 `draft_specs/*`：为非 composite spec 提供默认关闭的纯 classifier。
- Modify `backend/app/services/ai_operations/approval_decisions.py`、`composite.py`：让 approval 成为唯一 savepoint/highlighter owner。

### Frontend

- Modify `frontend/src/api/types.ts`、`foodsApi.ts`、`queryKeys.ts`、`cacheInvalidation.ts`：定义高亮契约、参数化缓存和 eligible mutation 失效。
- Modify `frontend/src/app/useAppWorkspaceQueries.ts`：拆分 Home highlights 与 Family logs，保留各自完整 query state。
- Create `frontend/src/app/useAppFamilyViewModel.ts`：保留 Family 完整审计统计语义，并显式表示首次 loading/error。
- Modify `frontend/src/features/home/homeDashboardModel.ts`、`useHomeDashboardState.ts`：负责环形推荐、独立游标、`HomeRequiredAction`、紧凑日历和远端展示状态。
- Create `frontend/src/features/home/HomeRequiredActions.tsx`、`HomeHighlightTimeline.tsx`、`HomeCompactCalendar.tsx`：提供桌面/手机复用且无业务排序的 presentation。
- Modify `frontend/src/features/home/HomeDashboard.tsx`、`HomeMobileDashboard.tsx`、`frontend/src/App.tsx`：组合已确认的三问结构并保留既有入口。
- Modify `frontend/src/features/family/FamilySettings.tsx`、`FamilyActivityViewer.tsx`、`FamilyActivityViewerModel.ts`、`useFamilySettingsState.ts`：统一 activity overlay 并区分 loading/empty/error/stale。
- Create `frontend/src/components/foods/FoodPlanWeekMobilePage.tsx` and modify `useFoodPlanState.ts`、`FoodWorkspace.tsx`、`FoodMobileView.tsx`：处理 `target:'week'` 的桌面/手机落点。
- Modify `frontend/src/styles/01-home-dashboard.css`、`02-family-settings.css`、`05-workspace-overlays.css`、`06-food-workspace.css`、`07-mobile.css`：使用现有 token 实现两列、单列、受控横滑、安全区和可见焦点。
- Modify `frontend/scripts/smoke.mjs`：补齐新接口 fixture、请求审计和响应式/导航断言。

---

### Task 1: Persist the Activity Highlight Contract

**Files:**

- Create: `backend/alembic/versions/4a5b6c7d8e9f_add_activity_highlights.py`
- Modify: `backend/app/core/enums.py`
- Modify: `backend/app/models/domain.py`
- Modify: `backend/app/services/activity.py`
- Create: `backend/tests/activity/test_activity_highlight_model.py`

**Interfaces:**

- Consumes: current `ActivityAction`, `ActivityLog`, `create_id()` and `utcnow()`.
- Produces: `ActivityHighlightKind`; immutable `ActivityHighlight(kind: ActivityHighlightKind, summary: str)`; `log_activity(..., highlight: ActivityHighlight | None = None) -> ActivityLog`; nullable ORM fields `ActivityLog.highlight_kind` and `ActivityLog.highlight_summary`.

- [ ] **Step 1: Write the failing service and constraint tests**

Create the focused test file with a local SQLite session fixture and these exact assertions:

```python
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind
from app.models.domain import ActivityLog, Base, Family
from app.services.activity import ActivityHighlight, log_activity


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    session.add(Family(id="family-highlight", name="高亮家庭", motto="", location=""))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_log_activity_defaults_to_audit_only(db: Session) -> None:
    activity = log_activity(
        db,
        family_id="family-highlight",
        actor_id="user-1",
        action=ActivityAction.UPDATE,
        entity_type="Family",
        entity_id="family-highlight",
        summary="更新家庭资料",
    )
    db.flush()
    assert activity.highlight_kind is None
    assert activity.highlight_summary is None


def test_log_activity_normalizes_a_structured_highlight(db: Session) -> None:
    activity = log_activity(
        db,
        family_id="family-highlight",
        actor_id="user-1",
        action=ActivityAction.UPDATE,
        entity_type="InventoryOperation",
        entity_id="operation-1",
        summary="登记采购",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.SHOPPING,
            summary="  完成 5 项采购入库  ",
        ),
    )
    db.flush()
    assert activity.highlight_kind is ActivityHighlightKind.SHOPPING
    assert activity.highlight_summary == "完成 5 项采购入库"


@pytest.mark.parametrize("summary", ["", "   ", "食" * 256])
def test_log_activity_rejects_invalid_highlight_summary(db: Session, summary: str) -> None:
    with pytest.raises(ValueError):
        log_activity(
            db,
            family_id="family-highlight",
            actor_id="user-1",
            action=ActivityAction.UPDATE,
            entity_type="InventoryOperation",
            entity_id="operation-1",
            summary="登记采购",
            highlight=ActivityHighlight(kind=ActivityHighlightKind.SHOPPING, summary=summary),
        )


def test_database_constraint_rejects_a_half_populated_highlight(db: Session) -> None:
    with pytest.raises(IntegrityError):
        db.execute(
            insert(ActivityLog).values(
                id="activity-half",
                family_id="family-highlight",
                actor_id="user-1",
                action=ActivityAction.UPDATE,
                entity_type="Family",
                entity_id="family-highlight",
                summary="非法半字段",
                highlight_kind=ActivityHighlightKind.FAMILY,
                highlight_summary=None,
            )
        )
        db.flush()
    db.rollback()
```

- [ ] **Step 2: Run the focused test and verify the contract is absent**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/activity/test_activity_highlight_model.py -q)
```

Expected: collection/import fails because `ActivityHighlightKind` and `ActivityHighlight` do not exist, or assertions fail because `ActivityLog` has no highlighter fields.

- [ ] **Step 3: Add the enum, value object, ORM pair constraint and service validation**

Implement the enum:

```python
class ActivityHighlightKind(str, Enum):
    SHOPPING = "shopping"
    INVENTORY = "inventory"
    MEAL_PLAN = "meal_plan"
    MEAL = "meal"
    FAMILY = "family"
```

Add the model contract:

```python
class ActivityLog(Base):
    __tablename__ = "activity_logs"
    __table_args__ = (
        CheckConstraint(
            "(highlight_kind IS NULL AND highlight_summary IS NULL) OR "
            "(highlight_kind IS NOT NULL AND highlight_summary IS NOT NULL)",
            name="ck_activity_logs_highlight_pair",
        ),
        Index(
            "ix_activity_logs_family_created_highlight",
            "family_id",
            "created_at",
            "highlight_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: create_id("activity"))
    family_id: Mapped[str] = mapped_column(ForeignKey("families.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    action: Mapped[ActivityAction] = mapped_column(SqlEnum(ActivityAction, native_enum=False), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    summary: Mapped[str] = mapped_column(String(255), nullable=False)
    highlight_kind: Mapped[ActivityHighlightKind | None] = mapped_column(
        SqlEnum(ActivityHighlightKind, native_enum=False),
        nullable=True,
    )
    highlight_summary: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    family: Mapped["Family"] = relationship(back_populates="activity_logs")
```

Add `CheckConstraint` and `Index` to the SQLAlchemy imports and `ActivityHighlightKind` to the enum imports.

Extend the service without changing the legacy `summary` behavior:

```python
from dataclasses import dataclass

from app.core.enums import ActivityAction, ActivityHighlightKind


@dataclass(frozen=True, slots=True)
class ActivityHighlight:
    kind: ActivityHighlightKind
    summary: str


def _normalize_highlight(highlight: ActivityHighlight | None) -> tuple[ActivityHighlightKind | None, str | None]:
    if highlight is None:
        return None, None
    normalized_summary = highlight.summary.strip()
    if not normalized_summary:
        raise ValueError("家庭高亮摘要不能为空")
    if len(normalized_summary) > 255:
        raise ValueError("家庭高亮摘要不能超过 255 个字符")
    return highlight.kind, normalized_summary


def log_activity(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    action: ActivityAction,
    entity_type: str,
    entity_id: str,
    summary: str,
    highlight: ActivityHighlight | None = None,
) -> ActivityLog:
    highlight_kind, highlight_summary = _normalize_highlight(highlight)
    activity = ActivityLog(
        id=create_id("activity"),
        family_id=family_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        highlight_kind=highlight_kind,
        highlight_summary=highlight_summary,
        created_at=utcnow(),
    )
    db.add(activity)
    return activity
```

- [ ] **Step 4: Add the additive Alembic migration**

Use the project’s enum-name persistence convention: Python/API values are lowercase, while the non-native SQL enum constraint stores member names.

```python
"""add activity highlights

Revision ID: 4a5b6c7d8e9f
Revises: 3f4a5b6c7d8e
"""

from alembic import op
import sqlalchemy as sa

revision = "4a5b6c7d8e9f"
down_revision = "3f4a5b6c7d8e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "activity_logs",
        sa.Column(
            "highlight_kind",
            sa.Enum(
                "SHOPPING",
                "INVENTORY",
                "MEAL_PLAN",
                "MEAL",
                "FAMILY",
                name="activityhighlightkind",
                native_enum=False,
            ),
            nullable=True,
        ),
    )
    op.add_column("activity_logs", sa.Column("highlight_summary", sa.String(length=255), nullable=True))
    op.create_check_constraint(
        "ck_activity_logs_highlight_pair",
        "activity_logs",
        "(highlight_kind IS NULL AND highlight_summary IS NULL) OR "
        "(highlight_kind IS NOT NULL AND highlight_summary IS NOT NULL)",
    )
    op.create_index(
        "ix_activity_logs_family_created_highlight",
        "activity_logs",
        ["family_id", "created_at", "highlight_kind"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_activity_logs_family_created_highlight", table_name="activity_logs")
    op.drop_constraint("ck_activity_logs_highlight_pair", "activity_logs", type_="check")
    op.drop_column("activity_logs", "highlight_summary")
    op.drop_column("activity_logs", "highlight_kind")
```

Do not add a data `UPDATE` or historical inference.

- [ ] **Step 5: Run model tests and migration shape checks**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/activity/test_activity_highlight_model.py tests/activity/test_activity_logs_api.py -q)
(cd backend && .venv/bin/alembic heads)
```

Expected: all tests pass and Alembic prints only `4a5b6c7d8e9f (head)`.

- [ ] **Step 6: Commit the persistence contract**

```bash
git add backend/alembic/versions/4a5b6c7d8e9f_add_activity_highlights.py backend/app/core/enums.py backend/app/models/domain.py backend/app/services/activity.py backend/tests/activity/test_activity_highlight_model.py
git commit -m "feat: add activity highlight persistence contract"
```

### Task 2: Add the Family-Scoped Activity Highlights API

**Files:**

- Create: `backend/app/services/activity_highlights.py`
- Create: `backend/app/api/activity_highlights.py`
- Modify: `backend/app/services/clock.py`
- Modify: `backend/app/schemas/activity.py`
- Modify: `backend/app/api/router.py`
- Create: `backend/tests/activity/test_activity_highlights_api.py`
- Create: `backend/tests/activity/test_activity_highlights_mysql.py`

**Interfaces:**

- Consumes: `ActivityLog.highlight_kind`, `ActivityLog.highlight_summary`, `Membership`, `now_for_family()` and authenticated membership.
- Produces: `activity_week_window_utc(family_id: str | None = None, *, at: datetime | None = None) -> tuple[datetime, datetime]` with naive UTC bounds; `list_activity_highlights(db, *, family_id, limit, at=None) -> dict[str, object]` validated by the response schema; `GET /api/activity-highlights?limit=5`.

- [ ] **Step 1: Write failing clock, isolation, ordering and response-contract tests**

Copy the exact engine/session/dependency-override lifecycle from `backend/tests/activity/test_activity_logs_api.py` into the new test module. Define `HighlightsApiContext` with fields `client`, `SessionLocal`, `family_id`, `other_family_id`, `user_id`, `membership_id` and `other_family_activity_id`, and expose it through a fixture named `highlights_api_context(monkeypatch)`. In that fixture, patch `app.services.activity_highlights.now_for_family` to return `datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai"))`. Seed two families, a current-family actor, a user who belongs only to the other family, equal timestamps, a Sunday record, Monday-boundary records, an audit-only row and a future record. Use `StaticPool`, override `get_db` and `get_current_auth`, and clear overrides/drop metadata/dispose the engine in `finally`, exactly like the existing activity API fixture. The key tests must read:

```python
def test_activity_week_window_converts_shanghai_monday_to_naive_utc() -> None:
    at = datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    week_start, now = activity_week_window_utc(at=at)
    assert week_start == datetime(2026, 7, 12, 16, 0)
    assert now == datetime(2026, 7, 12, 16, 30)
    assert week_start.tzinfo is None
    assert now.tzinfo is None


def test_highlights_are_family_scoped_stably_sorted_and_minimal(
    highlights_api_context: HighlightsApiContext,
) -> None:
    response = highlights_api_context.client.get("/api/activity-highlights", params={"limit": 5})
    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload["items"]] == ["activity-z", "activity-a"]
    assert payload["items"][0]["actor_name"] == "当前成员"
    assert payload["items"][1]["actor_name"] == "家庭成员"
    assert set(payload["items"][0]) == {
        "id", "kind", "summary", "actor_id", "actor_name", "created_at"
    }
    assert highlights_api_context.other_family_activity_id not in {
        item["id"] for item in payload["items"]
    }


def test_week_count_is_not_limited_and_excludes_future_records(
    highlights_api_context: HighlightsApiContext,
) -> None:
    response = highlights_api_context.client.get("/api/activity-highlights", params={"limit": 1})
    assert response.status_code == 200
    assert len(response.json()["items"]) == 1
    assert response.json()["week_highlight_count"] == 3


@pytest.mark.parametrize(
    ("limit", "status_code"),
    [(None, 200), (1, 200), (20, 200), (0, 422), (21, 422)],
)
def test_highlight_limit_contract(
    highlights_api_context: HighlightsApiContext,
    limit: int | None,
    status_code: int,
) -> None:
    params = {} if limit is None else {"limit": limit}
    assert highlights_api_context.client.get(
        "/api/activity-highlights",
        params=params,
    ).status_code == status_code


def test_activity_highlights_require_authentication(
    highlights_api_context: HighlightsApiContext,
) -> None:
    app.dependency_overrides.pop(get_current_auth, None)
    response = highlights_api_context.client.get("/api/activity-highlights")
    assert response.status_code == 401
```

Also assert an audit-only row is excluded and a row whose actor belongs only to another family uses `家庭成员` rather than that user’s display name.

Create a real-MySQL companion test using the repository’s existing safe test-database environment variable:

```python
from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind
from app.models.domain import ActivityLog, Family
from app.services.activity_highlights import list_activity_highlights


def _mysql_test_url() -> str:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    database = make_url(value).database or ""
    if not database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return value


def test_mysql_shanghai_week_boundary_matches_naive_utc_contract() -> None:
    engine = create_engine(_mysql_test_url(), future=True)
    connection = engine.connect()
    transaction = connection.begin()
    db = Session(bind=connection, expire_on_commit=False)
    try:
        db.add(Family(id="family-highlight-mysql", name="MySQL 高亮家庭", motto="", location=""))
        for activity_id, created_at in [
            ("activity-before-week", datetime(2026, 7, 12, 15, 59, 59)),
            ("activity-week-start", datetime(2026, 7, 12, 16, 0, 0)),
            ("activity-future", datetime(2026, 7, 12, 16, 31, 0)),
        ]:
            db.add(
                ActivityLog(
                    id=activity_id,
                    family_id="family-highlight-mysql",
                    actor_id="missing-member",
                    action=ActivityAction.UPDATE,
                    entity_type="InventoryOperation",
                    entity_id=activity_id,
                    summary="MySQL 边界审计",
                    highlight_kind=ActivityHighlightKind.INVENTORY,
                    highlight_summary="完成库存盘点",
                    created_at=created_at,
                )
            )
        db.flush()
        result = list_activity_highlights(
            db,
            family_id="family-highlight-mysql",
            limit=20,
            at=datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai")),
        )
        assert result["week_highlight_count"] == 1
        assert {item["id"] for item in result["items"]} == {
            "activity-before-week",
            "activity-week-start",
            "activity-future",
        }
    finally:
        db.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        engine.dispose()
```

The limited item list intentionally includes historical/future eligible rows; only `week_highlight_count` applies the Monday-to-now bounds.

- [ ] **Step 2: Run the API test and verify the endpoint is missing**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/activity/test_activity_highlights_api.py -q)
```

Expected: import fails for `activity_week_window_utc` or requests return 404.

- [ ] **Step 3: Implement explicit Shanghai-to-naive-UTC bounds**

Add this to `clock.py`:

```python
from datetime import UTC, date, datetime, time


def activity_week_window_utc(
    family_id: str | None = None,
    *,
    at: datetime | None = None,
) -> tuple[datetime, datetime]:
    family_now = now_for_family(family_id, at=at)
    monday = family_now.date() - timedelta(days=family_now.weekday())
    family_week_start = datetime.combine(monday, time.min, tzinfo=family_now.tzinfo)
    week_start_utc = family_week_start.astimezone(UTC).replace(tzinfo=None)
    now_utc_naive = family_now.astimezone(UTC).replace(tzinfo=None)
    return week_start_utc, now_utc_naive
```

Import `timedelta`. Do not call `datetime.combine` without the Shanghai `tzinfo`, and do not compare aware values directly to MySQL `DATETIME`.

- [ ] **Step 4: Implement a focused query service**

Use one stable limited select, one unlimited count select, and a current-family membership map:

```python
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.domain import ActivityLog, Membership
from app.services.clock import activity_week_window_utc


def _response_time(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def list_activity_highlights(
    db: Session,
    *,
    family_id: str,
    limit: int,
    at: datetime | None = None,
) -> dict[str, object]:
    eligible = (
        ActivityLog.family_id == family_id,
        ActivityLog.highlight_kind.is_not(None),
        ActivityLog.highlight_summary.is_not(None),
    )
    logs = list(
        db.scalars(
            select(ActivityLog)
            .where(*eligible)
            .order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
            .limit(limit)
        )
    )
    memberships = list(
        db.scalars(select(Membership).where(Membership.family_id == family_id))
    )
    actor_map = {membership.user_id: membership.user.display_name for membership in memberships}
    week_start, now = activity_week_window_utc(family_id, at=at)
    week_count = int(
        db.scalar(
            select(func.count(ActivityLog.id)).where(
                *eligible,
                ActivityLog.created_at >= week_start,
                ActivityLog.created_at <= now,
            )
        )
        or 0
    )
    return {
        "items": [
            {
                "id": log.id,
                "kind": log.highlight_kind.value,
                "summary": log.highlight_summary,
                "actor_id": log.actor_id,
                "actor_name": actor_map.get(log.actor_id, "家庭成员"),
                "created_at": _response_time(log.created_at),
            }
            for log in logs
        ],
        "week_highlight_count": week_count,
    }
```

The membership query must remain constrained by `family_id`; do not fetch users globally.

- [ ] **Step 5: Add Pydantic schemas, route and router registration**

```python
class ActivityHighlightOut(BaseModel):
    id: str
    kind: ActivityHighlightKind
    summary: str
    actor_id: str
    actor_name: str
    created_at: datetime


class ActivityHighlightsResponse(BaseModel):
    items: list[ActivityHighlightOut]
    week_highlight_count: int
```

Import `ActivityHighlightKind` from `app.core.enums` in `schemas/activity.py`.

```python
router = APIRouter(tags=["activity-highlights"])


@router.get("/api/activity-highlights", response_model=ActivityHighlightsResponse)
def get_activity_highlights(
    limit: int = Query(default=5, ge=1, le=20),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    return list_activity_highlights(
        db,
        family_id=membership.family_id,
        limit=limit,
    )
```

Register `activity_highlights_router` next to `activity_logs_router` without changing `GET /api/activity-logs`.

- [ ] **Step 6: Run focused and regression tests**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/activity/test_activity_highlights_api.py tests/activity/test_activity_highlights_mysql.py tests/activity/test_activity_logs_api.py tests/activity/test_activity_highlight_model.py -q)
```

Expected: SQLite tests pass; the MySQL test passes when `CULINA_TEST_MYSQL_URL` is configured and otherwise reports a skip. The legacy logs response still includes audit fields, while the highlight response exposes only its six item fields plus the count wrapper.

- [ ] **Step 7: Commit the query API**

```bash
git add backend/app/services/activity_highlights.py backend/app/api/activity_highlights.py backend/app/services/clock.py backend/app/schemas/activity.py backend/app/api/router.py backend/tests/activity/test_activity_highlights_api.py backend/tests/activity/test_activity_highlights_mysql.py
git commit -m "feat: add family activity highlights API"
```

### Task 3: Highlight Shopping and Inventory Transaction Outcomes

**Files:**

- Modify: `backend/app/services/shopping_intake.py`
- Modify: `backend/app/services/inventory_reconciliation.py`
- Modify: `backend/app/services/inventory_operation_history.py`
- Modify: `backend/app/services/inventory_expiry_actions.py`
- Modify: `backend/tests/shopping/test_shopping_intake_api.py`
- Modify: `backend/tests/inventory/test_inventory_reconciliation_api.py`
- Modify: `backend/tests/inventory/test_inventory_operation_revert.py`
- Modify: `backend/tests/inventory/test_inventory_api.py`

**Interfaces:**

- Consumes: Task 1 `ActivityHighlight` and `ActivityHighlightKind`; PR 72 grouped expiry actions; PR 73 `InventoryOperationType` and idempotency/revert boundaries.
- Produces: one `shopping` highlight per successful intake/revert, one `inventory` highlight per successful reconciliation/revert or grouped expired disposal; snooze, retain and date correction remain audit-only.

- [ ] **Step 1: Add failing highlighter and idempotency assertions**

In the existing successful request tests, query only `ActivityLog.highlight_kind IS NOT NULL` and assert exact transaction-level counts:

```python
def _highlight_rows(db: Session, *, family_id: str) -> list[ActivityLog]:
    return list(
        db.scalars(
            select(ActivityLog)
            .where(
                ActivityLog.family_id == family_id,
                ActivityLog.highlight_kind.is_not(None),
            )
            .order_by(ActivityLog.created_at, ActivityLog.id)
        )
    )


def test_shopping_intake_writes_one_highlight_and_replay_does_not_duplicate(
    intake_api_context: IntakeApiContext,
) -> None:
    first = intake_api_context.client.post(
        "/api/shopping-intake",
        json=intake_api_context.valid_payload,
        headers={"Idempotency-Key": "intake-highlight-1"},
    )
    replay = intake_api_context.client.post(
        "/api/shopping-intake",
        json=intake_api_context.valid_payload,
        headers={"Idempotency-Key": "intake-highlight-1"},
    )
    assert first.status_code == 200
    assert replay.status_code == 200
    with intake_api_context.SessionLocal() as db:
        highlights = _highlight_rows(db, family_id=intake_api_context.family_id)
        assert len(highlights) == 1
        assert highlights[0].highlight_kind is ActivityHighlightKind.SHOPPING
        assert highlights[0].highlight_summary == "完成 1 项采购入库"
```

Add equivalent assertions:

- reconciliation first submit and idempotent replay: business operation count 1, highlight count 1;
- shopping-intake revert: one new `shopping` highlight;
- reconciliation revert: one new `inventory` highlight;
- repeated revert: no third highlight;
- grouped expired disposal: one `inventory` highlight whose summary count equals submitted batch count;
- snooze, retain and expiry-date correction: zero highlights;
- existing forced commit failure, stale version and cross-family failures: zero highlights.

- [ ] **Step 2: Run the focused tests and verify audit rows lack highlights**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/shopping/test_shopping_intake_api.py -k "highlight or idempotent or forced_commit" -q)
(cd backend && .venv/bin/python -m pytest tests/inventory/test_inventory_reconciliation_api.py tests/inventory/test_inventory_operation_revert.py -k "highlight or replay or forced_commit or conflict" -q)
```

Expected: new highlight assertions fail with zero eligible rows; all legacy business assertions remain green.

- [ ] **Step 3: Attach highlights only to the existing transaction-level audit rows**

For shopping intake:

```python
highlight_count = full_completed + partial_only
log_activity(
    db,
    family_id=family_id,
    actor_id=user_id,
    action=ActivityAction.UPDATE,
    entity_type="InventoryOperation",
    entity_id=operation.id,
    summary=f"登记了本次购买：{description}",
    highlight=ActivityHighlight(
        kind=ActivityHighlightKind.SHOPPING,
        summary=f"完成 {highlight_count} 项采购入库",
    ),
)
```

For reconciliation, use actual adjusted/confirmed results:

```python
log_activity(
    db,
    family_id=family_id,
    actor_id=user_id,
    action=ActivityAction.UPDATE,
    entity_type="InventoryOperation",
    entity_id=operation.id,
    summary=f"完成了一次库存盘点：{description}",
    highlight=ActivityHighlight(
        kind=ActivityHighlightKind.INVENTORY,
        summary=f"完成库存盘点并确认 {confirmed_count} 项、修正 {adjusted_count} 项",
    ),
)
```

For revert, select the kind from the already-locked persisted operation type, not from summary text:

```python
if operation.operation_type == InventoryOperationType.SHOPPING_INTAKE:
    highlight = ActivityHighlight(
        kind=ActivityHighlightKind.SHOPPING,
        summary="撤销一次采购入库",
    )
elif operation.operation_type == InventoryOperationType.RECONCILIATION:
    highlight = ActivityHighlight(
        kind=ActivityHighlightKind.INVENTORY,
        summary="撤销一次库存盘点",
    )
else:
    highlight = None

log_activity(
    db,
    family_id=family_id,
    actor_id=user_id,
    action=ActivityAction.REVERT,
    entity_type="InventoryOperation",
    entity_id=operation.id,
    summary=activity_summary,
    highlight=highlight,
)
```

For `dispose_expired_inventory_items()`:

```python
log_activity(
    db,
    family_id=family_id,
    actor_id=user_id,
    action=ActivityAction.UPDATE,
    entity_type="Ingredient",
    entity_id=ingredient.id,
    summary=f"{actor_display_name}销毁{ingredient.name} {len(disposed_item_ids)} 个过期批次",
    highlight=ActivityHighlight(
        kind=ActivityHighlightKind.INVENTORY,
        summary=f"集中处理 {len(disposed_item_ids)} 个过期批次",
    ),
)
```

Do not add `highlight` to `snooze_expiry_alerts()`, retain, state snooze, state retain or either expiry correction function.

- [ ] **Step 4: Re-run business, rollback and idempotency coverage**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/shopping/test_shopping_intake_api.py tests/inventory/test_inventory_reconciliation_api.py tests/inventory/test_inventory_operation_revert.py -q)
(cd backend && .venv/bin/python -m pytest tests/inventory -k "expiry" -q)
```

Expected: all pass; every replay assertion remains business result 1/highlight 1, and failure paths leave zero highlights.

- [ ] **Step 5: Commit the inventory outcome matrix**

```bash
git add backend/app/services/shopping_intake.py backend/app/services/inventory_reconciliation.py backend/app/services/inventory_operation_history.py backend/app/services/inventory_expiry_actions.py backend/tests/shopping/test_shopping_intake_api.py backend/tests/inventory/test_inventory_reconciliation_api.py backend/tests/inventory/test_inventory_operation_revert.py backend/tests/inventory/test_inventory_api.py
git commit -m "feat: highlight shopping and inventory outcomes"
```

Before committing, inspect `git diff --cached --name-only` and confirm only these eight files are staged.

### Task 4: Highlight Meal Plan, Meal and Family Outcomes

**Files:**

- Modify: `backend/app/api/recipe_meta.py`
- Modify: `backend/app/api/meal_logs.py`
- Modify: `backend/app/api/recipes.py`
- Modify: `backend/app/api/family.py`
- Modify: `backend/tests/recipes/test_food_workspace.py`
- Modify: `backend/tests/recipes/test_recipe_cooking.py`
- Modify: `backend/tests/family/test_family_api.py`

**Interfaces:**

- Consumes: Task 1 highlighter contract and existing manual API transaction/`commit_session()` boundaries.
- Produces: `meal_plan` for create/material update/delete; `meal` for recipe cook, meal create and quick-add; `family` only for invitation. Note/status-only plan updates, meal enrichment and profile/family/member edits remain audit-only.

- [ ] **Step 1: Add failing eligible-versus-audit-only tests**

`backend/tests/recipes/test_food_workspace.py` is the existing meal-log/food-plan API test owner and uses `RecipeFoodWorkspaceTestCase`; do not create a duplicate meal-log module or a pytest fixture. Add this helper as a method on that class:

```python
def assert_highlight_kinds(
    self,
    expected: list[ActivityHighlightKind],
) -> None:
    with self.SessionLocal() as db:
        rows = list(
            db.scalars(
                select(ActivityLog)
                .where(
                    ActivityLog.family_id == self.family.id,
                    ActivityLog.highlight_kind.is_not(None),
                )
                .order_by(ActivityLog.created_at, ActivityLog.id)
            )
        )
    self.assertEqual([row.highlight_kind for row in rows], expected)
```

Extend the existing `test_food_plan_supports_non_recipe_food_and_quick_add_completion` around its real `plan_response` and `update_response` calls:

```python
self.assert_highlight_kinds([ActivityHighlightKind.MEAL_PLAN])

note_only = self.client.patch(
    f"/api/food-plan/{plan['id']}",
    json={"note": "带水果"},
)
self.assertEqual(note_only.status_code, 200, note_only.text)
self.assert_highlight_kinds([ActivityHighlightKind.MEAL_PLAN])

update_response = self.client.patch(
    f"/api/food-plan/{plan['id']}",
    json={"meal_type": "lunch"},
)
self.assertEqual(update_response.status_code, 200, update_response.text)
self.assert_highlight_kinds([
    ActivityHighlightKind.MEAL_PLAN,
    ActivityHighlightKind.MEAL_PLAN,
])
```

Use `self.client`, `self.SessionLocal`, `self.family.id` and `self.assert*` throughout the remaining matrix.

Also cover:

- delete plan creates one more `meal_plan`;
- status-only/cooked marker does not create `meal_plan`;
- create meal log and quick-add each create one `meal`;
- meal detail/rating/photo update creates no new highlight;
- manual recipe cook creates exactly one `meal` even when it consumes inventory and completes a plan;
- invitation creates one `family`;
- family/profile/member edit creates no new highlight;
- commit failure rolls back both business data and highlighter row.

- [ ] **Step 2: Run the focused tests and verify the matrix is not implemented**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/recipes/test_food_workspace.py tests/recipes/test_recipe_cooking.py tests/family/test_family_api.py -k "highlight or note_only or invite or cook" -q)
```

Expected: eligible tests fail because no rows carry `highlight_kind`; audit-only control assertions pass.

- [ ] **Step 3: Add plan highlights using before/after material fields**

On create and delete, attach explicit actor-free summaries. On update, capture before values before mutation:

```python
before_material = (item.food_id, item.plan_date, item.meal_type)

# Apply payload fields using the existing code.

after_material = (item.food_id, item.plan_date, item.meal_type)
materially_changed = before_material != after_material
highlight = (
    ActivityHighlight(
        kind=ActivityHighlightKind.MEAL_PLAN,
        summary=f"将 {item.food.name} 安排到 {item.plan_date.isoformat()} {MEAL_TYPE_LABELS[item.meal_type.value]}",
    )
    if materially_changed
    else None
)
log_activity(
    db,
    family_id=membership.family_id,
    actor_id=user.id,
    action=ActivityAction.UPDATE,
    entity_type="FoodPlanItem",
    entity_id=item.id,
    summary=f"更新菜单计划 {item.food.name}",
    highlight=highlight,
)
```

`create` and `delete` use the same `MEAL_PLAN` kind. Status and note are deliberately absent from `before_material`/`after_material`.

- [ ] **Step 4: Add outer-owner meal and family highlights**

For manual meal creation and quick-add:

```python
highlight=ActivityHighlight(
    kind=ActivityHighlightKind.MEAL,
    summary=f"记录了{MEAL_TYPE_LABELS.get(meal_log.meal_type.value, meal_log.meal_type.value)}",
)
```

For manual recipe cook, add the highlighter only to the existing final recipe-cook transaction activity:

```python
highlight=ActivityHighlight(
    kind=ActivityHighlightKind.MEAL,
    summary=f"完成 {recipe.title} 并记录用餐",
)
```

Any nested inventory consumption, plan completion or meal creation remains audit-only. For invitation:

```python
highlight=ActivityHighlight(
    kind=ActivityHighlightKind.FAMILY,
    summary=f"邀请 {member_user.display_name} 加入家庭",
)
```

Do not add highlighters to `update_family`, `update_member`, profile updates, meal update/enrichment or recipe favorites.

- [ ] **Step 5: Run all affected service suites**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/recipes/test_food_workspace.py tests/recipes/test_recipe_cooking.py tests/family/test_family_api.py -q)
(cd backend && .venv/bin/python -m pytest tests -k "meal_log" -q)
```

Expected: all pass; one cook transaction yields exactly one eligible `meal` row even if multiple audit rows exist.

- [ ] **Step 6: Commit the remaining manual outcome matrix**

```bash
git add backend/app/api/recipe_meta.py backend/app/api/meal_logs.py backend/app/api/recipes.py backend/app/api/family.py backend/tests/recipes/test_food_workspace.py backend/tests/recipes/test_recipe_cooking.py backend/tests/family/test_family_api.py
git commit -m "feat: highlight meal plan meal and family outcomes"
```

The meal-log API coverage is owned by `backend/tests/recipes/test_food_workspace.py`; do not create a duplicate test module for the same endpoints.

### Task 5: Add Pure AI Outcome Classifiers and Composite Reduction

**Files:**

- Modify: `backend/app/services/ai_operations/registry_types.py`
- Modify: `backend/app/services/ai_operations/draft_specs/common.py`
- Modify: `backend/app/services/ai_operations/draft_specs/planning.py`
- Modify: `backend/app/services/ai_operations/draft_specs/recipes.py`
- Create: `backend/app/services/ai_operations/highlights.py`
- Modify: `backend/tests/ai_infra/test_registry_and_metrics.py`
- Modify: `backend/tests/ai_infra/test_composite_operations.py`

**Interfaces:**

- Consumes: Task 1 `ActivityHighlight`; submitted non-composite payloads; actual successful `business_entity` payloads; composite `steps` results containing `stepId`, `domain`, `entityIds` and `payload`.
- Produces: pure `DraftHighlightContext`; optional `DraftOperationSpec.highlight_classifier`; `DraftOperationRegistry.classify_highlight()`; `classify_approval_highlight(...) -> ActivityHighlight | None` with zero/single-kind/cross-kind semantics.

- [ ] **Step 1: Write failing registry and reduction tests**

Add focused tests that do not touch a database:

```python
def _highlight_test_spec(draft_type: str) -> DraftOperationSpec:
    """Project-native registry fixture; keep every unrelated callback inert."""
    return DraftOperationSpec(
        draft_type=draft_type,
        normalize=lambda context: context.payload,
        execute=lambda context: (context.payload, []),
        after_success=None,
        approval_config=lambda _payload: {"approval_type": f"{draft_type}.apply"},
        preview_summary=lambda _payload: "测试草稿",
    )


def test_specs_without_classifier_are_audit_only() -> None:
    registry = DraftOperationRegistry([_highlight_test_spec("shopping_list")])
    result = registry.classify_highlight(
        DraftHighlightContext(
            draft_type="shopping_list",
            submitted_payload={"operations": [{"action": "create"}]},
            business_entity={"operations": [{"action": "create"}]},
        )
    )
    assert result is None


def test_meal_plan_classifier_uses_actual_eligible_results() -> None:
    context = DraftHighlightContext(
        draft_type="meal_plan",
        submitted_payload={"operations": []},
        business_entity={
            "operations": [
                {"action": "create", "item": {"id": "plan-1"}},
                {"action": "update", "item": {"id": "plan-2"}},
                {"action": "set_status", "item": {"id": "plan-3"}},
            ]
        },
    )
    result = draft_operation_registry.classify_highlight(context)
    assert result == ActivityHighlight(
        kind=ActivityHighlightKind.MEAL_PLAN,
        summary="完成 2 项菜单安排",
    )


def test_meal_log_classifier_rejects_enrichment_and_accepts_create() -> None:
    update_result = draft_operation_registry.classify_highlight(
        DraftHighlightContext(
            draft_type="meal_log",
            submitted_payload={"action": "update_details"},
            business_entity={"id": "meal-1"},
        )
    )
    create_result = draft_operation_registry.classify_highlight(
        DraftHighlightContext(
            draft_type="meal_log",
            submitted_payload={"action": "create"},
            business_entity={"id": "meal-2", "meal_type": "dinner"},
        )
    )
    assert update_result is None
    assert create_result == ActivityHighlight(
        kind=ActivityHighlightKind.MEAL,
        summary="记录了一次晚餐",
    )


def test_composite_same_kind_reduces_once_and_cross_kind_is_audit_only() -> None:
    same_kind = reduce_activity_highlights(
        [
            ActivityHighlight(ActivityHighlightKind.MEAL_PLAN, "完成 2 项菜单安排"),
            ActivityHighlight(ActivityHighlightKind.MEAL_PLAN, "完成 1 项菜单安排"),
        ]
    )
    cross_kind = reduce_activity_highlights(
        [
            ActivityHighlight(ActivityHighlightKind.MEAL_PLAN, "完成 1 项菜单安排"),
            ActivityHighlight(ActivityHighlightKind.MEAL, "记录了一次晚餐"),
        ]
    )
    assert same_kind == ActivityHighlight(
        ActivityHighlightKind.MEAL_PLAN,
        "完成 2 组菜单安排",
    )
    assert cross_kind is None
```

Add a composite mapping test where one ingredient-profile step returns no candidate and three meal-plan steps return one aggregated `meal_plan` candidate. Add a control test proving ordinary recipe CRUD, shopping-list CRUD and generic inventory-operation specs return `None`.

- [ ] **Step 2: Run the focused AI tests and verify classifier symbols are absent**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/ai_infra/test_registry_and_metrics.py tests/ai_infra/test_composite_operations.py -k "highlight or classifier" -q)
```

Expected: import/attribute failures for `DraftHighlightContext`, `highlight_classifier` or `reduce_activity_highlights`.

- [ ] **Step 3: Add the default-closed registry contract**

In `registry_types.py`:

```python
from app.services.activity import ActivityHighlight


@dataclass(frozen=True, slots=True)
class DraftHighlightContext:
    draft_type: str
    submitted_payload: dict[str, Any]
    business_entity: dict[str, Any]


DraftHighlightClassifier = Callable[[DraftHighlightContext], ActivityHighlight | None]


@dataclass(frozen=True, slots=True)
class DraftOperationSpec:
    draft_type: str
    normalize: NormalizeDraft
    execute: ExecuteDraft
    after_success: PostExecuteHook | None
    approval_config: ApprovalConfigBuilder
    preview_summary: PreviewSummaryBuilder
    highlight_classifier: DraftHighlightClassifier | None = None
    validate_approval_value: ApprovalValueValidator = _allow_any_approval_value
    result_metadata: DraftResultMetadata = DEFAULT_DRAFT_RESULT_METADATA
    business_entity_records: BusinessEntityRecordsExtractor | None = None
    load_current_value: RecoveryCurrentValueLoader | None = None
```

Add the registry method:

```python
def classify_highlight(self, context: DraftHighlightContext) -> ActivityHighlight | None:
    classifier = self.get(context.draft_type).highlight_classifier
    if classifier is None:
        return None
    return classifier(context)
```

Extend `_spec()` with `highlight_classifier: DraftHighlightClassifier | None = None` and forward that exact field. Existing specs therefore remain audit-only without edits.

- [ ] **Step 4: Implement only the approved draft classifiers**

In `planning.py`:

```python
def _classify_meal_plan_highlight(context: DraftHighlightContext) -> ActivityHighlight | None:
    operations = context.business_entity.get("operations")
    if isinstance(operations, list):
        eligible_count = sum(
            1
            for operation in operations
            if isinstance(operation, dict)
            and operation.get("action") in {"create", "update", "delete"}
        )
    else:
        items = context.business_entity.get("items")
        eligible_count = len(items) if isinstance(items, list) else 0
    if eligible_count == 0:
        return None
    return ActivityHighlight(
        kind=ActivityHighlightKind.MEAL_PLAN,
        summary=f"完成 {eligible_count} 项菜单安排",
    )


def _classify_meal_log_highlight(context: DraftHighlightContext) -> ActivityHighlight | None:
    action = str(context.submitted_payload.get("action") or "create")
    if action != "create" or not context.business_entity.get("id"):
        return None
    meal_type = str(context.business_entity.get("meal_type") or "")
    label = {"breakfast": "早餐", "lunch": "午餐", "dinner": "晚餐", "snack": "加餐"}.get(
        meal_type,
        "用餐",
    )
    return ActivityHighlight(
        kind=ActivityHighlightKind.MEAL,
        summary=f"记录了一次{label}",
    )
```

Register these functions only on `meal_plan` and `meal_log`. Leave `shopping_list` without a classifier.

In `recipes.py`:

```python
def _classify_recipe_cook_highlight(context: DraftHighlightContext) -> ActivityHighlight | None:
    cook_log = context.business_entity.get("cook_log")
    meal_log = context.business_entity.get("meal_log")
    if not isinstance(cook_log, dict) and not isinstance(meal_log, dict):
        return None
    title = str(context.submitted_payload.get("title") or "一道菜").strip()
    return ActivityHighlight(
        kind=ActivityHighlightKind.MEAL,
        summary=f"完成 {title} 并记录用餐",
    )
```

Register it only on `recipe_cook`. Leave ordinary `recipe` without a classifier.

- [ ] **Step 5: Implement composite candidate collection and strict reduction**

In the new `highlights.py`:

```python
from __future__ import annotations

from typing import Any

from app.core.enums import ActivityHighlightKind
from app.services.activity import ActivityHighlight
from app.services.ai_operations.registry_types import (
    DraftHighlightContext,
    DraftOperationRegistry,
)


def reduce_activity_highlights(
    candidates: list[ActivityHighlight],
) -> ActivityHighlight | None:
    if not candidates:
        return None
    kinds = {candidate.kind for candidate in candidates}
    if len(kinds) != 1:
        return None
    kind = candidates[0].kind
    if len(candidates) == 1:
        return candidates[0]
    noun = {
        ActivityHighlightKind.SHOPPING: "组采购入库",
        ActivityHighlightKind.INVENTORY: "组库存处理",
        ActivityHighlightKind.MEAL_PLAN: "组菜单安排",
        ActivityHighlightKind.MEAL: "项餐食记录",
        ActivityHighlightKind.FAMILY: "项家庭协作",
    }[kind]
    return ActivityHighlight(kind=kind, summary=f"完成 {len(candidates)} {noun}")


def _composite_candidates(
    registry: DraftOperationRegistry,
    *,
    submitted_payload: dict[str, Any],
    business_entity: dict[str, Any],
) -> list[ActivityHighlight]:
    from app.services.ai_operations.composite import COMPOSITE_DOMAIN_DRAFT_TYPES

    submitted_steps = {
        str(step.get("stepId")): step
        for step in submitted_payload.get("steps") or []
        if isinstance(step, dict)
    }
    candidates: list[ActivityHighlight] = []
    for result in business_entity.get("steps") or []:
        if not isinstance(result, dict):
            continue
        step = submitted_steps.get(str(result.get("stepId")))
        domain = str(result.get("domain") or "")
        draft_type = COMPOSITE_DOMAIN_DRAFT_TYPES.get(domain)
        if step is None or draft_type is None:
            continue
        candidate = registry.classify_highlight(
            DraftHighlightContext(
                draft_type=draft_type,
                submitted_payload=step.get("operation") or {},
                business_entity=result.get("payload") or {},
            )
        )
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def classify_approval_highlight(
    registry: DraftOperationRegistry,
    *,
    draft_type: str,
    submitted_payload: dict[str, Any],
    business_entity: dict[str, Any],
) -> ActivityHighlight | None:
    if draft_type == "composite_operation":
        return reduce_activity_highlights(
            _composite_candidates(
                registry,
                submitted_payload=submitted_payload,
                business_entity=business_entity,
            )
        )
    return registry.classify_highlight(
        DraftHighlightContext(
            draft_type=draft_type,
            submitted_payload=submitted_payload,
            business_entity=business_entity,
        )
    )
```

Do not add a fallback based on `domain` alone. The domain selects a draft spec; that spec still decides whether its actual outcome is eligible.

- [ ] **Step 6: Run classifier and existing registry/composite tests**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/ai_infra/test_registry_and_metrics.py tests/ai_infra/test_composite_operations.py -q)
```

Expected: all pass; shopping-list and unclassified inventory operations remain audit-only, same-kind composites reduce once, cross-kind composites return `None`.

- [ ] **Step 7: Commit the classifier layer**

```bash
git add backend/app/services/ai_operations/registry_types.py backend/app/services/ai_operations/draft_specs/common.py backend/app/services/ai_operations/draft_specs/planning.py backend/app/services/ai_operations/draft_specs/recipes.py backend/app/services/ai_operations/highlights.py backend/tests/ai_infra/test_registry_and_metrics.py backend/tests/ai_infra/test_composite_operations.py
git commit -m "feat: classify AI activity highlight outcomes"
```

### Task 6: Make AI Approval the Single Atomic Highlighter Owner

**Files:**

- Modify: `backend/app/services/ai_operations/approval_decisions.py`
- Modify: `backend/app/services/ai_operations/composite.py`
- Modify: `backend/tests/ai_infra/test_workspace_approvals.py`
- Modify: `backend/tests/ai_infra/test_composite_operations.py`

**Interfaces:**

- Consumes: Task 5 `classify_approval_highlight()`, Task 1 `log_activity()`, current `draft_operation_registry.after_success()` and `execute_ai_operation_draft()`.
- Produces: one nested success unit ordered as execute → transactional hook → classify/reduce → transaction-level `AIOperation` activity → flush; status transitions occur after that unit exits.

- [ ] **Step 1: Add failing success, audit-only, rejection and fault-injection tests**

`backend/tests/ai_infra/test_workspace_approvals.py` is a `unittest.TestCase` module, not a pytest-fixture module. Add methods inside the existing `AIWorkspaceApprovalsTestCase`; reuse its real `self.SessionLocal`, `self.family`, `self.user`, `self._create_ai_approval_for_test(...)` and `self._approve_ai_approval_for_test(...)` helpers. Do not introduce `WorkspaceContext`, `approve_fixture_draft`, `reject_fixture_draft` or any other implicit fixture.

First add this concrete payload helper at module scope:

```python
def _highlight_meal_plan_payload(*, suffix: str) -> dict[str, Any]:
    return {
        "draftType": "meal_plan",
        "schemaVersion": "meal_plan_operation.v1",
        "operations": [
            {
                "action": "create",
                "payload": {
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "reason": f"高亮原子性测试 {suffix}",
                },
            }
        ],
    }
```

Then add the success test in the existing class. Commit the service-level transaction before reopening a session, so the assertion covers durable rows rather than only the current identity map:

```python
def test_approved_meal_plan_writes_one_transaction_level_highlight(self) -> None:
    with self.SessionLocal() as db:
        service, draft, approval = self._create_ai_approval_for_test(
            db,
            draft_type="meal_plan",
            payload=_highlight_meal_plan_payload(suffix="success"),
            suffix="highlight-success",
        )
        result = self._approve_ai_approval_for_test(
            service,
            draft=draft,
            approval=approval,
        )
        self.assertEqual(result["operation"]["status"], "succeeded")
        db.commit()

    with self.SessionLocal() as db:
        rows = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.family_id == self.family.id,
                    ActivityLog.highlight_kind.is_not(None),
                )
            )
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].entity_type, "AIOperation")
        self.assertEqual(rows[0].highlight_kind, ActivityHighlightKind.MEAL_PLAN)
```

Add two explicit audit-only methods, again using the existing class helpers:

- approve a real `shopping_list` create payload (copy the valid payload from `test_ai_approval_business_writes_record_audit_fields_and_activity_logs`) and assert the business item exists but the count of `ActivityLog.highlight_kind IS NOT NULL` remains zero;
- create a `meal_plan` draft with `_highlight_meal_plan_payload(suffix="rejected")`, call `service._apply_approval_decision(...)` with `decision="rejected"`, `draft_version=draft.version` and `values={}`, commit, then assert there is no plan item for that unique reason and no highlighted row.

Add four explicit fault tests rather than a parameterized test with invented helper names:

1. Patch `app.services.ai_operations.approval_decisions.draft_operation_registry.after_success` to raise `RuntimeError("after_success fault")` while approving `_highlight_meal_plan_payload(suffix="after-success")`.
2. Patch `app.services.ai_operations.approval_decisions.classify_approval_highlight` to raise `RuntimeError("classifier fault")` for the same draft shape.
3. Attach a SQLAlchemy `before_flush` listener to the test `db` session; raise `RuntimeError("activity flush fault")` only when `db.new` contains an `ActivityLog` whose `entity_type == "AIOperation"`, and remove the listener in `finally`. This must not break setup or `AIOperation` creation flushes.
4. In `AICompositeOperationsTestCase`, patch `app.services.ai_operations.composite._execute_inventory_step` to raise after the preceding ingredient step has run, then approve the existing ingredient → inventory composite fixture.

For every fault, use the returned decision dict to assert `operation.status == "failed"` and `draft.status == "pending_retry"`, call `db.commit()`, reopen `self.SessionLocal()`, and assert both of the following without any generic counting helper:

- the known created business ID (meal-plan ID from `result["business_entity"]`, or the fixed composite ingredient name) cannot be loaded/found;
- `select(func.count(ActivityLog.id)).where(ActivityLog.highlight_kind.is_not(None))` returns zero.

These tests must use `unittest.mock.patch` and `self.assert*`; do not add pytest `monkeypatch` fixtures to the class module.

- [ ] **Step 2: Run the AI approval tests and observe non-atomic behavior**

Run:

```bash
(cd backend && .venv/bin/python -m pytest tests/ai_infra/test_workspace_approvals.py tests/ai_infra/test_composite_operations.py -k "highlight or fault or atomic" -q)
```

Expected: success tests find no highlighter; `after_success`/classifier tests show the current savepoint ends too early; composite ownership tests detect the inner savepoint.

- [ ] **Step 3: Move all required success work into one outer savepoint**

Refactor only the approved branch’s try block:

```python
try:
    with db.begin_nested():
        business_entity, entity_ids = execute_ai_operation_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            draft_type=draft.draft_type,
            payload=submitted_payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
        draft_operation_registry.after_success(
            DraftPostExecuteContext(
                db=db,
                draft_type=draft.draft_type,
                family_id=family_id,
                user_id=user_id,
                message_id=draft.message_id,
                business_entity=business_entity,
            )
        )
        highlight = classify_approval_highlight(
            draft_operation_registry,
            draft_type=draft.draft_type,
            submitted_payload=submitted_payload,
            business_entity=business_entity,
        )
        if highlight is not None:
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="AIOperation",
                entity_id=operation.id,
                summary="AI 审批业务操作执行成功",
                highlight=highlight,
            )
        db.flush()

    operation.status = "succeeded"
    operation.business_entity_ids = entity_ids
    operation.completed_at = utcnow()
    draft.status = "confirmed"
    draft.payload = submitted_payload
    draft.updated_by = user_id
    operation_summary = {"operationId": operation.id, "entityIds": entity_ids}
```

Keep the existing exception branch that marks operation failed and draft pending_retry after the savepoint rollback. The current `_refresh_inventory_operation_result_card` hook stays in `after_success` because it uses only this database session.

- [ ] **Step 4: Remove composite’s nested transaction ownership**

Change `execute_composite_operation_plan()` from an inner `with db.begin_nested()` to a plain ordered loop:

```python
ordered_steps = composite_execution_order(payload)
step_results: dict[str, dict[str, Any]] = {}
for step in ordered_steps:
    domain = str(step["domain"])
    if domain not in EXECUTABLE_COMPOSITE_DOMAINS:
        raise ValueError("复合操作执行器暂不支持该步骤领域")
    operation = resolve_composite_step_operation(step, step_results=step_results)
    normalize_before_execute = composite_operation_requires_deferred_normalization(
        step["operation"]
    )
    if execute_operation is None and domain == "ingredient":
        step_result = _execute_ingredient_step(
            db,
            family_id=family_id,
            user_id=user_id,
            step=step,
            operation=operation,
        )
    elif domain == "inventory":
        step_result = _execute_inventory_step(
            db,
            family_id=family_id,
            user_id=user_id,
            step=step,
            operation=operation,
            normalize_before_execute=normalize_before_execute,
        )
    elif execute_operation is None:
        raise ValueError("复合操作执行器需要统一领域 executor 后才能执行该步骤")
    else:
        draft_type = COMPOSITE_DOMAIN_DRAFT_TYPES[domain]
        business_entity, entity_ids = execute_operation(
            draft_type,
            operation,
            normalize_before_execute,
        )
        step_result = _step_result(
            step,
            domain=domain,
            business_entity=business_entity,
            entity_ids=entity_ids,
        )
    step_results[str(step["stepId"])] = step_result
```

Direct composite unit tests that need rollback must wrap the call in `with db.begin_nested():`, making transaction ownership explicit.

- [ ] **Step 5: Run AI infrastructure regression tests**

Run:

```bash
npm run backend:test:ai
```

Expected: all AI infra tests pass; same-kind composite produces one highlighter, cross-kind produces none, and every injected failure removes both business result and highlighter before marking the operation failed.

- [ ] **Step 6: Commit the approval transaction boundary**

```bash
git add backend/app/services/ai_operations/approval_decisions.py backend/app/services/ai_operations/composite.py backend/tests/ai_infra/test_workspace_approvals.py backend/tests/ai_infra/test_composite_operations.py
git commit -m "fix: make AI highlight approval atomic"
```

### Task 7: Add Frontend Highlight Contracts, Keys and Invalidation

**Files:**

- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/foodsApi.ts`
- Modify: `frontend/src/api/queryKeys.ts`
- Modify: `frontend/src/api/cacheInvalidation.ts`
- Modify: `frontend/src/api/foodsApi.test.ts`
- Modify: `frontend/src/api/queryKeys.test.ts`
- Modify: `frontend/src/api/cacheInvalidation.test.ts`

**Interfaces:**

- Consumes: Task 2 JSON response.
- Produces: `ActivityHighlightKind`, `ActivityHighlight`, `ActivityHighlightsResponse`; `api.getActivityHighlights(limit = 5)`; `queryKeys.activityHighlights` and `queryKeys.activityHighlightList(limit)`; prefix invalidation for eligible success helpers.

- [ ] **Step 1: Write failing API, key-separation and invalidation tests**

```typescript
it('requests the five-item activity highlight response', async () => {
  mockRequest.mockResolvedValueOnce({ items: [], week_highlight_count: 0 });
  await foodsApi.getActivityHighlights(5);
  expect(mockRequest).toHaveBeenCalledWith('/api/activity-highlights?limit=5');
});

it('keeps highlight limits and audit logs in separate caches', () => {
  expect(queryKeys.activityHighlights).toEqual(['activity-highlights']);
  expect(queryKeys.activityHighlightList(5)).toEqual(['activity-highlights', 'list', 5]);
  expect(queryKeys.activityHighlightList(3)).not.toEqual(queryKeys.activityHighlightList(5));
  expect(queryKeys.activityHighlightList(5)).not.toEqual(queryKeys.activityLogs);
});

it.each([
  invalidateAfterInventoryOperation,
  invalidateAfterFoodPlanChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterMealLogChanged,
  invalidateAfterQuickMealAdded,
])('invalidates the activity-highlight prefix for eligible outcomes', async (invalidate) => {
  const queryClient = fakeQueryClient();
  await invalidate(queryClient);
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.activityHighlights,
  });
});

it('does not add highlight invalidation to ordinary shopping-list changes', async () => {
  const queryClient = fakeQueryClient();
  await invalidateAfterShoppingChanged(queryClient);
  expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
    queryKey: queryKeys.activityHighlights,
  });
});
```

Also assert `invalidateAfterMemberChanged` and `invalidateAfterAiApprovalSettled` include the root key. The member helper may refresh redundantly for edits because it also owns invitation success; this does not change backend eligibility.

- [ ] **Step 2: Run focused frontend API tests**

Run:

```bash
npm --prefix frontend run test -- src/api/foodsApi.test.ts src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
```

Expected: type/import failures and missing invalidation calls.

- [ ] **Step 3: Add exact API types and client**

```typescript
export type ActivityHighlightKind =
  | 'shopping'
  | 'inventory'
  | 'meal_plan'
  | 'meal'
  | 'family';

export type ActivityHighlight = {
  id: string;
  kind: ActivityHighlightKind;
  summary: string;
  actor_id: string;
  actor_name: string;
  created_at: string;
};

export type ActivityHighlightsResponse = {
  items: ActivityHighlight[];
  week_highlight_count: number;
};
```

Add to `foodsApi`:

```typescript
getActivityHighlights: (limit = 5) =>
  request<ActivityHighlightsResponse>(
    `/api/activity-highlights?limit=${encodeURIComponent(String(limit))}`
  ),
```

- [ ] **Step 4: Add parameterized keys and centralized invalidation**

```typescript
activityHighlights: ['activity-highlights'] as const,
activityHighlightList: (limit = 5) =>
  ['activity-highlights', 'list', limit] as const,
```

Add `queryKeys.activityHighlights` to:

- `invalidateAfterInventoryOperation` and the inventory helper used by grouped expired disposal;
- `invalidateAfterFoodPlanChanged`;
- `invalidateAfterRecipeCooked`;
- `invalidateAfterMealLogChanged` and `invalidateAfterQuickMealAdded`;
- `invalidateAfterMemberChanged`;
- `invalidateAfterAiApprovalSettled`.

Do not add it to recipe favorite, ordinary shopping-list, profile or family-profile helpers.

- [ ] **Step 5: Run focused tests and TypeScript**

Run:

```bash
npm --prefix frontend run test -- src/api/foodsApi.test.ts src/api/queryKeys.test.ts src/api/cacheInvalidation.test.ts
npm --prefix frontend run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit the frontend data contract**

```bash
git add frontend/src/api/types.ts frontend/src/api/foodsApi.ts frontend/src/api/queryKeys.ts frontend/src/api/cacheInvalidation.ts frontend/src/api/foodsApi.test.ts frontend/src/api/queryKeys.test.ts frontend/src/api/cacheInvalidation.test.ts
git commit -m "feat: add frontend activity highlight contract"
```

### Task 8: Build Pure Home Recommendation, Action and Highlight Models

**Files:**

- Modify: `frontend/src/features/home/homeDashboardModel.ts`
- Modify: `frontend/src/features/home/homeDashboardModel.test.ts`
- Modify: `frontend/src/features/home/useHomeDashboardState.ts`
- Modify: `frontend/src/features/home/useHomeDashboardState.test.tsx`

**Interfaces:**

- Consumes: Task 7 `ActivityHighlightsResponse`; PR 72 `homeEligibleInventoryActionGroups` and `InventoryActionGroup`; recommendation items; existing seven-day plan data.
- Produces: `selectCircularWindow<T>(items, cursor, pageSize)`; independent `desktopRecommendationCursor` and `mobileRecommendationCursor`; `HomeRequiredAction`; `buildHomeRequiredActions()`; `HomeHighlightsViewModel`; fixed kind icon/fallback actor helpers.

- [ ] **Step 1: Write the failing circular-window matrix**

```typescript
describe.each([
  { size: 0, pageSize: 3, cursor: 0, expected: [] },
  { size: 1, pageSize: 3, cursor: 0, expected: [0] },
  { size: 2, pageSize: 3, cursor: 0, expected: [0, 1] },
  { size: 4, pageSize: 3, cursor: 3, expected: [3, 0, 1] },
  { size: 5, pageSize: 3, cursor: 3, expected: [3, 4, 0] },
  { size: 6, pageSize: 3, cursor: 3, expected: [3, 4, 5] },
])('circular recommendations: $size items', ({ size, pageSize, cursor, expected }) => {
  it('returns only real items and never repeats inside a full window', () => {
    const items = Array.from({ length: size }, (_, id) => ({ id }));
    const result = selectCircularWindow(items, cursor, pageSize);
    expect(result.map((item) => item.id)).toEqual(expected);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });
});

it('advances desktop and mobile cursors independently', () => {
  let state = renderHarness([], undefined, 6);
  act(() => state!.showNextDesktopRecommendations());
  state = latest!;
  expect(state.desktopRecommendationCursor).toBe(3);
  expect(state.mobileRecommendationCursor).toBe(0);
  act(() => state.showNextMobileRecommendation());
  state = latest!;
  expect(state.desktopRecommendationCursor).toBe(3);
  expect(state.mobileRecommendationCursor).toBe(1);
});
```

Use the test file's existing React `createRoot` harness. Extend its `Harness` props with `recommendationCount: number`, forward that value to `useHomeDashboardState`, and change the existing helper signature to:

```typescript
function renderHarness(
  groups: InventoryActionGroup[],
  businessDateKey?: string,
  recommendationCount = 0
) {
  act(() => {
    root?.render(
      <Harness
        groups={groups}
        businessDateKey={businessDateKey}
        recommendationCount={recommendationCount}
        onState={(state) => { latest = state; }}
      />
    );
  });
  return latest;
}
```

Do not import `renderHook`; `@testing-library/react` is not a dependency of this repository.

- [ ] **Step 2: Write the failing required-action and remote-state tests**

```typescript
it('merges urgent expiry, one shopping action, then low stock before one truncation', () => {
  const result = buildHomeRequiredActions({
    inventoryGroups: [expiredTomato, expiringMilk, lowStockEggs, lowStockRice],
    pendingShoppingCount: 5,
  });
  expect(result.actions).toEqual([
    { kind: 'inventory', group: expiredTomato },
    { kind: 'inventory', group: expiringMilk },
    { kind: 'shopping', pendingCount: 5 },
  ]);
  expect(result.hasMoreHomeActions).toBe(true);
});

it('does not create a shopping action when pending count is zero', () => {
  const result = buildHomeRequiredActions({
    inventoryGroups: [expiredTomato, lowStockEggs],
    pendingShoppingCount: 0,
  });
  expect(result.actions.map((item) => item.kind)).toEqual(['inventory', 'inventory']);
});

it('distinguishes success zero, no-cache failure and stale refresh failure', () => {
  expect(buildHomeHighlightsViewModel({
    data: { items: [], week_highlight_count: 0 },
    isLoading: false,
    isError: false,
    isFetching: false,
  })).toMatchObject({ phase: 'empty', weekCountLabel: '本周协作 0 次' });

  expect(buildHomeHighlightsViewModel({
    data: undefined,
    isLoading: false,
    isError: true,
    isFetching: false,
  })).toMatchObject({ phase: 'error', weekCountLabel: '本周协作 --' });

  expect(buildHomeHighlightsViewModel({
    data: { items: [shoppingHighlight], week_highlight_count: 7 },
    isLoading: false,
    isError: true,
    isFetching: false,
  })).toMatchObject({
    phase: 'ready',
    hasRefreshError: true,
    weekCountLabel: '本周协作 7 次',
  });
});
```

Also test `resolveHomeHighlightActor("") === "家庭成员"`, every known kind mapping, unknown kind fallback, and exactly seven compact calendar days.

- [ ] **Step 3: Run focused model/state tests**

Run:

```bash
npm --prefix frontend run test -- src/features/home/homeDashboardModel.test.ts src/features/home/useHomeDashboardState.test.tsx
```

Expected: missing exports and the existing fixed-three normal slice/one shared page state fail the new matrix.

- [ ] **Step 4: Implement the circular window and independent cursors**

```typescript
export function selectCircularWindow<T>(
  items: readonly T[],
  cursor: number,
  pageSize: number
): T[] {
  if (items.length === 0 || pageSize <= 0) return [];
  const count = Math.min(items.length, pageSize);
  const normalizedCursor = ((cursor % items.length) + items.length) % items.length;
  return Array.from(
    { length: count },
    (_, index) => items[(normalizedCursor + index) % items.length]
  );
}

export function advanceRecommendationCursor(
  cursor: number,
  sourceLength: number,
  step: number
) {
  return sourceLength === 0 ? 0 : (cursor + step) % sourceLength;
}
```

In the hook:

```typescript
const [desktopRecommendationCursor, setDesktopRecommendationCursor] = useState(0);
const [mobileRecommendationCursor, setMobileRecommendationCursor] = useState(0);

function showNextDesktopRecommendations() {
  setDesktopRecommendationCursor((current) =>
    advanceRecommendationCursor(current, input.recommendationCount, 3)
  );
}

function showNextMobileRecommendation() {
  setMobileRecommendationCursor((current) =>
    advanceRecommendationCursor(current, input.recommendationCount, 1)
  );
}
```

Extend `buildHomeDashboardViewModel` input/output with the two cursors and windows:

```typescript
const desktopRecommendations = selectCircularWindow(
  dashboardRecommendationItems,
  input.desktopRecommendationCursor,
  3
);
const mobileRecommendations = selectCircularWindow(
  dashboardRecommendationItems,
  input.mobileRecommendationCursor,
  1
);

return {
  // existing dashboard values
  dashboardRecommendationItems,
  desktopRecommendations,
  mobileRecommendations,
  canChangeDesktopRecommendations: dashboardRecommendationItems.length > 3,
  canChangeMobileRecommendation: dashboardRecommendationItems.length > 1,
};
```

Keep the old `dashboardRecommendationPage` fields only as a compile-safe compatibility adapter in Task 8; Task 10 migrates desktop, Task 11 migrates mobile and removes the adapter. Reset both new cursors to zero when the ordered recommendation ID signature changes. Do not derive mobile output by slicing the desktop window.

- [ ] **Step 5: Implement the required-action union and one-pass truncation**

```typescript
export type HomeRequiredAction =
  | { kind: 'inventory'; group: InventoryActionGroup }
  | { kind: 'shopping'; pendingCount: number };

export function buildHomeRequiredActions(input: {
  inventoryGroups: InventoryActionGroup[];
  pendingShoppingCount: number;
}): {
  actions: HomeRequiredAction[];
  hasMoreHomeActions: boolean;
} {
  const urgent = input.inventoryGroups
    .filter((group) => group.kind === 'expiry')
    .map((group) => ({ kind: 'inventory' as const, group }));
  const shopping = input.pendingShoppingCount > 0
    ? [{ kind: 'shopping' as const, pendingCount: input.pendingShoppingCount }]
    : [];
  const lowStock = input.inventoryGroups
    .filter((group) => group.kind === 'low_stock')
    .map((group) => ({ kind: 'inventory' as const, group }));
  const candidates = [...urgent, ...shopping, ...lowStock];
  return {
    actions: candidates.slice(0, 3),
    hasMoreHomeActions: candidates.length > 3,
  };
}
```

Call this with `homeEligibleInventoryActionGroups`, never `homeInventoryActionGroups`. Components receive final `actions` and do not sort or slice again.

- [ ] **Step 6: Implement highlight state, icon and actor normalization**

```typescript
export type HomeHighlightsViewModel = {
  items: ActivityHighlight[];
  phase: 'loading' | 'empty' | 'ready' | 'error';
  hasRefreshError: boolean;
  isRefreshing: boolean;
  weekCountLabel: string;
};

export function buildHomeHighlightsViewModel(input: {
  data?: ActivityHighlightsResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}): HomeHighlightsViewModel {
  if (input.data) {
    return {
      items: input.data.items,
      phase: input.data.items.length === 0 ? 'empty' : 'ready',
      hasRefreshError: input.isError,
      isRefreshing: input.isFetching,
      weekCountLabel: `本周协作 ${input.data.week_highlight_count} 次`,
    };
  }
  return {
    items: [],
    phase: input.isError ? 'error' : 'loading',
    hasRefreshError: false,
    isRefreshing: input.isFetching,
    weekCountLabel: '本周协作 --',
  };
}

export function resolveHomeHighlightActor(actorName: string | null | undefined) {
  return actorName?.trim() || '家庭成员';
}

const HOME_HIGHLIGHT_ICONS: Record<string, DashboardIconName> = {
  shopping: 'cart',
  inventory: 'leaf',
  meal_plan: 'calendar',
  meal: 'pot',
  family: 'family',
};

export function homeHighlightIcon(kind: string): DashboardIconName {
  return HOME_HIGHLIGHT_ICONS[kind] ?? 'family';
}
```

These five literals already exist in `DashboardIconName`; keep the semantic table in the test.

- [ ] **Step 7: Run model/state tests and typecheck**

Run:

```bash
npm --prefix frontend run test -- src/features/home/homeDashboardModel.test.ts src/features/home/useHomeDashboardState.test.tsx
npm --prefix frontend run typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit the pure home models**

```bash
git add frontend/src/features/home/homeDashboardModel.ts frontend/src/features/home/homeDashboardModel.test.ts frontend/src/features/home/useHomeDashboardState.ts frontend/src/features/home/useHomeDashboardState.test.tsx
git commit -m "feat: model home recommendations actions and highlights"
```

### Task 9: Query Highlights and Feed the Home View Model

**Files:**

- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Create: `frontend/src/app/useAppWorkspaceQueries.test.tsx`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.test.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**

- Consumes: Task 7 client/key and Task 8 `buildHomeHighlightsViewModel()`.
- Produces: `activityHighlightsQuery` enabled only for Home, excluded from boot loading; `homeHighlightsViewModel` and Hero `sidebarActivityLabel` based on server `week_highlight_count`; wired desktop/mobile recommendation windows; `homeRequiredActions`/`hasMoreHomeActions`; explicit `retryHomeHighlights()`.

- [ ] **Step 1: Write failing query-enable and Hero-state tests**

Create `useAppWorkspaceQueries.test.tsx` with the same project-native `createRoot` pattern used by `useHomeDashboardState.test.tsx`; do not add Testing Library. Define this harness in that new file before the tests:

```tsx
type WorkspaceQueries = ReturnType<typeof useAppWorkspaceQueries>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: WorkspaceQueries | null = null;

function WorkspaceQueriesHarness(props: {
  activeTab: TabKey;
  onState: (state: WorkspaceQueries) => void;
}) {
  const state = useAppWorkspaceQueries({
    activeTab: props.activeTab,
    isAuthenticated: true,
    foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
  });
  useEffect(() => props.onState(state));
  return null;
}

function renderWorkspaceQueries(activeTab: TabKey) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <WorkspaceQueriesHarness
          activeTab={activeTab}
          onState={(state) => { latest = state; }}
        />
      </QueryClientProvider>
    );
  });
  return {
    client,
    current: () => {
      if (!latest) throw new Error('workspace query harness not ready');
      return latest;
    },
  };
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}
```

In `beforeEach`, stub every Home boot query with resolved project-shaped empty data (`getFamily`, `getMembers`, `getIngredients`, `getInventory`, `getShoppingList`, `getRecipes`, `getFoodPlan`, `getFoods`, `getFoodRecommendations`, `getMealLogs` and the temporary `getActivityLogs`). In `afterEach`, unmount/remove the root and call `vi.restoreAllMocks()`. The highlight spy is configured per test.

Then add:

```typescript
it('enables five highlights on home without adding them to boot loading', async () => {
  const highlights = vi
    .spyOn(api, 'getActivityHighlights')
    .mockImplementation(() => new Promise<ActivityHighlightsResponse>(() => undefined));
  const harness = renderWorkspaceQueries('home');
  await flushQueries();
  expect(highlights).toHaveBeenCalledWith(5);
  expect(harness.current().activityHighlightsQuery.isLoading).toBe(true);
  expect(harness.current().isBootLoading).toBe(false);
});

it('does not request highlights outside home', async () => {
  const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
    items: [],
    week_highlight_count: 0,
  });
  renderWorkspaceQueries('family');
  await flushQueries();
  expect(highlights).not.toHaveBeenCalled();
});

it('uses the server week count and never converts no-cache errors to zero', () => {
  const success = useAppHomeViewModel(buildHomeArgs({
    activityHighlights: {
      data: { items: [], week_highlight_count: 0 },
      isLoading: false,
      isError: false,
      isFetching: false,
    },
  }));
  const failure = useAppHomeViewModel(buildHomeArgs({
    activityHighlights: {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
    },
  }));
  expect(success.sidebarActivityLabel).toBe('本周协作 0 次');
  expect(failure.sidebarActivityLabel).toBe('本周协作 --');
});
```

In `useAppHomeViewModel.test.ts`, define `type HomeArgs = Parameters<typeof useAppHomeViewModel>[0]` and extract the file's existing complete argument literal into `buildHomeArgs(overrides: Partial<HomeArgs> = {}): HomeArgs`; append the new `activityHighlights` default and finish with `...overrides`. This is a mechanical extraction of the existing test fixture, not a new guessed fixture. Add the stale-data case using that same helper.

Add a stale-data test: data count 7 plus `isError=true` must keep `本周协作 7 次` and mark `hasRefreshError=true`.

- [ ] **Step 2: Run focused tests and verify query/model support is absent**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppWorkspaceQueries.test.tsx src/app/useAppHomeViewModel.test.ts
```

Expected: missing `activityHighlightsQuery`/args and the old Hero count still derives from raw activity logs.

- [ ] **Step 3: Add the non-polling Home query**

```typescript
const needsActivityHighlights = args.activeTab === 'home';
const activityHighlightsQuery = useQuery({
  queryKey: queryKeys.activityHighlightList(5),
  queryFn: () => api.getActivityHighlights(5),
  enabled: args.isAuthenticated && needsActivityHighlights,
});
```

Return the full query object. Do not add it to `isBootLoading` and do not set `refetchInterval`. At this task boundary the legacy activity logs query may still be enabled for Home until its last UI consumer is removed in Task 12.

- [ ] **Step 4: Feed normalized query state into the Home view model**

Use a serializable input rather than passing the full React Query object through model code:

```typescript
type HomeActivityHighlightsInput = {
  data?: ActivityHighlightsResponse;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
};

const homeHighlightsViewModel = buildHomeHighlightsViewModel(args.activityHighlights);
const sidebarActivityLabel = homeHighlightsViewModel.weekCountLabel;
const {
  actions: homeRequiredActions,
  hasMoreHomeActions,
} = buildHomeRequiredActions({
  inventoryGroups: dashboardViewModel.homeEligibleInventoryActionGroups,
  pendingShoppingCount: dashboardViewModel.pendingShoppingCount,
});
```

Keep Family’s current full-audit statistics temporarily based on `activityLogs`; Task 12 moves those consumers to a Family-specific view model before removing Home’s full-log query.

- [ ] **Step 5: Wire App with an explicit retry callback**

```typescript
const {
  activityHighlightsQuery,
  activityLogsQuery,
  // existing queries and data
} = useAppWorkspaceQueries({ activeTab, isAuthenticated, foodPlanWeekRange });

const homeViewModel = useAppHomeViewModel({
  // existing inputs
  activityHighlights: {
    data: activityHighlightsQuery.data,
    isLoading: activityHighlightsQuery.isLoading,
    isError: activityHighlightsQuery.isError,
    isFetching: activityHighlightsQuery.isFetching,
  },
  desktopRecommendationCursor,
  mobileRecommendationCursor,
});

function retryHomeHighlights() {
  void activityHighlightsQuery.refetch();
}
```

Expose `homeHighlightsViewModel` and `retryHomeHighlights` to the Home props used in Task 10; until then it is valid for App to destructure them without changing the current markup.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppWorkspaceQueries.test.tsx src/app/useAppHomeViewModel.test.ts
npm --prefix frontend run typecheck
```

Expected: all pass; an unresolved highlights request does not trigger the app-wide loading screen.

- [ ] **Step 7: Commit the Home query feed**

```bash
git add frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppWorkspaceQueries.test.tsx frontend/src/app/useAppHomeViewModel.ts frontend/src/app/useAppHomeViewModel.test.ts frontend/src/App.tsx
git commit -m "feat: feed activity highlights into home"
```

### Task 10: Build the Desktop Three-Question Home

**Files:**

- Create: `frontend/src/features/home/HomeRequiredActions.tsx`
- Create: `frontend/src/features/home/HomeHighlightTimeline.tsx`
- Create: `frontend/src/features/home/HomeCompactCalendar.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/01-home-dashboard.css`

**Interfaces:**

- Consumes: Task 8 final `HomeRequiredAction[]`, desktop recommendation window, seven compact days and `HomeHighlightsViewModel`; existing action/dialog openers.
- Produces: shared presentation components with no sorting/paging logic; desktop Question 1 full-width; Question 2/3 `56% / 44%` grid; callback `onOpenFamilyActivity()`; callback `onOpenFullWeek(planDate)`.

- [ ] **Step 1: Write failing shared-component and desktop structure tests**

Keep the file's existing `buildProps`, `renderDashboard`, `desktopSurface`, `root` and `container` helpers. Add typed fixture builders named `makeRecommendation(index)`, `makePlanDay(index)` and `makeHighlight(index)` that return, respectively, `HomeDashboardProps['desktopRecommendations'][number]`, `HomeDashboardProps['compactPlanDays'][number]` and `HomeDashboardProps['homeHighlights']['items'][number]`. Populate every required field from those indexed types; use empty images/meal items, fixed `2026-07-06 + index` dates and unique IDs. Also add this project-native button helper:

```typescript
function buttonByText(view: ParentNode, label: string) {
  const button = Array.from(view.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return button as HTMLButtonElement;
}
```

Use raw DOM assertions, consistent with the existing file:

```typescript
it('renders desktop recommendations, compact week and the two-column lower questions', () => {
  const view = renderDashboard({
    desktopRecommendations: [0, 1, 2].map(makeRecommendation),
    compactPlanDays: Array.from({ length: 7 }, (_, index) => makePlanDay(index)),
    requiredActions: [
      { kind: 'inventory', group: tomato },
      { kind: 'shopping', pendingCount: 5 },
    ],
    homeHighlights: {
      items: Array.from({ length: 5 }, (_, index) => makeHighlight(index)),
      phase: 'ready',
      hasRefreshError: false,
      isRefreshing: false,
      weekCountLabel: '本周协作 5 次',
    },
  });
  const desktop = desktopSurface(view);
  expect(desktop.textContent).toContain('今天吃什么');
  expect(desktop.querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(3);
  expect(desktop.querySelectorAll('[aria-label="七天菜单"] button[aria-label^="选择 "]')).toHaveLength(7);
  expect(desktop.textContent).toContain('今天必须处理什么');
  expect(desktop.textContent).toContain('5 项待采购');
  expect(desktop.textContent).toContain('家里发生了什么');
  expect(desktop.querySelectorAll('[data-testid="home-highlight-row"]')).toHaveLength(5);
  expect(desktop.querySelector('[data-testid="home-lower-grid"]')?.classList.contains('home-dashboard-lower-grid')).toBe(true);
});

it('renders local loading/error/stale states without hiding the other two questions', () => {
  const retry = vi.fn();
  const view = renderDashboard({
    homeHighlights: { items: [], phase: 'loading', hasRefreshError: false, isRefreshing: true, weekCountLabel: '本周协作 --' },
    onRetryHighlights: retry,
  });
  expect(view.querySelector('[aria-label="家庭动态加载中"]')).not.toBeNull();
  expect(view.textContent).toContain('今天吃什么');
  expect(view.textContent).toContain('今天必须处理什么');

  act(() => root?.render(<HomeDashboard {...buildProps({
      homeHighlights: { items: [], phase: 'error', hasRefreshError: false, isRefreshing: false, weekCountLabel: '本周协作 --' },
      onRetryHighlights: retry,
    })} />));
  act(() => buttonByText(view, '重试家庭动态').click());
  expect(retry).toHaveBeenCalledTimes(1);
});

it('does not own a second activity modal', () => {
  const onOpenFamilyActivity = vi.fn();
  const view = renderDashboard({ onOpenFamilyActivity });
  act(() => buttonByText(view, '查看完整记录').click());
  expect(onOpenFamilyActivity).toHaveBeenCalledTimes(1);
  expect(view.querySelector('[aria-label="家庭活动弹窗"]')).toBeNull();
});
```

Do not import `screen`, `userEvent`, `waitFor` or `@testing-library/*`; those packages are not present in `frontend/package.json`.

Also assert the button text is “换一批”, it is disabled at `N <= 3` and enabled at `N > 3`, `N=1/2` renders only one/two real cards, actions are already capped at 3, and highlights never render meal/food images.

- [ ] **Step 2: Run the desktop tests and verify the old dashboard shape fails**

Run:

```bash
npm --prefix frontend run test -- src/features/home/HomeDashboard.test.tsx
```

Expected: missing shared components/test IDs, current desktop sections are not the three-question hierarchy, and Home still owns `isActivityViewerOpen`.

- [ ] **Step 3: Implement required-action presentation without business reordering**

```tsx
function HomeInventoryActionRow(props: {
  group: InventoryActionGroup;
  onOpen: () => void;
}) {
  return (
    <article className={`home-action-row tone-${getHomeActionTone(props.group)}`}>
      <div>
        <strong>{props.group.title}</strong>
        <p>{props.group.detail}</p>
      </div>
      <button type="button" onClick={props.onOpen}>
        {getHomeActionPrimaryLabel(props.group)}
      </button>
    </article>
  );
}

export function HomeRequiredActions(props: {
  actions: HomeRequiredAction[];
  hasMore: boolean;
  onOpenInventory: (group: InventoryActionGroup) => void;
  onOpenShoppingIntake: () => void;
  onOpenReconciliation: () => void;
  onViewAll: () => void;
}) {
  return (
    <section className="home-question-panel home-required-actions" aria-labelledby="home-required-title">
      <header className="home-question-head">
        <div>
          <span>问题 2</span>
          <h2 id="home-required-title">今天必须处理什么</h2>
        </div>
        <button type="button" onClick={props.onOpenReconciliation}>建议再确认</button>
      </header>
      {props.actions.length > 0 ? (
        <div className="home-action-list">
          {props.actions.map((action) =>
            action.kind === 'shopping' ? (
              <article key="shopping" className="home-action-row">
                <div><strong>{action.pendingCount} 项待采购</strong><p>登记本次购买</p></div>
                <button type="button" onClick={props.onOpenShoppingIntake}>去登记</button>
              </article>
            ) : (
              <HomeInventoryActionRow
                key={action.group.id}
                group={action.group}
                onOpen={() => props.onOpenInventory(action.group)}
              />
            )
          )}
        </div>
      ) : (
        <StateBlock status="empty" title="今天没有必须处理的事项" description="库存和采购清单都在可控范围内。" />
      )}
      {props.hasMore && <button type="button" onClick={props.onViewAll}>查看全部</button>}
    </section>
  );
}
```

Move the existing `getHomeActionPrimaryLabel()` and `getHomeActionTone()` presentation helpers from `HomeDashboard.tsx` into this file. Do not duplicate inventory priority logic.

- [ ] **Step 4: Implement the fixed-kind highlight timeline and remote states**

```tsx
function HomeHighlightSkeleton() {
  return (
    <div className="home-highlight-skeleton" aria-label="家庭动态加载中">
      {[0, 1, 2].map((index) => (
        <span key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

export function HomeHighlightTimeline(props: {
  viewModel: HomeHighlightsViewModel;
  limit: number;
  onRetry: () => void;
  onViewAll: () => void;
}) {
  const items = props.viewModel.items.slice(0, props.limit);
  return (
    <section className="home-question-panel home-highlight-panel" aria-labelledby="home-highlight-title">
      <header className="home-question-head">
        <div><span>问题 3</span><h2 id="home-highlight-title">家里发生了什么</h2></div>
        <button type="button" onClick={props.onViewAll}>查看完整记录</button>
      </header>
      {props.viewModel.phase === 'loading' && <HomeHighlightSkeleton />}
      {props.viewModel.phase === 'error' && (
        <StateBlock
          status="error"
          title="家庭动态暂时加载失败"
          description="稍后重试；其他首页功能仍可使用。"
          actionLabel="重试家庭动态"
          onAction={props.onRetry}
        />
      )}
      {props.viewModel.phase === 'empty' && (
        <StateBlock status="empty" title="还没有家庭高亮" description="新的采购、盘点、菜单和餐食结果会出现在这里。" />
      )}
      {items.length > 0 && (
        <div className="home-highlight-list">
          {items.map((item) => (
            <article key={item.id} className="home-highlight-row" data-testid="home-highlight-row">
              <DashboardIcon name={homeHighlightIcon(item.kind)} />
              <div><strong>{resolveHomeHighlightActor(item.actor_name)}</strong><p>{item.summary}</p></div>
              <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
            </article>
          ))}
        </div>
      )}
      {props.viewModel.hasRefreshError && items.length > 0 && (
        <button className="home-highlight-refresh-warning" type="button" onClick={props.onRetry}>
          刷新失败，重试
        </button>
      )}
    </section>
  );
}
```

Do not import meal photos or index into unrelated arrays.

- [ ] **Step 5: Implement the shared seven-day compact calendar**

```tsx
export function HomeCompactCalendar(props: {
  days: DashboardPlanDay[];
  selectedDate: string;
  selectedSummary: string;
  onSelectDate: (date: string) => void;
  onPreviousWeek: () => void;
  onCurrentWeek: () => void;
  onNextWeek: () => void;
  onOpenFullWeek: (planDate: string) => void;
  mobile?: boolean;
}) {
  return (
    <section className="home-compact-calendar" aria-label="七天菜单">
      <header>
        <h3>这周怎么吃</h3>
        <div className="home-compact-week-controls">
          <button type="button" aria-label="上一周" onClick={props.onPreviousWeek}><DashboardIcon name="chevron" /></button>
          <button type="button" onClick={props.onCurrentWeek}>回到本周</button>
          <button type="button" aria-label="下一周" onClick={props.onNextWeek}><DashboardIcon name="chevron" /></button>
        </div>
      </header>
      <div className={props.mobile ? 'home-compact-days is-mobile-scroll' : 'home-compact-days'}>
        {props.days.map((day) => (
          <button
            key={day.date}
            type="button"
            aria-label={`选择 ${day.date}`}
            aria-pressed={day.date === props.selectedDate}
            className={[
              day.date === props.selectedDate ? 'is-selected' : '',
              day.isToday ? 'is-today' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => props.onSelectDate(day.date)}
          >
            <span>{day.weekday}</span><strong>{day.dayLabel}</strong>
            <i aria-label={`${day.totalCount} 项菜单`}>{day.totalCount}</i>
          </button>
        ))}
      </div>
      <div className="home-compact-day-summary">
        <p>{props.selectedSummary}</p>
        <button type="button" onClick={() => props.onOpenFullWeek(props.selectedDate)}>
          查看完整周菜单
        </button>
      </div>
    </section>
  );
}
```

`DashboardPlanDay` already supplies `dayLabel`, `totalCount` and `isToday`; the component must use those exact fields and perform no plan aggregation.

- [ ] **Step 6: Recompose the desktop page and remove its activity modal state**

The desktop order must be:

```tsx
<HomeDesktopHeader />
<HomeStats items={dashboardStats} />
<section className="home-question-one">
  <HomeQuestionHeading index={1} title="今天吃什么" />
  <HomeRecommendationGrid items={desktopRecommendations} />
  <HomeCompactCalendar {...calendarProps} />
</section>
<div className="home-dashboard-lower-grid" data-testid="home-lower-grid">
  <HomeRequiredActions {...requiredActionProps} />
  <HomeHighlightTimeline viewModel={homeHighlights} limit={5} {...highlightActions} />
</div>
```

Delete `isActivityViewerOpen`, the Home-owned `FamilyActivityModal` import/render and the `activityLogs` prop. The button calls `onOpenFamilyActivity`.

Wire “建议再确认” to `onOpenReconciliation?.({ scope: 'suggested' })` and “登记本次购买” to PR 73’s shared shopping-intake opener. Neither action may request reconciliation detail until the corresponding overlay opens.

- [ ] **Step 7: Add scoped desktop layout and focus styles**

```css
.home-dashboard-lower-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.27fr) minmax(0, 1fr);
  gap: 16px;
}

.home-dashboard-lower-grid > *,
.home-question-panel,
.home-action-row,
.home-highlight-row {
  min-width: 0;
}

.home-action-list,
.home-highlight-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}

.home-compact-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}

.home-compact-days > button,
.home-compact-week-controls button {
  min-height: 44px;
}

.home-question-panel :focus-visible,
.home-compact-calendar :focus-visible {
  outline: 3px solid rgba(210, 107, 51, 0.24);
  outline-offset: 2px;
}
```

Use existing `--surface-2`, `--surface-3`, `--line-soft`, `--text`, `--text-soft`, `--accent` and existing radius/shadow variables for the remaining declarations. Do not introduce blue dashboard colors, marketing gradients or a new shadow scale.

- [ ] **Step 8: Run desktop tests, style-token check and build**

Run:

```bash
npm --prefix frontend run test -- src/features/home/HomeDashboard.test.tsx src/features/home/homeDashboardModel.test.ts
npm --prefix frontend run check:style-tokens
npm --prefix frontend run build
```

Expected: all pass.

- [ ] **Step 9: Commit the desktop three-question page**

```bash
git add frontend/src/features/home/HomeRequiredActions.tsx frontend/src/features/home/HomeHighlightTimeline.tsx frontend/src/features/home/HomeCompactCalendar.tsx frontend/src/features/home/HomeDashboard.tsx frontend/src/features/home/HomeDashboard.test.tsx frontend/src/App.tsx frontend/src/styles/01-home-dashboard.css
git commit -m "feat: focus desktop home on three questions"
```

### Task 11: Preserve the Mobile Hero and Build the Single-Column Home

**Files:**

- Modify: `frontend/src/features/home/HomeMobileDashboard.tsx`
- Modify: `frontend/src/features/home/HomeMobileDashboard.test.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/styles/07-mobile.css`

**Interfaces:**

- Consumes: Task 10 shared components; Task 8 mobile one-item window and independent next callback.
- Produces: original mobile top structure unchanged; one full recommendation; horizontal seven-day compact calendar; vertically stacked Question 2/3; maximum three highlights.

- [ ] **Step 1: Write failing mobile preservation and density tests**

Keep the file's existing `buildProps`, `renderMobile`, `root` and `container`. Add the same fully typed `makeRecommendation`, `makePlanDay`, `makeHighlight` and `buttonByText` builders described in Task 10, but type them through `HomeMobileDashboardProps` so this file has no cross-test dependency.

```typescript
it('keeps the original mobile top structure and stats', () => {
  const view = renderMobile();
  expect(view.textContent).toContain('Culina');
  expect(view.querySelector('button[aria-label="全局搜索"]')).not.toBeNull();
  expect(view.querySelector('button[aria-label="查看提醒"]')).not.toBeNull();
  expect(view.querySelector<HTMLImageElement>('.mobile-dashboard-kitchen img')?.getAttribute('src')).toBe('/assets/kitchen_transparent.webp');
  expect(view.textContent).toContain('测试家庭');
  expect(view.querySelector('[aria-label="家庭信息"]')).not.toBeNull();
  expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent?.includes('新增食材'))).toBe(true);
  expect(Array.from(view.querySelectorAll('button')).some((button) => button.textContent?.includes('查看记录'))).toBe(true);
  expect(view.querySelectorAll('[data-testid="mobile-home-stat"]')).toHaveLength(4);
});

it('renders one full recommendation and advances by one', () => {
  const onNext = vi.fn();
  const view = renderMobile({
    mobileRecommendations: [makeRecommendation(1)],
    recommendationCount: 5,
    onNextMobileRecommendation: onNext,
  });
  expect(view.querySelectorAll('[data-testid="home-recommendation-card"]')).toHaveLength(1);
  expect(view.querySelector('[data-testid="mobile-recommendation-scroller"]')).toBeNull();
  act(() => buttonByText(view, '换一个').click());
  expect(onNext).toHaveBeenCalledTimes(1);
});

it('stacks action and highlight questions and limits highlights to three', () => {
  const view = renderMobile({
    homeHighlights: {
      items: Array.from({ length: 5 }, (_, index) => makeHighlight(index)),
      phase: 'ready',
      hasRefreshError: false,
      isRefreshing: false,
      weekCountLabel: '本周协作 5 次',
    },
  });
  const questions = Array.from(view.querySelectorAll('[data-testid="mobile-home-question"]'));
  expect(questions.map((node) => node.getAttribute('data-question'))).toEqual(['1', '2', '3']);
  expect(view.querySelectorAll('[data-testid="home-highlight-row"]')).toHaveLength(3);
});

it('renders seven fixed-width calendar buttons in a dedicated scroller', () => {
  const view = renderMobile({
    compactPlanDays: Array.from({ length: 7 }, (_, index) => makePlanDay(index)),
  });
  const scroller = view.querySelector('[data-testid="mobile-home-calendar-scroll"]');
  expect(scroller?.classList.contains('is-mobile-scroll')).toBe(true);
  expect(scroller?.querySelectorAll('button[aria-label^="选择 "]')).toHaveLength(7);
});
```

Add assertions that `换一个` is disabled only when `N <= 1`, the top label uses `本周协作 --` for no-cache failure, and Q2 shows `5 项待采购` rather than `5 项采购可入库`.

Do not import `screen`, `within`, `userEvent` or any `@testing-library/*` package.

- [ ] **Step 2: Run the mobile tests and verify the current three-card scroller fails**

Run:

```bash
npm --prefix frontend run test -- src/features/home/HomeMobileDashboard.test.tsx
```

Expected: old `mobile-dashboard-food-scroller` renders up to three cards, button uses desktop threshold/step, and full week UI is not the shared compact calendar.

- [ ] **Step 3: Preserve the Hero/stat JSX and replace only the body hierarchy**

Keep these existing blocks structurally intact:

- `mobile-dashboard-topbar` with brand/search/notification center;
- `mobile-dashboard-kitchen` image;
- family name/motto and `mobile-dashboard-meta-row`;
- `mobile-dashboard-actions` with “新增食材”“查看记录”;
- `mobile-dashboard-stat-strip` with four cards.

Keep AppShell’s existing bottom navigation and safe-area handling; `HomeMobileDashboard` must not introduce a second bottom bar or hide the shared one.

Below them, render:

```tsx
<section className="mobile-dashboard-panel mobile-home-question" data-testid="mobile-home-question" data-question="1">
  <MobileQuestionHeading title="今天吃什么" />
  <button
    type="button"
    onClick={props.onNextMobileRecommendation}
    disabled={props.recommendationCount <= 1}
  >
    换一个
  </button>
  <HomeRecommendationCards items={props.mobileRecommendations} mobile />
  <HomeCompactCalendar
    {...props.compactCalendar}
    mobile
  />
</section>
<div className="mobile-home-question" data-testid="mobile-home-question" data-question="2">
  <HomeRequiredActions {...props.requiredActionProps} />
</div>
<div className="mobile-home-question" data-testid="mobile-home-question" data-question="3">
  <HomeHighlightTimeline
    viewModel={props.homeHighlights}
    limit={3}
    onRetry={props.onRetryHighlights}
    onViewAll={props.onOpenFamilyActivity}
  />
</div>
```

`HomeRecommendationCards` receives exactly the model’s one-item mobile window. Remove the recommendation horizontal scroller class and next-card peek.

After both desktop and mobile consume the new windows, delete the Task 8 compatibility fields `dashboardRecommendationPage` and `dashboardRecommendationPageCount` from the hook, model, App and Home prop types.

- [ ] **Step 4: Add only two mobile horizontal scroll containers**

```css
@media (max-width: 767px) {
  .mobile-dashboard-page {
    width: 100%;
    max-width: 100%;
    overflow-x: clip;
  }

  .mobile-dashboard-meta-row,
  .home-compact-days.is-mobile-scroll {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
  }

  .home-compact-days.is-mobile-scroll > button {
    flex: 0 0 72px;
    min-width: 72px;
    min-height: 52px;
  }

  .mobile-home-question,
  .mobile-dashboard-food-card,
  .home-required-actions,
  .home-highlight-panel {
    min-width: 0;
    width: 100%;
  }

  .mobile-dashboard-food-card {
    overflow: hidden;
  }

  .mobile-dashboard-actions button,
  .mobile-dashboard-icon-actions button,
  .mobile-home-question button {
    min-height: 44px;
  }
}
```

Apply `data-testid="mobile-home-calendar-scroll"` to the compact-day scroller for smoke measurement. No other Home section may use `overflow-x: auto`.

- [ ] **Step 5: Run mobile and desktop regressions plus build**

Run:

```bash
npm --prefix frontend run test -- src/features/home/HomeMobileDashboard.test.tsx src/features/home/HomeDashboard.test.tsx src/features/home/useHomeDashboardState.test.tsx
npm --prefix frontend run check:style-tokens
npm --prefix frontend run build
```

Expected: all pass.

- [ ] **Step 6: Commit the mobile Home structure**

```bash
git add frontend/src/features/home/HomeMobileDashboard.tsx frontend/src/features/home/HomeMobileDashboard.test.tsx frontend/src/features/home/HomeDashboard.tsx frontend/src/styles/07-mobile.css
git commit -m "feat: focus mobile home while preserving hero"
```

### Task 12: Split Home and Family Queries and Unify Activity Navigation

**Files:**

- Modify: `frontend/src/app/useAppWorkspaceQueries.ts`
- Modify: `frontend/src/app/useAppWorkspaceQueries.test.tsx`
- Create: `frontend/src/app/useAppFamilyViewModel.ts`
- Create: `frontend/src/app/useAppFamilyViewModel.test.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.ts`
- Modify: `frontend/src/app/useAppHomeViewModel.test.ts`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Modify: `frontend/src/features/family/FamilySettings.test.tsx`
- Modify: `frontend/src/features/family/FamilyMobileView.tsx`
- Modify: `frontend/src/features/family/FamilyActivityViewer.tsx`
- Modify: `frontend/src/features/family/FamilyActivityViewerModel.ts`
- Modify: `frontend/src/features/family/FamilyActivityViewerModel.test.ts`
- Create: `frontend/src/features/family/FamilyActivityViewer.test.tsx`
- Modify: `frontend/src/features/family/useFamilySettingsState.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/02-family-settings.css`
- Modify: `frontend/src/styles/05-workspace-overlays.css`

**Interfaces:**

- Consumes: Task 9 highlights query, full unbounded `activityLogsQuery` and Task 10/11 `onOpenFamilyActivity` callback.
- Produces: Home-only highlights query; Family-only full logs query; `FamilyActivityQueryState` with data/loading/error/fetching/retry; `FamilyOverlayMode='activity'` as the sole open state; responsive modal/page presentation.

- [ ] **Step 1: Write failing final query-split and Family-state tests**

```typescript
it('requests highlights but never full activity logs on home', async () => {
  const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
    items: [], week_highlight_count: 0,
  });
  const logs = vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
  renderWorkspaceQueries('home');
  await flushQueries();
  expect(highlights).toHaveBeenCalledWith(5);
  expect(logs).not.toHaveBeenCalled();
});

it('requests full activity logs without a preview limit on family', async () => {
  const highlights = vi.spyOn(api, 'getActivityHighlights').mockResolvedValue({
    items: [], week_highlight_count: 0,
  });
  const logs = vi.spyOn(api, 'getActivityLogs').mockResolvedValue([]);
  renderWorkspaceQueries('family');
  await flushQueries();
  expect(logs).toHaveBeenCalledWith();
  expect(highlights).not.toHaveBeenCalled();
});

it('keeps both activity queries out of boot loading', async () => {
  vi.spyOn(api, 'getActivityHighlights').mockImplementation(
    () => new Promise<ActivityHighlightsResponse>(() => undefined)
  );
  const home = renderWorkspaceQueries('home');
  await flushQueries();
  expect(home.current().isBootLoading).toBe(false);
  home.unmount();
  vi.spyOn(api, 'getActivityLogs').mockImplementation(
    () => new Promise<ActivityLog[]>(() => undefined)
  );
  const family = renderWorkspaceQueries('family');
  await flushQueries();
  expect(family.current().isBootLoading).toBe(false);
});

it('does not convert a first Family load or failure into zero statistics', () => {
  expect(buildAppFamilyViewModel({
    data: undefined, isLoading: true, isError: false, isFetching: true,
  }).weekActivityValue).toBe('--');
  expect(buildAppFamilyViewModel({
    data: undefined, isLoading: false, isError: true, isFetching: false,
  }).activityPhase).toBe('error');
});
```

Extend the Task 9 harness return value with a real cleanup method used above:

```typescript
unmount() {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
}
```

Keep the resolved boot-query stubs from Task 9. Do not add `waitFor`; `flushQueries()` is the only async harness primitive.

Add component tests:

- Home “查看完整记录” sets active tab to Family and overlay to `activity` in one event;
- desktop renders one `FamilyActivityModal` when overlay is `activity`;
- phone renders one `FamilyActivityMobilePage` for the same state;
- rerendering from desktop to phone preserves `overlayMode='activity'`;
- closing either presentation sets overlay to `null` and keeps the Family tab;
- no local `isActivityModalOpen` or `isMobileActivityPageOpen` behavior remains.

- [ ] **Step 2: Write failing viewer loading/error/stale tests**

In the new `FamilyActivityViewer.test.tsx`, use a fresh `QueryClient` plus `createRoot`, mirroring `FoodWorkspace.test.ts`. Define `buildQueryState(overrides)` with defaults `{ data: undefined, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }`, and define `renderActivityViewer(previewQuery)` to render:

```tsx
<QueryClientProvider client={client}>
  <FamilyActivityModal
    previewQuery={previewQuery}
    members={[]}
    onClose={vi.fn()}
  />
</QueryClientProvider>
```

The helper returns the raw container. Stub `api.getActivityLogs` per test and use the same two-tick `flushQueries()` implementation from Task 9. Define a local `buttonByText(view, label)` exactly as in Task 10.

```typescript
it('shows loading rather than empty before the first viewer response', () => {
  vi.spyOn(api, 'getActivityLogs').mockImplementation(
    () => new Promise<ActivityLog[]>(() => undefined)
  );
  const view = renderActivityViewer(buildQueryState({ isLoading: true, isFetching: true }));
  expect(view.querySelector('[aria-label="家庭活动加载中"]')).not.toBeNull();
  expect(view.textContent).not.toContain('暂无家庭活动');
});

it('shows retry on a no-cache error', async () => {
  const request = vi.spyOn(api, 'getActivityLogs').mockRejectedValue(new Error('offline'));
  const view = renderActivityViewer(buildQueryState({ isError: true }));
  await flushQueries();
  act(() => buttonByText(view, '重试活动记录').click());
  await flushQueries();
  expect(request).toHaveBeenCalledTimes(2);
  expect(view.textContent).not.toContain('暂无家庭活动');
});

it('keeps cached rows on refresh failure', async () => {
  vi.spyOn(api, 'getActivityLogs').mockRejectedValue(new Error('offline'));
  const view = renderActivityViewer(buildQueryState({
    data: [auditLog], isError: true, isFetching: false,
  }));
  await flushQueries();
  expect(view.textContent).toContain(auditLog.summary);
  expect(buttonByText(view, '刷新失败，重试')).not.toBeNull();
});
```

Do not import `screen`, `userEvent`, `waitFor` or `@testing-library/*`.

- [ ] **Step 3: Run the focused tests**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppWorkspaceQueries.test.tsx src/app/useAppHomeViewModel.test.ts src/app/useAppFamilyViewModel.test.ts src/features/family/FamilySettings.test.tsx src/features/family/FamilyActivityViewerModel.test.ts src/features/family/FamilyActivityViewer.test.tsx
```

Expected: Home still requests full logs, Family loses query state behind `data ?? []`, and three independent activity booleans/state paths fail the new tests.

- [ ] **Step 4: Complete the query split and retain the full Family query object**

```typescript
const needsActivityHighlights = args.activeTab === 'home';
const needsActivityLogs = args.activeTab === 'family';

const activityHighlightsQuery = useQuery({
  queryKey: queryKeys.activityHighlightList(5),
  queryFn: () => api.getActivityHighlights(5),
  enabled: args.isAuthenticated && needsActivityHighlights,
});
const activityLogsQuery = useQuery({
  queryKey: queryKeys.activityLogs,
  queryFn: () => api.getActivityLogs(),
  enabled: args.isAuthenticated && needsActivityLogs,
});
```

Remove both from `isBootLoading`. Return both query objects. Do not return a flattened `activityLogs: activityLogsQuery.data ?? []` as the only Family input. Do not pass a limit to the Family overview query.

- [ ] **Step 5: Move full-audit statistics out of the Home view model**

`useAppHomeViewModel` must no longer accept `ActivityLog[]` or derive `currentUserRecentLogs`/`weekActivityCount` from it. Its Hero label comes only from Task 8’s highlight view model.

Define the feature-level query snapshot in `FamilyActivityViewerModel.ts` so feature components never import from `app/`:

```typescript
export type FamilyActivityQueryState = {
  data: ActivityLog[] | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};
```

Then create the app-specific statistics model in `useAppFamilyViewModel.ts`:

```typescript

export function buildAppFamilyViewModel(input: FamilyActivityQueryState & {
  currentUserId?: string;
  now?: Date;
}) {
  const hasData = input.data !== undefined;
  const logs = input.data ?? [];
  const nowMs = (input.now ?? new Date()).getTime();
  const weekActivityValue = logs.filter((log) => {
    const timestamp = Date.parse(log.created_at);
    return Number.isFinite(timestamp) && nowMs - timestamp <= 7 * 24 * 60 * 60 * 1000;
  }).length;
  const activityPhase = hasData
    ? (logs.length === 0 ? 'empty' : 'ready')
    : input.isError
      ? 'error'
      : 'loading';
  return {
    logs,
    activityPhase,
    hasRefreshError: hasData && input.isError,
    currentUserRecentLogs: hasData
      ? logs.filter((log) => log.actor_id === input.currentUserId).length
      : null,
    weekActivityValue: hasData ? weekActivityValue : '--',
  };
}
```

The seven-day calculation above intentionally preserves the current Family statistic formula while making `now` injectable for deterministic tests; this task does not silently replace it with Home's `week_highlight_count`. A future server count contract is required before adding a preview limit.

- [ ] **Step 6: Make `FamilyOverlayMode` the only activity business state**

```typescript
export type FamilyOverlayMode =
  | 'invite'
  | 'profile'
  | 'password'
  | 'family'
  | 'member'
  | 'activity'
  | null;
```

Delete `isActivityModalOpen` and `isMobileActivityPageOpen` from `FamilySettings`. Render by controlled state:

```tsx
if (props.overlayMode === 'activity' && props.isPhoneViewport) {
  return (
    <FamilyActivityMobilePage
      previewQuery={props.activityQuery}
      members={props.members}
      onBack={() => props.onOverlayChange(null)}
    />
  );
}

{props.overlayMode === 'activity' && !props.isPhoneViewport && (
  <FamilyActivityModal
    previewQuery={props.activityQuery}
    members={props.members}
    onClose={() => props.onOverlayChange(null)}
  />
)}
```

Changing `isPhoneViewport` selects presentation only; never rewrite `overlayMode` in an effect.

- [ ] **Step 7: Normalize overview/viewer remote states**

The viewer hook must expose:

```typescript
return {
  filters,
  setFilters,
  resetFilters,
  limit,
  setLimit,
  hasFilters,
  logs,
  phase,
  isFetching: activityQuery.isFetching,
  hasRefreshError: hasCachedData && activityQuery.isError,
  refetch: () => void activityQuery.refetch(),
};
```

Where:

```typescript
const queryData = activityQuery.data;
const seedData = props.previewQuery.data?.slice(0, limit);
const logs = queryData ?? seedData ?? [];
const hasCachedData = queryData !== undefined || seedData !== undefined;
const phase = hasCachedData
  ? (logs.length === 0 ? 'empty' : 'ready')
  : activityQuery.isError || props.previewQuery.isError
    ? 'error'
    : 'loading';
```

The Family overview may keep its unbounded array for exact statistics, but the viewer must never render more than its current `limit`; the seeded preview is therefore sliced only inside the viewer. Keep `FAMILY_ACTIVITY_PAGE_SIZE = 50` and increment by 50 on “加载更多”.

Presentation rules:

- `loading` → skeleton with `aria-label="家庭活动加载中"`;
- `empty` → empty copy only after a successful empty result;
- `error` → local error and “重试活动记录”;
- `ready + hasRefreshError` → retain rows and show low-emphasis “刷新失败，重试”.

Apply the same no-fake-zero rules to Family overview stats and preview timeline.

- [ ] **Step 8: Wire atomic Home-to-Family navigation**

```typescript
function openFamilyActivity() {
  setFamilyOverlayMode('activity');
  setActiveTab('family');
}
```

Pass this one callback to desktop and mobile Home. Closing the activity modal/page calls only `setFamilyOverlayMode(null)`, so the user stays in Family.

- [ ] **Step 9: Run Family/query tests and full frontend unit tests**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppWorkspaceQueries.test.tsx src/app/useAppHomeViewModel.test.ts src/app/useAppFamilyViewModel.test.ts src/features/family/FamilySettings.test.tsx src/features/family/FamilyActivityViewerModel.test.ts src/features/family/FamilyActivityViewer.test.tsx
npm --prefix frontend run test
npm --prefix frontend run build
```

Expected: all pass; Home never issues `/api/activity-logs`, Family retains full query semantics and local loading/error states, and one overlay state drives both responsive presentations.

- [ ] **Step 10: Commit the query and activity navigation convergence**

```bash
git add frontend/src/app/useAppWorkspaceQueries.ts frontend/src/app/useAppWorkspaceQueries.test.tsx frontend/src/app/useAppFamilyViewModel.ts frontend/src/app/useAppFamilyViewModel.test.ts frontend/src/app/useAppHomeViewModel.ts frontend/src/app/useAppHomeViewModel.test.ts frontend/src/features/family/FamilySettings.tsx frontend/src/features/family/FamilySettings.test.tsx frontend/src/features/family/FamilyMobileView.tsx frontend/src/features/family/FamilyActivityViewer.tsx frontend/src/features/family/FamilyActivityViewerModel.ts frontend/src/features/family/FamilyActivityViewerModel.test.ts frontend/src/features/family/FamilyActivityViewer.test.tsx frontend/src/features/family/useFamilySettingsState.ts frontend/src/App.tsx frontend/src/styles/02-family-settings.css frontend/src/styles/05-workspace-overlays.css
git commit -m "feat: unify family activity navigation and states"
```

### Task 13: Add Explicit Week Navigation and a Mobile Week Presentation

**Files:**

- Modify: `frontend/src/app/useAppGlobalSearchNavigation.ts`
- Modify: `frontend/src/app/useAppGlobalSearchNavigation.test.tsx`
- Modify: `frontend/src/components/foods/useFoodPlanState.ts`
- Create: `frontend/src/components/foods/useFoodPlanState.test.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Modify: `frontend/src/components/foods/FoodMobileView.tsx`
- Create: `frontend/src/components/foods/FoodPlanWeekMobilePage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/06-food-workspace.css`
- Modify: `frontend/src/styles/07-mobile.css`

**Interfaces:**

- Consumes: Task 10/11 `onOpenFullWeek(planDate)`, existing food tab/week range and item navigation.
- Produces: discriminated `FoodPlanNavigationRequest` with `target:'item' | 'week'`; `openFoodPlanWeek(planDate)`; desktop focus on existing week section; mobile safe-area week page; unchanged item-detail navigation.

- [ ] **Step 1: Write failing navigation protocol tests**

Extend the existing `NavigationHarness` instead of inventing a second hook harness. Add module-level `setSelectedRecipePlanDateMock` beside the existing `setActiveTabMock`; in `NavigationHarness`, assign both module variables to the `vi.fn()` instances passed into `useAppGlobalSearchNavigation`. Define one fully typed `mealPlanSelection: GlobalSearchSelection` using a complete `FoodPlanItem` fixture (the existing `homeDashboardModel.test.ts` plan-item fixture has every required field).

```typescript
it('keeps global-search plan results as item targets', () => {
  const api = renderNavigation();
  act(() => api!.nav.handleGlobalSearchSelect(mealPlanSelection));
  expect(latest!.nav.foodPlanNavigationRequest).toEqual({
    target: 'item',
    itemId: mealPlanSelection.entityId,
    planDate: mealPlanSelection.item.entity.plan_date,
    requestId: 1,
  });
});

it('opens the selected natural week without inventing an item id', () => {
  const api = renderNavigation();
  act(() => api!.nav.openFoodPlanWeek('2026-07-15'));
  expect(setSelectedRecipePlanDateMock).toHaveBeenCalledWith('2026-07-15');
  expect(setActiveTabMock).toHaveBeenCalledWith('foods');
  expect(latest!.nav.foodPlanNavigationRequest).toEqual({
    target: 'week',
    planDate: '2026-07-15',
    requestId: 1,
  });
});

it('handles week navigation without opening plan detail', () => {
  const onNavigateToWeek = vi.fn();
  let state = renderPlanState({
    navigationRequest: { target: 'week', planDate: '2026-07-15', requestId: 9 },
    onNavigateToWeek,
  });
  expect(onNavigateToWeek).toHaveBeenCalledWith('2026-07-15');
  state = latestPlanState!;
  expect(state.activePlanDetailItem).toBeNull();
});
```

Create `useFoodPlanState.test.tsx` with the same `createRoot` + component `Harness` pattern as `useHomeDashboardState.test.tsx`. Define `buildPlanStateInput(overrides)` with `foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' }`, empty arrays and `vi.fn()`/resolved-promise defaults for every current callback; then `renderPlanState(overrides)` renders the harness and returns module-level `latestPlanState`. The harness must forward `navigationRequest` and `onNavigateToWeek`; do not use `renderHook`.

Add rerender tests proving the same `requestId` is handled once and a later request for another week is handled. Keep an existing item test proving `target:'item'` still opens its exact item.

- [ ] **Step 2: Write failing desktop/mobile presentation tests**

Extend the real `FoodWorkspace.test.ts` helper from `renderWorkspace(options)` to accept `isPhoneViewport?: boolean`, `foodPlanNavigationRequest?: FoodPlanNavigationRequest | null` and `foodPlanWeekRange?: { start: string; end: string }`, forwarding those exact values to `FoodWorkspace`. Keep the helper's existing `QueryClient`, `createRoot`, default food and callbacks.

```typescript
it('focuses the existing desktop week section for a week request', () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  const { view } = renderWorkspace({
    isPhoneViewport: false,
    foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' },
    foodPlanNavigationRequest: {
      target: 'week', planDate: '2026-07-15', requestId: 2,
    },
  });
  const week = view.querySelector('[data-testid="food-plan-week-section"]');
  expect(document.activeElement).toBe(week);
  expect(view.querySelector('[role="dialog"][aria-label*="菜单详情"]')).toBeNull();
});

it('opens and closes the lightweight mobile week page', () => {
  const { view } = renderWorkspace({
    isPhoneViewport: true,
    foodPlanWeekRange: { start: '2026-07-13', end: '2026-07-19' },
    foodPlanNavigationRequest: {
      target: 'week', planDate: '2026-07-15', requestId: 3,
    },
  });
  expect(view.querySelector('main[aria-label="手机周菜单"]')).not.toBeNull();
  expect(view.querySelector('[role="dialog"][aria-label*="菜单详情"]')).toBeNull();
  const back = view.querySelector<HTMLButtonElement>('button[aria-label="返回食物页"]');
  if (!back) throw new Error('mobile week back button missing');
  act(() => back.click());
  expect(view.querySelector('main[aria-label="手机周菜单"]')).toBeNull();
});
```

Do not add `screen`, `userEvent`, `waitFor`, `renderHook` or `@testing-library/*`.

- [ ] **Step 3: Run focused navigation tests**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppGlobalSearchNavigation.test.tsx src/components/foods/useFoodPlanState.test.tsx src/components/foods/FoodWorkspace.test.ts
```

Expected: current type requires `itemId`, `useFoodPlanState` always searches/opens an item, and no mobile week page exists.

- [ ] **Step 4: Replace the plan request with the exact discriminated union**

```typescript
export type FoodPlanNavigationRequest =
  | {
      target: 'item';
      itemId: string;
      planDate: string;
      requestId: number;
    }
  | {
      target: 'week';
      planDate: string;
      requestId: number;
    };
```

Global-search selection constructs `target:'item'`. Add:

```typescript
const openFoodPlanWeek = useCallback((planDate: string) => {
  foodPlanNavigationRequestIdRef.current += 1;
  setSelectedRecipePlanDate(planDate);
  setFoodPlanNavigationRequest({
    target: 'week',
    planDate,
    requestId: foodPlanNavigationRequestIdRef.current,
  });
  setActiveTab('foods');
}, [setActiveTab, setSelectedRecipePlanDate]);
```

Return `openFoodPlanWeek` and pass it to `HomeDashboard.onOpenFullWeek` in App.

- [ ] **Step 5: Branch item and week behavior in `useFoodPlanState`**

Extend the input with `onNavigateToWeek: (planDate: string) => void`:

```typescript
useEffect(() => {
  const request = input.navigationRequest;
  if (!request || handledNavigationRequestIdRef.current === request.requestId) return;
  if (request.planDate < input.foodPlanWeekRange.start || request.planDate > input.foodPlanWeekRange.end) return;

  if (request.target === 'week') {
    input.onNavigateToWeek(request.planDate);
    handledNavigationRequestIdRef.current = request.requestId;
    return;
  }

  const item = input.foodPlanItems.find((entry) => entry.id === request.itemId);
  if (!item) return;
  openPlanDetail(item);
  handledNavigationRequestIdRef.current = request.requestId;
}, [
  input.foodPlanItems,
  input.foodPlanWeekRange.end,
  input.foodPlanWeekRange.start,
  input.navigationRequest,
  input.onNavigateToWeek,
]);
```

No week branch may call `openPlanDetail()`.

- [ ] **Step 6: Add desktop focus and mobile page state in FoodWorkspace**

```tsx
const foodPlanWeekRef = useRef<HTMLDivElement | null>(null);
const [mobileWeekPlanDate, setMobileWeekPlanDate] = useState<string | null>(null);

const handleNavigateToWeek = useCallback((planDate: string) => {
  if (props.isPhoneViewport) {
    setMobileWeekPlanDate(planDate);
    return;
  }
  requestAnimationFrame(() => {
    foodPlanWeekRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    foodPlanWeekRef.current?.focus({ preventScroll: true });
  });
}, [props.isPhoneViewport]);
```

Attach `ref={foodPlanWeekRef}`, `tabIndex={-1}` and `data-testid="food-plan-week-section"` to the existing desktop `food-plan-week` section. Pass `handleNavigateToWeek` into `useFoodPlanState`.

- [ ] **Step 7: Implement the lightweight mobile week page**

```tsx
export function FoodPlanWeekMobilePage(props: {
  weekRange: { start: string; end: string };
  days: Array<{ date: string; label: string; items: FoodPlanItem[] }>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onOpenItem: (item: FoodPlanItem) => void;
  onBack: () => void;
}) {
  return (
    <main className="food-plan-week-mobile-page" aria-label="手机周菜单">
      <header className="food-plan-week-mobile-head">
        <button type="button" aria-label="返回食物页" onClick={props.onBack}>
          <DashboardIcon name="chevron" />
        </button>
        <div><span>完整周菜单</span><h1>{props.weekRange.start} 至 {props.weekRange.end}</h1></div>
      </header>
      <div className="food-plan-week-mobile-days" aria-label="选择日期">
        {props.days.map((day) => (
          <button
            key={day.date}
            type="button"
            aria-pressed={day.date === props.selectedDate}
            onClick={() => props.onSelectDate(day.date)}
          >
            <span>{day.label}</span><strong>{day.items.length} 项</strong>
          </button>
        ))}
      </div>
      <section aria-label="所选日期菜单">
        {props.days.find((day) => day.date === props.selectedDate)?.items.map((item) => (
          <button key={item.id} type="button" onClick={() => props.onOpenItem(item)}>
            <strong>{item.food_name}</strong><span>{MEAL_TYPE_LABELS[item.meal_type]}</span>
          </button>
        ))}
      </section>
    </main>
  );
}
```

Render this page from `FoodWorkspace`/`FoodMobileView` when `mobileWeekPlanDate` is set. Opening an item remains an explicit subsequent tap.
Import `MEAL_TYPE_LABELS` from `frontend/src/lib/ui.ts` so the page never exposes raw meal-type values.

- [ ] **Step 8: Add mobile safe-area and desktop focus styles**

```css
.food-plan-week:focus-visible {
  outline: 3px solid rgba(210, 107, 51, 0.24);
  outline-offset: 4px;
}

@media (max-width: 767px) {
  .food-plan-week-mobile-page {
    min-height: 100dvh;
    padding:
      calc(env(safe-area-inset-top) + 12px)
      16px
      calc(env(safe-area-inset-bottom) + 24px);
    background: var(--surface-3);
  }

  .food-plan-week-mobile-head button,
  .food-plan-week-mobile-days button,
  .food-plan-week-mobile-page section button {
    min-height: 44px;
  }
}
```

Use existing `--surface-3`, `--line-soft`, `--text`, `--text-soft` and `--accent` for the rest of this page.

- [ ] **Step 9: Run navigation regressions and build**

Run:

```bash
npm --prefix frontend run test -- src/app/useAppGlobalSearchNavigation.test.tsx src/components/foods/useFoodPlanState.test.tsx src/components/foods/FoodWorkspace.test.ts
npm --prefix frontend run build
```

Expected: all pass; item navigation remains unchanged and week navigation never auto-opens an item.

- [ ] **Step 10: Commit week navigation**

```bash
git add frontend/src/app/useAppGlobalSearchNavigation.ts frontend/src/app/useAppGlobalSearchNavigation.test.tsx frontend/src/components/foods/useFoodPlanState.ts frontend/src/components/foods/useFoodPlanState.test.tsx frontend/src/components/foods/FoodWorkspace.tsx frontend/src/components/foods/FoodWorkspace.test.ts frontend/src/components/foods/FoodMobileView.tsx frontend/src/components/foods/FoodPlanWeekMobilePage.tsx frontend/src/App.tsx frontend/src/styles/06-food-workspace.css frontend/src/styles/07-mobile.css
git commit -m "feat: navigate home calendar to full week menus"
```

### Task 14: Extend Smoke Fixtures and Responsive Acceptance

**Files:**

- Modify: `frontend/scripts/smoke.mjs`
- Modify only if smoke exposes a verified issue: `frontend/src/styles/01-home-dashboard.css`
- Modify only if smoke exposes a verified issue: `frontend/src/styles/02-family-settings.css`
- Modify only if smoke exposes a verified issue: `frontend/src/styles/06-food-workspace.css`
- Modify only if smoke exposes a verified issue: `frontend/src/styles/07-mobile.css`

**Interfaces:**

- Consumes: final backend response shape and the stable selectors/test IDs introduced in Tasks 10–13.
- Produces: deterministic five-highlight fixture with independent week count; delayed/failing activity fixtures; request audit; desktop/mobile layout, overflow and navigation acceptance.

- [ ] **Step 1: Add the failing fixture and unknown-request audit**

Register exactly one Home highlight response:

```javascript
function makeHighlight(id, kind, summary, createdAt) {
  return {
    id,
    kind,
    summary,
    actor_id: user.id,
    actor_name: user.display_name,
    created_at: createdAt,
  };
}

const activityHighlightsFixture = {
  items: [
    makeHighlight('highlight-5', 'shopping', '完成 5 项采购入库', '2026-07-12T08:42:00Z'),
    makeHighlight('highlight-4', 'inventory', '完成库存盘点并修正 3 项', '2026-07-12T08:10:00Z'),
    makeHighlight('highlight-3', 'meal_plan', '安排了周日晚餐', '2026-07-11T11:30:00Z'),
    makeHighlight('highlight-2', 'meal', '完成番茄炒蛋并记录用餐', '2026-07-11T10:00:00Z'),
    makeHighlight('highlight-1', 'family', '邀请爸爸加入家庭', '2026-07-10T09:00:00Z'),
  ],
  week_highlight_count: 9,
};

if (url.pathname === '/api/activity-highlights') {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(activityHighlightsFixture),
  });
  return;
}
```

Keep `/api/activity-logs` for Family only. Record every requested pathname; the Home scenario asserts the list excludes `/api/activity-logs`. Unknown API routes still fail the smoke rather than returning an empty success.

```javascript
const requestedApiPaths = [];

// At the start of the route handler:
if (url.pathname.startsWith('/api/')) {
  requestedApiPaths.push(url.pathname);
}

// Immediately before leaving the Home-only scenario:
if (requestedApiPaths.includes('/api/activity-logs')) {
  throw new Error('首页错误请求了完整 /api/activity-logs');
}
```

- [ ] **Step 2: Add failing desktop/mobile semantic and count assertions**

```javascript
await expectVisible(page.getByRole('heading', { name: '今天吃什么' }), '首页问题 1');
await expectVisible(page.getByRole('heading', { name: '今天必须处理什么' }), '首页问题 2');
await expectVisible(page.getByRole('heading', { name: '家里发生了什么' }), '首页问题 3');

const recommendationCount = await page.getByTestId('home-recommendation-card').count();
const expectedRecommendationCount = isPhoneViewport ? 1 : 3;
if (recommendationCount !== expectedRecommendationCount) {
  throw new Error(
    `首页推荐数量错误：expected=${expectedRecommendationCount} actual=${recommendationCount}`
  );
}

const highlightCount = await page.getByTestId('home-highlight-row').count();
const expectedHighlightCount = isPhoneViewport ? 3 : 5;
if (highlightCount !== expectedHighlightCount) {
  throw new Error(
    `首页高亮数量错误：expected=${expectedHighlightCount} actual=${highlightCount}`
  );
}

const calendarDayCount = await page.getByRole('button', { name: /选择 / }).count();
if (calendarDayCount !== 7) {
  throw new Error(`紧凑日历不是 7 天：actual=${calendarDayCount}`);
}

if (isPhoneViewport) {
  await expectVisible(page.getByRole('navigation', { name: '手机主导航' }), '手机底部导航');
}
```

Use a recommendation fixture of five items so the desktop last window wraps and mobile can advance 1→2→3 without jumping.

- [ ] **Step 3: Add layout and controlled-overflow measurements**

```javascript
const layout = await page.evaluate(() => {
  const root = document.documentElement;
  const calendar = document.querySelector('[data-testid="mobile-home-calendar-scroll"]');
  const meta = document.querySelector('.mobile-dashboard-meta-row');
  const lower = document.querySelector('[data-testid="home-lower-grid"]');
  return {
    rootFits: root.scrollWidth <= root.clientWidth,
    calendarScrolls: calendar
      ? calendar.scrollWidth > calendar.clientWidth
      : null,
    metaScrollable: meta
      ? getComputedStyle(meta).overflowX === 'auto'
      : null,
    lowerColumns: lower
      ? getComputedStyle(lower).gridTemplateColumns
      : '',
  };
});
if (!layout.rootFits) {
  throw new Error('首页根页面产生横向溢出');
}
if (isPhoneViewport) {
  if (layout.calendarScrolls !== true) {
    throw new Error('手机紧凑日历没有形成受控横滑');
  }
  if (layout.metaScrollable !== true) {
    throw new Error('手机 Hero meta chips 没有保持受控横滑');
  }
} else {
  if (layout.lowerColumns.trim().split(/\s+/).length !== 2) {
    throw new Error(`桌面问题 2/3 不是两列：${layout.lowerColumns}`);
  }
}
```

For mobile, assert Question 2 and 3 bounding boxes do not overlap and Question 3’s top is below Question 2’s bottom. For desktop, assert each lower panel’s internal rows have one x-position column.

- [ ] **Step 4: Add activity loading/error and navigation scenarios**

Use route control promises to verify:

1. delayed `/api/activity-highlights` shows local skeleton while recommendations/calendar/actions remain visible;
2. initial 500 shows “家庭动态暂时加载失败” and retry;
3. a successful cached response followed by refetch 500 retains five/three rows and shows low-emphasis retry;
4. desktop “查看完整记录” opens Family modal;
5. phone “查看完整记录” opens Family page;
6. delayed `/api/activity-logs` in the viewer shows loading, never a transient empty state;
7. “查看完整周菜单” opens selected week, desktop focuses week section, phone opens `aria-label="手机周菜单"`, and no plan detail is open.

The fixture state is controlled inside the smoke process; do not add production query parameters or feature flags.

Use this in-process route controller:

```javascript
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const highlightDelay = deferred();
const activityLogDelay = deferred();
const routeMode = {
  highlights: 'success',
  activityLogs: 'success',
};

async function fulfillActivityRoute(route, url) {
  if (url.pathname === '/api/activity-highlights') {
    if (routeMode.highlights === 'delay') await highlightDelay.promise;
    if (routeMode.highlights === 'error') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'fixture highlight failure' }),
      });
      return true;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activityHighlightsFixture),
    });
    return true;
  }
  if (url.pathname === '/api/activity-logs') {
    if (routeMode.activityLogs === 'delay') await activityLogDelay.promise;
    if (routeMode.activityLogs === 'error') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'fixture activity-log failure' }),
      });
      return true;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(activityLogs),
    });
    return true;
  }
  return false;
}
```

Each scenario creates a fresh page/context so deferred promises are not reused. For stale-cache coverage, first load success, set `routeMode.highlights = 'error'`, dispatch a window focus event, then assert old rows plus “刷新失败，重试”.

- [ ] **Step 5: Run smoke at the required viewport matrix**

The script must cover:

- `1440 × 960`;
- `1280 × 820`;
- `1180 × 820`;
- `1112 × 834`;
- `1024` landscape touch;
- `430 × 932`;
- `390 × 844`;
- `375 × 812`;
- one viewport narrower than `360px`.

Run:

```bash
npm --prefix frontend run smoke
```

Expected: first run fails until all fixture/routes/selectors and layout rules are complete; final run has no unknown API request, page error, console error or root horizontal overflow.

- [ ] **Step 6: Apply only smoke-proven style repairs and rerun**

For each CSS repair, add a nearby smoke assertion that fails without it. Do not adjust unrelated pages or introduce global `overflow-x: hidden` as a blanket fix.

Run:

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
```

Expected: all pass.

- [ ] **Step 7: Commit smoke acceptance**

```bash
git add frontend/scripts/smoke.mjs
git add frontend/src/styles/01-home-dashboard.css frontend/src/styles/02-family-settings.css frontend/src/styles/06-food-workspace.css frontend/src/styles/07-mobile.css
git diff --cached --name-only
git commit -m "test: cover home household highlights smoke"
```

Before commit, unstage any style file whose diff is empty or unrelated to a smoke assertion.

### Task 15: Verify Migration, Full Stack and Release Gates

**Files:**

- Verification only; no file is expected to change.

**Interfaces:**

- Consumes: Tasks 1–14 and the final merged PR 72/73 baseline.
- Produces: current evidence for MySQL migration compatibility, one Alembic head, backend/frontend suites, local smoke, manual business acceptance and remote PR gates.

- [ ] **Step 1: Verify real MySQL 8.4 upgrade, downgrade order and re-upgrade**

Run against the project’s disposable local database:

```bash
npm run db:up
npm run backend:migrate
(cd backend && .venv/bin/alembic downgrade 3f4a5b6c7d8e)
(cd backend && .venv/bin/alembic upgrade 4a5b6c7d8e9f)
(cd backend && .venv/bin/alembic downgrade 3f4a5b6c7d8e)
(cd backend && .venv/bin/alembic upgrade head)
(cd backend && .venv/bin/alembic heads)
```

Expected:

- both upgrade runs succeed on MySQL 8.4;
- downgrade removes index, check, summary, kind in that order;
- final output is exactly one `4a5b6c7d8e9f (head)`;
- no historical `activity_logs` row receives highlighter values.

- [ ] **Step 2: Run a real-MySQL week-boundary test**

Require a configured test-only MySQL URL and run the Task 2 companion test:

```bash
test -n "$CULINA_TEST_MYSQL_URL"
(cd backend && .venv/bin/python -m pytest tests/activity/test_activity_highlights_mysql.py -q)
```

Expected: Shanghai Sunday `23:59:59`, Monday `00:00:00`, UTC cross-date and future-row cases match the SQLite results and do not depend on session timezone.

- [ ] **Step 3: Run the complete backend gates**

```bash
npm run backend:typecheck
npm run backend:test
npm run backend:test:ai
npm run backend:test:service
npm run backend:test:search
```

Expected: every command exits 0. In particular, the two PR 73 suites that previously failed are green on the combined branch.

- [ ] **Step 4: Run the complete frontend gates**

```bash
npm --prefix frontend run quality
npm --prefix frontend run build
npm --prefix frontend run smoke
```

Expected: every command exits 0. Local smoke is mandatory even if the GitHub Frontend Smoke job still uses `continue-on-error`.

- [ ] **Step 5: Perform manual transaction acceptance**

Using two test families and at least two members, execute:

1. one atomic shopping intake and its idempotent replay;
2. one reconciliation and its replay;
3. one shopping/reconciliation revert;
4. one grouped expired disposal;
5. plan create, material update, note-only update and delete;
6. one recipe cook, one meal create and one quick-add;
7. one family invitation and one member profile edit;
8. AI meal-plan approval, AI shopping-list approval, same-kind composite and cross-kind composite.

Expected:

- every eligible transaction adds exactly one Home highlighter;
- replays, note/profile edits, AI shopping-list and cross-kind composite add none;
- full activity logs retain all expected granular audit rows;
- another family sees neither highlighters nor actor names;
- Home API failure leaves the other two Home questions usable.

- [ ] **Step 6: Run a clean diff and targeted code review**

Use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. Apply `backend-code-audit` to backend/ and `frontend-code-audit` to frontend/. Any confirmed finding returns to the owning task, starts with a failing regression test and receives its own focused fix commit.

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
```

Expected: only the planned commits/files are present, `git diff --check` is silent, and no user worktree file appears.

- [ ] **Step 7: Refresh GitHub and deployment gates**

After pushing/opening the implementation PR, run:

```bash
gh pr checks --watch
gh pr view --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup
```

Expected: mergeable, current with the final PR 72/73 base, and all required checks green.

Deployment order:

1. migration;
2. backend model/writers/API;
3. verify auth, family isolation, stable order and week count;
4. frontend query split and Home;
5. real business-flow acceptance.

Emergency rollback order:

1. roll back frontend so it stops calling the new endpoint;
2. roll back backend;
3. retain additive columns, constraint and existing highlighter data;
4. do not run destructive downgrade during an incident.

- [ ] **Step 8: Finish the branch only after all evidence is current**

Use `superpowers:finishing-a-development-branch` to present merge/PR/cleanup choices. If Task 15 produces no repair, it creates no commit. Do not report completion from older task output or from GitHub status alone.

## Spec Coverage Matrix

| Confirmed requirement | Implementation task(s) | Primary verification |
| --- | --- | --- |
| ActivityLog single fact table, pair fields, no history backfill | 1 | model constraint test + MySQL migration |
| Family-scoped limit API, stable order, actor fallback | 2 | API isolation/shape/order tests |
| Shanghai Monday-to-now naive UTC count, no future rows | 2, 15 | clock/API boundary + real MySQL |
| Shopping/intake/reconciliation/revert/disposal eligibility and idempotency | 3 | business API replay/rollback tests |
| Plan material changes, meal/cook, invitation; audit-only controls | 4 | food/meal/family API tests |
| Draft-specific default-closed classifier | 5 | registry tests |
| Zero/same-kind/cross-kind composite reduction | 5, 6 | composite unit + approval integration |
| One approval savepoint including hook/classifier/highlighter/flush | 6 | four fault-injection tests |
| Frontend API types, parameterized keys and invalidation | 7 | API/key/cache tests |
| Circular `N=0/1/2/4/5/6` windows and independent cursors | 8 | model/hook matrix |
| Q2 untruncated merge and one final truncation | 8, 10, 11 | pure model + desktop/mobile copy |
| Desktop 3 recommendations, compact week, `56/44` lower grid | 10, 14 | component + smoke geometry |
| Mobile Hero/top preserved, one recommendation, Q2/3 stacked | 11, 14 | component + smoke |
| Only two controlled mobile scrollers and no root overflow | 11, 14 | CSS ownership + DOM measurements |
| Home highlights only; Family full logs; neither boot-blocking | 9, 12 | query hook tests + request audit |
| Success/loading/error/stale states and Hero `0` versus `--` | 8, 9, 10, 12 | model/component/viewer tests |
| One Family `activity` overlay state across viewport changes | 12 | controlled-state rerender tests |
| Week target without item auto-open; mobile week page | 13, 14 | navigation/component/smoke |
| Full backend/frontend/MySQL/local-smoke/release gates | 15 | recorded command output and manual acceptance |

## Commit Sequence

The intended reviewable sequence is:

1. `feat: add activity highlight persistence contract`
2. `feat: add family activity highlights API`
3. `feat: highlight shopping and inventory outcomes`
4. `feat: highlight meal plan meal and family outcomes`
5. `feat: classify AI activity highlight outcomes`
6. `fix: make AI highlight approval atomic`
7. `feat: add frontend activity highlight contract`
8. `feat: model home recommendations actions and highlights`
9. `feat: feed activity highlights into home`
10. `feat: focus desktop home on three questions`
11. `feat: focus mobile home while preserving hero`
12. `feat: unify family activity navigation and states`
13. `feat: navigate home calendar to full week menus`
14. `test: cover home household highlights smoke`

Each commit must pass the focused command listed in its task. Task 15 validates the complete sequence and does not squash away the review boundaries before review.
