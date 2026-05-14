import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { MarkdownReaderService } from '../core/markdown-reader-service';
import { SearchService } from '../core/search-service';
import { highlightFirstMatch } from '../core/search-highlight';
import { SettingsService } from '../core/settings-service';

@Component({
  selector: 'app-markdown-reader',
  templateUrl: './markdown-reader.html',
  styleUrl: './markdown-reader.scss',
})
export class MarkdownReader implements AfterViewInit, OnDestroy {
  private svc = inject(MarkdownReaderService);
  private settings = inject(SettingsService);
  private search = inject(SearchService);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  protected readonly viewing = this.svc.viewing;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;
  protected readonly rightPanelWidth = this.settings.rightPanelWidth;
  protected readonly widthIcon = computed(() => {
    switch (this.rightPanelWidth()) {
      case 'compact':
        return '◧';
      case 'normal':
        return '▢';
      case 'wide':
        return '◨';
      case 'full':
        return '⛶';
    }
  });
  protected readonly widthLabel = computed(() => {
    switch (this.rightPanelWidth()) {
      case 'compact':
        return 'compacto';
      case 'normal':
        return 'normal';
      case 'wide':
        return 'ancho';
      case 'full':
        return 'pantalla';
    }
  });

  private viewReady = signal(false);
  private tiptap: TipTapEditor | null = null;
  private lastLoadedAt = 0;

  constructor() {
    effect(() => {
      const at = this.svc.loadedAt();
      const ready = this.viewReady();
      if (!ready) return;
      if (at === this.lastLoadedAt) return;
      const md = untracked(() => this.svc.content());
      const target = untracked(() => this.svc.viewing());
      if (!target) {
        this.tiptap?.destroy();
        this.tiptap = null;
        this.lastLoadedAt = at;
        return;
      }
      if (!this.tiptap) {
        this.createEditor(md);
      } else {
        this.tiptap.commands.setContent(md, { emitUpdate: false });
      }
      this.lastLoadedAt = at;

      // Si hay un highlight pendiente para esta nota (viene de Ctrl+F),
      // saltar al primer match después del flush del DOM.
      if (target.path) {
        const pending = this.search.consumePendingHighlight(target.path);
        if (pending) {
          setTimeout(() => {
            highlightFirstMatch(this.hostRef.nativeElement, pending.terms, pending.rawQuery);
          }, 0);
        }
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady.set(true);
  }

  ngOnDestroy(): void {
    this.tiptap?.destroy();
    this.tiptap = null;
  }

  protected close(): void {
    this.svc.close();
  }

  protected promote(): void {
    void this.svc.promoteToCenter();
  }

  protected cycleWidth(): void {
    this.settings.cycleRightPanelWidth();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.svc.isOpen()) this.svc.close();
  }

  private createEditor(content: string): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [
        StarterKit.configure({
          link: { autolink: false, openOnClick: false },
        }),
        Typography,
        Markdown.configure({
          html: false,
          tightLists: true,
          bulletListMarker: '-',
          linkify: false,
          breaks: false,
          transformPastedText: false,
          transformCopiedText: false,
        }),
      ],
      content,
      editable: false,
      autofocus: false,
    });
  }
}
