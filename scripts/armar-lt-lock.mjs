#!/usr/bin/env node
// Arma `src-tauri/lt-lock.json`: la lista de lo que tWriter baja para correr
// LanguageTool sin Docker. Son los jars de LT ya compilados (Maven Central) y
// un JRE de Temurin por target (Adoptium), cada uno con su sha256. La app la
// compila adentro con `include_str!` y no ejecuta nada que no esté ahí.
//
// Maven solo hace falta en la máquina que corre este script, para resolver el
// cierre de dependencias de `scripts/lt/pom.xml`; la app no lo usa. Corre a
// mano o desde `.github/workflows/lt-al-dia.yml`, nunca en build time, y su
// salida se commitea (mismo criterio que podar-tesauro-en.mjs).
//
// Regla de supply chain: no elige ninguna versión de LT ni de JRE publicada
// hace menos de 7 días. Si la última es más nueva, toma la anterior.
//
// Uso: node scripts/armar-lt-lock.mjs [--lt <versión>|--lt latest]
//   Sin --lt usa la versión que ya tiene el pom.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIETE_DIAS = 7 * 24 * 60 * 60 * 1000;
const MAVEN = 'https://repo1.maven.org/maven2';
const ADOPTIUM = 'https://api.adoptium.net/v3/assets/feature_releases/21/ga';
/** Triple de Rust → os/arch de Adoptium. */
const TARGETS = {
  'aarch64-apple-darwin': { os: 'mac', arch: 'aarch64' },
  'x86_64-apple-darwin': { os: 'mac', arch: 'x64' },
  'x86_64-unknown-linux-gnu': { os: 'linux', arch: 'x64' },
  'x86_64-pc-windows-msvc': { os: 'windows', arch: 'x64' },
};

/** La versión más nueva publicada hace 7 días o más, o null si no hay. */
export function elegirVersion(candidatas, hoy) {
  const elegibles = candidatas.filter((c) => hoy - c.fecha >= SIETE_DIAS);
  elegibles.sort((a, b) => b.fecha - a.fecha);
  return elegibles[0]?.version ?? null;
}

/** Ruta del `java` dentro del archivo de Temurin, relativa a donde se extrae. */
export function rutaJava(releaseName, target) {
  const raiz = `${releaseName}-jre`;
  if (target.includes('apple-darwin')) return `${raiz}/Contents/Home/bin/java`;
  if (target.includes('windows')) return `${raiz}/bin/java.exe`;
  return `${raiz}/bin/java`;
}

