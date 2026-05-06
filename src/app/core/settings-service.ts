import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

export type EditorWidth = 'narrow' | 'wide' | 'full';

const FONT_MIN = 12;
const FONT_MAX = 28;
const FONT_DEFAULT = 17;

interface Settings {
  root: string | null;
  editorWidth?: EditorWidth;
  editorFontSize?: number;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly root = signal<string | null>(null);
  readonly editorWidth = signal<EditorWidth>('narrow');
  readonly editorFontSize = signal<number>(FONT_DEFAULT);
  readonly loaded = signal<boolean>(false);

  async load(): Promise<void> {
    try {
      const s = await invoke<Settings>('get_settings');
      this.root.set(s.root ?? null);
      this.editorWidth.set(s.editorWidth ?? 'narrow');
      this.editorFontSize.set(clampFont(s.editorFontSize ?? FONT_DEFAULT));
    } catch {
      this.root.set(null);
    } finally {
      this.loaded.set(true);
    }
  }

  async setRoot(path: string): Promise<void> {
    this.root.set(path);
    await this.persist();
  }

  async setEditorWidth(width: EditorWidth): Promise<void> {
    this.editorWidth.set(width);
    await this.persist();
  }

  cycleEditorWidth(): void {
    const order: EditorWidth[] = ['narrow', 'wide', 'full'];
    const next = order[(order.indexOf(this.editorWidth()) + 1) % order.length];
    void this.setEditorWidth(next);
  }

  bumpFontSize(delta: number): void {
    const next = clampFont(this.editorFontSize() + delta);
    if (next === this.editorFontSize()) return;
    this.editorFontSize.set(next);
    void this.persist();
  }

  private async persist(): Promise<void> {
    const settings: Settings = {
      root: this.root(),
      editorWidth: this.editorWidth(),
      editorFontSize: this.editorFontSize(),
    };
    await invoke('set_settings', { settings });
  }

  async pickRoot(): Promise<string | null> {
    const result = await open({
      directory: true,
      multiple: false,
      title: 'Carpeta raíz de novelas',
      defaultPath: this.root() ?? undefined,
    });
    if (typeof result !== 'string') {
      return null;
    }
    await this.setRoot(result);
    return result;
  }
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}
