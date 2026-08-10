import { WorkspaceDrawer, WorkspaceOverlayFrame } from '../../components/ui-kit';
import {
  ModelUsagePolicyFooter,
  ModelUsagePolicySettings,
  type ModelUsagePolicySettingsProps,
} from './ModelUsagePolicySettings';
import { isModelUsageMissingPriceConfirmationRequired } from './modelUsageModel';

export interface ModelUsagePolicyDesktopDrawerProps {
  onClose: () => void;
  settings: Omit<ModelUsagePolicySettingsProps, 'onSaved' | 'formId'>;
}

export function ModelUsagePolicyDesktopDrawer(props: ModelUsagePolicyDesktopDrawerProps) {
  const formId = 'model-usage-policy-desktop-form';
  const requiresMissingPriceConfirmation = Boolean(
    props.settings.draft?.hard_limit_enabled
      && isModelUsageMissingPriceConfirmationRequired(props.settings.saveError),
  );
  return (
    <WorkspaceOverlayFrame onClose={props.onClose} busy={props.settings.isSaving}>
      <WorkspaceDrawer
        title="模型预算设置"
        description="设置当前家庭的预算提醒、硬限制和能力护栏。"
        onClose={props.onClose}
        busy={props.settings.isSaving}
        footerActions={(
          <ModelUsagePolicyFooter
            formId={formId}
            isSaving={props.settings.isSaving}
            hasDraft={Boolean(props.settings.draft)}
            requiresMissingPriceConfirmation={requiresMissingPriceConfirmation}
            hasMissingPriceConfirmation={Boolean(props.settings.draft?.confirm_missing_price_impact)}
            onClose={props.onClose}
          />
        )}
      >
        <ModelUsagePolicySettings {...props.settings} formId={formId} onSaved={props.onClose} />
      </WorkspaceDrawer>
    </WorkspaceOverlayFrame>
  );
}
