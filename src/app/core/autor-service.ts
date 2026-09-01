import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';

export interface AutorConfig {
  nombre?: string | null;
  bio?: Record<string, string> | null;
  foto?: string | null;
  web?: string | null;
  qr?: string | null;
}

@Injectable({ providedIn: 'root' })
export class AutorService {
  private settings = inject(SettingsService);

  /** true = modal abierto. El perfil es uno solo, no hay nodo que editar. */
  readonly editing = signal(false);
  readonly savedAt = signal(0);

  async load(): Promise<AutorConfig> {
    const root = this.settings.root();
    if (!root) return {};
    return await invoke<AutorConfig>('get_autor_config', { root });
  }

  async save(config: AutorConfig): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    await invoke('set_autor_config', { root, config });
    this.savedAt.set(Date.now());
  }

  open(): void {
    this.editing.set(true);
  }

  close(): void {
    this.editing.set(false);
  }
}
