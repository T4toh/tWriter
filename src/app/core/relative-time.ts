/**
 * Tiempo relativo en español, compacto, para tooltips/listas.
 * Devuelve `''` si `ms` es falsy o inválido.
 */
export function formatRelativeTime(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const now = Date.now();
  const delta = Math.max(0, now - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'recién';
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'ayer';
  if (day < 7) return `hace ${day} d`;
  if (day < 30) {
    const wk = Math.floor(day / 7);
    return `hace ${wk} sem`;
  }
  if (day < 365) {
    const mo = Math.floor(day / 30);
    return `hace ${mo} mes${mo === 1 ? '' : 'es'}`;
  }
  const yr = Math.floor(day / 365);
  return `hace ${yr} año${yr === 1 ? '' : 's'}`;
}

/** Timestamp absoluto local en formato `YYYY-MM-DD HH:mm`. */
export function formatAbsoluteTime(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
