import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsService } from '../core/settings-service';
import { StorageHelpService } from '../core/storage-help-service';
import { StorageService } from '../core/storage-service';

@Component({
  selector: 'app-storage-help-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './storage-help-modal.html',
  styleUrl: './storage-help-modal.scss',
})
export class StorageHelpModal {
  private settings = inject(SettingsService);
  private storage = inject(StorageService);
  protected help = inject(StorageHelpService);

  protected readonly root = computed(() => this.settings.root() ?? '~/Novelas');

  protected close(): void {
    this.help.close();
    // Re-detectar: si el usuario corrió `git init` afuera, el badge se actualiza
    // sin necesidad de reabrir la carpeta.
    void this.storage.refresh();
  }
}
