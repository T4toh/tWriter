import { Component, inject } from '@angular/core';
import { ToastService } from '../core/toast-service';

@Component({
  selector: 'app-toast-container',
  imports: [],
  templateUrl: './toast-container.html',
  styleUrl: './toast-container.scss',
})
export class ToastContainer {
  protected toast = inject(ToastService);
  protected dismiss(id: number): void {
    this.toast.dismiss(id);
  }
}
