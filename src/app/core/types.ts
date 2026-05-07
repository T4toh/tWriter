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
