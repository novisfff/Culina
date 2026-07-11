# Task 6 Report: Frontend Visibility Contract and History Controls

## Status

**DONE**

## What was implemented

Personal/shared AI conversation frontend visibility controls for Task 6 only (not inventory/stock work).

### 1. Types
- File: `frontend/src/api/types.ts`
- Added `export type AiConversationVisibility = 'private' | 'family'`
- Extended `AiConversation` with required fields:
  - `owner_user_id: string`
  - `owner_display_name: string`
  - `visibility: AiConversationVisibility`
  - `is_owner: boolean`

### 2. API method
- File: `frontend/src/api/aiApi.ts`
- Added:
  ```ts
  updateAiConversationVisibility: (conversationId, visibility) =>
    request(`/api/ai/conversations/${conversationId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ visibility }),
    })
  ```
- Available via `api` through existing `...aiApi` spread in `client.ts`.

### 3. Fixtures
- File: `frontend/src/components/ai/aiWorkspaceTestFixtures.ts`
- `conversation(overrides: Partial<AiConversation> = {})` now defaults:
  - `owner_user_id: 'user-1'`
  - `owner_display_name: '小林'`
  - `visibility: 'private'`
  - `is_owner: true`
- File: `frontend/src/components/ai/AiDeleteConversationDialog.test.tsx`
  - Replaced local incomplete fixture with shared `conversation()` helper.

### 4. Shared owner-only actions + family metadata
- New file: `frontend/src/components/ai/AiConversationActions.tsx`
  - `AiConversationActions`:
    - Returns `null` when `!conversation.is_owner`
    - Manage button `aria-label={`管理会话：${title}`}`
    - Sibling buttons under `role="menu"` (not nested buttons)
    - Labels: `公开给家庭` / `取消公开` + `删除`
    - Closes menu after either action
  - `AiConversationSharingMeta`:
    - Renders only when `visibility === 'family'`
    - Badge `家庭公开` + `owner_display_name`

### 5. Desktop + mobile history wiring
- `AiConversationHistory.tsx` (desktop rail):
  - Replaced always-on trash delete button with owner-only manage menu
  - Renders sharing meta under title
  - Props: `updatingConversationId`, `onChangeVisibility`, `onDeleteConversation`
- `AiMobileChrome.tsx` + `AiMobilePage.tsx`:
  - Mobile history items are select-button + actions siblings
  - Same visibility/delete/updating props plumbed from workspace

### 6. Visibility mutation + delete dialog placement
- File: `frontend/src/components/ai/AiWorkspace.tsx`
- `visibilityMutation`:
  - `mutationFn` calls `api.updateAiConversationVisibility`
  - `onSuccess` patches item in `queryKeys.aiConversations`
  - `onError` maps HTTP 409 to:
    - `会话正在生成回复，请先等待完成或取消当前任务`
  - other errors use message / `更新公开状态失败`
- Local pending conversations include owner defaults (`is_owner: true`, `visibility: 'private'`)
- Delete confirmation dialog moved out of `.ai-desktop-view` so mobile can open the same dialog
- `updatingConversationId` covers visibility pending or delete pending ids

### 7. Styles
- File: `frontend/src/styles/09-ai-workspace.css`
- Added under `ai-` namespace:
  - `.ai-conversation-actions`
  - `.ai-conversation-manage`
  - `.ai-conversation-action-menu`
  - `.ai-history-sharing-meta`
  - `.ai-history-shared-badge`
  - `.ai-history-owner-name`
  - mobile row layout for actions (`.ai-mobile-conversation-main`)
- Preserved warm palette and history rail dimensions; no redesign of the rail.

## TDD evidence

### RED intent
Task brief specified failing tests first for:
1. API PATCH visibility method
2. Owner-only manage controls + family badge rendering

Implemented tests matching the brief verbatim:
- `aiApi.test.ts`: `patches AI conversation visibility`
- `AiWorkspace.test.tsx`: `shows owner controls only on owned conversations`
- Existing delete confirmation test updated to open manage menu first (delete is no longer a direct trash button)

### GREEN
Focused suite and production build both pass after implementation.

## Verification commands and results

```bash
npm --prefix frontend run test -- \
  src/api/aiApi.test.ts \
  src/components/ai/AiWorkspace.test.tsx \
  src/components/ai/AiMobilePage.test.tsx \
  src/components/ai/AiLegacyStylesUsage.test.ts \
  src/components/ai/AiDeleteConversationDialog.test.tsx
