# AI Draft UI System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a reusable AI Draft UI system and migrate all ten approval Draft types to it without changing business data, validation, payloads, resource queries, or approval semantics.

**Architecture:** Keep ApprovalPanel as the owner of approval state, failure recovery, comments, decisions, validation, and submission. Add a Draft-specific component layer under frontend/src/components/ai/draft-ui, use existing ui-kit controls directly wherever their behavior fits, and move type-specific JSX into explicit Draft Views selected by AiDraftRenderer. Custom business UI remains permitted inside a View when it follows the new Draft visual contract.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, existing Culina ui-kit, CSS custom properties, existing AI workspace contracts, Playwright smoke checks.

**Approved design:** docs/superpowers/specs/2026-07-22-ai-draft-ui-system-design.md

## Global Constraints

- Work only from the current main-derived branch; preserve every existing Draft field, default, validation result, payload, resource query, and approval result.
- Cover exactly recipe, recipe_cook, meal_plan, shopping_list, inventory_intake, meal_log, food_profile, ingredient_profile, inventory_operation, and composite_operation.
- Exclude RecipeDraftDialog because it is a generation workspace dialog rather than an approval Draft.
- Do not add a schema/config-driven generic form renderer, a new backend contract, a database migration, an AI runtime change, or a cache/query change.
- ApprovalPanel remains the sole owner of submitted values, validation, comment, approval/rejection, failure recovery, and collapse timing.
- Use DropdownSelect, ComboboxField, SearchableResourceSelect, QuantityUnitField, FormActions, StatusBadge, and StateBlock directly when their existing semantics fit. Do not create parallel Draft button/select controls.
- OptionChipGroup is single-select. Do not use it to replace an existing multi-select interaction; retain a Draft-specific multi-select only where that behavior is required.
- Draft Views may define custom cards and layouts for genuine domain-specific structures. They must use canonical tokens, real labels, 44px minimum hit targets, 44px desktop controls, 48px touch controls, focus-visible behavior, and meaningful non-color state text.
- Pending uses plan semantics; attention uses warning; dangerous effects use danger; resolved output is compact and must not look submit-ready.
- New shared CSS belongs in frontend/src/styles/09-ai-draft-ui.css with .ai-draft-* prefixes. Keep conversation/composer styles in 09-ai-workspace.css and remove migrated duplicate rules instead of stacking overrides.
- Add .agents/skills/frontend-ui-style/references/ai-draft-patterns.md and route every AI Draft/approval-Draft task to it from .agents/skills/frontend-ui-style/SKILL.md.
- Test user-observable behavior and semantic state. Do not replace interaction tests with broad class-name assertions.
- Stage explicit paths only. Each task ends with a focused commit; do not push or open the PR during this plan.

---

## Dependency Order

    baseline
      -> style reference and CSS entry
      -> Draft primitives
      -> Draft field adapters
      -> renderer contract
      -> generated recipe and recipe operation
      -> recipe cook
      -> meal plan
      -> shopping list
      -> meal log
      -> food profile
      -> ingredient profile and transition editor
      -> inventory intake
      -> inventory operation
      -> composite operation and composition correction
      -> legacy cleanup and full verification

## File Responsibility Map

### Create

- frontend/src/components/ai/draft-ui/types.ts — Draft-only tone, summary, field, and renderer contracts.
- frontend/src/components/ai/draft-ui/AiDraftSummaryCard.tsx — common pending/resolved summary surface.
- frontend/src/components/ai/draft-ui/AiDraftSection.tsx — labelled section structure with optional action slot.
- frontend/src/components/ai/draft-ui/AiDraftImpactNote.tsx — plan, warning, danger, and neutral impact disclosure.
- frontend/src/components/ai/draft-ui/AiDraftItemCard.tsx — repeated object card frame with header/body/footer slots.
- frontend/src/components/ai/draft-ui/AiDraftResolvedSummary.tsx — compact approved/rejected/expired/cancelled summary.
- frontend/src/components/ai/draft-ui/AiDraftField.tsx — visible label, help, error, and control relationship.
- frontend/src/components/ai/draft-ui/AiDraftResourceField.tsx — Draft field frame around SearchableResourceSelect.
- frontend/src/components/ai/draft-ui/AiDraftTagInput.tsx — delimiter-preserving tag input and visible chip preview.
- frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx — typed dispatch from ApprovalPanel to Draft Views.
- frontend/src/components/ai/draft-ui/AiDraftPrimitives.test.tsx — primitive semantic and accessibility coverage.
- frontend/src/components/ai/draft-ui/AiDraftFieldAdapters.test.tsx — resource/tag/field interaction coverage.
- frontend/src/components/ai/draft-ui/views/AiGeneratedRecipeDraftView.tsx — generated recipe editor only.
- frontend/src/components/ai/draft-ui/views/AiRecipeOperationDraftView.tsx — structured recipe create/update/delete/favorite view.
- frontend/src/components/ai/draft-ui/views/AiRecipeCookDraftView.tsx — recipe-cook view.
- frontend/src/components/ai/draft-ui/views/AiMealPlanDraftView.tsx — meal-plan view.
- frontend/src/components/ai/draft-ui/views/AiShoppingListDraftView.tsx — shopping-list view.
- frontend/src/components/ai/draft-ui/views/AiMealLogDraftView.tsx — meal-log view.
- frontend/src/components/ai/draft-ui/views/AiFoodProfileDraftView.tsx — food-profile view.
- frontend/src/components/ai/draft-ui/views/AiIngredientProfileDraftView.tsx — ingredient-profile view.
- frontend/src/styles/09-ai-draft-ui.css — shared Draft component styles and responsive rules.
- .agents/skills/frontend-ui-style/references/ai-draft-patterns.md — future Draft implementation reference.

