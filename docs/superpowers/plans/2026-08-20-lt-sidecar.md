# LT Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la gramática funcione sin que el autor instale ni levante nada: la app baja un LanguageTool recortado con su propio JRE a `app_data_dir` y lo corre como proceso hijo.

**Architecture:** Un módulo nuevo `src-tauri/src/sidecar.rs` maneja instalación (descarga → verificación sha256 → extracción) y ciclo de vida del proceso (puerto libre → spawn → health poll → kill). `grammar.rs` cambia una sola cosa: `resolve_base` deja de devolver el `http://localhost:8081` hardcodeado para el modo `local` y pregunta primero si el sidecar está arriba. El código de Docker no se toca en esta vuelta.

**Tech Stack:** Rust (Tauri 2, reqwest + feature `stream`, crate `zip` ya presente, `sha2` nuevo), Node para el script de armado, Angular 21 con signals para el modal.

**Spec:** `docs/superpowers/specs/2026-08-20-lt-sidecar-design.md`

## Global Constraints

- **Solo `x86_64-unknown-linux-gnu`** en esta vuelta. macOS y Windows son un PR posterior.
- **No tocar el código de Docker de `grammar.rs`.** Ni borrarlo, ni refactorizarlo. Se borra en el PR siguiente, después de la verificación manual del autor.
- **Orden de resolución del endpoint**: `mode == "custom"` (URL manual) gana siempre → sidecar → container Docker. En la práctica el `mode` ya da los dos extremos; solo hay que hacer dinámico el `local`.
- **`-Xmx256m`** exacto. Medido contra el peor caso (chunk de 20 KB): 154 matches, 2,45 s, RSS 538 MB, cero OOM.
- **La verificación de sha256 es obligatoria y va ANTES de extraer.** Si no coincide: borrar la descarga, no extraer nada, abortar con mensaje accionable.
- **Formato del bundle: `.zip`** (el crate `zip` ya está en `Cargo.toml`; `tar.gz` pediría `tar` + `flate2` por 1 MB de diferencia).
- **Nunca 8081 hardcodeado para el sidecar.** El autor ya corre un LT propio en `:8010` y puede tener el container en `:8081`. Buscar puerto libre desde 8081 hacia arriba.
- **Convenciones del repo**: standalone components, signals, `@if`/`@for`, sin sufijo `Component`, sin `public` explícito, return types explícitos, `inject()`. Nombres de dominio y UI en español.
- **`sha2 = "0.11"`** — verificado el 2026-08-20 contra la regla de supply chain: publicada 2026-03-25 (148 días), repo `github.com/RustCrypto/hashes`, 857M descargas.
- **Salida del script de armado NO se commitea** (igual que `podar-tesauro-en.mjs`).
- Los smoke runners de `scripts/` solo pueden importar **funciones puras** — nada que toque DOM, `@tiptap/core` ni el schema de ProseMirror.

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `scripts/lt-sidecar-poda.mjs` | **Puro.** Dada una lista de paths del zip de LT, decide qué borrar. Sin IO. |
| `scripts/run-lt-sidecar-smoke.mjs` | Smoke runner de la poda. |
| `scripts/armar-lt-sidecar.mjs` | Mitad con IO: baja, aplica la poda, corre `jlink`, empaqueta, calcula sha256. |
| `src-tauri/src/sidecar.rs` | Módulo nuevo. Rutas de instalación, sha256, puerto libre, args de spawn, descarga, extracción, ciclo de vida, comandos Tauri. |
| `src-tauri/src/grammar.rs` | **Un solo cambio**: `resolve_base` consulta al sidecar para el modo `local`. |
| `src-tauri/src/lib.rs` | Registrar `mod sidecar`, los comandos nuevos, y el hook de salida que mata el proceso. |
| `src-tauri/Cargo.toml` | `sha2` nuevo, feature `stream` en `reqwest`. |
| `src/app/core/sidecar-service.ts` | Wrapper de los invokes, expone signals de estado. |
| `src/app/grammar/grammar-modal.ts` | Botones de instalar/actualizar + progreso. |
| `.github/workflows/lt-sidecar.yml` | Workflow manual (`workflow_dispatch`) que arma y publica el bundle. |

`sidecar.rs` va a quedar en ~400 líneas. Si pasa de 600, partir en `sidecar/instalacion.rs` + `sidecar/proceso.rs`.

---

### Task 1: Poda pura del bundle + smoke runner

**Files:**
- Create: `scripts/lt-sidecar-poda.mjs`
- Create: `scripts/run-lt-sidecar-smoke.mjs`

**Interfaces:**
- Consumes: nada.
- Produces: `decidirPoda(paths: string[], idiomas: string[]) => { borrar: string[], conservar: string[] }`, y las constantes `JARS_A_BORRAR: string[]`, `MODULOS_JLINK: string[]`.

- [ ] **Step 1: Write the failing test**

Crear `scripts/run-lt-sidecar-smoke.mjs`:

```js
// Smoke runner de la poda del bundle de LT. Función pura: no toca red ni disco
// del bundle real, así que corre en node sin más.
import { decidirPoda, JARS_A_BORRAR, MODULOS_JLINK } from './lt-sidecar-poda.mjs';

let ok = 0;
let fail = 0;

function check(nombre, cond, detalle = '') {
  if (cond) {
    ok++;
  } else {
    fail++;
    console.error(`  FAIL ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const paths = [
  'org/languagetool/rules/es/grammar.xml',
  'org/languagetool/rules/es/ConfusionCheckFilter.class',
  'org/languagetool/rules/en/grammar.xml',
  'org/languagetool/rules/ar/grammar.xml',
  'org/languagetool/rules/ar/ArabicHunspellSpellerRule.class',
  'org/languagetool/rules/de/grammar.xml',
  'org/languagetool/resource/ar/common_words.txt',
  'org/languagetool/resource/de/common_words.txt',
  'org/languagetool/resource/de/hunspell/de_DE.dict',
  'libs/spanish-pos-dict.jar',
  'libs/english-pos-dict.jar',
  'libs/dutch-pos-dict.jar',
  'libs/hanlp.jar',
  'libs/grpc-netty-shaded.jar',
  'libs/mybatis.jar',
  'languagetool-server.jar',
];

const { borrar, conservar } = decidirPoda(paths, ['en', 'es']);
const b = new Set(borrar);
const c = new Set(conservar);

// Datos de idiomas ajenos: se van.
check('borra datos de ar', b.has('org/languagetool/rules/ar/grammar.xml'));
check('borra datos de de', b.has('org/languagetool/resource/de/hunspell/de_DE.dict'));

// Las clases de idiomas ajenos SE CONSERVAN: Languages.getAllLanguages() las
// instancia todas al arrancar y sin ellas explota con NoClassDefFoundError.
check(
  'CONSERVA .class de ar',
  c.has('org/languagetool/rules/ar/ArabicHunspellSpellerRule.class'),
  'borrarlas rompe el arranque',
);

// common_words.txt de TODOS los idiomas: LanguageIdentifier los lee eager.
check('CONSERVA common_words de ar', c.has('org/languagetool/resource/ar/common_words.txt'));
check('CONSERVA common_words de de', c.has('org/languagetool/resource/de/common_words.txt'));

// Idiomas que sí queremos: intactos.
check('conserva es', c.has('org/languagetool/rules/es/grammar.xml'));
check('conserva en', c.has('org/languagetool/rules/en/grammar.xml'));
check('conserva clase es', c.has('org/languagetool/rules/es/ConfusionCheckFilter.class'));

// pos-dicts: solo es + en.
check('borra dutch-pos-dict', b.has('libs/dutch-pos-dict.jar'));
check('conserva spanish-pos-dict', c.has('libs/spanish-pos-dict.jar'));
check('conserva english-pos-dict', c.has('libs/english-pos-dict.jar'));

// Jars grandes de idiomas que no usamos.
check('borra hanlp', b.has('libs/hanlp.jar'));

