import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FontsService } from '../core/fonts-service';
import { SettingsService } from '../core/settings-service';
import { ThemesService } from '../core/themes-service';
import { FontEntry, Theme } from '../core/types';
import { Select, SelectOption } from '../shared/select';

interface EditableTheme {
  nombre: string;
  body_font: string;
  body_size: string;
  heading_font: string;
  heading_size: string;
  line_height: string;
  page_margin: string;
  body_font_italic: string;
  body_font_bold: string;
  body_font_bold_italic: string;
  editorial_body_font: string;
  editorial_heading_font: string;
  chapter_title_position: string;
  prefijo_capitulo: string;
  mostrar_titulo_capitulo: boolean;
  dropcap: boolean;
  mostrar_numero_parte: boolean;
  formato_parte: string;
  template: string;
}

/** Genera nombre CSS único per-modal-instance para no chocar con otras
 *  declaraciones del DOM. Mismo nombre que se usa en el preview. */
function previewFamilyName(slot: string, idx: number): string {
  return `tw-preview-${slot}-${idx}`;
}

@Component({
  selector: 'app-theme-editor-modal',
  imports: [FormsModule, Select],
  templateUrl: './theme-editor-modal.html',
  styleUrl: './theme-editor-modal.scss',
})
export class ThemeEditorModal {
  private svc = inject(ThemesService);
  private fontsSvc = inject(FontsService);
  private settings = inject(SettingsService);

  protected readonly editing = this.svc.editing;
  protected readonly form = signal<EditableTheme | null>(null);
  /** Fuentes del pool global. Las lee del FontsService cuando hay root y modal abierto. */
  protected readonly fonts = computed<FontEntry[]>(() => {
    const root = this.settings.root();
    return root ? this.fontsSvc.get(root) : [];
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Generación incremental de family name para evitar caché entre selecciones. */
  private previewGen = signal(0);

  /** Familias únicas detectadas en las fuentes del tema, para sugerir en los selects. */
  protected readonly availableFamilies = computed(() => {
    const set = new Set<string>();
    for (const f of this.fonts()) {
      if (f.family) set.add(f.family);
    }
    return Array.from(set).sort();
  });

  /** Lista de stems disponibles para los selectores de per-style faces. */
  protected readonly availableStems = computed(() => {
    return this.fonts()
      .map((f) => ({
        stem: stripExt(f.name),
        label: this.formatStyle(f),
        family: f.family,
        weight: f.weight,
        style: f.style,
      }))
      .sort((a, b) => a.stem.localeCompare(b.stem));
  });

  /** Opciones para los <app-select> de body_font_italic / bold / bold_italic. */
  protected readonly stemSelectOptions = computed<SelectOption[]>(() => {
    const stems = this.availableStems();
    return [
      { value: '', label: 'Auto (de body_font)' },
      ...stems.map((s) => ({ value: s.stem, label: `${s.stem} — ${s.label}` })),
    ];
  });

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

  /** Familias CSS que el preview tiene cargadas. Se rotan via previewGen. */
  protected readonly previewFamilies = computed(() => {
    const f = this.form();
    if (!f) return null;
    const gen = this.previewGen();
    return {
      body: f.body_font ? `${previewFamilyName('body', gen)}` : null,
      italic: f.body_font_italic ? previewFamilyName('italic', gen) : null,
      bold: f.body_font_bold ? previewFamilyName('bold', gen) : null,
      boldItalic: f.body_font_bold_italic
        ? previewFamilyName('bolditalic', gen)
        : null,
    };
  });

  protected readonly previewBodyStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    return `font-family: ${stack.join(', ')};`;
  });

