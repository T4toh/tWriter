import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { ChapterService } from './chapter-service';
import { NoteService } from './note-service';
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
    this.draggingNode.set(node);
    // Backstop del `dragend` del tree: ese handler vive en el nodo arrastrado,
    // así que si Angular re-renderiza el árbol durante el drag (refresh, pintar
    // la nota activa, expandir una carpeta) el elemento se destruye con su
    // listener y el evento nunca llega — el hint "Soltar acá para abrir en
    // split" queda pintado para siempre. El listener en `window` sobrevive esa
    // churn. `dragend` dispara también al cancelar con Escape o al soltar fuera
    // de la ventana.
    //
    // Ojo: NO escuchar `drop` acá. En captura sobre `window` correría ANTES del
    // `onCenterDrop` del shell, que lee `draggingNode()` para saber qué abrir.
    const cerrar = (): void => {
      window.removeEventListener('dragend', cerrar, true);
      this.endDrag();
    };
    window.addEventListener('dragend', cerrar, true);
  }

  endDrag(): void {
    this.draggingNode.set(null);
  }
}
