import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImageInputValue } from '../api/types';
import { cleanupTestDomAndMocks, renderWithQuery } from '../test/renderWithQuery';
import { ActionButton, FormActions, ImageComposer, WorkspaceDrawer, WorkspaceModal } from './ui-kit';

const generatedImage: ImageInputValue = {
  generatedAsset: {
    id: 'media-ginger',
    name: 'ginger',
    url: '/ginger.jpg',
    source: 'ai',
    alt: '姜',
    created_at: '2026-06-28T00:00:00Z',
  },
};

afterEach(() => {
  cleanupTestDomAndMocks();
});

describe('ImageComposer', () => {
  it('renders action icons with explicit svg paint attributes', async () => {
    const rendered = await renderWithQuery(
      <ImageComposer
        title="食材图片"
        value={generatedImage}
        previewLabel="姜"
        onUpload={() => undefined}
        onGenerate={() => undefined}
        onReset={() => undefined}
        variant="workspace-inline"
      />,
    );

    const buttons = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('.image-composer-actions button'));
    const generateIcon = buttons[0]?.querySelector('svg');
    const resetIcon = buttons[1]?.querySelector('svg');

    expect(generateIcon?.getAttribute('fill')).toBe('currentColor');
    expect(resetIcon?.getAttribute('fill')).toBe('none');
    expect(resetIcon?.getAttribute('stroke')).toBe('currentColor');
    expect(resetIcon?.getAttribute('stroke-linecap')).toBe('round');

    rendered.unmount();
  });
});

describe('WorkspaceOverlayShell', () => {
  const repoRoot = resolve(__dirname, '..');

  it('renders a shared footer with optional information and actions outside the scroll body', async () => {
    const ModalWithFooter = WorkspaceModal as React.ComponentType<{
      title: string;
      description: string;
      onClose: () => void;
      footerInfo: React.ReactNode;
      footerActions: React.ReactNode;
      children: React.ReactNode;
    }>;
    const rendered = await renderWithQuery(
      <ModalWithFooter
        title="登记这批库存"
        description="保存后会写入库存。"
        onClose={() => undefined}
        footerInfo={<p>确认后将补入库存</p>}
        footerActions={<FormActions primaryLabel="补入库存" secondaryLabel="取消" />}
      >
        <section>表单内容</section>
      </ModalWithFooter>,
    );

    const body = rendered.container.querySelector('.workspace-overlay-body');
    const footer = rendered.container.querySelector('.workspace-overlay-footer');
    const footerInfo = rendered.container.querySelector('.workspace-overlay-footer-info');
    const footerActions = rendered.container.querySelector('.workspace-overlay-footer-actions');

    expect(body?.textContent).toContain('表单内容');
    expect(body?.textContent).not.toContain('补入库存');
    expect(footer?.textContent).toContain('确认后将补入库存');
    expect(footerInfo?.textContent).toContain('确认后将补入库存');
    expect(footerActions?.querySelector('button')?.textContent).toBe('取消');

    rendered.unmount();
  });

  it('uses the same footer slot for desktop drawers without changing the drawer kind', async () => {
    const DrawerWithFooter = WorkspaceDrawer as React.ComponentType<{
      title: string;
      onClose: () => void;
      footer: React.ReactNode;
      children: React.ReactNode;
    }>;
    const rendered = await renderWithQuery(
      <DrawerWithFooter
        title="食物详情"
        onClose={() => undefined}
        footer={<ActionButton type="button">加入菜单</ActionButton>}
      >
        <section>详情内容</section>
      </DrawerWithFooter>,
    );

    expect(rendered.container.querySelector('.workspace-drawer')).not.toBeNull();
    expect(rendered.container.querySelector('.workspace-overlay-footer')?.textContent).toContain('加入菜单');

    rendered.unmount();
  });

  it('keeps mobile drawer footer actions hierarchical and compact', () => {
    const foundationStyles = readFileSync(resolve(repoRoot, 'styles/00-foundation.css'), 'utf8');
    const uiKitStyles = readFileSync(resolve(repoRoot, 'styles/00-ui-kit.css'), 'utf8');
    const mobileStyles = readFileSync(resolve(repoRoot, 'styles/07-mobile.css'), 'utf8');
    const foodStyles = readFileSync(resolve(repoRoot, 'styles/06-food-workspace.css'), 'utf8');

    expect(foundationStyles).not.toContain('.ui-form-actions-row');
    expect(uiKitStyles).toContain('grid-template-columns: repeat(6, minmax(0, 1fr));');
    expect(uiKitStyles).toContain('.workspace-modal > .workspace-overlay-footer > .workspace-overlay-footer-actions:has(.ui-form-actions[data-primary-placement="before-extra"])');
    expect(uiKitStyles).toContain('@media (max-width: 900px)');
    expect(uiKitStyles).toContain('.ui-form-actions[data-primary-placement="before-extra"] .ui-form-actions-primary');
    expect(uiKitStyles).toContain('button:nth-of-type(2):nth-last-of-type(2)');
    expect(mobileStyles).toContain('grid-template-columns: repeat(6, minmax(0, 1fr)) !important;');
    expect(mobileStyles).toContain('.ui-form-actions[data-primary-placement="before-extra"] .ui-form-actions-primary');
    expect(mobileStyles).toContain('button:nth-of-type(3):nth-last-of-type(1)');
    expect(foodStyles).toContain('.food-detail-actions-mobile .ui-form-actions-row');
    expect(foodStyles).toContain('.food-detail-actions-mobile .ui-form-actions-primary');
    expect(foodStyles).toContain('flex: 0 1 220px;');
    expect(foodStyles).toContain('flex: 0 1 156px;');
  });
});
