import { TreeNode } from '../core/types';

/** Nota lista para pintar en la tab "Este libro". Lleva el `TreeNode` original
 *  para que las filas reusen el `select`/menú contextual del árbol en vez de
 *  duplicar la lógica de abrir notas. */
export interface NotaRef {
  node: TreeNode;
  path: string;
  /** Nombre del archivo sin extensión. */
  nombre: string;
  /** Texto de la fila: `Aedan` o `Lugares › Cantaria` si está anidada. */
  etiqueta: string;
}

export interface NotasDelLibro {
  /** Nombre de la saga sin el prefijo numérico (`1 - Meridian 2.0` → `Meridian 2.0`). */
  sagaNombre: string;
  /** Libro resuelto desde el capítulo activo, o null si el capítulo no está
   *  dentro de un libro (o si se resolvió solo la saga). */
  libroNombre: string | null;
  /** Notas del libro: las de `Notas/<saga>/<libro>/` más el `notas/` que el
   *  libro tenga en el árbol de novelas (típicamente `Arreglos.md`). */
  libro: NotaRef[];
  /** Notas de la saga: todo lo que cuelga de `Notas/<saga>/` sin ser un libro. */
  saga: NotaRef[];
  /** Carpeta de notas de la saga (`Notas/Meridian`). Existe siempre que el
   *  resultado no sea null. */
  carpetaSagaPath: string;
  /** Carpeta de notas del libro (`Notas/Meridian/3 - Secreto`). Es el destino
   *  natural de una ficha nueva. Puede no existir todavía en disco — se
   *  devuelve el path que le corresponde y el backend crea la carpeta. null si
   *  no se resolvió ningún libro. */
  carpetaLibroPath: string | null;
}

/** Saca el prefijo `N - ` que ordena las carpetas en el filesystem. */
export function sinPrefijoNumerico(nombre: string): string {
  return nombre.replace(/^\d+\s*-\s*/, '');
}

/** ¿La carpeta de notas `candidato` corresponde a la saga `saga`? Calza exacto
 *  o por prefijo, porque el autor tiene `Notas/Meridian` para la saga
 *  `1 - Meridian 2.0` (la saga se versionó, la carpeta de notas no). */
export function calzaSaga(candidato: string, saga: string): boolean {
  const a = candidato.trim().toLowerCase();
  const b = sinPrefijoNumerico(saga).trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}

/** Cadena de nodos desde `root` hasta `path`, incluidos los dos. Vacío si no
 *  está. */
function cadenaHasta(root: TreeNode, path: string): TreeNode[] {
  if (root.path === path) return [root];
  for (const c of root.children) {
    const sub = cadenaHasta(c, path);
    if (sub.length > 0) return [root, ...sub];
  }
  return [];
}

/** Todas las notas del subárbol, con etiqueta `carpeta › archivo` para las
 *  anidadas. `prefijo` acumula los nombres de carpeta intermedios. */
function recolectar(node: TreeNode, prefijo: string[]): NotaRef[] {
  const out: NotaRef[] = [];
  for (const c of node.children) {
    if (c.kind === 'note') {
      const nombre = c.name.replace(/\.(md|markdown)$/i, '');
      out.push({
        node: c,
        path: c.path,
        nombre,
        etiqueta: [...prefijo, nombre].join(' › '),
      });
    } else if (c.kind === 'notes' || c.kind === 'folder') {
      out.push(...recolectar(c, [...prefijo, c.name]));
    }
  }
  return out;
}

function ordenar(notas: NotaRef[]): NotaRef[] {
  return [...notas].sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, 'es'));
}

/**
 * Notas relevantes para el capítulo que se está escribiendo.
 *
 * El autor guarda las fichas de personaje **por libro** a propósito — son
 * acumulativas y muestran al personaje por época — así que hay cuatro
 * `Aedan.md`, uno por libro. Escribiendo, la que importa es la del libro
 * abierto; encontrarla a mano en el árbol es el laburo que esta función saca.
 *
 * `activoPath` es el capítulo (o la nota) abierta. Devuelve null si no se puede
 * resolver la saga o si esa saga no tiene carpeta de notas.
 */
