/**
 * SSH / 에이전트 점검용: JSON 한 줄 로그. 항상 `service` + `ts` + `level` + `event` 로 grep/jq.
 */

export const SERVICE_NAME = 'maki-llm-gateway';

/**
 * @param {string} urlStr
 * @returns {{ host: string, port: string, scheme: string } | { host: 'invalid' }} — 경로/쿼리/자격 미포함
 */
export function maskLlamaBaseUrl(urlStr) {
  try {
    const parsed = new URL(String(urlStr).replace(/\/$/, ''));
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return {
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: String(port),
    };
  } catch {
    return { host: 'invalid' };
  }
}

/**
 * @param {'info' | 'warn' | 'error'} level
 * @param {Record<string, unknown>} fields — 반드시 `event` (예: `http_request`, `llama_upstream`, `title_from_text`)
 */
export function logStructured(level, fields) {
  const row = { ts: new Date().toISOString(), service: SERVICE_NAME, level, ...fields };
  const line = JSON.stringify(row);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}
