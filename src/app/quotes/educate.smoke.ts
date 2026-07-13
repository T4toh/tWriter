/**
 * Runner standalone para los casos de `educate.spec.ts`.
 * Correr con: `node --experimental-strip-types src/app/quotes/educate.smoke.ts`
 * (no requiere Karma ni deps npm; asserts con `node:assert`).
 */
import assert from 'node:assert';
import { educateQuotes } from './educate.ts';

const cases: Array<[string, string]> = [
  ['<p>"It\'s stupid…"</p>', '<p>“It’s stupid…”</p>'],
  ["The alternatives were 'tech' or 'thief'.", 'The alternatives were ‘tech’ or ‘thief’.'],
  ["You're the dogs' owner.", 'You’re the dogs’ owner.'],
  ['<p>"Hi"</p><hr class="scene-break"/><p>"Bye"</p>', '<p>“Hi”</p><hr class="scene-break"/><p>“Bye”</p>'],
  ['<p>He said <em>"go"</em> loudly.</p>', '<p>He said <em>“go”</em> loudly.</p>'],
  ["Back in the '90s.", 'Back in the ’90s.'],
  ["Get 'em all.", 'Get ’em all.'],
  ['<p>Nothing to fix here.</p>', '<p>Nothing to fix here.</p>'],
  ['<p>She smiled, "hello", and left.</p>', '<p>She smiled, “hello”, and left.</p>'],
];

let passed = 0;
for (const [input, expected] of cases) {
  const got = educateQuotes(input).text;
  assert.strictEqual(got, expected, `\n  in:  ${input}\n  got: ${got}\n  exp: ${expected}`);
  passed++;
}

// changes flag
assert.strictEqual(educateQuotes('<p>"x"</p>').changes, 1, 'changes debe ser 1');
assert.strictEqual(educateQuotes('<p>plain</p>').changes, 0, 'changes debe ser 0');

console.log(`✓ ${passed} casos OK + flags changes OK`);
