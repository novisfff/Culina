import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { UserRole, ModelUsageRequestLogPage as RequestPage } from '../../api/types';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { DashboardIcon } from '../../app/shellIcons';
import { DateRangePickerField, DropdownSelect, StateBlock } from '../../components/ui-kit';
import { businessDateKey } from '../../lib/date';
import { MODEL_USAGE_CAPABILITY_OPTIONS } from './modelUsageOptions';
import { ModelUsageRequestLogs } from './ModelUsageRequestLogs';
import { currentModelUsagePeriod } from './useModelUsageQueries';

type Props = { familyId: string; role: UserRole; initialPeriod?: string | null; isPhoneViewport: boolean; onBack: () => void };
type Filters = { dateFrom: string; dateTo: string; capability: string; provider: string; status: string; model: string };
const capabilityOptions = [{ value: '', label: '全部能力' }, ...Object.entries(MODEL_USAGE_CAPABILITY_OPTIONS).map(([value, option]) => ({ value, label: option.label }))];
const statusOptions = [{ value: '', label: '全部状态' }, { value: 'priced', label: '已定价' }, { value: 'estimated', label: '含估算' }, { value: 'unpriced', label: '未定价' }, { value: 'needs_review', label: '需核对' }];

function periodEnd(value: string): string {
  const [year, month] = value.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${value}-${String(lastDay).padStart(2, '0')}`;
}

function defaultFilters(initialPeriod?: string | null): Filters {
  const today = businessDateKey(new Date(), 'Asia/Shanghai');
  const currentPeriod = currentModelUsagePeriod();
  const period = initialPeriod ?? currentPeriod;
  return {
    dateFrom: `${period}-01`,
    dateTo: period === currentPeriod ? today : periodEnd(period),
    capability: '',
    provider: '',
    status: '',
    model: '',
  };
}

export function ModelUsageRequestLogsPage(props: Props) {
  const isOwner = props.role === 'Owner';
  const [scope, setScope] = useState<'family' | 'me'>(isOwner ? 'family' : 'me');
  const initialFilters = useMemo(() => defaultFilters(props.initialPeriod), [props.initialPeriod]);
  const [draftFilters, setDraftFilters] = useState<Filters>(() => defaultFilters(props.initialPeriod));
  const [filters, setFilters] = useState<Filters>(() => defaultFilters(props.initialPeriod));
  const [page, setPage] = useState(0);
  const limit = 20;
  const query = useQuery<RequestPage>({
    queryKey: [...queryKeys.modelUsageRequests(props.familyId, scope, filters.dateFrom, filters.dateTo), filters.capability, filters.provider, filters.status, filters.model, page],
    queryFn: () => (scope === 'family' ? api.getFamilyModelUsageRequests : api.getMyModelUsageRequests)({
      limit,
      offset: page * limit,
      date_from: filters.dateFrom,
      date_to: filters.dateTo,
      capability: filters.capability,
      provider: filters.provider,
      status: filters.status,
      model: filters.model,
    }),
    enabled: Boolean(props.familyId) && Boolean(filters.dateFrom) && Boolean(filters.dateTo),
  });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / limit));
  const pageData = useMemo(() => query.data ?? null, [query.data]);
  const patchFilter = (patch: Partial<Filters>) => setDraftFilters((current) => ({ ...current, ...patch }));
  const applyFilters = () => { setFilters(draftFilters); setPage(0); };
  const resetFilters = () => { setDraftFilters(initialFilters); setFilters(initialFilters); setPage(0); };

  if (query.isError) return <main className="model-usage-workspace model-usage-request-logs-page"><StateBlock status="error" title="请求日志加载失败" description="请稍后重试。" actionLabel="重新加载" onAction={() => { void query.refetch(); }} /></main>;
  return (
    <main className={`model-usage-workspace model-usage-request-logs-page ${props.isPhoneViewport ? 'is-mobile' : ''}`}>
      <header className="model-usage-request-page-header">
        <button type="button" className="model-usage-request-page-back" aria-label="返回模型用量" onClick={props.onBack}>
          <DashboardIcon name="arrow-left" />
        </button>
        <div className="model-usage-request-page-copy">
          <p>模型用量明细</p>
          <h1>请求日志</h1>
          <small>按日期、模型和核对状态查看每一次请求。</small>
        </div>
      </header>
      <section className="model-usage-request-filters" aria-label="请求日志筛选">
        <div className="model-usage-request-filters-head">
          <div>
            <h2>筛选请求</h2>
            <p>按时间和模型条件定位记录</p>
          </div>
          {isOwner ? <div className="model-usage-scope-toggle" aria-label="日志范围"><button type="button" aria-pressed={scope === 'family'} onClick={() => { setScope('family'); setPage(0); }}>家庭</button><button type="button" aria-pressed={scope === 'me'} onClick={() => { setScope('me'); setPage(0); }}>我的</button></div> : null}
        </div>
        <div className="model-usage-request-filters-grid">
          <div className="model-usage-request-filter-field model-usage-request-date-range">
            <span>请求日期</span>
            <DateRangePickerField ariaLabel="请求日期" startValue={draftFilters.dateFrom} endValue={draftFilters.dateTo} max={businessDateKey(new Date(), 'Asia/Shanghai')} onChange={(value) => patchFilter({ dateFrom: value.start, dateTo: value.end })} />
          </div>
          <div className="model-usage-request-filter-field model-usage-request-filter-dropdown model-usage-request-capability-filter">
            <span>模型能力</span>
            <DropdownSelect ariaLabel="模型能力" value={draftFilters.capability} options={capabilityOptions} placeholder="全部能力" onChange={(value) => patchFilter({ capability: value ?? '' })} />
          </div>
          <div className="model-usage-request-filter-field model-usage-request-filter-dropdown">
            <span>核对状态</span>
            <DropdownSelect ariaLabel="核对状态" value={draftFilters.status} options={statusOptions} placeholder="全部状态" onChange={(value) => patchFilter({ status: value ?? '' })} />
          </div>
          <label className="model-usage-request-provider-filter"><span>Provider</span><input value={draftFilters.provider} placeholder="例如 openai" onChange={(event) => patchFilter({ provider: event.target.value })} /></label>
          <label className="model-usage-request-model-filter"><span>模型</span><input value={draftFilters.model} placeholder="搜索模型名称" onChange={(event) => patchFilter({ model: event.target.value })} /></label>
        </div>
        <div className="model-usage-request-filter-actions"><button type="button" onClick={resetFilters}>清除条件</button><button type="button" onClick={applyFilters}>查询记录</button></div>
      </section>
      {query.isLoading ? <p role="status">正在加载请求日志。</p> : <ModelUsageRequestLogs page={pageData} />}
      {!query.isLoading ? <nav className="model-usage-request-pagination" aria-label="请求日志分页"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page + 1} / {totalPages} 页</span><button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button></nav> : null}
    </main>
  );
}
