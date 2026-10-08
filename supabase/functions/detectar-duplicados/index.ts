// Edge Function detectar-duplicados.
// POST { mercado_id, tipo: "SOPORTE" | "PROVEEDOR" } con la sesión del usuario.
// Lee con el JWT de quien llama (RLS aplica), le pide al modelo los grupos,
// reemplaza las propuestas PENDIENTE de ese mercado y tipo, y devuelve cuántas.
//
// Secretos: ANTHROPIC_API_KEY. SUPABASE_URL y SUPABASE_ANON_KEY los pone Supabase.
// verify_jwt está apagado (supabase/config.toml): la sesión se verifica aquí.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  detectar, firma, FilaCompra, FilaProveedor, MODELO, proveedores, soportes, Tipo, Valor,
} from "./nucleo.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const responder = (cuerpo: unknown, estado = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Todas las filas de una consulta, de a 1000 (límite por defecto de la API).
async function traerTodo<T>(consulta: () => any): Promise<T[]> {
  const filas: T[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta().range(desde, desde + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

async function comprasDelMercado(sb: SupabaseClient, mercado: number): Promise<FilaCompra[]> {
  const filas = await traerTodo<any>(() =>
    sb.from("compras").select("id, proveedor_id, ubicacion, ciudad, formato, proveedores(nombre)")
      .eq("mercado_id", mercado).order("id"));
  return filas.map(f => ({
    proveedor_id: f.proveedor_id, proveedor: f.proveedores?.nombre ?? "",
    ubicacion: f.ubicacion, ciudad: f.ciudad, formato: f.formato,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ error: "Usa POST" }, 405);

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return responder({ error: "Falta la sesión" }, 401);

    const llave = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, llave, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: errorSesion } = await sb.auth.getUser(token);
    if (errorSesion || !user) return responder({ error: "Sesión inválida o vencida" }, 401);

    const { mercado_id, tipo } = await req.json().catch(() => ({}));
    const mercado = Number(mercado_id);
    if (!Number.isInteger(mercado) || !["SOPORTE", "PROVEEDOR"].includes(tipo)) {
      return responder({ error: "Se espera { mercado_id, tipo: SOPORTE | PROVEEDOR }" }, 400);
    }

    // Se revisa antes de llamar al modelo, para no gastar en una corrida que RLS
    // no dejaría guardar.
    const [rol, mis] = await Promise.all([sb.rpc("fn_rol_actual"), sb.rpc("fn_mis_mercados")]);
    if (rol.error) throw rol.error;
    if (mis.error) throw mis.error;
    if (!["PLANNING", "ZB", "ADMIN"].includes(rol.data)) {
      return responder({ error: "Tu rol no puede analizar duplicados" }, 403);
    }
    const misIds = (mis.data ?? []).map((x: unknown) => Number(typeof x === "object" ? Object.values(x as object)[0] : x));
    if (!misIds.includes(mercado)) return responder({ error: "No tienes acceso a ese mercado" }, 403);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return responder({ error: "Falta el secreto ANTHROPIC_API_KEY en Supabase" }, 500);

    const filas = await comprasDelMercado(sb, mercado);
    let valores: Valor[];
    if (tipo === "SOPORTE") {
      valores = soportes(filas);
    } else {
      const provs = await traerTodo<FilaProveedor>(() =>
        sb.from("proveedores").select("id, nombre").eq("mercado_id", mercado).eq("activo", true).order("id"));
      valores = proveedores(provs, filas);
    }

    const resueltos = await traerTodo<{ valores: Valor[]; estado: string }>(() =>
      sb.from("duplicados_propuestos").select("valores, estado")
        .eq("mercado_id", mercado).eq("tipo", tipo).in("estado", ["UNIFICADO", "RECHAZADO"]).order("id"));
    const firmas = new Set(resueltos.map(r => firma(tipo as Tipo, r.valores)));
    const rechazados = resueltos.filter(r => r.estado === "RECHAZADO").map(r => r.valores);

    const prompt = await Deno.readTextFile(new URL("./prompt.md", import.meta.url));
    const { grupos, descartados } = await detectar(apiKey, prompt, tipo, valores, filas, rechazados,
      firmas, Deno.env.get("MODELO_DUPLICADOS") ?? MODELO);

    // Las pendientes anteriores de este mercado y tipo se reemplazan por las nuevas.
    const borrar = await sb.from("duplicados_propuestos").delete()
      .eq("mercado_id", mercado).eq("tipo", tipo).eq("estado", "PENDIENTE");
    if (borrar.error) throw borrar.error;
    if (grupos.length) {
      const guardar = await sb.from("duplicados_propuestos").insert(
        grupos.map(g => ({ mercado_id: mercado, tipo, ...g, estado: "PENDIENTE" })));
      if (guardar.error) throw guardar.error;
    }

    return responder({ encontrados: grupos.length, analizados: valores.length, descartados });
  } catch (e) {
    console.error(e);
    return responder({ error: (e as Error).message ?? String(e) }, 500);
  }
});
