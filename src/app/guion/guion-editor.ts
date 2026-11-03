import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorProps } from '@tiptap/pm/view';
import { LucideChevronDown, LucideFilePen } from '@lucide/angular';
import { NotificacionesBell } from '../notificaciones/notificaciones-bell';
import { PaneId } from '../core/chapter-service';
import { CursorRestoreService } from '../core/cursor-restore-service';
import { NoteService } from '../core/note-service';
import { SearchService } from '../core/search-service';
import {
  PARAGRAPH_SPACING_EM,
  SettingsService,
  resolveEditorFontStack,
} from '../core/settings-service';
import { buildEditorProps } from '../editor/editor-props';
import { withFreshHistory } from '../editor/fresh-history';
import { Grammar } from '../editor/grammar-extension';
import { atajo } from '../shared/atajo';
import { ContextMenuService, CtxMenuEntry } from '../shared/context-menu-service';
import { vistaMenu } from '../shared/vista-menu';
import {
  GuionTeclas,
  Linea,
  Resaltado,
  docDesdeLineas,
  lineasDesdeDoc,
} from './guion-extensiones';
import { partirLineas, unirLineas } from './lineas';

/**
 * Editor de guion: texto plano, un nodo por línea, resaltado del formato de
 * escenas del juego. Mismo pane y mismo `NoteService` que las notas (autosave,
 * dirty, cierre); lo que cambia es que acá no hay Markdown: lo que se guarda es
 * `lineasDesdeDoc(doc).join('\n')`, idéntico a lo que se abrió salvo lo que el
 * autor tocó. Spec: `docs/superpowers/specs/2026-11-03-editor-de-guion-design.md`.
 */
@Component({
  selector: 'app-guion-editor',
  imports: [LucideChevronDown, LucideFilePen, NotificacionesBell],
  templateUrl: './guion-editor.html',
  styleUrl: './guion-editor.scss',
})
export class GuionEditor implements AfterViewInit, OnDestroy {
  protected readonly atajo = atajo;
  protected note = inject(NoteService);
  protected settings = inject(SettingsService);
  private ctxMenu = inject(ContextMenuService);
  private search = inject(SearchService);
  private cursorRestore = inject(CursorRestoreService);

  readonly paneId = input<PaneId>(0);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  private readonly pane = computed(() => this.note.panes[this.paneId()]);
  protected readonly active = computed(() => this.pane().active());
  protected readonly dirty = computed(() => this.pane().dirty());
  protected readonly noteError = computed(() => this.pane().error());
  protected readonly width = this.settings.editorWidth;
  protected readonly fontSize = this.settings.editorFontSize;
  protected readonly fontStack = computed(() =>
    resolveEditorFontStack(this.settings.editorFontFamily()),
  );
  protected readonly paragraphSpacingEm = computed(
    () => PARAGRAPH_SPACING_EM[this.settings.editorParagraphSpacing()],
  );
  protected readonly canUndo = signal(false);
  protected readonly canRedo = signal(false);
  protected readonly hasSelection = signal(false);

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;

