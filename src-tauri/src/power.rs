//! Avisos de suspensión del sistema: subir los cambios antes de dormir.
//!
//! El caso que lo motivó: la Mac queda con el editor abierto, se cierra la
//! tapa, el commit del blur alcanza a hacerse pero el push no. Esa noche se
//! escribe en la otra PC sin ese commit y a la mañana siguiente el rebase
//! choca. Los timers del front no corren con la máquina dormida, así que el
//! único momento para subir es el aviso previo del sistema.
//!
//! Cada plataforma avisa distinto y da un margen distinto:
//! - macOS: IOKit `kIOMessageSystemWillSleep`; la suspensión espera hasta
//!   `IOAllowPowerChange` o 30 s.
//! - Linux: logind `PrepareForSleep` con un inhibidor `delay`; el margen es
//!   `InhibitDelayMaxSec` (5 s por default).
//! - Windows: `PBT_APMSUSPEND`; ~2 s y el sistema no espera.
//!
//! En las tres el flujo es el mismo: emitir `power-will-sleep` con un id, que
//! el front flushee y sincronice, y esperar su `power_sleep_ready(id)` o el
//! margen de la plataforma, lo que llegue primero. Al despertar se emite
//! `power-did-wake`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// Espera del ack del front. El id es creciente: un ack tardío de una
/// suspensión anterior no libera la actual.
struct Gate {
    acked: Mutex<u64>,
    cv: Condvar,
}

impl Gate {
    const fn new() -> Self {
        Self { acked: Mutex::new(0), cv: Condvar::new() }
    }

    fn ack(&self, id: u64) {
        let mut acked = self.acked.lock().unwrap_or_else(|e| e.into_inner());
        if id > *acked {
            *acked = id;
        }
        self.cv.notify_all();
    }

    /// true si el front respondió dentro del margen.
    fn wait(&self, id: u64, budget: Duration) -> bool {
        let acked = self.acked.lock().unwrap_or_else(|e| e.into_inner());
        let (_acked, res) = self
            .cv
            .wait_timeout_while(acked, budget, |acked| *acked < id)
            .unwrap_or_else(|e| e.into_inner());
        !res.timed_out()
    }
}

static GATE: Gate = Gate::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub fn power_sleep_ready(id: u64) {
    GATE.ack(id);
}

/// Bloquea el thread del aviso hasta que el front sincronice o venza el margen.
fn before_sleep(app: &AppHandle, budget: Duration) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if let Err(e) = app.emit("power-will-sleep", id) {
        tracing::warn!(target: "power", error = %e, "no pude avisar la suspensión");
        return;
    }
    let ok = GATE.wait(id, budget);
    tracing::info!(target: "power", id, synced = ok, "suspensión");
}

fn after_wake(app: &AppHandle) {
    tracing::info!(target: "power", "vuelta de la suspensión");
    let _ = app.emit("power-did-wake", ());
}

