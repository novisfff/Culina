import type { ReactNode } from 'react';
import type { MealLog } from '../../api/types';

export type MealHistorySurfaceMode = 'timeline' | 'create' | 'detail' | 'enrich';

export type MealHistorySurfaceProps = {
  mode: MealHistorySurfaceMode;
  /** Optional meal for detail/enrich modes. */
  meal?: MealLog | null;
  /** Timeline desktop + mobile content (siblings, like the current workspace). */
  children?: ReactNode;
  createContent?: ReactNode;
  detailContent?: ReactNode;
  enrichContent?: ReactNode;
};

/**
 * Shell-free valid-meal history surface.
 * Timeline/create/detail/enrich presentation without debt-task language.
 */
export function MealHistorySurface(props: MealHistorySurfaceProps) {
  if (props.mode === 'create' && props.createContent) {
    return (
      <section className="meal-history-surface meal-history-surface-create" aria-label="记一餐">
        {props.createContent}
      </section>
    );
  }

  if (props.mode === 'detail' && props.detailContent) {
    return (
      <section className="meal-history-surface meal-history-surface-detail" aria-label="这餐详情">
        {props.detailContent}
      </section>
    );
  }

  if (props.mode === 'enrich' && props.enrichContent) {
    return (
      <section className="meal-history-surface meal-history-surface-enrich" aria-label="编辑这顿">
        {props.enrichContent}
      </section>
    );
  }

  return (
    <section className="meal-history-surface meal-history-surface-timeline" aria-label="吃过的">
      {props.children}
    </section>
  );
}
