# Vista de revisión del libro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un modal, abierto desde la tarjeta del libro, que escanea el libro entero con los cuatro detectores, muestra cuántos cambios haría cada uno, y aplica los que el autor tilde.

**Architecture:** Una función pura nueva (`planoConMapa` + `aplicarFixesHtml`) resuelve la parte riesgosa —aplicar fixes con offsets de texto plano sobre HTML sin pisar markup inline—. Un service (`revision-libro-service.ts`) orquesta escaneo y aplicación reusando el comando Rust `list_chapters_for_audit` que ya existe. Un componente modal (`revision-libro-modal.ts`) muestra los conteos y las tildes. Cero backend nuevo.

**Tech Stack:** Angular 21 standalone + signals, TypeScript 5.9, Tauri 2 (`invoke` de comandos ya existentes), smoke runners con `tsc` a un tmpdir.

**Spec:** `docs/superpowers/specs/2026-09-02-revision-libro-design.md`

## Global Constraints

- **Standalone components only**, sin NgModules. Signals para estado (`signal()`, `computed()`, `input()`, `output()`).
- **Modern templates**: `@if`, `@for`, `@switch`. Nada de `*ngIf`/`*ngFor`.
- **File naming**: `revision-libro-service.ts`, no `revision-libro.service.ts`. **Class naming**: `RevisionLibroModal`, sin sufijo `Component`.
- **Sin `public`** explícito. **Return types explícitos** en métodos. **`inject()`** para DI, no constructor params.
- **Idioma de los identificadores**: español para sustantivos de dominio (`libro`, `capitulo`, `revision`), inglés para verbos y mecánica de framework.
- **No hay runner de tests para el frontend.** Lo que corre son los smoke runners de `scripts/`, que compilan TS con `tsc` a un tmpdir. **Solo sirven para funciones puras**: nada que toque el DOM, `@tiptap/core` o el schema de ProseMirror.
- Todo lo que toque DOM se valida con `pnpm build` + verificación manual del autor.
- **Nunca marcar un item de `TODO.md` como `[x]`** hasta que el autor verifique a mano con la app levantada.
- Commits **sin** `Co-Authored-By`.

---

### Task 1: `planoConMapa` — texto plano con mapa de posiciones al HTML

**Files:**
- Create: `src/app/dialogos/plano-con-mapa.ts`
- Create: `scripts/run-plano-con-mapa-smoke.mjs`

**Interfaces:**
- Consumes: nada.
- Produces: `planoConMapa(html: string): { plain: string; mapa: Int32Array }` — `mapa[i]` es el índice en `html` del carácter `i` de `plain`. `mapa.length === plain.length`.

**Contexto que necesitás:** `src/app/dialogos/validator.ts` tiene `htmlToPlain(html)`, que produce el texto plano sobre el que `validateRae` calcula sus offsets. Es lossy de cuatro formas: saca tags (`TAG_RE`), decodifica entidades (`ENTITY_MAP`), hace `.trim()` de cada bloque y descarta los bloques vacíos; une los bloques con `\n\n` y parte por `<br>` (`BR_RE`). Leelo entero antes de empezar: `planoConMapa` tiene que producir **exactamente el mismo string**.

Los `\n\n` de unión no existen en el HTML. Para esos caracteres sintéticos, `mapa[i]` apunta al índice donde **termina** el bloque anterior en el HTML. Nunca se usan como destino de un fix (ningún fix cae sobre un separador), pero el mapa tiene que tener una entrada por carácter para que los índices no se corran.

- [ ] **Step 1: Escribir el smoke runner con los casos que fallan**

Crear `scripts/run-plano-con-mapa-smoke.mjs`, copiando la estructura de `scripts/run-tesauro-smoke.mjs` (compila con `tsc` a un tmpdir y hace `import` del JS). Compilar **dos** archivos: `src/app/dialogos/plano-con-mapa.ts` y `src/app/dialogos/validator.ts`.

