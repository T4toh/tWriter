# Control total del tipeo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que tWriter controle el tipeo de punta a punta: apagar el corrector y las sustituciones del OS, sugerir palabras del diccionario de la saga en el popover de gramática, y ubicar el popup donde haya lugar en vez de siempre hacia abajo.

**Architecture:** Cuatro piezas independientes. (1) Atributos heredados en `index.html` + `editorProps` explícitos en los dos editores TipTap. (2) Módulo Rust macOS-only que apaga las sustituciones nativas vía `NSUserDefaults.registerDefaults` y setters sobre la `WKWebView`, cada selector gateado por `respondsToSelector:`. (3) Función pura `suggestFromDictionary` que ranquea el diccionario per-saga por distancia de edición, consumida por el popover de gramática. (4) Función pura `placePopover` con flip arriba/abajo + clamp + `maxHeight`, y los dos popovers midiéndose a sí mismos en vez de recibir `x`/`y` calculados con constantes mágicas.

**Tech Stack:** Angular 21 (signals, standalone, `afterRenderEffect`), TipTap 3 / ProseMirror, Tauri 2, Rust con `objc2` + `objc2-foundation`, tests puros con `node --experimental-strip-types`.

**Spec:** `docs/superpowers/specs/2026-07-29-control-total-tipeo-design.md`

## Global Constraints

- **Convenciones del repo** (`CLAUDE.md`): standalone components sin NgModules; signals (`signal()`, `computed()`, `input()`, `output()`); templates modernos `@if`/`@for` (nunca `*ngIf`/`*ngFor`); nombres de archivo sin sufijo (`tree.ts`, no `tree.component.ts`); clases sin sufijo `Component`; sin `public` explícito; return types explícitos en métodos; `inject()` para DI; español para UI, comentarios y nombres de dominio.
- **No hay runner de Karma.** `angular.json` no define target `test`. El patrón vigente para tests es un `.spec.ts` con los casos (con shims `declare const describe/it/expect` o `node:assert`) más un `.smoke.ts` standalone que corre con `node --experimental-strip-types <archivo>`. Referencia: `src/app/quotes/educate.spec.ts` + `src/app/quotes/educate.smoke.ts`. **No agregar Karma ni deps npm en este plan.**
- **Cero deps npm nuevas.** Todo lo del frontend sale con lo ya instalado.
- **Deps Rust nuevas: solo `objc2 = "0.6"` y `objc2-foundation = "0.3"`**, macOS-only, y ya están en `src-tauri/Cargo.lock` como transitivas de Tauri (0.6.4 y 0.3.2 respectivamente) — sin versiones nuevas ni riesgo de supply-chain, y publicadas hace mucho más de 7 días. Verificar con `grep -n 'name = "objc2' src-tauri/Cargo.lock` antes de agregarlas y usar esas mismas versiones para no duplicar el árbol.
- **Typography de TipTap queda como única fuente de comillas curvas y rayas.** Ninguna tarea la desactiva ni la duplica.
- **Sin toggle de "usar corrector del sistema".** Se apaga y punto — decisión de producto tomada en el spec.
- **Fuera de alcance:** autocompletado inline de términos mientras se escribe; el artefacto de glifo; el scroll a la línea nueva. Los tres están anotados en `TODO.md`.
- **Build de verificación:** `pnpm build` (Angular producción) tiene que pasar en toda tarea que toque TS/HTML. `cargo check --manifest-path src-tauri/Cargo.toml` en toda tarea que toque Rust.

## File Structure

**Nuevos:**
- `src/app/dictionary/suggest.ts` — `suggestFromDictionary()`, pura, sin imports de Angular.
- `src/app/dictionary/suggest.spec.ts` — casos.
- `src/app/dictionary/suggest.smoke.ts` — runner standalone de esos casos.
- `src/app/editor/popover-position.ts` — `placePopover()`, pura, sin imports de Angular ni DOM.
- `src/app/editor/popover-position.spec.ts` — casos.
- `src/app/editor/popover-position.smoke.ts` — runner standalone.
- `src-tauri/src/macos_text.rs` — apagado de sustituciones nativas, todo `#[cfg(target_os = "macos")]`.

**Modificados:**
- `src/index.html` — atributos heredados en `<html>`.
- `src/app/editor/editor.ts` — `editorProps`; anchor rect en vez de `x`/`y`; candidatos del diccionario; cierre en scroll.
- `src/app/notes-editor/notes-editor.ts` — `editorProps`.
- `src/app/editor/editor.html` — bindings de los dos popovers.
- `src/app/editor/grammar-popover.ts` + `.scss` — placement propio, chip "tu diccionario", `max-height`.
- `src/app/editor/rae-popover.ts` + `.scss` — placement propio, `max-height`.
- `src-tauri/src/lib.rs` — `mod macos_text;` + llamada en `setup`.
- `src-tauri/Cargo.toml` — deps macOS-only.

---

### Task 1: Apagar el corrector del OS en la capa web

**Files:**
- Modify: `src/index.html:2`
- Modify: `src/app/editor/editor.ts:1210-1214` (dentro del objeto pasado a `new TipTapEditor({...})`)
- Modify: `src/app/notes-editor/notes-editor.ts:354-355` (ídem)

**Interfaces:**
- Consumes: nada.
- Produces: nada que otras tareas consuman. Cambio autocontenido.

- [ ] **Step 1: Atributos heredados en `index.html`**

`src/index.html` línea 2 hoy es `<html lang="en">`. Dejarla así:

```html
<html lang="en" spellcheck="false" autocorrect="off" autocapitalize="off">
```

Los tres atributos se heredan a todo el árbol, así que cubren los ~30 templates con inputs y contenteditables de una sola vez. **No** tocar `lang`: al apagar el corrector el idioma declarado deja de influir en esto y cambiarlo afectaría hyphenation, fuera de alcance.

- [ ] **Step 2: `editorProps` en el editor de capítulos**

En `src/app/editor/editor.ts`, dentro de `createEditor()`, el objeto de config de `new TipTapEditor({...})` hoy tiene `element`, `extensions`, `content`, `editable`, `autofocus: false`, y los callbacks. Agregar `editorProps` justo después de `editable,` (antes del comentario de `autofocus`):

```ts
      // El OS no opina sobre el texto: sin corrector, sin autocorrección y sin
      // autocapitalización. Las comillas y rayas las hace Typography de TipTap.
      // Explícito acá además de heredado desde <html> porque ProseMirror
      // reescribe los atributos del contenteditable al montar la vista.
      editorProps: {
        attributes: {
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          autocomplete: 'off',
          'data-gramm': 'false',
          'data-gramm_editor': 'false',
        },
      },
```

- [ ] **Step 3: `editorProps` en el editor de notas**

En `src/app/notes-editor/notes-editor.ts`, mismo objeto de config, agregar el bloque idéntico después de `editable,`. Repetido a propósito: son dos instancias de TipTap con configs distintas (el de notas tiene la extensión Markdown), no hay factory compartida que abstraiga esto y crear una para seis atributos no vale.

- [ ] **Step 4: Verificar que compila**

```bash
pnpm build
```

Esperado: build exitoso. Si TypeScript se queja del tipo de `attributes`, los valores tienen que ser todos `string` (por eso `'false'` y no `false`).

- [ ] **Step 5: Verificación manual (requiere la Mac)**

