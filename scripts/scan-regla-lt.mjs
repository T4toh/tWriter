// Escanea un corpus de capítulos .html contra el LanguageTool local activando
// SOLO una regla, para medir hits y falsos positivos antes de aportarla upstream.
// uso: node scripts/scan-regla-lt.mjs DETRAS_PX [/ruta/al/corpus] [es-AR]
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const regla = process.argv[2];
if (!regla) {
  console.error('uso: node scripts/scan-regla-lt.mjs <RULE_ID> [corpus] [idioma]');
  process.exit(1);
}
const root = process.argv[3] ?? `${process.env.HOME}/novelas`;
const idioma = process.argv[4] ?? 'es-AR';
const LT = 'http://localhost:8081/v2/check';
const files = execSync(`find "${root}" -name '*.html'`, { encoding: 'utf8' }).trim().split('\n');

const plain = (html) => html
  .replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&[a-z]+;/g, ' ')
  .replace(/\n{2,}/g, '\n').trim();

const chunks = (txt, max = 15000) => {
  const out = [];
  for (let i = 0; i < txt.length; i += max) out.push(txt.slice(i, i + max));
  return out;
};

let total = 0, palabras = 0;
for (const f of files) {
  const txt = plain(readFileSync(f, 'utf8'));
  palabras += txt.split(/\s+/).length;
  for (const chunk of chunks(txt)) {
    const body = new URLSearchParams({
      text: chunk, language: idioma, enabledOnly: 'true', enabledRules: regla,
    });
    const res = await fetch(LT, { method: 'POST', body });
    // Los 500 esporádicos son un NPE de LT 6.8 en el desambiguador, no del corpus
    // ni de la regla: ver el item de LT en TODO.md.
    if (!res.ok) { console.error(`HTTP ${res.status} en ${f}`); continue; }
    const { matches } = await res.json();
    for (const m of matches) {
      total++;
      const ctx = m.context.text.replace(/\n/g, ' ');
      console.log(`${f.replace(root + '/', '')} | ${ctx} | → ${m.replacements.slice(0, 2).map(r => r.value).join(' / ')}`);
    }
  }
}
console.log(`\n${total} hits en ${files.length} archivos / ${palabras} palabras`);
