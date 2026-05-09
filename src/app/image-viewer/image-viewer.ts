import { Component, HostListener, inject } from '@angular/core';
import { ImageViewerService } from '../core/image-viewer-service';

@Component({
  selector: 'app-image-viewer',
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.scss',
})
export class ImageViewer {
  private svc = inject(ImageViewerService);

  protected readonly viewing = this.svc.viewing;
  protected readonly dataUrl = this.svc.dataUrl;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;

  protected close(): void {
    this.svc.close();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.svc.isOpen()) this.svc.close();
  }
}
