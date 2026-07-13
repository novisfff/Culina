import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react';
import type { EatBaseView } from '../../app/appNavigationModel';
import type { AppNavigationService } from '../../app/useAppNavigationState';
import { ActionButton, StateBlock } from '../../components/ui-kit';
import type { ResolvedEatTask } from './EatWorkspaceViewModel';

const EAT_TABS: ReadonlyArray<{ key: EatBaseView; label: string }> = [
  { key: 'discover', label: '发现' },
  { key: 'plan', label: '菜单' },
  { key: 'history', label: '吃过的' },
];

export type EatWorkspaceProps = {
  navigation: AppNavigationService;
  resolvedTask: ResolvedEatTask;
  liveMessage?: string;
  completionPending?: boolean;
  discoverContent?: ReactNode;
  planContent?: ReactNode;
  historyContent?: ReactNode;
  /** Optional focused task body for food/plan/meal/cook/ready-recipe kinds. */
  foodTaskContent?: ReactNode;
  planTaskContent?: ReactNode;
  mealTaskContent?: ReactNode;
  recipeTaskContent?: ReactNode;
  cookTaskContent?: ReactNode;
  mealCreateContent?: ReactNode;
};

function returnLabel(view: EatBaseView): string {
  if (view === 'plan') return '返回菜单';
  if (view === 'history') return '返回吃过的';
  return '返回发现';
}

function taskReturnView(task: AppNavigationService['state']['eat']['task']): EatBaseView {
  return task?.returnTo ?? 'discover';
}

function renderBaseView(props: EatWorkspaceProps): ReactNode {
  switch (props.navigation.state.eat.baseView) {
    case 'plan':
      return props.planContent ?? null;
    case 'history':
      return props.historyContent ?? null;
    case 'discover':
    default:
      return props.discoverContent ?? null;
  }
}

type TaskShellProps = {
  title: string;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
  completionPending?: boolean;
  children: ReactNode;
  footerActions?: ReactNode;
  closeLabel?: string;
};

/**
 * Shared task panel: one close path for drawer/back/Escape, blocked while completionPending.
 * Reuses overlay visual classes without WorkspaceOverlayFrame focus lifecycle — Task 2 owns
 * heading focus via registerTaskHeading and restore-to-base. No auto-focus / restore here.
 */
function EatTaskShell(props: TaskShellProps) {
  const pending = Boolean(props.completionPending);
  const titleId = useId();
  const onCloseRef = useRef(props.onClose);
  const pendingRef = useRef(pending);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pendingRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div
      className="workspace-overlay-root eat-task-overlay"
      data-busy={pending ? 'true' : undefined}
    >
      <div
        className="workspace-overlay-backdrop"
        onClick={() => {
          if (pendingRef.current) return;
          onCloseRef.current();
        }}
      />
      <section
        className="eat-task-panel workspace-modal workspace-overlay-panel workspace-modal-sheet"
        data-workspace-overlay-panel="true"
        data-workspace-overlay-busy={pending ? 'true' : 'false'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="eat-task-header">
          <h2 id={titleId} ref={props.headingRef} className="eat-task-heading" tabIndex={-1}>
            {props.title}
          </h2>
          <ActionButton
            tone="secondary"
            size="compact"
            type="button"
            className="workspace-overlay-close eat-task-close"
            aria-label={props.closeLabel ?? '关闭'}
            disabled={pending}
            onClick={() => {
              if (!pending) props.onClose();
            }}
          >
            关闭
          </ActionButton>
        </header>
        <div className="eat-task-body">{props.children}</div>
        {props.footerActions ? (
          <footer className="eat-task-action-bar">{props.footerActions}</footer>
        ) : null}
      </section>
    </div>
  );
}

function RelationErrorTask(props: {
  title: string;
  description: string;
  returnLabel: string;
  headingRef: Ref<HTMLHeadingElement>;
  onClose: () => void;
  completionPending?: boolean;
}) {
  const pending = Boolean(props.completionPending);
  return (
    <EatTaskShell
      title={props.title}
      headingRef={props.headingRef}
      onClose={props.onClose}
      completionPending={props.completionPending}
      footerActions={
        <ActionButton
          tone="primary"
          type="button"
          disabled={pending}
          onClick={() => {
            if (!pending) props.onClose();
          }}
        >
          {props.returnLabel}
        </ActionButton>
      }
    >
      <p className="eat-task-relation-copy">{props.description}</p>
    </EatTaskShell>
  );
}

