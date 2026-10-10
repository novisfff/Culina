import { useEffect, useState } from 'react';
import type { FamilyModelBindingDraft } from '../../api/types/modelUsage';
import { DropdownSelect } from '../../components/ui-kit';

function voicePlaceholder(binding: FamilyModelBindingDraft, dashscope: boolean): string {
  if (!dashscope) return '默认 alloy';
  if (binding.capability === 'realtime_audio') return '使用模型默认音色';
  const model = binding.requested_model.trim().toLowerCase();
  if (model.startsWith('cosyvoice-')) {
    return model.startsWith('cosyvoice-v3') ? '默认 longanyang' : '默认 longxiaochun';
  }
  return '默认 Cherry';
}

export function ModelAudioOptions({ binding, dashscope, disabled, onChange, onValidityChange }: {
  binding: FamilyModelBindingDraft;
  dashscope: boolean;
  disabled: boolean;
  onChange: (patch: Partial<FamilyModelBindingDraft>) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [hotwords, setHotwords] = useState(binding.capability === 'stt' ? binding.hotwords.join('、') : '');
  const savedWords = binding.capability === 'stt' ? binding.hotwords.join('、') : '';
  useEffect(() => { setHotwords(savedWords); }, [savedWords]);
  const words = [...new Set(hotwords.split(/[,，、\n]/).map((word) => word.trim()).filter(Boolean))];
  const validWords = words.length <= 32 && words.every((word) => word.length <= 80);
  const model = binding.requested_model.trim().toLowerCase();
  const fixedWav = dashscope && binding.capability === 'tts'
    && (model.startsWith('qwen-tts') || model.startsWith('qwen3-tts')) && !model.includes('-realtime');
  return <>
    {binding.capability === 'stt' || binding.capability === 'realtime_audio' ? <div className="family-model-settings-field">
      <span>识别语言</span>
      <DropdownSelect ariaLabel="识别语言选项" triggerAriaLabel="识别语言" placeholder="自动识别" className="family-model-settings-dropdown"
        value={binding.language_hint || ''} disabled={disabled}
        options={[{ value: '', label: '自动识别' }, { value: 'zh', label: '中文' }, { value: 'en', label: '英语' }]}
        onChange={(value) => onChange({ language_hint: value || null })} />
    </div> : null}
    {binding.capability === 'tts' || binding.capability === 'realtime_audio' ? <label className="family-model-settings-field">
      <span>音色</span>
      <input aria-label="音色" value={binding.voice || ''} maxLength={80} disabled={disabled}
        placeholder={voicePlaceholder(binding, dashscope)}
        onChange={(event) => onChange({ voice: event.target.value.trim() || null })} />
      <small>填写当前模型支持的音色名称；留空使用默认音色。</small>
      {dashscope && binding.capability === 'realtime_audio' ? <small>实时语音请选择 Qwen-Omni；Qwen TTS 仅提供播报。</small> : null}
    </label> : null}
    {binding.capability === 'stt' && dashscope ? <label className="family-model-settings-field">
      <span>识别热词</span>
      <textarea value={hotwords} disabled={disabled} aria-invalid={!validWords}
        placeholder="如：藜麦、鹰嘴豆" onChange={(event) => {
          const next = event.target.value;
          setHotwords(next);
          const nextWords = [...new Set(next.split(/[,，、\n]/).map((word) => word.trim()).filter(Boolean))];
          onValidityChange?.(nextWords.length <= 32 && nextWords.every((word) => word.length <= 80));
        }}
        onBlur={() => { if (validWords) onChange({ hotwords: words }); }} />
      <small>{validWords ? '用逗号或顿号分隔，最多 32 个；模型需支持热词。' : '最多 32 个热词，每个不超过 80 字；当前修改尚未保存。'}</small>
    </label> : null}
    {binding.capability === 'tts' ? <div className="family-model-settings-field">
      <span>音频格式</span>
      <DropdownSelect ariaLabel="音频格式选项" triggerAriaLabel="音频格式" placeholder="选择音频格式" className="family-model-settings-dropdown"
        value={fixedWav ? 'wav' : binding.output_format} disabled={disabled || fixedWav}
        options={(fixedWav ? ['wav'] : [...new Set([...(dashscope ? ['mp3', 'wav'] : ['mp3', 'wav', 'flac']), binding.output_format])]).map((value) => ({ value, label: value.toUpperCase() }))}
        onChange={(value) => onChange({ output_format: value as 'mp3' | 'wav' | 'ogg' | 'flac' | 'mp4' })} />
      <small>{fixedWav ? '当前 Qwen 播报模型固定返回 WAV。' : '默认 MP3。其他格式需当前模型支持。'}</small>
    </div> : null}
  </>;
}
