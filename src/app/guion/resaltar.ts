/**
 * Resaltado del formato de escenas del juego (rpg-copado). Puro, sin DOM.
 *
 * El formato está definido en el repo del juego (`docs/superpowers/specs/
 * 2026-11-03-dialogos-design.md` de rpg-copado); acá solo se reconoce lo
 * variable para pintarlo. Lo que no calza con nada queda como `texto` (el que
 * habla sigue hablando): **no se marcan errores**, eso es del validador del
 * juego.
 *
 * Se trabaja línea por línea arrastrando un solo estado: si quedó abierto un
 * comentario `<!-- … -->`, porque puede abarcar varias líneas y adentro no se
 * reconoce nada.
 */

export type ClaseGuion =
  | 'titulo'
  | 'lugar'
  | 'nombre'
  | 'gesto'
  | 'narracion'
  | 'instruccion'
  | 'opcion'
  | 'tirada'
  | 'resultado'
  | 'comentario'
  | 'texto';

/** Rango dentro de la línea, `hasta` exclusivo. */
export interface Span {
  desde: number;
  hasta: number;
  clase: ClaseGuion;
}

export interface Resaltado {
  spans: Span[];
  enComentario: boolean;
}

const SANGRIA = /^[ \t]*/;
/** Mayúsculas con acentos y Ñ, dígitos y `_`; después `(gesto)` opcional y `:`. */
const HABLA = /^([A-ZÁÉÍÓÚÜÑ0-9_]+)( \([^)]*\))?:/;
const INSTRUCCION = /^\[(?:fondo|entra|sale|recordar|si):[^\]]*\]\s*$|^\[si no\]\s*$/;
const ENTRA_SALE = /^\[(?:entra|sale):\s*([A-ZÁÉÍÓÚÜÑ0-9_]+)\s*\]/;
const RESULTADO = /^- (?:éxito|exito|falla):\s*$/;
const TIRADA = /^- (\[[^\]]*\])/;

export function resaltar(linea: string, enComentario: boolean): Resaltado {
  const spans: Span[] = [];
  let pos = 0;
  let abierto = enComentario;

  // Comentarios primero: pueden empezar y terminar en cualquier parte de la
  // línea, y lo que no está adentro de uno se clasifica aparte.
  while (pos < linea.length) {
    if (abierto) {
      const fin = linea.indexOf('-->', pos);
      const hasta = fin === -1 ? linea.length : fin + 3;
      spans.push({ desde: pos, hasta, clase: 'comentario' });
      pos = hasta;
      if (fin === -1) return { spans, enComentario: true };
      abierto = false;
      continue;
    }
    const inicio = linea.indexOf('<!--', pos);
    const tramo = linea.slice(pos, inicio === -1 ? linea.length : inicio);
    clasificar(tramo, pos, spans);
    if (inicio === -1) break;
    pos = inicio;
    abierto = true;
  }
  return { spans, enComentario: abierto };
}

/** Clasifica un tramo sin comentarios, sumando `base` a los offsets. */
function clasificar(tramo: string, base: number, spans: Span[]): void {
  const sangria = SANGRIA.exec(tramo)?.[0].length ?? 0;
  const cuerpo = tramo.slice(sangria);
  const desde = base + sangria;
  const hasta = base + tramo.length;
  if (cuerpo.trim() === '') return;
  const finCuerpo = desde + cuerpo.trimEnd().length;

  if (cuerpo.startsWith('## ')) {
    spans.push({ desde, hasta: finCuerpo, clase: 'lugar' });
    return;
  }
  if (cuerpo.startsWith('# ')) {
    spans.push({ desde, hasta: finCuerpo, clase: 'titulo' });
    return;
  }
  if (INSTRUCCION.test(cuerpo)) {
    spans.push({ desde, hasta: finCuerpo, clase: 'instruccion' });
    const m = ENTRA_SALE.exec(cuerpo);
    if (m) {
      const nombreDesde = desde + cuerpo.indexOf(m[1]);
      spans.push({ desde: nombreDesde, hasta: nombreDesde + m[1].length, clase: 'nombre' });
    }
    return;
  }
  if (RESULTADO.test(cuerpo)) {
    spans.push({ desde, hasta: finCuerpo, clase: 'resultado' });
    return;
  }
  if (cuerpo.startsWith('> ') || cuerpo === '>') {
    spans.push({ desde, hasta: desde + 1, clase: 'narracion' });
    texto(cuerpo, 2, desde, spans);
    return;
  }
  if (cuerpo.startsWith('- ')) {
    spans.push({ desde, hasta: desde + 1, clase: 'opcion' });
    const t = TIRADA.exec(cuerpo);
    if (t) {
      spans.push({ desde: desde + 2, hasta: desde + 2 + t[1].length, clase: 'tirada' });
      texto(cuerpo, 2 + t[1].length + 1, desde, spans);
    } else {
      texto(cuerpo, 2, desde, spans);
    }
    return;
  }
  const h = HABLA.exec(cuerpo);
  if (h) {
    spans.push({ desde, hasta: desde + h[1].length, clase: 'nombre' });
    if (h[2]) {
      const gDesde = desde + h[1].length + 1;
      spans.push({ desde: gDesde, hasta: gDesde + h[2].length - 1, clase: 'gesto' });
    }
    texto(cuerpo, h[0].length + 1, desde, spans);
    return;
  }
  spans.push({ desde, hasta, clase: 'texto' });
}

/** Span `texto` desde `offset` (dentro del cuerpo) hasta el final, si hay algo. */
function texto(cuerpo: string, offset: number, desde: number, spans: Span[]): void {
  if (offset >= cuerpo.length) return;
  spans.push({ desde: desde + offset, hasta: desde + cuerpo.length, clase: 'texto' });
}
