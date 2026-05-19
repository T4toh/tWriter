import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  TemplateRef,
  computed,
  forwardRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { LucideChevronDown } from '@lucide/angular';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Datos arbitrarios que el consumer puede pasar para usar desde itemTemplate
   *  o desde el handler (itemHover). El componente no los interpreta. */
  data?: Record<string, unknown>;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

interface VisibleGroup {
  label: string;
  options: SelectOption[];
  /** Offset del primer ítem del grupo en la lista flat visible. */
  start: number;
}

@Component({
  selector: 'app-select',
  standalone: true,
  imports: [CommonModule, FormsModule, LucideChevronDown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './select.html',
  styleUrl: './select.scss',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => Select),
      multi: true,
    },
  ],
  host: {
    '[class.is-open]': 'open()',
    '[class.is-disabled]': 'disabled()',
  },
})
export class Select implements ControlValueAccessor {
  readonly options = input<SelectOption[]>([]);
  /** Alternativa a `options`: render con headers de grupo. Si está seteado,
   *  el componente ignora `options` y usa los items de los grupos. */
  readonly groups = input<SelectGroup[]>([]);
  readonly placeholder = input<string>('Seleccionar…');
  readonly disabled = input<boolean>(false);
  readonly searchThreshold = input<number>(10);
  readonly invalid = input<boolean>(false);
  /** Template opcional para renderizar el contenido de cada ítem. Recibe la
   *  option como $implicit. Si no se pasa, render plano del `label`. */
  readonly itemTemplate = input<TemplateRef<{ $implicit: SelectOption }> | null>(null);

  /** Emite cuando el usuario hace hover sobre un ítem (o usa keyboard
   *  para destacar uno nuevo). Útil para lazy-load de assets por ítem. */
  readonly itemHover = output<SelectOption>();

  protected readonly open = signal(false);
  protected readonly value = signal<string>('');
  protected readonly filter = signal('');
  protected readonly highlightIdx = signal(0);

  protected readonly panelTop = signal(0);
  protected readonly panelLeft = signal(0);
  protected readonly panelWidth = signal(0);
  protected readonly panelFlipUp = signal(false);

