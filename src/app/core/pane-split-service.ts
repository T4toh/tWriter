import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ChapterService } from './chapter-service';
import { NoteService } from './note-service';
import { armarCierreDeDrag } from './drag-cleanup';
import { TreeNode } from './types';

export interface DraggingNode {
  path: string;
  kind: TreeNode['kind'];
}

@Injectable({ providedIn: 'root' })
export class PaneSplitService {
  private chapter = inject(ChapterService);
  private note = inject(NoteService);

  readonly splitEnabled = signal<boolean>(false);
  readonly orientation = signal<'horizontal' | 'vertical'>('horizontal');
  /** Set por el tree mientras arrastra un nodo. App shell observa para mostrar drop zone. */
  readonly draggingNode = signal<DraggingNode | null>(null);
  /** Desarma el cierre del drag en curso. Null cuando no hay drag. */
  private desarmarCierre: (() => void) | null = null;

  /** True si el pane 1 tiene chapter o note activos. */
  readonly hasSecondaryContent = computed(
    () =>
      this.chapter.panes[1].active() !== null ||
      this.note.panes[1].active() !== null,
  );

  constructor() {
    // Si pane 1 quedó vacío estando split, deshabilitar split.
    effect(() => {
      const enabled = this.splitEnabled();
      const has = this.hasSecondaryContent();
      if (enabled && !has) {
        this.splitEnabled.set(false);
      }
    });
  }

  enableSplit(): void {
    this.splitEnabled.set(true);
  }

  disableSplit(): void {
    this.splitEnabled.set(false);
  }

  closeSecondary(): void {
    this.chapter.closeInPane(1);
    this.note.closeInPane(1);
    this.splitEnabled.set(false);
  }

  toggleOrientation(): void {
    this.orientation.update((o) => (o === 'horizontal' ? 'vertical' : 'horizontal'));
  }

  beginDrag(node: DraggingNode): void {
    // Un drag nuevo sin que el anterior cerrara: desarmar el viejo primero para
    // no acumular listeners ni watchdogs.
    this.desarmarCierre?.();
    this.draggingNode.set(node);
    // El `(dragend)` del tree vive en el nodo arrastrado, así que si Angular
    // re-renderiza el árbol a mitad del drag el elemento se destruye con su
    // listener y el hint "Soltar acá para abrir en split" queda pintado para
    // siempre. `armarCierreDeDrag` cubre eso por dos caminos que no dependen de
    // que el nodo siga vivo — ver el comentario de `drag-cleanup.ts`.
    this.desarmarCierre = armarCierreDeDrag(window, () => this.endDrag(), {
      set: (cb, ms) => setTimeout(cb, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  }

  endDrag(): void {
    // Primero soltar la referencia: `desarmar` es idempotente, pero así este
    // método sigue siendo seguro de llamar desde el propio cierre.
    const desarmar = this.desarmarCierre;
    this.desarmarCierre = null;
    desarmar?.();
    this.draggingNode.set(null);
  }
}
