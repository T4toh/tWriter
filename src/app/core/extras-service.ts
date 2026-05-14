import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export type ExtraKind = 'image' | 'document' | 'text' | 'other';

export interface ExtraEntry {
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number;
  kind: ExtraKind;
  ext?: string | null;
}

export interface ExtrasDirNode {
  type: 'dir';
  name: string;
  relativePath: string;
  children: ExtrasNode[];
}

export interface ExtrasFileNode {
  type: 'file';
  name: string;
  relativePath: string;
  entry: ExtraEntry;
}

export type ExtrasNode = ExtrasDirNode | ExtrasFileNode;

export function buildExtrasTree(entries: ExtraEntry[]): ExtrasNode[] {
  const root: ExtrasNode[] = [];
  const dirByPath = new Map<string, ExtrasDirNode>();
  for (const e of entries) {
    const parts = e.relative_path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parentChildren = root;
    let parentRel = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirRel = parentRel ? `${parentRel}/${part}` : part;
      let node = dirByPath.get(dirRel);
      if (!node) {
        node = { type: 'dir', name: part, relativePath: dirRel, children: [] };
        dirByPath.set(dirRel, node);
        parentChildren.push(node);
      }
      parentChildren = node.children;
      parentRel = dirRel;
    }
    parentChildren.push({
      type: 'file',
      name: parts[parts.length - 1],
      relativePath: e.relative_path,
      entry: e,
    });
  }
  const sortRec = (nodes: ExtrasNode[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.type === 'dir') sortRec(n.children);
  };
  sortRec(root);
  return root;
}

@Injectable({ providedIn: 'root' })
export class ExtrasService {
  /** Map de scopePath → entries cacheadas. Bumpea con cada list. */
  private readonly cache = signal<Map<string, ExtraEntry[]>>(new Map());

  /** Devuelve la lista cacheada (vacía si nunca se cargó). */
  get(scopePath: string): ExtraEntry[] {
    return this.cache().get(scopePath) ?? [];
  }

  /** Devuelve true si se cargó alguna vez (incluso si está vacía). */
  hasLoaded(scopePath: string): boolean {
    return this.cache().has(scopePath);
  }

  async refresh(scopePath: string): Promise<ExtraEntry[]> {
    const entries = await invoke<ExtraEntry[]>('list_extras', { scopePath });
    this.cache.update((m) => {
      const next = new Map(m);
      next.set(scopePath, entries);
      return next;
    });
    return entries;
  }

  async addFromPath(
    scopePath: string,
    sourcePath: string,
    targetName?: string,
  ): Promise<ExtraEntry> {
    const entry = await invoke<ExtraEntry>('add_extra', {
      scopePath,
      sourcePath,
      targetName: targetName ?? null,
    });
    await this.refresh(scopePath);
    return entry;
  }

  async remove(scopePath: string, relativePath: string): Promise<void> {
    await invoke('remove_extra', { scopePath, relativePath });
    await this.refresh(scopePath);
  }

  async rename(
    scopePath: string,
    relativePath: string,
    newName: string,
  ): Promise<ExtraEntry> {
    const entry = await invoke<ExtraEntry>('rename_extra', {
      scopePath,
      relativePath,
      newName,
    });
    await this.refresh(scopePath);
    return entry;
  }

  /** Olvida todo el cache. Llamar al cambiar de root. */
  clear(): void {
    this.cache.set(new Map());
  }
}
