export type NodeKind = 'saga' | 'book' | 'section' | 'chapter';

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
