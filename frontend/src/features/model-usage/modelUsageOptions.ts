import type {
  ModelUsageCapability,
  ModelUsageErrorCode,
  ModelUsageFamilyGroupBy,
  ModelUsageMemberBudgetState,
  ModelUsageMeter,
  ModelUsagePersonalGroupBy,
  ModelUsageScope,
} from '../../api/types';

export const MODEL_USAGE_CAPABILITY_OPTIONS: Record<
  ModelUsageCapability,
  { label: string; description: string }
> = {
  llm: { label: '文本与图片理解', description: '对话、菜谱建议和图片理解' },
  embedding: { label: '智能搜索', description: '让搜索理解食材和菜谱内容' },
  rerank: { label: '搜索排序', description: '调整搜索结果的先后顺序' },
  stt: { label: '语音转文字', description: '把语音记录转换为文字' },
  tts: { label: '文字转语音', description: '把内容转换为语音播报' },
  realtime_audio: { label: '实时语音', description: '进行实时语音交流' },
  image_generation: { label: '图片生成', description: '生成菜谱和食物图片' },
};

export const MODEL_USAGE_CAPABILITY_METERS: Record<
  ModelUsageCapability,
  readonly ModelUsageMeter[]
> = {
  llm: ['input_tokens', 'uncached_input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'],
  embedding: ['embedding_tokens'],
  rerank: ['input_tokens'],
  stt: ['audio_input_seconds', 'audio_input_tokens'],
  tts: ['audio_output_seconds', 'audio_output_tokens', 'tts_characters', 'tts_tokens'],
  realtime_audio: ['audio_input_seconds', 'tts_characters'],
  image_generation: ['generated_images'],
};

export const MODEL_USAGE_METER_OPTIONS: Record<ModelUsageMeter, { label: string }> = {
  input_tokens: { label: '输入 Token' },
  uncached_input_tokens: { label: '未缓存输入 Token' },
  cached_input_tokens: { label: '缓存输入 Token' },
  output_tokens: { label: '输出 Token' },
  total_tokens: { label: '总文本用量' },
  embedding_tokens: { label: '智能搜索用量（Token）' },
  rerank_requests: { label: '排序请求' },
  rerank_documents: { label: '参与排序的内容' },
  audio_input_seconds: { label: '音频输入时长' },
  audio_output_seconds: { label: '音频输出时长' },
  audio_input_tokens: { label: '音频输入 Token' },
  audio_output_tokens: { label: '音频输出 Token' },
  tts_characters: { label: '语音合成字符' },
  tts_tokens: { label: '语音合成 Token' },
  generated_images: { label: '生成图片' },
  request_units: { label: '请求单位' },
};

export const MODEL_USAGE_MEMBER_BUDGET_STATE_OPTIONS: Record<
  ModelUsageMemberBudgetState,
  { label: string; message: string }
> = {
  sufficient: { label: '额度充足', message: '当前家庭模型额度充足。' },
  approaching_limit: { label: '接近上限', message: '家庭模型额度接近提醒线。' },
  alert_threshold_reached: { label: '达到提醒线', message: '家庭模型额度已达到提醒线。' },
  capability_degraded: { label: '部分功能可能降级', message: '部分模型功能可能暂时使用基础方式处理。' },
  measurement_unavailable: { label: '用量明细暂时异常', message: '当前无法完整确认模型额度，请稍后重试。' },
};

export const MODEL_USAGE_HEALTH_OPTIONS = {
  exact: { title: '已完整记录' },
  estimated: { title: '含估算用量' },
  unpriced: { title: '存在未定价用量' },
  uncertain: { title: '仍有请求待核对' },
  pending: { title: '费用确认中' },
  conservative_unknown_execution: { title: '请求状态待确认' },
  known_unmeasured: { title: '用量明细待恢复' },
  measurement_gap: { title: '部分时段记录不完整' },
} as const;

export const MODEL_USAGE_PERSONAL_GROUP_OPTIONS: ReadonlyArray<{
  value: ModelUsagePersonalGroupBy;
  label: string;
}> = [
  { value: 'capability', label: '按功能' },
  { value: 'meter', label: '按用量类型' },
  { value: 'daily_capability_cost', label: '按日期与功能' },
];

export const MODEL_USAGE_FAMILY_GROUP_OPTIONS: ReadonlyArray<{
  value: ModelUsageFamilyGroupBy;
  label: string;
}> = [
  { value: 'capability', label: '按功能' },
  { value: 'provider_model', label: '按模型服务 / 模型' },
  { value: 'meter', label: '按用量类型' },
  { value: 'subject', label: '按家庭成员' },
  { value: 'daily_capability_cost', label: '按日期与功能' },
];

export function modelUsageGroupOptions(scope: ModelUsageScope) {
  return scope === 'family' ? MODEL_USAGE_FAMILY_GROUP_OPTIONS : MODEL_USAGE_PERSONAL_GROUP_OPTIONS;
}

export const MODEL_USAGE_ERROR_OPTIONS: Record<ModelUsageErrorCode, { title: string; message: string }> = {
  model_usage_adjustment_window_closed: { title: '这个统计周期已归档', message: '历史统计不能再按单次请求修正。' },
  model_usage_alert_not_found: { title: '提醒已不可用', message: '该提醒可能已被处理，请刷新后查看。' },
  model_usage_attempt_already_accounted: { title: '这次请求已经记录', message: '请刷新当前操作结果；系统不会再次发起模型请求。' },
  model_usage_attempt_conflict: { title: '这次请求无法安全重试', message: '请重新尝试一次。' },
  model_usage_budget_exceeded: { title: '本月模型额度已用完', message: '本次没有向模型服务发起请求。' },
  model_usage_capability_limit_exceeded: { title: '这项模型功能已达上限', message: '本次已使用可用的基础方式处理。' },
  model_usage_dispatch_recovery_required: { title: '模型请求状态正在核对', message: '系统不会重复发起请求，请稍后查看结果。' },
  model_usage_future_period_not_allowed: { title: '统计周期未开始', message: '请选择当前或已结束的月份。' },
  model_usage_guardrail_quantity_unavailable: { title: '暂时无法确认这项用量', message: '为避免超出限制，本次没有发起模型请求。' },
  model_usage_historical_rollup_not_found: { title: '历史统计暂不可用', message: '该统计周期的汇总数据尚未生成。' },
  model_usage_invalid_group_by: { title: '统计方式不可用', message: '请刷新后重新选择统计方式。' },
  model_usage_invalid_period: { title: '统计周期格式不正确', message: '请选择一个有效的月份。' },
  model_usage_ledger_unavailable: { title: '暂时无法确认模型额度', message: '请稍后重试；当前没有发起新的模型请求。' },
  model_usage_missing_price_confirmation_required: { title: '请确认未定价请求的处理方式', message: '开启超额停止前，请先确认没有价格的请求会被阻止。' },
  model_usage_policy_conflict: { title: '预算设置已更新', message: '请查看最新设置后再应用当前修改。' },
  model_usage_policy_validation_error: { title: '预算设置无法保存', message: '请检查预算和功能限额后再试。' },
  model_usage_price_unavailable: { title: '暂时无法确认模型费用', message: '为避免超出预算，本次没有发起模型请求。' },
  model_usage_query_unavailable: { title: '模型用量暂不可用', message: '请稍后刷新再试。' },
  model_usage_settlement_pending: { title: '模型用量正在核对', message: '结果可继续使用，费用状态稍后更新。' },
};
