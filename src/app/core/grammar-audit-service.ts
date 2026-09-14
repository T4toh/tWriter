import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { htmlToPlain } from '../dialogos/validator';
import { idiomaFlexionDe } from '../dictionary/derived-forms';
import { resolverIdiomaEfectivo } from '../revision/deteccion';
import { GrammarMatch } from './types';
import { auditTitleFromPath } from './audit-snippet';
import { BookConfigService } from './book-config-service';
import { DebugService } from './debug-service';
import { FontPreviewService } from './font-preview-service';
import { GrammarService } from './grammar-service';
import { filtrarMatchesAuditoria } from './grammar-audit-filter';
import { ImageViewerService } from './image-viewer-service';
import { MarkdownReaderService } from './markdown-reader-service';
import { RaeAuditService } from './rae-audit-service';
import { RepeticionesAuditService } from './repeticiones-audit-service';
import { SearchService } from './search-service';

interface ChapterPayload {
  path: string;
  html: string;
  idioma?: string | null;
}

export interface ChapterGrammar {
  path: string;
  title: string;
  /** El plano que se mandó a LT; los offsets de los matches son sobre este. */
  plain: string;
  matches: GrammarMatch[];
}

export interface GrammarAuditScope {
  path: string;
  name: string;
}

/**
 * Auditoría de gramática sobre un alcance (saga, libro o sección).
 *
 * Tercer hermano de `RaeAuditService` y `RepeticionesAuditService`, con la
 * misma forma. La diferencia es que el chequeo no es local ni gratis: cada
 * capítulo es un POST a LanguageTool, así que corre capítulo por capítulo con
 * progreso visible, se cancela cerrando el panel (el loop corta después de
 * cada `await`) y cachea la respuesta de LT por capítulo mientras el HTML no
 * cambie, para no volver a pegarle por lo que ya se chequeó.
 */
@Injectable({ providedIn: 'root' })
export class GrammarAuditService {
  private search = inject(SearchService);
  private imageViewer = inject(ImageViewerService);
  private fontPreview = inject(FontPreviewService);
  private markdownReader = inject(MarkdownReaderService);
  private raeAudit = inject(RaeAuditService);
  private repeticionesAudit = inject(RepeticionesAuditService);
  private grammar = inject(GrammarService);
  private bookConfig = inject(BookConfigService);
  private debug = inject(DebugService);

  readonly scope = signal<GrammarAuditScope | null>(null);
  readonly chapters = signal<ChapterGrammar[]>([]);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly progress = signal<{ done: number; total: number } | null>(null);
  /** Capítulos que LT no pudo chequear (500 esporádico, timeout). Se sigue
   *  con el resto: un capítulo caído no invalida los otros. */
  readonly fallidos = signal<string[]>([]);

  readonly total = computed(() => this.chapters().reduce((sum, c) => sum + c.matches.length, 0));

  /** Pedido de "abrime el popover sobre ESTE match", que el editor consume al
   *  terminar su propio `checkGrammar`. Mismo patrón que el de repeticiones:
   *  el match se identifica por `ruleId` + `anchor`, no por offset, porque el
   *  panel calcula sobre `htmlToPlain` y el editor sobre `extractPlainText`. */
  readonly pendingPopover = signal<{ path: string; ruleId: string; anchor: string } | null>(
    null,
  );

  /** Respuesta cruda de LT por capítulo, antes del filtro del diccionario, así
   *  un cambio en el diccionario se refiltra sin volver a pegarle a LT. */
  private cache = new Map<string, { html: string; matches: GrammarMatch[] }>();

  pedirPopover(path: string, ruleId: string, anchor: string): void {
    this.pendingPopover.set({ path, ruleId, anchor });
  }

  limpiarPopoverPendiente(): void {
    this.pendingPopover.set(null);
  }

  constructor() {
    // Exclusión mutua de vuelta: este cierra a los otros dos al abrir, y si
    // alguno de los dos abre, este se cierra solo. Los otros no lo inyectan
    // para no cerrar un ciclo de DI.
    effect(() => {
      const otroAbierto = this.raeAudit.scope() !== null || this.repeticionesAudit.scope() !== null;
      if (otroAbierto && this.scope() !== null) this.close();
    });
  }

