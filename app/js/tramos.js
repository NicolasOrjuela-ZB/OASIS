// Fechas de un material frente a su compra, y partición en tramos.
// Regla: un material nunca excede su compra. Si una campaña cruza dos compras
// del mismo soporte se parte en un material por compra (CLAUDE.md).
// No depende de la página: se puede probar con node.

const MESES_LARGO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUMEROS = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis'];
const ANIO_ACTUAL = new Date().getFullYear();

// Fechas como texto ISO (AAAA-MM-DD): se comparan como texto y no sufren por la zona horaria.
function sumarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mayor = (a, b) => (a > b ? a : b);
const menor = (a, b) => (a < b ? a : b);
const partes = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
const deAnio = (y) => (y !== ANIO_ACTUAL ? ` de ${y}` : '');

const letra = (secuencia) => String.fromCharCode(64 + secuencia);

// "15 de julio" (con el año si no es el actual)
function fechaLarga(iso) {
  const p = partes(iso);
  return `${p.d} de ${MESES_LARGO[p.m - 1]}${deAnio(p.y)}`;
}

// "del 1 al 30 de junio", "del 15 de junio al 15 de julio"
function rango(a, b) {
  const x = partes(a), y = partes(b);
  if (x.y === y.y && x.m === y.m) return `del ${x.d} al ${y.d} de ${MESES_LARGO[y.m - 1]}${deAnio(y.y)}`;
  if (x.y === y.y) return `del ${x.d} de ${MESES_LARGO[x.m - 1]} al ${y.d} de ${MESES_LARGO[y.m - 1]}${deAnio(y.y)}`;
  return `del ${x.d} de ${MESES_LARGO[x.m - 1]} de ${x.y} al ${y.d} de ${MESES_LARGO[y.m - 1]} de ${y.y}`;
}

// "1–31 julio", "15 jun – 15 jul"
function periodoCorto(a, b) {
  const x = partes(a), y = partes(b);
  const anio = x.y === y.y && y.y === ANIO_ACTUAL ? '' : ` ${y.y}`;
  if (x.y === y.y && x.m === y.m) return `${x.d}–${y.d} ${MESES_LARGO[y.m - 1]}${anio}`;
  const corto = (p) => `${p.d} ${MESES_LARGO[p.m - 1].slice(0, 3)}${x.y !== y.y ? ` ${p.y}` : ''}`;
  return `${corto(x)} – ${corto(y)}${x.y === y.y ? anio : ''}`;
}

