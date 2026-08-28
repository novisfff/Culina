import { DashboardIcon } from '../../app/shellIcons';
import { StateBlock } from '../../components/ui-kit';
import type { InventoryActionGroup } from '../inventory/inventoryActionModel';
import type { HomeRequiredAction } from './homeDashboardModel';

export function getHomeActionPrimaryLabel(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return '加入采购清单';
  }
  if (group.severity === 'expired') {
    return '集中处理';
  }
  return '处理提醒';
}

export function getHomeActionTone(group: InventoryActionGroup) {
  if (group.kind === 'low_stock') {
    return 'low-stock';
  }
  if (group.severity === 'expired') {
    return 'expired';
  }
  if (group.severity === 'expires_today' || group.severity === 'expires_soon') {
    return 'soon';
  }
  return 'later';
}

function HomeInventoryActionRow(props: {
  group: InventoryActionGroup;
  onOpen: () => void;
}) {
  const primaryLabel = getHomeActionPrimaryLabel(props.group);
  return (
    <article
      className={`home-action-row tone-${getHomeActionTone(props.group)}`}
      data-testid="home-action-group"
    >
      <span className="home-action-icon" aria-hidden="true">
        <DashboardIcon name="leaf" />
      </span>
      <div className="home-action-row-copy">
        <strong>{props.group.title}</strong>
        <p>{props.group.detail}</p>
      </div>
      <button
        className="solid-button button-compact"
        type="button"
        data-testid="home-action-primary"
        onClick={props.onOpen}
        aria-label={`${primaryLabel}${props.group.ingredientName}`}
      >
        {primaryLabel}
      </button>
    </article>
  );
}

export function HomeRequiredActions(props: {
  actions: HomeRequiredAction[];
  hasMore: boolean;
  onOpenInventory: (group: InventoryActionGroup) => void;
  onOpenShoppingIntake: () => void;
  onOpenReconciliation: () => void;
  onViewAll: () => void;
}) {
  const showSingleActionHint = props.actions.length === 1 && !props.hasMore;

  return (
    <section
      className={`home-question-panel home-required-actions${showSingleActionHint ? ' is-single-action' : ''}`}
      aria-labelledby="home-required-title"
    >
      <header className="home-question-head">
        <div>
          <h2 id="home-required-title">今天需要处理什么</h2>
        </div>
        <button
          className="ghost-button button-compact home-question-head-action"
          type="button"
          onClick={props.onOpenReconciliation}
        >
          <DashboardIcon name="refresh" />
          核对库存
        </button>
      </header>
      {props.actions.length > 0 ? (
        <div className="home-action-list">
          {props.actions.map((action) =>
            action.kind === 'shopping' ? (
              <article key="shopping" className="home-action-row tone-shopping">
                <span className="home-action-icon" aria-hidden="true">
                  <DashboardIcon name="cart" />
                </span>
                <div className="home-action-row-copy">
                  <strong>{action.pendingCount} 项待采购</strong>
                  <p>记录本次购买</p>
                </div>
                <button
                  className="solid-button button-compact"
                  type="button"
                  data-testid="home-action-primary"
                  onClick={props.onOpenShoppingIntake}
                >
                  记录购买
                </button>
              </article>
            ) : (
              <HomeInventoryActionRow
                key={action.group.id}
                group={action.group}
                onOpen={() => props.onOpenInventory(action.group)}
              />
            ),
          )}
        </div>
      ) : (
        <StateBlock
          status="empty"
          title="今天没有需要处理的事项"
          description="目前没有需要处理的库存或采购内容。"
        />
      )}
      {showSingleActionHint ? (
        <p className="home-required-single-hint">
          <span className="home-required-single-hint-icon" aria-hidden="true">
            <DashboardIcon name="check" />
          </span>
          <span>处理完这一项后，今天暂时没有其他需要处理的事。</span>
        </p>
      ) : null}
      {props.hasMore ? (
        <button
          className="tertiary-button button-compact home-question-more"
          type="button"
          onClick={props.onViewAll}
        >
          <span>查看全部</span>
          <DashboardIcon name="arrow-right" />
        </button>
      ) : null}
    </section>
  );
}
