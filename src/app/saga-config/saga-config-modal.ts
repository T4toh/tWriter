import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FontsService } from '../core/fonts-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SagaConfig, SagaConfigService } from '../core/saga-config-service';
import { SettingsService } from '../core/settings-service';
import { ThemesService } from '../core/themes-service';
import { Theme, ThemeRef } from '../core/types';
import { Select, SelectOption } from '../shared/select';

@Component({
  selector: 'app-saga-config-modal',
  imports: [FormsModule, Select],
  templateUrl: './saga-config-modal.html',
  styleUrl: './saga-config-modal.scss',
})
export class SagaConfigModal {
  private svc = inject(SagaConfigService);
  protected themesSvc = inject(ThemesService);
  private fontsSvc = inject(FontsService);
  private settings = inject(SettingsService);
  private dialogs = inject(NativeDialogsService);

  protected readonly globalVariantEs = this.settings.grammarVariantEs;
  protected readonly globalVariantEn = this.settings.grammarVariantEn;

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<SagaConfig | null>(null);
  protected readonly diccionarioText = signal<string>('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sagaPath = computed(() => this.editing()?.path ?? null);

  // Tema: form fields como strings vacíos = hereda. base "" = sin tema.
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
  protected readonly ovEditorialBodyFont = signal<string>('');
  protected readonly ovEditorialHeadingFont = signal<string>('');
  protected readonly ovChapterTitlePosition = signal<string>('');

  protected readonly availableThemes = computed(() => this.themesSvc.list());
  protected readonly selectedBaseTheme = computed(() => {
    const id = this.themeBase();
    if (!id) return null;
    return this.availableThemes().find((t) => t.id === id) ?? null;
  });
  protected readonly availableFamilies = computed(() => {
    const set = new Set<string>();
    const path = this.sagaPath();
    if (path) {
      for (const f of this.fontsSvc.get(path)) set.add(f.family);
    }
    const base = this.selectedBaseTheme();
    if (base?.body_font) set.add(base.body_font);
    if (base?.heading_font) set.add(base.heading_font);
    return Array.from(set).sort();
  });

  /** Stems disponibles en saga/fonts/ para los selectores de per-style. */
  protected readonly availableStems = computed(() => {
    const path = this.sagaPath();
    if (!path) return [];
    return this.fontsSvc
      .get(path)
      .map((f) => stripExt(f.name))
      .sort();
  });

  protected readonly idiomaOptions: SelectOption[] = [
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'Inglés' },
  ];
  protected readonly prefijoCapituloOptions: SelectOption[] = [
    { value: 'none', label: 'Sin prefijo' },
    { value: 'decimal', label: 'Número (1, 2, 3…)' },
    { value: 'roman', label: 'Romano (I, II, III…)' },
  ];
  protected readonly formatoParteOptions: SelectOption[] = [
    { value: 'raw', label: '1' },
    { value: 'parte', label: 'Parte 1' },
    { value: 'punto', label: '1.' },
  ];
  protected readonly templateOptions: SelectOption[] = [
    { value: '6x9', label: '6 × 9 in (default)' },
    { value: '5x8', label: '5 × 8 in' },
    { value: 'a5', label: 'A5 (148 × 210 mm)' },
  ];
  protected readonly varianteEsOptions = computed<SelectOption[]>(() => [
    { value: '', label: `Heredar global (${this.globalVariantEs()})` },
    { value: 'es-AR', label: 'es-AR — Argentina (voseo)' },
    { value: 'es-ES', label: 'es-ES — España' },
  ]);
  protected readonly varianteEnOptions = computed<SelectOption[]>(() => [
    { value: '', label: `Heredar global (${this.globalVariantEn()})` },
    { value: 'en-US', label: 'en-US — Inglés (US)' },
    { value: 'en-GB', label: 'en-GB — Inglés (UK)' },
  ]);
  protected readonly themeBaseOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'Sin tema' },
    ...this.availableThemes().map((t) => ({ value: t.id, label: t.nombre || t.id })),
  ]);
  private stemFaceOptions(inherited: string | null | undefined): SelectOption[] {
    return [
      { value: '', label: inherited || 'Heredar' },
      ...this.availableStems().map((s) => ({ value: s, label: s })),
    ];
  }
  protected readonly italicFaceOptions = computed<SelectOption[]>(() =>
    this.stemFaceOptions(this.selectedBaseTheme()?.body_font_italic),
  );
  protected readonly boldFaceOptions = computed<SelectOption[]>(() =>
    this.stemFaceOptions(this.selectedBaseTheme()?.body_font_bold),
  );
  protected readonly boldItalicFaceOptions = computed<SelectOption[]>(() =>
    this.stemFaceOptions(this.selectedBaseTheme()?.body_font_bold_italic),
  );
  protected readonly chapterTitlePositionOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.selectedBaseTheme()?.chapter_title_position || 'Heredar (centrado)' },
    { value: 'top', label: 'Arriba' },
    { value: 'center', label: 'Centrado (explícito)' },
    { value: 'bottom', label: 'Abajo' },
  ]);

  protected setVarianteEs(value: string): void {
    this.update('variante_es', value === '' ? null : value);
  }
  protected setVarianteEn(value: string): void {
    this.update('variante_en', value === '' ? null : value);
  }

  constructor() {
    effect(() => {
      const node = this.editing();
      if (!node) {
        this.config.set(null);
        this.diccionarioText.set('');
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
    this.ovEditorialBodyFont.set('');
    this.ovEditorialHeadingFont.set('');
    this.ovChapterTitlePosition.set('');
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
    this.ovEditorialBodyFont.set(ov?.editorial_body_font ?? '');
    this.ovEditorialHeadingFont.set(ov?.editorial_heading_font ?? '');
    this.ovChapterTitlePosition.set(ov?.chapter_title_position ?? '');
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
      editorial_body_font: blank(this.ovEditorialBodyFont()),
      editorial_heading_font: blank(this.ovEditorialHeadingFont()),
      chapter_title_position: blank(this.ovChapterTitlePosition()),
    };
    const hasOverrides = Object.values(overrides).some((v) => v !== null);
    if (!base && !hasOverrides) return null;
    return {
      base,
      overrides: hasOverrides ? overrides : null,
    };
  }

  private async load(path: string): Promise<void> {
    this.error.set(null);
    try {
      const cfg = await this.svc.load(path);
      this.config.set({
        nombre: cfg.nombre ?? '',
        autor: cfg.autor ?? '',
        idioma: cfg.idioma ?? 'es',
        variante_es: cfg.variante_es ?? null,
        variante_en: cfg.variante_en ?? null,
        tapa: cfg.tapa ?? '',
        diccionario: cfg.diccionario ?? [],
        imprenta: cfg.imprenta ?? 'Independiente',
        template: cfg.template ?? '6x9',
        mostrar_titulo_capitulo: cfg.mostrar_titulo_capitulo ?? true,
        prefijo_capitulo: cfg.prefijo_capitulo ?? 'none',
        dropcap: cfg.dropcap ?? false,
        mostrar_numero_parte: cfg.mostrar_numero_parte ?? false,
        formato_parte: cfg.formato_parte ?? 'raw',
        finalizada: cfg.finalizada ?? false,
      });
      this.diccionarioText.set((cfg.diccionario ?? []).join('\n'));
      this.hydrateTheme(cfg.theme ?? null);
    } catch (err) {
      this.error.set(String(err));
    }
  }

  protected async pickCover(): Promise<void> {
    const result = await this.dialogs.pickSingleFile({
      title: 'Seleccionar tapa de saga',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: this.sagaPath() ?? undefined,
    });
    if (!result) return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, tapa: result });
  }

  protected update<K extends keyof SagaConfig>(key: K, value: SagaConfig[K]): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, [key]: value });
  }

  protected updateDiccionarioText(value: string): void {
    this.diccionarioText.set(value);
  }

  protected async save(): Promise<void> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const palabras = this.diccionarioText()
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const cleaned: SagaConfig = {
        nombre: cfg.nombre,
        autor: blank(cfg.autor),
        idioma: cfg.idioma,
        variante_es: cfg.variante_es ?? null,
        variante_en: cfg.variante_en ?? null,
        tapa: blank(cfg.tapa),
        diccionario: palabras.length > 0 ? palabras : null,
        imprenta: blank(cfg.imprenta),
        template: cfg.template ?? null,
        mostrar_titulo_capitulo: cfg.mostrar_titulo_capitulo ?? null,
        prefijo_capitulo: cfg.prefijo_capitulo ?? null,
        dropcap: cfg.dropcap ?? null,
        mostrar_numero_parte: cfg.mostrar_numero_parte ?? null,
        formato_parte: cfg.formato_parte ?? null,
        finalizada: cfg.finalizada ?? null,
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

  protected editTheme(): void {
    const id = this.themeBase();
    if (id) this.themesSvc.openEditor(id);
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
