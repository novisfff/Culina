import type {
  ModelUsageFamilyRequestLog,
  ModelUsagePersonalRequestLog,
  ModelUsageRequestLogPage,
} from '../../api/types/modelUsage';
import { StatusBadge } from '../../components/ui-kit';
import { MODEL_USAGE_CAPABILITY_OPTIONS, MODEL_USAGE_METER_OPTIONS } from './modelUsageOptions';
import { formatModelUsageCny, formatModelUsageQuantity } from './modelUsageModel';

function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai',
  }).format(date);
}

function RequestLogEntry(props: { item: ModelUsagePersonalRequestLog; familyItem?: ModelUsageFamilyRequestLog }) {
  const { item, familyItem } = props;
  const pricingKnown = item.pricing_status === 'priced';
  return (
    <article className="model-usage-request-record" role="listitem">
      <div className="model-usage-request-record-identity">
        <strong>{MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label}</strong>
        <time dateTime={item.occurred_at}>{dateTime(item.occurred_at)}</time>
      </div>
      {item.meters.length ? (
        <dl className="model-usage-request-record-meters">
          {item.meters.map((meter, index) => (
            <div key={`${meter.meter}:${index}`}>
              <dt>{MODEL_USAGE_METER_OPTIONS[meter.meter].label}</dt>
              <dd>{formatModelUsageQuantity(meter.quantity)}{meter.meter === 'generated_images' ? ' 张' : meter.meter === 'audio_input_seconds' || meter.meter === 'audio_output_seconds' ? ' 秒' : ''}</dd>
            </div>
          ))}
        </dl>
      ) : <span className="model-usage-request-record-empty">用量待确认</span>}
      <div className="model-usage-request-record-statuses">
        {familyItem && pricingKnown && familyItem.cost_cny != null ? <strong className="model-usage-request-record-cost">{formatModelUsageCny(familyItem.cost_cny)}</strong> : null}
        {item.measurement_status === 'estimated' ? <StatusBadge tone="neutral">估算用量</StatusBadge> : null}
        {item.provider_outcome === 'failed_billed' ? <StatusBadge tone="warning">失败 · 已计费</StatusBadge>
          : item.provider_outcome === 'not_billed' ? <StatusBadge tone="neutral">未计费</StatusBadge>
            : item.provider_outcome !== 'succeeded' || item.execution_certainty === 'unknown'
              ? <StatusBadge tone="warning">执行待核对</StatusBadge> : null}
        {!pricingKnown ? <StatusBadge tone="warning">未定价</StatusBadge>
          : familyItem && familyItem.cost_cny == null ? <StatusBadge tone="warning">费用待确认</StatusBadge> : null}
      </div>
    </article>
  );
}

export function ModelUsageRequestLogs(props: { page: ModelUsageRequestLogPage | null }) {
  const page = props.page;
  const items = page?.items ?? [];
  return (
    <section className="model-usage-request-results" aria-labelledby="model-usage-request-results-heading">
      <div className="model-usage-request-results-head">
        <div>
          <h2 id="model-usage-request-results-heading">请求记录</h2>
          <p>共 {page?.total ?? 0} 次请求</p>
        </div>
        <span>本页 {items.length} 条</span>
      </div>
      {!page || items.length === 0 ? (
        <p className="model-usage-request-empty">没有符合当前条件的请求记录。</p>
      ) : (
        <div className="model-usage-request-log-list" role="list">
          {page.scope === 'family'
            ? page.items.map((item) => <RequestLogEntry key={item.id} item={item} familyItem={item} />)
            : page.items.map((item) => <RequestLogEntry key={item.id} item={item} />)}
        </div>
      )}
    </section>
  );
}
