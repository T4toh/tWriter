import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { LucideBell, LucideTrash2, LucideX } from '@lucide/angular';
import { ToastHistorico, ToastService } from '../core/toast-service';
import { ModalService } from '../shared/modal-service';

/** Campana de la status bar, al lado de "guardado". Los avisos se van solos a
 *  los 4 segundos y el autor no siempre está mirando; acá queda lo que pasó.
 *
 *  Las entradas **las borra el autor** —una por una o con "Limpiar todo"—, no
 *  se vencen. El tope de `MAX_HISTORIAL` es una red, no una política.
 *
 *  No lleva badge de "no leídas": se ofreció y no se pidió. Si alguna vez hace
 *  falta, es un contador que se resetea en `toggle()`. */
@Component({
  selector: 'app-notificaciones-bell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, LucideBell, LucideTrash2, LucideX],
  template: `
    <button
      type="button"
      class="bell-btn"
      [class.active]="open()"
      (click)="toggle($event)"
      [title]="titulo()"
    >
      <svg lucideBell [size]="13"></svg>
    </button>

    @if (open()) {
      <div class="notif-panel" (click)="$event.stopPropagation()">
        <header class="notif-head">
          <span class="notif-title">Notificaciones</span>
          @if (historial().length > 0) {
            <button
              type="button"
              class="notif-clear"
              (click)="toast.limpiarHistorial()"
              title="Limpiar todo"
            >
              <svg lucideTrash2 [size]="12"></svg>
              Limpiar todo
            </button>
          }
        </header>

        @if (historial(); as lista) {
          @if (lista.length === 0) {
            <p class="notif-vacio">Sin notificaciones</p>
          } @else {
            <ul class="notif-list">
              @for (n of lista; track n.id) {
                <li class="notif-item" [attr.data-level]="n.level">
                  <div class="notif-cuerpo">
                    <span class="notif-hora">{{ n.ts | date: 'HH:mm' }}</span>
                    <span class="notif-msg">{{ n.message }}</span>
                  </div>
                  <div class="notif-acciones">
                    @if (n.detalle) {
                      <button type="button" class="notif-link" (click)="verDetalle(n)">
                        ver detalle
                      </button>
                    }
                    @if (n.accion; as a) {
                      <button type="button" class="notif-link" (click)="correr(n)">
                        {{ a.label }}
                      </button>
                    }
                  </div>
                  <button
                    type="button"
                    class="notif-x"
                    (click)="toast.olvidar(n.id)"
                    title="Borrar esta notificación"
                  >
                    <svg lucideX [size]="12"></svg>
                  </button>
                </li>
              }
            </ul>
          }
        }
      </div>
    }
  `,
  styleUrl: './notificaciones-bell.scss',
})
export class NotificacionesBell {
  protected toast = inject(ToastService);
  private modal = inject(ModalService);
  private elRef = inject(ElementRef<HTMLElement>);

  protected readonly open = signal(false);
  protected readonly historial = this.toast.historial;
  protected readonly titulo = computed(() => {
    const n = this.historial().length;
    if (n === 0) return 'Notificaciones (ninguna)';
    return `Notificaciones (${n})`;
  });

  protected toggle(event: MouseEvent): void {
    // Sin esto el mismo click que abre el panel llega a `onDocClick` y lo
    // cierra en el acto.
    event.stopPropagation();
    this.open.update((v) => !v);
  }

  protected verDetalle(n: ToastHistorico): void {
    if (!n.detalle) return;
    void this.modal.alert({
      title: n.detalle.titulo,
      message: n.detalle.texto,
      variant: n.level === 'error' ? 'error' : 'info',
    });
  }

  /** Correr la acción la consume: un "Deshacer" que se puede tocar dos veces
   *  es un segundo problema. La entrada se va del historial con ella. */
  protected correr(n: ToastHistorico): void {
    n.accion?.run();
    this.toast.olvidar(n.id);
  }

  @HostListener('document:click', ['$event'])
  protected onDocClick(event: MouseEvent): void {
    if (!this.open()) return;
    if (this.elRef.nativeElement.contains(event.target as Node)) return;
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEsc(): void {
    this.open.set(false);
  }
}