### Modify

- frontend/src/components/ai/AiApprovalPanel.tsx — retain approval state/validation/submission; delegate display to AiDraftRenderer.
- frontend/src/components/ai/AiApprovalFields.tsx — keep exported resource contracts; replace duplicate field chrome with Draft field adapters and ui-kit.
- frontend/src/components/ai/AiInventoryIntakeApproval.tsx — compose Draft primitives without changing intake model callbacks.
- frontend/src/components/ai/AiInventoryOperationEditor.tsx — compose Draft primitives without changing inventory model callbacks.
- frontend/src/components/ai/AiCompositeOperationPreview.tsx — compose Draft primitives without changing composite validation.
- frontend/src/components/ai/AiSpecializedApprovalEditors.tsx — compose Draft primitives without changing transition/composition validation.
- frontend/src/components/ai/AiApprovalPanel.test.tsx — retain and extend approval behavior coverage across migrated views.
- frontend/src/components/ai/AiInventoryIntakeApproval.test.tsx — preserve intake row behavior while asserting common UI semantics.
- frontend/src/components/ai/AiInventoryOperationApproval.test.tsx — preserve inventory concurrency/batch behavior while asserting common UI semantics.
- frontend/src/components/ai/AiLegacyStylesUsage.test.ts — verify new Draft stylesheet ownership and import.
- frontend/src/styles.css — import 09-ai-draft-ui.css after 09-ai-workspace.css and before the mobile aggregation layer.
- frontend/src/styles/09-ai-workspace.css — remove only shared Draft rules that move to the new stylesheet; preserve non-Draft AI workspace styles.
- .agents/skills/frontend-ui-style/SKILL.md — add the required route to ai-draft-patterns.md.

---

### Task 0: Capture the Current Approval Baseline

**Files:** No product changes.

**Interfaces:** Produces a known-green main-derived baseline and a list of current approval behavior tests that must remain green.

- [ ] **Step 1: Verify branch and source scope**

    git status --short
    git branch --show-current
    git log -2 --oneline
    rg -n "draftType ===|isRecipeApproval|renderStructuredDraftEditor|submitDecision" frontend/src/components/ai/AiApprovalPanel.tsx

    Expected: the worktree is clean and the ten supported structured Draft types remain listed in ApprovalPanel.

- [ ] **Step 2: Run the focused approval baseline**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiInventoryIntakeApproval.test.tsx src/components/ai/AiInventoryOperationApproval.test.tsx src/lib/aiWorkspaceContracts.test.ts

    Expected: PASS before any UI extraction. Stop and diagnose a failure before changing source.

- [ ] **Step 3: Record CSS ownership before migration**

    rg -n "^\\.ai-(confirmation-item|resource-field|resource-select|approval-panel|approval-actions|inventory-intake|inventory-operation|composite-operation)" frontend/src/styles/09-ai-workspace.css

    Expected: the command identifies the shared rules to move and the type-specific rules that must remain local.

- [ ] **Step 4: Commit nothing**

    git status --short

    Expected: no modified or staged files.

### Task 1: Add the Draft Style Reference and Shared CSS Entry

**Files:**

- Create: .agents/skills/frontend-ui-style/references/ai-draft-patterns.md
- Create: frontend/src/styles/09-ai-draft-ui.css
- Modify: .agents/skills/frontend-ui-style/SKILL.md
- Modify: frontend/src/styles.css
- Modify: frontend/src/components/ai/AiLegacyStylesUsage.test.ts

**Interfaces:** Produces the canonical Draft UI reference and one dedicated stylesheet import. Later component tasks own only .ai-draft-* rules in this file.

- [ ] **Step 1: Write the failing style-ownership test**

    Add this test to AiLegacyStylesUsage.test.ts:

    it('loads shared AI Draft styles from the dedicated stylesheet', () => {
      const entry = readFileSync(resolve(repoRoot, 'src/styles.css'), 'utf8');
      const draftStyles = readFileSync(resolve(repoRoot, 'src/styles/09-ai-draft-ui.css'), 'utf8');

      expect(entry).toContain("@import './styles/09-ai-draft-ui.css';");
      expect(draftStyles).toContain('.ai-draft-summary-card');
      expect(draftStyles).toContain('.ai-draft-section');
    });

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiLegacyStylesUsage.test.ts

    Expected: FAIL because the stylesheet and import do not exist.

- [ ] **Step 3: Add the reference, route, and empty-safe style foundation**

    Create ai-draft-patterns.md with these exact top-level sections:

    # AI Draft Patterns
    ## Scope and Exclusions
    ## Reuse Decision
    ## Pending, Busy, Failure, and Resolved States
    ## Summary, Section, Item, and Impact Roles
    ## Field and Resource Selection Rules
    ## Custom UI Boundary
    ## Responsive and Accessibility Requirements
    ## Review Checklist

    In frontend-ui-style/SKILL.md, add one routing bullet that requires this reference for AI Draft, approval Draft, approval-card, Draft-component, and Draft-CSS work. In styles.css add:

    @import './styles/09-ai-draft-ui.css';

    The new stylesheet initially defines the token-based shared root selectors:

    .ai-draft-summary-card,
    .ai-draft-section,
    .ai-draft-impact-note,
    .ai-draft-item-card,
    .ai-draft-resolved-summary {
      min-width: 0;
    }

