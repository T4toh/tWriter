#!/usr/bin/env node
// Prueba de verdad de `src-tauri/lt-lock.json`: baja los jars y el JRE de esta
// plataforma, verifica cada sha256, levanta LanguageTool igual que la app
// (mismos argumentos que `lt_embebido::java_args`) y le manda un check en
// es-AR y otro en en-US que tienen que marcar. Es lo que corre
// `.github/workflows/lt-al-dia.yml` antes de abrir el PR de una versión nueva:
// si LT cambió algo que lo rompe (como el `ca`/`pt` que pide
// `CommonWordsDetector`), el PR sale en rojo.
//
// Toca red y baja ~142 MB, así que no es un smoke de funciones puras.
// Uso: node scripts/smoke-lt-lock.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(repo, 'src-tauri', 'lt-lock.json'), 'utf8'));
const target = {
  'darwin arm64': 'aarch64-apple-darwin',
  'darwin x64': 'x86_64-apple-darwin',
  'linux x64': 'x86_64-unknown-linux-gnu',
  'win32 x64': 'x86_64-pc-windows-msvc',
}[`${process.platform} ${process.arch}`];
const jre = lock.jres[target];
if (!jre) {
  console.error(`sin JRE en el lock para ${process.platform} ${process.arch}`);
  process.exit(1);
}

const CASOS = [
  { language: 'es-AR', text: 'Ella fué a la casa y vió que el perro estaban dormido.', regla: 'MONOSILABOS' },
  { language: 'en-US', text: 'She go to the store yesterday and buyed a apple.', regla: 'HE_VERB_AGR' },
];

async function bajar(url, sha256, destino) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} en ${url}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const real = createHash('sha256').update(bytes).digest('hex');
  if (real !== sha256) throw new Error(`${url}: sha256 ${real}, el lock dice ${sha256}`);
  writeFileSync(destino, bytes);
}

const puertoLibre = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const dir = mkdtempSync(join(tmpdir(), 'lt-smoke-'));
let java;
let log = '';
try {
  const libs = join(dir, 'libs');
  mkdirSync(libs);
  for (let i = 0; i < lock.jars.length; i += 8) {
    await Promise.all(lock.jars.slice(i, i + 8).map((j) => bajar(j.url, j.sha256, join(libs, j.file))));
  }
  const archivo = join(dir, jre.url.split('/').pop());
  await bajar(jre.url, jre.sha256, archivo);
  mkdirSync(join(dir, 'jre'));
  execFileSync('tar', ['-xf', archivo, '-C', join(dir, 'jre')]);
  console.log(`LT ${lock.lt} (${lock.jars.length} jars) + JRE ${lock.jre} (${target}) bajados y verificados`);

  const puerto = await puertoLibre();
  java = spawn(
    join(dir, 'jre', jre.java),
    ['-Xmx256m', '-cp', join(libs, '*'), 'org.languagetool.server.HTTPServer', '--port', String(puerto)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  java.stdout.on('data', (d) => (log += d));
  java.stderr.on('data', (d) => (log += d));

  const base = `http://127.0.0.1:${puerto}`;
  const hasta = Date.now() + 60_000;
  for (;;) {
    if (java.exitCode !== null) throw new Error('java terminó antes de contestar');
    if (await fetch(`${base}/v2/languages`).then((r) => r.ok, () => false)) break;
    if (Date.now() > hasta) throw new Error('LT no contestó en 60 s');
    await new Promise((r) => setTimeout(r, 200));
  }

  for (const { language, text, regla } of CASOS) {
    const r = await fetch(`${base}/v2/check`, { method: 'POST', body: new URLSearchParams({ language, text }) });
    const d = await r.json();
    const reglas = d.matches.map((m) => m.rule.id);
    if (!reglas.includes(regla)) throw new Error(`${language}: esperaba ${regla}, marcó ${reglas.join(', ') || 'nada'}`);
    console.log(`  ok — ${language} marca ${regla} (LT ${d.software.version})`);
  }
} catch (e) {
  console.error(`FALLÓ: ${e.message}`);
  if (log) console.error(log.split('\n').filter(Boolean).slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  java?.kill();
  rmSync(dir, { recursive: true, force: true });
}