  constructor() {
    effect(() => {
      const at = this.pane().loadedAt();
      if (!this.viewReady() || at === this.lastLoadedAt) return;
      const texto = untracked(() => this.pane().content());
      const target = untracked(() => this.pane().active());
      const editable = !!target;
      const doc = docDesdeLineas(partirLineas(texto));
      if (!this.tiptap) {
        this.createEditor(doc, editable);
      } else {
        this.tiptap.commands.setContent(doc, { emitUpdate: false });
        this.tiptap.setEditable(editable, false);
        // Ctrl+Z no cruza de un archivo al otro (ver fresh-history.ts).
        this.tiptap.view.updateState(withFreshHistory(this.tiptap.state));
      }
      this.hostRef.nativeElement.scrollTop = 0;
      this.lastLoadedAt = at;
      this.refreshState();

      if (target?.path && this.paneId() === 0 && this.tiptap) {
        const restore = this.cursorRestore.consume(target.path);
        if (restore) {
          const docSize = this.tiptap.state.doc.content.size;
          const pos = Math.max(0, Math.min(restore.pmPos, Math.max(0, docSize - 1)));
          this.tiptap
            .chain()
            .focus(undefined, { scrollIntoView: false })
            .setTextSelection({ from: pos, to: pos })
            .run();
          this.hostRef.nativeElement.scrollTop = 0;
        }
      }
    });

    effect(() => {
      const fontSizePx = this.fontSize();
      const editor = this.tiptap;
      if (!editor) return;
      editor.setOptions({ editorProps: this.props(editor.view.dom, fontSizePx) });
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
  }

  ngOnDestroy(): void {
    this.tiptap?.destroy();
    this.tiptap = null;
  }

  /** `buildEditorProps` devuelve todo (`setOptions` reemplaza la key entera),
   *  así que lo propio del guion se suma acá en cada reaplicación. */
  private props(dom: HTMLElement | null, fontSizePx: number): EditorProps {
    return {
      ...buildEditorProps(dom, fontSizePx),
      // Pegar: siempre texto plano, una `linea` por renglón, con las líneas
      // vacías intactas (el formato separa toques con renglones en blanco; el
      // parser de clipboard de ProseMirror las colapsaría).
      handlePaste: (view, event) => {
        const texto = event.clipboardData?.getData('text/plain');
        if (!texto) return false;
        const lineas = partirLineas(texto);
        const nodos = lineas.map((l) => view.state.schema.nodes['linea'].create(null, l ? view.state.schema.text(l) : null));
        view.dispatch(
          view.state.tr.replaceSelection(new Slice(Fragment.from(nodos), 1, 1)).scrollIntoView(),
        );
        return true;
      },
      // Copiar: líneas con un solo `\n` entre medio, no el `\n\n` por defecto.
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
    };
  }

  private createEditor(doc: ReturnType<typeof docDesdeLineas>, editable: boolean): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        // Solo documento, texto y undo: el guion es texto plano.
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          dropcursor: false,
          gapcursor: false,
          hardBreak: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          paragraph: false,
          strike: false,
          trailingNode: false,
          underline: false,
        }),
        Linea,
        GuionTeclas,
        Resaltado,
        Grammar,
      ],
      content: doc,
      editable,
      editorProps: this.props(null, untracked(() => this.fontSize())),
      autofocus: editable && this.paneId() === 0 ? 'end' : false,
      onUpdate: ({ editor }) => {
        this.note.updateContentInPane(unirLineas(lineasDesdeDoc(editor.state.doc)), this.paneId());
      },
      onSelectionUpdate: () => {
        this.refreshState();
        if (this.paneId() === 0) this.search.setFocused('note');
      },
      onTransaction: () => this.refreshState(),
    });
    const editor = this.tiptap;
    editor.setOptions({
      editorProps: this.props(editor.view.dom, untracked(() => this.fontSize())),
    });
  }

  protected onContextMenu(event: MouseEvent): void {
    if (!this.tiptap) return;
    this.refreshState();
    this.ctxMenu.open(event, this.buildEditorItems());
  }

  private buildEditorItems(): CtxMenuEntry[] {
    return [
      { label: 'Deshacer', kbd: atajo('Z'), disabled: !this.canUndo(), onClick: () => this.undo() },
      { label: 'Rehacer', kbd: atajo('Z', true), disabled: !this.canRedo(), onClick: () => this.redo() },
      { kind: 'separator' },
      { label: 'Cortar', kbd: atajo('X'), disabled: !this.hasSelection(), onClick: () => void this.cut() },
      { label: 'Copiar', kbd: atajo('C'), disabled: !this.hasSelection(), onClick: () => void this.copy() },
      { label: 'Pegar', kbd: atajo('V'), onClick: () => void this.paste() },
      { label: 'Seleccionar todo', kbd: atajo('A'), onClick: () => this.selectAll() },
    ];
  }

  protected undo(): void {
    this.tiptap?.chain().focus().undo().run();
  }
  protected redo(): void {
    this.tiptap?.chain().focus().redo().run();
  }
  protected async cut(): Promise<void> {
    await this.copySelection();
    this.tiptap?.chain().focus().deleteSelection().run();
  }
  protected async copy(): Promise<void> {
    await this.copySelection();
  }
  protected async paste(): Promise<void> {
    const e = this.tiptap;
    if (!e) return;
    try {
      const texto = await navigator.clipboard.readText();
      e.chain().focus().insertContent(docDesdeLineas(partirLineas(texto)).content ?? []).run();
    } catch {
      // permisos / sin texto
    }
  }
  private async copySelection(): Promise<void> {
    const e = this.tiptap;
    if (!e) return;
    const { from, to } = e.state.selection;
    if (from === to) return;
    try {
      await navigator.clipboard.writeText(e.state.doc.textBetween(from, to, '\n'));
    } catch {
      // ignorar
    }
  }
  protected selectAll(): void {
    this.tiptap?.chain().focus().selectAll().run();
  }
  protected openViewMenu(event: MouseEvent): void {
    this.ctxMenu.openBelow(event, vistaMenu(this.settings));
  }
  protected fontBump(delta: number): void {
    this.settings.bumpFontSize(delta);
  }

  private refreshState(): void {
    const e = this.tiptap;
    if (!e) return;
    const { from, to, empty } = e.state.selection;
    this.canUndo.set(e.can().undo());
    this.canRedo.set(e.can().redo());
    this.hasSelection.set(!empty && from !== to);
    if (this.paneId() === 0) {
      const node = this.pane().active();
      if (node?.path) this.settings.setLastSession(node.path, from);
    }
  }
}
