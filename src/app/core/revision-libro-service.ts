import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { aplicarEnCapitulo, detectarEnCapitulo, SeleccionRevision } from '../revision/deteccion';
import { BookConfigService } from './book-config-service';
import { ChapterService, countWords } from './chapter-service';
import { DebugService } from './debug-service';
import { GitService } from './git-service';
import { NoteService } from './note-service';
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

/** Rayas y comillas: `converter`/`educateQuotes` devuelven `changes` 0|1 por
 *  capítulo (¿hubo cambio?, no cuántos), así que lo único real que se puede
 *  mostrar es en cuántos capítulos hay algo para tocar — no un conteo de
 *  cambios inventado. */
export interface ConteoCapitulos {
  capitulos: number;
}

/** Arreglos RAE y repeticiones sí traen conteo real de violaciones. */
export interface ConteoDetector {
  cambios: number;
  capitulos: number;
}

export interface ResumenRevision {
  rayas: ConteoCapitulos;
  comillas: ConteoCapitulos;
  arreglosRae: ConteoDetector;
  repeticiones: ConteoDetector;
  /** Capítulos por idioma EFECTIVO (`detectarEnCapitulo::esIngles`), contados
   *  mientras se escanea. Es lo que decide si rayas/arreglosRae (necesitan
   *  `capitulosEs > 0`) y comillas (`capitulosEn > 0`) aplican al libro —
   *  un detector puede no encontrar nada y aun así aplicar, o directamente
   *  no aplicar porque el libro no tiene ningún capítulo de ese idioma. */
  capitulosEs: number;
  capitulosEn: number;
  /** Campo `idioma` crudo de `book.json` (`null` si el libro no lo declara).
   *  Se lo muestra tal cual en el modal para que el autor distinga "esto lo
   *  declaré yo" (viene de acá) de "esto lo adivinó la app" (fallback a
   *  `.meta.json` del capítulo o a `detectLang`, ver `resolverIdiomaEfectivo`
   *  en `deteccion.ts`). */
  idiomaLibroDeclarado: string | null;
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
  private bookConfig = inject(BookConfigService);
  private chapter = inject(ChapterService);
  private note = inject(NoteService);
  private debug = inject(DebugService);

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

  /** Idioma declarado en `book.json` del libro, o `null` si no lo declara
   *  (o si `book.json` no se pudo leer). Una sola vez por libro, antes del
   *  loop de capítulos — el mismo patrón que `palabrasDeLaSaga` de acá
   *  arriba. Se lo pasa crudo a `detectarEnCapitulo`/`aplicarEnCapitulo`
   *  para que la cadena de resolución (libro → capítulo → `detectLang`)
   *  viva en un solo lugar: `resolverIdiomaEfectivo` en `deteccion.ts`. */
  private async idiomaDelLibro(node: TreeNode): Promise<string | null> {
    try {
      const cfg = await this.bookConfig.load(node.path);
      return cfg.idioma ?? null;
    } catch {
      return null;
    }
  }

