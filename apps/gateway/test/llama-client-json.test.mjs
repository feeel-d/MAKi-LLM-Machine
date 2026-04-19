import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonObjectFromModelText } from '../lib/llama-client.mjs';

test('parseJsonObjectFromModelText parses plain JSON object', () => {
  const parsed = parseJsonObjectFromModelText('{"title":"hello"}');
  assert.deepEqual(parsed, { title: 'hello' });
});

test('parseJsonObjectFromModelText parses fenced JSON', () => {
  const parsed = parseJsonObjectFromModelText('```json\n{"body":"text"}\n```');
  assert.deepEqual(parsed, { body: 'text' });
});

test('parseJsonObjectFromModelText parses JSON surrounded by text', () => {
  const parsed = parseJsonObjectFromModelText('Result:\n{"title":"abc"}\nThanks');
  assert.deepEqual(parsed, { title: 'abc' });
});

test('parseJsonObjectFromModelText throws on invalid content', () => {
  assert.throws(() => parseJsonObjectFromModelText('not json'));
});

