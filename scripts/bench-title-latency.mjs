#!/usr/bin/env node
/**
 * 제목(title-from-text) 경로 지연 측정: 게이트웨이 vs llama-server 직접 호출, 입력 길이·max_tokens·temperature·response_format
 * 사용: node scripts/bench-title-latency.mjs
 * 환경: GATEWAY_URL, ROUTER_URL, SERVICE_KEY, TITLE_BENCH_MODEL_ID(선택), LLAMA_API_KEY(선택)
 *
 * Gemma4 등은 reasoning_content에 먼저 쓰고 content는 나중에 채울 수 있어,
 * 짧은 max_tokens(예: 64)는 측정 ms는 짧아도 content가 비는 경우가 있음(프로덕 title 프롬프트와 별개 해석).
 */
import { performance } from 'node:perf_hooks';
import { buildTitleFromTextPrompt } from '../apps/gateway/lib/content-generation.mjs';

const GATEWAY_URL = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const ROUTER_URL = (process.env.ROUTER_URL ?? 'http://127.0.0.1:8082').replace(/\/$/, '');
const SERVICE_KEY = process.env.SERVICE_KEY ?? 'test-service-key';
const LLAMA_KEY = process.env.LLAMA_API_KEY ?? '';

/** 실제 /v1/models id (로컬은 gemmae4 별칭이 없을 수 있어 HF id 사용) */
let MODEL = process.env.TITLE_BENCH_MODEL_ID ?? '';

async function discoverLoadedGemmaModel(router) {
  const r = await fetch(`${router}/v1/models`);
  if (!r.ok) {
    return null;
  }
  const j = await r.json();
  const data = Array.isArray(j?.data) ? j.data : [];
  const prefer = (id) => typeof id === 'string' && (id.includes('gemma-4-E4B') || id === 'gemmae4');
  const loaded = data.find(
    (e) => prefer(e.id) && e?.status?.value === 'loaded' && e?.status?.failed !== true,
  );
  if (loaded) {
    return loaded.id;
  }
  return data.find((e) => prefer(e.id))?.id ?? null;
}

function headersJson(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (LLAMA_KEY) h.Authorization = `Bearer ${LLAMA_KEY}`;
  return h;
}

/** 게이트웨이 title-from-text/stream: SSE `done`까지 읽기 (또는 레거시 JSON) */
async function readTitleFromTextGatewayResponse(r) {
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('text/event-stream')) {
    return r.json();
  }
  const reader = r.body?.getReader();
  if (!reader) {
    throw new Error('no response body for SSE');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let out = null;
  let errMsg;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const segment = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventName = '';
      const dataLines = [];
      for (const line of segment.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) continue;
      try {
        const data = JSON.parse(dataStr);
        if (eventName === 'done' && data?.title) {
          out = data;
        }
        if (eventName === 'error' && data?.error) {
          errMsg = String(data.error);
        }
      } catch {
        // ignore
      }
    }
  }
  if (errMsg) {
    throw new Error(errMsg);
  }
  if (!out) {
    throw new Error('stream ended without done');
  }
  return out;
}

async function timed(name, fn) {
  const t0 = performance.now();
  let err;
  let out;
  try {
    out = await fn();
  } catch (e) {
    err = e;
  }
  const ms = Math.round(performance.now() - t0);
  return { name, ms, err: err ? String(err.message ?? err) : null, out };
}

function makeTextApproxChars(n) {
  if (n <= 0) return '빈';
  const unit = '한글본문';
  const rep = Math.ceil(n / unit.length);
  return unit.repeat(rep).slice(0, n);
}

function basePrompt() {
  return buildTitleFromTextPrompt({
    text: '로컬 벤치용 짧은 본문입니다. 제목 한 줄만 생성합니다.',
    language: 'ko',
    style: 'neutral',
    maxLength: 80,
  });
}

