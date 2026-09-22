import { Component, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ImageViewerService } from '../core/image-viewer-service';
import { Caja, Vista, centrar, clampPan, fitScale, wheelFactor, zoomAt } from './zoom';

@Component({
  selector: 'app-image-viewer',
  templateUrl: './image-viewer.html',
  styleUrl: './image-viewer.scss',
})
export class ImageViewer {
  private svc = inject(ImageViewerService);
  private body = viewChild<ElementRef<HTMLElement>>('body');

  protected readonly viewing = this.svc.viewing;
  protected readonly dataUrl = this.svc.dataUrl;
  protected readonly loading = this.svc.loading;
  protected readonly error = this.svc.error;

  protected readonly vista = signal<Vista>({ scale: 1, tx: 0, ty: 0 });
  /** true mientras la imagen está en modo "encaja"; el resize la re-encaja. */
  protected readonly ajustada = signal(true);
  protected readonly porcentaje = computed(() => Math.round(this.vista().scale * 100));

  private natural = { w: 0, h: 0 };
  private drag: { x: number; y: number; tx: number; ty: number } | null = null;
  private observer: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      // Cambió la imagen: arranca encajada.
      this.dataUrl();
      this.natural = { w: 0, h: 0 };
      this.ajustada.set(true);
    });
    effect((onCleanup) => {
      const el = this.body()?.nativeElement;
      if (!el) return;
      this.observer = new ResizeObserver(() => { if (this.ajustada()) this.encajar(); });
      this.observer.observe(el);
      onCleanup(() => this.observer?.disconnect());
    });
  }

  protected close(): void {
    this.svc.close();
  }

  protected onLoad(ev: Event): void {
    const img = ev.target as HTMLImageElement;
    this.natural = { w: img.naturalWidth, h: img.naturalHeight };
    this.encajar();
  }

  protected encajar(): void {
    const c = this.caja();
    if (!c) return;
    this.vista.set(centrar(fitScale(c), c));
    this.ajustada.set(true);
  }

  protected onWheel(ev: WheelEvent): void {
    const c = this.caja();
    if (!c) return;
    ev.preventDefault();
    const { x, y } = this.punto(ev);
    this.vista.set(zoomAt(this.vista(), c, wheelFactor(ev.deltaY), x, y));
    this.ajustada.set(false);
  }

  protected onDblClick(ev: MouseEvent): void {
    const c = this.caja();
    if (!c) return;
    if (this.ajustada()) {
      const { x, y } = this.punto(ev);
      this.vista.set(zoomAt(this.vista(), c, 1 / this.vista().scale, x, y));
      this.ajustada.set(false);
    } else {
      this.encajar();
    }
  }

  protected onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const v = this.vista();
    this.drag = { x: ev.clientX, y: ev.clientY, tx: v.tx, ty: v.ty };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  protected onPointerMove(ev: PointerEvent): void {
    const c = this.caja();
    if (!this.drag || !c) return;
    const v = this.vista();
    this.vista.set(clampPan({
      scale: v.scale,
      tx: this.drag.tx + ev.clientX - this.drag.x,
      ty: this.drag.ty + ev.clientY - this.drag.y,
    }, c));
  }

  protected onPointerUp(): void {
    this.drag = null;
  }

  protected excede(): boolean {
    const c = this.caja();
    if (!c) return false;
    const s = this.vista().scale;
    return c.imgW * s > c.boxW || c.imgH * s > c.boxH;
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.svc.isOpen()) this.svc.close();
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (!this.svc.isOpen() || !(ev.metaKey || ev.ctrlKey)) return;
    const c = this.caja();
    if (!c) return;
    const factor = ev.key === '+' || ev.key === '=' ? 1.25 : ev.key === '-' ? 0.8 : 0;
    if (factor) {
      ev.preventDefault();
      this.vista.set(zoomAt(this.vista(), c, factor, c.boxW / 2, c.boxH / 2));
      this.ajustada.set(false);
    } else if (ev.key === '0') {
      ev.preventDefault();
      this.encajar();
    }
  }

  private caja(): Caja | null {
    const el = this.body()?.nativeElement;
    if (!el || !this.natural.w) return null;
    return { imgW: this.natural.w, imgH: this.natural.h, boxW: el.clientWidth, boxH: el.clientHeight };
  }

  private punto(ev: MouseEvent): { x: number; y: number } {
    const r = this.body()!.nativeElement.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
}
