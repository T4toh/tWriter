import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { aplicarEnCapitulo, detectarEnCapitulo, SeleccionRevision } from '../revision/deteccion';
import { GitService } from './git-service';
import { ProjectService } from './project-service';
import { SettingsService } from './settings-service';
import { ToastService } from './toast-service';
import { TreeNode } from './types';

export type { SeleccionRevision } from '../revision/deteccion';

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
  private project = inject(ProjectService);
  private git = inject(GitService);
  private toast = inject(ToastService);

  readonly libro = signal<TreeNode | null>(null);
  readonly escaneando = signal<boolean>(false);
  readonly aplicando = signal<boolean>(false);
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

  /** Aplica al libro entero las transformaciones tildadas en `seleccion`. Un
   *  solo `write_chapter` por capítulo, encadenando rayas → comillas →
   *  arreglosRae sobre el mismo HTML, y solo si algo cambió — cada write
   *  dispara el auto-commit del repo de novelas, así que escribir de más
   *  ensucia el historial. El gateo de idioma es el mismo que usa `escanear`
   *  (`aplicarEnCapitulo`, hermana pura de `detectarEnCapitulo`): un capítulo
   *  en inglés nunca puede salir con rayas españolas ni comillas aplanadas. */
  async aplicar(seleccion: SeleccionRevision): Promise<void> {
    const node = this.libro();
    if (!node) return;
    this.aplicando.set(true);
    this.error.set(null);
    const toastId = this.toast.progreso('Aplicando correcciones…');
    try {
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      let modificados = 0;
      let salteados = 0;
      let procesados = 0;
      for (const p of payloads) {
        const { html, salteados: s } = aplicarEnCapitulo(p.html, p.idioma, seleccion);
        salteados += s;
        if (html !== p.html) {
          await invoke('write_chapter', { path: p.path, html });
          modificados += 1;
        }
        procesados += 1;
        this.toast.update(toastId, `Aplicando correcciones (${procesados} de ${payloads.length})`);
        if (procesados % 5 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (modificados > 0) {
        await this.project.loadTree();
        void this.git.refreshStatus();
      }
      this.toast.success(
        `${modificados} capítulo${modificados === 1 ? '' : 's'} modificado${modificados === 1 ? '' : 's'}.`,
      );
      if (salteados > 0) {
        // No es un error: son fixes de RAE que cruzaban el borde de un tag y
        // no se aplicaron a propósito (ver `aplicarFixesHtml`). Decirlo es lo
        // mínimo — si no, el autor cuenta los arreglos y el número no le
        // cierra.
        this.toast.warn(
          `${salteados} arreglo${salteados === 1 ? '' : 's'} de RAE se saltearon por tocar texto con formato. Revisalos a mano desde el panel «Revisar RAE».`,
        );
      }
      await this.escanear();
    } catch (e) {
      this.error.set(String(e));
      this.toast.error(`Revisión: ${e}`);
    } finally {
      this.toast.dismiss(toastId);
      this.aplicando.set(false);
    }
  }
}
