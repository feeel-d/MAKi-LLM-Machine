import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContentGenerationService,
  validateTitleFromTextInput,
} from '../lib/content-generation.mjs';
import { InternalApiError } from '../lib/internal-errors.mjs';

const BASE_CONFIG = {
  contentRetryCount: 1,
};

test('titleFromText uses deepseek and returns normalized title', async () => {
  const calls = [];
  const service = createContentGenerationService({
    fetchRouterModels: async () => [{ id: 'deepseek' }],
    completeJsonCompletion: async (payload) => {
      calls.push(payload);
      return { parsed: { title: '  새 제목   테스트  ' } };
    },
  });

  const result = await service.titleFromText({
    config: BASE_CONFIG,
    requestId: 'req-1',
    input: {
      text: '긴 본문',
    },
  });

  assert.equal(result.model, 'deepseek');
  assert.equal(result.title, '새 제목 테스트');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'deepseek');
});

test('titleFromImage uses gemmae4 and forwards fetched dataUrl', async () => {
  const calls = [];
  const service = createContentGenerationService({
    fetchRouterModels: async () => [{ id: 'gemmae4' }],
    fetchImageAsDataUrl: async () => ({
      dataUrl: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
      sizeBytes: 4,
    }),
    completeJsonCompletion: async (payload) => {
      calls.push(payload);
      return { parsed: { title: '이미지 제목' } };
    },
  });

  const result = await service.titleFromImage({
    config: BASE_CONFIG,
    requestId: 'req-2',
    input: {
      imageUrl: 'https://cdn.example.com/a.png',
    },
  });

  assert.equal(result.model, 'gemmae4');
  assert.equal(result.title, '이미지 제목');
  assert.equal(calls[0].model, 'gemmae4');
  const content = calls[0].messages[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('bodyFromImage defaults to medium length', async () => {
  const calls = [];
  const service = createContentGenerationService({
    fetchRouterModels: async () => [{ id: 'gemmae4' }],
    fetchImageAsDataUrl: async () => ({
      dataUrl: 'data:image/jpeg;base64,AAAA',
      mimeType: 'image/jpeg',
      sizeBytes: 4,
    }),
    completeJsonCompletion: async (payload) => {
      calls.push(payload);
      return { parsed: { body: '자동 생성 본문' } };
    },
  });

  const result = await service.bodyFromImage({
    config: BASE_CONFIG,
    requestId: 'req-3',
    input: {
      imageUrl: 'https://cdn.example.com/a.jpg',
    },
  });

  assert.equal(result.body, '자동 생성 본문');
  assert.equal(calls[0].maxTokens, 760);
});

test('validateTitleFromTextInput rejects invalid style', () => {
  assert.throws(
    () => validateTitleFromTextInput({ text: '본문', style: 'random' }),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 400 &&
      error.code === 'INVALID_STYLE',
  );
});

test('titleFromText returns 503 when required model is missing', async () => {
  const service = createContentGenerationService({
    fetchRouterModels: async () => [{ id: 'qwen' }],
    completeJsonCompletion: async () => ({ parsed: { title: 'unused' } }),
  });

  await assert.rejects(
    () =>
      service.titleFromText({
        config: BASE_CONFIG,
        requestId: 'req-4',
        input: { text: '본문' },
      }),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 503 &&
      error.code === 'MODEL_UNAVAILABLE',
  );
});