async function postRouter(body) {
  const r = await fetch(`${ROUTER_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: headersJson(),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function extractText(payload) {
  const c = payload?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

async function main() {
  if (!MODEL) {
    MODEL = await discoverLoadedGemmaModel(ROUTER_URL);
  }
  if (!MODEL) {
    console.error('사용할 Gemma E4B 모델 id를 찾지 못했습니다. TITLE_BENCH_MODEL_ID=... 또는 ROUTER_URL 확인');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`Using router model id: ${MODEL} (${ROUTER_URL})\n`);

  const rows = [];
  const push = (o) => {
    rows.push(o);
    const flag = o.err ? 'ERR' : 'ok';
    const extra = o.err ? o.err : '';
    // eslint-disable-next-line no-console
    console.log(`${o.name}\t${o.ms}ms\t${flag}\t${extra}`);
  };

  // 0) 연결 확인
  const h = await timed('ping gateway /api/health', () =>
    fetch(`${GATEWAY_URL}/api/health`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
  );
  push({ ...h, name: h.name + ' (ignore)' });
  if (h.err) {
    console.error('게이트웨이에 연결할 수 없습니다. GATEWAY_URL=' + GATEWAY_URL);
    process.exit(1);
  }

  const rPing = await timed('ping router /v1/models', () => fetch(`${ROUTER_URL}/v1/models`));
  push({ ...rPing, name: rPing.name + ' (ignore)' });
  if (rPing.err) {
    console.error('라우터에 연결할 수 없습니다. ROUTER_URL=' + ROUTER_URL);
    process.exit(1);
  }

  // 웜업(첫 추론·KV 등)
  await timed('warmup via gateway', () =>
    fetch(`${GATEWAY_URL}/internal/v1/content/title-from-text/stream`, {
      method: 'POST',
      headers: headersJson({ 'X-Service-Key': SERVICE_KEY }),
      body: JSON.stringify({
        text: '웜업',
        language: 'ko',
        style: 'neutral',
        maxLength: 40,
      }),
    }).then((r) => readTitleFromTextGatewayResponse(r)),
  );
  console.log('--- A. Gateway title-from-text (큐+동일 제목 경로) ---');

  for (const [label, n] of [
    ['short_80ch', 80],
    ['mid_2k', 2000],
    ['long_8k', 8000],
  ]) {
    const text = makeTextApproxChars(n);
    const t = await timed(`gateway textLen~${n} (${label})`, () =>
      fetch(`${GATEWAY_URL}/internal/v1/content/title-from-text/stream`, {
        method: 'POST',
        headers: headersJson({ 'X-Service-Key': SERVICE_KEY }),
        body: JSON.stringify({ text, language: 'ko', style: 'neutral', maxLength: 80 }),
      }).then((r) => readTitleFromTextGatewayResponse(r)),
    );
    push(t);
  }

  const prompt0 = basePrompt();
  console.log('--- B. Router direct: max_tokens (프롬프트 고정) ---');
  for (const max_tokens of [32, 64, 128, 256, 512]) {
    const t = await timed(`router max_tokens=${max_tokens}`, () =>
      postRouter({
        model: MODEL,
        messages: [{ role: 'user', content: prompt0 }],
        stream: false,
        temperature: 0.3,
        max_tokens,
      }),
    );
    if (!t.err) t.out = extractText(t.out).slice(0, 60);
    push(t);
  }

  console.log('--- C. Router direct: temperature (max_tokens=128) ---');
  for (const temperature of [0, 0.1, 0.3, 0.6, 0.9]) {
    const t = await timed(`router temp=${temperature}`, () =>
      postRouter({
        model: MODEL,
        messages: [{ role: 'user', content: prompt0 }],
        stream: false,
        temperature,
        max_tokens: 128,
      }),
    );
    if (!t.err) t.out = extractText(t.out).slice(0, 60);
    push(t);
  }

  console.log('--- D. Router direct: response_format json_object on/off (max_tokens=128) ---');
  for (const jf of [false, true]) {
    const body = {
      model: MODEL,
      messages: [{ role: 'user', content: prompt0 }],
      stream: false,
      temperature: 0.3,
      max_tokens: 128,
    };
    if (jf) {
      body.response_format = { type: 'json_object' };
    }
    const t = await timed(`router json_object=${jf}`, () => postRouter(body));
    if (!t.err) t.out = extractText(t.out).slice(0, 60);
    push(t);
  }

  console.log('--- E. Router direct: 프롬프트 입력 길이 (max_tokens=128) ---');
  for (const n of [200, 2000, 10000]) {
    const longPrompt = buildTitleFromTextPrompt({
      text: makeTextApproxChars(n),
      language: 'ko',
      style: 'neutral',
      maxLength: 80,
    });
    const t = await timed(`router promptBody~${n}chars`, () =>
      postRouter({
        model: MODEL,
        messages: [{ role: 'user', content: longPrompt }],
        stream: false,
        temperature: 0.3,
        max_tokens: 128,
      }),
    );
    if (!t.err) t.out = extractText(t.out).slice(0, 40);
    push(t);
  }

  console.log('--- F. Baseline 3× gateway (같은 요청) 분산 ---');
  const b = makeTextApproxChars(500);
  for (let i = 1; i <= 3; i += 1) {
    const t = await timed(`gateway repeat ${i}/3`, () =>
      fetch(`${GATEWAY_URL}/internal/v1/content/title-from-text/stream`, {
        method: 'POST',
        headers: headersJson({ 'X-Service-Key': SERVICE_KEY }),
        body: JSON.stringify({ text: b, language: 'ko', style: 'neutral', maxLength: 80 }),
      }).then((r) => readTitleFromTextGatewayResponse(r)),
    );
    push(t);
  }

  // 요약
  const ok = rows.filter((x) => !x.name.includes('(ignore)') && !x.name.startsWith('ping') && !x.err);
  const withMs = rows.filter((x) => !x.name.includes('(ignore)') && !x.name.startsWith('ping') && !x.err && x.ms != null);
  const mss = withMs.map((x) => x.ms);
  const min = mss.length ? Math.min(...mss) : 0;
  const max = mss.length ? Math.max(...mss) : 0;
  const avg = mss.length ? Math.round(mss.reduce((a, b) => a + b, 0) / mss.length) : 0;
  console.log('\n=== Summary (all successful bench rows, excl. ping) ===');
  console.log(`count=${mss.length} min=${min}ms max=${max}ms avg=${avg}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
