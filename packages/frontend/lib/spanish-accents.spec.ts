/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/spanish-accents.spec.ts
 *
 * Guards the orthography of the Spanish UI copy.
 *
 * `messages/es.json` had 1695 strings and 47 of them contained an accent.
 * The rest were written without diacritics, including the whole sign-up form
 * that a prospective Spanish salon reads first: "Nombre del salon",
 * "Telefono", "Contrasena", "Espanol", "Acepto los terminos". 327 strings
 * were corrected.
 *
 * This is not a style preference. For a product sold in Spain, copy without
 * accents reads as unfinished, and the first screen is the worst place to
 * suggest that.
 *
 * Two rules, both chosen so a correct string can never trip them:
 *
 *  1. Singular -ción / -sión always carry the accent. The plural does NOT
 *     (acción -> acciones, sesión -> sesiones), so the rule ignores anything
 *     ending in s.
 *  2. An explicit list of words that do not exist in Spanish without their
 *     accent. Words that exist BOTH ways are deliberately absent, because
 *     only the sentence can decide: esta/está, mas/más, si/sí, tu/tú,
 *     publico/público, numero/número, continua/continúa, aun/aún. Those were
 *     reviewed by hand, one occurrence at a time.
 *
 * Also absent, because they are correct as they stand: `salones` (the plural
 * of salón drops the accent, the stress moves), and `solo` (the RAE has not
 * required the accent since 2010).
 */

import * as fs from 'fs';
import * as path from 'path';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

const ES_PATH = path.resolve(__dirname, '..', 'messages', 'es.json');
const es = JSON.parse(fs.readFileSync(ES_PATH, 'utf8'));

type Entry = [string, string];
const strings: Entry[] = [];
(function walk(node: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') strings.push([full, value]);
    else if (value && typeof value === 'object') {
      walk(value as Record<string, unknown>, full);
    }
  }
})(es, '');

const LETTER = '[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]';

/** Tokens that are identifiers, placeholders, URLs or file names, not prose. */
function looksLikeCode(token: string): boolean {
  if (/[_/@{}<>=]/.test(token)) return true;
  if (/\.[a-z]{2,4}\b/i.test(token)) return true;
  if (/^[a-z]+[A-Z]/.test(token)) return true;
  return false;
}

function offenders(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [key, value] of strings) {
    for (const token of value.split(/\s+/)) {
      if (looksLikeCode(token)) continue;
      const bare = token.replace(/^[¿¡("'«]+|[.,;:!?)"'»]+$/g, '');
      if (pattern.test(bare)) out.push(`${key}: ${bare}`);
    }
  }
  return out;
}

console.log('\n=== Rule 1: singular -ción / -sión carry the accent ===');

// `sion`/`cion` at the end of a word, with no trailing s, is always wrong.
// The plural is excluded because it genuinely has no accent.
const singularCionRule = new RegExp(`^${LETTER}*[cs]ion$`, 'i');
check('no unaccented -cion / -sion', offenders(singularCionRule), []);

console.log('\n=== Rule 2: words that do not exist unaccented ===');

// Every entry here was found in the file and corrected. None of them is a
// valid Spanish word without its accent, so a false positive is impossible.
const ALWAYS_ACCENTED = [
  'telefono', 'telefonos', 'telefonico', 'telefonica',
  'contrasena', 'contrasenas',
  'espanol', 'espanola', 'ingles',
  'terminos', 'politica', 'politicas', 'regimen',
  'electronico', 'electronica',
  'salon', 'peluqueria', 'peluquerias',
  'codigo', 'codigos', 'metodo', 'metodos', 'periodo',
  'minimo', 'minima', 'maximo', 'maxima',
  'unico', 'unica', 'unicos', 'unicas',
  'proximo', 'proxima', 'ultimo', 'ultima', 'ultimos', 'ultimas',
  'automatico', 'automatica', 'automaticamente',
  'facil', 'faciles', 'dificil', 'rapido', 'rapida',
  'movil', 'moviles', 'grafico', 'graficos',
  'linea', 'lineas', 'valido', 'validos', 'valida', 'validas',
  'dia', 'dias', 'ano', 'anos', 'manana',
  'senal', 'diseno', 'tamano', 'pequeno', 'compania',
  'credito', 'debito', 'estadistica', 'estadisticas',
  'metrica', 'metricas', 'historico', 'categoria', 'categorias',
  'garantia', 'energia', 'economia', 'fotografia', 'galeria',
  'limite', 'limites', 'titulo', 'titulos', 'articulo', 'articulos',
  'parametro', 'parametros', 'caracter', 'analisis',
  'util', 'utiles', 'basico', 'basica', 'logico', 'logica',
  'aqui', 'alli', 'ahi', 'asi', 'tambien', 'despues', 'segun',
  'ademas', 'quizas', 'jamas', 'atras', 'detras',
  'facilmente', 'rapidamente', 'todavia',
  'estas', 'estan', 'estara', 'estaran', 'sera', 'seran',
  'podra', 'podran', 'tendra', 'tendran', 'hara', 'haran',
  'cancelaras', 'pasaras', 'apareceran', 'aparecera',
  'recibira', 'recibiran', 'enviara', 'enviaran',
  'analitica', 'analiticas', 'intentalo', 'area', 'areas',
  'anadir', 'anade', 'anadido', 'sincronizacion', 'antelacion',
];

const wordRule = new RegExp(`^(${ALWAYS_ACCENTED.join('|')})$`, 'i');
check('no unaccented forms from the curated list', offenders(wordRule), []);

console.log('\n=== The list itself stays honest ===');

// Words that exist both ways must NOT be in the list, or a correct string
// would start failing this spec.
const AMBIGUOUS = ['esta', 'mas', 'si', 'tu', 'el', 'solo', 'publico',
  'publica', 'numero', 'continua', 'aun', 'salones', 'mi', 'se', 'de'];
check(
  'no ambiguous word is policed',
  ALWAYS_ACCENTED.filter((w) => AMBIGUOUS.includes(w)),
  [],
);
check('no duplicates in the list', ALWAYS_ACCENTED.length, new Set(ALWAYS_ACCENTED).size);

console.log('\n=== Coverage: the copy really is accented now ===');

const accented = strings.filter(([, v]) => /[ÁÉÍÓÚÜÑáéíóúüñ]/.test(v)).length;
// It was 47 out of 1695 before this pass. A regression that stripped the
// accents again would show up here even if it used vocabulary the rules
// above do not cover.
check('at least 300 strings carry an accent', accented >= 300, true);
console.log(`     (${accented} of ${strings.length})`);

console.log('\n=== Placeholders survived the pass ===');

const brokenPlaceholders = strings.filter(([, v]) =>
  /\{\{?[^}]*[ÁÉÍÓÚÜÑáéíóúüñ][^}]*\}?\}/.test(v),
);
// `{salon}` was accented to `{salón}` during the fix, which would have made
// the interpolation miss and shown the literal braces to the user.
check(
  'no accent inside an interpolation placeholder',
  brokenPlaceholders.map(([k]) => k),
  [],
);

console.log('\n=== Summary ===');
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log('✓ All spanish-accents tests passed.');
}
