import {
  ModelUsagePolicyFooter,
  ModelUsagePolicySettings,
  type ModelUsagePolicySettingsProps,
} from './ModelUsagePolicySettings';
import { isModelUsageMissingPriceConfirmationRequired } from './modelUsageModel';

export interface ModelUsagePolicyMobilePageProps {
  onClose: () => void;
  settings: Omit<ModelUsagePolicySettingsProps, 'onSaved' | 'formId'>;
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export function ModelUsagePolicyMobilePage(props: ModelUsagePolicyMobilePageProps) {
  const formId = 'model-usage-policy-mobile-form';
  const requiresMissingPriceConfirmation = Boolean(
    props.settings.draft?.hard_limit_enabled
      && isModelUsageMissingPriceConfirmationRequired(props.settings.saveError),
  );
  return (
    <main className="model-usage-policy-mobile" aria-label="模型预算设置">
      <header className="model-usage-policy-mobile-header">
        <button type="button" aria-label="返回模型用量" onClick={props.onClose} disabled={props.settings.isSaving}><BackIcon /></button>
        <div>
          <p>家庭额度管理</p>
          <h1>模型预算设置</h1>
          <small>设置提醒、限制和各项能力额度</small>
        </div>
      </header>
      <ModelUsagePolicySettings {...props.settings} formId={formId} onSaved={props.onClose} />
      <footer className="model-usage-policy-mobile-footer">
        <ModelUsagePolicyFooter
          formId={formId}
          isSaving={props.settings.isSaving}
          hasDraft={Boolean(props.settings.draft)}
          requiresMissingPriceConfirmation={requiresMissingPriceConfirmation}
          hasMissingPriceConfirmation={Boolean(props.settings.draft?.confirm_missing_price_impact)}
          onClose={props.onClose}
        />
      </footer>
    </main>
  );
}
