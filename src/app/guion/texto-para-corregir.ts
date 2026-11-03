/**
 * Qué parte del guion va a LanguageTool. Puro, sin DOM.
 *
 * Solo la prosa (los spans `texto` de `resaltar`): lo que sigue al
 * `NOMBRE (gesto):`, la narración, el texto de una opción y las líneas de
 * continuación. Nombres, gestos, instrucciones, títulos, tiradas, resultados
 * y comentarios no se mandan nunca, así `HERMANO` o `[si no]` no aparecen
 * como errores ni hay que meterlos en el diccionario.
 *
 * Los tramos van unidos con `\n\n` (para LT, un corte de párrafo), y una marca
 * que cruce de un tramo a otro la descarta `mapMatchesToPm`, que no acepta
 * matches con `\n` adentro.
 */
import { resaltar } from './resaltar';

export interface Tramo {
  /** Índice de la línea en el documento. */
  linea: number;
  /** Rango dentro de la línea, `hasta` exclusivo. */
  desde: number;
  hasta: number;
  /** Rango dentro de `plain`, `plainEnd` exclusivo. */
  plainStart: number;
  plainEnd: number;
}

export function textoParaCorregir(lineas: string[]): { plain: string; tramos: Tramo[] } {
  const tramos: Tramo[] = [];
  const partes: string[] = [];
  let plainLen = 0;
  let enComentario = false;
  for (let i = 0; i < lineas.length; i++) {
    const r = resaltar(lineas[i], enComentario);
    enComentario = r.enComentario;
    for (const s of r.spans) {
      if (s.clase !== 'texto') continue;
      const texto = lineas[i].slice(s.desde, s.hasta);
      if (partes.length > 0) plainLen += 2;
      partes.push(texto);
      tramos.push({
        linea: i,
        desde: s.desde,
        hasta: s.hasta,
        plainStart: plainLen,
        plainEnd: plainLen + texto.length,
      });
      plainLen += texto.length;
    }
  }
  return { plain: partes.join('\n\n'), tramos };
}
