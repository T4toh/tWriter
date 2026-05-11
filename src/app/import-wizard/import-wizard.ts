import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  EditableBook,
  EditableSection,
  ImportWizardService,
  SourceKind,
  WizardStep,
} from '../core/import-wizard-service';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { ToastService } from '../core/toast-service';
import { ProjectService } from '../core/project-service';
import { Select, SelectOption } from '../shared/select';

@Component({
  selector: 'app-import-wizard',
  standalone: true,
  imports: [FormsModule, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-wizard.html',
  styleUrl: './import-wizard.scss',
})
export class ImportWizard {
  protected wizard = inject(ImportWizardService);
  private toast = inject(ToastService);
  private dialogs = inject(NativeDialogsService);
  private project = inject(ProjectService);

  protected readonly stepIndex = computed(() => {
    const isSaga = this.wizard.tipo() === 'saga';
    const order: WizardStep[] = isSaga
      ? ['tipo', 'source', 'saga-config', 'estructura', 'metadata', 'resumen', 'progreso', 'completo']
      : ['tipo', 'source', 'estructura', 'metadata', 'resumen', 'progreso', 'completo'];
    return order.indexOf(this.wizard.step()) + 1;
  });
  protected readonly totalSteps = computed(() => (this.wizard.tipo() === 'saga' ? 6 : 5));
  protected readonly expandedBookIdx = signal<number | null>(0);
  protected readonly expandedSections = signal<Set<string>>(new Set());

  protected readonly idiomaSagaOptions: SelectOption[] = [
    { value: '', label: '(auto-detect por capítulo)' },
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'Inglés' },
  ];
  protected readonly idiomaBookOptions: SelectOption[] = [
    { value: '', label: '(heredar saga / autodetect)' },
    { value: 'es', label: 'Español' },
    { value: 'en', label: 'Inglés' },
  ];
  protected readonly templateOptions: SelectOption[] = [
    { value: '6x9', label: '6 × 9 in (default)' },
    { value: '5x8', label: '5 × 8 in' },
    { value: 'a5', label: 'A5 (148 × 210 mm)' },
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

  protected isSectionExpanded(path: string): boolean {
    return this.expandedSections().has(path);
  }

  protected toggleSectionExpand(path: string): void {
    this.expandedSections.update((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  protected setTipo(kind: SourceKind): void {
    this.wizard.setTipo(kind);
  }

  protected async pickSource(): Promise<void> {
    const result = await this.dialogs.pickFolder({ title: 'Carpeta a importar' });
    if (!result) return;
    this.wizard.sourcePath.set(result);
  }

  protected async scan(): Promise<void> {
    const path = this.wizard.sourcePath();
    if (!path) return;
    await this.wizard.scan(path);
  }

  private mainOrder(): WizardStep[] {
    const isSaga = this.wizard.tipo() === 'saga';
    return isSaga
      ? ['tipo', 'source', 'saga-config', 'estructura', 'metadata', 'resumen']
      : ['tipo', 'source', 'estructura', 'metadata', 'resumen'];
  }

  protected back(): void {
    const order = this.mainOrder();
    const idx = order.indexOf(this.wizard.step());
    if (idx > 0) this.wizard.step.set(order[idx - 1]);
  }

  protected next(): void {
    const order = this.mainOrder();
    const idx = order.indexOf(this.wizard.step());
    if (idx >= 0 && idx < order.length - 1) {
      // Saliendo de saga-config: aplicar defaults a books
      if (this.wizard.step() === 'saga-config') {
        this.wizard.applySagaDefaultsToBooks();
      }
      this.wizard.step.set(order[idx + 1]);
    }
  }

  protected close(): void {
    this.wizard.close();
  }

  protected toggleBookInclude(book: EditableBook): void {
    this.wizard.books.update((list) =>
      list.map((b) => (b === book ? { ...b, include: !b.include } : b)),
    );
  }

  protected toggleBookConvert(book: EditableBook): void {
    this.wizard.books.update((list) =>
      list.map((b) => (b === book ? { ...b, convert_chapters: !b.convert_chapters } : b)),
    );
  }

  protected updateBookDir(book: EditableBook, value: string): void {
    this.wizard.books.update((list) =>
      list.map((b) => (b === book ? { ...b, dir_name: value } : b)),
    );
  }

  protected updateBookField<K extends 'titulo' | 'subtitulo' | 'autor' | 'idioma' | 'isbn'>(
    book: EditableBook,
    field: K,
    value: string,
  ): void {
    this.wizard.books.update((list) =>
      list.map((b) =>
        b === book ? { ...b, config: { ...b.config, [field]: value || null } } : b,
      ),
    );
  }

  protected async pickBookCover(book: EditableBook): Promise<void> {
    const result = await this.dialogs.pickSingleFile({
      title: `Tapa para "${book.config.titulo || book.dir_name}"`,
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: book.source_path,
    });
    if (!result) return;
    this.wizard.books.update((list) =>
      list.map((b) => (b === book ? { ...b, config: { ...b.config, tapa: result } } : b)),
    );
  }

  protected updateBookCoverPath(book: EditableBook, value: string): void {
    this.wizard.books.update((list) =>
      list.map((b) => (b === book ? { ...b, config: { ...b.config, tapa: value || null } } : b)),
    );
  }

  protected updateBookOrder(book: EditableBook, value: string): void {
    const n = parseInt(value, 10);
    this.wizard.books.update((list) =>
      list.map((b) =>
        b === book
          ? { ...b, config: { ...b.config, numero_en_serie: isNaN(n) ? null : n } }
          : b,
      ),
    );
  }

  protected moveBook(idx: number, dir: -1 | 1): void {
    const list = [...this.wizard.books()];
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    this.wizard.books.set(list);
  }

  protected toggleSection(book: EditableBook, sec: EditableSection): void {
    this.wizard.books.update((list) =>
      list.map((b) =>
        b === book
          ? {
              ...b,
              sections: b.sections.map((s) =>
                s === sec ? { ...s, include: !s.include } : s,
              ),
            }
          : b,
      ),
    );
  }

  protected toggleChapterInclude(book: EditableBook, sec: EditableSection | null, chSrc: string): void {
    this.wizard.books.update((list) =>
      list.map((b) => {
        if (b !== book) return b;
        if (sec) {
          return {
            ...b,
            sections: b.sections.map((s) =>
              s !== sec
                ? s
                : { ...s, chapters: s.chapters.map((c) => (c.source_path === chSrc ? { ...c, include: !c.include } : c)) },
            ),
          };
        }
        return {
          ...b,
          direct_chapters: b.direct_chapters.map((c) => (c.source_path === chSrc ? { ...c, include: !c.include } : c)),
        };
      }),
    );
  }

  protected updateChapterTarget(book: EditableBook, sec: EditableSection | null, chSrc: string, value: string): void {
    this.wizard.books.update((list) =>
      list.map((b) => {
        if (b !== book) return b;
        if (sec) {
          return {
            ...b,
            sections: b.sections.map((s) =>
              s !== sec
                ? s
                : { ...s, chapters: s.chapters.map((c) => (c.source_path === chSrc ? { ...c, target_name: value } : c)) },
            ),
          };
        }
        return {
          ...b,
          direct_chapters: b.direct_chapters.map((c) => (c.source_path === chSrc ? { ...c, target_name: value } : c)),
        };
      }),
    );
  }

  protected toggleExtraInclude(book: EditableBook, sec: EditableSection | null, xSrc: string): void {
    this.wizard.books.update((list) =>
      list.map((b) => {
        if (b !== book) return b;
        if (sec) {
          return {
            ...b,
            sections: b.sections.map((s) =>
              s !== sec
                ? s
                : { ...s, extras: s.extras.map((x) => (x.source_path === xSrc ? { ...x, include: !x.include } : x)) },
            ),
          };
        }
        return {
          ...b,
          extras: b.extras.map((x) => (x.source_path === xSrc ? { ...x, include: !x.include } : x)),
        };
      }),
    );
  }

  protected updateSectionDir(book: EditableBook, sec: EditableSection, value: string): void {
    this.wizard.books.update((list) =>
      list.map((b) =>
        b !== book ? b : { ...b, sections: b.sections.map((s) => (s !== sec ? s : { ...s, dir_name: value })) },
      ),
    );
  }

  protected toggleSectionConvert(book: EditableBook, sec: EditableSection): void {
    this.wizard.books.update((list) =>
      list.map((b) =>
        b === book
          ? {
              ...b,
              sections: b.sections.map((s) =>
                s === sec ? { ...s, convert_chapters: !s.convert_chapters } : s,
              ),
            }
          : b,
      ),
    );
  }

  protected toggleBook(idx: number): void {
    this.expandedBookIdx.update((cur) => (cur === idx ? null : idx));
  }

  protected updateSagaName(value: string): void {
    this.wizard.sagaConfig.update((c) => ({ ...c, nombre: value }));
    this.wizard.sagaDirName.set(value);
  }

  protected updateSagaField<K extends keyof { autor: string; idioma: string; imprenta: string }>(
    field: K,
    value: string,
  ): void {
    this.wizard.sagaConfig.update((c) => ({
      ...c,
      [field]: value || null,
    }));
  }

  protected updateSagaSelect<
    K extends 'template' | 'prefijo_capitulo' | 'formato_parte',
  >(field: K, value: string): void {
    this.wizard.sagaConfig.update((c) => ({
      ...c,
      [field]: (value || null) as any,
    }));
  }

  protected updateSagaBool<
    K extends 'mostrar_titulo_capitulo' | 'dropcap' | 'mostrar_numero_parte',
  >(field: K, value: boolean): void {
    this.wizard.sagaConfig.update((c) => ({
      ...c,
      [field]: value,
    }));
  }

  protected async runImport(): Promise<void> {
    await this.wizard.apply();
    const sum = this.wizard.summary();
    if (sum) {
      const ok = sum.converted_chapters + sum.copied_chapters + sum.copied_extras;
      const failed = sum.failed.length;
      if (failed > 0) {
        this.toast.warn(
          `Importación con errores: ${ok} ok, ${failed} fallidos. Revisá la lista.`,
        );
      } else {
        this.toast.success(
          `Importado: ${sum.converted_chapters} convertidos, ${sum.copied_chapters} copiados, ${sum.copied_extras} extras.`,
        );
      }
      // Refrescar tree del repo
      void this.project.loadTree();
    }
  }

  protected finish(): void {
    this.wizard.close();
  }

  protected resumenBookCount = computed(() => this.wizard.books().filter((b) => b.include).length);

  protected resumenChapterCount = computed(() => {
    let convertCount = 0;
    let copyCount = 0;
    for (const b of this.wizard.books()) {
      if (!b.include) continue;
      const sectionsConvert = b.sections.flatMap((s) =>
        s.include
          ? s.chapters.filter((c) => c.include).map(() => s.convert_chapters)
          : [],
      );
      for (const v of sectionsConvert) {
        if (v) convertCount++;
        else copyCount++;
      }
      const direct = b.direct_chapters.filter((c) => c.include);
      if (b.convert_chapters) convertCount += direct.length;
      else copyCount += direct.length;
    }
    return { convertCount, copyCount };
  });

  protected resumenExtraCount = computed(() => {
    let n = 0;
    for (const b of this.wizard.books()) {
      if (!b.include) continue;
      n += b.extras.filter((x) => x.include).length;
      for (const s of b.sections) {
        if (!s.include) continue;
        n += s.extras.filter((x) => x.include).length;
      }
    }
    return n;
  });
}
