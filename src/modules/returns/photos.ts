/**
 * Return-photo handling: client inputs are validated twice (schema shape +
 * magic-byte sniffing here), then written to a PRIVATE directory that no
 * static mount serves. Only metadata (storedName, originalName, size, mime)
 * ever reaches the database.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
/** RFC-safe lowercase media type suffix used for extensions. */
export const PHOTO_TYPES = ['jpeg', 'png', 'webp'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** Rejected magic bytes get a truthful, non-technical error string. */
export function detectImageType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 //  P
  ) {
    return 'webp';
  }
  return null;
}

export const PHOTO_MIME: Record<PhotoType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export const PHOTO_EXT: Record<PhotoType, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export interface ReturnPhotoInput {
  name: string;
  type: string;
  size: number;
  dataBase64: string;
}

export interface StoredPhotoMetadata {
  id: string;
  storedName: string;
  originalName: string;
  size: number;
  mime: string;
}

export type PhotoValidation =
  | { ok: true; bytes: Buffer; type: PhotoType }
  | { ok: false; error: string };

/** Client-declared name is only ever used for display (never for paths). */
export function sanitizeOriginalName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'photo';
}

/** High-entropy, URL-safe photo id (16 chars), never derived from user input. */
export function generatePhotoId(): string {
  return randomBytes(12).toString('base64url');
}

/** Where return photos live. Defaults to <backend>/uploads/returns. */
export function uploadsDirectory(): string {
  const configured = env.RETURN_PHOTO_UPLOADS_DIR?.trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'uploads', 'returns');
}

export function storedPhotoName(returnId: string, photoId: string, ext: string): string {
  return `${returnId}-${photoId}.${ext}`;
}

export async function ensureUploadsDirectory(): Promise<void> {
  await mkdir(uploadsDirectory(), { recursive: true });
}

export function photoFilePath(storedName: string): string {
  return path.join(uploadsDirectory(), storedName);
}

/**
 * Validates a client-authored photo input: declares a type that matches the
 * detected magic bytes (authoritative), enforces size bounds, and rejects
 * non-image data. Base64 length checks keep us inside the JSON body limit.
 */
export function validateReturnPhoto(input: ReturnPhotoInput): PhotoValidation {
  if (typeof input.dataBase64 !== 'string' || input.dataBase64.length === 0) {
    return { ok: false, error: 'One of your photos is empty.' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.dataBase64, 'base64');
  } catch {
    return { ok: false, error: 'One of your photos could not be read.' };
  }
  const type = detectImageType(bytes);
  if (!type) {
    return { ok: false, error: 'Only JPEG, PNG or WebP photos are accepted.' };
  }
  if (typeof input.size === 'number' && input.size !== bytes.length) {
    return { ok: false, error: 'One of your photos reported a wrong file size.' };
  }
  if (bytes.length === 0) {
    return { ok: false, error: 'One of your photos is empty.' };
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    return { ok: false, error: 'Each photo must be up to 3 MB. Please compress and try again.' };
  }
  const declaredType = (input.type ?? '').trim().toLowerCase();
  if (declaredType !== PHOTO_MIME[type]) {
    return { ok: false, error: 'One of your photos has a mismatched file type.' };
  }
  return { ok: true, bytes, type };
}

/** Persists an already-validated photo and returns its stored metadata. */
export async function writeReturnPhoto(
  returnId: string,
  photoId: string,
  type: PhotoType,
  bytes: Buffer,
  originalName: string,
): Promise<StoredPhotoMetadata> {
  const storedName = storedPhotoName(returnId, photoId, PHOTO_EXT[type]);
  await ensureUploadsDirectory();
  await writeFile(photoFilePath(storedName), bytes, { flag: 'wx' });
  return {
    id: photoId,
    storedName,
    originalName: sanitizeOriginalName(originalName),
    size: bytes.length,
    mime: PHOTO_MIME[type],
  };
}

/** Best-effort cleanup of photos written for a return that failed to persist. */
export async function deleteReturnPhotos(
  photos: ReadonlyArray<Pick<StoredPhotoMetadata, 'storedName'>>,
): Promise<void> {
  for (const photo of photos) {
    await unlink(photoFilePath(photo.storedName)).catch(() => undefined);
  }
}

/** Whitelist pattern for URL-supplied photo ids (base64url 16 chars). */
export const PHOTO_ID_PATTERN = /^[A-Za-z0-9_-]{16,24}$/;

export function isValidPhotoId(value: string): boolean {
  return PHOTO_ID_PATTERN.test(value);
}