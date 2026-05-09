import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';

export interface GitStatus {
  has_changes: boolean;
  changed: number;
  ahead: number;
  behind: number;
  branch: string | null;
  remote: string | null;
}

interface GitCommitResult {
  committed: boolean;
  oid: string | null;
  files: number;
}

export type SyncState =
  | 'unknown'
  | 'clean'
  | 'pending'
  | 'syncing'
  | 'offline'
  | 'error';

const STATUS_REFRESH_MS = 30_000;
const AUTO_COMMIT_MS = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class GitService {
  private settings = inject(SettingsService);

  readonly status = signal<GitStatus | null>(null);
  readonly currentOp = signal<'sync' | 'pull' | null>(null);
  readonly syncing = computed<boolean>(() => this.currentOp() !== null);
  readonly error = signal<string | null>(null);
  readonly lastSyncAt = signal<number | null>(null);
  readonly lastCommitInfo = signal<string | null>(null);

  readonly state = computed<SyncState>(() => {
    if (this.syncing()) return 'syncing';
    if (this.error()) return 'error';
    const s = this.status();
    if (!s) return 'unknown';
    if (s.has_changes || s.ahead > 0) return 'pending';
    return 'clean';
  });

  readonly summary = computed(() => {
    const s = this.status();
    if (!s) return 'sin estado';
    if (s.has_changes) return `${s.changed} cambio${s.changed === 1 ? '' : 's'} sin guardar`;
    if (s.ahead > 0) return `${s.ahead} commit${s.ahead === 1 ? '' : 's'} sin pushear`;
    if (s.behind > 0) return `${s.behind} commit${s.behind === 1 ? '' : 's'} en remoto`;
    return s.branch ? `sincronizado · ${s.branch}` : 'sincronizado';
  });

  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const root = this.settings.root();
      this.stopTimers();
      if (root) {
        void this.refreshStatus();
        this.startTimers();
      } else {
        this.status.set(null);
      }
    });
  }

  async refreshStatus(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    try {
      const s = await invoke<GitStatus>('git_status', { repoPath: root });
      this.status.set(s);
      this.error.set(null);
    } catch (err) {
      this.status.set(null);
      this.error.set(String(err));
    }
  }

  /** commit + push si hay cambios o commits locales pendientes. */
  async syncNow(message?: string): Promise<void> {
    const root = this.settings.root();
    if (!root || this.syncing()) return;
    this.currentOp.set('sync');
    this.error.set(null);
    try {
      const msg = message ?? this.defaultMessage();
      const commitRes = await invoke<GitCommitResult>('git_commit_all', {
        repoPath: root,
        message: msg,
      });
      if (commitRes.committed) {
        this.lastCommitInfo.set(`${commitRes.files} archivo${commitRes.files === 1 ? '' : 's'}`);
      }
      await this.refreshStatus();
      const s = this.status();
      if (s && s.ahead > 0) {
        await invoke('git_push', { repoPath: root });
      }
      await this.refreshStatus();
      this.lastSyncAt.set(Date.now());
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.currentOp.set(null);
    }
  }

  async pull(): Promise<void> {
    const root = this.settings.root();
    if (!root || this.syncing()) return;
    this.currentOp.set('pull');
    this.error.set(null);
    try {
      await invoke('git_pull', { repoPath: root });
      await this.refreshStatus();
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.currentOp.set(null);
    }
  }

  private startTimers(): void {
    this.statusTimer = setInterval(() => void this.refreshStatus(), STATUS_REFRESH_MS);
    this.commitTimer = setInterval(() => {
      const s = this.status();
      if (s && (s.has_changes || s.ahead > 0)) {
        void this.syncNow();
      }
    }, AUTO_COMMIT_MS);
  }

  private stopTimers(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.commitTimer) clearInterval(this.commitTimer);
    this.statusTimer = null;
    this.commitTimer = null;
  }

  private defaultMessage(): string {
    const now = new Date();
    const d = now.toISOString().slice(0, 16).replace('T', ' ');
    return `auto: ${d}`;
  }
}
