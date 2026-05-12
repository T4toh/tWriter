use std::fmt::Write as _;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::{filter::EnvFilter, fmt, prelude::*};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[derive(Serialize, Clone)]
pub struct DebugLog {
    pub level: &'static str,
    pub source: String,
    pub message: String,
    pub details: Option<String>,
}

pub fn set_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("twriter_lib=info,warn,error"));

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr).with_target(true))
        .with(EmitLayer)
        .try_init();
}

struct EmitLayer;

impl<S: Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>> Layer<S> for EmitLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let Some(handle) = APP_HANDLE.get() else {
            return;
        };

        let meta = event.metadata();
        let level = match *meta.level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "info",
            _ => return,
        };

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let message = visitor.message.unwrap_or_else(|| meta.name().to_string());
        let details = if visitor.fields.is_empty() {
            None
        } else {
            Some(visitor.fields)
        };

        let payload = DebugLog {
            level,
            source: meta.target().to_string(),
            message,
            details,
        };

        let _ = handle.emit("debug-log", payload);
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: String,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = Some(format!("{value:?}"));
        } else {
            if !self.fields.is_empty() {
                self.fields.push('\n');
            }
            let _ = write!(self.fields, "{} = {:?}", field.name(), value);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            if !self.fields.is_empty() {
                self.fields.push('\n');
            }
            let _ = write!(self.fields, "{} = {}", field.name(), value);
        }
    }
}
