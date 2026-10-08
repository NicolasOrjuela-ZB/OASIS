// Lógica del detector de duplicados, sin HTTP ni base de datos: la usan la
// Edge Function (index.ts) y la prueba local (supabase/probar_duplicados.ts).
//
// Al modelo se le manda cada texto con un número y devuelve números, no textos:
// así un texto con caracteres invisibles o mal copiado no se pierde en el camino.
// Las reglas que no dependen del criterio del modelo (mismo proveedor, misma
// ciudad, dos o más valores) se vuelven a revisar aquí, en código.

import Anthropic from "npm:@anthropic-ai/sdk@^0.131.0";

export const MODELO = "claude-sonnet-4-6";

export type Tipo = "SOPORTE" | "PROVEEDOR";
export type Confianza = "ALTA" | "MEDIA" | "BAJA";

// Lo que se guarda en duplicados_propuestos.valores (ver sql/duplicados.sql).
export interface Valor {
  texto: string;
  proveedor_id: number;
  compras: number;
  ubicacion?: string;
  proveedor?: string;
  ciudad?: string;
  formatos?: string[];
}

export interface Grupo {
  valores: Valor[];
  canonico: string;
  confianza: Confianza;
  razon: string;
}

// Filas que llegan de la base.
export interface FilaCompra {
  proveedor_id: number;
  proveedor: string;
  ubicacion: string;
  ciudad: string;
  formato: string;
}
export interface FilaProveedor {
  id: number;
  nombre: string;
}

// Mayúsculas, sin tildes, sin caracteres invisibles ni espacios dobles.
// BOGOTA y BOGOTÁ son la misma ciudad.
export function normalizar(s: string): string {
  return (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ").trim().toUpperCase();
}

// Identidad de un valor: lo que se compara para no volver a proponer algo resuelto.
export function clave(tipo: Tipo, v: Valor): string {
  return tipo === "SOPORTE" ? `${v.proveedor_id}|${v.ubicacion}|${v.ciudad}` : String(v.proveedor_id);
}

// SOPORTE: uno por (proveedor, ubicación, ciudad) exactos, con sus formatos.
export function soportes(filas: FilaCompra[]): Valor[] {
  const porClave = new Map<string, Valor>();
  for (const f of filas) {
    const k = `${f.proveedor_id}|${f.ubicacion}|${f.ciudad}`;
    let v = porClave.get(k);
    if (!v) {
      v = { texto: f.ubicacion, ubicacion: f.ubicacion, proveedor_id: f.proveedor_id,
            proveedor: f.proveedor, ciudad: f.ciudad, formatos: [], compras: 0 };
      porClave.set(k, v);
    }
    v.compras++;
    if (f.formato && !v.formatos!.includes(f.formato)) v.formatos!.push(f.formato);
  }
  return [...porClave.values()].sort((a, b) =>
    a.proveedor!.localeCompare(b.proveedor!) || a.ubicacion!.localeCompare(b.ubicacion!));
}

// PROVEEDOR: uno por proveedor activo, con cuántas compras tiene.
export function proveedores(provs: FilaProveedor[], filas: FilaCompra[]): Valor[] {
  const compras = new Map<number, number>();
  for (const f of filas) compras.set(f.proveedor_id, (compras.get(f.proveedor_id) ?? 0) + 1);
  return provs
    .map(p => ({ texto: p.nombre, proveedor_id: p.id, compras: compras.get(p.id) ?? 0 }))
    .sort((a, b) => a.texto.localeCompare(b.texto));
}

// Contexto extra por proveedor para el modelo: ciudades y algunas ubicaciones.
function contextoProveedor(id: number, filas: FilaCompra[]) {
  const propias = filas.filter(f => f.proveedor_id === id);
  const ciudades = [...new Set(propias.map(f => normalizar(f.ciudad)))].sort();
  const ubicaciones = [...new Set(propias.map(f => f.ubicacion))].slice(0, 6);
  return { ciudades, ubicaciones };
}

// Mensaje para el modelo: los elementos numerados y los grupos ya rechazados.
export function mensaje(tipo: Tipo, valores: Valor[], filas: FilaCompra[], rechazados: number[][]): string {
  const lineas = valores.map((v, i) => JSON.stringify(
    tipo === "SOPORTE"
      ? { id: i + 1, ubicacion: v.ubicacion, proveedor: v.proveedor, ciudad: v.ciudad,
          formatos: v.formatos, compras: v.compras }
      : { id: i + 1, proveedor: v.texto, compras: v.compras, ...contextoProveedor(v.proveedor_id, filas) },
  ));
  let m = `Tipo: ${tipo}\n\nElementos (${valores.length}), uno por línea:\n${lineas.join("\n")}\n`;
  if (rechazados.length) {
    m += `\nGrupos que una persona ya revisó y dijo que NO son lo mismo. No los propongas otra vez:\n`;
    m += rechazados.map(g => `- [${g.join(", ")}]`).join("\n") + "\n";
  }
  return m;
}

const ESQUEMA = {
  type: "object",
  properties: {
    grupos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "integer" } },
          canonico: { type: "string" },
          confianza: { type: "string", enum: ["ALTA", "MEDIA", "BAJA"] },
          razon: { type: "string" },
        },
        required: ["ids", "canonico", "confianza", "razon"],
        additionalProperties: false,
      },
    },
  },
  required: ["grupos"],
  additionalProperties: false,
};

