import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '../../api/request';
import type { MealLog, UpdateMealCompositionPayload } from '../../api/types';
import { ActionButton, FormActions } from '../../components/ui-kit';
import {
  createLocalCompositionEntryId,
  mergeMealComposition,
  type CompositionConflict,
  type CompositionEntry,
} from './MealCompositionModel';

export type MealCompositionEditorProps = {
  meal: MealLog;
  busy?: boolean;
  onSubmit: (payload: UpdateMealCompositionPayload) => Promise<MealLog>;
  /** Used after network timeout to verify whether the exact draft landed. */
  onRefetchMeal?: () => Promise<MealLog | null>;
  onSaved?: (meal: MealLog) => void;
  onClose: () => void;
};

function entriesFromMeal(meal: MealLog): CompositionEntry[] {
  return meal.food_entries.map((entry) => ({
    id: entry.id,
    food_id: entry.food_id,
    servings: entry.servings,
    note: entry.note ?? '',
    food_name: entry.food_name,
    rating: entry.rating,
  }));
}

function toPayload(entries: CompositionEntry[], expectedRowVersion: number): UpdateMealCompositionPayload {
  return {
    expected_row_version: expectedRowVersion,
    food_entries: entries.map((entry) => ({
      id: entry.id.startsWith('client:') ? null : entry.id,
      food_id: entry.food_id.trim(),
      servings: entry.servings,
      note: entry.note.trim(),
    })),
  };
}

