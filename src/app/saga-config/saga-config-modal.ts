import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { SagaConfig, SagaConfigService } from '../core/saga-config-service';

@Component({
  selector: 'app-saga-config-modal',
  imports: [FormsModule],
  templateUrl: './saga-config-modal.html',
  styleUrl: './saga-config-modal.scss',
})
export class SagaConfigModal {
  private svc = inject(SagaConfigService);

  protected readonly editing = this.svc.editing;
  protected readonly config = signal<SagaConfig | null>(null);
  protected readonly diccionarioText = signal<string>('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sagaPath = computed(() => this.editing()?.path ?? null);

  constructor() {
    effect(() => {
      const node = this.editing();
      if (!node) {
        this.config.set(null);
        this.diccionarioText.set('');
        return;
      }
      void this.load(node.path);
    });
  }

  private async load(path: string): Promise<void> {
    this.error.set(null);
    try {
      const cfg = await this.svc.load(path);
      this.config.set({
        nombre: cfg.nombre ?? '',
        autor: cfg.autor ?? '',
        idioma: cfg.idioma ?? 'es',
        tapa: cfg.tapa ?? '',
        diccionario: cfg.diccionario ?? [],
      });
      this.diccionarioText.set((cfg.diccionario ?? []).join('\n'));
    } catch (err) {
      this.error.set(String(err));
    }
  }

  protected async pickCover(): Promise<void> {
    const result = await openDialog({
      multiple: false,
      directory: false,
      title: 'Seleccionar tapa de saga',
      filters: [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      defaultPath: this.sagaPath() ?? undefined,
    });
    if (typeof result !== 'string') return;
    const cur = this.config();
    if (cur) this.config.set({ ...cur, tapa: result });
  }

  protected update<K extends keyof SagaConfig>(key: K, value: SagaConfig[K]): void {
    const cur = this.config();
    if (!cur) return;
    this.config.set({ ...cur, [key]: value });
  }

  protected updateDiccionarioText(value: string): void {
    this.diccionarioText.set(value);
  }

  protected async save(): Promise<void> {
    const path = this.sagaPath();
    const cfg = this.config();
    if (!path || !cfg) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const palabras = this.diccionarioText()
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const cleaned: SagaConfig = {
        nombre: cfg.nombre,
        autor: blank(cfg.autor),
        idioma: cfg.idioma,
        tapa: blank(cfg.tapa),
        diccionario: palabras.length > 0 ? palabras : null,
      };
      await this.svc.save(path, cleaned);
      this.svc.close();
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.svc.close();
  }
}

function blank(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}
