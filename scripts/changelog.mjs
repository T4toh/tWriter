#!/usr/bin/env node
// El CHANGELOG.md de la raíz, en formato Keep a Changelog 1.1.0, con
// versiones SemVer. Tres comandos:
//
//   node scripts/changelog.mjs siguiente patch|minor|major|auto
//     Imprime la versión que sigue a la última del changelog. `auto` elige el
//     nivel por lo que hay en [Unreleased] (ver `nivelMinimo`).
//
//   node scripts/changelog.mjs cerrar 0.23.0 [2026-10-01]
//     [Unreleased] pasa a «## [0.23.0] - fecha», arriba se abre una vacía y
//     se actualizan los links de comparación. Falla sin escribir nada si
//     [Unreleased] está vacía, si tiene un tipo que no es de Keep a Changelog,
//     o si la versión es más chica de lo que pide su contenido (un patch con
//     algo en Added). Lo llama bump-version.sh.
//
//   node scripts/changelog.mjs extraer v0.23.0
//     Imprime el cuerpo de esa versión. Lo usa release.yml para el borrador.
//     Sin sección para esa versión no imprime nada y sale bien: el release
//     no se corta por el changelog.
//
// La lógica son funciones puras; el smoke es run-changelog-smoke.mjs.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = 'https://github.com/T4toh/tWriter';
const UNRELEASED = '## [Unreleased]';
/** Los tipos de Keep a Changelog, en su orden. */
export const TIPOS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const VERSION_RE = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}\s*$/;

/** Las secciones de nivel 2 (`## …`), con dónde empieza y termina cada una. */
function secciones(md) {
  const lineas = md.split('\n');
  const out = [];
  lineas.forEach((l, i) => {
    if (l.startsWith('## ')) {
      if (out.length) out[out.length - 1].fin = i;
      out.push({ titulo: l, inicio: i, fin: lineas.length });
    }
  });
  // La última sección termina donde empiezan los links de comparación.
  const ult = out[out.length - 1];
  if (ult) {
    const link = lineas.findIndex((l, i) => i > ult.inicio && /^\[[^\]]+\]: /.test(l));
    if (link !== -1) ult.fin = link;
  }
  return { lineas, out };
}

