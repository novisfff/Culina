# Frontend UI Kit Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一 Culina 前端高频基础组件，并把现有业务代码中的弹窗、下拉、搜索、筛选 chip、状态徽标、数量单位输入、资源选择和表单动作迁移到新的基础组件体系。

**Architecture:** 以现有 `frontend/src/components/ui-kit.tsx` 为兼容出口，新增 `frontend/src/components/ui-kit/` 目录承载更聚焦的基础组件；旧 `ui-kit.tsx` 在迁移期继续导出现有 API，避免一次性改爆所有调用点。基础组件覆盖当前业务需要的通用交互外壳，包括桌面 popover、手机 sheet、表单 footer、危险确认、可输入 combobox、资源选择、数量单位、chip group 和状态块；食材、菜谱、食物、AI 草稿等业务 payload 构造继续留在业务目录、model 或 hook 中。

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Testing Library style DOM assertions through existing Vitest/jsdom setup, Culina CSS files under `frontend/src/styles/`.

## Global Constraints

- 文案默认使用简体中文，语气具体、克制、像家庭厨房助手。
- 移动端是主要体验；手机端不是桌面页面的简单压缩版。
- 基础 UI 放在 `frontend/src/components/ui-kit/`，旧 `frontend/src/components/ui-kit.tsx` 保留为兼容 re-export 或兼容聚合层。
- 通用行为 hook 放在 `frontend/src/hooks/`。
- 基础组件样式集中放入 `frontend/src/styles/00-ui-kit.css`，并在 `frontend/src/styles.css` 中紧跟 `00-foundation.css` 后导入。
- 业务域样式继续放在现有业务 CSS 文件中，例如 `03-recipe-workspace.css`、`04-ingredients-workspace.css`、`06-food-workspace.css`、`07-mobile.css`。
- 基础组件不得直接调用 API，不得直接操作 React Query cache，不得包含食材、菜谱、食物、AI 草稿等业务 payload 构造。
- 所有按钮必须使用真实 `<button>`，图标按钮必须有 `aria-label` 或可读文本。
- 有限选项、弹窗、确认、提交中、禁用原因、loading、empty、error 状态必须有可读表达。
- 不新增依赖，先复用现有 React、TypeScript、Vitest 和 CSS。
- 本计划目标是全量迁移：新增基础组件后，同一类交互不允许继续保留局部 `CustomSelect`、裸 `workspace-overlay-actions` footer、裸 `<select>` 枚举、重复搜索输入、重复数量单位输入或业务内自建确认弹窗。

---

## File Structure

本计划是一个完整执行计划。任务按“先建基础组件，再按交互类型全量迁移，再清理旧样式和文档”的顺序推进；每个任务都必须独立通过测试并提交。

**Create**

- `frontend/src/components/ui-kit/index.ts`
  - 新 ui-kit 目录出口，导出新基础组件。
- `frontend/src/components/ui-kit/DropdownSelect.tsx`
  - 非搜索单选下拉，支持泛型值、placeholder、labelPrefix、清空项、Escape 关闭、点击外部关闭、listbox 语义。
- `frontend/src/components/ui-kit/DropdownSelect.test.tsx`
  - 覆盖选择、清空、Escape、点击外部关闭、aria 状态。
- `frontend/src/components/ui-kit/FormActions.tsx`
  - 统一表单底部动作区域，支持 primary/secondary/danger 按钮、提交中、禁用原因。
- `frontend/src/components/ui-kit/FormActions.test.tsx`
  - 覆盖按钮顺序、提交中禁用、禁用原因可读。
- `frontend/src/components/ui-kit/FormField.tsx`
  - 统一 label、hint、error、required、disabled 的字段壳。
- `frontend/src/components/ui-kit/FormField.test.tsx`
  - 覆盖 label 关联、错误态、hint。
- `frontend/src/components/ui-kit/SearchField.tsx`
  - 统一搜索输入、清空按钮、loading indicator、IME composition 事件。
- `frontend/src/components/ui-kit/SearchField.test.tsx`
  - 覆盖输入、清空、compositionStart/compositionEnd、loading 文案。
- `frontend/src/components/ui-kit/ConfirmDialog.tsx`
  - 基于 `WorkspaceModal` 的通用确认弹窗，支持 danger/primary tone、提交中和取消。
- `frontend/src/components/ui-kit/ConfirmDialog.test.tsx`
  - 覆盖确认、取消、danger 文案和禁用态。
- `frontend/src/components/ui-kit/QuantityUnitField.tsx`
  - 轻量数量 + 单位输入，不包含食材换算规则。
- `frontend/src/components/ui-kit/QuantityUnitField.test.tsx`
  - 覆盖数量、单位、自定义单位和 presence-only 禁用数量。
- `frontend/src/components/ui-kit/ComboboxField.tsx`
  - 可输入选择器，覆盖当前 AI 审批 combobox、单位/分类/保存位置自定义输入和普通业务 preset 输入。
- `frontend/src/components/ui-kit/ComboboxField.test.tsx`
  - 覆盖输入过滤、自定义值、禁用自定义值、Escape 关闭。
- `frontend/src/components/ui-kit/ResourcePickerField.tsx`
  - 通用资源选择器外壳，桌面使用 popover，手机使用 sheet；资源类型、异步加载和业务绑定规则由调用方传入。
- `frontend/src/components/ui-kit/ResourcePickerField.test.tsx`
  - 覆盖选择真实 id、禁止自由提交、空态和加载态。
- `frontend/src/components/ui-kit/OptionChipGroup.tsx`
  - 单选/多选 chip 组，覆盖筛选 chip、单位 chip、分类 chip。
- `frontend/src/components/ui-kit/OptionChipGroup.test.tsx`
  - 覆盖单选、多选、横向滚动语义和禁用态。
- `frontend/src/components/ui-kit/StatusBadge.tsx`
  - 带 tone/size/icon 的状态徽标，逐步替换 `Badge` 的语义化状态用法。
- `frontend/src/components/ui-kit/StateBlock.tsx`
  - 统一 empty/loading/error/retry 状态；保留 `EmptyState` 兼容导出。
- `frontend/src/components/ui-kit/MobileActionBar.tsx`
  - 手机端固定底部动作栏，处理 safe-area 和主次按钮。
- `frontend/src/styles/00-ui-kit.css`
  - 新基础组件样式，使用 `.ui-*` 前缀。

**Modify**

- `frontend/src/components/ui-kit.tsx`
  - 从 `./ui-kit` re-export 新组件，继续保留现有组件，迁移期不删除旧 API。
- `frontend/src/styles.css`
  - 在 `00-foundation.css` 后导入 `00-ui-kit.css`。
- `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - 删除局部 `CustomSelect`，改用 `DropdownSelect`。
- `frontend/src/features/family/FamilyActivityViewer.tsx`
  - 删除局部 `CustomSelect`，改用 `DropdownSelect`。
- `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
  - 删除局部 `CustomSelect`，改用 `DropdownSelect`。
- `frontend/src/components/ai/AiDeleteConversationDialog.tsx`
  - 改用 `ConfirmDialog`。
- `frontend/src/components/recipes/RecipeCookView.tsx`
  - 将退出烹饪和删除计时器两个确认弹窗改用 `ConfirmDialog`。
- `frontend/src/components/ai/AiApprovalFields.tsx`
  - 将 `ApprovalSelectField` 和 `ApprovalComboboxField` 改为包装新 `DropdownSelect` / `ComboboxField`，保留 AI 审批专属 class 和 props。
- `frontend/src/components/recipes/RecipeWorkspace.tsx`
  - 将 `RecipeToolbarDropdown` 改为 `DropdownSelect` 包装或删除局部实现。
- `frontend/src/components/foods/FoodWorkspace.tsx`
  - 将桌面食物搜索、弹窗 footer、quick meal 弹窗动作迁移到基础组件。
- `frontend/src/components/ingredients/IngredientWorkspace.tsx`
  - 将移动 drawer/footer、删除确认和 chip rail 可复用部分迁移到基础组件；数据编排不重写。
- `frontend/src/components/foods/FoodMobileView.tsx`
  - 将搜索输入和状态徽标迁移到 `SearchField` / `StatusBadge`。
- `frontend/src/components/recipes/RecipeMobileLibraryView.tsx`
  - 将搜索输入迁移到 `SearchField`。
- `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
  - 将分类、状态、库存、购物筛选 chip 迁移到 `OptionChipGroup`。
- `frontend/src/components/ingredients/IngredientEditorView.tsx`
  - 将分类、单位、保存位置 chip 迁移到 `OptionChipGroup` / `ComboboxField`。
- `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
  - 将食材选择、数量单位、保存位置、状态选择和 footer 全量迁移。
- `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
  - 将采购数量单位、单位 chip、footer 和食材选择全量迁移。
- `frontend/src/components/recipes/RecipeEditorView.tsx`
  - 将 servings/difficulty/ingredient unit/step icon 下拉和食材搜索选择迁移到新组件。
- `frontend/src/components/recipes/RecipePlanDialogs.tsx`
  - 将 meal type 下拉和 footer 迁移。
- `frontend/src/components/recipes/RecipeShoppingDialog.tsx`
  - 将数量单位、单位选择和 footer 全量迁移。
- `frontend/src/components/foods/FoodPlanDialog.tsx`
  - 将计划表单 footer 和 meal type/default select 迁移。
- `frontend/src/components/foods/FoodPlanDetailModal.tsx`
  - 将计划详情 footer 和状态动作迁移。
- `frontend/src/features/family/FamilySettingsModals.tsx`
  - 将 member role select、所有 modal footer 迁移。
- `frontend/src/features/home/HomeDashboard.tsx`
  - 将 quick meal modal footer 和 dashboard 状态徽标迁移。
- `frontend/src/features/home/HomeDashboardDialogs.tsx`
  - 将所有 modal footer、select、资源选择和 restock 数量单位迁移。
- `frontend/src/features/meals/MealLogComposer.tsx`
  - 将 meal type select 和参与人选择 chip 迁移。
- `frontend/src/features/meals/MealLogWorkspace.tsx`
  - 将 enrichment modal footer 和状态徽标迁移。

---

### Task 1: UI Kit Directory And DropdownSelect

**Files:**
- Create: `frontend/src/components/ui-kit/index.ts`
- Create: `frontend/src/components/ui-kit/DropdownSelect.tsx`
- Create: `frontend/src/components/ui-kit/DropdownSelect.test.tsx`
- Create: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/components/ui-kit.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: existing `ActionButton` from `frontend/src/components/ui-kit.tsx`.
- Produces:
  - `type DropdownSelectOption<T extends string> = { value: T; label: string; description?: string }`
  - `function DropdownSelect<T extends string>(props: DropdownSelectProps<T>): JSX.Element`
  - `DropdownSelectProps<T>` includes `ariaLabel`, `placeholder`, `value`, `options`, `onChange`, optional `labelPrefix`, optional `clearOption`, optional `disabled`, optional `className`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui-kit/DropdownSelect.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DropdownSelect } from './DropdownSelect';

describe('DropdownSelect', () => {
  const options = [
    { value: 'breakfast', label: '早餐' },
    { value: 'lunch', label: '午餐' },
  ] as const;

  it('opens the listbox and emits the selected value', () => {
    const onChange = vi.fn();
    render(
      <DropdownSelect
        ariaLabel="选择餐别"
        labelPrefix="餐别"
        placeholder="选择餐别"
        value="breakfast"
        options={options}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '餐别: 早餐' }));
    expect(screen.getByRole('listbox', { name: '选择餐别' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: '午餐' }));
    expect(onChange).toHaveBeenCalledWith('lunch');
  });

  it('supports a clear option', () => {
    const onChange = vi.fn();
    render(
      <DropdownSelect
        ariaLabel="筛选成员"
        labelPrefix="成员"
        placeholder="全部成员"
        value="user-1"
        options={[{ value: 'user-1', label: '妈妈' }]}
        clearOption={{ value: '', label: '全部成员' }}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '成员: 妈妈' }));
    fireEvent.click(screen.getByRole('option', { name: '全部成员' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('closes with Escape without changing the value', () => {
    const onChange = vi.fn();
    render(
      <DropdownSelect
        ariaLabel="选择餐别"
        placeholder="选择餐别"
        value="breakfast"
        options={options}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '早餐' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/DropdownSelect.test.tsx`

Expected: FAIL with an import error for `./DropdownSelect`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/ui-kit/DropdownSelect.tsx`:

```tsx
import { useEffect, useId, useRef, useState } from 'react';

export type DropdownSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export type DropdownSelectProps<T extends string> = {
  ariaLabel: string;
  placeholder: string;
  value: T | '';
  options: readonly DropdownSelectOption<T>[];
  onChange: (value: T | '') => void;
  labelPrefix?: string;
  clearOption?: { value: ''; label: string };
  disabled?: boolean;
  className?: string;
};

