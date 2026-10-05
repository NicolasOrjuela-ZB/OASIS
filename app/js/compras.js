// Pantalla de Compras: una fila por compra, editable en la tabla.
// Equivale a la hoja Flow del Sheets.

const { createApp, nextTick } = Vue;

// Espejo de los enums de la base (oasis_v2_esquema.sql). Si cambian allá, cambian aquí.
const ENUMS = {
  tipo_compra: ['DIRECTO', 'BONIFICADO'],
  medio:       ['OOH', 'DOOH'],
  tipo_costo:  ['EXHIBICION', 'PRODUCCION', 'IMPUESTOS'],
};

const COLUMNAS_COMPRA = [
  'id', 'mercado_id', 'codigo', 'cliente', 'campana_id', 'proveedor_id',
  'tipo_compra', 'medio', 'tipo_costo', 'formato', 'ubicacion', 'ciudad',
  'tarifa_bruta', 'descuento_pct', 'tarifa_neta', 'cantidad', 'nro_semanas',
  'valor_total', 'fecha_inicio', 'fecha_fin',
].join(', ');

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const fmt = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });

const redondear = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const esNumero = (x) => typeof x === 'number' && Number.isFinite(x);

// Lee lo que la gente escribe: "1.234.567", "1234567,5", "10,71", "10.71".
function leerNumero(texto, decimales) {
  const t = String(texto).replace(/\s|\$/g, '');
  if (t === '') return null;
  let normal;
  if (t.includes(',')) normal = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1 || decimales === 0) normal = t.replace(/\./g, '');
  else normal = t;
  return /^-?\d*\.?\d+$|^-?\d+\.$/.test(normal) ? Number(normal) : NaN;
}