/** La última versión publicada del changelog, como `[major, minor, patch]`. */
export function ultimaVersion(md) {
  for (const l of md.split('\n')) {
    const m = VERSION_RE.exec(l);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

/** Los tipos (`### Added`, …) de [Unreleased] que tienen al menos un ítem. */
export function tiposSinPublicar(md) {
  const { lineas, out } = secciones(md);
  const s = out.find((x) => x.titulo.trim() === UNRELEASED);
  if (!s) throw new Error(`no hay «${UNRELEASED}» en CHANGELOG.md`);
  const tipos = [];
  let actual = null;
  for (const l of lineas.slice(s.inicio + 1, s.fin)) {
    const h = /^### (.+?)\s*$/.exec(l);
    if (h) {
      actual = h[1];
      if (!TIPOS.includes(actual)) {
        throw new Error(`«### ${actual}» no es un tipo de Keep a Changelog (${TIPOS.join(', ')})`);
      }
    } else if (/^\s*[-*] \S/.test(l)) {
      if (!actual) throw new Error('hay ítems en [Unreleased] fuera de un «### Tipo»');
      if (!tipos.includes(actual)) tipos.push(actual);
    }
  }
  return tipos;
}

/** El nivel mínimo de bump que pide SemVer para esos tipos. Desde 1.0 un
 *  Removed rompe compatibilidad y pide major; en 0.x alcanza con minor. */
export function nivelMinimo(tipos, major) {
  if (major >= 1 && tipos.includes('Removed')) return 'major';
  if (tipos.some((t) => ['Added', 'Changed', 'Deprecated', 'Removed'].includes(t))) return 'minor';
  return 'patch';
}

const NIVELES = ['patch', 'minor', 'major'];

export function siguiente([ma, mi, pa], nivel) {
  if (nivel === 'major') return `${ma + 1}.0.0`;
  if (nivel === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/** Qué nivel es pasar de `prev` a `next`, o null si no es un paso SemVer válido. */
function nivelDe([ma, mi, pa], next) {
  const [a, b, c] = next.split('.').map(Number);
  if (a === ma + 1 && b === 0 && c === 0) return 'major';
  if (a === ma && b === mi + 1 && c === 0) return 'minor';
  if (a === ma && b === mi && c === pa + 1) return 'patch';
  return null;
}

export function cerrar(md, version, fecha) {
  const tipos = tiposSinPublicar(md);
  if (!tipos.length) {
    throw new Error(`[Unreleased] está vacía: sumá qué cambia en ${version} antes de cortar el release`);
  }
  const prev = ultimaVersion(md);
  if (prev) {
    const nivel = nivelDe(prev, version);
    if (!nivel) {
      throw new Error(`${version} no sigue a ${prev.join('.')} (SemVer: X.Y.Z+1, X.Y+1.0 o X+1.0.0)`);
    }
    const minimo = nivelMinimo(tipos, prev[0]);
    if (NIVELES.indexOf(nivel) < NIVELES.indexOf(minimo)) {
      throw new Error(
        `${version} es un ${nivel}, pero [Unreleased] tiene ${tipos.join(', ')}: pide ${minimo} (${siguiente(prev, minimo)})`,
      );
    }
  }
  const { lineas, out } = secciones(md);
  const s = out.find((x) => x.titulo.trim() === UNRELEASED);
  lineas.splice(s.inicio, 1, UNRELEASED, '', `## [${version}] - ${fecha}`);
  // Links: [unreleased] compara contra la versión nueva, y la nueva contra la anterior.
  const i = lineas.findIndex((l) => /^\[unreleased\]: /i.test(l));
  const nuevo = prev
    ? `[${version}]: ${REPO}/compare/v${prev.join('.')}...v${version}`
    : `[${version}]: ${REPO}/releases/tag/v${version}`;
  const unrel = `[unreleased]: ${REPO}/compare/v${version}...HEAD`;
  if (i === -1) lineas.push('', unrel, nuevo);
  else lineas.splice(i, 1, unrel, nuevo);
  return lineas.join('\n');
}

export function extraer(md, tag) {
  const version = tag.replace(/^v/, '');
  const { lineas, out } = secciones(md);
  const s = out.find((x) => x.titulo.startsWith(`## [${version}] `));
  if (!s) return '';
  return lineas.slice(s.inicio + 1, s.fin).join('\n').trim();
}

// Corrido como CLI (no importado por el smoke). `realpathSync` porque por un
// symlink `argv[1]` y `import.meta.url` no coinciden.
const esCli = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (esCli) {
  const archivo = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
  // Fecha local, no UTC: un release cortado de noche en Argentina no puede
  // quedar con la fecha de mañana. `sv` es el locale que formatea AAAA-MM-DD.
  const [cmd, arg, fecha = new Date().toLocaleDateString('sv')] = process.argv.slice(2);
  try {
    const md = readFileSync(archivo, 'utf8');
    if (cmd === 'siguiente' && [...NIVELES, 'auto'].includes(arg)) {
      const prev = ultimaVersion(md);
      if (!prev) throw new Error('CHANGELOG.md no tiene ninguna versión publicada');
      const nivel = arg === 'auto' ? nivelMinimo(tiposSinPublicar(md), prev[0]) : arg;
      process.stdout.write(`${siguiente(prev, nivel)}\n`);
    } else if (cmd === 'cerrar' && arg) {
      writeFileSync(archivo, cerrar(md, arg, fecha));
    } else if (cmd === 'extraer' && arg) {
      const cuerpo = extraer(md, arg);
      if (cuerpo) process.stdout.write(`${cuerpo}\n`);
    } else {
      console.error(
        'uso: changelog.mjs siguiente patch|minor|major|auto | cerrar X.Y.Z [AAAA-MM-DD] | extraer vX.Y.Z',
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(`changelog: ${e.message}`);
    process.exit(1);
  }
}
