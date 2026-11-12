// Kabul koşusu özeti: profil/tur başına görünen sonuç, sunum yolu, grafik/tablo ve model kaydı.
const fs = require('fs'); const path = require('path');
const { semanticFailures, completionFailures, modelFailures, replayFailures } = require('./expectations.cjs');
const dir = process.argv[2];
const manifest = path.join(dir, '..', 'run.json');
const runId = process.env.UI_RUN_ID || (fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).runId : null);
if (!runId) throw new Error('Koşu kimliği yok; önceki kanıt bu koşunun sonucu sayılamaz.');
const rows = fs.readdirSync(dir).filter((f) => /^[A-G]\.json$/.test(f)).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((row) => row.runId === runId);
const calls = rows.flatMap((r) => r.calls);
let out = '| Profil | Konuşma | Ayrıntı | Tur | Soru | Durum | Sunum | Grafik (tür:öğe) | Tablo | Model çağrısı | Düşünme | ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const r of rows) {
  const p = r.server?.presentation;
  const mode = !p ? (r.server ? `- (${r.server.outcome})` : '-') : p.mode === 'narrative' ? `anlatı (${p.reason || '-'})`
    : p.mode === 'composed' ? (p.server ? `sunucu (${p.reason}/${p.issue || '-'})` : 'model düzyazısı') : `${p.mode} (${p.reason || '-'})`;
  const charts = (r.rendered.charts || []).map((c) => `${c.type}:${c.items.length}${c.visible ? '' : '!gizli'}`).join(', ') || '—';
  out += `| ${r.profile} | ${r.conversation} | ${r.detail} | ${r.turn} | ${r.question.slice(0, 60)} | ${r.rendered.status}${r.server ? '/' + r.server.outcome : ''} | ${mode} | ${charts} | ${(r.rendered.tables || []).length} | ${r.calls.map((c) => c.purpose[0]).join('')} | ${r.calls.reduce((s, c) => s + (c.thinkingTokens || 0), 0)} | ${r.ms} |\n`;
}
const models = [...new Set(calls.flatMap((c) => c.models || []))];
out += `\nToplam tur: ${rows.length}; model çağrısı: ${calls.length} (başarısız: ${calls.filter((c) => !c.ok).length}); modeller: ${models.join(', ')}; düşünme belirteci toplamı: ${calls.reduce((s, c) => s + (c.thinkingTokens || 0), 0)}; düşünme açık çağrı: ${calls.filter((c) => c.ok && c.thinking !== 'off').length}\n`;
out += `Girdi (önbelleksiz): ${calls.reduce((s, c) => s + (c.input || 0), 0)}; önbellek yazma: ${calls.reduce((s, c) => s + (c.cacheWrite || 0), 0)}; önbellek okuma: ${calls.reduce((s, c) => s + (c.cacheRead || 0), 0)}; çıktı: ${calls.reduce((s, c) => s + (c.output || 0), 0)}\n`;
// Atlanan konuşma (gerekli sentetik veri yok) sınanmamıştır: tam kabul raporlanmaz, eksik kapsam adıyla yazılır ve koşu başarısızdır.
const skipped = rows.filter((row) => row.skipped);
if (skipped.length) out += `Kapsam eksik (sınanmadı): ${skipped.map((row) => `${row.profile}/${row.conversation} (${row.skipped})`).join(', ')}\n`;
process.stdout.write(out);
if (!rows.length || skipped.length || rows.some((row) => row.failures?.length || completionFailures(row.rendered, row.server).length || !row.server
  || semanticFailures({ outcome: row.expectedOutcome || 'grounded' }, row.rendered, row.server).length
  // Betikli satırda yalnızca canlı model gereksinimleri atlanır; sunucu yeniden yürütme sözleşmesi yine denetlenir.
  || (row.scripted ? replayFailures({ serverReplay: row.serverReplay === true }, row.server, row.calls).length
    : modelFailures({ serverReplay: row.serverReplay === true }, row.server, row.calls).length))) process.exitCode = 1;