```

Result:
- Test Files: 5 passed
- Tests: **51 passed**
- Includes new visibility API + owner-controls tests, updated delete-menu flow, mobile prop wiring, fixture defaults, and style-selector assertions

```bash
npm --prefix frontend run build
```

Result:
- `tsc -b` + `vite build` succeeded
- Bundle budget check passed with pre-existing warnings only (main/AI/recipe/ingredient gzip budgets already over baseline)

## Files changed (matches commit `c8d282bb`)

1. `frontend/src/api/types.ts`
2. `frontend/src/api/aiApi.ts`
3. `frontend/src/api/aiApi.test.ts`
4. `frontend/src/components/ai/aiWorkspaceTestFixtures.ts`
5. `frontend/src/components/ai/AiConversationActions.tsx` *(new)*
6. `frontend/src/components/ai/AiConversationHistory.tsx`
7. `frontend/src/components/ai/AiMobileChrome.tsx`
8. `frontend/src/components/ai/AiMobilePage.tsx`
9. `frontend/src/components/ai/AiMobilePage.test.tsx`
10. `frontend/src/components/ai/AiWorkspace.tsx`
11. `frontend/src/components/ai/AiWorkspace.test.tsx`
12. `frontend/src/components/ai/AiDeleteConversationDialog.test.tsx`
13. `frontend/src/components/ai/AiLegacyStylesUsage.test.ts`
14. `frontend/src/styles/09-ai-workspace.css`

## Self-review

- Owner gating is correct: non-owners get no manage control; family meta still visible.
- Manage menu uses sibling buttons + `role="menu"` / `role="menuitem"` (no nested buttons).
- aria-label matches required `管理会话：...` pattern.
- Visibility toggle text matches brief (`公开给家庭` / `取消公开`).
- 409 feedback string matches backend-aligned message from brief.
- Delete confirmation is shared by desktop and mobile (dialog no longer desktop-only).
- Fixtures provide required owner fields so LiveSync/other conversation constructors inherit defaults via `conversation()`.
- Styles stay under `ai-` namespace and avoid redesigning the history rail.
- No inventory/food-stock code was touched for this task.

## Commit

- `c8d282bb` — `feat(ai): manage shared conversation visibility`

## Review fix: close manage menu on conversation selection

### Finding
Important: Manage menu does not close on conversation selection. Brief requires “Close the menu after either action and on conversation selection.” Open state was local `useState`; selecting another conversation left open menus mounted in the history list.

### Fix
- `AiConversationActions` now accepts `activeConversationKey` and resets `open` via `useEffect` when it changes.
- Outside-click dismiss on `mousedown` also closes the menu when selecting the same item’s main button (or clicking elsewhere).
- Wired `activeConversationKey` from desktop history (`AiConversationHistory.tsx`) and mobile history (`AiMobileChrome.tsx`).
- Added regression test: open manage menu on conversation A, select conversation B, assert `aria-expanded=false` and no open action menu.

### Test results
```bash
npm --prefix frontend run test -- src/components/ai/AiWorkspace.test.tsx src/components/ai/AiMobilePage.test.tsx
```
- Test Files: 2 passed
- Tests: **32 passed** (includes new close-on-selection coverage)

### Commit
- `fix(ai): close conversation manage menu on selection` (branch HEAD after review fix)

## Concerns

None blocking.

Notes only:
- Pre-existing bundle budget warnings remain (AI workspace and main chunks already over baseline).
