import { FechaCortaPipe } from '../shared/fecha-corta-pipe';
import { Component, computed, input, output } from '@angular/core';
import {
  LucideBookMarked,
  LucideDynamicIcon,
  LucideFile,
  LucideFilePen,
  LucideFolder,
  LucideLibrary,
  LucideNotebook,
  type LucideIcon,
} from '@lucide/angular';
import { TreeNode } from '../core/types';

interface Chip {
  path: string;
  name: string;
  kind: string;
  icon: LucideIcon | null;
}

const MAX_CHIPS = 8;

@Component({
  selector: 'app-folder-card',
  imports: [FechaCortaPipe, LucideDynamicIcon],
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

}

function iconFor(kind: string): LucideIcon | null {
  switch (kind) {
    case 'note': return LucideFilePen;
    case 'notes': return LucideNotebook;
    case 'folder': return LucideFolder;
    case 'chapter': return LucideFile;
    case 'book': return LucideBookMarked;
    case 'saga': return LucideLibrary;
    default: return null;
  }
}
