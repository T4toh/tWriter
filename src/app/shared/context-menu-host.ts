import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
  AfterViewChecked,
} from '@angular/core';
import {
  ContextMenuService,
  CtxMenuEntry,
  CtxMenuItem,
} from './context-menu-service';

@Component({
  selector: 'app-context-menu-host',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './context-menu-host.html',
  styleUrl: './context-menu-host.scss',
})
export class ContextMenuHost implements AfterViewChecked {
  private svc = inject(ContextMenuService);

  protected readonly state = this.svc.current;

  private readonly menuEl =
    viewChild<ElementRef<HTMLDivElement>>('menuEl');
  private readonly measured = signal<{ w: number; h: number } | null>(null);

  protected readonly position = computed(() => {
    const s = this.state();
    if (!s) return { x: 0, y: 0 };
    const m = this.measured();
    const margin = 6;
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    let x = s.x;
    let y = s.y;
    if (m) {
      if (x + m.w + margin > winW) x = Math.max(margin, winW - m.w - margin);
      if (y + m.h + margin > winH) y = Math.max(margin, winH - m.h - margin);
    }
    return { x, y };
  });

  ngAfterViewChecked(): void {
    const s = this.state();
    if (!s) {
      if (this.measured() !== null) this.measured.set(null);
      return;
    }
    const el = this.menuEl()?.nativeElement;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const cur = this.measured();
    if (!cur || cur.w !== w || cur.h !== h) {
      this.measured.set({ w, h });
    }
  }

  protected isSeparator(entry: CtxMenuEntry): entry is { kind: 'separator' } {
    return entry.kind === 'separator';
  }

  protected asItem(entry: CtxMenuEntry): CtxMenuItem {
    return entry as CtxMenuItem;
  }

  protected close(): void {
    this.svc.close();
  }

  protected onBackdropContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.close();
  }

  protected onCardClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  protected async run(item: CtxMenuItem): Promise<void> {
    if (item.disabled) return;
    this.close();
    try {
      await item.onClick();
    } catch (err) {
      console.error('[ctx-menu] action threw', err);
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEsc(event: Event): void {
    if (!this.state()) return;
    event.stopPropagation();
    event.preventDefault();
    this.close();
  }
}
