/** Media contracts. */
import type { ImageGenerationMode, MediaSource } from './primitives';
export interface IngredientUnitConversion {
  unit: string;
  ratio_to_default: number;
}

export interface MediaAsset {
  id: string;
  name: string;
  url: string;
  url_expires_at?: string;
  source: MediaSource;
  alt: string;
  generation_mode?: ImageGenerationMode | null;
  reference_media_id?: string | null;
  style_key?: string | null;
  prompt_version?: string | null;
  variants?: {
    thumb?: MediaAssetVariant | null;
    card?: MediaAssetVariant | null;
    large?: MediaAssetVariant | null;
  } | null;
  created_at: string;
  created_by?: string | null;
}

export interface MediaAssetVariant {
  url: string;
  url_expires_at?: string;
  width: number;
  height: number;
  content_type: string;
  byte_size: number;
}
