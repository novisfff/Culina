import type { ComponentProps, ReactNode } from 'react';
import type { CookRecipeResponse, Food, Recipe } from '../../api/types';
import type { CookLaunchContext } from '../../app/appNavigationModel';
import { StateBlock } from '../ui-kit';
import { RecipeCookView } from './RecipeCookView';
import { RecipeDetailDrawer } from './RecipeDetailDrawer';
import { RecipeDetailView } from './RecipeDetailView';
import { RecipeEditorView } from './RecipeEditorView';

type RecipeDetailProps = ComponentProps<typeof RecipeDetailView>;
type RecipeEditorProps = ComponentProps<typeof RecipeEditorView>;
type RecipeCookProps = ComponentProps<typeof RecipeCookView>;

type RecipeTaskBase = {
  recipe: Recipe;
  food: Food | null;
};

export type RecipeTaskSurfaceProps =
  | (RecipeTaskBase & {
      mode: 'view';
      onEdit: () => void;
      onCook: (context: CookLaunchContext) => void;
      onClose: () => void;
      relationWritable: boolean;
      asDrawer?: boolean;
      detail: RecipeDetailProps;
    })
  | (RecipeTaskBase & {
      mode: 'edit';
      onSaved: (recipe: Recipe) => void;
      onClose: () => void;
      relationWritable: boolean;
      editor: RecipeEditorProps;
      /** Optional detail props used when the Food relation is not writable. */
      detailFallback?: RecipeDetailProps;
    })
  | (RecipeTaskBase & {
      mode: 'cook';
      food: Food;
      launchContext: CookLaunchContext;
      onCompleted: (result: CookRecipeResponse) => void;
      onClose: () => void;
      cook: RecipeCookProps;
    });

function RelationErrorBanner({ recipeTitle }: { recipeTitle: string }) {
  return (
    <StateBlock
      status="error"
      title="做法关联不完整"
      description={`${recipeTitle} 尚未关联唯一食物，目前只能只读查看，不能开始烹饪或写入菜单计划。`}
      className="recipe-task-relation-error"
    />
  );
}

function ReadOnlyDetail(props: {
  recipe: Recipe;
  relationWritable: boolean;
  asDrawer?: boolean;
  onClose: () => void;
  detail: RecipeDetailProps;
  onEdit: () => void;
  onCook: (context: CookLaunchContext) => void;
}) {
  const detailProps: RecipeDetailProps = props.relationWritable
    ? {
        ...props.detail,
        onBack: props.detail.onBack ?? props.onClose,
        onEdit: props.onEdit,
        onCook: (card) => {
          props.detail.onCook(card);
        },
      }
    : {
        ...props.detail,
        showPlanAction: false,
        showShoppingAction: false,
        showEditAction: false,
        showDeleteAction: false,
        onBack: props.onClose,
        onCook: () => undefined,
        onPlan: () => undefined,
        onShopping: () => undefined,
        onEdit: () => undefined,
        onDelete: async () => undefined,
      };

  let body: ReactNode;
  if (props.asDrawer) {
    const { onBack: _onBack, backLabel: _backLabel, compactHeader: _compactHeader, showHeroTitle: _showHeroTitle, ...drawerDetail } =
      detailProps;
    body = <RecipeDetailDrawer {...drawerDetail} onClose={props.onClose} />;
  } else {
    body = <RecipeDetailView {...detailProps} />;
  }

  return (
    <>
      {!props.relationWritable ? <RelationErrorBanner recipeTitle={props.recipe.title} /> : null}
      {body}
    </>
  );
}

/**
 * Task-facing Recipe surface for view/edit/cook.
 * Composes detail/editor/cook views without the Recipe library shell.
 */
export function RecipeTaskSurface(props: RecipeTaskSurfaceProps) {
  if (props.mode === 'cook') {
    return (
      <section className="recipe-task-surface recipe-task-surface-cook" aria-label="烹饪">
        <RecipeCookView {...props.cook} />
      </section>
    );
  }

  if (props.mode === 'edit') {
    if (!props.relationWritable) {
      return (
        <section className="recipe-task-surface recipe-task-surface-view" aria-label="做法">
          <RelationErrorBanner recipeTitle={props.recipe.title} />
          {props.detailFallback ? (
            <RecipeDetailView
              {...props.detailFallback}
              showPlanAction={false}
              showShoppingAction={false}
              showEditAction={false}
              showDeleteAction={false}
              onCook={() => undefined}
              onPlan={() => undefined}
              onShopping={() => undefined}
              onEdit={() => undefined}
              onDelete={async () => undefined}
              onBack={props.onClose}
            />
          ) : null}
        </section>
      );
    }

    return (
      <section className="recipe-task-surface recipe-task-surface-edit" aria-label="编辑做法">
        <RecipeEditorView {...props.editor} />
      </section>
    );
  }

  return (
    <section className="recipe-task-surface recipe-task-surface-view" aria-label="做法">
      <ReadOnlyDetail
        recipe={props.recipe}
        relationWritable={props.relationWritable}
        asDrawer={props.asDrawer}
        onClose={props.onClose}
        detail={props.detail}
        onEdit={props.onEdit}
        onCook={props.onCook}
      />
    </section>
  );
}
