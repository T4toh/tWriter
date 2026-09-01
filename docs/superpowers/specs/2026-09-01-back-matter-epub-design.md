# Back matter del EPUB: catálogo de publicados, perfil de autor y página legal

**Fecha**: 2026-09-01
**Estado**: diseño aprobado, pendiente de plan de implementación

## Problema

Hoy el final del EPUB no vende nada. Cuando el lector termina la novela
encuentra, como mucho, una página "Sobre el autor" con una bio que hay que
copiar y pegar en cada `book.json`, y una contratapa. No hay forma de decirle
que existe un segundo libro de la misma saga, ni que hay otras sagas.

Del pedido del autor salen tres cosas que son la misma cosa — todas viven en
el back matter y todas se alimentan de datos que ya están en el repo:

1. Una sección "Otros libros" al final del EPUB, que se arme sola: los otros
   libros publicados de la misma saga, y los de las otras sagas.
2. El perfil del autor en un solo lugar en vez de repetido por libro.
3. Los incisos de la página legal editables, incluida una nota que aclare que
   la IA se usó solo para generar imágenes y que el texto es del autor.

## Decisiones tomadas

| Decisión | Elegido | Por qué |
|---|---|---|
| Alcance de "página del autor" | La del EPUB, mejorada | El sitio web es otro proyecto; el dato es el mismo y se puede exportar después. |
| Links por libro | Uno solo, libre | Apunta a `tatoh.ar/libros/<libro>`, donde el autor lista las tiendas. Si mañana suma Kobo, el EPUB ya publicado sigue sirviendo. |
| Qué es "publicado" | Tener `link` cargado | Cero flags nuevos, imposible filtrar un inédito por olvido. |
| Origen del catálogo | Escaneo del root al exportar | Los 21 libros ya están en disco con título, subtítulo, tapa y número de serie. Una lista manual sería el mismo dato escrito dos veces. |
| Perfil del autor | `autor.json` en la raíz | Un repo, un escritor. Los campos del libro quedan como override. |
| Página legal | Checks por inciso + texto editable | Cubre también el ítem viejo de "copyright editable en ambos idiomas". |
| Disposición de la lista | Tapa a la izquierda, texto al lado | Entran varios libros por pantalla y se lee como catálogo. |
| Índice | Todas las editoriales, agrupadas aparte | Se puede saltar a cualquier página, sin que el listado de capítulos pierda legibilidad. |

## Modelo de datos

### `autor.json` (nuevo, en la raíz del repo de novelas)

```json
{
  "nombre": "Ignacio Martín Arano",
  "bio": { "es": "...", "en": "..." },
  "foto": "autor.jpg",
  "web": "https://tatoh.ar/libros"
}
```

Módulo `src-tauri/src/autor.rs`, con el patrón de `saga_config.rs`: struct
`AutorConfig` con todos los campos opcionales, comandos `get_autor_config` /
`set_autor_config`, y auto-detección de `autor.*` / `author.*` en disco para la
foto, igual que hace hoy `find_author_photo_in`.

La página "Sobre el autor" usa la bio del idioma del libro; si esa falta, cae a
la otra. Si no hay ninguna bio ni en `autor.json` ni en el libro, la página no
se genera (comportamiento actual).

`sobre_el_autor` y `foto_autor` **siguen existiendo en `book.json` como
override**. No hay migración: los libros que ya los tengan cargados exportan
igual que hoy.

### Campos nuevos en `book.json`

El struct `BookConfig` es plano y se mantiene plano — nada de structs anidados.

| Campo | Tipo | Default | Para qué |
|---|---|---|---|
| `link` | `Option<String>` | ausente | URL pública del libro. Su presencia es lo que lo mete en el catálogo de los demás EPUB. |
| `obra_de_ficcion` | `Option<bool>` | hereda `derechos_reservados` | Inciso de obra de ficción, ahora separado. |
| `nota_ia` | `Option<bool>` | `false` | Inciso de uso de IA. |
| `textos_legales` | `Option<BTreeMap<String, String>>` | ausente | Override de redacción por inciso. Solo se guarda lo que se edita. |

**Compatibilidad**: un `book.json` de hoy (con `derechos_reservados: true` y
nada más) prende `reserva` + `ficcion` y deja `ia` apagado, o sea produce
exactamente la misma página legal que ahora. Hay un test que lo fija.

## Descubrimiento del catálogo

Módulo nuevo `src-tauri/src/catalogo.rs`. No va en `epub.rs`, que ya tiene
2.197 líneas.