  protected readonly previewItalicStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.italic) stack.push(`"${fams.italic}"`);
    if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    return `font-family: ${stack.join(', ')}; font-style: italic;`;
  });

  protected readonly previewBoldStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.bold) stack.push(`"${fams.bold}"`);
    if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    return `font-family: ${stack.join(', ')}; font-weight: bold;`;
  });

  protected readonly previewBoldItalicStyle = computed(() => {
    const fams = this.previewFamilies();
    if (!fams) return '';
    const stack: string[] = [];
    if (fams.boldItalic) stack.push(`"${fams.boldItalic}"`);
    if (fams.body) stack.push(`"${fams.body}"`);
    stack.push('serif');
    return `font-family: ${stack.join(', ')}; font-weight: bold; font-style: italic;`;
  });

  constructor() {
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

    // Re-load preview FontFaces cuando cambian los slots o el body_font.
    effect(() => {
      const f = this.form();
      const fonts = this.fonts();
      if (!f || fonts.length === 0) return;
      // Tracking de los stems específicos para invalidar correctamente.
      void f.body_font;
      void f.body_font_italic;
      void f.body_font_bold;
      void f.body_font_bold_italic;
      void this.reloadPreviewFonts(f, fonts);
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
        body_font_italic: t.body_font_italic ?? '',
        body_font_bold: t.body_font_bold ?? '',
        body_font_bold_italic: t.body_font_bold_italic ?? '',
        editorial_body_font: t.editorial_body_font ?? '',
        editorial_heading_font: t.editorial_heading_font ?? '',
        chapter_title_position: t.chapter_title_position ?? '',
        prefijo_capitulo: t.prefijo_capitulo ?? '',
        mostrar_titulo_capitulo: t.mostrar_titulo_capitulo ?? true,
        dropcap: t.dropcap ?? false,
        mostrar_numero_parte: t.mostrar_numero_parte ?? false,
        formato_parte: t.formato_parte ?? '',
        template: t.template ?? '',
      });
    } catch (err) {
      this.error.set(String(err));
    }
  }

  private async reloadPreviewFonts(f: EditableTheme, fonts: FontEntry[]): Promise<void> {
    this.previewGen.update((g) => g + 1);
    const gen = this.previewGen();

    const findByStem = (stem: string) =>
      fonts.find((fe) => stripExt(fe.name).toLowerCase() === stem.toLowerCase());

    const findRegularOfFamily = (family: string) =>
      fonts.find(
        (fe) =>
          fe.family.toLowerCase() === family.toLowerCase() &&
          fe.weight === 400 &&
          fe.style === 'normal',
      ) ??
      fonts.find((fe) => fe.family.toLowerCase() === family.toLowerCase());

    const slots: Array<{
      slot: string;
      face: FontEntry | undefined;
      desc: { weight: string; style: string };
    }> = [
      {
        slot: 'body',
        face: f.body_font ? findRegularOfFamily(f.body_font) : undefined,
        desc: { weight: 'normal', style: 'normal' },
      },
      {
        slot: 'italic',
        face: f.body_font_italic ? findByStem(f.body_font_italic) : undefined,
        desc: { weight: 'normal', style: 'italic' },
      },
      {
        slot: 'bold',
        face: f.body_font_bold ? findByStem(f.body_font_bold) : undefined,
        desc: { weight: 'bold', style: 'normal' },
      },
      {
        slot: 'bolditalic',
        face: f.body_font_bold_italic ? findByStem(f.body_font_bold_italic) : undefined,
        desc: { weight: 'bold', style: 'italic' },
      },
    ];

    for (const { slot, face, desc } of slots) {
      if (!face) continue;
      const url = convertFileSrc(face.path);
      const familyName = previewFamilyName(slot, gen);
      try {
        const ff = new FontFace(familyName, `url("${url}")`, desc);
        await ff.load();
        document.fonts.add(ff);
      } catch {
        // Preview falla silencioso — no rompe el modal.
      }
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
        body_font_italic: blank(cur.body_font_italic),
        body_font_bold: blank(cur.body_font_bold),
        body_font_bold_italic: blank(cur.body_font_bold_italic),
        editorial_body_font: blank(cur.editorial_body_font),
        editorial_heading_font: blank(cur.editorial_heading_font),
        chapter_title_position: blank(cur.chapter_title_position),
        prefijo_capitulo: blank(cur.prefijo_capitulo),
        mostrar_titulo_capitulo: cur.mostrar_titulo_capitulo,
        dropcap: cur.dropcap,
        mostrar_numero_parte: cur.mostrar_numero_parte,
        formato_parte: blank(cur.formato_parte),
        template: blank(cur.template),
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

function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name;
  return name.slice(0, idx);
}
