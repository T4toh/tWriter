# LanguageTool descargado por la app, sin containers

**Fecha**: 2026-10-28
**Estado**: diseño, sin implementar
**Reemplaza**: el spec `2026-08-20-lt-sidecar-design.md` de la rama
`archivo/lt-sidecar-NO-MERGEAR`. De ahí se toma el ciclo de vida del proceso;
lo que muere es el armado en CI y el release propio del bundle.

## Por qué

Hoy la gramática local exige un runtime de containers (Docker, Podman o Apple
`container`) y una imagen de ~300 MB. El autor prefiere lo embebido o de fondo
por sobre "instalate un runtime", y el sidecar de agosto se descartó por el
costo de compilar LT en CI por target. Ese costo ya no existe: LT 6.8 está
compilado en Maven Central, y un JRE listo sale de Adoptium/Temurin. La app baja
los dos, los verifica y corre LT como proceso propio.

## Spike del 2026-10-28 (lo que está medido)

Hecho en la Mac arm64 del autor y en un container Linux x86_64 (Apple
`container` + Rosetta). Material en el scratchpad de esa sesión, no se commitea.

- **Cierre de dependencias**: `languagetool-server` + `language-es` +
  `language-en` 6.8, **excluyendo `org.languagetool:language-all`** (que
  `languagetool-server` arrastra y trae los 30 idiomas, 251 MB), **más
  `language-ca` y `language-pt`** (ver trampa abajo). Resultado: **130 jars,
  96 MB**. Ningún jar es nativo de una plataforma (sin classifiers; `jna` trae
  los nativos de todas adentro): la misma lista sirve para los cuatro targets.
- **JRE**: Temurin 21 JRE, ~40–50 MB comprimido por target (151 MB
  desempaquetado en Mac). Probado 21.0.12.1+1.
- **Arranque**: `java -Xmx256m -cp "<dir>/libs/*" org.languagetool.server.HTTPServer --port <n>`.
  Listo en **0,36 s** (Mac), ~0,4 s (Linux x64). Primer check: 0,8 s es-AR,
  1,1 s en-US. RSS ~400 MB.
- **Equivalencia**: sobre ~3.500 palabras de `tWriter-repo-prueba/1 - Meridiano`
  dio **las mismas 151 marcas, mismos offsets y reglas** que el container del
  autor (LT 6.8 en `:8081`), en Mac y en Linux x64. en-US marca igual
  (`HE_VERB_AGR`, `MORFOLOGIK_RULE_EN_US`, `EN_A_VS_AN`, `THEIR_IS`).
- **macOS**: el JRE viene firmado por Adoptium (`TeamIdentifier=JCDTMS22B4`) y,
  bajado fuera de un browser, no recibe `com.apple.quarantine` (solo
  `com.apple.provenance`). No hay nada que firmar de nuestro lado.
- **Maven Central publica `.sha1`, `.sha256`, `.sha512` y `.asc`** por jar.

**Trampa nueva (reemplaza las tres del recorte viejo, que con este método no
aplican porque no se poda nada):** `CommonWordsDetector` tiene hardcodeados
`es`, `ca` y `pt` en su inicializador estático. Sin `language-ca` y
`language-pt` en el classpath el server no arranca:
`IllegalArgumentException: 'ca' is not a language code known to LanguageTool`.
Cuestan 17 MB. Si una versión futura hardcodea otro idioma, el smoke de CI
(sección 6) lo agarra antes de mergear.

## Decisiones del autor

- **Docker sale, pero en un PR aparte**, después de probar el embebido. En este
  PR conviven.
- **Las cuatro plataformas** de `release.yml`: `aarch64-apple-darwin`,
  `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu` (AppImage, .deb, AUR) y
  Windows x64. Mac Intel y Windows los prueba el autor en máquinas propias; **no
  hay job de CI por plataforma**.
- **LT al día del lado del repo**: un workflow detecta versiones nuevas y abre un
  PR. **Llega a los usuarios con el próximo release de tWriter**, no antes: la
  app no consulta nada remoto para saber qué bajar.
- **Nada se actualiza ni se baja solo**: la descarga es por botón, y una versión
  nueva se ofrece con su botón (las reglas cambian entre versiones de LT y el
  autor tiene que saber a qué atribuir un cambio en las marcas).

## Metas, no-metas, anti-metas

**Metas**: gramática local sin runtime de containers en los cuatro targets;
mismas marcas que el container; LT y JRE fijados por hash en el binario; LT al
día vía PRs automáticos.