  /** Escanea el libro capturado en `node` al arrancar. Si mientras tanto se
   *  cierra el modal o se abre otro libro (`this.libro()` cambia), los
   *  conteos calculados se descartan sin tocar `resultado`/`error` — si no,
   *  el escaneo de un libro A que sigue en vuelo aterriza sobre el B que el
   *  autor ya tiene abierto. `escaneando` sí se resetea siempre en el
   *  `finally`: es un flag de "hay un escaneo en curso", no un dato de libro,
   *  y dejarlo pegado en `true` trabaría el botón del libro que quedó abierto. */
  async escanear(): Promise<void> {
    const node = this.libro();
    if (!node) return;
    this.escaneando.set(true);
    this.error.set(null);
    try {
      // `list_chapters_for_audit` lee del disco. Si el autor tiene un
      // capítulo o nota abierta en el editor con un autosave pendiente (ver
      // `AUTOSAVE_MS` en chapter-service.ts), sin este flush el escaneo ve el
      // buffer viejo y los conteos que muestra no corresponden a lo que hay
      // — mismo patrón que `NodeActionsService.irAGaleria`, en los dos panes.
      await this.chapter.flushAllDirty();
      await this.note.flushAllDirty();
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      if (this.libro() !== node) return;
      // Una sola vez para todo el libro: el idioma de `book.json` (si lo
      // declara, manda para todos los capítulos) y el diccionario de saga.
      const idiomaLibro = await this.idiomaDelLibro(node);
      const diccionario = await this.palabrasDeLaSaga(node);
      if (this.libro() !== node) return;
      const vacioCap = (): ConteoCapitulos => ({ capitulos: 0 });
      const vacio = (): ConteoDetector => ({ cambios: 0, capitulos: 0 });
      const res: ResumenRevision = {
        rayas: vacioCap(), comillas: vacioCap(), arreglosRae: vacio(), repeticiones: vacio(),
        capitulosEs: 0, capitulosEn: 0, idiomaLibroDeclarado: idiomaLibro,
      };
      // Los nombres propios inventados del mundo. Sin esto, que `Kallai`
      // aparezca cinco veces en una escena cuenta como cinco repeticiones y el
      // número que ve el autor no significa nada. Es la misma fuente que usa
      // el detector inline del editor (`editor.ts:1333`).
      const excepciones = this.settings.repeticionesExcepciones();
      let procesados = 0;
      for (const p of payloads) {
        const det = detectarEnCapitulo(p.html, idiomaLibro, p.idioma, { excepciones, diccionario });
        if (det.esIngles) res.capitulosEn += 1; else res.capitulosEs += 1;
        if (det.rayas > 0) res.rayas.capitulos += 1;
        if (det.comillas > 0) res.comillas.capitulos += 1;
        if (det.arreglosRae > 0) { res.arreglosRae.cambios += det.arreglosRae; res.arreglosRae.capitulos += 1; }
        if (det.repeticiones > 0) { res.repeticiones.cambios += det.repeticiones; res.repeticiones.capitulos += 1; }

        procesados += 1;
        if (procesados % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (this.libro() !== node) return;
        }
      }
      this.resultado.set(res);
    } catch (e) {
      if (this.libro() === node) {
        // Un rescaneo fallido no puede dejar los conteos viejos ni las
        // casillas habilitadas al lado del mensaje de error.
        this.resultado.set(null);
        this.error.set(String(e));
      }
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
    // Fuera del try: si `write_chapter` falla a mitad de libro, el catch
    // necesita saber cuántos capítulos ya quedaron escritos en disco (con su
    // auto-commit ya disparado) para decírselo al autor y refrescar árbol/git.
    let modificados = 0;
    try {
      // Mismo motivo que en `escanear`: sin flushear antes, un autosave
      // pendiente que dispara DESPUÉS de este lote reescribe el archivo con
      // el buffer viejo y se pierde en silencio la corrección recién aplicada.
      await this.chapter.flushAllDirty();
      await this.note.flushAllDirty();
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: node.path,
      });
      // Mismo root e idioma de libro para todos los capítulos — se resuelven
      // una sola vez, igual que `diccionario` en `escanear`.
      const root = this.project.root();
      const idiomaLibro = await this.idiomaDelLibro(node);
      let salteados = 0;
      let procesados = 0;
      for (const p of payloads) {
        const { html, salteados: s } = aplicarEnCapitulo(p.html, idiomaLibro, p.idioma, seleccion);
        salteados += s;
        if (html !== p.html) {
          await invoke('write_chapter', { path: p.path, html });
          // Contar apenas `write_chapter` tuvo éxito, ANTES de las stats: si
          // `write_chapter_stats` de abajo falla, el capítulo ya quedó
          // escrito en disco (con su auto-commit ya disparado) y el `finally`
          // necesita saber que hay que refrescar árbol/git igual.
          modificados += 1;
          if (root) {
            // Mismo camino que `chapter-service.ts::saveInPane`: sin esto el
            // árbol y la galería siguen mostrando palabras/fecha viejas para
            // capítulos que se acaban de reescribir. Un fallo acá es
            // cosmético (stats desactualizadas) — no aborta el lote.
            try {
              await invoke('write_chapter_stats', {
                root,
                chapterPath: p.path,
                palabras: countWords(html),
                ultimaEdicion: new Date().toISOString(),
              });
            } catch (err) {
              this.debug.error('revision-libro', `stats de ${p.path}: ${err}`);
            }
          }
        }
        procesados += 1;
        this.toast.update(toastId, `Aplicando correcciones (${procesados} de ${payloads.length})`);
        if (procesados % 5 === 0) await new Promise((r) => setTimeout(r, 0));
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
      // Si mientras se aplicaba el autor cerró el modal o abrió otro libro,
      // no dispares un rescaneo fantasma sobre el libro que quedó abierto.
      if (this.libro() === node) await this.escanear();
    } catch (e) {
      // Si ya se escribieron capítulos antes del error, decirlo: el autor
      // necesita saber que el libro quedó a medio aplicar para decidir si
      // revierte con git, no solo ver el error crudo.
      const prefijo =
        modificados > 0
          ? `Se modificaron ${modificados} capítulo${modificados === 1 ? '' : 's'} antes del error. `
          : '';
      // El error solo se muestra si el modal sigue en el mismo libro — si no,
      // el mensaje de A aterriza sobre el B que el autor ya tiene abierto.
      if (this.libro() === node) this.error.set(`${prefijo}${e}`);
      this.toast.error(`Revisión: ${prefijo}${e}`);
    } finally {
      // El refresco corre en el finally (no solo en el camino feliz): si
      // `modificados > 0` el árbol y el git status quedaron desincronizados
      // aunque haya fallado a mitad de libro.
      if (modificados > 0) {
        await this.project.loadTree();
        void this.git.refreshStatus();
      }
      this.toast.dismiss(toastId);
      this.aplicando.set(false);
    }
  }
}