`pnpm tauri dev` y en el editor de capítulos:
1. Tipear `vos tenés razón, andá y fijate si querés` → ninguna palabra se reescribe.
2. Tipear `"hola"` → salen comillas curvas (`“hola”`, de Typography), no rectas ni las del sistema.
3. Cero subrayado rojo bajo palabras inventadas de la saga.
4. Abrir el panel de búsqueda y el modal de configuración de gramática, tipear ahí → cero corrector, cero autocapitalización.

Anotar el resultado real de cada punto. Si en macOS **sigue** habiendo autocorrección, es lo esperado en este punto: lo arregla la Task 2. Lo que **sí** tiene que estar resuelto acá es el subrayado rojo y el comportamiento en Linux/Windows.

- [ ] **Step 6: Commit**

```bash
git add src/index.html src/app/editor/editor.ts src/app/notes-editor/notes-editor.ts
git commit -m "feat(editor): apagar corrector y autocorrección del OS en la capa web

spellcheck/autocorrect/autocapitalize off heredados desde <html> (cubre todos
los inputs de la app) + explícitos en los editorProps de ambos editores TipTap,
porque ProseMirror reescribe los atributos del contenteditable al montar.
Typography sigue siendo la única fuente de comillas curvas y rayas."
```

---

### Task 2: Apagar las sustituciones nativas de macOS

**Files:**
- Create: `src-tauri/src/macos_text.rs`
- Modify: `src-tauri/Cargo.toml` (agregar sección `[target.'cfg(target_os = "macos")'.dependencies]` al final de `[dependencies]`, antes de `[dev-dependencies]`)
- Modify: `src-tauri/src/lib.rs:1-29` (lista de `mod`) y `src-tauri/src/lib.rs:77-104` (bloque `.setup(...)`)

**Interfaces:**
- Consumes: nada.
- Produces: `macos_text::disable_native_text_substitutions(app: &tauri::AppHandle)` — no-op en plataformas que no son macOS. Ninguna tarea posterior la usa.

- [ ] **Step 1: Confirmar las versiones ya presentes en el lock**

```bash
grep -n 'name = "objc2"' -A 1 src-tauri/Cargo.lock
grep -n 'name = "objc2-foundation"' -A 1 src-tauri/Cargo.lock
```

Esperado: `objc2` 0.6.x y `objc2-foundation` 0.3.x (al escribir el plan: 0.6.4 y 0.3.2). Usar esas mismas líneas de versión en el paso siguiente para no duplicar el árbol de deps.

- [ ] **Step 2: Deps macOS-only en `Cargo.toml`**

Agregar al final de la sección `[dependencies]` (justo antes de `[dev-dependencies]`):

```toml
# Apagar las sustituciones de texto nativas de macOS (autocorrección, comillas
# inteligentes, guiones, reemplazo de texto) que muerden dentro de la WKWebView
# y arruinan el voseo. Ambas ya venían como transitivas de Tauri.
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
```

- [ ] **Step 3: Escribir el módulo**

Crear `src-tauri/src/macos_text.rs`:

```rust
//! Apagado de las sustituciones de texto nativas de macOS.
//!
//! Los atributos HTML (`spellcheck`/`autocorrect`/`autocapitalize`) no alcanzan:
//! WKWebView aplica autocorrección y sustituciones del sistema POR ENCIMA del
//! contenteditable, lo que reescribe voseo (`tenés` → `tenes`) y pisa las
//! comillas de Typography. Se atacan dos capas independientes por si una no
//! muerde en alguna versión de WebKit:
//!
//! 1. `registerDefaults` sobre el domain de la app (registro en memoria: NO
//!    escribe el plist del usuario ni afecta otras apps).
//! 2. Setters de `NSTextCheckingClient` sobre la instancia de WKWebView, cada
//!    uno gateado por `respondsToSelector:` para no panickear si WebKit los
//!    renombra o los saca.

#[cfg(not(target_os = "macos"))]
pub fn disable_native_text_substitutions(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
pub fn disable_native_text_substitutions(app: &tauri::AppHandle) {
    register_defaults();
    apply_to_webviews(app);
}

/// Claves de `NSUserDefaults` que gobiernan las sustituciones automáticas.
/// Las `NS*` son las de AppKit; las `Web*` las lee WebKit para el corrector
/// dentro de la webview.
#[cfg(target_os = "macos")]
const DEFAULT_KEYS: &[&str] = &[
    "NSAutomaticQuoteSubstitutionEnabled",
    "NSAutomaticDashSubstitutionEnabled",
    "NSAutomaticTextReplacementEnabled",
    "NSAutomaticSpellingCorrectionEnabled",
    "NSAutomaticPeriodSubstitutionEnabled",
    "NSAutomaticCapitalizationEnabled",
    "WebContinuousSpellCheckingEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
];

#[cfg(target_os = "macos")]
fn register_defaults() {
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let keys: Vec<objc2::rc::Retained<NSString>> =
        DEFAULT_KEYS.iter().map(|k| NSString::from_str(k)).collect();
    let values: Vec<objc2::rc::Retained<NSNumber>> =
        DEFAULT_KEYS.iter().map(|_| NSNumber::new_bool(false)).collect();

    let key_refs: Vec<&NSString> = keys.iter().map(|k| k.as_ref()).collect();
    let value_refs: Vec<&NSNumber> = values.iter().map(|v| v.as_ref()).collect();

    unsafe {
        let dict = NSDictionary::from_slices(&key_refs, &value_refs);
        let defaults = NSUserDefaults::standardUserDefaults();
        defaults.registerDefaults(dict.as_ref());
    }
    tracing::info!(target: "boot", keys = DEFAULT_KEYS.len(), "sustituciones nativas macOS: defaults registrados");
}

/// Setters de sustitución/corrección sobre la instancia de WKWebView.
#[cfg(target_os = "macos")]
const SELECTORS: &[&str] = &[
    "setAutomaticQuoteSubstitutionEnabled:",
    "setAutomaticDashSubstitutionEnabled:",
    "setAutomaticTextReplacementEnabled:",
    "setAutomaticSpellingCorrectionEnabled:",
    "setContinuousSpellCheckingEnabled:",
    "setSmartInsertDeleteEnabled:",
];

#[cfg(target_os = "macos")]
fn apply_to_webviews(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(target: "boot", "no encontré la ventana 'main' para apagar sustituciones");
        return;
    };
    let r = window.with_webview(|webview| {
        use objc2::runtime::{AnyObject, Sel};
        use objc2::{msg_send, sel};

        let wv = webview.inner() as *mut AnyObject;
        if wv.is_null() {
            return;
        }
        for name in SELECTORS {
            // `sel!` necesita literales, así que registramos el selector por nombre.
            let Some(sel) = Sel::register_unchecked_from_str(name) else {
                continue;
            };
            unsafe {
                let responds: bool = msg_send![wv, respondsToSelector: sel];
                if !responds {
                    tracing::debug!(target: "boot", selector = *name, "WKWebView no responde, salteado");
                    continue;
                }
                let _: () = msg_send![wv, performSelector: sel, withObject: std::ptr::null::<AnyObject>()];
            }
        }
        let _ = sel!(description); // ancla de compilación para el import de `sel!`
    });
    if let Err(e) = r {
        tracing::warn!(target: "boot", error = %e, "with_webview falló");
    }
}
```

