/**
 * Tests del educador de comillas tipográficas (inglés).
 *
 * Misma convención que `../dialogos/validator.spec.ts`: no hay Karma/Jasmine
 * corriendo todavía, así que `describe/it/expect` se declaran localmente y los
 * mismos casos se validan con el runner standalone `educate.smoke.ts`
 * (asserts con `node:assert`, corrido con `node --experimental-strip-types`).
 */
import { educateQuotes } from './educate';

declare const describe: (name: string, fn: () => void) => void;
declare const it: (name: string, fn: () => void) => void;
declare const expect: (actual: unknown) => {
  toBe: (expected: unknown) => void;
};

describe('educateQuotes', () => {
  it('comillas dobles de diálogo → curly', () => {
    const r = educateQuotes('<p>"It\'s stupid…"</p>');
    expect(r.text).toBe('<p>“It’s stupid…”</p>');
    expect(r.changes).toBe(1);
  });

  it('comilla simple de cita → curly', () => {
    const r = educateQuotes("The alternatives were 'tech' or 'thief'.");
    expect(r.text).toBe('The alternatives were ‘tech’ or ‘thief’.');
  });

  it('contracción y posesivo → apóstrofe ’', () => {
    const r = educateQuotes("You're the dogs' owner.");
    expect(r.text).toBe('You’re the dogs’ owner.');
  });

  it('no toca atributos de tags (scene-break intacto)', () => {
    const r = educateQuotes('<p>"Hi"</p><hr class="scene-break"/><p>"Bye"</p>');
    expect(r.text).toBe('<p>“Hi”</p><hr class="scene-break"/><p>“Bye”</p>');
  });

  it('inline tag transparente: apertura por char previo real', () => {
    const r = educateQuotes('<p>He said <em>"go"</em> loudly.</p>');
    expect(r.text).toBe('<p>He said <em>“go”</em> loudly.</p>');
  });

  it('décadas: elisión inicial → ’', () => {
    const r = educateQuotes("Back in the '90s.");
    expect(r.text).toBe('Back in the ’90s.');
  });

  it("elisión 'em → ’", () => {
    const r = educateQuotes("Get 'em all.");
    expect(r.text).toBe('Get ’em all.');
  });

  it('sin comillas rectas → changes 0, texto igual', () => {
    const r = educateQuotes('<p>Nothing to fix here.</p>');
    expect(r.text).toBe('<p>Nothing to fix here.</p>');
    expect(r.changes).toBe(0);
  });

  it('apertura tras coma+espacio dentro del párrafo', () => {
    const r = educateQuotes('<p>She smiled, "hello", and left.</p>');
    expect(r.text).toBe('<p>She smiled, “hello”, and left.</p>');
  });
});
