import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';

export type StorageBackend =
  | 'git'
  | 'dropbox'
  | 'pcloud'
  | 'nextcloud'
  | 'onedrive'
  | 'gdrive'
  | 'icloud'
  | 'sync'
  | 'mega'
  | 'local'
  | 'unknown';

const LABELS: Record<StorageBackend, string> = {
  git: 'Git',
  dropbox: 'Dropbox',
  pcloud: 'pCloud',
  nextcloud: 'Nextcloud',
  onedrive: 'OneDrive',
  gdrive: 'Google Drive',
  icloud: 'iCloud',
  sync: 'Sync',
  mega: 'MEGA',
  local: 'Local',
  unknown: '—',
};

const ICONS: Record<StorageBackend, string> = {
  git: '⎇',
  dropbox: '📦',
  pcloud: '☁️',
  nextcloud: '☁️',
  onedrive: '☁️',
  gdrive: '☁️',
  icloud: '☁️',
  sync: '🔄',
  mega: '☁️',
  local: '💾',
  unknown: '·',
};

@Injectable({ providedIn: 'root' })
export class StorageService {
  private settings = inject(SettingsService);

  readonly backend = signal<StorageBackend>('unknown');
  readonly isGit = computed(() => this.backend() === 'git');
  readonly label = computed<string>(() => LABELS[this.backend()]);
  readonly icon = computed<string>(() => ICONS[this.backend()]);

  constructor() {
    effect(() => {
      const root = this.settings.root();
      if (!root) {
        this.backend.set('unknown');
        return;
      }
      void this.detect(root);
    });
  }

  /** Re-evalúa el backend del root actual. Llamar después de `git init` externo. */
  async refresh(): Promise<void> {
    const root = this.settings.root();
    if (!root) {
      this.backend.set('unknown');
      return;
    }
    await this.detect(root);
  }

  private async detect(root: string): Promise<void> {
    try {
      const b = await invoke<StorageBackend>('detect_storage_backend', { path: root });
      this.backend.set(b);
    } catch {
      this.backend.set('local');
    }
  }
}
