import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { Ingredient } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { useDebouncedSearchValue, useSearchCompositionState } from '../../hooks/useDebouncedValue';
import { MediaWithPlaceholder } from '../MediaPlaceholder';
import { ActionButton, Badge, EmptyState, SearchLoadingIndicator, WorkspaceModal } from '../ui-kit';
import { RecipeUiIcon } from './RecipeWorkspaceCards';
import type { RecipeUnresolvedIngredientTarget } from './RecipeWorkspaceModel';

type RecipeIngredientResolutionDialogProps = {
  targets: RecipeUnresolvedIngredientTarget[];
  ingredients: Ingredient[];
  isCreatingIngredient?: boolean;
  onClose: () => void;
  onRetrySave: () => void;
  onResolveWithIngredient: (target: RecipeUnresolvedIngredientTarget, ingredient: Ingredient) => void;
  onCreateIngredient: (target: RecipeUnresolvedIngredientTarget) => Promise<void> | void;
  onRemoveIngredientRow: (target: RecipeUnresolvedIngredientTarget) => void;
};

function reasonLabel(reason: string) {
  if (reason === 'ingredient_not_found') return '食材不存在或不属于当前家庭';
  if (reason === 'missing_ingredient_id') return '还没有绑定真实食材';
  return '需要重新确认';
}

function formatTargetQuantity(target: RecipeUnresolvedIngredientTarget) {
  const quantity = target.quantity === undefined || target.quantity === null || target.quantity === '' ? '' : String(target.quantity);
  return [quantity, target.unit].filter(Boolean).join('');
}

function RecipeIngredientCandidateSearch({
  target,
  ingredients,
  isCreatingIngredient,
  onResolveWithIngredient,
  onCreateIngredient,
  onRemoveIngredientRow,
}: {
  target: RecipeUnresolvedIngredientTarget;
  ingredients: Ingredient[];
  isCreatingIngredient?: boolean;
  onResolveWithIngredient: (target: RecipeUnresolvedIngredientTarget, ingredient: Ingredient) => void;
  onCreateIngredient: (target: RecipeUnresolvedIngredientTarget) => Promise<void> | void;
  onRemoveIngredientRow: (target: RecipeUnresolvedIngredientTarget) => void;
}) {
  const [search, setSearch] = useState(target.ingredient_name);
  const normalizedSearch = search.trim();
  const searchComposition = useSearchCompositionState();
  const searchValue = useDebouncedSearchValue(search, { isComposing: searchComposition.isComposing });
  const candidateQuery = useQuery({
    queryKey: queryKeys.ingredientPickerSearch(searchValue),
    queryFn: () => api.getIngredients({ q: searchValue, limit: 8 }),
    enabled: Boolean(searchValue),
    placeholderData: keepPreviousData,
  });
  const [appliedSearch, setAppliedSearch] = useState('');
  const [appliedCandidates, setAppliedCandidates] = useState<Ingredient[]>([]);
  useEffect(() => {
    if (!normalizedSearch) {
      setAppliedSearch('');
      setAppliedCandidates([]);
      return;
    }
    if (searchValue && !candidateQuery.isPlaceholderData && candidateQuery.data) {
      setAppliedSearch(searchValue);
      setAppliedCandidates(candidateQuery.data);
    }
  }, [candidateQuery.data, candidateQuery.isPlaceholderData, normalizedSearch, searchValue]);
  const fallbackCandidates = useMemo(() => {
    const keyword = normalizedSearch.toLocaleLowerCase();
    if (!keyword) return ingredients.slice(0, 8);
    return ingredients
      .filter((ingredient) => ingredient.name.toLocaleLowerCase().includes(keyword) || ingredient.category.toLocaleLowerCase().includes(keyword))
      .slice(0, 8);
  }, [ingredients, normalizedSearch]);
  const candidates = normalizedSearch ? appliedCandidates : fallbackCandidates;
  const isCandidateSearchFetching =
    Boolean(normalizedSearch) &&
    !searchComposition.isComposing &&
    (appliedSearch !== normalizedSearch || candidateQuery.isFetching);

  useEffect(() => {
    setSearch(target.ingredient_name);
  }, [target.rowId, target.ingredient_name]);

  return (
    <article className="recipe-ingredient-resolution-row">
      <div className="recipe-ingredient-resolution-row-head">
        <div>
          <strong>{target.ingredient_name || `第 ${target.index + 1} 项食材`}</strong>
          <span>
            {[formatTargetQuantity(target), reasonLabel(target.reason)].filter(Boolean).join(' · ')}
          </span>
        </div>
        <Badge>待处理</Badge>
      </div>

      <label className="recipe-ingredient-resolution-search">
        <span>检索已有食材</span>
        <span className="recipe-ingredient-resolution-search-input">
          <input
            className="text-input"
            value={search}
            placeholder="输入食材名或别名"
            onChange={(event) => setSearch(event.target.value)}
            onCompositionStart={searchComposition.onCompositionStart}
            onCompositionEnd={searchComposition.onCompositionEnd}
          />
          <SearchLoadingIndicator active={isCandidateSearchFetching} />
        </span>
      </label>

      <div className="recipe-ingredient-resolution-candidates">
        {isCandidateSearchFetching ? <p className="recipe-ingredient-resolution-status">正在检索相似食材...</p> : null}
        {!isCandidateSearchFetching && candidates.length === 0 ? (
          <p className="recipe-ingredient-resolution-status">没有找到合适候选，可以先新建食材。</p>
        ) : null}
        {candidates.map((ingredient) => (
          <button
            key={ingredient.id}
            type="button"
            className="recipe-ingredient-resolution-candidate"
            onClick={() => onResolveWithIngredient(target, ingredient)}
          >
            <MediaWithPlaceholder
              src={resolveAssetUrl(ingredient.image?.url)}
              alt={ingredient.name}
              className="recipe-ingredient-resolution-candidate-media"
              emptyLabel="暂无图"
            />
            <span>
              <strong>{ingredient.name}</strong>
              <small>{[ingredient.category, `默认 ${ingredient.default_unit}`, ingredient.default_storage].filter(Boolean).join(' · ')}</small>
            </span>
            <RecipeUiIcon name="check" />
          </button>
        ))}
      </div>

      <div className="recipe-ingredient-resolution-actions">
        <ActionButton tone="primary" size="compact" type="button" onClick={() => onCreateIngredient(target)} disabled={isCreatingIngredient}>
          <RecipeUiIcon name="plus" />
          新建为食材
        </ActionButton>
        <ActionButton tone="secondary" size="compact" type="button" onClick={() => onRemoveIngredientRow(target)}>
          <RecipeUiIcon name="minus" />
          从菜谱移除
        </ActionButton>
      </div>
    </article>
  );
}