// Jars que parecen premium pero el arranque los toca.
check('CONSERVA grpc-netty-shaded', c.has('libs/grpc-netty-shaded.jar'), 'el arranque lo necesita');
check('CONSERVA mybatis', c.has('libs/mybatis.jar'), 'el arranque lo necesita');

// Nada fuera de org/ y libs/ se toca.
check('conserva el server jar', c.has('languagetool-server.jar'));

// Invariantes generales.
check('borrar y conservar no se solapan', borrar.every((p) => !c.has(p)));
check('cubre todos los paths', borrar.length + conservar.length === paths.length);
check('jlink lleva 19 modulos', MODULOS_JLINK.length === 19, `son ${MODULOS_JLINK.length}`);
check('jlink incluye jdk.httpserver', MODULOS_JLINK.includes('jdk.httpserver'));
check('JARS_A_BORRAR no incluye mybatis', !JARS_A_BORRAR.includes('mybatis.jar'));

console.log(`\nlt-sidecar-poda: ${ok} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/run-lt-sidecar-smoke.mjs`
Expected: FAIL — `Cannot find module './lt-sidecar-poda.mjs'`

- [ ] **Step 3: Write minimal implementation**

Crear `scripts/lt-sidecar-poda.mjs`:

```js
// Decide qué se borra del zip de LanguageTool para dejar solo es+en.
// Función PURA: recibe la lista de paths y devuelve la partición. La mitad con
// IO vive en `armar-lt-sidecar.mjs`.
//
// TRES TRAMPAS VERIFICADAS — si las "optimizás", el server no arranca:
//
// 1. Los `.class` de los otros idiomas SE CONSERVAN.
//    `Languages.getAllLanguages()` instancia todos los idiomas al arrancar y
//    tira `NoClassDefFoundError: ArabicHunspellSpellerRule` si faltan. Trimear
//    `META-INF/org/languagetool/language-module.properties` NO alcanza.
//    Cuesta 2,6 MB contra 219 MB de datos: conservarlas es gratis.
// 2. `common_words.txt` de TODOS los idiomas se conserva.
//    `LanguageIdentifier` los lee eager al construirse.
// 3. `grpc-netty-shaded`, `mybatis` y `lettuce` NO se borran, aunque parezcan
//    solo de premium: el arranque los toca
//    (`NoClassDefFoundError: org/apache/ibatis/...`).

/** Jars de idiomas o motores que no usamos. Todos verificados como borrables. */
export const JARS_A_BORRAR = [
  'lucene-gosen-ipadic.jar', // japonés
  'hanlp.jar', // chino
  'languagetool-ga-dicts.jar', // irlandés
  'morfologik-ukrainian-lt.jar',
  'morfologik-crh-lt.jar', // tártaro de Crimea
];

/** Módulos del JRE de `jlink`. Verificado que con estos 19 el server arranca y chequea. */
export const MODULOS_JLINK = [
  'java.base',
  'java.desktop',
  'java.logging',
  'java.management',
  'java.naming',
  'java.net.http',
  'java.prefs',
  'java.rmi',
  'java.scripting',
  'java.security.jgss',
  'java.sql',
  'java.transaction.xa',
  'java.xml',
  'java.xml.crypto',
  'jdk.crypto.ec',
  'jdk.unsupported',
  'jdk.httpserver',
  'java.instrument',
  'jdk.zipfs',
];

/** Archivos que se conservan siempre, sea cual sea el idioma del directorio. */
const SIEMPRE = ['.class', 'common_words.txt'];

/** `org/languagetool/{rules,resource}/<lang>/...` → `<lang>`, o null. */
function idiomaDe(path) {
  const m = /^org\/languagetool\/(?:rules|resource)\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

function esPosDictAjeno(path, idiomas) {
  const m = /^libs\/([a-z]+)-pos-dict\.jar$/.exec(path);
  if (!m) return false;
  const porIdioma = { es: 'spanish', en: 'english' };
  const permitidos = idiomas.map((l) => porIdioma[l]).filter(Boolean);
  return !permitidos.includes(m[1]);
}

/**
 * Parte los paths en lo que se borra y lo que se conserva.
 * @param {string[]} paths lista de paths relativos a la raíz del zip
 * @param {string[]} idiomas códigos a conservar, ej `['en','es']`
 */
export function decidirPoda(paths, idiomas) {
  const borrar = [];
  const conservar = [];
  for (const p of paths) {
    if (SIEMPRE.some((suf) => p.endsWith(suf))) {
      conservar.push(p);
      continue;
    }
    const lang = idiomaDe(p);
    if (lang !== null && !idiomas.includes(lang)) {
      borrar.push(p);
      continue;
    }
    if (esPosDictAjeno(p, idiomas)) {
      borrar.push(p);
      continue;
    }
    if (JARS_A_BORRAR.includes(p.replace(/^libs\//, '')) && p.startsWith('libs/')) {
      borrar.push(p);
      continue;
    }
    conservar.push(p);
  }
  return { borrar, conservar };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/run-lt-sidecar-smoke.mjs`
Expected: PASS — `lt-sidecar-poda: 18 ok, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add scripts/lt-sidecar-poda.mjs scripts/run-lt-sidecar-smoke.mjs
git commit -m "feat(sidecar): poda pura del bundle de LT con smoke runner"
```

---

### Task 2: Script de armado del bundle

**Files:**
- Create: `scripts/armar-lt-sidecar.mjs`
- Create: `.github/workflows/lt-sidecar.yml`
- Modify: `CLAUDE.md` (sección Comandos — sumar el script)

**Interfaces:**
- Consumes: `decidirPoda`, `JARS_A_BORRAR`, `MODULOS_JLINK` de Task 1.
- Produces: un `lt-sidecar-<version>-x86_64-unknown-linux-gnu.zip` y un `.sha256` en `dist-sidecar/`, más un `manifest.json`.

Este task no tiene test automático: toca red y necesita un JDK completo. Se valida corriéndolo. La lógica testeable ya está en Task 1.

- [ ] **Step 1: Escribir el script**

Crear `scripts/armar-lt-sidecar.mjs`:

```js
#!/usr/bin/env node
// Arma el bundle del sidecar de LanguageTool: LT recortado a es+en + un JRE
// mínimo de `jlink`, empaquetado en un zip con su sha256.
//
// COMPILA DEL TAG, no baja un zip. LanguageTool dejó de publicar zips después
// de 6.6 (el directorio de descargas termina ahí y `stable.zip` es de
// 2025-03-27); v6.7 y v6.8 existen solo como tags de fuente. Bajar el zip nos
// dejaría clavados en 6.6 para siempre.
//
// Corre EN CI o a mano, nunca en build time. Su salida NO se commitea (mismo
// criterio que `podar-tesauro-en.mjs`).
//
// Requiere: JDK 17+ completo en PATH (`jlink` no viene en un JRE) y Maven.
// Los dos vienen en `ubuntu-24.04` de GitHub Actions.
//
// Uso: node scripts/armar-lt-sidecar.mjs [--tag v6.8] [--salida dist-sidecar]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decidirPoda, MODULOS_JLINK } from './lt-sidecar-poda.mjs';

const REPO_LT = 'https://github.com/languagetool-org/languagetool.git';
const TAG_DEFAULT = 'v6.8';
const TARGET = 'x86_64-unknown-linux-gnu';
const IDIOMAS = ['en', 'es'];

function arg(nombre, def) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : def;
}
const TAG = arg('--tag', TAG_DEFAULT);
const SALIDA = arg('--salida', 'dist-sidecar');
const TMP = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'lt-sidecar-'));

function log(msg) {
  console.log(`[armar-lt-sidecar] ${msg}`);
}

function clonarTag() {
  const dest = path.join(TMP, 'src');
  log(`clonando ${TAG} (shallow)`);
  execFileSync('git', ['clone', '--depth', '1', '--branch', TAG, REPO_LT, dest], {
    stdio: 'inherit',
  });
  return dest;
}

/**
 * Compila el módulo standalone. El assembly declara los formatos `zip` y
 * `dir` con finalName `LanguageTool-<version>`, así que la salida queda
 * exploded en `languagetool-standalone/target/LanguageTool-<version>/` y no
 * hay que descomprimir nada.
 * @returns el path de ese directorio
 */
async function compilar(src) {
  log('compilando languagetool-standalone (tarda: arrastra core + todos los idiomas)');
  execFileSync('./build.sh', ['languagetool-standalone', 'clean', 'package', '-DskipTests'], {
    cwd: src,
    stdio: 'inherit',
  });
  const target = path.join(src, 'languagetool-standalone', 'target');
  const dirs = await fs.readdir(target, { withFileTypes: true });
  const d = dirs.find((e) => e.isDirectory() && /^LanguageTool-\d/.test(e.name));
  if (!d) throw new Error(`no encontré LanguageTool-<version>/ en ${target}`);
  return path.join(target, d.name);
}

async function listarArchivos(raiz) {
  const out = [];
  async function caminar(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await caminar(p);
      else out.push(path.relative(raiz, p));
    }
  }
  await caminar(raiz);
  return out;
}

async function podar(raiz) {
  const paths = await listarArchivos(raiz);
  const { borrar, conservar } = decidirPoda(paths, IDIOMAS);
  let bytes = 0;
  for (const rel of borrar) {
    const p = path.join(raiz, rel);
    bytes += (await fs.stat(p)).size;
    await fs.rm(p);
  }
  log(`poda: ${borrar.length} archivos borrados (${(bytes / 1e6).toFixed(0)} MB), ${conservar.length} conservados`);
}

function armarJre(destino) {
  log('armando JRE con jlink');
  execFileSync(
    'jlink',
    [
      '--add-modules',
      MODULOS_JLINK.join(','),
      '--strip-debug',
      '--no-header-files',
      '--no-man-pages',
      '--compress=zip-6',
      '--output',
      destino,
    ],
    { stdio: 'inherit' },
  );
}

function empaquetar(cwd, zipDest) {
  log(`empaquetando ${zipDest}`);
  execFileSync('zip', ['-qr', '-6', zipDest, 'lt', 'jre'], { cwd, stdio: 'inherit' });
}

async function sha256De(archivo) {
  const h = createHash('sha256');
  h.update(await fs.readFile(archivo));
  return h.digest('hex');
}

// ── main ──
const src = clonarTag();
const dist = await compilar(src);
const version = path.basename(dist).replace('LanguageTool-', '');
log(`versión de LanguageTool: ${version} (del tag ${TAG})`);

const stage = path.join(TMP, 'stage');
await fs.mkdir(stage, { recursive: true });
await fs.rename(dist, path.join(stage, 'lt'));

await podar(path.join(stage, 'lt'));
armarJre(path.join(stage, 'jre'));

await fs.mkdir(SALIDA, { recursive: true });
const nombre = `lt-sidecar-${version}-${TARGET}.zip`;
const zipFinal = path.resolve(SALIDA, nombre);
await fs.rm(zipFinal, { force: true });
empaquetar(stage, zipFinal);

const hash = await sha256De(zipFinal);
const { size } = await fs.stat(zipFinal);
await fs.writeFile(path.join(SALIDA, `${nombre}.sha256`), `${hash}  ${nombre}\n`);
await fs.writeFile(
  path.join(SALIDA, 'manifest.json'),
  `${JSON.stringify({ ltVersion: version, bundles: { [TARGET]: { archivo: nombre, sha256: hash, bytes: size } } }, null, 2)}\n`,
);

log(`listo: ${nombre} — ${(size / 1e6).toFixed(0)} MB`);
log(`sha256: ${hash}`);
await fs.rm(TMP, { recursive: true, force: true });
```

- [ ] **Step 2: Correr el script y verificar la salida**

Run: `node scripts/armar-lt-sidecar.mjs --tag v6.8`

Expected: termina con `listo: lt-sidecar-6.8-x86_64-unknown-linux-gnu.zip — <N> MB` y un sha256 de 64 hex. **Anotar el N real**: las mediciones del spec son de 6.6 (129 MB) y hay dos versiones de diferencia, así que el número puede moverse. Si difiere más de ±15 MB, actualizar la tabla del spec con el valor medido. Verificar a mano:

```bash
ls -lh dist-sidecar/
unzip -l dist-sidecar/lt-sidecar-*.zip | grep -c "jre/bin/java"   # debe ser 1
```

- [ ] **Step 3: Verificar que el bundle armado realmente arranca**

```bash
cd $(mktemp -d) && unzip -q ~/Repos/tWriter/dist-sidecar/lt-sidecar-*.zip
./jre/bin/java -Xmx256m -cp "lt/languagetool-server.jar:lt/libs/*:lt" \
  org.languagetool.server.HTTPServer --port 8099 --allow-origin &
sleep 20
curl -s --data-urlencode "text=El mago penso en su ermana." --data "language=es-AR" \
  http://localhost:8099/v2/check | head -c 200
```

Expected: JSON con al menos 2 matches de `MORFOLOGIK_RULE_ES`. Si sale `NoClassDefFoundError`, la poda borró algo que no debía — revisar las tres trampas en `lt-sidecar-poda.mjs`.

- [ ] **Step 4: Agregar el workflow de CI**

Crear `.github/workflows/lt-sidecar.yml`:

```yaml
name: Armar bundle del sidecar de LT

# Manual a propósito: LT saca ~2 versiones por año, así que un cron sería
# maquinaria para nada. Y no queremos que CI publique artefactos sin que
# alguien lo pida.
on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag de LanguageTool a compilar (ej: v6.8)'
        required: true
        default: 'v6.8'

jobs:
  build-linux:
    runs-on: ubuntu-24.04
    # El build arrastra core + todos los módulos de idioma.
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      # JDK completo, no JRE: `jlink` no viene en un JRE. Maven ya viene en el runner.
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - run: node scripts/armar-lt-sidecar.mjs --tag "${{ inputs.tag }}" --salida dist-sidecar
      - uses: actions/upload-artifact@v4
        with:
          name: lt-sidecar-linux
          path: dist-sidecar/
```

Publicar como release se hace a mano desde los artifacts, con `gh release upload lt-sidecar-v1 dist-sidecar/*`. **No automatizarlo**: publicar es una acción que decide una persona.

- [ ] **Step 5: Documentar el script en CLAUDE.md**

En la sección `## Comandos`, agregar después de la línea de `run-tesauro-smoke.mjs`:

```
node scripts/run-lt-sidecar-smoke.mjs                # poda del bundle de LT
node scripts/armar-lt-sidecar.mjs                    # arma el bundle (pide JDK con jlink)
```

- [ ] **Step 6: Commit**

```bash
git add scripts/armar-lt-sidecar.mjs .github/workflows/lt-sidecar.yml CLAUDE.md
git commit -m "feat(sidecar): script de armado del bundle y workflow manual"
```

---

### Task 3: Rutas de instalación y verificación de sha256

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs` (agregar `mod sidecar;`)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `pub fn install_root(app: &AppHandle) -> Result<PathBuf, String>`
  - `pub fn version_dir(root: &Path, version: &str) -> PathBuf`
  - `pub fn is_installed(version_dir: &Path) -> bool`
  - `pub fn marcar_ok(version_dir: &Path) -> Result<(), String>`
  - `pub fn verify_sha256(bytes: &[u8], esperado: &str) -> Result<(), String>`

- [ ] **Step 1: Agregar las dependencias**

En `src-tauri/Cargo.toml`, en `[dependencies]`:

```toml
sha2 = "0.11"
```

Y cambiar la línea de `reqwest` para sumar `stream`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "stream"] }
```

Verificado el 2026-08-20 contra la regla de supply chain: `sha2 0.11.0` se publicó el 2026-03-25 (148 días), repo `github.com/RustCrypto/hashes`, 857M descargas. `stream` es una feature de un crate ya presente.

- [ ] **Step 2: Write the failing test**

Crear `src-tauri/src/sidecar.rs` con solo el módulo de tests:

```rust
//! LanguageTool como proceso hijo: instalación en `app_data_dir` y ciclo de
//! vida. Ver `docs/superpowers/specs/2026-08-20-lt-sidecar-design.md`.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(label: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("twriter-sidecar-{}-{}", label, n));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn version_dir_aisla_versiones() {
        let root = tempdir("versiones");
        let a = version_dir(&root, "6.8");
        let b = version_dir(&root, "6.9");
        assert_ne!(a, b, "cada versión va a su propio directorio");
        assert!(a.ends_with("6.8"));
    }

    #[test]
    fn no_instalado_sin_marcador_ok() {
        let root = tempdir("marcador");
        let d = version_dir(&root, "6.8");
        fs::create_dir_all(&d).unwrap();
        // Directorio existe pero la extracción no terminó: NO cuenta como instalado.
        assert!(!is_installed(&d));
        marcar_ok(&d).unwrap();
        assert!(is_installed(&d));
    }

    #[test]
    fn sha256_acepta_el_hash_correcto() {
        // sha256 de "hola" (verificable con `printf 'hola' | sha256sum`)
        let esperado = "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79";
        assert!(verify_sha256(b"hola", esperado).is_ok());
    }

    #[test]
    fn sha256_rechaza_hash_distinto() {
        let err = verify_sha256(b"hola", &"0".repeat(64)).unwrap_err();
        assert!(err.contains("integridad"), "mensaje accionable, no un hash pelado: {err}");
    }

    #[test]
    fn sha256_es_case_insensitive() {
        let up = "B221D9DBB083A7F33428D7C2A3C3198AE925614D70210E28716CCAA7CD4DDB79";
        assert!(verify_sha256(b"hola", up).is_ok());
    }
}
```

Agregar en `src-tauri/src/lib.rs`, con los otros `mod`:

```rust
mod sidecar;
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: FAIL de compilación — `cannot find function version_dir in this scope`

- [ ] **Step 4: Write minimal implementation**

Arriba del `mod tests` en `src-tauri/src/sidecar.rs`:

```rust
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Marcador escrito al final de una extracción exitosa. Sin esto, un
/// directorio a medio extraer se tomaría por instalado.
const MARCADOR_OK: &str = ".ok";

/// `app_data_dir()/lt-sidecar`. Versionamos por subdirectorio para que
/// actualizar sea "bajar al lado y borrar el viejo", y el rollback sea gratis.
pub fn install_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("lt-sidecar"))
}

