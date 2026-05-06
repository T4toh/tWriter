import {
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { BookConfig, BookConfigService } from '../core/book-config-service';

@Component({
  selector: 'app-book-config-modal',
  imports: [FormsModule],
  templateUrl: './book-config-modal.html',
  styleUrl: './book-config-modal.scss',
})
export class BookConfigModal {
  private svc = inject(BookConfigService);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<BookConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly bookPath = computed(() => this.editing()?.path ?? null);

  constructor() {
    effect(() => {
      const node = this.editing();
      if (!node) {
        this.config.set(null);
        return;
      }
      void this.load(node.path);
    });
  }

  private async load(path: string): Promise<void> {
    this.error.set(null);
    try {
      const cfg = await this.svc.load(path);
      this.config.set({
        titulo: cfg.titulo ?? '',
        subtitulo: cfg.subtitulo ?? '',
        autor: cfg.autor ?? '',
        idioma: cfg.idioma ?? 'es',
        isbn: cfg.isbn ?? '',
        tapa: cfg.tapa ?? '',
        copyright_anio: cfg.copyright_anio ?? new Date().getFullYear(),
        derechos_reservados: cfg.derechos_reservados ?? true,
        dedicatoria: cfg.dedicatoria ?? '',
        imprenta: cfg.imprenta ?? 'Independiente',
        serie: cfg.serie ?? '',
        numero_en_serie: cfg.numero_en_serie ?? null,
        mostrar_titulo_capitulo: cfg.mostrar_titulo_capitulo ?? true,
        prefijo_capitulo: cfg.prefijo_capitulo ?? 'none',
        dropcap: cfg.dropcap ?? false,
        mostrar_numero_parte: cfg.mostrar_numero_parte ?? false,
        formato_parte: cfg.formato_parte ?? 'raw',
      });
    } catch (err) {
      this.error.set(String(err));
    }
  }

  protected async pickCover(): Promise<void> {
    const result = await openDialog({
      multiple: false,
      directory: false,
      title: 'Seleccionar tapa',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (typeof result !== 'string') return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, tapa: result });
  }

  protected update<K extends keyof BookConfig>(key: K, value: BookConfig[K]): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, [key]: value });
  }

  protected async save(): Promise<void> {
    const path = this.bookPath();
    const cfg = this.config();
    if (!path || !cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      // Normalizar: vacíos a null
      const cleaned: BookConfig = {
        titulo: cfg.titulo,
        subtitulo: blank(cfg.subtitulo),
        autor: blank(cfg.autor),
        idioma: cfg.idioma,
        isbn: blank(cfg.isbn),
        tapa: blank(cfg.tapa),
        copyright_anio: cfg.copyright_anio || null,
        derechos_reservados: cfg.derechos_reservados ?? null,
        dedicatoria: blank(cfg.dedicatoria),
        imprenta: blank(cfg.imprenta),
        serie: blank(cfg.serie),
        numero_en_serie: cfg.numero_en_serie || null,
        mostrar_titulo_capitulo: cfg.mostrar_titulo_capitulo ?? null,
        prefijo_capitulo: cfg.prefijo_capitulo ?? null,
        dropcap: cfg.dropcap ?? null,
        mostrar_numero_parte: cfg.mostrar_numero_parte ?? null,
        formato_parte: cfg.formato_parte ?? null,
      };
      await this.svc.save(path, cleaned);
      this.svc.close();
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }
}

function blank(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}
