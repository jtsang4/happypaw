import fs from 'fs';
import path from 'path';

import type { Base64ImageInput, CodexUserInput } from './shared.js';

const IMAGE_MAX_DIMENSION = 8000;
const STAGED_IMAGE_DIR_NAME = '.happypaw-input-images';

function resolveImageMimeType(
  img: Base64ImageInput,
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined,
  log: (message: string) => void,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(
      `Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`,
    );
    return detected as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  }

  return (declared || detected || 'image/jpeg') as
    | 'image/jpeg'
    | 'image/png'
    | 'image/gif'
    | 'image/webp';
}

function getImageDimensions(
  base64Data: string,
): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    if (
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      const fullHeader = Buffer.from(base64Data.slice(0, 40000), 'base64');
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xff) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            width: fullHeader.readUInt16BE(i + 7),
            height: fullHeader.readUInt16BE(i + 5),
          };
        }
        if (marker !== 0xd8 && marker !== 0xd9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    if (
      buf.length >= 10 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46
    ) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return {
        width: buf.readInt32LE(18),
        height: Math.abs(buf.readInt32LE(22)),
      };
    }

    if (
      buf.length >= 30 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46
    ) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30) {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (fourCC === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (fourCC === 'VP8X' && buf.length >= 30) {
        return {
          width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
          height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function filterOversizedImages(
  images: Base64ImageInput[],
  log: (message: string) => void,
): { valid: Base64ImageInput[]; rejected: string[] } {
  const valid: Base64ImageInput[] = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (
      dims &&
      (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)
    ) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
      continue;
    }
    valid.push(img);
  }
  return { valid, rejected };
}

function imageExtensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.jpg';
  }
}

export function buildUserInput(
  prompt: string,
  images: Base64ImageInput[] | undefined,
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined,
  log: (message: string) => void,
  stagedImagePaths?: string[],
): {
  input: CodexUserInput[];
  rejected: string[];
} {
  const filteredImages = images
    ? filterOversizedImages(images, log)
    : { valid: [], rejected: [] };

  const imageInputs: CodexUserInput[] = stagedImagePaths
    ? stagedImagePaths.map(
        (imagePath) =>
          ({
            type: 'localImage',
            path: imagePath,
          }) satisfies CodexUserInput,
      )
    : filteredImages.valid.map(
        (img) =>
          ({
            type: 'image',
            url: `data:${resolveImageMimeType(
              img,
              detectImageMimeTypeFromBase64Strict,
              log,
            )};base64,${img.data}`,
          }) satisfies CodexUserInput,
      );

  return {
    input: [
      {
        type: 'text',
        text: prompt,
        text_elements: [],
      } satisfies CodexUserInput,
      ...imageInputs,
    ],
    rejected: filteredImages.rejected,
  };
}

export function stageInputImages(
  workspaceDir: string,
  images: Base64ImageInput[] | undefined,
  detectImageMimeTypeFromBase64Strict: (data: string) => string | undefined,
  log: (message: string) => void,
): {
  paths: string[];
  rejected: string[];
  cleanup: () => void;
} {
  if (!images || images.length === 0) {
    return { paths: [], rejected: [], cleanup: () => {} };
  }

  const filtered = filterOversizedImages(images, log);
  if (filtered.valid.length === 0) {
    return { paths: [], rejected: filtered.rejected, cleanup: () => {} };
  }

  const stagingDir = path.join(workspaceDir, STAGED_IMAGE_DIR_NAME);
  fs.mkdirSync(stagingDir, { recursive: true });

  const stagedPaths: string[] = [];
  const cleanup = (): void => {
    for (const stagedPath of stagedPaths) {
      try {
        fs.unlinkSync(stagedPath);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    filtered.valid.forEach((img, index) => {
      const mimeType = resolveImageMimeType(
        img,
        detectImageMimeTypeFromBase64Strict,
        log,
      );
      const ext = imageExtensionFromMimeType(mimeType);
      const filename = `turn-${Date.now()}-${process.pid}-${index}${ext}`;
      const absPath = path.join(stagingDir, filename);
      fs.writeFileSync(absPath, Buffer.from(img.data, 'base64'));
      stagedPaths.push(absPath);
      log(`Staged Codex image input at ${absPath}`);
    });
    return { paths: stagedPaths, rejected: filtered.rejected, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