- [ ] **Step 4: Verify the reference and test**

    rg -n "^## (Scope and Exclusions|Reuse Decision|Pending, Busy, Failure, and Resolved States|Custom UI Boundary|Review Checklist)$" .agents/skills/frontend-ui-style/references/ai-draft-patterns.md
    npm --prefix frontend run test -- src/components/ai/AiLegacyStylesUsage.test.ts
    npm --prefix frontend run check:style-tokens

    Expected: the reference has all required sections; the ownership test passes; the style report has no new unexplained Draft-specific hit.

- [ ] **Step 5: Commit**

    git add .agents/skills/frontend-ui-style/SKILL.md .agents/skills/frontend-ui-style/references/ai-draft-patterns.md frontend/src/styles.css frontend/src/styles/09-ai-draft-ui.css frontend/src/components/ai/AiLegacyStylesUsage.test.ts
    git commit -m "docs: define AI draft UI patterns"

### Task 2: Build the Structural Draft Primitives

**Files:**

- Create: frontend/src/components/ai/draft-ui/types.ts
- Create: frontend/src/components/ai/draft-ui/AiDraftSummaryCard.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftSection.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftImpactNote.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftItemCard.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftResolvedSummary.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftPrimitives.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export type AiDraftTone = 'plan' | 'warning' | 'danger' | 'neutral' | 'success';

    export type AiDraftSummaryItem = {
      label: string;
      value: ReactNode;
    };

    export type AiDraftResolvedStatus = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'canceled';

    export function AiDraftSummaryCard(props: {
      title: string;
      items: readonly AiDraftSummaryItem[];
      tone?: AiDraftTone;
      children?: ReactNode;
      className?: string;
    }): JSX.Element;

    export function AiDraftSection(props: {
      title: string;
      description?: string;
      action?: ReactNode;
      children: ReactNode;
      className?: string;
    }): JSX.Element;

    export function AiDraftImpactNote(props: {
      tone: Exclude<AiDraftTone, 'success'>;
      title: string;
      children: ReactNode;
      className?: string;
    }): JSX.Element;

    export function AiDraftItemCard(props: {
      title: string;
      summary?: ReactNode;
      status?: ReactNode;
      children: ReactNode;
      footer?: ReactNode;
      className?: string;
    }): JSX.Element;

    export function AiDraftResolvedSummary(props: {
      status: AiDraftResolvedStatus;
      title: string;
      summary: ReactNode;
      children?: ReactNode;
      className?: string;
    }): JSX.Element;

- [ ] **Step 1: Write failing primitive tests**

    Add tests that render a summary with two items, a labelled section with an action, a warning impact note, an item card with a footer, and each resolved status. Assert real headings, status text, role semantics, and children:

    expect(view.getByRole('heading', { name: '本次变更' })).toBeTruthy();
    expect(view.getByText('3 项')).toBeTruthy();
    expect(view.getByRole('note', { name: '确认影响' })).toBeTruthy();
    expect(view.getByText('已确认')).toBeTruthy();

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/draft-ui/AiDraftPrimitives.test.tsx

    Expected: FAIL because draft-ui modules do not exist.

- [ ] **Step 3: Implement semantic primitives and token CSS**

    Use StatusBadge inside status-bearing primitives. AiDraftSection must generate a stable heading relationship with useId rather than using a bare div. AiDraftImpactNote uses role="note" for plan/warning/neutral and role="alert" for danger. AiDraftResolvedSummary maps status to the existing approved/rejected/expired/cancelled Chinese strings without introducing success language before approval.

    Add token-only CSS with desktop and touch sizing:

    .ai-draft-summary-card,
    .ai-draft-item-card,
    .ai-draft-resolved-summary {
      display: grid;
      gap: var(--space-4);
      border: 1px solid var(--line-soft);
      border-radius: var(--radius-md);
      background: var(--surface);
      padding: var(--space-5);
    }

    @media (max-width: 767px) {
      .ai-draft-summary-card,
      .ai-draft-item-card,
      .ai-draft-resolved-summary {
        padding: var(--space-4);
      }
    }

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/draft-ui/AiDraftPrimitives.test.tsx
    npm --prefix frontend run check:style-tokens

    Expected: primitive tests pass and the report contains no new unexplained rule.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/types.ts frontend/src/components/ai/draft-ui/AiDraftSummaryCard.tsx frontend/src/components/ai/draft-ui/AiDraftSection.tsx frontend/src/components/ai/draft-ui/AiDraftImpactNote.tsx frontend/src/components/ai/draft-ui/AiDraftItemCard.tsx frontend/src/components/ai/draft-ui/AiDraftResolvedSummary.tsx frontend/src/components/ai/draft-ui/AiDraftPrimitives.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "feat: add AI draft layout primitives"

### Task 3: Add Field, Resource, and Tag Adapters Without Duplicating ui-kit

**Files:**

- Create: frontend/src/components/ai/draft-ui/AiDraftField.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftResourceField.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftTagInput.tsx
- Create: frontend/src/components/ai/draft-ui/AiDraftFieldAdapters.test.tsx
- Modify: frontend/src/components/ai/AiApprovalFields.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiDraftField(props: {
      label: string;
      helpText?: string;
      error?: string;
      required?: boolean;
      children: ReactNode;
      className?: string;
    }): JSX.Element;

    export function AiDraftResourceField<T extends string>(props: {
      label: string;
      value: T | '';
      selectedLabel?: string;
      query: string;
      options: readonly SearchableResourceOption<T>[];
      onQueryChange: (value: string) => void;
      onChange: (value: T) => void;
      loading?: boolean;
      loadingMore?: boolean;
      hasMore?: boolean;
      onLoadMore?: () => void;
      disabled?: boolean;
      emptyText?: string;
      children?: ReactNode;
    }): JSX.Element;

    export function AiDraftTagInput(props: {
      label: string;
      values: readonly string[];
      disabled: boolean;
      placeholder: string;
      onChange: (values: string[]) => void;
      helpText?: string;
    }): JSX.Element;

