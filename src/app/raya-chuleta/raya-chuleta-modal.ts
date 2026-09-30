import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import chuleta from '../../../docs/raya.md';
import { RayaChuletaService } from '../core/raya-chuleta-service';
import { MarkdownView } from '../shared/markdown-view';

/** La chuleta de diálogos con raya: `docs/raya.md` renderizado de solo
 *  lectura. El mismo archivo sirve para la wiki; acá no se copia nada. */
@Component({
  selector: 'app-raya-chuleta-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownView],
  template: `
    @if (svc.open()) {
      <div class="modal-backdrop" (click)="svc.close()"></div>
      <div class="modal-card rc-modal" (click)="$event.stopPropagation()">
        <div class="rc-body"><app-markdown-view [markdown]="chuleta" /></div>
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
  protected readonly chuleta = chuleta;
}
