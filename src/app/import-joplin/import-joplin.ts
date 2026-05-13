import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImportJoplinService } from '../core/import-joplin-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SettingsService } from '../core/settings-service';

@Component({
  selector: 'app-import-joplin',
  imports: [FormsModule],
  templateUrl: './import-joplin.html',
  styleUrl: './import-joplin.scss',
})
export class ImportJoplin {
  protected wizard = inject(ImportJoplinService);
  protected settings = inject(SettingsService);
  private dialogs = inject(NativeDialogsService);

  protected readonly stepIndex = computed(() => {
    switch (this.wizard.step()) {
      case 'source':
        return 1;
      case 'preview':
        return 2;
      case 'progreso':
        return 3;
      case 'completo':
        return 3;
    }
  });
  protected readonly totalSteps = computed(() => 3);

  protected close(): void {
    if (this.wizard.applying()) return;
    this.wizard.close();
  }

  protected async pickSource(): Promise<void> {
    const path = await this.dialogs.pickFolder({
      title: 'Elegí la carpeta del export Joplin',
    });
    if (!path) return;
    await this.wizard.scan(path);
  }

  protected back(): void {
    if (this.wizard.applying()) return;
    if (this.wizard.step() === 'preview') {
      this.wizard.step.set('source');
    }
  }

  protected apply(): void {
    void this.wizard.apply();
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
