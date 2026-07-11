import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import type { ShoppingIntakeResult } from '../../api/types';
import {
  ActionButton,
  FormActions,
  MobileActionBar,
  OptionChipGroup,
  QuantityUnitField,
  StateBlock,
  WorkspaceModal,
  WorkspaceOverlayFrame,
} from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import {
  collectReviewExceptions,
  formatPurchaseQuantitySummary,
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
    () => (props.draft ? collectReviewExceptions(props.draft) : []),
    [props.draft],
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
      ? props.result?.summary.description || '库存与采购项已同步更新。'
      : props.step === 'review'
        ? '默认按计划数量入库；只展开需要改动的例外。'
        : '请显式勾选本次买到的项目，不会默认全选。';

  const remainingErrorCount = fieldErrors.length;
  const liveMessage =
    props.errorMessage ||
    (remainingErrorCount > 0 ? `还有 ${remainingErrorCount} 处需要确认` : null) ||
    (props.step === 'result' && props.result
      ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销`
      : null);

  let footerActions: ReactNode = null;
  if (props.step === 'select') {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel={`下一步（${selectedItems.length}）`}
        isSubmitting={busy}
        primaryDisabled={busy || loading || selectedItems.length === 0}
        onPrimary={props.onGoReview}
        secondaryLabel="取消"
        onSecondary={closeIfAllowed}
      />
    );
  } else if (props.step === 'review') {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel={busy ? '提交中…' : '确认入库'}
        isSubmitting={busy}
        primaryDisabled={busy || loading || selectedItems.length === 0}
        onPrimary={props.onSubmit}
        secondaryLabel="返回选择"
        onSecondary={() => {
          if (!busy) props.onGoSelect();
        }}
      />
    );
  } else {
    footerActions = (
      <FormActions
        className="inventory-maintenance-actions"
        primaryLabel="完成"
        isSubmitting={false}
        onPrimary={closeIfAllowed}
        secondaryLabel={
          props.result?.can_revert && props.onRevertResult
            ? '撤销本次操作'
            : props.result?.can_revert
              ? '稍后可撤销'
              : undefined
        }
        onSecondary={
          props.result?.can_revert && props.onRevertResult
            ? () => props.onRevertResult?.(props.result!.operation_id)
            : props.result?.can_revert
              ? closeIfAllowed
              : undefined
        }
      />
    );
  }

  const footerInfo = (
    <div className="inventory-maintenance-footer-summary">
      {props.step === 'result' && props.result ? (
        <>
          <span>已登记</span>
          <strong>
            完成 {props.result.summary.completed_count} · 部分 {props.result.summary.partial_count}
          </strong>
          <p>可在 {compactTimeLabel(props.result.revertible_until)} 前撤销</p>
        </>
      ) : (
        <>
          <span>已选择</span>
          <strong>{selectedItems.length} 项</strong>
          <p>{props.draft ? `购买日期 ${props.draft.purchaseDate}` : '—'}</p>
        </>
      )}
    </div>
  );

  return (
    <WorkspaceOverlayFrame
      rootClassName={['inventory-maintenance-overlay-root', props.overlayRootClassName]
        .filter(Boolean)
        .join(' ')}
      closeOnBackdrop={!busy}
      onClose={closeIfAllowed}
    >
      <WorkspaceModal
        title={title}
        description={description}
        eyebrow="采购入库"
        closeLabel="关闭"
        closeAriaLabel="关闭采购入库"
        className="workspace-modal-wide inventory-maintenance-modal"
        onClose={closeIfAllowed}
        footerInfo={footerInfo}
        footerActions={
          <>
            <div className="inventory-maintenance-desktop-actions">{footerActions}</div>
            <MobileActionBar className="inventory-maintenance-mobile-actions">{footerActions}</MobileActionBar>
          </>
        }
      >
        <div className="inventory-maintenance-scroll">
          <div className="inventory-maintenance-live" aria-live="polite">
            {liveMessage}
          </div>

          {props.conflictState && props.conflictState !== 'none' ? (
            <div className="inventory-maintenance-conflict" role="status">
              <strong>需要重新确认</strong>
              <p>{props.errorMessage ?? '家人可能刚改动了采购项或库存，请刷新后重新确认。'}</p>
              {props.onRetry ? (
                <ActionButton tone="secondary" size="compact" type="button" disabled={busy} onClick={props.onRetry}>
                  重试提交
                </ActionButton>
              ) : null}
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
              busy={busy}
              onRevertResult={props.onRevertResult}
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
  onToggleItem: (shoppingItemId: string) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  return (
    <section className="inventory-maintenance-section" aria-label="待买项目">
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
                item.selected ? 'is-selected' : '',
                error ? 'has-error' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <label className="inventory-maintenance-item-main">
                <input
                  type="checkbox"
                  checked={item.selected}
                  disabled={props.busy}
                  data-field-key={`${item.shoppingItemId}:selected`}
                  onChange={() => props.onToggleItem(item.shoppingItemId)}
                />
                <div className="inventory-maintenance-item-copy">
                  <div className="inventory-maintenance-item-title-row">
                    <strong>{item.title}</strong>
                    <span className="inventory-maintenance-chip">{itemKindLabel(item)}</span>
                  </div>
                  <p className="subtle">{plannedCopy(item)}</p>
                </div>
              </label>
              {item.kind === 'free_text' ? (
                <FreeTextActions
                  item={item}
                  busy={props.busy}
                  candidates={props.freeTextCandidatesByItemId?.[item.shoppingItemId] ?? []}
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
  focusRef: MutableRefObject<HTMLInputElement | HTMLButtonElement | null>;
  onPatchItem: (shoppingItemId: string, patch: Partial<ShoppingIntakeDraftItem>) => void;
  onToggleException: (shoppingItemId: string) => void;
  onCompleteFreeText: (shoppingItemId: string) => void;
  onLinkFreeText: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  const exceptionIds = new Set(props.exceptions.map((item) => item.shoppingItemId));
  const cleanItems = props.selectedItems.filter((item) => !exceptionIds.has(item.shoppingItemId));

  return (
    <div className="inventory-maintenance-review-layout">
      <section className="inventory-maintenance-section" aria-label="默认入库">
        <div className="inventory-maintenance-section-head">
          <span>按计划入库</span>
          <em>{cleanItems.length} 项</em>
        </div>
        {cleanItems.length === 0 ? (
          <p className="subtle">没有完全按计划的项目；请在下方处理例外。</p>
        ) : (
          <ul className="inventory-maintenance-summary-list">
            {cleanItems.map((item) => (
              <li key={item.shoppingItemId}>
                <strong>{item.title}</strong>
                <span>{plannedCopy(item)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="inventory-maintenance-section" aria-label="例外与差异">
        <div className="inventory-maintenance-section-head">
          <span>差异与例外</span>
          <em>{props.exceptions.length} 项</em>
        </div>
        {props.exceptions.length === 0 ? (
          <p className="subtle">没有需要改动的例外，可直接确认入库。</p>
        ) : (
          <div className="inventory-maintenance-item-list">
            {props.exceptions.map((item) => {
              const isExpanded = props.expanded.has(item.shoppingItemId);
              return (
                <article
                  key={item.shoppingItemId}
                  className={['inventory-maintenance-item-card', isExpanded ? 'is-expanded' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="inventory-maintenance-item-title-row">
                    <strong>{item.title}</strong>
                    <span className="inventory-maintenance-chip">{itemKindLabel(item)}</span>
                    <ActionButton
                      tone="tertiary"
                      size="compact"
                      type="button"
                      disabled={props.busy}
                      onClick={() => props.onToggleException(item.shoppingItemId)}
                    >
                      {isExpanded ? '收起' : '展开编辑'}
                    </ActionButton>
                  </div>
                  <ExceptionSummary item={item} />
                  {isExpanded ? (
                    <ExceptionEditor
                      item={item}
                      busy={props.busy}
                      fieldErrors={props.fieldErrors}
                      candidates={props.freeTextCandidatesByItemId?.[item.shoppingItemId] ?? []}
                      onPatchItem={props.onPatchItem}
                      onCompleteFreeText={props.onCompleteFreeText}
                      onLinkFreeText={props.onLinkFreeText}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="inventory-maintenance-section inventory-maintenance-review-meta" aria-label="公共信息">
        <div className="inventory-maintenance-section-head">
          <span>公共购买日期</span>
        </div>
        <p className="inventory-maintenance-meta-value">{props.draft.purchaseDate}</p>
        <p className="subtle">存放位置和到期日已按档案默认带出；只在例外中修改。</p>
      </section>
    </div>
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
    return <p className="subtle">{copy ?? plannedCopy(props.item)}</p>;
  }
  if (props.item.kind === 'presence_ingredient') {
    return (
      <p className="subtle">
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
    <p className="subtle">
      {props.item.resolution === 'complete_without_inventory' ? '将仅标记已买' : '尚未关联库存'}
    </p>
  );
}

function ExceptionEditor(props: {
  item: ShoppingIntakeDraftItem;
  busy: boolean;
  fieldErrors: ShoppingIntakeFieldError[];
  candidates: FreeTextLinkCandidate[];
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
        onComplete={props.onCompleteFreeText}
        onLink={props.onLinkFreeText}
      />
    );
  }

  if (item.kind === 'presence_ingredient') {
    const expiryError = fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'expiryDate');
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
        <label className="inventory-maintenance-date-field">
          <span>存放位置</span>
          <input
            type="text"
            value={item.storageLocation}
            disabled={props.busy}
            data-field-key={`${item.shoppingItemId}:storageLocation`}
            onChange={(event) =>
              props.onPatchItem(item.shoppingItemId, { storageLocation: event.target.value })
            }
          />
        </label>
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
  const expiryError =
    item.kind === 'exact_ingredient'
      ? fieldErrorFor(props.fieldErrors, item.shoppingItemId, 'expiryDate')
      : null;
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
        quantityFieldKey={`${item.shoppingItemId}:actualQuantity`}
        onQuantityChange={(value) => props.onPatchItem(item.shoppingItemId, { actualQuantity: value })}
        onUnitChange={(value) => props.onPatchItem(item.shoppingItemId, { unit: value })}
        className="inventory-maintenance-quantity"
      />
      {summaryCopy ? <p className="inventory-maintenance-diff-copy">{summaryCopy}</p> : null}
      {quantityError ? <p className="inventory-maintenance-field-error">{quantityError.message}</p> : null}
      <label className="inventory-maintenance-date-field">
        <span>存放位置{item.kind === 'food' ? '（影响全部成品库存）' : ''}</span>
        <input
          type="text"
          value={item.storageLocation}
          disabled={props.busy}
          data-field-key={`${item.shoppingItemId}:storageLocation`}
          onChange={(event) =>
            props.onPatchItem(item.shoppingItemId, { storageLocation: event.target.value })
          }
        />
      </label>

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
  onComplete: (shoppingItemId: string) => void;
  onLink: (shoppingItemId: string, candidate: FreeTextLinkCandidate) => void;
}) {
  return (
    <div className="inventory-maintenance-freetext-actions">
      <ActionButton
        tone={props.item.resolution === 'complete_without_inventory' ? 'primary' : 'secondary'}
        size="compact"
        type="button"
        disabled={props.busy}
        data-field-key={`${props.item.shoppingItemId}:resolution`}
        onClick={() => props.onComplete(props.item.shoppingItemId)}
      >
        仅标记已买
      </ActionButton>
      {props.candidates.length > 0 ? (
        <div className="inventory-maintenance-link-candidates" aria-label="可关联目标">
          {props.candidates.map((candidate) => (
            <ActionButton
              key={`${candidate.kind}:${candidate.id}`}
              tone="tertiary"
              size="compact"
              type="button"
              disabled={props.busy}
              onClick={() => props.onLink(props.item.shoppingItemId, candidate)}
            >
              关联{candidate.name}
            </ActionButton>
          ))}
        </div>
      ) : (
        <p className="subtle">没有精确同名档案可关联；可仅标记已买。</p>
      )}
    </div>
  );
}

function ResultStep(props: {
  result: ShoppingIntakeResult;
  busy?: boolean;
  onRevertResult?: (operationId: string) => void;
  onViewResult?: (operationId: string) => void;
}) {
  return (
    <section className="inventory-maintenance-result" aria-label="入库结果">
      <div className="inventory-maintenance-summary-card">
        <p className="eyebrow">操作结果</p>
        <h4>{props.result.summary.title || '本次购买已登记'}</h4>
        <p className="subtle">{props.result.summary.description}</p>
        <div className="inventory-maintenance-summary-metrics">
          <article>
            <span>完成</span>
            <strong>{props.result.summary.completed_count}</strong>
            <em>项</em>
          </article>
          <article>
            <span>部分</span>
            <strong>{props.result.summary.partial_count}</strong>
            <em>项</em>
          </article>
          <article>
            <span>状态</span>
            <strong>{props.result.status === 'applied' ? '已生效' : '已撤销'}</strong>
            <em />
          </article>
        </div>
        <p className="inventory-maintenance-revert-copy" aria-live="polite">
          {props.result.status === 'reverted'
            ? '这次操作已撤销'
            : props.result.can_revert
              ? `可在 ${compactTimeLabel(props.result.revertible_until)} 前撤销本次操作`
              : '撤销窗口已过或当前无权撤销'}
        </p>
        {(props.onViewResult || (props.result.can_revert && props.onRevertResult)) ? (
          <div className="inventory-operation-result-actions">
            {props.onViewResult ? (
              <ActionButton
                tone="secondary"
                size="compact"
                type="button"
                disabled={Boolean(props.busy)}
                onClick={() => props.onViewResult?.(props.result.operation_id)}
              >
                查看详情
              </ActionButton>
            ) : null}
            {props.result.can_revert && props.onRevertResult ? (
              <ActionButton
                tone="primary"
                size="compact"
                type="button"
                disabled={Boolean(props.busy)}
                onClick={() => props.onRevertResult?.(props.result.operation_id)}
              >
                撤销本次操作
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {props.result.items.length > 0 ? (
        <ul className="inventory-maintenance-summary-list">
          {props.result.items.map((item) => (
            <li key={item.shopping_item_id}>
              <strong>{item.shopping_item_id}</strong>
              <span>
                {item.result === 'partial'
                  ? `部分买到，剩余 ${item.remaining_planned_quantity ?? '—'}`
                  : item.result === 'completed_without_inventory'
                    ? '仅完成'
                    : item.result === 'stocked'
                      ? '已入库'
                      : '已完成'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
