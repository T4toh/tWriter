import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { GrammarService, LtDockerStatus } from '../core/grammar-service';
import { SettingsService } from '../core/settings-service';
import { Select } from '../shared/select';
import { GrammarMode } from '../core/types';

export type DockerPhase = 'checking' | 'pulling' | 'starting' | 'loading' | 'ready' | 'error';

interface LtProgressEvent {
  phase: DockerPhase;
  message: string;
}

@Component({
  selector: 'app-grammar-settings',
  standalone: true,
  imports: [FormsModule, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './grammar-settings.html',
  styleUrl: './grammar-settings.scss',
})
export class GrammarSettings {
  private grammar = inject(GrammarService);
  private settings = inject(SettingsService);

  protected readonly open = signal<boolean>(false);
  protected readonly mode = signal<GrammarMode>('public');
  protected readonly customUrl = signal<string>('');
  protected readonly variantEs = signal<string>('es-AR');
  protected readonly variantEn = signal<string>('en-US');
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
        this.variantEs.set(this.settings.grammarVariantEs());
        this.variantEn.set(this.settings.grammarVariantEn());
        this.testResult.set(null);
        this.dockerMessage.set(null);
        this.dockerPhase.set(null);
        void this.refreshDockerStatus();
      } else {
        this.detachProgressListener();
      }
    });
  }

  protected async refreshDockerStatus(): Promise<void> {
    try {
      const s = await this.grammar.dockerStatus();
      this.dockerStatus.set(s);
    } catch {
      this.dockerStatus.set(null);
    }
  }

  protected async startDocker(): Promise<void> {
    this.dockerBusy.set('starting');
    this.dockerPhase.set('checking');
    this.dockerMessage.set('Chequeando que Docker esté instalado…');
    await this.attachProgressListener();
    try {
      const msg = await this.grammar.dockerStart();
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

  show(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  protected onModeChange(value: string): void {
    this.mode.set(value as GrammarMode);
    this.testResult.set(null);
  }

  /** Devuelve true si la fase `p` ya pasó (la actual está más adelante en el flujo). */
  protected phaseDone(p: DockerPhase): boolean {
    const order: DockerPhase[] = ['checking', 'pulling', 'starting', 'loading', 'ready'];
    const cur = this.dockerPhase();
    if (!cur || cur === 'error') return false;
    return order.indexOf(cur) > order.indexOf(p);
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const cfg = {
        mode: this.mode(),
        customUrl: this.customUrl().trim() || null,
        variantEs: this.variantEs(),
        variantEn: this.variantEn(),
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
      await this.settings.setGrammarVariants(this.variantEs(), this.variantEn());
      await this.grammar.setMode(this.mode(), url);
      this.close();
    } finally {
      this.saving.set(false);
    }
  }
}
