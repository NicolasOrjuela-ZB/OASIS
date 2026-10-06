-- =============================================================================
-- OASIS v2.0 — Fase 2: el valor total depende de TIEMPO
-- =============================================================================
-- Fórmula del valor total automático:
--   tiempo = 'SEMANA'  -> tarifa neta × cantidad × nro. semanas (vacío = 0)
--   cualquier otro     -> tarifa neta × cantidad
-- Recalcula valor_total_manual con la fórmula nueva y el mismo criterio de
-- siempre (difiere más de $1). No cambia ningún valor_total: solo la bandera.
-- Mismo cálculo en la interfaz (compras.js) y en cargar_oasis.py.
-- Repetible.
-- =============================================================================

BEGIN;

UPDATE public.compras c
SET valor_total_manual = n.manual
FROM (
    SELECT id,
           abs(valor_total - round(tarifa_neta * cantidad
               * CASE WHEN tiempo = 'SEMANA' THEN coalesce(nro_semanas, 0) ELSE 1 END, 2)) > 1 AS manual
    FROM public.compras
) n
WHERE n.id = c.id
  AND c.valor_total_manual IS DISTINCT FROM n.manual;

COMMIT;

-- Verificación: compras manuales y por qué.
-- SELECT codigo, tiempo, tarifa_neta, cantidad, nro_semanas, valor_total
-- FROM compras WHERE valor_total_manual ORDER BY codigo;
