import { buildMeta, createId, nowIso } from './helpers';
import type { PhotoAsset } from './types';

function svgDataUri(content: string): string {
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(content)}`;
}

export function generateAiCover(title: string, userId: string): PhotoAsset {
  const palette = ['#f28f60', '#e56b6f', '#f7b267', '#7a9e7e', '#4c82a4'];
  const hash = [...title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const primary = palette[hash % palette.length];
  const secondary = palette[(hash + 2) % palette.length];
  const shiftX = (hash % 56) - 28;
  const shiftY = (hash % 40) - 20;
  const tilt = (hash % 16) - 8;
  const svg = `
    <svg width="1200" height="800" viewBox="0 0 1200 800" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="800" rx="72" fill="#FFF6EE"/>
      <rect width="1200" height="800" rx="72" fill="url(#warm)"/>
      <circle cx="${320 + shiftX}" cy="${196 + shiftY / 2}" r="120" fill="white" opacity="0.18"/>
      <circle cx="${868 - shiftX}" cy="${202 - shiftY / 3}" r="132" fill="${primary}" opacity="0.08"/>
      <ellipse cx="${604 + shiftX / 3}" cy="${460 + shiftY / 3}" rx="236" ry="242" fill="${secondary}" opacity="0.08"/>
      <ellipse cx="${534 + shiftX / 2}" cy="${438 + shiftY}" rx="142" ry="184" transform="rotate(${tilt} 534 438)" fill="white" opacity="0.26"/>
      <ellipse cx="${664 - shiftX / 2}" cy="${428 - shiftY / 2}" rx="156" ry="194" transform="rotate(${-tilt} 664 428)" fill="${primary}" opacity="0.18"/>
      <path d="M770 268C794.105 242.945 826.646 230.968 862.105 230.968C854.264 266.166 833.879 298.61 806.738 321.95C782.633 347.005 750.092 358.982 714.633 358.982C722.474 323.784 742.859 291.34 770 268Z" fill="white" fill-opacity="0.8"/>
      <path d="M708 306C728.161 285.047 755.392 275.029 785.065 275.029C778.507 304.475 761.444 331.612 738.729 351.144C718.568 372.097 691.337 382.115 661.664 382.115C668.222 352.669 685.285 325.532 708 306Z" fill="${secondary}" fill-opacity="0.36"/>
      <ellipse cx="602" cy="438" rx="74" ry="102" fill="white" fill-opacity="0.28"/>
      <defs>
        <linearGradient id="warm" x1="92" y1="92" x2="1108" y2="708" gradientUnits="userSpaceOnUse">
          <stop stop-color="${primary}"/>
          <stop offset="1" stop-color="${secondary}"/>
        </linearGradient>
      </defs>
    </svg>
  `;

  return {
    id: createId('photo'),
    name: `${title}-ai-cover`,
    url: svgDataUri(svg),
    source: 'ai',
    alt: `${title} 的 AI 封面`,
    generationMode: 'text',
    styleKey: 'culina-still-life-v1',
    promptVersion: '4',
    createdAt: nowIso(),
    createdBy: userId
  };
}

export function fileToPhoto(file: File, userId: string): Promise<PhotoAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        ...buildMeta(userId, 'photo'),
        name: file.name,
        url: typeof reader.result === 'string' ? reader.result : '',
        source: 'upload',
        alt: file.name
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
