import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ExtraEntry } from './extras-service';

interface ImageData {
  mime: string;
  base64: string;
}

@Injectable({ providedIn: 'root' })
export class ImageViewerService {
  readonly viewing = signal<ExtraEntry | null>(null);
  readonly dataUrl = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async open(entry: ExtraEntry): Promise<void> {
    this.viewing.set(entry);
    this.dataUrl.set(null);
    this.error.set(null);
    this.loading.set(true);
    try {
      const img = await invoke<ImageData>('read_image', { path: entry.path });
      if (this.viewing()?.path !== entry.path) return;
      this.dataUrl.set(`data:${img.mime};base64,${img.base64}`);
    } catch (e) {
      if (this.viewing()?.path !== entry.path) return;
      this.error.set(String(e));
    } finally {
      if (this.viewing()?.path === entry.path) {
        this.loading.set(false);
      }
    }
  }

  close(): void {
    this.viewing.set(null);
    this.dataUrl.set(null);
    this.error.set(null);
    this.loading.set(false);
  }

  isOpen(): boolean {
    return this.viewing() !== null;
  }
}
