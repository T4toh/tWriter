import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from '../core/settings-service';
import { StorageHelpService } from '../core/storage-help-service';
import { StorageService } from '../core/storage-service';
import { ToastService } from '../core/toast-service';

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
  private toast = inject(ToastService);

  protected readonly root = computed(() => this.settings.root() ?? '~/Novelas');

  /** Abre una terminal del sistema parada en la carpeta de la novela. Si no
   *  hay ninguna, el `cd` copiable del paso 1 sigue ahí como remedio. */
  protected async openTerminal(): Promise<void> {
    try {
      await invoke<string>('open_terminal', { dir: this.root() });
    } catch (e) {
      this.toast.error(`No pude abrir una terminal: ${e}`);
    }
  }

  protected close(): void {
    this.help.close();
    // Re-detectar: si el usuario corrió `git init` afuera, el badge se actualiza
    // sin necesidad de reabrir la carpeta.
    void this.storage.refresh();
  }
}
