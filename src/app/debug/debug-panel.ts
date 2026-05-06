import { Component, inject } from '@angular/core';
import { DebugEntry, DebugService } from '../core/debug-service';

@Component({
  selector: 'app-debug-panel',
  imports: [],
  templateUrl: './debug-panel.html',
  styleUrl: './debug-panel.scss',
})
export class DebugPanel {
  protected debug = inject(DebugService);

  protected readonly entries = this.debug.entries;
  protected readonly visible = this.debug.visible;

  protected close(): void {
    this.debug.toggle();
  }

  protected clear(): void {
    this.debug.clear();
  }

  protected formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-AR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  protected trackEntry(_: number, e: DebugEntry): number {
    return e.ts;
  }
}
