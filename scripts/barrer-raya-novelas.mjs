// Barre un repo de novelas con el validador de raya (los `.html` ya escritos
// con raya) y con el converter (los `.docx` en borrador, vía pandoc), y
// cuenta qué marca cada regla con una muestra por regla. Es el medidor de
// falsos positivos sobre texto real: el corpus de `run-raya-corpus-smoke.mjs`
// se alimenta de lo que sale raro acá. Uso:
//   node scripts/barrer-raya-novelas.mjs ~/novelas [--muestras 8]
// Las sagas en inglés (`saga.json` → `idioma: en`) y `extras/` se saltean.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2];
if (!root) { console.error('uso: node scripts/barrer-raya-novelas.mjs <repo de novelas> [--muestras N]'); process.exit(2); }
const muestras = Number(process.argv[process.argv.indexOf('--muestras') + 1]) || 5;

const out = mkdtempSync(join(tmpdir(), 'raya-barrido-'));
const r = spawnSync(join(repo, 'node_modules/.bin/tsc'), [
  '--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict', '--skipLibCheck', '--outDir', out,
  'src/app/dialogos/validator.ts', 'src/app/dialogos/rules-dedicated.ts', 'src/app/dialogos/converter.ts',
  'src/app/dialogos/tags.ts', 'src/app/core/types.ts',
], { cwd: repo, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
const req = createRequire(import.meta.url);
const { convert } = req(join(out, 'dialogos/converter.js'));
const { validateRaya, htmlToPlain, nonProseSkip } = req(join(out, 'dialogos/validator.js'));
rmSync(out, { recursive: true, force: true });

const sagasEs = execFileSync('find', [root, '-maxdepth', 2, '-name', 'saga.json'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((f) => JSON.parse(readFileSync(f, 'utf8')).idioma !== 'en')
  .map(dirname);
const archivos = (ext) => sagasEs.flatMap((s) =>
  execFileSync('find', [s, '-name', `*.${ext}`, '-not', '-path', '*/extras/*'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean));

const por = {};
const anotar = (regla, archivo, texto, at) => {
  (por[regla] ??= []).push(`[${archivo.replace(root, '').replace(/^\//, '')}] …${texto.slice(Math.max(0, at - 60), at + 60).replace(/\n/g, '⏎')}…`);
};

// 1. Validador sobre lo ya escrito con raya.
const htmls = archivos('html');
let parrafos = 0;
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  const plain = htmlToPlain(html);
  parrafos += plain.split('\n\n').length;
  for (const v of validateRaya(plain, 'es', nonProseSkip(html))) anotar(v.ruleId, f, plain, v.offset);
}
console.log(`## Validador: ${htmls.length} .html, ${parrafos} párrafos`);
for (const [k, xs] of Object.entries(por).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(xs.length).padStart(5)}  ${k}`);
  for (const x of xs.slice(0, muestras)) console.log(`         ${x}`);
}

// 2. Converter sobre los borradores .docx (si hay pandoc).
const docxs = archivos('docx');
const pandoc = ['/opt/homebrew/bin/pandoc', '/usr/local/bin/pandoc', '/usr/bin/pandoc'].find(existsSync) ?? 'pandoc';
if (docxs.length) {
  const cats = { sinConvertir: [], residuo: [], ok: 0 };
  let total = 0;
  const vistos = new Set();
  for (const f of docxs) {
    let html;
    try { html = execFileSync(pandoc, ['--wrap=none', '-t', 'html', f], { encoding: 'utf8' }); } catch { console.error(`pandoc falló con ${f}`); continue; }
    for (const m of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
      for (const linea of m[1].split(/<br\s*\/?>/)) {
        const l = linea.replace(/\s*\n\s*/g, ' ').trim();
        if (!/[“"«]/.test(l) || vistos.has(l)) continue;
        vistos.add(l);
        total += 1;
        const conv = convert(l).text;
        // Lo que el autor obtiene: convert() y después los autofix en bloque,
        // igual que el pipeline de `run-raya-corpus-smoke.mjs`.
        let plano = conv.replace(/<[^>]+>/g, '');
        for (let i = 0; i < 5; i += 1) {
          const fixes = validateRaya(plano, 'es').filter((v) => v.autoFix && !v.autoFix.manual && v.ruleId !== 'pending-conversion').map((v) => v.autoFix);
          if (!fixes.length) break;
          let end = Infinity;
          for (const x of fixes.sort((a, b) => b.offset - a.offset)) {
            if (x.offset + x.length > end) continue;
            plano = plano.slice(0, x.offset) + x.replacement + plano.slice(x.offset + x.length);
            end = x.offset;
          }
        }
        const viol = validateRaya(plano, 'es').map((v) => v.ruleId).filter((id) => id !== 'pending-conversion');
        if (conv === l) cats.sinConvertir.push(`[${f.replace(root, '')}] ${l.slice(0, 140)}`);
        else if (viol.length) cats.residuo.push(`[${viol.join(' ')}] ${plano.slice(0, 140)}`);
        else cats.ok += 1;
      }
    }
  }
  console.log(`\n## Converter: ${docxs.length} .docx, ${total} párrafos con comillas, ${cats.ok} convierten limpio`);
  for (const k of ['sinConvertir', 'residuo']) {
    console.log(`${String(cats[k].length).padStart(5)}  ${k}`);
    for (const x of cats[k].slice(0, muestras)) console.log(`         ${x}`);
  }
}
