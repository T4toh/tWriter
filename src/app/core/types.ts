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
  palabras: number;
  ultima_edicion: string | null;
  status: string | null;
  idioma: string | null;
}

export const EMPTY_META: ChapterMeta = {
  orden: 0,
  titulo: '',
  palabras: 0,
  ultima_edicion: null,
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
  /** Filename stem del face explícito para `<em>`/`<i>`. Pisa auto-pick. */
  body_font_italic?: string | null;
  /** Filename stem del face explícito para `<strong>`/`<b>`. */
  body_font_bold?: string | null;
  /** Filename stem del face explícito para combinaciones bold+italic. */
  body_font_bold_italic?: string | null;
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
