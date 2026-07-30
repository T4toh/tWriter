import { ChangeDetectionStrategy, Component, OnDestroy, input, signal } from '@angular/core';

/** Ventana del "copiado ✓". 2s: alcanza para leerlo y no queda pegado. */
const COPIED_MS = 2000;

/**
 * Comando pelado + botón de copiar. Existe para que el usuario pueda copiar el
 * comando sin arrastrar la prosa que lo explica (ver la convención "el remedio
 * se da adentro de la app" en CLAUDE.md).
 */
@Component({
  selector: 'app-copy-command',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <code class="cc-cmd">{{ command() }}</code>
    <button
      type="button"
      class="cc-btn"
      [attr.aria-label]="'Copiar el comando ' + command()"
      (click)="copy()"
    >
      <span aria-live="polite">{{ copied() ? 'copiado ✓' : 'copiar' }}</span>
    </button>
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      /* Adentro de .docker-panel (flex-direction: column, align-items:
         stretch por default) el host es un flex item estirado, así que sin
         esto el chip ocupa todo el ancho del panel en vez de abrazar el
         comando. */
      align-self: flex-start;
    }
    .cc-cmd {
      font-family: var(--font-mono);
      font-size: 11px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 3px 6px;
      user-select: all;
      overflow-x: auto;
      white-space: nowrap;
    }
    .cc-btn {
      flex: none;
      font-size: 11px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 3px;
      background: transparent;
      color: var(--fg-muted);
      cursor: pointer;
    }
    .cc-btn:hover {
      color: var(--fg);
      border-color: var(--accent);
    }
  `],
})
export class CopyCommand implements OnDestroy {
  readonly command = input.required<string>();

  protected readonly copied = signal<boolean>(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.command());
    } catch {
      // Sin permiso de clipboard. El `user-select: all` del <code> deja
      // seleccionarlo con un click, así que no dejamos al usuario sin salida.
      return;
    }
    this.copied.set(true);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.copied.set(false), COPIED_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
