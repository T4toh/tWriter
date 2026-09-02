import { Component, computed, effect, inject, signal } from '@angular/core';
import { AutorConfig, AutorService } from '../core/autor-service';
import { CoverCache } from '../core/cover-cache';
import { SettingsService } from '../core/settings-service';

@Component({
  selector: 'app-autor-card',
  imports: [],
  templateUrl: './autor-card.html',
  styleUrl: './autor-card.scss',
})
export class AutorCard {
  private autorSvc = inject(AutorService);
  private coverCache = inject(CoverCache);
  private settings = inject(SettingsService);

  protected readonly config = signal<AutorConfig | null>(null);
  protected readonly fotoUrl = signal<string | null>(null);

  /** Mismo criterio en toda la card: un nombre solo de espacios cuenta como
   *  vacío, tanto para el texto mostrado como para el estado "Sin configurar". */
  protected readonly tieneNombre = computed(() => !!this.config()?.nombre?.trim());

  protected readonly displayName = computed(() => this.config()?.nombre?.trim() || 'Autor');

  constructor() {
    effect(() => {
      // Re-load cuando cambia el root o cuando se guardó el modal.
      const root = this.settings.root();
      this.autorSvc.savedAt();
      if (!root) {
        this.config.set(null);
        this.fotoUrl.set(null);
        return;
      }
      void this.load(root);
    });
  }

  protected onClick(): void {
    this.autorSvc.open();
  }

  private async load(root: string): Promise<void> {
    try {
      const cfg = await this.autorSvc.load();
      this.config.set(cfg);
      await this.loadFoto(root, cfg.foto ?? null);
    } catch {
      this.config.set(null);
      this.fotoUrl.set(null);
    }
  }

  private async loadFoto(root: string, foto: string | null): Promise<void> {
    if (!foto || !foto.trim()) {
      this.fotoUrl.set(null);
      return;
    }
    const fullPath = foto.startsWith('/') ? foto : `${root}/${foto}`;
    try {
      const url = await this.coverCache.urlFor(fullPath, this.autorSvc.savedAt());
      this.fotoUrl.set(url);
    } catch {
      this.fotoUrl.set(null);
    }
  }
}