```javascript
const { planoConMapa } = await import(pathToFileURL(join(outDir, 'dialogos/plano-con-mapa.js')).href);
const { htmlToPlain } = await import(pathToFileURL(join(outDir, 'dialogos/validator.js')).href);

// 1) El plano tiene que ser idéntico al de htmlToPlain. Es LA condición del
//    diseño: si se desalinean, los fixes se aplican en el lugar equivocado.
const htmls = [
  '<p>Hola mundo.</p>',
  '<p>Con <em>cursiva</em> adentro.</p>',
  '<p></p><p>Después de un bloque vacío.</p>',
  '<p>  Con espacios al borde.  </p>',
  '<p>Entidad &amp; y espacio&nbsp;duro.</p>',
  '<p>Uno<br/>Dos</p>',
  '<p>Uno.</p><p>Dos.</p><p>Tres.</p>',
  '<h1 class="chapter-title">Título</h1><p>Cuerpo.</p>',
];
let fallos = 0;
for (const html of htmls) {
  const { plain, mapa } = planoConMapa(html);
  if (plain !== htmlToPlain(html)) {
    fallos += 1;
    console.error(`FALLA plano != htmlToPlain para ${html}\n  got: ${JSON.stringify(plain)}\n  exp: ${JSON.stringify(htmlToPlain(html))}`);
  }
  if (mapa.length !== plain.length) {
    fallos += 1;
    console.error(`FALLA mapa.length ${mapa.length} != plain.length ${plain.length} para ${html}`);
  }
}

// 2) El mapa tiene que apuntar al carácter correcto del HTML.
const casos = [
  ['<p>Hola mundo.</p>', 0, 'H', 'primer carácter'],
  ['<p>Con <em>cursiva</em> adentro.</p>', 4, 'c', 'carácter adentro de la cursiva'],
  ['<p>  Con espacios.  </p>', 0, 'C', 'el trim no descoloca el mapa'],
  ['<p>Entidad &amp; fin.</p>', 8, '&', 'la entidad decodificada apunta a su inicio en el HTML'],
  ['<p></p><p>Segundo.</p>', 0, 'S', 'el bloque vacío descartado no descoloca'],
];
for (const [html, idxPlano, esperado, desc] of casos) {
  const { mapa } = planoConMapa(html);
  const got = html[mapa[idxPlano]];
  if (got !== esperado) {
    fallos += 1;
    console.error(`FALLA ${desc}: html[${mapa[idxPlano]}] = ${JSON.stringify(got)} != ${JSON.stringify(esperado)}`);
  }
}
console.log(fallos === 0 ? `${htmls.length + casos.length} chequeos OK` : `${fallos} fallas`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el smoke runner y verificar que falla**

Run: `node scripts/run-plano-con-mapa-smoke.mjs`
Expected: falla la compilación de `tsc` porque `src/app/dialogos/plano-con-mapa.ts` no existe.

- [ ] **Step 3: Implementar `planoConMapa`**

Primero, en `src/app/dialogos/validator.ts`, exportar las constantes que hoy son
privadas — duplicarlas es exactamente cómo las dos funciones se desalinean con
el tiempo:

```typescript
export const P_BLOCK_RE = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
export const BR_RE = /<br\s*\/?>/i;
export const ENTITY_MAP: Record<string, string> = { /* … sin cambios … */ };
```

Después crear `src/app/dialogos/plano-con-mapa.ts`:

```typescript
import { BR_RE, ENTITY_MAP, P_BLOCK_RE } from './validator';

const BR_SOLO_RE = /^<br\s*\/?>$/i;

/**
 * Igual que `htmlToPlain` de `validator.ts`, pero además devuelve el índice en
 * el HTML de cada carácter del plano.
 *
 * Existe porque las violaciones de `validateRae` traen offsets sobre el plano y
 * el archivo en disco es HTML: sin el mapa, aplicar un fix obliga a reconstruir
 * el HTML desde texto plano, que es como se pierden `<em>` y `<strong>`.
 *
 * `plain` DEBE salir idéntico al de `htmlToPlain`. Si las dos se desalinean los
 * fixes se aplican en el lugar equivocado y en silencio, así que el smoke
 * runner compara las dos salidas sobre HTML reales.
 */
