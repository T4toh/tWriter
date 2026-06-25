/**
 * Tests del matching client-side de búsqueda (`search-highlight.ts`).
 *
 * Igual que `dialogos/validator.spec.ts`: no hay Karma/Jasmine corriendo aún
 * (no está la entrada `test` en angular.json). Estos `describe/it` corren tal
 * cual cuando se sume. Se cubren sólo las funciones puras (sin DOM):
 * `foldAccents` y `findAllMatchesInPlain`. `highlightFirstMatch` depende del DOM
 * (TreeWalker/Range/Selection) y se valida vía el E2E manual.
 *
 * Invariante clave testeado: el fold es LENGTH-PRESERVING, así que un match
 * accent-insensitive devuelve rangos que, sliceados sobre el texto ORIGINAL,
 * recuperan el substring con tilde tal cual aparece — sin desfasar offsets.
 */
import { foldAccents, findAllMatchesInPlain } from './search-highlight';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
  toHaveLength: (n: number) => void;
};

describe('foldAccents', () => {
  it('pliega vocales acentuadas a su base', () => {
    expect(foldAccents('Mansión')).toBe('Mansion');
    expect(foldAccents('camión corazón')).toBe('camion corazon');
    expect(foldAccents('ÁÉÍÓÚ')).toBe('AEIOU');
  });

  it('preserva ñ/Ñ (año ≠ ano)', () => {
    expect(foldAccents('año')).toBe('año');
    expect(foldAccents('niño')).toBe('niño');
  });

  it('es length-preserving (1 code unit → 1)', () => {
    for (const s of ['áéíóúü', 'Mansión', 'señor', 'corazón']) {
      expect(foldAccents(s).length).toBe(s.length);
    }
  });
});

describe('findAllMatchesInPlain', () => {
  // `fold=true` ⇒ modo fuzzy (accent-insensitive). Omitido / false ⇒ exacto.
  it('exacto (default): accent-sensitive, mansion ≠ mansión', () => {
    const plain = 'la mansión encantada';
    // Sin fold, "mansion" NO debe encontrar "mansión" — esto es lo que permite
    // ubicar el typo literal al corregir errores.
    expect(findAllMatchesInPlain(plain, ['mansion'], 'mansion')).toHaveLength(0);
    // El literal exacto sí.
    const hits = findAllMatchesInPlain(plain, ['mansión'], 'mansión');
    expect(hits).toHaveLength(1);
    expect(plain.slice(hits[0].start, hits[0].end)).toBe('mansión');
  });

  it('fuzzy (fold): matchea sin tilde sobre texto con tilde y marca el original', () => {
    const plain = 'la mansión encantada';
    const hits = findAllMatchesInPlain(plain, ['mansion'], 'mansion', true);
    expect(hits).toHaveLength(1);
    // El rango sliceado sobre el original recupera "mansión" (con tilde).
    expect(plain.slice(hits[0].start, hits[0].end)).toBe('mansión');
  });

  it('fuzzy (fold): matchea con tilde sobre texto sin tilde', () => {
    const plain = 'la mansion encantada';
    const hits = findAllMatchesInPlain(plain, ['mansión'], 'mansión', true);
    expect(hits).toHaveLength(1);
    expect(plain.slice(hits[0].start, hits[0].end)).toBe('mansion');
  });

  it('fuzzy (fold): NO confunde ñ con n (ano ≠ año)', () => {
    const hits = findAllMatchesInPlain('cumplió un año más', ['ano'], 'ano', true);
    expect(hits).toHaveLength(0);
  });

  it('fuzzy (fold): mantiene offsets alineados tras chars acentuados', () => {
    const plain = 'corazón roto en la canción final';
    const hits = findAllMatchesInPlain(plain, ['cancion'], 'cancion', true);
    expect(hits).toHaveLength(1);
    expect(plain.slice(hits[0].start, hits[0].end)).toBe('canción');
  });
});
