import type { ImageInputValue } from '../../api/types';
import { resolveAssetUrl } from '../../lib/assets';
import { getImagePreview } from '../../lib/ui';
import { MediaWithPlaceholder } from '../MediaPlaceholder';

export function ImageComposer(props: {
  title: string;
  value: ImageInputValue;
  previewLabel: string;
  onUpload: (files: FileList | null) => void;
  onGenerate: (mode: 'reference' | 'text') => void;
  onReset: () => void;
  isGenerating?: boolean;
  errorMessage?: string | null;
  variant?: 'default' | 'workspace-inline';
  uploadTitle?: string;
  uploadHint?: string;
  generatedTitle?: string;
  generateLabel?: string;
  clearLabel?: string;
}) {
  const preview = getImagePreview(props.value);
  const hasReference = Boolean(props.value.referenceAsset);
  const hasGenerated = Boolean(props.value.generatedAsset);
  const generateLabel = props.generateLabel ?? (hasReference
    ? hasGenerated
      ? '重新生成主图'
      : '重试生成主图'
    : '基于信息生成主图');
  const ContainerTag = props.variant === 'workspace-inline' ? 'section' : 'div';
  const rootClassName =
    props.variant === 'workspace-inline'
      ? 'media-panel form-panel-section image-composer image-composer-workspace-inline'
      : 'span-two media-panel form-panel-section image-composer';
  const showResults = hasReference || hasGenerated || Boolean(props.isGenerating);
  const aiStatusLabel = hasGenerated ? '已生成' : props.isGenerating ? '后台生成中' : props.errorMessage ? '可重试' : '未生成';
  const aiPlaceholderTitle = props.isGenerating ? 'AI 主图已排队' : props.errorMessage ? '主图生成失败' : '还没有 AI 主图';
  const aiPlaceholderNote = props.isGenerating ? '可以先保存，生成完成后会自动更新图片。' : props.errorMessage ? '点击右上角按钮重试即可。' : '可以先上传参考图，或直接基于信息生成。';

  return (
    <ContainerTag className={rootClassName}>
      <div className="section-mini-title">
        <span>{props.title}</span>
      </div>
      <div className="image-composer-stage">
        {!showResults ? (
          props.variant === 'workspace-inline' ? (
            <div className="image-composer-intro-grid">
              <div className="image-composer-intro-card">
                <div className="image-composer-intro-card-header">
                  <div className="image-composer-intro-card-icon">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m10.607 10.607l.707.707N12 8a4 4 0 100 8 4 4 0 000-8z" />
                    </svg>
                  </div>
                  <strong>AI 主图美化</strong>
                </div>
                <p className="image-composer-intro-card-desc">
                  上传您的日常实拍作为<b>参考图</b>，AI 将自动将其美化为温馨的手绘插画主图。
                </p>
                <div className="image-composer-intro-card-tips">
                  <div className="image-composer-intro-tip">
                    <span className="image-composer-intro-tip-dot">✦</span>
                    <span>支持拍照或相册上传参考图，效果更佳</span>
                  </div>
                  <div className="image-composer-intro-tip">
                    <span className="image-composer-intro-tip-dot">✦</span>
                    <span>若无参考图，也可直接基于食物名称一键生成</span>
                  </div>
                </div>
              </div>
              <label className="upload-dropzone image-composer-primary-dropzone">
                <input
                  type="file"
                  accept="image/*,.svg"
                  capture="environment"
                  disabled={props.isGenerating}
                  onChange={(event) => {
                    props.onUpload(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
                <div className="image-composer-dropzone-copy">
                  <strong>{props.uploadTitle ?? '上传参考图'}</strong>
                  <span>{props.uploadHint ?? '上传后自动生成统一风格主图'}</span>
                </div>
              </label>
            </div>
          ) : (
            <label className="upload-dropzone image-composer-primary-dropzone">
              <input
                type="file"
                accept="image/*,.svg"
                capture="environment"
                disabled={props.isGenerating}
                onChange={(event) => {
                  props.onUpload(event.target.files);
                  event.currentTarget.value = '';
                }}
              />
              <div className="image-composer-dropzone-copy">
                <strong>{props.uploadTitle ?? '上传参考图'}</strong>
                <span>{props.uploadHint ?? '上传后自动生成统一风格主图'}</span>
              </div>
            </label>
          )
        ) : (
          <div className={hasReference ? 'image-composer-result-grid has-reference' : 'image-composer-result-grid'}>
            {hasReference && (
              <label className="image-composer-result-card image-composer-result-card-upload">
                <input
                  type="file"
                  accept="image/*,.svg"
                  capture="environment"
                  disabled={props.isGenerating}
                  onChange={(event) => {
                    props.onUpload(event.target.files);
                    event.currentTarget.value = '';
                  }}
                />
                <div className="image-composer-result-head">
                  <span>参考图</span>
                  <small>{props.isGenerating ? '后台生成中' : '点按更换'}</small>
                </div>
                <div className="image-composer-result-media">
                  <MediaWithPlaceholder
                    src={resolveAssetUrl(props.value.referenceAsset?.url ?? preview?.url ?? '')}
                    alt={`${props.previewLabel}参考图`}
                  />
                </div>
              </label>
            )}

            <article className="image-composer-result-card">
              <div className="image-composer-result-head">
                <span>{props.generatedTitle ?? 'AI 主图'}</span>
                <small>{aiStatusLabel}</small>
              </div>
              {hasGenerated ? (
                <div className="image-composer-result-media">
                  <MediaWithPlaceholder
                    src={resolveAssetUrl(props.value.generatedAsset?.url ?? preview?.url ?? '')}
                    alt={props.previewLabel}
                  />
                </div>
              ) : (
                <div className="image-composer-result-placeholder">
                  {props.isGenerating && <div className="image-composer-loading-surface" aria-hidden="true" />}
                  <strong>{aiPlaceholderTitle}</strong>
                  <span>{aiPlaceholderNote}</span>
                </div>
              )}
            </article>
          </div>
        )}
      </div>
      <div className="image-composer-actions">
        <button
          className="ghost-button ai-action"
          type="button"
          onClick={() => props.onGenerate(hasReference ? 'reference' : 'text')}
          disabled={props.isGenerating}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 3.8 14 9l5.2 2-5.2 2-2 5.2-2-5.2-5.2-2 5.2-2L12 3.8Z" />
          </svg>
          {props.isGenerating ? '正在生成...' : generateLabel}
        </button>
        {(hasReference || hasGenerated) && (
          <button className="ghost-button" type="button" onClick={props.onReset} disabled={props.isGenerating}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.1 8.5A7.2 7.2 0 1 1 4.8 16" />
              <path d="M5 4.8v3.7h3.7" />
            </svg>
            {props.clearLabel ?? '清空图片'}
          </button>
        )}
      </div>
      {props.errorMessage && <span className="image-composer-error">{props.errorMessage}</span>}
    </ContainerTag>
  );
}
