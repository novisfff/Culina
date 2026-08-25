import { useEffect, useState } from 'react';
import type { AiAutoExecutionActionKey, AiAutoExecutionSettingRow } from '../../api/types';
import { StateBlock, StatusBadge } from '../../components/ui-kit';
import { AI_AUTO_EXECUTION_ACTIONS, findAiAutoExecutionAction } from './aiAutoExecutionModel';
import { AiAutoExecutionConsentDialog } from './AiAutoExecutionConsentDialog';
import { AiAutoExecutionSwitchRow } from './AiAutoExecutionSwitchRow';
import { useAiAutoExecutionSettings } from './useAiAutoExecutionSettings';

type PendingConsent = { familyId: string; scope: 'member' | 'family'; row: AiAutoExecutionSettingRow } | null;

export function AiAutoExecutionSettingsView(props: { familyId: string; isOwner: boolean }) {
  const state = useAiAutoExecutionSettings(props.familyId);
  const [consent, setConsent] = useState<PendingConsent>(null);
  useEffect(() => setConsent(null), [props.familyId]);
  if (state.isLoading) return <StateBlock status="loading" title="正在加载自动执行设置" description="请稍候。" />;
  if (state.isError || !state.settings) return <StateBlock status="error" title="自动执行设置加载失败" description="请检查网络后重试。" actionLabel="重试" onAction={state.retry} />;

  const memberRows = new Map(state.settings.member_preferences.map((row) => [row.action_key, row]));
  const shopping = state.settings.family_policies.find((row) => row.action_key === 'shopping_list.safe_write');
  const runToggle = (scope: 'member' | 'family', row: AiAutoExecutionSettingRow) => {
    if (row.requires_reconsent || (!row.enabled && !state.settings!.consent_notice.acknowledged)) {
      setConsent({ familyId: props.familyId, scope, row });
      return;
    }
    void state.update(scope, row, !row.enabled);
  };
  const rowFor = (key: AiAutoExecutionActionKey) => memberRows.get(key);

  return (
    <section className="ai-auto-execution-settings" aria-label="AI 自动执行设置">
      <header className="ai-auto-execution-header">
        <div><h1>AI 自动执行</h1><p>只在你预先开启的低风险范围内直接完成明确指令。</p></div>
        <StatusBadge tone={state.settings.consent_notice.acknowledged ? 'success' : 'warning'}>{state.settings.consent_notice.acknowledged ? '已确认规则' : '需要确认规则'}</StatusBadge>
      </header>
      <section className="ai-auto-execution-section" aria-labelledby="ai-auto-execution-member-heading">
        <div className="ai-auto-execution-section-head"><h2 id="ai-auto-execution-member-heading">我的自动执行</h2><p>每项能力可随时关闭。</p></div>
        <div className="ai-auto-execution-list">
          {AI_AUTO_EXECUTION_ACTIONS.map((action) => {
            const row = rowFor(action.key);
            if (!row) return null;
            const shoppingPolicyOff = action.key === 'shopping_list.safe_write' && !shopping?.effective_enabled;
            const failure = state.failureFor('member', row.action_key);
            return <AiAutoExecutionSwitchRow key={action.key} action={action} enabled={row.enabled} effectiveEnabled={row.effective_enabled} disabled={shoppingPolicyOff} pending={state.isPending('member', row.action_key)} requiresReconsent={row.requires_reconsent} readOnlyMessage={shoppingPolicyOff ? '需要家庭 Owner 先开放此能力' : undefined} errorMessage={failure?.message} onRetry={failure && !failure.isConflict ? () => void state.update('member', row, failure.payload.enabled, failure.payload) : undefined} onToggle={() => runToggle('member', row)} />;
          })}
        </div>
      </section>
      {shopping && (() => {
        const action = findAiAutoExecutionAction(shopping.action_key)!;
        const memberReadOnly = !props.isOwner;
        const readOnlyMessage = memberReadOnly ? (shopping.effective_enabled ? '仅家庭 Owner 可修改' : '家庭 Owner 尚未开放此能力') : undefined;
        const failure = state.failureFor('family', shopping.action_key);
        return <section className="ai-auto-execution-section" aria-labelledby="ai-auto-execution-family-heading">
          <div className="ai-auto-execution-section-head"><h2 id="ai-auto-execution-family-heading">家庭共享操作</h2><p>仅影响家庭成员的购物清单安全操作。</p></div>
          <div className="ai-auto-execution-list"><AiAutoExecutionSwitchRow action={action} ariaLabel="允许家庭成员在规则内自动维护购物清单" enabled={shopping.enabled} effectiveEnabled={shopping.effective_enabled} disabled={memberReadOnly} pending={state.isPending('family', shopping.action_key)} requiresReconsent={shopping.requires_reconsent} readOnlyMessage={readOnlyMessage} errorMessage={failure?.message} onRetry={failure && !failure.isConflict ? () => void state.update('family', shopping, failure.payload.enabled, failure.payload) : undefined} onToggle={() => runToggle('family', shopping)} /></div>
        </section>;
      })()}
      <AiAutoExecutionConsentDialog open={Boolean(consent && consent.familyId === props.familyId)} isSubmitting={Boolean(consent && state.isPending(consent.scope, consent.row.action_key))} onCancel={() => setConsent(null)} onConfirm={() => { if (consent?.familyId === props.familyId) { void state.update(consent.scope, consent.row, true); setConsent(null); } }} />
    </section>
  );
}
