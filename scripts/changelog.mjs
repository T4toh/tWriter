#!/usr/bin/env node
// El CHANGELOG.md de la raíz, para el release.
//
//   node scripts/changelog.mjs cerrar 0.23.0 [2026-10-01]
//     «## Sin publicar» pasa a «## v0.23.0 — fecha» y arriba se abre una nueva
//     vacía. Falla sin escribir nada si «Sin publicar» está vacía: un release
//     sin notas es justo el olvido que esto evita. Lo llama bump-version.sh.
//
//   node scripts/changelog.mjs extraer v0.23.0
//     Imprime el cuerpo de esa versión. Lo usa release.yml para el borrador.
//     Sin sección para esa versión no imprime nada y sale bien: el release
//     no se corta por el changelog.
//
// La lógica son dos funciones puras; el smoke es run-changelog-smoke.mjs.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SIN_PUBLICAR = '## Sin publicar';

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
  return { lineas, out };
}

export function cerrar(md, version, fecha) {
  const { lineas, out } = secciones(md);
  const s = out.find((x) => x.titulo.trim() === SIN_PUBLICAR);
  if (!s) throw new Error(`no hay «${SIN_PUBLICAR}» en CHANGELOG.md`);
  const cuerpo = lineas.slice(s.inicio + 1, s.fin);
  if (!cuerpo.some((l) => l.trim() !== '')) {
    throw new Error(
      `«${SIN_PUBLICAR}» está vacía: sumá qué cambia en v${version} antes de cortar el release`,
    );
  }
  if (out.some((x) => x.titulo.startsWith(`## v${version} `))) {
    throw new Error(`CHANGELOG.md ya tiene una sección v${version}`);
  }
  lineas.splice(s.inicio, 1, SIN_PUBLICAR, '', `## v${version} — ${fecha}`);
  return lineas.join('\n');
}

export function extraer(md, tag) {
  const version = tag.replace(/^v/, '');
  const { lineas, out } = secciones(md);
  const s = out.find((x) => x.titulo.startsWith(`## v${version} `) || x.titulo.trim() === `## v${version}`);
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
    if (cmd === 'cerrar' && arg) {
      writeFileSync(archivo, cerrar(readFileSync(archivo, 'utf8'), arg, fecha));
    } else if (cmd === 'extraer' && arg) {
      const cuerpo = extraer(readFileSync(archivo, 'utf8'), arg);
      if (cuerpo) process.stdout.write(`${cuerpo}\n`);
    } else {
      console.error('uso: changelog.mjs cerrar X.Y.Z [AAAA-MM-DD] | extraer vX.Y.Z');
      process.exit(2);
    }
  } catch (e) {
    console.error(`changelog: ${e.message}`);
    process.exit(1);
  }
}
