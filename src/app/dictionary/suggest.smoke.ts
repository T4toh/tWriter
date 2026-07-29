/**
 * Runner standalone de los casos de `suggest.spec.ts`.
 * Correr con: `node --experimental-strip-types src/app/dictionary/suggest.smoke.ts`
 * (no requiere Karma ni deps npm; asserts con `node:assert`).
 */
import assert from 'node:assert';
import { suggestFromDictionary } from './suggest.ts';

const DICT = ['Kallai', 'Kállia', 'Bastien', 'Meridian', 'duende', 'Adi'];

const cases: Array<[string, string[], number | undefined, string[]]> = [
  ['Kallay', DICT, undefined, ['Kallai']],
  ['kallia', DICT, undefined, ['Kállia']],
  ['bastien', DICT, undefined, ['Bastien']],
  ['Kalliaa', DICT, 2, ['Kállia', 'Kallai']],
  ['Xdo', DICT, undefined, []],
  ['Meridiam', DICT, undefined, ['Meridian']],
  ['Meridiaan', DICT, undefined, ['Meridian']],
  ['zzzzqqqq', DICT, undefined, []],
  ['Bastien', DICT, undefined, []],
  ['Kalla', DICT, 1, ['Kallai']],
  ['Kallai', [], undefined, []],
  ['', DICT, undefined, []],
];

let passed = 0;
for (const [word, dict, max, expected] of cases) {
  const got = max === undefined ? suggestFromDictionary(word, dict) : suggestFromDictionary(word, dict, max);
  assert.deepStrictEqual(got, expected, `\n  word: ${word}\n  got:  ${JSON.stringify(got)}\n  exp:  ${JSON.stringify(expected)}`);
  passed++;
}
console.log(`suggestFromDictionary: ${passed}/${cases.length} ok`);
