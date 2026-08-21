# LanguageTool como sidecar descargado

**Fecha**: 2026-08-20
**Estado**: diseño aprobado, sin implementar
**Reemplaza**: nada todavía — el código de Docker queda intacto en esta vuelta

## Problema

Hoy la gramática depende de que el autor tenga un runtime de containers instalado
y baje una imagen de ~300 MB. Ya se invirtió bastante en suavizar eso
(`2026-07-30-languagetool-setup-seamless-design.md`, `lt-runtime-recordado`),
pero el requisito de fondo sigue: sin Docker/Podman/Apple containers no hay
corrector.

El relevamiento del 2026-08-20 (ver `TODO.md`, sección *Gramática, ortografía y
tesauro*) cerró la pregunta de si conviene cambiar de motor: **no existe motor
alternativo para español**. Harper es solo inglés, nlprule está muerto desde
2021 y sin corrector ortográfico, y portar el XML de LT a Rust es el pozo que
mató a nlprule. La salida no es cambiar de motor, es **embeberlo**.

## Decisión: descarga on-demand, no bundleado

Se evaluaron tres caminos:

| | Instalador | Red | Notarización macOS |
|---|---|---|---|
| **A1** `resources` bundleado | +174 MB por target | cero | **riesgo no medido** |
| **A2** descarga a `app_data_dir` | igual que hoy | 128 MB una vez | **la esquiva** |
| A3 híbrido | mixto | mixto | igual que A1 |

**Se eligió A2.** Razones, en orden de peso:

1. **Esquiva la notarización de macOS.** Meter un JRE y ~130 jars dentro de un
   `.app` firmado necesita entitlements y firmar cada binario de Java. No se
   pudo medir desde Linux y es el riesgo más grande de A1. Con A2 el JRE vive
   en `app_data_dir`, fuera del bundle, y no hay nada que firmar.
2. **Reusa lo que ya existe.** `reqwest` ya está en `Cargo.toml`
   (rustls-tls), y la tubería de progreso — `emit_progress` +
   el evento `languagetool-progress` + el modal que lo escucha — ya está
   construida y verificada para el pull de Docker, que hoy dice *"Bajando
   imagen erikvl87/languagetool (~300MB, puede tardar 1–3 min)"*. Cambia qué se
   baja, no el flujo.
3. **No hay precedente de `externalBin` en el repo.** `tauri.conf.json` no lo
   declara y `src-tauri/binaries/` está vacío: pandoc se resuelve buscando el
   binario del sistema (`import.rs:16`). El CLAUDE.md afirma lo contrario y
   **está desactualizado** — hay que corregirlo. El único precedente de
   bundling es `resources` (el tesauro, 14 MB).
4. El repo no engorda y CI no arrastra 174 MB × 4 targets.

Costo asumido: una descarga de **128 MB** la primera vez que se usa gramática.
Sigue siendo menos que los ~300 MB de imagen de hoy, y sin pedir Docker.

