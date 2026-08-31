import { OptionChipGroup } from '../../components/ui-kit';
import {
  SCOPE_LABELS,
  type InventoryReconciliationScope,
} from './inventoryReconciliationModel';

const SCOPE_OPTIONS: InventoryReconciliationScope[] = [
  'suggested',
  'refrigerated',
  'frozen',
  'room_temperature',
  'all',
];

export function InventoryReconciliationScopeStep(props: {
  scope: InventoryReconciliationScope;
  checkedCount: number;
  totalCount: number;
  disabled?: boolean;
  onChange: (scope: InventoryReconciliationScope) => void;
}) {
  return (
    <section className="inventory-maintenance-section inventory-reconciliation-scope" aria-label="盘点范围">
      <div className="inventory-maintenance-section-head">
        <span>盘点范围</span>
        <em>{props.checkedCount}/{props.totalCount} 已核对</em>
      </div>
      <OptionChipGroup
        ariaLabel="盘点范围"
        value={props.scope}
        size="large"
        className="inventory-maintenance-chip-group"
        onChange={(value) => {
          if (!props.disabled) props.onChange(value as InventoryReconciliationScope);
        }}
        options={SCOPE_OPTIONS.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] }))}
      />
      <div className="inventory-reconciliation-progress" aria-live="polite">
        <progress value={props.checkedCount} max={Math.max(props.totalCount, 1)} aria-label={`盘点进度 ${props.checkedCount} / ${props.totalCount}`} />
        <span>进度 {props.checkedCount} / {props.totalCount}</span>
      </div>
    </section>
  );
}