**Ojo con `performSelector:withObject:` y booleanos.** Pasar `nil` como objeto equivale a `NO` en la mayoría de estos setters, pero es frágil. Si al compilar/correr resulta que `objc2` 0.6 permite el `msg_send!` directo con literal (`msg_send![wv, setAutomaticQuoteSubstitutionEnabled: false]`), preferir eso: un `msg_send!` por selector, cada uno precedido por su `respondsToSelector:` con `sel!(setAutomaticQuoteSubstitutionEnabled:)`. Es más verboso pero pasa el `BOOL` bien tipado. La API exacta de `Sel::register_unchecked_from_str` puede diferir en 0.6 — chequear con `cargo doc -p objc2 --open` o el source en `~/.cargo/registry` y ajustar; el diseño (gate por `respondsToSelector:` + un log por selector salteado) es lo que no se negocia.

- [ ] **Step 4: Cablear en `lib.rs`**

En `src-tauri/src/lib.rs`, agregar el módulo en orden alfabético dentro de la lista de `mod` (después de `mod import_wizard;`, antes de `mod notes;`):

```rust
mod macos_text;
```

Y dentro de `.setup(|app| { ... })`, como **primera** línea del closure (antes de `let handle = app.handle().clone();`), para que corra antes de que el frontend empiece a recibir tipeo:

```rust
            macos_text::disable_native_text_substitutions(app.handle());
```

- [ ] **Step 5: Verificar que compila**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Esperado: sin errores. En Linux/Windows el módulo es un no-op y las deps ni se bajan. Si `with_webview` no existe, chequear qué features de `tauri` hacen falta antes de inventar otro camino — está disponible con el default (`wry`) en Tauri 2.

- [ ] **Step 6: Verificación manual (requiere la Mac) y documentar el resultado real**

`pnpm tauri dev` y en el editor:
1. Tipear `vos tenés`, `andá`, `querés`, `fijate` → cero reescritura, cero sugerencia flotante del sistema.
2. Tipear `--` y `...` → los transforma Typography (`—`, `…`), no la sustitución de macOS. Verificable: pegar el resultado en un editor plano y confirmar que son los caracteres esperados.
3. Escribir un abreviado que tengas configurado en Ajustes → Teclado → Reemplazo de texto de macOS → **no** se expande.

Si algún punto falla, mirar los logs de `boot` para ver qué selectores se saltearon y anotarlo en el commit. La capa 1 (defaults) sola ya cubre la autocorrección: si la capa 2 no muerde, el resultado sigue siendo aceptable, pero **hay que decir cuál de las dos funcionó**, no asumirlo.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/macos_text.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(macos): apagar las sustituciones de texto nativas de la WKWebView

Los atributos HTML no alcanzan en macOS: WKWebView aplica autocorrección y
sustituciones del sistema por encima del contenteditable y arruina el voseo.
macos_text.rs ataca dos capas: registerDefaults sobre el domain de la app (no
escribe el plist del usuario) y los setters de NSTextCheckingClient sobre la
instancia de webview, cada uno gateado por respondsToSelector: para no
panickear si WebKit los renombra. objc2/objc2-foundation ya venían como
transitivas de Tauri; se fijan las mismas versiones del lock."
```

---

### Task 3: `suggestFromDictionary` — función pura

**Files:**
- Create: `src/app/dictionary/suggest.ts`
- Create: `src/app/dictionary/suggest.spec.ts`
- Create: `src/app/dictionary/suggest.smoke.ts`

**Interfaces:**
- Consumes: `foldAccents(s: string): string` de `src/app/core/search-highlight.ts` (ya existe, línea 27, length-preserving).
- Produces: `suggestFromDictionary(word: string, words: string[], max?: number): string[]` — devuelve las palabras del diccionario más cercanas a `word`, tal cual están escritas en el diccionario, ordenadas por distancia ascendente y después alfabéticamente. `max` default 3. Lo consume la Task 4.

- [ ] **Step 1: Escribir el spec con los casos (falla porque no existe el módulo)**

Crear `src/app/dictionary/suggest.spec.ts`:

```ts
/**
 * Tests de `suggest.ts` — candidatos del diccionario de la saga para un typo.
 *
 * Igual que `quotes/educate.spec.ts`: no hay Karma en el repo, así que los
 * casos viven acá y `suggest.smoke.ts` los corre con
 * `node --experimental-strip-types`.
 */
import { suggestFromDictionary } from './suggest';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toEqual: (expected: unknown) => void;
};

const DICT = ['Kallai', 'Kállia', 'Bastien', 'Meridian', 'duende', 'Adi'];

describe('suggestFromDictionary', () => {
  it('encuentra la palabra por una edición', () => {
    expect(suggestFromDictionary('Kallay', DICT)).toEqual(['Kallai']);
  });

  it('ignora acentos al comparar pero devuelve la palabra del diccionario', () => {
    expect(suggestFromDictionary('kallia', DICT)).toEqual(['Kállia']);
  });

  it('ignora mayúsculas', () => {
    expect(suggestFromDictionary('bastien', DICT)).toEqual(['Bastien']);
  });

  it('ordena por distancia y después alfabéticamente', () => {
    // 'Kallia' está a 1 de 'Kállia' (solo acento, que se pliega → distancia 0
    // tras el fold) y a 1 de 'Kallai' (transposición i/a). Empate → alfabético.
    expect(suggestFromDictionary('Kalliaa', DICT, 2)).toEqual(['Kállia', 'Kallai']);
  });

  it('no tolera 2 ediciones en palabras cortas', () => {
    // 'Adi' tiene 3 chars: umbral 1. 'Xdo' está a 2 → sin candidatos.
    expect(suggestFromDictionary('Xdo', DICT)).toEqual([]);
  });

  it('tolera 2 ediciones en palabras largas', () => {
    expect(suggestFromDictionary('Meridiam', DICT)).toEqual(['Meridian']);
    expect(suggestFromDictionary('Meridiaan', DICT)).toEqual(['Meridian']);
  });

  it('no devuelve nada cuando nada está cerca', () => {
    expect(suggestFromDictionary('zzzzqqqq', DICT)).toEqual([]);
  });

  it('excluye la palabra idéntica (ya está bien escrita)', () => {
    expect(suggestFromDictionary('Bastien', DICT)).toEqual([]);
  });

  it('respeta el máximo', () => {
    expect(suggestFromDictionary('Kalla', DICT, 1)).toEqual(['Kallai']);
  });

  it('tolera diccionario vacío y palabra vacía', () => {
    expect(suggestFromDictionary('Kallai', [])).toEqual([]);
    expect(suggestFromDictionary('', DICT)).toEqual([]);
  });
});
```

- [ ] **Step 2: Escribir el runner standalone**

Crear `src/app/dictionary/suggest.smoke.ts`:

```ts
/**
 * Runner standalone de los casos de `suggest.spec.ts`.
 * Correr con: `node --experimental-strip-types src/app/dictionary/suggest.smoke.ts`
 * (no requiere Karma ni deps npm; asserts con `node:assert`).
 */
import assert from 'node:assert';
import { suggestFromDictionary } from './suggest.ts';

const DICT = ['Kallai', 'Kállia', 'Bastien', 'Meridian', 'duende', 'Adi'];

