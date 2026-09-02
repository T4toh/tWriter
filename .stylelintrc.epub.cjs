// Config de stylelint SOLO para src-tauri/src/epub_style.css.
//
// A propósito, no extiende stylelint-config-standard-scss: esa hoja usa
// float, display:table y vh porque los e-readers (Kindle KF8/KFX en
// particular) no soportan flexbox/grid de forma confiable — ver los
// comentarios del propio archivo. Cualquier regla de gusto (casing,
// orden de propiedades, shorthand, qué layout "se debe" usar) rechazaría
// justamente las decisiones deliberadas de ese archivo, así que no se
// habilita ninguna. Lo único que se valida acá es que el CSS sea
// *correcto*: nombres de propiedad, valores, unidades, at-rules y
// selectores que existen de verdad. Un parser CSS no distingue
// "colr: red" (typo) de una propiedad real — stylelint sí, porque tiene
// una base de datos de propiedades conocidas.
module.exports = {
  rules: {
    // "colr: red" — nombre de propiedad que no existe. Es el caso que
    // motivó esta config: sintácticamente válido, el reader lo ignora en
    // silencio y el autor solo lo nota mirando el EPUB en un Kindle.
    'property-no-unknown': true,

    // Valor inválido para una propiedad que sí existe (ej. "display: felx").
    'declaration-property-value-no-unknown': true,

    // Dos declaraciones de la misma propiedad en el mismo bloque: la
    // segunda pisa a la primera en silencio, sin error visible.
    'declaration-block-no-duplicate-properties': true,

    // Bloque de regla vacío — quedó sin declaraciones tras un refactor.
    'block-no-empty': true,

    // @-regla que stylelint no reconoce (ej. "@midea" por typo de
    // "@media"). "amzn-kf8" no cae acá: es el *tipo* de @media (el valor
    // dentro del at-rule), no el nombre del at-rule en sí, así que este
    // check no lo toca — sigue siendo un @media válido.
    'at-rule-no-unknown': true,

    // Unidad que no existe (ej. "10pxx").
    'unit-no-unknown': true,

    // Selector sintácticamente inválido que un parser CSS tolerante deja
    // pasar sin error (comas colgantes, combinadores sueltos, etc).
    'selector-no-invalid': true,
  },
};
