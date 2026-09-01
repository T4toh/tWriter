import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideCheck, LucideX } from '@lucide/angular';
import { DictionaryService } from '../core/dictionary-service';
import { ToastService } from '../core/toast-service';
import { DerivedFormsPanel } from './derived-forms-panel';
import { inferLemma } from './derived-forms';
import { validateWord } from './word-validator';

@Component({
  selector: 'app-dictionary-modal',
  imports: [FormsModule, LucideCheck, LucideX, DerivedFormsPanel],
  templateUrl: './dictionary-modal.html',
  styleUrl: './dictionary-modal.scss',
})
export class DictionaryModal {
  private svc = inject(DictionaryService);
  private toast = inject(ToastService);

  /** Palabra para la que está abierto el panel de formas derivadas, o null. */
  protected readonly formasPara = signal<string | null>(null);
  /** El idioma sale de la saga que se está editando, no de la del capítulo
   *  abierto: el modal se abre para un nodo cualquiera del árbol y también
   *  desde el landing, donde no hay capítulo. */
  protected readonly idiomaFlexion = this.svc.idiomaFlexion;

  protected readonly editing = this.svc.editing;
  protected readonly words = this.svc.words;
  protected readonly count = this.svc.count;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly problematic = this.svc.problematic;

  protected readonly newWord = signal<string>('');
  protected readonly searchText = signal<string>('');
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly cleaning = signal<boolean>(false);
  protected readonly adding = signal<boolean>(false);

  protected readonly newWordValidation = computed(() => {
    const raw = this.newWord();
    if (!raw.trim()) return null;
    return validateWord(raw);
  });

  protected readonly canAdd = computed(() => {
    const v = this.newWordValidation();
    return v !== null && v.ok && !this.adding();
  });

  /** Mismo criterio que el popover del editor: «+ formas…» solo si hay lema que
   *  inferir. Sin esto un nombre propio en `-ar` (`Krilar`) cae al fallback del
   *  panel y ofrece 15 conjugaciones de un verbo inexistente, todas tildadas. */
  protected readonly puedeDerivar = computed<boolean>(() => {
    const idioma = this.idiomaFlexion();
    if (idioma !== 'es' || !this.canAdd()) return false;
    return inferLemma(this.newWord().trim(), idioma).length > 0;
  });

  protected readonly filteredWords = computed<string[]>(() => {
    const q = this.searchText().trim().toLowerCase();
    if (!q) return this.words();
    return this.words().filter((w) => w.toLowerCase().includes(q));
  });

  constructor() {
    // Limpiar inputs al cerrar/cambiar de saga.
    effect(() => {
      const e = this.editing();
      if (!e) {
        this.newWord.set('');
        this.searchText.set('');
        // Sin esto el panel de formas queda armado: al reabrir el modal para
        // otra saga aparece solo, con la palabra de la saga anterior.
        this.formasPara.set(null);
        this.confirmDelete.set(null);
      }
    });
  }

  protected updateNewWord(value: string): void {
    this.newWord.set(value);
  }

  protected updateSearch(value: string): void {
    this.searchText.set(value);
  }

  protected async addWord(): Promise<void> {
    if (!this.canAdd()) return;
    const raw = this.newWord();
    this.adding.set(true);
    try {
      const result = await this.svc.addWord(raw);
      if (!result.ok) {
        this.toast.error(result.reason ?? 'No se pudo agregar');
        return;
      }
      this.newWord.set('');
    } finally {
      this.adding.set(false);
    }
  }

  protected abrirFormas(palabra: string): void {
    this.formasPara.set(palabra);
  }

  protected cerrarFormas(): void {
    this.formasPara.set(null);
  }

  protected async agregarFormas(formas: string[]): Promise<void> {
    // Vía DictionaryService: escribe en la saga que el modal edita y su
    // `persist()` ya sincroniza `SagaContextService` cuando además es la activa.
    const result = await this.svc.addManyWords(formas);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudieron agregar las formas');
      return;
    }
    this.toast.success(
      result.added === 1 ? '1 forma agregada' : `${result.added} formas agregadas`,
    );
    this.formasPara.set(null);
  }

  protected onAddKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.addWord();
    }
  }

  protected askRemove(word: string): void {
    this.confirmDelete.set(word);
  }

  protected cancelRemove(): void {
    this.confirmDelete.set(null);
  }

  protected async confirmRemove(word: string): Promise<void> {
    const result = await this.svc.removeWord(word);
    if (!result.ok) {
      this.toast.error(result.reason ?? 'No se pudo borrar');
    }
    this.confirmDelete.set(null);
  }

  protected async cleanProblematic(): Promise<void> {
    this.cleaning.set(true);
    try {
      const result = await this.svc.cleanAll();
      if (!result.ok) {
        this.toast.error(result.reason ?? 'No se pudo limpiar');
        return;
      }
      if (result.removed > 0) {
        this.toast.success(`Se limpiaron ${result.removed} entradas problemáticas`);
      } else {
        this.toast.info('No había nada que limpiar');
      }
    } finally {
      this.cleaning.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }

  protected onBackdropClick(): void {
    this.close();
  }

  protected onModalKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }
}