```rust
pub struct LibroPublicado {
    pub titulo: String,
    pub subtitulo: Option<String>,
    pub link: String,
    pub tapa: Option<PathBuf>,   // absoluto, ya resuelto contra el book dir
    pub numero_en_serie: Option<u32>,
}

pub struct Catalogo {
    pub misma_saga: Vec<LibroPublicado>,
    pub otros: Vec<LibroPublicado>,
    pub saga_actual: Option<String>,   // nombre para el encabezado del bloque
}

pub fn escanear(root: &Path, libro_actual: &Path) -> Catalogo
```

Recorre `<root>/*/saga.json` para ubicar las sagas y `<root>/*/*/book.json`
para los libros. Descarta:

- los libros sin `link`,
- el libro que se está exportando,
- las carpetas sin `book.json` — `fonts`, `themes`, `Notas`, `extras`,
  `notas` se caen solas por este filtro, sin lista negra hardcodeada.

Ordena por `numero_en_serie` y, cuando falta, por nombre de carpeta (que ya
viene numerado en disco). Las sagas se ordenan entre sí por nombre de carpeta.

El root sale de `find_saga_and_root`, que ya existe en `epub.rs`.

## Páginas generadas

### Orden nuevo del final

```
último capítulo / epílogo
  → Otros libros        (nuevo)
  → Sobre el autor
  → contratapa
```

La lista va antes que la bio: el lector acaba de terminar la historia, es el
momento en que le interesa el próximo libro.

Todas las páginas editoriales entran al índice, agrupadas aparte de los
capítulos. Ver la sección "Índice" más abajo.

### `otros_libros.xhtml`

```html
<body class="otros-libros-body">
  <div class="otros-libros">
    <h1>Otros libros</h1>

    <h2>Más de Meridian</h2>
    <ul class="libro-list">
      <li class="libro">
        <a href="https://..."><img class="libro-tapa" src="cat-1.jpg" alt=""/></a>
        <p class="libro-titulo"><a href="https://...">La Caballera Esmeralda</a></p>
        <p class="libro-subtitulo">Meridian #1</p>
      </li>
      ...
    </ul>

    <h2>Otros libros del autor</h2>
    <ul class="libro-list">...</ul>
  </div>
</body>
```

- La tapa y el título linkean los dos al mismo `link`.
- El bloque que quede vacío se omite. Si quedan los dos vacíos, la página no se
  genera y no se suma nada al spine ni al OPF.
- Disposición con `float: left` sobre `.libro-tapa` más un `clear: both` por
  `<li>`. Nada de flexbox ni grid: los lectores viejos los ignoran y el
  resultado queda peor que el apilado.

### Encabezados bilingües

| Clave | es | en |
|---|---|---|
| Título de página | Otros libros | Also by the Author |
| Bloque de saga | Más de \<saga\> | More from \<saga\> |
| Bloque de otras sagas | Otros libros del autor | Other Books by the Author |

El idioma sale del `idioma` del libro que se exporta, como todas las páginas
editoriales.

### Tipografía

`body.otros-libros-body` se suma a la regla de fuentes editoriales de
`epub.rs:155`, y `.otros-libros h1` a la de `epub.rs:170`. Así hereda lo mismo
que la portadilla, el copyright, la dedicatoria y el TOC.

**No se agrega ninguna tipografía ni ningún control nuevo al theme editor.** La
página usa la fuente editorial del tema y punto. Lo único que queda para el que
alguna vez la quiera distinta son las clases propias (`otros-libros`,
`libro-titulo`, `libro-subtitulo`, `toc-editorial`), que un tema futuro podría
apuntar sin tocar el builder.

## Índice

Hoy el índice son solo los capítulos: las páginas editoriales no están ni en
`toc.xhtml` ni en `toc.ncx`. Pasan a estar todas, pero **agrupadas**, para que
el listado de capítulos siga siendo lo que domina la pantalla.

El `<ol class="toc">` queda en tres tramos, en orden de lectura:

```
Copyright                 <- li.toc-editorial
Dedicatoria               <- li.toc-editorial (si existe)
1. La partida             <- capítulos, como hoy
2. ...
Otros libros              <- li.toc-editorial, con separador arriba
Sobre el autor            <- li.toc-editorial
```

Las entradas editoriales llevan `class="toc-editorial"`, siguiendo el patrón
que el nav ya usa con `li.toc-part`. El CSS les da cuerpo más chico y color
atenuado, y el primer `li.toc-editorial` del tramo final lleva un `border-top`
fino que separa visualmente el catálogo de los capítulos. Los capítulos no
cambian en nada.

`toc.ncx` (el legacy) recibe las mismas entradas en el mismo orden, sin
distinción de estilo — el formato no la soporta y los lectores que lo usan
tampoco.

La portadilla y la contratapa **no** entran: son imágenes de página completa,
no destinos de navegación.

## Miniaturas de tapa

Las tapas del repo pesan entre 0,5 y 7 MB (121 MB en total): son PNG de
resolución de imprenta. Embeberlas como están — que es lo que hace hoy
`embed_image` con la tapa del propio libro — pondría ~25 MB en un EPUB con
cinco libros listados, y KDP cobra delivery por MB.

