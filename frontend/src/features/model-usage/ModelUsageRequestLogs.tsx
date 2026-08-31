import type {
  ModelUsageFamilyRequestLog,
  ModelUsageFamilyRequestLogPage,
  ModelUsagePersonalRequestLog,
  ModelUsagePersonalRequestLogPage,
  ModelUsageRequestLogPage,
} from '../../api/types/modelUsage';
import { MODEL_USAGE_CAPABILITY_OPTIONS, MODEL_USAGE_METER_OPTIONS } from './modelUsageOptions';
import { formatModelUsageCny, formatModelUsageQuantity } from './modelUsageModel';

type RequestLogItem = ModelUsagePersonalRequestLog | ModelUsageFamilyRequestLog;

function statusLabel(item: RequestLogItem): string {
  if (item.pricing_status !== 'priced') return '未定价';
  if (item.measurement_status === 'estimated') return '含估算';
  if (item.provider_outcome !== 'succeeded') return '需要核对';
  return '已核对';
}

function meterSummary(item: RequestLogItem): string {
  return item.meters
    .slice(0, 3)
    .map((meter) => `${formatModelUsageQuantity(meter.quantity)} ${MODEL_USAGE_METER_OPTIONS[meter.meter].label}`)
    .join(' · ') || '还没有用量明细';
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function PersonalRequestLogList(props: { page: ModelUsagePersonalRequestLogPage }) {
  return (
    <div className="model-usage-request-log-list" role="list">
      {props.page.items.map((item) => (
        <article className="model-usage-request-log" key={item.id} role="listitem">
          <div className="model-usage-request-log-main">
            <div className="model-usage-request-log-title">
              <strong>{MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label}</strong>
              <span>我的请求</span>
            </div>
            <small>{dateTime(item.occurred_at)}</small>
          </div>
          <div className="model-usage-request-log-meters">{meterSummary(item)}</div>
          <span className={`model-usage-table-status ${statusLabel(item) === '已核对' ? 'is-good' : 'is-warning'}`}>{statusLabel(item)}</span>
        </article>
      ))}
    </div>
  );
}

function FamilyRequestLogList(props: { page: ModelUsageFamilyRequestLogPage }) {
  return (
    <div className="model-usage-request-log-list" role="list">
      {props.page.items.map((item) => (
        <article className="model-usage-request-log" key={item.id} role="listitem">
          <div className="model-usage-request-log-main">
            <div className="model-usage-request-log-title">
              <strong>{item.billing_model || item.requested_model}</strong>
              <span>{MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label}</span>
            </div>
            <small>{dateTime(item.occurred_at)} · {item.provider}</small>
          </div>
          <div className="model-usage-request-log-meters">{meterSummary(item)}</div>
          <strong className="model-usage-request-log-cost">{item.cost_cny ? formatModelUsageCny(item.cost_cny) : '未定价'}</strong>
          <span className={`model-usage-table-status ${statusLabel(item) === '已核对' ? 'is-good' : 'is-warning'}`}>{statusLabel(item)}</span>
        </article>
      ))}
    </div>
  );
}

export function ModelUsageRequestLogs(props: { page: ModelUsageRequestLogPage | null }) {
  const items = props.page?.items ?? [];
  return (
    <section className="model-usage-request-results" aria-labelledby="model-usage-request-results-heading">
      <div className="model-usage-request-results-head">
        <div>
          <h2 id="model-usage-request-results-heading">请求记录</h2>
          <p>共 {props.page?.total ?? 0} 次请求</p>
        </div>
        <span>本页 {items.length} 条</span>
      </div>
      {props.page === null || items.length === 0 ? (
        <p className="model-usage-request-empty">没有符合当前条件的请求记录。</p>
      ) : props.page.scope === 'family' ? (
        <FamilyRequestLogList page={props.page} />
      ) : (
        <PersonalRequestLogList page={props.page} />
      )}
    </section>
  );
}
