import { Component, computed, effect, inject, signal, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { AutorConfig, AutorService } from '../core/autor-service';
import { CoverCache } from '../core/cover-cache';
import { NativeDialogsService } from '../core/native-dialogs-service';
import { SettingsService } from '../core/settings-service';

/** Lado máximo (en px de pantalla) del cuadro de recorte en el modal. */
/** Lado máximo del recuadro de recorte, en px. Se calcula contra la ventana
 *  y no como constante fija: con un tope chico la foto se muestra diminuta en
 *  una pantalla grande y elegir el recorte se vuelve adivinar. El 88vw/72vh
 *  deja aire para el título, la ayuda y la botonera del modal. */
function cropDisplayMax(): number {
  const w = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const h = typeof window === 'undefined' ? 900 : window.innerHeight;
  return Math.max(320, Math.min(w * 0.88, h * 0.72));
}

/** Estado del paso de recorte: la foto elegida no era cuadrada, así que se
 *  muestra con un cuadro arrastrable antes de adoptarla. Coordenadas de
 *  `x`/`y`/`side` en píxeles de la imagen ORIGINAL (no de pantalla). */
interface RecorteState {
  sourcePath: string;
  dataUrl: string;
  width: number;
  height: number;
  x: number;
  y: number;
  side: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

@Component({
  selector: 'app-autor-modal',
  imports: [FormsModule],
  templateUrl: './autor-modal.html',
  styleUrl: './autor-modal.scss',
})
export class AutorModal {
  private svc = inject(AutorService);
  private dialogs = inject(NativeDialogsService);
  private settings = inject(SettingsService);
  private coverCache = inject(CoverCache);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<AutorConfig | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Bump manual al reemplazar foto/QR — invalida el blob cacheado, porque
   *  `adopt_config_image` puede cambiar la extensión del archivo (mismo
   *  nombre relativo "autor.jpg" → "autor.png") y la cache está keyed por path. */
  private readonly previewVersion = signal(0);
  protected readonly fotoPreviewUrl = signal<string | null>(null);
  protected readonly qrPreviewUrl = signal<string | null>(null);

  /** Bio a mostrar en el preview: la del libro no existe acá — se muestra la
   *  de español y, si está vacía, se cae a inglés. Mismo criterio que
   *  `AutorConfig::bio_en` en Rust (usado por el EPUB), sin selector de idioma. */
  protected readonly previewBio = computed<string>(() => {
    const bio = this.config()?.bio;
    if (!bio) return '';
    const es = bio['es']?.trim();
    if (es) return es;
    return bio['en']?.trim() ?? '';
  });

  /** Un `<p>` por línea no vacía — así arma la página el EPUB
   *  (`build_about_author_xhtml` en `epub.rs`), no como un solo bloque. */
  protected readonly previewParrafos = computed<string[]>(() =>
    this.previewBio()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );

  protected readonly previewWebHost = computed<string | null>(() => {
    const web = this.config()?.web?.trim();
    if (!web) return null;
    return web.replace(/^https?:\/\//, '');
  });

  constructor() {
    effect(() => {
      if (!this.editing()) return;
      // Un error de la apertura anterior no debe sobrevivir a un cierre y
      // reapertura del modal.
      this.error.set(null);
      void this.svc
        .load()
        .then((cfg) => this.config.set(cfg))
        .catch((e) => this.error.set(String(e)));
    });

    effect(() => {
      const cfg = this.config();
      const root = this.settings.root();
      const version = this.previewVersion();
      if (!cfg || !root) {
        this.fotoPreviewUrl.set(null);
        this.qrPreviewUrl.set(null);
        return;
      }
      void this.loadPreviewImg(cfg.foto ?? null, root, version, this.fotoPreviewUrl);
      void this.loadPreviewImg(cfg.qr ?? null, root, version, this.qrPreviewUrl);
    });
  }

  private async loadPreviewImg(
    nombre: string | null | undefined,
    root: string,
    version: number,
    target: WritableSignal<string | null>,
  ): Promise<void> {
    if (!nombre || !nombre.trim()) {
      target.set(null);
      return;
    }
    const fullPath = nombre.startsWith('/') ? nombre : `${root}/${nombre}`;
    try {
      target.set(await this.coverCache.urlFor(fullPath, version));
    } catch {
      target.set(null);
    }
  }

  protected update<K extends keyof AutorConfig>(key: K, value: AutorConfig[K]): void {
    const cur = this.config();
    if (cur) this.config.set({ ...cur, [key]: value });
  }

  protected bio(idioma: 'es' | 'en'): string {
    return this.config()?.bio?.[idioma] ?? '';
  }

  protected setBio(idioma: 'es' | 'en', valor: string): void {
    const cur = this.config();
    if (!cur) return;
    const bio = { ...(cur.bio ?? {}) };
    if (valor.trim()) bio[idioma] = valor;
    else delete bio[idioma];
    this.config.set({ ...cur, bio });
  }

  /** Foto de "Sobre el autor": si ya es cuadrada se adopta tal cual (sin UI);
   *  si no, pasa por el paso de recorte — el autor elige el encuadre, la app
   *  no recorta a ciegas. */
  protected async pickFoto(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const elegido = await this.dialogs.pickSingleFile({
      title: 'Seleccionar foto del autor',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
      defaultPath: root,
    });
    if (!elegido) return;
    try {
      const { mime, base64 } = await invoke<{ mime: string; base64: string }>('read_image', {
        path: elegido,
      });
      const dataUrl = `data:${mime};base64,${base64}`;
      const { width, height } = await this.leerDimensiones(dataUrl);
      if (width === height) {
        await this.adoptarFoto(root, elegido);
        return;
      }
      // No cuadrada: cuadro por defecto centrado horizontalmente y sesgado
      // hacia arriba — las cabezas de los retratos caen en el tercio
      // superior, un recorte centrado a lo alto las corta por la frente.
      const side = Math.min(width, height);
      const x = (width - side) / 2;
      const y = (height - side) * 0.25;
      this.recorte.set({ sourcePath: elegido, dataUrl, width, height, x, y, side });
    } catch (e) {
      this.error.set(`No pude leer esa imagen: ${e}`);
    }
  }

  protected async pickQr(): Promise<void> {
    const root = this.settings.root();
    if (!root) return;
    const elegido = await this.dialogs.pickSingleFile({
      title: 'Seleccionar imagen del QR',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg'] }],
      defaultPath: root,
    });
    if (!elegido) return;
    try {
      const rel = await invoke<string>('adopt_config_image', {
        dirPath: root,
        sourcePath: elegido,
        stem: 'qr',
      });
      this.update('qr', rel);
      this.previewVersion.update((v) => v + 1);
    } catch (e) {
      this.error.set(`No pude copiar la imagen: ${e}`);
    }
  }

  private leerDimensiones(dataUrl: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('no pude decodificar la imagen'));
      img.src = dataUrl;
    });
  }

  /** Copia la foto a la raíz del repo sin recortar (imagen ya cuadrada). */
  private async adoptarFoto(root: string, sourcePath: string): Promise<void> {
    try {
      const rel = await invoke<string>('adopt_config_image', {
        dirPath: root,
        sourcePath,
        stem: 'autor',
      });
      this.update('foto', rel);
      this.previewVersion.update((v) => v + 1);
    } catch (e) {
      this.error.set(`No pude copiar la imagen: ${e}`);
    }
  }

  // --- Recorte de la foto (imagen no cuadrada) ---

  protected readonly recorte = signal<RecorteState | null>(null);

  private dragState: { pointerId: number; startX: number; startY: number; origX: number; origY: number } | null =
    null;

  protected readonly recorteScale = computed(() => {
    const r = this.recorte();
    if (!r) return 1;
    return Math.min(1, cropDisplayMax() / Math.max(r.width, r.height));
  });

  protected readonly recorteFrameSize = computed(() => {
    const r = this.recorte();
    const scale = this.recorteScale();
    return { width: (r?.width ?? 0) * scale, height: (r?.height ?? 0) * scale };
  });

  protected readonly recorteSquareStyle = computed(() => {
    const r = this.recorte();
    const scale = this.recorteScale();
    if (!r) return { left: 0, top: 0, size: 0 };
    return { left: r.x * scale, top: r.y * scale, size: r.side * scale };
  });

  protected onRecorteQuadradoPointerDown(ev: PointerEvent): void {
    const r = this.recorte();
    if (!r) return;
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.dragState = { pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, origX: r.x, origY: r.y };
    ev.preventDefault();
  }

  protected onRecorteQuadradoPointerMove(ev: PointerEvent): void {
    const r = this.recorte();
    const drag = this.dragState;
    if (!r || !drag || drag.pointerId !== ev.pointerId) return;
    const scale = this.recorteScale();
    const dx = (ev.clientX - drag.startX) / scale;
    const dy = (ev.clientY - drag.startY) / scale;
    const x = clamp(drag.origX + dx, 0, r.width - r.side);
    const y = clamp(drag.origY + dy, 0, r.height - r.side);
    this.recorte.set({ ...r, x, y });
  }

  protected onRecorteQuadradoPointerUp(ev: PointerEvent): void {
    if (this.dragState?.pointerId === ev.pointerId) this.dragState = null;
  }

  /** Mueve el cuadro de recorte con las flechas — Shift para un paso más
   *  grande. `preventDefault` evita que las flechas scrolleen el diálogo. */
  protected onRecorteQuadradoKeydown(ev: KeyboardEvent): void {
    const r = this.recorte();
    if (!r) return;
    const paso = ev.shiftKey ? 20 : 4;
    let dx = 0;
    let dy = 0;
    switch (ev.key) {
      case 'ArrowLeft':
        dx = -paso;
        break;
      case 'ArrowRight':
        dx = paso;
        break;
      case 'ArrowUp':
        dy = -paso;
        break;
      case 'ArrowDown':
        dy = paso;
        break;
      default:
        return;
    }
    ev.preventDefault();
    const x = clamp(r.x + dx, 0, r.width - r.side);
    const y = clamp(r.y + dy, 0, r.height - r.side);
    this.recorte.set({ ...r, x, y });
  }

  protected async confirmarRecorte(): Promise<void> {
    const r = this.recorte();
    const root = this.settings.root();
    if (!r || !root) return;
    try {
      const rel = await invoke<string>('adopt_config_image', {
        dirPath: root,
        sourcePath: r.sourcePath,
        stem: 'autor',
        crop: { x: Math.round(r.x), y: Math.round(r.y), side: Math.round(r.side) },
      });
      this.update('foto', rel);
      this.previewVersion.update((v) => v + 1);
      this.recorte.set(null);
    } catch (e) {
      this.error.set(`No pude recortar la imagen: ${e}`);
    }
  }

  protected cancelarRecorte(): void {
    this.recorte.set(null);
  }

  protected async save(): Promise<void> {
    const cfg = this.config();
    if (!cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.svc.save(cfg);
      this.svc.close();
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }
}
