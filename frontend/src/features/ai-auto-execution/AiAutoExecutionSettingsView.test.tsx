import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/aiApi';
import type { AiAutoExecutionSettings } from '../../api/types';
import { AiAutoExecutionSettingsView } from './AiAutoExecutionSettingsView';

vi.mock('../../api/aiApi', () => ({ aiApi: { getAiAutoExecutionSettings: vi.fn(), updateAiAutoExecutionPreference: vi.fn(), updateAiAutoExecutionFamilyPolicy: vi.fn() } }));

function settings(overrides: Partial<AiAutoExecutionSettings> = {}): AiAutoExecutionSettings {
  const rows = ['food.set_favorite', 'meal_log.rate_food', 'meal_log.simple_create', 'meal_plan.simple_create'] as const;
  return { catalog_version: '1', consent_notice: { version: 'notice-1', acknowledged: false }, member_preferences: rows.map((action_key) => ({ action_key, enabled: false, effective_enabled: false, row_version: 1, consent_notice_version: null, requires_reconsent: false })), family_policies: [{ action_key: 'shopping_list.safe_write', enabled: false, effective_enabled: false, row_version: 1, consent_notice_version: null, requires_reconsent: false }], limits: {}, server_now: '2026-08-24T00:00:00Z', ...overrides };
}
function renderSettings(isOwner = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AiAutoExecutionSettingsView familyId="family-1" isOwner={isOwner} /></QueryClientProvider>);
}

describe('AiAutoExecutionSettingsView', () => {
  it('shows family shopping policy as read-only for members', async () => {
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockResolvedValue(settings());
    renderSettings(false);
    expect(await screen.findByRole('switch', { name: '允许家庭成员在规则内自动维护购物清单' })).toBeDisabled();
    expect(screen.getByText('需要家庭 Owner 先开放此能力')).toBeVisible();
  });

  it('requires consent before first enable and keeps the switch unchanged until success', async () => {
    const user = userEvent.setup();
    let resolve!: (value: AiAutoExecutionSettings) => void;
    vi.mocked(aiApi.getAiAutoExecutionSettings).mockResolvedValue(settings());
    vi.mocked(aiApi.updateAiAutoExecutionPreference).mockReturnValue(new Promise((done) => { resolve = done; }));
    renderSettings(true);
    const control = await screen.findByRole('switch', { name: '收藏状态' });
    await user.click(control);
    expect(screen.getByRole('dialog', { name: '开启自动执行' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '同意并开启' }));
    expect(control).toHaveAttribute('aria-checked', 'false');
    resolve(settings({ consent_notice: { version: 'notice-1', acknowledged: true }, member_preferences: settings().member_preferences.map((row) => row.action_key === 'food.set_favorite' ? { ...row, enabled: true, effective_enabled: true } : row) }));
    expect(await screen.findByRole('switch', { name: '收藏状态', checked: true })).toHaveAttribute('aria-checked', 'true');
  });
});
