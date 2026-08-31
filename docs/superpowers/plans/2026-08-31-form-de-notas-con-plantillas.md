# Form de notas con plantillas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el `selectPrompt` de creación de notas por un form de bloques editables (título, subtítulo, lista, párrafo) con plantillas de fábrica sacadas del corpus real y plantillas propias guardables como `.md` en `<root>/Plantillas/`.

**Architecture:** Un módulo puro (`shared/note-blocks.ts`) traduce markdown ⇄ bloques en las dos direcciones; las plantillas — de fábrica y del autor — son markdown, así que hay un solo camino de código. Un service (`core/note-form-service.ts`) tiene el estado del modal y los `invoke`, y un componente standalone montado en `app.html` rinde el form, igual que `split-chapter-modal`. Rust solo suma dos comandos para listar y escribir la carpeta de plantillas.

**Tech Stack:** Angular 21 (standalone, signals, `@if`/`@for`), TypeScript 5.9, Tauri 2 / Rust, smoke runners de `scripts/` con `tsc` (no hay runner de tests de frontend en este repo).

**Spec:** `docs/superpowers/specs/2026-08-31-form-de-notas-con-plantillas-design.md`

## Global Constraints

- **Standalone components**, sin NgModules. Signals para estado (`signal()`, `computed()`, `input()`).
- **Templates modernos**: `@if`, `@for`, `@switch`. Nada de `*ngIf`/`*ngFor`.
- **File naming**: `note-blocks.ts`, `note-form-service.ts` — sin `.component`/`.service`.
- **Class naming**: `NoteFormModal`, `NoteFormService`. Sin sufijo `Component`.
- **Sin `public`** explícito. **Return types explícitos** en métodos. `inject()` para DI.
- Español para UI, comentarios y nombres de dominio.
- **El remedio se da adentro de la app**: si algo falla y la app lo puede detectar, decir qué pasó y qué hacer.
- No hay runner de tests de frontend. Lo puro se prueba con un smoke runner de `scripts/`; lo que toca DOM lo verifica el autor a mano con la app levantada, y **el item del TODO no se marca hasta entonces**.
- Comandos: `pnpm build` (Angular), `cargo test --manifest-path src-tauri/Cargo.toml` (Rust), `node scripts/run-<algo>-smoke.mjs`.
- Nunca firmar commits como co-autor.

---

## Task 0: Rama de trabajo

**Files:** ninguno.

- [ ] **Step 1: Partir de `main` actualizado**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/form-de-notas-con-plantillas
```

---

## Task 1: `note-blocks.ts` — markdown ⇄ bloques

**Files:**
- Create: `src/app/shared/note-blocks.ts`
- Create: `scripts/run-note-blocks-smoke.mjs`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type BloqueTipo = 'h1' | 'h2' | 'lista' | 'parrafo'`
  - `interface Bloque { tipo: BloqueTipo; texto: string; items: string[] }`
  - `markdownABloques(md: string): Bloque[]`
  - `bloquesAMarkdown(bloques: readonly Bloque[], opts?: { plantilla?: boolean }): string`
  - `bloqueVacio(tipo: BloqueTipo): Bloque`

- [ ] **Step 1: Escribir el smoke runner con las aserciones (falla primero)**

Create `scripts/run-note-blocks-smoke.mjs`:

```js
#!/usr/bin/env node
// Smoke runner de note-blocks (markdown <-> bloques). No es parte del build de Angular.
// Compila el TS a un dir temporal y corre las aserciones.
// Uso: node scripts/run-note-blocks-smoke.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const outDir = mkdtempSync(join(tmpdir(), 'note-blocks-smoke-'));

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
    'src/app/shared/note-blocks.ts',
  ],
  { cwd: repo, encoding: 'utf8' },
);
if (r.status !== 0) {
  console.error(r.stdout);
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}

const mod = await import(pathToFileURL(join(outDir, 'note-blocks.js')).href);
const { markdownABloques, bloquesAMarkdown, bloqueVacio } = mod;

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
const tipos = (bs) => bs.map((b) => b.tipo).join(',');

console.log('markdownABloques — headings');
{
  const bs = markdownABloques('# Aedan\n\n## Raza\n- Humano\n');
  check('h1 + h2 + lista', tipos(bs) === 'h1,h2,lista', tipos(bs));
  check('el h1 guarda el título', bs[0].texto === 'Aedan', bs[0].texto);
  check('la lista guarda el item', bs[2].items.length === 1 && bs[2].items[0] === 'Humano', JSON.stringify(bs[2]));
}
{
  const bs = markdownABloques('### Muy anidado\n');
  check('###+ colapsa a h2', tipos(bs) === 'h2,parrafo', tipos(bs));
}

console.log('markdownABloques — párrafo implícito');
{
  const bs = markdownABloques('## Descripción\n\n## Objetos\n-\n');
  check('heading sin nada abajo genera parrafo vacío', tipos(bs) === 'h2,parrafo,h2,lista', tipos(bs));
  check('el parrafo implícito viene vacío', bs[1].texto === '', JSON.stringify(bs[1]));
  check('el heading con bullet NO genera parrafo', bs[3].items.length === 1 && bs[3].items[0] === '', JSON.stringify(bs[3]));
}

console.log('markdownABloques — prosa y bullets');
{
  const bs = markdownABloques('Islota en el mar del norte. \\\nLugar natal de los humanos.\n');
  check('líneas seguidas quedan en UN parrafo', tipos(bs) === 'parrafo', tipos(bs));
  check('el salto duro sobrevive', bs[0].texto.includes('\\\n'), JSON.stringify(bs[0].texto));
}
{
  const bs = markdownABloques('- uno\n* dos\n+ tres\n');
  check('-, * y + entran a la misma lista', tipos(bs) === 'lista' && bs[0].items.length === 3, JSON.stringify(bs));
}
{
  const bs = markdownABloques('- Humano\n\nProsa aparte\n');
  check('línea vacía corta la lista', tipos(bs) === 'lista,parrafo', tipos(bs));
}
{
  const bs = markdownABloques('---\n');
  check('--- no es bullet', tipos(bs) === 'parrafo', tipos(bs));
}
{
  const bs = markdownABloques('');
  check('markdown vacío → sin bloques', bs.length === 0, JSON.stringify(bs));
}

console.log('bloquesAMarkdown — modo nota');
{
  const bs = [
    { tipo: 'h2', texto: 'Raza', items: [] },
    { tipo: 'lista', texto: '', items: ['Humano', '  ', ''] },
    { tipo: 'h2', texto: 'Objetos', items: [] },
    { tipo: 'lista', texto: '', items: ['', ''] },
    { tipo: 'parrafo', texto: '', items: [] },
  ];
  const md = bloquesAMarkdown(bs);
  check('descarta items vacíos', md.includes('- Humano') && !md.includes('- \n'), JSON.stringify(md));
  check('descarta la lista entera si quedó vacía', !md.includes('Objetos'), JSON.stringify(md));
  check('descarta el parrafo vacío', md.trim().split('\n').length === 2, JSON.stringify(md));
  check('termina en newline', md.endsWith('\n'), JSON.stringify(md));
}
{
  check('sin bloques con contenido → string vacío', bloquesAMarkdown([{ tipo: 'parrafo', texto: '', items: [] }]) === '');
}

console.log('bloquesAMarkdown — modo plantilla');
{
  const bs = markdownABloques('## Descripción\n\n## Atajos\n- ¡Fuego!\n');
  const tpl = bloquesAMarkdown(bs, { plantilla: true });
  check('la plantilla no lleva contenido', !tpl.includes('¡Fuego!'), JSON.stringify(tpl));
  check('la plantilla conserva un bullet vacío', tpl.includes('\n-'), JSON.stringify(tpl));
  const back = markdownABloques(tpl);
  check('round-trip: mismos tipos', tipos(back) === tipos(bs), `${tipos(back)} vs ${tipos(bs)}`);
  check('round-trip: mismos títulos', back[0].texto === 'Descripción' && back[2].texto === 'Atajos', JSON.stringify(back));
  const back2 = markdownABloques(bloquesAMarkdown(back, { plantilla: true }));
  check('round-trip estable en la segunda vuelta', tipos(back2) === tipos(back), `${tipos(back2)} vs ${tipos(back)}`);
}

console.log('bloqueVacio');
{
  const l = bloqueVacio('lista');
  check('lista arranca con un item vacío', l.items.length === 1 && l.items[0] === '', JSON.stringify(l));
  check('h2 arranca sin items', bloqueVacio('h2').items.length === 0);
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Correrlo para verificar que falla**

Run: `node scripts/run-note-blocks-smoke.mjs`
Expected: FAIL — `tsc` no encuentra `src/app/shared/note-blocks.ts` (error TS6053 "File not found").

- [ ] **Step 3: Implementar `note-blocks.ts`**

Create `src/app/shared/note-blocks.ts`:

```ts
/**
 * Markdown de una nota ⇄ bloques editables del form de creación.
 *
 * Las plantillas (de fábrica y las del autor en `<root>/Plantillas/`) son
 * markdown, así que este módulo es el único traductor y hay un solo camino de
 * código para las dos fuentes. Puro: sin DOM, sin Angular. Cubierto por
 * `scripts/run-note-blocks-smoke.mjs`.
 */

