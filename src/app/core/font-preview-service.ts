import { Injectable, signal } from '@angular/core';
import { FontEntry } from './types';

@Injectable({ providedIn: 'root' })
export class FontPreviewService {
  readonly viewing = signal<FontEntry | null>(null);

  open(entry: FontEntry): void {
    this.viewing.set(entry);
  }

  close(): void {
    this.viewing.set(null);
  }

  isOpen(): boolean {
    return this.viewing() !== null;
  }
}