  isOpen(): boolean {
    return this.scope() !== null;
  }

  private async palabrasDeLaSaga(path: string): Promise<string[]> {
    try {
      const sagaPath = await invoke<string | null>('find_saga_dir', { path });
      if (!sagaPath) return [];
      return await invoke<string[]>('get_saga_dictionary', { sagaPath });
    } catch {
      return [];
    }
  }

  private async idiomaDelLibro(path: string): Promise<string | null> {
    try {
      const cfg = await this.bookConfig.load(path);
      return cfg.idioma ?? null;
    } catch {
      return null;
    }
  }

  private async matchesDe(payload: ChapterPayload, plain: string, lang: 'es' | 'en'): Promise<GrammarMatch[]> {
    const hit = this.cache.get(payload.path);
    if (hit && hit.html === payload.html) return hit.matches;
    const matches = await this.grammar.check(plain, lang);
    this.cache.set(payload.path, { html: payload.html, matches });
    return matches;
  }

  async open(scope: GrammarAuditScope): Promise<void> {
    this.search.hide();
    this.imageViewer.close();
    this.fontPreview.close();
    this.markdownReader.close();
    this.raeAudit.close();
    this.repeticionesAudit.close();

    this.scope.set(scope);
    this.chapters.set([]);
    this.fallidos.set([]);
    this.loading.set(true);
    this.error.set(null);
    this.progress.set(null);

    try {
      if (!(await this.grammar.ping())) {
        this.error.set('LanguageTool no responde. Revisá la configuración de gramática.');
        this.grammar.pedirConfig();
        return;
      }
      const payloads = await invoke<ChapterPayload[]>('list_chapters_for_audit', {
        scopePath: scope.path,
      });
      if (this.scope() !== scope) return;
      this.progress.set({ done: 0, total: payloads.length });

      const idiomaLibro = await this.idiomaDelLibro(scope.path);
      const diccionario = await this.palabrasDeLaSaga(scope.path);
      if (this.scope() !== scope) return;

      const accumulated: ChapterGrammar[] = [];
      let processed = 0;
      for (const payload of payloads) {
        const plain = htmlToPlain(payload.html);
        const idioma = resolverIdiomaEfectivo(idiomaLibro, payload.idioma, payload.html);
        const lang = idioma === 'en' ? 'en' : 'es';
        if (plain.trim()) {
          let crudos: GrammarMatch[] | null = null;
          try {
            crudos = await this.matchesDe(payload, plain, lang);
          } catch {
            // `grammar.check` ya logueó y recalibró `available`.
            this.fallidos.update((f) => [...f, payload.path]);
          }
          if (this.scope() !== scope) return;
          if (crudos) {
            const matches = filtrarMatchesAuditoria(plain, crudos, diccionario, idiomaFlexionDe(lang));
            if (matches.length > 0) {
              accumulated.push({ path: payload.path, title: auditTitleFromPath(payload.path), plain, matches });
              this.chapters.set([...accumulated]);
            }
          }
        }
        processed += 1;
        this.progress.set({ done: processed, total: payloads.length });
      }

      this.debug.info(
        'grammar-audit',
        'audit completado',
        JSON.stringify({
          scope: scope.path,
          chapters: payloads.length,
          withHits: accumulated.length,
          fallidos: this.fallidos().length,
          total: this.total(),
        }),
      );
    } catch (err) {
      if (this.scope() !== scope) return;
      this.error.set(String(err));
      this.debug.error('grammar-audit', 'audit falló', String(err));
    } finally {
      if (this.scope() === scope) {
        this.loading.set(false);
        this.progress.set(null);
      }
    }
  }

  close(): void {
    this.scope.set(null);
    this.chapters.set([]);
    this.fallidos.set([]);
    this.loading.set(false);
    this.error.set(null);
    this.progress.set(null);
  }
}