export type BloqueTipo = 'h1' | 'h2' | 'lista' | 'parrafo';

export interface Bloque {
  tipo: BloqueTipo;
  /** h1/h2: el título. parrafo: el cuerpo (puede tener saltos). lista: ''. */
  texto: string;
  /** Solo `lista`. Vacío en los otros tipos. */
  items: string[];
}

export interface RenderOpts {
  /** Guarda la estructura sin el contenido: es lo que se escribe a `Plantillas/`. */
  plantilla?: boolean;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
/** Exige espacio (o nada) después del marcador, para que `---` y `-Hola` no sean bullets. */
const BULLET = /^\s*[-*+](?:\s+(.*))?$/;

export function bloqueVacio(tipo: BloqueTipo): Bloque {
  return { tipo, texto: '', items: tipo === 'lista' ? [''] : [] };
}

export function markdownABloques(md: string): Bloque[] {
  const out: Bloque[] = [];
  let lista: string[] | null = null;
  let parrafo: string[] | null = null;

  const cerrar = (): void => {
    if (lista) {
      out.push({ tipo: 'lista', texto: '', items: lista });
      lista = null;
    }
    if (parrafo) {
      out.push({ tipo: 'parrafo', texto: parrafo.join('\n'), items: [] });
      parrafo = null;
    }
  };

  for (const raw of md.split(/\r?\n/)) {
    const linea = raw.trimEnd();
    const h = HEADING.exec(linea);
    if (h) {
      cerrar();
      // ponytail: el modelo tiene dos niveles; ###+ colapsa a h2. Sumar 'h3' si
      // aparece una nota con jerarquía de tres niveles que importe.
      out.push({ tipo: h[1].length === 1 ? 'h1' : 'h2', texto: h[2].trim(), items: [] });
      continue;
    }
    const b = BULLET.exec(linea);
    if (b) {
      cerrar();
      lista = lista ?? [];
      lista.push((b[1] ?? '').trim());
      continue;
    }
    if (linea.trim() === '') {
      cerrar();
      continue;
    }
    cerrar();
    parrafo = parrafo ?? [];
    parrafo.push(linea);
  }
  cerrar();
  return conParrafosImplicitos(out);
}

/** Un heading sin nada abajo significa "sección de prosa": en un `.md` vacío es
 *  lo único que distingue un párrafo de una lista (que deja su bullet). Sin esto,
 *  guardar `Conjuro` como plantilla y recargarla deja `Descripción` sin campo. */
function conParrafosImplicitos(bloques: readonly Bloque[]): Bloque[] {
  const out: Bloque[] = [];
  for (let i = 0; i < bloques.length; i++) {
    const b = bloques[i];
    out.push(b);
    if (b.tipo !== 'h1' && b.tipo !== 'h2') continue;
    const sig = bloques[i + 1];
    if (!sig || sig.tipo === 'h1' || sig.tipo === 'h2') out.push(bloqueVacio('parrafo'));
  }
  return out;
}

export function bloquesAMarkdown(bloques: readonly Bloque[], opts: RenderOpts = {}): string {
  const plantilla = opts.plantilla === true;
  const partes: string[] = [];
  for (const b of bloques) {
    if (b.tipo === 'h1' || b.tipo === 'h2') {
      const texto = b.texto.trim();
      if (texto === '' && !plantilla) continue;
      partes.push(`${b.tipo === 'h1' ? '#' : '##'} ${texto}`.trimEnd());
      continue;
    }
    if (b.tipo === 'lista') {
      if (plantilla) {
        // El bullet vacío es lo que marca "esta sección es una lista" al reparsear.
        partes.push('-');
        continue;
      }
      const items = b.items.map((i) => i.trim()).filter((i) => i !== '');
      if (items.length === 0) continue;
      partes.push(items.map((i) => `- ${i}`).join('\n'));
      continue;
    }
    if (plantilla) continue;
    const texto = b.texto.trim();
    if (texto === '') continue;
    partes.push(texto);
  }
  return partes.length === 0 ? '' : `${partes.join('\n\n')}\n`;
}
```

- [ ] **Step 4: Correr el smoke y verificar que pasa**

Run: `node scripts/run-note-blocks-smoke.mjs`
Expected: PASS, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add src/app/shared/note-blocks.ts scripts/run-note-blocks-smoke.mjs
git commit -m "feat(notas): traductor markdown <-> bloques para el form de creación"
```

---

## Task 2: Plantillas de fábrica como markdown

**Files:**
- Modify: `src/app/shared/note-templates.ts` (reescritura completa)
- Modify: `scripts/run-note-templates-smoke.mjs` (aserciones nuevas)
- Modify: `src/app/shared/node-actions-service.ts:737-771` (que siga compilando con la API nueva)

**Interfaces:**
- Consumes: `markdownABloques`, `bloquesAMarkdown`, `Bloque` de Task 1.
- Produces:
  - `interface NoteTemplate { id: string; label: string; markdown: string; origen: 'fabrica' | 'archivo' }`
  - `const NOTE_TEMPLATES: readonly NoteTemplate[]` — las 6 de fábrica
  - `combinarPlantillas(fabrica: readonly NoteTemplate[], archivos: readonly { nombre: string; markdown: string }[]): NoteTemplate[]`
  - `bloquesDePlantilla(tpl: NoteTemplate): Bloque[]`

- [ ] **Step 1: Escribir las aserciones nuevas en el smoke de plantillas**

Replace todo lo que sigue a la línea `const mod = await import(...)` en `scripts/run-note-templates-smoke.mjs` — y en el array de entrada de `tsc`, agregar `'src/app/shared/note-blocks.ts'` después de `'src/app/shared/note-templates.ts'`:

```js
const mod = await import(pathToFileURL(join(outDir, 'note-templates.js')).href);
const { NOTE_TEMPLATES, combinarPlantillas, bloquesDePlantilla } = mod;

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

console.log('NOTE_TEMPLATES');
check('son 6', NOTE_TEMPLATES.length === 6, NOTE_TEMPLATES.length);
check(
  'los ids son los del spec',
  NOTE_TEMPLATES.map((t) => t.id).join(',') === 'vacia,personaje,conjuro,mundo,lista-agrupada,catalogo',
  NOTE_TEMPLATES.map((t) => t.id).join(','),
);
check('todas son de fábrica', NOTE_TEMPLATES.every((t) => t.origen === 'fabrica'));

{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'personaje'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check(
    'personaje trae las 5 secciones del corpus',
    h2.join(',') === 'Raza,Características,Objetos,Magia,Detalles',
    h2.join(','),
  );
  check('las 5 son listas', bs.filter((b) => b.tipo === 'lista').length === 5, JSON.stringify(bs.map((b) => b.tipo)));
  check('personaje NO trae h1', !bs.some((b) => b.tipo === 'h1'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'conjuro'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('conjuro trae las 3 del corpus', h2.join(',') === 'Descripción,Atajos e Encantaciones,Conjuro', h2.join(','));
  check('Descripción es párrafo', bs[1].tipo === 'parrafo', JSON.stringify(bs.map((b) => b.tipo)));
  check('Atajos es lista', bs[3].tipo === 'lista', JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'vacia'));
  check('vacia arranca con h1', bs[0].tipo === 'h1', JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'catalogo'));
  check('catalogo trae h1 + h2', bs.some((b) => b.tipo === 'h1') && bs.some((b) => b.tipo === 'h2'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'mundo'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('mundo trae General/Lugares/Personajes', h2.join(',') === 'General,Lugares,Personajes', h2.join(','));
  check('mundo es prosa, sin listas', !bs.some((b) => b.tipo === 'lista'), JSON.stringify(bs.map((b) => b.tipo)));
}
{
  const bs = bloquesDePlantilla(NOTE_TEMPLATES.find((t) => t.id === 'lista-agrupada'));
  const h2 = bs.filter((b) => b.tipo === 'h2').map((b) => b.texto);
  check('lista-agrupada copia los títulos de Personajes.md', h2.join(',') === 'Principales,Secundarios (Orden de Aparición)', h2.join(','));
}

console.log('combinarPlantillas');
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'Conjuro', markdown: '## Otra cosa\n' }]);
  const conjuro = out.find((t) => t.label === 'Conjuro');
  check('el archivo del autor le gana a la de fábrica', conjuro.origen === 'archivo', JSON.stringify(conjuro));
  check('no duplica la entrada', out.filter((t) => t.label === 'Conjuro').length === 1, JSON.stringify(out.map((t) => t.label)));
  check('sigue habiendo 6', out.length === 6, out.length);
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'conjuro', markdown: '## x\n' }]);
  check('la colisión es case-insensitive', out.length === 6 && out.find((t) => t.label === 'conjuro').origen === 'archivo', JSON.stringify(out.map((t) => `${t.label}:${t.origen}`)));
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [
    { nombre: 'Nave', markdown: '## Tripulación\n-\n' },
    { nombre: 'Arma', markdown: '## Daño\n' },
  ]);
  check('las plantillas nuevas se suman al final', out.length === 8, out.length);
  check('y van ordenadas alfabéticamente', out.slice(6).map((t) => t.label).join(',') === 'Arma,Nave', out.slice(6).map((t) => t.label).join(','));
  check('las de fábrica mantienen su orden', out.slice(0, 6).map((t) => t.id).join(',') === 'vacia,personaje,conjuro,mundo,lista-agrupada,catalogo', out.slice(0, 6).map((t) => t.id).join(','));
}
{
  const out = combinarPlantillas(NOTE_TEMPLATES, [{ nombre: 'Rota', markdown: '   \n' }]);
  check('una plantilla que no parsea a nada se descarta', !out.some((t) => t.label === 'Rota'), JSON.stringify(out.map((t) => t.label)));
}

console.log('');
console.log(`${passed} ok, ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Correrlo para verificar que falla**

Run: `node scripts/run-note-templates-smoke.mjs`
Expected: FAIL — `combinarPlantillas` no existe (`TypeError: combinarPlantillas is not a function`), o `tsc` rompe por el import nuevo.

- [ ] **Step 3: Reescribir `note-templates.ts`**

Replace el contenido completo de `src/app/shared/note-templates.ts`:

```ts
/**
 * Plantillas de notas. Las formas salen del relevamiento del corpus real
 * (`~/novelas/Notas`, 114 `.md`, 2026-08-31), no de un modelo inventado:
 *
 *  - `personaje`: 20 fichas `Notas/Meridian/<libro>/<nombre>.md`
 *  - `conjuro`: 15 archivos `Magia y asociados/Conjuros (Lista)/*.md`
 *  - `mundo`: 4 archivos `Notas/Meridian/<libro>/Mundo.md`
 *  - `lista-agrupada`: `Personajes.md` de Meridian y Buenos Aires 2077
 *  - `catalogo`: ~25 archivos con un heading por entrada (Monstruos, Lugares.md)
 *
 * La plantilla ES markdown: así las de fábrica y las que el autor guarda en
 * `<root>/Plantillas/*.md` comparten un solo camino de código. Ojo con el H1:
 * `personaje`, `conjuro`, `mundo` y `lista-agrupada` arrancan SIN título, porque
 * las notas que el autor ya escribe no lo tienen.
 *
 * Puro: sin DOM, sin Angular. Cubierto por `scripts/run-note-templates-smoke.mjs`.
 */
import { Bloque, markdownABloques } from './note-blocks';

export interface NoteTemplate {
  id: string;
  label: string;
  markdown: string;
  origen: 'fabrica' | 'archivo';
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  { id: 'vacia', label: 'Vacía', origen: 'fabrica', markdown: '# \n' },
  {
    id: 'personaje',
    label: 'Personaje',
    origen: 'fabrica',
    markdown: '## Raza\n-\n\n## Características\n-\n\n## Objetos\n-\n\n## Magia\n-\n\n## Detalles\n-\n',
  },
  {
    id: 'conjuro',
    label: 'Conjuro',
    origen: 'fabrica',
    markdown: '## Descripción\n\n## Atajos e Encantaciones\n-\n\n## Conjuro\n',
  },
  {
    id: 'mundo',
    label: 'Mundo (estado del libro)',
    origen: 'fabrica',
    markdown: '## General\n\n## Lugares\n\n## Personajes\n',
  },
  {
    id: 'lista-agrupada',
    label: 'Lista agrupada',
    origen: 'fabrica',
    markdown: '## Principales\n-\n\n## Secundarios (Orden de Aparición)\n-\n',
  },
  { id: 'catalogo', label: 'Catálogo por entradas', origen: 'fabrica', markdown: '# \n\n## \n' },
] as const;

export function bloquesDePlantilla(tpl: NoteTemplate): Bloque[] {
  return markdownABloques(tpl.markdown);
}

/** Junta las de fábrica con los `.md` de `<root>/Plantillas/`. El archivo del
 *  autor le gana a la de fábrica con el mismo nombre (comparación
 *  case-insensitive), así puede pisar una plantilla shipeada sin esperar un
 *  release. Las que no existen de fábrica se suman al final, alfabéticas. Una
 *  plantilla que no parsea a ningún bloque se descarta. */
export function combinarPlantillas(
  fabrica: readonly NoteTemplate[],
  archivos: readonly { nombre: string; markdown: string }[],
): NoteTemplate[] {
  const utiles = archivos.filter((a) => markdownABloques(a.markdown).length > 0);
  const porNombre = new Map<string, { nombre: string; markdown: string }>();
  for (const a of utiles) porNombre.set(a.nombre.toLowerCase(), a);

  const out: NoteTemplate[] = fabrica.map((t) => {
    const propia = porNombre.get(t.label.toLowerCase());
    if (!propia) return t;
    porNombre.delete(t.label.toLowerCase());
    return { id: t.id, label: propia.nombre, markdown: propia.markdown, origen: 'archivo' };
  });

  const extras = [...porNombre.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  for (const e of extras) {
    out.push({ id: `archivo:${e.nombre}`, label: e.nombre, markdown: e.markdown, origen: 'archivo' });
  }
  return out;
}
```

- [ ] **Step 4: Adaptar `createNoteIn` a la API nueva (sin cambiar la UI todavía)**

`renderNoteTemplate` ya no existe, así que `node-actions-service.ts` no compila. Cambio mínimo para dejar el build verde; el modal nuevo llega en Task 5.

En `src/app/shared/node-actions-service.ts`, cambiar el import:

```ts
import { NOTE_TEMPLATES, bloquesDePlantilla } from './note-templates';
```

y en `createNoteIn`, reemplazar la línea del body:

```ts
    const tpl = NOTE_TEMPLATES.find((t) => t.id === res.selected);
    const bloques = tpl ? bloquesDePlantilla(tpl) : [];
    const h1 = bloques.find((b) => b.tipo === 'h1');
    if (h1) h1.texto = titulo;
    const body = bloquesAMarkdown(bloques) || null;
```

y sumar el import de `bloquesAMarkdown`:

```ts
import { bloquesAMarkdown } from './note-blocks';
```

- [ ] **Step 5: Correr el smoke y el build**

Run: `node scripts/run-note-templates-smoke.mjs && node scripts/run-note-blocks-smoke.mjs && pnpm build`
Expected: los dos smokes en `0 fail` y el build de Angular sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/app/shared/note-templates.ts src/app/shared/node-actions-service.ts scripts/run-note-templates-smoke.mjs
git commit -m "feat(notas): plantillas de fábrica como markdown, sacadas del corpus real"
```

---

## Task 3: Backend — carpeta `Plantillas/`

**Files:**
- Modify: `src-tauri/src/notes.rs` (dos comandos + tests)
- Modify: `src-tauri/src/lib.rs:60` (use) y el `generate_handler!` (~línea 143)
- Modify: `src-tauri/src/fs.rs:40-52` (`SKIP_DIRS`)

**Interfaces:**
- Consumes: nada del frontend.
- Produces:
  - `list_note_templates(root: String) -> Result<Vec<NoteTemplateFile>, String>`
  - `save_note_template(root: String, nombre: String, markdown: String, overwrite: bool) -> Result<String, String>`
  - `NoteTemplateFile { nombre: String, path: String, markdown: String }` (serde: camelCase por default no aplica, los campos ya son de una palabra)

- [ ] **Step 1: Escribir los tests en `notes.rs`**

Agregar dentro de `mod tests` (al final, antes del `}` que cierra el módulo):

```rust
    #[test]
    fn list_note_templates_sin_carpeta_es_lista_vacia() {
        let dir = tmp_dir("tpl-vacio");
        let out = list_note_templates(dir.to_string_lossy().into_owned()).unwrap();
        assert!(out.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_note_templates_ordena_e_ignora_lo_que_no_es_md() {
        let dir = tmp_dir("tpl-list");
        let plantillas = dir.join("Plantillas");
        fs::create_dir_all(plantillas.join("subdir")).unwrap();
        fs::write(plantillas.join("Nave.md"), "## Tripulación\n-\n").unwrap();
        fs::write(plantillas.join("Arma.md"), "## Daño\n").unwrap();
        fs::write(plantillas.join("notas.txt"), "no soy plantilla").unwrap();
        let out = list_note_templates(dir.to_string_lossy().into_owned()).unwrap();
        let nombres: Vec<&str> = out.iter().map(|t| t.nombre.as_str()).collect();
        assert_eq!(nombres, vec!["Arma", "Nave"]);
        assert!(out[1].markdown.contains("Tripulación"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_crea_la_carpeta_la_primera_vez() {
        let dir = tmp_dir("tpl-save");
        let path = save_note_template(
            dir.to_string_lossy().into_owned(),
            "Nave".into(),
            "## Tripulación\n-".into(),
            false,
        )
        .unwrap();
        assert!(PathBuf::from(&path).is_file());
        assert!(path.ends_with("Nave.md"));
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.ends_with('\n'), "siempre termina en newline: {:?}", body);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_no_pisa_sin_overwrite() {
        let dir = tmp_dir("tpl-overwrite");
        let root = dir.to_string_lossy().into_owned();
        save_note_template(root.clone(), "Nave".into(), "## Uno\n".into(), false).unwrap();
        let err = save_note_template(root.clone(), "Nave".into(), "## Dos\n".into(), false)
            .unwrap_err();
        assert!(err.contains("ya existe"), "{}", err);
        let path = save_note_template(root, "Nave".into(), "## Dos\n".into(), true).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("Dos"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_note_template_rechaza_nombres_con_separadores() {
        let dir = tmp_dir("tpl-nombre");
        let root = dir.to_string_lossy().into_owned();
        assert!(save_note_template(root.clone(), "  ".into(), "## x\n".into(), false).is_err());
        assert!(save_note_template(root.clone(), "a/b".into(), "## x\n".into(), false).is_err());
        assert!(save_note_template(root, "a\\b".into(), "## x\n".into(), false).is_err());
        fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml notes::`
Expected: FAIL de compilación — `cannot find function list_note_templates` / `save_note_template`.

- [ ] **Step 3: Implementar los comandos**

Agregar en `src-tauri/src/notes.rs`, después de `create_folder` y antes de `mod tests`:

```rust
/// Carpeta de plantillas del autor. Está en `SKIP_DIRS` de `fs.rs`, así que no
/// aparece en el árbol; sí se commitea con el resto del repo de novelas.
const TEMPLATES_DIR_NAME: &str = "Plantillas";

#[derive(Serialize, Debug)]
pub struct NoteTemplateFile {
    pub nombre: String,
    pub path: String,
    pub markdown: String,
}

fn templates_dir(root: &str) -> PathBuf {
    PathBuf::from(root).join(TEMPLATES_DIR_NAME)
}

#[tauri::command]
pub fn list_note_templates(root: String) -> Result<Vec<NoteTemplateFile>, String> {
    let dir = templates_dir(&root);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<NoteTemplateFile> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || !is_note_path(&path) {
            continue;
        }
        let Some(nombre) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if nombre.is_empty() {
            continue;
        }
        let markdown = fs::read_to_string(&path).map_err(|e| {
            tracing::error!(target: "note", path = %path.display(), error = %e, "list_note_templates: read falló");
            e.to_string()
        })?;
        out.push(NoteTemplateFile {
            nombre: nombre.to_string(),
            path: path.to_string_lossy().into_owned(),
            markdown,
        });
    }
    out.sort_by(|a, b| a.nombre.to_lowercase().cmp(&b.nombre.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn save_note_template(
    root: String,
    nombre: String,
    markdown: String,
    overwrite: bool,
) -> Result<String, String> {
    let trimmed = nombre.trim();
    if trimmed.is_empty() {
        return Err("nombre vacío".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("nombre no puede contener separadores de path".to_string());
    }
    // No se pasa por `write_note`: exige que la carpeta padre exista, y la
    // primera plantilla es justamente la que la crea.
    let dir = templates_dir(&root);
    fs::create_dir_all(&dir).map_err(|e| {
        tracing::error!(target: "note", path = %dir.display(), error = %e, "save_note_template: no pude crear la carpeta");
        e.to_string()
    })?;
    let target = dir.join(format!("{}.md", trimmed));
    if target.exists() && !overwrite {
        return Err(format!("ya existe: {}", target.display()));
    }
    let mut markdown = markdown;
    if !markdown.ends_with('\n') {
        markdown.push('\n');
    }
    fs::write(&target, markdown).map_err(|e| {
        tracing::error!(target: "note", path = %target.display(), error = %e, "save_note_template: write falló");
        e.to_string()
    })?;
    tracing::info!(target: "note", path = %target.display(), "plantilla guardada");
    Ok(target.to_string_lossy().into_owned())
}
```

- [ ] **Step 4: Registrar los comandos y esconder la carpeta**

En `src-tauri/src/lib.rs:60`:

```rust
use notes::{
    create_folder, create_note, delete_note, list_note_templates, read_note, save_note_template,
    write_note,
};
```

En el `generate_handler!`, después de `create_folder,`:

```rust
            list_note_templates,
            save_note_template,
```

En `src-tauri/src/fs.rs`, sumar a `SKIP_DIRS` (después de `"themes",`):

```rust
    "Plantillas",
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, incluidos los 5 tests nuevos y los que ya existían de `fs`/`notes`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/notes.rs src-tauri/src/lib.rs src-tauri/src/fs.rs
git commit -m "feat(notas): comandos para listar y guardar plantillas en <root>/Plantillas"
```

---

## Task 4: `note-form-service.ts` — estado y IO

**Files:**
- Create: `src/app/core/note-form-service.ts`

**Interfaces:**
- Consumes: `Bloque`, `bloqueVacio`, `bloquesAMarkdown`, `markdownABloques` (Task 1); `NOTE_TEMPLATES`, `NoteTemplate`, `bloquesDePlantilla`, `combinarPlantillas` (Task 2); `list_note_templates`, `save_note_template` (Task 3); `NoteService.createNote`, `SettingsService.root`, `ToastService`, `ProjectService`.
- Produces:
  - `interface NoteFormState { parentDir: string; nombre: string; plantillaId: string; bloques: Bloque[] }`
  - `NoteFormService.editing: Signal<NoteFormState | null>`
  - `NoteFormService.plantillas: Signal<NoteTemplate[]>`
  - `NoteFormService.creando: Signal<boolean>`
  - `open(parentDir: string): Promise<string | null>` — resuelve con el path creado, o null si se canceló (mismo patrón de resolver que `ModalService.openModal`)
  - `close(): void`
  - `setNombre(v: string): void`
  - `aplicarPlantilla(id: string): void`
  - `patchBloque(i: number, patch: Partial<Bloque>): void`
  - `addBloque(tipo: BloqueTipo): void`
  - `removeBloque(i: number): void`
  - `moverBloque(i: number, delta: -1 | 1): void`
  - `markdownActual(): string`
  - `crear(): Promise<string | null>` — devuelve el path creado
  - `guardarPlantilla(nombre: string, overwrite: boolean): Promise<boolean>`

- [ ] **Step 1: Escribir el service**

Create `src/app/core/note-form-service.ts`:

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import {
  Bloque,
  BloqueTipo,
  bloqueVacio,
  bloquesAMarkdown,
} from '../shared/note-blocks';
import {
  NOTE_TEMPLATES,
  NoteTemplate,
  bloquesDePlantilla,
  combinarPlantillas,
} from '../shared/note-templates';
import { NoteService } from './note-service';
import { SettingsService } from './settings-service';
import { ToastService } from './toast-service';

export interface NoteFormState {
  parentDir: string;
  nombre: string;
  plantillaId: string;
  bloques: Bloque[];
}

interface NoteTemplateFile {
  nombre: string;
  path: string;
  markdown: string;
}

@Injectable({ providedIn: 'root' })
export class NoteFormService {
  private note = inject(NoteService);
  private settings = inject(SettingsService);
  private toast = inject(ToastService);

  /** Estado del modal. null = cerrado. */
  readonly editing = signal<NoteFormState | null>(null);
  readonly creando = signal(false);
  private archivos = signal<NoteTemplateFile[]>([]);

  readonly plantillas = computed<NoteTemplate[]>(() =>
    combinarPlantillas(NOTE_TEMPLATES, this.archivos()),
  );

  /** Resolver del `open()` en curso: le devuelve al caller el path creado (o
   *  null si se canceló), así el post-proceso de "que la nota quede a la vista"
   *  sigue viviendo donde ya funciona, en `node-actions-service.createNoteIn`. */
  private resolver: ((path: string | null) => void) | null = null;

  /** Abre el form para crear una nota en `parentDir` y resuelve cuando el autor
   *  crea o cancela. Recarga las plantillas del autor cada vez: pudo haber
   *  editado un `.md` de `Plantillas/` a mano o llegado uno por git desde la
   *  otra PC. */
  open(parentDir: string): Promise<string | null> {
    const inicial = NOTE_TEMPLATES[0];
    this.editing.set({
      parentDir,
      nombre: '',
      plantillaId: inicial.id,
      bloques: bloquesDePlantilla(inicial),
    });
    void this.recargarPlantillas();
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    this.editing.set(null);
    this.resolve(null);
  }

  private resolve(path: string | null): void {
    const r = this.resolver;
    this.resolver = null;
    r?.(path);
  }

  private async recargarPlantillas(): Promise<void> {
    const root = this.settings.root();
    if (!root) {
      this.archivos.set([]);
      return;
    }
    try {
      const list = await invoke<NoteTemplateFile[]>('list_note_templates', { root });
      this.archivos.set(list);
    } catch (err) {
      // No es fatal: las de fábrica alcanzan para crear la nota.
      this.archivos.set([]);
      this.toast.error(`No pude leer las plantillas de Plantillas/: ${String(err)}`);
    }
  }

  setNombre(v: string): void {
    const s = this.editing();
    if (!s) return;
    const anterior = s.nombre.trim();
    // El H1 sigue al nombre mientras el autor no lo haya escrito a mano.
    const bloques = s.bloques.map((b) =>
      b.tipo === 'h1' && (b.texto.trim() === '' || b.texto.trim() === anterior)
        ? { ...b, texto: v }
        : b,
    );
    this.editing.set({ ...s, nombre: v, bloques });
  }

  aplicarPlantilla(id: string): void {
    const s = this.editing();
    if (!s) return;
    const tpl = this.plantillas().find((t) => t.id === id);
    if (!tpl) return;
    const bloques = bloquesDePlantilla(tpl);
    const h1 = bloques.find((b) => b.tipo === 'h1');
    if (h1) h1.texto = s.nombre;
    this.editing.set({ ...s, plantillaId: id, bloques });
  }

  /** true si hay algo escrito que se perdería al cambiar de plantilla. */
  tieneContenido(): boolean {
    const s = this.editing();
    if (!s) return false;
    return s.bloques.some(
      (b) =>
        (b.tipo === 'parrafo' && b.texto.trim() !== '') ||
        (b.tipo === 'lista' && b.items.some((i) => i.trim() !== '')),
    );
  }

  patchBloque(i: number, patch: Partial<Bloque>): void {
    const s = this.editing();
    if (!s || i < 0 || i >= s.bloques.length) return;
    const bloques = s.bloques.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    this.editing.set({ ...s, bloques });
  }

  addBloque(tipo: BloqueTipo): void {
    const s = this.editing();
    if (!s) return;
    this.editing.set({ ...s, bloques: [...s.bloques, bloqueVacio(tipo)] });
  }

  removeBloque(i: number): void {
    const s = this.editing();
    if (!s) return;
    this.editing.set({ ...s, bloques: s.bloques.filter((_, idx) => idx !== i) });
  }

  moverBloque(i: number, delta: -1 | 1): void {
    const s = this.editing();
    if (!s) return;
    const j = i + delta;
    if (i < 0 || j < 0 || i >= s.bloques.length || j >= s.bloques.length) return;
    const bloques = [...s.bloques];
    // ponytail: reorden por índice; el drag (cdkDropList + moveItemInArray) es
    // pulido acordado sobre este mismo array, no cambia el modelo.
    [bloques[i], bloques[j]] = [bloques[j], bloques[i]];
    this.editing.set({ ...s, bloques });
  }

  markdownActual(): string {
    const s = this.editing();
    return s ? bloquesAMarkdown(s.bloques) : '';
  }

  /** Crea la nota. Devuelve el path o null si falló (el toast ya lo dijo). */
  async crear(): Promise<string | null> {
    const s = this.editing();
    if (!s) return null;
    const nombre = s.nombre.trim();
    if (!nombre) return null;
    this.creando.set(true);
    try {
      const body = this.markdownActual();
      const creado = await this.note.createNote(s.parentDir, nombre, body || null);
      if (creado) {
        this.editing.set(null);
        this.resolve(creado);
      }
      return creado;
    } finally {
      this.creando.set(false);
    }
  }

  /** Guarda la estructura actual (sin contenido) como plantilla del autor. */
  async guardarPlantilla(nombre: string, overwrite: boolean): Promise<boolean> {
    const s = this.editing();
    const root = this.settings.root();
    if (!s || !root) return false;
    const markdown = bloquesAMarkdown(s.bloques, { plantilla: true });
    if (!markdown) {
      this.toast.error('La plantilla quedaría vacía: agregá al menos un bloque.');
      return false;
    }
    try {
      await invoke<string>('save_note_template', {
        root,
        nombre,
        markdown,
        overwrite,
      });
      await this.recargarPlantillas();
      this.toast.info(`Plantilla "${nombre}" guardada en Plantillas/`);
      return true;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('ya existe')) return false; // el componente ofrece sobrescribir
      this.toast.error(`No pude guardar la plantilla: ${msg}`);
      return false;
    }
  }
}
```

- [ ] **Step 2: Verificar que compila y que la API de los services usados existe**

Run: `pnpm build`
Expected: build sin errores. Las APIs que usa este service ya están verificadas contra el repo: `ToastService.info/error`, `NoteService.createNote(parentDir, name, body|null): Promise<string|null>`, `SettingsService.root()`.

- [ ] **Step 3: Commit**

```bash
git add src/app/core/note-form-service.ts
git commit -m "feat(notas): service del form de creación (estado, plantillas, guardado)"
```

---

## Task 5: El modal — crear la nota end-to-end

**Files:**
- Create: `src/app/note-form/note-form-modal.ts`
- Create: `src/app/note-form/note-form-modal.html`
- Create: `src/app/note-form/note-form-modal.scss`
- Modify: `src/app/app.ts` (import + `imports` del componente)
- Modify: `src/app/app.html:338` (montaje, al lado de `<app-split-chapter-modal />`)
- Modify: `src/app/shared/node-actions-service.ts::createNoteIn`

**Interfaces:**
- Consumes: todo lo que produce `NoteFormService` (Task 4).
- Produces: `<app-note-form-modal />` montado en el shell; `createNoteIn(parentDir)` abre el form.

- [ ] **Step 1: Escribir el componente**

Create `src/app/note-form/note-form-modal.ts`:

```ts
import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BloqueTipo } from '../shared/note-blocks';
import { NoteFormService } from '../core/note-form-service';
import { SettingsService } from '../core/settings-service';
import { ModalService } from '../shared/modal-service';