const cases: Array<[string, string[], number | undefined, string[]]> = [
  ['Kallay', DICT, undefined, ['Kallai']],
  ['kallia', DICT, undefined, ['Kállia']],
  ['bastien', DICT, undefined, ['Bastien']],
  ['Kalliaa', DICT, 2, ['Kállia', 'Kallai']],
  ['Xdo', DICT, undefined, []],
  ['Meridiam', DICT, undefined, ['Meridian']],
  ['Meridiaan', DICT, undefined, ['Meridian']],
  ['zzzzqqqq', DICT, undefined, []],
  ['Bastien', DICT, undefined, []],
  ['Kalla', DICT, 1, ['Kallai']],
  ['Kallai', [], undefined, []],
  ['', DICT, undefined, []],
];

let passed = 0;
for (const [word, dict, max, expected] of cases) {
  const got = max === undefined ? suggestFromDictionary(word, dict) : suggestFromDictionary(word, dict, max);
  assert.deepStrictEqual(got, expected, `\n  word: ${word}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
  passed++;
}
console.log(`suggestFromDictionary: ${passed}/${cases.length} ok`);
```

- [ ] **Step 3: Correr el runner y verificar que falla**

```bash
node --experimental-strip-types src/app/dictionary/suggest.smoke.ts
```

Esperado: FALLA con error de módulo no encontrado (`Cannot find module './suggest.ts'`).

- [ ] **Step 4: Implementar el módulo**

Crear `src/app/dictionary/suggest.ts`:

```ts
/**
 * Candidatos del diccionario de la saga para una palabra marcada como typo.
 *
 * El diccionario per-saga (`<saga>/diccionario.txt`) hoy solo SILENCIA falsos
 * positivos de LanguageTool. Acá se usa como fuente de sugerencias: si escribís
 * `Kallay`, LT ofrece palabras del español y nunca `Kallai`, que es la que hace
 * falta. Función pura, sin Angular ni DOM: la lista tiene decenas o cientos de
 * palabras, así que la distancia se calcula en TS sin Rust ni red.
 */
import { foldAccents } from '../core/search-highlight';

/** Máximo de ediciones tolerado según el largo de la palabra tipeada. Mismo
 *  criterio que la búsqueda fuzzy: cortas exigen precisión, largas toleran más. */
function maxDistanceFor(length: number): number {
  if (length <= 3) return 1;
  if (length <= 6) return 1;
  return 2;
}

/** Levenshtein clásico con dos filas (O(n) memoria). Corta temprano si la
 *  diferencia de largos ya excede el umbral. */
function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (a === b) return 0;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > limit) return limit + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/**
 * Devuelve hasta `max` palabras del diccionario cercanas a `word`, tal cual
 * están escritas en el diccionario. Comparación case-insensitive y con acentos
 * plegados; orden por distancia ascendente y después alfabético (estable).
 * Excluye coincidencias exactas: si la palabra ya está bien escrita no hay nada
 * que sugerir.
 */
export function suggestFromDictionary(word: string, words: string[], max = 3): string[] {
  const needle = foldAccents(word.toLowerCase());
  if (needle.length === 0 || words.length === 0) return [];
  const limit = maxDistanceFor(needle.length);
  const scored: { word: string; distance: number }[] = [];
  for (const candidate of words) {
    const folded = foldAccents(candidate.toLowerCase());
    if (folded === needle) continue;
    const distance = levenshtein(needle, folded, limit);
    if (distance <= limit) scored.push({ word: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word, 'es'));
  return scored.slice(0, max).map((s) => s.word);
}
```

- [ ] **Step 5: Correr el runner y verificar que pasa**

```bash
node --experimental-strip-types src/app/dictionary/suggest.smoke.ts
```

Esperado: `suggestFromDictionary: 12/12 ok`.

Si el caso `['Kalliaa', DICT, 2, ['Kállia', 'Kallai']]` falla, calcular las distancias reales a mano antes de tocar la implementación — puede ser el caso esperado del test el que está mal, no el código. Corregir el que efectivamente esté mal, en el spec **y** en el smoke (los dos tienen que decir lo mismo).

- [ ] **Step 6: Verificar que el build sigue pasando**

```bash
pnpm build
```

Esperado: build exitoso (los `.spec.ts` y `.smoke.ts` no entran al bundle de Angular; el `suggest.ts` sí compila).

- [ ] **Step 7: Commit**

```bash
git add src/app/dictionary/suggest.ts src/app/dictionary/suggest.spec.ts src/app/dictionary/suggest.smoke.ts
git commit -m "feat(dictionary): suggestFromDictionary — candidatos del diccionario de la saga

Levenshtein con umbral por largo (1 hasta 6 chars, 2 arriba), comparación con
acentos plegados y case-insensitive, devolviendo la palabra tal cual está en
diccionario.txt. Orden por distancia y después alfabético. Función pura + smoke
runner con node --experimental-strip-types (el repo no tiene Karma)."
```

---

### Task 4: Mostrar los candidatos del diccionario en el popover de gramática

**Files:**
- Modify: `src/app/editor/editor.ts` (imports; el `signal` de `grammarPopover` en la línea ~166; `onGrammarHostClick` en ~1171-1191; el template binding sale por `editor.html`)
- Modify: `src/app/editor/editor.html:384-394`
- Modify: `src/app/editor/grammar-popover.ts`
- Modify: `src/app/editor/grammar-popover.scss`

**Interfaces:**
- Consumes: `suggestFromDictionary(word, words, max?)` de la Task 3. `SagaContextService.dictionary` es un `computed<Set<string>>` de palabras **en minúscula** — para sugerir hace falta la lista original, así que se agrega un accessor (Step 1).
- Produces: input nuevo `dictSuggestions = input<string[]>([])` en `GrammarPopover`. La Task 6 le cambia el contrato de posición a este mismo componente: no renombrar `apply`/`dismiss`/`addToDict`.

- [ ] **Step 1: Exponer la lista de palabras del diccionario (no solo el Set en minúscula)**

En `src/app/core/saga-context-service.ts`, el estado privado es `dictWords = signal<string[]>([])` y lo público es `dictionary = computed<Set<string>>(...)` con todo en minúscula. Agregar, junto a `dictionary`:

```ts
  /** Palabras del diccionario tal cual están escritas en `diccionario.txt`.
   *  `dictionary` (Set en minúscula) sirve para filtrar; para SUGERIR hace
   *  falta la forma original, que es la que se le ofrece al autor. */
  readonly dictionaryWords = computed<string[]>(() => this.dictWords());
```

- [ ] **Step 2: Calcular los candidatos al abrir el popover**

En `src/app/editor/editor.ts`:

Agregar el import:

```ts
import { suggestFromDictionary } from '../dictionary/suggest';
```

El signal del popover hoy es:

```ts
  protected readonly grammarPopover = signal<{ match: GrammarMatch; x: number; y: number; from: number; to: number } | null>(null);
```

Sumarle el campo de candidatos (la Task 6 va a reemplazar `x`/`y` por `anchor`; acá solo se agrega `dictSuggestions`):

```ts
  protected readonly grammarPopover = signal<{ match: GrammarMatch; x: number; y: number; from: number; to: number; dictSuggestions: string[] } | null>(null);
```

En `onGrammarHostClick`, donde hoy hace `this.grammarPopover.set({ match: m, x: ..., y: ..., from: m.from, to: m.to })`, calcular los candidatos antes del `set`:

```ts
    const rect = span.getBoundingClientRect();
    // El diccionario de la saga hasta ahora solo silenciaba falsos positivos.
    // Para los TYPOS también aporta candidatos: si el autor escribió mal un
    // nombre propio del mundo, LT nunca lo va a ofrecer.
    const word = this.tiptap?.state.doc.textBetween(m.from, m.to, ' ').trim() ?? '';
    const dictSuggestions =
      m.category === 'TYPOS' && word.length > 0
        ? suggestFromDictionary(word, this.sagaCtx.dictionaryWords(), 3).filter(
            (s) => !m.replacements.some((r) => r.toLowerCase() === s.toLowerCase()),
          )
        : [];
    this.grammarPopover.set({
      match: m,
      x: Math.min(rect.left, window.innerWidth - 340),
      y: rect.bottom + 4,
      from: m.from,
      to: m.to,
      dictSuggestions,
    });
```

- [ ] **Step 3: Pasar el input en el template**

En `src/app/editor/editor.html`, el bloque `@if (grammarPopover(); as gp)` tiene `<app-grammar-popover [match]="gp.match" [x]="gp.x" [y]="gp.y" ... />`. Agregar el binding:

```html
    [dictSuggestions]="gp.dictSuggestions"
```

- [ ] **Step 4: Renderizar los candidatos diferenciados en el popover**

En `src/app/editor/grammar-popover.ts`, agregar el input y renderizarlo arriba de la lista de LT. El componente hoy tiene `suggestions = computed(() => (this.match()?.replacements ?? []).slice(0, 5))`; se ajusta para que el total (diccionario + LT) no pase de 5:

```ts
  dictSuggestions = input<string[]>([]);
```

```ts
  suggestions = computed(() => {
    const room = Math.max(0, 5 - this.dictSuggestions().length);
    return (this.match()?.replacements ?? []).slice(0, room);
  });

  hasAnySuggestion = computed(() => this.dictSuggestions().length > 0 || this.suggestions().length > 0);
```

En el template, reemplazar el bloque `@if (suggestions().length > 0) { ... } @else { ... }` por:

```html
        @if (hasAnySuggestion()) {
          <ul class="reps">
            @for (r of dictSuggestions(); track r) {
              <li>
                <button type="button" class="rep-btn rep-btn--dict" (click)="apply.emit(r)">
                  {{ r }}<span class="rep-chip">tu diccionario</span>
                </button>
              </li>
            }
            @for (r of suggestions(); track r) {
              <li>
                <button type="button" class="rep-btn" (click)="apply.emit(r)">{{ r }}</button>
              </li>
            }
          </ul>
        } @else {
          <div class="no-reps">Sin sugerencias automáticas</div>
        }
```

- [ ] **Step 5: Estilo del chip**

En `src/app/editor/grammar-popover.scss`, agregar (usando las mismas variables CSS que ya usa el archivo para colores de acento — mirar las reglas existentes de `.rep-btn` y reusar esas variables, no hardcodear hex nuevos):

```scss
.rep-btn--dict {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.rep-chip {
  flex: none;
  font-size: 0.7em;
  text-transform: lowercase;
  opacity: 0.75;
  border: 1px solid currentcolor;
  border-radius: 999px;
  padding: 0 0.4em;
}
```

- [ ] **Step 6: Verificar que compila**

```bash
pnpm build
```

Esperado: build exitoso.

- [ ] **Step 7: Verificación manual**

`pnpm tauri dev`, abrir un capítulo en español de una saga que tenga `diccionario.txt` con nombres propios, con LanguageTool corriendo:
1. Escribir un nombre de la saga con un error de una letra (ej. `Kallay` si el diccionario tiene `Kallai`).
2. Esperar el subrayado de gramática y clickearlo.
3. El candidato del diccionario aparece **primero**, con el chip "tu diccionario"; abajo siguen los de LT.
4. Clickearlo reemplaza la palabra correctamente.
5. Sanity check de que no rompió nada: clickear un error de gramática común (no TYPOS, ej. concordancia) → cero chips, comportamiento idéntico al de antes.

- [ ] **Step 8: Commit**

```bash
git add src/app/core/saga-context-service.ts src/app/editor/editor.ts src/app/editor/editor.html src/app/editor/grammar-popover.ts src/app/editor/grammar-popover.scss
git commit -m "feat(grammar): sugerir palabras del diccionario de la saga en el popover

El diccionario per-saga solo silenciaba falsos positivos de LT: si el autor
escribía mal un nombre propio del mundo, LT ofrecía palabras del español y
nunca la correcta. Ahora los matches TYPOS traen hasta 3 candidatos del
diccionario (dedupeados contra los replacements de LT), mostrados arriba con
chip 'tu diccionario'. saga-context-service expone dictionaryWords() porque
el Set público está en minúscula y para sugerir hace falta la forma original."
```

---

### Task 5: `placePopover` — función pura de posicionamiento

**Files:**
- Create: `src/app/editor/popover-position.ts`
- Create: `src/app/editor/popover-position.spec.ts`
- Create: `src/app/editor/popover-position.smoke.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  ```ts
  interface AnchorBox { left: number; top: number; bottom: number; }
  interface PopoverSize { width: number; height: number; }
  interface ViewportBox { width: number; height: number; }
  interface Placement { x: number; y: number; placement: 'below' | 'above'; maxHeight: number; }
  function placePopover(anchor: AnchorBox, size: PopoverSize, viewport: ViewportBox, gap?: number, margin?: number): Placement
  ```
  La Task 6 consume estos cuatro tipos y la función. `gap` default 6, `margin` default 8.

- [ ] **Step 1: Escribir el spec con los casos**

Crear `src/app/editor/popover-position.spec.ts`:

```ts
/**
 * Tests de `popover-position.ts` — ubicación de los popovers de gramática y RAE.
 *
 * Sin Karma en el repo: los casos viven acá y `popover-position.smoke.ts` los
 * corre con `node --experimental-strip-types`. La función es pura (no toca DOM),
 * así que se testea entera.
 */
import { placePopover } from './popover-position';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toEqual: (expected: unknown) => void;
};

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 320, height: 200 };

