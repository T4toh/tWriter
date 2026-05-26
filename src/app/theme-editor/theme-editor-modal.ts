import { Component, computed, effect, inject, signal } from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FontsService } from '../core/fonts-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SettingsService } from '../core/settings-service';
import { ThemesService } from '../core/themes-service';
import { ToastService } from '../core/toast-service';
import { FontEntry, Theme } from '../core/types';
import { Select, SelectGroup, SelectOption } from '../shared/select';

interface EditableTheme {
  nombre: string;
  body_font: string;
  body_size: string;
  heading_font: string;
  heading_size: string;
  line_height: string;
  page_margin: string;
  editorial_body_font: string;
  editorial_heading_font: string;
  chapter_title_position: string;
  prefijo_capitulo: string;
  mostrar_titulo_capitulo: boolean;
  dropcap: boolean;
  mostrar_numero_parte: boolean;
  formato_parte: string;
  template: string;
  italic_oblique_deg: string;
  italic_weight: string;
  bold_weight: string;
}

type Tab = 'tipografia' | 'capitulos' | 'editoriales' | 'pagina' | 'fuentes';

interface PoolItem {
  entry: FontEntry;
  /** CSS family name único para registrar la FontFace de este archivo. */
  family: string;
  /** Etiqueta legible (familia + Bold/Italic). */
  label: string;
}

function previewFamilyName(slot: string, idx: number): string {
  return `tw-preview-${slot}-${idx}`;
}

@Component({
  selector: 'app-theme-editor-modal',
  imports: [FormsModule, ScrollingModule, Select],
  templateUrl: './theme-editor-modal.html',
  styleUrl: './theme-editor-modal.scss',
})
export class ThemeEditorModal {
  private svc = inject(ThemesService);
  private fontsSvc = inject(FontsService);
  private settings = inject(SettingsService);
  private dialogs = inject(NativeDialogsService);
  private toast = inject(ToastService);

