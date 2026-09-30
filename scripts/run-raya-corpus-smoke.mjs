#!/usr/bin/env node
// Corpus de diálogos contra convert() + validateRae() + autoFix. La norma es
// el DPD «raya» 2.ª ed. (https://www.rae.es/dpd/raya), secciones 2.1, 2.3a-f,
// 2.4, 3.1, 3.2 y 3.4; la sección va en cada caso.
//
// Cada caso: [familia, input, esperado, sección, idioma?]. esperado null ⇒ el
// texto ya es correcto: convert() no lo toca y el validador no dice nada.
// esperado { marca } ⇒ el error no tiene un arreglo único: el validador tiene
// que marcarlo con esa regla y nada lo cambia en bloque (puede traer un
// arreglo `manual`, de a uno desde el popover).
// Si no, lo que el autor obtiene (convert + todos los autoFix) tiene que
// quedar igual al esperado. Siempre, para todos: no se pierden letras ni
// suspensivos, y convert() es idempotente.
//
// PENDIENTES lista los casos que todavía fallan, con el arreglo en TODO.md
// (Validador RAE → Revisión a fondo). Fallan sin cortar la corrida; si uno
// empieza a pasar, la corrida sí corta para que se lo saque de la lista.
// Uso: node scripts/run-raya-corpus-smoke.mjs [--all]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = mkdtempSync(join(tmpdir(), 'raya-corpus-'));
const r = spawnSync(join(repo, 'node_modules/.bin/tsc'), [
  '--target', 'es2022', '--ignoreConfig', '--module', 'commonjs', '--strict', '--skipLibCheck',
  '--outDir', out,
  'src/app/dialogos/validator.ts', 'src/app/dialogos/rules-dedicated.ts', 'src/app/dialogos/converter.ts',
  'src/app/dialogos/tags.ts', 'src/app/dialogos/aplicar-fixes.ts', 'src/app/core/types.ts',
], { cwd: repo, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
const req = createRequire(import.meta.url);
const { convert } = req(join(out, 'dialogos/converter.js'));
const { validateRae, htmlToPlain } = req(join(out, 'dialogos/validator.js'));
const { aplicarFixesHtml } = req(join(out, 'dialogos/aplicar-fixes.js'));
rmSync(out, { recursive: true, force: true });

const C = [
  // 1. Sustitutos de raya
  [1, '--Hola, Roberto. --sus manos temblaban por el miedo.', '—Hola, Roberto. —Sus manos temblaban por el miedo.', '2.3d'],
  [1, '--Hola --dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [1, '-Hola -dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [1, '–Hola –dijo Juan–. ¿Venís?', '—Hola —dijo Juan—. ¿Venís?', '2.3b'],
  [1, '―Hola ―dijo Juan.', '—Hola —dijo Juan.', '3.1 (U+2015)'],
  [1, '−Hola −dijo Juan.', '—Hola —dijo Juan.', '3.1 (U+2212)'],
  [1, '-- Hola -- dijo Juan.', '—Hola —dijo Juan.', '3.1/2'],
  [1, '- ¿Venís? - preguntó Ana.', '—¿Venís? —preguntó Ana.', '3.1/2.3c'],
  [1, '—Hola -dijo Juan-. ¿Venís?', '—Hola —dijo Juan—. ¿Venís?', '2.3b'],
  [1, '—No sé --murmuró Pedro-- si voy a poder.', '—No sé —murmuró Pedro— si voy a poder.', '2.3e'],
  [1, '--¿Qué hacés acá? --preguntó.', '—¿Qué hacés acá? —preguntó.', '2.3c'],
  [1, '―¡Vení! ―gritó Ana―. Ya es tarde.', '—¡Vení! —gritó Ana—. Ya es tarde.', '2.3b'],
  [1, '-- ¡Basta! --Pedro golpeó la mesa.', '—¡Basta! —Pedro golpeó la mesa.', '2.3d'],
  [1, '–Andate –le dijo.', '—Andate —le dijo.', '2.3c'],
  [1, '--Mañana --dijo-- vamos al río.', '—Mañana —dijo— vamos al río.', '2.3e'],
  [1, '−¿Vos acá? −preguntó Ana−. No te esperaba.', '—¿Vos acá? —preguntó Ana—. No te esperaba.', '2.3b'],
  // 2. Espaciado
  [2, '— Hola —dijo Juan.', '—Hola —dijo Juan.', '3.1'],
  [2, '—Hola—dijo Juan.', '—Hola —dijo Juan.', '2'],
  [2, '—Hola —dijo Juan —. ¿Venís?', '—Hola —dijo Juan—. ¿Venís?', '2'],
  [2, '—Hola —dijo Juan— . ¿Venís?', '—Hola —dijo Juan—. ¿Venís?', '2'],
  [2, '—Hola  —dijo  Juan.', '—Hola —dijo Juan.', '2'],
  [2, '—No sé— dijo Pedro.', '—No sé —dijo Pedro.', '2'],
  [2, '—Mañana —dijo Ana—vamos al río.', '—Mañana —dijo Ana— vamos al río.', '2'],
  [2, '—  ¿Venís? — preguntó.', '—¿Venís? —preguntó.', '3.1/2'],
  [2, '—¡Qué frío!—exclamó Ana.', '—¡Qué frío! —exclamó Ana.', '2'],
  [2, '—Vení acá —le dijo— , que te quiero ver.', '—Vení acá —le dijo—, que te quiero ver.', '2'],
  [2, '—Hola —masculló Pedro—vení.', '—Hola —masculló Pedro— vení.', '2'],
  // 3. Mayúsculas
  [3, '—¿Venís? —Preguntó Ana.', '—¿Venís? —preguntó Ana.', '2.3c'],
  [3, '—¡Qué le vamos a hacer! —Exclamó resignada doña Patro.', '—¡Qué le vamos a hacer! —exclamó resignada doña Patro.', '2.3c'],
  [3, '—Hola —Dijo Juan.', '—Hola —dijo Juan.', '2.3c'],
  [3, '—Hola. —Dijo Juan.', '—Hola —dijo Juan.', '2.3c'],
  [3, '—No se moleste. —cerró la puerta y salió de mala gana.', '—No se moleste. —Cerró la puerta y salió de mala gana.', '2.3d'],
  [3, '—Me voy ya. —se puso en pie con gesto decidido—. No hace falta que me acompañe.', '—Me voy ya. —Se puso en pie con gesto decidido—. No hace falta que me acompañe.', '2.3d'],
  [3, '—No se moleste —cerró la puerta y salió.', '—No se moleste. —Cerró la puerta y salió.', '2.3d'],
  [3, '—¡Esto que has hecho —Gritó— es una locura!', '—¡Esto que has hecho —gritó— es una locura!', '2.3e'],
  [3, '—Solo nos queda esto —Le enseñó unos billetes— para el viaje.', '—Solo nos queda esto —le enseñó unos billetes— para el viaje.', '2.3e'],
  [3, '—¿Me escuchás? —Masculló Pedro.', '—¿Me escuchás? —masculló Pedro.', '2.3c'],
  [3, '—Tranquilo, che. —Advirtió el comisario.', '—Tranquilo, che —advirtió el comisario.', '2.3c'],
  [3, '—Hola, Roberto. —sus manos temblaban por el miedo.', '—Hola, Roberto. —Sus manos temblaban por el miedo.', '2.3d'],
  [3, '—Andá vos —Dijo, y cerró la puerta.', '—Andá vos —dijo, y cerró la puerta.', '2.3c'],
  [3, '—No me jodas. —Le contestó sin mirarla.', '—No me jodas —le contestó sin mirarla.', '2.3c'],
  // 4. Puntuación
  [4, '—Hola. —dijo Juan.', '—Hola —dijo Juan.', '2.3c'],
  [4, '—Hola, —dijo Juan.', '—Hola —dijo Juan.', '2.3c'],
  [4, '—Está bien —dijo Carlos;— lo haré.', '—Está bien —dijo Carlos—; lo haré.', '2.3c'],
  [4, '—Está bien —dijo Carlos,— lo haré.', '—Está bien —dijo Carlos—, lo haré.', '2.3c'],
  [4, '—Está bien —dijo Carlos.— Lo haré.', '—Está bien —dijo Carlos—. Lo haré.', '2.3c'],
  [4, '—Hola —dijo Juan—.', '—Hola —dijo Juan.', '2.3a'],
  [4, '—Espero que todo salga bien —dijo Azucena con gesto ilusionado—.', '—Espero que todo salga bien —dijo Azucena con gesto ilusionado.', '2.3a'],
  // 2.3b sin raya de cierre: se escribe igual que un 2.3a con narración que
  // sigue (`—Hola —dijo Juan. Luego se fue.`). No se marca.
  [4, '—Lo principal es sentirse viva —añadió Pilar. Afortunada o desafortunada, pero viva.', null, '2.3b/2.3a indistinguibles'],
  [4, '—Hola —dijo Juan. —¿Venís mañana?', { marca: 'closing-dash' }, '2.3b u otro hablante: sin arreglo'],
  [4, '—No sé —dijo Pedro, —capaz mañana.', '—No sé —dijo Pedro—, capaz mañana.', '2.3c'],
  [4, '—Anoche estuve en una fiesta —me confesó, y añadió:— Conocí gente.', '—Anoche estuve en una fiesta —me confesó, y añadió—: Conocí gente.', '2.3f'],
  [4, '—Anoche estuve en una fiesta —me confesó, y añadió: —Conocí gente.', '—Anoche estuve en una fiesta —me confesó, y añadió—: Conocí gente.', '2.3f'],
  // Dos puntos: tres (suspensivos) o uno, y cuál quiso el autor no se sabe.
  // Se marca y se deja como está.
  [4, '—Ya voy.. —dijo Ana.', { marca: 'double-period' }, 'puntos'],
  [4, '—No sé.. Capaz mañana.', { marca: 'double-period' }, 'puntos'],
  [4, 'Se quedó mirando la puerta.... Nadie vino.', { marca: 'double-period' }, 'puntos'],
  [6, '—No sé... Capaz mañana.', null, 'suspensivos'],
  [6, 'Compró harina, azúcar, huevos, etc.... Y se olvidó la leche.', null, 'susp. tras abreviatura (DPD susp. 3.1)'],
  [6, 'Está en la pág.... no me acuerdo cuál.', null, 'susp. tras abreviatura'],
  [4, 'Se olvidó la leche, etc..', { marca: 'double-period' }, 'abreviatura + punto'],
  [4, '—¿Venís?. —preguntó Ana.', '—¿Venís? —preguntó Ana.', '2.3c'],
  [4, '—¡Andate!. —gritó.', '—¡Andate! —gritó.', '2.3c'],
  [4, '—Bueno... —dijo Ana—. Vamos.', '—Bueno... —dijo Ana—. Vamos.', '2.3c (susp. quedan)'],
  [4, '—Bueno… —dijo Ana. Vamos.', null, '2.3b/2.3a indistinguibles'],
  [4, '—No se moleste —cerró la puerta—. No hace falta.', '—No se moleste. —Cerró la puerta—. No hace falta.', '2.3d'],
  // 5. Comillas en vez de raya
  [5, '"Hola", dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [5, '"Hola," dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [5, '“Hola”, dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [5, '«Hola», dijo Juan.', '—Hola —dijo Juan.', '3.1/2.3a'],
  [5, '"Vení", le dijo Ana.', '—Vení —le dijo Ana.', '2.3c'],
  [5, '"¿Qué hora es?", me preguntó.', '—¿Qué hora es? —me preguntó.', '2.3c'],
  [5, '"No sé", Juan dijo.', '—No sé —Juan dijo.', '2.3a'],
  [5, '"Callate", masculló Pedro.', '—Callate —masculló Pedro.', '2.3c'],
  [5, '"Cuidado", advirtió el comisario.', '—Cuidado —advirtió el comisario.', '2.3c'],
  [5, '"Andate", espetó ella.', '—Andate —espetó ella.', '2.3c'],
  [5, '"No quiero", susurraba la nena.', '—No quiero —susurraba la nena.', '2.3c'],
  [5, '"Siempre lo mismo", decía mi abuela.', '—Siempre lo mismo —decía mi abuela.', '2.3c'],
  [5, '"Ya voy", contestaba sin mirar.', '—Ya voy —contestaba sin mirar.', '2.3c'],
  [5, '"Hijo de puta", dijo entre dientes.', '—Hijo de puta —dijo entre dientes.', '2.3c'],
  [5, '"Te lo dije", volvió a decir Ana.', '—Te lo dije —volvió a decir Ana.', '2.3c'],
  [5, '"Pasá", díjole el viejo.', '—Pasá —díjole el viejo.', '2.3c'],
  [5, '"Está bien", dijo Carlos, "lo haré".', '—Está bien —dijo Carlos—, lo haré.', '2.3c'],
  [5, '"Esto que hiciste", gritó, "es una locura".', '—Esto que hiciste —gritó— es una locura.', '2.3e (ambiguo)'],
  [5, '"Hola." Cerró la puerta. "Chau."', '—Hola. —Cerró la puerta—. Chau.', '2.3d'],
  [5, '"No se moleste". Cerró la puerta y salió.', '—No se moleste. —Cerró la puerta y salió.', '2.3d'],
  [5, '"¿Venís?" Preguntó Ana.', '—¿Venís? —preguntó Ana.', '2.3c'],
  [5, '"Hola", dijo Juan. "¿Cómo estás?"', '—Hola —dijo Juan—. ¿Cómo estás?', '2.3b'],
  [5, '"Hola...", dijo Ana.', '—Hola... —dijo Ana.', '2.3c'],
  [5, '"Hola…", dijo Ana.', '—Hola… —dijo Ana.', '2.3c'],
  [5, '"Bueno...", dijo Ana. "Vamos."', '—Bueno... —dijo Ana—. Vamos.', '2.3b'],
  [5, '"Vení", dijo. "Te tengo que contar algo", agregó.', '—Vení —dijo—. Te tengo que contar algo —agregó.', '2.3b'],
  [5, "'Hola', dijo Juan.", '—Hola —dijo Juan.', '3.1'],
  [5, '"Dale", respondió Ana sonriendo.', '—Dale —respondió Ana sonriendo.', '2.3c'],
  [5, '"Vení", me pidió. "Sentate acá."', '—Vení —me pidió—. Sentate acá.', '2.3b'],
  // aisladores: separan la causa (coma fuera de comillas / pronombre / verbo fuera de lista / &nbsp;)
  [5, '"Hola," le dijo Ana.', '—Hola —le dijo Ana.', '2.3c (pronombre)'],
  [5, '"Hola," masculló Pedro.', '—Hola —masculló Pedro.', '2.3c (verbo fuera de lista)'],
  [5, '"¿Venís?" preguntó Ana.', '—¿Venís? —preguntó Ana.', '2.3c'],
  [5, '"Hola..." dijo Ana.', '—Hola... —dijo Ana.', '2.3c (susp.)'],
  [5, '"Hola." dijo Ana.', '—Hola —dijo Ana.', '2.3c'],
  [7, '<p>"Hola,"&nbsp;dijo Ana.</p>', '<p>—Hola —dijo Ana.</p>', 'html (&nbsp; aislado)'],
  [7, '<p>"Hola," dijo <em>Juan</em>.</p>', '<p>—Hola —dijo <em>Juan</em>.</p>', 'html (em, coma adentro)'],
  // 8. Punto/cierre + raya + caja del inciso. DPD manda UNO solo: dicendi →
  // sin punto y minúscula (2.3c); no-dicendi tras enunciado completo → punto
  // y mayúscula (2.3d); inciso a mitad de enunciado → minúscula (2.3e).
  [8, '—Hola, Roberto. —dijo Juan.', '—Hola, Roberto —dijo Juan.', '2.3c'],
  [8, '—Hola, Roberto. —le dijo Ana.', '—Hola, Roberto —le dijo Ana.', '2.3c'],
  [8, '—Hola, Roberto. —masculló Ana.', '—Hola, Roberto —masculló Ana.', '2.3c'],
  [8, '--Hola, Roberto. --dijo Juan.', '—Hola, Roberto —dijo Juan.', '2.3c'],
  [8, '—Hola, Roberto. —sus manos temblaban por el miedo.', '—Hola, Roberto. —Sus manos temblaban por el miedo.', '2.3d'],
  [8, '—Hola, Roberto. —se levantó y salió.', '—Hola, Roberto. —Se levantó y salió.', '2.3d'],
  [8, '—Hola, Roberto. —sus manos temblaban—. ¿Cómo estás?', '—Hola, Roberto. —Sus manos temblaban—. ¿Cómo estás?', '2.3d'],
  [8, '—¿Venís? —sus ojos brillaban.', '—¿Venís? —Sus ojos brillaban.', '2.3d'],
  [8, '—¡Basta! —golpeó la mesa.', '—¡Basta! —Golpeó la mesa.', '2.3d'],
  [8, '"Hola, Roberto." sus manos temblaban.', '—Hola, Roberto. —Sus manos temblaban.', '2.3d'],
  [8, '<p>—Hola, Roberto. —sus manos temblaban.</p>', '<p>—Hola, Roberto. —Sus manos temblaban.</p>', '2.3d html'],
  [8, '—Hola —Sus manos temblaban por el miedo.', '—Hola. —Sus manos temblaban por el miedo.', '2.3d (sin punto)'],
  [8, '—Hola —Se levantó y salió.', '—Hola. —Se levantó y salió.', '2.3d (sin punto)'],
  [8, '—Hola, Roberto —Sus manos temblaban—. ¿Cómo estás?', '—Hola, Roberto. —Sus manos temblaban—. ¿Cómo estás?', '2.3d (sin punto)'],
  [8, '—Hola —sus manos temblaban.', '—Hola. —Sus manos temblaban.', '2.3d (sin punto, minúscula)'],
  [8, '—Solo nos queda esto. —le enseñó unos billetes— para el viaje.', '—Solo nos queda esto —le enseñó unos billetes— para el viaje.', '2.3e'],
  [8, '—Solo nos queda esto —Le enseñó unos billetes— para el viaje.', '—Solo nos queda esto —le enseñó unos billetes— para el viaje.', '2.3e'],
  [8, '—Esto que hiciste —Gritó— es una locura.', '—Esto que hiciste —gritó— es una locura.', '2.3e'],
  // 6. Falsos positivos (esperado === input)
  [6, 'Juan —el vecino del quinto— llegó tarde.', null, '2.1'],
  [6, 'Esperaba a Emilio —un gran amigo—. Lamentablemente, no vino.', null, '2.1'],
  // Un ítem en mayúscula (3.2c, `— La entonación…`) no se distingue de un
  // diálogo con espacio de más: solo los de minúscula (3.2a/b) son seguros.
  [6, '— expresiva,', null, '3.2a'],
  [6, '— no refugiarse debajo de un árbol;', null, '3.2b'],
  [6, 'El acuerdo franco-alemán se firmó ayer.', null, 'guion'],
  [6, 'Vivió en Rosario entre 1990-2000.', null, 'guion'],
  [6, 'La temperatura bajó a -5 grados.', null, 'guion'],
  [6, '-5 grados hacía esa mañana.', null, 'guion'],
  [6, '«¿Y si no vuelve?», pensó Ana.', null, 'comillas (pensamiento)'],
  [6, 'Ana pensó: «Esto no va a terminar bien».', null, 'comillas'],
  [6, '—Me dijo «andate» y se fue.', null, 'cita interna'],
  [6, '—El cartel decía «Prohibido pasar» —dijo Juan.', null, 'cita interna'],
  [6, 'María.— ¿Dónde vas?', null, '3.4'],
  [6, '"Hello," she said. "Come in."', null, 'inglés', 'en'],
  [6, '—¿Cuándo volverás?', null, '3.1'],
  [6, '—No se moleste. —Cerró la puerta y salió de mala gana.', null, '2.3d'],
  [6, '—Está bien —dijo Carlos—; lo haré, pero que sea la última vez que me lo pides.', null, '2.3c'],
  [6, '—Anoche estuve en una fiesta —me confesó, y añadió—: Conocí a personas muy interesantes.', null, '2.3f'],
  [6, '—Solo nos queda esto —le enseñó unos pocos billetes— para el resto del viaje.', null, '2.3e'],
  [6, '—Me voy ya. —Se puso en pie con gesto decidido—. No hace falta que me acompañe.', null, '2.3d'],
  [6, '—¡Qué le vamos a hacer! —exclamó resignada doña Patro.', null, '2.3c'],
  [6, '—Dicen que la casa está embrujada.', null, '3.1'],
  [6, 'Me dijo que no. Dijo que mañana.', null, 'narración'],
  [6, 'El «sí» de ella lo cambió todo.', null, 'comillas'],
  [6, "—Escuchaba rock'n'roll todo el día —dijo Ana.", null, 'apóstrofo'],
  [6, '—¿Venís? —preguntó Ana—. Dale, que se hace tarde.', null, '2.3b'],
  [6, '—Hola —dijo Juan.', null, '2.3a'],
  [6, '«Es imprescindible —señaló el ministro— que se refuercen los controles».', null, '2.4'],
  [6, 'Le dijo «te quiero» y ella dijo «yo también».', null, 'comillas'],
  // 7. HTML del editor
  [7, '<p>"Hola", dijo <em>Juan</em>.</p><p>"¿Venís?", preguntó Ana.</p>', '<p>—Hola —dijo <em>Juan</em>.</p><p>—¿Venís? —preguntó Ana.</p>', 'html'],
  [7, '<p><em>"Vení"</em>, dijo ella.</p>', '<p><em>—Vení</em> —dijo ella.</p>', 'html (em)'],
  [7, '<p>"Tom &amp; Jerry", dijo&nbsp;Ana.</p>', '<p>—Tom &amp; Jerry —dijo&nbsp;Ana.</p>', 'html (&amp; &nbsp;)'],
  [7, '<p>"Hola",&nbsp;dijo Ana.</p>', '<p>—Hola —dijo Ana.</p>', 'html (&nbsp; antes del verbo)'],
  [7, '<p>--Hola, Roberto. --sus manos temblaban.</p>', '<p>—Hola, Roberto. —Sus manos temblaban.</p>', 'html 2.3d'],
  [7, '<p>"Hola", dijo Juan. "<strong>Ahora</strong> vení."</p>', '<p>—Hola —dijo Juan—. <strong>Ahora</strong> vení.</p>', 'html 2.3b'],
  [7, '<p>"Hola", dijo Juan.</p>\n<p>Ana no contestó.</p>', '<p>—Hola —dijo Juan.</p>\n<p>Ana no contestó.</p>', 'html multi-p'],
  [7, '<p class="x">"Chau", dijo.</p>', '<p class="x">—Chau —dijo.</p>', 'html attrs'],
  [7, '<h1 class="chapter-title">Capítulo 1</h1><p>"Hola", dijo Juan.</p>', '<h1 class="chapter-title">Capítulo 1</h1><p>—Hola —dijo Juan.</p>', 'html h1'],
  [7, '<p>—Hola —dijo Juan.</p><hr class="scene-break"/><p>"Chau", dijo Ana.</p>', '<p>—Hola —dijo Juan.</p><hr class="scene-break"/><p>—Chau —dijo Ana.</p>', 'html hr'],
  [7, '<p>—Hola —Dijo <em>Juan</em>.</p>', '<p>—Hola —dijo <em>Juan</em>.</p>', 'html 2.3c'],
  [7, '<p><em>«¿Y si no vuelve?»</em>, pensó Ana.</p>', null, 'html pensamiento'],
  [7, '<blockquote><p>"Canción de cuna"</p></blockquote>', null, 'html verso'],
  [7, '"Hola", dijo Juan.\n\n"Chau", dijo Ana.', '—Hola —dijo Juan.\n\n—Chau —dijo Ana.', 'plano multi-p'],
  // 9. Texto correcto que el converter rompía (revisión del 2026-09-29)
  [9, '—Me dijo «Vete» y se fue.', null, '§4 cita interna'],
  [9, '—Vamos —dijo Juan, y leyó el cartel "Peligro".', null, '§4 cita interna'],
  [9, '"Me dijo «vete» y se fue" dijo Juan.', '—Me dijo «vete» y se fue —dijo Juan.', '2.3c + cita interna'],
  [9, '<p>Leyó «la carta» de O’Brien.</p><p>"Hola" dijo Juan.</p>', '<p>Leyó «la carta» de O’Brien.</p><p>—Hola —dijo Juan.</p>', 'comillas de otro párrafo'],
  [9, '<h1 class="chapter-title">«Uno»</h1><p>"Hola" dijo Juan.</p>', '<h1 class="chapter-title">«Uno»</h1><p>—Hola —dijo Juan.</p>', 'comillas del título'],
  [9, '"¿Qué es «eso»?" preguntó Ana.', '—¿Qué es «eso»? —preguntó Ana.', 'cita interna en línea convertida'],
  [9, '—Fuimos a Anar\'s y luego a Bob\'s casa —dijo.', null, 'apóstrofo'],
  [9, 'La palabra "fin" dice mucho.', null, 'comillas en narración'],
  [9, 'El cartel "Cerrado" indica que no hay nadie.', null, 'comillas en narración'],
  [9, 'Escribió "Libertad". Luego se fue.', null, 'comillas en narración'],
  [9, '—No se moleste. —Negó con la cabeza.', null, '2.3d'],
  [9, '—Mirá. —Señaló la puerta.', null, '2.3d'],
  [9, '—Me voy. —Pidió la cuenta y salió.', null, '2.3d'],
  [9, '"Yo..." murmuró.', '—Yo... —murmuró.', '2.3c (susp.)'],
  [9, '"Yo..." dijo Juan, "vamos."', '—Yo... —dijo Juan—, vamos.', '2.3c (susp.)'],
  [9, '"Yo..." dijo Juan. "Bah."', '—Yo... —dijo Juan—. Bah.', '2.3b (susp.)'],
  [9, '—Yo... —murmuró.', null, '2.3c (susp.)'],
  // 10. Guiones que no son raya, verbos y pronombres (PR de coma y verbos)
  [10, '—Vive en el 3-B desde 1990–2000 —dijo Ana.', null, 'guion y semirraya de rango'],
  [10, '—Hacía −5 grados —dijo Ana.', null, 'signo menos'],
  [10, '—Es un acuerdo franco-alemán —dijo.', null, 'guion de palabra'],
  [10, '- harina,', null, 'lista con guion (3.2a)'],
  [10, '—¿Venís? —le preguntó Ana.', null, '2.3c pronombre'],
  [10, '"Vení." María dice que no.', '—Vení. —María dice que no.', '2.3d'],
  [10, '"Hola", le dijo Juan a Ana.', '—Hola —le dijo Juan a Ana.', '2.3c pronombre'],
  [10, '"Mañana", dije. "Hoy no puedo".', '—Mañana —dije—. Hoy no puedo.', '2.3b primera persona'],
  [10, '"No", repitió. "No quiero", insistió.', '—No —repitió—. No quiero —insistió.', '2.3b + verbo del segundo parlamento'],
  [10, '—Hola -- le dijo Juan.', '—Hola —le dijo Juan.', 'sustituto + pronombre'],
  // 11. Caja del inciso y raya de cierre (PR de reglas)
  [11, '—Hola —sonrió Ana.', '—Hola. —Sonrió Ana.', '2.3d (sonreír no es de lengua)'],
  [11, '—Sí —asintió—. Vamos.', '—Sí. —Asintió—. Vamos.', '2.3d'],
  [11, '—Bueno —se rascó la cabeza—, vamos.', null, '2.3e con coma'],
  [11, '—Hola —Pedro golpeó la mesa— y se fue.', null, 'nombre propio a mitad (no se toca)'],
  [11, '—Hola —saludó Ana.', null, 'verbo fuera de las listas: no se marca'],
  [11, '—¡Duendes! —gritó. —Todo apestaba.', { marca: 'closing-dash' }, '2.3b u otro hablante: sin arreglo'],
  [11, 'Entonces gritó: —¡Vení!', null, 'raya tras dos puntos en narración'],
  [11, 'Esperaba a Emilio —un gran amigo. Lamentablemente, no vino.', { marca: 'unclosed-aside' }, '2.1'],
  [11, '—Leí "Rayuela" anoche.', null, 'comillas internas (§4)'],
  [11, '—Esto que has hecho —gritó "es una locura."', { marca: 'dash-quote-mix' }, 'conversión a medias'],
  [11, 'Se quedó  mirando la puerta.', 'Se quedó mirando la puerta.', 'espacio doble'],
  // Falsos positivos encontrados corriendo el validador sobre las novelas
  // del autor (2026-09-30): el personaje retoma tras el comentario.
  [11, '—Ya sé. —Te dije.', null, 'retoma: segunda persona'],
  [11, '—Ya sé. —Me dijo que la regañaste.', null, 'retoma: «que» detrás'],
  [11, '—¿Eh? —La pregunta lo tomó por sorpresa.', null, 'artículo, no clítico'],
  [9, '»Ayer, cuando tenía todo listo, recibí una llamada.', null, 'comillas de seguir (DPD comillas 2c)'],
  [9, '»Me dijo «vete» y me fui.', null, 'comillas de seguir'],
  [9, '“Esto empieza mal”, pensó Bastidas malhumorado.', null, 'pensamiento (DPD comillas 2b)'],
  [9, '"Bueno," dijo, "vamos."', '—Bueno —dijo—, vamos.', '2.3c'],
  [9, '"Hola," Cerró la puerta.', '—Hola. —Cerró la puerta.', '2.3d'],
  [9, '"No sé." se encogió de hombros.', '—No sé. —Se encogió de hombros.', '2.3d'],
];

const PENDIENTES = new Set([
  "\"Esto que hiciste\", gritó, \"es una locura\".",
  "<p>\"Hola,\"&nbsp;dijo Ana.</p>",
  "<p><em>\"Vení\"</em>, dijo ella.</p>",
  "<p>\"Hola\",&nbsp;dijo Ana.</p>",
  "<blockquote><p>\"Canción de cuna\"</p></blockquote>",
  "<h1 class=\"chapter-title\">«Uno»</h1><p>\"Hola\" dijo Juan.</p>",
]);

const letters = (s) => (s.replace(/<[^>]+>|&[a-z]+;/g, ' ').match(/\p{L}/gu) ?? []).join('').toLowerCase();
const ellipses = (s) => (s.match(/\.\.\.|…/g) ?? []).length;
const isHtml = (s) => /<(p|h1|blockquote)[\s>]/.test(s);

function applyPlain(t, fixes) {
  let end = Infinity;
  for (const f of [...fixes].sort((a, b) => b.offset - a.offset)) {
    if (f.offset + f.length > end) continue; // solapa con uno ya aplicado
    t = t.slice(0, f.offset) + f.replacement + t.slice(f.offset + f.length);
    end = f.offset;
  }
  return t;
}
const plainOf = (t) => (isHtml(t) ? htmlToPlain(t) : t);
const viol = (t, lang = 'es') => validateRae(plainOf(t), lang);
// Lo que el autor obtiene: convert() y después todos los autoFix dedicados
// (pending-conversion ya es convert) hasta que no quede ninguno aplicable.
function pipeline(x) {
  let t = convert(x).text;
  for (let i = 0; i < 5; i++) {
    // Los `manual` son de a uno desde el popover: la revisión en bloque no
    // los aplica, y acá tampoco.
    const fixes = viol(t).filter((v) => v.autoFix && !v.autoFix.manual && v.ruleId !== 'pending-conversion').map((v) => v.autoFix);
    if (!fixes.length) break;
    const n = isHtml(t) ? aplicarFixesHtml(t, fixes).html : applyPlain(t, fixes);
    if (n === t) break;
    t = n;
  }
  return t;
}

const rows = [];
for (const [fam, input, exp0, sec, lang = 'es'] of C) {
  const marca = exp0?.marca;
  const exp = marca ? input : (exp0 ?? input);
  const correct = exp === input && !marca;
  const conv = lang === 'es' ? convert(input).text : input;
  const pipe = lang === 'es' ? pipeline(input) : input;
  const vIn = viol(input, lang).map((v) => v.ruleId);
  const vOut = viol(pipe, lang).map((v) => v.ruleId);
  const vExp = viol(exp, lang).map((v) => v.ruleId);
  const f = [];
  if (marca && !vIn.includes(marca)) f.push('SIN-MARCA');
  if (!correct && pipe !== exp) f.push('MAL');
  if (!correct && vIn.length === 0) f.push('MUDO-in');
  if (!correct && pipe !== exp && vOut.length === 0 && vIn.length > 0) f.push('MUDO-out');
  if ((correct && (vIn.length || conv !== input)) || (!correct && !marca && vExp.length)) f.push('FP');
  if (letters(conv) !== letters(input) || letters(pipe) !== letters(input)) f.push('PERDIDA');
  if (ellipses(conv) < ellipses(input) || ellipses(pipe) < ellipses(input)) f.push('PERDIDA-SUSP');
  if (lang === 'es' && convert(conv).text !== conv) f.push('NO-IDEMP');
  // Toda marca enseña: trae su sección del DPD (el espacio doble no tiene).
  const sinAyuda = [...viol(input, lang), ...viol(pipe, lang)].filter(
    (v) => v.ruleId !== 'double-space' && !v.help?.section,
  );
  if (sinAyuda.length) f.push('SIN-AYUDA:' + sinAyuda.map((v) => v.ruleId).join('/'));
  rows.push({ fam, input, conv, pipe, exp, sec, vIn, vOut, vExp, f });
}

const show = (s) => JSON.stringify(s).slice(1, -1);
const all = process.argv.includes('--all');
const fams = ['', 'Sustitutos de raya', 'Espaciado', 'Mayúsculas', 'Puntuación', 'Comillas', 'Falsos positivos', 'HTML / multi-párrafo', 'Punto/cierre + raya + caja del inciso', 'Texto correcto que se rompía', 'Guiones, verbos y pronombres', 'Caja del inciso y raya de cierre'];
const fallan = rows.filter((x) => x.f.length && !PENDIENTES.has(x.input));
const sanados = rows.filter((x) => !x.f.length && PENDIENTES.has(x.input));
for (let fam = 1; fam < fams.length; fam++) {
  const rs = rows.filter((x) => x.fam === fam && (all || fallan.includes(x)));
  if (!rs.length) continue;
  console.log(`\n## ${fam}. ${fams[fam]}`);
  for (const x of rs) {
    const tag = x.f.length ? x.f.join(',') + (PENDIENTES.has(x.input) ? ' (pendiente)' : '') : 'OK';
    console.log(`[${tag}] ${x.sec}`);
    console.log(`  in:   ${show(x.input)}   viol: ${x.vIn.join(' ') || '∅'}`);
    console.log(`  conv: ${show(x.conv)}`);
    if (x.pipe !== x.conv) console.log(`  fix:  ${show(x.pipe)}   viol: ${x.vOut.join(' ') || '∅'}`);
    else console.log(`        viol(out): ${x.vOut.join(' ') || '∅'}`);
    if (x.exp !== x.input) console.log(`  exp:  ${show(x.exp)}${x.vExp.length ? '   viol(exp): ' + x.vExp.join(' ') : ''}`);
  }
}
for (const x of sanados) console.error(`  SANADO — sacar de PENDIENTES: ${show(x.input)}`);
const ok = rows.filter((x) => !x.f.length).length;
const pend = rows.filter((x) => x.f.length && PENDIENTES.has(x.input)).length;
console.log(`\n${rows.length} casos: ${ok} ok, ${pend} pendientes, ${fallan.length} fail, ${sanados.length} sanados`);
if (process.argv.includes('--lista')) for (const x of rows.filter((x) => x.f.length)) console.log(`  ${JSON.stringify(x.input)},`);
process.exit(fallan.length || sanados.length ? 1 : 0);
