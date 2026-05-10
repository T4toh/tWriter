import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { ThemesService } from '../core/themes-service';
import { FontEntry, Theme } from '../core/types';
import { ModalService } from '../shared/modal-service';
import { ToastService } from '../core/toast-service';

interface EditableTheme {
  nombre: string;
  body_font: string;
  body_size: string;
  heading_font: string;
  heading_size: string;
  line_height: string;
  page_margin: string;
}

@Component({
  selector: 'app-theme-editor-modal',
  imports: [FormsModule],
  templateUrl: './theme-editor-modal.html',
  styleUrl: './theme-editor-modal.scss',
})
export class ThemeEditorModal {
  private svc = inject(ThemesService);
  private modal = inject(ModalService);
  private toast = inject(ToastService);

  protected readonly editing = this.svc.editing;
  protected readonly form = signal<EditableTheme | null>(null);
  protected readonly fonts = signal<FontEntry[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Familias únicas detectadas en las fuentes del tema, para sugerir en los selects. */
  protected readonly availableFamilies = computed(() => {
    const set = new Set<string>();
    for (const f of this.fonts()) {
      if (f.family) set.add(f.family);
    }
    return Array.from(set).sort();
  });

  constructor() {
    effect(() => {
      const id = this.editing();
      if (!id) {
        this.form.set(null);
        this.fonts.set([]);
        return;
      }
      void this.load(id);
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
      });
      const fonts = await this.svc.listFonts(id);
      this.fonts.set(fonts);
    } catch (err) {
      this.error.set(String(err));
    }
  }

  protected update<K extends keyof EditableTheme>(key: K, value: EditableTheme[K]): void {
    const cur = this.form();
    if (!cur) return;
    this.form.set({ ...cur, [key]: value });
  }

  protected async pickFont(): Promise<void> {
    const id = this.editing();
    if (!id) return;
    const result = await openDialog({
      multiple: true,
      directory: false,
      title: 'Agregar fuentes',
      filters: [{ name: 'Fuentes', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    });
    const paths = Array.isArray(result) ? result : result ? [result] : [];
    if (paths.length === 0) return;
    for (const p of paths) {
      try {
        await this.svc.addFont(id, p);
      } catch (err) {
        this.toast.error(`No pude agregar ${p}: ${err}`);
      }
    }
    this.fonts.set(await this.svc.listFonts(id));
  }

  protected async openFontFile(font: FontEntry): Promise<void> {
    try {
      await openPath(font.path);
    } catch (err) {
      this.toast.error(`No pude abrir: ${err}`);
    }
  }

  protected async renameFont(font: FontEntry): Promise<void> {
    const id = this.editing();
    if (!id) return;
    const newName = await this.modal.prompt({
      title: 'Renombrar fuente',
      message: 'Nuevo nombre del archivo (mantener extensión .ttf/.otf/.woff/.woff2):',
      defaultValue: font.name,
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin separadores';
        if (!/\.(ttf|otf|woff|woff2)$/i.test(t)) return 'Extensión inválida';
        return null;
      },
    });
    if (!newName) return;
    try {
      await this.svc.renameFont(id, font.relative_path, newName);
      this.fonts.set(await this.svc.listFonts(id));
    } catch (err) {
      this.toast.error(`No pude renombrar: ${err}`);
    }
  }

  protected async removeFont(font: FontEntry): Promise<void> {
    const id = this.editing();
    if (!id) return;
    const ok = await this.modal.confirm({
      title: 'Borrar fuente',
      message: `¿Borrar ${font.name} del tema? El archivo se elimina del disco.`,
      okLabel: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.svc.removeFont(id, font.relative_path);
      this.fonts.set(await this.svc.listFonts(id));
    } catch (err) {
      this.toast.error(`No pude borrar: ${err}`);
    }
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
