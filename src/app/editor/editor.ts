import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
} from '@angular/core';
import { Editor as TipTapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { ChapterService } from '../core/chapter-service';

@Component({
  selector: 'app-editor',
  imports: [],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
})
export class Editor implements AfterViewInit, OnDestroy {
  private chapter = inject(ChapterService);

  @ViewChild('host', { static: true })
  hostRef!: ElementRef<HTMLDivElement>;

  protected readonly active = this.chapter.active;
  protected readonly canEdit = this.chapter.canEdit;
  protected readonly wordCount = this.chapter.wordCount;
  protected readonly dirty = this.chapter.dirty;
  protected readonly saving = this.chapter.saving;
  protected readonly chapterError = this.chapter.error;

  private tiptap: TipTapEditor | null = null;
  private lastSyncedPath: string | null = null;

  constructor() {
    effect(() => {
      const node = this.chapter.active();
      const html = this.chapter.content();
      if (!this.tiptap) return;
      if (node?.path !== this.lastSyncedPath) {
        this.tiptap.commands.setContent(html, { emitUpdate: false });
        this.tiptap.setEditable(this.canEdit());
        this.lastSyncedPath = node?.path ?? null;
      }
    });
  }

  ngAfterViewInit(): void {
    this.tiptap = new TipTapEditor({
      element: this.hostRef.nativeElement,
      extensions: [StarterKit, Typography],
      content: this.chapter.content(),
      editable: this.canEdit(),
      autofocus: 'end',
      onUpdate: ({ editor }) => {
        this.chapter.updateContent(editor.getHTML());
      },
    });
    this.lastSyncedPath = this.chapter.active()?.path ?? null;
  }

  ngOnDestroy(): void {
    this.tiptap?.destroy();
    this.tiptap = null;
  }
}
