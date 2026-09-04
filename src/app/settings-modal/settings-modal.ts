import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  LucideBan,
  LucideCheck,
  LucideCircle,
  LucideCircleAlert,
  LucideEye,
  LucideEyeOff,
  LucideLock,
  LucideX,
} from '@lucide/angular';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { DebugService } from '../core/debug-service';
import { GrammarService, LtDockerStatus, SecretStatus } from '../core/grammar-service';
import { APP_FONT_LABEL, AppFontSlot } from '../core/app-fonts';
import { SettingsService } from '../core/settings-service';
import { SystemFontsService } from '../core/system-fonts-service';
import { Select, SelectGroup, SelectOption } from '../shared/select';
import { CopyCommand } from '../shared/copy-command';
import { GrammarMode } from '../core/types';

export type DockerPhase =
  | 'checking'
  | 'daemon'
  | 'pulling'
  | 'starting'
  | 'loading'
  | 'ready'
  | 'error';

interface LtProgressEvent {
  phase: DockerPhase;
  message: string;
}

/** Secciones colapsables del modal. `show()` recibe cuál abrir: el effect que
 *  reacciona a LanguageTool caído pide `gramatica`, porque si el bloque
 *  arrancara colapsado el remedio quedaría escondido detrás de un click. */
export type SeccionSettings = 'general' | 'apariencia' | 'gramatica';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [
    FormsModule, Select, CopyCommand,
    LucideBan, LucideCheck, LucideCircle, LucideCircleAlert, LucideEye, LucideEyeOff,
    LucideLock, LucideX,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-modal.html',
  styleUrl: './settings-modal.scss',
})
export class SettingsModal {
  private grammar = inject(GrammarService);
  private settings = inject(SettingsService);
  protected debug = inject(DebugService);

  protected readonly open = signal<boolean>(false);
  protected readonly mode = signal<GrammarMode>('public');
  protected readonly customUrl = signal<string>('');
  protected readonly ltUsername = signal<string>('');
  /** Buffer del input. Cuando hay key guardada en el keyring, queda vacío hasta que el usuario tipea para reemplazar. */
  protected readonly ltApiKey = signal<string>('');
  protected readonly showApiKey = signal<boolean>(false);
  protected readonly apiKeyStatus = signal<SecretStatus | null>(null);
  protected readonly clearKeyOnSave = signal<boolean>(false);
  protected readonly variantEs = signal<string>('es-AR');
  protected readonly variantEn = signal<string>('en-US');
  protected readonly picky = signal<boolean>(false);
  /** Las tres formas de repetición deliberada que filtra el detector local.
   *  Prendidas = se filtran, que es el default. */
  protected readonly excConstruccion = signal<boolean>(true);
  protected readonly excFraseRepetida = signal<boolean>(true);
  protected readonly excAnafora = signal<boolean>(true);
  protected readonly testing = signal<boolean>(false);
  protected readonly testResult = signal<'ok' | 'fail' | null>(null);
  protected readonly saving = signal<boolean>(false);
  protected readonly dockerStatus = signal<LtDockerStatus | null>(null);
  protected readonly dockerBusy = signal<'starting' | 'stopping' | null>(null);
  protected readonly dockerMessage = signal<string | null>(null);
  protected readonly dockerPhase = signal<DockerPhase | null>(null);
  private unlistenProgress: UnlistenFn | null = null;

  constructor() {
    effect(() => {
      if (this.open()) {
        this.mode.set(this.grammar.mode());
        this.customUrl.set(this.grammar.customUrl() ?? '');
        this.ltUsername.set(this.grammar.ltUsername() ?? '');
        this.ltApiKey.set('');
        this.showApiKey.set(false);
        this.clearKeyOnSave.set(false);
        void this.refreshApiKeyStatus();
        this.variantEs.set(this.settings.grammarVariantEs());
        this.variantEn.set(this.settings.grammarVariantEn());
        this.picky.set(this.settings.grammarPicky());
        const exc = this.settings.repeticionesExcepciones();
        this.excConstruccion.set(exc.construccion);
        this.excFraseRepetida.set(exc.fraseRepetida);
        this.excAnafora.set(exc.anafora);
        this.testResult.set(null);
        this.dockerMessage.set(null);
        this.dockerPhase.set(null);
        void this.refreshDockerStatus();
      } else {
        this.detachProgressListener();
      }
    });
  }

