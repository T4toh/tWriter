/**
 * Tests de `suggest.ts` — candidatos del diccionario de la saga para un typo.
 *
 * Igual que `quotes/educate.spec.ts`: no hay Karma en el repo, así que los
 * casos viven acá y `scripts/run-suggest-smoke.mjs` los corre compilando a
 * CommonJS temporal (mismo patrón que `run-rae-smoke.mjs`).
 */
import { suggestFromDictionary } from './suggest';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toEqual: (expected: unknown) => void;
};

const DICT = ['Kallai', 'Kállia', 'Bastien', 'Meridian', 'duende', 'Adi'];

describe('suggestFromDictionary', () => {
  it('encuentra la palabra por una edición', () => {
    expect(suggestFromDictionary('Kallay', DICT)).toEqual(['Kallai']);
  });

  it('ignora acentos al comparar pero devuelve la palabra del diccionario', () => {
    expect(suggestFromDictionary('kallia', DICT)).toEqual(['Kállia']);
  });

  it('ignora mayúsculas', () => {
    expect(suggestFromDictionary('bastien', DICT)).toEqual(['Bastien']);
  });

  it('ordena por distancia y después alfabéticamente', () => {
    // 'Kallia' está a 1 de 'Kállia' (solo acento, que se pliega → distancia 0
    // tras el fold) y a 1 de 'Kallai' (transposición i/a). Empate → alfabético.
    expect(suggestFromDictionary('Kalliaa', DICT, 2)).toEqual(['Kállia', 'Kallai']);
  });

  it('no tolera 2 ediciones en palabras cortas', () => {
    // 'Adi' tiene 3 chars: umbral 1. 'Xdo' está a 2 → sin candidatos.
    expect(suggestFromDictionary('Xdo', DICT)).toEqual([]);
  });

  it('tolera 2 ediciones en palabras largas', () => {
    expect(suggestFromDictionary('Meridiam', DICT)).toEqual(['Meridian']);
    expect(suggestFromDictionary('Meridiaan', DICT)).toEqual(['Meridian']);
  });

  it('no devuelve nada cuando nada está cerca', () => {
    expect(suggestFromDictionary('zzzzqqqq', DICT)).toEqual([]);
  });

  it('excluye la palabra idéntica (ya está bien escrita)', () => {
    expect(suggestFromDictionary('Bastien', DICT)).toEqual([]);
  });

  it('respeta el máximo', () => {
    expect(suggestFromDictionary('Kalla', DICT, 1)).toEqual(['Kallai']);
  });

  it('tolera diccionario vacío y palabra vacía', () => {
    expect(suggestFromDictionary('Kallai', [])).toEqual([]);
    expect(suggestFromDictionary('', DICT)).toEqual([]);
  });
});
