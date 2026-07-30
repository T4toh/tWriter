# El popover de RAE deja de tirar markup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que aplicar un fix de RAE desde el popover inline deje de borrar las itálicas y negritas del párrafo.

**Architecture:** El botón de párrafo pasa a un round-trip por HTML — serializa el rango del documento, se lo da al converter (que ya acepta HTML con markup: es lo que recibe del botón "RAE" del toolbar) y reinserta HTML. Los fixes puntuales, cuyo replacement no sale del converter, pasan de `insertContent` plano a una transacción que conserva las marcas vivas del rango.

**Tech Stack:** Angular 21, TipTap 3 / ProseMirror, TypeScript 5.9.

**Spec:** `docs/superpowers/specs/2026-07-30-rae-popover-markup-design.md`

## Global Constraints

- Branch: `fix/rae-popover-markup`, sacada de `main` actualizado.
- Cero dependencias npm nuevas. `getHTMLFromFragment` ya viene en `@tiptap/core`.
- **Este repo no tiene runner de tests con DOM**: `angular.json` no define target `test` y no hay karma/jasmine/vitest/jsdom. Lo automatizado va a `scripts/run-*.mjs` con el patrón de `run-rae-smoke.mjs` (compilar con `tsc` a un tmpdir e importar el JS). Lo que depende del DOM se valida con `pnpm build` + verificación manual, igual que `highlightFirstMatch`.
- Por eso el código se parte en dos archivos: uno **sin** imports de tiptap (smoke-testeable en node) y otro con ellos. No juntarlos: el smoke runner importaría `@tiptap/core` en node y reventaría.
- Convenciones del repo: standalone, signals, `@if`/`@for`, sin `public`, return types explícitos, comentarios en español.
- Verificación: `pnpm build` tiene que pasar antes de cada commit.
- La verificación con la app levantada la hace el autor, no el implementador.

---

### Task 1: `convertFragmentHtml` + smoke runner

**Files:**
- Create: `src/app/editor/rae-convert.ts`
- Create: `scripts/run-rae-apply-smoke.mjs`

**Interfaces:**
- Consumes: `convert(text: string): { text: string; changes: number }` de `src/app/dialogos/converter.ts`.
- Produces: `convertFragmentHtml(html: string): string | null` — `null` cuando el converter no cambió nada.

- [ ] **Step 1: Escribir el smoke runner que falla**

Crear `scripts/run-rae-apply-smoke.mjs`:

```javascript
#!/usr/bin/env node
// Smoke runner de `convertFragmentHtml` (editor/rae-convert.ts). No es parte
// del build de Angular. Compila los TS necesarios a un dir temporal y corre las
// aserciones. Uso: node scripts/run-rae-apply-smoke.mjs
//
// Solo cubre la mitad SIN DOM. `serializeRange` (editor/rae-apply.ts) importa
// @tiptap/core y no se puede cargar en node: se valida con `pnpm build` + el
// checklist manual, igual que `highlightFirstMatch`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'rae-apply-smoke-'));

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
    '--allowSyntheticDefaultImports',
    '--outDir', outDir,
    'src/app/editor/rae-convert.ts',
    'src/app/dialogos/converter.ts',
    'src/app/dialogos/tags.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'editor/rae-convert.js')).href);
const { convertFragmentHtml } = mod;

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

console.log('convertFragmentHtml');
{
  // El caso del bug: hasta ahora esto se aplicaba como texto plano y el <em>
  // desaparecía del párrafo.
  const out = convertFragmentHtml('"Vení", dijo <em>ella</em>, "ya mismo".');
  check(
    'diálogo con <em> → raya y la itálica sigue envolviendo las mismas palabras',
    out === '—Vení —dijo <em>ella</em>—, ya mismo.',
    out,
  );
}
{
  const out = convertFragmentHtml('"Hola", dijo <em>Ana</em>.');
  check('el markup no se pierde en un inciso simple', out === '—Hola, dijo <em>Ana</em>.', out);
}
{
  const out = convertFragmentHtml('El <strong>capitán</strong> miró el mar.');
  check('fragmento sin nada que convertir → null', out === null, out);
}
{
  // Rango que cruza bloques: el slice serializa con <p> adentro y el converter
  // entra por su rama <p>, que procesa cada párrafo por separado.
  const out = convertFragmentHtml('<p>"Hola", dijo Ana.</p><p>"Chau", respondió.</p>');
  check(
    'fragmento con <p> → convierte cada párrafo sin colapsarlos',
    out === '<p>—Hola, dijo Ana.</p><p>—Chau, respondió.</p>',
    out,
  );
}

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
```

- [ ] **Step 2: Correr el runner y verificar que falla**

Run: `node scripts/run-rae-apply-smoke.mjs`
Expected: FAIL — `tsc` no encuentra `src/app/editor/rae-convert.ts` (error TS6053 / "File not found").

- [ ] **Step 3: Implementar el módulo**

Crear `src/app/editor/rae-convert.ts`:

```ts
/**
 * Mitad SIN DOM del apply de RAE: HTML de entrada → HTML convertido.
 *
 * Vive separado de `rae-apply.ts` a propósito. Ese importa `@tiptap/core`, que
 * no carga en node, y el smoke runner (`scripts/run-rae-apply-smoke.mjs`)
 * necesita poder importar esto sin arrastrarlo.
 */
import { convert } from '../dialogos/converter';

/**
 * Aplica las reglas RAE sobre un fragmento HTML. Devuelve `null` cuando no hay
 * nada que cambiar — el caller no dispara transacción.
 *
 * El converter ya acepta HTML con markup inline: es exactamente lo que recibe
 * del botón "RAE" del toolbar, que convierte el capítulo entero. Acá se le da
 * la misma clase de input sobre un rango más chico.
 */
export function convertFragmentHtml(html: string): string | null {
  const out = convert(html).text;
  return out === html ? null : out;
}
```

- [ ] **Step 4: Correr el runner y verificar que pasa**

Run: `node scripts/run-rae-apply-smoke.mjs`
Expected: `4 ok, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/app/editor/rae-convert.ts scripts/run-rae-apply-smoke.mjs
git commit -m "feat(rae): convertFragmentHtml, aplicar RAE sobre un fragmento HTML

Mitad sin DOM del apply, para que el fix del popover deje de reinsertar
texto plano. Smoke runner con el caso del bug: un <em> adentro de un
diálogo entre comillas sobrevive a la conversión."
```

---

### Task 2: el botón de párrafo reinserta HTML

**Files:**
- Create: `src/app/editor/rae-apply.ts`
- Modify: `src/app/editor/editor.ts` (imports ~línea 37-40, `applyRaeParagraph` líneas 1131-1147)

**Interfaces:**
- Consumes: `convertFragmentHtml` (Task 1).
- Produces: `serializeRange(doc: PmNode, from: number, to: number, schema: Schema): string`.

- [ ] **Step 1: Crear el módulo con DOM**

Crear `src/app/editor/rae-apply.ts`:

```ts
/**
 * Mitad CON DOM del apply de RAE. Importa `@tiptap/core`, así que no se puede
 * cargar desde node: lo cubren `pnpm build` y la verificación manual. La lógica
 * testeable vive en `rae-convert.ts`.
 */
import { getHTMLFromFragment } from '@tiptap/core';
import { Node as PmNode, Schema } from '@tiptap/pm/model';

/**
 * HTML del rango `from..to` del documento, con el markup inline intacto.
 *
 * Es el rango y no el nodo: `extractPlainText` mapea cada `<br>` a `\n\n` y el
 * validador parte por `\n\n`, así que un "párrafo" del validador puede ser un
 * segmento adentro de un bloque con hard breaks. Reemplazar el `<p>` entero se
 * comería el otro segmento.
 */
export function serializeRange(
  doc: PmNode,
  from: number,
  to: number,
  schema: Schema,
): string {
  return getHTMLFromFragment(doc.slice(from, to).content, schema);
}
```

- [ ] **Step 2: Importar los dos módulos en el editor**

En `src/app/editor/editor.ts`, agregar junto a los imports locales del editor (cerca de la línea 37, donde entran `findAllMatchesInPlain` / `highlightFirstMatch`):

```ts
import { convertFragmentHtml } from './rae-convert';
import { serializeRange } from './rae-apply';
```

- [ ] **Step 3: Reescribir `applyRaeParagraph`**

Reemplazar `src/app/editor/editor.ts:1131-1147` por:

```ts
  protected applyRaeParagraph(): void {
    const popover = this.raePopover();
    if (!popover || !this.tiptap) return;
    const v = popover.violation;
    if (v.paragraphFrom === undefined || v.paragraphTo === undefined) return;
    // NO se usa `v.autoFix.replacement`: es texto plano (el validador corre
    // sobre el plano del documento) y reinsertarlo borraba las itálicas y
    // negritas del párrafo. Se recalcula sobre el HTML del rango.
    const { doc, schema } = this.tiptap.state;
    const html = serializeRange(doc, v.paragraphFrom, v.paragraphTo, schema);
    const converted = convertFragmentHtml(html);
    if (converted === null) return;
    this.tiptap
      .chain()
      .focus()
      .insertContentAt({ from: v.paragraphFrom, to: v.paragraphTo }, converted)
      .run();
    this.raePopover.set(null);
    this.raeViolations.update((list) => list.filter((m) => m.id !== v.id));
    this.applyRaeDecorations(this.raeViolations());
    if (this.raeAuto()) this.scheduleRaeRecheck();
  }
```

- [ ] **Step 4: Compilar**

Run: `pnpm build 2>&1 | tail -15`
Expected: build exitoso. Si `getHTMLFromFragment` no resuelve, verificar el export con `grep -n "getHTMLFromFragment" node_modules/@tiptap/core/dist/index.d.ts` antes de cambiar el enfoque.

- [ ] **Step 5: Verificar que el smoke runner sigue verde**

Run: `node scripts/run-rae-apply-smoke.mjs`
Expected: `4 ok, 0 fail`.

- [ ] **Step 6: Commit**