- [ ] **Step 1: Write failing adapter tests**

    Test the following user-visible behavior:

    - AiDraftField exposes a visible label, help text, required marker, and role=alert error through one labelled field group around its child control.
    - AiDraftResourceField opens a search surface, sends query changes, selects an option, and exposes loading-more state without owning a query request.
    - AiDraftTagInput preserves the existing delimiter semantics: "清淡、香辣、清淡" becomes ["清淡", "香辣"] and its preview exposes both chips.
    - AiApprovalFields retains its exported AiResourceOption and AiResourceOptionLoader types and still supports paged resource loading.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/draft-ui/AiDraftFieldAdapters.test.tsx src/components/ai/AiApprovalPanel.test.tsx

    Expected: new module imports fail.

- [ ] **Step 3: Implement the adapter boundary**

    AiDraftField owns only label/help/error markup. Use DropdownSelect and ComboboxField directly inside it; do not introduce AiDraftSelect or AiDraftCombobox.

    AiDraftResourceField composes the existing SearchableResourceSelect. It receives query, options, loading, pagination, and callbacks from its parent, so existing resourceOptionLoader ownership in ApprovalPanel remains unchanged.

    Move the current splitTextList and unique-text behavior from ApprovalPanel into AiDraftTagInput without changing delimiter handling or deduplication. Keep its input editable and its preview read-only; do not add per-chip removal controls because that would alter the existing interaction.

    Refactor AiApprovalFields as follows:

    - ApprovalSelectField and ApprovalComboboxField use AiDraftField plus the existing ui-kit control.
    - AiSearchableResourceSelect delegates its field chrome and list presentation to AiDraftResourceField while retaining its public props.
    - ApprovalMultiSelectField remains a Draft-specific multi-select because OptionChipGroup is single-select; retain role=listbox, aria-multiselectable, Escape/outside-click behavior, and its controlled value array.
    - IngredientQuantityPicker retains ComboboxField for custom units; use QuantityUnitField only in callers whose units are finite options and do not allow custom values.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/draft-ui/AiDraftFieldAdapters.test.tsx src/components/ai/AiApprovalPanel.test.tsx
    npm --prefix frontend run check:style-tokens

    Expected: resource pagination, tag deduplication, recipe/meal-plan field editing, and existing approval tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/AiDraftField.tsx frontend/src/components/ai/draft-ui/AiDraftResourceField.tsx frontend/src/components/ai/draft-ui/AiDraftTagInput.tsx frontend/src/components/ai/draft-ui/AiDraftFieldAdapters.test.tsx frontend/src/components/ai/AiApprovalFields.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "feat: add AI draft field adapters"

### Task 4: Introduce the Renderer Contract and Preserve ApprovalPanel Ownership

**Files:**

- Create: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx

**Interfaces:**

    export type AiDraftRendererProps = {
      approval: AiApprovalRequest;
      draftType: string;
      recipeApproval: boolean;
      recipe: AiGeneratedRecipeDraft;
      structuredDraft: Record<string, unknown>;
      readonly: boolean;
      foodOptions: readonly AiResourceOption[];
      ingredientOptions: readonly AiResourceOption[];
      onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
      onStructuredDraftChange: (next: Record<string, unknown>) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
      renderLegacyFallback: () => ReactNode;
    };

- [ ] **Step 1: Write failing dispatch tests**

    Add tests that render a generated recipe approval and an inventory-intake approval through ApprovalPanel. Assert that the existing visible title, confirmation label, and no-extra-submit-button behavior remain present while the renderer is mounted.

    Add a direct renderer test with an unknown draft type:

    const fallback = vi.fn(() => <p>原始草稿</p>);
    render(<AiDraftRenderer {...baseProps} draftType="unknown" renderLegacyFallback={fallback} />);
    expect(fallback).toHaveBeenCalledOnce();
    expect(screen.getByText('原始草稿')).toBeTruthy();

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: FAIL because AiDraftRenderer is not imported or mounted.

- [ ] **Step 3: Implement a temporary explicit renderer boundary**

    Create AiDraftRenderer with an explicit switch, not a schema renderer. It receives only display-state props and never calls onDecision, sets validation errors, serializes payloads, or reads queries.

    In ApprovalPanel retain:

    const submitDecision = async (decision: 'approved' | 'rejected') => {
      // keep all current validation and values construction here unchanged
    };

    Replace the direct renderStructuredDraftEditor invocation with AiDraftRenderer. Initially preserve unmatched branches through renderLegacyFallback. Keep approvalStatusText exported from AiApprovalPanel because AiResultCards imports it. Keep getApprovalFailureSummary and its current-value/recovery data in ApprovalPanel, but place its existing details inside AiDraftImpactNote so failure chrome follows the shared Draft contract.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiResultCards.test.tsx

    Expected: existing generic JSON fallback and visible approval shell behavior remain unchanged.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx
    git commit -m "refactor: add AI draft renderer boundary"

