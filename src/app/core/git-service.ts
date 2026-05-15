import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from './settings-service';
import { StorageService } from './storage-service';

export interface GitError {
  /** Mensaje corto y amigable en español, mostrado en la status bar. */
  friendly: string;
  /** Stderr crudo de git (o detalle del backend). Visible en el `<details>`. */
  raw: string;
}

export type GitErrorCategory =
  | 'auth'
  | 'network'
  | 'conflict'
  | 'rejected'
  | 'unknown';

const FRIENDLY: Record<GitErrorCategory, string> = {
  auth: 'No se pudo autenticar contra el remoto. Revisá la clave SSH o el token.',
  network: 'Sin conexión al remoto. Reintentamos en 30 s.',
  conflict: 'Conflicto entre esta PC y el remoto. Abrí los detalles para ver qué archivo.',
  rejected:
    'El remoto avanzó y reintentamos rebasear automáticamente. Si volvés a ver este mensaje, abrí los detalles.',
  unknown: 'Falló el sync. Abrí los detalles para ver el error.',
};

/** Parsea el prefijo `category: stderr` que el backend devuelve y arma el
 *  `GitError` para la UI. Si no matchea ninguna categoría, queda como
 *  `unknown` con el string entero como `raw`. */
export function toGitError(raw: unknown): GitError {
  const s = String(raw ?? '');
  const m = s.match(/^(auth|network|conflict|rejected|unknown):\s*(.*)$/s);
  if (m) {
    const cat = m[1] as GitErrorCategory;
    return { friendly: FRIENDLY[cat], raw: m[2] || s };
  }
  return { friendly: FRIENDLY.unknown, raw: s };
}

export interface GitStatusPath {
  path: string;
  kind: 'new' | 'modified' | 'deleted' | 'renamed' | 'typechange' | 'conflicted';
}