pub fn version_dir(root: &Path, version: &str) -> PathBuf {
    root.join(version)
}

pub fn is_installed(version_dir: &Path) -> bool {
    version_dir.join(MARCADOR_OK).is_file()
}

pub fn marcar_ok(version_dir: &Path) -> Result<(), String> {
    fs::write(version_dir.join(MARCADOR_OK), b"").map_err(|e| format!("marcador .ok: {e}"))
}

/// Verifica el sha256 del bundle bajado. **Obligatorio antes de extraer**: es
/// código que se va a ejecutar. El mensaje tiene que ser accionable, no un
/// hash pelado.
pub fn verify_sha256(bytes: &[u8], esperado: &str) -> Result<(), String> {
    let mut h = Sha256::new();
    h.update(bytes);
    let actual = format!("{:x}", h.finalize());
    if actual.eq_ignore_ascii_case(esperado.trim()) {
        return Ok(());
    }
    Err(format!(
        "Falló la verificación de integridad del bundle de LanguageTool. \
         Se esperaba {} y llegó {}. La descarga se descartó; probá de nuevo.",
        &esperado.trim()[..16.min(esperado.trim().len())],
        &actual[..16]
    ))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: PASS — 5 passed

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(sidecar): rutas de instalacion y verificacion de sha256"
```

---

### Task 4: Puerto libre y args de spawn

**Files:**
- Modify: `src-tauri/src/sidecar.rs`

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces:
  - `pub fn find_free_port(desde: u16) -> Result<u16, String>`
  - `pub fn spawn_args(version_dir: &Path, port: u16) -> (PathBuf, Vec<String>)` — devuelve `(binario_java, args)`

- [ ] **Step 1: Write the failing test**

Agregar al `mod tests` de `sidecar.rs`:

```rust
#[test]
fn find_free_port_saltea_el_ocupado() {
    use std::net::TcpListener;
    // Ocupamos uno y verificamos que devuelva otro. No asumimos 8081 libre:
    // el autor corre un LT propio y puede tener el container arriba.
    let ocupado = TcpListener::bind("127.0.0.1:0").unwrap();
    let p = ocupado.local_addr().unwrap().port();
    let libre = find_free_port(p).unwrap();
    assert_ne!(libre, p, "no puede devolver el puerto que está tomado");
    assert!(libre > p, "busca hacia arriba");
}

#[test]
fn spawn_args_arma_el_classpath_y_el_heap() {
    let d = Path::new("/tmp/lt-sidecar/6.8");
    let (bin, args) = spawn_args(d, 8123);
    assert!(bin.ends_with("jre/bin/java"), "usa el JRE del bundle, no el del sistema");
    let joined = args.join(" ");
    // -Xmx256m es el valor medido contra el peor caso (chunk de 20 KB).
    assert!(args.contains(&"-Xmx256m".to_string()), "falta el cap de heap: {joined}");
    assert!(joined.contains("lt/languagetool-server.jar"));
    assert!(joined.contains("lt/libs/*"));
    assert!(args.contains(&"org.languagetool.server.HTTPServer".to_string()));
    // El puerto va como string, después de --port.
    let i = args.iter().position(|a| a == "--port").expect("falta --port");
    assert_eq!(args[i + 1], "8123");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: FAIL de compilación — `cannot find function find_free_port`

- [ ] **Step 3: Write minimal implementation**

En `sidecar.rs`, arriba del `mod tests`:

```rust
use std::net::TcpListener;

/// Cuántos puertos probar antes de rendirse.
const RANGO_PUERTOS: u16 = 50;
/// Cap de heap. Medido contra el peor caso real (chunk de 20 KB, que es donde
/// corta `split_chunks`): 154 matches, 2,45 s, RSS 538 MB, cero OOM. Mismo
/// resultado que con 512m.
const HEAP: &str = "-Xmx256m";

/// Primer puerto libre desde `desde` hacia arriba. Nunca hardcodear 8081: el
/// autor corre un LT propio en :8010 y puede tener el container en :8081.
pub fn find_free_port(desde: u16) -> Result<u16, String> {
    for p in desde.saturating_add(1)..desde.saturating_add(RANGO_PUERTOS) {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Ok(p);
        }
    }
    Err(format!(
        "No encontré un puerto libre entre {} y {}. Cerrá algún servicio local y probá de nuevo.",
        desde,
        desde.saturating_add(RANGO_PUERTOS)
    ))
}

/// Binario de java y args para levantar el server. `version_dir` es el
/// directorio de instalación, que contiene `lt/` y `jre/`.
pub fn spawn_args(version_dir: &Path, port: u16) -> (PathBuf, Vec<String>) {
    let bin = version_dir.join("jre").join("bin").join("java");
    let lt = version_dir.join("lt");
    let cp = format!(
        "{}:{}:{}",
        lt.join("languagetool-server.jar").display(),
        lt.join("libs").join("*").display(),
        lt.display()
    );
    let args = vec![
        HEAP.to_string(),
        "-cp".to_string(),
        cp,
        "org.languagetool.server.HTTPServer".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--allow-origin".to_string(),
    ];
    (bin, args)
}
```

Nota: `find_free_port` arranca en `desde + 1` porque el caller pasa 8080 para
que el primer candidato sea 8081, y así el test puede ocupar un puerto y pedir
`find_free_port(p)` esperando algo mayor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: PASS — 7 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "feat(sidecar): puerto libre y args de spawn con heap acotado"
```

---

### Task 5: Descarga con progreso y extracción

**Files:**
- Modify: `src-tauri/src/sidecar.rs`

**Interfaces:**
- Consumes: `verify_sha256`, `version_dir`, `marcar_ok` (Task 3).
- Produces:
  - `pub fn pct(bajados: u64, total: u64) -> u8`
  - `pub async fn descargar(url: &str, on_progress: &mut dyn FnMut(u64, u64)) -> Result<Vec<u8>, String>`
  - `pub fn extraer_zip(bytes: &[u8], destino: &Path) -> Result<(), String>`
  - `pub async fn instalar(app: &AppHandle, version: &str, url: &str, sha: &str) -> Result<PathBuf, String>`

- [ ] **Step 1: Write the failing test**

Agregar al `mod tests`:

```rust
#[test]
fn pct_no_divide_por_cero() {
    // Content-Length puede faltar: total 0 no puede panicar.
    assert_eq!(pct(0, 0), 0);
    assert_eq!(pct(500, 0), 0);
}

#[test]
fn pct_calcula_y_topea_en_100() {
    assert_eq!(pct(0, 200), 0);
    assert_eq!(pct(100, 200), 50);
    assert_eq!(pct(200, 200), 100);
    // Si el server manda más bytes que el Content-Length, no pasamos de 100.
    assert_eq!(pct(400, 200), 100);
}

#[test]
fn extraer_zip_restaura_el_bit_de_ejecucion() {
    use std::io::Write;
    let root = tempdir("extraer");
    // Armamos un zip con una entrada 0o755, como la que trae `jre/bin/java`.
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o755);
        w.start_file("jre/bin/java", opts).unwrap();
        w.write_all(b"#!/bin/sh\n").unwrap();
        w.finish().unwrap();
    }
    extraer_zip(&buf, &root).unwrap();
    let java = root.join("jre").join("bin").join("java");
    assert!(java.is_file(), "extrajo el archivo");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let modo = fs::metadata(&java).unwrap().permissions().mode() & 0o111;
        assert_ne!(modo, 0, "java tiene que quedar ejecutable");
    }
}