Se suma el crate `image` con `default-features = false` y solo `png` + `jpeg`,
para decodificar y reescalar. Antes de sumarlo se verifica que la versión
elegida tenga más de 7 días publicada y se revisa el crate, según la norma de
supply chain.

- Miniaturas del catálogo: ancho 400 px, JPEG calidad 82 (~30 KB cada una).
- **La tapa del propio libro pasa por el mismo camino**, con techo de 1600 px
  de ancho. Eso arregla un problema que el EPUB ya tiene hoy, no es un
  agregado: los EPUB exportados vienen cargando la tapa de imprenta entera.

Si no se quisiera la dependencia, la única alternativa es la lista sin
imágenes: no hay forma de reescalar sin decoder.

## Interfaz

### `book-config-modal`

- Campo `link` en los datos del libro, con hint `https://tatoh.ar/libros/...`
  y la aclaración de que cargarlo publica el libro en el catálogo del resto de
  los EPUB.
- Sección "Legal": un check por inciso (reserva de derechos, obra de ficción,
  nota de IA) y, al lado de cada uno, un "Editar redacción" que despliega un
  textarea con el default precargado. Si el texto queda igual al default no se
  guarda nada en `textos_legales`.

### Modal "Autor" (nuevo)

Nombre, bio ES, bio EN, foto y web. Se abre desde el header de la vista raíz
del landing, que es la única pantalla que representa al repo entero y por lo
tanto al autor. Sigue el patrón de `saga-config-modal`.

### Tapa faltante

Si un libro del catálogo tiene `link` pero su imagen no está en disco, se lista
sin miniatura y el resultado del export informa el path que faltó. Es la
convención del proyecto: si la app detectó el problema, tiene que decir cuál es
y dónde. Se cruza con el ítem del TODO "tapa que no existe: avisar en vez de
placeholder mudo".

## Verificación

### Automatizado (`cargo test`)

`catalogo.rs`, con tempdir armando sagas falsas:

- filtra los libros sin `link`,
- excluye el libro que se está exportando,
- ordena por `numero_en_serie`, y por nombre de carpeta cuando falta,
- ignora las carpetas sin `book.json`,
- separa correctamente misma saga de otras sagas.

`epub.rs`:

- la página aparece cuando hay publicados y no aparece cuando no hay,
- los dos bloques, y la omisión del que queda vacío,
- el orden en el spine: otros libros antes que sobre el autor,
- los incisos legales on/off y el override de texto,
- **back-compat**: un `BookConfig` con solo `derechos_reservados: true`
  produce la misma página legal que la implementación actual,
- la bio de `autor.json` se usa cuando el libro no tiene la suya, y el libro
  pisa al global cuando la tiene,
- el índice incluye copyright, dedicatoria, otros libros y sobre el autor, en
  ese orden relativo a los capítulos y con `class="toc-editorial"`, y las
  mismas entradas aparecen en `toc.ncx`,
- una página editorial que no se genera (sin dedicatoria, sin publicados)
  tampoco deja entrada en el índice.

`image`: reescalar una PNG grande da 400 px de ancho y menos de 100 KB.

### Manual (lo hace el autor)

No hay runner de tests para el frontend, así que los dos modales se validan con
`pnpm build` más verificación a mano. El ítem del TODO no se marca hasta que el
autor lo pruebe:

1. Cargar el link de *La Caballera Esmeralda* (`https://www.amazon.com/dp/B0G3JTSR43`
   por ahora, `tatoh.ar/libros/...` cuando exista la vista).
2. Llenar `autor.json` desde el modal nuevo.
3. Exportar *Ojos en el Abismo* y *Más que un trabajo*.
4. Abrir los dos en Thorium: que el link funcione, que la tapa se vea, que
   *Más que un trabajo* muestre el bloque de saga y *Ojos en el Abismo* muestre
   los dos bloques.
5. Confirmar que el EPUB pesa menos que el de la revisión anterior (por el
   reescalado de la tapa propia).

## Fuera de alcance

- **El sitio web**. `tatoh.ar/libros` lo mantiene el autor por afuera; acá solo
  se guarda la URL.
- **Libros publicados que no estén en el repo**. Si algún día hacen falta, se
  suma una lista `extras` en `autor.json` que se concatena al escaneo.
- **Varios links por libro** (uno por tienda). El link único apunta a la página
  del autor, que es justamente donde viven las tiendas.
- **Sinopsis por libro** en la lista. Sería un campo más para mantener.
- **"Próximamente"** para libros sin publicar. Solo entra lo que tiene link.
- **Miniaturas en la grilla del landing**. `CoverCache` sigue como está; el
  reescalado es del lado del export.
