import { Component, EventEmitter, Output, inject } from '@angular/core';
import { DebugEntry, DebugLevel, DebugService } from '../core/debug-service';

@Component({
  selector: 'app-debug-panel',
  imports: [],
  templateUrl: './debug-panel.html',
  styleUrl: './debug-panel.scss',
})
export class DebugPanel {
  @Output() snapshotRequested = new EventEmitter<void>();

  protected debug = inject(DebugService);

  protected readonly entries = this.debug.entries;
  protected readonly filtered = this.debug.filtered;
  protected readonly visible = this.debug.visible;
  protected readonly levelFilter = this.debug.levelFilter;
  protected readonly sourceFilter = this.debug.sourceFilter;

  protected readonly levels: DebugLevel[] = ['info', 'warn', 'error'];

  protected copyOk = false;

  protected close(): void {
    this.debug.toggle();
  }

  protected clear(): void {
    this.debug.clear();
  }

  protected toggleLevel(level: DebugLevel): void {
    this.debug.toggleLevel(level);
  }

  protected isLevelOn(level: DebugLevel): boolean {
    return this.levelFilter().has(level);
  }

  protected onSourceInput(event: Event): void {
    const v = (event.target as HTMLInputElement).value;
    this.debug.setSourceFilter(v);
  }

  protected async copy(): Promise<void> {
    const text = this.filtered()
      .map((e) => {
        const ts = this.formatTime(e.ts);
        const head = `${ts} [${e.source}] ${e.level.toUpperCase()}: ${e.message}`;
        return e.details ? `${head}\n${e.details}` : head;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.copyOk = true;
      setTimeout(() => (this.copyOk = false), 1500);
    } catch {
      // sin clipboard permissions o contexto inseguro — silent
    }
  }

  protected requestSnapshot(): void {
    this.snapshotRequested.emit();
  }

  protected formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-AR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  protected trackEntry(_: number, e: DebugEntry): number {
    return e.ts;
  }
}
