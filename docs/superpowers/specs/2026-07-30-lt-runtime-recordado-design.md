# Recordar qué runtime de containers tiene LanguageTool

Fecha: 2026-07-30

## Problema

Con el daemon caído, la app puede arrancar el runtime equivocado, bajar ~300MB de imagen y
crear un **segundo** container de LanguageTool mientras el real duerme en otro runtime.

`detect_engine()` (`src-tauri/src/grammar.rs:247-264`) elige bien: recorre los runtimes con
daemon vivo y prefiere aquel donde el container ya está corriendo, después donde existe.
Pero cuando ningún daemon responde devuelve `None`, y ahí entra el fallback:

```rust
fn detect_installed() -> Option<Engine> {
    Runtime::ALL
        .into_iter()
        .find_map(|rt| rt.bin().map(|bin| Engine { rt, bin }))
}
```

`Runtime::ALL` es `[Docker, Podman, Apple]` — un orden de prioridad fijo que **no tiene
ninguna relación** con cuál de los tres es dueño del container `twriter-languagetool`. En una
Mac con Docker Desktop y Apple `container` instalados y los dos daemons dormidos,
`detect_installed()` devuelve Docker siempre.

### Por qué recién ahora hace daño

Antes de `feat/languagetool-setup-seamless` esto solo ensuciaba un mensaje: la UI decía
"Docker" donde tendría que decir "Apple container". Ahora la app **ejecuta** el remedio —
`languagetool_docker_start` (`grammar.rs:1128-1130`) usa `detect_installed()` para decidir
sobre qué runtime opera. Un click en el botón de arranque, en esa Mac, levanta Docker
Desktop, baja la imagen de LanguageTool y crea un container nuevo. El container real sigue
apagado en Apple `container`, y el autor queda con dos.

Es el caso concreto que quedó anotado como fuera de alcance de la ronda final de esa PR,
porque pide tocar el modelo de settings y no solo `grammar.rs`.

## Solución

Recordar el runtime donde la app **vio** el container, y preferirlo sobre el orden fijo.
Cuando no hay nada recordado y hay más de un candidato, preguntar en vez de adivinar.

### La decisión, como función pura

Toda la lógica vive en una función sin I/O, que es lo único que hace falta testear:

```rust
enum RuntimePick {
    Chosen(Runtime),
    Ambiguous(Vec<Runtime>),
    None,
}

fn pick_runtime(installed: &[Runtime], remembered: Option<Runtime>) -> RuntimePick
```

Reglas, en orden:

1. Hay un runtime recordado **y sigue instalado** → `Chosen(ese)`.
2. Hay exactamente un runtime instalado → `Chosen(ese)`.
3. Hay más de uno → `Ambiguous` con todos los instalados, en el orden de `Runtime::ALL`.
4. No hay ninguno → `None`.

El caso 1 gana sobre el 2 y el 3 aunque el recordado no sea el primero de `Runtime::ALL` —
es justamente el punto. Un runtime recordado que ya no está instalado se ignora en silencio
y se vuelve a decidir; no es un error que le importe al autor.

`detect_installed()` pasa a envolver `pick_runtime` y a devolver el pick, no un `Engine`
suelto. `detect_engine()` **no se toca**: cuando hay un daemon vivo ya elige por evidencia.

Los tres call sites de hoy resuelven el pick así:

- `languagetool_docker_status` (`grammar.rs:877`): `Chosen` se comporta como el `Engine` de
  hoy; `Ambiguous` llena `runtime_choices` y deja `runtime: None` — la app no afirma un
  runtime que no sabe; `None` es el caso "no hay runtime instalado", igual que hoy.
- `languagetool_docker_start` (`grammar.rs:1130`): `Ambiguous` sin parámetro `runtime`
  explícito devuelve error pidiendo la elección. La UI no puede llegar a ese estado —
  cuando `runtime_choices` no viene vacío muestra los botones — pero el comando no confía en
  eso.
- `languagetool_docker_stop` (`grammar.rs:1233`): `Ambiguous` es no-op. Frenar un container
  que no sabemos dónde vive no tiene sentido, y frenar el equivocado tampoco.

### Cuándo se recuerda

Solo con evidencia del container, nunca por tener un daemon vivo:

- `languagetool_docker_status`: si `detect_engine()` devolvió un engine y `running()` o
  `exists()` dieron true, se persiste ese runtime.
