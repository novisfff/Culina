import type { ReactNode } from 'react';
import { PageHeader, WorkspaceSubnav } from '../ui-kit';
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
        <PageHeader
          title="食材"
          description="管理家庭食材档案、库存状态以及采购清单。"
          actions={props.desktopActions}
        />

        <section className="ingredients-panel ingredients-panel-shell card">
          <div className="ingredients-panel-subnav-row">
            <WorkspaceSubnav items={props.panelItems} value={props.activePanel} onChange={props.onPanelChange} />
            
            <div className="ingredients-status-metrics">
              {props.workspaceMetrics.map((item) => {
                let icon = null;
                let badgeClass = "ingredients-status-metric-pill";
                
                if (item.label === '提醒') {
                  const alertCount = parseInt(item.value) || 0;
                  icon = (
                    <svg className="metric-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                    </svg>
                  );
                  badgeClass += alertCount > 0 ? " status-alert-active" : " status-alert-inactive";
                } else if (item.label === '待买') {
                  icon = (
                    <svg className="metric-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="9" cy="21" r="1"></circle>
                      <circle cx="20" cy="21" r="1"></circle>
                      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
                    </svg>
                  );
                  badgeClass += " status-shopping";
                } else if (item.label === '在库食材') {
                  icon = (
                    <svg className="metric-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                      <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                  );
                  badgeClass += " status-stocked";
                }
                
                return (
                  <div key={item.label} className={badgeClass} title={item.detail}>
                    {icon}
                    <span className="metric-pill-label">{item.label}</span>
                    <span className="metric-pill-value">{item.value}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="ingredients-panel-body">{props.activePanelContent}</div>
        </section>
      </div>
    </>
  );
}

