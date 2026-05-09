import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { BookConfig } from './book-config-service';
import { SagaConfig } from './saga-config-service';
import { SettingsService } from './settings-service';

export type WizardStep =
  | 'tipo'
  | 'source'
  | 'saga-config'
  | 'estructura'
  | 'metadata'
  | 'resumen'
  | 'progreso'
  | 'completo';
export type SourceKind = 'saga' | 'book';

export interface SourceFile {
  path: string;
  name: string;
  ext: string;
  is_chapter_candidate: boolean;
}

export type SourceNode =
  | {
      kind: 'book';
      path: string;
      name: string;
      sections: SourceNode[];
      chapters: SourceFile[];
      extras: SourceFile[];
    }
  | {
      kind: 'section';
      path: string;
      name: string;
      chapters: SourceFile[];
      extras: SourceFile[];
    };

export interface SourceTree {
  root_path: string;
  suggested_kind: SourceKind;
  name: string;
  children: SourceNode[];
  direct_chapters: SourceFile[];
  direct_extras: SourceFile[];
}

export interface ChapterImport {
  source_path: string;
  target_name: string;
  orden: number;
  titulo: string;
  idioma: string | null;
}

export interface ExtraImport {
  source_path: string;
  relative_dest: string;
}

export interface SectionImportSpec {
  dir_name: string;
  convert_chapters: boolean;
  chapters: ChapterImport[];
  extras: ExtraImport[];
}

export interface BookImportSpec {
  dir_name: string;
  config: BookConfig;
  convert_chapters: boolean;
  sections: SectionImportSpec[];
  direct_chapters: ChapterImport[];
  extras: ExtraImport[];
}

export interface SagaImportSpec {
  dir_name: string;
  config: SagaConfig;
}

export interface WizardPlan {
  target_root: string;
  saga: SagaImportSpec | null;
  books: BookImportSpec[];
}

export interface ImportSummary {
  created_dirs: number;
  converted_chapters: number;
  copied_chapters: number;
  copied_extras: number;
  failed: string[];
}

export interface ProgressPayload {
  done: number;
  total: number;
  current: string;
}

/** Estructura editable que el componente mantiene durante el step `estructura`. */
export interface EditableBook {
  source_path: string;
  dir_name: string;
  include: boolean;
  convert_chapters: boolean;
  sections: EditableSection[];
  direct_chapters: EditableChapter[];
  extras: EditableExtra[];
  config: BookConfig;
}

export interface EditableSection {
  source_path: string;
  dir_name: string;
  include: boolean;
  convert_chapters: boolean;
  chapters: EditableChapter[];
  extras: EditableExtra[];
}

export interface EditableChapter {
  source_path: string;
  source_name: string;
  source_ext: string;
  target_name: string;
  include: boolean;
  titulo: string;
}

export interface EditableExtra {
  source_path: string;
  source_name: string;
  source_ext: string;
  relative_dest: string;
  include: boolean;
}

@Injectable({ providedIn: 'root' })
export class ImportWizardService {
  private settings = inject(SettingsService);

  readonly open = signal<boolean>(false);
  readonly step = signal<WizardStep>('tipo');
  readonly tipo = signal<SourceKind | null>(null);
  readonly sourcePath = signal<string | null>(null);
  readonly tree = signal<SourceTree | null>(null);
  readonly scanning = signal<boolean>(false);
  readonly applying = signal<boolean>(false);
  readonly progress = signal<ProgressPayload | null>(null);
  readonly summary = signal<ImportSummary | null>(null);
  readonly error = signal<string | null>(null);

  readonly sagaConfig = signal<SagaConfig>({ nombre: '' });
  readonly sagaDirName = signal<string>('');
  readonly books = signal<EditableBook[]>([]);

  readonly canApply = computed(() => {
    const root = this.settings.root();
    if (!root) return false;
    if (this.books().length === 0) return false;
    return this.books().some((b) => b.include);
  });

  private unlisten: UnlistenFn | null = null;

  show(): void {
    this.reset();
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.detachProgress();
  }

  reset(): void {
    this.step.set('tipo');
    this.tipo.set(null);
    this.sourcePath.set(null);
    this.tree.set(null);
    this.scanning.set(false);
    this.applying.set(false);
    this.progress.set(null);
    this.summary.set(null);
    this.error.set(null);
    this.sagaConfig.set({ nombre: '' });
    this.sagaDirName.set('');
    this.books.set([]);
  }

  setTipo(kind: SourceKind): void {
    this.tipo.set(kind);
    this.step.set('source');
  }

  async scan(path: string): Promise<void> {
    this.sourcePath.set(path);
    this.scanning.set(true);
    this.error.set(null);
    try {
      const tree = await invoke<SourceTree>('scan_import_source', { path });
      this.tree.set(tree);
      this.hydrateEditableFromTree(tree);
      // Saga: pasar a saga-config primero. Novela: directo a estructura.
      this.step.set(this.tipo() === 'saga' ? 'saga-config' : 'estructura');
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.scanning.set(false);
    }
  }

  /** Aplica defaults de saga a todos los books (titulo no se toca, resto sí si está vacío). */
  applySagaDefaultsToBooks(): void {
    const cfg = this.sagaConfig();
    this.books.update((list) =>
      list.map((b) => ({
        ...b,
        config: {
          ...b.config,
          autor: b.config.autor || cfg.autor || null,
          idioma: b.config.idioma || cfg.idioma || null,
          imprenta: b.config.imprenta || cfg.imprenta || null,
          template: b.config.template ?? cfg.template ?? null,
          mostrar_titulo_capitulo:
            b.config.mostrar_titulo_capitulo ?? cfg.mostrar_titulo_capitulo ?? null,
          prefijo_capitulo: b.config.prefijo_capitulo ?? cfg.prefijo_capitulo ?? null,
          dropcap: b.config.dropcap ?? cfg.dropcap ?? null,
          mostrar_numero_parte:
            b.config.mostrar_numero_parte ?? cfg.mostrar_numero_parte ?? null,
          formato_parte: b.config.formato_parte ?? cfg.formato_parte ?? null,
        },
      })),
    );
  }