#[test]
fn extraer_zip_rechaza_paths_que_escapan() {
    use std::io::Write;
    let root = tempdir("zipslip");
    let mut buf = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        w.start_file("../escapado.txt", opts).unwrap();
        w.write_all(b"x").unwrap();
        w.finish().unwrap();
    }
    // Zip Slip: una entrada con `..` no puede escribir fuera del destino.
    let r = extraer_zip(&buf, &root);
    assert!(r.is_err(), "tiene que rechazar el path que escapa");
    assert!(!root.parent().unwrap().join("escapado.txt").exists());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: FAIL de compilación — `cannot find function pct`

- [ ] **Step 3: Write minimal implementation**

En `sidecar.rs`:

```rust
use futures_util::StreamExt;
use std::io::Read;

/// Porcentaje para la UI. `total == 0` cuando falta el `Content-Length`.
pub fn pct(bajados: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    let p = bajados.saturating_mul(100) / total;
    p.min(100) as u8
}

/// Baja el bundle a memoria, llamando a `on_progress(bajados, total)` cada
/// chunk. Son ~129 MB: entran en RAM y así se verifica el hash antes de tocar
/// el disco.
pub async fn descargar(
    url: &str,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<Vec<u8>, String> {
    let res = reqwest::get(url)
        .await
        .map_err(|e| format!("No pude bajar el bundle de LanguageTool: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "El servidor devolvió {} al bajar el bundle de LanguageTool.",
            res.status()
        ));
    }
    let total = res.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Se cortó la descarga: {e}"))?;
        buf.extend_from_slice(&chunk);
        on_progress(buf.len() as u64, total);
    }
    Ok(buf)
}

/// Extrae el zip a `destino`. Rechaza entradas cuyo path escape del destino
/// (Zip Slip) y hace `chmod` explícito de los ejecutables en Unix, sin confiar
/// en que el zip traiga los permisos.
pub fn extraer_zip(bytes: &[u8], destino: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("El bundle no es un zip válido: {e}"))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = f.enclosed_name() else {
            return Err(format!(
                "El bundle tiene una entrada con un path inseguro: {}",
                f.name()
            ));
        };
        let out = destino.join(&rel);
        if f.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut datos = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut datos).map_err(|e| e.to_string())?;
        fs::write(&out, &datos).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // El zip trae 0o755 en `external_attr`, pero no dependemos de eso:
            // si la entrada está bajo jre/bin o es un .so, la marcamos ejecutable.
            let modo = f.unix_mode().unwrap_or(0o644);
            let ejecutable = modo & 0o111 != 0
                || rel.starts_with("jre/bin")
                || rel.extension().is_some_and(|e| e == "so");
            let bits = if ejecutable { 0o755 } else { 0o644 };
            fs::set_permissions(&out, fs::Permissions::from_mode(bits))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Flujo completo: baja → verifica → extrae → marca `.ok`. Si el hash no
/// coincide, no se extrae nada.
pub async fn instalar(
    app: &AppHandle,
    version: &str,
    url: &str,
    sha: &str,
) -> Result<PathBuf, String> {
    let root = install_root(app)?;
    let dir = version_dir(&root, version);
    if is_installed(&dir) {
        return Ok(dir);
    }
    let app_p = app.clone();
    let mut ultimo = 0u8;
    let bytes = descargar(url, &mut |bajados, total| {
        let p = pct(bajados, total);
        // Emitimos cada 2% para no inundar el bridge en 129 MB.
        if p >= ultimo + 2 || p == 100 {
            ultimo = p;
            crate::grammar::emit_progress_pub(
                &app_p,
                "downloading",
                format!(
                    "Bajando LanguageTool… {}% ({} de {} MB)",
                    p,
                    bajados / 1_000_000,
                    total / 1_000_000
                ),
            );
        }
    })
    .await?;

    crate::grammar::emit_progress_pub(app, "verifying", "Verificando integridad…");
    verify_sha256(&bytes, sha)?;

    crate::grammar::emit_progress_pub(app, "extracting", "Descomprimiendo…");
    // Extraemos a un dir temporal al lado y renombramos: si falla a mitad, no
    // queda un directorio de versión a medio armar.
    let tmp = root.join(format!("{version}.parcial"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    if let Err(e) = extraer_zip(&bytes, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let _ = fs::remove_dir_all(&dir);
    fs::rename(&tmp, &dir).map_err(|e| format!("no pude mover la instalación: {e}"))?;
    marcar_ok(&dir)?;
    Ok(dir)
}
```

