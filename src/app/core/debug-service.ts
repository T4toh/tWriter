import { Injectable, computed, signal } from '@angular/core';

export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEntry {
  ts: number;
  level: DebugLevel;
  source: string;
  message: string;
  details?: string;
}

const MAX_ENTRIES = 200;
const ENTRIES_KEY = 'twriter-debug-entries-v1';
const VISIBLE_KEY = 'twriter-debug-visible-v1';
const LEVELS_KEY = 'twriter-debug-levels-v1';
const SOURCE_KEY = 'twriter-debug-source-v1';

const DEFAULT_LEVELS: DebugLevel[] = ['info', 'warn', 'error'];

/**
 * Sink puro para eventos de debug. Sin inyecciones — se evita ciclo DI con
 * los servicios que la consumen (chapter, etc). Las suscripciones a errores
 * de servicios se cablean en el App component.
 */
@Injectable({ providedIn: 'root' })
export class DebugService {
  readonly entries = signal<DebugEntry[]>(loadEntries());
  readonly visible = signal<boolean>(loadVisible());
  readonly levelFilter = signal<Set<DebugLevel>>(new Set(loadLevels()));
  readonly sourceFilter = signal<string>(loadSource());

  readonly filtered = computed(() => {
    const lvls = this.levelFilter();
    const needle = this.sourceFilter().trim().toLowerCase();
    return this.entries().filter(
      (e) => lvls.has(e.level) && (needle === '' || e.source.toLowerCase().includes(needle)),
    );
  });

  log(level: DebugLevel, source: string, message: string, details?: string): void {
    const entry: DebugEntry = {
      ts: Date.now(),
      level,
      source,
      message,
      details,
    };
    this.entries.update((es) => {
      const next = [entry, ...es].slice(0, MAX_ENTRIES);
      persist(ENTRIES_KEY, JSON.stringify(next));
      return next;
    });
  }

  info(source: string, message: string, details?: string): void {
    this.log('info', source, message, details);
  }

  warn(source: string, message: string, details?: string): void {
    this.log('warn', source, message, details);
  }

  error(source: string, message: string, details?: string): void {
    this.log('error', source, message, details);
  }

  /** Push a snapshot/dump entry with pretty-printed JSON details. */
  snapshot(label: string, data: Record<string, unknown>): void {
    let body: string;
    try {
      body = JSON.stringify(data, null, 2);
    } catch (e) {
      body = `(no serializable: ${String(e)})`;
    }
    this.log('info', 'snapshot', label, body);
  }

  clear(): void {
    this.entries.set([]);
    persist(ENTRIES_KEY, '[]');
  }

  toggle(): void {
    this.visible.update((v) => {
      const next = !v;
      persist(VISIBLE_KEY, next ? '1' : '0');
      return next;
    });
  }

  toggleLevel(level: DebugLevel): void {
    this.levelFilter.update((s) => {
      const next = new Set(s);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      persist(LEVELS_KEY, JSON.stringify(Array.from(next)));
      return next;
    });
  }

  setSourceFilter(value: string): void {
    this.sourceFilter.set(value);
    persist(SOURCE_KEY, value);
  }
}

function persist(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // quota / disabled — silently ignore
  }
}

function loadEntries(): DebugEntry[] {
  try {
    const raw = sessionStorage.getItem(ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDebugEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function loadVisible(): boolean {
  try {
    return sessionStorage.getItem(VISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadLevels(): DebugLevel[] {
  try {
    const raw = sessionStorage.getItem(LEVELS_KEY);
    if (!raw) return DEFAULT_LEVELS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_LEVELS;
    const out = parsed.filter(
      (v): v is DebugLevel => v === 'info' || v === 'warn' || v === 'error',
    );
    return out.length > 0 ? out : DEFAULT_LEVELS;
  } catch {
    return DEFAULT_LEVELS;
  }
}

function loadSource(): string {
  try {
    return sessionStorage.getItem(SOURCE_KEY) ?? '';
  } catch {
    return '';
  }
}

function isDebugEntry(v: unknown): v is DebugEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['ts'] === 'number' &&
    (o['level'] === 'info' || o['level'] === 'warn' || o['level'] === 'error') &&
    typeof o['source'] === 'string' &&
    typeof o['message'] === 'string'
  );
}