@Component({
  selector: 'app-note-form-modal',
  imports: [FormsModule],
  templateUrl: './note-form-modal.html',
  styleUrl: './note-form-modal.scss',
})
export class NoteFormModal {
  private svc = inject(NoteFormService);
  private settings = inject(SettingsService);
  private modal = inject(ModalService);

  protected readonly editing = this.svc.editing;
  protected readonly creando = this.svc.creando;
  protected readonly plantillas = this.svc.plantillas;

  protected readonly destino = computed(() => {
    const s = this.editing();
    const root = this.settings.root();
    if (!s) return '';
    if (!root) return s.parentDir;
    return s.parentDir.startsWith(root) ? s.parentDir.slice(root.length + 1) : s.parentDir;
  });

  protected readonly puedeCrear = computed(() => {
    const s = this.editing();
    if (!s || this.creando()) return false;
    const n = s.nombre.trim();
    return n.length > 0 && !n.includes('/') && !n.includes('\\');
  });

  protected close(): void {
    this.svc.close();
  }

  protected onNombre(v: string): void {
    this.svc.setNombre(v);
  }

  protected async onPlantilla(id: string): Promise<void> {
    if (this.svc.tieneContenido()) {
      const ok = await this.modal.confirm({
        title: 'Cambiar de plantilla',
        message: 'Se descarta lo que escribiste en los bloques. ¿Seguimos?',
        okLabel: 'Cambiar',
        danger: true,
      });
      if (!ok) return;
    }
    this.svc.aplicarPlantilla(id);
  }

