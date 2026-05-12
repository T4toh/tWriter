import { Injectable, inject } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { DebugLevel, DebugService } from './debug-service';

interface RustLogPayload {
  level: DebugLevel;
  source: string;
  message: string;
  details?: string;
}

/**
 * Suscriptor del evento 'debug-log' emitido desde el layer de tracing en Rust.
 * Singleton root — la suscripción vive lo que dura el contexto JS.
 */
@Injectable({ providedIn: 'root' })
export class RustLogBridge {
  private debug = inject(DebugService);

  constructor() {
    void this.attach();
  }

  private async attach(): Promise<void> {
    try {
      await listen<RustLogPayload>('debug-log', (event) => {
        const p = event.payload;
        this.debug.log(p.level, p.source, p.message, p.details);
      });
    } catch (e) {
      this.debug.error('rust-bridge', 'No se pudo enganchar al canal debug-log', String(e));
    }
  }
}
