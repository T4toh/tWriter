import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  LucideCloud,
  LucideGitBranch,
  LucideHardDrive,
  LucidePackage,
  LucideRefreshCw,
  type LucideIcon,
} from '@lucide/angular';
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

const ICONS: Record<StorageBackend, LucideIcon | null> = {
  git: LucideGitBranch,
  dropbox: LucidePackage,
  pcloud: LucideCloud,
  nextcloud: LucideCloud,
  onedrive: LucideCloud,
  gdrive: LucideCloud,
  icloud: LucideCloud,
  sync: LucideRefreshCw,
  mega: LucideCloud,
  local: LucideHardDrive,
  unknown: null,
};

@Injectable({ providedIn: 'root' })
export class StorageService {
  private settings = inject(SettingsService);

  readonly backend = signal<StorageBackend>('unknown');
  readonly isGit = computed(() => this.backend() === 'git');
  readonly label = computed<string>(() => LABELS[this.backend()]);
  readonly icon = computed<LucideIcon | null>(() => ICONS[this.backend()]);

  constructor() {
    effect(() => {
      const root = this.settings.root();
      // Reset siempre antes de detect. Sin esto, al cambiar de root el signal
      // retiene el backend viejo (e.g. 'git') durante la ventana async, y
      // GitService dispara `git_status` sobre el folder nuevo asumiendo
      // backend equivocado. Con el reset, consumers ven 'unknown' = pendiente.
      this.backend.set('unknown');
      if (!root) return;
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