export function DropdownSelect<T extends string>({
  ariaLabel,
  placeholder,
  value,
  options,
  onChange,
  labelPrefix,
  clearOption,
  disabled = false,
  className,
}: DropdownSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const triggerText = selectedOption
    ? labelPrefix
      ? `${labelPrefix}: ${selectedOption.label}`
      : selectedOption.label
    : placeholder;
  const allOptions = clearOption ? [clearOption, ...options] : options;

  useEffect(() => {
    if (!isOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className={['ui-dropdown-select', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')} ref={rootRef}>
      <button
        type="button"
        className="ui-dropdown-select-trigger"
        aria-label={triggerText}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{triggerText}</span>
        <span className="ui-dropdown-select-chevron" aria-hidden="true" />
      </button>
      {isOpen && (
        <div id={listboxId} className="ui-dropdown-select-menu" role="listbox" aria-label={ariaLabel}>
          {allOptions.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value || '__clear'}
                type="button"
                className={selected ? 'ui-dropdown-select-option is-selected' : 'ui-dropdown-select-option'}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                <span className="ui-dropdown-select-option-copy">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {selected ? <span className="ui-dropdown-select-option-mark" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Create `frontend/src/components/ui-kit/index.ts`:

```ts
export * from './DropdownSelect';
```

Append to the bottom of `frontend/src/components/ui-kit.tsx`:

```ts
export * from './ui-kit';
```

Create `frontend/src/styles/00-ui-kit.css`:

```css
.ui-dropdown-select {
  position: relative;
  min-width: 0;
}

.ui-dropdown-select-trigger {
  width: 100%;
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--surface, #fff);
  color: var(--text);
  padding: 0 12px;
  font: inherit;
  cursor: pointer;
}

.ui-dropdown-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.ui-dropdown-select-chevron {
  width: 8px;
  height: 8px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  opacity: 0.62;
}

.ui-dropdown-select-menu {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  left: 0;
  width: max(100%, 220px);
  max-height: min(320px, 60vh);
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface, #fff);
  box-shadow: 0 18px 42px rgba(84, 55, 35, 0.16);
}

.ui-dropdown-select-option {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  padding: 8px 10px;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.ui-dropdown-select-option:hover,
.ui-dropdown-select-option:focus-visible,
.ui-dropdown-select-option.is-selected {
  background: var(--accent-soft);
}

.ui-dropdown-select-option-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.ui-dropdown-select-option-copy small {
  color: var(--text-soft);
}

.ui-dropdown-select-option-mark {
  color: var(--accent-strong);
  font-weight: 700;
}

@media (max-width: 767px) {
  .ui-dropdown-select-trigger,
  .ui-dropdown-select-option {
    min-height: 44px;
  }
}
```

Modify `frontend/src/styles.css`:

```css
/* Global stylesheet entrypoint.
 * Keep imports ordered to preserve the original cascade across workspaces.
 */
@import './styles/00-foundation.css';
@import './styles/00-ui-kit.css';
@import './styles/01-home-dashboard.css';
@import './styles/02-family-settings.css';
@import './styles/03-recipe-workspace.css';
@import './styles/04-ingredients-workspace.css';
@import './styles/05-workspace-overlays.css';
@import './styles/06-food-workspace.css';
@import './styles/08-meal-log.css';
@import './styles/09-global-search.css';
@import './styles/07-mobile.css';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend run test -- src/components/ui-kit/DropdownSelect.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run typecheck for exported API**

Run: `npm --prefix frontend run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui-kit.tsx frontend/src/components/ui-kit frontend/src/styles.css frontend/src/styles/00-ui-kit.css
git commit -m "feat: add shared dropdown select"
```

---

### Task 2: Replace Duplicate CustomSelect Implementations

**Files:**
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/features/family/FamilyActivityViewer.tsx`
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Test: `frontend/src/features/home/homeDashboardModel.test.ts`
- Test: `frontend/src/features/family/FamilyActivityViewerModel.test.ts`
- Test: `frontend/src/components/ingredients/consumeQuickHelpers.test.ts`

**Interfaces:**
- Consumes: `DropdownSelect<T extends string>` from Task 1.
- Produces: no new public API; removes three local `CustomSelect` implementations and routes simple select UI through the shared component.

- [ ] **Step 1: Inspect the three local select shapes**

Run: `rg -n "type CustomSelect|function CustomSelect|<CustomSelect" frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/features/family/FamilyActivityViewer.tsx frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`

Expected: output includes local `CustomSelect` definitions in all three files.

- [ ] **Step 2: Replace the home dashboard select import and usage**

In `frontend/src/features/home/HomeDashboardDialogs.tsx`, change the ui-kit import to include `DropdownSelect`:

```tsx
import { ActionButton, Avatar, Badge, DropdownSelect, EmptyState, WorkspaceModal } from '../../components/ui-kit';
```

Delete the local `CustomSelectOption` type and `CustomSelect` function. Replace each home dashboard `CustomSelect` call with this shape:

```tsx
<DropdownSelect
  ariaLabel={props.placeholder}
  placeholder={props.placeholder}
  value={props.value}
  options={props.options}
  onChange={props.onChange}
/>
```

If the call is inline and not using a `props` object, use the explicit variables:

```tsx
<DropdownSelect
  ariaLabel="选择餐别"
  placeholder="选择餐别"
  value={homePlanAddForm.mealType}
  options={MEAL_OPTIONS}
  onChange={(mealType) => setHomePlanAddForm((current) => ({ ...current, mealType }))}
/>
```

- [ ] **Step 3: Replace the family activity select import and usage**

In `frontend/src/features/family/FamilyActivityViewer.tsx`, change the ui-kit import:

```tsx
import { ActionButton, DropdownSelect, EmptyState, WorkspaceModal } from '../../components/ui-kit';
```

Delete local `CustomSelectProps` and `CustomSelect`. Replace member/status/limit filters with:

```tsx
<DropdownSelect
  ariaLabel={placeholder}
  labelPrefix={labelPrefix}
  placeholder={placeholder}
  value={value}
  options={options}
  clearOption={{ value: '', label: placeholder.replace(`${labelPrefix}: `, '') }}
  onChange={onChange}
/>
```

- [ ] **Step 4: Replace the ingredient inventory overlay select import and usage**

In `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`, change the ui-kit import:

```tsx
import { ActionButton, Badge, DropdownSelect, WorkspaceModal } from '../ui-kit';
```

Delete the local `CustomSelect` function. Replace simple non-search select calls with:

```tsx
<DropdownSelect
  ariaLabel="选择保存位置"
  placeholder="选择保存位置"
  value={props.inventoryForm.storageLocation}
  options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
  onChange={(storageLocation) => props.setInventoryForm((current) => ({ ...current, storageLocation }))}
/>
```

Use `as string` only when the existing form field is typed wider than string; do not loosen the `DropdownSelect` component type.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/features/home/homeDashboardModel.test.ts \
  src/features/family/FamilyActivityViewerModel.test.ts \
  src/components/ingredients/consumeQuickHelpers.test.ts \
  src/components/ui-kit/DropdownSelect.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm --prefix frontend run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/features/family/FamilyActivityViewer.tsx frontend/src/components/ingredients/IngredientInventoryOverlay.tsx
git commit -m "refactor: reuse shared dropdown select"
```

---

### Task 3: FormActions And ConfirmDialog

**Files:**
- Create: `frontend/src/components/ui-kit/FormActions.tsx`
- Create: `frontend/src/components/ui-kit/FormActions.test.tsx`
- Create: `frontend/src/components/ui-kit/ConfirmDialog.tsx`
- Create: `frontend/src/components/ui-kit/ConfirmDialog.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/components/ai/AiDeleteConversationDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipeCookView.tsx`

**Interfaces:**
- Consumes: existing `ActionButton`, existing `WorkspaceModal`.
- Produces:
  - `FormActions(props): JSX.Element`
  - `ConfirmDialog(props): JSX.Element | null`
  - `ConfirmDialog` props: `open`, `title`, `description`, `confirmLabel`, `cancelLabel`, `tone`, `isSubmitting`, `onConfirm`, `onCancel`.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/ui-kit/FormActions.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FormActions } from './FormActions';

describe('FormActions', () => {
  it('renders secondary before primary and exposes disabled reason', () => {
    render(
      <FormActions
        primaryLabel="保存"
        secondaryLabel="取消"
        primaryDisabled
        primaryDisabledReason="请先选择食材"
        onPrimary={vi.fn()}
        onSecondary={vi.fn()}
      />
    );

    expect(screen.getByText('请先选择食材')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['取消', '保存']);
  });

  it('calls the primary action', () => {
    const onPrimary = vi.fn();
    render(<FormActions primaryLabel="确认" onPrimary={onPrimary} />);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onPrimary).toHaveBeenCalled();
  });
});
```

Create `frontend/src/components/ui-kit/ConfirmDialog.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('confirms and cancels with readable labels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="删除会话"
        description="删除后不可恢复。"
        confirmLabel="删除"
        cancelLabel="先保留"
        tone="danger"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '先保留' }));
    expect(onConfirm).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog
        open={false}
        title="删除"
        description="确认删除。"
        confirmLabel="删除"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByText('确认删除。')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix frontend run test -- src/components/ui-kit/FormActions.test.tsx src/components/ui-kit/ConfirmDialog.test.tsx`

Expected: FAIL with import errors for `FormActions` and `ConfirmDialog`.

- [ ] **Step 3: Implement FormActions**

Create `frontend/src/components/ui-kit/FormActions.tsx`:

```tsx
import type { ReactNode } from 'react';
import { ActionButton } from '../ui-kit';

export type FormActionsProps = {
  primaryLabel: ReactNode;
  onPrimary?: () => void;
  primaryType?: 'button' | 'submit';
  primaryTone?: 'primary' | 'danger';
  primaryDisabled?: boolean;
  primaryDisabledReason?: string;
  isSubmitting?: boolean;
  secondaryLabel?: ReactNode;
  onSecondary?: () => void;
  className?: string;
};

export function FormActions({
  primaryLabel,
  onPrimary,
  primaryType = 'button',
  primaryTone = 'primary',
  primaryDisabled = false,
  primaryDisabledReason,
  isSubmitting = false,
  secondaryLabel,
  onSecondary,
  className,
}: FormActionsProps) {
  const disabled = primaryDisabled || isSubmitting;
  return (
    <div className={['ui-form-actions', className].filter(Boolean).join(' ')}>
      {primaryDisabledReason && disabled ? <p className="ui-form-actions-reason">{primaryDisabledReason}</p> : null}
      <div className="ui-form-actions-row">
        <span className="ui-form-actions-spacer" />
        {secondaryLabel ? (
          <ActionButton tone="secondary" type="button" onClick={onSecondary} disabled={isSubmitting}>
            {secondaryLabel}
          </ActionButton>
        ) : null}
        <ActionButton
          tone="primary"
          type={primaryType}
          className={primaryTone === 'danger' ? 'danger' : undefined}
          onClick={onPrimary}
          disabled={disabled}
        >
          {isSubmitting ? '处理中...' : primaryLabel}
        </ActionButton>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement ConfirmDialog**

Create `frontend/src/components/ui-kit/ConfirmDialog.tsx`:

```tsx
import type { ReactNode } from 'react';
import { WorkspaceModal } from '../ui-kit';
import { FormActions } from './FormActions';

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  tone?: 'primary' | 'danger';
  isSubmitting?: boolean;
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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="workspace-overlay-root ui-confirm-dialog-root">
      <div className="workspace-overlay-backdrop" onClick={() => {
        if (!isSubmitting) onCancel();
      }} />
      <WorkspaceModal
        title={title}
        description={typeof description === 'string' ? description : undefined}
        closeLabel={cancelLabel}
        closeAriaLabel={typeof cancelLabel === 'string' ? cancelLabel : '关闭确认弹窗'}
        className={tone === 'danger' ? 'ui-confirm-dialog is-danger' : 'ui-confirm-dialog'}
        onClose={() => {
          if (!isSubmitting) onCancel();
        }}
      >
        {typeof description === 'string' ? null : <div className="ui-confirm-dialog-description">{description}</div>}
        <FormActions
          primaryLabel={confirmLabel}
          primaryTone={tone === 'danger' ? 'danger' : 'primary'}
          secondaryLabel={cancelLabel}
          isSubmitting={isSubmitting}
          onPrimary={onConfirm}
          onSecondary={onCancel}
        />
      </WorkspaceModal>
    </div>
  );
}
```

Modify `frontend/src/components/ui-kit/index.ts`:

```ts
export * from './DropdownSelect';
export * from './FormActions';
export * from './ConfirmDialog';
```

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-form-actions {
  display: grid;
  gap: 8px;
  margin-top: 18px;
}

.ui-form-actions-reason {
  margin: 0;
  color: var(--text-soft);
  font-size: 0.9rem;
}

.ui-form-actions-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ui-form-actions-spacer {
  flex: 1 1 auto;
}

.ui-form-actions-danger {
  color: var(--danger, #d94b3d);
}

.ui-confirm-dialog-description {
  color: var(--text-soft);
  line-height: 1.6;
}

@media (max-width: 767px) {
  .ui-form-actions-row {
    align-items: stretch;
  }

  .ui-form-actions-row > button {
    min-height: 44px;
    flex: 1 1 100%;
  }
}
```

- [ ] **Step 5: Run component tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/FormActions.test.tsx src/components/ui-kit/ConfirmDialog.test.tsx`

Expected: PASS.

- [ ] **Step 6: Migrate AI delete conversation dialog**

Modify `frontend/src/components/ai/AiDeleteConversationDialog.tsx` to use `ConfirmDialog`:

```tsx
import type { AiConversation } from '../../api/types';
import { ConfirmDialog } from '../ui-kit';

export function AiDeleteConversationDialog(props: {
  conversation: AiConversation;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open
      title="删除这段对话"
      description={`将删除「${props.conversation.title || props.conversation.prompt || 'AI 会话'}」，相关消息不会再显示。`}
      confirmLabel="确认删除"
      cancelLabel="取消"
      tone="danger"
      isSubmitting={props.isDeleting}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
```

- [ ] **Step 7: Migrate RecipeCookView confirmation modals**

In `frontend/src/components/recipes/RecipeCookView.tsx`, import `ConfirmDialog`:

```tsx
import { ActionButton, ConfirmDialog, WorkspaceModal } from '../ui-kit';
```

Replace the exit confirmation modal with:

```tsx
<ConfirmDialog
  open={Boolean(pendingExitTarget)}
  title={pendingExitTarget ? getExitConfirmTitle(pendingExitTarget) : '退出烹饪'}
  description={`当前有 ${runningTimers.length} 个计时器正在工作。退出后会暂停计时，烹饪步骤和已用时间仍会保留。`}
  confirmLabel="暂停并退出"
  cancelLabel="继续烹饪"
  tone="primary"
  onCancel={() => setPendingExitTarget(null)}
  onConfirm={() => {
    const target = pendingExitTarget;
    setPendingExitTarget(null);
    if (target) {
      exitCookMode(target);
    }
  }}
/>
```

Replace the timer delete confirmation modal with:

```tsx
<ConfirmDialog
  open={Boolean(deletingTimerId)}
  title="确认删除正在运行的计时器？"
  description="该计时器正在运行中，删除后将无法恢复计时进度。"
  confirmLabel="确认删除"
  cancelLabel="继续计时"
  tone="danger"
  onCancel={() => setDeletingTimerId(null)}
  onConfirm={() => {
    if (deletingTimerId) {
      const target = timers.find((timer) => timer.id === deletingTimerId);
      if (target) deleteTimer(target.id);
    }
    setDeletingTimerId(null);
  }}
/>
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/FormActions.test.tsx \
  src/components/ui-kit/ConfirmDialog.test.tsx \
  src/components/recipes/RecipeCookTimerModel.test.ts \
  src/components/ai/AiWorkspace.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Run build**

Run: `npm --prefix frontend run build`

Expected: PASS; existing bundle budget warnings are acceptable if the build exits 0.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css frontend/src/components/ai/AiDeleteConversationDialog.tsx frontend/src/components/recipes/RecipeCookView.tsx
git commit -m "refactor: standardize confirmation dialogs"
```

---

### Task 4: FormField And SearchField

**Files:**
- Create: `frontend/src/components/ui-kit/FormField.tsx`
- Create: `frontend/src/components/ui-kit/FormField.test.tsx`
- Create: `frontend/src/components/ui-kit/SearchField.tsx`
- Create: `frontend/src/components/ui-kit/SearchField.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/features/search/GlobalSearchOverlay.tsx`

**Interfaces:**
- Consumes: `SearchLoadingIndicator` from existing ui-kit.
- Produces:
  - `FormField(props): JSX.Element`
  - `SearchField(props): JSX.Element`
  - `SearchField` supports `value`, `onChange`, `placeholder`, `ariaLabel`, `loading`, `onCompositionStart`, `onCompositionEnd`, `onClear`.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/ui-kit/FormField.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormField } from './FormField';

describe('FormField', () => {
  it('associates label, hint and error text with the control', () => {
    render(
      <FormField label="食材名称" hint="使用家里常用叫法" error="请填写食材名称" required>
        <input />
      </FormField>
    );

    expect(screen.getByText('食材名称')).toBeInTheDocument();
    expect(screen.getByText('使用家里常用叫法')).toBeInTheDocument();
    expect(screen.getByText('请填写食材名称')).toHaveAttribute('role', 'alert');
  });
});
```

Create `frontend/src/components/ui-kit/SearchField.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchField } from './SearchField';

describe('SearchField', () => {
  it('emits changes and clears the value', () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <SearchField
        ariaLabel="搜索食材"
        placeholder="搜索食材"
        value="番茄"
        onChange={onChange}
        onClear={onClear}
      />
    );

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索食材' }), { target: { value: '鸡蛋' } });
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));

    expect(onChange).toHaveBeenCalledWith('鸡蛋');
    expect(onClear).toHaveBeenCalled();
  });

  it('shows loading status while searching', () => {
    render(
      <SearchField
        ariaLabel="搜索"
        placeholder="搜索"
        value="面条"
        loading
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('正在检索')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix frontend run test -- src/components/ui-kit/FormField.test.tsx src/components/ui-kit/SearchField.test.tsx`

Expected: FAIL with import errors.

- [ ] **Step 3: Implement FormField**

Create `frontend/src/components/ui-kit/FormField.tsx`:

```tsx
import type { ReactNode } from 'react';

export type FormFieldProps = {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
};

export function FormField({ label, children, hint, error, required = false, disabled = false, className }: FormFieldProps) {
  return (
    <label className={['ui-form-field', disabled ? 'is-disabled' : '', error ? 'has-error' : '', className].filter(Boolean).join(' ')}>
      <span className="ui-form-field-label">
        {label}
        {required ? <span className="ui-form-field-required" aria-label="必填">*</span> : null}
      </span>
      <span className="ui-form-field-control">{children}</span>
      {hint ? <span className="ui-form-field-hint">{hint}</span> : null}
      {error ? <span className="ui-form-field-error" role="alert">{error}</span> : null}
    </label>
  );
}
```

- [ ] **Step 4: Implement SearchField**

Create `frontend/src/components/ui-kit/SearchField.tsx`:

```tsx
import type { CompositionEvent } from 'react';
import { SearchLoadingIndicator } from '../ui-kit';

export type SearchFieldProps = {
  ariaLabel: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  onCompositionStart?: (event: CompositionEvent<HTMLInputElement>) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLInputElement>) => void;
};

export function SearchField({
  ariaLabel,
  placeholder,
  value,
  onChange,
  onClear,
  loading = false,
  disabled = false,
  className,
  onCompositionStart,
  onCompositionEnd,
}: SearchFieldProps) {
  return (
    <div className={['ui-search-field', className, disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      <input
        type="search"
        role="searchbox"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
      <SearchLoadingIndicator active={loading} className="ui-search-field-loading" />
      {value ? (
        <button type="button" className="ui-search-field-clear" aria-label="清空搜索" onClick={onClear ?? (() => onChange(''))} disabled={disabled}>
          ×
        </button>
      ) : null}
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
```

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-form-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.ui-form-field-label {
  color: var(--text);
  font-weight: 700;
}

.ui-form-field-required {
  margin-left: 4px;
  color: var(--danger, #d94b3d);
}

.ui-form-field-control {
  min-width: 0;
}

.ui-form-field-hint,
.ui-form-field-error {
  font-size: 0.88rem;
  line-height: 1.45;
}

.ui-form-field-hint {
  color: var(--text-soft);
}

.ui-form-field-error {
  color: var(--danger, #d94b3d);
}

.ui-search-field {
  min-width: 0;
  min-height: 42px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface, #fff);
  padding: 0 8px 0 12px;
}

.ui-search-field input {
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
}

.ui-search-field-clear {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: var(--surface-muted, #f6f0ea);
  color: var(--text-soft);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 767px) {
  .ui-search-field {
    min-height: 46px;
  }

  .ui-search-field-clear {
    width: 38px;
    height: 38px;
  }
}
```

- [ ] **Step 5: Run component tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/FormField.test.tsx src/components/ui-kit/SearchField.test.tsx`

Expected: PASS.

- [ ] **Step 6: Migrate GlobalSearchOverlay input**

In `frontend/src/features/search/GlobalSearchOverlay.tsx`, import `SearchField`:

```tsx
import { SearchField } from '../../components/ui-kit';
```

Replace the local search input block with:

```tsx
<SearchField
  ariaLabel="搜索家庭厨房"
  placeholder="搜索食材、食物、菜谱..."
  value={query}
  loading={isLoading}
  onChange={setQuery}
  onClear={() => setQuery('')}
/>
```

Keep result rendering unchanged.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/FormField.test.tsx \
  src/components/ui-kit/SearchField.test.tsx \
  src/features/search/GlobalSearchOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run smoke**

Run: `npm --prefix frontend run smoke`

Expected: PASS for login, workspace tabs and responsive checks.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css frontend/src/features/search/GlobalSearchOverlay.tsx
git commit -m "feat: add shared form and search fields"
```

---

### Task 5: QuantityUnitField

**Files:**
- Create: `frontend/src/components/ui-kit/QuantityUnitField.tsx`
- Create: `frontend/src/components/ui-kit/QuantityUnitField.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/components/recipes/RecipeShoppingDialog.tsx`

**Interfaces:**
- Consumes: `DropdownSelect` from Task 1.
- Produces:
  - `QuantityUnitField(props): JSX.Element`
  - Props include `quantity`, `unit`, `unitOptions`, `onQuantityChange`, `onUnitChange`, optional `quantityDisabled`, optional `quantityDisabledReason`, optional `allowEmptyQuantity`.

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/ui-kit/QuantityUnitField.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuantityUnitField } from './QuantityUnitField';

describe('QuantityUnitField', () => {
  it('edits quantity and unit', () => {
    const onQuantityChange = vi.fn();
    const onUnitChange = vi.fn();
    render(
      <QuantityUnitField
        quantity="2"
        unit="个"
        unitOptions={[{ value: '个', label: '个' }, { value: '斤', label: '斤' }]}
        onQuantityChange={onQuantityChange}
        onUnitChange={onUnitChange}
      />
    );

    fireEvent.change(screen.getByLabelText('数量'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '个' }));
    fireEvent.click(screen.getByRole('option', { name: '斤' }));

    expect(onQuantityChange).toHaveBeenCalledWith('3');
    expect(onUnitChange).toHaveBeenCalledWith('斤');
  });

  it('explains presence-only quantity mode', () => {
    render(
      <QuantityUnitField
        quantity=""
        unit="份"
        quantityDisabled
        quantityDisabledReason="这个食材只记录是否需要补充"
        unitOptions={[{ value: '份', label: '份' }]}
        onQuantityChange={vi.fn()}
        onUnitChange={vi.fn()}
      />
    );

    expect(screen.getByText('这个食材只记录是否需要补充')).toBeInTheDocument();
    expect(screen.getByLabelText('数量')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/QuantityUnitField.test.tsx`

Expected: FAIL with import error.

- [ ] **Step 3: Implement QuantityUnitField**

Create `frontend/src/components/ui-kit/QuantityUnitField.tsx`:

```tsx
import { DropdownSelect, type DropdownSelectOption } from './DropdownSelect';

export type QuantityUnitFieldProps = {
  quantity: string;
  unit: string;
  unitOptions: readonly DropdownSelectOption<string>[];
  onQuantityChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  quantityLabel?: string;
  unitLabel?: string;
  quantityDisabled?: boolean;
  quantityDisabledReason?: string;
  allowEmptyQuantity?: boolean;
  className?: string;
};

export function QuantityUnitField({
  quantity,
  unit,
  unitOptions,
  onQuantityChange,
  onUnitChange,
  quantityLabel = '数量',
  unitLabel = '单位',
  quantityDisabled = false,
  quantityDisabledReason,
  allowEmptyQuantity = true,
  className,
}: QuantityUnitFieldProps) {
  return (
    <div className={['ui-quantity-unit-field', className, quantityDisabled ? 'is-quantity-disabled' : ''].filter(Boolean).join(' ')}>
      <label className="ui-quantity-unit-number">
        <span>{quantityLabel}</span>
        <input
          aria-label={quantityLabel}
          type="number"
          inputMode="decimal"
          min={allowEmptyQuantity ? undefined : 0}
          step="0.01"
          value={quantity}
          disabled={quantityDisabled}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
      </label>
      <label className="ui-quantity-unit-select">
        <span>{unitLabel}</span>
        <DropdownSelect
          ariaLabel={unitLabel}
          placeholder="选择单位"
          value={unit}
          options={unitOptions}
          onChange={(value) => onUnitChange(value)}
        />
      </label>
      {quantityDisabledReason ? <p className="ui-quantity-unit-reason">{quantityDisabledReason}</p> : null}
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
```

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-quantity-unit-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(120px, 0.75fr);
  gap: 10px;
  align-items: end;
}

.ui-quantity-unit-number,
.ui-quantity-unit-select {
  display: grid;
  gap: 6px;
  min-width: 0;
  color: var(--text);
  font-weight: 700;
}

.ui-quantity-unit-number input {
  min-height: 40px;
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--surface, #fff);
  color: var(--text);
  padding: 0 12px;
  font: inherit;
}

.ui-quantity-unit-number input:disabled {
  opacity: 0.62;
}

.ui-quantity-unit-reason {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--text-soft);
  font-size: 0.88rem;
}

@media (max-width: 767px) {
  .ui-quantity-unit-field {
    grid-template-columns: 1fr;
  }

  .ui-quantity-unit-number input {
    min-height: 44px;
  }
}
```

- [ ] **Step 4: Run component test**

Run: `npm --prefix frontend run test -- src/components/ui-kit/QuantityUnitField.test.tsx`

Expected: PASS.

- [ ] **Step 5: Replace one low-risk recipe shopping quantity row**

In `frontend/src/components/recipes/RecipeShoppingDialog.tsx`, import `QuantityUnitField`:

```tsx
import { ActionButton, EmptyState, QuantityUnitField, WorkspaceModal } from '../ui-kit';
```

Replace the custom quantity and unit controls for shopping draft rows with:

```tsx
<QuantityUnitField
  quantity={item.quantity === '' || item.quantity === null || item.quantity === undefined ? '' : String(item.quantity)}
  unit={item.unit || '份'}
  unitOptions={[item.unit || '份', ...props.unitOptions]
    .filter((unit, index, list) => unit && list.indexOf(unit) === index)
    .map((unit) => ({ value: unit, label: unit }))}
  quantityDisabled={item.quantityMode === 'not_track_quantity'}
  quantityDisabledReason={item.quantityMode === 'not_track_quantity' ? '这个食材只提醒需要补充，不记录具体数量。' : undefined}
  onQuantityChange={(value) => props.onUpdateDraft(item.id, { quantity: value })}
  onUnitChange={(unit) => props.onUpdateDraft(item.id, { unit })}
/>
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/QuantityUnitField.test.tsx \
  src/components/recipes/RecipeWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run build**

Run: `npm --prefix frontend run build`

Expected: PASS; existing bundle budget warnings are acceptable if the command exits 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css frontend/src/components/recipes/RecipeShoppingDialog.tsx
git commit -m "feat: add shared quantity unit field"
```

---

### Task 6: Documentation And Quality Gate

**Files:**
- Modify: `docs/frontend-code-standards.md`
- Modify: `docs/plans/README.md`
- Test: no new test file

**Interfaces:**
- Consumes: components created in Tasks 1 to 5.
- Produces: documented placement rules for future UI component work.

- [ ] **Step 1: Update frontend standards**

In `docs/frontend-code-standards.md`, add this section after “样式与体验”:

```md
## 基础组件统一化

高频基础组件优先放在 `frontend/src/components/ui-kit/`，并通过 `frontend/src/components/ui-kit.tsx` 兼容出口导出。

- 弹窗、确认框、表单动作、下拉选择、搜索输入、数量单位输入、状态块和徽标属于基础组件。
- 基础组件只负责结构、视觉、可访问性、loading/disabled/error 状态和手机端触控尺寸。
- 食材、食物、菜谱、AI 审批等业务规则不得写入基础组件；这些规则应留在业务 model、hook 或具体业务组件中。
- 手机端和桌面/pad 端共享基础语义和 props；弹层、选择器、导航和长列表可在组件内部使用不同 presentation。
- 基础组件样式放在 `frontend/src/styles/00-ui-kit.css`，使用 `.ui-*` 前缀；业务域样式继续放在对应业务 CSS 文件中。
```

- [ ] **Step 2: Update plans README**

In `docs/plans/README.md`, append:

```md
## 当前前端基础组件计划

- `docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md`：前端基础组件统一化全量迁移计划，先建立 DropdownSelect、FormActions、ConfirmDialog、FormField、SearchField 和 QuantityUnitField。
```

- [ ] **Step 3: Run quality commands**

Run:

```bash
npm --prefix frontend run test -- src/components/ui-kit/DropdownSelect.test.tsx src/components/ui-kit/FormActions.test.tsx src/components/ui-kit/ConfirmDialog.test.tsx src/components/ui-kit/FormField.test.tsx src/components/ui-kit/SearchField.test.tsx src/components/ui-kit/QuantityUnitField.test.tsx
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run smoke
npm --prefix frontend run check:style-tokens
git diff --check
```

Expected:

- UI kit targeted tests PASS.
- Typecheck PASS.
- Build exits 0. Bundle budget warnings may remain warnings.
- Smoke PASS.
- `check:style-tokens` exits 0. Report-only matches may remain report-only.
- `git diff --check` produces no output.

- [ ] **Step 4: Commit**

```bash
git add docs/frontend-code-standards.md docs/plans/README.md docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md
git commit -m "docs: document frontend ui kit plan"
```

---

### Task 7: ComboboxField Foundation

**Files:**
- Create: `frontend/src/components/ui-kit/ComboboxField.tsx`
- Create: `frontend/src/components/ui-kit/ComboboxField.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`

**Interfaces:**
- Consumes: `00-ui-kit.css` and exports created in Tasks 1 to 5.
- Produces: `ComboboxField<T extends string>(props)` for preset + optional custom text.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/ui-kit/ComboboxField.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComboboxField } from './ComboboxField';

describe('ComboboxField', () => {
  const options = [
    { value: '冷藏', label: '冷藏', description: '冰箱冷藏层' },
    { value: '常温', label: '常温' },
  ];

  it('filters options and selects a preset', () => {
    const onChange = vi.fn();
    render(<ComboboxField ariaLabel="保存位置" value="" options={options} onChange={onChange} placeholder="选择保存位置" />);
    fireEvent.change(screen.getByRole('combobox', { name: '保存位置' }), { target: { value: '冷' } });
    fireEvent.click(screen.getByRole('option', { name: '冷藏 冰箱冷藏层' }));
    expect(onChange).toHaveBeenCalledWith('冷藏');
  });

  it('allows custom values when enabled', () => {
    const onChange = vi.fn();
    render(<ComboboxField ariaLabel="单位" value="" options={[{ value: '个', label: '个' }]} allowCustom onChange={onChange} placeholder="输入单位" />);
    fireEvent.change(screen.getByRole('combobox', { name: '单位' }), { target: { value: '袋' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: '单位' }), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('袋');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ComboboxField.test.tsx`

Expected: FAIL with import error for `./ComboboxField`.

- [ ] **Step 3: Implement ComboboxField**

Create `frontend/src/components/ui-kit/ComboboxField.tsx`:

```tsx
import { useMemo, useState } from 'react';

export type ComboboxOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

export type ComboboxFieldProps<T extends string> = {
  ariaLabel: string;
  value: T | string;
  options: readonly ComboboxOption<T>[];
  onChange: (value: T | string) => void;
  placeholder: string;
  allowCustom?: boolean;
  disabled?: boolean;
  className?: string;
};

function normalizeComboboxText(value: string) {
  return value.trim().toLowerCase();
}

export function ComboboxField<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder,
  allowCustom = false,
  disabled = false,
  className,
}: ComboboxFieldProps<T>) {
  const [query, setQuery] = useState(String(value ?? ''));
  const [isOpen, setIsOpen] = useState(false);
  const visibleOptions = useMemo(() => {
    const normalized = normalizeComboboxText(query);
    if (!normalized) return options;
    return options.filter((option) => normalizeComboboxText(`${option.label} ${option.value} ${option.description ?? ''}`).includes(normalized));
  }, [options, query]);

  function commitCustomValue() {
    const next = query.trim();
    if (allowCustom && next) {
      onChange(next);
      setIsOpen(false);
    }
  }

  return (
    <div className={['ui-combobox-field', className, isOpen ? 'is-open' : '', disabled ? 'is-disabled' : ''].filter(Boolean).join(' ')}>
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setIsOpen(false);
          if (event.key === 'Enter') commitCustomValue();
        }}
      />
      {isOpen && (
        <div className="ui-combobox-menu" role="listbox" aria-label={`${ariaLabel}选项`}>
          {visibleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                setQuery(option.label);
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
          {allowCustom && query.trim() && !visibleOptions.some((option) => normalizeComboboxText(option.label) === normalizeComboboxText(query)) ? (
            <button type="button" role="option" aria-selected={false} onClick={commitCustomValue}>
              <strong>使用“{query.trim()}”</strong>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Export component**

In `frontend/src/components/ui-kit/index.ts`, add:

```ts
export * from './ComboboxField';
```

- [ ] **Step 5: Add styles**

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-combobox-field {
  position: relative;
  min-width: 0;
}

.ui-combobox-field input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: var(--surface, #fff);
  color: var(--text);
  padding: 0 12px;
  font: inherit;
}

.ui-combobox-menu {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  left: 0;
  width: 100%;
  display: grid;
  gap: 6px;
  max-height: min(320px, 60vh);
  overflow: auto;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface, #fff);
  padding: 6px;
  box-shadow: 0 18px 42px rgba(84, 55, 35, 0.16);
}

.ui-combobox-menu button {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  padding: 8px 10px;
  text-align: left;
  font: inherit;
}

.ui-combobox-menu button:hover,
.ui-combobox-menu button:focus-visible {
  background: var(--accent-soft);
}

.ui-combobox-menu small {
  color: var(--text-soft);
}

@media (max-width: 767px) {
  .ui-combobox-field input,
  .ui-combobox-menu button {
    min-height: 44px;
  }
}
```

- [ ] **Step 6: Run component test**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ComboboxField.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css
git commit -m "feat: add combobox field primitive"
```

---

### Task 8: ResourcePickerField Foundation

**Files:**
- Create: `frontend/src/components/ui-kit/ResourcePickerField.tsx`
- Create: `frontend/src/components/ui-kit/ResourcePickerField.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`

**Interfaces:**
- Consumes: `SearchField` from Task 4.
- Produces: `ResourcePickerField<T extends string>(props)` for selecting an existing resource id without accepting free text.

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/ui-kit/ResourcePickerField.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResourcePickerField } from './ResourcePickerField';

describe('ResourcePickerField', () => {
  it('requires selecting an existing resource id', () => {
    const onChange = vi.fn();
    render(
      <ResourcePickerField
        ariaLabel="选择食材"
        placeholder="搜索已有食材"
        value=""
        query=""
        onQueryChange={vi.fn()}
        onChange={onChange}
        options={[{ id: 'ingredient-1', label: '番茄', description: '蔬菜 · 默认 个' }]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '番茄 蔬菜 · 默认 个' }));
    expect(onChange).toHaveBeenCalledWith('ingredient-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ResourcePickerField.test.tsx`

Expected: FAIL with import error for `./ResourcePickerField`.

- [ ] **Step 3: Implement ResourcePickerField**

Create `frontend/src/components/ui-kit/ResourcePickerField.tsx`:

```tsx
import type { ReactNode } from 'react';
import { SearchField } from './SearchField';

export type ResourcePickerOption<T extends string> = {
  id: T;
  label: string;
  description?: string;
  image?: ReactNode;
  disabled?: boolean;
};

export type ResourcePickerFieldProps<T extends string> = {
  ariaLabel: string;
  placeholder: string;
  value: T | '';
  query: string;
  options: readonly ResourcePickerOption<T>[];
  onQueryChange: (value: string) => void;
  onChange: (value: T) => void;
  loading?: boolean;
  emptyText?: string;
  className?: string;
};

export function ResourcePickerField<T extends string>({
  ariaLabel,
  placeholder,
  value,
  query,
  options,
  onQueryChange,
  onChange,
  loading = false,
  emptyText = '没有找到匹配项',
  className,
}: ResourcePickerFieldProps<T>) {
  return (
    <div className={['ui-resource-picker', className].filter(Boolean).join(' ')}>
      <SearchField ariaLabel={ariaLabel} placeholder={placeholder} value={query} loading={loading} onChange={onQueryChange} />
      <div className="ui-resource-picker-list" role="listbox" aria-label={`${ariaLabel}结果`}>
        {options.length === 0 ? <p className="ui-resource-picker-empty">{emptyText}</p> : null}
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === value}
            disabled={option.disabled}
            className={option.id === value ? 'is-selected' : undefined}
            onClick={() => onChange(option.id)}
          >
            {option.image}
            <span>
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Export component**

In `frontend/src/components/ui-kit/index.ts`, add:

```ts
export * from './ResourcePickerField';
```

- [ ] **Step 5: Add styles**

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-resource-picker {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ui-resource-picker-list {
  display: grid;
  gap: 6px;
  max-height: min(320px, 60vh);
  overflow: auto;
  border: 1px solid var(--line-soft);
  border-radius: 14px;
  background: var(--surface, #fff);
  padding: 6px;
  box-shadow: 0 18px 42px rgba(84, 55, 35, 0.16);
}

.ui-resource-picker-list button {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text);
  padding: 8px 10px;
  text-align: left;
  font: inherit;
}

.ui-resource-picker-list button:hover,
.ui-resource-picker-list button:focus-visible,
.ui-resource-picker-list button.is-selected {
  background: var(--accent-soft);
}

.ui-resource-picker-list small,
.ui-resource-picker-empty {
  color: var(--text-soft);
}

@media (max-width: 767px) {
  .ui-resource-picker-list button {
    min-height: 44px;
  }
}
```

- [ ] **Step 6: Run component test**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ResourcePickerField.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css
git commit -m "feat: add resource picker field primitive"
```

---

### Task 9: OptionChipGroup Foundation

**Files:**
- Create: `frontend/src/components/ui-kit/OptionChipGroup.tsx`
- Create: `frontend/src/components/ui-kit/OptionChipGroup.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`

**Interfaces:**
- Consumes: none beyond `00-ui-kit.css` tokens.
- Produces: `OptionChipGroup<T extends string>(props)` for single-choice filter/preset rows.

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/ui-kit/OptionChipGroup.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OptionChipGroup } from './OptionChipGroup';

describe('OptionChipGroup', () => {
  it('changes a single selected chip', () => {
    const onChange = vi.fn();
    render(
      <OptionChipGroup
        ariaLabel="库存筛选"
        value="all"
        options={[{ value: 'all', label: '全部' }, { value: 'low', label: '低库存' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: '低库存' }));
    expect(onChange).toHaveBeenCalledWith('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/OptionChipGroup.test.tsx`

Expected: FAIL with import error for `./OptionChipGroup`.

- [ ] **Step 3: Implement OptionChipGroup**

Create `frontend/src/components/ui-kit/OptionChipGroup.tsx`:

```tsx
export type OptionChip<T extends string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type OptionChipGroupProps<T extends string> = {
  ariaLabel: string;
  value: T;
  options: readonly OptionChip<T>[];
  onChange: (value: T) => void;
  className?: string;
};

export function OptionChipGroup<T extends string>({ ariaLabel, value, options, onChange, className }: OptionChipGroupProps<T>) {
  return (
    <div className={['ui-option-chip-group', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={option.value === value ? 'ui-option-chip is-selected' : 'ui-option-chip'}
          onClick={() => onChange(option.value)}
        >
          <span>{option.label}</span>
          {option.description ? <small>{option.description}</small> : null}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Export component**

In `frontend/src/components/ui-kit/index.ts`, add:

```ts
export * from './OptionChipGroup';
```

- [ ] **Step 5: Add styles**

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-option-chip-group {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.ui-option-chip {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: var(--surface, #fff);
  color: var(--text-soft);
  padding: 0 12px;
  white-space: nowrap;
  font: inherit;
}

.ui-option-chip.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

@media (max-width: 767px) {
  .ui-option-chip {
    min-height: 44px;
  }
}
```

- [ ] **Step 6: Run component test**

Run: `npm --prefix frontend run test -- src/components/ui-kit/OptionChipGroup.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css
git commit -m "feat: add option chip group primitive"
```

---

### Task 10: StatusBadge And StateBlock Foundation

**Files:**
- Create: `frontend/src/components/ui-kit/StatusBadge.tsx`
- Create: `frontend/src/components/ui-kit/StatusBadge.test.tsx`
- Create: `frontend/src/components/ui-kit/StateBlock.tsx`
- Create: `frontend/src/components/ui-kit/StateBlock.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`

**Interfaces:**
- Consumes: none beyond `00-ui-kit.css` tokens.
- Produces: `StatusBadge(props)` and `StateBlock(props)` for semantic badges and empty/loading/error blocks.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/ui-kit/StatusBadge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  it('renders a semantic tone class', () => {
    render(<StatusBadge tone="warning">即将过期</StatusBadge>);
    expect(screen.getByText('即将过期')).toHaveClass('tone-warning');
  });
});
```

Create `frontend/src/components/ui-kit/StateBlock.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StateBlock } from './StateBlock';

describe('StateBlock', () => {
  it('renders an action for empty state recovery', () => {
    const onAction = vi.fn();
    render(<StateBlock status="empty" title="还没有内容" description="先添加一条记录。" actionLabel="去添加" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '去添加' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('uses alert role for errors', () => {
    render(<StateBlock status="error" title="加载失败" description="请稍后重试。" />);
    expect(screen.getByRole('alert')).toHaveTextContent('加载失败');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/StatusBadge.test.tsx \
  src/components/ui-kit/StateBlock.test.tsx
```

Expected: FAIL with import errors.

- [ ] **Step 3: Implement StatusBadge**

Create `frontend/src/components/ui-kit/StatusBadge.tsx`:

```tsx
import type { ReactNode } from 'react';

export type StatusBadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'plan';

export function StatusBadge(props: { children: ReactNode; tone?: StatusBadgeTone; size?: 'default' | 'compact'; className?: string }) {
  const tone = props.tone ?? 'neutral';
  return (
    <span className={['ui-status-badge', `tone-${tone}`, props.size === 'compact' ? 'is-compact' : '', props.className].filter(Boolean).join(' ')}>
      {props.children}
    </span>
  );
}
```

- [ ] **Step 4: Implement StateBlock**

Create `frontend/src/components/ui-kit/StateBlock.tsx`:

```tsx
import type { ReactNode } from 'react';

export type StateBlockProps = {
  status: 'empty' | 'loading' | 'error';
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
};

export function StateBlock(props: StateBlockProps) {
  return (
    <div className={['ui-state-block', `is-${props.status}`, props.className].filter(Boolean).join(' ')} role={props.status === 'error' ? 'alert' : 'status'}>
      <strong>{props.title}</strong>
      <p>{props.description}</p>
      {props.actionLabel && props.onAction ? (
        <button className="ui-state-block-action" type="button" onClick={props.onAction}>{props.actionLabel}</button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Export components**

In `frontend/src/components/ui-kit/index.ts`, add:

```ts
export * from './StatusBadge';
export * from './StateBlock';
```

- [ ] **Step 6: Add styles**

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-status-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border-radius: 999px;
  padding: 0 9px;
  background: var(--surface-muted, #f6f0ea);
  color: var(--text-soft);
  font-size: 0.82rem;
  font-weight: 700;
}

.ui-status-badge.is-compact {
  min-height: 20px;
  padding: 0 7px;
  font-size: 0.76rem;
}

.ui-status-badge.tone-success { background: var(--success-soft); color: var(--success); }
.ui-status-badge.tone-warning { background: var(--warning-soft); color: var(--warning); }
.ui-status-badge.tone-danger { background: var(--danger-soft); color: var(--danger); }
.ui-status-badge.tone-info { background: var(--sage-soft); color: #517a58; }
.ui-status-badge.tone-plan { background: var(--plan-soft); color: var(--plan); }

.ui-state-block {
  display: grid;
  gap: 8px;
  border: 1px dashed var(--line-soft);
  border-radius: 14px;
  background: var(--surface-warm, #fcfaf7);
  padding: 18px;
  color: var(--text-soft);
}

.ui-state-block strong {
  color: var(--text);
}

.ui-state-block-action {
  justify-self: start;
  min-height: 36px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: var(--surface, #fff);
  color: var(--accent-strong);
  padding: 0 14px;
  font: inherit;
  font-weight: 700;
}
```

- [ ] **Step 7: Run component tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/StatusBadge.test.tsx \
  src/components/ui-kit/StateBlock.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css
git commit -m "feat: add status and state primitives"
```

---

### Task 11: MobileActionBar And Export Gate

**Files:**
- Create: `frontend/src/components/ui-kit/MobileActionBar.tsx`
- Create: `frontend/src/components/ui-kit/MobileActionBar.test.tsx`
- Modify: `frontend/src/components/ui-kit/index.ts`
- Modify: `frontend/src/styles/00-ui-kit.css`

**Interfaces:**
- Consumes: primitives from Tasks 1 to 10.
- Produces: `MobileActionBar(props)` for safe-area bottom actions and a complete ui-kit export surface for migration tasks.

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/ui-kit/MobileActionBar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobileActionBar } from './MobileActionBar';

describe('MobileActionBar', () => {
  it('renders bottom actions in a stable container', () => {
    render(<MobileActionBar><button type="button">保存</button></MobileActionBar>);
    expect(screen.getByText('保存').parentElement).toHaveClass('ui-mobile-action-bar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend run test -- src/components/ui-kit/MobileActionBar.test.tsx`

Expected: FAIL with import error for `./MobileActionBar`.

- [ ] **Step 3: Implement MobileActionBar**

Create `frontend/src/components/ui-kit/MobileActionBar.tsx`:

```tsx
import type { ReactNode } from 'react';

export function MobileActionBar(props: { children: ReactNode; className?: string }) {
  return <div className={['ui-mobile-action-bar', props.className].filter(Boolean).join(' ')}>{props.children}</div>;
}
```

- [ ] **Step 4: Normalize final ui-kit exports**

Rewrite `frontend/src/components/ui-kit/index.ts` to:

```ts
export * from './DropdownSelect';
export * from './FormActions';
export * from './ConfirmDialog';
export * from './FormField';
export * from './SearchField';
export * from './QuantityUnitField';
export * from './ComboboxField';
export * from './ResourcePickerField';
export * from './OptionChipGroup';
export * from './StatusBadge';
export * from './StateBlock';
export * from './MobileActionBar';
```

- [ ] **Step 5: Add styles**

Append to `frontend/src/styles/00-ui-kit.css`:

```css
.ui-mobile-action-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 10px;
  padding: 12px 0 calc(12px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, var(--bg), rgba(250, 248, 245, 0.86));
}
```

- [ ] **Step 6: Run foundation tests**

Run:

```bash
npm --prefix frontend run test -- \
  src/components/ui-kit/ComboboxField.test.tsx \
  src/components/ui-kit/ResourcePickerField.test.tsx \
  src/components/ui-kit/OptionChipGroup.test.tsx \
  src/components/ui-kit/StatusBadge.test.tsx \
  src/components/ui-kit/StateBlock.test.tsx \
  src/components/ui-kit/MobileActionBar.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ui-kit frontend/src/styles/00-ui-kit.css frontend/src/components/ui-kit.tsx
git commit -m "feat: add mobile action bar primitive"
```

---

### Task 12: AI Overlay Action Migration

**Files:**
- Modify: `frontend/src/components/ai/AiDeleteConversationDialog.tsx`
- Modify: `frontend/src/components/ai/AiQualityDiagnosticsModal.tsx`
- Modify: `frontend/src/components/ai/AiRecommendationPlanDialog.tsx`
- Test: `frontend/src/components/ai/AiRecommendationPlanDialog.test.tsx`

**Interfaces:**
- Consumes: `ConfirmDialog`, `FormActions`.
- Produces: AI modal action rows use shared footer components.

- [ ] **Step 1: Find AI modal actions**

Run: `rg -n "workspace-overlay-actions|ai-delete-confirm-actions|<WorkspaceModal" frontend/src/components/ai --glob '*.{tsx,ts}'`

Expected: results include `AiDeleteConversationDialog.tsx`, `AiQualityDiagnosticsModal.tsx`, and `AiRecommendationPlanDialog.tsx`.

- [ ] **Step 2: Replace AI delete dialog**

Replace the body of `AiDeleteConversationDialog` with:

```tsx
return (
  <ConfirmDialog
    open
    title="删除这条历史？"
    description={`将删除「${props.conversation.title || props.conversation.prompt || 'AI 会话'}」，相关消息不会再显示。`}
    confirmLabel="确认删除"
    cancelLabel="取消"
    tone="danger"
    isSubmitting={props.isDeleting}
    onCancel={props.onCancel}
    onConfirm={props.onConfirm}
  />
);
```

- [ ] **Step 3: Replace AI recommendation plan dialog footer**

In `frontend/src/components/ai/AiRecommendationPlanDialog.tsx`, replace the `workspace-overlay-actions` block with:

```tsx
<FormActions
  primaryLabel="加入菜单计划"
  primaryType="submit"
  primaryDisabled={!activeRequest.recommendation.foodId}
  isSubmitting={isSubmitting}
  secondaryLabel="取消"
  onSecondary={onClose}
/>
```

- [ ] **Step 4: Keep quality diagnostics close-only modal unchanged**

In `frontend/src/components/ai/AiQualityDiagnosticsModal.tsx`, keep `WorkspaceModal` because it has no submit footer. Verify it uses `closeLabel` or readable close text.

Run: `rg -n "closeLabel|closeAriaLabel" frontend/src/components/ai/AiQualityDiagnosticsModal.tsx`

Expected: output includes `closeLabel` or `closeAriaLabel`.

- [ ] **Step 5: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ConfirmDialog.test.tsx src/components/ui-kit/FormActions.test.tsx src/components/ai/AiRecommendationPlanDialog.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ai
git commit -m "refactor: migrate ai modal actions"
```

---

### Task 13: Recipe Overlay Action Migration

**Files:**
- Modify: `frontend/src/components/recipes/RecipeCookFinishDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipeCookView.tsx`
- Modify: `frontend/src/components/recipes/RecipeDraftDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipePlanDialogs.tsx`
- Modify: `frontend/src/components/recipes/RecipeSceneManagerDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipeShoppingDialog.tsx`
- Test: `frontend/src/components/recipes/RecipeCookTimerModel.test.ts`
- Test: `frontend/src/components/recipes/RecipeWorkspace.test.ts`

**Interfaces:**
- Consumes: `ConfirmDialog`, `FormActions`.
- Produces: recipe dialogs use shared confirm and footer components.

- [ ] **Step 1: Replace cook exit confirmation**

In `RecipeCookView.tsx`, replace the `pendingExitTarget` modal with:

```tsx
<ConfirmDialog
  open={Boolean(pendingExitTarget)}
  title={pendingExitTarget ? getExitConfirmTitle(pendingExitTarget) : '退出烹饪'}
  description={`当前有 ${runningTimers.length} 个计时器正在工作。退出后会暂停计时，烹饪步骤和已用时间仍会保留。`}
  confirmLabel="暂停并退出"
  cancelLabel="继续烹饪"
  tone="primary"
  onCancel={() => setPendingExitTarget(null)}
  onConfirm={() => {
    const target = pendingExitTarget;
    setPendingExitTarget(null);
    if (target) exitCookMode(target);
  }}
/>
```

- [ ] **Step 2: Replace cook timer delete confirmation**

In `RecipeCookView.tsx`, replace the `deletingTimerId` modal with:

```tsx
<ConfirmDialog
  open={Boolean(deletingTimerId)}
  title="确认删除正在运行的计时器？"
  description="该计时器正在运行中，删除后将无法恢复计时进度。"
  confirmLabel="确认删除"
  cancelLabel="继续计时"
  tone="danger"
  onCancel={() => setDeletingTimerId(null)}
  onConfirm={() => {
    const target = timers.find((timer) => timer.id === deletingTimerId);
    if (target) deleteTimer(target.id);
    setDeletingTimerId(null);
  }}
/>
```

- [ ] **Step 3: Replace recipe dialog submit footers**

Replace submit footer blocks in `RecipeDraftDialog.tsx`, `RecipePlanDialogs.tsx`, `RecipeSceneManagerDialog.tsx`, `RecipeShoppingDialog.tsx`, and `RecipeCookFinishDialog.tsx` with `FormActions`.

Use this shape for `RecipeDraftDialog.tsx`:

```tsx
<FormActions
  primaryLabel={props.isBusy ? '生成中...' : '生成菜谱草稿'}
  primaryType="submit"
  primaryDisabled={props.isBusy || !props.canSubmit}
  isSubmitting={props.isBusy}
  secondaryLabel="取消"
  onSecondary={props.onClose}
/>
```

Use this shape for `RecipeShoppingDialog.tsx`:

```tsx
<FormActions
  primaryLabel="确认加入清单"
  primaryDisabled={props.drafts.length === 0}
  isSubmitting={Boolean(props.isCreatingShopping)}
  secondaryLabel="取消"
  onPrimary={props.onSubmit}
  onSecondary={props.onClose}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/recipes/RecipeCookTimerModel.test.ts src/components/recipes/RecipeWorkspace.test.ts src/components/ui-kit/FormActions.test.tsx src/components/ui-kit/ConfirmDialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/recipes
git commit -m "refactor: migrate recipe modal actions"
```

---

### Task 14: Food And Home Overlay Action Migration

**Files:**
- Modify: `frontend/src/components/foods/FoodPlanDialog.tsx`
- Modify: `frontend/src/components/foods/FoodPlanDetailModal.tsx`
- Modify: `frontend/src/components/foods/FoodSceneDialogs.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Test: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Test: `frontend/src/features/home/homeDashboardModel.test.ts`

**Interfaces:**
- Consumes: `FormActions`, `ConfirmDialog`.
- Produces: food and home dialogs use shared action rows.

- [ ] **Step 1: Replace food plan form footer**

In `FoodPlanDialog.tsx`, replace the footer with:

```tsx
<FormActions
  primaryLabel="保存计划"
  primaryType="submit"
  primaryDisabled={props.isUpdatingPlan || !props.planForm.foodId}
  isSubmitting={Boolean(props.isUpdatingPlan)}
  secondaryLabel="取消"
  onSecondary={props.onClose}
/>
```

- [ ] **Step 2: Replace food scene form footer**

In `FoodSceneDialogs.tsx`, replace the scene form footer with:

```tsx
<FormActions
  primaryLabel={props.sceneFormMode === 'create' ? '创建场景' : '保存场景'}
  primaryType="submit"
  primaryDisabled={!props.sceneDraft.name.trim()}
  isSubmitting={Boolean(props.isUpdatingScene)}
  secondaryLabel="取消"
  onSecondary={props.onCloseSceneForm}
/>
```

- [ ] **Step 3: Replace quick meal modal footer**

In `FoodWorkspace.tsx` and `HomeDashboard.tsx`, replace quick meal modal action rows with:

```tsx
<FormActions
  primaryLabel="记录这一餐"
  primaryType="submit"
  isSubmitting={isSubmitting}
  secondaryLabel="取消"
  onSecondary={() => setQuickMealDialog(null)}
/>
```

- [ ] **Step 4: Replace home dashboard dialog footers**

In `HomeDashboardDialogs.tsx`, replace home plan add, expiry review, restock, and meal detail footers with `FormActions`. For restock submit use:

```tsx
<FormActions
  primaryLabel="补入库存"
  primaryDisabled={!props.homeRestockIngredient}
  isSubmitting={props.isCreatingInventory}
  secondaryLabel="取消"
  onPrimary={props.submitHomeRestock}
  onSecondary={props.closeHomeRestock}
/>
```

- [ ] **Step 5: Run tests**

Run: `npm --prefix frontend run test -- src/components/foods/FoodWorkspace.test.ts src/features/home/homeDashboardModel.test.ts src/components/ui-kit/FormActions.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/foods frontend/src/features/home
git commit -m "refactor: migrate food and home modal actions"
```

---

### Task 15: Ingredient Overlay Action Migration

**Files:**
- Modify: `frontend/src/components/ingredients/IngredientConsumeOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientDestroyExpiredOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspace.tsx`
- Test: `frontend/src/components/ingredients/consumeQuickHelpers.test.ts`
- Test: `frontend/src/components/ingredients/workspaceModel.test.ts`

**Interfaces:**
- Consumes: `FormActions`, `ConfirmDialog`.
- Produces: ingredient overlays use shared footer and confirm components.

- [ ] **Step 1: Replace consume overlay footer**

In `IngredientConsumeOverlay.tsx`, replace the footer with:

```tsx
<FormActions
  primaryLabel="确认消耗"
  primaryType="submit"
  primaryDisabled={!props.consumeCanSubmit}
  isSubmitting={Boolean(props.isConsumingInventory)}
  secondaryLabel="取消"
  onSecondary={props.closeOverlay}
/>
```

- [ ] **Step 2: Replace destroy expired overlay footer**

In `IngredientDestroyExpiredOverlay.tsx`, replace the footer with:

```tsx
<FormActions
  primaryLabel="确认销毁"
  primaryType="submit"
  primaryTone="danger"
  primaryDisabled={props.destroyExpiredItems.length === 0}
  isSubmitting={Boolean(props.isDisposingExpiredInventory)}
  secondaryLabel="取消"
  onSecondary={props.closeOverlay}
/>
```

- [ ] **Step 3: Replace inventory and shopping overlay footers**

In `IngredientInventoryOverlay.tsx`, use:

```tsx
<FormActions
  primaryLabel="补入库存"
  primaryType="submit"
  primaryDisabled={!props.inventoryCanSubmit}
  isSubmitting={Boolean(props.isCreatingInventory)}
  secondaryLabel="取消"
  onSecondary={props.closeOverlay}
/>
```

In `IngredientShoppingOverlay.tsx`, use:

```tsx
<FormActions
  primaryLabel="加入采购清单"
  primaryType="submit"
  primaryDisabled={!props.shoppingCanSubmit}
  isSubmitting={Boolean(props.isCreatingShopping)}
  secondaryLabel="取消"
  onSecondary={props.closeOverlay}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/ingredients/consumeQuickHelpers.test.ts src/components/ingredients/workspaceModel.test.ts src/components/ui-kit/FormActions.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ingredients
git commit -m "refactor: migrate ingredient modal actions"
```

---

### Task 16: Family And Meal Overlay Action Migration

**Files:**
- Modify: `frontend/src/features/family/FamilyActivityViewer.tsx`
- Modify: `frontend/src/features/family/FamilySettingsModals.tsx`
- Modify: `frontend/src/features/meals/MealLogWorkspace.tsx`
- Test: `frontend/src/features/family/FamilyActivityViewerModel.test.ts`
- Test: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`

**Interfaces:**
- Consumes: `FormActions`.
- Produces: family and meal modals use shared form actions.

- [ ] **Step 1: Replace family settings modal footers**

In `FamilySettingsModals.tsx`, replace profile, password, member, family profile and image prompt footers with:

```tsx
<FormActions
  primaryLabel="保存"
  primaryType="submit"
  isSubmitting={props.isSubmitting}
  secondaryLabel="取消"
  onSecondary={props.onClose}
/>
```

For image prompt sections use:

```tsx
<FormActions
  primaryLabel="生成图片"
  primaryDisabled={!props.imageControls.prompt.trim()}
  isSubmitting={props.imageControls.isGenerating}
  secondaryLabel="取消"
  onPrimary={props.imageControls.onPromptSubmit}
  onSecondary={props.imageControls.onPromptClose}
/>
```

- [ ] **Step 2: Replace family activity modal footer**

In `FamilyActivityViewer.tsx`, replace the load-more action row with:

```tsx
<FormActions
  primaryLabel="加载更多"
  primaryDisabled={!viewer.hasMore}
  onPrimary={() => viewer.setLimit((current) => current + FAMILY_ACTIVITY_PAGE_SIZE)}
/>
```

- [ ] **Step 3: Replace meal enrichment modal footer**

In `MealLogWorkspace.tsx`, replace enrichment modal action rows with:

```tsx
<FormActions
  primaryLabel={modalMode === 'preview' ? '继续补充' : '保存记录'}
  primaryType={modalMode === 'preview' ? 'button' : 'submit'}
  isSubmitting={props.isSubmitting}
  secondaryLabel="取消"
  onPrimary={modalMode === 'preview' ? () => setModalMode('edit') : undefined}
  onSecondary={() => setModalMode(null)}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/features/family/FamilyActivityViewerModel.test.ts src/features/meals/MealLogWorkspaceModel.test.ts src/components/ui-kit/FormActions.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/family frontend/src/features/meals
git commit -m "refactor: migrate family and meal modal actions"
```

---

### Task 17: AI Select And Combobox Migration

**Files:**
- Modify: `frontend/src/components/ai/AiApprovalFields.tsx`
- Modify: `frontend/src/components/ai/AiApprovalPanel.tsx`
- Modify: `frontend/src/components/ai/AiInventoryOperationEditor.tsx`
- Test: `frontend/src/components/ai/AiApprovalPanel.test.tsx`
- Test: `frontend/src/components/ai/AiInventoryOperationApproval.test.tsx`

**Interfaces:**
- Consumes: `DropdownSelect`, `ComboboxField`.
- Produces: `ApprovalSelectField` and `ApprovalComboboxField` keep their exports while delegating to shared primitives.

- [ ] **Step 1: Rebuild ApprovalSelectField**

In `AiApprovalFields.tsx`, keep the wrapper label and icon, and replace the custom menu with:

```tsx
<DropdownSelect
  ariaLabel={label}
  placeholder="请选择"
  value={value}
  options={options}
  disabled={disabled}
  className={`ai-choice-select ${className}`.trim()}
  onChange={(nextValue) => onChange(nextValue)}
/>
```

- [ ] **Step 2: Rebuild ApprovalComboboxField**

In `AiApprovalFields.tsx`, replace the custom combobox menu with:

```tsx
<ComboboxField
  ariaLabel={label}
  placeholder={placeholder ?? '请选择或输入'}
  value={value}
  options={options}
  disabled={disabled}
  allowCustom={allowCustom}
  className={`ai-choice-combobox ${className}`.trim()}
  onChange={(nextValue) => onChange(String(nextValue))}
/>
```

- [ ] **Step 3: Run AI approval tests**

Run: `npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiInventoryOperationApproval.test.tsx src/components/ui-kit/DropdownSelect.test.tsx src/components/ui-kit/ComboboxField.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ai
git commit -m "refactor: migrate ai approval selects"
```

---

### Task 18: Recipe Select And Combobox Migration

**Files:**
- Modify: `frontend/src/components/recipes/RecipeWorkspace.tsx`
- Modify: `frontend/src/components/recipes/RecipeEditorView.tsx`
- Modify: `frontend/src/components/recipes/RecipePlanDialogs.tsx`
- Test: `frontend/src/components/recipes/RecipeEditorView.test.tsx`
- Test: `frontend/src/components/recipes/RecipeWorkspace.test.ts`

**Interfaces:**
- Consumes: `DropdownSelect`, `ComboboxField`.
- Produces: recipe toolbar, editor and plan dialogs use shared select components.

- [ ] **Step 1: Replace RecipeToolbarDropdown**

In `RecipeWorkspace.tsx`, delete `RecipeToolbarDropdown` and replace each usage with:

```tsx
<DropdownSelect
  ariaLabel={title}
  labelPrefix={title}
  placeholder={title}
  value={value}
  options={options}
  className="recipe-toolbar-dropdown"
  onChange={(nextValue) => onChange(nextValue)}
/>
```

- [ ] **Step 2: Replace recipe editor finite selects**

In `RecipeEditorView.tsx`, replace servings, difficulty and step icon native selects with `DropdownSelect`.

Use this for difficulty:

```tsx
<DropdownSelect
  ariaLabel="选择难度"
  placeholder="选择难度"
  value={form.difficulty}
  options={DIFFICULTY_OPTIONS}
  onChange={(difficulty) => setForm({ ...form, difficulty: difficulty as Difficulty })}
/>
```

Use this for step icon:

```tsx
<DropdownSelect
  ariaLabel="选择步骤图标"
  placeholder="选择步骤图标"
  value={step.icon}
  options={RECIPE_STEP_ICON_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
  onChange={(icon) => updateStepDraft(step.id, { icon })}
/>
```

- [ ] **Step 3: Replace recipe plan meal type selects**

In `RecipePlanDialogs.tsx`, replace meal type selects with:

```tsx
<DropdownSelect
  ariaLabel="选择餐别"
  placeholder="选择餐别"
  value={props.form.mealType}
  options={MEAL_OPTIONS}
  onChange={(mealType) => props.onChangeForm({ ...props.form, mealType: mealType as MealType })}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/recipes/RecipeEditorView.test.tsx src/components/recipes/RecipeWorkspace.test.ts src/components/ui-kit/DropdownSelect.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/recipes
git commit -m "refactor: migrate recipe selects"
```

---

### Task 19: Ingredient Select And Combobox Migration

**Files:**
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientEditorView.tsx`
- Test: `frontend/src/components/ingredients/workspaceModel.test.ts`

**Interfaces:**
- Consumes: `DropdownSelect`, `ComboboxField`, `OptionChipGroup`.
- Produces: ingredient storage, unit, category and status controls use shared primitives.

- [ ] **Step 1: Replace ingredient storage combobox**

In `IngredientInventoryOverlay.tsx` and `IngredientEditorView.tsx`, use:

```tsx
<ComboboxField
  ariaLabel="保存位置"
  placeholder="选择或输入保存位置"
  value={props.inventoryForm.storageLocation}
  options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
  allowCustom
  onChange={(storageLocation) => props.setInventoryForm((current) => ({ ...current, storageLocation }))}
/>
```

- [ ] **Step 2: Replace ingredient unit combobox**

Use:

```tsx
<ComboboxField
  ariaLabel="默认单位"
  placeholder="选择或输入单位"
  value={props.ingredientForm.default_unit}
  options={buildUnitPresetOptions(props.ingredientForm.default_unit).map((unit) => ({ value: unit, label: unit }))}
  allowCustom
  onChange={(defaultUnit) => props.setIngredientForm((current) => ({ ...current, default_unit: defaultUnit }))}
/>
```

- [ ] **Step 3: Replace ingredient category chips**

Use:

```tsx
<OptionChipGroup
  ariaLabel="食材分类"
  value={props.ingredientForm.category}
  options={INGREDIENT_CATEGORY_PRESETS.map((preset) => ({ value: preset.label, label: preset.label }))}
  onChange={(category) => props.setIngredientForm((current) => ({ ...current, category }))}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/ingredients/workspaceModel.test.ts src/components/ui-kit/ComboboxField.test.tsx src/components/ui-kit/OptionChipGroup.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ingredients
git commit -m "refactor: migrate ingredient selects"
```

---

### Task 20: Family And Meal Select Migration

**Files:**
- Modify: `frontend/src/features/family/FamilyActivityViewer.tsx`
- Modify: `frontend/src/features/family/FamilySettingsModals.tsx`
- Modify: `frontend/src/features/meals/MealLogComposer.tsx`
- Test: `frontend/src/features/family/FamilyActivityViewerModel.test.ts`
- Test: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`

**Interfaces:**
- Consumes: `DropdownSelect`, `OptionChipGroup`.
- Produces: family activity filters, member role select and meal type select use shared primitives.

- [ ] **Step 1: Replace family activity filters**

In `FamilyActivityViewer.tsx`, replace the remaining filter select calls with:

```tsx
<DropdownSelect
  ariaLabel={placeholder}
  labelPrefix={labelPrefix}
  placeholder={placeholder}
  value={value}
  options={options}
  clearOption={{ value: '', label: placeholder.replace(`${labelPrefix}: `, '') }}
  onChange={onChange}
/>
```

- [ ] **Step 2: Replace member role select**

In `FamilySettingsModals.tsx`, replace role native select with:

```tsx
<DropdownSelect
  ariaLabel="选择成员角色"
  placeholder="选择成员角色"
  value={props.memberEditForm.role}
  options={[
    { value: 'Owner', label: '管理员' },
    { value: 'Member', label: '成员' },
  ]}
  onChange={(role) => props.setMemberEditForm((current) => ({ ...current, role }))}
/>
```

- [ ] **Step 3: Replace meal log meal type select**

In `MealLogComposer.tsx`, replace meal type native select with:

```tsx
<DropdownSelect
  ariaLabel="选择餐别"
  placeholder="选择餐别"
  value={mealType}
  options={MEAL_OPTIONS}
  onChange={(nextMealType) => setMealType(nextMealType as MealType)}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/features/family/FamilyActivityViewerModel.test.ts src/features/meals/MealLogWorkspaceModel.test.ts src/components/ui-kit/DropdownSelect.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/family frontend/src/features/meals
git commit -m "refactor: migrate family and meal selects"
```

---

### Task 21: Workspace Search Field Migration

**Files:**
- Modify: `frontend/src/features/search/GlobalSearchOverlay.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/components/foods/FoodMobileView.tsx`
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/components/recipes/RecipeWorkspace.tsx`
- Modify: `frontend/src/components/recipes/RecipeMobileLibraryView.tsx`
- Test: `frontend/src/features/search/GlobalSearchOverlay.test.tsx`
- Test: `frontend/src/hooks/useDebouncedValue.test.tsx`
- Test: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Test: `frontend/src/components/recipes/RecipeWorkspace.test.ts`

**Interfaces:**
- Consumes: `SearchField`.
- Produces: all workspace and mobile search inputs use the shared search field.

- [ ] **Step 1: Replace global search input**

In `GlobalSearchOverlay.tsx`, use:

```tsx
<SearchField
  ariaLabel="搜索家庭厨房"
  placeholder="搜索食材、食物、菜谱..."
  value={query}
  loading={isLoading}
  onChange={setQuery}
  onClear={() => setQuery('')}
/>
```

- [ ] **Step 2: Replace food search inputs**

In `FoodWorkspace.tsx` and `FoodMobileView.tsx`, use:

```tsx
<SearchField
  ariaLabel="搜索食物"
  placeholder="搜索食物"
  value={search}
  loading={isFoodSearchFetching}
  onChange={setSearch}
  onClear={() => setSearch('')}
  onCompositionStart={foodSearchComposition.onCompositionStart}
  onCompositionEnd={foodSearchComposition.onCompositionEnd}
/>
```

- [ ] **Step 3: Replace ingredient panel search inputs**

In `IngredientWorkspacePanels.tsx`, use:

```tsx
<SearchField
  ariaLabel="搜索食材"
  placeholder="搜索食材"
  value={props.catalogSearch}
  loading={Boolean(props.catalogSearch.trim()) && Boolean(props.isCatalogSearchFetching)}
  onChange={props.setCatalogSearch}
  onClear={() => props.setCatalogSearch('')}
/>
```

For inventory search use the same component with `props.inventorySearch`, `props.setInventorySearch`, and `props.isInventorySearchFetching`.

- [ ] **Step 4: Replace recipe search inputs**

In `RecipeWorkspace.tsx` and `RecipeMobileLibraryView.tsx`, use:

```tsx
<SearchField
  ariaLabel="搜索菜谱"
  placeholder="搜索菜谱"
  value={search}
  loading={isRecipeSearchFetching}
  onChange={setSearch}
  onClear={() => setSearch('')}
  onCompositionStart={recipeSearchComposition.onCompositionStart}
  onCompositionEnd={recipeSearchComposition.onCompositionEnd}
/>
```

- [ ] **Step 5: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/SearchField.test.tsx src/features/search/GlobalSearchOverlay.test.tsx src/hooks/useDebouncedValue.test.tsx src/components/foods/FoodWorkspace.test.ts src/components/recipes/RecipeWorkspace.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/search frontend/src/components/foods frontend/src/components/ingredients/IngredientWorkspacePanels.tsx frontend/src/components/recipes
git commit -m "refactor: migrate workspace search fields"
```

---

### Task 22: Recipe Resource Picker Migration

**Files:**
- Modify: `frontend/src/components/recipes/RecipeEditorView.tsx`
- Modify: `frontend/src/components/recipes/RecipeIngredientResolutionDialog.tsx`
- Modify: `frontend/src/components/recipes/RecipeShoppingDialog.tsx`
- Test: `frontend/src/components/recipes/RecipeEditorView.test.tsx`
- Test: `frontend/src/components/recipes/RecipeWorkspace.test.ts`

**Interfaces:**
- Consumes: `ResourcePickerField`.
- Produces: recipe ingredient binding and shopping custom ingredient selection use shared resource picker.

- [ ] **Step 1: Replace recipe editor ingredient picker**

In `RecipeEditorView.tsx`, use:

```tsx
<ResourcePickerField
  ariaLabel="选择已有食材"
  placeholder="搜索食材库"
  value={row.ingredientId ?? ''}
  query={ingredientSearch}
  loading={isIngredientSearchFetching}
  options={visibleIngredientOptions.map((ingredient) => ({
    id: ingredient.id,
    label: ingredient.name,
    description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
  }))}
  onQueryChange={setIngredientSearch}
  onChange={(ingredientId) => selectIngredientRow(row.id, ingredientId)}
/>
```

- [ ] **Step 2: Replace ingredient resolution picker**

In `RecipeIngredientResolutionDialog.tsx`, use:

```tsx
<ResourcePickerField
  ariaLabel="选择匹配食材"
  placeholder="搜索已有食材"
  value={selectedIngredientId ?? ''}
  query={searchValue}
  loading={candidateQuery.isFetching}
  options={(candidateQuery.data ?? []).map((ingredient) => ({
    id: ingredient.id,
    label: ingredient.name,
    description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
  }))}
  onQueryChange={setSearchValue}
  onChange={setSelectedIngredientId}
/>
```

- [ ] **Step 3: Replace shopping custom ingredient picker**

In `RecipeShoppingDialog.tsx`, replace `.recipe-shopping-combobox` with:

```tsx
<ResourcePickerField
  ariaLabel="从食材库添加"
  placeholder="搜索食材库"
  value={props.customForm.ingredientId ?? ''}
  query={props.customForm.title}
  options={props.visibleIngredientOptions.map((option) => ({
    id: option.id,
    label: option.name,
    description: `${option.category || '食材'} · 默认 ${option.unit}`,
    image: <MediaWithPlaceholder src={option.imageUrl} alt="" />,
  }))}
  onQueryChange={(nextTitle) => {
    const matched = props.ingredientOptions.find((item) => item.name === nextTitle);
    props.onChangeCustomForm({
      ...props.customForm,
      ingredientId: matched?.id ?? null,
      title: nextTitle,
      unit: matched?.unit ?? props.customForm.unit,
    });
    props.onSetIngredientPickerOpen(true);
  }}
  onChange={(ingredientId) => {
    const option = props.ingredientOptions.find((item) => item.id === ingredientId);
    if (option) props.onSelectIngredientOption(option);
  }}
  emptyText="没有匹配的食材，请先去食材库建档。"
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/ResourcePickerField.test.tsx src/components/recipes/RecipeEditorView.test.tsx src/components/recipes/RecipeWorkspace.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/recipes
git commit -m "refactor: migrate recipe resource pickers"
```

---

### Task 23: Home And Ingredient Resource Picker Migration

**Files:**
- Modify: `frontend/src/features/home/HomeDashboardDialogs.tsx`
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- Test: `frontend/src/features/home/homeDashboardModel.test.ts`
- Test: `frontend/src/components/ingredients/workspaceModel.test.ts`

**Interfaces:**
- Consumes: `ResourcePickerField`.
- Produces: home plan food selection, home restock ingredient selection and ingredient overlay selection use shared resource picker.

- [ ] **Step 1: Replace home food plan picker**

In `HomeDashboardDialogs.tsx`, use:

```tsx
<ResourcePickerField
  ariaLabel="选择食物"
  placeholder="搜索已有食物"
  value={props.homePlanAddFood?.id ?? ''}
  query={props.homePlanAddFoodSearch}
  options={props.homePlanAddFoodOptions.map((food) => ({
    id: food.id,
    label: food.name,
    description: food.routine_note || '家庭食物',
  }))}
  onQueryChange={props.setHomePlanAddFoodSearch}
  onChange={(foodId) => {
    const food = props.homePlanAddFoodOptions.find((item) => item.id === foodId);
    if (food) props.selectHomePlanAddFood(food);
  }}
/>
```

- [ ] **Step 2: Replace ingredient overlay picker**

In `IngredientInventoryOverlay.tsx`, use:

```tsx
<ResourcePickerField
  ariaLabel="选择食材"
  placeholder="搜索已有食材"
  value={props.inventoryForm.ingredientId}
  query={props.inventoryForm.title}
  options={props.ingredientOptions.map((ingredient) => ({
    id: ingredient.id,
    label: ingredient.name,
    description: `${ingredient.category || '食材'} · 默认 ${ingredient.default_unit || '个'}`,
  }))}
  onQueryChange={(title) => props.setInventoryForm((current) => ({ ...current, title }))}
  onChange={(ingredientId) => props.selectInventoryIngredient(ingredientId)}
/>
```

- [ ] **Step 3: Replace shopping overlay picker**

In `IngredientShoppingOverlay.tsx`, use the same `ResourcePickerField` shape with `props.shoppingForm.ingredientId`, `props.shoppingForm.title`, `props.setShoppingForm`, and `props.selectShoppingIngredient`.

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/features/home/homeDashboardModel.test.ts src/components/ingredients/workspaceModel.test.ts src/components/ui-kit/ResourcePickerField.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/home/HomeDashboardDialogs.tsx frontend/src/components/ingredients/IngredientInventoryOverlay.tsx frontend/src/components/ingredients/IngredientShoppingOverlay.tsx
git commit -m "refactor: migrate home and ingredient resource pickers"
```

---

### Task 24: Ingredient Quantity And Unit Migration

**Files:**
- Modify: `frontend/src/components/ingredients/IngredientInventoryOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientShoppingOverlay.tsx`
- Modify: `frontend/src/components/ingredients/IngredientConsumeOverlay.tsx`
- Test: `frontend/src/components/ingredients/consumeQuickHelpers.test.ts`

**Interfaces:**
- Consumes: `QuantityUnitField`.
- Produces: ingredient inventory, shopping and consume quantity controls use shared component.

- [ ] **Step 1: Replace inventory quantity field**

Use:

```tsx
<QuantityUnitField
  quantity={props.inventoryForm.quantity}
  unit={props.inventoryForm.unit || selectedInventoryIngredient?.default_unit || '个'}
  unitOptions={inventoryUnitOptions.map((option) => ({ value: option.unit, label: option.unit }))}
  quantityDisabled={!tracksIngredientQuantity(selectedInventoryIngredient)}
  quantityDisabledReason={!tracksIngredientQuantity(selectedInventoryIngredient) ? '这个食材只记录是否有库存，不填写具体数量。' : undefined}
  onQuantityChange={(quantity) => props.setInventoryForm((current) => ({ ...current, quantity }))}
  onUnitChange={(unit) => props.setInventoryForm((current) => ({ ...current, unit }))}
/>
```

- [ ] **Step 2: Replace shopping quantity field**

Use:

```tsx
<QuantityUnitField
  quantity={props.shoppingForm.quantity}
  unit={props.shoppingForm.unit || selectedShoppingIngredient?.default_unit || '份'}
  unitOptions={shoppingIngredientUnitOptions.map((option) => ({ value: option.unit, label: option.unit }))}
  quantityDisabled={props.shoppingForm.quantityMode === 'not_track_quantity'}
  quantityDisabledReason={props.shoppingForm.quantityMode === 'not_track_quantity' ? '只提醒需要补充，不记录具体数量。' : undefined}
  onQuantityChange={(quantity) => props.setShoppingForm((current) => ({ ...current, quantity }))}
  onUnitChange={(unit) => props.setShoppingForm((current) => ({ ...current, unit }))}
/>
```

- [ ] **Step 3: Replace consume quantity field**

Use:

```tsx
<QuantityUnitField
  quantity={props.consumeForm.quantity}
  unit={selectedConsumeUnit?.unit ?? props.consumeForm.unit}
  unitOptions={consumeUnitOptions.map((option) => ({ value: option.unit, label: option.unit }))}
  quantityDisabled={!tracksIngredientQuantity(selectedConsumeSummary.ingredient)}
  quantityDisabledReason={!tracksIngredientQuantity(selectedConsumeSummary.ingredient) ? '这个食材只记录是否还有，不按数量扣减。' : undefined}
  onQuantityChange={(quantity) => props.setConsumeForm((current) => ({ ...current, quantity }))}
  onUnitChange={(unit) => props.setConsumeForm((current) => ({ ...current, unit }))}
/>
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/QuantityUnitField.test.tsx src/components/ingredients/consumeQuickHelpers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ingredients
git commit -m "refactor: migrate ingredient quantity fields"
```

---

### Task 25: Recipe Quantity And Unit Migration

**Files:**
- Modify: `frontend/src/components/recipes/RecipeEditorView.tsx`
- Modify: `frontend/src/components/recipes/RecipeShoppingDialog.tsx`
- Test: `frontend/src/components/recipes/RecipeEditorView.test.tsx`
- Test: `frontend/src/components/recipes/RecipeWorkspace.test.ts`

**Interfaces:**
- Consumes: `QuantityUnitField`.
- Produces: recipe ingredient and shopping quantity controls use shared component.

- [ ] **Step 1: Replace recipe ingredient quantity field**

In `RecipeEditorView.tsx`, use:

```tsx
<QuantityUnitField
  quantity={row.quantity}
  unit={row.unit || '份'}
  unitOptions={[row.unit || '份', ...SHOPPING_UNIT_OPTIONS].filter((unit, index, list) => unit && list.indexOf(unit) === index).map((unit) => ({ value: unit, label: unit }))}
  quantityDisabled={row.requirement === 'presence'}
  quantityDisabledReason={row.requirement === 'presence' ? '这个食材只记录是否需要，不按数量计算。' : undefined}
  onQuantityChange={(quantity) => updateIngredientRow(row.id, { quantity })}
  onUnitChange={(unit) => updateIngredientRow(row.id, { unit })}
/>
```

- [ ] **Step 2: Replace recipe shopping quantity field**

In `RecipeShoppingDialog.tsx`, use the `QuantityUnitField` snippet already defined in Task 5 with `item`, `props.unitOptions`, and `props.onUpdateDraft`.

- [ ] **Step 3: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/QuantityUnitField.test.tsx src/components/recipes/RecipeEditorView.test.tsx src/components/recipes/RecipeWorkspace.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/recipes
git commit -m "refactor: migrate recipe quantity fields"
```

---

### Task 26: Chip, Badge And State Migration

**Files:**
- Modify: `frontend/src/components/ingredients/IngredientWorkspacePanels.tsx`
- Modify: `frontend/src/components/ingredients/IngredientEditorView.tsx`
- Modify: `frontend/src/components/foods/FoodMobileView.tsx`
- Modify: `frontend/src/components/foods/FoodWorkspace.tsx`
- Modify: `frontend/src/features/home/HomeDashboard.tsx`
- Modify: `frontend/src/features/meals/MealLogMobileView.tsx`
- Modify: `frontend/src/features/family/FamilySettings.tsx`
- Test: `frontend/src/components/ingredients/workspaceModel.test.ts`
- Test: `frontend/src/components/foods/FoodWorkspace.test.ts`
- Test: `frontend/src/features/home/homeDashboardModel.test.ts`
- Test: `frontend/src/features/meals/MealLogWorkspaceModel.test.ts`

**Interfaces:**
- Consumes: `OptionChipGroup`, `StatusBadge`, `StateBlock`.
- Produces: filter chip rows, semantic badges and custom empty states use shared primitives.

- [ ] **Step 1: Replace ingredient filter chips**

In `IngredientWorkspacePanels.tsx`, use:

```tsx
<OptionChipGroup
  ariaLabel="食材分类筛选"
  value={props.catalogCategoryFilter}
  options={[
    { value: 'all', label: '全部' },
    ...props.catalogCategories.map((category) => ({ value: category, label: category })),
  ]}
  onChange={props.setCatalogCategoryFilter}
  className="ingredients-category-chip-group"
/>
```

- [ ] **Step 2: Replace ingredient editor chips**

In `IngredientEditorView.tsx`, use `OptionChipGroup` for category, unit preset and storage preset rows. For storage:

```tsx
<OptionChipGroup
  ariaLabel="默认保存位置"
  value={props.ingredientForm.default_storage}
  options={INVENTORY_STORAGE_PRESETS.map((storage) => ({ value: storage, label: storage }))}
  onChange={(defaultStorage) => props.setIngredientForm((current) => ({ ...current, default_storage: defaultStorage }))}
/>
```

- [ ] **Step 3: Replace semantic badges**

Use `StatusBadge` for status badges. Example in `HomeDashboard.tsx`:

```tsx
<StatusBadge tone={item.done ? 'success' : item.status === '紧急' ? 'danger' : 'warning'}>
  {item.done ? '已完成' : item.status}
</StatusBadge>
```

Use `Badge` only for neutral metadata.

- [ ] **Step 4: Replace custom empty blocks**

Use `StateBlock` for custom empty text blocks. Example:

```tsx
<StateBlock
  status="empty"
  title="还没有匹配结果"
  description="调整筛选条件，或先添加一条家庭食材。"
  actionLabel="清空筛选"
  onAction={clearFilters}
/>
```

- [ ] **Step 5: Run tests**

Run: `npm --prefix frontend run test -- src/components/ui-kit/OptionChipGroup.test.tsx src/components/ingredients/workspaceModel.test.ts src/components/foods/FoodWorkspace.test.ts src/features/home/homeDashboardModel.test.ts src/features/meals/MealLogWorkspaceModel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components frontend/src/features
git commit -m "refactor: migrate chips badges and states"
```

---

### Task 27: Style Cleanup, Compatibility Removal And Full Verification

**Files:**
- Modify: `frontend/src/components/ui-kit.tsx`
- Modify: `frontend/src/styles/00-ui-kit.css`
- Modify: `frontend/src/styles/01-home-dashboard.css`
- Modify: `frontend/src/styles/02-family-settings.css`
- Modify: `frontend/src/styles/03-recipe-workspace.css`
- Modify: `frontend/src/styles/04-ingredients-workspace.css`
- Modify: `frontend/src/styles/05-workspace-overlays.css`
- Modify: `frontend/src/styles/06-food-workspace.css`
- Modify: `frontend/src/styles/07-mobile.css`
- Modify: `frontend/src/styles/08-meal-log.css`
- Modify: `docs/frontend-code-standards.md`
- Modify: `docs/plans/README.md`

**Interfaces:**
- Consumes: all migrated components from Tasks 1-26.
- Produces: no duplicate local component styles for migrated primitives; documentation records the new full-migration baseline.

- [x] **Step 1: Verify migration grep gates**

Run:

```bash
rg -n "function CustomSelect|RecipeToolbarDropdown|<select|SearchLoadingIndicator|workspace-overlay-actions|recipe-shopping-stepper|ingredients-choice-chip|ingredients-unit-chip" frontend/src/components frontend/src/features --glob '*.{tsx,ts}'
```

Expected: no results, except `SearchLoadingIndicator` inside `frontend/src/components/ui-kit/SearchField.tsx` if `rg` scope includes ui-kit.

- [x] **Step 2: Remove obsolete CSS selectors**

Delete CSS blocks that only served migrated primitives:

```txt
custom-select-container
custom-select-trigger
custom-select-dropdown
custom-select-option
recipe-toolbar-dropdown
recipe-shopping-stepper
recipe-shopping-select-shell
ingredients-choice-chip
ingredients-unit-chip
workspace-overlay-actions
food-governance-chips
dashboard-chip-row
mobile-food-chip-row
mobile-ingredient-chip-row
mobile-recipe-chip-row
```

Keep business-specific layout classes when they still wrap domain cards or page sections.

- [x] **Step 3: Keep compatibility exports only for public names**

In `frontend/src/components/ui-kit.tsx`, keep exports for existing names that are still used. Because this compatibility file is itself named `ui-kit.tsx`, the directory export must target the directory index explicitly:

```ts
export * from './ui-kit/index';
```

Run:

```bash
rg -n "from '../ui-kit'|from '../../components/ui-kit'|from './components/ui-kit'" frontend/src --glob '*.{tsx,ts}'
```

Expected: imports continue to work through the compatibility file. Do not force every import to `../ui-kit/index` in this plan.

- [x] **Step 4: Update docs**

In `docs/frontend-code-standards.md`, replace the basic component section from Task 6 with this final baseline:

```md
## 基础组件统一化

高频基础组件统一放在 `frontend/src/components/ui-kit/`，并通过 `frontend/src/components/ui-kit.tsx` 兼容出口导出。业务页面不得再新增局部 `CustomSelect`、裸业务确认弹窗、重复搜索输入、重复数量单位输入或自建筛选 chip。

- 弹窗、确认框、表单动作、下拉选择、可输入 combobox、资源选择、搜索输入、数量单位输入、chip group、状态徽标、状态块和移动端底部动作栏属于基础组件。
- 基础组件只负责结构、视觉、可访问性、loading/disabled/error 状态、手机端触控尺寸和桌面/手机 presentation。
- 食材、食物、菜谱、AI 审批等业务规则不得写入基础组件；这些规则应留在业务 model、hook 或具体业务组件中。
- 手机端和桌面/pad 端共享基础语义和 props；弹层、选择器、导航和长列表可在组件内部使用不同 presentation。
- 基础组件样式放在 `frontend/src/styles/00-ui-kit.css`，使用 `.ui-*` 前缀；业务域样式继续放在对应业务 CSS 文件中。
```

In `docs/plans/README.md`, add:

```md
- `docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md`：前端基础组件统一化全量迁移计划，覆盖基础组件设计、全业务迁移、样式清理和验证命令。
```

- [x] **Step 5: Run full frontend verification**

Run:

```bash
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run smoke
npm --prefix frontend run check:style-tokens
git diff --check
```

Expected:

- Vitest PASS.
- Typecheck PASS.
- Build exits 0. Bundle budget warnings may remain warnings.
- Smoke PASS.
- `check:style-tokens` exits 0. Report-only matches may remain report-only.
- `git diff --check` produces no output.

- [x] **Step 6: Commit**

```bash
git add frontend/src docs/frontend-code-standards.md docs/plans/README.md docs/superpowers/plans/2026-07-06-frontend-ui-kit-unification.md
git commit -m "refactor: complete frontend ui kit migration"
```

---

## Self-Review

**Spec coverage:** This plan covers the requested frontend基础组件统一化全量迁移 with concrete locations, phone vs desktop/pad boundary, modal/dialog standardization, dropdown/combobox replacement, resource picker migration, form actions, form field, search field, quantity/unit field, chip group, status badge, state block, mobile action bar, style cleanup, docs updates and validation commands.

**Placeholder scan:** The plan avoids placeholder markers, deferred-work language and open-ended edge-case instructions. Every code-changing step includes exact code blocks or exact replacement snippets.

**Type consistency:** Component names and exports are consistent across tasks: `DropdownSelect`, `ComboboxField`, `ResourcePickerField`, `OptionChipGroup`, `StatusBadge`, `StateBlock`, `MobileActionBar`, `FormActions`, `ConfirmDialog`, `FormField`, `SearchField`, `QuantityUnitField`. All new exports are routed through `frontend/src/components/ui-kit/index.ts` and then through existing `frontend/src/components/ui-kit.tsx`.

**Risk control:** The plan performs full migration but keeps tasks split by interaction type, with targeted tests and commits after each gate. AI approval-specific selectors are migrated by preserving their exported wrapper names while moving their internals onto shared primitives, so backend approval contracts and existing tests remain the behavior guard.
