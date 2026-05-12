import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FontPreviewService } from '../core/font-preview-service';

const LOREM_LONG =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
  'Vivamus lacinia odio vitae vestibulum vestibulum. Cras venenatis ' +
  'euismod malesuada. Mauris fringilla nulla a velit cursus, ut ' +
  'consequat sapien dignissim. Pellentesque habitant morbi tristique ' +
  'senectus et netus et malesuada fames ac turpis egestas.';

const ALPHA_NUM =
  'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ\nabcdefghijklmnñopqrstuvwxyz\n0123456789 ¿? ¡! .,;:—«»';

@Component({
  selector: 'app-font-preview',
  templateUrl: './font-preview.html',
  styleUrl: './font-preview.scss',
})
export class FontPreview {
  private svc = inject(FontPreviewService);

  protected readonly viewing = this.svc.viewing;
  protected readonly lorem = LOREM_LONG;
  protected readonly alphaNum = ALPHA_NUM;

  /** Family name único per-componente para evitar caching entre fuentes. */
  private gen = signal(0);
  /** Family generado ya cargado y listo para usar en font-family. */
  protected readonly loadedFamily = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly fontStyle = computed(() => {
    const fam = this.loadedFamily();
    return fam ? `font-family: "${fam}", serif;` : '';
  });
  protected readonly title = computed(() => this.viewing()?.name ?? '');
  protected readonly subtitle = computed(() => {
    const f = this.viewing();
    if (!f) return '';
    const parts = [f.family];
    if (f.weight === 700) parts.push('Bold');
    if (f.style === 'italic') parts.push('Italic');
    return parts.join(' · ');
  });
  protected readonly sizes: ReadonlyArray<{ px: number; label: string }> = [
    { px: 48, label: '48' },
    { px: 32, label: '32' },
    { px: 20, label: '20' },
    { px: 14, label: '14' },
  ];

  constructor() {
    effect(() => {
      const entry = this.viewing();
      if (!entry) {
        this.loadedFamily.set(null);
        this.loadError.set(null);
        return;
      }
      void this.loadFace(entry.path);
    });
  }

  private async loadFace(path: string): Promise<void> {
    this.gen.update((g) => g + 1);
    const family = `tw-fontpreview-${this.gen()}`;
    const url = convertFileSrc(path);
    try {
      const ff = new FontFace(family, `url("${url}")`);
      await ff.load();
      document.fonts.add(ff);
      if (this.viewing()?.path !== path) return;
      this.loadedFamily.set(family);
      this.loadError.set(null);
    } catch (e) {
      if (this.viewing()?.path !== path) return;
      this.loadedFamily.set(null);
      this.loadError.set(String(e));
    }
  }

  protected close(): void {
    this.svc.close();
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.svc.isOpen()) this.svc.close();
  }
}
