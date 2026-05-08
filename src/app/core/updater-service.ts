import { Injectable, inject, signal } from '@angular/core';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { DebugService } from './debug-service';

export type UpdaterEstado =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unavailable';

@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private debug = inject(DebugService);

  readonly estado = signal<UpdaterEstado>('idle');
  readonly progreso = signal<number>(0);
  readonly versionDisponible = signal<string | null>(null);
  readonly notas = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  private update: Update | null = null;

  async chequear(): Promise<void> {
    this.estado.set('checking');
    this.error.set(null);
    try {
      const result = await check();
      if (!result) {
        this.estado.set('idle');
        this.debug.info('updater', 'sin updates disponibles');
        return;
      }
      this.update = result;
      this.versionDisponible.set(result.version);
      this.notas.set(result.body ?? null);
      this.estado.set('available');
      this.debug.info('updater', `update disponible: v${result.version}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.estado.set('unavailable');
      this.debug.warn('updater', 'no se pudo chequear updates', msg);
    }
  }

  descartar(): void {
    this.update = null;
    this.versionDisponible.set(null);
    this.notas.set(null);
    this.estado.set('idle');
  }

  async aplicar(): Promise<void> {
    if (!this.update) return;
    this.estado.set('downloading');
    this.progreso.set(0);
    let total = 0;
    let descargado = 0;
    try {
      await this.update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === 'Progress') {
          descargado += ev.data.chunkLength;
          if (total > 0) {
            this.progreso.set(Math.round((descargado / total) * 100));
          }
        } else if (ev.event === 'Finished') {
          this.progreso.set(100);
          this.estado.set('ready');
        }
      });
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error.set(msg);
      this.estado.set('error');
      this.debug.error('updater', 'falló la instalación', msg);
    }
  }
}
