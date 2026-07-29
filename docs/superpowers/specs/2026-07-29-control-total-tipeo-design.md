# Control total del tipeo: matar el corrector del OS, sugerir del diccionario propio y ubicar bien el popup

Fecha: 2026-07-29

## Problema

tWriter es un editor de texto y hoy delega parte del tipeo al sistema operativo. Eso rompe la escritura:

1. **macOS reescribe el texto.** La autocorrección y las sustituciones nativas (comillas
   inteligentes, guiones, "reemplazo de texto") muerden dentro de la webview y arruinan el
   voseo rioplatense (`tenés`, `andá`, `querés`) tanto en el editor como en los inputs
   comunes de la app. El autor pierde tiempo deshaciendo correcciones no pedidas.
2. **El diccionario de la saga no sugiere nada.** `SagaContextService.dictionary` solo
   *silencia* falsos positivos de LanguageTool (filtro de matches `TYPOS` en `editor.ts`).
   Nunca aporta candidatos: escribir `Kallay` ofrece palabras del diccionario español y
   nunca `Kallai`, que es justo la que hace falta.
3. **El popup de gramática/RAE se corta.** `onGrammarHostClick` y `onRaeHostClick`
   (`editor.ts:1163-1190`) posicionan con `y = rect.bottom + 4` fijo y clampean X con
   constantes mágicas (`340`, `380`) que no coinciden con el CSS real (`max-width` 320 y
   360). Un error cerca del borde inferior abre un popup que no se ve.

## Alcance

Este spec cubre esos tres puntos. Quedan **fuera**:

- Autocompletado inline de términos del proyecto mientras se escribe (feature aparte, ya
  anotada en `TODO.md` §Búsqueda: `@tiptap/suggestion` + prefix query sobre el índice
  tantivy + diccionario per-saga).
- El artefacto de glifo en algunas letras y el scroll a la línea nueva al tipear: se
  anotan como bugs pendientes en `TODO.md`, no se resuelven acá.

## Decisiones de diseño

- **La app manda sobre el tipeo, no el OS.** Ninguna opinión del sistema operativo entra
  al flujo creativo. No hay toggle "usar corrector del sistema": simplemente se apaga.
- **Typography de TipTap sigue siendo la única fuente de sustitución tipográfica.**
  Comillas curvas y rayas las produce la app — determinista e igual en macOS, Windows y
  Linux, coherente con el conversor RAE y el educador de comillas EN.
- **LanguageTool sigue siendo el único corrector**, ahora complementado con el diccionario
  de la saga como fuente de candidatos (LT no tiene API de completion, solo `/v2/check`).

## Componente 1 — Apagar el corrector nativo (capa web)

`src/index.html`: `<html spellcheck="false" autocorrect="off" autocapitalize="off">`. Los
tres atributos se heredan, así que una sola declaración cubre todos los inputs y
contenteditables de la app sin tocar los ~30 templates. El `lang="en"` que ya tiene ese tag
queda como está: al apagar el corrector por completo el idioma declarado deja de influir en
esto, y cambiarlo tocaría hyphenation y otros comportamientos fuera de alcance.

Además, explícito en los dos editores TipTap — `editor.ts` (`createEditor`, línea ~1194) y
`notes-editor.ts` (línea ~336) — vía `editorProps.attributes`:

```
spellcheck: 'false'
autocorrect: 'off'
autocapitalize: 'off'
autocomplete: 'off'
'data-gramm': 'false'
'data-gramm_editor': 'false'
```

Explícito y no solo heredado porque ProseMirror reescribe los atributos del contenteditable
al montar la vista.

Con esto quedan cubiertos Linux (WebKitGTK) y Windows (WebView2), que respetan
`spellcheck="false"`.

## Componente 2 — Apagar las sustituciones nativas de macOS (capa Rust)

Los atributos HTML no alcanzan en macOS: WKWebView aplica autocorrección y sustituciones
del sistema por encima del contenteditable.

Nuevo módulo `src-tauri/src/macos_text.rs`, todo bajo `#[cfg(target_os = "macos")]`,
invocado desde el `setup` de `lib.rs`. Dos capas independientes, por si una no muerde:

1. **Defaults registrados antes de crear la webview.** `NSUserDefaults.registerDefaults`
   (registro en memoria: no escribe el plist del usuario, no afecta nada fuera de la app)
   con todos en `false`: `NSAutomaticQuoteSubstitutionEnabled`,
   `NSAutomaticDashSubstitutionEnabled`, `NSAutomaticTextReplacementEnabled`,
   `NSAutomaticSpellingCorrectionEnabled`, `NSAutomaticPeriodSubstitutionEnabled`,
   `NSAutomaticCapitalizationEnabled`, `WebContinuousSpellCheckingEnabled`,
   `WebAutomaticSpellingCorrectionEnabled`.
