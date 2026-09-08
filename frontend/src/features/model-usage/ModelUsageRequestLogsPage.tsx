import { useState } from 'react';
import type { ModelUsageScope, UserRole } from '../../api/types/modelUsage';
import { DashboardIcon } from '../../app/shellIcons';
import { DateRangePickerField, DropdownSelect, StateBlock } from '../../components/ui-kit';
import { currentModelUsagePeriod } from './useModelUsageQueries';
import type { ModelUsageNavigationContext } from './modelUsageWorkspaceViewModel';
import { businessDateKey } from '../../lib/date';
import { MODEL_USAGE_CAPABILITY_OPTIONS } from './modelUsageOptions';
import { ModelUsageRequestLogs } from './ModelUsageRequestLogs';
import type { ModelUsageRequestLogFilters } from './modelUsageRequestLogsModel';
import { useModelUsageRequestLogs } from './useModelUsageRequestLogs';

type Props = {
  familyId: string;
  role: UserRole;
  initialPeriod?: string | null;
  initialScope?: ModelUsageScope;
  isPhoneViewport: boolean;
  onBack: (context: ModelUsageNavigationContext) => void;
};

const capabilityOptions = [
  { value: '', label: '全部功能' },
  ...Object.entries(MODEL_USAGE_CAPABILITY_OPTIONS).map(([value, option]) => ({ value, label: option.label })),
];
const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'priced', label: '已定价' },
  { value: 'estimated', label: '含估算' },
  { value: 'unpriced', label: '未定价' },
  { value: 'needs_review', label: '需要核对' },
];

