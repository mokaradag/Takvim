import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyLogoSource, companyLogoResponse } from '../src/server/branding/companyLogo.js';

test('kurum logosu UNC, yerel SVG ve eski URL ayarlarını destekler', () => {
  const path = String.raw`\\server\paylasim\Kurum Logo\white\logo.svg`;
  assert.deepEqual(companyLogoSource({ MERGEN_ROTA_COMPANY_LOGO_PATH: path }), { path });
  assert.deepEqual(companyLogoSource({ NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL: path }), { path });
  assert.deepEqual(companyLogoSource({ NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL: 'https://example.test/logo.svg' }), { url: 'https://example.test/logo.svg' });
  assert.equal(companyLogoSource({ MERGEN_ROTA_COMPANY_LOGO_PATH: 'javascript:alert(1)' }), null);
});

test('kurum SVG dosyası oranını koruyan görüntü türüyle sunulur; dosya yolu açıklanmaz', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'company-logo-'));
  try {
    const path = join(dir, 'logo.svg');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 80"><rect width="400" height="80" fill="white"/></svg>';
    await writeFile(path, svg);
    const response = await companyLogoResponse({ MERGEN_ROTA_COMPANY_LOGO_PATH: path });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await response.text(), svg);
    const missing = await companyLogoResponse({ MERGEN_ROTA_COMPANY_LOGO_PATH: join(dir, 'missing.svg') });
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), '');
    const url = await companyLogoResponse({ NEXT_PUBLIC_MERGEN_ROTA_COMPANY_LOGO_URL: 'https://example.test/logo.svg' });
    assert.equal(url.status, 307);
    assert.equal(url.headers.get('location'), 'https://example.test/logo.svg');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
