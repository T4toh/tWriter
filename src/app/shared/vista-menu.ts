import { LucideCheck } from '@lucide/angular';
import type { EditorWidth, ParagraphSpacing, SettingsService } from '../core/settings-service';
import type { CtxMenuEntry } from './context-menu-service';

const SPACING_OPTIONS: ReadonlyArray<{ value: ParagraphSpacing; label: string }> = [
  { value: 'tight', label: 'Apretado' },
  { value: 'normal', label: 'Normal' },
  { value: 'loose', label: 'Amplio' },
];

const WIDTH_OPTIONS: ReadonlyArray<{ value: EditorWidth; label: string }> = [
  { value: 'narrow', label: 'Página' },
  { value: 'wide', label: 'Ancho' },
  { value: 'full', label: 'Todo el ancho' },
];

/** «Vista ▾» de los editores de capítulos y de notas: lo que cambia la
 *  pantalla y no el libro. El ✓ marca la opción actual. */
export function vistaMenu(settings: SettingsService): CtxMenuEntry[] {
  const spacing = settings.editorParagraphSpacing();
  const width = settings.editorWidth();
  return [
    { kind: 'header', label: 'Solo en pantalla, no cambia el libro' },
    { kind: 'separator' },
    { kind: 'header', label: 'Espacio entre párrafos' },
    ...SPACING_OPTIONS.map((o) => ({
      label: o.label,
      icon: o.value === spacing ? LucideCheck : undefined,
      onClick: () => settings.setParagraphSpacing(o.value),
    })),
    { kind: 'separator' },
    { kind: 'header', label: 'Ancho del texto' },
    ...WIDTH_OPTIONS.map((o) => ({
      label: o.label,
      icon: o.value === width ? LucideCheck : undefined,
      onClick: () => settings.setEditorWidth(o.value),
    })),
  ];
}