  protected async refreshApiKeyStatus(): Promise<void> {
    try {
      this.apiKeyStatus.set(await this.grammar.apiKeyStatus());
    } catch {
      this.apiKeyStatus.set(null);
    }
  }

  protected markKeyForDeletion(): void {
    this.clearKeyOnSave.set(true);
    this.ltApiKey.set('');
  }

  protected undoKeyDeletion(): void {
    this.clearKeyOnSave.set(false);
  }

  protected async refreshDockerStatus(): Promise<void> {
    try {
      const s = await this.grammar.dockerStatus();
      this.dockerStatus.set(s);
    } catch {
      this.dockerStatus.set(null);
    }
  }

  protected async startDocker(runtime?: string): Promise<void> {
    this.dockerBusy.set('starting');
    this.dockerPhase.set('checking');
    this.dockerMessage.set('Buscando un runtime de containers…');
    await this.attachProgressListener();
    try {
      const msg = await this.grammar.dockerStart(runtime);
      this.dockerPhase.set('ready');
      this.dockerMessage.set(msg);
    } catch (e) {
      this.dockerPhase.set('error');
      this.dockerMessage.set(String(e));
    } finally {
      this.dockerBusy.set(null);
      this.detachProgressListener();
      await this.refreshDockerStatus();
      await this.grammar.ping();
    }
  }

  private async attachProgressListener(): Promise<void> {
    this.detachProgressListener();
    this.unlistenProgress = await listen<LtProgressEvent>('languagetool-progress', (ev) => {
      this.dockerPhase.set(ev.payload.phase);
      this.dockerMessage.set(ev.payload.message);
    });
  }

