import { Pipe, PipeTransform } from '@angular/core';

/** Día/mes/año, fijo en `es-AR`, con los tres campos de ancho constante para
 *  que la columna alinee en `--font-mono` (`04/09/26`, no `4/9/26`).
 *
 *  Fijo y NO el locale del sistema, aunque fue lo primero que se probó: en la
 *  máquina del autor `LANG=en_GB.UTF-8` pero `LC_TIME=es_AR.UTF-8` — el idioma
 *  en inglés y las fechas en argentino. `Intl` mira `navigator.language`, que
 *  sale de `LANG`, así que seguir al sistema daba formato británico justo en el
 *  dato donde el sistema decía otra cosa. Configurable en Ajustes es lo que
 *  corresponde; hasta entonces el default es el del autor. Ver TODO.
 *
 *  Se arma una sola vez: construir un `Intl.DateTimeFormat` es caro y esto
 *  corre por cada tarjeta de la grilla. */
const CORTA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
});

/**
 * Fecha de última edición, corta y sin hora.
 *
 * **Por qué no `DatePipe` con `shortDate`**, que es lo primero que uno prueba:
 * `DatePipe` no usa `Intl`, usa los datos CLDR propios de Angular, y solo los
 * de los locales que se hayan registrado con `registerLocaleData`. Sin
 * registrar nada, `LOCALE_ID` es `en-US` y las fechas salen con el mes primero
 * (`9/5/26` en vez de `5/9/26`); y ponerle `navigator.language` sin registrar
 * ese locale tira «Missing locale data» en runtime. Seguir al sistema con
 * `DatePipe` obliga a registrar todos los locales o a mantener una lista fija
 * con fallback. `Intl` los trae todos y sigue al OS sin configurar nada.
 *
 * Reemplaza a `formatDate`, que estaba copiada en las cuatro tarjetas de la
 * landing y además era relativa («hace 2 d», «hace 5 meses»): ocupaba mucho en
 * la columna más apretada y en una biblioteca la fecha se escanea, no se lee.
 */
@Pipe({ name: 'fechaCorta' })
export class FechaCortaPipe implements PipeTransform {
  transform(ms: number | null | undefined): string {
    if (!ms) return 'sin editar';
    return CORTA.format(ms);
  }
}
