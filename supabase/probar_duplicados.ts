// Prueba del detector de duplicados con los datos reales, sin pasar por la
// Edge Function: mismo nucleo.ts y mismo prompt.md. Sirve para ajustar el prompt.
//
//   source .env
//   export ANTHROPIC_API_KEY=...        (o agrégala a .env)
//   npx deno run -A --node-modules-dir=none supabase/probar_duplicados.ts              # muestra las propuestas
//   npx deno run -A --node-modules-dir=none supabase/probar_duplicados.ts --guardar    # y las deja PENDIENTE
//
// Lee con postgres (salta RLS). Con --guardar reemplaza las PENDIENTE del
// mercado, igual que el botón «Analizar».

import postgres from "npm:postgres@3";
import {
  detectar, firma, FilaCompra, normalizar, proveedores, soportes, Tipo, Valor,
} from "./functions/detectar-duplicados/nucleo.ts";

const MERCADO = Deno.env.get("MERCADO") ?? "MCO";
const guardar = Deno.args.includes("--guardar");
const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY");

const sql = postgres({ ssl: "require" });   // toma PGHOST, PGUSER, etc. del entorno
const prompt = await Deno.readTextFile(new URL("./functions/detectar-duplicados/prompt.md", import.meta.url));

const [{ id: mercado }] = await sql`SELECT id FROM mercados WHERE codigo = ${MERCADO}`;
const filas = (await sql`
  SELECT c.proveedor_id, p.nombre AS proveedor, c.ubicacion, c.ciudad, c.formato
  FROM compras c JOIN proveedores p ON p.id = c.proveedor_id
  WHERE c.mercado_id = ${mercado} ORDER BY c.id`) as unknown as FilaCompra[];

for (const tipo of ["PROVEEDOR", "SOPORTE"] as Tipo[]) {
  const valores: Valor[] = tipo === "SOPORTE"
    ? soportes(filas)
    : proveedores(await sql`SELECT id, nombre FROM proveedores WHERE mercado_id = ${mercado} AND activo ORDER BY id` as any, filas);
  const resueltos = await sql`SELECT valores, estado FROM duplicados_propuestos
    WHERE mercado_id = ${mercado} AND tipo = ${tipo} AND estado IN ('UNIFICADO', 'RECHAZADO')`;
  const rechazados = resueltos.filter(r => r.estado === "RECHAZADO").map(r => r.valores);

  const t0 = Date.now();
  const { grupos, descartados } = await detectar(apiKey, prompt, tipo, valores, filas, rechazados,
    new Set(resueltos.map(r => firma(tipo, r.valores))));

  console.log(`\n=== ${tipo}: ${valores.length} analizados, ${grupos.length} grupos, ` +
    `${((Date.now() - t0) / 1000).toFixed(0)} s ===`);
  for (const g of grupos) {
    console.log(`\n[${g.confianza}] → ${g.canonico}`);
    for (const v of g.valores) {
      const extra = tipo === "SOPORTE" ? `  · ${v.proveedor} · ${v.ciudad} · ${v.compras} compras` : `  · ${v.compras} compras`;
      console.log(`    ${JSON.stringify(v.texto)}${extra}`);
    }
    console.log(`    ${g.razon}`);
  }
  for (const d of descartados) console.log(`\n  descartado (${d.motivo}): ${d.textos.join(" | ")}`);

  // Comprobaciones pedidas: ningún soporte agrupado entre ciudades distintas.
  if (tipo === "SOPORTE") {
    const mezcla = grupos.filter(g => new Set(g.valores.map(v => normalizar(v.ciudad!))).size > 1);
    console.log(`\n  Grupos con ciudades distintas: ${mezcla.length}`);
  }

  if (guardar) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM duplicados_propuestos WHERE mercado_id = ${mercado} AND tipo = ${tipo} AND estado = 'PENDIENTE'`;
      for (const g of grupos) {
        await tx`INSERT INTO duplicados_propuestos (mercado_id, tipo, valores, canonico, confianza, razon)
          VALUES (${mercado}, ${tipo}, ${tx.json(g.valores as any)}, ${g.canonico}, ${g.confianza}, ${g.razon})`;
      }
    });
    console.log(`  Guardadas ${grupos.length} propuestas PENDIENTE.`);
  }
}

await sql.end();
