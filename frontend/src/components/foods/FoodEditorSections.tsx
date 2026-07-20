import type { CSSProperties } from 'react';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton } from '../ui-kit';
import { FoodUiIcon } from './FoodWorkspacePrimitives';

export type FoodEditorCompletionItem = {
  label: string;
  done: boolean;
};

export type FoodEditorRecipeSummaryProps = {
  completionPercent: number;
  coverUrl?: string;
  description: string;
  hasRecipe: boolean;
  meta: string;
  onEditRecipe: () => void;
  resolveAssetUrl: (url: string) => string;
  title: string;
};

function clampCompletionPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function completionStyle(completionPercent: number) {
  return {
    '--food-editor-completion': `${clampCompletionPercent(completionPercent)}%`,
  } as CSSProperties;
}

export function FoodEditorRecipeSummary(props: FoodEditorRecipeSummaryProps) {
  return (
    <div className="food-editor-recipe-card">
      <div className="food-editor-recipe-cover">
        <MediaWithPlaceholder
          src={props.coverUrl ? props.resolveAssetUrl(props.coverUrl) : undefined}
          alt=""
        />
      </div>
      <div className="food-editor-recipe-copy">
        <strong>{props.title}</strong>
        <span>{props.meta}</span>
        <p>{props.description}</p>
        <div className="food-editor-recipe-progress" aria-hidden="true">
          <span style={completionStyle(props.completionPercent)} />
        </div>
      </div>
      <div className="food-editor-recipe-action">
        <ActionButton tone="secondary" type="button" onClick={props.onEditRecipe}>
          <span>{props.hasRecipe ? '编辑菜谱' : '添加菜谱'}</span>
          <FoodUiIcon name="arrowRight" />
        </ActionButton>
      </div>
    </div>
  );
}

export function FoodEditorCompletion(props: {
  completionItems: FoodEditorCompletionItem[];
  completionPercent: number;
}) {
  const completionPercent = clampCompletionPercent(props.completionPercent);
  return (
    <div className="food-editor-completion">
      <div className="food-editor-completion-head">
        <span>资料完整度</span>
        <strong>{completionPercent}%</strong>
      </div>
      <div
        className="food-editor-completion-bar"
        role="progressbar"
        aria-label="资料完整度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={completionPercent}
        style={completionStyle(completionPercent)}
      >
        <span />
      </div>
      <div className="food-editor-completion-list">
        {props.completionItems.map((item) => (
          <span key={item.label} className={item.done ? 'done' : ''}>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