**No-metas (esta vuelta)**: borrar el código de Docker (PR siguiente); n-gramas
de inglés; Linux arm64 / Windows arm64; recortar `ca`/`pt` o los jars de
grpc/mybatis/lettuce; que la app descubra versiones nuevas sin release.

**Anti-metas (si pasa esto, falló aunque "ande")**:
- Bajar 142 MB sin que el autor lo pida.
- Que quede un `java` vivo después de cerrar la app.
- Una ventana negra de consola en Windows.
- Ejecutar algo cuyo sha256 no coincida con el fijado.
- Un error genérico: cada falla dice qué pasó y ofrece el remedio en el panel.

## Diseño

### 1. La lista fijada — `src-tauri/lt-lock.json`

Un JSON commiteado y compilado en el binario con `include_str!` (es el ancla de
confianza: lo que no está ahí no se ejecuta). Forma:

```json
{
  "lt": "6.8",
  "jre": "21.0.12.1+1",
  "jars": [
    { "url": "https://repo1.maven.org/maven2/org/languagetool/language-es/6.8/language-es-6.8.jar",
      "file": "language-es-6.8.jar", "sha256": "…", "size": 0 }
  ],
  "jres": {
    "aarch64-apple-darwin":     { "url": "…", "sha256": "…", "size": 0, "java": "<raíz>/Contents/Home/bin/java" },
    "x86_64-apple-darwin":      { "…": "…" },
    "x86_64-unknown-linux-gnu": { "…": "…", "java": "<raíz>/bin/java" },
    "x86_64-pc-windows-msvc":   { "…": "…", "java": "<raíz>\\bin\\java.exe" }
  }
}
```

La entrada del JRE se elige por el target de **compilación** (`cfg!`), no por la
máquina del runner: las dos builds de Mac salen del runner ARM. La forma exacta
del campo `java` (ruta relativa a la raíz del archivo, que en Temurin es una
carpeta `jdk-…-jre/`) la decide quien implemente.

### 2. El generador — `scripts/armar-lt-lock.mjs` + `scripts/lt/pom.xml`

El `pom.xml` es el del spike: las cinco dependencias (`languagetool-server` con
la exclusión de `language-all`, `language-es`, `language-en`, `language-ca`,
`language-pt`), todas a la misma versión de LT. El script:

1. corre `mvn dependency:list` sobre ese pom (scope runtime) para el cierre;
2. arma la URL de Maven Central de cada jar, lo baja y **calcula el sha256
   nosotros**, cruzándolo con el `.sha256` publicado (si difieren, aborta);
3. pide a la API de Adoptium el JRE 21 por target y toma URL, sha256 y tamaño;
4. escribe `lt-lock.json`.

Corre a mano o desde el workflow; nunca en build time. Necesita Maven y un JDK
(los trae `ubuntu-24.04` de Actions; en la Mac del autor ya están por Homebrew).

**Regla de supply chain**: el script **no elige ninguna versión de LT ni de JRE
publicada hace menos de 7 días** (regla de la organización). Si la última es
más nueva, toma la anterior. LT se fecha por `lastUpdated` del
`maven-metadata.xml`; el JRE por `updated_at` de Adoptium. El 2026-10-28 eso
excluye 21.0.13+9 (del 22-oct) y deja 21.0.12.1+1.

### 3. Mantenerlo al día — `.github/workflows/lt-al-dia.yml`

Semanal + `workflow_dispatch`. Corre el generador apuntando a la última versión
de LT elegible. Si `lt-lock.json` cambió:

1. **Smoke**: baja los jars y el JRE de Linux x64 según el lock nuevo, levanta el
   server y le manda un check en es-AR y otro en en-US con frases que tienen que
   marcar (las del spike sirven: «Ella fué a la casa y vió…» →
   `MONOSILABOS`; «She go to the store…» → `HE_VERB_AGR`). Falla si no arranca
   o si no marca.
2. Abre un PR con el lock nuevo y una línea en `CHANGELOG.md` → `[Unreleased]`:
   `### Changed` («LanguageTool updated to X») si cambió LT, `### Security`
   («Java runtime for LanguageTool updated to X») si cambió solo el JRE
   (Temurin saca sus parches en los CPU trimestrales de Oracle). Si el smoke
   falló, el PR se abre igual, con el log en la descripción y un commit status
   en rojo que postea el propio workflow: los PRs abiertos con `GITHUB_TOKEN` no
   disparan otros workflows, y el repo no tiene CI de PRs.

