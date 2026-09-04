import type {
  FamilyModelAdapterKind,
  FamilyModelCapability,
  FamilyModelProviderProfile,
  ModelUsageMeter,
} from '../../api/types/modelUsage';

export const FAMILY_MODEL_CAPABILITY_OPTIONS: Record<FamilyModelCapability, {
  label: string;
  description: string;
}> = {
  llm: { label: '对话与图片理解', description: '用于家庭助手、菜谱草稿和图片理解。' },
  image_generation: { label: '图片生成', description: '用于菜谱、食物和家庭图片。' },
  stt: { label: '语音识别', description: '把做菜时的语音转成文字。' },
  tts: { label: '语音播报', description: '朗读步骤和助手回复。' },
  realtime_audio: { label: '实时语音', description: '支持连续的语音交互。' },
  embedding: { label: '智能搜索', description: '让搜索理解家庭里的食材、菜谱等内容。' },
  rerank: { label: '搜索排序', description: '调整家庭搜索结果的先后顺序。' },
};

export const FAMILY_MODEL_ADAPTER_OPTIONS: ReadonlyArray<{
  value: FamilyModelAdapterKind;
  label: string;
  description: string;
}> = [
  { value: 'openai_compatible_http', label: 'OpenAI 兼容 HTTP', description: '支持对话、图片、语音和搜索功能。' },
  { value: 'dashscope', label: 'DashScope（通义千问）', description: '统一支持对话、图片、语音和实时交互。只需配置一个 API 密钥。' },
  { value: 'openai_realtime', label: 'OpenAI Realtime', description: '仅用于实时语音。' },
];

export function isFamilyModelRealtimeAdapter(adapterKind: FamilyModelAdapterKind): boolean {
  return adapterKind === 'openai_realtime';
}

export const FAMILY_MODEL_METER_LABELS: Partial<Record<ModelUsageMeter, string>> = {
  uncached_input_tokens: '未缓存输入 Token',
  cached_input_tokens: '缓存输入 Token',
  output_tokens: '输出 Token',
  generated_images: '生成图片',
  audio_input_seconds: '音频输入秒数',
  tts_characters: '语音合成字符',
  embedding_tokens: '智能搜索用量（Token）',
  input_tokens: '输入 Token',
};

export function familyModelCapabilityLabel(capability: FamilyModelCapability): string {
  return FAMILY_MODEL_CAPABILITY_OPTIONS[capability].label;
}

export function profileSupportsCapability(
  profile: Pick<FamilyModelProviderProfile, 'adapter_kind' | 'status' | 'archived'>,
  capability: FamilyModelCapability,
): boolean {
  if (profile.archived || profile.status !== 'active') return false;
  const isRealtime = isFamilyModelRealtimeAdapter(profile.adapter_kind);
  if (profile.adapter_kind === 'dashscope') return true;
  return capability === 'realtime_audio' ? isRealtime : !isRealtime;
}
