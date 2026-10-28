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
  /** `level=picky` en `/v2/check`: reglas extra de texto formal. */
  picky: boolean;
  /** Ids de reglas que el autor mató en la saga activa. Van como
   *  `disabledRules` en `/v2/check` (el backend arma el CSV). */
  disabledRules: string[];
}

/** Estado del LanguageTool que baja y corre tWriter (`lt_embebido.rs`). */
export interface LtEmbebidoStatus {
  lt_instalado: string | null;
  jre_instalado: string | null;
  /** Versiones que trae esta versión de tWriter (`lt-lock.json`). */
  lt_lock: string;
  jre_lock: string;
  /** Lo que falta bajar para quedar al día con el lock; 0 si está al día. */
  mb_a_bajar: number;
  corriendo: boolean;
  puerto: number | null;
  /** Último error de arranque, con la última línea de stderr de java. */
  error: string | null;
  /** Otro LanguageTool en 8081: el container de una versión anterior de tWriter. */
  container_viejo: boolean;
}

export type SecretBackend = 'keyring' | 'plain' | 'none';

export interface SecretStatus {
  present: boolean;
  backend: SecretBackend;
  keyring_available: boolean;
}

/** Polling cuando LT está caído. 30s = balance entre recovery rápido y
 * ruido en logs. Una vez que `available` flipea a true, el guard del
 * setInterval lo deja como no-op (sin clearInterval para no bookkeepar). */
const LT_RECOVERY_POLL_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class GrammarService {
  private settings = inject(SettingsService);
  private sagaCtx = inject(SagaContextService);
  private debug = inject(DebugService);

  constructor() {
    setInterval(() => {
      if (!this.available()) void this.ping();
    }, LT_RECOVERY_POLL_MS);
  }

  readonly available = signal<boolean>(false);
  /** Versión del LT en uso (pie del editor). `null` si no responde o en modo público. */
  readonly version = signal<string | null>(null);
  readonly checking = signal<boolean>(false);
  readonly lastError = signal<string | null>(null);
  /**
   * Contador de pedidos de "abrí el modal de config de LT". `app.ts` es el
   * único que tiene el `ViewChild` del modal, así que el pedido viaja por acá
   * en vez de que cada superficie que chequea gramática conozca el shell.
   */
  readonly pedidoDeConfig = signal<number>(0);
  /** Ya se auto-abrió el modal por esta caída. Se rearma cuando LT responde. */
  private avisoAbierto = false;
  readonly mode = this.settings.grammarMode;
  readonly customUrl = this.settings.grammarCustomUrl;
  readonly ltUsername = this.settings.grammarLtUsername;

  readonly canAutoCheck = computed(() => this.mode() === 'local' || this.mode() === 'custom');
  /**
   * Auto-check activo. Se prende solo cuando LT responde (available) y el
   * modo lo permite (local/custom). El usuario lo apaga desde Configuración →
   * General → «Revisión mientras escribís» (persiste `grammarAutoDisabled`).
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
      picky: this.settings.grammarPicky(),
      disabledRules: this.sagaCtx.reglasLtDesactivadas().map((r) => r.regla),
    };
  }

  /** Pide abrir el modal de configuración de LanguageTool. */
  pedirConfig(): void {
    this.pedidoDeConfig.update((n) => n + 1);
  }

  async ping(): Promise<boolean> {
    try {
      const ok = await invoke<boolean>('check_grammar_available', { cfg: this.buildCfg() });
      this.available.set(ok);
      if (ok) this.avisoAbierto = false;
      if (!ok) this.version.set(null);
      else if (this.version() === null) void this.loadVersion();
      if (!ok) this.debug.warn('grammar', `ping LanguageTool falló (modo ${this.mode()})`);
      return ok;
    } catch (e) {
      this.available.set(false);
      this.debug.error('grammar', `ping LanguageTool excepción (modo ${this.mode()})`, String(e));
      return false;
    }
  }

  private async loadVersion(): Promise<void> {
    try {
      this.version.set(
        await invoke<string | null>('languagetool_version', { cfg: this.buildCfg() }),
      );
    } catch {
      this.version.set(null);
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
      // Recalibración inmediata: si LT acaba de caerse, el próximo
      // scheduleGrammarRecheck del editor verá `available=false` y no spamea
      // requests muertos hasta que el polling de recovery lo levante.
      //
      // El modal de config se abre solo si el ping confirma que LT NO responde
      // — un 500 esporádico (LT 6.8 los tira en es-AR) no es un problema de
      // configuración y no justifica interrumpir al autor. Una sola vez por
      // caída: `avisoAbierto` se rearma cuando LT vuelve.
      void this.ping().then((ok) => {
        if (ok || this.avisoAbierto) return;
        this.avisoAbierto = true;
        this.pedirConfig();
      });
      throw new Error(msg);
    } finally {
      this.checking.set(false);
    }
  }

  async setMode(
    mode: GrammarMode,
    customUrl?: string | null,
    ltUsername?: string | null,
  ): Promise<void> {
    await this.settings.setGrammarMode(mode, customUrl ?? null, ltUsername ?? null);
    this.version.set(null);
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

  async embebidoStatus(): Promise<LtEmbebidoStatus> {
    return invoke<LtEmbebidoStatus>('lt_embebido_status');
  }

  async embebidoInstalar(): Promise<void> {
    await this.embebidoAccion('lt_embebido_instalar', 'bajado y arrancado');
  }

  async embebidoReiniciar(): Promise<void> {
    await this.embebidoAccion('lt_embebido_reiniciar', 'reiniciado');
  }

  async embebidoBorrar(): Promise<void> {
    await this.embebidoAccion('lt_embebido_borrar', 'borrado');
  }

  private async embebidoAccion(cmd: string, hecho: string): Promise<void> {
    try {
      await invoke(cmd);
      this.debug.info('grammar', `LanguageTool embebido ${hecho}`);
    } catch (e) {
      this.debug.error('grammar', `falló ${cmd}`, String(e));
      throw e;
    } finally {
      // Puede haber cambiado de versión o de puerto: la versión cacheada ya no vale.
      this.version.set(null);
      void this.ping();
    }
  }
}
