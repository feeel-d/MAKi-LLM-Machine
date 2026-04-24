#!/usr/bin/env node
/**
 * llama-server GET /v1/models 결과로 프로필에 필요한 슬롯이 모두 loaded 인지 검사.
 * exit 0: OK, 1: HTTP/파싱 오류, 2: 일부 슬롯 미로드
 */
import process from 'node:process';

const url = process.argv[2] ?? 'http://127.0.0.1:8081/v1/models';
const profile = process.argv[3] ?? 'full';

const required = {
  full: ['gemma26', 'gemmae4'],
};

function isLoaded(m) {
  if (!m?.id || m.id === 'default') {
    return false;
  }
  const s = m.status;
  if (!s) {
    return true;
  }
  if (s.failed === true) {
    return false;
  }
  if (s.value === 'loading') {
    return false;
  }
  return s.value === 'loaded';
}

try {
  const r = await fetch(url);
  if (!r.ok) {
    console.error(`router-verify-slots: HTTP ${r.status} ${url}`);
    process.exit(1);
  }
  const j = await r.json();
  const data = Array.isArray(j?.data) ? j.data : [];
  const loaded = new Set();
  const bad = [];
  for (const m of data) {
    if (!m.id || m.id === 'default') {
      continue;
    }
    if (isLoaded(m)) {
      loaded.add(m.id);
    } else {
      bad.push({ id: m.id, value: m.status?.value, failed: m.status?.failed });
    }
  }

  const need = required[profile] ?? required.full;
  const missing = need.filter((id) => !loaded.has(id));

  if (missing.length === 0) {
    console.log(`router-verify-slots: OK profile=${profile} loaded=${[...loaded].join(',')}`);
    process.exit(0);
  }

  console.error(
    `router-verify-slots: NOT_LOADED profile=${profile} missing=${missing.join(',')} bad=${JSON.stringify(bad)}`,
  );
  process.exit(2);
} catch (e) {
  console.error('router-verify-slots:', e);
  process.exit(1);
}
