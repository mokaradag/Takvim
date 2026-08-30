import { publicRotaPath } from '../../lib/publicPath.js';

async function requestJson(path, init) {
  let response;
  try {
    response = await fetch(publicRotaPath(path), {
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      ...init
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: 'Sunucuya ulaşılamadı.' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      code: body?.error?.code || 'REQUEST_FAILED',
      message: body?.error?.message || 'İşlem tamamlanamadı.'
    };
  }
  return { ok: true, value: body };
}

export function submitScheduleChangeRequest(input) {
  return requestJson('/api/mergen-rota/schedule-changes', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function decideScheduleChangeRequest(requestId, decision, message = '') {
  return requestJson(`/api/mergen-rota/schedule-changes/${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ decision, message })
  });
}
