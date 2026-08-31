import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import {
  Bloque,
  BloqueTipo,
  bloqueVacio,
  bloquesAMarkdown,
} from '../shared/note-blocks';
import {
  NOTE_TEMPLATES,
  NoteTemplate,
  bloquesDePlantilla,
  combinarPlantillas,
} from '../shared/note-templates';
import { NoteService } from './note-service';
import { SettingsService } from './settings-service';
import { ToastService } from './toast-service';

export interface NoteFormState {
  parentDir: string;
  nombre: string;
  plantillaId: string;
  bloques: Bloque[];
}

interface NoteTemplateFile {
  nombre: string;
  path: string;
  markdown: string;
}

@Injectable({ providedIn: 'root' })
export class NoteFormService {
  private note = inject(NoteService);
  private settings = inject(SettingsService);
  private toast = inject(ToastService);

  /** Estado del modal. null = cerrado. */
  readonly editing = signal<NoteFormState | null>(null);
  readonly creando = signal(false);
  private archivos = signal<NoteTemplateFile[]>([]);

  readonly plantillas = computed<NoteTemplate[]>(() =>
    combinarPlantillas(NOTE_TEMPLATES, this.archivos()),
  );

  /** Resolver del `open()` en curso: le devuelve al caller el path creado (o
   *  null si se canceló), así el post-proceso de "que la nota quede a la vista"
   *  sigue viviendo donde ya funciona, en `node-actions-service.createNoteIn`. */
  private resolver: ((path: string | null) => void) | null = null;

  /** Abre el form para crear una nota en `parentDir` y resuelve cuando el autor
   *  crea o cancela. Recarga las plantillas del autor cada vez: pudo haber
   *  editado un `.md` de `Plantillas/` a mano o llegado uno por git desde la
   *  otra PC. */
  open(parentDir: string): Promise<string | null> {
    const inicial = NOTE_TEMPLATES[0];
    this.editing.set({
      parentDir,
      nombre: '',
      plantillaId: inicial.id,
      bloques: bloquesDePlantilla(inicial),
    });
    void this.recargarPlantillas();
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    this.editing.set(null);
    this.resolve(null);
  }

  private resolve(path: string | null): void {
    const r = this.resolver;
    this.resolver = null;
    r?.(path);
  }

  private async recargarPlantillas(): Promise<void> {
    const root = this.settings.root();
    if (!root) {
      this.archivos.set([]);
      return;
    }
    try {
      const list = await invoke<NoteTemplateFile[]>('list_note_templates', { root });
      this.archivos.set(list);
    } catch (err) {
      // No es fatal: las de fábrica alcanzan para crear la nota.
      this.archivos.set([]);
      this.toast.error(`No pude leer las plantillas de Plantillas/: ${String(err)}`);
    }
  }

  setNombre(v: string): void {
    const s = this.editing();
    if (!s) return;
    const anterior = s.nombre.trim();
    // El H1 sigue al nombre mientras el autor no lo haya escrito a mano.
    const bloques = s.bloques.map((b) =>
      b.tipo === 'h1' && (b.texto.trim() === '' || b.texto.trim() === anterior)
        ? { ...b, texto: v }
        : b,
    );
    this.editing.set({ ...s, nombre: v, bloques });
  }

  aplicarPlantilla(id: string): void {
    const s = this.editing();
    if (!s) return;
    const tpl = this.plantillas().find((t) => t.id === id);
    if (!tpl) return;
    const bloques = bloquesDePlantilla(tpl);
    const h1 = bloques.find((b) => b.tipo === 'h1');
    if (h1) h1.texto = s.nombre;
    this.editing.set({ ...s, plantillaId: id, bloques });
  }

  /** true si hay algo escrito que se perdería al cambiar de plantilla. */
  tieneContenido(): boolean {
    const s = this.editing();
    if (!s) return false;
    return s.bloques.some(
      (b) =>
        (b.tipo === 'parrafo' && b.texto.trim() !== '') ||
        (b.tipo === 'lista' && b.items.some((i) => i.trim() !== '')),
    );
  }

  patchBloque(i: number, patch: Partial<Bloque>): void {
    const s = this.editing();
    if (!s || i < 0 || i >= s.bloques.length) return;
    const bloques = s.bloques.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    this.editing.set({ ...s, bloques });
  }

  addBloque(tipo: BloqueTipo): void {
    const s = this.editing();
    if (!s) return;
    this.editing.set({ ...s, bloques: [...s.bloques, bloqueVacio(tipo)] });
  }

  removeBloque(i: number): void {
    const s = this.editing();
    if (!s) return;
    this.editing.set({ ...s, bloques: s.bloques.filter((_, idx) => idx !== i) });
  }

  moverBloque(i: number, delta: -1 | 1): void {
    const s = this.editing();
    if (!s) return;
    const j = i + delta;
    if (i < 0 || j < 0 || i >= s.bloques.length || j >= s.bloques.length) return;
    const bloques = [...s.bloques];
    // ponytail: reorden por índice; el drag (cdkDropList + moveItemInArray) es
    // pulido acordado sobre este mismo array, no cambia el modelo.
    [bloques[i], bloques[j]] = [bloques[j], bloques[i]];
    this.editing.set({ ...s, bloques });
  }

  markdownActual(): string {
    const s = this.editing();
    return s ? bloquesAMarkdown(s.bloques) : '';
  }

  /** Crea la nota. Devuelve el path o null si falló (el toast ya lo dijo). */
  async crear(): Promise<string | null> {
    const s = this.editing();
    if (!s) return null;
    const nombre = s.nombre.trim();
    if (!nombre) return null;
    this.creando.set(true);
    try {
      const body = this.markdownActual();
      const creado = await this.note.createNote(s.parentDir, nombre, body || null);
      if (creado) {
        this.editing.set(null);
        this.resolve(creado);
      }
      return creado;
    } finally {
      this.creando.set(false);
    }
  }

  /** Guarda la estructura actual (sin contenido) como plantilla del autor. */
  async guardarPlantilla(nombre: string, overwrite: boolean): Promise<boolean> {
    const s = this.editing();
    const root = this.settings.root();
    if (!s || !root) return false;
    const markdown = bloquesAMarkdown(s.bloques, { plantilla: true });
    if (!markdown) {
      this.toast.error('La plantilla quedaría vacía: agregá al menos un bloque.');
      return false;
    }
    try {
      await invoke<string>('save_note_template', {
        root,
        nombre,
        markdown,
        overwrite,
      });
      await this.recargarPlantillas();
      this.toast.info(`Plantilla "${nombre}" guardada en Plantillas/`);
      return true;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('ya existe')) return false; // el componente ofrece sobrescribir
      this.toast.error(`No pude guardar la plantilla: ${msg}`);
      return false;
    }
  }
}
