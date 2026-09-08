import type { ModelUsageBreakdownItem, ModelUsageGroupBy } from '../../api/types/modelUsage';
import { DropdownSelect } from '../../components/ui-kit';
import { modelUsageGroupOptions } from './modelUsageOptions';
import { ModelUsageBreakdownTable } from './ModelUsageBreakdownTable';
import type { ModelUsageWorkspaceViewProps } from './modelUsageWorkspaceViewModel';

export function ModelUsageBreakdown(props: Pick<ModelUsageWorkspaceViewProps, 'groupBy' | 'scope' | 'isOwner' | 'actions' | 'isBreakdownLoading'> & {
  items: ModelUsageBreakdownItem[] | null;
}) {
  const options = modelUsageGroupOptions(props.scope);
  return (
    <section className="model-usage-breakdown model-usage-breakdown-ledger" aria-labelledby="model-usage-breakdown-heading">
        <div className="model-usage-section-head model-usage-breakdown-head">
          <div>
            <h2 id="model-usage-breakdown-heading">费用明细</h2>
            <p>选择一种方式查看本统计周期的费用和用量明细。</p>
          </div>
          <div className="model-usage-group-field">
            <span className="model-usage-group-label">查看方式</span>
            <div className="model-usage-group-select-wrapper">
              <DropdownSelect
                ariaLabel="查看方式选项"
                triggerAriaLabel="查看方式"
                placeholder="选择查看方式"
                value={props.groupBy}
                options={options}
                onChange={(value) => {
                  if (value) props.actions.setGroupBy(value as ModelUsageGroupBy);
                }}
              />

            </div>
          </div>
        </div>
      {props.isBreakdownLoading && !props.items ? (
        <div className="model-usage-breakdown-loading" role="status">正在加载费用明细。</div>
      ) : props.items?.length ? (
        props.scope === 'family' ? (
          <ModelUsageBreakdownTable
            scope="family"
            items={props.items as import('../../api/types').ModelUsageFamilyBreakdownItem[]}
            groupBy={props.groupBy as import('../../api/types').ModelUsageFamilyGroupBy}
          />
        ) : (
          <ModelUsageBreakdownTable
            scope="me"
            items={props.items as import('../../api/types').ModelUsagePersonalBreakdownItem[]}
            groupBy={props.groupBy as import('../../api/types').ModelUsagePersonalGroupBy}
          />
        )
      ) : (
        <p className="model-usage-breakdown-empty">这个统计周期还没有可展示的费用明细。</p>
      )}
    </section>
  );
}