**Permisos (decisión del autor)**: se prende "Allow GitHub Actions to create
and approve pull requests" en el repo (hoy apagado, con
`default_workflow_permissions: read`), y el workflow pide en su propio
`permissions:` solo `contents: write`, `pull-requests: write` y
`statuses: write`. Nada de token personal: el autor descarta cualquier cosa
que venza y haya que acordarse de renovar. El cambio de setting es
`gh api -X PUT repos/T4toh/tWriter/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=read`
y se hace al implementar, no antes.

**Nunca mergea ni publica solo** (regla de la organización). El repo no usa
Dependabot hoy y no hace falta sumarlo: un PR del bot no puede regenerar el lock
sin un token aparte.

### 4. Descarga e instalación (Rust)

- Destino: **LT y JRE en directorios separados**, `app_data_dir()/languagetool/lt-<versión>/`
  (los jars) y `app_data_dir()/languagetool/jre-<versión>/`, cada uno con un
  marcador `.ok` que se escribe **al final**. Directorio con `.ok` = instalado.
  Sin `.ok` = basura de un intento anterior, se borra. Separados para que un
  parche del JRE baje ~50 MB y no los 142. *(Decisión mía.)*
- **El hash se verifica una vez, al bajar.** Lo instalado sigue corriendo
  aunque un release nuevo de tWriter traiga otro lock: la versión instalada la
  dice el nombre del directorio, y el lock del binario solo decide qué se
  ofrece bajar. No se re-verifica al arrancar (el sha256 del JRE es del
  `.tar.gz`, que ya no existe después de extraer). Así un update de tWriter
  nunca deja sin gramática. *(Decisión mía.)*
- Cada archivo baja a un temporal, se verifica su sha256 **antes** de
  desempaquetar o mover nada, y si no coincide se borra todo el directorio de
  esa versión y se aborta con mensaje accionable (reintentar).
- JRE: `tar.gz` en Mac/Linux, `zip` en Windows. `zip` ya está en `Cargo.toml`;
  se suman `tar` y `flate2`. `sha2` y `flate2` ya están en `Cargo.lock` como
  transitivas: fijar las mismas versiones. Todo crate nuevo pasa el chequeo de
  >7 días y de que sea el crate real. `reqwest` necesita la feature `stream`
  para el progreso por bytes.
- Después de extraer, `chmod 0o755` explícito sobre `java` en Unix.
- Progreso por `emit_progress` / evento `languagetool-progress`, el mismo que usa
  hoy el pull de Docker y que el modal ya escucha. Fases: `downloading` (MB
  hechos / totales), `verifying`, `extracting`, `starting`, `ready`.
- Cuando una versión nueva queda instalada y arranca bien, se borra la vieja.
  Si la nueva no arranca, se borra la nueva y sigue la vieja.

### 5. Ciclo de vida del proceso

- **Puerto**: el primero libre **desde 8082** con `TcpListener::bind`. 8081
  queda para el container mientras convivan: el autor usa Apple `container`,
  que no se relanza solo (`apple_run_args_omit_restart`), así que si el
  embebido tomara 8081 al abrir la app, el container no podría arrancar
  después; y `ping_local_lt` / `languagetool_docker_status` tienen 8081
  hardcodeado y describirían al embebido como si fuera el container. Cuando
  Docker salga, se puede volver a 8081. *(Decisión mía.)*
- **Arranque**: `<java> -Xmx256m -cp "<libs>/*" org.languagetool.server.HTTPServer --port <n>`.
  Escucha solo en localhost (default de LT, sin `--public`).
- **Windows**: `CREATE_NO_WINDOW` vía `std::os::windows::process::CommandExt`
  (hoy no hay ningún `creation_flags` en `src-tauri`). Sin eso aparece una
  consola por cada arranque.
- **Listo**: poll a `/v2/languages` con timeout generoso (30 s; en frío medido
  0,4 s, pero la primera vez el SO puede tardar en escanear el JRE).
- **Cuándo arranca**: al abrir la app, si el modo es Local y está instalado, en
  segundo plano. También al terminar una instalación.
- **Al cerrar**: matar el `Child` (guardado en el state de Tauri). Hoy `lib.rs`
  no maneja `RunEvent::Exit`; hay que sumarlo.