  private readonly elRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');
  private readonly panelEl = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    // Portal manual: mover el panel al body para escapar el transform
    // del modal padre (CSS quirk: position:fixed queda atrapado en
    // ancestors con transform).
    afterNextRender(() => {
      const el = this.panelEl()?.nativeElement;
      if (!el) return;
      document.body.appendChild(el);
      this.destroyRef.onDestroy(() => el.remove());
    });
  }

  protected readonly useGroups = computed(() => this.groups().length > 0);

  /** Conteo total de items (para decidir mostrar el filtro). */
  private readonly totalCount = computed(() =>
    this.useGroups()
      ? this.groups().reduce((sum, g) => sum + g.options.length, 0)
      : this.options().length,
  );

  protected readonly showFilter = computed(() => this.totalCount() > this.searchThreshold());

  /** Lista flat de opciones visibles (para keyboard nav e indexación). */
  protected readonly visibleOptions = computed<SelectOption[]>(() => {
    const q = this.filter().trim().toLowerCase();
    if (this.useGroups()) {
      const all: SelectOption[] = [];
      for (const g of this.groups()) {
        for (const o of g.options) {
          if (!q || o.label.toLowerCase().includes(q)) all.push(o);
        }
      }
      return all;
    }
    const opts = this.options();
    if (!q) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(q));
  });

  /** Grupos con filtro aplicado y offsets para indexar contra visibleOptions. */
  protected readonly visibleGroups = computed<VisibleGroup[]>(() => {
    if (!this.useGroups()) return [];
    const q = this.filter().trim().toLowerCase();
    const out: VisibleGroup[] = [];
    let cursor = 0;
    for (const g of this.groups()) {
      const filtered = q
        ? g.options.filter((o) => o.label.toLowerCase().includes(q))
        : g.options;
      if (filtered.length === 0) continue;
      out.push({ label: g.label, options: filtered, start: cursor });
      cursor += filtered.length;
    }
    return out;
  });

  protected readonly selectedLabel = computed(() => {
    const v = this.value();
    if (this.useGroups()) {
      for (const g of this.groups()) {
        const hit = g.options.find((o) => o.value === v);
        if (hit) return hit.label;
      }
      return '';
    }
    return this.options().find((o) => o.value === v)?.label ?? '';
  });

  private onChange: (v: string) => void = () => {};
  private onTouched: () => void = () => {};
  private disabledByForm = false;

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }
  registerOnChange(fn: (v: string) => void): void {
    this.onChange = fn;
  }
  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }
  setDisabledState(isDisabled: boolean): void {
    this.disabledByForm = isDisabled;
  }

  protected isDisabled(): boolean {
    return this.disabled() || this.disabledByForm;
  }

  protected toggle(): void {
    if (this.isDisabled()) return;
    if (this.open()) {
      this.close();
    } else {
      this.openPanel();
    }
  }

  protected openPanel(): void {
    if (this.isDisabled()) return;
    this.measurePanel();
    this.filter.set('');
    const vals = this.visibleOptions();
    const cur = this.value();
    const idx = vals.findIndex((o) => o.value === cur);
    this.highlightIdx.set(idx >= 0 ? idx : 0);
    this.open.set(true);
    if (this.showFilter()) {
      queueMicrotask(() => this.filterInput()?.nativeElement.focus());
    }
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.onTouched();
    this.elRef.nativeElement.focus();
  }

  protected pick(opt: SelectOption): void {
    if (opt.disabled) return;
    this.value.set(opt.value);
    this.onChange(opt.value);
    this.close();
  }

  protected onItemHover(opt: SelectOption, idx: number): void {
    this.highlightIdx.set(idx);
    this.itemHover.emit(opt);
  }

  protected onFilterChange(v: string): void {
    this.filter.set(v);
    this.highlightIdx.set(0);
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (this.isDisabled()) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.openPanel();
    }
  }

  protected onPanelKeydown(event: KeyboardEvent): void {
    const vis = this.visibleOptions();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveHighlight(1, vis);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveHighlight(-1, vis);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const opt = vis[this.highlightIdx()];
      if (opt) this.pick(opt);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      this.highlightIdx.set(0);
      this.scrollHighlightedIntoView();
      const first = vis[0];
      if (first) this.itemHover.emit(first);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      const last = Math.max(0, vis.length - 1);
      this.highlightIdx.set(last);
      this.scrollHighlightedIntoView();
      const opt = vis[last];
      if (opt) this.itemHover.emit(opt);
      return;
    }
  }

  private moveHighlight(delta: number, vis: SelectOption[]): void {
    if (vis.length === 0) return;
    const cur = this.highlightIdx();
    let next = cur + delta;
    if (next < 0) next = vis.length - 1;
    if (next >= vis.length) next = 0;
    this.highlightIdx.set(next);
    this.scrollHighlightedIntoView();
    const opt = vis[next];
    if (opt) this.itemHover.emit(opt);
  }

  private scrollHighlightedIntoView(): void {
    queueMicrotask(() => {
      const panel = this.panelEl()?.nativeElement;
      const item = panel?.querySelector(`[data-idx="${this.highlightIdx()}"]`) as HTMLElement | null;
      item?.scrollIntoView({ block: 'nearest' });
    });
  }

  @HostListener('document:click', ['$event'])
  protected onDocClick(event: MouseEvent): void {
    if (!this.open()) return;
    const target = event.target as Node;
    const panel = this.panelEl()?.nativeElement;
    if (this.elRef.nativeElement.contains(target)) return;
    if (panel?.contains(target)) return;
    this.close();
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  protected onViewportChange(): void {
    if (this.open()) this.measurePanel();
  }

  private measurePanel(): void {
    const rect = this.elRef.nativeElement.getBoundingClientRect();
    const panelHeight = 320;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < panelHeight && rect.top > spaceBelow;
    this.panelFlipUp.set(flipUp);
    this.panelTop.set(flipUp ? rect.top - 4 : rect.bottom + 4);
    this.panelLeft.set(rect.left);
    this.panelWidth.set(rect.width);
  }
}
