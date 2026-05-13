import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { GrammarMatch, GrammarMode } from './types';
import { SettingsService } from './settings-service';
import { SagaContextService } from './saga-context-service';
import { DebugService } from './debug-service';

interface GrammarCfg {
  mode: GrammarMode;
  customUrl: string | null;
  ltUsername: string | null;
  /** Override transitorio para "Probar conexión" antes de persistir. En check normal va `null` y el backend lee del keyring. */
  ltApiKey: string | null;
  variantEs: string;
  variantEn: string;
}

export interface LtDockerStatus {
  docker_installed: boolean;
  container_running: boolean;
  container_exists: boolean;
  api_responding: boolean;
}

export type SecretBackend = 'keyring' | 'plain' | 'none';

export interface SecretStatus {
  present: boolean;
  backend: SecretBackend;
  keyring_available: boolean;
}

@Injectable({ providedIn: 'root' })
export class GrammarService {
  private settings = inject(SettingsService);
  private sagaCtx = inject(SagaContextService);
  private debug = inject(DebugService);

  readonly available = signal<boolean>(false);
  readonly checking = signal<boolean>(false);
  readonly lastError = signal<string | null>(null);
  readonly mode = this.settings.grammarMode;
  readonly customUrl = this.settings.grammarCustomUrl;
  readonly ltUsername = this.settings.grammarLtUsername;

  readonly canAutoCheck = computed(() => this.mode() === 'local' || this.mode() === 'custom');
  /**
   * Auto-check activo. Se prende solo cuando LT responde (available) y el
   * modo lo permite (local/custom). El usuario solo lo "destraba" desde el
   * toggle (que persiste `grammarAutoDisabled`).
   */
  readonly autoEnabled = computed(
    () => this.available() && this.canAutoCheck() && !this.settings.grammarAutoDisabled(),
  );

  private buildCfg(): GrammarCfg {
    return {
      mode: this.mode(),
      customUrl: this.customUrl(),
      ltUsername: this.ltUsername(),
      // apiKey va `null` en flow normal — el backend la carga del keyring del OS.
      ltApiKey: null,
      variantEs: this.sagaCtx.varianteEs() ?? this.settings.grammarVariantEs(),
      variantEn: this.sagaCtx.varianteEn() ?? this.settings.grammarVariantEn(),
    };
  }

  async ping(): Promise<boolean> {
    try {
      const ok = await invoke<boolean>('check_grammar_available', { cfg: this.buildCfg() });
      this.available.set(ok);
      if (!ok) this.debug.warn('grammar', `ping LanguageTool falló (modo ${this.mode()})`);
      return ok;
    } catch (e) {
      this.available.set(false);
      this.debug.error('grammar', `ping LanguageTool excepción (modo ${this.mode()})`, String(e));
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
      this.debug.info(
        'grammar',
        `check ok (${lang}, ${text.length} bytes, ${matches.length} matches)`,
      );
      return matches;
    } catch (e) {
      const msg = String(e ?? 'Error desconocido');
      this.lastError.set(msg);
      this.debug.error('grammar', `check falló (${lang}, ${text.length} bytes)`, msg);
      throw new Error(msg);
    } finally {
      this.checking.set(false);
    }
  }

  toggleAuto(): void {
    void this.settings.setGrammarAutoDisabled(!this.settings.grammarAutoDisabled());
  }

  async setMode(
    mode: GrammarMode,
    customUrl?: string | null,
    ltUsername?: string | null,
  ): Promise<void> {
    await this.settings.setGrammarMode(mode, customUrl ?? null, ltUsername ?? null);
    const authNote = ltUsername ? ` (auth: ${ltUsername})` : '';
    this.debug.info(
      'grammar',
      `modo cambiado a "${mode}"${authNote}`,
      customUrl ?? undefined,
    );
    await this.ping();
  }

  /** Estado del apiKey en el keyring del OS (presente / backend / disponibilidad). Nunca devuelve el valor. */
  async apiKeyStatus(): Promise<SecretStatus> {
    return invoke<SecretStatus>('lt_api_key_status');
  }

  /** Guarda o borra el apiKey (valor vacío = borrar). Va al keyring; si no hay, cae a plain con warning. */
  async saveApiKey(value: string): Promise<SecretStatus> {
    return invoke<SecretStatus>('lt_api_key_save', { value });
  }

  async dockerStatus(): Promise<LtDockerStatus> {
    return invoke<LtDockerStatus>('languagetool_docker_status');
  }

  async dockerStart(): Promise<string> {
    try {
      const msg = await invoke<string>('languagetool_docker_start');
      this.debug.info('grammar', `LanguageTool Docker arrancado`, msg);
      return msg;
    } catch (e) {
      this.debug.error('grammar', `falló arrancar Docker LanguageTool`, String(e));
      throw e;
    }
  }

  async dockerStop(): Promise<void> {
    try {
      await invoke('languagetool_docker_stop');
      this.debug.info('grammar', `LanguageTool Docker detenido`);
    } catch (e) {
      this.debug.error('grammar', `falló detener Docker LanguageTool`, String(e));
      throw e;
    }
  }
}
