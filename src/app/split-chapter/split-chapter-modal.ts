import { Component, ElementRef, computed, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SplitChapterService } from '../core/split-chapter-service';

@Component({
  selector: 'app-split-chapter-modal',
  imports: [FormsModule],
  templateUrl: './split-chapter-modal.html',
  styleUrl: './split-chapter-modal.scss',
})
export class SplitChapterModal {
  protected svc = inject(SplitChapterService);

  protected readonly editing = this.svc.editing;
  protected readonly loading = this.svc.loading;
  protected readonly applying = this.svc.applying;
  protected readonly bulkMode = this.svc.bulkMode;
  protected readonly lastResult = this.svc.lastResult;

  protected readonly canApplyRae = computed(() => {
    const s = this.editing();
    return !!this.lastResult() && s?.preview.idioma === 'es' && !this.applying();
  });

  protected readonly blocksContainer = viewChild<ElementRef<HTMLElement>>('blocksContainer');

  protected readonly partsSummary = computed(() => {
    const s = this.editing();
    if (!s) return [];
    const blocks = s.preview.blocks;
    const boundaries = s.boundaries;
    const parts: {
      number: number;
      blockCount: number;
      firstBlockText: string;
      startIndex: number;
    }[] = [];
    let partNum = 1;
    let start = 0;
    for (let i = 1; i <= blocks.length; i++) {
      if (i === blocks.length || boundaries[i]) {
        const slice = blocks.slice(start, i);
        parts.push({
          number: partNum,
          blockCount: slice.length,
          firstBlockText: previewText(slice[0]?.html ?? ''),
          startIndex: start,
        });
        partNum++;
        start = i;
      }
    }
    return parts;
  });

  protected readonly canApply = computed(() => {
    const s = this.editing();
    if (!s) return false;
    return s.folderName.trim().length > 0 && !this.applying();
  });

  protected onFolderNameChange(name: string): void {
    this.svc.setFolderName(name);
  }

  protected toggleBoundary(index: number): void {
    this.svc.toggleBoundary(index);
  }

  protected async apply(): Promise<void> {
    await this.svc.apply();
  }

  protected async applyRae(): Promise<void> {
    await this.svc.applyRaeToParts();
  }

  protected async continueWithoutRae(): Promise<void> {
    await this.svc.continueWithoutRae();
  }

  protected async skip(): Promise<void> {
    await this.svc.skip();
  }

  protected abortRest(): void {
    this.svc.abortRest();
  }

  protected close(): void {
    if (this.applying()) return;
    this.svc.close();
  }

  protected scrollToPart(startIndex: number): void {
    const container = this.blocksContainer()?.nativeElement;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-block-index="${startIndex}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1000);
  }

  protected candidateBadge(reason: string | null): string {
    switch (reason) {
      case 'heading-1':
        return 'H1';
      case 'heading-2':
        return 'H2';
      case 'hr':
        return 'HR';
      case 'short-numeric':
        return '#';
      default:
        return '';
    }
  }
}

function previewText(html: string): string {
  const stripped = html.replace(/<[^>]*>/g, '').trim();
  if (stripped.length <= 60) return stripped;
  return stripped.slice(0, 60) + '…';
}
