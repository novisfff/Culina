import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelAudioOptions } from './ModelAudioOptions';
import { createEmptyFamilyModelDraft } from './familyModelSettingsModel';

describe('ModelAudioOptions', () => {
  it('shows the adapter default voice for realtime audio', () => {
    const binding = createEmptyFamilyModelDraft().bindings.find((item) => item.capability === 'realtime_audio')!;
    const { rerender } = render(<ModelAudioOptions binding={binding} dashscope={false} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText('音色')).toHaveAttribute('placeholder', '默认 alloy');
    rerender(<ModelAudioOptions binding={binding} dashscope disabled={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText('音色')).toHaveAttribute('placeholder', '使用模型默认音色');
    expect(screen.getByText('实时语音请选择 Qwen-Omni；Qwen TTS 仅提供播报。')).toBeInTheDocument();
  });
  it.each([
    ['cosyvoice-v3-plus', '默认 longanyang'],
    ['cosyvoice-v2', '默认 longxiaochun'],
    ['qwen3-tts-flash', '默认 Cherry'],
  ])('shows the native TTS default for %s', (model, placeholder) => {
    const original = createEmptyFamilyModelDraft().bindings.find((item) => item.capability === 'tts')!;
    render(<ModelAudioOptions binding={{ ...original, requested_model: model }} dashscope disabled={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText('音色')).toHaveAttribute('placeholder', placeholder);
  });
  it.each(['qwen3-tts-flash', 'qwen3-tts-flash-2025-11-27', 'qwen-tts'])('shows fixed WAV for native %s while keeping historical settings intact', (model) => {
    const binding = createEmptyFamilyModelDraft().bindings.find((item) => item.capability === 'tts')!;
    const onChange = vi.fn();
    const { rerender } = render(<ModelAudioOptions binding={{ ...binding, requested_model: model }} dashscope disabled={false} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '音频格式' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '音频格式' })).toHaveTextContent('WAV');
    expect(screen.getByText('当前 Qwen 播报模型固定返回 WAV。')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    rerender(<ModelAudioOptions binding={{ ...binding, requested_model: model }} dashscope={false} disabled={false} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '音频格式' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '音频格式' })).toHaveTextContent('MP3');
  });
  it('only offers native hotwords for DashScope and preserves incomplete edits locally', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const binding = createEmptyFamilyModelDraft().bindings.find((item) => item.capability === 'stt')!;
    const { rerender } = render(<ModelAudioOptions binding={binding} dashscope={false} disabled={false} onChange={onChange} />);
    expect(screen.queryByLabelText(/识别热词/)).not.toBeInTheDocument();
    rerender(<ModelAudioOptions binding={binding} dashscope disabled={false} onChange={onChange} />);
    const input = screen.getByLabelText(/识别热词/);
    await user.type(input, '藜麦、藜麦、鹰嘴豆');
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith({ hotwords: ['藜麦', '鹰嘴豆'] });
    onChange.mockClear();
    await user.clear(input);
    await user.type(input, 'a'.repeat(81));
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
