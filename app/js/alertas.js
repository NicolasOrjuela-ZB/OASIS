// Pantalla de Alertas: lo que falta o está mal en la captura, desde v_alertas.
// Solo lectura, salvo la card de posibles duplicados (PLANNING, ZB, ADMIN).
// Cada referencia abre su fila en Compras o Materiales; la
// versión (con o sin inputs) la decide esa pantalla según el rol.

// Orden de las cards y a dónde lleva cada referencia.
const TIPOS_ALERTA = [
  { alerta: 'material fuera del periodo de su compra', titulo: 'Fuera de periodo', destino: 'partir',
    explica: 'Materiales con fechas fuera del periodo de su compra. Al abrirlos, el panel queda listo para partirlos en un tramo por compra.' },
  { alerta: 'material sin fechas', titulo: 'Sin fechas', destino: 'material',
    explica: 'Materiales sin fecha de inicio ni fin. No entran al reparto de inversión.' },
  { alerta: 'material sin sub campaña', titulo: 'Sin sub campaña', destino: 'material',
    explica: 'Materiales sin sub campaña: su inversión no se puede atribuir.' },
  { alerta: 'compra sin materiales', titulo: 'Compra sin materiales', destino: 'compra',
    explica: 'Compras sin ningún material: su valor no se reparte en ningún día.' },
  { alerta: 'sub campaña de otro mercado', titulo: 'Sub campaña de otro mercado', destino: 'material',
    explica: 'La sub campaña del material no es del glosario del mercado de su compra.' },
];

// Posibles duplicados: confianza → clase de pill (DISENO.md, pills de estado).
const CLASE_CONFIANZA = { ALTA: 'ok', MEDIA: 'prop', BAJA: 'err' };
const ORDEN_CONFIANZA = { ALTA: 0, MEDIA: 1, BAJA: 2 };
const INVISIBLES = /[\u200b-\u200d\ufeff]/;

// Mensaje legible de un error de la Edge Function o de un RPC.
async function mensajeDe(error) {
  if (!error) return 'Error desconocido';
  try {
    const cuerpo = await error.context.json();
    if (cuerpo && cuerpo.error) return cuerpo.error;
  } catch { /* no era respuesta de la función */ }
  return error.message || String(error);
}