pub fn watch(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("power".into())
        .spawn(move || platform::run(app));
    if let Err(e) = spawned {
        tracing::warn!(target: "power", error = %e, "no pude escuchar la suspensión");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;

    use tauri::AppHandle;

    // Bajo los 30 s que espera macOS, con aire para el resto del callback.
    const BUDGET: Duration = Duration::from_secs(20);

    // `iokit_common_msg(0x270)` y compañía, de IOKit/IOMessage.h.
    const CAN_SYSTEM_SLEEP: u32 = 0xe000_0270;
    const SYSTEM_WILL_SLEEP: u32 = 0xe000_0280;
    const SYSTEM_HAS_POWERED_ON: u32 = 0xe000_0300;

    type Callback = extern "C" fn(*mut c_void, u32, u32, *mut c_void);

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IORegisterForSystemPower(
            refcon: *mut c_void,
            port: *mut *mut c_void,
            callback: Callback,
            notifier: *mut u32,
        ) -> u32;
        fn IONotificationPortGetRunLoopSource(port: *mut c_void) -> *mut c_void;
        fn IOAllowPowerChange(kernel_port: u32, notification_id: isize) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopDefaultMode: *const c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
    }

    static ROOT_PORT: AtomicU32 = AtomicU32::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    extern "C" fn on_power(_refcon: *mut c_void, _service: u32, msg: u32, arg: *mut c_void) {
        let port = ROOT_PORT.load(Ordering::Acquire);
        match msg {
            // Suspensión por inactividad: no la frenamos, la del sync es la de abajo.
            CAN_SYSTEM_SLEEP => unsafe {
                IOAllowPowerChange(port, arg as isize);
            },
            SYSTEM_WILL_SLEEP => {
                if let Some(app) = APP.get() {
                    super::before_sleep(app, BUDGET);
                }
                unsafe {
                    IOAllowPowerChange(port, arg as isize);
                }
            }
            SYSTEM_HAS_POWERED_ON => {
                if let Some(app) = APP.get() {
                    super::after_wake(app);
                }
            }
            _ => {}
        }
    }

    pub fn run(app: AppHandle) {
        let _ = APP.set(app);
        let mut port: *mut c_void = std::ptr::null_mut();
        let mut notifier: u32 = 0;
        let root = unsafe {
            IORegisterForSystemPower(std::ptr::null_mut(), &mut port, on_power, &mut notifier)
        };
        if root == 0 {
            tracing::warn!(target: "power", "IORegisterForSystemPower falló");
            return;
        }
        ROOT_PORT.store(root, Ordering::Release);
        unsafe {
            CFRunLoopAddSource(
                CFRunLoopGetCurrent(),
                IONotificationPortGetRunLoopSource(port),
                kCFRunLoopDefaultMode,
            );
            CFRunLoopRun();
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::time::Duration;

    use dbus::arg::OwnedFd;
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use tauri::AppHandle;

    // Bajo el `InhibitDelayMaxSec` default de logind (5 s).
    const BUDGET: Duration = Duration::from_secs(4);

    const DEST: &str = "org.freedesktop.login1";
    const PATH: &str = "/org/freedesktop/login1";
    const MANAGER: &str = "org.freedesktop.login1.Manager";

    /// El inhibidor `delay` es lo que le da margen al sync: logind espera a
    /// que se cierre el fd (o vence el plazo). Hay que pedirlo de nuevo en
    /// cada vuelta, porque se suelta en cada suspensión.
    fn inhibit(conn: &Connection) -> Option<OwnedFd> {
        let proxy = conn.with_proxy(DEST, PATH, Duration::from_secs(5));
        let res: Result<(OwnedFd,), _> = proxy.method_call(
            MANAGER,
            "Inhibit",
            ("sleep", "tWriter", "Subir los cambios antes de suspender", "delay"),
        );
        match res {
            Ok((fd,)) => Some(fd),
            Err(e) => {
                tracing::warn!(target: "power", error = %e, "logind no dio el inhibidor");
                None
            }
        }
    }

    pub fn run(app: AppHandle) {
        let conn = match Connection::new_system() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(target: "power", error = %e, "sin bus de sistema, no escucho la suspensión");
                return;
            }
        };
        let mut lock = inhibit(&conn);
        let rule = MatchRule::new_signal(MANAGER, "PrepareForSleep");
        let added = conn.add_match(rule, move |(start,): (bool,), conn: &Connection, _| {
            if start {
                super::before_sleep(&app, BUDGET);
                // Cerrar el fd es lo que le dice a logind "ya está".
                drop(lock.take());
            } else {
                lock = inhibit(conn);
                super::after_wake(&app);
            }
            true
        });
        if let Err(e) = added {
            tracing::warn!(target: "power", error = %e, "no pude escuchar PrepareForSleep");
            return;
        }
        loop {
            if let Err(e) = conn.process(Duration::from_secs(3600)) {
                tracing::warn!(target: "power", error = %e, "se cortó el bus de sistema");
                return;
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use std::time::Duration;

    use tauri::AppHandle;

    // Windows da ~2 s y no espera a nadie; pasado eso la máquina se duerme igual.
    const BUDGET: Duration = Duration::from_millis(1800);

    const DEVICE_NOTIFY_CALLBACK: u32 = 2;
    const PBT_APMSUSPEND: u32 = 0x4;
    const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;

    type Callback = unsafe extern "system" fn(*mut c_void, u32, *mut c_void) -> u32;

    #[repr(C)]
    struct SubscribeParameters {
        callback: Callback,
        context: *mut c_void,
    }

    #[link(name = "powrprof")]
    extern "system" {
        fn PowerRegisterSuspendResumeNotification(
            flags: u32,
            recipient: *mut c_void,
            handle: *mut *mut c_void,
        ) -> u32;
    }

    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "system" fn on_power(_ctx: *mut c_void, kind: u32, _setting: *mut c_void) -> u32 {
        if let Some(app) = APP.get() {
            match kind {
                PBT_APMSUSPEND => super::before_sleep(app, BUDGET),
                PBT_APMRESUMEAUTOMATIC => super::after_wake(app),
                _ => {}
            }
        }
        0
    }

    /// Windows llama al callback desde un thread suyo: registrar y listo.
    pub fn run(app: AppHandle) {
        let _ = APP.set(app);
        // Vive lo que vive la app: Windows guarda el puntero.
        let params = Box::leak(Box::new(SubscribeParameters {
            callback: on_power,
            context: std::ptr::null_mut(),
        }));
        let mut handle: *mut c_void = std::ptr::null_mut();
        let err = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                params as *mut SubscribeParameters as *mut c_void,
                &mut handle,
            )
        };
        if err != 0 {
            tracing::warn!(target: "power", err, "PowerRegisterSuspendResumeNotification falló");
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod platform {
    pub fn run(_app: tauri::AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn ack_libera_la_espera() {
        let gate = Arc::new(Gate::new());
        let g = gate.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            g.ack(1);
        });
        assert!(gate.wait(1, Duration::from_secs(5)));
        t.join().unwrap();
    }

    #[test]
    fn sin_ack_vence_el_margen() {
        let gate = Gate::new();
        let start = Instant::now();
        assert!(!gate.wait(1, Duration::from_millis(100)));
        assert!(start.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn ack_viejo_no_libera_la_suspension_nueva() {
        let gate = Gate::new();
        gate.ack(1);
        assert!(!gate.wait(2, Duration::from_millis(50)));
        gate.ack(3);
        assert!(gate.wait(2, Duration::from_millis(50)));
    }
}
