import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import type { ShoppingIntakeResult } from '../../api/types';
import {
  ActionButton,
  DropdownSelect,
  FormActions,
  OptionChipGroup,
  OperationLoadingOverlay,
  QuantityUnitField,
  SearchableResourceSelect,
  StateBlock,
  StatusBadge,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { INVENTORY_STORAGE_PRESETS } from '../../components/ingredients/ingredientWorkspaceForms';
import { formatDateTime } from '../../lib/ui';
import { isOperationStillRevertible } from './InventoryOperationBanner';
import {
  collectReviewExceptions,
  filterFreeTextLinkOptions,
  formatPurchaseQuantitySummary,
  isFreeTextLinkCandidateUnitCompatible,
  summarizePurchaseQuantity,
  type FreeTextLinkCandidate,
  type ShoppingIntakeDraft,
  type ShoppingIntakeDraftItem,
  type ShoppingIntakeFieldError,
  type ShoppingIntakeStep,
} from './shoppingIntakeModel';

export type ShoppingIntakeDialogProps = {
  open: boolean;
  step: ShoppingIntakeStep;
  draft: ShoppingIntakeDraft | null;
  loading?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  fieldErrors?: ShoppingIntakeFieldError[];
  focusFieldKey?: string | null;
  conflictState?: 'none' | 'stale_version' | 'idempotency_key_reused';
  result?: ShoppingIntakeResult | null;
  expandedExceptionIds?: string[];
  freeTextCandidatesByItemId?: Record<string, FreeTextLinkCandidate[]>;
  freeTextLinkOptions?: FreeTextLinkCandidate[];
  overlayRootClassName?: string;
  onClose: () => void;
  onGoReview: () => void;
  onGoSelect: () => void;
  onToggleItem: (shoppingItemId: string) => void;
  onPatchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
  onToggleException: (shoppingItemId: string) => void;
  onSubmit: () => void;
  onRetry?: () => void;
  onRevertResult?: (operationId: string) => void;
  onViewResult?: (operationId: string) => void;
};

const AVAILABILITY_OPTIONS = [
  { value: 'sufficient', label: '充足' },
  { value: 'present_unknown', label: '还在' },
  { value: 'low', label: '少量' },
] as const;

const STORAGE_LOCATION_OPTIONS = INVENTORY_STORAGE_PRESETS.map((storageLocation) => ({
  value: storageLocation,
  label: storageLocation,
}));

function storageLocationOptions(currentValue: string) {
  const normalizedCurrentValue = currentValue.trim();
  if (
    !normalizedCurrentValue ||
    INVENTORY_STORAGE_PRESETS.includes(
      normalizedCurrentValue as (typeof INVENTORY_STORAGE_PRESETS)[number],
    )
  ) {
    return STORAGE_LOCATION_OPTIONS;
  }
  return [
    { value: normalizedCurrentValue, label: normalizedCurrentValue },
    ...STORAGE_LOCATION_OPTIONS,
  ];
}

function fieldErrorFor(
  fieldErrors: ShoppingIntakeFieldError[] | undefined,
  shoppingItemId: string,
  field?: string,
) {
  if (!fieldErrors?.length) return null;
  return (
    fieldErrors.find(
      (error) =>
        error.shoppingItemId === shoppingItemId && (field ? error.field === field || error.field.includes(field) : true),
    ) ?? null
  );
}

function itemKindLabel(item: ShoppingIntakeDraftItem) {
  if (item.kind === 'exact_ingredient') return '精确数量';
  if (item.kind === 'presence_ingredient') return '只记有无';
  if (item.kind === 'food') return '成品库存';
  return '自由文本';
}

function plannedCopy(item: ShoppingIntakeDraftItem) {
  if (item.kind === 'exact_ingredient' || item.kind === 'food') {
    return `计划 ${item.plannedQuantity} ${item.plannedUnit || item.unit}`;
  }
  if (item.kind === 'presence_ingredient') {
    return '买到后记为家庭整体有无';
  }
  if (item.resolution === 'complete_without_inventory') {
    return '仅标记已买，不写库存';
  }
  return '需关联库存或仅完成';
}

function compactTimeLabel(iso: string) {
  try {
    return formatDateTime(iso);
  } catch {
    return iso;
  }
}

export function ShoppingIntakeDialog(props: ShoppingIntakeDialogProps) {
  const busy = Boolean(props.busy);
  const loading = Boolean(props.loading);
  const fieldErrors = props.fieldErrors ?? [];
  const expanded = new Set(props.expandedExceptionIds ?? []);
  const focusRef = useRef<HTMLInputElement | HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!props.open || !props.focusFieldKey) {
      return;
    }
    // Auto-expand the exception card that owns the focused field so the control mounts.
    const shoppingItemId = props.focusFieldKey.includes(':')
      ? props.focusFieldKey.split(':')[0]
      : null;
    if (
      shoppingItemId &&
      props.step === 'review' &&
      !(props.expandedExceptionIds ?? []).includes(shoppingItemId)
    ) {
      props.onToggleException(shoppingItemId);
      return;
    }
    const node = document.querySelector<HTMLElement>(`[data-field-key="${props.focusFieldKey}"]`);
    if (node && typeof node.focus === 'function' && node.getAttribute('type') !== 'hidden') {
      node.focus();
    }
  }, [
    props.open,
    props.focusFieldKey,
    props.step,
    props.expandedExceptionIds,
    fieldErrors,
    props.onToggleException,
  ]);

  const selectedItems = useMemo(
    () => props.draft?.items.filter((item) => item.selected) ?? [],
    [props.draft],
  );
  const reviewExceptions = useMemo(
    () => {
      if (!props.draft) return [];
      const selected = props.draft.items.filter((item) => item.selected);
      const errorIds = new Set(
        fieldErrors
          .map((error) => error.shoppingItemId)
          .filter(Boolean),
      );
      const prioritized = selected.filter((item) => errorIds.has(item.shoppingItemId));
      const prioritizedIds = new Set(prioritized.map((item) => item.shoppingItemId));
      const ordinary = collectReviewExceptions(props.draft).filter(
        (item) => !prioritizedIds.has(item.shoppingItemId),
      );
      return [...prioritized, ...ordinary];
    },
    [props.draft, fieldErrors],
  );

  if (!props.open) {
    return null;
  }

  const closeIfAllowed = () => {
    if (!busy) {
      props.onClose();
    }
  };

  const title =
    props.step === 'result'
      ? '本次购买已登记'
      : props.step === 'review'
        ? '核对实际数量与例外'
        : '选择本次买到的项目';

  const description =
    props.step === 'result'
      ? '库存与采购清单已同步更新。'
      : props.step === 'review'
        ? '默认按计划数量入库；只展开需要改动的例外。'
        : '请显式勾选本次买到的项目，不会默认全选。';

  const remainingErrorCount = fieldErrors.length;
  const canRevertResult = isOperationStillRevertible(props.result, Date.now());
  const liveMessage =
    props.errorMessage ||
    (remainingErrorCount > 0 ? `还有 ${remainingErrorCount} 处需要确认` : null) ||
    (props.step === 'result' && props.result
      ? canRevertResult
        ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销`
        : props.result.status === 'reverted'
          ? '这次操作已撤销'
          : '撤销窗口已过或当前无权撤销'
      : null);

  let footerActions: ReactNode = null;
  if (props.step === 'select') {
    footerActions = (
      <FormActions
        primaryLabel={`下一步（${selectedItems.length}）`}
        isSubmitting={busy}
        primaryDisabled={busy || loading || selectedItems.length === 0}
        onPrimary={props.onGoReview}
        secondaryLabel="取消"
        onSecondary={closeIfAllowed}
      />
    );
  } else if (props.step === 'review') {
    const requiresReconfirmation = Boolean(
      props.conflictState && props.conflictState !== 'none',
    );
    footerActions = (
      <FormActions
        primaryLabel={
          requiresReconfirmation
            ? '重新确认并提交'
            : '确认入库'
        }
        isSubmitting={busy}
        submittingLabel={requiresReconfirmation ? '正在重新提交' : '正在登记'}
        primaryDisabled={busy || loading || selectedItems.length === 0}
        onPrimary={requiresReconfirmation && props.onRetry ? props.onRetry : props.onSubmit}
        secondaryLabel="返回选择"
        onSecondary={() => {
          if (!busy) props.onGoSelect();
        }}
      />
    );
  } else {
    footerActions = (
      <FormActions
        primaryLabel="完成"
        secondaryIsSubmitting={busy && canRevertResult && Boolean(props.onRevertResult)}
        secondarySubmittingLabel="正在撤销"
        onPrimary={closeIfAllowed}
        secondaryLabel={
          canRevertResult && props.onRevertResult
            ? '撤销本次登记'
            : canRevertResult
              ? '稍后可撤销'
              : undefined
        }
        onSecondary={
          canRevertResult && props.onRevertResult
            ? () => props.onRevertResult?.(props.result!.operation_id)
            : canRevertResult
              ? closeIfAllowed
              : undefined
        }
      />
    );
  }

  const footerInfo = (
    <>
      {props.step === 'result' && props.result ? (
        <>
          <span>{props.result.status === 'reverted' ? '登记已撤销' : '登记已生效'}</span>
          <strong>
            {canRevertResult
              ? `可撤销至 ${compactTimeLabel(props.result.revertible_until)}`
              : props.result.status === 'reverted'
                ? '库存已恢复'
                : '本次登记已完成'}
          </strong>
        </>
      ) : (
        <>
          <span>已选择</span>
          <strong>{selectedItems.length} 项</strong>
          <p>{props.draft ? `购买日期 ${props.draft.purchaseDate}` : '—'}</p>
        </>
      )}
    </>
  );

  return (
    <WorkspaceOverlayFrame
      rootClassName={props.overlayRootClassName}
      closeOnBackdrop={!busy}
      busy={busy}
      labelledBy="shopping-intake-title"
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        titleId="shopping-intake-title"
        description={description}
        eyebrow="采购入库"
        closeLabel="关闭"
        closeAriaLabel="关闭采购入库"
        className={[
          'workspace-modal-wide',
          'inventory-shopping-intake-modal',
          props.step === 'result' ? 'is-result' : '',
        ].filter(Boolean).join(' ')}
        onClose={closeIfAllowed}
        busy={busy}
        footerInfo={footerInfo}
        footerActions={footerActions}
      >
        <div
          className={[
            'inventory-shopping-intake-content',
            'ui-operation-loading-host',
            busy ? 'is-busy' : '',
          ].filter(Boolean).join(' ')}
          aria-busy={busy}
        >
          <div className="inventory-maintenance-live" aria-live="polite">
            {liveMessage}
          </div>

          <OperationLoadingOverlay
            active={busy}
            title={props.step === 'result' ? '正在撤销本次登记' : '正在登记采购项'}
          />

          {props.conflictState && props.conflictState !== 'none' ? (
            <div className="inventory-maintenance-conflict" role="status">
              <strong>需要重新确认</strong>
              <p>{props.errorMessage ?? '家人可能刚改动了采购项或库存，请刷新后重新确认。'}</p>
            </div>
          ) : null}

          {props.errorMessage && (!props.conflictState || props.conflictState === 'none') ? (
            <div className="inventory-maintenance-error" role="alert">
              {props.errorMessage}
              {remainingErrorCount > 1 ? `（剩余 ${remainingErrorCount} 处）` : null}
            </div>
          ) : null}

          {loading ? (
            <StateBlock
              status="loading"
              title="正在准备采购项"
              description="稍等一下，正在读取待买清单。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.step !== 'result' && (!props.draft || props.draft.items.length === 0) ? (
            <StateBlock
              status="empty"
              title="没有待买项目"
              description="采购清单里暂时没有未完成的项目。"
              className="inventory-maintenance-state"
            />
          ) : null}

          {!loading && props.step === 'select' && props.draft ? (
            <SelectStep
              draft={props.draft}
              busy={busy}
              fieldErrors={fieldErrors}
              freeTextCandidatesByItemId={props.freeTextCandidatesByItemId}
              freeTextLinkOptions={props.freeTextLinkOptions}
              onToggleItem={props.onToggleItem}
              onCompleteFreeText={props.onCompleteFreeText}
              onLinkFreeText={props.onLinkFreeText}
            />
          ) : null}

          {!loading && props.step === 'review' && props.draft ? (
            <ReviewStep
              draft={props.draft}
              selectedItems={selectedItems}
              exceptions={reviewExceptions}
              expanded={expanded}
              busy={busy}
              fieldErrors={fieldErrors}
              freeTextCandidatesByItemId={props.freeTextCandidatesByItemId}
              freeTextLinkOptions={props.freeTextLinkOptions}
              focusRef={focusRef}
              onPatchItem={props.onPatchItem}
              onToggleException={props.onToggleException}
              onCompleteFreeText={props.onCompleteFreeText}
              onLinkFreeText={props.onLinkFreeText}
            />
          ) : null}

          {!loading && props.step === 'result' && props.result ? (
            <ResultStep
              result={props.result}
              draft={props.draft}
              busy={busy}
              onViewResult={props.onViewResult}
            />
          ) : null}
        </div>
      </WorkspaceModal>
    </WorkspaceOverlayFrame>
  );
}

function SelectStep(props: {
  draft: ShoppingIntakeDraft;
  busy: boolean;
  fieldErrors: ShoppingIntakeFieldError[];
  freeTextCandidatesByItemId?: Record<string, FreeTextLinkCandidate[]>;
  freeTextLinkOptions?: FreeTextLinkCandidate[];
  onToggleItem: (shoppingItemId: string) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  return (
    <section className="card inventory-maintenance-section inventory-shopping-intake-select" aria-label="待买项目">
      <div className="inventory-maintenance-section-head">
        <span>待买清单</span>
        <em>{props.draft.items.length} 项</em>
      </div>
      <div className="inventory-maintenance-item-list">
        {props.draft.items.map((item) => {
          const error = fieldErrorFor(props.fieldErrors, item.shoppingItemId);
          return (
            <article
              key={item.shoppingItemId}
              className={[
                'inventory-maintenance-item-card',
                'inventory-shopping-intake-item',
                item.selected ? 'is-selected' : '',
                error ? 'has-error' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <label className="inventory-maintenance-item-main">
                <input
                  type="checkbox"
                  className="inventory-shopping-intake-checkbox"
                  checked={item.selected}
                  disabled={props.busy}
                  aria-label={`选择 ${item.title}，${plannedCopy(item)}`}
                  data-field-key={`${item.shoppingItemId}:selected`}
                  onChange={() => props.onToggleItem(item.shoppingItemId)}
                />
                <div className="inventory-maintenance-item-copy">
                  <div className="inventory-maintenance-item-title-row">
                    <strong>{item.title}</strong>
                    <StatusBadge tone="neutral" size="compact">
                      {itemKindLabel(item)}
                    </StatusBadge>
                  </div>
                  <p className="subtle inventory-shopping-intake-plan">{plannedCopy(item)}</p>
                </div>
              </label>
              {item.kind === 'free_text' ? (
                <FreeTextActions
                  item={item}
                  busy={props.busy}
                  candidates={props.freeTextCandidatesByItemId?.[item.shoppingItemId] ?? []}
                  linkOptions={props.freeTextLinkOptions ?? []}
                  onComplete={props.onCompleteFreeText}
                  onLink={props.onLinkFreeText}
                />
              ) : null}
              {error ? <p className="inventory-maintenance-field-error">{error.message}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ReviewStep(props: {
  draft: ShoppingIntakeDraft;
  selectedItems: ShoppingIntakeDraftItem[];
  exceptions: ShoppingIntakeDraftItem[];
  expanded: Set<string>;
  busy: boolean;
  fieldErrors: ShoppingIntakeFieldError[];
  freeTextCandidatesByItemId?: Record<string, FreeTextLinkCandidate[]>;
  freeTextLinkOptions?: FreeTextLinkCandidate[];
  focusRef: MutableRefObject<HTMLInputElement | HTMLButtonElement | null>;
  onPatchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  onToggleException: (shoppingItemId: string) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  const exceptionIds = new Set(props.exceptions.map((item) => item.shoppingItemId));
  const cleanItems = props.selectedItems.filter((item) => !exceptionIds.has(item.shoppingItemId));
  const errorIds = new Set(
    props.fieldErrors.map((error) => error.shoppingItemId).filter(Boolean),
  );
  const reviewItems = [
    ...props.selectedItems.filter((item) => errorIds.has(item.shoppingItemId)),
    ...props.selectedItems.filter((item) => !errorIds.has(item.shoppingItemId)),
  ];

  return (
    <div className="inventory-maintenance-review-layout">
      <section className="inventory-shopping-review-overview" aria-label="入库核对摘要">
        <div className="inventory-shopping-review-stats">
          <article>
            <span>本次入库</span>
            <strong>{props.selectedItems.length}</strong>
            <em>项</em>
          </article>
          <article>
            <span>按计划</span>
            <strong>{cleanItems.length}</strong>
            <em>项</em>
          </article>
          <article className={props.exceptions.length > 0 ? 'has-exceptions' : ''}>
            <span>需调整</span>
            <strong>{props.exceptions.length}</strong>
            <em>项</em>
          </article>
        </div>
        <div className="inventory-shopping-review-defaults">
          <div>
            <span>购买日期</span>
            <time dateTime={props.draft.purchaseDate}>{props.draft.purchaseDate}</time>
          </div>
          <p>存放位置和到期日按档案默认值带出，只需修改有差异的项目。</p>
        </div>
      </section>

      <section
        className="inventory-maintenance-section inventory-shopping-review-section"
        aria-label="本次入库项目"
      >
        <div className="inventory-maintenance-section-head">
          <span>本次入库项目</span>
          <em>{reviewItems.length} 项</em>
        </div>
        {reviewItems.length === 0 ? (
          <p className="subtle">当前没有需要核对的入库项目。</p>
        ) : (
          <div className="inventory-maintenance-item-list inventory-shopping-review-list">
            {reviewItems.map((item) => (
              <ReviewItemCard
                key={item.shoppingItemId}
                item={item}
                isExpanded={props.expanded.has(item.shoppingItemId)}
                isException={exceptionIds.has(item.shoppingItemId)}
                busy={props.busy}
                fieldErrors={props.fieldErrors}
                candidates={props.freeTextCandidatesByItemId?.[item.shoppingItemId] ?? []}
                linkOptions={props.freeTextLinkOptions ?? []}
                onToggle={props.onToggleException}
                onPatchItem={props.onPatchItem}
                onCompleteFreeText={props.onCompleteFreeText}
                onLinkFreeText={props.onLinkFreeText}
              />
            ))}
          </div>
        )}
      </section>

      <section
        className={[
          'inventory-maintenance-section',
          'inventory-shopping-review-section',
          'inventory-shopping-review-exceptions',
          props.exceptions.length === 0 ? 'is-empty' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label="例外与差异"
      >
        <div className="inventory-maintenance-section-head">
          <span>差异与例外</span>
          <em>{props.exceptions.length} 项</em>
        </div>
        {props.exceptions.length === 0 ? (
          <div className="inventory-shopping-review-empty" role="status">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>没有差异，可直接确认入库</strong>
              <p>当前项目都会按计划数量和档案默认信息入库。</p>
            </div>
          </div>
        ) : (
          <div className="inventory-shopping-review-difference-status" role="status">
            <span aria-hidden="true">!</span>
            <div>
              <strong>{props.exceptions.length} 个项目存在差异</strong>
              <p>差异项目已在上方标记，可继续在原位置调整。</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ReviewItemCard(props: {
  item: ShoppingIntakeDraftItem;
  isExpanded: boolean;
  isException: boolean;
  busy: boolean;
  fieldErrors: ShoppingIntakeFieldError[];
  candidates: FreeTextLinkCandidate[];
  linkOptions: FreeTextLinkCandidate[];
  onToggle: (shoppingItemId: string) => void;
  onPatchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  const itemError = fieldErrorFor(props.fieldErrors, props.item.shoppingItemId);

  return (
    <article
      className={[
        'inventory-maintenance-item-card',
        'inventory-shopping-review-item',
        props.isException ? 'is-exception' : '',
        props.isExpanded ? 'is-expanded' : '',
        itemError ? 'has-error' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-field-key={
        itemError?.field === 'conflict'
          ? `${props.item.shoppingItemId}:conflict`
          : undefined
      }
      tabIndex={itemError?.field === 'conflict' ? -1 : undefined}
    >
      <div className="inventory-shopping-review-item-main">
        <div className="inventory-shopping-review-item-copy">
          <div className="inventory-maintenance-item-title-row">
            <strong>{props.item.title}</strong>
            <StatusBadge tone="neutral" size="compact">
              {itemKindLabel(props.item)}
            </StatusBadge>
          </div>
          <ExceptionSummary item={props.item} />
        </div>
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className="inventory-shopping-review-adjust"
          disabled={props.busy}
          aria-expanded={props.isExpanded}
          onClick={() => props.onToggle(props.item.shoppingItemId)}
        >
          {props.isExpanded ? '收起' : props.isException ? '编辑差异' : '调整'}
        </ActionButton>
      </div>
      {itemError?.field === 'conflict' ? (
        <p className="inventory-maintenance-field-error">{itemError.message}</p>
      ) : null}
      {props.isExpanded ? (
        <ExceptionEditor
          item={props.item}
          busy={props.busy}
          fieldErrors={props.fieldErrors}
          candidates={props.candidates}
          linkOptions={props.linkOptions}
          onPatchItem={props.onPatchItem}
          onCompleteFreeText={props.onCompleteFreeText}
          onLinkFreeText={props.onLinkFreeText}
        />
      ) : null}
    </article>
  );
}

function ExceptionSummary(props: { item: ShoppingIntakeDraftItem }) {
  if (props.item.kind === 'exact_ingredient' || props.item.kind === 'food') {
    const summary = summarizePurchaseQuantity({
      actualQuantity: props.item.actualQuantity,
      plannedQuantity: props.item.plannedQuantity,
      unit: props.item.unit,
    });
    const copy = formatPurchaseQuantitySummary(summary);
    return (
      <p className="subtle inventory-shopping-review-summary">
        {copy ?? plannedCopy(props.item)}
      </p>
    );
  }
  if (props.item.kind === 'presence_ingredient') {
    return (
      <p className="subtle inventory-shopping-review-summary">
        默认充足
        {props.item.resultingAvailabilityLevel !== 'sufficient'
          ? ` · 当前选择：${
              props.item.resultingAvailabilityLevel === 'low'
                ? '少量'
                : props.item.resultingAvailabilityLevel === 'present_unknown'
                  ? '还在'
                  : props.item.resultingAvailabilityLevel
            }`
          : ''}
        {props.item.requiresManualExpiry && !props.item.expiryDate ? ' · 需要确认到期日' : ''}
      </p>
    );
  }
  return (
    <p className="subtle inventory-shopping-review-summary">
      {props.item.resolution === 'complete_without_inventory' ? '将仅标记已买' : '尚未关联库存'}
    </p>
  );
}

function ExceptionEditor(props: {
  item: ShoppingIntakeDraftItem;
  busy: boolean;
  fieldErrors: ShoppingIntakeFieldError[];
  candidates: FreeTextLinkCandidate[];
  linkOptions: FreeTextLinkCandidate[];
  onPatchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  const { item } = props;

  if (item.kind === 'free_text') {
    return (
      <FreeTextActions
        item={item}
        busy={props.busy}
        candidates={props.candidates}
        linkOptions={props.linkOptions}
        onComplete={props.onCompleteFreeText}
        onLink={props.onLinkFreeText}
      />
    );
  }

  if (item.kind === 'presence_ingredient') {
    const expiryError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'expiryDate');
    const storageError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'storageLocation');
    return (
      <div className="inventory-maintenance-editor">
        <div className="inventory-maintenance-field-head">
          <span>买到后状态</span>
          <p className="subtle">只记录整体有无，不区分多个批次。</p>
        </div>
        <OptionChipGroup
          ariaLabel={`${item.title} 有无状态`}
          value={item.resultingAvailabilityLevel}
          size="large"
          className="inventory-maintenance-chip-group"
          onChange={(value) => {
            if (props.busy) return;
            props.onPatchItem(item.shoppingItemId, {
              resultingAvailabilityLevel: value as typeof item.resultingAvailabilityLevel,
            });
          }}
          options={AVAILABILITY_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
        />
        <div className="inventory-maintenance-date-field">
          <span>存放位置</span>
          <DropdownSelect
            ariaLabel={`${item.title}存放位置`}
            placeholder="选择存放位置"
            value={item.storageLocation}
            options={storageLocationOptions(item.storageLocation)}
            disabled={props.busy}
            triggerFieldKey={`${item.shoppingItemId}:storageLocation`}
            onChange={(storageLocation) => {
              if (storageLocation) {
                props.onPatchItem(item.shoppingItemId, { storageLocation });
              }
            }}
          />
        </div>
        {storageError ? <p className="inventory-maintenance-field-error">{storageError.message}</p> : null}
        {item.requiresManualExpiry || item.expiryDate !== null ? (
          <label className="inventory-maintenance-date-field">
            <span>到期日{item.requiresManualExpiry ? '（必填）' : ''}</span>
            <input
              type="date"
              value={item.expiryDate ?? ''}
              disabled={props.busy}
              data-field-key={`${item.shoppingItemId}:expiryDate`}
              onChange={(event) =>
                props.onPatchItem(item.shoppingItemId, {
                  expiryDate: event.target.value ? event.target.value : null,
                })
              }
            />
          </label>
        ) : null}
        {expiryError ? <p className="inventory-maintenance-field-error">{expiryError.message}</p> : null}
      </div>
    );
  }

  // exact / food
  const quantityError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'actualQuantity');
  const unitError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'unit');
  const storageError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'storageLocation');
  const expiryError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'expiryDate');
  const summary = summarizePurchaseQuantity({
    actualQuantity: item.actualQuantity,
    plannedQuantity: item.plannedQuantity,
    unit: item.unit,
  });
  const summaryCopy = formatPurchaseQuantitySummary(summary);

  return (
    <div className="inventory-maintenance-editor">
      <QuantityUnitField
        quantity={item.actualQuantity}
        unit={item.unit}
        unitOptions={[{ value: item.unit, label: item.unit || '单位' }]}
        quantityDisabled={props.busy}
        quantityStep="1"
        quantityFieldKey={`${item.shoppingItemId}:actualQuantity`}
        unitFieldKey={`${item.shoppingItemId}:unit`}
        onQuantityChange={(value) => props.onPatchItem(item.shoppingItemId, { actualQuantity: value })}
        onUnitChange={(value) => props.onPatchItem(item.shoppingItemId, { unit: value })}
        className="inventory-maintenance-quantity"
      />
      {summaryCopy ? <p className="inventory-maintenance-diff-copy">{summaryCopy}</p> : null}
      {quantityError ? <p className="inventory-maintenance-field-error">{quantityError.message}</p> : null}
      {unitError ? <p className="inventory-maintenance-field-error">{unitError.message}</p> : null}
      <div className="inventory-maintenance-date-field">
        <span>存放位置{item.kind === 'food' ? '（影响全部成品库存）' : ''}</span>
        <DropdownSelect
          ariaLabel={`${item.title}存放位置`}
          placeholder="选择存放位置"
          value={item.storageLocation}
          options={storageLocationOptions(item.storageLocation)}
          disabled={props.busy}
          triggerFieldKey={`${item.shoppingItemId}:storageLocation`}
          onChange={(storageLocation) => {
            if (storageLocation) {
              props.onPatchItem(item.shoppingItemId, { storageLocation });
            }
          }}
        />
      </div>
      {storageError ? <p className="inventory-maintenance-field-error">{storageError.message}</p> : null}

      {item.kind === 'exact_ingredient' && (item.requiresManualExpiry || item.expiryDate !== null) ? (
        <label className="inventory-maintenance-date-field">
          <span>到期日{item.requiresManualExpiry ? '（必填）' : ''}</span>
          <input
            type="date"
            value={item.expiryDate ?? ''}
            disabled={props.busy}
            data-field-key={`${item.shoppingItemId}:expiryDate`}
            onChange={(event) =>
              props.onPatchItem(item.shoppingItemId, {
                expiryDate: event.target.value ? event.target.value : null,
              })
            }
          />
        </label>
      ) : null}
      {item.kind === 'food' ? (
        <label className="inventory-maintenance-date-field">
          <span>到期日（可选）</span>
          <input
            type="date"
            value={item.expiryDate ?? ''}
            disabled={props.busy}
            data-field-key={`${item.shoppingItemId}:expiryDate`}
            onChange={(event) =>
              props.onPatchItem(item.shoppingItemId, {
                expiryDate: event.target.value ? event.target.value : null,
              })
            }
          />
        </label>
      ) : null}
      {expiryError ? <p className="inventory-maintenance-field-error">{expiryError.message}</p> : null}
    </div>
  );
}

function FreeTextActions(props: {
  item: Extract<ShoppingIntakeDraftItem, { kind: 'free_text' }>;
  busy: boolean;
  candidates: FreeTextLinkCandidate[];
  linkOptions: FreeTextLinkCandidate[];
  onComplete: (shoppingItemId: string) => void;
  onLink: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matchingOptions = filterFreeTextLinkOptions(props.linkOptions, query);
  const incompatibleExactFoodCandidates = props.candidates.filter(
    (candidate) => !isFreeTextLinkCandidateUnitCompatible(candidate, props.item.plannedUnit),
  );
  const selectOptions = matchingOptions.map((candidate) => ({
    id: `${candidate.kind}:${candidate.id}`,
    label: candidate.name,
    disabled: !isFreeTextLinkCandidateUnitCompatible(candidate, props.item.plannedUnit),
    description:
      candidate.kind === 'food'
        ? isFreeTextLinkCandidateUnitCompatible(candidate, props.item.plannedUnit)
          ? '成品库存'
          : `成品库存 · 单位为 ${candidate.stockUnit || '份'}，请先调整采购计划单位`
        : candidate.quantityTrackingMode === 'track_quantity'
          ? '食材档案 · 精确数量'
          : '食材档案 · 只记有无',
  }));

  const isCompletedWithoutInventory = props.item.resolution === 'complete_without_inventory';

  return (
    <div className="inventory-maintenance-freetext-actions">
      <div className="inventory-maintenance-freetext-actions-group">
        <ActionButton
          tone="secondary"
          size="compact"
          type="button"
          className={`inventory-freetext-action-btn is-complete-btn ${isCompletedWithoutInventory ? 'is-active' : ''}`}
          disabled={props.busy}
          data-field-key={`${props.item.shoppingItemId}:resolution`}
          onClick={() => props.onComplete(props.item.shoppingItemId)}
        >
          仅标记已买
        </ActionButton>

        {props.candidates.length > 0 &&
          props.candidates.map((candidate) => {
            const isCompatible = isFreeTextLinkCandidateUnitCompatible(candidate, props.item.plannedUnit);
            return (
              <ActionButton
                key={`${candidate.kind}:${candidate.id}`}
                tone="secondary"
                size="compact"
                type="button"
                className="inventory-freetext-action-btn is-recommend-btn"
                disabled={props.busy || !isCompatible}
                onClick={() => props.onLink(props.item.shoppingItemId, candidate)}
              >
                关联{candidate.name}
              </ActionButton>
            );
          })}

        {props.linkOptions.length > 0 && (
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            className={`inventory-freetext-action-btn is-search-btn ${searchOpen ? 'is-active' : ''}`}
            disabled={props.busy}
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((current) => !current)}
          >
            {searchOpen ? '收起搜索' : '搜索其他档案'}
          </ActionButton>
        )}
      </div>

      <div className="inventory-freetext-tips">
        {props.candidates.length === 0 && (
          <p className="subtle inventory-freetext-tip-row">
            没有精确同名档案，可搜索其他档案或仅标记已买。
          </p>
        )}
        {incompatibleExactFoodCandidates.length > 0 && (
          <p className="subtle inventory-freetext-tip-row warning">
            成品库存需与采购计划使用相同单位，请先在采购清单中调整单位。
          </p>
        )}
      </div>

      {searchOpen && (
        <SearchableResourceSelect
          ariaLabel={`${props.item.title}关联档案`}
          placeholder="搜索食材或成品档案"
          value=""
          query={query}
          options={selectOptions}
          disabled={props.busy}
          emptyText={query.trim() ? '没有找到匹配档案' : '暂无可关联档案'}
          className="inventory-maintenance-freetext-search"
          onQueryChange={setQuery}
          onSearchClear={() => setQuery('')}
          onChange={(optionId) => {
            const candidate = matchingOptions.find(
              (option) => `${option.kind}:${option.id}` === optionId,
            );
            if (
              candidate &&
              isFreeTextLinkCandidateUnitCompatible(candidate, props.item.plannedUnit)
            ) {
              props.onLink(props.item.shoppingItemId, candidate);
              setSearchOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function ResultStep(props: {
  result: ShoppingIntakeResult;
  draft?: ShoppingIntakeDraft | null;
  busy?: boolean;
  onViewResult?: (operationId: string) => void;
}) {
  const canRevert = isOperationStillRevertible(props.result, Date.now());
  const totalCount = props.result.summary.completed_count + props.result.summary.partial_count;
  const titleByShoppingItemId = new Map(
    props.draft?.items.map((item) => [item.shoppingItemId, item.title]) ?? [],
  );
  return (
    <section className="inventory-maintenance-result inventory-shopping-result" aria-label="入库结果">
      <div className="inventory-shopping-result-overview">
        <div className="inventory-shopping-result-heading">
          <StatusBadge tone={props.result.status === 'applied' ? 'success' : 'neutral'} size="compact">
            {props.result.status === 'applied' ? '已生效' : '已撤销'}
          </StatusBadge>
          <div>
            <h4>已登记 {totalCount} 项</h4>
            <p>库存数量与采购清单已同步。</p>
          </div>
        </div>
        <div className="inventory-shopping-result-counts" aria-label="登记统计">
          <span><strong>完成 {props.result.summary.completed_count}</strong> 项</span>
          <span><strong>部分 {props.result.summary.partial_count}</strong> 项</span>
        </div>
        <p className="inventory-maintenance-revert-copy" aria-live="polite">
          {props.result.status === 'reverted'
            ? '这次操作已撤销'
            : canRevert
              ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销本次登记`
              : '撤销窗口已过或当前无权撤销'}
        </p>
        {props.onViewResult ? (
          <ActionButton
            tone="tertiary"
            size="compact"
            type="button"
            disabled={Boolean(props.busy)}
            onClick={() => props.onViewResult?.(props.result.operation_id)}
          >
            查看操作详情
          </ActionButton>
        ) : null}
      </div>
      {props.result.items.length > 0 ? (
        <div className="inventory-shopping-result-items">
          <div className="inventory-maintenance-section-head">
            <span>本次登记项目</span>
            <em>{props.result.items.length} 项</em>
          </div>
          <ul className="inventory-maintenance-summary-list">
            {props.result.items.map((item) => {
              const isPartial = item.result === 'partial';
              const label = isPartial
                ? `部分买到 · 剩余 ${item.remaining_planned_quantity ?? '—'}`
                : item.result === 'completed_without_inventory'
                  ? '仅完成采购项'
                  : item.result === 'stocked'
                    ? '已加入库存'
                    : '已完成';
              return (
                <li key={item.shopping_item_id}>
                  <strong>{titleByShoppingItemId.get(item.shopping_item_id) ?? '采购项'}</strong>
                  <StatusBadge tone={isPartial ? 'warning' : 'success'} size="compact">
                    {label}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