// Trae todas las filas de una consulta, de a 1000 (límite por defecto de la API).
async function traerTodo(consulta) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta().range(desde, desde + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

// ------------------------------------------------------------------ Celda numérica
// Muestra el número con separadores cuando no tiene foco, y el valor crudo al editar.
const CeldaNum = {
  props: { modelValue: null, decimales: { type: Number, default: 2 }, disabled: Boolean },
  emits: ['update:modelValue', 'editado'],
  data: () => ({ enfocada: false, texto: '' }),
  computed: {
    mostrado() {
      if (this.enfocada) return this.texto;
      const v = this.modelValue;
      if (v === null || v === undefined) return '';
      if (Number.isNaN(v)) return this.texto;
      return fmt.format(v);
    },
  },
  methods: {
    alEnfocar() {
      this.enfocada = true;
      const v = this.modelValue;
      this.texto = esNumero(v) ? String(v).replace('.', ',') : (Number.isNaN(v) ? this.texto : '');
    },
    alEscribir(ev) {
      this.texto = ev.target.value;
      this.$emit('update:modelValue', leerNumero(this.texto, this.decimales));
      this.$emit('editado');
    },
  },
  template: `<input class="n" inputmode="decimal" :value="mostrado" :disabled="disabled"
                    @focus="alEnfocar" @blur="enfocada = false" @input="alEscribir">`,
};

// ------------------------------------------------------------------ Filas

let contadorFilas = 0;

// Lo que se manda a la base. El descuento en pantalla va de 0 a 100; en la base,
// como fracción (0,15 = 15 %), igual que lo carga cargar_oasis.py desde el Sheets.
function aPayload(r) {
  return {
    mercado_id:    r.mercado_id,
    codigo:        r.codigo,
    cliente:       r.cliente,
    campana_id:    r.campana_id,
    proveedor_id:  r.proveedor_id,
    tipo_compra:   r.tipo_compra,
    medio:         r.medio,
    tipo_costo:    r.tipo_costo,
    formato:       r.formato,
    ubicacion:     r.ubicacion,
    ciudad:        r.ciudad,
    tarifa_bruta:  r.tarifa_bruta,
    descuento_pct: redondear(r.descuento / 100, 4),
    tarifa_neta:   r.tarifa_neta,
    cantidad:      r.cantidad,
    nro_semanas:   r.nro_semanas,
    valor_total:   r.valor_total,
    fecha_inicio:  r.fecha_inicio,
    fecha_fin:     r.fecha_fin,
  };
}

function desdeBase(c) {
  const num = (x) => (x === null || x === undefined ? null : Number(x));
  const r = {
    _k: ++contadorFilas,
    id: c.id,
    mercado_id: c.mercado_id,
    codigo: c.codigo,
    cliente: c.cliente,
    campana_id: c.campana_id,
    proveedor_id: c.proveedor_id,
    tipo_compra: c.tipo_compra,
    medio: c.medio,
    tipo_costo: c.tipo_costo,
    formato: c.formato,
    ubicacion: c.ubicacion,
    ciudad: c.ciudad,
    tarifa_bruta: num(c.tarifa_bruta),
    descuento: redondear(num(c.descuento_pct) * 100, 2),
    tarifa_neta: num(c.tarifa_neta),
    cantidad: num(c.cantidad),
    nro_semanas: num(c.nro_semanas),
    valor_total: num(c.valor_total),
    fecha_inicio: c.fecha_inicio,
    fecha_fin: c.fecha_fin,
    _intento: true,      // las filas existentes muestran sus errores de inmediato
    _guardando: false,
    _repetir: false,
    _estado: null,
  };
  r._snap = JSON.stringify(aPayload(r));
  return r;
}

function filaNueva(mercadoId, codigo) {
  const r = {
    _k: ++contadorFilas,
    id: null, mercado_id: mercadoId, codigo,
    cliente: '', campana_id: null, proveedor_id: null,
    tipo_compra: null, medio: null, tipo_costo: null,
    formato: '', ubicacion: '', ciudad: '',
    tarifa_bruta: null, descuento: 0, tarifa_neta: 0,
    cantidad: 1, nro_semanas: null, valor_total: 0,
    fecha_inicio: null, fecha_fin: null,
    _intento: false,     // una fila nueva no grita errores hasta que se sale de ella
    _guardando: false, _repetir: false, _estado: null,
    _snap: null,
  };
  return r;
}

function validar(r, campanasPorId, proveedoresPorId) {
  const e = {};
  const obligatorio = 'Obligatorio';

  for (const c of ['cliente', 'formato', 'ubicacion', 'ciudad']) {
    if (!r[c]) e[c] = obligatorio;
  }
  for (const c of ['tipo_compra', 'medio', 'tipo_costo']) {
    if (!r[c]) e[c] = obligatorio;
  }

  if (!r.campana_id) e.campana_id = obligatorio;
  else {
    const c = campanasPorId.get(r.campana_id);
    if (!c) e.campana_id = 'Campaña desconocida';
    else if (c.mercado_id !== r.mercado_id) e.campana_id = 'La campaña es de otro mercado';
  }

  if (!r.proveedor_id) e.proveedor_id = obligatorio;
  else {
    const p = proveedoresPorId.get(r.proveedor_id);
    if (!p) e.proveedor_id = 'Proveedor desconocido';
    else if (p.mercado_id !== r.mercado_id) e.proveedor_id = 'El proveedor es de otro mercado';
  }

  if (r.tarifa_bruta === null) e.tarifa_bruta = obligatorio;
  else if (!esNumero(r.tarifa_bruta)) e.tarifa_bruta = 'No es un número';
  else if (r.tarifa_bruta < 0) e.tarifa_bruta = 'No puede ser negativa';

  if (r.descuento === null) e.descuento = 'Obligatorio (0 si no hay descuento)';
  else if (!esNumero(r.descuento)) e.descuento = 'No es un número';
  else if (r.descuento < 0 || r.descuento > 100) e.descuento = 'Debe estar entre 0 y 100';

  if (r.cantidad === null) e.cantidad = obligatorio;
  else if (!esNumero(r.cantidad) || !Number.isInteger(r.cantidad)) e.cantidad = 'Debe ser un número entero';
  else if (r.cantidad < 1) e.cantidad = 'Debe ser al menos 1';

  if (r.nro_semanas !== null) {
    if (!esNumero(r.nro_semanas)) e.nro_semanas = 'No es un número';
    else if (r.nro_semanas < 0) e.nro_semanas = 'No puede ser negativo';
  }

  if (!r.fecha_inicio) e.fecha_inicio = obligatorio;
  if (!r.fecha_fin) e.fecha_fin = obligatorio;
  if (r.fecha_inicio && r.fecha_fin && r.fecha_fin < r.fecha_inicio) {
    e.fecha_fin = 'La fecha fin es anterior a la fecha inicio';
  }

  return e;
}

// Diferencias entre lo guardado y la fórmula. Vienen del Sheets: se muestran,
// no se corrigen solas.
function observaciones(r) {
  const o = { neta: '', total: '' };
  if (esNumero(r.tarifa_bruta) && esNumero(r.descuento) && esNumero(r.tarifa_neta)) {
    const f = redondear(r.tarifa_bruta * (1 - r.descuento / 100), 2);
    if (Math.abs(f - r.tarifa_neta) > 1) {
      o.neta = `Guardada: ${fmt.format(r.tarifa_neta)}. Fórmula (bruta × (1 − desc.)): ${fmt.format(f)}.`;
    }
  }
  if (esNumero(r.tarifa_neta) && esNumero(r.cantidad) && esNumero(r.valor_total)) {
    const f = redondear(r.tarifa_neta * r.cantidad, 2);
    if (Math.abs(f - r.valor_total) > 1) {
      o.total = `Guardado: ${fmt.format(r.valor_total)}. Fórmula (neta × cantidad): ${fmt.format(f)}.`;
    }
  }
  return o;
}

function mensajeError(error) {
  if (!error) return 'Error desconocido';
  if (error.code === '42501') return 'Sin permiso para guardar en este mercado';
  if (error.code === '23505') return 'Ese código ya existe en el mercado';
  if (error.code === '23503') return 'Campaña o proveedor no corresponden al mercado';
  if (error.code === '23514') return 'La base rechazó un valor (fechas, descuento o valor total)';
  return error.message || String(error);
}

// ------------------------------------------------------------------ App

async function iniciar() {
  const usuario = await requerirAcceso();
  pintarBarra(document.getElementById('barra'), usuario, 'compras');

  createApp({
    components: { CeldaNum },

    data: () => ({
      ENUMS,
      usuario,
      cargando: true,
      errorCarga: '',
      mercados: [],
      misMercadoIds: [],
      campanas: [],
      proveedores: [],
      filas: [],
      filaActiva: null,
      filtros: { mercado: '', mes: '', proveedor: '', tipoCosto: '' },
    }),

    computed: {
      soloLectura() { return this.usuario.rol === 'LECTURA'; },

      misMercados() {
        return this.mercados.filter(m => this.misMercadoIds.includes(m.id));
      },
      mercadosPorId() { return new Map(this.mercados.map(m => [m.id, m])); },
      campanasPorId() { return new Map(this.campanas.map(c => [c.id, c])); },
      proveedoresPorId() { return new Map(this.proveedores.map(p => [p.id, p])); },

      campanasPorMercado() {
        const g = new Map();
        for (const c of this.campanas) {
          if (!g.has(c.mercado_id)) g.set(c.mercado_id, []);
          g.get(c.mercado_id).push(c);
        }
        return g;
      },

      eyebrow() {
        const m = this.mercadosPorId.get(this.filtros.mercado);
        return m ? `${m.codigo} · ${m.nombre}` : 'Todos mis mercados';
      },

      proveedoresFiltro() {
        const enMercado = this.filtros.mercado
          ? this.proveedores.filter(p => p.mercado_id === this.filtros.mercado)
          : this.proveedores.filter(p => this.misMercadoIds.includes(p.mercado_id));
        return enMercado.map(p => ({
          id: p.id,
          etiqueta: this.filtros.mercado ? p.nombre : `${p.nombre} (${this.codigoMercado(p.mercado_id)})`,
        }));
      },

      meses() {
        const s = new Set();
        for (const r of this.filas) {
          if (!r.fecha_inicio || !r.fecha_fin || r.fecha_fin < r.fecha_inicio) continue;
          let [y, m] = r.fecha_inicio.slice(0, 7).split('-').map(Number);
          const fin = r.fecha_fin.slice(0, 7);
          for (let i = 0; i < 60; i++) {
            const k = `${y}-${String(m).padStart(2, '0')}`;
            s.add(k);
            if (k >= fin) break;
            m++; if (m > 12) { m = 1; y++; }
          }
        }
        return [...s].sort();
      },

      // Las filas nuevas sin guardar siempre se ven, aunque no cumplan los filtros.
      visibles() {
        const f = this.filtros;
        return this.filas.filter(r => {
          if (!r.id) return true;
          if (f.mercado && r.mercado_id !== f.mercado) return false;
          if (f.proveedor && r.proveedor_id !== f.proveedor) return false;
          if (f.tipoCosto && r.tipo_costo !== f.tipoCosto) return false;
          if (f.mes) {
            if (!r.fecha_inicio || !r.fecha_fin) return false;
            if (r.fecha_inicio > `${f.mes}-31` || r.fecha_fin < `${f.mes}-01`) return false;
          }
          return true;
        });
      },

      sumaVisible() {
        return this.visibles.reduce((s, r) => s + (esNumero(r.valor_total) ? r.valor_total : 0), 0);
      },

      errores() {
        const m = new Map();
        for (const r of this.filas) m.set(r._k, validar(r, this.campanasPorId, this.proveedoresPorId));
        return m;
      },

      obs() {
        const m = new Map();
        for (const r of this.filas) m.set(r._k, observaciones(r));
        return m;
      },

      observadasVisibles() {
        return this.visibles.filter(r => { const o = this.obs.get(r._k); return o.neta || o.total; }).length;
      },

      mercadoParaCrear() {
        return this.filtros.mercado || null;
      },
      puedeCrear() { return !this.soloLectura && !this.cargando && !!this.mercadoParaCrear; },
      motivoNoCrear() {
        if (this.soloLectura) return 'Tu rol es de solo lectura';
        if (!this.mercadoParaCrear) return 'Elige un mercado para crear la compra';
        return '';
      },

      estadoGlobal() {
        if (this.cargando) return { clase: '', texto: '' };
        const guardando = this.filas.filter(r => r._guardando).length;
        const conError = this.filas.filter(r => r._estado && r._estado.clase === 'err').length;
        if (guardando) return { clase: 'prop', texto: 'Guardando…' };
        if (conError) return { clase: 'err', texto: `${conError} ${conError === 1 ? 'fila sin guardar' : 'filas sin guardar'}` };
        if (this.soloLectura) return { clase: '', texto: 'Solo lectura' };
        return { clase: 'ok', texto: 'Todo guardado' };
      },
    },

    watch: {
      'filtros.mercado'() {
        if (this.filtros.proveedor && !this.proveedoresFiltro.some(p => p.id === this.filtros.proveedor)) {
          this.filtros.proveedor = '';
        }
      },
    },

    methods: {
      fmtNumero(x) { return esNumero(x) ? fmt.format(x) : ''; },
      fmtEntero(x) { return fmt.format(x); },
      nombreMes(k) { const [y, m] = k.split('-'); return `${MESES[Number(m) - 1]} ${y}`; },
      codigoMercado(id) { const m = this.mercadosPorId.get(id); return m ? m.codigo : '?'; },

      proveedoresDe(r) {
        return this.proveedores.filter(p => p.mercado_id === r.mercado_id && (p.activo || p.id === r.proveedor_id));
      },

      // Hay ~330 campañas por mercado: la lista completa solo se arma en la fila
      // que se está editando; las demás llevan solo la opción elegida.
      opcionesCampana(r) {
        if (r._k === this.filaActiva) {
          return (this.campanasPorMercado.get(r.mercado_id) || [])
            .filter(c => c.activo || c.id === r.campana_id);
        }
        const c = this.campanasPorId.get(r.campana_id);
        return c ? [c] : [];
      },

      msgErr(r, campo) {
        if (!r._intento) return '';
        return this.errores.get(r._k)[campo] || '';
      },
      claseErr(r, campo) { return this.msgErr(r, campo) ? 'err' : ''; },

      // Recalcula lo derivado de lo que se acaba de editar. Lo demás se respeta:
      // así una compra con valores heredados del Sheets no cambia si solo se toca
      // la ubicación o una fecha.
      recalcular(r, desde) {
        if (desde === 'neta' && esNumero(r.tarifa_bruta) && esNumero(r.descuento)) {
          r.tarifa_neta = redondear(r.tarifa_bruta * (1 - r.descuento / 100), 2);
        }
        if (esNumero(r.tarifa_neta) && esNumero(r.cantidad)) {
          r.valor_total = redondear(r.tarifa_neta * r.cantidad, 2);
        }
      },

      alSalirDeCelda(ev) {
        const tr = ev.target.closest('tr[data-k]');
        if (!tr) return;
        const r = this.filas.find(x => x._k === Number(tr.dataset.k));
        if (!r) return;
        const destino = ev.relatedTarget && ev.relatedTarget.closest && ev.relatedTarget.closest('tr[data-k]');
        const sigueEnLaFila = destino === tr;

        // Fila nueva: se guarda cuando se sale de la fila (o antes, si ya está completa).
        if (!r.id && sigueEnLaFila && Object.keys(this.errores.get(r._k)).length) return;
        if (!r.id) r._intento = true;
        this.guardar(r);
      },

      async guardar(r) {
        if (this.soloLectura) return;

        const errs = this.errores.get(r._k);
        const n = Object.keys(errs).length;
        if (n) {
          r._intento = true;
          r._estado = { clase: 'err', texto: n === 1 ? '1 error' : `${n} errores`, detalle: Object.values(errs).join(' · ') };
          return;
        }

        const payload = aPayload(r);
        const snap = JSON.stringify(payload);
        if (snap === r._snap) {
          if (r._estado && r._estado.clase === 'err') r._estado = null;
          return;
        }
        if (r._guardando) { r._repetir = true; return; }

        r._guardando = true;
        r._estado = { clase: 'prop', texto: 'guardando…' };
        let error = null;

        try {
          if (r.id) {
            const { mercado_id, codigo, ...cambios } = payload;
            const res = await sb.from('compras')
              .update({ ...cambios, actualizado_en: new Date().toISOString() })
              .eq('id', r.id)
              .select('id');
            error = res.error;
            if (!error && res.data.length === 0) error = { code: '42501' };
          } else {
            let res = await sb.from('compras').insert(payload).select('id').single();
            if (res.error && res.error.code === '23505') {
              // Alguien más tomó el código mientras tanto: se pide el siguiente a la base.
              r.codigo = await this.siguienteCodigoEnBase(r.mercado_id);
              payload.codigo = r.codigo;
              res = await sb.from('compras').insert(payload).select('id').single();
            }
            error = res.error;
            if (!error) r.id = res.data.id;
          }
        } catch (e) {
          error = e;
        }

        r._guardando = false;
        if (error) {
          r._estado = { clase: 'err', texto: 'error', detalle: mensajeError(error) };
          console.error('No se guardó la compra', r.codigo, error);
        } else {
          r._snap = JSON.stringify(aPayload(r));
          const estado = { clase: 'ok', texto: 'guardado' };
          r._estado = estado;
          setTimeout(() => { if (r._estado === estado) r._estado = null; }, 2500);
        }

        if (r._repetir) { r._repetir = false; this.guardar(r); }
      },

      siguienteCodigoLocal(mercadoId) {
        let max = 0;
        for (const r of this.filas) {
          if (r.mercado_id !== mercadoId) continue;
          const n = parseInt(r.codigo, 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
        return String(max + 1).padStart(3, '0');
      },

      async siguienteCodigoEnBase(mercadoId) {
        const filas = await traerTodo(() => sb.from('compras').select('codigo').eq('mercado_id', mercadoId).order('id'));
        let max = 0;
        for (const f of filas) { const n = parseInt(f.codigo, 10); if (Number.isFinite(n) && n > max) max = n; }
        for (const r of this.filas) {
          if (r.mercado_id === mercadoId && !r.id) { const n = parseInt(r.codigo, 10); if (n > max) max = n; }
        }
        return String(max + 1).padStart(3, '0');
      },

      async nuevaCompra() {
        if (!this.puedeCrear) return;
        const r = filaNueva(this.mercadoParaCrear, this.siguienteCodigoLocal(this.mercadoParaCrear));
        this.filas.push(r);
        this.filaActiva = r._k;
        await nextTick();
        const tr = this.$el.querySelector(`tr[data-k="${r._k}"]`);
        if (tr) {
          tr.scrollIntoView({ block: 'nearest' });
          const primero = tr.querySelector('input, select');
          if (primero) primero.focus();
        }
      },

      descartar(r) {
        this.filas = this.filas.filter(x => x !== r);
      },

      async cargar() {
        try {
          const [mercados, mis, propios, campanas, proveedores, compras] = await Promise.all([
            traerTodo(() => sb.from('mercados').select('id, codigo, nombre, activo').order('id')),
            sb.rpc('fn_mis_mercados'),
            traerTodo(() => sb.from('usuario_mercados').select('mercado_id').order('mercado_id')),
            traerTodo(() => sb.from('campanas').select('id, mercado_id, nombre_unico, activo').order('nombre_unico')),
            traerTodo(() => sb.from('proveedores').select('id, mercado_id, nombre, activo').order('nombre')),
            traerTodo(() => sb.from('compras').select(COLUMNAS_COMPRA).order('mercado_id').order('codigo')),
          ]);
          if (mis.error) throw mis.error;

          this.mercados = mercados;
          this.misMercadoIds = (mis.data || []).map(x => (typeof x === 'object' ? Object.values(x)[0] : x)).map(Number);
          this.campanas = campanas;
          this.proveedores = proveedores;
          this.filas = compras.map(desdeBase);

          // Mercado por defecto: el único que tenga, o el primero asignado (un ADMIN ve todos).
          if (this.misMercados.length === 1) this.filtros.mercado = this.misMercados[0].id;
          else {
            const propio = propios.map(p => p.mercado_id).find(id => this.misMercadoIds.includes(id));
            if (propio) this.filtros.mercado = propio;
          }
          if (!this.misMercados.length) {
            this.errorCarga = 'Tu usuario no tiene mercados asignados. Pide a un administrador que te los asigne.';
          }
        } catch (e) {
          console.error(e);
          this.errorCarga = 'No se pudieron cargar las compras: ' + (e.message || e);
        } finally {
          this.cargando = false;
        }
      },
    },

    mounted() {
      this.cargar();
      window.addEventListener('beforeunload', (ev) => {
        const pendientes = this.filas.some(r => r._guardando || (r._estado && r._estado.clase === 'err') || (!r.id));
        if (pendientes) { ev.preventDefault(); ev.returnValue = ''; }
      });
    },
  }).mount('#app');
}

iniciar();
