import { WorkspaceToolError } from './workspace-tools';
import { inspectImageStructure, validPngRaster } from './upload-security';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
type Dimensions = { width: number; height: number };
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_DIMENSION = 2048;
function bad(): never {
  throw new WorkspaceToolError('손상되지 않은 정적 PNG, JPEG, WebP 이미지를 선택해주세요. 가로·세로는 각각 2,048px 이하여야 합니다.', 400, 'INVALID_REFERENCE_IMAGE');
}

/** Reference limits wrap the shared complete-container parser used for generated images. */
export function validateImageStructure(bytes: Uint8Array, mime: string): Dimensions {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_REFERENCE_BYTES) bad();
  const dimensions = inspectImageStructure(bytes, mime);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1
    || dimensions.width > MAX_REFERENCE_DIMENSION || dimensions.height > MAX_REFERENCE_DIMENSION) bad();
  return dimensions;
}

/** PNG is fully inflated and checked, including indexed pixels. JPEG/WebP still
 * need an isolated entropy decoder before any higher-risk local processing. */
export async function validateReferenceImage(bytes: Uint8Array, mime: string): Promise<Dimensions> {
  const dimensions = validateImageStructure(bytes, mime);
  if (mime === 'image/png' && !await validPngRaster(bytes, MAX_REFERENCE_DIMENSION)) bad();
  return dimensions;
}