### Task 5: Migrate Generated Recipe and Recipe Operation Views

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiGeneratedRecipeDraftView.tsx
- Create: frontend/src/components/ai/draft-ui/views/AiRecipeOperationDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiGeneratedRecipeDraftView(props: {
      recipe: AiGeneratedRecipeDraft;
      readonly: boolean;
      ingredientOptions: readonly AiResourceOption[];
      onRecipeChange: (next: AiGeneratedRecipeDraft) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
    }): JSX.Element;

    export function AiRecipeOperationDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      ingredientOptions: readonly AiResourceOption[];
      onDraftChange: (next: Record<string, unknown>) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
    }): JSX.Element;

- [ ] **Step 1: Add failing recipe semantic tests**

    Add one generated-recipe test that requires headings for “菜谱信息”, “食材”, “烹饪步骤”, and “补充信息”, then edits an ingredient quantity and a step key point before approval.

    Add operation tests requiring a readable before/after summary for update and an explicit danger impact note for delete. Keep the existing assertions that unbound ingredients block approval and retired favorite operations are rejected.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new heading/impact semantics are absent before migration.

- [ ] **Step 3: Extract exact existing behavior into two Views**

    Move only display JSX and local array-edit callbacks out of ApprovalPanel. Preserve blankRecipeDraft, validateRecipeDraftForSubmit, validateRecipeOperationDraftForSubmit, recipeDraftFromRecord, and submission construction in ApprovalPanel or their current helper scope.

    In the generated view, map the existing editor into:

    <AiDraftSummaryCard title={recipe.title || '菜谱草稿'} items={summaryItems}>
      <AiDraftImpactNote tone="plan" title="确认后">将创建或更新这道菜谱。</AiDraftImpactNote>
    </AiDraftSummaryCard>
    <AiDraftSection title="食材">{ingredientCards}</AiDraftSection>
    <AiDraftSection title="烹饪步骤">{stepCards}</AiDraftSection>

    Use AiDraftItemCard for ingredient and step rows; keep current add/remove minimum-item behavior and custom unit ComboboxField behavior.

    In the operation view, preserve the exact update/delete/favorite branches and before snapshots. Render delete impact through AiDraftImpactNote tone="danger"; do not alter the operation payload.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: all existing recipe tests plus the new semantic tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiGeneratedRecipeDraftView.tsx frontend/src/components/ai/draft-ui/views/AiRecipeOperationDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate recipe draft views"

### Task 6: Migrate Recipe-Cook Draft UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiRecipeCookDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiRecipeCookDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      status: AiApprovalRequest['status'];
      schemaVersion: 'recipe_cook_operation.v1' | 'recipe_cook_operation.v2' | 'unknown';
      onDraftChange: (next: Record<string, unknown>) => void;
    }): JSX.Element;

- [ ] **Step 1: Add failing recipe-cook tests**

    Require a summary card with recipe, date, meal type, servings, and shortage count. Require a warning impact note when shortages exist and a compact resolved summary when the approval is no longer pending.

    Keep the current v1 regeneration and v2 always-record submission tests unchanged.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new summary/impact semantics fail before the view is selected.

- [ ] **Step 3: Implement the view**

    Move recipe-cook display JSX and only its display helpers into AiRecipeCookDraftView. Use:

    <AiDraftSummaryCard title={title} items={recipeCookSummaryItems(draft, schemaVersion)} />
    <AiDraftSection title="做菜结果">{editableResultFields}</AiDraftSection>
    <AiDraftSection title="食材与库存">{previewItems}</AiDraftSection>
    <AiDraftImpactNote tone="warning" title="库存提醒">{shortageText}</AiDraftImpactNote>

    Do not move resolveRecipeCookSchemaVersion, validateRecipeCookDraftForSubmit, buildRecipeCookSubmitDraft, or the disabled-regeneration decision out of ApprovalPanel.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: recipe cook v1/v2, shortage, readable preview, and submission tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiRecipeCookDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate recipe cook draft view"

### Task 7: Migrate Meal-Plan Draft UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiMealPlanDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiMealPlanDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      foodOptions: readonly AiResourceOption[];
      ingredientOptions: readonly AiResourceOption[];
      onDraftChange: (next: Record<string, unknown>) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
    }): JSX.Element;

- [ ] **Step 1: Add failing meal-plan tests**

    Require a summary card that exposes plan-operation count and a section heading for each existing plan item. Require a warning impact note for missing ingredients and a danger impact note for delete operations.

    Preserve existing tests for resource images, quantity edits, paged resource loading, binding validation, and compact resolved output.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new headings and impact-note semantics fail.

- [ ] **Step 3: Implement the view**

    Move meal-plan rendering into AiMealPlanDraftView. Compose:

    <AiDraftSummaryCard title="餐食计划" items={mealPlanSummaryItems(items, operations)} />
    <AiDraftSection title="计划项">{operationOrItemCards}</AiDraftSection>
    <AiDraftImpactNote tone="warning" title="缺料提醒">...</AiDraftImpactNote>

    Keep normalizeMealPlanIngredientItems, updateDraftItem, addDraftItem, removeDraftItem, validateMealPlanDraftForSubmit, and resource-loader state behavior unchanged. Use AiDraftResourceField for food/ingredient lookup and retain custom-unit behavior through ComboboxField.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: all meal-plan tests pass, including pagination and submission payload assertions.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiMealPlanDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate meal plan draft view"

### Task 8: Migrate Shopping-List Draft UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiShoppingListDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiShoppingListDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      ingredientOptions: readonly AiResourceOption[];
      onDraftChange: (next: Record<string, unknown>) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
    }): JSX.Element;

- [ ] **Step 1: Add failing shopping-list tests**

    Require a “采购清单摘要” summary, a “采购项” section, an impact note for delete/set_done changes, and a compact resolved summary. Keep the existing quantity mode, unit combobox, numeric-empty, binding validation, and nested operation submission tests.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new summary and impact semantics fail.

