import { Pipe, PipeTransform, inject } from '@angular/core';
import { SettingsService } from '../core/settings-service';
import { formatFechaCorta } from './fecha-corta';

/**
 * Fecha de última edición, corta y sin hora, en el formato elegido en Ajustes.
 *
 * **`pure: false` a propósito**: el formato viene de un signal y un pipe puro
 * cachea por argumento, así que no se enteraría del cambio hasta que cambie
 * el `ms`. Es barato — un `Date` y tres `padStart` por tarjeta.
 *
 * **Por qué no `DatePipe` con `shortDate`**, que es lo primero que uno prueba:
 * `DatePipe` no usa `Intl`, usa los datos CLDR propios de Angular, y solo los
 * de los locales que se hayan registrado con `registerLocaleData`. Sin
 * registrar nada, `LOCALE_ID` es `en-US` y las fechas salen con el mes primero
 * (`9/5/26` en vez de `5/9/26`); y ponerle `navigator.language` sin registrar
 * ese locale tira «Missing locale data» en runtime.
 *
 * Reemplaza a `formatDate`, que estaba copiada en las cuatro tarjetas de la
 * landing y además era relativa («hace 2 d», «hace 5 meses»): ocupaba mucho en
 * la columna más apretada y en una biblioteca la fecha se escanea, no se lee.
 */
@Pipe({ name: 'fechaCorta', pure: false })
export class FechaCortaPipe implements PipeTransform {
  private settings = inject(SettingsService);

  transform(ms: number | null | undefined): string {
    if (!ms) return 'sin editar';
    return formatFechaCorta(ms, this.settings.dateFormat());
  }
}
