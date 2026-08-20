#!/usr/bin/env node
// Reporte de calibración del detector de repeticiones. NO es un test: corre el
// detector sobre capítulos reales y escupe densidad (hits por 1.000 palabras)
// para la grilla de perillas, más una muestra de hits con su contexto para que
// el autor diga cuáles son señal y cuáles ruido.
//
// Uso: node scripts/densidad-repeticiones.mjs <dir-de-la-saga> [es|en] [--muestra N]
//
// El dir es una saga con la estructura de `Novelas/`: capítulos `<n>.html` a
// cualquier profundidad, y un `diccionario.txt` en la raíz si existe.
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dirArg, langArg = 'es', ...rest] = process.argv.slice(2);
if (!dirArg) {
  console.error('uso: node scripts/densidad-repeticiones.mjs <dir-de-la-saga> [es|en] [--muestra N]');
  process.exit(2);
}
const muestraIdx = rest.indexOf('--muestra');
const muestraN = muestraIdx >= 0 ? Number(rest[muestraIdx + 1]) : 15;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'rep-densidad-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--strict', '--skipLibCheck', '--esModuleInterop',
    '--allowSyntheticDefaultImports', '--outDir', outDir,
    'src/app/repeticiones/detector.ts',
    'src/app/dialogos/validator.ts',
    'src/app/dialogos/rules-dedicated.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/tags.ts',
    'src/app/core/types.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout || r.stderr);
  process.exit(r.status ?? 1);
}

const { detectRepeticiones, DEFAULTS } = await import(
  pathToFileURL(join(outDir, 'repeticiones/detector.js')).href
);
// `htmlToPlain` del validador RAE: el mismo mapeo de bloques a `\n\n` que hace
// `extractPlainText` en el editor, sin necesitar ProseMirror.
const { htmlToPlain } = await import(pathToFileURL(join(outDir, 'dialogos/validator.js')).href);

function walkHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkHtml(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out.sort();
}

const dicPath = join(dirArg, 'diccionario.txt');
const diccionario = existsSync(dicPath)
  ? readFileSync(dicPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];

const capitulos = walkHtml(dirArg).map((p) => ({
  path: p,
  plain: htmlToPlain(readFileSync(p, 'utf8')),
}));
const palabras = capitulos.reduce((n, c) => n + (c.plain.match(/\p{L}+/gu)?.length ?? 0), 0);

console.log(`saga: ${dirArg}`);
console.log(`idioma: ${langArg} · capítulos: ${capitulos.length} · palabras: ${palabras.toLocaleString('es-AR')}`);
console.log(`diccionario per-saga: ${diccionario.length} entradas\n`);

const run = (over) => {
  const opts = { ...DEFAULTS, ignorar: diccionario, ...over };
  const t0 = process.hrtime.bigint();
  const hits = capitulos.flatMap((c) =>
    detectRepeticiones(c.plain, langArg, opts).map((h) => ({ ...h, cap: c.path, plain: c.plain })),
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { hits, ms, opts };
};

console.log('densidad — hits por 1.000 palabras');
console.log('minApar. │ ventana 20 │ ventana 30 │ ventana 40 │ ventana 60');
console.log('─────────┼────────────┼────────────┼────────────┼───────────');
for (const minApariciones of [2, 3, 4]) {
  const celdas = [20, 30, 40, 60].map((ventana) => {
    const { hits } = run({ ventana, minApariciones });
    return ((hits.length / palabras) * 1000).toFixed(1).padStart(10);
  });
  console.log(`   ${String(minApariciones).padEnd(6)}│${celdas.join(' │')}`);
}

// Lo mismo pero cortando `largoMinimo`, que es la otra perilla que mueve la aguja.
console.log('\nlargoMinimo (ventana 40, minApariciones 3)');
for (const largoMinimo of [4, 5, 6]) {
  const { hits } = run({ largoMinimo });
  const d = ((hits.length / palabras) * 1000).toFixed(1);
  console.log(`  ${largoMinimo} chars → ${String(hits.length).padStart(5)} hits · ${d} por 1.000 palabras`);
}

// Cuánto saca cada excepción deliberada por su cuenta, para que la config
// granular se decida con números y no de memoria.
console.log('\nexcepciones deliberadas (ventana 40, minApariciones 3)');
const todas = { construccion: true, fraseRepetida: true, anafora: true };
const base = run({ excepciones: { construccion: false, fraseRepetida: false, anafora: false } }).hits.length;
console.log(`  sin ninguna       → ${String(base).padStart(4)} hits`);
for (const k of ['construccion', 'fraseRepetida', 'anafora']) {
  const sola = run({ excepciones: { construccion: false, fraseRepetida: false, anafora: false, [k]: true } }).hits.length;
  console.log(`  solo ${k.padEnd(14)}→ ${String(sola).padStart(4)} hits (saca ${base - sola})`);
}
console.log(`  las tres          → ${String(run({ excepciones: todas }).hits.length).padStart(4)} hits`);

const { hits, ms, opts } = run({});
console.log(`\ndefaults (${JSON.stringify({ ...opts, ignorar: `${diccionario.length} palabras` })})`);
console.log(`${hits.length} hits · ${((hits.length / palabras) * 1000).toFixed(1)} por 1.000 palabras · ${ms.toFixed(0)} ms para toda la saga`);

const porPalabra = new Map();
for (const h of hits) porPalabra.set(h.palabra, (porPalabra.get(h.palabra) ?? 0) + 1);
const top = [...porPalabra].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`\nformas más marcadas: ${top.map(([w, n]) => `${w}(${n})`).join(', ')}`);

console.log(`\nmuestra de ${muestraN} hits con contexto (uno de cada ${Math.max(1, Math.floor(hits.length / muestraN))}):`);
const paso = Math.max(1, Math.floor(hits.length / muestraN));
for (let i = 0; i < hits.length && i / paso < muestraN; i += paso) {
  const h = hits[i];
  const desde = Math.max(0, h.offsetPrevio - 30);
  const hasta = Math.min(h.plain.length, h.offset + h.length + 30);
  const ctx = h.plain.slice(desde, hasta).replace(/\n+/g, ' ⏎ ');
  console.log(`\n  ${relative(dirArg, h.cap)} · «${h.palabra}» ×${h.apariciones} a ${h.distancia} palabras`);
  console.log(`    …${ctx}…`);
}

rmSync(outDir, { recursive: true, force: true });