export function notasDelLibro(
  tree: TreeNode | null,
  activoPath: string | null,
): NotasDelLibro | null {
  if (!tree || !activoPath) return null;
  const cadena = cadenaHasta(tree, activoPath);
  if (cadena.length === 0) return null;
  // La saga más profunda de la cadena, no la primera: el nodo raíz del árbol
  // también viene con `kind: 'saga'` (se llama como la carpeta root), así que
  // tomar la primera agarraba la raíz y devolvía null para todo.
  const sagas = cadena.filter((n) => n.kind === 'saga');
  const saga = sagas.length > 0 ? sagas[sagas.length - 1] : null;
  if (!saga || saga.path === tree.path) return null;
  const libro = cadena.find((n) => n.kind === 'book') ?? null;

  // Carpeta de notas de la saga: vive afuera de la saga, en el root o un nivel
  // más abajo (el autor las tiene en `Notas/<saga>/`). No se baja más que eso:
  // a esa profundidad ya empiezan las carpetas temáticas (`Lugares/`) y una de
  // ellas podría calzar de casualidad con el nombre de otra saga.
  const carpetasSueltas = tree.children.filter(
    (c) => c.kind === 'folder' || c.kind === 'notes',
  );
  const candidatas = [
    ...carpetasSueltas,
    ...carpetasSueltas.flatMap((c) =>
      c.children.filter((g) => g.kind === 'folder' || g.kind === 'notes'),
    ),
  ];
  const carpetaSaga = candidatas.find((c) => calzaSaga(c.name, saga.name));
  if (!carpetaSaga) return null;

  // Dentro de la carpeta de notas, los libros calzan por nombre exacto.
  const carpetaLibro = libro
    ? (carpetaSaga.children.find(
        (c) =>
          (c.kind === 'folder' || c.kind === 'notes') && c.name === libro.name,
      ) ?? null)
    : null;

  // `notas/` del libro en el árbol de novelas (Arreglos.md y compañía).
  const notasDelArbol = libro
    ? libro.children.filter((c) => c.kind === 'notes' || c.kind === 'note')
    : [];

  const delLibro: NotaRef[] = [];
  if (carpetaLibro) delLibro.push(...recolectar(carpetaLibro, []));
  for (const n of notasDelArbol) {
    if (n.kind === 'note') {
      const nombre = n.name.replace(/\.(md|markdown)$/i, '');
      delLibro.push({ node: n, path: n.path, nombre, etiqueta: nombre });
    } else {
      delLibro.push(...recolectar(n, []));
    }
  }

  // Notas de saga: SOLO las `.md` sueltas de `Notas/<saga>/` (`Personajes`,
  // `Idiomas`, `Detalles`…). Las carpetas temáticas no se aplanan acá: bajar
  // recursivo por `Lugares/`, `Monstruos/` y `Magia y asociados/` daba 95 filas
  // en la saga de Meridian, peor que el árbol que esta lista viene a evitar.
  // Para eso está la tab "Todas".
  const deSaga: NotaRef[] = [];
  for (const c of carpetaSaga.children) {
    if (c.kind === 'note') {
      const nombre = c.name.replace(/\.(md|markdown)$/i, '');
      deSaga.push({ node: c, path: c.path, nombre, etiqueta: nombre });
    }
  }

  return {
    sagaNombre: sinPrefijoNumerico(saga.name),
    libroNombre: libro ? libro.name : null,
    libro: ordenar(delLibro),
    saga: ordenar(deSaga),
    carpetaSagaPath: carpetaSaga.path,
    carpetaLibroPath:
      carpetaLibro?.path ?? (libro ? `${carpetaSaga.path}/${libro.name}` : null),
  };
}