describe('placePopover', () => {
  it('abre abajo cuando entra abajo', () => {
    const anchor = { left: 100, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 100,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('flipea arriba cuando no entra abajo pero sí arriba', () => {
    // bottom=700: 700+6+200=906 > 800-8. Arriba: 650-6-200=444 >= 8 → cabe.
    const anchor = { left: 100, top: 650, bottom: 700 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 100,
      y: 444,
      placement: 'above',
      maxHeight: 200,
    });
  });

  it('cuando no entra en ningún lado elige el lado con más espacio y limita la altura', () => {
    // Viewport chico: 300 de alto. anchor top=140 bottom=160.
    // Abajo: 300-8-160-6 = 126. Arriba: 140-6-8 = 126. Empate → below.
    const anchor = { left: 100, top: 140, bottom: 160 };
    expect(placePopover(anchor, SIZE, { width: 1000, height: 300 })).toEqual({
      x: 100,
      y: 166,
      placement: 'below',
      maxHeight: 126,
    });
  });

  it('cuando hay más espacio arriba que abajo, pega arriba con altura limitada', () => {
    // Viewport 300. anchor top=250 bottom=280. Abajo: 300-8-280-6=6.
    // Arriba: 250-6-8=236 → gana arriba, y=8, maxHeight=236.
    const anchor = { left: 100, top: 250, bottom: 280 };
    expect(placePopover(anchor, SIZE, { width: 1000, height: 300 })).toEqual({
      x: 100,
      y: 8,
      placement: 'above',
      maxHeight: 236,
    });
  });

  it('clampea X contra el borde derecho', () => {
    const anchor = { left: 950, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 672, // 1000 - 320 - 8
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('clampea X contra el borde izquierdo', () => {
    const anchor = { left: -50, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT)).toEqual({
      x: 8,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('con viewport más angosto que el popover deja X en el margen', () => {
    const anchor = { left: 40, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, { width: 200, height: 800 })).toEqual({
      x: 8,
      y: 126,
      placement: 'below',
      maxHeight: 200,
    });
  });

  it('respeta gap y margin custom', () => {
    const anchor = { left: 100, top: 100, bottom: 120 };
    expect(placePopover(anchor, SIZE, VIEWPORT, 20, 40)).toEqual({
      x: 100,
      y: 140,
      placement: 'below',
      maxHeight: 200,
    });
  });
});
```

- [ ] **Step 2: Escribir el runner standalone**

Crear `src/app/editor/popover-position.smoke.ts`:

```ts
/**
 * Runner standalone de los casos de `popover-position.spec.ts`.
 * Correr con: `node --experimental-strip-types src/app/editor/popover-position.smoke.ts`
 */
import assert from 'node:assert';
import { placePopover } from './popover-position.ts';

const VIEWPORT = { width: 1000, height: 800 };
const SMALL = { width: 1000, height: 300 };
const NARROW = { width: 200, height: 800 };
const SIZE = { width: 320, height: 200 };

const cases: Array<[string, () => unknown, unknown]> = [
  ['abre abajo', () => placePopover({ left: 100, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 100, y: 126, placement: 'below', maxHeight: 200 }],
  ['flipea arriba', () => placePopover({ left: 100, top: 650, bottom: 700 }, SIZE, VIEWPORT), { x: 100, y: 444, placement: 'above', maxHeight: 200 }],
  ['no entra en ningún lado → below con altura limitada', () => placePopover({ left: 100, top: 140, bottom: 160 }, SIZE, SMALL), { x: 100, y: 166, placement: 'below', maxHeight: 126 }],
  ['no entra en ningún lado → above con altura limitada', () => placePopover({ left: 100, top: 250, bottom: 280 }, SIZE, SMALL), { x: 100, y: 8, placement: 'above', maxHeight: 236 }],
  ['clamp derecho', () => placePopover({ left: 950, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 672, y: 126, placement: 'below', maxHeight: 200 }],
  ['clamp izquierdo', () => placePopover({ left: -50, top: 100, bottom: 120 }, SIZE, VIEWPORT), { x: 8, y: 126, placement: 'below', maxHeight: 200 }],
  ['viewport angosto', () => placePopover({ left: 40, top: 100, bottom: 120 }, SIZE, NARROW), { x: 8, y: 126, placement: 'below', maxHeight: 200 }],
  ['gap y margin custom', () => placePopover({ left: 100, top: 100, bottom: 120 }, SIZE, VIEWPORT, 20, 40), { x: 100, y: 140, placement: 'below', maxHeight: 200 }],
];

let passed = 0;
for (const [name, run, expected] of cases) {
  const got = run();
  assert.deepStrictEqual(got, expected, `\n  case: ${name}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
  passed++;
}
console.log(`placePopover: ${passed}/${cases.length} ok`);
```

- [ ] **Step 3: Correr el runner y verificar que falla**

```bash
node --experimental-strip-types src/app/editor/popover-position.smoke.ts
```

Esperado: FALLA con `Cannot find module './popover-position.ts'`.

- [ ] **Step 4: Implementar el módulo**

Crear `src/app/editor/popover-position.ts`:

```ts
/**
 * Ubicación de los popovers flotantes del editor (gramática y RAE).
 *
 * Antes se posicionaban con `y = rect.bottom + 4` fijo y un clamp de X con
 * constantes mágicas que ni coincidían con el `max-width` del CSS: un error
 * cerca del borde inferior abría un popup que no se veía. Acá se decide el lado
 * con el espacio real disponible y, si no entra en ninguno, se limita la altura
 * para que el popover scrollee adentro en vez de cortarse.
 *
 * Pura y sin DOM: la mide el componente y le pasa los números.
 */

/** Caja del elemento que ancla el popover, en coordenadas de viewport
 *  (`getBoundingClientRect`). Los popovers son `position: fixed`. */
export interface AnchorBox {
  left: number;
  top: number;
  bottom: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ViewportBox {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  placement: 'below' | 'above';
  /** Alto máximo que el popover puede ocupar. Igual a `size.height` cuando
   *  entra completo; menor cuando hubo que limitarlo (el componente aplica
   *  `overflow-y: auto`). */
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function placePopover(
  anchor: AnchorBox,
  size: PopoverSize,
  viewport: ViewportBox,
  gap = 6,
  margin = 8,
): Placement {
  const x = clamp(anchor.left, margin, viewport.width - size.width - margin);
  const spaceBelow = viewport.height - margin - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - margin;

  if (size.height <= spaceBelow) {
    return { x, y: anchor.bottom + gap, placement: 'below', maxHeight: size.height };
  }
  if (size.height <= spaceAbove) {
    return { x, y: anchor.top - gap - size.height, placement: 'above', maxHeight: size.height };
  }
  // No entra completo en ninguno: gana el lado con más aire y el popover
  // scrollea adentro. Empate → abajo (lectura natural desde el anchor).
  if (spaceBelow >= spaceAbove) {
    return {
      x,
      y: anchor.bottom + gap,
      placement: 'below',
      maxHeight: Math.max(0, spaceBelow),
    };
  }
  return { x, y: margin, placement: 'above', maxHeight: Math.max(0, spaceAbove) };
}
```

- [ ] **Step 5: Correr el runner y verificar que pasa**

```bash
node --experimental-strip-types src/app/editor/popover-position.smoke.ts
```

Esperado: `placePopover: 8/8 ok`. Si algún número no da, recalcular la aritmética del caso a mano antes de cambiar la implementación — puede ser el valor esperado el que está mal. Si se corrige un caso, corregirlo en el `.spec.ts` **y** en el `.smoke.ts`.

- [ ] **Step 6: Verificar el build**

```bash
pnpm build
```

Esperado: build exitoso.

- [ ] **Step 7: Commit**

```bash
git add src/app/editor/popover-position.ts src/app/editor/popover-position.spec.ts src/app/editor/popover-position.smoke.ts
git commit -m "feat(editor): placePopover — flip arriba/abajo con clamp y maxHeight

Función pura que elige el lado según el espacio real del viewport, clampea X
contra los bordes y, cuando no entra completo en ningún lado, devuelve el
maxHeight disponible para que el popover scrollee adentro en vez de cortarse.
Smoke runner con node --experimental-strip-types (el repo no tiene Karma)."
```

---

### Task 6: Popovers auto-posicionados (gramática y RAE)

**Files:**
- Modify: `src/app/editor/grammar-popover.ts`
- Modify: `src/app/editor/grammar-popover.scss:1-6`
- Modify: `src/app/editor/rae-popover.ts`
- Modify: `src/app/editor/rae-popover.scss:1-6`
- Modify: `src/app/editor/editor.ts` (signals `grammarPopover` ~166 y `raePopover` ~168; `onGrammarHostClick` ~1171; `onRaeHostClick` ~1151; `createEditor` para el listener de scroll ~1278-1290; `ngOnDestroy`/cleanup donde se remueven los otros listeners del host)
- Modify: `src/app/editor/editor.html:384-405`

**Interfaces:**
- Consumes: `placePopover`, `AnchorBox`, `PopoverSize`, `ViewportBox`, `Placement` de la Task 5. `dictSuggestions` input de la Task 4 (ya existente en `GrammarPopover`; no tocar).
- Produces: contrato nuevo de ambos popovers — input `anchor = input<AnchorBox | null>(null)` en lugar de `x`/`y`. Los outputs (`apply`, `dismiss`, `addToDict`, `applyParagraph`) quedan igual.

- [ ] **Step 1: Auto-posicionamiento en `GrammarPopover`**

En `src/app/editor/grammar-popover.ts`: sacar los inputs `x`/`y`, recibir `anchor`, medir el elemento raíz y aplicar el `Placement`.

Imports:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { AnchorBox, Placement, placePopover } from './popover-position';
```

Clase:

```ts
  match = input<GrammarMatch | null>(null);
  anchor = input<AnchorBox | null>(null);
  dictSuggestions = input<string[]>([]);
  apply = output<string>();
  dismiss = output<void>();
  addToDict = output<void>();

  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  /** null hasta que el popover se midió: se renderiza invisible para que no se
   *  vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);

  constructor() {
    // Medición real: el alto depende de cuántas sugerencias haya, así que no
    // se puede estimar desde el CSS. Se mide el elemento ya renderizado y se
    // recoloca en el mismo ciclo.
    afterRenderEffect(() => {
      const anchor = this.anchor();
      const el = this.root()?.nativeElement;
      if (!anchor || !el) {
        this.placed.set(null);
        return;
      }
      this.placed.set(
        placePopover(
          anchor,
          { width: el.offsetWidth, height: el.scrollHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    });
  }
```

En el template, el `<div class="grammar-pop">` pasa a:

```html
      <div
        #root
        class="grammar-pop"
        [class.grammar-pop--measuring]="placed() === null"
        [style.top.px]="placed()?.y ?? 0"
        [style.left.px]="placed()?.x ?? 0"
        [style.max-height.px]="placed()?.maxHeight ?? null"
        (click)="$event.stopPropagation()"
      >
```

**Por qué `afterRenderEffect` y no `afterNextRender`:** el precedente del repo es `afterNextRender` (`src/app/shared/select.ts:97`), que corre una sola vez. Acá hace falta remedir cada vez que cambian el anchor, las sugerencias o el tamaño de ventana, y `afterRenderEffect` es la variante reactiva: re-corre cuando cambian los signals que lee.

`scrollHeight` y no `offsetHeight` para medir el alto **deseado**: una vez que se aplica `max-height`, `offsetHeight` devolvería el alto ya recortado y el cálculo se realimentaría solo.

- [ ] **Step 2: Recalcular ante `resize`**

En la misma clase de `GrammarPopover`, agregar un listener de ventana que fuerce la remedición. Con signals alcanza con un signal "tick" que el `afterRenderEffect` lea:

```ts
  private readonly resizeTick = signal(0);
```

Leerlo dentro del `afterRenderEffect` (primera línea del callback: `this.resizeTick();`) y en el constructor:

```ts
    const onResize = (): void => this.resizeTick.update((n) => n + 1);
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));
```

Agregar `DestroyRef` y `inject` a los imports de `@angular/core`.

- [ ] **Step 3: Mismo tratamiento en `RaePopover`**

En `src/app/editor/rae-popover.ts` aplicar exactamente el mismo patrón: sacar `x`/`y`, sumar `anchor = input<AnchorBox | null>(null)`, `viewChild('root')`, `placed` signal, `afterRenderEffect` con `resizeTick`, y en el template `#root` + `[style.top.px]`/`[style.left.px]`/`[style.max-height.px]` + la clase `rae-pop--measuring`. El resto del template (`rae-pop-head`, `rae-pop-msg`, footer, las clases por categoría) queda intacto, igual que los outputs `apply`, `applyParagraph` y `dismiss`.

Se repite el código en vez de extraer una base compartida: son dos componentes chicos con templates y estilos distintos, y una clase base con `viewChild` + `afterRenderEffect` heredados es más difícil de seguir que veinte líneas duplicadas. Si aparece un tercer popover, ahí sí conviene extraer una directiva.

- [ ] **Step 4: Estilos de medición y scroll interno**

En `src/app/editor/grammar-popover.scss`, la regla de `.grammar-pop` ya tiene `position: fixed`, `z-index: 1000`, `min-width: 220px`, `max-width: 320px`. Agregarle:

```scss
  overflow-y: auto;
  overscroll-behavior: contain;
```

Y la clase de medición:

```scss
.grammar-pop--measuring {
  visibility: hidden;
}
```

En `src/app/editor/rae-popover.scss`, lo mismo sobre `.rae-pop` (que ya tiene `position: fixed`, `min-width: 240px`, `max-width: 360px`) más:

```scss
.rae-pop--measuring {
  visibility: hidden;
}
```

- [ ] **Step 5: `editor.ts` pasa el anchor y se olvida de las constantes mágicas**

En `src/app/editor/editor.ts`:

Import:

```ts
import { AnchorBox } from './popover-position';
```

Los dos signals dejan de guardar `x`/`y`:

```ts
  protected readonly grammarPopover = signal<{ match: GrammarMatch; anchor: AnchorBox; from: number; to: number; dictSuggestions: string[] } | null>(null);
```

```ts
  protected readonly raePopover = signal<{ violation: RaeViolationPos; anchor: AnchorBox } | null>(null);
```

En `onRaeHostClick`, reemplazar el `set` (que hoy calcula `x: Math.min(rect.left, window.innerWidth - 380)` y `y: rect.bottom + 4`) por:

```ts
    const rect = span.getBoundingClientRect();
    this.raePopover.set({
      violation: v,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
```

En `onGrammarHostClick`, ídem (manteniendo el cálculo de `dictSuggestions` de la Task 4):

```ts
    this.grammarPopover.set({
      match: m,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
      from: m.from,
      to: m.to,
      dictSuggestions,
    });
```

Todo lo demás que lee `popover.from`/`popover.to`/`popover.match` (`applyGrammarReplacement`, `dismissGrammarMatch`, `addCurrentToDictionary`, los handlers de RAE) sigue funcionando sin cambios: solo desaparecieron `x` e `y`.

- [ ] **Step 6: Cerrar los popovers al scrollear**

Los popovers son `position: fixed` y hoy se cierran ante cualquier tipeo (`onTransaction`) pero **no** ante scroll, así que al scrollear quedan flotando desanclados del span que los originó.

En `createEditor()`, donde ya se registran `grammarHostListener` y `raeHostListener` sobre `this.hostRef.nativeElement` (líneas ~1278-1290), sumar un listener de scroll con el mismo patrón de guardar la referencia para poder removerla:

```ts
    if (this.popoverScrollListener) {
      this.hostRef.nativeElement.removeEventListener('scroll', this.popoverScrollListener);
    }
    // Los popovers son position:fixed y no siguen al scroll: si el capítulo se
    // mueve, quedarían flotando lejos del span que los abrió.
    this.popoverScrollListener = () => {
      if (this.grammarPopover()) this.grammarPopover.set(null);
      if (this.raePopover()) this.raePopover.set(null);
    };
    this.hostRef.nativeElement.addEventListener('scroll', this.popoverScrollListener, { passive: true });
```

Declarar el campo junto a los otros dos listeners de la clase:

```ts
  private popoverScrollListener: (() => void) | null = null;
```

Y removerlo en `ngOnDestroy()` (`editor.ts:650`), donde ya se remueven `grammarHostListener` y `raeHostListener`, con el mismo patrón (`removeEventListener` + `= null`).

- [ ] **Step 7: `editor.html` con el contrato nuevo**

En `src/app/editor/editor.html`, los dos bloques pasan a:

```html
@if (grammarPopover(); as gp) {
  <div class="grammar-pop-backdrop" (click)="closeGrammarPopover()"></div>
  <app-grammar-popover
    [match]="gp.match"
    [anchor]="gp.anchor"
    [dictSuggestions]="gp.dictSuggestions"
    (apply)="applyGrammarReplacement($event)"
    (dismiss)="dismissGrammarMatch()"
    (addToDict)="addCurrentToDictionary()"
  />
}

@if (raePopover(); as rp) {
  <div class="grammar-pop-backdrop" (click)="dismissRae()"></div>
  <app-rae-popover
    [violation]="rp.violation"
    [anchor]="rp.anchor"
    (apply)="applyRaeFix()"
    (applyParagraph)="applyRaeParagraph()"
    (dismiss)="dismissRae()"
  />
}
```

- [ ] **Step 8: Verificar que compila y que los tests puros siguen pasando**

```bash
pnpm build
node --experimental-strip-types src/app/editor/popover-position.smoke.ts
node --experimental-strip-types src/app/dictionary/suggest.smoke.ts
```

Esperado: build exitoso, `placePopover: 8/8 ok`, `suggestFromDictionary: 12/12 ok`. Si el build se queja de `x`/`y` en algún template, quedó un binding viejo — buscar `[x]=` y `[y]=` en `src/app`.

- [ ] **Step 9: Verificación manual**

`pnpm tauri dev`, con LanguageTool corriendo y un capítulo en español:
1. Click en un error de gramática en la **última línea visible** del editor → el popover abre **hacia arriba** y se ve completo.
2. Click en un error arriba en la pantalla → abre hacia abajo, como siempre.
3. Click en un error pegado al borde derecho → no se sale de la ventana.
4. Con el popover abierto, scrollear el editor → se cierra.
5. Con el popover abierto, redimensionar la ventana a una altura chica → se recoloca y, si no entra, scrollea adentro sin cortarse.
6. Repetir 1, 2 y 4 con una violación RAE (botón "Revisar RAE").
7. Cero flash: el popover no se ve aparecer primero en la posición vieja.

- [ ] **Step 10: Commit**

```bash
git add src/app/editor/grammar-popover.ts src/app/editor/grammar-popover.scss src/app/editor/rae-popover.ts src/app/editor/rae-popover.scss src/app/editor/editor.ts src/app/editor/editor.html
git commit -m "fix(editor): popovers de gramática y RAE se ubican donde hay lugar

Antes posicionaban con y = rect.bottom + 4 fijo y clamp de X con constantes
mágicas (340/380) que no coincidían con el max-width real, así que un error
cerca del borde inferior abría un popup cortado. Ahora reciben el anchor rect,
se miden a sí mismos (afterRenderEffect + visibility:hidden hasta tener medida)
y aplican placePopover: flip arriba/abajo, clamp de X, y max-height con scroll
interno cuando no entra completo en ningún lado. Recalculan en resize y se
cierran al scrollear el editor (son position:fixed, no seguían al scroll)."
```

---

### Task 7: Cerrar el ciclo en la documentación

**Files:**
- Modify: `TODO.md` (el item "Control total del tipeo…" en §Editor / UX)

**Interfaces:**
- Consumes: el resultado real de las verificaciones manuales de las Tasks 1, 2, 4 y 6.
- Produces: nada.

- [ ] **Step 1: Marcar el item como hecho con el resultado real**

En `TODO.md`, el item `- **Control total del tipeo — …**` pasa a `- [x] **Control total del tipeo — …**`, siguiendo la convención del archivo (los `[x]` llevan el nombre de la rama o PR y un resumen de lo que efectivamente se hizo). Sumar al final del párrafo:

- Qué capa terminó apagando la autocorrección de macOS: `registerDefaults`, los setters sobre la webview, o las dos. Si algún selector se salteó por `respondsToSelector:`, nombrarlo.
- Confirmación de que el voseo no se reescribe y de que las comillas curvas son las de Typography.
- Los conteos reales de los smoke runners.

Nada de "debería funcionar": lo que se verificó, con lo que se observó.

- [ ] **Step 2: Commit**

```bash
git add TODO.md
git commit -m "docs: cerrar el item de control total del tipeo con el resultado verificado"
```

---

## Self-Review

**Cobertura del spec:**

| Requisito del spec | Task |
|---|---|
| Componente 1 — atributos en `<html>` + `editorProps` en ambos editores | Task 1 |
| Componente 2 — `macos_text.rs`, `registerDefaults`, setters gateados, deps macOS-only, wiring en `lib.rs` | Task 2 |
| Componente 3 — `suggest.ts` puro con Levenshtein, umbral por largo, fold de acentos | Task 3 |
| Componente 3 — integración: 3 candidatos, dedupe contra LT, chip "tu diccionario", tope 5 | Task 4 |
| Componente 4 — `placePopover` con flip, clamp, `maxHeight` | Task 5 |
| Componente 4 — contrato `anchor`, medición real, `resize`, cierre en scroll, `overflow-y` | Task 6 |
| Verificación — unit tests con el patrón `.spec.ts` + `.smoke.ts` | Tasks 3 y 5 |
| Verificación — manual de voseo, comillas, inputs | Tasks 1 y 2 |
| Verificación — manual de popup y diccionario | Tasks 4 y 6 |

Sin huecos.

**Consistencia de tipos:** `AnchorBox`/`PopoverSize`/`ViewportBox`/`Placement` y `placePopover` se definen en la Task 5 y se consumen con esos mismos nombres en la Task 6. `suggestFromDictionary(word, words, max)` se define en la Task 3 y se llama con esa firma en la Task 4. `dictionaryWords()` se agrega en la Task 4 Step 1 y se usa en el Step 2 de la misma tarea. El input `dictSuggestions` que agrega la Task 4 sobrevive el refactor de la Task 6 (está explícito en el bloque de la clase del Step 1). `disable_native_text_substitutions(&tauri::AppHandle)` se define y se llama dentro de la Task 2.

**Riesgo conocido, marcado en el plan:** la API exacta de `objc2` 0.6 para registrar un selector por nombre (`Sel::register_unchecked_from_str`) puede diferir. La Task 2 Step 3 dice explícitamente qué chequear y qué alternativa preferir, y qué parte del diseño no se negocia. El resto del plan no depende de eso.