export function planoConMapa(html: string): { plain: string; mapa: Int32Array } {
  const chars: string[] = [];
  const idx: number[] = [];
  // Buffer de la parte en curso (un bloque, o un tramo entre dos `<br>`).
  let parteChars: string[] = [];
  let parteIdx: number[] = [];

  const cerrarParte = (): void => {
    // El `.trim()` de `pushIfText`, recortando los dos arrays a la vez.
    let a = 0;
    let b = parteChars.length;
    while (a < b && /\s/.test(parteChars[a])) a += 1;
    while (b > a && /\s/.test(parteChars[b - 1])) b -= 1;
    if (b <= a) {
      parteChars = [];
      parteIdx = [];
      return; // parte vacía: se descarta, igual que `pushIfText`
    }
    if (chars.length > 0) {
      // El separador `\n\n` no existe en el HTML: se lo ancla al final del
      // bloque anterior. Ningún fix cae sobre un separador, pero el mapa
      // necesita una entrada por carácter para que los índices no se corran.
      const ancla = idx[idx.length - 1] + 1;
      chars.push('\n', '\n');
      idx.push(ancla, ancla);
    }
    for (let k = a; k < b; k += 1) {
      chars.push(parteChars[k]);
      idx.push(parteIdx[k]);
    }
    parteChars = [];
    parteIdx = [];
  };

  const comerChunk = (chunk: string, base: number): void => {
    let i = 0;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c === '<') {
        const fin = chunk.indexOf('>', i);
        if (fin === -1) {
          // `<` suelto: es texto.
          parteChars.push(c);
          parteIdx.push(base + i);
          i += 1;
          continue;
        }
        const tag = chunk.slice(i, fin + 1);
        if (BR_SOLO_RE.test(tag)) cerrarParte();
        i = fin + 1;
        continue;
      }
      if (c === '&') {
        const entidad = Object.keys(ENTITY_MAP).find((e) => chunk.startsWith(e, i));
        if (entidad) {
          parteChars.push(ENTITY_MAP[entidad]);
          parteIdx.push(base + i);
          i += entidad.length;
          continue;
        }
      }
      parteChars.push(c);
      parteIdx.push(base + i);
      i += 1;
    }
    cerrarParte();
  };

  // Mismo recorrido de bloques que `htmlToPlain`.
  const matches = Array.from(html.matchAll(P_BLOCK_RE));
  if (matches.length === 0) {
    comerChunk(html, 0);
  } else {
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      comerChunk(html.slice(last, start), last);
      // `m[1]` es el interior del `<p>`; su base es start + largo de la tag de
      // apertura.
      const apertura = m[0].length - m[1].length - '</p>'.length;
      comerChunk(m[1], start + apertura);
      last = start + m[0].length;
    }
    comerChunk(html.slice(last), last);
  }

  return { plain: chars.join(''), mapa: Int32Array.from(idx) };
}
```

- [ ] **Step 4: Correr el smoke runner y verificar que pasa**

Run: `node scripts/run-plano-con-mapa-smoke.mjs`
Expected: `13 chequeos OK`, exit 0.

- [ ] **Step 5: Verificar que no rompiste el validador**

Run: `node scripts/run-rae-smoke.mjs && pnpm build`
Expected: los dos verdes. (Tocaste `validator.ts` para exportar constantes.)

- [ ] **Step 6: Commit**

```bash
git add src/app/dialogos/plano-con-mapa.ts src/app/dialogos/validator.ts scripts/run-plano-con-mapa-smoke.mjs
git commit -m "feat(rae): plano con mapa de posiciones al HTML"
```

---

### Task 2: `aplicarFixesHtml` — aplicar fixes sin pisar markup

**Files:**
- Create: `src/app/dialogos/aplicar-fixes.ts`
- Create: `scripts/run-aplicar-fixes-smoke.mjs`

**Interfaces:**
- Consumes: `planoConMapa(html)` de Task 1.
- Produces: `aplicarFixesHtml(html: string, fixes: RaeAutoFix[]): { html: string; aplicados: number; salteados: number }`. `RaeAutoFix` ya existe en `src/app/core/types.ts:109` y es `{ offset: number; length: number; replacement: string }`, con `offset`/`length` en el espacio del **texto plano**.

**Contexto que necesitás:** los fixes se aplican en **orden descendente de offset**. Si aplicás de menor a mayor, cada reemplazo corre las posiciones de los siguientes y el segundo fix cae en el lugar equivocado.

El guard central: si el rango del HTML que corresponde al fix **contiene un `<`**, el fix cruza el borde de un tag y **no se aplica**. Saltear cinco fixes es preferible a comerse un `</em>` en veinte capítulos de una operación masiva que el autor no va a revisar archivo por archivo.

- [ ] **Step 1: Escribir el smoke runner con los casos que fallan**

Crear `scripts/run-aplicar-fixes-smoke.mjs` con la misma estructura del anterior, compilando `src/app/dialogos/aplicar-fixes.ts`.

```javascript
const { aplicarFixesHtml } = await import(pathToFileURL(join(outDir, 'dialogos/aplicar-fixes.js')).href);

