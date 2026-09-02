/** Saca el prefijo numérico de orden (`"1 - Meridian"` → `"Meridian"`) que
 *  usan las carpetas de saga/libro/capítulo para ordenarse en el filesystem.
 *  Solo reconoce `-` como separador porque es lo único que la app escribe
 *  (`create.rs::format!("{} - {}", ...)` y el rename de book/saga-config-modal
 *  que preserva el prefijo). Un nombre que arranca con dígitos pero no tiene
 *  ese separador (`"2001 - Odisea"` sin más, o `"2001: Odisea"`) no matchea y
 *  se devuelve tal cual. Espejo de `strip_numeric_prefix` en `util.rs`. */
export function sinPrefijoNumerico(nombre: string): string {
  return nombre.replace(/^\d+\s*-\s*/, '');
}
