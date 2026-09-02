import {
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { BookConfig, BookConfigService } from '../core/book-config-service';
import { FontsService } from '../core/fonts-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SagaConfigService } from '../core/saga-config-service';
import { ThemesService } from '../core/themes-service';
import { Theme, ThemeRef, TreeNode } from '../core/types';
import { NodeActionsService } from '../shared/node-actions-service';
import { Select, SelectOption } from '../shared/select';

/** Espejo de `epub.rs::texto_inciso_default`. Si cambia allá, cambia acá:
 *  el textarea precarga esto y solo se guarda lo que el autor edite. */
const TEXTOS_LEGALES_DEFAULT: Record<string, { es: string; en: string }> = {
  reserva: {
    es: 'Todos los derechos reservados. Ninguna parte de esta publicación puede ser reproducida, almacenada ni transmitida en forma alguna por medio electrónico, mecánico, fotocopia, grabación u otros sin autorización escrita del autor.',
    en: 'All rights reserved. No part of this publication may be reproduced, stored or transmitted in any form or by any means, electronic, mechanical, photocopying, recording or otherwise, without the prior written permission of the author.',
  },
  ficcion: {
    es: 'Esta novela es enteramente una obra de ficción. Los nombres, personajes y eventos retratados son producto de la imaginación del autor. Cualquier parecido con personas reales, vivas o fallecidas, eventos o lugares es enteramente coincidencia.',
    en: "This novel is entirely a work of fiction. The names, characters and incidents portrayed in it are the work of the author's imagination. Any resemblance to actual persons, living or dead, events or localities is entirely coincidental.",
  },
  ia: {
    es: 'Las imágenes de esta obra fueron generadas con inteligencia artificial. El texto es obra exclusiva del autor.',
    en: 'The images in this work were generated with artificial intelligence. The text is the sole work of the author.',
  },
};

const INCISOS = [
  { clave: 'reserva', label: 'Reserva de derechos' },
  { clave: 'ficcion', label: 'Obra de ficción' },
  { clave: 'ia', label: 'Uso de IA' },
] as const;

@Component({
  selector: 'app-book-config-modal',
  imports: [FormsModule, Select],
  templateUrl: './book-config-modal.html',
  styleUrl: './book-config-modal.scss',
})
export class BookConfigModal {
  private svc = inject(BookConfigService);
  protected themesSvc = inject(ThemesService);
  private sagaCfg = inject(SagaConfigService);
  private fontsSvc = inject(FontsService);
  private dialogs = inject(NativeDialogsService);
  private nodeActions = inject(NodeActionsService);

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
  protected readonly ovEditorialBodyFont = signal<string>('');
  protected readonly ovEditorialHeadingFont = signal<string>('');
  protected readonly ovChapterTitlePosition = signal<string>('');

  protected readonly availableThemes = computed(() => this.themesSvc.list());
  protected readonly selectedBaseTheme = computed(() => {
    const id = this.themeBase();
    if (!id) return null;
    return this.availableThemes().find((t) => t.id === id) ?? null;
  });
  /** Tema base que la saga padre tiene configurado (lo que se hereda si dejás vacío). */
  protected readonly sagaThemeBase = signal<string | null>(null);
  protected readonly sagaThemeLabel = computed(() => {
    const id = this.sagaThemeBase();
    if (!id) return null;
    const meta = this.availableThemes().find((t) => t.id === id);
    return meta?.nombre || meta?.id || id;
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

  protected readonly incisos = INCISOS;
  /** Claves de incisos con el textarea desplegado. */
  protected readonly editandoTexto = signal<Set<string>>(new Set());

  protected readonly idiomaOptions: SelectOption[] = [
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'Inglés' },
  ];

  protected readonly themeBaseOptions = computed<SelectOption[]>(() => {
    const sagaLabel = this.sagaThemeLabel();
    const inheritLabel = sagaLabel ? `Heredar de saga (${sagaLabel})` : 'Heredar de saga';
    return [
      { value: '', label: inheritLabel },
      ...this.availableThemes().map((t) => ({ value: t.id, label: t.nombre || t.id })),
    ];
  });

  protected readonly chapterTitlePositionOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.selectedBaseTheme()?.chapter_title_position || 'Heredar (centrado)' },
    { value: 'top', label: 'Arriba' },
    { value: 'center', label: 'Centrado (explícito)' },
    { value: 'bottom', label: 'Abajo' },
  ]);

  constructor() {
    effect(() => {
      const node = this.editing();
      if (!node) {
        this.config.set(null);
        this.sagaThemeBase.set(null);
        this.resetTheme();
        return;
      }
      void this.load(node.path);
      void this.themesSvc.refresh();
      void this.fontsSvc.refresh(node.path);
      void this.loadSagaTheme(node.path);
    });
  }

  private async loadSagaTheme(bookPath: string): Promise<void> {
    try {
      const sagaPath = await invoke<string | null>('find_saga_dir', { path: bookPath });
      if (!sagaPath || sagaPath === bookPath) {
        this.sagaThemeBase.set(null);
        return;
      }
      const cfg = await this.sagaCfg.load(sagaPath);
      this.sagaThemeBase.set(cfg.theme?.base ?? null);
    } catch {
      this.sagaThemeBase.set(null);
    }
  }

  private resetTheme(): void {
    this.themeBase.set('');
    this.ovBodyFont.set('');
    this.ovBodySize.set('');
    this.ovHeadingFont.set('');
    this.ovHeadingSize.set('');
    this.ovLineHeight.set('');
    this.ovPageMargin.set('');
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
        link: cfg.link ?? '',
        obra_de_ficcion: cfg.obra_de_ficcion ?? null,
        nota_ia: cfg.nota_ia ?? null,
        textos_legales: cfg.textos_legales ?? null,
        dedicatoria: cfg.dedicatoria ?? '',
        imprenta: cfg.imprenta ?? 'Independiente',
        serie: cfg.serie ?? '',
        numero_en_serie: cfg.numero_en_serie ?? null,
        // Campos de "Estilo de capítulos" preservados desde book.json
        // legacy. Nuevos UIs los editan en el theme editor; acá solo se
        // preservan en memoria para no perderlos en el round-trip.
        mostrar_titulo_capitulo: cfg.mostrar_titulo_capitulo ?? null,
        prefijo_capitulo: cfg.prefijo_capitulo ?? null,
        dropcap: cfg.dropcap ?? null,
        mostrar_numero_parte: cfg.mostrar_numero_parte ?? null,
        formato_parte: cfg.formato_parte ?? null,
        template: cfg.template ?? null,
        finalizada: cfg.finalizada ?? false,
        epilogo: cfg.epilogo ?? null,
        sobre_el_autor: cfg.sobre_el_autor ?? '',
        foto_autor: cfg.foto_autor ?? '',
      });
      this.hydrateTheme(cfg.theme ?? null);
    } catch (err) {
      this.error.set(String(err));
    }
  }

  protected async pickCover(): Promise<void> {
    const result = await this.dialogs.pickSingleFile({
      title: 'Seleccionar tapa',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
      defaultPath: this.bookPath() ?? undefined,
    });
    if (!result) return;
    const rel = await this.adoptImage(result, 'cover');
    if (!rel) return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, tapa: rel });
  }

  protected async pickBackCover(): Promise<void> {
    const result = await this.dialogs.pickSingleFile({
      title: 'Seleccionar contratapa',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
      defaultPath: this.bookPath() ?? undefined,
    });
    if (!result) return;
    const rel = await this.adoptImage(result, 'back-cover');
    if (!rel) return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, contratapa: rel });
  }

  /**
   * Deja la imagen dentro de la carpeta del libro y devuelve el nombre
   * relativo. El path absoluto del file dialog no sirve: la imagen no viaja
   * por git y el EPUB sale sin portada en la otra PC.
   */
  private async adoptImage(source: string, stem: string): Promise<string | null> {
    const dir = this.bookPath();
    if (!dir) return null;
    try {
      return await invoke<string>('adopt_config_image', {
        dirPath: dir,
        sourcePath: source,
        stem,
      });
    } catch (err) {
      this.error.set(`No se pudo usar esa imagen: ${err}`);
      return null;
    }
  }

  protected update<K extends keyof BookConfig>(key: K, value: BookConfig[K]): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, [key]: value });
  }

  protected incisoActivo(clave: string): boolean {
    const c = this.config();
    if (!c) return false;
    const reserva = c.derechos_reservados ?? true;
    if (clave === 'reserva') return reserva;
    if (clave === 'ficcion') return c.obra_de_ficcion ?? reserva;
    return c.nota_ia ?? false;
  }

  protected setInciso(clave: string, activo: boolean): void {
    const c = this.config();
    if (!c) return;
    if (clave === 'reserva') {
      // Al apagar la reserva, el inciso de ficción tenía que quedar donde
      // estaba: lo materializamos antes de que el default lo arrastre.
      const ficcion = this.incisoActivo('ficcion');
      this.config.set({ ...c, derechos_reservados: activo, obra_de_ficcion: ficcion });
      return;
    }
    if (clave === 'ficcion') this.config.set({ ...c, obra_de_ficcion: activo });
    else this.config.set({ ...c, nota_ia: activo });
  }

  protected textoInciso(clave: string): string {
    const c = this.config();
    const propio = c?.textos_legales?.[clave];
    if (propio) return propio;
    const idioma = c?.idioma === 'en' ? 'en' : 'es';
    return TEXTOS_LEGALES_DEFAULT[clave][idioma];
  }

  protected setTextoInciso(clave: string, valor: string): void {
    const c = this.config();
    if (!c) return;
    const idioma = c.idioma === 'en' ? 'en' : 'es';
    const textos = { ...(c.textos_legales ?? {}) };
    // Si volvió al default, no guardamos nada: el book.json queda limpio y
    // el texto sigue el idioma del libro si mañana cambia.
    if (valor.trim() === TEXTOS_LEGALES_DEFAULT[clave][idioma].trim()) delete textos[clave];
    else textos[clave] = valor;
    this.config.set({
      ...c,
      textos_legales: Object.keys(textos).length ? textos : null,
    });
  }

  protected toggleEdicionTexto(clave: string): void {
    this.editandoTexto.update((set) => {
      const next = new Set(set);
      if (next.has(clave)) next.delete(clave);
      else next.add(clave);
      return next;
    });
  }

  /** Ver el gemelo en `saga-config-modal.ts`: mismo criterio, la carpeta del
   *  libro es la fuente de verdad y `titulo` no puede divergir de ella. */
  private async renameFolderIfNeeded(node: TreeNode, titulo: string): Promise<string> {
    const match = node.name.match(/^\d+\s*-\s*/);
    const prefix = match ? match[0] : '';
    const current = node.name.slice(prefix.length);
    const trimmed = titulo.trim();
    if (!trimmed || trimmed === current) return node.path;
    return this.nodeActions.renameNodeTo(node, `${prefix}${trimmed}`);
  }

  protected async save(): Promise<void> {
    const path = this.bookPath();
    const cfg = this.config();
    const node = this.editing();
    if (!path || !cfg || !node) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      // Normalizar: vacíos a null
      const cleaned: BookConfig = {
        titulo: cfg.titulo.trim(),
        subtitulo: blank(cfg.subtitulo),
        autor: blank(cfg.autor),
        idioma: cfg.idioma,
        isbn: blank(cfg.isbn),
        tapa: blank(cfg.tapa),
        contratapa: blank(cfg.contratapa),
        copyright_anio: cfg.copyright_anio || null,
        derechos_reservados: cfg.derechos_reservados ?? null,
        link: blank(cfg.link),
        obra_de_ficcion: cfg.obra_de_ficcion ?? null,
        nota_ia: cfg.nota_ia ?? null,
        textos_legales: cfg.textos_legales ?? null,
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
        sobre_el_autor: blank(cfg.sobre_el_autor),
        foto_autor: blank(cfg.foto_autor),
      };
      const finalPath = await this.renameFolderIfNeeded(node, cleaned.titulo);
      await this.svc.save(finalPath, cleaned);
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

