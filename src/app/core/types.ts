export type NodeKind = 'saga' | 'book' | 'section' | 'chapter' | 'note' | 'notes' | 'folder';

export interface TreeNode {
  name: string;
  path: string;
  kind: NodeKind;
  ext?: string;
  editable?: boolean;
  modifiedMs?: number;
  wordCount?: number;
  excluded?: boolean;
  children: TreeNode[];
}

export interface ChapterMeta {
  orden: number;
  titulo: string;
  status: string | null;
  idioma: string | null;
}

export const EMPTY_META: ChapterMeta = {
  orden: 0,
  titulo: '',
  status: null,
  idioma: null,
};

export interface Theme {
  id?: string | null;
  nombre?: string | null;
  body_font?: string | null;
  body_size?: string | null;
  heading_font?: string | null;
  heading_size?: string | null;
  line_height?: string | null;
  page_margin?: string | null;
  /** Familia para texto de páginas editoriales (TOC, copyright, dedicatoria,
   *  title page, sobre el autor). Auto-pick por sufijo igual que body_font. */
  editorial_body_font?: string | null;
  /** Familia para títulos de páginas editoriales (TÍTULO de title-page,
   *  "Índice", parte-headings del TOC, encabezado de about-author). */
  editorial_heading_font?: string | null;
  /** Posición vertical del bloque título+prefix en la página de chapter-title.
   *  `top` | `center` | `bottom`. null o ausente = `center` (default). */
  chapter_title_position?: string | null;
  /** Prefijo del capítulo: `none` | `decimal` | `roman`. Default: `none`. */
  prefijo_capitulo?: string | null;
  /** Mostrar el título del capítulo en chapter title page. Default: true. */
  mostrar_titulo_capitulo?: boolean | null;
  /** Letrina (dropcap) en primera letra de cada capítulo. Default: false. */
  dropcap?: boolean | null;
  /** Mostrar número/título de la parte arriba de su contenido. Default: false. */
  mostrar_numero_parte?: boolean | null;
  /** Formato de etiqueta de parte: `raw` | `parte` | `punto`. Default: `raw`. */
  formato_parte?: string | null;
  /** Tamaño de página EPUB: `6x9` | `5x8` | `a5`. Default: `6x9`. */
  template?: string | null;
  /** Ángulo (deg) para la oblique sintética de `<em>`/`<i>`. None = `italic` (default UA). */
  italic_oblique_deg?: number | null;
  /** Peso para `<em>`/`<i>` (100-900). None = peso del regular. */
  italic_weight?: number | null;
  /** Peso para `<strong>`/`<b>` (100-900). None = `bold` (700). */
  bold_weight?: number | null;
}

export interface ThemeRef {
  base?: string | null;
  overrides?: Theme | null;
}

export interface ThemeMeta extends Theme {
  id: string;
}

export interface FontEntry {
  name: string;
  path: string;
  relative_path: string;
  size_bytes: number;
  ext?: string | null;
  family: string;
  weight: number;
  style: string;
}

export type PullChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface PullPathChange {
  path: string;
  kind: PullChangeKind;
}

export type GrammarMode = 'public' | 'local' | 'custom';

export interface GrammarMatch {
  offset: number;
  length: number;
  message: string;
  shortMessage: string;
  ruleId: string;
  category: string;
  replacements: string[];
}

export type RaeCategory = 'pending-conversion' | 'char' | 'structure' | 'typo';
export type RaeSeverity = 'error' | 'warning';

export interface RaeAutoFix {
  offset: number;
  length: number;
  replacement: string;
}

export interface RaeParagraphRange {
  offset: number;
  length: number;
}

export interface RaeViolation {
  offset: number;
  length: number;
  category: RaeCategory;
  severity: RaeSeverity;
  ruleId: string;
  message: string;
  shortMessage: string;
  autoFix?: RaeAutoFix;
  paragraphRange?: RaeParagraphRange;
}

/** Repetición cercana de una palabra de contenido. La marca va en la aparición
 *  repetida, nunca en la primera del grupo. */
export interface Repeticion {
  offset: number;
  length: number;
  /** Forma normalizada que disparó el match (minúsculas, sin diacríticos). */
  palabra: string;
  /** Offset de la aparición previa, para el "ir a la anterior" del popover. */
  offsetPrevio: number;
  /** Distancia en palabras contra la aparición previa. */
  distancia: number;
  /** Cuántas veces aparece la forma en este párrafo, dentro de la ventana. */
  apariciones: number;
}