// "a", "a y b", "a, b y c"
function enLista(xs) {
  return xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

const normTexto = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

// Mismo soporte: mismo mercado, proveedor y ubicación. También el mismo tipo de
// costo: el arriendo y la producción de un paradero son compras distintas.
function mismoSoporte(a, b) {
  return a.mercado_id === b.mercado_id
    && a.proveedor_id === b.proveedor_id
    && a.tipo_costo === b.tipo_costo
    && normTexto(a.ubicacion) === normTexto(b.ubicacion);
}

// "La compra 001 cubre del 1 al 30 de junio; el material termina el 15 de julio."
function mensajeFuera(compra, fi, ff) {
  const base = `La compra ${compra.codigo} cubre ${rango(compra.fecha_inicio, compra.fecha_fin)}; `;
  if (fi < compra.fecha_inicio && ff > compra.fecha_fin) return `${base}el material va ${rango(fi, ff)}.`;
  if (ff > compra.fecha_fin) return `${base}el material termina el ${fechaLarga(ff)}.`;
  return `${base}el material empieza el ${fechaLarga(fi)}.`;
}

// Errores de fechas de un material, por campo. `obligatorias`: en el panel las
// dos fechas se piden; en la tabla un material puede seguir sin fechas.
function erroresFechas(fi, ff, compra, obligatorias) {
  const e = {};
  if (!fi && !ff) {
    if (obligatorias) { e.fecha_inicio = 'Obligatoria'; e.fecha_fin = 'Obligatoria'; }
    return e;
  }
  if (!fi) { e.fecha_inicio = obligatorias ? 'Obligatoria' : 'Falta la fecha inicio'; return e; }
  if (!ff) { e.fecha_fin = obligatorias ? 'Obligatoria' : 'Falta la fecha fin'; return e; }
  if (ff < fi) { e.fecha_fin = 'La fecha fin es anterior a la fecha inicio'; return e; }
  if (!compra) return e;
  if (!compra.fecha_inicio || !compra.fecha_fin) {
    e.fecha_inicio = `La compra ${compra.codigo} no tiene periodo; complétalo en Compras`;
    return e;
  }
  if (fi < compra.fecha_inicio || ff > compra.fecha_fin) {
    const m = mensajeFuera(compra, fi, ff);
    if (fi < compra.fecha_inicio) e.fecha_inicio = m;
    if (ff > compra.fecha_fin) e.fecha_fin = m;
    e._fuera = true;
  }
  return e;
}

// Cómo guardar un material del fi al ff que se registró bajo `compra`.
//   { tipo: 'dentro',     tramos: [{ compra, fi, ff }] }
//   { tipo: 'particion',  tramos: [...] }   un tramo por compra, en orden
//   { tipo: 'sin_compra', hueco: { fi, ff } } días que ninguna compra del soporte cubre
//   { tipo: 'sin_cruce' }                    el material no toca la compra elegida
// Los días fuera de la compra se cubren con otras compras del mismo soporte,
// cada una hasta donde alcance (una campaña larga puede cruzar varias).
function planTramos(compra, fi, ff, compras) {
  if (!fi || !ff || ff < fi || !compra.fecha_inicio || !compra.fecha_fin) return null;
  if (fi >= compra.fecha_inicio && ff <= compra.fecha_fin) {
    return { tipo: 'dentro', tramos: [{ compra, fi, ff }] };
  }
  if (ff < compra.fecha_inicio || fi > compra.fecha_fin) return { tipo: 'sin_cruce' };

  const otras = compras.filter(c => c.id !== compra.id && c.fecha_inicio && c.fecha_fin
    && c.fecha_fin >= c.fecha_inicio && mismoSoporte(c, compra));
  const tramos = [{ compra, fi: mayor(fi, compra.fecha_inicio), ff: menor(ff, compra.fecha_fin) }];

  // Hacia adelante: desde el día siguiente al fin de la compra.
  for (let d = sumarDias(compra.fecha_fin, 1); d <= ff;) {
    const cubre = otras.filter(c => c.fecha_inicio <= d && c.fecha_fin >= d)
      .sort((a, b) => (b.fecha_fin > a.fecha_fin ? 1 : -1))[0];
    if (!cubre) {
      const siguiente = otras.map(c => c.fecha_inicio).filter(x => x > d).sort()[0];
      return { tipo: 'sin_compra', hueco: { fi: d, ff: siguiente ? menor(ff, sumarDias(siguiente, -1)) : ff } };
    }
    tramos.push({ compra: cubre, fi: d, ff: menor(ff, cubre.fecha_fin) });
    d = sumarDias(cubre.fecha_fin, 1);
  }

  // Hacia atrás: desde el día anterior al inicio de la compra.
  for (let d = sumarDias(compra.fecha_inicio, -1); d >= fi;) {
    const cubre = otras.filter(c => c.fecha_inicio <= d && c.fecha_fin >= d)
      .sort((a, b) => (a.fecha_inicio > b.fecha_inicio ? 1 : -1))[0];
    if (!cubre) {
      const anterior = otras.map(c => c.fecha_fin).filter(x => x < d).sort().pop();
      return { tipo: 'sin_compra', hueco: { fi: anterior ? mayor(fi, sumarDias(anterior, 1)) : fi, ff: d } };
    }
    tramos.unshift({ compra: cubre, fi: mayor(fi, cubre.fecha_inicio), ff: d });
    d = sumarDias(cubre.fecha_inicio, -1);
  }

  return { tipo: 'particion', tramos };
}

// "Esta campaña cruza a la compra 002 (1–31 julio). Se crearán dos materiales:
//  001-C del 15 al 30 de junio y 002-A del 1 al 15 de julio. ¿Confirmar?"
// Cada tramo trae `codigo` (el material que será). `actual`: el material que se
// parte, que se queda con el tramo de su compra.
function mensajeParticion(compra, tramos, actual) {
  const otras = tramos.filter(t => t.compra.id !== compra.id);
  const cruza = `Esta campaña cruza a ${otras.length === 1 ? 'la compra' : 'las compras'} `
    + enLista(otras.map(t => `${t.compra.codigo} (${periodoCorto(t.compra.fecha_inicio, t.compra.fecha_fin)})`)) + '.';
  const desc = (t) => `${t.codigo} ${rango(t.fi, t.ff)}`;
  if (!actual) {
    return `${cruza} Se crearán ${NUMEROS[tramos.length] || tramos.length} materiales: ${enLista(tramos.map(desc))}. ¿Confirmar?`;
  }
  const propio = tramos.find(t => t.compra.id === compra.id);
  const nuevos = tramos.filter(t => t !== propio);
  return `${cruza} ${actual} queda ${rango(propio.fi, propio.ff)} y se ${nuevos.length === 1 ? 'creará' : 'crearán'} `
    + `${enLista(nuevos.map(desc))}. ¿Confirmar?`;
}

function mensajeSinCompra(compra, proveedor, hueco) {
  return `No hay una compra de ${compra.ubicacion} · ${proveedor} que cubra ${rango(hueco.fi, hueco.ff)}. `
    + 'Regístrala primero en Compras.';
}

// Miniatura del enlace, con la misma lógica del Sheets: archivo de Drive →
// miniatura; carpeta de Drive → ícono; cualquier otra cosa → nada.
function miniatura(enlace, ancho = 200) {
  const t = (enlace || '').trim();
  if (!/^https?:\/\//i.test(t) || !/(drive|docs)\.google\.com/i.test(t)) return null;
  if (/\/folders\//.test(t)) return { tipo: 'carpeta' };
  const m = t.match(/\/d\/([\w-]{10,})/) || t.match(/[?&]id=([\w-]{10,})/);
  return m ? { tipo: 'imagen', url: `https://drive.google.com/thumbnail?id=${m[1]}&sz=w${ancho}` } : null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    sumarDias, fechaLarga, rango, periodoCorto, letra, normTexto, mismoSoporte,
    erroresFechas, planTramos, mensajeFuera, mensajeParticion, mensajeSinCompra, miniatura,
  };
}
