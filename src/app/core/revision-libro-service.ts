import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { detectarEnCapitulo } from '../revision/deteccion';
import { SettingsService } from './settings-service';
import { TreeNode } from './types';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ConteoDetector {
  cambios: number;
  capitulos: number;
}

export interface ResumenRevision {
  rayas: ConteoDetector;
  comillas: ConteoDetector;
  arreglosRae: ConteoDetector;
  repeticiones: ConteoDetector;
}

/**
 * Escanea un libro entero con los cuatro detectores (rayas, comillas,
 * arreglos RAE, repeticiones) y devuelve conteos. No escribe nada — aplicar
 * las correcciones es responsabilidad de otro servicio.
 */
@Injectable({ providedIn: 'root' })
export class RevisionLibroService {
  private settings = inject(SettingsService);

  readonly libro = signal<TreeNode | null>(null);
  readonly escaneando = signal<boolean>(false);
  readonly resultado = signal<ResumenRevision | null>(null);
  readonly error = signal<string | null>(null);

  abrirPara(node: TreeNode): void {
    if (node.kind !== 'book') return;
    this.resultado.set(null);
    this.error.set(null);
    this.libro.set(node);
  }

  cerrar(): void {
    this.libro.set(null);
  }

  /** Palabras del diccionario de la saga que contiene al libro. `find_saga_dir`
   *  (Rust) ya resuelve esto por filesystem — sube desde `node.path` buscando
   *  `saga.json` o, si no hay, el padre del dir con `book.json` — así que no
   *  hace falta caminar el árbol en TS ni preocuparse por el root también
   *  `kind: 'saga'` (ver `fs.rs::get_tree`): esa ambigüedad es del árbol en
   *  memoria, no del filesystem. Mismo patrón que
   *  `book-config-modal.ts::loadSagaTheme`. */
  private async palabrasDeLaSaga(node: TreeNode): Promise<string[]> {
    try {
      const sagaPath = await invoke<string | null>('find_saga_dir', { path: node.path });
      if (!sagaPath || sagaPath === node.path) return [];
      return await invoke<string[]>('get_saga_dictionary', { sagaPath });
    } catch {
      return [];
    }
  }

  async escanear(): Promise<void> {
    const node = this.libro();
    if (!node) return;
    this.escaneando.set(true);
    this.error.set(null);
    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      const vacio = (): ConteoDetector => ({ cambios: 0, capitulos: 0 });
      const res: ResumenRevision = {
        rayas: vacio(), comillas: vacio(), arreglosRae: vacio(), repeticiones: vacio(),
      };
      // Una sola vez para todo el libro: es el mismo diccionario de saga para
      // todos sus capítulos.
      const diccionario = await this.palabrasDeLaSaga(node);
      // Los nombres propios inventados del mundo. Sin esto, que `Kallai`
      // aparezca cinco veces en una escena cuenta como cinco repeticiones y el
      // número que ve el autor no significa nada. Es la misma fuente que usa
      // el detector inline del editor (`editor.ts:1333`).
      const excepciones = this.settings.repeticionesExcepciones();
      let procesados = 0;
      for (const p of payloads) {
        const det = detectarEnCapitulo(p.html, p.idioma, { excepciones, diccionario });
        if (det.rayas > 0) { res.rayas.cambios += det.rayas; res.rayas.capitulos += 1; }
        if (det.comillas > 0) { res.comillas.cambios += det.comillas; res.comillas.capitulos += 1; }
        if (det.arreglosRae > 0) { res.arreglosRae.cambios += det.arreglosRae; res.arreglosRae.capitulos += 1; }
        if (det.repeticiones > 0) { res.repeticiones.cambios += det.repeticiones; res.repeticiones.capitulos += 1; }

        procesados += 1;
        if (procesados % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      this.resultado.set(res);
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.escaneando.set(false);
    }
  }
}
