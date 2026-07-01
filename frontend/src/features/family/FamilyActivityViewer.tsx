import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type { ActivityLog, Member } from '../../api/types';
import { DashboardIcon } from '../../app/shellIcons';
import { ActionButton, EmptyState, WorkspaceModal } from '../../components/ui-kit';
import { formatDateTime } from '../../lib/ui';
import {
  DEFAULT_FAMILY_ACTIVITY_FILTERS,
  FAMILY_ACTIVITY_DATE_PRESETS,
  FAMILY_ACTIVITY_PAGE_SIZE,
  buildFamilyActivityActionOptions,
  buildFamilyActivityActorOptions,
  buildFamilyActivityEntityOptions,
  buildFamilyActivityQuery,
  familyActivityActionLabel,
  familyActivityEmptyDescription,
  familyActivityEntityLabel,
  groupFamilyActivitiesByDate,
  hasFamilyActivityFilters,
  type FamilyActivityFilters,
} from './FamilyActivityViewerModel';

type FamilyActivityViewerProps = {
  members: Member[];
  previewLogs: ActivityLog[];
};

function activityIconName(log: ActivityLog) {
  if (log.entity_type === 'ShoppingListItem') return 'cart';
  if (log.entity_type === 'Ingredient' || log.entity_type === 'InventoryItem') return 'leaf';
  if (log.entity_type === 'FoodPlanItem') return 'calendar';
  if (log.action === 'invite') return 'user-plus';
  if (log.action === 'create') return 'plus';
  return 'edit';
}

type CustomSelectOption = {
  value: string;
  label: string;
};

type CustomSelectProps = {
  labelPrefix: string;
  placeholder: string;
  value: string;
  options: CustomSelectOption[];
  onChange: (value: string) => void;
};

function CustomSelect({ labelPrefix, placeholder, value, options, onChange }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedOption = options.find((opt) => opt.value === value);
  const triggerLabel = selectedOption ? `${labelPrefix}: ${selectedOption.label}` : placeholder;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="custom-select-container" ref={containerRef} aria-expanded={isOpen}>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span>{triggerLabel}</span>
        <span className="custom-select-arrow" />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown">
          <button
            type="button"
            className={`custom-select-option ${value === '' ? 'selected' : ''}`}
            onClick={() => {
              onChange('');
              setIsOpen(false);
            }}
          >
            {placeholder.replace(`${labelPrefix}: `, '')}
          </button>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select-option ${value === option.value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FamilyActivityFiltersPanel(props: {
  filters: FamilyActivityFilters;
  logsForOptions: ActivityLog[];
  members: Member[];
  onChange: (filters: FamilyActivityFilters) => void;
  onReset: () => void;
}) {
  const actorOptions = useMemo(
    () => buildFamilyActivityActorOptions(props.logsForOptions, props.members),
    [props.logsForOptions, props.members]
  );
  const actionOptions = useMemo(() => buildFamilyActivityActionOptions(props.logsForOptions), [props.logsForOptions]);
  const entityOptions = useMemo(() => buildFamilyActivityEntityOptions(props.logsForOptions), [props.logsForOptions]);
  const updateFilters = (patch: Partial<FamilyActivityFilters>) => props.onChange({ ...props.filters, ...patch });

  return (
    <section className="family-activity-viewer-filters" aria-label="家庭活动筛选">
      <div className="family-activity-viewer-date-presets" role="tablist" aria-label="日期范围">
        {FAMILY_ACTIVITY_DATE_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={props.filters.datePreset === preset.value ? 'active' : ''}
            onClick={() => updateFilters({ datePreset: preset.value })}
          >
            {preset.label}
          </button>
        ))}
      </div>
      {props.filters.datePreset === 'custom' && (
        <div className="family-activity-viewer-custom-dates">
          <label>
            <span>开始日期</span>
            <input
              type="date"
              className="text-input"
              value={props.filters.startDate}
              onChange={(event) => updateFilters({ startDate: event.target.value })}
            />
          </label>
          <label>
            <span>结束日期</span>
            <input
              type="date"
              className="text-input"
              value={props.filters.endDate}
              onChange={(event) => updateFilters({ endDate: event.target.value })}
            />
          </label>
        </div>
      )}
      <div className="family-activity-viewer-select-grid">
        <CustomSelect
          labelPrefix="操作人"
          placeholder="操作人: 所有人"
          value={props.filters.actorId}
          options={actorOptions}
          onChange={(val) => updateFilters({ actorId: val })}
        />
        <CustomSelect
          labelPrefix="类型"
          placeholder="类型: 全部操作"
          value={props.filters.action}
          options={actionOptions}
          onChange={(val) => updateFilters({ action: val })}
        />
        <CustomSelect
          labelPrefix="对象"
          placeholder="对象: 全部模块"
          value={props.filters.entityType}
          options={entityOptions}
          onChange={(val) => updateFilters({ entityType: val })}
        />
        <button className="ghost-button" type="button" onClick={props.onReset}>
          重置筛选
        </button>
      </div>
    </section>
  );
}