async function iniciar() {
  const usuario = await requerirAcceso();
  pintarBarra(document.getElementById('barra'), usuario, 'alertas');

  createApp({
    data: () => ({
      usuario,
      cargando: true,
      errorCarga: '',
      mercados: [],
      misMercadoIds: [],
      alertas: [],
      ubicaciones: new Map(),   // compra_id -> ubicación
      filtros: { mercado: '' },
      duplicados: [],
      analizando: false,
      dup: { mensaje: '', clase: '' },
      CLASE_CONFIANZA,
    }),

    computed: {
      misMercados() { return this.mercados.filter(m => this.misMercadoIds.includes(m.id)); },
      mercadosPorId() { return new Map(this.mercados.map(m => [m.id, m])); },
      codigoFiltro() { const m = this.mercadosPorId.get(this.filtros.mercado); return m ? m.codigo : ''; },
      eyebrow() {
        const m = this.mercadosPorId.get(this.filtros.mercado);
        return m ? `${m.codigo} · ${m.nombre}` : 'Todos mis mercados';
      },

      // Una card por tipo con al menos un caso. Un tipo que la vista agregue
      // después y no esté en la lista sale al final con su nombre tal cual.
      grupos() {
        const k = this.codigoFiltro;
        const porTipo = new Map();
        for (const a of this.alertas) {
          if (k && a.mercado !== k) continue;
          if (!porTipo.has(a.alerta)) porTipo.set(a.alerta, []);
          porTipo.get(a.alerta).push(a);
        }
        const conocidos = TIPOS_ALERTA.map(t => t.alerta);
        const extra = [...porTipo.keys()].filter(t => !conocidos.includes(t))
          .map(t => ({ alerta: t, titulo: t, destino: 'material', explica: '' }));
        return [...TIPOS_ALERTA, ...extra]
          .filter(t => porTipo.has(t.alerta))
          .map(t => ({
            ...t,
            casos: porTipo.get(t.alerta).sort((a, b) =>
              a.mercado.localeCompare(b.mercado) || a.referencia.localeCompare(b.referencia)),
          }));
      },
      puedeEscribir() { return ['PLANNING', 'ZB', 'ADMIN'].includes(this.usuario.rol); },
      // Proveedores primero (se unifican antes que los soportes), luego por confianza.
      duplicadosVisibles() {
        const id = this.filtros.mercado;
        return this.duplicados
          .filter(d => !id || d.mercado_id === id)
          .sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'PROVEEDOR' ? -1 : 1)
            || ORDEN_CONFIANZA[a.confianza] - ORDEN_CONFIANZA[b.confianza] || a.id - b.id);
      },
      total() { return this.grupos.reduce((s, g) => s + g.casos.length, 0); },
    },

    watch: {
      'filtros.mercado'(id) {
        guardarMercadoActivo(id ? this.mercadosPorId.get(id).codigo : '');
        this.dup = { mensaje: '', clase: '' };
      },
    },

    methods: {
      enlace(grupo, a) {
        const q = new URLSearchParams({ mercado: a.mercado });
        // "compra sin materiales" no tiene material: siempre va a Compras.
        if (grupo.destino === 'compra' || !a.material_id) {
          q.set('compra', a.compra_id);
          return `compras.html?${q}`;
        }
        q.set('material', a.material_id);
        if (grupo.destino === 'partir') q.set('partir', '1');
        return `materiales.html?${q}`;
      },
      ubicacion(a) { return this.ubicaciones.get(a.compra_id) || ''; },

      // ---------------------------------------------------------- Duplicados
      codigoMercado(id) { const m = this.mercadosPorId.get(id); return m ? m.codigo : ''; },
      invisible(t) { return INVISIBLES.test(t); },
      totalCompras(d) { return d.valores.reduce((s, v) => s + (v.compras || 0), 0); },
      detalle(d, v) {
        const n = `${v.compras} ${v.compras === 1 ? 'compra' : 'compras'}`;
        if (d.tipo === 'PROVEEDOR') return n;
        return [v.proveedor, v.ciudad, (v.formatos || []).join(', '), n].filter(Boolean).join(' · ');
      },

      async cargarDuplicados() {
        const filas = await traerTodo(() => sb.from('duplicados_propuestos')
          .select('id, mercado_id, tipo, valores, canonico, confianza, razon')
          .eq('estado', 'PENDIENTE').order('id'));
        this.duplicados = filas.map(d => ({ ...d, _canonico: d.canonico, _ocupado: false, _error: '' }));
      },

      // Proveedores y soportes en paralelo: son dos llamadas a la función.
      async analizar() {
        const mercado = this.filtros.mercado;
        const codigo = this.codigoFiltro;
        this.analizando = true;
        this.dup = { mensaje: '', clase: '' };
        try {
          const resultados = await Promise.all(['PROVEEDOR', 'SOPORTE'].map(async tipo => {
            const { data, error } = await sb.functions.invoke('detectar-duplicados', {
              body: { mercado_id: mercado, tipo },
            });
            if (error) throw new Error(`${tipo === 'PROVEEDOR' ? 'Proveedores' : 'Soportes'}: ${await mensajeDe(error)}`);
            return data;
          }));
          await this.cargarDuplicados();
          const [p, s] = resultados.map(r => r.encontrados);
          this.dup = {
            clase: p + s ? 'ok' : '',
            mensaje: p + s
              ? `${codigo}: ${p} ${p === 1 ? 'grupo' : 'grupos'} de proveedores y ${s} de soportes por revisar.`
              : `${codigo}: no se encontraron duplicados nuevos.`,
          };
        } catch (e) {
          console.error(e);
          this.dup = { clase: 'error', mensaje: 'No se pudo analizar. ' + (e.message || e) };
          await this.cargarDuplicados().catch(() => {});
        } finally {
          this.analizando = false;
        }
      },

      async unificar(d) {
        d._ocupado = true;
        d._error = '';
        const { data, error } = await sb.rpc('fn_unificar_duplicado', { p_id: d.id, p_canonico: d._canonico });
        if (error) {
          d._ocupado = false;
          d._error = 'No se pudo unificar: ' + await mensajeDe(error);
          return;
        }
        this.duplicados = this.duplicados.filter(x => x.id !== d.id);
        this.dup = { clase: 'ok', mensaje: `Unificado en «${d._canonico.trim()}»: ${data} ${data === 1 ? 'compra cambió' : 'compras cambiaron'}.` };
        // Las ubicaciones de las alertas pueden haber cambiado.
        const compras = await traerTodo(() => sb.from('compras').select('id, ubicacion').order('id')).catch(() => null);
        if (compras) this.ubicaciones = new Map(compras.map(c => [c.id, c.ubicacion]));
      },

      async rechazar(d) {
        d._ocupado = true;
        d._error = '';
        const { error } = await sb.rpc('fn_rechazar_duplicado', { p_id: d.id });
        if (error) {
          d._ocupado = false;
          d._error = 'No se pudo marcar: ' + await mensajeDe(error);
          return;
        }
        this.duplicados = this.duplicados.filter(x => x.id !== d.id);
      },

      async cargar() {
        try {
          const [mercados, mis, propios, alertas, compras] = await Promise.all([
            traerTodo(() => sb.from('mercados').select('id, codigo, nombre').order('id')),
            sb.rpc('fn_mis_mercados'),
            traerTodo(() => sb.from('usuario_mercados').select('mercado_id').eq('usuario_id', this.usuario.id).order('mercado_id')),
            traerTodo(() => sb.from('v_alertas').select('alerta, referencia, mercado, compra_id, material_id')
              .order('alerta').order('mercado').order('referencia')),
            traerTodo(() => sb.from('compras').select('id, ubicacion').order('id')),
          ]);
          if (mis.error) throw mis.error;
          this.mercados = mercados;
          this.misMercadoIds = (mis.data || []).map(x => (typeof x === 'object' ? Object.values(x)[0] : x)).map(Number);
          this.alertas = alertas;
          this.ubicaciones = new Map(compras.map(c => [c.id, c.ubicacion]));
          await this.cargarDuplicados();
          this.filtros.mercado = mercadoInicial(this.misMercados, propios.map(p => p.mercado_id));
          if (!this.misMercados.length) {
            this.errorCarga = 'Tu usuario no tiene mercados asignados. Pide a un administrador que te los asigne.';
          }
        } catch (e) {
          console.error(e);
          this.errorCarga = 'No se pudieron cargar las alertas: ' + (e.message || e);
        } finally {
          this.cargando = false;
        }
      },
    },

    mounted() { this.cargar(); },
  }).mount('#app');
}

iniciar();
