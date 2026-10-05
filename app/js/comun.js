// Cliente de Supabase, sesión y barra superior. Lo comparten todas las páginas.

const sb = window.supabase.createClient(
  window.OASIS_CONFIG.supabaseUrl,
  window.OASIS_CONFIG.supabaseKey
);

const ROLES_INTERNOS = ['PLANNING', 'ZB', 'LECTURA', 'ADMIN'];

// Fila de `usuarios` del login actual, o null.
// RLS solo deja leer la fila propia y solo si el usuario está activo, así que
// "sin fila" e "inactivo" se ven igual desde aquí: los dos quedan sin acceso.
async function usuarioActual() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { session: null, usuario: null };

  const { data, error } = await sb
    .from('usuarios')
    .select('id, correo, nombre, rol, activo')
    .eq('auth_user_id', session.user.id)
    .maybeSingle();

  if (error) throw error;
  const usuario = data && data.activo && ROLES_INTERNOS.includes(data.rol) ? data : null;
  return { session, usuario };
}

// Para páginas internas: sin sesión o sin acceso, vuelve al login.
async function requerirAcceso() {
  const { session, usuario } = await usuarioActual();
  if (!session || !usuario) {
    window.location.replace('index.html');
    return new Promise(() => {}); // detiene la página mientras redirige
  }
  return usuario;
}

async function salir() {
  await sb.auth.signOut();
  window.location.replace('index.html');
}

const NAVEGACION = [
  { clave: 'compras',    texto: 'Compras',    href: 'compras.html' },
  { clave: 'materiales', texto: 'Materiales', href: null },
  { clave: 'consulta',   texto: 'Consulta',   href: null },
  { clave: 'inversion',  texto: 'Inversión',  href: null },
  { clave: 'alertas',    texto: 'Alertas',    href: null },
];

function pintarBarra(contenedor, usuario, activa) {
  const nav = NAVEGACION.map(n => {
    if (!n.href) return `<span class="deshabilitado" title="Próximamente">${n.texto}</span>`;
    const clase = n.clave === activa ? ' class="activo"' : '';
    return `<a href="${n.href}"${clase}>${n.texto}</a>`;
  }).join('');

  contenedor.innerHTML = `
    <a class="marca" href="compras.html">OASIS<span>.</span></a>
    <nav>${nav}</nav>
    <div class="usuario">
      <div>
        <div class="nombre"></div>
        <div class="rol"></div>
      </div>
      <button class="salir" type="button">Salir</button>
    </div>`;
  contenedor.querySelector('.nombre').textContent = usuario.nombre;
  contenedor.querySelector('.rol').textContent = usuario.rol;
  contenedor.querySelector('.salir').addEventListener('click', salir);
}