En `src-tauri/Cargo.toml` sumar, en `[dependencies]`:

```toml
futures-util = { version = "0.3", default-features = false }
```

`futures-util` ya viene en el árbol como dependencia transitiva de `reqwest`; declararla explícita es para poder usar `StreamExt`.

En `src-tauri/src/grammar.rs`, exponer `emit_progress` para que `sidecar.rs` reuse la misma tubería en vez de inventar un evento nuevo. Justo debajo de la definición de `emit_progress`:

```rust
/// Reexport para `sidecar.rs`: el sidecar emite sobre el MISMO evento
/// (`languagetool-progress`) que ya escucha el modal de gramática, así no hay
/// dos canales de progreso para lo mismo.
pub(crate) fn emit_progress_pub(app: &AppHandle, phase: &'static str, message: impl Into<String>) {
    emit_progress(app, phase, message);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: PASS — 11 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/sidecar.rs src-tauri/src/grammar.rs
git commit -m "feat(sidecar): descarga con progreso, verificacion y extraccion segura"
```

---

### Task 6: Ciclo de vida del proceso

**Files:**
- Modify: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `spawn_args`, `find_free_port` (Task 4), `install_root`/`version_dir`/`is_installed` (Task 3).
- Produces:
  - `pub fn puerto_activo() -> Option<u16>`
  - `pub async fn arrancar(app: &AppHandle, version_dir: &Path) -> Result<u16, String>`
  - `pub fn detener()`

Estado en un `static Mutex<Option<Proceso>>`, siguiendo el patrón que ya usa
`grammar.rs` con `static PUBLIC_BUDGET: Mutex<PublicRateBudget>`. No se
introduce `.manage()` de Tauri: el repo no lo usa hoy.

- [ ] **Step 1: Write the failing test**

Agregar al `mod tests`:

