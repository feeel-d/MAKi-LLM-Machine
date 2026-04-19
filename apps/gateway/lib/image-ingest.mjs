import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { InternalApiError } from './internal-errors.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Buffer.from('GIF87a', 'ascii');
const GIF89A_SIGNATURE = Buffer.from('GIF89a', 'ascii');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii');

const DEFAULT_ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export async function fetchImageAsDataUrl({ imageUrl, config }) {
  const url = parseAndValidateImageUrl(imageUrl);
  await assertPublicNetworkTarget(url.hostname);

  const timeoutMs = Math.max(1_000, Number(config.imageFetchTimeoutMs ?? 15_000));
  const maxBytes = Math.max(1, Number(config.maxImageBytes ?? 8 * 1024 * 1024));
  const allowedMime = toAllowedMimeSet(config.allowedImageMime);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('image_fetch_timeout'), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'image/*',
      },
    });

    if (!response.ok || !response.body) {
      throw new InternalApiError(
        422,
        `Image fetch failed with status ${response.status}.`,
        'IMAGE_FETCH_FAILED',
      );
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new InternalApiError(413, 'Image is too large.', 'IMAGE_TOO_LARGE');
    }

    const declaredMime = parseContentType(response.headers.get('content-type'));
    if (declaredMime && !declaredMime.startsWith('image/')) {
      throw new InternalApiError(422, 'URL did not return an image.', 'INVALID_IMAGE_MIME');
    }

    const bytes = await readBodyWithLimit(response.body, maxBytes);
    if (bytes.length === 0) {
      throw new InternalApiError(422, 'Image payload is empty.', 'EMPTY_IMAGE');
    }

    const detectedMime = detectImageMime(bytes);
    if (!detectedMime) {
      throw new InternalApiError(422, 'Unsupported image format.', 'UNSUPPORTED_IMAGE_FORMAT');
    }

    if (declaredMime && declaredMime.startsWith('image/') && declaredMime !== detectedMime) {
      throw new InternalApiError(422, 'Image MIME mismatch.', 'IMAGE_MIME_MISMATCH');
    }

    const finalMime = declaredMime && declaredMime.startsWith('image/') ? declaredMime : detectedMime;
    if (!allowedMime.has(finalMime)) {
      throw new InternalApiError(422, `Image MIME ${finalMime} is not allowed.`, 'IMAGE_MIME_NOT_ALLOWED');
    }

    return {
      mimeType: finalMime,
      sizeBytes: bytes.length,
      dataUrl: `data:${finalMime};base64,${bytes.toString('base64')}`,
    };
  } catch (error) {
    if (error instanceof InternalApiError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new InternalApiError(504, 'Image fetch timeout.', 'IMAGE_FETCH_TIMEOUT');
    }

    throw new InternalApiError(
      422,
      error instanceof Error ? error.message : 'Unable to fetch image.',
      'IMAGE_FETCH_ERROR',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function parseAndValidateImageUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InternalApiError(400, 'imageUrl is required.', 'IMAGE_URL_REQUIRED');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InternalApiError(400, 'imageUrl is invalid.', 'INVALID_IMAGE_URL');
  }

  if (url.protocol !== 'https:') {
    throw new InternalApiError(422, 'Only HTTPS image URLs are allowed.', 'IMAGE_URL_NOT_HTTPS');
  }

  if (url.username || url.password) {
    throw new InternalApiError(422, 'Image URL with credentials is not allowed.', 'IMAGE_URL_WITH_CREDENTIALS');
  }

  return url;
}

export async function assertPublicNetworkTarget(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized) {
    throw new InternalApiError(422, 'imageUrl hostname is missing.', 'IMAGE_HOST_MISSING');
  }

  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    throw new InternalApiError(422, 'Private host is not allowed.', 'PRIVATE_HOST_NOT_ALLOWED');
  }

  if (net.isIP(normalized)) {
    if (isPrivateIpAddress(normalized)) {
      throw new InternalApiError(422, 'Private IP is not allowed.', 'PRIVATE_IP_NOT_ALLOWED');
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new InternalApiError(422, 'Unable to resolve image host.', 'IMAGE_HOST_RESOLVE_FAILED');
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new InternalApiError(422, 'Unable to resolve image host.', 'IMAGE_HOST_RESOLVE_FAILED');
  }

  for (const entry of addresses) {
    if (entry?.address && isPrivateIpAddress(entry.address)) {
      throw new InternalApiError(422, 'Private IP is not allowed.', 'PRIVATE_IP_NOT_ALLOWED');
    }
  }
}

export function isPrivateIpAddress(ip) {
  if (typeof ip !== 'string' || ip.length === 0) {
    return true;
  }

  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    return isPrivateIpAddress(mapped);
  }

  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip);
  }
  if (family === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
}

export function detectImageMime(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }

  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6);
    if (head.equals(GIF87A_SIGNATURE) || head.equals(GIF89A_SIGNATURE)) {
      return 'image/gif';
    }
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_SIGNATURE) &&
    bytes.subarray(8, 12).equals(WEBP_SIGNATURE)
  ) {
    return 'image/webp';
  }

  return null;
}

function toAllowedMimeSet(configValue) {
  if (configValue instanceof Set && configValue.size > 0) {
    return configValue;
  }

  if (Array.isArray(configValue) && configValue.length > 0) {
    return new Set(configValue.map((item) => String(item).toLowerCase()));
  }

  if (typeof configValue === 'string' && configValue.trim().length > 0) {
    return new Set(
      configValue
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  return DEFAULT_ALLOWED_IMAGE_MIME;
}

function parseContentType(raw) {
  if (!raw) {
    return '';
  }

  return raw.split(';')[0].trim().toLowerCase();
}

async function readBodyWithLimit(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      throw new InternalApiError(413, 'Image is too large.', 'IMAGE_TOO_LARGE');
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  if (normalized.startsWith('2001:db8')) {
    return true;
  }

  return false;
}