export interface GitStatus {
  has_changes: boolean;
  changed: number;
  ahead: number;
  behind: number;
  branch: string | null;
  remote: string | null;
  paths: GitStatusPath[];
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

/** Item del listado agrupado que ve el usuario. Un `chapter` colapsa el par
 *  `<n>.html` + `<n>.meta.json`, así "1 capítulo" se cuenta como 1 unidad
 *  semántica aunque sean 2 archivos en git. */
export interface GroupedChange {
  /** `chapter`: par html+meta. `book-meta`: book.json / saga.json. `other`: cualquier otro. */
  kind: 'chapter' | 'book-meta' | 'other';
  /** Path del archivo principal (el `.html` si es capítulo). */
  primary: string;
  /** Todos los paths físicos asociados (incluye `.meta.json` si aplica). */
  files: string[];
  /** Etiqueta corta del cambio: `nuevo`, `editado`, `borrado`, `renombrado`. */
  label: string;
}

export interface GroupedSummary {
  chapters: GroupedChange[];
  bookMeta: GroupedChange[];
  other: GroupedChange[];
  total: number;
}

const STATUS_REFRESH_MS = 30_000;
const AUTO_COMMIT_MS = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class GitService {
  private settings = inject(SettingsService);
  private storage = inject(StorageService);

  readonly status = signal<GitStatus | null>(null);
  readonly currentOp = signal<'sync' | 'pull' | null>(null);
  readonly syncing = computed<boolean>(() => this.currentOp() !== null);
  readonly error = signal<GitError | null>(null);
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

  /** Agrupa `status.paths` por capítulo / book-meta / other. */
  readonly grouped = computed<GroupedSummary | null>(() => {
    const s = this.status();
    if (!s || !s.paths.length) return null;
    return groupPaths(s.paths);
  });

  readonly summary = computed(() => {
    const s = this.status();
    if (!s) return 'sin estado';
    if (s.has_changes) {
      const g = this.grouped();
      if (g) return summarizeGroups(g);
      return `${s.changed} cambio${s.changed === 1 ? '' : 's'} sin guardar`;
    }
    if (s.ahead > 0) return `${s.ahead} commit${s.ahead === 1 ? '' : 's'} sin pushear`;
    if (s.behind > 0) return `${s.behind} commit${s.behind === 1 ? '' : 's'} en remoto`;
    return s.branch ? `sincronizado · ${s.branch}` : 'sincronizado';
  });

  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private autoFailCount = 0;
  private autoPaused = false;
  private autoPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private autoPullInflight = false;
  private ensuredForRoot: string | null = null;

  constructor() {
    effect(() => {
      const root = this.settings.root();
      // Leemos `backend()` directo (no `isGit()`) para distinguir 'unknown'
      // (detect en vuelo) de un backend ya resuelto != git. Sin esto, al boot
      // entrábamos al `else` con `isGit=false` mientras detect estaba en
      // vuelo, dejando timers apagados; cuando backend resolvía a 'git' el
      // effect re-corría pero la UI podía quedar en "sin estado" si algo
      // cortaba la re-evaluación (race documentada en README:536).
      const backend = this.storage.backend();
      this.stopTimers();
      this.status.set(null);
      this.error.set(null);
      if (!root || backend === 'unknown') {
        // 'unknown' = detect en vuelo. Esperamos al próximo re-run del effect
        // sin tocar `ensuredForRoot`, así no re-disparamos
        // `git_ensure_twriter_ignored` si backend termina resolviendo a 'git'
        // sobre el mismo root.
        if (!root) this.ensuredForRoot = null;
        return;
      }
      if (backend !== 'git') {
        this.ensuredForRoot = null;
        return;
      }
      if (this.ensuredForRoot !== root) {
        this.ensuredForRoot = root;
        void invoke('git_ensure_twriter_ignored', { repoPath: root }).catch((err) => {
          console.warn('git_ensure_twriter_ignored failed', err);
        });
      }
      void this.refreshStatus();
      this.startTimers();
    });
  }

  async refreshStatus(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    try {
      const s = await invoke<GitStatus>('git_status', { repoPath: root });
      this.status.set(s);
      this.error.set(null);
      if (
        !this.autoPaused &&
        !this.autoPullInflight &&
        !this.syncing() &&
        s.behind > 0
      ) {
        void this.autoPull(s);
      }
    } catch (err) {
      this.status.set(null);
      this.error.set(toGitError(err));
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
      this.resetThrottle();
    } catch (err) {
      this.error.set(toGitError(err));
    } finally {
      this.currentOp.set(null);
    }
  }

  /** Pull manual. Antes usaba siempre `--ff-only` y fallaba cuando había
   *  commits locales; ahora replica la lógica del auto-pull: si `ahead===0`
   *  usa ff-only, si no usa rebase --autostash. */
  async pull(): Promise<void> {
    const root = this.settings.root();
    if (!root || this.syncing()) return;
    this.currentOp.set('pull');
    this.error.set(null);
    try {
      // Si no tenemos status aún, lo pedimos antes de decidir el comando.
      let s = this.status();
      if (!s) {
        s = await invoke<GitStatus>('git_status', { repoPath: root });
        this.status.set(s);
      }
      const cmd = s.ahead > 0 ? 'git_pull_rebase' : 'git_pull';
      await invoke(cmd, { repoPath: root });
      await this.refreshStatus();
      this.resetThrottle();
    } catch (err) {
      this.error.set(toGitError(err));
    } finally {
      this.currentOp.set(null);
    }
  }

  private async autoPull(s: GitStatus): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    this.autoPullInflight = true;
    try {
      if (s.ahead === 0) {
        await invoke('git_pull', { repoPath: root });
      } else {
        await invoke('git_pull_rebase', { repoPath: root });
      }
      this.resetThrottle();
      this.error.set(null);
      await this.refreshStatus();
    } catch (err) {
      const e = toGitError(err);
      const raw = String(err);
      if (raw.startsWith('conflict:')) {
        this.error.set(e);
        this.pauseAutoLoop();
      } else {
        this.autoFailCount += 1;
        if (this.autoFailCount >= 3) {
          this.error.set(e);
          this.pauseAutoLoop();
        }
      }
    } finally {
      this.autoPullInflight = false;
    }
  }

