# Frontend Overlay Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端重复实现的业务弹窗和抽屉抽成共用组件，同时保持现有电脑、pad、手机端 UI 表现不变。

**Architecture:** 先抽最稳定的 overlay chrome，再按业务域抽可复用的业务弹窗或表单分段。已存在且较完整的一套实现作为基准：销毁过期批次以食材页现有组件为基准，快速入库以食材页现有分段为基准，首页只做适配和复用。菜单计划只抽共用的 food-plan 选择和日期/餐次/备注分段，不把 food plan 和 recipe plan 强行合成一个大弹窗。

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Query, existing Culina ui-kit, existing CSS classes in `frontend/src/styles/*`.

## Global Constraints

- 只做抽离和复用，不改变现有 UI；两个相同弹窗细微差距以当前更完整的一套统一。
- 电脑端、pad 端、手机端都必须覆盖；不要把手机端当桌面弹窗压缩版。
- 文案优先使用简体中文，保留 Culina 温暖家庭厨房产品语气。
- 优先复用 `frontend/src/components/ui-kit.tsx` 和 `frontend/src/components/ui-kit/*`，不要新建第二套基础弹窗系统。
- 样式类名沿用现有 `.workspace-overlay-*`、`.destroy-expired-*`、`.ingredients-restock-*`、`.recipe-plan-*`、`.meal-*`，除非为了组件边界新增局部类名。
- 不改 API 字段、query key、cache invalidation、后端接口或数据模型。
- 不提交 `.env`、密钥、token、本地生成产物。
- 执行前检查当前 dirty worktree；不要覆盖用户已有未提交改动。
- 每个任务完成后先跑对应 Vitest；最后跑 `npm --prefix frontend run test`、`npm --prefix frontend run build`、`npm --prefix frontend run smoke`。

---

## Duplicate Map

Current duplicate or near-duplicate overlay implementations to address:

- `frontend/src/features/home/HomeDashboardDialogs.tsx:886-1004` duplicates `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx:29-153`.
- `frontend/src/features/home/HomeDashboardDialogs.tsx:559-883` duplicates much of `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx:55-453`, especially ingredient identity, quantity/unit, purchase date, storage, expiry, status, and notes sections.
- `frontend/src/features/home/HomeDashboardDialogs.tsx:226-372` duplicates the food menu add dialog in `frontend/src/components/foods/FoodPlanDialog.tsx:42-228`.
- `frontend/src/features/home/HomeDashboardDialogs.tsx:378-413` and `frontend/src/features/meals/MealLogWorkspace.tsx:225-360` both wrap `MealEnrichmentForm` in a modal with the same footer actions.
- Leave these alone in this pass because they are not the same workflow: `GlobalSearchOverlay`, `AiRunDebugDrawer`, `AiQualityDiagnosticsModal`, family settings modals, recipe shopping confirmation, ingredient shopping overlay, recipe cook finish dialog, and cooking assistant clear confirmation.

## File Structure

- Create `frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx`
  - Owns only the repeated overlay root and backdrop wrapper.
  - Does not own `WorkspaceModal` or `WorkspaceDrawer`; callers still choose modal vs drawer.

- Create `frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx`
  - Verifies class composition and backdrop close behavior.

- Modify `frontend/src/components/ui-kit/index.ts`
  - Exports `WorkspaceOverlayFrame`.

- Modify `frontend/src/components/ui-kit/ConfirmDialog.tsx`
  - Uses `WorkspaceOverlayFrame` without changing rendered classes.

- Create `frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx`
  - Tests the existing expired-disposal UI after it becomes the shared component.

- Modify `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx`
  - Rename prop names from ingredient-workspace-specific names to generic shared names.
  - Keep existing CSS classes and markup.
  - Add optional `formId`, `overlayRootClassName`, `description`, `footerSummaryIntro`, `footerSummaryDetail`, `summaryMetrics`, `listTitle`, `listDescription`, `emptyDescription`.

- Modify `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`
  - Calls the shared expired dialog through the new generic props.

- Modify `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - Removes the inline expired-disposal modal.
  - Uses the shared expired dialog inside the home overlay root.

- Create `frontend/src/components/ingredients/IngredientRestockSections.tsx`
  - Contains reusable presentational sections for restock identity, quantity/unit, purchase date, storage, expiry, and advanced status/notes.
  - Does not fetch resources and does not submit.

- Create `frontend/src/components/ingredients/IngredientRestockSections.test.tsx`
  - Tests quantity tracking copy, purchase preset behavior, expiry mode behavior, and notes/status callbacks.

- Modify `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
  - Replaces duplicated internal JSX with `IngredientRestockSections`.

- Modify `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - Replaces inline restock form sections with `IngredientRestockSections`.

- Create `frontend/src/components/foods/FoodPlanDialogParts.tsx`
  - Contains `FoodPlanSelectedHero`, `FoodPlanFoodPicker`, `FoodPlanDateMealNoteFields`.
  - Uses existing food plan CSS classes.

- Create `frontend/src/components/foods/FoodPlanDialogParts.test.tsx`
  - Tests date/meal/note callbacks and selected food hero.

- Modify `frontend/src/components/foods/FoodPlanDialog.tsx`
  - Uses `FoodPlanDialogParts`.

- Modify `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - Uses `FoodPlanDialogParts` for the home food-plan dialog.

- Create `frontend/src/features/meals/MealEnrichmentModal.tsx`
  - Wraps `MealEnrichmentForm` in `WorkspaceModal` with shared title, description, footer, submit form id, and overlay root.

- Create `frontend/src/features/meals/MealEnrichmentModal.test.tsx`
  - Tests shared modal title, footer, close action, and submit wiring.

- Modify `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - Uses `MealEnrichmentModal` for homepage meal completion enrichment.

- Modify `frontend/src/features/meals/MealLogWorkspace.tsx`
  - Uses `MealEnrichmentModal` for enrich mode; preview mode stays in `MealLogWorkspace` because it is a distinct read-only detail workflow.

- Modify `frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts`
  - Updates allow-list expectations after moving search usage from `HomeDashboardDialogs` into shared food/restock sections.

---

### Task 1: Shared Overlay Frame

**Files:**
- Create: `frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx`
- Create: `frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/components/ui-kit/ConfirmDialog.tsx`

**Interfaces:**
- Consumes: `ReactNode` from React.
- Produces:
  - `WorkspaceOverlayFrame(props: WorkspaceOverlayFrameProps): JSX.Element`
  - `WorkspaceOverlayFrameProps = { children: ReactNode; onClose: () => void; rootClassName?: string; backdropClassName?: string; closeOnBackdrop?: boolean }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceOverlayFrame } from './WorkspaceOverlayFrame';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderFrame(closeOnBackdrop = true) {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <WorkspaceOverlayFrame
        rootClassName="home-dashboard-overlay-root"
        backdropClassName="custom-backdrop"
        closeOnBackdrop={closeOnBackdrop}
        onClose={onClose}
      >
        <div className="workspace-modal">内容</div>
      </WorkspaceOverlayFrame>
    );
  });
  return { onClose, view: container };
}