interface GrupoModelo { ids: number[]; canonico: string; confianza: Confianza; razon: string }

export async function preguntarModelo(
  apiKey: string, prompt: string, contenido: string, modelo = MODELO,
): Promise<GrupoModelo[]> {
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: modelo,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: prompt,
    messages: [{ role: "user", content: contenido }],
    // medium: con high, el lote más grande se acercaba al límite de tiempo de la
    // Edge Function sin mejorar los grupos.
    output_config: { effort: "medium", format: { type: "json_schema", schema: ESQUEMA } },
  });
  const r = await stream.finalMessage();
  if (r.stop_reason === "refusal") throw new Error("El modelo no respondió la solicitud (refusal).");
  if (r.stop_reason === "max_tokens") throw new Error("La respuesta del modelo quedó cortada (max_tokens).");
  const texto = r.content.find(b => b.type === "text");
  if (!texto || texto.type !== "text") throw new Error("El modelo no devolvió texto.");
  return JSON.parse(texto.text).grupos;
}

export interface Descartado { textos: string[]; motivo: string }

// Convierte la respuesta del modelo en grupos válidos. Descarta, con motivo:
// ids que no existen o repetidos en otro grupo, grupos de menos de dos, soportes
// de distinto proveedor o distinta ciudad, y grupos idénticos a uno ya resuelto.
export function validar(
  tipo: Tipo, valores: Valor[], respuesta: GrupoModelo[], resueltos: Set<string>,
): { grupos: Grupo[]; descartados: Descartado[] } {
  const grupos: Grupo[] = [];
  const descartados: Descartado[] = [];
  const usados = new Set<number>();

  for (const g of respuesta) {
    const ids = [...new Set(g.ids)].filter(i => i >= 1 && i <= valores.length && !usados.has(i));
    const vs = ids.map(i => valores[i - 1]);
    const textos = vs.map(v => v.texto);

    if (vs.length < 2) {
      if (g.ids.length >= 2) descartados.push({ textos, motivo: "quedó con menos de dos valores" });
      continue;
    }
    if (tipo === "SOPORTE") {
      if (new Set(vs.map(v => v.proveedor_id)).size > 1) {
        descartados.push({ textos, motivo: "mezcla proveedores" });
        continue;
      }
      if (new Set(vs.map(v => normalizar(v.ciudad!))).size > 1) {
        descartados.push({ textos, motivo: "mezcla ciudades" });
        continue;
      }
      // BOGOTA y BOGOTÁ con la misma ubicación: unificar la ubicación no cambia nada.
      if (new Set(vs.map(v => v.ubicacion)).size === 1) {
        descartados.push({ textos, motivo: "misma ubicación; solo cambia cómo se escribe la ciudad" });
        continue;
      }
    }
    const firma = vs.map(v => clave(tipo, v)).sort().join("\n");
    if (resueltos.has(firma)) {
      descartados.push({ textos, motivo: "ya fue unificado o rechazado" });
      continue;
    }

    ids.forEach(i => usados.add(i));
    const masUsado = [...vs].sort((a, b) => b.compras - a.compras)[0].texto;
    grupos.push({
      valores: vs,
      canonico: g.canonico.trim() || masUsado,
      confianza: g.confianza,
      razon: g.razon.trim(),
    });
  }
  return { grupos, descartados };
}

// Firma de un grupo ya guardado, para comparar con `validar`.
export function firma(tipo: Tipo, valores: Valor[]): string {
  return valores.map(v => clave(tipo, v)).sort().join("\n");
}

// Grupos rechazados expresados con los números de esta corrida (los que aún existen).
export function rechazadosComoIds(tipo: Tipo, valores: Valor[], rechazados: Valor[][]): number[][] {
  const pos = new Map(valores.map((v, i) => [clave(tipo, v), i + 1]));
  return rechazados
    .map(g => g.map(v => pos.get(clave(tipo, v))).filter((x): x is number => x !== undefined))
    .filter(g => g.length >= 2);
}

// Análisis completo de un tipo. SOPORTE va en una llamada por proveedor, en
// paralelo: un soporte solo se agrupa dentro de su proveedor, así que partir no
// pierde grupos, y con todo junto el modelo tardaba más de lo que dura una
// Edge Function (~7 min con 142 soportes).
export async function detectar(
  apiKey: string, prompt: string, tipo: Tipo, valores: Valor[], filas: FilaCompra[],
  rechazados: Valor[][], resueltos: Set<string>, modelo = MODELO,
): Promise<{ grupos: Grupo[]; descartados: Descartado[] }> {
  const lotes = new Map<number, Valor[]>();
  for (const v of valores) {
    const k = tipo === "SOPORTE" ? v.proveedor_id : 0;
    if (!lotes.has(k)) lotes.set(k, []);
    lotes.get(k)!.push(v);
  }
  const resultados = await Promise.all([...lotes.values()]
    .filter(lote => lote.length >= 2)
    .map(async lote => {
      const ids = rechazadosComoIds(tipo, lote, rechazados);
      const respuesta = await preguntarModelo(apiKey, prompt, mensaje(tipo, lote, filas, ids), modelo);
      return validar(tipo, lote, respuesta, resueltos);
    }));
  return {
    grupos: resultados.flatMap(r => r.grupos),
    descartados: resultados.flatMap(r => r.descartados),
  };
}