export function RecipeIngredientResolutionDialog(props: RecipeIngredientResolutionDialogProps) {
  const unresolvedCount = props.targets.length;
  return (
    <div className="workspace-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        title="处理缺失食材"
        description="这些配料还没有绑定到食材库，处理后才能保存菜谱。"
        eyebrow="保存前确认"
        onClose={props.onClose}
        className="recipe-ingredient-resolution-modal"
      >
        <div className="recipe-ingredient-resolution-dialog">
          <section className="recipe-ingredient-resolution-summary">
            <div>
              <h3>{unresolvedCount > 0 ? '需要逐项确认' : '食材已经处理完成'}</h3>
              <p>{unresolvedCount > 0 ? '可以匹配已有食材、创建新食材，或移除不需要扣库存的配料。' : '现在可以重新保存菜谱。'}</p>
            </div>
            <Badge>{unresolvedCount} 项</Badge>
          </section>

          {unresolvedCount > 0 ? (
            <div className="recipe-ingredient-resolution-list">
              {props.targets.map((target) => (
                <RecipeIngredientCandidateSearch
                  key={`${target.rowId ?? target.index}-${target.reason}`}
                  target={target}
                  ingredients={props.ingredients}
                  isCreatingIngredient={props.isCreatingIngredient}
                  onResolveWithIngredient={props.onResolveWithIngredient}
                  onCreateIngredient={props.onCreateIngredient}
                  onRemoveIngredientRow={props.onRemoveIngredientRow}
                />
              ))}
            </div>
          ) : (
            <EmptyState title="没有待处理食材" description="已将所有配料绑定到食材库，或从菜谱中移除。" />
          )}

          <div className="workspace-overlay-actions">
            <ActionButton tone="secondary" type="button" onClick={props.onClose}>
              稍后处理
            </ActionButton>
            <ActionButton tone="primary" type="button" onClick={props.onRetrySave} disabled={unresolvedCount > 0}>
              重新保存
            </ActionButton>
          </div>
        </div>
      </WorkspaceModal>
    </div>
  );
}