  private hydrateEditableFromTree(tree: SourceTree): void {
    const isSaga = this.tipo() === 'saga';
    if (isSaga) {
      this.sagaDirName.set(tree.name);
      this.sagaConfig.set({
        nombre: tree.name,
        autor: null,
        idioma: null,
        diccionario: null,
        imprenta: 'Independiente',
        template: '6x9',
        mostrar_titulo_capitulo: true,
        prefijo_capitulo: 'none',
        dropcap: false,
        mostrar_numero_parte: false,
        formato_parte: 'raw',
      });
    } else {
      this.sagaDirName.set('');
      this.sagaConfig.set({ nombre: '' });
    }
    const books: EditableBook[] = [];
    let bookIndex = 1;
    for (const child of tree.children) {
      if (child.kind !== 'book') continue;
      const dirName = isSaga ? `${bookIndex} - ${child.name}` : child.name;
      books.push(this.buildEditableBook(child, dirName));
      bookIndex += 1;
    }
    this.books.set(books);
  }

  private buildEditableBook(node: SourceNode & { kind: 'book' }, dirName: string): EditableBook {
    return {
      source_path: node.path,
      dir_name: dirName,
      include: true,
      convert_chapters: true,
      sections: node.sections.map((s, i) => this.buildEditableSection(s, i + 1)),
      direct_chapters: node.chapters.map((c, i) => this.buildEditableChapter(c, i + 1)),
      extras: node.extras.map((x) => this.buildEditableExtra(x)),
      config: {
        titulo: node.name,
        idioma: null,
      },
    };
  }

  private buildEditableSection(node: SourceNode, idx: number): EditableSection {
    if (node.kind !== 'section') {
      return {
        source_path: '',
        dir_name: '',
        include: false,
        convert_chapters: true,
        chapters: [],
        extras: [],
      };
    }
    return {
      source_path: node.path,
      dir_name: `${idx} - ${node.name}`,
      include: true,
      convert_chapters: true,
      chapters: node.chapters.map((c, i) => this.buildEditableChapter(c, i + 1)),
      extras: node.extras.map((x) => this.buildEditableExtra(x)),
    };
  }

  private buildEditableChapter(file: SourceFile, idx: number): EditableChapter {
    return {
      source_path: file.path,
      source_name: file.name,
      source_ext: file.ext,
      target_name: String(idx),
      include: true,
      titulo: file.name,
    };
  }

  private buildEditableExtra(file: SourceFile): EditableExtra {
    const fname = `${file.name}${file.ext ? '.' + file.ext : ''}`;
    return {
      source_path: file.path,
      source_name: file.name,
      source_ext: file.ext,
      relative_dest: `extras/${fname}`,
      include: true,
    };
  }

  /** Construye el WizardPlan desde el estado editable. */
  buildPlan(): WizardPlan | null {
    const root = this.settings.root();
    if (!root) return null;
    const includedBooks = this.books().filter((b) => b.include);
    if (includedBooks.length === 0) return null;
    const saga: SagaImportSpec | null = this.tipo() === 'saga'
      ? { dir_name: this.sagaDirName().trim() || this.sagaConfig().nombre, config: this.sagaConfig() }
      : null;

    const books: BookImportSpec[] = includedBooks.map((b) => ({
      dir_name: b.dir_name,
      config: b.config,
      convert_chapters: b.convert_chapters,
      sections: b.sections
        .filter((s) => s.include)
        .map((s) => ({
          dir_name: s.dir_name,
          convert_chapters: s.convert_chapters,
          chapters: s.chapters
            .filter((c) => c.include)
            .map((c) => this.toChapterImport(c, b.config.idioma ?? null)),
          extras: s.extras
            .filter((x) => x.include)
            .map((x) => ({ source_path: x.source_path, relative_dest: x.relative_dest })),
        })),
      direct_chapters: b.direct_chapters
        .filter((c) => c.include)
        .map((c) => this.toChapterImport(c, b.config.idioma ?? null)),
      extras: b.extras
        .filter((x) => x.include)
        .map((x) => ({ source_path: x.source_path, relative_dest: x.relative_dest })),
    }));
    return { target_root: root, saga, books };
  }

  private toChapterImport(c: EditableChapter, idioma: string | null): ChapterImport {
    return {
      source_path: c.source_path,
      target_name: c.target_name,
      orden: parseInt(c.target_name, 10) || 0,
      titulo: c.titulo,
      idioma,
    };
  }

  async apply(): Promise<void> {
    const plan = this.buildPlan();
    if (!plan) {
      this.error.set('No hay libros para importar.');
      return;
    }
    this.applying.set(true);
    this.error.set(null);
    this.summary.set(null);
    this.progress.set({ done: 0, total: 0, current: '' });
    this.step.set('progreso');
    await this.attachProgress();
    try {
      const summary = await invoke<ImportSummary>('import_wizard_apply', { plan });
      this.summary.set(summary);
      this.step.set('completo');
    } catch (e) {
      this.error.set(String(e));
      this.step.set('estructura');
    } finally {
      this.applying.set(false);
      this.detachProgress();
    }
  }

  private async attachProgress(): Promise<void> {
    this.detachProgress();
    this.unlisten = await listen<ProgressPayload>('import-progress', (event) => {
      this.progress.set(event.payload);
    });
  }

  private detachProgress(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}
