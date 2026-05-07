import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { GrammarMatch, GrammarMode } from './types';
import { SettingsService } from './settings-service';

interface GrammarCfg {
  mode: GrammarMode;
  customUrl: string | null;
  variantEs: string;
  variantEn: string;
}

export interface LtDockerStatus {
  docker_installed: boolean;
  container_running: boolean;
  container_exists: boolean;
  api_responding: boolean;
}

@Injectable({ providedIn: 'root' })
export class GrammarService {
  private settings = inject(SettingsService);

  readonly available = signal<boolean>(false);
  readonly checking = signal<boolean>(false);
  readonly lastError = signal<string | null>(null);
  readonly mode = this.settings.grammarMode;
  readonly customUrl = this.settings.grammarCustomUrl;
  readonly autoEnabled = signal<boolean>(false);

  readonly canAutoCheck = computed(() => this.mode() === 'local' || this.mode() === 'custom');

  private buildCfg(): GrammarCfg {
    return {
      mode: this.mode(),
      customUrl: this.customUrl(),
      variantEs: this.settings.grammarVariantEs(),
      variantEn: this.settings.grammarVariantEn(),
    };
  }

  async ping(): Promise<boolean> {
    try {
      const ok = await invoke<boolean>('check_grammar_available', { cfg: this.buildCfg() });
      this.available.set(ok);
      return ok;
    } catch {
      this.available.set(false);
      return false;
    }
  }

  async check(text: string, lang: 'es' | 'en' | 'auto'): Promise<GrammarMatch[]> {
    this.checking.set(true);
    this.lastError.set(null);
    try {
      const matches = await invoke<GrammarMatch[]>('check_grammar', {
        text,
        lang,
        cfg: this.buildCfg(),
      });
      return matches;
    } catch (e) {
      const msg = String(e ?? 'Error desconocido');
      this.lastError.set(msg);
      throw new Error(msg);
    } finally {
      this.checking.set(false);
    }
  }

  toggleAuto(): void {
    if (!this.canAutoCheck()) {
      this.autoEnabled.set(false);
      return;
    }
    this.autoEnabled.update((v) => !v);
  }

  async setMode(mode: GrammarMode, customUrl?: string | null): Promise<void> {
    await this.settings.setGrammarMode(mode, customUrl ?? null);
    if (!this.canAutoCheck()) {
      this.autoEnabled.set(false);
    }
    await this.ping();
  }

  async dockerStatus(): Promise<LtDockerStatus> {
    return invoke<LtDockerStatus>('languagetool_docker_status');
  }

  async dockerStart(): Promise<string> {
    return invoke<string>('languagetool_docker_start');
  }

  async dockerStop(): Promise<void> {
    await invoke('languagetool_docker_stop');
  }
}
