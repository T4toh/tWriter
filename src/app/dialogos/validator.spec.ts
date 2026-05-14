/**
 * Tests del validador RAE.
 *
 * No hay infraestructura Karma/Jasmine corriendo en el repo todavía (la entrada
 * `test` no está en angular.json). Cuando se sume, estos `describe/it` corren
 * tal cual con Karma + Jasmine. Mientras tanto, la lógica se valida vía el
 * runner standalone `validator.smoke.ts` (mismo conjunto de casos, asserts con
 * `node:assert`, compilable con `pnpm exec tsc` aislado).
 */
import { validateRae, htmlToPlain } from './validator';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  toContain: (expected: unknown) => void;
  toHaveLength: (n: number) => void;
};

describe('validateRae', () => {
  it('no marca un diálogo simple sin inciso', () => {
    const plain =
      '—Bastien va a completar tu morral más tarde. Te espero afuera, hermoso.';
    const v = validateRae(plain, 'es');
    expect(v).toHaveLength(0);
  });

  it('marca dash-orphan cuando hay verbo dicendi sin raya precedente', () => {
    const plain = '—Hola dijo Juan.';
    const v = validateRae(plain, 'es');
    expect(v.length).toBe(1);
    expect(v[0].ruleId).toBe('dash-orphan');
    expect(v[0].category).toBe('structure');
  });

  it('marca pending-conversion para diálogo con comillas y verbo dicendi', () => {
    const plain = '"Hola" dijo Juan.';
    const v = validateRae(plain, 'es');
    const pending = v.find((x) => x.ruleId === 'pending-conversion');
    expect(pending !== undefined).toBe(true);
    expect(pending!.autoFix?.replacement.includes('—Hola')).toBe(true);
  });

  it('marca dash-short cuando arranca con guion corto', () => {
    const plain = '-Hola, dijo.';
    const v = validateRae(plain, 'es');
    const short = v.find((x) => x.ruleId === 'dash-short');
    expect(short !== undefined).toBe(true);
    expect(short!.autoFix?.replacement).toBe('—');
  });

  it('marca paragraph-collapsed con 3+ diálogos pegados', () => {
    const plain = '—A. —B —dijo. —C. —D —preguntó. —E.';
    const v = validateRae(plain, 'es');
    const collapsed = v.find((x) => x.ruleId === 'paragraph-collapsed');
    expect(collapsed !== undefined).toBe(true);
  });

  it('exit early en inglés', () => {
    const plain = '"Hello," said John.';
    const v = validateRae(plain, 'en');
    expect(v).toHaveLength(0);
  });

  it('no marca cita interna válida con « »', () => {
    const plain = '—Me dijo «hola» al pasar.';
    const v = validateRae(plain, 'es');
    expect(v.length).toBe(0);
  });

  it('marca space-after-open con autoFix', () => {
    const plain = '— Texto del diálogo.';
    const v = validateRae(plain, 'es');
    const space = v.find((x) => x.ruleId === 'space-after-open');
    expect(space !== undefined).toBe(true);
    expect(space!.autoFix?.replacement).toBe('');
  });

  it('marca verb-capitalized con autoFix', () => {
    const plain = '—Hola —Dijo Juan.';
    const v = validateRae(plain, 'es');
    const cap = v.find((x) => x.ruleId === 'verb-capitalized');
    expect(cap !== undefined).toBe(true);
    expect(cap!.autoFix?.replacement).toBe('d');
  });

  it('marca period-before-verb con autoFix', () => {
    const plain = '—Hola. —dijo Juan.';
    const v = validateRae(plain, 'es');
    const period = v.find((x) => x.ruleId === 'period-before-verb');
    expect(period !== undefined).toBe(true);
  });

  it('separa por \\n\\n y produce offsets globales', () => {
    const plain = '—Primero.\n\n—Hola dijo Juan.';
    const v = validateRae(plain, 'es');
    const orphan = v.find((x) => x.ruleId === 'dash-orphan');
    expect(orphan !== undefined).toBe(true);
    expect(orphan!.offset > 10).toBe(true);
  });
});

describe('htmlToPlain', () => {
  it('separa <p> con \\n\\n', () => {
    const html = '<p>Uno</p><p>Dos</p>';
    expect(htmlToPlain(html)).toBe('Uno\n\nDos');
  });

  it('trata <br> como separador de párrafo', () => {
    const html = '<p>Uno<br>Dos</p>';
    expect(htmlToPlain(html)).toBe('Uno\n\nDos');
  });

  it('desnuda inline markup', () => {
    const html = '<p>Hola <em>mundo</em> <strong>cruel</strong></p>';
    expect(htmlToPlain(html)).toBe('Hola mundo cruel');
  });

  it('decodifica entidades comunes', () => {
    const html = '<p>foo &amp; bar &mdash; baz</p>';
    expect(htmlToPlain(html)).toBe('foo & bar — baz');
  });
});