function FamilyActivityTimeline(props: {
  logs: ActivityLog[];
  isFetching: boolean;
  hasFilters: boolean;
}) {
  const groups = useMemo(() => groupFamilyActivitiesByDate(props.logs), [props.logs]);

  if (props.logs.length === 0) {
    return (
      <div className="family-activity-viewer-empty">
        <EmptyState title={props.hasFilters ? '没有匹配记录' : '暂无家庭活动'} description={familyActivityEmptyDescription(props.hasFilters)} />
      </div>
    );
  }

  return (
    <div className="family-activity-viewer-timeline" aria-busy={props.isFetching}>
      {groups.map((group) => (
        <section key={group.key} className="family-activity-viewer-day">
          <h4>{group.label}</h4>
          <div className="family-activity-viewer-day-list">
            {group.items.map((log, index) => (
              <article key={log.id} className="family-activity-viewer-row">
                <span className={`family-activity-viewer-icon tone-${index % 4}`}>
                  <DashboardIcon name={activityIconName(log)} />
                </span>
                <div className="family-activity-viewer-row-copy">
                  <strong>{log.summary}</strong>
                  <p>
                    {log.actor_name ?? '家庭成员'} · {familyActivityActionLabel(log.action)} · {familyActivityEntityLabel(log.entity_type)}
                  </p>
                </div>
                <time dateTime={log.created_at}>{formatDateTime(log.created_at)}</time>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function useFamilyActivityViewerData(previewLogs: ActivityLog[]) {
  const [filters, setFilters] = useState<FamilyActivityFilters>(DEFAULT_FAMILY_ACTIVITY_FILTERS);
  const [limit, setLimit] = useState(FAMILY_ACTIVITY_PAGE_SIZE);
  const query = useMemo(() => buildFamilyActivityQuery(filters, limit), [filters, limit]);
  const hasFilters = hasFamilyActivityFilters(filters);
  const activityQuery = useQuery({
    queryKey: queryKeys.activityLogList(query),
    queryFn: () => api.getActivityLogs(query),
    placeholderData: keepPreviousData,
  });
  const logs = activityQuery.data ?? previewLogs;

  useEffect(() => {
    setLimit(FAMILY_ACTIVITY_PAGE_SIZE);
  }, [filters]);

  return {
    filters,
    setFilters,
    resetFilters: () => setFilters(DEFAULT_FAMILY_ACTIVITY_FILTERS),
    limit,
    setLimit,
    hasFilters,
    logs,
    isFetching: activityQuery.isFetching,
  };
}

export function FamilyActivityModal(props: FamilyActivityViewerProps & { onClose: () => void }) {
  const viewer = useFamilyActivityViewerData(props.previewLogs);
  const canLoadMore = viewer.logs.length >= viewer.limit;

  return (
    <div className="workspace-overlay-root family-settings-overlay-root">
      <div className="workspace-overlay-backdrop" onClick={props.onClose} />
      <WorkspaceModal
        className="family-activity-viewer-modal"
        eyebrow="家庭活动"
        title="操作记录"
        description={`共 ${viewer.logs.length} 条记录 · ${viewer.hasFilters ? '已应用筛选' : '按最新时间倒序展示'}`}
        closeAriaLabel="关闭家庭活动"
        onClose={props.onClose}
      >
        <FamilyActivityFiltersPanel
          filters={viewer.filters}
          logsForOptions={props.previewLogs}
          members={props.members}
          onChange={viewer.setFilters}
          onReset={viewer.resetFilters}
        />
        <FamilyActivityTimeline logs={viewer.logs} isFetching={viewer.isFetching} hasFilters={viewer.hasFilters} />
        {canLoadMore && (
          <div className="family-activity-viewer-actions">
            <ActionButton tone="secondary" type="button" onClick={() => viewer.setLimit((current) => current + FAMILY_ACTIVITY_PAGE_SIZE)}>
              加载更多
            </ActionButton>
          </div>
        )}
      </WorkspaceModal>
    </div>
  );
}

export function FamilyActivityMobilePage(props: FamilyActivityViewerProps & { onBack: () => void }) {
  const viewer = useFamilyActivityViewerData(props.previewLogs);
  const canLoadMore = viewer.logs.length >= viewer.limit;
  const pageRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    pageRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, []);

  return (
    <main ref={pageRef} className="family-activity-mobile-page" aria-label="手机家庭活动页">
      <header className="family-activity-mobile-head">
        <button type="button" onClick={props.onBack} aria-label="返回家庭页">
          <DashboardIcon name="chevron" />
        </button>
        <div>
          <h1>操作记录</h1>
          <p>共 {viewer.logs.length} 条记录 · 按最新时间倒序</p>
        </div>
      </header>
      <FamilyActivityFiltersPanel
        filters={viewer.filters}
        logsForOptions={props.previewLogs}
        members={props.members}
        onChange={viewer.setFilters}
        onReset={viewer.resetFilters}
      />
      <FamilyActivityTimeline logs={viewer.logs} isFetching={viewer.isFetching} hasFilters={viewer.hasFilters} />
      {canLoadMore && (
        <div className="family-activity-viewer-actions">
          <ActionButton tone="secondary" type="button" onClick={() => viewer.setLimit((current) => current + FAMILY_ACTIVITY_PAGE_SIZE)}>
            加载更多
          </ActionButton>
        </div>
      )}
    </main>
  );
}