  protected readonly editing = this.svc.editing;
  protected readonly form = signal<EditableTheme | null>(null);
  protected readonly activeTab = signal<Tab>('tipografia');
  protected readonly tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'tipografia', label: 'Tipografía' },
    { id: 'capitulos', label: 'Capítulos' },
    { id: 'editoriales', label: 'Editoriales' },
    { id: 'pagina', label: 'Página' },
    { id: 'fuentes', label: 'Fuentes' },
  ];
  protected readonly fonts = computed<FontEntry[]>(() => {
    const root = this.settings.root();
    return root ? this.fontsSvc.get(root) : [];
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Generación incremental para invalidar caché del browser entre selecciones. */
  private previewGen = signal(0);

  /** Familias únicas con path del regular (o primer face encontrado) para
   *  los selects de cuerpo/títulos/editoriales. */
  private readonly familyPaths = computed<Map<string, string>>(() => {
    const seen = new Map<string, string>();
    const fonts = this.fonts();
    // Pass 1: regular faces.
    for (const fe of fonts) {
      if (!seen.has(fe.family) && fe.weight === 400 && fe.style === 'normal') {
        seen.set(fe.family, fe.path);
      }
    }
    // Pass 2: cualquier otro face de familias sin regular.
    for (const fe of fonts) {
      if (!seen.has(fe.family)) seen.set(fe.family, fe.path);
    }
    return seen;
  });

  /** Groups para `<app-select>` de fuentes — pool + personalizado (familias
   *  referenciadas por el theme actual pero ausentes del pool). */
  protected readonly fontGroups = computed<SelectGroup[]>(() => {
    const families = this.familyPaths();
    const f = this.form();
    const pool: SelectOption[] = Array.from(families.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, path]) => ({
        value: family,
        label: family,
        data: { fontFamily: family, path },
      }));
    const groups: SelectGroup[] = [];
    if (pool.length > 0) groups.push({ label: 'Pool del repo', options: pool });

    if (f) {
      const poolLower = new Set(Array.from(families.keys()).map((s) => s.toLowerCase()));
      const custom = new Set<string>();
      for (const fam of [
        f.body_font,
        f.heading_font,
        f.editorial_body_font,
        f.editorial_heading_font,
      ]) {
        const t = fam.trim();
        if (t && !poolLower.has(t.toLowerCase())) custom.add(t);
      }
      if (custom.size > 0) {
        groups.push({
          label: 'Personalizado (no en pool)',
          options: Array.from(custom)
            .sort()
            .map((v) => ({ value: v, label: v, data: { fontFamily: v } })),
        });
      }
    }
    return groups;
  });

  /** Familias ya registradas como FontFace global con su family name real
   *  (no `tw-pool-*`). Idempotente. */
  private readonly familyLoaded = new Set<string>();

  protected readonly chapterTitlePositionOptions: SelectOption[] = [
    { value: '', label: 'Centrado (default)' },
    { value: 'top', label: 'Arriba' },
    { value: 'center', label: 'Centrado (explícito)' },
    { value: 'bottom', label: 'Abajo' },
  ];
  protected readonly prefijoCapituloOptions: SelectOption[] = [
    { value: '', label: 'Sin prefijo (default)' },
    { value: 'none', label: 'Sin prefijo (explícito)' },
    { value: 'decimal', label: 'Número (1, 2, 3…)' },
    { value: 'roman', label: 'Romano (I, II, III…)' },
  ];
  protected readonly formatoParteOptions: SelectOption[] = [
    { value: '', label: '1 (default)' },
    { value: 'raw', label: '1 (explícito)' },
    { value: 'parte', label: 'Parte 1' },
    { value: 'punto', label: '1.' },
  ];
  protected readonly templateOptions: SelectOption[] = [
    { value: '', label: '6 × 9 in (default)' },
    { value: '6x9', label: '6 × 9 in (explícito)' },
    { value: '5x8', label: '5 × 8 in' },
    { value: 'a5', label: 'A5 (148 × 210 mm)' },
  ];

  /** CSS family names para cada slot del preview. Rotan via previewGen. */
  private readonly previewFamilies = computed(() => {
    const f = this.form();
    if (!f) return null;
    const gen = this.previewGen();
    return {
      body: f.body_font ? previewFamilyName('body', gen) : null,
      heading: f.heading_font ? previewFamilyName('heading', gen) : null,
      editorialBody: f.editorial_body_font
        ? previewFamilyName('edbody', gen)
        : null,
      editorialHeading: f.editorial_heading_font
        ? previewFamilyName('edhead', gen)
        : null,
    };
  });

  protected readonly previewBodyStyle = computed(() => {
    const f = this.form();
    const fams = this.previewFamilies();
    if (!f || !fams) return '';
    const stack: string[] = [];
    if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    const parts: string[] = [`font-family: ${stack.join(', ')}`];
    if (f.body_size) parts.push(`font-size: ${f.body_size}`);
    if (f.line_height) parts.push(`line-height: ${f.line_height}`);
    return parts.join('; ') + ';';
  });

  protected readonly previewHeadingStyle = computed(() => {
    const f = this.form();
    const fams = this.previewFamilies();
    if (!f || !fams) return '';
    const stack: string[] = [];
    if (fams.heading) stack.push(`"${fams.heading}"`);
    stack.push('sans-serif');
    const parts: string[] = [`font-family: ${stack.join(', ')}`];
    if (f.heading_size) parts.push(`font-size: ${f.heading_size}`);
    return parts.join('; ') + ';';
  });

  protected readonly previewEditorialBodyStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.editorialBody) stack.push(`"${fams.editorialBody}"`);
    else if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    return `font-family: ${stack.join(', ')};`;
  });

  /** Parsea peso (100-900) o devuelve null. */
  private clampWeight(s: string): number | null {
    const t = s.trim();
    if (!t || !/^\d+$/.test(t)) return null;
    return Math.max(100, Math.min(900, parseInt(t, 10)));
  }

  /** Estilo inline para spans italic. font-style desde `italic_oblique_deg`
   *  (o `italic` clásico). font-weight cascade: italic_weight → bold_weight
   *  (cuando italic no se distingue de regular, subir bold también levanta italic). */
  protected readonly previewItalicSpanStyle = computed(() => {
    const f = this.form();
    if (!f) return 'font-style: italic;';
    const deg = f.italic_oblique_deg.trim();
    const parts: string[] = [];
    if (deg && !Number.isNaN(Number(deg))) {
      parts.push(`font-style: oblique ${deg}deg`);
    } else {
      parts.push('font-style: italic');
    }
    const w = this.clampWeight(f.italic_weight) ?? this.clampWeight(f.bold_weight);
    if (w != null) parts.push(`font-weight: ${w}`);
    return parts.join('; ') + ';';
  });

  /** Estilo inline para spans bold. `bold_weight` set → ese peso; sino `bold`. */
  protected readonly previewBoldSpanStyle = computed(() => {
    const f = this.form();
    if (!f) return 'font-weight: bold;';
    const w = this.clampWeight(f.bold_weight);
    return w != null ? `font-weight: ${w};` : 'font-weight: bold;';
  });

  /** Combo bold+italic: italic angle + bold_weight (bold gana sobre italic_weight). */
  protected readonly previewBoldItalicSpanStyle = computed(() => {
    const f = this.form();
    if (!f) return 'font-style: italic; font-weight: bold;';
    const deg = f.italic_oblique_deg.trim();
    const parts: string[] = [];
    if (deg && !Number.isNaN(Number(deg))) {
      parts.push(`font-style: oblique ${deg}deg`);
    } else {
      parts.push('font-style: italic');
    }
    const w = this.clampWeight(f.bold_weight);
    parts.push(w != null ? `font-weight: ${w}` : 'font-weight: bold');
    return parts.join('; ') + ';';
  });

  protected readonly previewEditorialHeadingStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.editorialHeading) stack.push(`"${fams.editorialHeading}"`);
    else if (fams.heading) stack.push(`"${fams.heading}"`);
    stack.push('sans-serif');
    return `font-family: ${stack.join(', ')};`;
  });

  /** Etiqueta de prefijo según el setting actual. Matchea exacto lo que
   *  `chapter_prefix` emite en `src-tauri/src/epub.rs` — solo el número
   *  (decimal o romano), sin prefijo "Capítulo". El ejemplo usa idx=5. */
  protected readonly chapterPrefixLabel = computed(() => {
    const f = this.form();
    if (!f) return null;
    switch (f.prefijo_capitulo) {
      case 'decimal':
        return '5';
      case 'roman':
        return 'V';
      default:
        return null;
    }
  });

  /** Etiqueta de parte según formato_parte. Parte 2 como ejemplo. */
  protected readonly partLabel = computed(() => {
    const f = this.form();
    if (!f || !f.mostrar_numero_parte) return null;
    switch (f.formato_parte) {
      case 'parte':
        return 'Parte 2';
      case 'punto':
        return '2.';
      case 'raw':
      default:
        return '2';
    }
  });

  /** Clase CSS para el mock de página según template (aspect-ratio + padding). */
  protected readonly pageMockClass = computed(() => {
    const tpl = this.form()?.template || '6x9';
    return `page-mock tpl-${tpl}`;
  });

  /** Clase CSS para el mock de página de título standalone, según
   *  `chapter_title_position`: top / center (default) / bottom. */
  protected readonly chapterTitlePageClass = computed(() => {
    const f = this.form();
    const tpl = f?.template || '6x9';
    const pos = f?.chapter_title_position || 'center';
    return `page-mock tpl-${tpl} ctp-${pos}`;
  });

  /** Pool ordenado, con un family CSS único por archivo. Cada item se
   *  renderiza con su propia tipografía en la lista. */
  protected readonly pool = computed<PoolItem[]>(() => {
    return this.fonts().map((entry) => ({
      entry,
      family: `tw-pool-${slugify(entry.relative_path)}`,
      label: this.formatStyle(entry),
    }));
  });

  /** Familias del pool ya registradas en document.fonts. Idempotente. */
  private readonly poolLoaded = new Set<string>();

  constructor() {
    // Bloquea scroll del body mientras el modal está abierto. overscroll-behavior
    // solo evita chain dentro de un scroller; con la rueda sobre backdrop el
    // documento de fondo seguía scrolleando. Esto lo congela.
    effect((onCleanup) => {
      if (!this.editing()) return;
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      onCleanup(() => {
        document.body.style.overflow = prev;
      });
    });

    effect(() => {
      const id = this.editing();
      if (!id) {
        this.form.set(null);
        return;
      }
      void this.load(id);
      const root = this.settings.root();
      if (root) void this.fontsSvc.refresh(root);
    });

    effect(() => {
      const f = this.form();
      const fonts = this.fonts();
      if (!f || fonts.length === 0) return;
      void f.body_font;
      void f.heading_font;
      void f.editorial_body_font;
      void f.editorial_heading_font;
      void this.reloadPreviewFonts(f, fonts);
    });

    // Pre-carga todas las FontFace del pool (eager). El virtual scroll de la
    // lista da el "paginado" en el render, pero las fuentes ya están listas
    // cuando los items entran en viewport.
    effect(() => {
      for (const item of this.pool()) {
        void this.loadPoolFace(item);
      }
    });
  }

  private async load(id: string): Promise<void> {
    this.error.set(null);
    try {
      const t = await this.svc.get(id);
      this.form.set({
        nombre: t.nombre ?? id,
        body_font: t.body_font ?? '',
        body_size: t.body_size ?? '',
        heading_font: t.heading_font ?? '',
        heading_size: t.heading_size ?? '',
        line_height: t.line_height ?? '',
        page_margin: t.page_margin ?? '',
        editorial_body_font: t.editorial_body_font ?? '',
        editorial_heading_font: t.editorial_heading_font ?? '',
        chapter_title_position: t.chapter_title_position ?? '',
        prefijo_capitulo: t.prefijo_capitulo ?? '',
        mostrar_titulo_capitulo: t.mostrar_titulo_capitulo ?? true,
        dropcap: t.dropcap ?? false,
        mostrar_numero_parte: t.mostrar_numero_parte ?? false,
        formato_parte: t.formato_parte ?? '',
        template: t.template ?? '',
        italic_oblique_deg:
          t.italic_oblique_deg != null ? String(t.italic_oblique_deg) : '',
        italic_weight: t.italic_weight != null ? String(t.italic_weight) : '',
        bold_weight: t.bold_weight != null ? String(t.bold_weight) : '',
      });
    } catch (err) {
      this.error.set(String(err));
    }
  }

  /** Carga FontFace para los slots del preview. Solo familia regular —
   *  italic/bold se sintetizan via CSS desde la misma face. */
  private async reloadPreviewFonts(
    f: EditableTheme,
    fonts: FontEntry[],
  ): Promise<void> {
    this.previewGen.update((g) => g + 1);
    const gen = this.previewGen();

    const findRegular = (family: string): FontEntry | undefined =>
      fonts.find(
        (fe) =>
          fe.family.toLowerCase() === family.toLowerCase() &&
          fe.weight === 400 &&
          fe.style === 'normal',
      ) ?? fonts.find((fe) => fe.family.toLowerCase() === family.toLowerCase());

    const slots: Array<{ slot: string; family: string }> = [];
    if (f.body_font) slots.push({ slot: 'body', family: f.body_font });
    if (f.heading_font) slots.push({ slot: 'heading', family: f.heading_font });
    if (f.editorial_body_font)
      slots.push({ slot: 'edbody', family: f.editorial_body_font });
    if (f.editorial_heading_font)
      slots.push({ slot: 'edhead', family: f.editorial_heading_font });

    for (const { slot, family } of slots) {
      const face = findRegular(family);
      if (!face) continue;
      const familyName = previewFamilyName(slot, gen);
      try {
        const ff = new FontFace(familyName, `url("${convertFileSrc(face.path)}")`);
        await ff.load();
        document.fonts.add(ff);
      } catch {
        // silent — preview no debe romper el modal
      }
    }
  }

  /** Registra una FontFace con el family real (compartido entre faces). Idempotente.
   *  Se invoca al hover sobre un item del dropdown de fuentes para preview. */
  protected onFontItemHover(opt: SelectOption): void {
    const data = opt.data as { fontFamily?: string; path?: string } | undefined;
    if (!data?.fontFamily || !data.path) return;
    const key = data.fontFamily.toLowerCase();
    if (this.familyLoaded.has(key)) return;
    this.familyLoaded.add(key);
    void (async () => {
      try {
        const ff = new FontFace(data.fontFamily!, `url("${convertFileSrc(data.path!)}")`);
        await ff.load();
        document.fonts.add(ff);
      } catch {
        // silent
      }
    })();
  }

  /** Registra la FontFace de un item del pool con su `family` único. Idempotente.
   *  Se invoca al renderizar cada item visible en el virtual scroll. Además
   *  registra la familia real (`item.entry.family`) la primera vez que se ve
   *  para que el `<app-select>` pueda renderear cada opción en su tipografía. */
  protected async loadPoolFace(item: PoolItem): Promise<void> {
    if (!this.poolLoaded.has(item.family)) {
      this.poolLoaded.add(item.family);
      try {
        const ff = new FontFace(
          item.family,
          `url("${convertFileSrc(item.entry.path)}")`,
        );
        await ff.load();
        document.fonts.add(ff);
      } catch {
        // silent
      }
    }
    const famKey = item.entry.family.toLowerCase();
    if (!this.familyLoaded.has(famKey)) {
      this.familyLoaded.add(famKey);
      try {
        const ff = new FontFace(
          item.entry.family,
          `url("${convertFileSrc(item.entry.path)}")`,
        );
        await ff.load();
        document.fonts.add(ff);
      } catch {
        // silent
      }
    }
  }

  protected async pickFont(): Promise<void> {
    const root = this.settings.root();
    if (!root) {
      this.toast.error('Elegí una carpeta raíz primero.');
      return;
    }
    const paths = await this.dialogs.pickFile({
      title: 'Agregar fuentes al pool global',
      filters: [{ name: 'Fuentes', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      multiple: true,
    });
    if (paths.length === 0) return;
    let added = 0;
    let failed = 0;
    for (const p of paths) {
      try {
        await this.fontsSvc.addFromPath(root, p);
        added++;
      } catch (err) {
        failed++;
        this.toast.error(`No pude agregar ${p}: ${err}`);
      }
    }
    if (added > 0) {
      this.toast.success(
        `Agregada${added === 1 ? '' : 's'} ${added} fuente${added === 1 ? '' : 's'} al pool global.`,
      );
    }
    if (failed > 0 && added === 0) {
      this.toast.error('No se pudo agregar ninguna fuente.');
    }
  }

  protected update<K extends keyof EditableTheme>(key: K, value: EditableTheme[K]): void {
    const cur = this.form();
    if (!cur) return;
    this.form.set({ ...cur, [key]: value });
  }

  protected async save(): Promise<void> {
    const id = this.editing();
    const cur = this.form();
    if (!id || !cur) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const theme: Theme = {
        id,
        nombre: blank(cur.nombre) ?? id,
        body_font: blank(cur.body_font),
        body_size: blank(cur.body_size),
        heading_font: blank(cur.heading_font),
        heading_size: blank(cur.heading_size),
        line_height: blank(cur.line_height),
        page_margin: blank(cur.page_margin),
        editorial_body_font: blank(cur.editorial_body_font),
        editorial_heading_font: blank(cur.editorial_heading_font),
        chapter_title_position: blank(cur.chapter_title_position),
        prefijo_capitulo: blank(cur.prefijo_capitulo),
        mostrar_titulo_capitulo: cur.mostrar_titulo_capitulo,
        dropcap: cur.dropcap,
        mostrar_numero_parte: cur.mostrar_numero_parte,
        formato_parte: blank(cur.formato_parte),
        template: blank(cur.template),
        italic_oblique_deg: parseFloatOrNull(cur.italic_oblique_deg),
        italic_weight: parseIntOrNull(cur.italic_weight),
        bold_weight: parseIntOrNull(cur.bold_weight),
      };
      await this.svc.save(id, theme);
      this.svc.closeEditor();
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.closeEditor();
  }

  protected trackByPath(_idx: number, item: PoolItem): string {
    return item.entry.relative_path;
  }

  protected formatStyle(font: FontEntry): string {
    const parts: string[] = [];
    parts.push(font.family);
    if (font.weight === 700) parts.push('Bold');
    if (font.style === 'italic') parts.push('Italic');
    return parts.join(' · ');
  }
}

function blank(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseFloatOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
