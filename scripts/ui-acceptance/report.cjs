// Kabul koşusu özeti: profil/tur başına görünen sonuç, sunum yolu, grafik/tablo ve model kaydı.
const fs = require('fs'); const path = require('path');
const dir = process.argv[2];
const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const calls = rows.flatMap((r) => r.calls);
let out = '| Profil | Konuşma | Ayrıntı | Tur | Soru | Durum | Sunum | Grafik (tür:öğe) | Tablo | Model çağrısı | Düşünme | ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const r of rows) {
  const p = r.server?.presentation;
  const mode = !p ? (r.server ? `- (${r.server.outcome})` : '-') : p.server ? `sunucu (${p.reason}/${p.issue || '-'})` : `model düzyazısı`;
  const charts = (r.rendered.charts || []).map((c) => `${c.type}:${c.items.length}${c.visible ? '' : '!gizli'}`).join(', ') || '—';
  out += `| ${r.profile} | ${r.conversation} | ${r.detail} | ${r.turn} | ${r.question.slice(0, 60)} | ${r.rendered.status}${r.server ? '/' + r.server.outcome : ''} | ${mode} | ${charts} | ${(r.rendered.tables || []).length} | ${r.calls.map((c) => c.purpose[0]).join('')} | ${r.calls.reduce((s, c) => s + (c.thinkingTokens || 0), 0)} | ${r.ms} |\n`;
}
const models = [...new Set(calls.flatMap((c) => c.models || []))];
out += `\nToplam tur: ${rows.length}; model çağrısı: ${calls.length} (başarısız: ${calls.filter((c) => !c.ok).length}); modeller: ${models.join(', ')}; düşünme belirteci toplamı: ${calls.reduce((s, c) => s + (c.thinkingTokens || 0), 0)}; düşünme açık çağrı: ${calls.filter((c) => c.thinking !== 'off').length}\n`;
out += `Girdi (önbelleksiz): ${calls.reduce((s, c) => s + (c.input || 0), 0)}; önbellek yazma: ${calls.reduce((s, c) => s + (c.cacheWrite || 0), 0)}; önbellek okuma: ${calls.reduce((s, c) => s + (c.cacheRead || 0), 0)}; çıktı: ${calls.reduce((s, c) => s + (c.output || 0), 0)}\n`;
process.stdout.write(out);
