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
import { FontsService } from '../core/fonts-service';
import { ThemesService } from '../core/themes-service';
import { Theme, ThemeRef } from '../core/types';

@Component({
  selector: 'app-book-config-modal',
  imports: [FormsModule],
  templateUrl: './book-config-modal.html',
  styleUrl: './book-config-modal.scss',
})
export class BookConfigModal {
  private svc = inject(BookConfigService);
  protected themesSvc = inject(ThemesService);
  private fontsSvc = inject(FontsService);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<BookConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly bookPath = computed(() => this.editing()?.path ?? null);

  protected readonly themeBase = signal<string>('');
  protected readonly ovBodyFont = signal<string>('');
  protected readonly ovBodySize = signal<string>('');
  protected readonly ovHeadingFont = signal<string>('');
  protected readonly ovHeadingSize = signal<string>('');
  protected readonly ovLineHeight = signal<string>('');
  protected readonly ovPageMargin = signal<string>('');
  protected readonly ovBodyFontItalic = signal<string>('');
  protected readonly ovBodyFontBold = signal<string>('');
  protected readonly ovBodyFontBoldItalic = signal<string>('');

  protected readonly availableThemes = computed(() => this.themesSvc.list());
  protected readonly selectedBaseTheme = computed(() => {
    const id = this.themeBase();
    if (!id) return null;
    return this.availableThemes().find((t) => t.id === id) ?? null;
  });
  protected readonly availableFamilies = computed(() => {
    const set = new Set<string>();
    const path = this.bookPath();
    if (path) {
      for (const f of this.fontsSvc.get(path)) set.add(f.family);
    }
    const base = this.selectedBaseTheme();
    if (base?.body_font) set.add(base.body_font);
    if (base?.heading_font) set.add(base.heading_font);
    return Array.from(set).sort();
  });

  /** Stems disponibles en book/fonts/ para los selectores de per-style. */
  protected readonly availableStems = computed(() => {
    const path = this.bookPath();
    if (!path) return [];
    return this.fontsSvc
      .get(path)
      .map((f) => stripExt(f.name))
      .sort();
  });

  constructor() {
    effect(() => {
      const node = this.editing();
      if (!node) {
        this.config.set(null);
        this.resetTheme();
        return;
      }
      void this.load(node.path);
      void this.themesSvc.refresh();
      void this.fontsSvc.refresh(node.path);
    });
  }

  private resetTheme(): void {
    this.themeBase.set('');
    this.ovBodyFont.set('');
    this.ovBodySize.set('');
    this.ovHeadingFont.set('');
    this.ovHeadingSize.set('');
    this.ovLineHeight.set('');
    this.ovPageMargin.set('');
    this.ovBodyFontItalic.set('');
    this.ovBodyFontBold.set('');
    this.ovBodyFontBoldItalic.set('');
  }

  private hydrateTheme(theme: ThemeRef | null | undefined): void {
    this.themeBase.set(theme?.base ?? '');
    const ov = theme?.overrides ?? null;
    this.ovBodyFont.set(ov?.body_font ?? '');
    this.ovBodySize.set(ov?.body_size ?? '');
    this.ovHeadingFont.set(ov?.heading_font ?? '');
    this.ovHeadingSize.set(ov?.heading_size ?? '');
    this.ovLineHeight.set(ov?.line_height ?? '');
    this.ovPageMargin.set(ov?.page_margin ?? '');
    this.ovBodyFontItalic.set(ov?.body_font_italic ?? '');
    this.ovBodyFontBold.set(ov?.body_font_bold ?? '');
    this.ovBodyFontBoldItalic.set(ov?.body_font_bold_italic ?? '');
  }

  private buildThemeRef(): ThemeRef | null {
    const base = blank(this.themeBase());
    const overrides: Theme = {
      body_font: blank(this.ovBodyFont()),
      body_size: blank(this.ovBodySize()),
      heading_font: blank(this.ovHeadingFont()),
      heading_size: blank(this.ovHeadingSize()),
      line_height: blank(this.ovLineHeight()),
      page_margin: blank(this.ovPageMargin()),
      body_font_italic: blank(this.ovBodyFontItalic()),
      body_font_bold: blank(this.ovBodyFontBold()),
      body_font_bold_italic: blank(this.ovBodyFontBoldItalic()),
    };
    const hasOverrides = Object.values(overrides).some((v) => v !== null);
    if (!base && !hasOverrides) return null;
    return {
      base,
      overrides: hasOverrides ? overrides : null,
    };
  }

  protected editTheme(): void {
    const id = this.themeBase();
    if (id) this.themesSvc.openEditor(id);
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
        contratapa: cfg.contratapa ?? '',
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
        template: cfg.template ?? '6x9',
        finalizada: cfg.finalizada ?? false,
        epilogo: cfg.epilogo ?? null,
      });
      this.hydrateTheme(cfg.theme ?? null);
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
      defaultPath: this.bookPath() ?? undefined,
    });
    if (typeof result !== 'string') return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, tapa: result });
  }

  protected async pickBackCover(): Promise<void> {
    const result = await openDialog({
      multiple: false,
      directory: false,
      title: 'Seleccionar contratapa',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: this.bookPath() ?? undefined,
    });
    if (typeof result !== 'string') return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, contratapa: result });
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
        contratapa: blank(cfg.contratapa),
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
        template: cfg.template ?? null,
        finalizada: cfg.finalizada ?? null,
        epilogo: blank(cfg.epilogo ?? null),
        theme: this.buildThemeRef(),
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

function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name;
  return name.slice(0, idx);
}