- [ ] **Step 3: Implement the view**

    Render create/update entries as AiDraftItemCard instances inside AiDraftSection. Use DropdownSelect for quantity mode and status values, ComboboxField for custom units, and AiDraftResourceField for ingredient binding. Render set_done and delete as concise status/impact content rather than an editable full card, while keeping current values and submit payload unchanged.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: shopping list create/apply/resolved tests pass with no raw JSON editor.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiShoppingListDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate shopping list draft view"

### Task 9: Migrate Meal-Log Draft UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiMealLogDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiMealLogDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      foodOptions: readonly AiResourceOption[];
      onDraftChange: (next: Record<string, unknown>) => void;
      onLoadResourceOptions: AiResourceOptionLoader;
    }): JSX.Element;

- [ ] **Step 1: Add failing meal-log tests**

    Require a summary card and the sections “餐食信息”, “食物项”, “参与人和照片”, and “备注与心情”. Require an explicit plan/warning impact note for optional stock deduction and keep rate_food as a compact rating surface.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new headings and impact note are absent.

- [ ] **Step 3: Implement the view**

    Preserve the existing create, update_details, update_composition dispatch boundary, and rate_food behavior. Use AiDraftResourceField for editable food binding, AiDraftItemCard for food entries, AiDraftField with ComboboxField for mood, existing StarRatingInput for rating, and readonly chips for participants/media IDs. Do not create new member or media selectors.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: food selection, ready-like stock deduction, read-only references, mood, rating, and payload tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiMealLogDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate meal log draft view"

### Task 10: Migrate Food-Profile Draft UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiFoodProfileDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiFoodProfileDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      categoryOptions: readonly ComboboxOption<string>[];
      onDraftChange: (next: Record<string, unknown>) => void;
    }): JSX.Element;

- [ ] **Step 1: Add failing food-profile tests**

    Require a summary card plus “核心信息”, “适用场景”, and “来源与备注” sections. Require set_favorite to render an explicit compact status summary rather than the full form.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new structure is absent.

- [ ] **Step 3: Implement the view**

    Keep foodProfileRecord, normalizeFoodProfilePayload, validateFoodProfileDraftForSubmit, and ApprovalPanel's payload normalization unchanged. Use DropdownSelect for food type, ComboboxField for category, the existing controlled multi-select behavior for meal types, and AiDraftTagInput for flavor tags. Retain custom category and tag values exactly as before.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: food type, meal type, category, tag, favorite, validation, and resolved-summary tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiFoodProfileDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate food profile draft view"

### Task 11: Migrate Ingredient-Profile and Tracking-Transition UI

**Files:**

- Create: frontend/src/components/ai/draft-ui/views/AiIngredientProfileDraftView.tsx
- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiSpecializedApprovalEditors.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:**

    export function AiIngredientProfileDraftView(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      onDraftChange: (next: Record<string, unknown>) => void;
    }): JSX.Element;

- [ ] **Step 1: Add failing ingredient tests**

    Require a profile summary, “核心信息”, “库存与追踪”, and “高级设置” sections. Require transition_tracking_mode to expose its irreversible effect through AiDraftImpactNote and preserve its current readonly/busy behavior.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the structured section and danger-note assertions fail.

- [ ] **Step 3: Implement the view and specialized composition**

    Keep validateIngredientProfileDraftForSubmit, validateIngredientProfilePayloadForSubmit, unit-conversion fields, and payload shape unchanged. Use AiDraftItemCard for unit conversion rows, AiDraftField plus ComboboxField for category/storage/units, and AiDraftImpactNote for tracking-mode consequences.

    Refactor AiIngredientTrackingTransitionApproval only at the presentation layer. Preserve validateIngredientTrackingTransitionForSubmit and its exact onChange payload behavior.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: profile validation, custom storage choice, conversion rows, transition draft, and compact resolved tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/views/AiIngredientProfileDraftView.tsx frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiSpecializedApprovalEditors.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: migrate ingredient profile draft view"

### Task 12: Migrate Inventory-Intake Draft UI

**Files:**

- Modify: frontend/src/components/ai/AiInventoryIntakeApproval.tsx
- Modify: frontend/src/components/ai/AiInventoryIntakeApproval.test.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css
- Modify: frontend/src/styles/09-ai-workspace.css

**Interfaces:** Keep exactly:

    export function AiInventoryIntakeApproval(props: {
      draft: Record<string, unknown>;
      readonly: boolean;
      onChange: (next: Record<string, unknown>) => void;
    }): JSX.Element;

- [ ] **Step 1: Add failing intake semantic tests**

    Add tests requiring:

    - a common summary card labelled “本次入库概览”;
    - “采购清单关联” and “直接入库” as Draft sections;
    - a warning impact note for incomplete/attention rows;
    - ignored rows as a collapsed read-only resolved/neutral disclosure;
    - no button with type=submit inside the editor.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiInventoryIntakeApproval.test.tsx src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new common primitive semantics fail before composing them.

