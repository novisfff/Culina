import type { ReactNode } from 'react';
import type { ModelUsageBreakdownItem, ModelUsageGroupBy } from '../../api/types';
import { MODEL_USAGE_CAPABILITY_OPTIONS, MODEL_USAGE_METER_OPTIONS } from './modelUsageOptions';
import { costDisplay, formatModelUsageQuantity } from './modelUsageModel';

type ModelUsageBreakdownTableProps = {
  items: ModelUsageBreakdownItem[];
  groupBy: ModelUsageGroupBy;
};

type Column = {
  key: string;
  label: string;
  render: (item: ModelUsageBreakdownItem) => ReactNode;
  className?: string;
};

function dimensionLabel(item: ModelUsageBreakdownItem, groupBy: ModelUsageGroupBy): string {
  if (groupBy === 'capability' && item.capability) return MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label;
  if (groupBy === 'meter' && item.meter) return MODEL_USAGE_METER_OPTIONS[item.meter].label;
  if (groupBy === 'provider_model' && item.billing_model) return `模型：${item.billing_model}`;
  return item.label;
}

function usageValue(item: ModelUsageBreakdownItem): string {
  if (!item.meter || !item.meter_total) return '—';
  return `${formatModelUsageQuantity(item.meter_total)} ${MODEL_USAGE_METER_OPTIONS[item.meter].label}`;
}

function pricingStatus(item: ModelUsageBreakdownItem): ReactNode {
  if (item.pricing_complete) return <span className="model-usage-table-status is-good">已定价</span>;
  if (item.unpriced_event_count > 0) {
    return <span className="model-usage-table-status is-warning">{item.unpriced_event_count} 次未定价</span>;
  }
  return <span className="model-usage-table-status is-warning">待定价</span>;
}

function measurementStatus(item: ModelUsageBreakdownItem): ReactNode {
  const health = item.measurement_health;
  if (health.measurement_gap || health.uncertain_attempt_count > 0 || health.known_unmeasured_attempt_count > 0) {
    return <span className="model-usage-table-status is-warning">需核对</span>;
  }
  if (health.pending_attempt_count > 0) {
    return <span className="model-usage-table-status is-info">结算中</span>;
  }
  if (health.estimated_event_count > 0) {
    return <span className="model-usage-table-status is-info">含估算</span>;
  }
  return <span className="model-usage-table-status is-good">已核对</span>;
}

function columnsFor(groupBy: ModelUsageGroupBy): Column[] {
  const costColumn: Column = {
    key: 'cost',
    label: '已记录费用',
    className: 'is-numeric',
    render: (item) => <span className="model-usage-breakdown-cost">{costDisplay(item)}</span>,
  };

  switch (groupBy) {
    case 'capability':
      return [
        { key: 'capability', label: '能力', render: (item) => dimensionLabel(item, groupBy) },
        costColumn,
        { key: 'pricing', label: '定价状态', render: pricingStatus },
        { key: 'measurement', label: '计量状态', render: measurementStatus },
      ];
    case 'meter':
      return [
        { key: 'meter', label: '计量项', render: (item) => dimensionLabel(item, groupBy) },
        { key: 'usage', label: '总用量', render: usageValue },
        costColumn,
        { key: 'pricing', label: '定价状态', render: pricingStatus },
      ];
    case 'subject':
      return [
        { key: 'subject', label: '成员', render: (item) => dimensionLabel(item, groupBy) },
        costColumn,
        { key: 'pricing', label: '定价状态', render: pricingStatus },
        { key: 'measurement', label: '计量状态', render: measurementStatus },
      ];
    case 'provider_model':
    default:
      return [
        { key: 'provider', label: 'Provider', render: (item) => item.provider || '—' },
        { key: 'model', label: '模型', render: (item) => item.billing_model || item.label || '—' },
        { key: 'usage', label: '用量', render: usageValue },
        costColumn,
      ];
  }
}

export function ModelUsageBreakdownTable({ items, groupBy }: ModelUsageBreakdownTableProps) {
  const columns = columnsFor(groupBy);

  return (
    <table className={`model-usage-breakdown-table model-usage-breakdown-table--${groupBy}`} aria-label="费用细分明细">
      <thead>
        <tr>
          {columns.map((column) => <th key={column.key} scope="col" className={column.className}>{column.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={`${item.label}-${item.local_day ?? ''}`}>
            {columns.map((column, index) => {
              const value = column.render(item);
              const isDimension = index === 0;
              return isDimension ? (
                <th key={column.key} scope="row" data-label={column.label} className={column.className}>
                  <strong className="model-usage-provider-name">{value}</strong>
                  {item.local_day ? <small>{item.local_day}</small> : null}
                </th>
              ) : (
                <td key={column.key} data-label={column.label} className={column.className}>{value}</td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
