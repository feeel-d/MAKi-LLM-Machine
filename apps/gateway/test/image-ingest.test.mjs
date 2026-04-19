import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPublicNetworkTarget,
  detectImageMime,
  isPrivateIpAddress,
  parseAndValidateImageUrl,
} from '../lib/image-ingest.mjs';
import { InternalApiError } from '../lib/internal-errors.mjs';

test('parseAndValidateImageUrl allows https only', () => {
  assert.throws(
    () => parseAndValidateImageUrl('http://example.com/a.png'),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 422 &&
      error.code === 'IMAGE_URL_NOT_HTTPS',
  );

  const url = parseAndValidateImageUrl('https://example.com/a.png');
  assert.equal(url.protocol, 'https:');
});

test('assertPublicNetworkTarget blocks localhost hostnames', async () => {
  await assert.rejects(
    () => assertPublicNetworkTarget('localhost'),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 422 &&
      error.code === 'PRIVATE_HOST_NOT_ALLOWED',
  );
});

test('isPrivateIpAddress detects private CIDR ranges', () => {
  assert.equal(isPrivateIpAddress('127.0.0.1'), true);
  assert.equal(isPrivateIpAddress('10.1.2.3'), true);
  assert.equal(isPrivateIpAddress('192.168.0.8'), true);
  assert.equal(isPrivateIpAddress('8.8.8.8'), false);
});

test('detectImageMime recognizes png and jpeg', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
  const random = Buffer.from([0x00, 0x01, 0x02, 0x03]);

  assert.equal(detectImageMime(png), 'image/png');
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
  assert.equal(detectImageMime(random), null);
});