function renderResolvedTask(
  props: EatWorkspaceProps,
  options: { headingRef: Ref<HTMLHeadingElement> },
): ReactNode {
  const resolved = props.resolvedTask;
  if (resolved.kind === 'none') {
    return null;
  }

  const onClose = props.navigation.closeTask;
  const backLabel = returnLabel(taskReturnView(props.navigation.state.eat.task));
  const pending = props.completionPending;

  if (resolved.kind === 'loading') {
    return (
      <EatTaskShell
        title={resolved.label}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock status="loading" title="请稍候" description="正在准备内容。" />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'recipe-food-missing' || resolved.kind === 'recipe-food-ambiguous') {
    return (
      <RelationErrorTask
        title="这份做法与家常菜的关联需要修复"
        description={
          resolved.kind === 'recipe-food-ambiguous'
            ? `「${resolved.recipe.title}」关联了多道家常菜，目前不能开始做或写入菜单。`
            : `「${resolved.recipe.title}」尚未关联唯一家常菜，目前只能查看说明，不能开始做。`
        }
        returnLabel={backLabel}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      />
    );
  }

  if (resolved.kind === 'recipe-not-found') {
    return (
      <RelationErrorTask
        title="这份做法已经不存在"
        description="它可能已被家庭成员删除或更新。"
        returnLabel={backLabel}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      />
    );
  }

  if (resolved.kind === 'plan-not-found') {
    return (
      <RelationErrorTask
        title="这个菜单项已经不存在"
        description="它可能已被家庭成员删除或更新。"
        returnLabel={backLabel}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      />
    );
  }

  if (resolved.kind === 'meal-not-found') {
    return (
      <RelationErrorTask
        title="这餐记录已经不存在"
        description="它可能已被家庭成员删除或更新。"
        returnLabel={backLabel}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      />
    );
  }

  if (resolved.kind === 'food-not-found') {
    return (
      <RelationErrorTask
        title="这份家常菜已经不存在"
        description="它可能已被家庭成员删除或更新。"
        returnLabel={backLabel}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      />
    );
  }

  if (resolved.kind === 'food') {
    // Full-chrome body (e.g. FoodDetailDrawer) owns its overlay; skip the task shell.
    if (props.foodTaskContent) {
      return props.foodTaskContent;
    }
    return (
      <EatTaskShell
        title={resolved.food.name || '家常菜详情'}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock
          status="empty"
          title={resolved.food.name}
          description="家常菜任务内容将由上层装配。"
        />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'ready-recipe') {
    if (props.recipeTaskContent) {
      return props.recipeTaskContent;
    }
    return (
      <EatTaskShell
        title="做法"
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock status="empty" title="做法" description="做法任务内容将由上层装配。" />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'plan') {
    if (props.planTaskContent) {
      return props.planTaskContent;
    }
    return (
      <EatTaskShell
        title={resolved.item.food_name || '菜单项'}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock
          status="empty"
          title={resolved.item.food_name}
          description="菜单项任务内容将由上层装配。"
        />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'cook') {
    if (props.cookTaskContent) {
      return props.cookTaskContent;
    }
    return (
      <EatTaskShell
        title={resolved.recipe.title || '做菜'}
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock
          status="empty"
          title={resolved.recipe.title}
          description="做菜任务内容将由上层装配。"
        />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'meal-create') {
    if (props.mealCreateContent) {
      return props.mealCreateContent;
    }
    return (
      <EatTaskShell
        title="记录一餐"
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock status="empty" title="记录一餐" description="新建这餐的内容将由上层装配。" />
      </EatTaskShell>
    );
  }

  if (resolved.kind === 'meal') {
    if (props.mealTaskContent) {
      return props.mealTaskContent;
    }
    return (
      <EatTaskShell
        title="这餐详情"
        headingRef={options.headingRef}
        onClose={onClose}
        completionPending={pending}
      >
        <StateBlock status="empty" title="这餐详情" description="这餐任务内容将由上层装配。" />
      </EatTaskShell>
    );
  }

  return null;
}

/**
 * Lightweight composition boundary for the unified eating workspace.
 * Owns tab semantics, base-view slots, resolved-task rendering, and focus targets.
 * Does not own domain mutations, recommendations, or query fetching.
 */
export function EatWorkspace(props: EatWorkspaceProps) {
  const { state } = props.navigation;

  return (
    <main className="eat-workspace">
      <header className="eat-workspace-header">
        <h1 className="eat-workspace-title">吃什么</h1>
        <div role="tablist" aria-label="吃什么视图" className="eat-workspace-tabs">
          {EAT_TABS.map((item) => {
            const selected = state.eat.baseView === item.key;
            return (
              <button
                key={item.key}
                role="tab"
                type="button"
                className={['eat-workspace-tab', selected ? 'is-selected' : ''].filter(Boolean).join(' ')}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={(event) => props.navigation.selectEatView(item.key, event.currentTarget)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="eat-workspace-layout">
        <section
          ref={props.navigation.registerBaseViewFocusTarget}
          className="eat-workspace-base"
          tabIndex={-1}
          aria-label="当前吃什么列表"
        >
          {renderBaseView(props)}
        </section>

        {renderResolvedTask(props, {
          headingRef: props.navigation.registerTaskHeading as Ref<HTMLHeadingElement>,
        })}
      </div>

      <div className="sr-only" aria-live="polite">
        {props.liveMessage ?? ''}
      </div>
    </main>
  );
}