async function pedir(url, como = 'text') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} en ${url}`);
  return como === 'bytes' ? Buffer.from(await r.arrayBuffer()) : r[como]();
}

async function versionLtLatest(hoy) {
  const meta = await pedir(`${MAVEN}/org/languagetool/languagetool-server/maven-metadata.xml`);
  const versiones = [...meta.matchAll(/<version>([\d.]+)<\/version>/g)].map((m) => m[1]).slice(-5);
  const candidatas = [];
  for (const version of versiones) {
    const r = await fetch(`${MAVEN}/org/languagetool/languagetool-server/${version}/languagetool-server-${version}.pom`, { method: 'HEAD' });
    if (r.ok) candidatas.push({ version, fecha: new Date(r.headers.get('last-modified')) });
  }
  const v = elegirVersion(candidatas, hoy);
  if (!v) throw new Error('ninguna versión de LT tiene 7 días o más');
  return v;
}

/** Los jars del cierre de runtime del pom, como coordenadas de Maven. */
function cierreDeDependencias(dirPom) {
  const tmp = mkdtempSync(join(tmpdir(), 'lt-lock-'));
  const salida = join(tmp, 'deps.txt');
  try {
    execFileSync('mvn', ['-q', 'dependency:list', '-DincludeScope=runtime', `-DoutputFile=${salida}`], { cwd: dirPom, stdio: 'inherit' });
    return [...readFileSync(salida, 'utf8').matchAll(/^\s+([^:\s]+):([^:\s]+):jar:([^:\s]+):(?:compile|runtime)/gm)]
      .map(([, grupo, artefacto, version]) => ({ grupo, artefacto, version }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function jarDelLock({ grupo, artefacto, version }) {
  const file = `${artefacto}-${version}.jar`;
  const url = `${MAVEN}/${grupo.replaceAll('.', '/')}/${artefacto}/${version}/${file}`;
  const bytes = await pedir(url, 'bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Los artefactos viejos de Central no siempre traen .sha256; ahí se cruza el .sha1.
  const publicado = await fetch(`${url}.sha256`);
  if (publicado.ok) {
    const esperado = (await publicado.text()).trim().split(/\s+/)[0];
    if (esperado !== sha256) throw new Error(`${file}: sha256 publicado ${esperado}, calculado ${sha256}`);
  } else {
    const esperado = (await pedir(`${url}.sha1`)).trim().split(/\s+/)[0];
    const sha1 = createHash('sha1').update(bytes).digest('hex');
    if (esperado !== sha1) throw new Error(`${file}: sha1 publicado ${esperado}, calculado ${sha1}`);
  }
  return { url, file, sha256, size: bytes.length };
}

/** El JRE 21 más nuevo elegible que esté publicado para los cuatro targets. */
async function jres(hoy) {
  const porTarget = {};
  for (const [target, { os, arch }] of Object.entries(TARGETS)) {
    const lista = await pedir(`${ADOPTIUM}?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse&page_size=10`, 'json');
    porTarget[target] = new Map(lista.map((r) => [r.version_data.openjdk_version.replace(/-LTS$/, ''), r]));
  }
  const [primero, ...resto] = Object.values(porTarget);
  const candidatas = [...primero.keys()]
    .filter((v) => resto.every((m) => m.has(v)))
    .map((version) => ({
      version,
      // La fecha más nueva de los cuatro: un target publicado ayer frena a todos.
      fecha: new Date(Math.max(...Object.values(porTarget).map((m) => Date.parse(m.get(version).binaries[0].updated_at)))),
    }));
  const version = elegirVersion(candidatas, hoy);
  if (!version) throw new Error('ningún JRE 21 tiene 7 días o más en los cuatro targets');
  const entradas = {};
  for (const [target, m] of Object.entries(porTarget)) {
    const r = m.get(version);
    const p = r.binaries[0].package;
    entradas[target] = { url: p.link, sha256: p.checksum, size: p.size, java: rutaJava(r.release_name, target) };
  }
  return { version, entradas };
}

async function main() {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dirPom = join(repo, 'scripts', 'lt');
  const pomPath = join(dirPom, 'pom.xml');
  const hoy = new Date();
  const i = process.argv.indexOf('--lt');
  let pom = readFileSync(pomPath, 'utf8');
  let lt = pom.match(/<lt\.version>([^<]+)<\/lt\.version>/)[1];
  if (i !== -1) {
    lt = process.argv[i + 1] === 'latest' ? await versionLtLatest(hoy) : process.argv[i + 1];
    pom = pom.replace(/<lt\.version>[^<]+<\/lt\.version>/, `<lt.version>${lt}</lt.version>`);
    writeFileSync(pomPath, pom);
  }

  const coords = cierreDeDependencias(dirPom);
  const jars = [];
  for (let j = 0; j < coords.length; j += 8) {
    jars.push(...(await Promise.all(coords.slice(j, j + 8).map(jarDelLock))));
  }
  jars.sort((a, b) => a.file.localeCompare(b.file));
  const jre = await jres(hoy);

  const lock = { lt, jre: jre.version, jars, jres: jre.entradas };
  writeFileSync(join(repo, 'src-tauri', 'lt-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const mb = (n) => (n / 1048576).toFixed(0);
  console.log(`LT ${lt}: ${jars.length} jars, ${mb(jars.reduce((s, j) => s + j.size, 0))} MB · JRE ${jre.version}`);
}

// realpath: con un symlink `argv[1]` y `import.meta.url` no coinciden.
const esCli = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (esCli) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