- `languagetool_docker_start`: el runtime que efectivamente creó o arrancó el container.

La escritura es condicional — solo si el valor cambió. El status corre en cada apertura de
la ventana de configuración y no tiene por qué reescribir `settings.json` cada vez.

### Dónde se persiste

Campo nuevo en el `Settings` de Rust (`src-tauri/src/settings.rs:18-181`):

```rust
#[serde(default, rename = "languagetoolRuntime", skip_serializing_if = "Option::is_none")]
pub languagetool_runtime: Option<String>,
```

`settings.json` vive en `app_config_dir` y es per-PC, que es exactamente el scope correcto:
qué runtime de containers usás es una propiedad de la máquina, no del repo de novelas.

**El campo es propiedad del backend y el frontend no lo conoce.** No se agrega a la interfaz
TS de settings. Para que el round-trip del front no lo borre, `set_settings`
(`settings.rs:202-207`) hace merge: si el `languagetool_runtime` entrante es `None`, conserva
el que está en disco.

Sin ese merge hay una carrera real, no teórica: el backend persiste `apple` al detectar el
container, el frontend tiene en memoria una copia de settings anterior a esa escritura, el
autor cambia el tamaño de fuente, y el `set_settings` resultante pisa el campo. El TODO ya
documenta el mismo mecanismo mordiendo al revés en `notesPaneCollapsed` — serde dropea lo que
el front no manda. Acá la asimetría es a propósito: el front no lo manda **nunca**, y el
merge lo hace inofensivo.

Queda como patrón reusable para cualquier estado que el backend descubra por su cuenta.

### La ambigüedad en la UI

`LtDockerStatus` (`grammar.rs:853-871`) suma:

```rust
pub runtime_choices: Vec<RuntimeChoice>,   // { key, label }
```

No vacío **solo** en el caso `Ambiguous`. La fase `daemon` del stepper, en vez de su botón
único, muestra un botón por runtime bajo el texto "Tenés N runtimes de containers instalados
y ninguno está respondiendo. ¿Cuál usás para LanguageTool?".

`languagetool_docker_start` pasa a tomar `runtime: Option<String>`:

- `None` → el camino de hoy, con `pick_runtime` resolviendo.
- `Some(key)` → la elección explícita del autor, que se persiste **antes** de arrancar nada.

En una máquina con un solo runtime instalado la UI no cambia: el pick es `Chosen` y
`runtime_choices` viene vacío.

### Firmas que cambian

`languagetool_docker_status` y `languagetool_docker_stop` pasan a recibir `app: AppHandle`
para poder leer y escribir settings. Tauri lo inyecta; el `invoke()` del frontend no cambia.

## Errores

- Runtime recordado ya no instalado: se ignora, se vuelve a decidir. Sin mensaje.
- Falla al escribir settings: se loggea y el flujo sigue. El remedio importa más que la
  memoria — que la próxima vez vuelva a preguntar es peor que no arrancar el container ahora.
- Falla al leer settings: se trata como "no hay nada recordado".

## Testing

Tests de Rust en `grammar.rs` y `settings.rs`:

- `pick_runtime` en matriz: recordado {ausente, presente e instalado, presente y
  desinstalado} × instalados {0, 1, N}.
- Invariante: `runtime_choices` no vacío ⟺ el pick fue `Ambiguous`.
- Invariante: `Ambiguous` nunca aparece con menos de dos runtimes.
- `Runtime::key()` ↔ `Runtime::from_key()` round-trip para los tres, y `from_key` de una
  string desconocida devuelve `None`.
- `set_settings` con `languagetool_runtime: None` conserva el valor de disco; con `Some`
  lo pisa.

Nada de esto necesita daemon ni container corriendo.

## Verificación a mano (macOS, la hace el autor)

1. Con el container corriendo en Apple `container`, abrir la config de gramática y confirmar
   que `settings.json` quedó con `"languagetoolRuntime": "apple"`.
2. `container system stop` → reabrir la app → la fase daemon nombra Apple container, no
   Docker, y el botón arranca el correcto.
3. Cambiar el tamaño de fuente del editor (fuerza un `set_settings` desde el front) y
   confirmar que `languagetoolRuntime` sigue en el archivo.
4. Borrar el campo a mano con los dos daemons caídos → la UI ofrece elegir entre Docker y
   Apple container; elegir Apple y confirmar que arranca ese y que el campo quedó escrito.