2. **Setters por instancia de webview.** Vía `window.with_webview(|wv| …)`, mandar a la
   `WKWebView` los selectores de `NSTextCheckingClient`:
   `setAutomaticQuoteSubstitutionEnabled:`, `setAutomaticDashSubstitutionEnabled:`,
   `setAutomaticTextReplacementEnabled:`, `setAutomaticSpellingCorrectionEnabled:`,
   `setContinuousSpellCheckingEnabled:`, `setSmartInsertDeleteEnabled:`. **Cada uno
   gateado por `respondsToSelector:`** para que una versión de WebKit que no los exponga
   no panickee ni cuelgue la app.

Dependencias nuevas, macOS-only, en `[target.'cfg(target_os = "macos")'.dependencies]`:
`objc2` y `objc2-foundation` (crates canónicas del ecosistema, ya presentes en el árbol de
Tauri). Fijar versión estable con más de 7 días de publicada.

**No es verificable por test unitario.** Se reproduce a mano en la Mac del autor. Si la
capa 2 no tiene efecto (selectores privados o renombrados), la capa 1 sola ya cubre la
autocorrección: se documenta el resultado real observado, no el esperado.

## Componente 3 — Sugerencias desde el diccionario de la saga

Módulo nuevo `src/app/dictionary/suggest.ts`, función pura:

```
suggestFromDictionary(word: string, words: string[], max: number): string[]
```

- Distancia de Levenshtein con umbral por longitud, el mismo criterio que ya usa la
  búsqueda fuzzy: ≤1 para palabras cortas, ≤2 para largas.
- Comparación case-insensitive y con acentos plegados (reusar `foldAccents` de
  `core/search-highlight.ts`), pero devolviendo la palabra **tal cual está escrita** en
  `diccionario.txt`.
- Orden por distancia ascendente y después alfabético para que el resultado sea estable.
- La lista tiene decenas o cientos de palabras: corre en TS, sin Rust y sin red.

Integración: cuando el match abierto tiene `category === 'TYPOS'`, el editor pasa al
popover hasta 3 candidatos del diccionario de la saga, deduplicados contra los
`replacements` de LT. `GrammarPopover` los muestra arriba y visualmente diferenciados (chip
"tu diccionario") para no confundirlos con los de LT; los de LT siguen abajo hasta
completar 5 en total.

## Componente 4 — Posicionamiento del popup

Módulo nuevo `src/app/editor/popover-position.ts`, función pura:

```
placePopover(anchor, size, viewport, gap = 6, margin = 8)
  → { x, y, placement: 'below' | 'above', maxHeight }
```

Reglas, en orden:

1. Abajo si entra completo: `anchor.bottom + gap + height <= viewport.height - margin`.
2. Si no, arriba si entra completo: `anchor.top - gap - height >= margin`.
3. Si no entra en ninguno, elegir el lado con más espacio, pegar el popover contra el
   margen y devolver `maxHeight` = espacio disponible.
4. X siempre `clamp(anchor.left, margin, viewport.width - width - margin)`.

**Medición real, no estimada.** Cambio de contrato en `GrammarPopover` y `RaePopover`: en
vez de los inputs `x`/`y` reciben `anchor: DOMRect` y calculan su posición en un
`afterRenderEffect`, midiendo `offsetWidth`/`offsetHeight` del elemento raíz vía
`viewChild`, con `visibility: hidden` hasta tener medida para que no se vea el salto. Las
constantes `340`/`380` de `editor.ts` desaparecen: el editor solo pasa el rect del span.

En el SCSS de ambos popovers: aplicar el `maxHeight` calculado + `overflow-y: auto` para
que el caso 3 scrollee adentro en vez de cortarse.

Recalcular ante `resize` de la ventana. Y cerrar el popover ante scroll del `.editor-host`:
hoy se cierra ante cualquier tipeo (`onTransaction`) pero no ante scroll, así que queda
flotando desanclado del span que lo originó.

## Verificación

**Unit tests (Karma):**

- `popover-position.spec.ts`: cabe abajo; no cabe abajo y flipea arriba; no cabe en ninguno
  (clamp + `maxHeight`); clamp de X contra el borde izquierdo y el derecho.
- `dictionary/suggest.spec.ts`: match con acentos (`kallai` ↔ `Kállai`); umbral por
  longitud (palabra corta no tolera 2 ediciones); orden por distancia; dedupe contra
  replacements de LT; sin match cuando nada está cerca.

**Manual, en la Mac (único camino para los componentes 1 y 2):**

- Tipear `vos tenés`, `andá`, `querés` en el editor: cero reescritura.
- Tipear `"`: las comillas curvas que salen son las de Typography, no las del sistema.
- Cero subrayado rojo del OS, en el editor y en los inputs de búsqueda y configuración.

**Manual, popup:**

- Click en un error de gramática en la última línea visible del capítulo: abre hacia arriba
  y se ve completo. Ídem con una violación RAE.
- Scrollear con el popup abierto: se cierra.

**Manual, diccionario:**

- Escribir un nombre de la saga mal tipeado: la palabra correcta aparece con chip
  "tu diccionario".
