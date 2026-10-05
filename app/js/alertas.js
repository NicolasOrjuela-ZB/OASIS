// Pantalla de Alertas: lo que falta o está mal en la captura, desde v_alertas.
// Solo lectura. Cada referencia abre su fila en Compras o Materiales; la
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
      total() { return this.grupos.reduce((s, g) => s + g.casos.length, 0); },
    },

    watch: {
      'filtros.mercado'(id) { guardarMercadoActivo(id ? this.mercadosPorId.get(id).codigo : ''); },
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