function sameComposition(left: CompositionEntry[], right: CompositionEntry[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (entries: CompositionEntry[]) =>
    [...entries]
      .map((entry) => ({
        id: entry.id.startsWith('client:') ? '' : entry.id,
        food_id: entry.food_id.trim(),
        servings: entry.servings,
        note: (entry.note ?? '').trim(),
      }))
      .sort((a, b) => `${a.food_id}:${a.id}`.localeCompare(`${b.food_id}:${b.id}`));
  const a = normalize(left);
  const b = normalize(right);
  return a.every((entry, index) => {
    const other = b[index];
    if (!other) return false;
    const idMatch = !entry.id || !other.id || entry.id === other.id;
    return (
      idMatch &&
      entry.food_id === other.food_id &&
      entry.servings === other.servings &&
      entry.note === other.note
    );
  });
}

function conflictLabel(conflict: CompositionConflict): string {
  if (conflict.field === 'servings') return '份量冲突';
  if (conflict.field === 'note') return '备注冲突';
  if (conflict.field === 'food_id') return '菜品冲突';
  return '条目存在性冲突';
}

function extractCurrentMeal(reason: unknown): MealLog | null {
  if (!isApiError(reason)) return null;
  const payload = reason.payload;
  if (!payload || typeof payload !== 'object') return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const current = (detail as { current?: unknown }).current;
  if (!current || typeof current !== 'object') return null;
  return current as MealLog;
}

function isTimeoutError(reason: unknown): boolean {
  if (!isApiError(reason)) {
    return reason instanceof Error && /timeout|超时|network|网络/i.test(reason.message);
  }
  return reason.status === 0 || /timeout|超时|network|网络/i.test(reason.detail || reason.message);
}

export function MealCompositionEditor(props: MealCompositionEditorProps) {
  const [baseEntries, setBaseEntries] = useState(() => entriesFromMeal(props.meal));
  const [draftEntries, setDraftEntries] = useState(() => entriesFromMeal(props.meal));
  const [expectedRowVersion, setExpectedRowVersion] = useState(props.meal.row_version);
  const [conflicts, setConflicts] = useState<CompositionConflict[]>([]);
  const [needsExplicitResubmit, setNeedsExplicitResubmit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const next = entriesFromMeal(props.meal);
    setBaseEntries(next);
    setDraftEntries(next);
    setExpectedRowVersion(props.meal.row_version);
    setConflicts([]);
    setNeedsExplicitResubmit(false);
    setError(null);
  }, [props.meal.id]);

  const canRemove = draftEntries.length > 1;
  const isBusy = Boolean(props.busy || submitting);
  const primaryLabel = needsExplicitResubmit ? '确认并保存' : '保存组合';

  const conflictSummary = useMemo(
    () => conflicts.map((conflict) => `${conflict.entry_key}:${conflict.field}`).join('|'),
    [conflicts],
  );

  function updateEntry(entryId: string, patch: Partial<CompositionEntry>) {
    setDraftEntries((current) =>
      current.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)),
    );
    setNeedsExplicitResubmit(false);
  }

  function addEntry() {
    setDraftEntries((current) => [
      ...current,
      {
        id: createLocalCompositionEntryId(),
        food_id: '',
        servings: 1,
        note: '',
        food_name: '',
      },
    ]);
    setNeedsExplicitResubmit(false);
  }

  function removeEntry(entryId: string) {
    setDraftEntries((current) => {
      if (current.length <= 1) return current;
      return current.filter((entry) => entry.id !== entryId);
    });
    setNeedsExplicitResubmit(false);
  }

  async function submit() {
    if (isBusy) return;
    if (draftEntries.some((entry) => !entry.food_id.trim())) {
      setError('请填写菜品 ID');
      return;
    }
    if (draftEntries.some((entry) => !Number.isFinite(entry.servings) || entry.servings <= 0)) {
      setError('份量需要大于 0');
      return;
    }

    setSubmitting(true);
    setError(null);
    const payload = toPayload(draftEntries, expectedRowVersion);
    try {
      const saved = await props.onSubmit(payload);
      setBaseEntries(entriesFromMeal(saved));
      setDraftEntries(entriesFromMeal(saved));
      setExpectedRowVersion(saved.row_version);
      setConflicts([]);
      setNeedsExplicitResubmit(false);
      props.onSaved?.(saved);
    } catch (reason) {
      if (isApiError(reason) && reason.status === 409) {
        const serverMeal = extractCurrentMeal(reason);
        if (serverMeal) {
          const serverEntries = entriesFromMeal(serverMeal);
          const merged = mergeMealComposition(baseEntries, draftEntries, serverEntries);
          setDraftEntries(merged.entries);
          setBaseEntries(serverEntries);
          setExpectedRowVersion(serverMeal.row_version);
          setConflicts(merged.conflicts);
          setNeedsExplicitResubmit(true);
          setError(merged.conflicts.length > 0 ? '有冲突，请确认后再保存' : '内容已更新，需要再次确认保存');
          return;
        }
        setError('版本冲突，请刷新后重试');
        return;
      }

      if (isTimeoutError(reason) && props.onRefetchMeal) {
        try {
          const refetched = await props.onRefetchMeal();
          if (refetched && sameComposition(draftEntries, entriesFromMeal(refetched))) {
            setBaseEntries(entriesFromMeal(refetched));
            setDraftEntries(entriesFromMeal(refetched));
            setExpectedRowVersion(refetched.row_version);
            setConflicts([]);
            setNeedsExplicitResubmit(false);
            props.onSaved?.(refetched);
            return;
          }
          if (refetched) {
            const serverEntries = entriesFromMeal(refetched);
            const merged = mergeMealComposition(baseEntries, draftEntries, serverEntries);
            setDraftEntries(merged.entries);
            setBaseEntries(serverEntries);
            setExpectedRowVersion(refetched.row_version);
            setConflicts(merged.conflicts);
            setNeedsExplicitResubmit(true);
            setError(merged.conflicts.length > 0 ? '有冲突，请确认后再保存' : '内容可能已变化，需要再次确认保存');
            return;
          }
        } catch {
          // fall through to generic error
        }
      }

      setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="meal-composition-editor" aria-label="编辑这顿组合">
      <div className="meal-composition-editor-list">
        {draftEntries.map((entry, index) => (
          <div key={entry.id} className="meal-composition-editor-row">
            <label>
              <span>菜品</span>
              <input
                className="text-input"
                aria-label="菜品"
                value={entry.food_name || entry.food_id}
                onChange={(event) => {
                  const value = event.target.value;
                  updateEntry(entry.id, {
                    food_name: value,
                    // Keep food_id in sync when editing a free-text add row.
                    food_id: entry.id.startsWith('client:') ? value : entry.food_id,
                  });
                }}
                disabled={isBusy || !entry.id.startsWith('client:')}
              />
            </label>
            {entry.id.startsWith('client:') ? (
              <label>
                <span>菜品 ID</span>
                <input
                  className="text-input"
                  aria-label="菜品 ID"
                  value={entry.food_id}
                  onChange={(event) => updateEntry(entry.id, { food_id: event.target.value })}
                  disabled={isBusy}
                />
              </label>
            ) : null}
            <label>
              <span>份量</span>
              <input
                className="text-input"
                aria-label="份量"
                type="number"
                min={0.5}
                step={0.5}
                value={entry.servings}
                onChange={(event) =>
                  updateEntry(entry.id, { servings: Number(event.target.value) || 0 })
                }
                disabled={isBusy}
              />
            </label>
            <label>
              <span>备注</span>
              <input
                className="text-input"
                aria-label="备注"
                value={entry.note}
                onChange={(event) => updateEntry(entry.id, { note: event.target.value })}
                disabled={isBusy}
              />
            </label>
            <ActionButton
              tone="secondary"
              size="compact"
              type="button"
              disabled={!canRemove || isBusy}
              onClick={() => removeEntry(entry.id)}
            >
              移除
            </ActionButton>
            <small className="meal-composition-editor-index">#{index + 1}</small>
          </div>
        ))}
      </div>

      <div className="meal-composition-editor-toolbar">
        <ActionButton tone="secondary" size="compact" type="button" disabled={isBusy} onClick={addEntry}>
          添加菜品
        </ActionButton>
      </div>

      {conflicts.length > 0 ? (
        <div className="meal-composition-editor-conflicts" data-conflict-summary={conflictSummary}>
          <strong>有冲突，请确认后再保存</strong>
          <ul>
            {conflicts.map((conflict) => (
              <li key={`${conflict.entry_key}-${conflict.field}`}>
                <span>{conflictLabel(conflict)}</span>
                <small>
                  本地 {String(conflict.draft ?? '—')} · 服务器 {String(conflict.server ?? '—')}
                </small>
              </li>
            ))}
          </ul>
        </div>
      ) : needsExplicitResubmit ? (
        <p className="meal-composition-editor-hint">内容已更新，需要再次确认保存</p>
      ) : null}

      {error ? <p className="meal-composition-editor-error">{error}</p> : null}

      <FormActions
        primaryLabel={primaryLabel}
        isSubmitting={isBusy}
        onPrimary={() => {
          void submit();
        }}
        secondaryLabel="取消"
        onSecondary={props.onClose}
      />
    </section>
  );
}