```bash
git add src/app/editor/rae-apply.ts src/app/editor/editor.ts
git commit -m "fix(rae): el fix de párrafo del popover conserva el markup inline

applyRaeParagraph serializa el rango a HTML, lo pasa por el converter y
reinserta HTML, en vez de reinsertar el replacement plano del validador.
Es el rango y no el nodo: un bloque con <br> tiene más de un párrafo
para el validador."
```

---

### Task 3: los fixes puntuales conservan las marcas

**Files:**
- Modify: `src/app/editor/editor.ts` (`applyRaeFix`, líneas 1114-1129)

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: nada para tasks posteriores.

- [ ] **Step 1: Reescribir `applyRaeFix`**

Reemplazar `src/app/editor/editor.ts:1114-1129` por:

```ts
  protected applyRaeFix(): void {
    const popover = this.raePopover();
    if (!popover || !this.tiptap) return;
    const v = popover.violation;
    if (!v.autoFix || v.fixFrom === undefined || v.fixTo === undefined) return;
    const from = v.fixFrom;
    const to = v.fixTo;
    const replacement = v.autoFix.replacement;
    this.tiptap
      .chain()
      .focus()
      .command(({ tr, state, dispatch }) => {
        if (!dispatch) return true;
        // `insertContent` de texto plano dejaba el reemplazo sin marcas: un fix
        // adentro de una itálica la borraba. Se heredan las marcas vivas en
        // `from`. Con marcas mixtas adentro del span se homogeneiza — pérdida
        // acotada en un span de pocos caracteres, contra perderlas todas.
        const marks = tr.doc.resolve(from).marks();
        if (replacement.length === 0) {
          // `schema.text('')` tira excepción: un borrado va por `delete`.
          tr.delete(from, to);
        } else {
          tr.replaceWith(from, to, state.schema.text(replacement, marks));
        }
        return true;
      })
      .run();
    this.raePopover.set(null);
    this.raeViolations.update((list) => list.filter((m) => m.id !== v.id));
    this.applyRaeDecorations(this.raeViolations());
    if (this.raeAuto()) this.scheduleRaeRecheck();
  }
```

- [ ] **Step 2: Compilar**

Run: `pnpm build 2>&1 | tail -15`
Expected: build exitoso.

- [ ] **Step 3: Verificar que no quedó ningún `insertContent` plano en el path de RAE**

Run: `grep -n "insertContent" src/app/editor/editor.ts`
Expected: los usos de las líneas ~765, ~793 y ~1007 (pegado de texto/HTML y otro flujo) siguen; en `applyRaeFix` no hay ninguno y en `applyRaeParagraph` es `insertContentAt`.

- [ ] **Step 4: Commit**

```bash
git add src/app/editor/editor.ts
git commit -m "fix(rae): los fixes puntuales del popover conservan las marcas

applyRaeFix pasa de insertContent plano a una transacción que hereda las
marcas vivas en fixFrom, con delete para el replacement vacío."
```

---

### Task 4: cerrar el item del TODO

**Files:**
- Modify: `TODO.md` (item "Fix de `pending-conversion` desde popover inline", sección Validador RAE, líneas 303-309)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Marcar el item con el resumen de lo implementado**

Reemplazar el item `- **Fix de \`pending-conversion\` desde popover inline**` de `TODO.md:303` por un `- [x]` con el mismo cuerpo más:

```markdown
  **Estado**: implementado en `fix/rae-popover-markup` — spec en
  `docs/superpowers/specs/2026-07-30-rae-popover-markup-design.md`.
  `applyRaeParagraph` serializa el rango con `serializeRange`
  (`getHTMLFromFragment` de `@tiptap/core`), lo pasa por `convertFragmentHtml` y
  reinserta HTML con `insertContentAt` — es el rango y no el nodo, porque un
  bloque con `<br>` cuenta como varios párrafos para el validador. De yapa,
  `applyRaeFix` (los fixes puntuales, que tenían el mismo antipatrón con blast
  radius más chico) pasó a una transacción que hereda las marcas vivas en
  `fixFrom`. Tests: `scripts/run-rae-apply-smoke.mjs` (4 casos) + `pnpm build`;
  la parte con DOM no es automatizable en este repo (no hay runner con DOM).
  **Falta la verificación a mano** (la hace el autor).
```

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: cerrar el item del fix de pending-conversion en TODO.md"
```

---

## Verificación a mano (la hace el autor)

Después del último commit, pasarle este checklist:

1. Capítulo con un párrafo de diálogo entre comillas que tenga una palabra en itálica →
   click en la decoración naranja → "Aplicar RAE al párrafo" → sale con raya y con la
   itálica intacta, envolviendo las mismas palabras.
2. El mismo párrafo por el botón "RAE" del toolbar → mismo resultado que por el popover.
3. Un párrafo armado con Shift+Enter (dos diálogos separados por `<br>`) → aplicar sobre uno
   solo y confirmar que el otro segmento y el salto quedaron intactos.
4. Un fix puntual (carácter/typo) sobre texto en itálica → el reemplazo queda en itálica.
5. Aplicar un fix y confirmar que el re-chequeo automático posterior no deja violaciones
   fantasma sobre el texto ya arreglado.