const casos = [
  {
    desc: 'fix adentro de una cursiva: se aplica y la cursiva sobrevive',
    html: '<p>Dijo <em>hola</em> y se fue.</p>',
    fixes: [{ offset: 5, length: 4, replacement: 'chau' }],
    esperado: { html: '<p>Dijo <em>chau</em> y se fue.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix que cruza el borde de un tag: se saltea, el HTML no cambia',
    html: '<p>Dijo <em>hola</em> y se fue.</p>',
    fixes: [{ offset: 3, length: 5, replacement: 'XXXXX' }],
    esperado: { html: '<p>Dijo <em>hola</em> y se fue.</p>', aplicados: 0, salteados: 1 },
  },
  {
    desc: 'fix en un párrafo posterior a uno vacío: offset correcto',
    html: '<p></p><p>Hola mundo.</p>',
    fixes: [{ offset: 5, length: 5, replacement: 'tierra' }],
    esperado: { html: '<p></p><p>Hola tierra.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix después de una entidad: offset correcto pese al cambio de largo',
    html: '<p>A &amp; B final.</p>',
    fixes: [{ offset: 6, length: 5, replacement: 'FINAL' }],
    esperado: { html: '<p>A &amp; B FINAL.</p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'fix en bloque con espacios al borde: el trim no descoloca',
    html: '<p>   Hola mundo.   </p>',
    fixes: [{ offset: 0, length: 4, replacement: 'Chau' }],
    esperado: { html: '<p>   Chau mundo.   </p>', aplicados: 1, salteados: 0 },
  },
  {
    desc: 'varios fixes en el mismo párrafo: todos, sin corrimiento',
    html: '<p>uno dos tres</p>',
    fixes: [
      { offset: 0, length: 3, replacement: 'UNO' },
      { offset: 8, length: 4, replacement: 'TRES' },
    ],
    esperado: { html: '<p>UNO dos TRES</p>', aplicados: 2, salteados: 0 },
  },
  {
    desc: 'sin fixes: devuelve el html igual',
    html: '<p>Nada.</p>',
    fixes: [],
    esperado: { html: '<p>Nada.</p>', aplicados: 0, salteados: 0 },
  },
];
let fallos = 0;
for (const c of casos) {
  const r = aplicarFixesHtml(c.html, c.fixes);
  const ok = r.html === c.esperado.html
    && r.aplicados === c.esperado.aplicados
    && r.salteados === c.esperado.salteados;
  if (!ok) { fallos += 1; console.error(`FALLA ${c.desc}: ${JSON.stringify(r)} != ${JSON.stringify(c.esperado)}`); }
}
console.log(fallos === 0 ? `${casos.length} casos OK` : `${fallos} fallas`);
rmSync(outDir, { recursive: true, force: true });
process.exit(fallos === 0 ? 0 : 1);
```

- [ ] **Step 2: Correr el smoke runner y verificar que falla**

Run: `node scripts/run-aplicar-fixes-smoke.mjs`
Expected: falla la compilación porque `src/app/dialogos/aplicar-fixes.ts` no existe.

- [ ] **Step 3: Implementar `aplicarFixesHtml`**

```typescript
import { RaeAutoFix } from '../core/types';
import { planoConMapa } from './plano-con-mapa';

/**
 * Aplica fixes de RAE sobre el HTML del capítulo. Los fixes traen offsets en el
 * espacio del texto plano; el mapa de `planoConMapa` los traduce a posiciones
 * exactas del HTML, así el markup inline queda intacto.
 *
 * Un fix cuyo rango en el HTML contiene un tag NO se aplica: cruzaría el borde
 * de una cursiva y se comería el `</em>`. En una operación masiva que el autor
 * no va a revisar archivo por archivo, saltear es la única opción defendible.
 */
export function aplicarFixesHtml(
  html: string,
  fixes: RaeAutoFix[],
): { html: string; aplicados: number; salteados: number } {
  if (fixes.length === 0) return { html, aplicados: 0, salteados: 0 };
  const { plain, mapa } = planoConMapa(html);
  let out = html;
  let aplicados = 0;
  let salteados = 0;
  // Descendente: aplicar de menor a mayor correría las posiciones de los que
  // vienen después.
  const ordenados = [...fixes].sort((a, b) => b.offset - a.offset);
  for (const fix of ordenados) {
    if (fix.offset < 0 || fix.offset + fix.length > plain.length) {
      salteados += 1;
      continue;
    }
    const desde = mapa[fix.offset];
    // El índice del último carácter del span, +1 para el borde derecho: el
    // carácter puede ocupar varios en el HTML (una entidad), así que no
    // alcanza con `mapa[offset + length]`.
    const hasta = mapa[fix.offset + fix.length - 1] + largoEnHtml(html, mapa[fix.offset + fix.length - 1]);
    if (out.slice(desde, hasta).includes('<')) {
      salteados += 1;
      continue;
    }
    out = out.slice(0, desde) + fix.replacement + out.slice(hasta);
    aplicados += 1;
  }
  return { html: out, aplicados, salteados };
}

/** Cuántos caracteres del HTML ocupa el carácter de plano que arranca en `i`:
 *  1 normalmente, el largo de la entidad si ahí empieza una. */
function largoEnHtml(html: string, i: number): number {
  if (html[i] !== '&') return 1;
  const fin = html.indexOf(';', i);
  return fin === -1 || fin - i > 10 ? 1 : fin - i + 1;
}
```

- [ ] **Step 4: Correr el smoke runner y verificar que pasa**

Run: `node scripts/run-aplicar-fixes-smoke.mjs`
Expected: `7 casos OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/app/dialogos/aplicar-fixes.ts scripts/run-aplicar-fixes-smoke.mjs
git commit -m "feat(rae): aplicar fixes sobre HTML sin pisar markup inline"
```

---

### Task 3: `revision-libro-service.ts` — escaneo del libro

**Files:**
- Create: `src/app/core/revision-libro-service.ts`

**Interfaces:**
- Consumes: `aplicarFixesHtml` de Task 2 (recién en Task 4; acá solo el escaneo).
- Produces:
  - `RevisionLibroService.abrirPara(node: TreeNode): void` y `cerrar(): void`
  - `readonly libro: Signal<TreeNode | null>`
  - `readonly escaneando: Signal<boolean>`
  - `readonly resultado: Signal<ResumenRevision | null>`
  - `escanear(): Promise<void>`
  - `interface ResumenRevision { rayas: ConteoDetector; comillas: ConteoDetector; arreglosRae: ConteoDetector; repeticiones: ConteoDetector; }`
  - `interface ConteoDetector { cambios: number; capitulos: number; }`

**Contexto que necesitás:** `list_chapters_for_audit` es un comando de Rust que ya existe y devuelve `{ path, html, idioma? }[]` para un scope. Lo usan `rae-audit-service.ts:72` y `quotes-fix-service.ts`. Copiá de `quotes-fix-service.ts` el patrón de ceder el event loop cada 5 capítulos: sin eso la UI se congela en libros grandes.

- [ ] **Step 1: Implementar el service (escaneo solamente)**

```typescript
import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { convert } from '../dialogos/converter';
import { detectLang } from '../dialogos/detect';
import { htmlToPlain, validateRae } from '../dialogos/validator';
import { educateQuotes } from '../quotes/educate';
import { DEFAULTS as REP_DEFAULTS, detectRepeticiones } from '../repeticiones/detector';
import { ProjectService } from './project-service';
import { SettingsService } from './settings-service';
import { TreeNode } from './types';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ConteoDetector {
  cambios: number;
  capitulos: number;
}

export interface ResumenRevision {
  rayas: ConteoDetector;
  comillas: ConteoDetector;
  arreglosRae: ConteoDetector;
  repeticiones: ConteoDetector;
}

@Injectable({ providedIn: 'root' })
export class RevisionLibroService {
  private settings = inject(SettingsService);
  private project = inject(ProjectService);

  readonly libro = signal<TreeNode | null>(null);
  readonly escaneando = signal<boolean>(false);
  readonly resultado = signal<ResumenRevision | null>(null);
  readonly error = signal<string | null>(null);

  abrirPara(node: TreeNode): void {
    if (node.kind !== 'book') return;
    this.resultado.set(null);
    this.error.set(null);
    this.libro.set(node);
  }

  cerrar(): void {
    this.libro.set(null);
  }

  /** Palabras del diccionario de la saga que contiene al libro. `pathChain` de
   *  `landing.ts` no está exportado, así que la cadena se recorre acá; son diez
   *  líneas y no justifican tocar landing para sacarlas. */
  private async palabrasDeLaSaga(node: TreeNode): Promise<string[]> {
    const root = this.project.tree();
    if (!root) return [];
    const buscarSaga = (n: TreeNode, ancestroSaga: TreeNode | null): TreeNode | null => {
      const saga = n.kind === 'saga' ? n : ancestroSaga;
      if (n.path === node.path) return saga;
      for (const hijo of n.children) {
        const hallado = buscarSaga(hijo, saga);
        if (hallado) return hallado;
      }
      return null;
    };
    // El root del árbol también es kind 'saga' (ver `fs.rs::get_tree`), así que
    // se arranca con null para no tomarlo como la saga del libro.
    const saga = buscarSaga(root, null);
    if (!saga || saga.path === root.path) return [];
    try {
      return await invoke<string[]>('get_saga_dictionary', { sagaPath: saga.path });
    } catch {
      return [];
    }
  }

  async escanear(): Promise<void> {
    const node = this.libro();
    if (!node) return;
    this.escaneando.set(true);
    this.error.set(null);
    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      const vacio = (): ConteoDetector => ({ cambios: 0, capitulos: 0 });
      const res: ResumenRevision = {
        rayas: vacio(), comillas: vacio(), arreglosRae: vacio(), repeticiones: vacio(),
      };
      // Una sola vez para todo el libro: es el mismo diccionario de saga para
      // todos sus capítulos.
      const diccionario = await this.palabrasDeLaSaga(node);
      let procesados = 0;
      for (const p of payloads) {
        const idioma = p.idioma ?? detectLang(p.html);
        const plain = htmlToPlain(p.html);

        // Rayas: el converter acepta HTML y procesa cada <p> por separado,
        // así que preserva el markup inline.
        const conv = convert(p.html);
        if (conv.changes > 0) { res.rayas.cambios += conv.changes; res.rayas.capitulos += 1; }

        // Comillas: solo capítulos en inglés, igual que `quotes-fix-service`.
        if (idioma === 'en') {
          const q = educateQuotes(p.html);
          if (q.changes > 0) { res.comillas.cambios += q.changes; res.comillas.capitulos += 1; }
        }

        const violaciones = validateRae(plain, idioma);
        const fixables = violaciones.filter((v) => v.autoFix !== undefined).length;
        if (fixables > 0) { res.arreglosRae.cambios += fixables; res.arreglosRae.capitulos += 1; }

        const reps = detectRepeticiones(plain, idioma === 'en' ? 'en' : 'es', {
          ...REP_DEFAULTS,
          excepciones: this.settings.repeticionesExcepciones(),
          // Los nombres propios inventados del mundo. Sin esto, que `Kallai`
          // aparezca cinco veces en una escena cuenta como cinco repeticiones y
          // el número que ve el autor no significa nada. Es la misma fuente que
          // usa el detector inline del editor (`editor.ts:1333`).
          ignorar: diccionario,
        });
        if (reps.length > 0) { res.repeticiones.cambios += reps.length; res.repeticiones.capitulos += 1; }

        procesados += 1;
        if (procesados % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      this.resultado.set(res);
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.escaneando.set(false);
    }
  }
}
```

- [ ] **Step 2: Verificar que compila**

Run: `pnpm build`
Expected: sin errores. (No hay test automatizable acá: el service invoca comandos de Tauri, que no corren desde node.)

- [ ] **Step 3: Commit**

```bash
git add src/app/core/revision-libro-service.ts
git commit -m "feat(revision): escaneo del libro con los cuatro detectores"
```

---

### Task 4: aplicar lo tildado

**Files:**
- Modify: `src/app/core/revision-libro-service.ts`

**Interfaces:**
- Consumes: `aplicarFixesHtml(html, fixes)` de Task 2.
- Produces: `aplicar(seleccion: SeleccionRevision): Promise<void>` y `interface SeleccionRevision { rayas: boolean; comillas: boolean; arreglosRae: boolean; }` — repeticiones no está porque no se aplican.

**Contexto que necesitás:** cada capítulo se escribe **una sola vez**, con las tres transformaciones encadenadas sobre el mismo HTML, y solo si algo cambió. Escribir tres veces el mismo archivo genera tres commits ruidosos del auto-commit. Al terminar hay que refrescar el árbol y el status de git, igual que hace `quotes-fix-service.fixScope()`.

- [ ] **Step 1: Agregar `aplicar()` al service**

```typescript
export interface SeleccionRevision {
  rayas: boolean;
  comillas: boolean;
  arreglosRae: boolean;
}

  async aplicar(seleccion: SeleccionRevision): Promise<void> {
    const node = this.libro();
    if (!node) return;
    this.aplicando.set(true);
    const toastId = this.toast.progreso('Aplicando correcciones…');
    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      let modificados = 0;
      let salteados = 0;
      let procesados = 0;
      for (const p of payloads) {
        const idioma = p.idioma ?? detectLang(p.html);
        let html = p.html;

        if (seleccion.rayas) html = convert(html).text;
        if (seleccion.comillas && idioma === 'en') html = educateQuotes(html).text;
        if (seleccion.arreglosRae) {
          const fixes = validateRae(htmlToPlain(html), idioma)
            .map((v) => v.autoFix)
            .filter((f): f is RaeAutoFix => f !== undefined);
          const r = aplicarFixesHtml(html, fixes);
          html = r.html;
          salteados += r.salteados;
        }

        // Un solo write por capítulo, y solo si cambió: cada write dispara el
        // auto-commit del repo de novelas.
        if (html !== p.html) {
          await invoke('write_chapter', { path: p.path, html });
          modificados += 1;
        }
        procesados += 1;
        this.toast.update(toastId, `Aplicando correcciones (${procesados} de ${payloads.length})`);
        if (procesados % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (modificados > 0) {
        await this.project.loadTree();
        void this.git.refreshStatus();
      }
      this.toast.success(
        `${modificados} capítulo${modificados === 1 ? '' : 's'} modificado${modificados === 1 ? '' : 's'}.`,
      );
      if (salteados > 0) {
        // No es un error: son los fixes que cruzaban el borde de un tag y no se
        // aplicaron a propósito. Decirlo es lo mínimo — si no, el autor cuenta
        // los arreglos y no le cierra el número.
        this.toast.warn(
          `${salteados} arreglo${salteados === 1 ? '' : 's'} de RAE se saltearon por tocar texto con formato. Revisalos a mano desde el panel «Revisar RAE».`,
        );
      }
      await this.escanear();
    } catch (e) {
      this.error.set(String(e));
      this.toast.error(`Revisión: ${e}`);
    } finally {
      this.toast.dismiss(toastId);
      this.aplicando.set(false);
    }
  }
```

Agregar al tope de la clase `private project = inject(ProjectService);`, `private git = inject(GitService);`, `private toast = inject(ToastService);` y `readonly aplicando = signal<boolean>(false);`, más los imports de `RaeAutoFix` desde `./types` y `aplicarFixesHtml` desde `../dialogos/aplicar-fixes`.

- [ ] **Step 2: Verificar que compila**

Run: `pnpm build`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/app/core/revision-libro-service.ts
git commit -m "feat(revision): aplicar las correcciones tildadas al libro"
```

---

### Task 5: el modal

**Files:**
- Create: `src/app/revision-libro/revision-libro-modal.ts`
- Create: `src/app/revision-libro/revision-libro-modal.html`
- Create: `src/app/revision-libro/revision-libro-modal.scss`
- Modify: `src/app/app.html` (sumar `<app-revision-libro-modal />` junto a `<app-book-config-modal />`, hoy en la línea 335)
- Modify: `src/app/app.ts` (import + entrada en el array `imports`)

**Interfaces:**
- Consumes: todo lo de Tasks 3 y 4.
- Produces: el elemento `<app-revision-libro-modal />`.

**Contexto que necesitás:** copiá la estructura de `src/app/book-config/book-config-modal.*`, que ya sigue el patrón "service con `abrirPara`/`cerrar` + componente global en `app.html`". Para los estilos, mirá `src/app/settings-modal/settings-modal.scss` (`.gs-backdrop`, `.gs-modal`, `.gs-option`).

Cuatro filas. Las tres primeras con checkbox; **repeticiones sin checkbox**, con la leyenda "no se arreglan solas". Cada fila muestra `N cambios en M capítulos`, o "sin cambios" si `cambios === 0`. El botón de aplicar va deshabilitado si no hay nada tildado o si `cambios === 0` en todo lo tildado.

- [ ] **Step 1: Escribir el componente**

```typescript
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RevisionLibroService, SeleccionRevision } from '../core/revision-libro-service';
import { Spinner } from '../shared/spinner';

@Component({
  selector: 'app-revision-libro-modal',
  imports: [Spinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './revision-libro-modal.html',
  styleUrl: './revision-libro-modal.scss',
})
export class RevisionLibroModal {
  protected readonly svc = inject(RevisionLibroService);

  protected readonly rayas = signal<boolean>(false);
  protected readonly comillas = signal<boolean>(false);
  protected readonly arreglosRae = signal<boolean>(false);

  protected readonly puedeAplicar = computed<boolean>(() => {
    const r = this.svc.resultado();
    if (!r || this.svc.aplicando()) return false;
    return (
      (this.rayas() && r.rayas.cambios > 0)
      || (this.comillas() && r.comillas.cambios > 0)
      || (this.arreglosRae() && r.arreglosRae.cambios > 0)
    );
  });

  protected async aplicar(): Promise<void> {
    const seleccion: SeleccionRevision = {
      rayas: this.rayas(),
      comillas: this.comillas(),
      arreglosRae: this.arreglosRae(),
    };
    await this.svc.aplicar(seleccion);
  }
}
```

- [ ] **Step 2: Escribir el template**

Crear `src/app/revision-libro/revision-libro-modal.html`:

```html
@if (svc.libro(); as libro) {
  <div class="rl-backdrop" (click)="svc.cerrar()"></div>
  <div class="rl-modal" (click)="$event.stopPropagation()">
    <header class="rl-header">
      <h2>Revisar «{{ libro.name }}»</h2>
      <button type="button" class="rl-escanear" [disabled]="svc.escaneando()" (click)="svc.escanear()">
        @if (svc.escaneando()) { <app-spinner [size]="14" /> } @else { Escanear }
      </button>
    </header>

    @if (svc.error(); as err) {
      <p class="rl-error">{{ err }}</p>
    }

    @if (svc.resultado(); as r) {
      <div class="rl-body">
        <label class="rl-fila">
          <input type="checkbox" [checked]="rayas()" (change)="rayas.set(!rayas())" [disabled]="r.rayas.cambios === 0" />
          <span class="rl-nombre">Rayas RAE</span>
          <span class="rl-conteo">{{ resumen(r.rayas) }}</span>
        </label>
        <label class="rl-fila">
          <input type="checkbox" [checked]="comillas()" (change)="comillas.set(!comillas())" [disabled]="r.comillas.cambios === 0" />
          <span class="rl-nombre">Comillas tipográficas</span>
          <span class="rl-conteo">{{ resumen(r.comillas) }}</span>
        </label>
        <label class="rl-fila">
          <input type="checkbox" [checked]="arreglosRae()" (change)="arreglosRae.set(!arreglosRae())" [disabled]="r.arreglosRae.cambios === 0" />
          <span class="rl-nombre">Arreglos RAE</span>
          <span class="rl-conteo">{{ resumen(r.arreglosRae) }}</span>
        </label>
        <div class="rl-fila rl-fila-reporte">
          <span class="rl-nombre">Repeticiones</span>
          <span class="rl-conteo">{{ resumen(r.repeticiones) }}</span>
          <span class="rl-nota">no se arreglan solas: se reescriben a mano en el editor</span>
        </div>
      </div>
    } @else if (!svc.escaneando()) {
      <p class="rl-vacio">Tocá «Escanear» para ver qué se puede corregir en esta novela.</p>
    }

    <footer class="rl-actions">
      <button type="button" class="btn btn-secondary" (click)="svc.cerrar()">Cerrar</button>
      <button type="button" class="btn btn-primary" [disabled]="!puedeAplicar()" (click)="aplicar()">
        @if (svc.aplicando()) { <app-spinner [size]="14" /> } @else { Aplicar lo tildado }
      </button>
    </footer>
  </div>
}
```

Y sumar el formateador al componente, que es lógica de vista y no va en el template:

```typescript
  protected resumen(c: ConteoDetector): string {
    if (c.cambios === 0) return 'sin cambios';
    const caps = `${c.capitulos} capítulo${c.capitulos === 1 ? '' : 's'}`;
    return `${c.cambios} en ${caps}`;
  }
```

Importar `ConteoDetector` desde `../core/revision-libro-service`.

- [ ] **Step 3: Montar el modal en el shell**

En `src/app/app.html`, al lado de `<app-book-config-modal />`:

```html
<app-revision-libro-modal />
```

En `src/app/app.ts`, importar `RevisionLibroModal` y sumarlo al array `imports` del `@Component`.

- [ ] **Step 4: Verificar que compila**

Run: `pnpm build && pnpm lint:css:all`
Expected: los dos verdes.

- [ ] **Step 5: Commit**

```bash
git add src/app/revision-libro src/app/app.html src/app/app.ts
git commit -m "feat(revision): modal de revisión del libro"
```

---

### Task 6: el botón en la tarjeta del libro

**Files:**
- Modify: `src/app/landing/book-card.ts`
- Modify: `src/app/landing/book-card.html:46-58` (el bloque del botón de exportar)

**Interfaces:**
- Consumes: `RevisionLibroService.abrirPara(node)` de Task 3.
- Produces: nada; es la punta de la cadena.

**Contexto que necesitás:** `book-card.html` ya tiene dos `.card-btn`, configurar y exportar. El nuevo va **antes** del de exportar: revisar es lo que se hace antes de publicar. Usar `lucideListChecks` de `@lucide/angular`, importándolo tanto en el `import` como en el array `imports` del `@Component` — así están los otros dos en `book-card.ts:10` y `:20`.

- [ ] **Step 1: Sumar el handler al componente**

En `src/app/landing/book-card.ts`:

```typescript
  private revision = inject(RevisionLibroService);

  protected abrirRevision(event: MouseEvent): void {
    event.stopPropagation();
    this.revision.abrirPara(this.node());
  }
```

- [ ] **Step 2: Sumar el botón al template**

En `src/app/landing/book-card.html`, antes del botón de exportar:

```html
    <button
      type="button"
      class="card-btn"
      (click)="abrirRevision($event)"
      title="Revisar y corregir la novela"
    >
      <svg lucideListChecks [size]="16"></svg>
    </button>
```

- [ ] **Step 3: Verificar que compila**

Run: `pnpm build`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/app/landing/book-card.ts src/app/landing/book-card.html
git commit -m "feat(revision): botón de revisión en la tarjeta del libro"
```

---

### Task 7: verificación manual y cierre del TODO

**Files:**
- Modify: `TODO.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada.

- [ ] **Step 1: Correr toda la verificación automatizable**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/run-plano-con-mapa-smoke.mjs
node scripts/run-aplicar-fixes-smoke.mjs
node scripts/run-rae-smoke.mjs
pnpm build && pnpm lint:css:all
```
Expected: todo verde.

- [ ] **Step 2: Levantar la app y pedirle al autor que verifique**

Run: `pnpm tauri dev`

Checklist para el autor, sobre el repo de prueba `/Users/tatoh/Repos/Personal/tWriter-repo-prueba` (regenerable con `node .tooling/generar.mjs`), **no** sobre su repo real:

1. Botón nuevo en la tarjeta del libro abre el modal.
2. "Escanear" muestra conteos por detector; repeticiones aparece sin tilde.
3. Tildar rayas y aplicar: los capítulos cambian, el árbol se refresca.
4. Un capítulo con `<em>` en medio de un diálogo conserva la cursiva.
5. Si hubo fixes salteados, aparece el toast que lo dice.
6. Comillas queda en cero en un libro en español y no toca nada.

- [ ] **Step 3: Marcar el TODO solo después de que el autor confirme**

Marcar `- [x]` el item "**Bulk auto-fix** desde el panel «Revisar RAE»" con la fecha y la nota de que lo verificó a mano. **No marcar antes.**

- [ ] **Step 4: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): bulk auto-fix verificado a mano por el autor"
```