- [ ] **Step 3: Recompose without changing the intake model**

    Preserve inventoryIntakeDraftFromRecord, groupInventoryIntakeItems, patchInventoryIntakeItem, patchInventoryIntakeDate, inventoryIntakeNeedsAttention, inventoryIntakeActionOptions, inventoryIntakeSubmitSummary, validation, row expansion defaults, and protected identity/version fields.

    Render:

    <AiDraftSummaryCard title="本次入库概览" items={overviewItems} />
    <AiDraftSection title="采购清单关联">{shoppingRows}</AiDraftSection>
    <AiDraftSection title="直接入库">{directRows}</AiDraftSection>
    <AiDraftImpactNote tone="warning" title="还需补充">{attentionCopy}</AiDraftImpactNote>

    Keep existing native date input only if the project ui-kit has no date field. Replace finite action/status select elements with DropdownSelect through AiDraftField, preserving exactly the option sets supplied by inventoryIntakeActionOptions.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiInventoryIntakeApproval.test.tsx src/components/ai/AiApprovalPanel.test.tsx
    npm --prefix frontend run check:style-tokens

    Expected: grouped rows, edit callbacks, read-only approved state, ignored items, protected IDs, and custom approval action ownership pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/AiInventoryIntakeApproval.tsx frontend/src/components/ai/AiInventoryIntakeApproval.test.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css frontend/src/styles/09-ai-workspace.css
    git commit -m "refactor: unify inventory intake draft UI"

### Task 13: Migrate Inventory-Operation Draft UI

**Files:**

- Modify: frontend/src/components/ai/AiInventoryOperationEditor.tsx
- Modify: frontend/src/components/ai/AiInventoryOperationApproval.test.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css
- Modify: frontend/src/styles/09-ai-workspace.css

**Interfaces:** Keep AiInventoryOperationEditor props and InventoryOperationDraftViewModel conversion unchanged.

- [ ] **Step 1: Add failing inventory-operation tests**

    Require an operation summary card, a “主要处理项” Draft section, an explicit danger impact note for dispose, and a compact resolved summary. Retain tests for batch choice disclosure and hidden row-version fields surviving quantity edits.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiInventoryOperationApproval.test.tsx src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new summary/impact semantics fail.

- [ ] **Step 3: Recompose the existing editor**

    Preserve inventoryOperationDraftFromRecord, validateInventoryOperationDraftForSubmit, unitOptionsForItem, storageOptionsForItem, batch selection, quantity tracking, and every expected row version. Use AiDraftSummaryCard for operation counts, AiDraftItemCard for every operation, AiDraftImpactNote tone="danger" for dispose, and existing DropdownSelect/ComboboxField wrappers for status/unit/storage.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiInventoryOperationApproval.test.tsx src/components/ai/AiApprovalPanel.test.tsx

    Expected: destructive editor, concurrency-boundary, expiring-first, and payload tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/AiInventoryOperationEditor.tsx frontend/src/components/ai/AiInventoryOperationApproval.test.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css frontend/src/styles/09-ai-workspace.css
    git commit -m "refactor: unify inventory operation draft UI"

### Task 14: Migrate Composite and Meal-Composition Special Draft UI

**Files:**

- Modify: frontend/src/components/ai/AiCompositeOperationPreview.tsx
- Modify: frontend/src/components/ai/AiSpecializedApprovalEditors.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-draft-ui.css
- Modify: frontend/src/styles/09-ai-workspace.css

**Interfaces:** Keep validateCompositeOperationDraftForSubmit, validateMealCompositionCorrectionForSubmit, composite step ordering, dependency text, and every existing onChange signature unchanged.

- [ ] **Step 1: Add failing special-draft tests**

    Require composite output to use a shared summary card, “执行顺序” section, and danger impact note for dangerous steps. Require meal-composition correction to expose the fixed no-inventory-adjustment warning through AiDraftImpactNote.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: the new semantic surfaces are absent.

- [ ] **Step 3: Recompose the special views**

    In AiCompositeOperationPreview, keep every current user-facing step title, dependency description, technical-details disclosure, risk calculation, and readonly rule. Replace only shared cards/notes with AiDraftSummaryCard, AiDraftSection, AiDraftItemCard, and AiDraftImpactNote.

    In AiMealCompositionCorrectionApproval, keep its existing food list and exact no-inventory-adjustment copy, but render that copy through the shared warning impact primitive. Do not change the correction Draft shape or validation.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx

    Expected: composite preview, dangerous-step, tracking-transition, and meal-composition tests pass.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/AiCompositeOperationPreview.tsx frontend/src/components/ai/AiSpecializedApprovalEditors.tsx frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-draft-ui.css frontend/src/styles/09-ai-workspace.css
    git commit -m "refactor: unify special AI draft views"

### Task 15: Remove the Legacy Renderer Fallback and Consolidate Shared CSS

**Files:**

- Modify: frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx
- Modify: frontend/src/components/ai/AiApprovalPanel.tsx
- Modify: frontend/src/components/ai/AiApprovalFields.tsx
- Modify: frontend/src/components/ai/AiLegacyStylesUsage.test.ts
- Modify: frontend/src/components/ai/AiApprovalPanel.test.tsx
- Modify: frontend/src/styles/09-ai-workspace.css
- Modify: frontend/src/styles/09-ai-draft-ui.css

**Interfaces:** Final AiDraftRenderer must dispatch all ten supported types and use raw JSON only for genuinely unknown/non-structured approvals. It must not retain renderLegacyFallback for any supported Draft.

