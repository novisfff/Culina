import { DashboardIcon } from '../../app/shellIcons';
import { StateBlock } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import {
  homeHighlightIcon,
  resolveHomeHighlightActor,
  type HomeHighlightsViewModel,
} from './homeDashboardModel';

function HomeHighlightSkeleton() {
  return (
    <div className="home-highlight-skeleton" aria-label="家庭动态加载中">
      {[0, 1, 2].map((index) => (
        <span key={index} aria-hidden="true" />
      ))}
    </div>
  );
}

export function HomeHighlightTimeline(props: {
  viewModel: HomeHighlightsViewModel;
  limit: number;
  onRetry: () => void;
  onViewAll: () => void;
}) {
  const items = props.viewModel.items.slice(0, props.limit);
  return (
    <section className="home-question-panel home-highlight-panel" aria-labelledby="home-highlight-title">
      <header className="home-question-head">
        <div>
          <h2 id="home-highlight-title">家里发生了什么</h2>
        </div>
        <button className="tertiary-button button-compact home-question-head-action" type="button" onClick={props.onViewAll}>
          查看完整记录
          <DashboardIcon name="arrow-right" />
        </button>
      </header>
      {props.viewModel.phase === 'loading' && <HomeHighlightSkeleton />}
      {props.viewModel.phase === 'error' && (
        <StateBlock
          status="error"
          title="家庭动态暂时加载失败"
          description="稍后重试；其他首页功能仍可使用。"
          actionLabel="重试家庭动态"
          onAction={props.onRetry}
        />
      )}
      {props.viewModel.phase === 'empty' && (
        <StateBlock
          status="empty"
          title="还没有家庭高亮"
          description="新的采购、盘点、菜单和餐食结果会出现在这里。"
        />
      )}
      {items.length > 0 && (
        <div className="home-highlight-list">
          {items.map((item) => (
            <article key={item.id} className={`home-highlight-row tone-${item.kind}`} data-testid="home-highlight-row">
              <span className="home-highlight-icon" aria-hidden="true">
                <DashboardIcon name={homeHighlightIcon(item.kind)} />
              </span>
              <div className="home-highlight-copy">
                <strong>{resolveHomeHighlightActor(item.actor_name)}</strong>
                <p>{item.summary}</p>
              </div>
              <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
            </article>
          ))}
        </div>
      )}
      {props.viewModel.hasRefreshError && (
        <button className="home-highlight-refresh-warning" type="button" onClick={props.onRetry}>
          刷新失败，重试
        </button>
      )}
    </section>
  );
}