Cumple el criterio del autor ("embebido o de fondo, nunca 'instalate un
runtime'"): el usuario no instala ni levanta nada, la app se encarga con barra
de progreso.

## Alcance

**Entra en esta vuelta**: armado reproducible del bundle, descarga verificada,
instalación en `app_data_dir`, ciclo de vida del proceso, resolución de a qué LT
le pega la app, y el aviso de versión nueva. **Solo `x86_64-unknown-linux-gnu`.**

**No entra**: borrar el código de Docker (segundo PR, cuando el sidecar esté
verificado a mano), macOS y Windows (tercero), ni nada más del relevamiento de
LT (reglas propias en TS, `disabledRules`, wizard).

## Números medidos

Todo contra LT 6.6 recortado a es+en, con el JRE de `jlink`, en Linux x64.

| | |
|---|---|
| LT 6.6 completo desempaquetado | 391 MB |
| LT recortado a es+en | 117 MB |
| JRE `jlink` (19 módulos) | 57 MB |
| **Bundle sin comprimir** | **174 MB** |
| **Bundle `tar.gz`** | **128 MB** |
| Arranque en frío → server listo | 1,07 s |
| Primer check es-AR (carga reglas) | 1,2 s |
| Checks siguientes (texto corto) | 27 ms |
| Check de un chunk de 20 KB | 2,45 s |
| RSS con heap default | 661 MB |
| **RSS con `-Xmx256m`** | **538 MB, cero OOM** |

`tar.zst` da 127 MB — 1 MB menos que gzip, porque los jars ya vienen
comprimidos. No vale sumar la dependencia: **gzip**.

`-Xmx256m` se probó contra el peor caso real: un chunk de 20 KB, que es donde
`split_chunks` (`grammar.rs:830`) corta. Mismo resultado (154 matches) y misma
latencia que con 512m, sin OOM. Se elige **256m**.

> **Caveat de versión**: estas mediciones son contra **LT 6.6**, que es lo que
> sirve `LanguageTool-stable.zip` hoy (release de 2025-03-28). El `TODO.md` dice
> que el container del autor corre **6.8** (tag de 2026-05-05). Los conteos de
> reglas y de matches pueden diferir algo entre las dos. No se asume que sean
> equivalentes.

## Diseño

### 1. Armado del bundle — `scripts/armar-lt-sidecar.mjs`

Encodea el procedimiento ya verificado a mano. Corre en CI, **no en build
time**, y su salida **no se commitea** — mismo criterio que
`scripts/podar-tesauro-en.mjs`.

1. Baja `LanguageTool-stable.zip` (241 MB) y registra qué versión trae adentro.
2. Borra los **datos** de los idiomas que no son `en`/`es`, **conservando los
   `.class`**.
3. Restaura `common_words.txt` de todos los idiomas (2,6 MB).
4. Borra los `*-pos-dict.jar` ajenos y `lucene-gosen-ipadic`, `hanlp`,
   `languagetool-ga-dicts`, `morfologik-ukrainian-lt`, `morfologik-crh-lt`.
5. `jlink` con los 19 módulos → JRE.
6. `tar czf` + `sha256sum`.

**Tres trampas verificadas, con su causa** (si alguien las "optimiza", vuelve a
romper):

| Qué no hacer | Qué pasa |
|---|---|
| Borrar los `.class` de otros idiomas | `Languages.getAllLanguages()` los instancia **todos** al arrancar → `NoClassDefFoundError: ArabicHunspellSpellerRule`. Trimear `META-INF/org/languagetool/language-module.properties` **no alcanza**. El reparto es 2,6 MB de clases contra 219 MB de datos, así que conservarlas no cuesta nada. |
| Borrar `common_words.txt` de otros idiomas | `LanguageIdentifier` los lee eager al construirse → `IOException: Common words file not found for Arabic`. |
| Borrar `grpc-netty-shaded` / `mybatis` / `lettuce` | El arranque los toca aunque no se use nada premium → `NoClassDefFoundError: org/apache/ibatis/...`. Quedan ~21 MB de recorte posible ahí; no vale el riesgo. |

`jlink` **no cross-compila**: cada target se arma en su propio runner. Para
`x86_64-apple-darwin` (que hoy se cross-compila desde el runner ARM `macos-14`)
habrá que bajarle los `jmods` del JDK x64 y pasárselos a `jlink`. Problema de la
tercera vuelta.

Los 19 módulos:

```
java.base, java.desktop, java.logging, java.management, java.naming,
java.net.http, java.prefs, java.rmi, java.scripting, java.security.jgss,
java.sql, java.transaction.xa, java.xml, java.xml.crypto, jdk.crypto.ec,
jdk.unsupported, jdk.httpserver, java.instrument, jdk.zipfs
```

### 2. Distribución e integridad

Assets en un release tag propio, **`lt-sidecar-v<n>`**, separado de los releases
de la app: el bundle cambia cuando cambia LT (dos veces al año), no cuando
cambia tWriter.

Nombre del asset: `lt-sidecar-<lt_version>-<rust_target>.tar.gz`.

**Las URLs versionadas del zip de LT dan 404** — solo existe
`LanguageTool-stable.zip`, así que la *entrada* no se puede pinnear por URL. No
hace falta: lo que se pinnea es el **sha256 de la salida**, que es lo que se
distribuye y se ejecuta. La versión de entrada queda registrada en el
manifiesto como dato informativo.

**Dos niveles de confianza:**

- **Piso pinneado en el binario**: una versión y su sha256 como consts en Rust.
  Es el ancla. Si todo lo demás falla, esa se baja y valida siempre.
- **`manifest.json`** en el release `lt-sidecar`, con las versiones disponibles
  y su sha256 por target. La app lo consulta para ofrecer versiones nuevas. Si
  no responde o el hash no coincide, se queda con el piso.

El manifiesto es un ancla de confianza más débil que un hash compilado — por eso
el piso nunca se saca.

**La verificación de sha256 es obligatoria y va antes de desempaquetar.** Es
código que se va a ejecutar: si el hash no coincide, no se toca nada, se borra
la descarga y se aborta con mensaje accionable. Hay precedente en el repo
(`6b0ac95 fix: update sha256sums for package integrity`).

### 3. Instalación

Destino: `app_data_dir()/lt-sidecar/<lt_version>/`, con un marcador `.ok`
escrito al final del desempaquetado. Si el directorio existe y tiene `.ok`, se
usa; si no, se baja.

Versionar por directorio hace que actualizar sea bajar al lado y borrar el
viejo, y que **el rollback sea gratis**: si un bundle nuevo no pasa el health
check, se borra y sigue andando el anterior.

Progreso por `emit_progress` sobre el evento `languagetool-progress` que ya
existe. Fases nuevas reusando el mismo contrato: `downloading` (con % y MB),
`verifying`, `extracting`, `starting`, `ready`.

### 4. Ciclo de vida del proceso

- **Puerto**: probar desde 8081 hacia arriba con `TcpListener::bind` hasta
  encontrar uno libre, y guardarlo en el state. Hoy 8081 está hardcodeado, y el
  autor **ya tiene un LT propio corriendo en `:8010`** — no hay que pisar nada
  de lo que tenga levantado.
- **Arranque**: `<jre>/bin/java -Xmx256m -cp "languagetool-server.jar:libs/*:."
  org.languagetool.server.HTTPServer --port <n> --allow-origin`.
- **Listo**: poll a `/v2/languages` hasta que responda (1,07 s medido en frío).
- **Muerte**: matar el `Child` al cerrar la app. Guardar el handle en el state
  de Tauri.
- **Caída**: si el proceso murió, relanzar en el próximo check con backoff. No
  reintentar en loop.

### 5. Resolución: a qué LT le pega la app

Orden fijo, **sin tocar el código de Docker**:

1. **URL manual del modal**, si está seteada → gana siempre. Cubre LT Premium y
   a quien tenga una imagen con los n-gramas de inglés (los 782 pares que sí
   pagarían, según el relevamiento).
2. **Sidecar**, si está instalado y arriba.
3. **Container Docker**, si está corriendo.

Así el sidecar puede fallar y la gramática sigue andando. El segundo PR borra el
punto 3 y las ~700 líneas de detección multi-runtime, pull, start y remedies.

### 6. Frescura

**Sin job programado en la v1.** Medido: LT saca ~2 versiones por año, cada 6-7
meses (`v6.8` 2026-05-05, `v6.7` 2025-10-10, `v6.6` 2025-03-28, `v6.4`
2024-03-28, `v6.2` 2023-07-02, `v6.0` 2022-12-29). Un cron para eso es
maquinaria que hay que mantener para nada, y además publicaría artefactos sin
intervención. Se publica a mano dos veces al año. Si molesta, el cron se suma
después: es aditivo y no pide rediseño.

Lo que sí entra es el **aviso dentro de la app**: si el manifiesto trae una
versión más nueva que la instalada, el modal de gramática lo muestra con un
botón para aplicarlo. El autor no tiene que acordarse de ir a mirar.

**No se actualiza en silencio.** La API de LT es estable (`/v2/check` no cambió
de 5.x a 6.x, y `text`/`language`/`level`/`disabledRules` siguen igual), pero
las **reglas** sí cambian entre versiones: un LT nuevo puede empezar a marcar
distinto sobre el mismo texto. Que el autor sepa a qué atribuir un cambio en las
marcas vale más que la frescura automática.

Cada bundle lleva **su propio JRE**, así que el par LT+Java siempre es
consistente: si algún día LT pide un JDK más nuevo, el bundle nuevo trae el JRE
nuevo y la app no se toca.

### 7. Licencias

- **LanguageTool: LGPL 2.1.** Corre como **proceso separado**, no linkeado, así
  que distribuirlo con una app MIT está permitido. Hay que sumar el aviso.
- **JRE de `jlink`: deriva de OpenJDK, GPLv2 con Classpath Exception.**
  Distribuir un runtime derivado está permitido con su aviso.

Los dos van a `src-tauri/resources/tesauro/LICENCIAS.md` (o un `LICENCIAS.md`
propio si queda más claro) y a `licencias.json` vía
`scripts/generar-licencias.mjs`, siguiendo el patrón que ya se usó para
`th_es_v2.dat` y WordNet.

Ojo: el bundle **no se commitea**, pero se **distribuye**, así que la obligación
de aviso aplica igual.

## Verificación

**Tests Rust** (partes puras, al lado de los que ya tiene `grammar.rs`):

- resolución de puerto libre: que saltee uno ocupado y devuelva el siguiente;
- verificación de sha256: que un hash que no coincide aborte y **no** deje nada
  desempaquetado;
- estado del directorio de instalación: `.ok` presente/ausente, versión vieja al
  lado de una nueva;
- orden de resolución de la sección 5, con las tres fuentes mockeadas.

**No hay smoke runner para el script de armado**: toca red y necesita un JDK
completo, así que no encaja en el patrón de funciones puras de `scripts/`. Se
valida corriéndolo en CI.

**Verificación manual del autor** (sin esto no se marca hecho):

1. `pnpm tauri dev` con el sidecar sin instalar → el modal ofrece bajarlo, la
   barra de progreso avanza, termina y queda listo.
2. Chequear un capítulo en español y uno en inglés → mismas marcas que con el
   container.
3. Cerrar la app → verificar con `pgrep` que **no queda un java colgado**.
4. Levantar algo en 8081 a mano y abrir la app → que elija otro puerto y no
   rompa.
5. Corromper el `.tar.gz` a propósito → que aborte con mensaje claro y no deje
   basura en `app_data_dir`.
6. Con el container de Docker corriendo Y el sidecar instalado → que gane el
   sidecar; con una URL manual seteada → que gane la URL.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El bundle de 128 MB falla a mitad de descarga | Verificación de sha256 + borrar el parcial. Reintento manual desde el modal, no automático. |
| Java colgado si la app crashea sin cerrar bien | Al arrancar, buscar un proceso previo del sidecar por puerto y adoptarlo o matarlo antes de levantar otro. |
| LT 6.8 se comporta distinto de 6.6 | Las mediciones dicen 6.6; no se asume equivalencia. Al bundlear la versión que sirva `stable.zip`, comparar contra el container antes de dar por bueno. |
| macOS: Gatekeeper con binarios bajados | Los archivos escritos por la app vía reqwest no reciben el xattr `com.apple.quarantine` como los de un browser, así que en principio no aplica — **pero hay que verificarlo** en la vuelta de macOS, no asumirlo. |

## Fuera de alcance, anotado

- Borrar el código de Docker de `grammar.rs` (~700 líneas) — segundo PR.
- macOS (arm64 + x64) y Windows — tercer PR, con notarización y `jmods` cross.
- Recortar los ~21 MB de grpc/mybatis/lettuce con más cuidado.
- Job programado de CI para el bundle.
- Corregir el CLAUDE.md: dice que pandoc va bundleado como `externalBin` y no es
  cierto.
