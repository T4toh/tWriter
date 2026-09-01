import { Component, computed, effect, inject, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { AutorConfig, AutorService } from '../core/autor-service';
import { CoverCache } from '../core/cover-cache';
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
  private coverCache = inject(CoverCache);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<AutorConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Bump manual al reemplazar foto/QR — invalida el blob cacheado, porque
   *  `adopt_config_image` puede cambiar la extensión del archivo (mismo
   *  nombre relativo "autor.jpg" → "autor.png") y la cache está keyed por path. */
  private readonly previewVersion = signal(0);
  protected readonly fotoPreviewUrl = signal<string | null>(null);
  protected readonly qrPreviewUrl = signal<string | null>(null);

  /** Bio a mostrar en el preview: la del libro no existe acá — se muestra la
   *  de español y, si está vacía, se cae a inglés. Mismo criterio que
   *  `AutorConfig::bio_en` en Rust (usado por el EPUB), sin selector de idioma. */
  protected readonly previewBio = computed<string>(() => {
    const bio = this.config()?.bio;
    if (!bio) return '';
    const es = bio['es']?.trim();
    if (es) return es;
    return bio['en']?.trim() ?? '';
  });

  /** Un `<p>` por línea no vacía — así arma la página el EPUB
   *  (`build_about_author_xhtml` en `epub.rs`), no como un solo bloque. */
  protected readonly previewParrafos = computed<string[]>(() =>
    this.previewBio()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );

  protected readonly previewWebHost = computed<string | null>(() => {
    const web = this.config()?.web?.trim();
    if (!web) return null;
    return web.replace(/^https?:\/\//, '');
  });

  constructor() {
    effect(() => {
      if (!this.editing()) return;
      void this.svc
        .load()
        .then((cfg) => this.config.set(cfg))
        .catch((e) => this.error.set(String(e)));
    });

    effect(() => {
      const cfg = this.config();
      const root = this.settings.root();
      const version = this.previewVersion();
      if (!cfg || !root) {
        this.fotoPreviewUrl.set(null);
        this.qrPreviewUrl.set(null);
        return;
      }
      void this.loadPreviewImg(cfg.foto ?? null, root, version, this.fotoPreviewUrl);
      void this.loadPreviewImg(cfg.qr ?? null, root, version, this.qrPreviewUrl);
    });
  }

  private async loadPreviewImg(
    nombre: string | null | undefined,
    root: string,
    version: number,
    target: WritableSignal<string | null>,
  ): Promise<void> {
    if (!nombre || !nombre.trim()) {
      target.set(null);
      return;
    }
    const fullPath = nombre.startsWith('/') ? nombre : `${root}/${nombre}`;
    try {
      target.set(await this.coverCache.urlFor(fullPath, version));
    } catch {
      target.set(null);
    }
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
      this.previewVersion.update((v) => v + 1);
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