```rust
#[test]
fn sin_proceso_no_hay_puerto() {
    detener();
    assert_eq!(puerto_activo(), None, "sin sidecar arriba, el modo local cae al 8081 de Docker");
}

#[test]
fn detener_es_idempotente() {
    detener();
    detener(); // no puede panicar ni colgarse
    assert_eq!(puerto_activo(), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: FAIL de compilación — `cannot find function puerto_activo`

- [ ] **Step 3: Write minimal implementation**

En `sidecar.rs`:

```rust
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

struct Proceso {
    child: Child,
    port: u16,
}

static PROCESO: Mutex<Option<Proceso>> = Mutex::new(None);

/// Puerto del sidecar si está arriba. `None` hace que `resolve_base` caiga al
/// 8081 del container, que es el comportamiento de hoy.
pub fn puerto_activo() -> Option<u16> {
    let guard = PROCESO.lock().ok()?;
    guard.as_ref().map(|p| p.port)
}

/// Levanta el server y espera a que responda. Si ya hay uno arriba, devuelve
/// su puerto sin tocar nada.
pub async fn arrancar(app: &AppHandle, version_dir: &Path) -> Result<u16, String> {
    if let Some(p) = puerto_activo() {
        return Ok(p);
    }
    let port = find_free_port(8080)?;
    let (bin, args) = spawn_args(version_dir, port);
    if !bin.is_file() {
        return Err(format!(
            "Falta el JRE del sidecar en {}. Reinstalá LanguageTool desde el modal de gramática.",
            bin.display()
        ));
    }
    crate::grammar::emit_progress_pub(app, "starting", "Levantando LanguageTool…");
    let child = Command::new(&bin)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("No pude levantar LanguageTool: {e}"))?;
    if let Ok(mut g) = PROCESO.lock() {
        *g = Some(Proceso { child, port });
    }

    // Health poll. Medido: 1,07 s en frío hasta que /v2/languages responde.
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/v2/languages");
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Ok(r) = client.get(&url).timeout(Duration::from_millis(1500)).send().await {
            if r.status().is_success() {
                tracing::info!(target: "sidecar", port, "LanguageTool sidecar listo");
                crate::grammar::emit_progress_pub(
                    app,
                    "ready",
                    format!("LanguageTool listo en localhost:{port}"),
                );
                return Ok(port);
            }
        }
    }
    detener();
    Err("LanguageTool no respondió en 15 s. Probá reinstalarlo desde el modal de gramática.".into())
}

/// Mata el proceso si está vivo. Idempotente: se llama al salir de la app y
/// desde el manejo de errores.
pub fn detener() {
    let Ok(mut g) = PROCESO.lock() else { return };
    if let Some(mut p) = g.take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
        tracing::info!(target: "sidecar", port = p.port, "sidecar detenido");
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: PASS — 13 passed

- [ ] **Step 5: Matar el proceso al cerrar la app**

En `src-tauri/src/lib.rs`, cambiar el final de la cadena del builder. Reemplazar:

```rust
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

por:

```rust
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Sin esto queda un `java` colgado después de cerrar la app.
            if let tauri::RunEvent::Exit = event {
                sidecar::detener();
            }
        });
```

- [ ] **Step 6: Levantar el sidecar al abrir la app**

Sin esto el sidecar solo corre en la sesión donde lo instalaste: al reabrir la
app, `puerto_activo()` es `None` y `mode=local` cae al 8081 del container.

En `src-tauri/src/lib.rs`, dentro del `.setup(|app| { ... })`, después del
bloque que dispara el reindex de búsqueda, agregar:

```rust
            // Levantar el sidecar de LT si ya está instalado. Best-effort y en
            // background: si falla, `resolve_base` cae al container y la
            // gramática sigue andando.
            let handle_sc = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let root = match sidecar::install_root(&handle_sc) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(target: "sidecar", error = %e, "sin app_data_dir");
                        return;
                    }
                };
                let dir = sidecar::version_dir(&root, sidecar::VERSION_PISO);
                if !sidecar::is_installed(&dir) {
                    tracing::info!(target: "sidecar", "sidecar no instalado, no levanto nada");
                    return;
                }
                if let Err(e) = sidecar::arrancar(&handle_sc, &dir).await {
                    tracing::warn!(target: "sidecar", error = %e, "no pude levantar el sidecar al boot");
                }
            });
```

- [ ] **Step 7: Verificar que compila y que no queda java colgado**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: compila sin errores.

Después, manualmente: `pnpm tauri dev`, instalar el sidecar, cerrar la app, y
`pgrep -af "org.languagetool.server.HTTPServer"` → **sin salida**.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(sidecar): ciclo de vida del proceso y kill al salir"
```

---

### Task 7: Enganchar `resolve_base` al sidecar

**Files:**
- Modify: `src-tauri/src/grammar.rs` (`resolve_base`, `LOCAL_BASE`)

**Interfaces:**
- Consumes: `sidecar::puerto_activo` (Task 6).
- Produces: `resolve_base` con el mismo contrato de antes (`Result<String, String>`).

Este es el único punto de integración con el código existente. **No se toca nada más de `grammar.rs`.**

- [ ] **Step 1: Write the failing test**

Agregar al `mod tests` de `grammar.rs`:

```rust
#[test]
fn modo_custom_gana_sobre_el_sidecar() {
    // La URL manual siempre gana: cubre Premium y a quien tenga una imagen
    // con los n-gramas de inglés.
    let cfg: GrammarConfig =
        serde_json::from_str(r#"{"mode":"custom","customUrl":"https://lt.example.com/"}"#).unwrap();
    assert_eq!(resolve_base(&cfg).unwrap(), "https://lt.example.com");
}

#[test]
fn modo_local_sin_sidecar_cae_al_8081_del_container() {
    crate::sidecar::detener();
    let cfg: GrammarConfig = serde_json::from_str(r#"{"mode":"local"}"#).unwrap();
    assert_eq!(resolve_base(&cfg).unwrap(), "http://localhost:8081");
}

#[test]
fn local_base_usa_el_puerto_del_sidecar_cuando_hay() {
    // `local_base_para` es la parte pura: no necesita un proceso vivo.
    assert_eq!(local_base_para(None), "http://localhost:8081");
    assert_eq!(local_base_para(Some(8123)), "http://127.0.0.1:8123");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml grammar`
Expected: FAIL de compilación — `cannot find function local_base_para`

- [ ] **Step 3: Write minimal implementation**

En `grammar.rs`, dejar `LOCAL_BASE` como está (lo usan los tests y es el
fallback) y agregar al lado:

```rust
/// Base del modo `local`. Parte pura, separada para poder testearla sin un
/// proceso vivo: si el sidecar está arriba le pegamos a su puerto, y si no
/// caemos al 8081 del container, que es el comportamiento histórico.
fn local_base_para(puerto_sidecar: Option<u16>) -> String {
    match puerto_sidecar {
        Some(p) => format!("http://127.0.0.1:{p}"),
        None => LOCAL_BASE.to_string(),
    }
}
```

Y cambiar la rama `"local"` de `resolve_base`:

```rust
        "local" => Ok(local_base_para(crate::sidecar::puerto_activo())),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml grammar`
Expected: PASS — los tests que ya había más los 3 nuevos.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/grammar.rs
git commit -m "feat(sidecar): resolve_base usa el puerto del sidecar en modo local"
```

---

### Task 8: Comandos Tauri, manifiesto y aviso de versión

**Files:**
- Modify: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `instalar` (Task 5), `arrancar`/`detener`/`puerto_activo` (Task 6).
- Produces, como comandos `#[tauri::command]`:
  - `lt_sidecar_status(app) -> Result<SidecarStatus, String>`
  - `lt_sidecar_install(app) -> Result<SidecarStatus, String>`
  - `lt_sidecar_stop() -> Result<(), String>`
- Y el tipo `SidecarStatus { instalado: bool, corriendo: bool, version: String, puerto: Option<u16>, version_nueva: Option<String> }` (serializado camelCase).

- [ ] **Step 1: Write the failing test**

Agregar al `mod tests` de `sidecar.rs`:

```rust
#[test]
fn manifest_se_parsea_y_elige_el_target() {
    let raw = r#"{
      "ltVersion": "6.8",
      "bundles": {
        "x86_64-unknown-linux-gnu": {
          "archivo": "lt-sidecar-6.8-x86_64-unknown-linux-gnu.zip",
          "sha256": "abc123",
          "bytes": 135266304
        }
      }
    }"#;
    let m: Manifest = serde_json::from_str(raw).unwrap();
    assert_eq!(m.lt_version, "6.8");
    let b = m.bundles.get(TARGET).expect("falta el bundle de este target");
    assert_eq!(b.sha256, "abc123");
}

#[test]
fn manifest_sin_nuestro_target_no_ofrece_nada() {
    let raw = r#"{"ltVersion":"6.10","bundles":{"aarch64-apple-darwin":{"archivo":"x.zip","sha256":"d","bytes":1}}}"#;
    let m: Manifest = serde_json::from_str(raw).unwrap();
    assert!(m.bundles.get(TARGET).is_none());
}

#[test]
fn version_nueva_solo_si_difiere_del_piso() {
    assert_eq!(version_nueva_si_hay(VERSION_PISO, VERSION_PISO), None);
    assert_eq!(version_nueva_si_hay(VERSION_PISO, "6.9"), Some("6.9".to_string()));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: FAIL de compilación — `cannot find type Manifest`

- [ ] **Step 3: Write minimal implementation**

En `sidecar.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Target de esta vuelta. macOS y Windows son un PR posterior.
pub const TARGET: &str = "x86_64-unknown-linux-gnu";

/// Piso pinneado en el binario: versión y hash que siempre se pueden bajar y
/// validar, sin depender del manifiesto. Es el ancla de confianza — no sacar.
/// Actualizar los dos juntos al publicar un bundle nuevo.
pub const VERSION_PISO: &str = "6.8";
const SHA_PISO: &str = "PONER_EL_SHA256_DEL_BUNDLE_PUBLICADO";
const URL_BASE: &str = "https://github.com/T4toh/tWriter/releases/download/lt-sidecar-v1";

#[derive(Deserialize, Debug)]
pub struct BundleInfo {
    pub archivo: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Deserialize, Debug)]
pub struct Manifest {
    #[serde(rename = "ltVersion")]
    pub lt_version: String,
    pub bundles: HashMap<String, BundleInfo>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub instalado: bool,
    pub corriendo: bool,
    pub version: String,
    pub puerto: Option<u16>,
    /// Versión más nueva disponible según el manifiesto, si hay. La app avisa
    /// y el autor decide: un LT nuevo puede cambiar las marcas sobre el mismo
    /// texto, así que nunca se actualiza en silencio.
    pub version_nueva: Option<String>,
}

pub fn version_nueva_si_hay(instalada: &str, del_manifiesto: &str) -> Option<String> {
    if instalada == del_manifiesto {
        None
    } else {
        Some(del_manifiesto.to_string())
    }
}

fn url_bundle(version: &str) -> String {
    format!("{URL_BASE}/lt-sidecar-{version}-{TARGET}.zip")
}

/// Consulta el manifiesto. Best-effort: si no responde, no es un error —
/// seguimos con el piso pinneado.
async fn leer_manifest() -> Option<Manifest> {
    let url = format!("{URL_BASE}/manifest.json");
    let res = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    res.json::<Manifest>().await.ok()
}

#[tauri::command]
pub async fn lt_sidecar_status(app: AppHandle) -> Result<SidecarStatus, String> {
    let root = install_root(&app)?;
    let dir = version_dir(&root, VERSION_PISO);
    let instalado = is_installed(&dir);
    let version_nueva = leer_manifest()
        .await
        .filter(|m| m.bundles.contains_key(TARGET))
        .and_then(|m| version_nueva_si_hay(VERSION_PISO, &m.lt_version));
    Ok(SidecarStatus {
        instalado,
        corriendo: puerto_activo().is_some(),
        version: VERSION_PISO.to_string(),
        puerto: puerto_activo(),
        version_nueva,
    })
}

#[tauri::command]
pub async fn lt_sidecar_install(app: AppHandle) -> Result<SidecarStatus, String> {
    // El manifiesto puede ofrecer algo más nuevo; si no responde, va el piso.
    let (version, sha) = match leer_manifest().await {
        Some(m) => match m.bundles.get(TARGET) {
            Some(b) => (m.lt_version.clone(), b.sha256.clone()),
            None => (VERSION_PISO.to_string(), SHA_PISO.to_string()),
        },
        None => (VERSION_PISO.to_string(), SHA_PISO.to_string()),
    };
    let dir = instalar(&app, &version, &url_bundle(&version), &sha).await?;
    let puerto = arrancar(&app, &dir).await?;
    Ok(SidecarStatus {
        instalado: true,
        corriendo: true,
        version,
        puerto: Some(puerto),
        version_nueva: None,
    })
}

#[tauri::command]
pub fn lt_sidecar_stop() -> Result<(), String> {
    detener();
    Ok(())
}
```

Registrar en `src-tauri/src/lib.rs`. En el bloque de `use`:

```rust
use sidecar::{lt_sidecar_install, lt_sidecar_status, lt_sidecar_stop};
```

Y en `tauri::generate_handler![...]`, después de `tesauro_lookup`:

```rust
            lt_sidecar_status,
            lt_sidecar_install,
            lt_sidecar_stop,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sidecar`
Expected: PASS — 16 passed

- [ ] **Step 5: Poner el sha256 real del bundle publicado**

Correr Task 2, publicar el bundle, y reemplazar `SHA_PISO` con el hash que
imprimió el script. **Sin esto la instalación falla siempre** — y eso está bien:
es mejor que aceptar cualquier binario.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(sidecar): comandos Tauri, manifiesto y aviso de version nueva"
```

---

### Task 9: Frontend — servicio y modal

**Files:**
- Create: `src/app/core/sidecar-service.ts`
- Modify: `src/app/grammar/grammar-modal.ts` (o el archivo del modal de gramática que exista; buscarlo con `grep -rl "Modo exigente" src/app`)

**Interfaces:**
- Consumes: los comandos `lt_sidecar_status`, `lt_sidecar_install`, `lt_sidecar_stop` (Task 8).
- Produces: `SidecarService` con `status`, `instalando`, `progreso`, `refrescar()`, `instalar()`.

- [ ] **Step 1: Escribir el servicio**

Crear `src/app/core/sidecar-service.ts`:

```ts
import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface SidecarStatus {
  instalado: boolean;
  corriendo: boolean;
  version: string;
  puerto: number | null;
  versionNueva: string | null;
}

interface LtProgress {
  phase: string;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class SidecarService {
  readonly status = signal<SidecarStatus | null>(null);
  readonly instalando = signal(false);
  readonly progreso = signal<string>('');

  constructor() {
    // Mismo evento que ya usa el setup de Docker: no inventamos otro canal.
    void listen<LtProgress>('languagetool-progress', (e) => {
      this.progreso.set(e.payload.message);
    });
  }

  async refrescar(): Promise<void> {
    try {
      this.status.set(await invoke<SidecarStatus>('lt_sidecar_status'));
    } catch {
      this.status.set(null);
    }
  }

  async instalar(): Promise<string | null> {
    this.instalando.set(true);
    this.progreso.set('Preparando…');
    try {
      this.status.set(await invoke<SidecarStatus>('lt_sidecar_install'));
      return null;
    } catch (e) {
      return String(e);
    } finally {
      this.instalando.set(false);
    }
  }
}
```

- [ ] **Step 2: Sumar la sección al modal de gramática**

Localizar el modal: `grep -rl "Modo exigente" src/app`. En su template, agregar
una sección arriba de la de Docker:

```html
@if (sidecar.status(); as s) {
  <section class="sidecar">
    <h3>LanguageTool integrado</h3>
    @if (!s.instalado) {
      <p>
        Se baja una vez (unos 129 MB) y queda funcionando sin Docker ni nada
        más instalado.
      </p>
      <button type="button" [disabled]="sidecar.instalando()" (click)="instalarSidecar()">
        {{ sidecar.instalando() ? 'Bajando…' : 'Instalar LanguageTool' }}
      </button>
    } @else {
      <p>Instalado — versión {{ s.version }}{{ s.corriendo ? ' · corriendo en :' + s.puerto : '' }}</p>
      @if (s.versionNueva) {
        <p class="aviso">
          Hay una versión más nueva de LanguageTool ({{ s.versionNueva }}).
          Puede cambiar qué marca sobre el mismo texto, así que se aplica cuando vos quieras.
        </p>
        <button type="button" [disabled]="sidecar.instalando()" (click)="instalarSidecar()">
          Actualizar a {{ s.versionNueva }}
        </button>
      }
    }
    @if (sidecar.instalando()) {
      <p class="progreso">{{ sidecar.progreso() }}</p>
    }
    @if (errorSidecar()) {
      <p class="error">{{ errorSidecar() }}</p>
    }
  </section>
}
```

Y en la clase del modal:

```ts
protected readonly sidecar = inject(SidecarService);
protected readonly errorSidecar = signal<string | null>(null);

async instalarSidecar(): Promise<void> {
  this.errorSidecar.set(null);
  const err = await this.sidecar.instalar();
  if (err) this.errorSidecar.set(err);
}
```

Y llamar `void this.sidecar.refrescar()` donde el modal ya carga su estado inicial.

- [ ] **Step 3: Verificar que compila**

Run: `pnpm build`
Expected: `Application bundle generation complete`, sin errores nuevos. Las
warnings de bundle budget y del CommonJS de `markdown-it-task-lists` son previas.

No hay test automático: es la mitad con DOM, que según el CLAUDE.md se valida
con `pnpm build` + verificación manual del autor.

- [ ] **Step 4: Commit**

```bash
git add src/app/core/sidecar-service.ts src/app/grammar/
git commit -m "feat(sidecar): servicio y seccion en el modal de gramatica"
```

---

### Task 10: Licencias y corregir el CLAUDE.md

**Files:**
- Create: `src-tauri/resources/LICENCIAS-SIDECAR.md`
- Modify: `scripts/generar-licencias.mjs`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Escribir el aviso de licencias**

Crear `src-tauri/resources/LICENCIAS-SIDECAR.md`:

```markdown
# Licencias del sidecar de LanguageTool

El bundle que tWriter baja a `app_data_dir` contiene software de terceros.
**No se commitea en este repo, pero se distribuye**, así que la obligación de
aviso aplica igual.

## LanguageTool — LGPL 2.1

<https://github.com/languagetool-org/languagetool>

Se distribuye recortado a español e inglés (se borran los datos de los otros
idiomas; ver `scripts/lt-sidecar-poda.mjs`). tWriter lo ejecuta como **proceso
separado** y se comunica por HTTP: no hay linkeo, así que la LGPL 2.1 permite
distribuirlo junto a una aplicación MIT. El código fuente de LanguageTool está
disponible en el repo de arriba, y las modificaciones que aplicamos son
únicamente el borrado de archivos que documenta el script de poda.

## OpenJDK (JRE armado con jlink) — GPLv2 con Classpath Exception

<https://openjdk.org/legal/gplv2+ce.html>

El runtime se genera con `jlink` a partir de un JDK Temurin y contiene solo 19
módulos. La Classpath Exception permite distribuir el runtime junto a una
aplicación con otra licencia.
```

- [ ] **Step 2: Sumarlo al generador de licencias**

En `scripts/generar-licencias.mjs`, agregar las dos entradas a la lista de
terceros que ya arma (seguir el patrón exacto de las entradas del tesauro, que
están en ese archivo):

```js
{
  nombre: 'LanguageTool',
  licencia: 'LGPL-2.1',
  url: 'https://github.com/languagetool-org/languagetool',
  nota: 'Sidecar bajado a app_data_dir, recortado a es+en. Proceso separado, sin linkeo.',
},
{
  nombre: 'OpenJDK (JRE de jlink)',
  licencia: 'GPL-2.0 WITH Classpath-exception-2.0',
  url: 'https://openjdk.org/legal/gplv2+ce.html',
  nota: 'Runtime mínimo de 19 módulos, distribuido con el sidecar.',
},
```

- [ ] **Step 3: Regenerar y verificar**

Run: `node scripts/generar-licencias.mjs`
Expected: imprime el conteo de dependencias y `licencias.json` ahora contiene
`LanguageTool` y `OpenJDK`. Verificar: `grep -c "LanguageTool" src/assets/licencias.json` → ≥ 1.

- [ ] **Step 4: Corregir la afirmación falsa del CLAUDE.md**

En `CLAUDE.md`, sección `## Sidecars y servicios externos`, reemplazar la línea
de Pandoc y la de LanguageTool:

```markdown
- **Pandoc**: **NO está bundleado.** `import.rs::pandoc_bin()` busca el binario
  del sistema (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, y cae a PATH).
  No hay `externalBin` en `tauri.conf.json` ni nada en `src-tauri/binaries/`.
- **LanguageTool**: se baja como bundle propio (LT recortado a es+en + un JRE de
  `jlink`, ~129 MB) a `app_data_dir` y corre como proceso hijo — ver
  `src-tauri/src/sidecar.rs` y el spec
  `docs/superpowers/specs/2026-08-20-lt-sidecar-design.md`. El container Docker
  en `localhost:8081` sigue soportado como fallback, y una URL manual en el
  modal gana sobre los dos.
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/resources/LICENCIAS-SIDECAR.md scripts/generar-licencias.mjs src/assets/licencias.json CLAUDE.md
git commit -m "docs(sidecar): licencias de LT y OpenJDK, y corregir el CLAUDE.md sobre pandoc"
```

---

## Verificación manual del autor

Sin esto no se marca hecho. Es la lista del spec, con lo que hay que ver en cada punto.

- [ ] **1. Instalación desde cero.** `pnpm tauri dev` con `~/.config/com.tatoh.twriter/lt-sidecar/` borrado → el modal de gramática ofrece instalar, la barra avanza con porcentaje, termina y queda `corriendo en :80XX`.
- [ ] **2. Mismos resultados que el container.** Chequear un capítulo en español y uno en inglés, y comparar la lista de matches contra el container de Docker. **Ojo**: el bundle y el container deberían ser los dos 6.8, así que las diferencias NO son esperables. Si aparecen, anotarlas en el `TODO.md`.
- [ ] **3. No queda java colgado.** Cerrar la app y correr `pgrep -af "org.languagetool.server.HTTPServer"` → sin salida.
- [ ] **4. No pisa puertos ajenos.** Con algo escuchando en 8081 (`python3 -m http.server 8081`), abrir la app → el sidecar elige 8082 o más y la gramática funciona igual.
- [ ] **5. Bundle corrupto aborta limpio.** Cambiar `SHA_PISO` a 64 ceros, instalar → mensaje claro sobre integridad, y `ls ~/.config/com.tatoh.twriter/lt-sidecar/` **sin** un directorio de versión ni un `.parcial` colgado.
- [ ] **6. Orden de resolución.** Con el container corriendo Y el sidecar instalado → gana el sidecar (verificar en los logs a qué puerto pega). Con una URL manual seteada en el modal → gana la URL.

## Notas para quien ejecute

- **No borres el código de Docker.** Tentador, pero es el PR siguiente y a propósito: mientras el sidecar no esté verificado a mano, el container es la red.
- **Los tests de `sidecar.rs` usan `Mutex` global**, así que `cargo test` los corre en paralelo y pueden pisarse. Si aparece flakiness en `sin_proceso_no_hay_puerto` o `detener_es_idempotente`, correrlos con `--test-threads=1` antes de asumir un bug real.
- **`SHA_PISO` arranca con un placeholder y eso rompe la instalación a propósito.** Se llena recién cuando existe un bundle publicado (Task 2 → Task 8 Step 5). No lo "arregles" desactivando la verificación.
- Si `sidecar.rs` pasa de 600 líneas, partirlo en `sidecar/instalacion.rs` + `sidecar/proceso.rs`.
