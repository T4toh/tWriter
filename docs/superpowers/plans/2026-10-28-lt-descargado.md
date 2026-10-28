# LanguageTool descargado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La app baja LT 6.8 (jars de Maven Central) y un JRE Temurin 21, verificados por sha256 contra una lista compilada en el binario, y corre LT como proceso propio; un workflow semanal mantiene esa lista al día con PRs.

**Architecture:** Un script Node genera `src-tauri/lt-lock.json` (jars + JRE por target con sus hashes) usando Maven solo en la máquina que lo corre. El módulo Rust nuevo `lt_embebido.rs` lo lee con `include_str!`, descarga lo que falta a `app_data_dir/languagetool/`, levanta `java` en un puerto libre desde 8082 y expone el puerto a `grammar.rs::resolve_base`. El modal de Configuración suma un panel encima del bloque de Docker, que queda intacto.

**Tech Stack:** Rust (Tauri 2, reqwest 0.13, sha2, tar, flate2, zip), Angular 22 signals, Node ESM scripts, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-lt-descargado-design.md`

## Global Constraints

- Ninguna versión de LT ni de JRE publicada hace **menos de 7 días** (regla de la organización). Aplica también a crates nuevos.
- Crates: `sha2 = "0.10.9"`, `tar = "0.4.46"`, `flate2 = "1.1.9"` — las versiones que **ya están en `Cargo.lock`** como transitivas, así no entra código nuevo. No sumar la feature `stream` de reqwest: `Response::chunk()` alcanza.
- Docker **no se toca**: convive. Nada del código de Docker se borra ni se renombra.
- Puerto del embebido: primero libre **desde 8082**. 8081 queda para el container.
- Arranque: `<java> -Xmx256m -cp <libs>/* org.languagetool.server.HTTPServer --port <n>`, sin `--public`.
- La descarga es **solo por botón**. Nunca se baja ni se actualiza solo.
- Windows: `CREATE_NO_WINDOW` (`0x08000000`) en el spawn de `java.exe`.
- Errores en español, accionables, en el panel (regla «el remedio se da adentro de la app» del CLAUDE.md).
- Identificadores: sustantivos de dominio en español, mecánica en inglés (ver CLAUDE.md). Archivos `kebab-case` sin sufijo `.component`.
- Commits **sin** línea `Co-Authored-By` (regla de la organización).
- No editar `src-tauri/` con `pnpm tauri dev` corriendo (el watcher reinicia la app del autor).

## Review Focus

1. **Descarga cortada a la mitad** (red, cerrar la app): el próximo intento no ve nada a medio instalar y vuelve a bajar → directorio sin `.ok` se borra (Task 2, `instalado_borra_directorios_sin_ok`).
2. **Ruta con espacios o acentos** (`~/Library/Application Support/`, usuario `Ñandú` en Windows): `java` arranca igual → args como `OsString` separados, sin shell (Task 4, `java_args_con_espacios_quedan_en_un_solo_arg`).
3. **Puerto 8082 ocupado por otra cosa**: toma el siguiente (Task 2, `puerto_libre_saltea_ocupado`).
4. **Archivo corrupto o truncado**: no deja nada extraído y el error lo dice (Task 3, `sha_que_no_coincide_no_extrae` y `extraer_corrupto_no_deja_destino`).
5. **Crash de la app con `java` vivo**: el próximo arranque lo mata antes de lanzar otro (Task 4, `pid_file_round_trip` + verificación manual 2).

---

### Task 1: Generador de la lista y `lt-lock.json`

**Files:**
- Create: `scripts/lt/pom.xml`
- Create: `scripts/armar-lt-lock.mjs`
- Create: `scripts/run-lt-lock-smoke.mjs`
- Create: `src-tauri/lt-lock.json` (salida del script, commiteada)

**Interfaces:**
- Produces: `src-tauri/lt-lock.json` con la forma:
  ```json
  { "lt": "6.8", "jre": "21.0.12.1+1",
    "jars": [{ "url": "…", "file": "language-es-6.8.jar", "sha256": "…", "size": 123 }],
    "jres": { "<rust target triple>": { "url": "…", "sha256": "…", "size": 123, "java": "jdk-21.0.12.1+1-jre/bin/java" } } }
  ```
  Targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`.
- Produces (exports puros de `armar-lt-lock.mjs`): `elegirVersion(candidatas: {version, fecha: Date}[], hoy: Date): string | null` y `rutaJava(releaseName: string, target: string): string`.

- [ ] **Step 1: `scripts/lt/pom.xml`.** El pom del spike: `languagetool-server` con `<exclusion>` de `org.languagetool:language-all`, más `language-es`, `language-en`, `language-ca`, `language-pt`, todos con `<version>${lt.version}</version>` y `<properties><lt.version>6.8</lt.version></properties>`. Un comentario arriba explica por qué `ca`/`pt` (el `CommonWordsDetector` los hardcodea; sin ellos: `'ca' is not a language code known to LanguageTool`).

- [ ] **Step 2: Smoke que falla.** `scripts/run-lt-lock-smoke.mjs`, mismo patrón que `run-changelog-smoke.mjs` (importa el `.mjs` directo, `assert` de node):
  ```js
  const hoy = new Date('2026-10-28');
  const v = (version, f) => ({ version, fecha: new Date(f) });
  assert.equal(elegirVersion([v('21.0.13+9','2026-10-22'), v('21.0.12.1+1','2026-08-19')], hoy), '21.0.12.1+1');
  assert.equal(elegirVersion([v('6.8','2026-05-05'), v('6.7','2025-10-10')], hoy), '6.8');
  assert.equal(elegirVersion([v('6.9','2026-10-27')], hoy), null);
  assert.equal(elegirVersion([v('6.8','2026-10-21')], hoy), '6.8'); // 7 días justos: entra
  assert.equal(rutaJava('jdk-21.0.12.1+1', 'aarch64-apple-darwin'), 'jdk-21.0.12.1+1-jre/Contents/Home/bin/java');
  assert.equal(rutaJava('jdk-21.0.12.1+1', 'x86_64-unknown-linux-gnu'), 'jdk-21.0.12.1+1-jre/bin/java');
  assert.equal(rutaJava('jdk-21.0.12.1+1', 'x86_64-pc-windows-msvc'), 'jdk-21.0.12.1+1-jre/bin/java.exe');
  ```
  Run: `node scripts/run-lt-lock-smoke.mjs` → falla (no existe el módulo).

- [ ] **Step 3: `scripts/armar-lt-lock.mjs`.** Cabecera de comentario como la de `podar-tesauro-en.mjs` (qué hace, cuándo correrlo, que nunca corre en build time). `elegirVersion` devuelve la más nueva con `hoy - fecha >= 7 días`, o `null`. CLI: `node scripts/armar-lt-lock.mjs [--lt <versión>|--lt latest]`:
  1. LT: con `--lt latest` lee `https://repo1.maven.org/maven2/org/languagetool/languagetool-server/maven-metadata.xml` (`<versions>`), fecha cada candidata con el `Last-Modified` del `.pom` de esa versión, y elige con `elegirVersion`. Sin flag usa la del `pom.xml`. Reescribe `<lt.version>` en el pom.
  2. `mvn -q dependency:list -DincludeScope=runtime -DoutputFile=<tmp>` en `scripts/lt/`, parsea `group:artifact:jar:version:scope`.
  3. Por jar: arma la URL de Maven Central, lo baja, calcula sha256, lo cruza con `<url>.sha256` (si difieren, aborta con exit 1).
  4. JRE: `https://api.adoptium.net/v3/assets/feature_releases/21/ga?architecture=<a>&image_type=jre&os=<os>&vendor=eclipse&page_size=10` por target; elige con `elegirVersion` sobre `binaries[0].updated_at`; toma `package.link`, `package.checksum`, `package.size`, `release_name` (para `rutaJava`). Las cuatro entradas tienen que quedar en **la misma** versión de JRE: si la más nueva elegible no está en los cuatro targets, toma la más nueva que sí.
  5. Escribe `src-tauri/lt-lock.json` (jars ordenados por `file`, JSON con 2 espacios).

- [ ] **Step 4: Smoke pasa.** Run: `node scripts/run-lt-lock-smoke.mjs` → sin salida de error, exit 0.

- [ ] **Step 5: Generar el lock real.** Run: `node scripts/armar-lt-lock.mjs`. Esperado: `lt-lock.json` con `"lt": "6.8"`, **130 jars**, `"jre": "21.0.12.1+1"` (21.0.13+9 tiene menos de 7 días al 2026-10-28; si se corre más tarde puede salir 21.0.13+9 y está bien).

- [ ] **Step 6: Sumar el smoke a la lista de comandos de `CLAUDE.md`** (`node scripts/run-lt-lock-smoke.mjs  # elección de versión >7 días y ruta del java por target`).

- [ ] **Step 7: Commit.** `feat(lt): lista fijada de jars y JRE para LanguageTool embebido`

---

### Task 2: `lt_embebido.rs` — lock, estado de instalación, puerto

**Files:**
- Create: `src-tauri/src/lt_embebido.rs`
- Modify: `src-tauri/src/lib.rs` (`mod lt_embebido;`)

**Interfaces:**
- Consumes: `src-tauri/lt-lock.json` (Task 1).
- Produces:
  ```rust
  #[derive(Deserialize)] pub struct Archivo { pub url: String, pub file: String, pub sha256: String, pub size: u64 }
  #[derive(Deserialize)] pub struct Jre { pub url: String, pub sha256: String, pub size: u64, pub java: String }
  #[derive(Deserialize)] pub struct Lock { pub lt: String, pub jre: String, pub jars: Vec<Archivo>, pub jres: HashMap<String, Jre> }
  pub fn lock() -> &'static Lock                       // include_str!("../lt-lock.json") + OnceLock
  pub fn target_actual() -> &'static str               // por cfg!(target_os/arch), el triple del lock
  pub fn jre_del_target(lock: &Lock) -> Option<&Jre>
  pub fn instalado(base: &Path, prefijo: &str) -> Option<String>  // prefijo "lt" o "jre"
  pub fn puerto_libre(desde: u16) -> Option<u16>
  ```
  Layout en disco: `<base>/lt-<versión>/libs/*.jar` y `<base>/jre-<versión>/<lo que trae el archivo>`, cada uno con `.ok`. `<base>` = `app_data_dir()/languagetool`.

- [ ] **Step 1: Tests que fallan** (en `#[cfg(test)] mod tests` del módulo, con `std::env::temp_dir()` + un nombre único por test, como hace el resto de `src-tauri`):
  - `lock_compilado_parsea_y_tiene_el_target_actual`: `lock().lt` no vacío, `lock().jars.len() > 100`, `jre_del_target(lock()).is_some()`.
  - `instalado_devuelve_la_version_con_ok`: crea `lt-6.8/.ok` → `instalado(base, "lt") == Some("6.8")`.
  - `instalado_borra_directorios_sin_ok`: crea `lt-6.9/` sin `.ok` y `lt-6.8/.ok` → devuelve `Some("6.8")` y `lt-6.9` ya no existe.
  - `instalado_sin_nada_es_none`: base inexistente → `None`.
  - `puerto_libre_saltea_ocupado`: bindea un `TcpListener` en `127.0.0.1:0`, toma su puerto `p`, `puerto_libre(p) != Some(p)`.

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml lt_embebido` → FAIL (no compila).

- [ ] **Step 3: Implementar.** `instalado` lista `<prefijo>-*`, borra los que no tienen `.ok`, y si quedan varios con `.ok` devuelve el de mtime más reciente (el viejo lo borra la Task 3 al terminar una actualización). `puerto_libre` prueba `TcpListener::bind(("127.0.0.1", p))` de `desde` a `desde + 100`.

- [ ] **Step 4: Run** el mismo comando → PASS.

- [ ] **Step 5: Commit.** `feat(lt): estado de instalación y puerto del LT embebido`

---

### Task 3: Descarga, verificación y extracción

**Files:**
- Modify: `src-tauri/Cargo.toml` (`sha2`, `tar`, `flate2` con las versiones de Global Constraints)
- Modify: `src-tauri/src/lt_embebido.rs`
- Modify: `src-tauri/src/grammar.rs` (`emit_progress` y `LtProgress` pasan a `pub(crate)`)

**Interfaces:**
- Consumes: `lock`, `jre_del_target`, `instalado` (Task 2); `grammar::emit_progress(app, phase, msg)`.
- Produces:
  ```rust
  pub fn verificar_sha256(path: &Path, esperado: &str) -> Result<(), String>
  pub fn extraer(archivo: &Path, destino: &Path) -> Result<(), String>   // .tar.gz / .zip por extensión de la URL
  pub async fn instalar(base: &Path, progreso: &(dyn Fn(&'static str, String) + Sync)) -> Result<(), String>
  // baja lo que falte o difiera del lock; sin AppHandle para poder testearlo.
  // El comando de la Task 4 le pasa `|fase, msg| grammar::emit_progress(&app, fase, msg)`.
  ```
  Fases de `languagetool-progress`: `downloading` (mensaje `"Bajando LanguageTool: 37 / 142 MB"`), `verifying`, `extracting`, `starting`, `ready`, `error`.

- [ ] **Step 1: Chequeo de supply chain** de `sha2 0.10.9`, `tar 0.4.46`, `flate2 1.1.9`: `cargo tree -i <crate>` confirma que ya están en el árbol y en esa versión; anotar en el mensaje de commit que no entra código nuevo.

- [ ] **Step 2: Tests que fallan:**
  - `sha_que_no_coincide_no_extrae`: archivo con `b"hola"` y un sha distinto → `verificar_sha256` da `Err` que contiene `"no coincide"`.
  - `sha_correcto_pasa`: sha256 de `b"hola"` (`b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79`) → `Ok`.
  - `extraer_tar_gz_preserva_ejecutable` (`#[cfg(unix)]`): arma con `tar`+`flate2` un `.tar.gz` con `x/bin/java` modo `0o755`, extrae, el modo sigue con bit de ejecución.
  - `extraer_corrupto_no_deja_destino`: `.tar.gz` con basura → `Err`, y `destino` no existe.

- [ ] **Step 3: Run** `cargo test --manifest-path src-tauri/Cargo.toml lt_embebido` → FAIL.

- [ ] **Step 4: Implementar.**
  - `extraer` escribe a `destino.with_extension("tmp")` y renombra al final; en error borra el temporal.
  - `instalar`: para LT, si `instalado(base,"lt") != Some(lock().lt)`, baja cada jar a `lt-<v>.tmp/libs/`, verifica cada uno, renombra a `lt-<v>/` y escribe `.ok`. Para el JRE igual con `jre-<v>/`, y en Unix `chmod 0o755` sobre `<jre-dir>/<jre.java>`. La descarga usa `reqwest` + `Response::chunk()` escribiendo a archivo y emitiendo progreso como mucho cada 1 MB. Si algo falla: borra el `.tmp` de esa pieza y devuelve `Err` con qué pieza y por qué (`"El archivo language-es-6.8.jar no coincide con el esperado. Puede ser una descarga cortada: probá de nuevo."`, `"No hay conexión con repo1.maven.org: …"`).
  - Solo después de que el proceso nuevo responde (Task 4) se borran `lt-*`/`jre-*` de otras versiones; si no responde, se borra el nuevo y vuelve el viejo. Ese paso vive en `instalar` llamando a `arrancar` de la Task 4: dejá el hueco marcado con un `todo!()` que la Task 4 completa, para que esta task compile y testee sola.

- [ ] **Step 5: Run** → PASS. También `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`.

- [ ] **Step 6: Commit.** `feat(lt): bajar, verificar y extraer LT y el JRE`

---

### Task 4: Proceso, resolución y comandos

**Files:**
- Modify: `src-tauri/src/lt_embebido.rs`
- Modify: `src-tauri/src/grammar.rs` (`resolve_base`, `check_grammar_available`)
- Modify: `src-tauri/src/lib.rs` (registro de comandos, arranque en `setup`, `RunEvent::Exit`)

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  ```rust
  pub fn java_args(libs: &Path, puerto: u16) -> Vec<OsString>
  pub fn base_embebida() -> Option<String>            // "http://127.0.0.1:<puerto>" si está corriendo
  pub async fn arrancar(app: &AppHandle) -> Result<u16, String>
  pub fn detener()
  pub async fn asegurar_corriendo(app: &AppHandle)     // relanza una vez si murió
  #[derive(Serialize)] pub struct LtEmbebidoStatus {
      lt_instalado: Option<String>, jre_instalado: Option<String>,
      lt_lock: String, jre_lock: String,
      mb_a_bajar: u64,            // lo que falta según el lock; 0 si está al día
      corriendo: bool, puerto: Option<u16>,
      error: Option<String>,      // último error de arranque, con la última línea de stderr de java
  }
  #[tauri::command] pub async fn lt_embebido_status(app: AppHandle) -> LtEmbebidoStatus
  #[tauri::command] pub async fn lt_embebido_instalar(app: AppHandle) -> Result<(), String>
  #[tauri::command] pub async fn lt_embebido_reiniciar(app: AppHandle) -> Result<(), String>
  #[tauri::command] pub async fn lt_embebido_borrar(app: AppHandle) -> Result<(), String>
  ```
  El estado vivo son dos statics: `PUERTO: AtomicU16` (0 = no corre), que lee `base_embebida`, y `PROCESO: Mutex<Option<Child>>` (mismo criterio que `PUBLIC_BUDGET` en `grammar.rs`: `resolve_base` es sync y no tiene `AppHandle`). `arrancar` y `detener` reciben `base: &Path`-derivado vía `app.path().app_data_dir()`; el resto del módulo trabaja con `base: &Path` para que sea testeable.

- [ ] **Step 1: Tests que fallan:**
  - `java_args_con_espacios_quedan_en_un_solo_arg`: `java_args(Path::new("/a b/Ñandú/libs"), 8082)` contiene exactamente `"-Xmx256m"`, `"-cp"`, el `OsString` `"/a b/Ñandú/libs/*"` como **un** elemento, `"org.languagetool.server.HTTPServer"`, `"--port"`, `"8082"`, y no contiene `"--public"`.
  - `pid_file_round_trip`: `escribir_pid(dir, 1234, 8083)` y `leer_pid(dir) == Some((1234, 8083))`; archivo ausente → `None`.
  - `resolve_base_local_usa_embebido_si_corre`: con `PUERTO.store(8083)` (y `0` al final del test), `resolve_base` de `{"mode":"local"}` da `http://127.0.0.1:8083`; con `None` da `LOCAL_BASE`; `{"mode":"custom","customUrl":"http://x"}` da `http://x` aunque haya embebido.

- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml` → FAIL.

- [ ] **Step 3: Implementar.**
  - `arrancar`: si hay `lt.pid` y su puerto responde `/v2/languages`, mata ese pid (`kill` en Unix, `taskkill /PID <n> /F` en Windows, los dos por `std::process::Command`); toma `puerto_libre(8082)`; lanza `java` con `java_args`, stdout a null, stderr a `<base>/lt.log` (truncado en cada arranque); en Windows `CommandExt::creation_flags(0x0800_0000)`; escribe `lt.pid`; poll a `/v2/languages` cada 200 ms hasta 30 s. Si no responde: mata el proceso y devuelve `Err` con la última línea no vacía de `lt.log`.
  - `detener`: mata el `Child` y borra `lt.pid`.
  - `asegurar_corriendo`: si `PROCESO` tiene un `Child` con `try_wait()` = `Some(_)`, relanza **una** vez; si vuelve a fallar, deja el error en el status y no reintenta hasta el próximo «Reiniciar».
  - `resolve_base`: rama `"local"` → `lt_embebido::base_embebida().unwrap_or_else(|| LOCAL_BASE.into())`.
  - `check_grammar_available`: con modo `"local"` y LT instalado, llama `asegurar_corriendo` antes del ping (necesita `AppHandle`: sumarlo como parámetro del comando; Tauri lo inyecta y el front no cambia).
  - Completar el `todo!()` de la Task 3: después de instalar, `arrancar`; si da `Ok`, borrar versiones viejas; si da `Err`, borrar la nueva.
  - `lt_embebido_borrar`: `detener` + borrar `<base>` entero.
  - `lib.rs`: registrar los cuatro comandos; en `setup`, si `settings.grammar_mode == Some("local")` y `instalado` da algo para `lt` y `jre`, `tauri::async_runtime::spawn(arrancar)`; cambiar `.run(generate_context!())` por `.build(generate_context!())?.run(|_, ev| if let RunEvent::Exit = ev { lt_embebido::detener() })`.

- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml` y `cargo clippy … -- -D warnings` → PASS.

- [ ] **Step 5: Prueba a mano en la Mac** (sin la app del autor corriendo): un test `#[ignore]` `instala_y_chequea_de_verdad` que con un `base` temporal hace `instalar(base, &|_, _| {})`, arranca `java` con `java_args` (la parte de `arrancar` que no necesita `AppHandle`, extraída a `arrancar_en(base: &Path) -> Result<u16, String>`), hace un POST a `/v2/check` con «Ella fué a la casa y vió que el perro estaban dormido.» en `es-AR`, espera una regla `MONOSILABOS`, y después de `detener` `pgrep -f HTTPServer` sale vacío. Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored instala_y_chequea` → PASS.

- [ ] **Step 6: Commit.** `feat(lt): correr LanguageTool como proceso propio`

---

### Task 5: Panel en Configuración → Gramática

**Files:**
- Modify: `src/app/core/grammar-service.ts`
- Modify: `src/app/settings-modal/settings-modal.ts`, `.html`, `.scss`

**Interfaces:**
- Consumes: los cuatro comandos de la Task 4 y el evento `languagetool-progress` (`{ phase, message }`, ya tipado como `LtProgressEvent`).
- Produces (en `GrammarService`): `embebidoStatus(): Promise<LtEmbebidoStatus>`, `embebidoInstalar(): Promise<void>`, `embebidoReiniciar(): Promise<void>`, `embebidoBorrar(): Promise<void>`, cada uno con el mismo log a `this.debug` que `dockerStart`/`dockerStop`, y `this.version.set(null); void this.ping();` después de instalar/reiniciar. Interfaz TS `LtEmbebidoStatus` con los mismos campos en snake_case que el struct Rust (como `LtDockerStatus`).

- [ ] **Step 1: Servicio.** Los cuatro métodos con los `invoke` (`lt_embebido_status`, etc.).

- [ ] **Step 2: Modal.** El radio pasa de «Local (Docker)» a «Local»; su subtítulo `localhost:8081` pasa a `privado, sin límites de uso, auto-check on.` Adentro de `@if (mode() === 'local')`, **antes** del bloque de Docker existente, un `<section class="lt-embebido">` con estos estados (signals `embebido`, `embebidoBusy`, y reusar el listener de `languagetool-progress` que ya existe en el modal):
  - no instalado: «LanguageTool corre dentro de tWriter, sin Docker. Baja una vez ~{{ mb }} MB (LanguageTool {{ lt_lock }} + Java {{ jre_lock }}).» + `btn btn-primary` «Bajar LanguageTool».
  - bajando: `<progress>` con el MB del mensaje y el texto de la fase.
  - instalado y corriendo: «LanguageTool {{ lt }} · Java {{ jre }} · listo» + `btn btn-secondary btn-sm` «Reiniciar» y `btn btn-danger btn-sm` «Borrar».
  - instalado y caído: el `error` + «Reiniciar».
  - actualización (`mb_a_bajar > 0` con algo instalado): si `lt_instalado !== lt_lock`, «Actualizar LanguageTool a {{ lt_lock }}»; si solo cambió Java, «Actualizar Java (parche de seguridad)».
  - error de descarga: el mensaje + «Reintentar».
  Debajo, el bloque de Docker tal cual, con un `<details>` que lo envuelve titulado «Alternativa: correrlo con Docker». Botones solo con las clases globales de `src/styles.scss`; en el `.scss` del componente, solo layout.
  El texto viejo «Por qué Docker: … Empaquetarlo dentro de tWriter haría el bundle pesar 300MB+ y forzaría una JVM» queda dentro de ese `<details>` pero hay que corregirlo: ya no es el porqué, es la alternativa.

- [ ] **Step 3: Verificar build.** Run: `pnpm build` → sin errores.

- [ ] **Step 4: Commit.** `feat(gramatica): bajar y manejar LanguageTool desde Configuración`

---

### Task 6: Workflow `lt-al-dia.yml`

**Files:**
- Create: `scripts/smoke-lt-lock.mjs`
- Create: `.github/workflows/lt-al-dia.yml`

**Interfaces:**
- Consumes: `scripts/armar-lt-lock.mjs --lt latest` (Task 1), `src-tauri/lt-lock.json`.

- [ ] **Step 1: `scripts/smoke-lt-lock.mjs`.** Lee el lock, baja los jars y el JRE de `x86_64-unknown-linux-gnu` a un tmpdir verificando sha256, levanta `java` con los mismos args que `java_args` en un puerto libre, espera `/v2/languages` hasta 60 s, y chequea: `es-AR` «Ella fué a la casa y vió que el perro estaban dormido.» incluye `MONOSILABOS`; `en-US` «She go to the store yesterday and buyed a apple.» incluye `HE_VERB_AGR`. Mata el proceso y sale con 0 o con 1 y el log. Probarlo local en un container x86_64: `container run --arch amd64 -v "$PWD":/w -w /w node:22 node scripts/smoke-lt-lock.mjs` → exit 0.

- [ ] **Step 2: Workflow.** `on: schedule: - cron: '0 9 * * 1'` + `workflow_dispatch`. `permissions: { contents: write, pull-requests: write, statuses: write }`. `runs-on: ubuntu-24.04`. Pasos: checkout; `actions/setup-node` con la versión de `release.yml`; `node scripts/armar-lt-lock.mjs --lt latest`; si `git diff --quiet src-tauri/lt-lock.json` → terminar. Si cambió:
  1. `node scripts/smoke-lt-lock.mjs` con `continue-on-error: true`, guardando el resultado.
  2. Línea de CHANGELOG en `## [Unreleased]`: bajo `### Changed` «LanguageTool updated to <lt>» si cambió `lt`; bajo `### Security` «Java runtime for LanguageTool updated to <jre>» si cambió solo `jre`. Insertarla con un flag nuevo de `armar-lt-lock.mjs`, `--changelog`, que inserta el texto bajo el encabezado del tipo dentro de `[Unreleased]` (creándolo si no está) y se prueba en `run-lt-lock-smoke.mjs` con un CHANGELOG de ejemplo: sin `### Security` lo crea; con `### Security` existente agrega la línea debajo.
  3. Rama `bot/lt-<lt>-jre-<jre>`, commit, push, `gh pr create` con el resultado del smoke en el cuerpo. Si la rama ya existe en el remoto, no hacer nada (el PR de la semana pasada sigue abierto).
  4. `gh api repos/${{ github.repository }}/statuses/<sha> -f state=success|failure -f context=lt-al-dia/smoke -f description=…`.

- [ ] **Step 3: Activar el permiso del repo.** Es un cambio de settings del repo que el autor aprobó (spec, sección 3): `gh api -X PUT repos/T4toh/tWriter/actions/permissions/workflow -F can_approve_pull_request_reviews=true -f default_workflow_permissions=read`. Verificar con `gh api repos/T4toh/tWriter/actions/permissions/workflow` → `"can_approve_pull_request_reviews":true`.

- [ ] **Step 4: Validar el YAML.** `actionlint .github/workflows/lt-al-dia.yml` si está instalado; si no, `node -e` con el parser YAML que ya esté en `node_modules`, o al menos `python3 -c 'import yaml…'`. La corrida real se hace después del merge con `workflow_dispatch` (necesita estar en `main`).

- [ ] **Step 5: Commit.** `ci(lt): workflow semanal que abre PR con LanguageTool al día`

---

### Task 7: Licencias y documentación

**Files:**
- Modify: `scripts/generar-licencias.mjs`, `src/assets/licencias.json` (regenerado)
- Modify: `CLAUDE.md`, `docs/decisiones-cerradas.md`, `CHANGELOG.md`, `TODO.md`

- [ ] **Step 1: Licencias.** En `generar-licencias.mjs`, dos entradas nuevas junto a las del tesauro: LanguageTool (`LGPL-2.1-or-later`, «se descarga de Maven Central al activarlo; corre como proceso aparte») y Eclipse Temurin (`GPL-2.0 WITH Classpath-exception-2.0`, «se descarga de Adoptium al activarlo»), con link a cada licencia en vez de copiar el texto (no lo distribuimos). Run: `node scripts/generar-licencias.mjs` → `licencias.json` con las dos.

- [ ] **Step 2: CLAUDE.md.** En «Sidecars y servicios externos», el bullet de LanguageTool: corre embebido (bajado por la app, `lt_embebido.rs`, `lt-lock.json`, workflow `lt-al-dia.yml`) o en Docker como alternativa hasta que se borre. Sumar `lt_embebido.rs` al diagrama de backend.

- [ ] **Step 3: decisiones-cerradas.md.** En «LT embebido como sidecar», debajo de la corrección del 2026-10-28: el método de Maven (exclusión de `language-all`, trampa de `ca`/`pt`), que las tres trampas del recorte no aplican, y los números del spike (130 jars / 96 MB, JRE ~46 MB, 0,36 s, ~400 MB RSS, mismas 151 marcas que el container).

- [ ] **Step 4: CHANGELOG.** `## [Unreleased]` → `### Added`: «Grammar checking no longer needs Docker: tWriter can download LanguageTool and run it on its own from Settings → Grammar.»

- [ ] **Step 5: TODO.md.** No sacar el item «Bajar LanguageTool desde la app» todavía: se saca cuando el autor lo pruebe (memoria del proyecto). Sí actualizarlo con «implementado, falta prueba del autor en las cuatro plataformas».

- [ ] **Step 6: Commit.** `docs(lt): licencias, CLAUDE.md y changelog del LT embebido`

---

## Verificación del autor (no la hace el agente)

La lista de la sección «Verificación → Manual del autor» del spec, en Mac arm64 primero y después en el Arch, una Mac Intel y Windows.
