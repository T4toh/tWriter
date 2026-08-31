/**
 * Markdown de una nota ⇄ bloques editables del form de creación.
 *
 * Las plantillas (de fábrica y las del autor en `<root>/Plantillas/`) son
 * markdown, así que este módulo es el único traductor y hay un solo camino de
 * código para las dos fuentes. Puro: sin DOM, sin Angular. Cubierto por
 * `scripts/run-note-blocks-smoke.mjs`.
 */

export type BloqueTipo = 'h1' | 'h2' | 'lista' | 'parrafo';

export interface Bloque {
  tipo: BloqueTipo;
  /** h1/h2: el título. parrafo: el cuerpo (puede tener saltos). lista: ''. */
  texto: string;
  /** Solo `lista`. Vacío en los otros tipos. */
  items: string[];
}

export interface RenderOpts {
  /** Guarda la estructura sin el contenido: es lo que se escribe a `Plantillas/`. */
  plantilla?: boolean;
}

const HEADING = /^(#{1,6})(?:\s+(.*))?$/;
/** Exige espacio (o nada) después del marcador, para que `---` y `-Hola` no sean bullets. */
const BULLET = /^\s*[-*+](?:\s+(.*))?$/;

export function bloqueVacio(tipo: BloqueTipo): Bloque {
  return { tipo, texto: '', items: tipo === 'lista' ? [''] : [] };
}

export function markdownABloques(md: string): Bloque[] {
  const out: Bloque[] = [];
  let lista: string[] | null = null;
  let parrafo: string[] | null = null;

  const cerrar = (): void => {
    if (lista) {
      out.push({ tipo: 'lista', texto: '', items: lista });
      lista = null;
    }
    if (parrafo) {
      out.push({ tipo: 'parrafo', texto: parrafo.join('\n'), items: [] });
      parrafo = null;
    }
  };

  for (const raw of md.split(/\r?\n/)) {
    const linea = raw.trimEnd();
    const h = HEADING.exec(linea);
    if (h) {
      cerrar();
      // ponytail: el modelo tiene dos niveles; ###+ colapsa a h2. Sumar 'h3' si
      // aparece una nota con jerarquía de tres niveles que importe.
      out.push({ tipo: h[1].length === 1 ? 'h1' : 'h2', texto: (h[2] ?? '').trim(), items: [] });
      continue;
    }
    const b = BULLET.exec(linea);
    if (b) {
      // Cierra parrafo pero no lista (para acumular bullets en la misma lista)
      if (parrafo) {
        out.push({ tipo: 'parrafo', texto: parrafo.join('\n'), items: [] });
        parrafo = null;
      }
      lista = lista ?? [];
      lista.push((b[1] ?? '').trim());
      continue;
    }
    if (linea.trim() === '') {
      cerrar();
      continue;
    }
    // Línea de prosa: cierra lista pero no parrafo (para acumular líneas en el mismo parrafo)
    if (lista) {
      out.push({ tipo: 'lista', texto: '', items: lista });
      lista = null;
    }
    parrafo = parrafo ?? [];
    parrafo.push(linea);
  }
  cerrar();
  return conParrafosImplicitos(out);
}

/** Un heading sin nada abajo significa "sección de prosa": en un `.md` vacío es
 *  lo único que distingue un párrafo de una lista (que deja su bullet). Sin esto,
 *  guardar `Conjuro` como plantilla y recargarla deja `Descripción` sin campo. */
function conParrafosImplicitos(bloques: readonly Bloque[]): Bloque[] {
  const out: Bloque[] = [];
  for (let i = 0; i < bloques.length; i++) {
    const b = bloques[i];
    out.push(b);
    if (b.tipo !== 'h1' && b.tipo !== 'h2') continue;
    const sig = bloques[i + 1];
    // Agrega parrafo si: (a) no hay siguiente, (b) siguiente es h1, o (c) ambos son h2 (mismo nivel)
    if (!sig || sig.tipo === 'h1' || (b.tipo === 'h2' && sig.tipo === 'h2')) {
      out.push(bloqueVacio('parrafo'));
    }
  }
  return out;
}

export function bloquesAMarkdown(bloques: readonly Bloque[], opts: RenderOpts = {}): string {
  const plantilla = opts.plantilla === true;
  const renderizado: string[] = [];
  let ultimoTipo: BloqueTipo | null = null;

  for (let i = 0; i < bloques.length; i++) {
    const b = bloques[i];
    let s: string | null = null;
    if (b.tipo === 'h1' || b.tipo === 'h2') {
      const texto = b.texto.trim();
      if (texto === '' && !plantilla) continue;
      // En modo nota, salta headings sin contenido después
      if (!plantilla && restoVacio(bloques, i + 1)) continue;
      s = `${b.tipo === 'h1' ? '#' : '##'} ${texto}`.trimEnd();
    } else if (b.tipo === 'lista') {
      if (!plantilla) {
        const items = b.items.map((i) => i.trim()).filter((i) => i !== '');
        if (items.length === 0) continue;
        s = items.map((i) => `- ${i}`).join('\n');
      } else {
        // El bullet vacío marca "esta sección es una lista" al reparsear
        s = '-';
      }
    } else { // parrafo
      if (plantilla) continue;
      const texto = b.texto.trim();
      if (texto === '') continue;
      s = texto;
    }
    if (s !== null) {
      // Agrega línea en blanco: antes de headings o entre bloques del mismo tipo (parrafo/lista)
      if (renderizado.length > 0 && (b.tipo === 'h1' || b.tipo === 'h2' || ultimoTipo === b.tipo)) {
        renderizado.push('');
      }
      renderizado.push(s);
      ultimoTipo = b.tipo;
    }
  }
  return renderizado.length === 0 ? '' : `${renderizado.join('\n')}\n`;
}

function restoVacio(bloques: readonly Bloque[], start: number): boolean {
  for (let i = start; i < bloques.length; i++) {
    const b = bloques[i];
    if (b.tipo === 'h1' || b.tipo === 'h2') return true; // Siguiente heading: sección vacía
    if (b.tipo === 'lista') {
      const hasContent = b.items.some((item) => item.trim() !== '');
      if (hasContent) return false;
    } else {
      if (b.texto.trim() !== '') return false;
    }
  }
  return true;
}
