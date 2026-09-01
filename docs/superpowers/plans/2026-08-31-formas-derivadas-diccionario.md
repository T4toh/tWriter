# Formas derivadas en el diccionario per-saga — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que agregar una palabra propia al diccionario de una saga cubra también sus formas flexionadas, sin inflar `diccionario.txt` ni silenciar typos reales.

**Architecture:** Dos mecanismos separados. Las formas que se pueden *pelar* (enclíticos y plural) se resuelven en tiempo de filtrado con una función pura que nunca escribe nada; las que no (conjugación española, género de adjetivos) las genera un preview editable que escribe al archivo. La regla que los separa: el generador nunca escribe un plural.

**Tech Stack:** TypeScript 5.9, Angular 21 (standalone + signals), smoke runners de `scripts/` compilados con `tsc` a un tmpdir. Rust no se toca.

**Spec:** `docs/superpowers/specs/2026-08-31-formas-derivadas-diccionario-design.md`

## Global Constraints

- **Convenciones del repo** (CLAUDE.md): standalone components, sin NgModules; `signal()`/`computed()`/`input()`/`output()` para estado; `@if`/`@for` en templates, nunca `*ngIf`/`*ngFor`; nombres de archivo sin sufijo (`derived-forms-panel.ts`, no `.component.ts`); clases sin sufijo `Component`; sin `public` explícito; return types explícitos en métodos; `inject()` en vez de constructor params; español para UI, comentarios y nombres de dominio.
- **No hay runner de tests para el frontend.** `ng test` no corre nada. La lógica pura se valida con un smoke runner nuevo en `scripts/`; la mitad con DOM se valida con `pnpm build` más verificación manual del autor.
- **El módulo `derived-forms.ts` no puede importar nada de Angular, TipTap ni ProseMirror.** El smoke runner lo compila suelto con `tsc` y lo importa desde node; cualquier import de esos paquetes lo rompe.
- **Idiomas nunca mezclados**: las reglas de flexión se eligen por el `idioma` de `saga.json` (`es` o `en`). No hay reglas compartidas.
- **Guardas del stripper, las tres, siempre**: resto ≥ 4 caracteres, máximo 2 pelados, y solo devuelve hit si el resto ya está en el diccionario.
- **El índice sin diacríticos se consulta solo después de haber pelado algo**, nunca sobre la palabra cruda.
- **Commits**: sin firmar como co-autor (regla de la organización). Formato Conventional Commits, en español, como el resto del repo.

---

### Task 1: `stripInflection` — pelado de flexión

**Files:**
- Create: `src/app/dictionary/derived-forms.ts`
- Create: `scripts/run-derived-forms-smoke.mjs`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type IdiomaFlexion = 'es' | 'en'`
  - `interface DictLookup { exactGet(word: string): string | null; foldedGet(word: string): string | null }`
  - `function fold(s: string): string`
  - `function makeDictLookup(words: readonly string[]): DictLookup`
  - `function stripInflection(word: string, idioma: IdiomaFlexion, lookup: DictLookup): string | null`

- [ ] **Step 1: Escribir el smoke runner con los casos que tienen que fallar**

Crear `scripts/run-derived-forms-smoke.mjs`. Sigue el patrón exacto de `scripts/run-note-templates-smoke.mjs`: compila el TS a un tmpdir con `tsc` y lo importa.

```js
#!/usr/bin/env node
// Smoke runner de las formas derivadas del diccionario per-saga.
// No es parte del build de Angular. Compila el TS a un dir temporal y corre
// las aserciones. Uso: node scripts/run-derived-forms-smoke.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'derived-forms-smoke-'));

