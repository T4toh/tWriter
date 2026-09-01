import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { AutorConfig, AutorService } from '../core/autor-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SettingsService } from '../core/settings-service';

@Component({
  selector: 'app-autor-modal',
  imports: [FormsModule],
  templateUrl: './autor-modal.html',
  styleUrl: './autor-modal.scss',
})
export class AutorModal {
  private svc = inject(AutorService);
  private dialogs = inject(NativeDialogsService);
  private settings = inject(SettingsService);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<AutorConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (!this.editing()) return;
      void this.svc
        .load()
        .then((cfg) => this.config.set(cfg))
        .catch((e) => this.error.set(String(e)));
    });
  }

  protected update<K extends keyof AutorConfig>(key: K, value: AutorConfig[K]): void {
    const cur = this.config();
    if (cur) this.config.set({ ...cur, [key]: value });
  }

  protected bio(idioma: 'es' | 'en'): string {
    return this.config()?.bio?.[idioma] ?? '';
  }

  protected setBio(idioma: 'es' | 'en', valor: string): void {
    const cur = this.config();
    if (!cur) return;
    const bio = { ...(cur.bio ?? {}) };
    if (valor.trim()) bio[idioma] = valor;
    else delete bio[idioma];
    this.config.set({ ...cur, bio });
  }

  protected async pickFoto(): Promise<void> {
    await this.pickImagen('foto', 'autor', 'Seleccionar foto del autor');
  }

  protected async pickQr(): Promise<void> {
    await this.pickImagen('qr', 'qr', 'Seleccionar imagen del QR');
  }

  /** Copia la imagen a la raíz del repo y guarda el nombre relativo: el path
   *  absoluto del diálogo no viaja por git y en la otra PC no existe. */
  private async pickImagen(campo: 'foto' | 'qr', stem: string, titulo: string): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const elegido = await this.dialogs.pickSingleFile({
      title: titulo,
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
      defaultPath: root,
    });
    if (!elegido) return;
    try {
      const rel = await invoke<string>('adopt_config_image', {
        dirPath: root,
        sourcePath: elegido,
        stem,
      });
      this.update(campo, rel);
    } catch (e) {
      this.error.set(`No pude copiar la imagen: ${e}`);
    }
  }

  protected async save(): Promise<void> {
    const cfg = this.config();
    if (!cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.svc.save(cfg);
      this.svc.close();
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }
}