export function ModelUsageRequestLogsPage(props: Props) {
  const logs = useModelUsageRequestLogs({
    familyId: props.familyId,
    role: props.role,
    initialPeriod: props.initialPeriod,
    initialScope: props.initialScope,
  });
  const { draftFilters, filters, requestQuery } = logs;
  const isFamilyScope = logs.scope === 'family';

  const [showAdvanced, setShowAdvanced] = useState(!props.isPhoneViewport);
  const filtersDirty = ['dateFrom', 'dateTo', 'capability', 'status', 'provider', 'model'].some(
    (key) => draftFilters[key as keyof ModelUsageRequestLogFilters] !== filters[key as keyof ModelUsageRequestLogFilters],
  );

  return (
    <main className={`model-usage-workspace model-usage-request-logs-page ${props.isPhoneViewport ? 'is-mobile' : ''}`}>
      <header className="model-usage-request-page-header">
        <button type="button" className="model-usage-request-page-back" aria-label="返回模型用量" onClick={() => props.onBack({ period: props.initialPeriod ?? currentModelUsagePeriod(), scope: logs.scope })}>
          <DashboardIcon name="arrow-left" />
        </button>
        <div className="model-usage-request-page-copy">
          <p>模型用量明细</p>
          <h1>请求记录</h1>
          <small>{isFamilyScope ? '按日期、模型和核对状态查看家庭请求。' : '按日期、功能和核对状态查看我的请求。'}</small>
        </div>
      </header>
      <section className={`model-usage-request-filters ${showAdvanced ? 'is-expanded' : ''}`} aria-label="请求记录筛选">
        <div className="model-usage-request-filters-head">
          <div>
            <h2>筛选请求</h2>
            <p>{isFamilyScope ? '按时间和模型条件定位记录' : '按时间和功能条件定位记录'}</p>
          </div>
          {logs.isOwner ? (
            <div className="model-usage-scope-toggle" aria-label="记录范围">
              <button type="button" aria-pressed={logs.scope === 'family'} onClick={() => logs.actions.setScope('family')}>家庭</button>
              <button type="button" aria-pressed={logs.scope === 'me'} onClick={() => logs.actions.setScope('me')}>我的</button>
            </div>
          ) : null}
        </div>
        <div className="model-usage-request-filter-summary">
          <span>已应用：{filters.dateFrom} 至 {filters.dateTo} · {capabilityOptions.find((option) => option.value === filters.capability)?.label} · {statusOptions.find((option) => option.value === filters.status)?.label}
            {filters.provider ? ` · 服务：${filters.provider}` : ''}{filters.model ? ` · 模型：${filters.model}` : ''}
          </span>
          <button type="button" className="tertiary-button" aria-expanded={showAdvanced} aria-controls="model-usage-advanced-filters"
            onClick={() => setShowAdvanced((current) => !current)}>{showAdvanced ? '收起筛选' : '更多筛选'}</button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); logs.actions.applyFilters(); }}>
        <div className="model-usage-request-filters-grid">
          <div className="model-usage-request-filter-field model-usage-request-date-range">
            <span>日期范围</span>
            <DateRangePickerField
              ariaLabel="日期范围"
              startValue={draftFilters.dateFrom}
              endValue={draftFilters.dateTo}
              max={businessDateKey(new Date(), 'Asia/Shanghai')}
              onChange={(value) => logs.actions.patchDraftFilters({ dateFrom: value.start, dateTo: value.end })}
            />
          </div>
          <div id="model-usage-advanced-filters" className="model-usage-request-advanced-fields" hidden={!showAdvanced}>
          <div className="model-usage-request-filter-field model-usage-request-filter-dropdown model-usage-request-capability-filter">
            <span>模型功能</span>
            <DropdownSelect
              ariaLabel="模型功能"
              value={draftFilters.capability}
              options={capabilityOptions}
              placeholder="全部功能"
              onChange={(value) => logs.actions.patchDraftFilters({
                capability: (value ?? '') as ModelUsageRequestLogFilters['capability'],
              })}
            />
          </div>
          <div className="model-usage-request-filter-field model-usage-request-filter-dropdown">
            <span>核对状态</span>
            <DropdownSelect
              ariaLabel="核对状态"
              value={draftFilters.status}
              options={statusOptions}
              placeholder="全部状态"
              onChange={(value) => logs.actions.patchDraftFilters({
                status: (value ?? '') as ModelUsageRequestLogFilters['status'],
              })}
            />
          </div>
          {isFamilyScope ? (
            <>
              <label className="model-usage-request-provider-filter">
                <span>模型服务</span>
                <input
                  value={draftFilters.provider}
                  placeholder="例如 openai"
                  onChange={(event) => logs.actions.patchDraftFilters({ provider: event.target.value })}
                />
              </label>
              <label className="model-usage-request-model-filter">
                <span>模型</span>
                <input
                  value={draftFilters.model}
                  placeholder="搜索模型名称"
                  onChange={(event) => logs.actions.patchDraftFilters({ model: event.target.value })}
                />
              </label>
            </>
          ) : null}
        </div>
        </div>
        <div className="model-usage-request-filter-actions">
          <span role="status">{filtersDirty ? '筛选已修改，点击“查看记录”应用。' : requestQuery.isFetching ? '正在更新记录…' : ''}</span>
          <button type="button" onClick={logs.actions.resetFilters}>清除筛选</button>
          <button type="submit" disabled={requestQuery.isFetching && !filtersDirty}>查看记录</button>
        </div>
        </form>
      </section>
      {requestQuery.isError ? <StateBlock status="error" title={logs.page ? '请求记录刷新失败' : '请求记录加载失败'}
        description={logs.page ? '保留上次加载的结果，可重新加载。' : '筛选条件已保留，请重新加载或返回用量总览。'}
        actionLabel="重新加载" onAction={() => { void requestQuery.refetch(); }} /> : null}
      {requestQuery.isLoading && !logs.page ? <p role="status">正在加载请求记录。</p> : logs.page ? <ModelUsageRequestLogs page={logs.page} /> : null}
      {logs.page ? (
        <nav className="model-usage-request-pagination" aria-label="请求记录分页">
          <button type="button" disabled={requestQuery.isFetching || filters.page === 0} onClick={() => logs.actions.setPage(filters.page - 1)}>上一页</button>
          <span>第 {filters.page + 1} / {logs.totalPages} 页</span>
          <button type="button" disabled={requestQuery.isFetching || filters.page + 1 >= logs.totalPages} onClick={() => logs.actions.setPage(filters.page + 1)}>下一页</button>
        </nav>
      ) : null}
    </main>
  );
}
