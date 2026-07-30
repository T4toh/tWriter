import {
  afterNextRender,
  afterRenderEffect,
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
import { Placement, placePopover } from '../editor/popover-position';

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

  /** `null` hasta la primera medición: el panel se renderiza invisible para que
   *  no se vea el salto desde la posición inicial. */
  protected readonly placed = signal<Placement | null>(null);
  /** `min-width` del panel = ancho del trigger, para que no quede más angosto. */
  protected readonly panelWidth = signal(0);
  /** `max-height` a bindear, o `null` cuando el panel entró completo. Bindearlo
   *  siempre puede dejar el tope un pixel más corto que el alto real (las
   *  medidas del DOM son enteros redondeados) y hacer aparecer un scrollbar
   *  espurio con lugar de sobra adentro. Mismo pozo que en `grammar-popover.ts`. */
  protected readonly clippedMaxHeight = signal<number | null>(null);
  private readonly resizeTick = signal(0);

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

    // Medición real: el alto depende de cuántas opciones haya y del filtro, así
    // que no se puede estimar desde el CSS — antes se asumía el `max-height` de
    // 320px y el panel se cortaba o se salía de pantalla. Se mide el panel ya
    // renderizado y se ubica en el mismo ciclo.
    afterRenderEffect(() => {
      this.resizeTick();
      const isOpen = this.open();
      // Se leen para remedir cuando cambia el contenido: filtrar acorta la lista.
      // CAVEAT (mismo tipo que documenta grammar-popover.ts:110-118): el
      // selector de fuentes del toolbar/theme-editor lazy-carga la `FontFace`
      // vía `itemHover` (ver `onFontItemHover` en editor.ts), y una fuente que
      // termina de cargar mientras el panel está abierto puede cambiar el alto
      // de esa fila sin tocar `filter()` ni `visibleOptions()` — ninguna señal
      // que este efecto lee se dispara, así que el panel queda con la posición
      // vieja hasta el próximo resize/scroll. No se agrega un `ResizeObserver`
      // para cubrirlo: está fuera de alcance y, sin el fix de medición de
      // arriba, oscilaría (el propio observer se dispararía con cada resize
      // que él mismo provoca al recortar/expandir el panel).
      this.filter();
      this.visibleOptions();
      const el = this.panelEl()?.nativeElement;
      if (!isOpen || !el) {
        this.placed.set(null);
        this.clippedMaxHeight.set(null);
        return;
      }
      const rect = this.elRef.nativeElement.getBoundingClientRect();
      // `offsetHeight` es border-box y ya viene capeado por el `max-height` del
      // SCSS: la lista interna (`.sel-list`, `overflow-y: auto; flex: 1`) encoge
      // y scrollea en vez de empujar al panel. Distinto del popover de
      // gramática, que no tiene cap ni scroller y hay que preguntarle cuánto
      // *querría* medir con `scrollHeight`.
      //
      // OJO con el orden: `[style.max-height.px]="clippedMaxHeight()"` deja un
      // `max-height` INLINE puesto en el panel (más específico que el del
      // SCSS). Si midiéramos con ese inline todavía puesto, `offsetHeight`
      // devolvería el recorte de la medición ANTERIOR, no el alto capeado por
      // el SCSS — y la remedición nunca converge (un panel que quedó recortado
      // "below" nunca se entera de que ahora entraría completo arriba). Por
      // eso se saca el inline, se mide (fuerza reflow contra el cap del
      // SCSS), y se lo devuelve intacto: el binding de abajo decide si hace
      // falta reponerlo con el valor nuevo.
      const prevInlineMaxHeight = el.style.maxHeight;
      el.style.maxHeight = '';
      const height = el.offsetHeight;
      el.style.maxHeight = prevInlineMaxHeight;
      // El panel lleva `min-width` = ancho del trigger, y ese bind se aplica
      // DESPUÉS de esta medición en el primer render: si le pasáramos el
      // `offsetWidth` crudo, el clamp de X se calcularía con un ancho más chico
      // que el final y el panel podría salirse igual por la derecha. El ancho
      // efectivo es el mayor de los dos.
      const width = Math.max(el.offsetWidth, rect.width);
      this.panelWidth.set(rect.width);
      const result = placePopover(
        { left: rect.left, top: rect.top, bottom: rect.bottom },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        4, // gap: preserva la separación visual de antes (`rect.bottom + 4`)
      );
      this.placed.set(result);
      this.clippedMaxHeight.set(result.maxHeight < height ? result.maxHeight : null);
    });

    // `scroll` no bubblea, así que un `@HostListener('window:scroll')` solo se
    // entera de scroll del `document`. El theme editor tiene `.te-body` con
    // `overflow-y: auto` y 8 `<app-select>` adentro: scrollear ESE contenedor
    // con un panel abierto no dispara nada y el panel (`position: fixed`)
    // queda flotando lejos del trigger que se movió. Un listener en fase de
    // CAPTURA sobre `document` sí ve el scroll de cualquier ancestro con
    // overflow, porque la captura baja por el árbol antes de que el evento
    // quede atado a un target puntual (y `scroll` no bubblea, pero sí se
    // despacha en capture en cada nivel).
    const onAnyScroll = (): void => {
      if (this.open()) this.resizeTick.update((n) => n + 1);
    };
    document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
    this.destroyRef.onDestroy(() => document.removeEventListener('scroll', onAnyScroll, true));
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
  protected onViewportChange(): void {
    if (this.open()) this.resizeTick.update((n) => n + 1);
  }
}
