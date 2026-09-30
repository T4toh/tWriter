import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import chuleta from '../../../docs/raya.md';
import { RayaChuletaService } from '../core/raya-chuleta-service';

/** La chuleta de diálogos con raya: `docs/raya.md` renderizado de solo
 *  lectura. El mismo archivo sirve para la wiki; acá no se copia nada. */
@Component({
  selector: 'app-raya-chuleta-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (svc.open()) {
      <div class="modal-backdrop" (click)="svc.close()"></div>
      <div class="modal-card rc-modal" (click)="$event.stopPropagation()">
        <div class="rc-body" #body></div>
        <footer class="modal-actions">
          <button type="button" class="btn btn-primary" (click)="svc.close()">Cerrar</button>
        </footer>
      </div>
    }
  `,
  styleUrl: './raya-chuleta-modal.scss',
})
export class RayaChuletaModal {
  protected readonly svc = inject(RayaChuletaService);
  private readonly body = viewChild<ElementRef<HTMLElement>>('body');
  private tiptap: Editor | null = null;

  constructor() {
    effect(() => {
      const el = this.body()?.nativeElement;
      this.tiptap?.destroy();
      this.tiptap = null;
      if (!el) return;
      this.tiptap = new Editor({
        element: el,
        editable: false,
        extensions: [
          StarterKit.configure({ link: { openOnClick: true, autolink: false } }),
          Markdown.configure({ html: false }),
        ],
        content: chuleta,
      });
    });
    inject(DestroyRef).onDestroy(() => this.tiptap?.destroy());
  }
}
