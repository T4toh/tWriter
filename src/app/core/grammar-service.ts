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
}

/** Qué pasó y con qué se arregla. Espeja `Remedy` de `grammar.rs`. */
export interface Remedy {
  /** Qué pasó, en prosa, sin el comando embebido. */
  message: string;
  /** Comando exacto para copiar, o null si no hay uno (ej. abrir Docker Desktop). */
  command: string | null;
  /** La app puede ejecutarlo sola. Decide botón primario vs solo chip copiable. */
  can_run: boolean;
}

/** Una forma de instalar un runtime. `command` solo viene en macOS (Homebrew). */
export interface InstallOption {
  label: string;
  command: string | null;
  url: string;
}

/** Runtime candidato cuando la app no puede saber cuál usa LanguageTool. */
export interface RuntimeChoice {
  /** Clave estable que vuelve como parámetro de dockerStart. */
  key: string;
  label: string;
}

export interface LtDockerStatus {
  /** Hay al menos un runtime de containers instalado (Docker/Podman/Apple). */
  docker_installed: boolean;
  /** Nombre legible del runtime detectado (ej. "Apple container"), o null. */
  runtime: string | null;
  /**
   * ¿Responde el daemon del runtime? Cuando es false, `container_running` y
   * `container_exists` NO significan nada: el CLI no puede listar containers
   * sin daemon.
   */
  daemon_running: boolean;
  container_running: boolean;
  container_exists: boolean;
  api_responding: boolean;
  /** Remedio accionable cuando falta el runtime o el daemon no responde. */
  remedy: Remedy | null;
  /** Cómo instalar un runtime. Solo viene con contenido si no hay ninguno. */
  install_options: InstallOption[];
  /**
   * Candidatos entre los que elegir. No vacío SOLO cuando hay más de un runtime
   * instalado, ninguno respondiendo y nada recordado.
   */
  runtime_choices: RuntimeChoice[];
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
      picky: this.settings.grammarPicky(),
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

  async dockerStart(runtime?: string): Promise<string> {
    try {
      const msg = await invoke<string>('languagetool_docker_start', {
        runtime: runtime ?? null,
      });
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
