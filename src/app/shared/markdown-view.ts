import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

/** Markdown de solo lectura, renderizado con el mismo TipTap que el lector de
 *  notas. Para los `.md` que vienen con la app (la chuleta de rayas, el
 *  changelog), importados como texto: no hay copias en HTML. */
@Component({
  selector: 'app-markdown-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="md-view" #host></div>`,
  styleUrl: './markdown-view.scss',
})
export class MarkdownView {
  readonly markdown = input.required<string>();
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private tiptap: Editor | null = null;

  constructor() {
    effect(() => {
      const md = this.markdown();
      this.tiptap?.destroy();
      this.tiptap = new Editor({
        element: this.host().nativeElement,
        editable: false,
        extensions: [
          StarterKit.configure({ link: { openOnClick: true, autolink: false } }),
          Markdown.configure({ html: false }),
        ],
        content: md,
      });
    });
    inject(DestroyRef).onDestroy(() => this.tiptap?.destroy());
  }
}