const tsc = join(repo, 'node_modules', '.bin', 'tsc');
const r = spawnSync(
  tsc,
  [
    '--target', 'es2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--outDir', outDir,
    'src/app/dictionary/derived-forms.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'derived-forms.js')).href);
const { makeDictLookup, stripInflection } = mod;

let passed = 0;
let failed = 0;
function check(name, cond, info) {
  if (cond) {
    passed += 1;
    console.log('  ok   —', name);
  } else {
    failed += 1;
    console.error('  FAIL —', name);
    if (info !== undefined) console.error('         ', info);
  }
}

// Diccionario de prueba: entradas reales de Meridian más las formas que el
// generador escribiría para `bardear` y `teletransportar` (Task 2).
const DICT_ES = [
  'arcanismo', 'mirmidón', 'telequinético', 'telequinética', 'encantación',
  'Aedan', 'lúmen', 'dracónido', 'piedrita',
  'bardear', 'bardeando', 'bardeado', 'bardeada', 'bardeo', 'bardeás',
  'bardea', 'bardean', 'bardeé', 'bardeaste', 'bardeó', 'bardearon',
  'bardeaba', 'bardeaban', 'bardeá',
  'teletransportar', 'teletransportando', 'teletransportado',
  'teletransportada', 'teletransporto', 'teletransportás', 'teletransporta',
  'teletransportan', 'teletransporté', 'teletransportaste', 'teletransportó',
  'teletransportaron', 'teletransportaba', 'teletransportaban',
  'teletransportá',
];
const DICT_EN = ['chobbo', 'faunt', 'xenoarchaeologist', 'koziara', 'naruu', 'holoblade'];
const ES = makeDictLookup(DICT_ES);
const EN = makeDictLookup(DICT_EN);

console.log('stripInflection — pela');
for (const [word, idioma, esperado] of [
  ['bardearlo', 'es', 'bardear'],
  ['bardeármelo', 'es', 'bardear'],
  ['teletransportándose', 'es', 'teletransportando'],
  ['bardeámelo', 'es', 'bardeá'],
  ['arcanismos', 'es', 'arcanismo'],
  ['mirmidones', 'es', 'mirmidón'],
  ['bardeados', 'es', 'bardeado'],
  ['telequinéticas', 'es', 'telequinética'],
  ['lúmenes', 'es', 'lúmen'],
  ['chobbos', 'en', 'chobbo'],
  ['faunts', 'en', 'faunt'],
  ['naruus', 'en', 'naruu'],
  ['Koziaras', 'en', 'koziara'],
  ['xenoarchaeologists', 'en', 'xenoarchaeologist'],
]) {
  const got = stripInflection(word, idioma, idioma === 'es' ? ES : EN);
  check(`${word} [${idioma}] → ${esperado}`, got === esperado, got);
}

console.log('stripInflection — NO pela');
for (const [word, idioma, motivo] of [
  ['perla', 'es', 'el resto «per» no llega a 4 caracteres'],
  ['casas', 'es', '«casa» no está en el diccionario'],
  ['mirmidon', 'es', 'sin flexión no se consulta el índice sin tildes'],
  ['encantanción', 'es', 'typo, ningún patrón aplica'],
  ['Aedan', 'es', 'nombre propio sin flexión'],
  ['manos', 'es', 'el resto «ma» no llega a 4 caracteres'],
  ['hermanos', 'es', '«herma» no está en el diccionario'],
  ['sombras', 'es', 'palabra común'],
  ['blades', 'en', '«blade» no está en el diccionario'],
]) {
  const got = stripInflection(word, idioma, idioma === 'es' ? ES : EN);
  check(`${word} [${idioma}] → null (${motivo})`, got === null, got);
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el runner para verificar que falla**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: FAIL — `tsc` sale distinto de 0 con `error TS6053: File 'src/app/dictionary/derived-forms.ts' not found.`

- [ ] **Step 3: Escribir la implementación mínima**

Crear `src/app/dictionary/derived-forms.ts`:

```ts
/** Reglas de flexión por idioma de saga. Nunca se mezclan entre idiomas. */
export type IdiomaFlexion = 'es' | 'en';

export interface DictLookup {
  /** Canónica si la grafía coincide exacto, comparando en minúsculas. */
  exactGet(word: string): string | null;
  /** Canónica ignorando diacríticos. Solo se consulta después de pelar algo. */
  foldedGet(word: string): string | null;
}

/** Minúsculas y sin diacríticos. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function makeDictLookup(words: readonly string[]): DictLookup {
  const exacto = new Map<string, string>();
  const plegado = new Map<string, string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (!exacto.has(lower)) exacto.set(lower, w);
    const f = fold(w);
    if (!plegado.has(f)) plegado.set(f, w);
  }
  return {
    exactGet: (word) => exacto.get(word.toLowerCase()) ?? null,
    foldedGet: (word) => plegado.get(fold(word)) ?? null,
  };
}

/** Rioplatense: sin `os` de vosotros. Los dobles (`-melo`) salen de pelar dos veces. */
const ENCLITICOS: readonly string[] = ['me', 'te', 'se', 'lo', 'la', 'le', 'nos', 'los', 'las', 'les'];

const VOCAL_FINAL = /[aeiouáéíóú]$/;
const MIN_RESTO = 4;
const MAX_PELADOS = 2;

/** Devuelve la entrada del diccionario que cubre `word` vía flexión, o null. */
export function stripInflection(
  word: string,
  idioma: IdiomaFlexion,
  lookup: DictLookup,
): string | null {
  const w = word.toLowerCase();

  // Resuelve un resto YA pelado: exacto primero, y recién ahí sin diacríticos.
  // El índice plegado nunca se consulta sobre la palabra cruda — si lo hiciera,
  // el diccionario pasaría a ignorar los acentos y `mirmidon` mal escrita
  // dejaría de marcarse.
  const resolver = (resto: string): string | null => {
    if (resto.length < MIN_RESTO) return null;
    return lookup.exactGet(resto) ?? lookup.foldedGet(resto);
  };

  const plural = pelarPlural(w, idioma, resolver);
  if (plural) return plural;

  if (idioma !== 'es') return null;
  return pelarEncliticos(w, resolver);
}

function pelarPlural(
  w: string,
  idioma: IdiomaFlexion,
  resolver: (resto: string) => string | null,
): string | null {
  if (!w.endsWith('s')) return null;
  const candidatos: string[] = [];
  if (idioma === 'es') {
    if (w.endsWith('ces')) candidatos.push(w.slice(0, -3) + 'z');
    if (VOCAL_FINAL.test(w.slice(0, -1))) candidatos.push(w.slice(0, -1));
    if (w.endsWith('es')) candidatos.push(w.slice(0, -2));
  } else {
    // Inglés: solo `-s`. `-es` y `-ies` no se implementan — cero casos en las
    // 265 entradas del diccionario de Milky Way.
    candidatos.push(w.slice(0, -1));
  }
  for (const c of candidatos) {
    const hit = resolver(c);
    if (hit) return hit;
  }
  return null;
}

function pelarEncliticos(w: string, resolver: (resto: string) => string | null): string | null {
  let nivel: string[] = [w];
  for (let profundidad = 0; profundidad < MAX_PELADOS; profundidad += 1) {
    const siguiente: string[] = [];
    for (const actual of nivel) {
      for (const enclitico of ENCLITICOS) {
        if (!actual.endsWith(enclitico)) continue;
        const resto = actual.slice(0, -enclitico.length);
        if (resto.length < MIN_RESTO) continue;
        // El resto tiene que tener forma de infinitivo, gerundio o imperativo.
        // Corta pelados espurios sobre sustantivos (`hermanos` → `herma`).
        if (!(resto.endsWith('r') || resto.endsWith('ndo') || VOCAL_FINAL.test(resto))) continue;
        const hit = resolver(resto);
        if (hit) return hit;
        siguiente.push(resto);
      }
    }
    nivel = siguiente;
  }
  return null;
}
```

- [ ] **Step 4: Correr el runner para verificar que pasa**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: PASS — `23 ok, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/app/dictionary/derived-forms.ts scripts/run-derived-forms-smoke.mjs
git commit -m "feat(diccionario): pelado de flexión con regla por idioma de saga

Enclíticos y plural se resuelven al filtrar, sin escribir al archivo. Las
tres guardas (resto de 4 caracteres, dos pelados como máximo, y el resto
tiene que estar ya en el diccionario) son lo que evita que silencie typos.
El índice sin diacríticos se consulta solo después de pelar algo, así
mirmidones cae en mirmidón pero mirmidon a secas sigue marcada."
```

---

### Task 2: `generateForms` — conjugación y género

**Files:**
- Modify: `src/app/dictionary/derived-forms.ts`
- Modify: `scripts/run-derived-forms-smoke.mjs`

**Interfaces:**
- Consumes: `IdiomaFlexion` de Task 1.
- Produces:
  - `type Categoria = 'verbo' | 'adjetivo'`
  - `function generateForms(lema: string, categoria: Categoria, idioma: IdiomaFlexion): string[]`

- [ ] **Step 1: Escribir las aserciones que fallan**

Agregar a `scripts/run-derived-forms-smoke.mjs`, justo antes del bloque final que imprime el conteo. Cambiar también la línea del import para traer la función nueva:

```js
const { makeDictLookup, stripInflection, generateForms } = mod;
```

```js
console.log('generateForms — verbos');
{
  const bardear = generateForms('bardear', 'verbo', 'es');
  check(
    'bardear da las 15 formas del núcleo, en orden',
    bardear.join(' ') ===
      'bardear bardeando bardeado bardeada bardeo bardeás bardea bardean ' +
      'bardeé bardeaste bardeó bardearon bardeaba bardeaban bardeá',
    bardear.join(' '),
  );
  check('el generador no escribe plurales de participio',
    !bardear.includes('bardeados') && !bardear.includes('bardeadas'), bardear.join(' '));

  const comer = generateForms('comer', 'verbo', 'es');
  check('comer da 15 (tabla -er)', comer.length === 15, comer.join(' '));
  check('comer conjuga con voseo', comer.includes('comés') && comer.includes('comé'), comer.join(' '));
  check('comer no tuteo', !comer.includes('comes'), comer.join(' '));

  const vivir = generateForms('vivir', 'verbo', 'es');
  check('vivir da 14: pretérito 1ª e imperativo voseo colisionan en «viví»',
    vivir.length === 14 && vivir.filter((f) => f === 'viví').length === 1, vivir.join(' '));

  const trancar = generateForms('trancar', 'verbo', 'es');
  check('-car ajusta el pretérito 1ª sg a «tranqué»',
    trancar.includes('tranqué') && !trancar.includes('trancé'), trancar.join(' '));
  check('-gar ajusta a «pagué»', generateForms('pagar', 'verbo', 'es').includes('pagué'));
  check('-zar ajusta a «cacé»', generateForms('cazar', 'verbo', 'es').includes('cacé'));

  const leer = generateForms('leer', 'verbo', 'es');
  check('raíz en vocal: i átona pasa a y',
    leer.includes('leyendo') && leer.includes('leyó') && leer.includes('leyeron'), leer.join(' '));
  check('raíz en vocal: i tónica lleva tilde, NO pasa a y',
    leer.includes('leído') && leer.includes('leída') && leer.includes('leíste') &&
    !leer.includes('leido') && !leer.includes('leyste'), leer.join(' '));

  check('un lema que no es infinitivo da lista vacía',
    generateForms('teletransporta', 'verbo', 'es').length === 0);
  check('un lema demasiado corto da lista vacía',
    generateForms('ar', 'verbo', 'es').length === 0);
}

console.log('generateForms — adjetivos e inglés');
{
  check('adjetivo en -o da masculino y femenino, sin plurales',
    generateForms('telequinético', 'adjetivo', 'es').join(' ') === 'telequinético telequinética',
    generateForms('telequinético', 'adjetivo', 'es').join(' '));
  check('adjetivo invariable en género no genera nada',
    generateForms('arcanista', 'adjetivo', 'es').length === 0);
  check('en inglés no se genera nada, ni verbos ni género',
    generateForms('bardear', 'verbo', 'en').length === 0 &&
    generateForms('chobbo', 'adjetivo', 'en').length === 0);
}
```

- [ ] **Step 2: Correr el runner para verificar que falla**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: FAIL — `TypeError: generateForms is not a function`

- [ ] **Step 3: Escribir la implementación**

Agregar a `src/app/dictionary/derived-forms.ts`:

```ts
export type Categoria = 'verbo' | 'adjetivo';

/** Formas a ofrecer para un lema. Solo español; en inglés devuelve [].
 *
 *  El generador NUNCA escribe un plural: de eso se encarga `stripInflection`.
 *  Por eso el núcleo verbal son 15 formas y no 17 (sin `bardeados`/`bardeadas`)
 *  y los adjetivos son 2 y no 4. */
export function generateForms(
  lema: string,
  categoria: Categoria,
  idioma: IdiomaFlexion,
): string[] {
  if (idioma !== 'es') return [];
  const l = lema.trim().toLowerCase();
  if (!l) return [];
  return categoria === 'verbo' ? conjugar(l) : generoAdjetivo(l);
}

/** Adjetivos en `-o`: masculino y femenino singular. Los invariables en género
 *  (`-e`, `-ista`, consonante) no generan nada — la entrada sola alcanza. */
function generoAdjetivo(lema: string): string[] {
  if (!lema.endsWith('o')) return [];
  return [lema, lema.slice(0, -1) + 'a'];
}

function conjugar(lema: string): string[] {
  const term = lema.slice(-2);
  const raiz = lema.slice(0, -2);
  if (raiz.length < 2) return [];

  if (term === 'ar') {
    return dedupe([
      lema,
      raiz + 'ando',
      raiz + 'ado',
      raiz + 'ada',
      raiz + 'o',
      raiz + 'ás',
      raiz + 'a',
      raiz + 'an',
      preteritoPrimeraAr(raiz),
      raiz + 'aste',
      raiz + 'ó',
      raiz + 'aron',
      raiz + 'aba',
      raiz + 'aban',
      raiz + 'á',
    ]);
  }

  if (term !== 'er' && term !== 'ir') return [];

  // Raíz terminada en vocal (`leer`, `oír`): la `i` átona entre vocales pasa a
  // `y`, pero la `i` tónica lleva tilde y NO pasa a `y`. Confundir los dos casos
  // escribe formas que no existen (`leyste`, `leido`) y esas sí silencian typos.
  const enVocal = VOCAL_FINAL.test(raiz);
  const gerundio = enVocal ? 'yendo' : 'iendo';
  const participio = enVocal ? 'ído' : 'ido';
  const participioF = enVocal ? 'ída' : 'ida';
  const preterito2 = enVocal ? 'íste' : 'iste';
  const preterito3 = enVocal ? 'yó' : 'ió';
  const preterito3pl = enVocal ? 'yeron' : 'ieron';
  const presenteVoseo = term === 'er' ? 'és' : 'ís';
  const imperativoVoseo = term === 'er' ? 'é' : 'í';

  return dedupe([
    lema,
    raiz + gerundio,
    raiz + participio,
    raiz + participioF,
    raiz + 'o',
    raiz + presenteVoseo,
    raiz + 'e',
    raiz + 'en',
    raiz + 'í',
    raiz + preterito2,
    raiz + preterito3,
    raiz + preterito3pl,
    raiz + 'ía',
    raiz + 'ían',
    raiz + imperativoVoseo,
  ]);
}

/** Ajuste ortográfico del pretérito 1ª sg: `trancar`→`tranqué`, `pagar`→`pagué`,
 *  `cazar`→`cacé`. No es modelar un irregular, es cómo se escribe el sonido. */
function preteritoPrimeraAr(raiz: string): string {
  if (raiz.endsWith('c')) return raiz.slice(0, -1) + 'qué';
  if (raiz.endsWith('g')) return raiz + 'ué';
  if (raiz.endsWith('z')) return raiz.slice(0, -1) + 'cé';
  return raiz + 'é';
}

function dedupe(formas: readonly string[]): string[] {
  return [...new Set(formas)];
}
```

- [ ] **Step 4: Correr el runner para verificar que pasa**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: PASS — todas las aserciones de Task 1 más las nuevas, `0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/app/dictionary/derived-forms.ts scripts/run-derived-forms-smoke.mjs
git commit -m "feat(diccionario): generador de conjugación y género

Núcleo narrativo de 15 formas por verbo, con voseo y sin tuteo. Son 15 y no
17 porque los plurales de participio los pela el stripper: el generador
nunca escribe un plural.

Dos ajustes ortográficos que no son irregulares sino mecánica de escritura:
-car/-gar/-zar en el pretérito 1ª sg, y la raíz terminada en vocal donde la
i átona pasa a y (leyendo) pero la tónica lleva tilde (leído, leíste)."
```

---

### Task 3: `inferLemma` — lema desde la forma marcada

**Files:**
- Modify: `src/app/dictionary/derived-forms.ts`
- Modify: `scripts/run-derived-forms-smoke.mjs`

**Interfaces:**
- Consumes: `IdiomaFlexion`, `Categoria` de Tasks 1 y 2.
- Produces:
  - `interface LemmaCandidate { lema: string; categoria: Categoria }`
  - `function inferLemma(word: string, idioma: IdiomaFlexion): LemmaCandidate[]`

**Por qué existe:** en el diccionario de Meridian están `teletransportó`, `bardean`, `casteando`, pero **no** `teletransportar` ni `bardear`. El autor agrega la palabra tal como se la marcó LanguageTool, nunca el lema, así que el preview tiene que reconstruirlo hacia atrás.

- [ ] **Step 1: Escribir las aserciones que fallan**

Agregar a `scripts/run-derived-forms-smoke.mjs`, antes del bloque final. Actualizar el import:

```js
const { makeDictLookup, stripInflection, generateForms, inferLemma } = mod;
```

```js
console.log('inferLemma');
{
  const primero = (w, i) => {
    const c = inferLemma(w, i)[0];
    return c ? `${c.lema}/${c.categoria}` : 'null';
  };
  for (const [word, esperado] of [
    ['teletransportó', 'teletransportar/verbo'],
    ['bardean', 'bardear/verbo'],
    ['casteando', 'castear/verbo'],
    ['teletransportaste', 'teletransportar/verbo'],
    ['teletransportaba', 'teletransportar/verbo'],
    ['bardeado', 'bardear/verbo'],
    ['comiendo', 'comer/verbo'],
  ]) {
    check(`${word} → ${esperado}`, primero(word, 'es') === esperado, primero(word, 'es'));
  }

  check('-iendo ofrece -er y -ir como dos candidatos',
    inferLemma('comiendo', 'es').map((c) => c.lema).join(',') === 'comer,comir',
    JSON.stringify(inferLemma('comiendo', 'es')));

  check('las formas en -a dan adjetivo primero y el verbo reconstruido segundo',
    inferLemma('castea', 'es').map((c) => `${c.lema}/${c.categoria}`).join(',') ===
      'castea/adjetivo,castear/verbo',
    JSON.stringify(inferLemma('castea', 'es')));
  check('teletransporta reconstruye teletransportar',
    inferLemma('teletransporta', 'es').some((c) => c.lema === 'teletransportar' && c.categoria === 'verbo'),
    JSON.stringify(inferLemma('teletransporta', 'es')));
  check('las formas en -o reconstruyen el infinitivo en -ar',
    inferLemma('teletransporto', 'es').some((c) => c.lema === 'teletransportar'),
    JSON.stringify(inferLemma('teletransporto', 'es')));
  check('telequinético propone adjetivo primero',
    inferLemma('telequinético', 'es')[0].categoria === 'adjetivo',
    JSON.stringify(inferLemma('telequinético', 'es')));

  check('la stop-list corta los sustantivos en -ción',
    inferLemma('teletransportación', 'es').length === 0,
    JSON.stringify(inferLemma('teletransportación', 'es')));
  check('la stop-list corta -miento y -dad',
    inferLemma('arcanismiento', 'es').length === 0 && inferLemma('oscuridad', 'es').length === 0);
  check('en inglés no infiere nada', inferLemma('chobbos', 'en').length === 0);
  check('un nombre propio corto no se confunde con un verbo',
    inferLemma('Aedan', 'es').length === 0, JSON.stringify(inferLemma('Aedan', 'es')));
  check('una palabra sin sufijo reconocible no da candidatos',
    inferLemma('Arcaneum', 'es').length === 0, JSON.stringify(inferLemma('Arcaneum', 'es')));
  // Limitación conocida y aceptada: un nombre largo terminado en -en/-an sí
  // propone verbo. No hay señal para distinguirlo sin un etiquetador
  // morfológico, y para eso está el botón Cancelar del preview.
  check('LIMITACIÓN: Bastien propone bastier, y se cancela a mano',
    inferLemma('Bastien', 'es')[0].lema === 'bastier',
    JSON.stringify(inferLemma('Bastien', 'es')));
}
```

- [ ] **Step 2: Correr el runner para verificar que falla**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: FAIL — `TypeError: inferLemma is not a function`

- [ ] **Step 3: Escribir la implementación**

Agregar a `src/app/dictionary/derived-forms.ts`:

```ts
export interface LemmaCandidate {
  lema: string;
  categoria: Categoria;
}

/** Sustantivos que terminan parecido a una forma verbal. Sin esta lista
 *  `teletransportación` — que está en el diccionario de Meridian — se ofrecería
 *  como verbo. */
const STOP_SUSTANTIVOS: readonly string[] = [
  'ciones', 'ción', 'siones', 'sión', 'mientos', 'miento', 'dades', 'dad',
];

interface ReglaSufijo {
  sufijo: string;
  terminaciones: readonly string[];
}

/** Ordenadas de sufijo más largo a más corto: la primera que matchea gana.
 *  `-a` y `-o` no están acá — caen al fallback de adjetivo, que además
 *  reconstruye el verbo como segundo candidato. */
const REGLAS: readonly ReglaSufijo[] = [
  { sufijo: 'ábamos', terminaciones: ['ar'] },
  { sufijo: 'ieron', terminaciones: ['er', 'ir'] },
  { sufijo: 'iendo', terminaciones: ['er', 'ir'] },
  { sufijo: 'ando', terminaciones: ['ar'] },
  { sufijo: 'aban', terminaciones: ['ar'] },
  { sufijo: 'aste', terminaciones: ['ar'] },
  { sufijo: 'aron', terminaciones: ['ar'] },
  { sufijo: 'amos', terminaciones: ['ar'] },
  { sufijo: 'iste', terminaciones: ['er', 'ir'] },
  { sufijo: 'ado', terminaciones: ['ar'] },
  { sufijo: 'ada', terminaciones: ['ar'] },
  { sufijo: 'ido', terminaciones: ['er', 'ir'] },
  { sufijo: 'ida', terminaciones: ['er', 'ir'] },
  { sufijo: 'aba', terminaciones: ['ar'] },
  { sufijo: 'ían', terminaciones: ['er', 'ir'] },
  { sufijo: 'ía', terminaciones: ['er', 'ir'] },
  { sufijo: 'ás', terminaciones: ['ar'] },
  { sufijo: 'és', terminaciones: ['er'] },
  { sufijo: 'ís', terminaciones: ['ir'] },
  { sufijo: 'ió', terminaciones: ['er', 'ir'] },
  { sufijo: 'an', terminaciones: ['ar'] },
  { sufijo: 'en', terminaciones: ['er', 'ir'] },
  { sufijo: 'ó', terminaciones: ['ar'] },
  { sufijo: 'é', terminaciones: ['ar'] },
  { sufijo: 'á', terminaciones: ['ar'] },
  { sufijo: 'í', terminaciones: ['ir'] },
];

const MIN_RAIZ = 3;
/** Los sufijos de una o dos letras (`-an`, `-en`, `-ó`) matchean cualquier cosa,
 *  incluidos nombres propios, así que piden una raíz más larga para aceptarse. */
const MIN_RAIZ_SUFIJO_CORTO = 4;

/** Candidatos de lema + categoría inferidos desde una forma marcada. */
export function inferLemma(word: string, idioma: IdiomaFlexion): LemmaCandidate[] {
  if (idioma !== 'es') return [];
  const w = word.trim().toLowerCase();
  if (w.length < MIN_RAIZ + 1) return [];
  if (STOP_SUSTANTIVOS.some((s) => w.endsWith(s))) return [];

  for (const regla of REGLAS) {
    if (!w.endsWith(regla.sufijo)) continue;
    const raiz = w.slice(0, -regla.sufijo.length);
    // Sin el piso más alto para sufijos cortos, `Aedan` matchea `-an` con raíz
    // `aed` y propone el verbo `aedar`. Los sufijos largos (`-iendo`, `-aste`)
    // ya discriminan solos y se conforman con una raíz de 3 (`comiendo`→`comer`).
    if (raiz.length < (regla.sufijo.length <= 2 ? MIN_RAIZ_SUFIJO_CORTO : MIN_RAIZ)) continue;
    return regla.terminaciones.map((t) => ({ lema: raiz + t, categoria: 'verbo' as const }));
  }

  // `-a` y `-o` son ambiguos: `telequinético` es adjetivo, `teletransporta` y
  // `teletransporto` son verbo. Se devuelven los dos, adjetivo primero porque
  // es lo más frecuente con esa terminación en el corpus.
  if (w.endsWith('a')) {
    return [
      { lema: w, categoria: 'adjetivo' },
      { lema: w + 'r', categoria: 'verbo' },
    ];
  }
  if (w.endsWith('o')) {
    return [
      { lema: w, categoria: 'adjetivo' },
      { lema: w.slice(0, -1) + 'ar', categoria: 'verbo' },
    ];
  }
  return [];
}
```

- [ ] **Step 4: Correr el runner para verificar que pasa**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: PASS — `57 ok, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/app/dictionary/derived-forms.ts scripts/run-derived-forms-smoke.mjs
git commit -m "feat(diccionario): inferir el lema desde la forma marcada

En el diccionario de Meridian están teletransportó y bardean pero no los
infinitivos: la palabra se agrega como la marcó LT, nunca como lema. Tabla
de sufijos de más largo a más corto, con stop-list de sustantivos para que
teletransportación no se ofrezca como verbo.

Las formas en -a y -o devuelven dos candidatos, adjetivo y verbo
reconstruido, porque castea/bardea/teletransporta son justo las que ya
están en el diccionario."
```

---

### Task 4: Cableado en el filtro — un solo punto de entrada

**Files:**
- Modify: `src/app/core/saga-context-service.ts:1-3` (imports), `:24-30` (computeds), `:99-101` (`isInDictionary`), `:115-130` (nuevo `addManyToDictionary`)
- Modify: `src/app/editor/editor.ts:625-643` (el effect de re-filtrado en vivo)

**Interfaces:**
- Consumes: `stripInflection`, `makeDictLookup`, `IdiomaFlexion`, `DictLookup` de Task 1.
- Produces:
  - `SagaContextService.isInDictionary(word: string): boolean` — misma firma, ahora cubre flexión
  - `SagaContextService.idiomaFlexion(): IdiomaFlexion | null` — signal computada, la usa Task 6
  - `SagaContextService.addManyToDictionary(words: readonly string[]): Promise<{ ok: boolean; added: number; reason?: string }>`

**Por qué acá y solo acá:** hay dos sitios que filtran TYPOS contra el diccionario. `editor.ts:1101` ya pasa por `isInDictionary`, pero `editor.ts:638` hace `dict.has(word.toLowerCase())` a mano y se saltea el service. Poner la guarda en el service y hacer que el segundo sitio lo use deja un solo camino, en vez de dos guardas paralelas que después divergen.

- [ ] **Step 1: Agregar los computeds y cambiar `isInDictionary`**

En `src/app/core/saga-context-service.ts`, extender el import de la línea 3 y agregar uno nuevo:

```ts
import { existsCaseInsensitive, validateWord } from '../dictionary/word-validator';
import {
  DictLookup,
  IdiomaFlexion,
  makeDictLookup,
  stripInflection,
} from '../dictionary/derived-forms';
```

Agregar los dos computeds después de `dictionaryWords` (línea 30):

```ts
  /** Índice para el pelado de flexión. Se rearma cuando cambia el diccionario. */
  private readonly lookup = computed<DictLookup>(() => makeDictLookup(this.dictWords()));
  /** Idioma de la saga reducido a las dos familias de reglas de flexión.
   *  Tolera variantes tipo `es-AR`. Null si la saga no declara idioma: en ese
   *  caso no se pela nada y el filtro se comporta como antes. */
  readonly idiomaFlexion = computed<IdiomaFlexion | null>(() => {
    const raw = this.config()?.idioma?.trim().toLowerCase();
    if (!raw) return null;
    if (raw.startsWith('es')) return 'es';
    if (raw.startsWith('en')) return 'en';
    return null;
  });
```

Reemplazar `isInDictionary` (líneas 99-101):

```ts
  isInDictionary(word: string): boolean {
    if (this.dictionary().has(word.toLowerCase())) return true;
    const idioma = this.idiomaFlexion();
    if (!idioma) return false;
    return stripInflection(word, idioma, this.lookup()) !== null;
  }
```

- [ ] **Step 2: Agregar `addManyToDictionary`**

En el mismo archivo, después de `addToDictionary` (línea 130). Una sola escritura por confirmación, no una por forma:

```ts
  /** Agrega varias palabras en una sola escritura. Descarta en silencio las
   *  inválidas y las que ya están — el panel de formas derivadas ya las muestra
   *  como "ya está", así que no hay nada que reportar. */
  async addManyToDictionary(
    words: readonly string[],
  ): Promise<{ ok: boolean; added: number; reason?: string }> {
    const path = this.sagaPath();
    if (!path) return { ok: false, added: 0, reason: 'No hay saga activa' };
    const next = [...this.dictWords()];
    let added = 0;
    for (const raw of words) {
      const result = validateWord(raw);
      if (!result.ok) continue;
      if (existsCaseInsensitive(next, result.value)) continue;
      next.push(result.value);
      added += 1;
    }
    if (added === 0) return { ok: true, added: 0 };
    try {
      await invoke('set_saga_dictionary', { sagaPath: path, words: next });
      this.dictWords.set(next);
      return { ok: true, added };
    } catch (err) {
      return { ok: false, added: 0, reason: String(err) };
    }
  }
```

- [ ] **Step 3: Hacer que el effect del editor use el service**

En `src/app/editor/editor.ts`, el effect que arranca en la línea 625. Reemplazar:

```ts
    effect(() => {
      const dict = this.sagaCtx.dictionary();
      if (!this.viewReady() || !this.tiptap) return;
      const current = untracked(() => this.grammarMatches());
      if (current.length === 0) return;
      const editor = this.tiptap;
      const filtered = current.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const word = editor.state.doc.textBetween(m.from, m.to, ' ').trim();
        return !dict.has(word.toLowerCase());
      });
```

por:

```ts
    effect(() => {
      // Touch del diccionario para que el effect corra cuando cambia. El
      // filtrado va por `isInDictionary`, que además de la grafía exacta pela
      // flexión (enclíticos, plural) — la misma guarda que usa `checkGrammar`.
      this.sagaCtx.dictionaryWords();
      if (!this.viewReady() || !this.tiptap) return;
      const current = untracked(() => this.grammarMatches());
      if (current.length === 0) return;
      const editor = this.tiptap;
      const filtered = current.filter((m) => {
        if (m.category !== 'TYPOS') return true;
        const word = editor.state.doc.textBetween(m.from, m.to, ' ').trim();
        return !this.sagaCtx.isInDictionary(word);
      });
```

- [ ] **Step 4: Verificar que compila**

Run: `pnpm build`
Expected: PASS — build de Angular sin errores de tipo. Si `tsc` se queja de que `computed` no está importado en `saga-context-service.ts`, ya está en el import de la línea 1 (`Injectable, computed, effect, inject, signal`).

- [ ] **Step 5: Verificar que el smoke runner sigue verde**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: PASS — `0 fail`. El módulo puro no cambió, pero se corre para descartar que un import circular nuevo lo rompa.

- [ ] **Step 6: Commit**

```bash
git add src/app/core/saga-context-service.ts src/app/editor/editor.ts
git commit -m "feat(diccionario): el filtro de typos pela flexión

isInDictionary suma el pelado después del miss exacto, y el effect de
re-filtrado en vivo del editor pasa a usarlo en vez de consultar el Set a
mano. Los dos sitios que filtran TYPOS quedan con una sola guarda en vez de
dos paralelas.

Suma addManyToDictionary: una sola escritura por confirmación del panel, no
una por forma."
```

---

### Task 5: Panel de formas derivadas, con entrada desde el modal del diccionario

**Files:**
- Create: `src/app/dictionary/derived-forms-panel.ts`
- Create: `src/app/dictionary/derived-forms-panel.scss`
- Modify: `src/app/dictionary/dictionary-modal.ts`
- Modify: `src/app/dictionary/dictionary-modal.html`

**Interfaces:**
- Consumes: `inferLemma`, `generateForms`, `Categoria`, `IdiomaFlexion` de Tasks 2 y 3; `existsCaseInsensitive` de `word-validator.ts`; `SagaContextService.addManyToDictionary` e `idiomaFlexion` de Task 4.
- Produces:
  - `class DerivedFormsPanel` con `input.required<string>() palabra`, `input.required<IdiomaFlexion>() idioma`, `input<readonly string[]>() existentes`, `output<string[]>() agregar`, `output<void>() cerrar`.

**Por qué la entrada va acá primero:** un panel sin punto de entrada no se puede verificar a mano. El modal del diccionario le da uno y deja la tarea comprobable sola; el popover del editor es Task 6.

- [ ] **Step 1: Crear el componente**

Crear `src/app/dictionary/derived-forms-panel.ts`:

```ts
import { Component, computed, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Categoria,
  IdiomaFlexion,
  generateForms,
  inferLemma,
} from './derived-forms';
import { existsCaseInsensitive } from './word-validator';

interface FormaItem {
  forma: string;
  yaEsta: boolean;
}

@Component({
  selector: 'app-derived-forms-panel',
  imports: [FormsModule],
  template: `
    <div class="formas-backdrop" (click)="cerrar.emit()"></div>
    <div class="formas-panel" (click)="$event.stopPropagation()">
      <header>
        <h3>Formas de «{{ palabra() }}»</h3>
        <button type="button" class="cerrar" (click)="cerrar.emit()" title="Cancelar">×</button>
      </header>

      <div class="config">
        <label class="campo">
          <span>Lema</span>
          <input
            type="text"
            [ngModel]="lema()"
            (ngModelChange)="cambiarLema($event)"
            placeholder="ej: bardear"
          />
        </label>
        <div class="campo">
          <span>Categoría</span>
          <div class="radios">
            <label>
              <input
                type="radio"
                name="categoria"
                value="verbo"
                [checked]="categoria() === 'verbo'"
                (change)="cambiarCategoria('verbo')"
              />
              verbo
            </label>
            <label>
              <input
                type="radio"
                name="categoria"
                value="adjetivo"
                [checked]="categoria() === 'adjetivo'"
                (change)="cambiarCategoria('adjetivo')"
              />
              adjetivo
            </label>
          </div>
        </div>
      </div>

      @if (formas().length === 0) {
        <p class="vacio">
          @if (categoria() === 'verbo') {
            El lema tiene que ser un infinitivo terminado en -ar, -er o -ir.
          } @else {
            Los adjetivos invariables en género no necesitan formas extra.
          }
        </p>
      } @else {
        <ul class="formas">
          @for (f of formas(); track f.forma) {
            <li [class.ya-esta]="f.yaEsta">
              <label>
                <input
                  type="checkbox"
                  [checked]="f.yaEsta || !excluidas().has(f.forma)"
                  [disabled]="f.yaEsta"
                  (change)="alternar(f.forma)"
                />
                <span class="forma">{{ f.forma }}</span>
                @if (f.yaEsta) {
                  <span class="nota">ya está</span>
                }
              </label>
            </li>
          }
        </ul>
        @if (seleccionadas().length === 0) {
          <p class="nota-plural">Todas las formas ya están en el diccionario.</p>
        } @else {
          <p class="nota-plural">
            Los plurales no hacen falta: el diccionario ya los reconoce solo.
          </p>
        }
      }

      <footer>
        <button type="button" class="btn-cancelar" (click)="cerrar.emit()">Cancelar</button>
        <button
          type="button"
          class="btn-agregar"
          [disabled]="seleccionadas().length === 0"
          (click)="agregar.emit(seleccionadas())"
        >
          Agregar {{ seleccionadas().length }}
        </button>
      </footer>
    </div>
  `,
  styleUrl: './derived-forms-panel.scss',
})
export class DerivedFormsPanel {
  palabra = input.required<string>();
  idioma = input.required<IdiomaFlexion>();
  existentes = input<readonly string[]>([]);
  agregar = output<string[]>();
  cerrar = output<void>();

  protected readonly lema = signal<string>('');
  protected readonly categoria = signal<Categoria>('verbo');
  private readonly excluidasSet = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly formas = computed<FormaItem[]>(() => {
    const existentes = this.existentes();
    return generateForms(this.lema(), this.categoria(), this.idioma()).map((forma) => ({
      forma,
      yaEsta: existsCaseInsensitive(existentes, forma),
    }));
  });

  protected readonly seleccionadas = computed<string[]>(() =>
    this.formas()
      .filter((f) => !f.yaEsta && !this.excluidasSet().has(f.forma))
      .map((f) => f.forma),
  );

  constructor() {
    // Cuando cambia la palabra de entrada, se resiembra lema y categoría desde
    // el primer candidato inferido y se limpian las exclusiones de la anterior.
    effect(() => {
      const candidato = inferLemma(this.palabra(), this.idioma())[0];
      this.lema.set(candidato?.lema ?? this.palabra().trim().toLowerCase());
      this.categoria.set(candidato?.categoria ?? 'verbo');
      this.excluidasSet.set(new Set<string>());
    });
  }

  protected excluidas(): ReadonlySet<string> {
    return this.excluidasSet();
  }

  protected cambiarLema(valor: string): void {
    this.lema.set(valor);
    this.excluidasSet.set(new Set<string>());
  }

  protected cambiarCategoria(valor: Categoria): void {
    this.categoria.set(valor);
    this.excluidasSet.set(new Set<string>());
  }

  protected alternar(forma: string): void {
    const next = new Set(this.excluidasSet());
    if (next.has(forma)) next.delete(forma);
    else next.add(forma);
    this.excluidasSet.set(next);
  }
}
```

- [ ] **Step 2: Crear los estilos**

Crear `src/app/dictionary/derived-forms-panel.scss`. Copiar los tokens de color de `dictionary-modal.scss` para que no desentone:

```scss
.formas-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 60;
}

.formas-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 61;
  width: min(28rem, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg, #1e1e22);
  color: var(--panel-fg, #e8e8ea);
  border: 1px solid var(--panel-border, #3a3a40);
  border-radius: 0.5rem;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.5);

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--panel-border, #3a3a40);

    h3 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
    }

    .cerrar {
      background: none;
      border: none;
      color: inherit;
      font-size: 1.25rem;
      line-height: 1;
      cursor: pointer;
      padding: 0 0.25rem;
    }
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--panel-border, #3a3a40);
  }
}

.config {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem 1rem;

  .campo {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;

    > span {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.7;
    }

    input[type='text'] {
      padding: 0.4rem 0.5rem;
      font: inherit;
      color: inherit;
      background: var(--input-bg, #141417);
      border: 1px solid var(--panel-border, #3a3a40);
      border-radius: 0.25rem;
    }
  }

  .radios {
    display: flex;
    gap: 1rem;

    label {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      cursor: pointer;
    }
  }
}

.formas {
  list-style: none;
  margin: 0;
  padding: 0 1rem;
  overflow-y: auto;
  flex: 1;

  li {
    label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.2rem 0;
      cursor: pointer;
    }

    &.ya-esta label {
      cursor: default;
      opacity: 0.55;
    }
  }

  .forma {
    font-family: var(--mono-font, ui-monospace, monospace);
  }

  .nota {
    font-size: 0.7rem;
    opacity: 0.7;
  }
}

.vacio,
.nota-plural {
  margin: 0;
  padding: 0.5rem 1rem 0.75rem;
  font-size: 0.8rem;
  opacity: 0.7;
}

.btn-cancelar,
.btn-agregar {
  padding: 0.4rem 0.9rem;
  font: inherit;
  border-radius: 0.25rem;
  cursor: pointer;
  border: 1px solid var(--panel-border, #3a3a40);
  background: transparent;
  color: inherit;
}

.btn-agregar {
  background: var(--accent, #4a7dff);
  border-color: var(--accent, #4a7dff);
  color: #fff;

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
```

- [ ] **Step 3: Enganchar el panel en el modal del diccionario**

En `src/app/dictionary/dictionary-modal.ts`, agregar el import del componente y del service de saga, sumarlo a `imports`, y agregar el estado y el handler:

```ts
import { DerivedFormsPanel } from './derived-forms-panel';
import { SagaContextService } from '../core/saga-context-service';
```

En el decorador: `imports: [FormsModule, LucideCheck, LucideX, DerivedFormsPanel],`

En la clase, después de `private toast = inject(ToastService);`:

```ts
  private sagaCtx = inject(SagaContextService);

  /** Palabra para la que está abierto el panel de formas derivadas, o null. */
  protected readonly formasPara = signal<string | null>(null);
  protected readonly idiomaFlexion = this.sagaCtx.idiomaFlexion;
```

Y los métodos, al lado de `addWord()`:

```ts
  protected abrirFormas(palabra: string): void {
    this.formasPara.set(palabra);
  }

  protected cerrarFormas(): void {
    this.formasPara.set(null);
  }

  protected async agregarFormas(formas: string[]): Promise<void> {
    const result = await this.sagaCtx.addManyToDictionary(formas);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudieron agregar las formas');
      return;
    }
    this.toast.success(
      result.added === 1 ? '1 forma agregada' : `${result.added} formas agregadas`,
    );
    this.formasPara.set(null);
    const target = this.editing();
    if (target) {
      await this.svc.openFor({
        name: target.nombre,
        path: target.path,
        kind: 'saga',
        children: [],
      });
    }
  }
```

Requiere el import de `TreeNode` para que el literal tipe: agregarlo arriba junto a los otros.

```ts
import { TreeNode } from '../core/types';
```

Y anotar el parámetro para que el literal no se infiera de más:

```ts
      const nodo: TreeNode = {
        name: target.nombre,
        path: target.path,
        kind: 'saga',
        children: [],
      };
      await this.svc.openFor(nodo);
```

**Por qué recargar:** `addManyToDictionary` escribe vía `SagaContextService`, que tiene su propia copia de la lista; el modal muestra la de `DictionaryService`. Sin la recarga el modal sigue mostrando el conteo viejo hasta que se cierra y se reabre. `openFor` relee `diccionario.txt` del disco, que es la fuente de verdad de las dos.

- [ ] **Step 4: Agregar el botón y el panel al template del modal**

En `src/app/dictionary/dictionary-modal.html`, dentro de `.add-row`, después del botón `Agregar` (el que tiene `class="btn-add"`):

```html
          @if (idiomaFlexion() === 'es' && canAdd()) {
            <button
              type="button"
              class="btn-add btn-formas"
              (click)="abrirFormas(newWord().trim())"
              title="Agregar también las formas derivadas"
            >
              + formas…
            </button>
          }
```

Y al final del archivo, después del `}` que cierra el `@if (editing(); as target)`:

```html
@if (formasPara(); as palabra) {
  @if (idiomaFlexion(); as idioma) {
    <app-derived-forms-panel
      [palabra]="palabra"
      [idioma]="idioma"
      [existentes]="words()"
      (agregar)="agregarFormas($event)"
      (cerrar)="cerrarFormas()"
    />
  }
}
```

- [ ] **Step 5: Verificar que compila**

Run: `pnpm build`
Expected: PASS — sin errores de tipo ni de template.

- [ ] **Step 6: Commit**

```bash
git add src/app/dictionary/derived-forms-panel.ts src/app/dictionary/derived-forms-panel.scss src/app/dictionary/dictionary-modal.ts src/app/dictionary/dictionary-modal.html
git commit -m "feat(diccionario): panel de formas derivadas con preview editable

Lema y categoría prellenados desde inferLemma, editables, y las formas
tildables una por una. Es lo que resuelve los verbos irregulares sin
modelarlos: se destilda la forma que no existe. Las que ya están en el
diccionario aparecen deshabilitadas y no cuentan para el total.

Primer punto de entrada en el modal del diccionario, que además lo hace
verificable a mano."
```

---

### Task 6: Entrada desde el popover de LanguageTool

**Files:**
- Modify: `src/app/editor/grammar-popover.ts:51-63` (footer) y `:80-92` (inputs/outputs)
- Modify: `src/app/editor/editor.ts` (handler nuevo + estado del panel)
- Modify: `src/app/editor/editor.html:413-421` (el `<app-grammar-popover>`)

**Interfaces:**
- Consumes: `DerivedFormsPanel` de Task 5; `inferLemma` de Task 3; `SagaContextService.idiomaFlexion` y `addManyToDictionary` de Task 4.
- Produces: nada que consuman tareas posteriores.

**Cuándo aparece el botón:** solo si el match es de categoría `TYPOS` **y** la saga es `es` **y** `inferLemma` devolvió al menos un candidato. En inglés y en las palabras sin forma derivable el popover queda exactamente como hoy — `+ diccionario` sigue siendo un click, sin modal.

- [ ] **Step 1: Agregar el input y el output al popover**

En `src/app/editor/grammar-popover.ts`, junto a los otros outputs (línea 85):

```ts
  canDeriveForms = input<boolean>(false);
  addToDictWithForms = output<void>();
```

Y en el template, dentro de `.footer-actions`, después del botón `+ diccionario`:

```html
            @if (canAddToDict() && canDeriveForms()) {
              <button
                type="button"
                class="dict-btn"
                (click)="addToDictWithForms.emit()"
                title="Agregar la palabra y sus formas derivadas"
              >
                + formas…
              </button>
            }
```

- [ ] **Step 2: Agregar el estado y los handlers en el editor**

En `src/app/editor/editor.ts`, sumar los imports:

```ts
import { DerivedFormsPanel } from '../dictionary/derived-forms-panel';
import { inferLemma } from '../dictionary/derived-forms';
```

Agregar `DerivedFormsPanel` al array `imports` del decorador `@Component`.

Agregar el estado, cerca de `grammarPopover`:

```ts
  /** Palabra para la que está abierto el panel de formas derivadas, o null. */
  protected readonly formasPara = signal<string | null>(null);
  protected readonly idiomaFlexion = this.sagaCtx.idiomaFlexion;

  /** El popover ofrece "+ formas…" solo si hay un lema que inferir. En inglés
   *  `inferLemma` devuelve [] y el botón no aparece. */
  protected readonly popoverPuedeDerivar = computed<boolean>(() => {
    const popover = this.grammarPopover();
    const idioma = this.idiomaFlexion();
    if (!popover || !idioma || !this.tiptap) return false;
    const word = this.tiptap.state.doc.textBetween(popover.from, popover.to, ' ').trim();
    return word.length > 0 && inferLemma(word, idioma).length > 0;
  });
```

Agregar los métodos, al lado de `addCurrentToDictionary` (línea 1175):

```ts
  protected abrirFormasDerivadas(): void {
    const popover = this.grammarPopover();
    if (!popover || !this.tiptap) return;
    const word = this.tiptap.state.doc.textBetween(popover.from, popover.to, ' ').trim();
    if (!word) return;
    this.formasPara.set(word);
    this.grammarPopover.set(null);
  }

  protected cerrarFormasDerivadas(): void {
    this.formasPara.set(null);
  }

  protected async agregarFormasDerivadas(formas: string[]): Promise<void> {
    const result = await this.sagaCtx.addManyToDictionary(formas);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudieron agregar las formas');
      return;
    }
    this.toast.success(
      result.added === 1 ? '1 forma agregada' : `${result.added} formas agregadas`,
    );
    this.formasPara.set(null);
    // No hace falta re-filtrar a mano: `addManyToDictionary` actualiza
    // `dictWords`, y el effect de re-filtrado en vivo lo toma solo.
  }
```

- [ ] **Step 3: Cablear el template del editor**

En `src/app/editor/editor.html`, el bloque de la línea 413:

```html
@if (grammarPopover(); as gp) {
  <app-grammar-popover
    [match]="gp.match"
    [anchor]="gp.anchor"
    [dictSuggestions]="gp.dictSuggestions"
    [canDeriveForms]="popoverPuedeDerivar()"
    (apply)="applyGrammarReplacement($event)"
    (dismiss)="dismissGrammarMatch()"
    (addToDict)="addCurrentToDictionary()"
    (addToDictWithForms)="abrirFormasDerivadas()"
  />
}

@if (formasPara(); as palabra) {
  @if (idiomaFlexion(); as idioma) {
    <app-derived-forms-panel
      [palabra]="palabra"
      [idioma]="idioma"
      [existentes]="sagaCtx.dictionaryWords()"
      (agregar)="agregarFormasDerivadas($event)"
      (cerrar)="cerrarFormasDerivadas()"
    />
  }
}
```

**Nota:** si `sagaCtx` es `private` en `editor.ts`, cambiarlo a `protected` para que el template lo alcance, o exponer `protected readonly dictionaryWords = this.sagaCtx.dictionaryWords;` y usar eso.

- [ ] **Step 4: Verificar que compila**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Verificar el módulo puro una vez más**

Run: `node scripts/run-derived-forms-smoke.mjs`
Expected: PASS — `0 fail`.

- [ ] **Step 6: Commit**

```bash
git add src/app/editor/grammar-popover.ts src/app/editor/editor.ts src/app/editor/editor.html
git commit -m "feat(diccionario): «+ formas…» en el popover de LanguageTool

Aparece solo en sagas en español y cuando hay un lema que inferir; el botón
«+ diccionario» de siempre queda intacto, un click y sin modal. Es el punto
de entrada que importa: el corpus muestra que las palabras se agregan desde
el popover, que es por eso que faltaban los infinitivos."
```

---

### Task 7: Verificación manual y cierre del TODO

**Files:**
- Modify: `TODO.md:1142-1165` (el item de conjugaciones)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

- [ ] **Step 1: Levantar la app**

Run: `pnpm tauri dev`

- [ ] **Step 2: Recorrer el guion de verificación**

Con LanguageTool corriendo (`scripts/start-languagetool.sh`), sobre la saga **Meridian 2.0** (`es`):

1. Abrir un capítulo que use `teletransportar`. Escribir `teletransportarían` (una forma que no está en el diccionario y que el núcleo no genera). LT la marca.
2. Click en la marca → el popover muestra `Ignorar`, `+ diccionario` y `+ formas…`.
3. Click en `+ formas…` → el panel abre con **Lema: `teletransportarer`** — que está mal, porque `-ían` infiere `-er`/`-ir`. Corregir el campo a `teletransportar`. La lista pasa a las 15 formas.
4. Destildar dos formas cualesquiera. El botón dice `Agregar 13`.
5. Confirmar → toast `13 formas agregadas`, el panel cierra, y las marcas de LT sobre las otras formas del capítulo desaparecen **sin recargar el capítulo**.
6. Escribir `teletransportándolo` → **no** queda marcada (dos pelados: `-lo`, `-se`… en realidad `-lo` y después el destildado sobre `teletransportándo`).
7. Escribir `teletransportaciones` → **sí** queda marcada si `teletransportación` no está; si está, no. Verificar cuál es el caso en el diccionario.
8. Abrir el modal del diccionario (badge del saga-header) y confirmar que las 13 formas están, en orden alfabético, y que **no** hay plurales de participio.
9. Cambiar a la saga **Milky Way** (`en`), marcar una palabra inventada: el popover muestra `+ diccionario` pero **no** `+ formas…`.
10. Escribir el plural de una palabra que ya esté en el diccionario inglés (ej: `holoblades`) → no queda marcada.

- [ ] **Step 3: Anotar lo que falle**

Cualquier desvío del guion se arregla antes de cerrar el item. El paso 3 tiene una imprecisión a propósito — `inferLemma` sobre `-ían` propone `-er`/`-ir`, no `-ar` — para confirmar que el campo de lema editable cumple su función y no es decorativo.

- [ ] **Step 4: Cerrar el item del TODO**

En `TODO.md`, marcar el item **"Agregar un verbo al diccionario y que entren todas sus conjugaciones"** con `[x]` y reemplazar el bloque de "Dos caminos, hay que elegir uno" por el resultado real: se eligió un tercero, dos mecanismos separados; el generador cubre verbos y género, el stripper cubre enclíticos y plural; el plural resultó ser el 93% del problema y los verbos un asunto exclusivamente español. Dejar el link al spec.

- [ ] **Step 5: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): cerrar el item de conjugaciones del diccionario

Verificado a mano por el autor. La solución no fue ninguno de los dos
caminos que planteaba el item: el generador cubre verbos y género, y el
pelado de flexión en el filtro cubre enclíticos y plural sin escribir nada."
```

---

## Notas para quien ejecute

- **`derived-forms.ts` no puede importar Angular.** El smoke runner lo compila suelto con `tsc`; un `import { signal } from '@angular/core'` lo rompe con un error que no dice eso.
- **`inferLemma` sobre nombres propios: limitación aceptada.** El piso de raíz
  para sufijos cortos corta `Aedan`, pero `Bastien` (raíz `basti`, 5) igual
  propone `bastier`. No hay forma de distinguir un nombre de un verbo inventado
  sin un etiquetador morfológico, y el popover solo aparece sobre palabras que LT
  no conoce — donde caen las dos cosas. El preview editable es el remedio: se
  cancela. Hay un `check` que pinea ese comportamiento para que nadie lo "arregle"
  rompiendo `bardean`.
- **El orden de `REGLAS` en `inferLemma` importa**: se prueba de sufijo más largo a más corto, y la primera que matchea gana. Agregar un sufijo corto arriba de uno largo rompe casos que ya pasan (`aba` antes de `ábamos`, por ejemplo).
- **Las tres guardas del stripper no son opcionales.** Se midieron: sobre 25.444 palabras únicas del corpus, con las guardas puestas hay 3 palabras nuevas silenciadas y las tres son plurales correctos de palabras propias del mundo. Sacar cualquiera de las tres cambia ese número.
- **`fold()` tiene que escribirse `/[\\u0300-\\u036f]/g`, con los escapes literales en el fuente.** Si se pega el rango de combining marks como caracteres reales, el regex sobrevive a algunos editores y a otros no, y cuando se rompe el fold deja de plegar acentos **en silencio**: `mirmidones` deja de caer en `mirmidón` y nadie se entera hasta que el smoke runner falla. Este plan ya se equivocó una vez en esto.