- [ ] **Step 1: Add failing final dispatch and CSS-ownership tests**

    Add a table-driven test with the ten draftType strings and assert that each renders a known visible summary or section without the raw “草稿内容” JSON textarea. Add a style-ownership test that 09-ai-draft-ui.css contains .ai-draft-summary-card, .ai-draft-section, .ai-draft-impact-note, .ai-draft-item-card, and .ai-draft-resolved-summary.

    Assert that 09-ai-workspace.css no longer defines the duplicate shared root rules:

    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-confirmation-item\s*\{/m);
    expect(aiWorkspaceStyles).not.toMatch(/^\.ai-resource-field\s*\{/m);

    Keep type-specific .ai-inventory-* and .ai-composite-* rules only when they cannot become .ai-draft-* structure.

- [ ] **Step 2: Verify red**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiLegacyStylesUsage.test.ts

    Expected: final dispatch/ownership assertions fail while any supported type still uses fallback or duplicate root CSS.

- [ ] **Step 3: Remove the fallback and duplicate shared rules**

    Delete renderLegacyFallback from AiDraftRendererProps and every supported-type inline JSX branch from ApprovalPanel. Keep the raw JSON fallback only when usesStructuredDraftEditor is false. Require every non-pending supported View to render AiDraftResolvedSummary while retaining its current type-specific result facts.

    Move shared confirmation-item, resource-field, resource-select, draft-editor-head, action, and resolved-summary styling to semantically named .ai-draft-* rules. Preserve ApprovalPanel shell selectors such as .ai-approval-panel, .ai-approval-head, .ai-approval-actions, AI conversation layout, composer, and human-input request styling in 09-ai-workspace.css.

- [ ] **Step 4: Verify green**

    npm --prefix frontend run test -- src/components/ai/AiApprovalPanel.test.tsx src/components/ai/AiLegacyStylesUsage.test.ts
    npm --prefix frontend run check:style-tokens

    Expected: ten-type dispatch passes, unknown Draft still receives raw JSON fallback, and shared CSS has one owner.

- [ ] **Step 5: Commit**

    git add frontend/src/components/ai/draft-ui/AiDraftRenderer.tsx frontend/src/components/ai/AiApprovalPanel.tsx frontend/src/components/ai/AiApprovalFields.tsx frontend/src/components/ai/AiLegacyStylesUsage.test.ts frontend/src/components/ai/AiApprovalPanel.test.tsx frontend/src/styles/09-ai-workspace.css frontend/src/styles/09-ai-draft-ui.css
    git commit -m "refactor: finalize unified AI draft UI"

### Task 16: Run the Full Verification and Visual Acceptance Gate

**Files:** No product changes unless a concrete failure requires the smallest scoped correction.

**Interfaces:** Produces final evidence that UI refactoring did not alter the approval contract.

- [ ] **Step 1: Run the automated suite**

    npm run frontend:quality
    npm run frontend:build
    npm --prefix frontend run check:style-tokens
    npm --prefix frontend test -- src/lib/aiWorkspaceContracts.test.ts
    npm run frontend:smoke
    git diff --check origin/main...HEAD

    Expected: all commands exit 0. The style-token command may print the known report-only baseline; manually classify every new Draft-related match before accepting it.

- [ ] **Step 2: Inspect the required visual states**

    Start the local app with:

    npm run dev

    Inspect a representative pending, busy/error, resolved, and danger state at:

    - 1440×900 desktop;
    - 768×1024 tablet;
    - 390×844 phone.

    Exercise one Draft from each group: generated recipe, meal plan, shopping list, meal log, food/ingredient profile, inventory intake, inventory operation, and composite operation. Verify long Chinese text, multiple rows, a resource list, a custom-unit field, a collapsed item, bottom actions, keyboard-safe scrolling, and no horizontal overflow.

- [ ] **Step 3: Check final scope**

    git diff --name-only origin/main...HEAD
    rg -n "RecipeDraftDialog" frontend/src/components/ai/draft-ui frontend/src/components/ai/AiApprovalPanel.tsx || true
    rg -n "renderLegacyFallback" frontend/src/components/ai || true

    Expected: no RecipeDraftDialog migration and no supported-Draft fallback remain.

- [ ] **Step 4: Commit only a verified correction if needed**

    git status --short

    Expected: clean. If a scoped correction was necessary, add only its files, rerun the exact failing command plus the full relevant gate, then commit with a message naming the correction.

## Spec Coverage Self-Review

| Approved requirement | Plan coverage |
| --- | --- |
| Ten approval Draft types | Tasks 5 through 14 and final ten-type dispatch in Task 15 |
| No content, logic, payload, validation, query, or approval change | Global Constraints; explicit preservation clauses in Tasks 4 through 14 |
| Reuse ui-kit first | Global Constraints and Task 3 decision boundary |
| Custom Draft UI remains allowed | Global Constraints, Task 2 slot primitives, and every view migration task |
| Dedicated Draft component library | Tasks 2 and 3 |
| ApprovalPanel becomes shell/dispatcher | Tasks 4 and 15 |
| Draft style reference routed through frontend-ui-style | Task 1 |
| Shared Draft CSS separate from workspace CSS | Tasks 1, 2, 12 through 15 |
| Pending/resolved/failure/danger/mobile behavior | Tasks 2, 5 through 15, and Task 16 visual gate |
| Existing intake PR included | Task 12 migrates the current main inventory-intake editor |
| RecipeDraftDialog excluded | Global Constraints and Task 16 scope check |
| Automated and viewport verification | Task 16 |

## Plan Self-Review Checklist

- Every file named in the responsibility map is created or modified by at least one task.
- Every supported Draft type has a dedicated migration task and an explicit regression command.
- No task asks for an unspecified contract, an undeclared component, or an unbounded CSS rewrite.
- AiDraftRenderer, AiDraftField, AiDraftResourceField, and AiDraftTagInput use the same names in their interface declarations and later tasks.
- The plan keeps existing multi-select/custom-unit semantics instead of forcing unsuitable ui-kit primitives.
- The plan does not introduce backend, API, database, runtime, cache, or RecipeDraftDialog work.