  private pauseAutoLoop(): void {
    this.autoPaused = true;
    if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
    this.autoPauseTimer = setTimeout(() => {
      this.autoPaused = false;
      this.autoFailCount = 0;
    }, 5 * 60_000);
  }

  private resetThrottle(): void {
    this.autoFailCount = 0;
    if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
    this.autoPauseTimer = null;
    this.autoPaused = false;
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
    if (this.autoPauseTimer) clearTimeout(this.autoPauseTimer);
    this.autoPauseTimer = null;
    this.autoPaused = false;
    this.autoFailCount = 0;
    this.autoPullInflight = false;
  }

  private defaultMessage(): string {
    const now = new Date();
    const d = now.toISOString().slice(0, 16).replace('T', ' ');
    return `auto: ${d}`;
  }
}

// ─────────── Helpers de agrupamiento ───────────

function groupPaths(paths: GitStatusPath[]): GroupedSummary {
  // Mapa por stem (path sin extensión y sin `.meta.json`) para colapsar
  // pares html+meta. Mantiene insertion order para mostrar un listado estable.
  const byStem = new Map<string, { files: GitStatusPath[]; primary: string }>();
  const bookMeta: GroupedChange[] = [];
  const other: GroupedChange[] = [];

  for (const p of paths) {
    const fileName = p.path.split('/').pop() ?? p.path;
    if (fileName === 'book.json' || fileName === 'saga.json') {
      bookMeta.push({
        kind: 'book-meta',
        primary: p.path,
        files: [p.path],
        label: labelOf(p.kind),
      });
      continue;
    }
    const stem = chapterStem(p.path);
    if (stem) {
      const entry = byStem.get(stem) ?? { files: [], primary: '' };
      entry.files.push(p);
      // Preferir `.html` como primary; si todavía no lo vimos, usar el primero.
      if (p.path.endsWith('.html')) {
        entry.primary = p.path;
      } else if (!entry.primary) {
        entry.primary = p.path;
      }
      byStem.set(stem, entry);
      continue;
    }
    other.push({
      kind: 'other',
      primary: p.path,
      files: [p.path],
      label: labelOf(p.kind),
    });
  }

  const chapters: GroupedChange[] = [];
  for (const entry of byStem.values()) {
    // El label del grupo es el del primary (html si existe, sino el primero).
    const primaryEntry =
      entry.files.find((f) => f.path === entry.primary) ?? entry.files[0];
    chapters.push({
      kind: 'chapter',
      primary: entry.primary,
      files: entry.files.map((f) => f.path),
      label: labelOf(primaryEntry.kind),
    });
  }

  return {
    chapters,
    bookMeta,
    other,
    total: chapters.length + bookMeta.length + other.length,
  };
}

/** Si el path corresponde a un capítulo (html o meta sibling), devuelve el
 *  stem absoluto (sin extensión). Sino null. */
function chapterStem(p: string): string | null {
  if (p.endsWith('.meta.json')) {
    return p.slice(0, -'.meta.json'.length);
  }
  if (p.endsWith('.html')) {
    return p.slice(0, -'.html'.length);
  }
  return null;
}

function labelOf(kind: GitStatusPath['kind']): string {
  switch (kind) {
    case 'new':
      return 'nuevo';
    case 'deleted':
      return 'borrado';
    case 'renamed':
      return 'renombrado';
    case 'conflicted':
      return 'conflicto';
    case 'typechange':
      return 'tipo cambiado';
    case 'modified':
    default:
      return 'editado';
  }
}

function summarizeGroups(g: GroupedSummary): string {
  const parts: string[] = [];
  if (g.chapters.length) {
    parts.push(
      `${g.chapters.length} capítulo${g.chapters.length === 1 ? '' : 's'} modificado${g.chapters.length === 1 ? '' : 's'}`,
    );
  }
  if (g.bookMeta.length) {
    parts.push(
      `${g.bookMeta.length} metadato${g.bookMeta.length === 1 ? '' : 's'} de libro`,
    );
  }
  if (g.other.length) {
    parts.push(`${g.other.length} archivo${g.other.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ') || 'sin cambios';
}
