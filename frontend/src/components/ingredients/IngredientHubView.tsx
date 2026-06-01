import type { ReactNode } from 'react';
import { CompactMetric, PageHeader, WorkspaceSubnav } from '../ui-kit';
import type { IngredientWorkspacePanel } from './workspaceModel';

type IngredientHubViewProps = {
  mobileView: ReactNode;
  workspaceMetrics: Array<{ label: string; value: string; detail?: string }>;
  desktopActions: ReactNode;
  panelItems: Array<{ value: IngredientWorkspacePanel; label: string; icon: ReactNode }>;
  activePanel: IngredientWorkspacePanel;
  onPanelChange: (value: IngredientWorkspacePanel) => void;
  activePanelContent: ReactNode;
};

export function IngredientHubView(props: IngredientHubViewProps) {
  return (
    <>
      {props.mobileView}

      <div className="ingredients-desktop-view">
        <div className="ingredients-mobile-header">
          <PageHeader
            variant="workspace"
            eyebrow="食材档案"
            title="食材档案工作台"
            description="先找到食材，再直接补货、消费或加入采购；库存和采购页只做辅助处理。"
            meta={
              <div className="compact-metric-strip ingredients-header-metrics">
                {props.workspaceMetrics.map((item) => (
                  <CompactMetric key={item.label} label={item.label} value={item.value} detail={item.detail} />
                ))}
              </div>
            }
            actions={props.desktopActions}
          />
        </div>

        <section className="ingredients-panel ingredients-panel-shell card">
          <div className="ingredients-panel-subnav">
            <WorkspaceSubnav items={props.panelItems} value={props.activePanel} onChange={props.onPanelChange} />
          </div>
          <div className="ingredients-panel-body">{props.activePanelContent}</div>
        </section>
      </div>
    </>
  );
}