describe('WorkspaceOverlayFrame', () => {
  it('keeps existing workspace overlay classes and closes from the backdrop', () => {
    const { onClose, view } = renderFrame();

    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    const backdrop = view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop.custom-backdrop');
    expect(backdrop).not.toBeNull();

    act(() => backdrop?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('can keep the backdrop visible without closing', () => {
    const { onClose, view } = renderFrame(false);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix frontend run test -- WorkspaceOverlayFrame.test.tsx
```

Expected: FAIL because `./WorkspaceOverlayFrame` does not exist.

- [ ] **Step 3: Add `WorkspaceOverlayFrame`**

Create `frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx`:

```tsx
import type { ReactNode } from 'react';

export type WorkspaceOverlayFrameProps = {
  children: ReactNode;
  onClose: () => void;
  rootClassName?: string;
  backdropClassName?: string;
  closeOnBackdrop?: boolean;
};

export function WorkspaceOverlayFrame({
  children,
  onClose,
  rootClassName,
  backdropClassName,
  closeOnBackdrop = true,
}: WorkspaceOverlayFrameProps) {
  return (
    <div className={['workspace-overlay-root', rootClassName].filter(Boolean).join(' ')}>
      <div
        className={['workspace-overlay-backdrop', backdropClassName].filter(Boolean).join(' ')}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      {children}
    </div>
  );
}
```

Modify `frontend/src/components/ui-kit/index.ts`:

```ts
export * from './DropdownSelect';
export * from './FormActions';
export * from './ConfirmDialog';
export * from './FormField';
export * from './SearchField';
export * from './QuantityUnitField';
export * from './ComboboxField';
export * from './SearchableResourceSelect';
export * from './OptionChipGroup';
export * from './StatusBadge';
export * from './StateBlock';
export * from './MobileActionBar';
export * from './ImageComposer';
export * from './WorkspaceOverlayFrame';
```

Modify `frontend/src/components/ui-kit/ConfirmDialog.tsx`:

```tsx
import type { ReactNode } from 'react';
import { WorkspaceModal } from '../ui-kit';
import { FormActions } from './FormActions';
import { WorkspaceOverlayFrame } from './WorkspaceOverlayFrame';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'primary' | 'danger';
  isSubmitting?: boolean;
  rootClassName?: string;
  modalClassName?: string;
  actionsClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'primary',
  isSubmitting = false,
  rootClassName,
  modalClassName,
  actionsClassName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  function cancelIfAllowed() {
    if (!isSubmitting) onCancel();
  }

  return (
    <WorkspaceOverlayFrame
      rootClassName={['ui-confirm-dialog-root', rootClassName].filter(Boolean).join(' ')}
      closeOnBackdrop={!isSubmitting}
      onClose={cancelIfAllowed}
    >
      <WorkspaceModal
        title={title}
        description={typeof description === 'string' ? description : undefined}
        closeLabel={cancelLabel}
        closeAriaLabel={typeof cancelLabel === 'string' ? cancelLabel : '关闭确认弹窗'}
        className={['ui-confirm-dialog', tone === 'danger' ? 'is-danger' : '', modalClassName].filter(Boolean).join(' ')}
        onClose={cancelIfAllowed}
        footerActions={
          <FormActions
            primaryLabel={confirmLabel}
            primaryTone={tone === 'danger' ? 'danger' : 'primary'}
            secondaryLabel={cancelLabel}
            isSubmitting={isSubmitting}
            className={actionsClassName}
            onPrimary={onConfirm}
            onSecondary={onCancel}
          />
        }
      >
        {typeof description === 'string' ? null : <div className="ui-confirm-dialog-description">{description}</div>}
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm --prefix frontend run test -- WorkspaceOverlayFrame.test.tsx ConfirmDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui-kit/WorkspaceOverlayFrame.tsx frontend/src/components/ui-kit/WorkspaceOverlayFrame.test.tsx frontend/src/components/ui-kit/index.ts frontend/src/components/ui-kit/ConfirmDialog.tsx
git commit -m "refactor: share workspace overlay frame"
```

---

### Task 2: Shared Expired Inventory Disposal Dialog

**Files:**
- Create: `frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx`
- Modify: `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`

**Interfaces:**
- Consumes:
  - `WorkspaceOverlayFrame` from Task 1.
  - `IngredientSummaryViewModel` and `DisposableExpiredInventoryItemViewModel` from `frontend/src/components/ingredients/workspaceModel.ts`.
- Produces:
  - `DestroyExpiredInventoryDialog(props: DestroyExpiredInventoryDialogProps): JSX.Element`
  - `DestroyExpiredInventoryDialogProps = { closeOverlay; summary; previewUrl?; meta; items; headline; submit; isSubmitting?; formId?; overlayRootClassName?; description?; footerSummaryIntro?; footerSummaryDetail?; summaryMetrics?; listTitle?; listDescription?; emptyDescription? }`
  - Backward-compatible export alias: `export { DestroyExpiredInventoryDialog as IngredientDestroyExpiredOverlay }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { DisposableExpiredInventoryItemViewModel, IngredientSummaryViewModel } from './workspaceModel';
import { DestroyExpiredInventoryDialog } from './IngredientDestroyExpiredOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const ingredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const summary: IngredientSummaryViewModel = {
  ingredient,
  inventoryItems: [],
  availableInventoryItems: [],
  alerts: [],
  quantitySummaries: [{ unit: '个', total: 2, label: '2个' }],
  hasMultipleUnits: false,
  primaryStorage: '冷藏',
  storageLocations: ['冷藏'],
  recipeReferences: [],
  latestPurchaseDate: '2026-06-25',
  latestUpdatedAt: '2026-07-01T00:00:00Z',
};

const item: DisposableExpiredInventoryItemViewModel = {
  id: 'inventory-expired-1',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  remainingQuantity: 2,
  remainingLabel: '2个',
  unit: '个',
  purchaseDate: '2026-06-20',
  expiryDate: '2026-06-25',
  storageLocation: '冷藏',
  notes: '表面变软',
  status: 'expiring',
  createdAt: '2026-06-20T00:00:00Z',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderDialog(items: DisposableExpiredInventoryItemViewModel[] = [item]) {
  const closeOverlay = vi.fn();
  const submit = vi.fn(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DestroyExpiredInventoryDialog
        closeOverlay={closeOverlay}
        summary={summary}
        meta={['蔬菜', '默认 个', '冷藏']}
        items={items}
        headline="2个"
        submit={submit}
        formId="test-destroy-expired-form"
        overlayRootClassName="home-dashboard-overlay-root"
        listTitle="将要销毁的批次"
        listDescription="只列出已经过期且当前仍有剩余量的批次。"
      />
    );
  });
  return { closeOverlay, submit, view: container };
}

describe('DestroyExpiredInventoryDialog', () => {
  it('renders the shared disposal content and submits through the provided form id', async () => {
    const { submit, view } = renderDialog();

    expect(view.textContent).toContain('销毁已过期批次');
    expect(view.textContent).toContain('番茄');
    expect(view.textContent).toContain('2个');
    expect(view.querySelector('.destroy-expired-row')).not.toBeNull();
    expect(view.querySelector('.destroy-expired-row-main')?.textContent).toContain('2个');
    expect(view.querySelector('.destroy-expired-row-meta')?.textContent).toContain('到期');
    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.getAttribute('form')).toBe('test-destroy-expired-form');

    await act(async () => {
      view.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('disables submit and shows the empty state when there are no disposable batches', () => {
    const { view } = renderDialog([]);

    expect(view.textContent).toContain('当前没有可销毁的批次');
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix frontend run test -- DestroyExpiredInventoryDialog.test.tsx
```

Expected: FAIL because `DestroyExpiredInventoryDialog` is not exported yet.

- [ ] **Step 3: Refactor the expired dialog**

Modify `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx` so the public component is generic and wraps itself in `WorkspaceOverlayFrame`:

```tsx
import type { FormEvent, ReactNode } from 'react';
import { formatDate, formatRelativeDays, INVENTORY_STATUS_LABELS } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { Badge, EmptyState, FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../ui-kit';
import type { DisposableExpiredInventoryItemViewModel, IngredientSummaryViewModel } from './workspaceModel';

export type DestroyExpiredInventoryDialogProps = {
  closeOverlay: () => void;
  summary: IngredientSummaryViewModel;
  previewUrl?: string;
  meta: string[];
  items: DisposableExpiredInventoryItemViewModel[];
  headline: string;
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isSubmitting?: boolean;
  formId?: string;
  overlayRootClassName?: string;
  description?: string;
  footerSummaryIntro?: string;
  footerSummaryDetail?: string;
  summaryMetrics?: ReactNode;
  listTitle?: string;
  listDescription?: string;
  emptyDescription?: string;
};

export function DestroyExpiredInventoryDialog(props: DestroyExpiredInventoryDialogProps) {
  const destroyExpiredFormId = props.formId ?? 'ingredient-destroy-expired-overlay-form';

  return (
    <WorkspaceOverlayFrame rootClassName={props.overlayRootClassName} onClose={props.closeOverlay}>
      <WorkspaceModal
        title="销毁已过期批次"
        description={props.description ?? '清零过期批次剩余量，历史记录会保留。'}
        closeLabel="关闭"
        closeAriaLabel="关闭"
        className="workspace-modal-wide destroy-expired-modal"
        onClose={props.closeOverlay}
        footerInfo={
          <div className="destroy-expired-footer-summary">
            <span>{props.footerSummaryIntro ?? '将处理'}</span>
            <strong>{props.items.length} 条过期批次</strong>
            <p>
              {props.items.length > 0
                ? props.footerSummaryDetail ?? '剩余量会清零，历史记录和日志保留。'
                : '当前没有可销毁的过期批次。'}
            </p>
          </div>
        }
        footerActions={
          <FormActions
            className="destroy-expired-actions"
            primaryLabel="确认销毁"
            primaryType="submit"
            primaryForm={destroyExpiredFormId}
            primaryTone="danger"
            primaryDisabled={props.items.length === 0}
            isSubmitting={Boolean(props.isSubmitting)}
            secondaryLabel="取消"
            onSecondary={props.closeOverlay}
          />
        }
      >
        <form id={destroyExpiredFormId} className="destroy-expired-form" onSubmit={(event) => void props.submit(event)}>
          <div className="destroy-expired-scroll">
            <section className="ingredients-restock-identity-card destroy-expired-summary-card">
              <div className="ingredients-restock-identity-media">
                <MediaWithPlaceholder src={props.previewUrl} alt={props.summary.ingredient.name} />
              </div>
              <div className="ingredients-restock-identity-copy">
                <div className="ingredients-restock-identity-head">
                  <div>
                    <h4>{props.summary.ingredient.name}</h4>
                    <p>{props.meta.join(' · ')}</p>
                  </div>
                  <div className="destroy-expired-summary-badges">
                    <Badge>{props.items.length} 条待销毁</Badge>
                    <Badge>{props.headline}</Badge>
                  </div>
                </div>
                <div className="destroy-expired-summary-grid">
                  {props.summaryMetrics ?? (
                    <article className="destroy-expired-summary-metric is-primary">
                      <span>本次处理范围</span>
                      <strong>{props.items.length} 条过期批次</strong>
                      <p>确认后清零剩余量。</p>
                    </article>
                  )}
                </div>
              </div>
            </section>

            <section className="ingredients-restock-field-group destroy-expired-list-section">
              <div className="ingredients-restock-field-head">
                <span>{props.listTitle ?? '待处理批次'}</span>
                {props.listDescription ? <p className="subtle">{props.listDescription}</p> : null}
              </div>
              {props.items.length > 0 ? (
                <div className="destroy-expired-list">
                  {props.items.map((item) => (
                    <article key={item.id} className="destroy-expired-row">
                      <div className="destroy-expired-row-main">
                        <strong>{item.remainingLabel}</strong>
                        <span>{item.storageLocation}</span>
                      </div>
                      <div className="destroy-expired-row-meta">
                        <span className="is-danger">已过期 {formatRelativeDays(item.expiryDate)}</span>
                        <span>{INVENTORY_STATUS_LABELS[item.status]}</span>
                        <span>购 {formatDate(item.purchaseDate)}</span>
                        <span>到期 {formatDate(item.expiryDate)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="当前没有可销毁的批次"
                  description={props.emptyDescription ?? '这份食材现在没有“已过期且仍有剩余量”的批次，可以直接关闭这个面板。'}
                />
              )}
            </section>
          </div>
        </form>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

export { DestroyExpiredInventoryDialog as IngredientDestroyExpiredOverlay };
```

- [ ] **Step 4: Update ingredient workspace caller**

In `frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx`, keep the existing import name and update props:

```tsx
{isDestroyExpiredOverlay && selectedDestroyExpiredSummary && (
  <IngredientDestroyExpiredOverlay
    closeOverlay={props.closeOverlay}
    summary={selectedDestroyExpiredSummary}
    previewUrl={selectedDestroyExpiredPreview}
    meta={selectedDestroyExpiredMeta}
    items={destroyExpiredItems}
    headline={destroyExpiredPresentation?.headline ?? '未登记'}
    submit={props.submitDestroyExpired}
    isSubmitting={props.isDisposingExpiredInventory}
  />
)}
```

- [ ] **Step 5: Replace homepage expired-disposal inline modal**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`:

If the current branch still has `DestroyExpiredLoadMoreRow` or `useDestroyExpiredBatchRendering` imports in `HomeDashboardDialogs.tsx`, remove them because the shared dialog renders the current compact row UI directly.

Add this import:

```tsx
import { DestroyExpiredInventoryDialog } from '../../components/ingredients/IngredientDestroyExpiredOverlay';
```

Remove `today` and `homeExpiredDisposalFormId` only if they are not used by other homepage dialogs after the inline expired-disposal JSX is removed.

Replace the `props.homeExpiredDisposalSummary` block with:

```tsx
{props.homeExpiredDisposalSummary && (
  <DestroyExpiredInventoryDialog
    closeOverlay={() => props.setHomeExpiredDisposalIngredientId(null)}
    summary={props.homeExpiredDisposalSummary}
    previewUrl={props.resolveAssetUrl(props.homeExpiredDisposalSummary.ingredient.image?.url)}
    meta={[
      props.homeExpiredDisposalSummary.ingredient.category || '未分类',
      props.homeExpiredDisposalSummary.primaryStorage,
    ]}
    items={props.homeExpiredDisposalItems}
    headline={props.homeExpiredDisposalSummary.quantitySummaries[0]?.label ?? '当前已空'}
    submit={props.submitHomeExpiredDisposal}
    isSubmitting={props.isDisposingExpiredInventory}
    formId="home-expired-disposal-overlay-form"
    overlayRootClassName="home-dashboard-overlay-root"
    description="会将这些过期批次的剩余量清零，但保留批次历史记录和活动日志。"
    footerSummaryIntro="确认后将处理"
    footerSummaryDetail="系统会把这些批次的剩余量清零，并在刷新后同步库存状态。"
    summaryMetrics={
      <>
        <article className="destroy-expired-summary-metric is-primary">
          <span>本次处理范围</span>
          <strong>{props.homeExpiredDisposalItems.length} 条过期批次</strong>
          <p>仅包含已经过期且当前仍有剩余量的批次。</p>
        </article>
        <article className="destroy-expired-summary-metric">
          <span>处理结果</span>
          <strong>清零剩余量</strong>
          <p>批次记录、备注和活动日志都会继续保留。</p>
        </article>
      </>
    }
    listTitle="将要销毁的批次"
    listDescription="只列出已经过期且当前仍有剩余量的批次；今天到期和未来到期不会出现在这里。"
  />
)}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm --prefix frontend run test -- DestroyExpiredInventoryDialog.test.tsx workspaceModel.test.ts
npm --prefix frontend run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ingredients/DestroyExpiredInventoryDialog.test.tsx frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx frontend/src/components/ingredients/IngredientWorkspaceOverlays.tsx frontend/src/features/home/HomeDashboardDialogs.tsx
git commit -m "refactor: share expired inventory disposal dialog"
```

---

### Task 3: Shared Ingredient Restock Sections

**Files:**
- Create: `frontend/src/components/ingredients/IngredientRestockSections.tsx`
- Create: `frontend/src/components/ingredients/IngredientRestockSections.test.tsx`
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts`

**Interfaces:**
- Consumes:
  - Existing `Ingredient`, `IngredientExpiryMode`, `IngredientUnitConversion`, `InventoryStatus`.
  - Existing `QuantityUnitField`, `OptionChipGroup`, `ComboboxField`, `TouchRangeField`, `DropdownSelect`.
- Produces:
  - `IngredientRestockIdentitySection`
  - `IngredientRestockQuantitySection`
  - `IngredientRestockPurchaseSection`
  - `IngredientRestockStorageSection`
  - `IngredientRestockExpirySection`
  - `IngredientRestockAdvancedSection`

- [ ] **Step 1: Write focused tests**

Create `frontend/src/components/ingredients/IngredientRestockSections.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '../../api/types';
import {
  IngredientRestockAdvancedSection,
  IngredientRestockExpirySection,
  IngredientRestockPurchaseSection,
  IngredientRestockQuantitySection,
} from './IngredientRestockSections';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const trackedIngredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [{ unit: '斤', ratio_to_default: 4 }],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const presenceOnlyIngredient: Ingredient = {
  ...trackedIngredient,
  id: 'ingredient-salt',
  name: '盐',
  quantity_tracking_mode: 'not_track_quantity',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('IngredientRestockSections', () => {
  it('shows presence-only quantity copy without enabling numeric entry', () => {
    const view = render(
      <IngredientRestockQuantitySection
        ingredient={presenceOnlyIngredient}
        quantity="1"
        unit="袋"
        unitOptions={[{ value: '袋', label: '袋' }]}
        selectedUnit={null}
        normalizedQuantity={null}
        onQuantityChange={vi.fn()}
        onUnitChange={vi.fn()}
      />
    );

    expect(view.textContent).toContain('这个食材只记录是否有库存，不填写具体数量。');
    expect(view.querySelector<HTMLInputElement>('input[type="number"]')?.disabled).toBe(true);
  });

  it('emits purchase preset changes', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockPurchaseSection
        purchaseDate="2026-07-07"
        purchaseDatePreset="today"
        onChange={onChange}
      />
    );

    act(() => {
      Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '昨天')?.click();
    });

    expect(onChange).toHaveBeenCalledWith({ purchaseDatePreset: 'yesterday' });
  });

  it('renders expiry day controls and emits day changes', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockExpirySection
        expiryInputMode="days"
        expiryDays="3"
        expiryDate="2026-07-10"
        purchaseDate="2026-07-07"
        defaultExpiryDays={3}
        expiryDaysValue={3}
        onChange={onChange}
      />
    );

    expect(view.textContent).toContain('预计到期日');
    act(() => {
      const input = view.querySelector<HTMLInputElement>('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '7');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ expiryDays: '7' });
  });

  it('keeps advanced status and notes callbacks separate', () => {
    const onChange = vi.fn();
    const view = render(
      <IngredientRestockAdvancedSection
        open
        status="fresh"
        notes=""
        onOpenChange={vi.fn()}
        onChange={onChange}
      />
    );

    const textarea = view.querySelector<HTMLTextAreaElement>('textarea');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '冷藏第二层');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith({ notes: '冷藏第二层' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix frontend run test -- IngredientRestockSections.test.tsx
```

Expected: FAIL because `IngredientRestockSections.tsx` does not exist.

- [ ] **Step 3: Create restock section components**

Create `frontend/src/components/ingredients/IngredientRestockSections.tsx` with this public API:

```tsx
import type { Ingredient, IngredientExpiryMode, InventoryStatus } from '../../api/types';
import { addDateKeyDays } from '../../lib/date';
import { tracksIngredientQuantity } from '../../lib/ingredientTracking';
import { formatDate, INVENTORY_STATUS_LABELS, todayKey } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import {
  ActionButton,
  Badge,
  ComboboxField,
  DropdownSelect,
  OptionChipGroup,
  QuantityUnitField,
  TouchRangeField,
} from '../ui-kit';
import {
  formatNumericString,
  INVENTORY_STORAGE_PRESETS,
  resolveExpiryDateFromDays,
  type InventoryPurchasePreset,
} from './ingredientWorkspaceForms';

export type RestockUnitOption = { value: string; label: string };
export type RestockPatch = Record<string, string | boolean | InventoryStatus | IngredientExpiryMode | InventoryPurchasePreset>;

export function IngredientRestockIdentitySection(props: {
  ingredient: Ingredient | null;
  previewUrl?: string;
  meta: string[];
  badgeLabel: string;
  canSwitch?: boolean;
  onSwitch?: () => void;
}) {
  if (!props.ingredient) return null;

  return (
    <section className="ingredients-restock-identity-card">
      <div className="ingredients-restock-identity-media">
        <MediaWithPlaceholder src={props.previewUrl} alt={props.ingredient.name} />
      </div>
      <div className="ingredients-restock-identity-copy">
        <div className="ingredients-restock-identity-head">
          <div>
            <h4>{props.ingredient.name}</h4>
            <p>{props.meta.join(' · ')}</p>
          </div>
          <Badge>{props.badgeLabel}</Badge>
        </div>
        {props.canSwitch && props.onSwitch ? (
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            className="ingredients-restock-identity-switch"
            onClick={props.onSwitch}
          >
            换一个食材
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}

export function IngredientRestockQuantitySection(props: {
  ingredient: Ingredient | null;
  quantity: string;
  unit: string;
  unitOptions: RestockUnitOption[];
  selectedUnit: { unit: string } | null;
  normalizedQuantity: number | null;
  onQuantityChange: (quantity: string) => void;
  onUnitChange: (unit: string) => void;
}) {
  const tracksQuantity = tracksIngredientQuantity(props.ingredient);
  const displayUnit = props.unit || props.ingredient?.default_unit || '个';

  return (
    <section className="ingredients-restock-field-group ingredients-restock-quantity-section">
      <div className="ingredients-restock-quantity-row">
        <QuantityUnitField
          className="ingredients-restock-quantity-field"
          quantity={props.quantity}
          unit={displayUnit}
          unitOptions={props.unitOptions}
          quantityDisabled={!tracksQuantity}
          quantityDisabledReason={!tracksQuantity ? '这个食材只记录是否有库存，不填写具体数量。' : undefined}
          onQuantityChange={props.onQuantityChange}
          onUnitChange={props.onUnitChange}
        />
        <section className="ingredients-restock-unit-card">
          <div className="ingredients-restock-unit-card-head">
            <span>单位</span>
            <strong>{displayUnit}</strong>
          </div>
          <p className="subtle">
            {props.ingredient
              ? props.selectedUnit?.unit === props.ingredient.default_unit
                ? '默认按主单位直接记库存'
                : props.normalizedQuantity !== null
                  ? `将记为 ${formatNumericString(props.normalizedQuantity)}${props.ingredient.default_unit} 库存`
                  : '切换单位后会自动折算到主单位'
              : '先选食材，再切换这次录入单位。'}
          </p>
        </section>
      </div>
    </section>
  );
}

export function IngredientRestockPurchaseSection(props: {
  purchaseDate: string;
  purchaseDatePreset: InventoryPurchasePreset;
  onChange: (patch: Partial<{ purchaseDate: string; purchaseDatePreset: InventoryPurchasePreset }>) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>购买时间</span>
        <p className="subtle">默认今天，需要时再改。</p>
      </div>
      <OptionChipGroup
        ariaLabel="购买时间"
        value={props.purchaseDatePreset}
        options={[
          { value: 'today', label: '今天' },
          { value: 'yesterday', label: '昨天' },
          { value: 'custom', label: '自定义' },
        ]}
        className="ingredients-restock-choice-row"
        onChange={(purchaseDatePreset) => props.onChange({ purchaseDatePreset: purchaseDatePreset as InventoryPurchasePreset })}
      />
      {props.purchaseDatePreset === 'custom' ? (
        <label>
          <span>购买日期</span>
          <input
            className="text-input"
            type="date"
            required
            value={props.purchaseDate}
            onChange={(event) => props.onChange({ purchaseDate: event.target.value, purchaseDatePreset: 'custom' })}
          />
        </label>
      ) : null}
    </section>
  );
}

export function IngredientRestockStorageSection(props: {
  storageLocation: string;
  onChange: (storageLocation: string) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>存放位置</span>
        <p className="subtle">按这次实际放的位置点一下。</p>
      </div>
      <ComboboxField
        ariaLabel="保存位置"
        placeholder="选择或输入保存位置"
        value={props.storageLocation}
        options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
        allowCustom
        onChange={(storageLocation) => props.onChange(String(storageLocation))}
      />
    </section>
  );
}

export function IngredientRestockExpirySection(props: {
  expiryInputMode: IngredientExpiryMode;
  expiryDays: string;
  expiryDate: string;
  purchaseDate: string;
  defaultExpiryDays?: number | null;
  expiryDaysValue: number;
  onChange: (patch: Partial<{ expiryInputMode: IngredientExpiryMode; expiryDays: string; expiryDate: string }>) => void;
}) {
  return (
    <section className="ingredients-restock-field-group">
      <div className="ingredients-restock-field-head">
        <span>到期信息</span>
        <p className="subtle">确认这批食材怎么跟踪到期。</p>
      </div>
      <OptionChipGroup
        ariaLabel="到期信息"
        value={props.expiryInputMode}
        options={[
          { value: 'none', label: '不记录' },
          { value: 'days', label: '几天后到期' },
          { value: 'manual_date', label: '包装到期日' },
        ]}
        className="ingredients-restock-choice-row"
        onChange={(expiryInputMode) => {
          const nextMode = expiryInputMode as IngredientExpiryMode;
          const nextDays = nextMode === 'days' ? props.expiryDays || String(props.defaultExpiryDays ?? 3) : '';
          props.onChange({
            expiryInputMode: nextMode,
            expiryDays: nextDays,
            expiryDate:
              nextMode === 'manual_date'
                ? props.expiryDate
                : nextMode === 'days'
                  ? resolveExpiryDateFromDays(props.purchaseDate, nextDays)
                  : '',
          });
        }}
      />
      {props.expiryInputMode === 'days' ? (
        <div className="ingredients-restock-expiry-grid">
          <TouchRangeField
            label="买后几天到期"
            value={props.expiryDaysValue}
            min={1}
            max={30}
            step={1}
            marks={[1, 3, 7, 14, 30]}
            formatValue={(value) => `${value} 天`}
            onChange={(value) => props.onChange({ expiryDays: String(value) })}
          />
          <div className="ingredients-restock-result-card">
            <span>预计到期日</span>
            <strong>{props.expiryDate ? formatDate(props.expiryDate) : '先选天数'}</strong>
            <p>{props.expiryDate ? `${props.purchaseDate} 购入` : '拖动后会自动换算日期'}</p>
          </div>
        </div>
      ) : props.expiryInputMode === 'manual_date' ? (
        <label>
          <span>包装到期日</span>
          <input
            className="text-input"
            type="date"
            required
            value={props.expiryDate}
            onChange={(event) => props.onChange({ expiryDate: event.target.value })}
          />
        </label>
      ) : (
        <p className="ingredients-restock-field-note">这批不跟踪到期提醒。</p>
      )}
    </section>
  );
}

export function IngredientRestockAdvancedSection(props: {
  open: boolean;
  status: InventoryStatus;
  notes: string;
  onOpenChange: (open: boolean) => void;
  onChange: (patch: Partial<{ status: InventoryStatus; notes: string; statusDirty: boolean }>) => void;
}) {
  const statusOptions = Object.entries(INVENTORY_STATUS_LABELS).map(([key, label]) => ({ value: key, label }));

  return (
    <section className="ingredients-modal-advanced">
      <button
        className="ghost-button ingredients-modal-advanced-toggle"
        type="button"
        onClick={() => props.onOpenChange(!props.open)}
      >
        {props.open ? '收起更多选项' : '更多选项'}
      </button>
      {props.open ? (
        <div className="ingredients-modal-advanced-fields">
          <div className="ingredients-restock-status-custom-field">
            <span>状态</span>
            <DropdownSelect
              ariaLabel="选择状态"
              placeholder="选择状态"
              value={props.status}
              options={statusOptions}
              onChange={(val) => props.onChange({ status: val as InventoryStatus, statusDirty: true })}
            />
          </div>
          <label className="span-two">
            <span>备注</span>
            <textarea
              className="text-input"
              rows={3}
              value={props.notes}
              onChange={(event) => props.onChange({ notes: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}

export function resolvePurchaseDatePatch(patch: Partial<{ purchaseDate: string; purchaseDatePreset: InventoryPurchasePreset }>) {
  if (patch.purchaseDatePreset === 'today') return { purchaseDatePreset: 'today' as const, purchaseDate: todayKey() };
  if (patch.purchaseDatePreset === 'yesterday') return { purchaseDatePreset: 'yesterday' as const, purchaseDate: addDateKeyDays(todayKey(), -1) };
  return patch;
}
```

- [ ] **Step 4: Use sections inside `IngredientInventoryOverlay`**

In `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`, replace the internal identity, quantity, purchase, storage, expiry, and advanced JSX with the new section components. Keep the quick restock strip and search picker in place.

Use this shape for the section calls:

```tsx
<IngredientRestockIdentitySection
  ingredient={props.selectedInventoryIngredient}
  previewUrl={props.selectedIngredientPreview}
  meta={props.selectedIngredientMeta}
  badgeLabel={props.inventoryForm.ingredientLocked ? '当前食材' : '已选食材'}
  canSwitch={!props.inventoryForm.ingredientLocked}
  onSwitch={() => props.syncInventoryIngredient(null, '')}
/>

<IngredientRestockQuantitySection
  ingredient={props.selectedInventoryIngredient}
  quantity={props.inventoryForm.quantity}
  unit={props.inventoryForm.unit || props.selectedInventoryIngredient?.default_unit || '个'}
  unitOptions={inventoryQuantityUnitOptions}
  selectedUnit={props.selectedInventoryUnit}
  normalizedQuantity={props.inventoryNormalizedQuantity}
  onQuantityChange={(quantity) => props.setInventoryForm({ ...props.inventoryForm, quantity })}
  onUnitChange={(unit) => props.setInventoryForm({ ...props.inventoryForm, unit })}
/>

<IngredientRestockPurchaseSection
  purchaseDate={props.inventoryForm.purchaseDate}
  purchaseDatePreset={props.inventoryForm.purchaseDatePreset}
  onChange={(patch) => props.setInventoryForm({ ...props.inventoryForm, ...resolvePurchaseDatePatch(patch) })}
/>

<IngredientRestockStorageSection
  storageLocation={props.inventoryForm.storageLocation}
  onChange={(storageLocation) => props.setInventoryForm({ ...props.inventoryForm, storageLocation })}
/>

<IngredientRestockExpirySection
  expiryInputMode={props.inventoryForm.expiryInputMode}
  expiryDays={props.inventoryForm.expiryDays}
  expiryDate={props.inventoryForm.expiryDate}
  purchaseDate={props.inventoryForm.purchaseDate}
  defaultExpiryDays={props.selectedInventoryIngredient?.default_expiry_days}
  expiryDaysValue={props.inventoryExpiryDaysValue}
  onChange={(patch) => props.setInventoryForm({ ...props.inventoryForm, ...patch })}
/>

<IngredientRestockAdvancedSection
  open={props.inventoryAdvancedOpen}
  status={props.inventoryForm.status}
  notes={props.inventoryForm.notes}
  onOpenChange={props.setInventoryAdvancedOpen}
  onChange={(patch) => props.setInventoryForm({ ...props.inventoryForm, ...patch })}
/>
```

- [ ] **Step 5: Use sections inside the homepage restock modal**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`, keep the homepage-specific source note and ingredient search selector. Replace duplicated quantity, purchase date, storage, expiry, status, and notes sections with the same `IngredientRestock*Section` calls.

For homepage purchase date, adapt `HomeRestockFormState` to a preset:

```tsx
const homePurchaseDatePreset =
  homeRestockForm.purchaseDate === today
    ? 'today'
    : homeRestockForm.purchaseDate === addDateKeyDays(today, -1)
      ? 'yesterday'
      : 'custom';
```

Use:

```tsx
<IngredientRestockPurchaseSection
  purchaseDate={homeRestockForm.purchaseDate}
  purchaseDatePreset={homePurchaseDatePreset}
  onChange={(patch) => {
    const resolvedPatch = resolvePurchaseDatePatch(patch);
    const purchaseDate = resolvedPatch.purchaseDate ?? homeRestockForm.purchaseDate;
    props.updateHomeRestockForm({
      ...homeRestockForm,
      purchaseDate,
      expiryDate:
        homeRestockForm.expiryInputMode === 'days'
          ? resolveExpiryDateFromDays(purchaseDate, homeRestockForm.expiryDays)
          : homeRestockForm.expiryDate,
    });
  }}
/>
```

Keep homepage's submit validation and `submitHomeRestock` unchanged.

- [ ] **Step 6: Update static usage test**

Run:

```bash
npm --prefix frontend run test -- SearchableResourceSelectUsage.test.ts
```

If it fails because `HomeDashboardDialogs.tsx` no longer directly uses `SearchableResourceSelect`, update `frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts` to remove `src/features/home/HomeDashboardDialogs.tsx` from only the assertions that inspect direct call sites.

- [ ] **Step 7: Run task tests**

Run:

```bash
npm --prefix frontend run test -- IngredientRestockSections.test.tsx SearchableResourceSelectUsage.test.ts
npm --prefix frontend run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ingredients/IngredientRestockSections.tsx frontend/src/components/ingredients/IngredientRestockSections.test.tsx frontend/src/components/ingredients/IngredientInventoryOverlay.tsx frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts
git commit -m "refactor: share ingredient restock form sections"
```

---

### Task 4: Shared Food Plan Dialog Parts

**Files:**
- Create: `frontend/src/components/foods/FoodPlanDialogParts.tsx`
- Create: `frontend/src/components/foods/FoodPlanDialogParts.test.tsx`
- Modify: `frontend/src/components/foods/FoodPlanDialog.tsx`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`

**Interfaces:**
- Consumes: `Food`, `MealType`, `Recipe`, `SearchableResourceSelect`, `useFoodResourceSearch`.
- Produces:
  - `FoodPlanSelectedHero`
  - `FoodPlanFoodPicker`
  - `FoodPlanDateMealNoteFields`

- [ ] **Step 1: Write tests for shared parts**

Create `frontend/src/components/foods/FoodPlanDialogParts.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import { FoodPlanDateMealNoteFields, FoodPlanSelectedHero } from './FoodPlanDialogParts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const food: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  suitable_meal_types: ['dinner'],
  recipe_id: 'recipe-1',
  source_name: '',
  purchase_source: '',
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('FoodPlanDialogParts', () => {
  it('renders selected food hero and exposes the change action', () => {
    const onClear = vi.fn();
    const view = render(
      <FoodPlanSelectedHero
        food={food}
        coverUrl={undefined}
        coverSrcSet={undefined}
        coverSizes={undefined}
        typeLabel="家常菜"
        sourceLabel="家庭厨房"
        capabilityLabel="有菜谱"
        iconKind="bookOpen"
        onClear={onClear}
      />
    );

    expect(view.textContent).toContain('即将加入');
    expect(view.textContent).toContain('番茄炒蛋');
    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '修改')?.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('emits date meal and note changes from one shared field block', () => {
    const onPlanDateChange = vi.fn();
    const onMealTypeChange = vi.fn();
    const onPlanNoteChange = vi.fn();
    const view = render(
      <FoodPlanDateMealNoteFields
        planDate="2026-07-07"
        mealType="dinner"
        note=""
        todayDate="2026-07-07"
        planDateOptions={[
          { value: '2026-07-07', label: '今天', display: '07/07' },
          { value: '2026-07-08', label: '周三', display: '07/08' },
        ]}
        mealOptions={[
          { value: 'breakfast', label: '早餐' },
          { value: 'dinner', label: '晚餐' },
        ]}
        notePlaceholder="比如：少油、常点套餐、提前解冻"
        onPlanDateChange={onPlanDateChange}
        onMealTypeChange={onMealTypeChange}
        onPlanNoteChange={onPlanNoteChange}
      />
    );

    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('07/08'))?.click());
    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '早餐')?.click());
    const input = view.querySelector<HTMLInputElement>('input.text-input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '提前解冻');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onPlanDateChange).toHaveBeenCalledWith('2026-07-08');
    expect(onMealTypeChange).toHaveBeenCalledWith('breakfast');
    expect(onPlanNoteChange).toHaveBeenCalledWith('提前解冻');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix frontend run test -- FoodPlanDialogParts.test.tsx
```

Expected: FAIL because `FoodPlanDialogParts.tsx` does not exist.

- [ ] **Step 3: Create shared food-plan parts**

Create `frontend/src/components/foods/FoodPlanDialogParts.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { Food, MealType } from '../../api/types';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { SearchableResourceSelect } from '../ui-kit';
import { FOOD_TYPE_LABELS, MEAL_TYPE_LABELS } from '../../lib/ui';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

export type FoodPlanDateOption = {
  value: string;
  label: string;
  display: string;
};

export type FoodPlanMealOption = {
  value: MealType;
  label: string;
};

export function FoodPlanSelectedHero(props: {
  food: Food;
  coverUrl?: string;
  coverSrcSet?: string;
  coverSizes?: string;
  typeLabel: string;
  sourceLabel: string;
  capabilityLabel: string;
  iconKind: 'bookOpen' | 'clipboard';
  onClear: () => void;
}) {
  return (
    <div className="recipe-plan-dialog-hero">
      <div className="recipe-plan-selected-cover">
        <MediaWithPlaceholder src={props.coverUrl} srcSet={props.coverSrcSet} sizes={props.coverSizes} alt={props.food.name} />
      </div>
      <div className="recipe-plan-selected-copy">
        <span className="recipe-plan-dialog-kicker">即将加入</span>
        <strong>{props.food.name}</strong>
        <div className="recipe-plan-selected-meta">
          <span>
            <FoodUiIcon name="home" />
            {props.typeLabel}
          </span>
          <span>
            <FoodUiIcon name="cloche" />
            {props.sourceLabel}
          </span>
          <span>
            <FoodUiIcon name={props.iconKind} />
            {props.capabilityLabel}
          </span>
        </div>
      </div>
      <button className="recipe-plan-change-food" type="button" onClick={props.onClear}>
        修改
      </button>
      <FoodUiIcon name="cloche" className="recipe-plan-selected-ornament" />
    </div>
  );
}

export function FoodPlanFoodPicker(props: {
  searchInputId: string;
  value: string;
  query: string;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  options: Array<{ id: string; label: string; description: string; image: ReactNode }>;
  emptyText: string;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onQueryChange: (value: string) => void;
  onLoadMore: () => void;
  onChange: (foodId: string) => void;
}) {
  return (
    <div className="recipe-plan-picker">
      <label htmlFor={props.searchInputId}>选择食物</label>
      <SearchableResourceSelect
        searchInputId={props.searchInputId}
        ariaLabel="选择食物"
        placeholder="搜索食物、来源、场景或备注"
        value={props.value}
        query={props.query}
        presentation="popover"
        loading={props.loading}
        loadingMore={props.loadingMore}
        hasMore={props.hasMore}
        loadMoreText="加载更多食物"
        loadingMoreText="正在加载更多食物..."
        options={props.options}
        emptyText={props.emptyText}
        onSearchCompositionStart={props.onCompositionStart}
        onSearchCompositionEnd={props.onCompositionEnd}
        onQueryChange={props.onQueryChange}
        onLoadMore={props.onLoadMore}
        onChange={props.onChange}
      />
    </div>
  );
}

export function FoodPlanDateMealNoteFields(props: {
  planDate: string;
  mealType: MealType;
  note: string;
  todayDate: string;
  planDateOptions: FoodPlanDateOption[];
  mealOptions: FoodPlanMealOption[];
  notePlaceholder: string;
  onPlanDateChange: (date: string) => void;
  onMealTypeChange: (mealType: MealType) => void;
  onPlanNoteChange: (note: string) => void;
}) {
  return (
    <>
      <div className="recipe-plan-form-row">
        <label className="recipe-plan-date-field">
          <span>计划日期</span>
          <div className="recipe-plan-date-strip" role="radiogroup" aria-label="计划日期">
            {props.planDateOptions.map((date) => (
              <button
                key={date.value}
                type="button"
                className={props.planDate === date.value ? 'active' : ''}
                aria-pressed={props.planDate === date.value}
                onClick={() => props.onPlanDateChange(date.value)}
              >
                <span>{date.value === props.todayDate ? '今天' : date.label}</span>
                <strong>{date.display}</strong>
              </button>
            ))}
          </div>
        </label>
        <label className="recipe-plan-meal-field">
          <span>餐次</span>
          <div className="recipe-plan-meal-segment" role="radiogroup" aria-label="餐次">
            {props.mealOptions.map((item) => (
              <button
                key={item.value}
                type="button"
                className={props.mealType === item.value ? 'active' : ''}
                aria-pressed={props.mealType === item.value}
                onClick={() => props.onMealTypeChange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </label>
      </div>
      <label className="recipe-plan-note-field">
        <span>备注</span>
        <input
          className="text-input"
          value={props.note}
          placeholder={props.notePlaceholder}
          onChange={(event) => props.onPlanNoteChange(event.target.value)}
        />
      </label>
    </>
  );
}

export function buildFoodPlanTypeLabel(food: Food) {
  return FOOD_TYPE_LABELS[food.type];
}

export function buildFoodPlanSourceLabel(food: Food) {
  return food.source_name || food.purchase_source || food.category || '常吃食物';
}

export function buildFoodPlanCapabilityLabel(food: Food) {
  return food.recipe_id ? '有菜谱' : '可直接记录';
}

export function buildFoodPlanMealOptions(values: MealType[]) {
  return values.map((value) => ({ value, label: MEAL_TYPE_LABELS[value] }));
}
```

- [ ] **Step 4: Refactor `FoodPlanDialog` to use parts**

In `frontend/src/components/foods/FoodPlanDialog.tsx`, replace selected hero, picker, and date/meal/note JSX with:

```tsx
{props.selectedPlanFood ? (
  <FoodPlanSelectedHero
    food={props.selectedPlanFood}
    coverUrl={selectedPlanFoodCoverUrl}
    coverSrcSet={buildMediaSrcSet(selectedPlanFoodCoverAsset)}
    coverSizes={buildMediaSizes('card')}
    typeLabel={FOOD_TYPE_LABELS[props.normalizeFoodType(props.selectedPlanFood)]}
    sourceLabel={
      props.selectedPlanFood.source_name ||
      props.selectedPlanFood.purchase_source ||
      (props.normalizeFoodType(props.selectedPlanFood) === 'selfMade'
        ? '家庭厨房'
        : props.selectedPlanFood.category || '常吃食物')
    }
    capabilityLabel={props.selectedPlanFood.recipe_id ? '有菜谱' : '可直接记录'}
    iconKind={props.selectedPlanFood.recipe_id ? 'bookOpen' : 'clipboard'}
    onClear={props.onClearPlanFoodSelection}
  />
) : (
  <FoodPlanFoodPicker
    searchInputId="food-plan-search"
    value={props.planForm.foodId}
    query={props.planFoodSearch}
    loading={foodSearch.isSearching}
    loadingMore={foodSearch.isFetchingNextPage}
    hasMore={foodSearch.hasMore}
    options={foodSearch.foods.map((food) => {
      const coverAsset = props.getFoodCoverAsset?.(food, props.recipes);
      const cover = resolveMediaUrl(coverAsset, 'thumb') ?? props.resolveFoodAssetUrl(props.getFoodCover(food, props.recipes) ?? '');
      return {
        id: food.id,
        label: food.name,
        description: [
          FOOD_TYPE_LABELS[props.normalizeFoodType(food)],
          food.source_name || food.purchase_source || food.category,
          food.recipe_id ? '可开始做' : '可记到今天',
          MEAL_TYPE_LABELS[props.getDefaultMealType(food)],
        ].filter(Boolean).join(' · '),
        image: <MediaWithPlaceholder src={cover} srcSet={buildMediaSrcSet(coverAsset)} sizes={buildMediaSizes('thumb')} alt="" />,
      };
    })}
    emptyText={foodSearch.isSearching ? '正在搜索...' : '没有找到匹配的食物'}
    onCompositionStart={foodSearch.onCompositionStart}
    onCompositionEnd={foodSearch.onCompositionEnd}
    onQueryChange={props.onPlanFoodSearchChange}
    onLoadMore={() => {
      if (foodSearch.hasMore && !foodSearch.isFetchingNextPage) void foodSearch.fetchNextPage();
    }}
    onChange={(foodId) => {
      const food = foodSearch.findFoodById(foodId);
      if (food) props.onSelectPlanFood(food);
    }}
  />
)}

<FoodPlanDateMealNoteFields
  planDate={props.planForm.planDate}
  mealType={props.planForm.mealType}
  note={props.planForm.note}
  todayDate={props.todayDate}
  planDateOptions={props.planDateOptions.map((date) => {
    const dateParts = props.getPlanDateParts(date);
    return { value: date, label: dateParts.weekday, display: `${dateParts.month}/${dateParts.day}` };
  })}
  mealOptions={MEAL_OPTIONS}
  notePlaceholder="比如：少油、常点套餐、提前解冻"
  onPlanDateChange={props.onPlanDateChange}
  onMealTypeChange={props.onMealTypeChange}
  onPlanNoteChange={props.onPlanNoteChange}
/>
```

- [ ] **Step 5: Refactor homepage food-plan add dialog**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`, use `FoodPlanSelectedHero`, `FoodPlanFoodPicker`, and `FoodPlanDateMealNoteFields` in the `isHomePlanAddDialogOpen` modal. Keep homepage submit and state callbacks unchanged.

Use this date option adapter:

```tsx
planDateOptions={props.dashboardPlanDays.map((day) => ({
  value: day.date,
  label: day.isToday ? '今天' : `周${day.weekday}`,
  display: day.date.slice(5).replace('-', '/'),
}))}
```

Use this meal option adapter:

```tsx
mealOptions={DASHBOARD_PLAN_MEAL_TYPES.map((value) => ({ value, label: MEAL_TYPE_LABELS[value] }))}
```

- [ ] **Step 6: Run task tests**

Run:

```bash
npm --prefix frontend run test -- FoodPlanDialogParts.test.tsx SearchableResourceSelectUsage.test.ts
npm --prefix frontend run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/foods/FoodPlanDialogParts.tsx frontend/src/components/foods/FoodPlanDialogParts.test.tsx frontend/src/components/foods/FoodPlanDialog.tsx frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts
git commit -m "refactor: share food plan dialog parts"
```

---

### Task 5: Shared Meal Enrichment Modal

**Files:**
- Create: `frontend/src/features/meals/MealEnrichmentModal.tsx`
- Create: `frontend/src/features/meals/MealEnrichmentModal.test.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`

**Interfaces:**
- Consumes:
  - `MealEnrichmentForm` and `MealSource`.
  - `MealLog`, `Member`, `UpdateMealLogPayload`.
  - `WorkspaceOverlayFrame` and `WorkspaceModal`.
- Produces:
  - `MealEnrichmentModal(props: MealEnrichmentModalProps): JSX.Element | null`
  - Props include `open`, `meal`, `source`, `members`, `isUpdating`, `updateMealLog`, `onClose`, optional `requireMeaningfulInput`, `onInvalidSave`, `overlayRootClassName`, and `formId`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/meals/MealEnrichmentModal.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MealLog, Member } from '../../api/types';
import { MealEnrichmentModal } from './MealEnrichmentModal';
import type { MealSource } from './MealLogEnrichment';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const meal: MealLog = {
  id: 'meal-1',
  family_id: 'family-1',
  date: '2026-07-07',
  meal_type: 'dinner',
  food_entries: [{ id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: null }],
  participant_user_ids: [],
  notes: '',
  mood: '',
  photos: [],
  deduction_suggestions: [],
  created_at: '2026-07-07T12:00:00Z',
  updated_at: '2026-07-07T12:00:00Z',
};

const members: Member[] = [];
const source: MealSource = { status: 'planned', label: '菜单计划' };

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderModal(open = true) {
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MealEnrichmentModal
        open={open}
        meal={meal}
        source={source}
        members={members}
        isUpdating={false}
        updateMealLog={vi.fn(async () => undefined)}
        onClose={onClose}
        overlayRootClassName="home-dashboard-overlay-root"
        formId="test-meal-enrichment-form"
      />
    );
  });
  return { onClose, view: container };
}

describe('MealEnrichmentModal', () => {
  it('wraps MealEnrichmentForm with the shared modal footer', () => {
    const { view } = renderModal();

    expect(view.textContent).toContain('补充记录');
    expect(view.textContent).toContain('保存后，本次补充记录将会出现在记录时间线中');
    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.getAttribute('form')).toBe('test-meal-enrichment-form');
  });

  it('renders nothing when closed', () => {
    const { view } = renderModal(false);
    expect(view.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix frontend run test -- MealEnrichmentModal.test.tsx
```

Expected: FAIL because `MealEnrichmentModal.tsx` does not exist.

- [ ] **Step 3: Add shared modal**

Create `frontend/src/features/meals/MealEnrichmentModal.tsx`:

```tsx
import type { MealLog, Member, UpdateMealLogPayload } from '../../api/types';
import { FormActions, WorkspaceModal, WorkspaceOverlayFrame } from '../../components/ui-kit';
import { MealEnrichmentForm, type MealSource } from './MealLogEnrichment';

export type MealEnrichmentModalProps = {
  open: boolean;
  meal: MealLog | null;
  source: MealSource | null;
  members: Member[];
  isUpdating: boolean;
  updateMealLog: (mealLogId: string, payload: UpdateMealLogPayload) => Promise<unknown>;
  onClose: () => void;
  requireMeaningfulInput?: boolean;
  onInvalidSave?: () => void;
  overlayRootClassName?: string;
  formId?: string;
};

export function MealEnrichmentModal(props: MealEnrichmentModalProps) {
  if (!props.open || !props.meal || !props.source) return null;

  const formId = props.formId ?? 'meal-log-enrichment-overlay-form';

  return (
    <WorkspaceOverlayFrame rootClassName={props.overlayRootClassName} onClose={props.onClose}>
      <WorkspaceModal
        title="补充记录"
        description="为这次待补充记录添加评价、家人、照片和评论"
        className="meal-log-modal meal-log-enrich-modal"
        closeAriaLabel="关闭"
        onClose={props.onClose}
        footerInfo={<span>保存后，本次补充记录将会出现在记录时间线中</span>}
        footerActions={
          <FormActions
            className="meal-enrichment-actions"
            primaryLabel="保存记录"
            primaryType="submit"
            primaryForm={formId}
            isSubmitting={props.isUpdating}
            secondaryLabel="稍后再说"
            onSecondary={props.onClose}
          />
        }
      >
        <MealEnrichmentForm
          formId={formId}
          showFooter={false}
          meal={props.meal}
          members={props.members}
          source={props.source}
          isUpdating={props.isUpdating}
          updateMealLog={props.updateMealLog}
          requireMeaningfulInput={props.requireMeaningfulInput}
          onInvalidSave={props.onInvalidSave}
          onCancel={props.onClose}
          onSaved={props.onClose}
        />
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}
```

- [ ] **Step 4: Use it in homepage dialogs**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`, replace the `homeMealEnrichmentMeal && homeMealEnrichmentSource` inline modal with:

```tsx
<MealEnrichmentModal
  open={Boolean(props.homeMealEnrichmentMeal && props.homeMealEnrichmentSource)}
  meal={props.homeMealEnrichmentMeal}
  source={props.homeMealEnrichmentSource}
  members={props.homeMealEnrichmentMembers}
  isUpdating={props.isUpdatingMeal}
  updateMealLog={props.updateMealLog}
  requireMeaningfulInput={props.homeMealEnrichmentMeal?.id.startsWith('draft-')}
  onInvalidSave={props.onInvalidMealEnrichmentSave}
  onClose={props.closeHomeMealEnrichment}
  overlayRootClassName="home-dashboard-overlay-root"
  formId="home-meal-enrichment-overlay-form"
/>
```

Remove the homepage-only `homeMealEnrichmentFormId` constant when it is no longer used outside this component call.

- [ ] **Step 5: Use it in meal workspace enrich mode**

In `frontend/src/features/meals/MealLogWorkspace.tsx`, keep preview mode inline. Replace only the enrich branch with:

```tsx
{modalMode === 'enrich' ? (
  <MealEnrichmentModal
    open
    meal={viewModel.selectedMeal}
    source={viewModel.selectedSource}
    members={props.members}
    isUpdating={props.isUpdatingMeal}
    updateMealLog={props.updateMealLog}
    onClose={() => setModalMode(null)}
    formId={mealEnrichmentFormId}
  />
) : null}
```

Then simplify the existing modal block so it renders only when `modalMode === 'preview'`. Keep `MealPhotoLightbox` behavior unchanged.

- [ ] **Step 6: Run tests**

Run:

```bash
npm --prefix frontend run test -- MealEnrichmentModal.test.tsx MealLogWorkspaceModel.test.ts MealLogEnrichmentModel.test.ts
npm --prefix frontend run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/meals/MealEnrichmentModal.tsx frontend/src/features/meals/MealEnrichmentModal.test.tsx frontend/src/features/meals/MealLogWorkspace.tsx frontend/src/features/home/HomeDashboardDialogs.tsx
git commit -m "refactor: share meal enrichment modal"
```

---

### Task 6: Cleanup Imports, Static Guards, and Visual Risk Checks

**Files:**
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/components/foods/FoodPlanDialog.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Modify: `frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts`

**Interfaces:**
- Consumes: Components created in Tasks 1-5.
- Produces: No new runtime interfaces; removes duplicate code and stale imports.

- [ ] **Step 1: Run TypeScript to find stale imports**

Run:

```bash
npm --prefix frontend run typecheck
```

Expected before cleanup: either PASS or FAIL with unused imports / missing symbols caused by the refactor.

- [ ] **Step 2: Remove stale imports and constants**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`, remove imports that are no longer used after extraction:

```tsx
DashboardIcon
Avatar
DropdownSelect
EmptyState
OptionChipGroup
SearchableResourceSelect
WorkspaceModal
resolveMediaUrl
useFoodResourceSearch
useIngredientResourceSearch
getExpiryDaysLeft
InventoryStatus
```

Keep imports that are still used by homepage-only dialogs:

```tsx
MediaWithPlaceholder
FoodPlanDetailModal
MealEnrichmentModal
DestroyExpiredInventoryDialog
FoodPlanDialogParts exports
Badge
FormActions
formatDate
formatDateTime
formatRelativeDays
getFoodCover
INVENTORY_STATUS_LABELS
MEAL_TYPE_LABELS
todayKey
```

If TypeScript shows a different exact list because another task left a valid use, remove only the imports TypeScript reports as unused.

- [ ] **Step 3: Add static guard against reintroducing homepage expired-disposal duplication**

Append this test to `frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts` or create `frontend/src/features/home/HomeDashboardDialogsUsage.test.ts` if the existing file is too specific:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('HomeDashboardDialogs overlay reuse', () => {
  it('does not inline the expired inventory disposal dialog', () => {
    const source = readFileSync(new URL('./HomeDashboardDialogs.tsx', import.meta.url), 'utf8');

    expect(source).toContain('DestroyExpiredInventoryDialog');
    expect(source).not.toContain('useDestroyExpiredBatchRendering');
    expect(source).not.toContain('DestroyExpiredLoadMoreRow');
  });
});
```

If placed in `frontend/src/features/home/HomeDashboardDialogsUsage.test.ts`, run it with:

```bash
npm --prefix frontend run test -- HomeDashboardDialogsUsage.test.ts
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --prefix frontend run test -- WorkspaceOverlayFrame.test.tsx DestroyExpiredInventoryDialog.test.tsx IngredientRestockSections.test.tsx FoodPlanDialogParts.test.tsx MealEnrichmentModal.test.tsx SearchableResourceSelectUsage.test.ts
npm --prefix frontend run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run full frontend verification**

Run:

```bash
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run smoke
git diff --check
```

Expected: PASS. If `smoke` fails on a known unrelated baseline, capture the failing viewport/assertion text and rerun the focused task tests plus `npm --prefix frontend run build`.

- [ ] **Step 6: Manual UI checklist**

Open the app and verify these flows on desktop width and mobile width:

```bash
npm run dev
```

Manual checks:

- 首页临期食材处理 opens the shared expired-disposal dialog with `home-dashboard-overlay-root`.
- 食材页销毁过期批次 opens the same dialog with ingredient workspace overlay styling.
- 首页采购提醒登记库存 keeps the same source note, selected ingredient, quantity, purchase date, storage, expiry, status, and notes behavior.
- 食材页补入库存 keeps quick restock, search, selected ingredient, quantity tracking, purchase date, storage, expiry, advanced options.
- 首页加食物到菜单 and食物页加食物到菜单 still use the same selected hero, search picker, date strip, meal segment, and note input styling.
- 首页补充记录 and餐食记录中心补充记录 use the same modal wrapper;餐食记录中心预览 still works.
- On mobile, modal drag handle, footer actions, safe-area spacing, and body scroll behavior remain intact.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/components/ingredients/IngredientInventoryOverlay.tsx frontend/src/components/foods/FoodPlanDialog.tsx frontend/src/features/meals/MealLogWorkspace.tsx frontend/src/components/ui-kit/SearchableResourceSelectUsage.test.ts frontend/src/features/home/HomeDashboardDialogsUsage.test.ts
git commit -m "test: guard shared overlay reuse"
```

---

## Self-Review

**Spec coverage:** The plan covers the user-requested duplicate popup/drawer extraction without UI redesign. It handles desktop, pad, and mobile by preserving existing `WorkspaceModal`/`WorkspaceOverlayShell` behavior and current CSS classes. It explicitly selects the richer current implementations as the unified baseline where duplicates differ.

**Placeholder scan:** The plan does not contain deferred markers, open-ended implementation steps, or undefined interfaces. Every new component has concrete props, call sites, and verification commands.

**Type consistency:** The produced names are consistent across tasks: `WorkspaceOverlayFrame`, `DestroyExpiredInventoryDialog`, `IngredientRestock*Section`, `FoodPlan*` parts, and `MealEnrichmentModal`. Callback names and form ids match the consuming files listed in each task.

**Out of scope:** This plan intentionally leaves unique modals alone: global search, AI debug/quality, family settings, recipe shopping, ingredient shopping, recipe cook finish, and cooking assistant confirmation.
