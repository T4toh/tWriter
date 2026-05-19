import { Component, inject } from '@angular/core';
import { LucideX } from '@lucide/angular';
import { UpdaterService } from '../core/updater-service';

@Component({
  selector: 'app-update-banner',
  imports: [LucideX],
  templateUrl: './update-banner.html',
  styleUrl: './update-banner.scss',
})
export class UpdateBanner {
  protected updater = inject(UpdaterService);

  protected aplicar(): void {
    void this.updater.aplicar();
  }

  protected descartar(): void {
    this.updater.descartar();
  }
}
