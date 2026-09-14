/** Formato de la fecha corta de la landing. Preferencia de Ajustes; en el
 *  `settings.json` va como `dateFormat`.
 *
 *  Dos familias y no un selector de locales, por pedido del autor: día-mes-año
 *  (la argentina, dos dígitos por campo) y año-mes-día (ISO, año completo
 *  para que no se confunda con la otra). Los tres campos salen de ancho fijo
 *  para que la columna alinee en `--font-mono` (`04/09/26`, no `4/9/26`).
 *
 *  Se arma a mano y no con `Intl` porque el locale del sistema no sirve: en la
 *  máquina del autor `LANG=en_GB.UTF-8` pero `LC_TIME=es_AR.UTF-8`, e `Intl`
 *  mira `navigator.language`, que sale de `LANG`. Con dos formatos fijos no
 *  hay locale que consultar. */
export type DateFormat = 'dmy' | 'ymd';

export const DATE_FORMATS: ReadonlyArray<DateFormat> = ['dmy', 'ymd'];
export const DATE_FORMAT_DEFAULT: DateFormat = 'dmy';

export const DATE_FORMAT_LABEL: Record<DateFormat, string> = {
  dmy: 'Día / mes / año',
  ymd: 'Año - mes - día',
};

export function isDateFormat(value: unknown): value is DateFormat {
  return value === 'dmy' || value === 'ymd';
}

export function formatFechaCorta(ms: number, formato: DateFormat): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return formato === 'ymd' ? `${yyyy}-${mm}-${dd}` : `${dd}/${mm}/${yyyy.slice(-2)}`;
}