  protected onTitulo(i: number, texto: string): void {
    this.svc.patchBloque(i, { texto });
  }

  protected onParrafo(i: number, texto: string): void {
    this.svc.patchBloque(i, { texto });
  }

  protected onItem(i: number, idx: number, valor: string): void {
    const s = this.editing();
    if (!s) return;
    const items = [...s.bloques[i].items];
    items[idx] = valor;
    // Un item vacío al final siempre disponible, así no hay que apretar "+".
    if (idx === items.length - 1 && valor.trim() !== '') items.push('');
    this.svc.patchBloque(i, { items });
  }

  protected quitarItem(i: number, idx: number): void {
    const s = this.editing();
    if (!s) return;
    const items = s.bloques[i].items.filter((_, k) => k !== idx);
    this.svc.patchBloque(i, { items: items.length > 0 ? items : [''] });
  }

  protected add(tipo: BloqueTipo): void {
    this.svc.addBloque(tipo);
  }

  protected quitar(i: number): void {
    this.svc.removeBloque(i);
  }

  protected mover(i: number, delta: -1 | 1): void {
    this.svc.moverBloque(i, delta);
  }

  /** El componente solo crea. Que la nota quede a la vista (descolapsar el pane,
   *  elegir la tab) lo sigue haciendo `createNoteIn`, que es donde ya funciona:
   *  `svc.open()` le devuelve el path creado. */
  protected async crear(): Promise<void> {
    await this.svc.crear();
  }
}
```

- [ ] **Step 2: Escribir el template**

Create `src/app/note-form/note-form-modal.html`:

```html
@if (editing(); as s) {
  <div class="nf-backdrop" (click)="close()"></div>
  <div class="nf-modal" (click)="$event.stopPropagation()">
    <header class="nf-header">
      <h2>Nueva nota</h2>
      <p class="nf-path">Se crea en: {{ destino() }}</p>
    </header>

    <div class="nf-config">
      <label class="nf-field">
        <span>Plantilla</span>
        <select [ngModel]="s.plantillaId" (ngModelChange)="onPlantilla($event)">
          @for (t of plantillas(); track t.id) {
            <option [value]="t.id">{{ t.label }}@if (t.origen === 'archivo') { · propia }</option>
          }
        </select>
      </label>
      <label class="nf-field">
        <span>Nombre</span>
        <input
          type="text"
          [ngModel]="s.nombre"
          (ngModelChange)="onNombre($event)"
          placeholder="Sin extensión, .md se agrega solo"
        />
      </label>
    </div>

    <div class="nf-bloques">
      @for (b of s.bloques; track $index) {
        <div class="nf-bloque" [class.nf-parrafo]="b.tipo === 'parrafo'">
          <div class="nf-bloque-head">
            <span class="nf-tipo">{{ b.tipo === 'h1' ? 'Título' : b.tipo === 'h2' ? 'Subtítulo' : b.tipo === 'lista' ? 'Lista' : 'Párrafo' }}</span>
            @if (b.tipo === 'h1' || b.tipo === 'h2') {
              <input
                class="nf-titulo"
                type="text"
                [ngModel]="b.texto"
                (ngModelChange)="onTitulo($index, $event)"
                placeholder="Nombre de la sección"
              />
            }
            <button type="button" title="Subir" (click)="mover($index, -1)">↑</button>
            <button type="button" title="Bajar" (click)="mover($index, 1)">↓</button>
            <button type="button" class="nf-quitar" title="Quitar bloque" (click)="quitar($index)">✕</button>
          </div>

          @if (b.tipo === 'parrafo') {
            <textarea
              rows="3"
              [ngModel]="b.texto"
              (ngModelChange)="onParrafo($index, $event)"
              placeholder="Prosa de la sección"
            ></textarea>
          }

          @if (b.tipo === 'lista') {
            <ul class="nf-items">
              @for (item of b.items; track $index) {
                <li>
                  <input
                    type="text"
                    [ngModel]="item"
                    (ngModelChange)="onItem($parent.$index, $index, $event)"
                    placeholder="Item"
                  />
                  <button type="button" title="Quitar item" (click)="quitarItem($parent.$index, $index)">✕</button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>

    <footer class="nf-footer">
      <div class="nf-add">
        <button type="button" (click)="add('h1')">+ Título</button>
        <button type="button" (click)="add('h2')">+ Subtítulo</button>
        <button type="button" (click)="add('lista')">+ Lista</button>
        <button type="button" (click)="add('parrafo')">+ Párrafo</button>
      </div>
      <div class="nf-actions">
        <button type="button" (click)="close()">Cancelar</button>
        <button type="button" class="nf-primary" [disabled]="!puedeCrear()" (click)="crear()">
          {{ creando() ? 'Creando…' : 'Crear' }}
        </button>
      </div>
    </footer>
  </div>
}
```

- [ ] **Step 3: Escribir el scss**

Create `src/app/note-form/note-form-modal.scss` (mismas variables y forma que `split-chapter-modal.scss`):

```scss
.nf-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.nf-modal {
  position: fixed;
  inset: 6vh 12vw;
  z-index: 101;
  background: var(--panel-bg, #1f1f1f);
  color: var(--text, #e5e5e5);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}

.nf-header {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border, #333);
  background: var(--panel-bg-elev, #262626);

  h2 {
    margin: 0;
    font-size: 1.05rem;
  }

  .nf-path {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    opacity: 0.7;
  }
}

.nf-config {
  display: flex;
  gap: 1rem;
  padding: 0.9rem 1.25rem;
  border-bottom: 1px solid var(--border, #333);

  .nf-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;

    &:last-child {
      flex: 1;
    }

    input,
    select {
      background: var(--input-bg, #161616);
      color: inherit;
      border: 1px solid var(--border, #333);
      border-radius: 4px;
      padding: 0.35rem 0.5rem;
      font: inherit;
    }
  }
}

.nf-bloques {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.nf-bloque {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  background: var(--panel-bg-elev, #232323);

  .nf-bloque-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;

    .nf-tipo {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.6;
      min-width: 4.5rem;
    }

    .nf-titulo {
      flex: 1;
    }

    button {
      background: transparent;
      border: 1px solid var(--border, #333);
      border-radius: 4px;
      color: inherit;
      cursor: pointer;
      padding: 0.1rem 0.4rem;

      &:hover {
        background: var(--hover-bg, #2e2e2e);
      }
    }

    .nf-quitar:hover {
      border-color: var(--danger, #b04a4a);
      color: var(--danger, #d97070);
    }
  }

  input,
  textarea {
    background: var(--input-bg, #161616);
    color: inherit;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    padding: 0.3rem 0.45rem;
    font: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  textarea {
    margin-top: 0.4rem;
    resize: vertical;
  }
}

.nf-items {
  list-style: none;
  margin: 0.4rem 0 0;
  padding: 0 0 0 0.2rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;

  li {
    display: flex;
    gap: 0.3rem;
    align-items: center;

    &::before {
      content: '•';
      opacity: 0.5;
    }

    button {
      background: transparent;
      border: none;
      color: inherit;
      opacity: 0.5;
      cursor: pointer;

      &:hover {
        opacity: 1;
      }
    }
  }
}

.nf-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--border, #333);
  background: var(--panel-bg-elev, #262626);

  .nf-add,
  .nf-actions {
    display: flex;
    gap: 0.4rem;
  }

  button {
    background: transparent;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    padding: 0.35rem 0.7rem;
    font: inherit;

    &:hover:not(:disabled) {
      background: var(--hover-bg, #2e2e2e);
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
    }
  }

  .nf-primary {
    background: var(--accent, #3b6ea5);
    border-color: var(--accent, #3b6ea5);
  }
}
```

- [ ] **Step 4: Montar el modal en el shell y abrirlo desde `createNoteIn`**

En `src/app/app.ts`: sumar `import { NoteFormModal } from './note-form/note-form-modal';` y `NoteFormModal` al array `imports` del `@Component` (donde ya está `SplitChapterModal`).

En `src/app/app.html`, junto a la línea 338:

```html
<app-note-form-modal />
```

En `src/app/shared/node-actions-service.ts`, reemplazar el cuerpo entero de `createNoteIn` (líneas 737-771) por:

```ts
  async createNoteIn(parentDir: string): Promise<void> {
    // Sin esto, con el pane de notas colapsado la nota nueva se crea invisible.
    this.settings.setNotesPaneCollapsed(false);
    const creado = await this.noteForm.open(parentDir);
    if (!creado) return;
    // Y sin esto la nota puede nacer en una rama que la tab activa no muestra.
    const nl = notasDelLibro(this.project.tree(), this.contextoLibro());
    const enLaLista =
      !!nl && [...nl.libro, ...nl.saga].some((x) => x.path === creado);
    this.settings.setNotasTab(enLaLista ? 'libro' : 'todas');
  }
```

O sea: **el post-proceso no se mueve a ningún lado**, queda tal cual estaba (líneas
760-770). Lo único que cambia es de dónde sale `creado`: antes de
`this.note.createNote(...)`, ahora del `open()` del form. Sumar
`private noteForm = inject(NoteFormService);` con su import. Los imports de
`NOTE_TEMPLATES`/`bloquesDePlantilla`/`bloquesAMarkdown` que agregó Task 2 quedan sin
uso: borrarlos.

- [ ] **Step 5: Verificar build**

Run: `pnpm build && node scripts/run-note-blocks-smoke.mjs && node scripts/run-note-templates-smoke.mjs`
Expected: build limpio y los dos smokes en `0 fail`.

- [ ] **Step 6: Commit**

```bash
git add src/app/note-form src/app/app.ts src/app/app.html src/app/shared/node-actions-service.ts
git commit -m "feat(notas): form de bloques para crear notas, reemplaza el selectPrompt"
```

---

## Task 6: Guardar la estructura como plantilla propia

**Files:**
- Modify: `src/app/note-form/note-form-modal.ts`
- Modify: `src/app/note-form/note-form-modal.html`

**Interfaces:**
- Consumes: `NoteFormService.guardarPlantilla(nombre, overwrite)` (Task 4), `ModalService.prompt`, `ModalService.confirm`.
- Produces: botón "Guardar plantilla…" en el footer del modal.

- [ ] **Step 1: Sumar el método al componente**

En `src/app/note-form/note-form-modal.ts`:

```ts
  protected async guardarPlantilla(): Promise<void> {
    const nombre = await this.modal.prompt({
      title: 'Guardar plantilla',
      message: 'Se guarda en Plantillas/ del repo de novelas, sin el contenido que escribiste.',
      placeholder: 'Ej: Nave',
      okLabel: 'Guardar',
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
    if (!nombre?.trim()) return;
    const limpio = nombre.trim();
    if (await this.svc.guardarPlantilla(limpio, false)) return;
    const pisar = await this.modal.confirm({
      title: 'Ya existe',
      message: `Plantillas/${limpio}.md ya existe. ¿La sobrescribo?`,
      okLabel: 'Sobrescribir',
      danger: true,
    });
    if (pisar) await this.svc.guardarPlantilla(limpio, true);
  }
```

`ModalService.prompt(opts): Promise<string | null>` y `confirm(opts): Promise<boolean>` — firmas ya verificadas contra `src/app/shared/modal-service.ts:81-87`.

- [ ] **Step 2: Sumar el botón al footer**

En `src/app/note-form/note-form-modal.html`, dentro de `.nf-actions`, antes del botón "Cancelar":

```html
        <button type="button" (click)="guardarPlantilla()">Guardar plantilla…</button>
```

- [ ] **Step 3: Verificar build**

Run: `pnpm build`
Expected: build sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/app/note-form
git commit -m "feat(notas): guardar la estructura del form como plantilla propia"
```

---

## Task 7: TODO y verificación manual

**Files:**
- Modify: `TODO.md` (el item "El creador de notas es inútil como está")

- [ ] **Step 1: Correr todo el verde disponible**

Run:
```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/run-note-blocks-smoke.mjs
node scripts/run-note-templates-smoke.mjs
```
Expected: los cuatro en verde. Pegar los resultados reales en el mensaje de handoff — nada de "debería pasar".

- [ ] **Step 2: Actualizar el item del TODO**

En el item **"El creador de notas es inútil como está — hacerlo un form de verdad"** de la sección `## Tree / Importer`, agregar al final (sin marcar `[x]`):

```markdown
  **Estado**: implementado en `feat/form-de-notas-con-plantillas` — spec en
  `docs/superpowers/specs/2026-08-31-form-de-notas-con-plantillas-design.md`,
  plan en `docs/superpowers/plans/2026-08-31-form-de-notas-con-plantillas.md`.
  Bloques editables (título/subtítulo/lista/párrafo) con ↑/↓, 6 plantillas de
  fábrica sacadas del corpus real, plantillas propias en `<root>/Plantillas/*.md`
  (la del autor le gana a la de fábrica con el mismo nombre). El drag de bloques
  queda como pulido posterior. **Falta la verificación manual del autor.**
```

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): estado del form de notas, pendiente de verificación manual"
```

- [ ] **Step 4: Pasarle al autor la checklist de verificación manual**

No marcar el item como hecho. Pedirle que pruebe, con `pnpm tauri dev`:

1. Menú contextual sobre una carpeta `notas/` → "Nueva nota…" → el form abre y dice el destino relativo al root.
2. Plantilla `Conjuro` → tres secciones, `Descripción` y `Conjuro` con textarea, `Atajos` con lista; escribir un item y ver que aparece el siguiente vacío solo.
3. Crear la nota → nace con el contenido escrito, el pane de notas se descolapsa y la nota queda a la vista.
4. Plantilla `Personaje` → borrar `Detalles` con la ✕, mover `Objetos` arriba con ↑, crear, y verificar el `.md` en disco.
5. Escribir contenido y cambiar de plantilla → pide confirmación antes de descartar.
6. "Guardar plantilla…" con nombre nuevo → aparece `<root>/Plantillas/<nombre>.md` con la estructura y **sin** el contenido; reabrir el form y ver la plantilla en el selector marcada como propia.
7. Guardar con un nombre ya existente → ofrece sobrescribir.
8. Editar a mano un `.md` de `Plantillas/` (cambiar un título) → reabrir el form y ver el cambio.
9. Crear `Plantillas/Conjuro.md` a mano → en el selector queda una sola entrada `Conjuro`, la del archivo.
10. El árbol **no** muestra la carpeta `Plantillas`.
11. Nombre con `/` → el botón Crear queda deshabilitado.

---

## Self-Review

**Cobertura del spec:**

| Sección del spec | Task |
|---|---|
| Modelo de datos (`Bloque`, parser, renderer, párrafo implícito) | 1 |
| Plantillas de fábrica (6, del corpus) + colisión con archivos | 2 |
| Persistencia `<root>/Plantillas/`, `SKIP_DIRS`, comandos Rust | 3 |
| Frontend: service, estado, H1 que sigue al nombre | 4 |
| Frontend: form, reorden ↑/↓, entry points sin cambios | 5 |
| "Guardar plantilla…" con prompt + confirm de sobrescritura | 6 |
| Errores (carpeta ausente, plantilla que no parsea, nombre existente, sin root) | 3 (Rust), 4 (toasts), 5 (`puedeCrear`), 6 (overwrite) |
| Testing puro + Rust + manual | 1, 2, 3, 7 |
| Fuera de alcance (fase 2, drag, frontmatter) | no se toca en ninguna tarea |

**Consistencia de tipos:** `Bloque`/`BloqueTipo`/`bloqueVacio`/`markdownABloques`/`bloquesAMarkdown` (Task 1) se usan con esos nombres exactos en Tasks 2, 4 y 5. `NoteTemplate.origen` (`'fabrica' | 'archivo'`) se lee en el `<option>` de Task 5. `NoteTemplateFile { nombre, path, markdown }` es el mismo shape en Rust (Task 3) y en el `invoke` del service (Task 4). `guardarPlantilla(nombre, overwrite)` tiene la misma firma en Tasks 4 y 6.

**APIs del repo verificadas mientras se escribía el plan** (no quedan huecos que el implementador tenga que adivinar): `ToastService.info/error/success` (`toast-service.ts:25-38`), `ModalService.prompt → Promise<string|null>` y `confirm → Promise<boolean>` (`modal-service.ts:81-87`), `NoteService.createNote(parentDir, name, body = null) → Promise<string|null>` (`note-service.ts:152`), `NoteService.open({ path, name })` (`note-service.ts:61`). **No existen** `NoteService.openNote(path)` ni `NavigationService.revealPath` — un borrador de este plan las usaba; el post-proceso de "que la nota quede a la vista" se queda en `node-actions-service.createNoteIn`, que ya lo tiene resuelto con `notasDelLibro` + `setNotasTab`.
