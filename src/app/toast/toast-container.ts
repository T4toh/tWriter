import { Component, inject } from '@angular/core';
import { Toast, ToastService } from '../core/toast-service';
import { ModalService } from '../shared/modal-service';

@Component({
  selector: 'app-toast-container',
  imports: [],
  templateUrl: './toast-container.html',
  styleUrl: './toast-container.scss',
})
export class ToastContainer {
  protected toast = inject(ToastService);
  private modal = inject(ModalService);

  /** Un toast con detalle lo abre en vez de cerrarse: el click accidental que
   *  antes tiraba el mensaje a la basura ahora muestra lo que decía. El toast
   *  queda igual —su timer sigue corriendo— así que el detalle es una lectura
   *  aparte, no un reemplazo. */
  protected onClick(t: Toast): void {
    if (t.detalle) {
      void this.modal.alert({
        title: t.detalle.titulo,
        message: t.detalle.texto,
        variant: t.level === 'error' ? 'error' : 'info',
      });
      return;
    }
    this.toast.dismiss(t.id);
  }
}