- **Huérfano de un crash**: al arrancar se guarda el pid en el directorio de
  instalación; al próximo arranque, si ese pid sigue vivo y es nuestro `java`,
  se mata antes de lanzar otro. Cómo confirmar que el pid es nuestro (y no uno
  reciclado) lo decide quien implemente; no vale `pgrep`, que no existe en
  Windows.
- **Caída**: si el proceso murió, se relanza en el próximo check, una vez. Sin
  loop de reintentos.

### 6. A qué LT le pega la app

`resolve_base` (`grammar.rs`) hoy devuelve `LOCAL_BASE` fijo para `"local"`.
Pasa a: **si el embebido está instalado y arriba, su puerto; si no,
`LOCAL_BASE`** (el container, como hoy). `"custom"` y `"public"` no cambian, y
`"custom"` sigue ganando sobre todo. `settings.json` no cambia, así que no hay
migración, y el PR que borre Docker solo saca la segunda rama. *(Decisión de
diseño mía, no del autor.)*

### 7. UI — Configuración → Gramática

El radio «Local (Docker)» (`settings-modal.html`) pasa a «Local». Adentro:

- **No instalado**: qué es, cuánto baja (~142 MB) y el botón «Bajar
  LanguageTool». Debajo, el bloque de Docker de hoy, como alternativa.
- **Bajando**: barra de progreso en MB y la fase.
- **Instalado**: versión de LT y del JRE, estado (arriba / caído con botón
  «Reiniciar»), y «Borrar» para liberar el espacio.
- **Versión nueva disponible** (el lock del binario difiere de lo instalado):
  aviso con botón, nunca se aplica solo. Si cambió LT: «Actualizar
  LanguageTool a X». Si cambió solo el JRE: «Actualizar Java (parche de
  seguridad)», que baja solo el JRE. *(Decisión mía: un parche de Java no
  cambia las marcas, pero igual va por botón porque baja ~50 MB.)*
- **Errores**: cada uno con su remedio ahí mismo (reintentar la descarga, sin
  red, hash que no coincide, java que no arranca con la última línea del log).

El diseño visual sigue `.btn` global y lo que ya hay en el modal.

### 8. Licencias

LT es LGPL 2.1 y el JRE es GPLv2 con Classpath Exception. Técnicamente la app no
los distribuye (los baja la máquina del usuario de Maven Central y Adoptium),
pero el aviso va igual a `LICENCIAS.md` y a `licencias.json` vía
`scripts/generar-licencias.mjs`, como el tesauro.

### 9. Documentación que se toca

- `CLAUDE.md` → «Sidecars y servicios externos»: LT deja de ser solo Docker.
- `docs/decisiones-cerradas.md` → «LT embebido como sidecar»: sumar el método
  de Maven (exclusión de `language-all`, trampa de `ca`/`pt`) y que las tres
  trampas viejas no aplican.
- `TODO.md`: sacar «Bajar LanguageTool desde la app» cuando el autor lo pruebe;
  sumar «Borrar Docker de `grammar.rs`» como siguiente.
- `CHANGELOG.md` → `### Added`.

## Verificación

**Tests Rust** (partes puras): puerto libre saltea uno ocupado; sha256 que no
coincide no deja nada en disco; directorio sin `.ok` se trata como no instalado;
`resolve_base` en `"local"` con y sin embebido; parseo de `lt-lock.json` y
elección de la entrada del JRE por target.

**Smoke de CI** (sección 3) cubre "arranca y marca" en Linux x64 cada vez que
cambia el lock.

**Manual del autor** (sin esto el item del TODO no se marca hecho):
1. Mac arm64, `pnpm tauri dev`, sin instalar: bajar, ver el progreso, queda
   listo; un capítulo es y uno en marcan lo mismo que con el container.
2. Cerrar la app → no queda ningún `java` vivo.
3. Con el container de Docker en 8081 → el embebido toma otro puerto y gana.
4. Cortar la red a mitad de la descarga → mensaje claro, reintento, nada roto.
5. Matar el `java` a mano → el próximo check lo relanza.
6. Arch (Linux x64), Mac Intel y Windows: 1 y 2. En Windows, sin ventana de
   consola.

## Lo que queda a quien implemente

Nombres de comandos y de módulos Rust (probable `lt_embebido.rs` al lado de
`grammar.rs`), la forma exacta del lock, descarga en serie o en paralelo,
cómo identificar el pid propio, y el layout del panel dentro del modal.
