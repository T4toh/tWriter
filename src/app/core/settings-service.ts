import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { NativeDialogsService } from './native-dialogs-service';
import { GrammarMode } from './types';

export type EditorWidth = 'narrow' | 'wide' | 'full';
export type ParagraphSpacing = 'tight' | 'normal' | 'loose';
export type RightPanelWidth = 'compact' | 'normal' | 'wide' | 'full';

const FONT_MIN = 12;
const FONT_MAX = 28;
const FONT_DEFAULT = 17;
const SPACING_DEFAULT: ParagraphSpacing = 'tight';
const RIGHT_PANEL_DEFAULT: RightPanelWidth = 'normal';

/** em entre `<p>` en el editor por nivel. EPUB no se ve afectado — usa su propio CSS. */
export const PARAGRAPH_SPACING_EM: Record<ParagraphSpacing, number> = {
  tight: 0,
  normal: 0.3,
  loose: 0.6,
};

interface Settings {
  root: string | null;
  editorWidth?: EditorWidth;
  editorFontSize?: number;
  editorParagraphSpacing?: ParagraphSpacing;
  grammarMode?: GrammarMode;
  grammarCustomUrl?: string | null;
  grammarLtUsername?: string | null;
  grammarVariantEs?: string | null;
  grammarVariantEn?: string | null;
  grammarAutoDisabled?: boolean;
  raeAutoDisabled?: boolean;
  rightPanelWidth?: RightPanelWidth;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private dialogs = inject(NativeDialogsService);
  readonly root = signal<string | null>(null);
  readonly editorWidth = signal<EditorWidth>('narrow');
  readonly editorFontSize = signal<number>(FONT_DEFAULT);
  readonly editorParagraphSpacing = signal<ParagraphSpacing>(SPACING_DEFAULT);
  readonly grammarMode = signal<GrammarMode>('public');
  readonly grammarCustomUrl = signal<string | null>(null);
  readonly grammarLtUsername = signal<string | null>(null);
  readonly grammarVariantEs = signal<string>('es-AR');
  readonly grammarVariantEn = signal<string>('en-US');
  /** Auto-check de gramática desactivado por el usuario. Persiste cross-session. */
  readonly grammarAutoDisabled = signal<boolean>(false);
  /** Auto-check del validador RAE desactivado por el usuario. Persiste cross-session. */
  readonly raeAutoDisabled = signal<boolean>(false);
  readonly rightPanelWidth = signal<RightPanelWidth>(RIGHT_PANEL_DEFAULT);
  readonly focusMode = signal<boolean>(false);
  readonly loaded = signal<boolean>(false);

  async load(): Promise<void> {
    try {
      const s = await invoke<Settings>('get_settings');
      this.root.set(s.root ?? null);
      this.editorWidth.set(s.editorWidth ?? 'narrow');
      this.editorFontSize.set(clampFont(s.editorFontSize ?? FONT_DEFAULT));
      this.editorParagraphSpacing.set(s.editorParagraphSpacing ?? SPACING_DEFAULT);
      this.grammarMode.set((s.grammarMode as GrammarMode) ?? 'public');
      this.grammarCustomUrl.set(s.grammarCustomUrl ?? null);
      this.grammarLtUsername.set(s.grammarLtUsername ?? null);
      this.grammarVariantEs.set(s.grammarVariantEs ?? 'es-AR');
      this.grammarVariantEn.set(s.grammarVariantEn ?? 'en-US');
      this.grammarAutoDisabled.set(s.grammarAutoDisabled ?? false);
      this.raeAutoDisabled.set(s.raeAutoDisabled ?? false);
      this.rightPanelWidth.set(s.rightPanelWidth ?? RIGHT_PANEL_DEFAULT);
    } catch {
      this.root.set(null);
    } finally {
      this.loaded.set(true);
    }
  }

  async setRoot(path: string): Promise<void> {
    this.root.set(path);
    await this.persist();
  }

  async setEditorWidth(width: EditorWidth): Promise<void> {
    this.editorWidth.set(width);
    await this.persist();
  }

  cycleEditorWidth(): void {
    const order: EditorWidth[] = ['narrow', 'wide', 'full'];
    const next = order[(order.indexOf(this.editorWidth()) + 1) % order.length];
    void this.setEditorWidth(next);
  }

  bumpFontSize(delta: number): void {
    const next = clampFont(this.editorFontSize() + delta);
    if (next === this.editorFontSize()) return;
    this.editorFontSize.set(next);
    void this.persist();
  }

  cycleParagraphSpacing(): void {
    const order: ParagraphSpacing[] = ['tight', 'normal', 'loose'];
    const next = order[(order.indexOf(this.editorParagraphSpacing()) + 1) % order.length];
    this.editorParagraphSpacing.set(next);
    void this.persist();
  }

  async setGrammarMode(
    mode: GrammarMode,
    customUrl: string | null,
    ltUsername: string | null = null,
  ): Promise<void> {
    this.grammarMode.set(mode);
    this.grammarCustomUrl.set(customUrl);
    this.grammarLtUsername.set(ltUsername);
    await this.persist();
  }

  async setGrammarVariants(es: string, en: string): Promise<void> {
    this.grammarVariantEs.set(es);
    this.grammarVariantEn.set(en);
    await this.persist();
  }

  async setGrammarAutoDisabled(disabled: boolean): Promise<void> {
    this.grammarAutoDisabled.set(disabled);
    await this.persist();
  }

  async setRaeAutoDisabled(disabled: boolean): Promise<void> {
    this.raeAutoDisabled.set(disabled);
    await this.persist();
  }

  async setRightPanelWidth(width: RightPanelWidth): Promise<void> {
    this.rightPanelWidth.set(width);
    await this.persist();
  }

  cycleRightPanelWidth(): void {
    const order: RightPanelWidth[] = ['compact', 'normal', 'wide', 'full'];
    const next = order[(order.indexOf(this.rightPanelWidth()) + 1) % order.length];
    void this.setRightPanelWidth(next);
  }

  toggleFocusMode(): void {
    this.focusMode.update((v) => !v);
  }

  private async persist(): Promise<void> {
    const settings: Settings = {
      root: this.root(),
      editorWidth: this.editorWidth(),
      editorFontSize: this.editorFontSize(),
      editorParagraphSpacing: this.editorParagraphSpacing(),
      grammarMode: this.grammarMode(),
      grammarCustomUrl: this.grammarCustomUrl(),
      grammarLtUsername: this.grammarLtUsername(),
      grammarVariantEs: this.grammarVariantEs(),
      grammarVariantEn: this.grammarVariantEn(),
      grammarAutoDisabled: this.grammarAutoDisabled(),
      raeAutoDisabled: this.raeAutoDisabled(),
      rightPanelWidth: this.rightPanelWidth(),
    };
    await invoke('set_settings', { settings });
  }

  async pickRoot(): Promise<string | null> {
    const result = await this.dialogs.pickFolder({
      title: 'Carpeta raíz de novelas',
      defaultPath: this.root() ?? undefined,
    });
    if (result === null) return null;
    await this.setRoot(result);
    return result;
  }
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}
