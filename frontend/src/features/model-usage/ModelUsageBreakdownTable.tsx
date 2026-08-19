import type { ReactNode } from 'react';
import type {
  ModelUsageFamilyBreakdownItem,
  ModelUsageFamilyGroupBy,
  ModelUsagePersonalBreakdownItem,
  ModelUsagePersonalGroupBy,
} from '../../api/types';
import { MODEL_USAGE_CAPABILITY_OPTIONS, MODEL_USAGE_METER_OPTIONS } from './modelUsageOptions';
import { costDisplay, formatModelUsageQuantity } from './modelUsageModel';

type PersonalProps = {
  scope: 'me';
  groupBy: ModelUsagePersonalGroupBy;
  items: ModelUsagePersonalBreakdownItem[];
};

type FamilyProps = {
  scope: 'family';
  groupBy: ModelUsageFamilyGroupBy;
  items: ModelUsageFamilyBreakdownItem[];
};

type ModelUsageBreakdownTableProps = PersonalProps | FamilyProps;

type Column<Item> = {
  key: string;
  label: string;
  render: (item: Item) => ReactNode;
  className?: string;
};

function personalDimensionLabel(item: ModelUsagePersonalBreakdownItem, groupBy: ModelUsagePersonalGroupBy): string {
  if (groupBy === 'capability' && item.capability) return MODEL_USAGE_CAPABILITY_OPTIONS[item.capability].label;
  if (groupBy === 'meter' && item.meter) return MODEL_USAGE_METER_OPTIONS[item.meter].label;
  return item.label;
}

function usageValue(item: ModelUsagePersonalBreakdownItem): string {
  if (!item.meter || !item.meter_total) return '—';
  return `${formatModelUsageQuantity(item.meter_total)} ${MODEL_USAGE_METER_OPTIONS[item.meter].label}`;
}

function pricingStatus(item: ModelUsagePersonalBreakdownItem): ReactNode {
  if (item.pricing_complete) return <span className="model-usage-table-status is-good">已定价</span>;
  if (item.unpriced_event_count > 0) {
    return <span className="model-usage-table-status is-warning">{item.unpriced_event_count} 次未定价</span>;
  }
  return <span className="model-usage-table-status is-warning">待定价</span>;
}

function measurementStatus(item: ModelUsagePersonalBreakdownItem): ReactNode {
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

function costColumn<Item extends ModelUsagePersonalBreakdownItem>(): Column<Item> {
  return {
    key: 'cost',
    label: '已记录费用',
    className: 'is-numeric',
    render: (item) => <span className="model-usage-breakdown-cost">{costDisplay(item)}</span>,
  };
}

function personalColumnsFor(groupBy: ModelUsagePersonalGroupBy): Column<ModelUsagePersonalBreakdownItem>[] {
  switch (groupBy) {
    case 'meter':
      return [
        { key: 'meter', label: '计量项', render: (item) => personalDimensionLabel(item, groupBy) },
        { key: 'usage', label: '总用量', render: usageValue },
        costColumn(),
        { key: 'pricing', label: '定价状态', render: pricingStatus },
      ];
    case 'daily_capability_cost':
      return [
        { key: 'day', label: '日期与能力', render: (item) => item.local_day ? `${item.local_day} · ${personalDimensionLabel(item, 'capability')}` : item.label },
        costColumn(),
        { key: 'pricing', label: '定价状态', render: pricingStatus },
        { key: 'measurement', label: '计量状态', render: measurementStatus },
      ];
    case 'capability':
    default:
      return [
        { key: 'capability', label: '能力', render: (item) => personalDimensionLabel(item, groupBy) },
        costColumn(),
        { key: 'pricing', label: '定价状态', render: pricingStatus },
        { key: 'measurement', label: '计量状态', render: measurementStatus },
      ];
  }
}

function familyColumnsFor(groupBy: ModelUsageFamilyGroupBy): Column<ModelUsageFamilyBreakdownItem>[] {
  if (groupBy === 'provider_model') {
    return [
      { key: 'provider', label: 'Provider', render: (item) => item.provider || '—' },
      { key: 'model', label: '模型', render: (item) => item.billing_model || item.label || '—' },
      { key: 'usage', label: '用量', render: usageValue },
      costColumn(),
    ];
  }
  if (groupBy === 'subject') {
    return [
      { key: 'subject', label: '成员', render: (item) => item.label },
      costColumn(),
      { key: 'pricing', label: '定价状态', render: pricingStatus },
      { key: 'measurement', label: '计量状态', render: measurementStatus },
    ];
  }
  return personalColumnsFor(groupBy);
}

function BreakdownRows<Item extends ModelUsagePersonalBreakdownItem>(props: {
  items: Item[];
  columns: Column<Item>[];
}) {
  return (
    <tbody>
      {props.items.map((item) => (
        <tr key={`${item.label}-${item.local_day ?? ''}`}>
          {props.columns.map((column, index) => {
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
  );
}

function Table<Item extends ModelUsagePersonalBreakdownItem>(props: {
  className: string;
  columns: Column<Item>[];
  items: Item[];
}) {
  return (
    <table className={props.className} aria-label="费用细分明细">
      <thead>
        <tr>
          {props.columns.map((column) => <th key={column.key} scope="col" className={column.className}>{column.label}</th>)}
        </tr>
      </thead>
      <BreakdownRows items={props.items} columns={props.columns} />
    </table>
  );
}

export function ModelUsageBreakdownTable(props: ModelUsageBreakdownTableProps) {
  if (props.scope === 'me') {
    return (
      <Table
        className={`model-usage-breakdown-table model-usage-breakdown-table--${props.groupBy}`}
        columns={personalColumnsFor(props.groupBy)}
        items={props.items}
      />
    );
  }

  return (
    <Table
      className={`model-usage-breakdown-table model-usage-breakdown-table--${props.groupBy}`}
      columns={familyColumnsFor(props.groupBy)}
      items={props.items}
    />
  );
}
