import { Component, computed, input, output } from '@angular/core';
import { TreeNode } from '../core/types';

interface Chip {
  path: string;
  name: string;
  kind: string;
  icon: string;
}

const MAX_CHIPS = 8;

@Component({
  selector: 'app-folder-card',
  imports: [],
  templateUrl: './folder-card.html',
  styleUrl: './folder-card.scss',
})
export class FolderCard {
  readonly node = input.required<TreeNode>();
  readonly select = output<TreeNode>();

  protected readonly chips = computed<Chip[]>(() =>
    this.node()
      .children.slice(0, MAX_CHIPS)
      .map((c) => ({
        path: c.path,
        name: c.name,
        kind: c.kind,
        icon: iconFor(c.kind),
      })),
  );

  protected readonly extra = computed(() =>
    Math.max(0, this.node().children.length - MAX_CHIPS),
  );

  protected readonly kindLabel = computed(() => {
    switch (this.node().kind) {
      case 'notes': return 'notas';
      case 'folder': return 'carpeta';
      default: return this.node().kind;
    }
  });

  protected onClick(): void {
    this.select.emit(this.node());
  }

  protected formatDate(ms: number | undefined): string {
    if (!ms) return 'sin editar';
    const now = Date.now();
    const diff = now - ms;
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < hour) return `hace ${Math.max(1, Math.floor(diff / min))} min`;
    if (diff < day) return `hace ${Math.floor(diff / hour)} h`;
    if (diff < 7 * day) return `hace ${Math.floor(diff / day)} d`;
    return new Date(ms).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'note': return '📝';
    case 'notes': return '📒';
    case 'folder': return '📁';
    case 'chapter': return '◆';
    case 'section': return '§';
    case 'book': return '📕';
    case 'saga': return '📚';
    default: return '•';
  }
}