  private detachProgressListener(): void {
    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = null;
    }
  }

  protected async stopDocker(): Promise<void> {
    this.dockerBusy.set('stopping');
    this.dockerMessage.set(null);
    try {
      await this.grammar.dockerStop();
      this.dockerMessage.set('Detenido.');
    } catch (e) {
      this.dockerMessage.set(String(e));
    } finally {
      this.dockerBusy.set(null);
      await this.refreshDockerStatus();
      await this.grammar.ping();
    }
  }

  /** Qué bloque arranca desplegado. Se recalcula en cada `show()` a propósito:
   *  no se persiste lo que el autor colapsó a mano, porque el modal tiene que
   *  abrirse con Gramática a la vista cada vez que LT se cae. */
  protected readonly generalAbierta = signal<boolean>(false);
  protected readonly aparienciaAbierta = signal<boolean>(false);
  protected readonly gramaticaAbierta = signal<boolean>(true);

  show(seccion: SeccionSettings = 'gramatica'): void {
    this.generalAbierta.set(seccion === 'general');
    this.aparienciaAbierta.set(seccion === 'apariencia');
    this.gramaticaAbierta.set(seccion === 'gramatica');
    this.open.set(true);
  }

  // ── Apariencia: las tres fuentes de la app ──────────────────────────────
  private systemFonts = inject(SystemFontsService);

  protected readonly slots: readonly AppFontSlot[] = ['ui', 'mono'];
  protected readonly slotLabel = APP_FONT_LABEL;
  protected readonly slotAyuda: Record<AppFontSlot, string> = {
    ui: 'Paneles, árbol, menús y botones.',
    mono: 'Paths, diffs y el panel de debug.',
  };
  /** Lo que shipea la app por slot. Solo para el label de la opción "default":
   *  el valor que se guarda es `null` y el stack real vive en `styles.scss`. */
  private readonly slotDefault: Record<AppFontSlot, string> = {
    ui: 'Lato',
    mono: 'Roboto Mono',
  };

  /** Un `SelectGroup[]` por slot. Se arma una sola vez por cambio del listado
   *  del OS, en vez de una función llamada desde el template por cada CD. */
  protected readonly fontGroups = computed<Record<AppFontSlot, SelectGroup[]>>(() => {
    const sys = this.systemFonts.fonts();
    const instaladas: SelectOption[] = sys.map((f) => ({
      value: f.family,
      label: f.family,
      data: { fontFamily: f.family, path: f.path },
    }));
    const armar = (slot: AppFontSlot): SelectGroup[] => {
      const grupos: SelectGroup[] = [
        {
          label: 'De la app',
          options: [{ value: '', label: `${this.slotDefault[slot]} (default)` }],
        },
      ];
      if (instaladas.length > 0) grupos.push({ label: 'Instaladas', options: instaladas });
      return grupos;
    };
    return { ui: armar('ui'), mono: armar('mono') };
  });

  protected fontValue(slot: AppFontSlot): string {
    return this.settings.appFont(slot) ?? '';
  }

  protected readonly fontsCargando = this.systemFonts.loading;

  /** El listado del OS tarda ~400ms la primera vez, así que se pide al abrir
   *  el dropdown y no al abrir el modal. */
  protected onFontDropdownOpen(): void {
    void this.systemFonts.ensureLoaded();
  }

  protected onFontHover(opt: SelectOption): void {
    const data = opt.data as { fontFamily?: string; path?: string } | undefined;
    if (!data?.fontFamily || !data.path) return;
    void this.systemFonts.loadFace(data.fontFamily, data.path);
  }

  protected onFontSelect(slot: AppFontSlot, value: string): void {
    this.settings.setAppFont(slot, value || null);
  }

  protected resetFonts(): void {
    this.settings.resetAppFonts();
  }

  protected readonly hayFuenteElegida = computed(() =>
    this.slots.some((slot) => this.settings.appFont(slot) !== null),
  );

  close(): void {
    this.open.set(false);
  }

  protected onModeChange(value: string): void {
    this.mode.set(value as GrammarMode);
    this.testResult.set(null);
  }

  /** Devuelve true si la fase `p` ya pasó (la actual está más adelante en el flujo). */
  protected phaseDone(p: DockerPhase): boolean {
    const order: DockerPhase[] = ['checking', 'daemon', 'pulling', 'starting', 'loading', 'ready'];
    const cur = this.dockerPhase();
    if (!cur || cur === 'error') return false;
    return order.indexOf(cur) > order.indexOf(p);
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      // El test usa el apiKey del input (override transitorio). Si está vacío y
      // hay key guardada en el keyring, el backend la usa.
      const cfg = {
        mode: this.mode(),
        customUrl: this.customUrl().trim() || null,
        ltUsername: this.ltUsername().trim() || null,
        ltApiKey: this.ltApiKey().trim() || null,
        variantEs: this.variantEs(),
        variantEn: this.variantEn(),
        picky: this.picky(),
      };
      const ok = await invoke<boolean>('check_grammar_available', { cfg });
      this.testResult.set(ok ? 'ok' : 'fail');
    } catch {
      this.testResult.set('fail');
    } finally {
      this.testing.set(false);
    }
  }

  protected async apply(): Promise<void> {
    this.saving.set(true);
    try {
      const url = this.customUrl().trim() || null;
      const user = this.ltUsername().trim() || null;
      const newKey = this.ltApiKey().trim();
      await this.settings.setGrammarVariants(this.variantEs(), this.variantEn());
      await this.settings.setGrammarPicky(this.picky());
      await this.settings.setRepeticionesExcepciones({
        construccion: this.excConstruccion(),
        fraseRepetida: this.excFraseRepetida(),
        anafora: this.excAnafora(),
      });
      await this.grammar.setMode(this.mode(), url, user);

      // apiKey va al keyring por separado. Solo tocar si:
      //   - usuario tipeó algo nuevo → guardar
      //   - usuario clickeó "borrar key" → mandar string vacío
      if (newKey) {
        await this.grammar.saveApiKey(newKey);
      } else if (this.clearKeyOnSave()) {
        await this.grammar.saveApiKey('');
      }

      await this.grammar.ping();
      this.close();
    } finally {
      this.saving.set(false);
    }
  }

  protected toggleApiKeyVisibility(): void {
    this.showApiKey.update((v) => !v);
  }
}
