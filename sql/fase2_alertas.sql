-- =============================================================================
-- OASIS v2.0 — Fase 2: pantalla de Alertas
-- =============================================================================
-- v_alertas solo traía `alerta` y `referencia` ("001-A"). Los códigos se repiten
-- entre mercados, así que la interfaz no podía filtrar por mercado ni abrir la
-- fila exacta. Se agregan al final tres columnas:
--   mercado      código del mercado de la compra (MCO, MLB…)
--   compra_id    id de la compra
--   material_id  id del material; nulo en "compra sin materiales"
--
-- Las dos primeras columnas y los textos de alerta no cambian. No toca
-- v_inversion_diaria (contrato con BI). Repetible.
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_alertas
WITH (security_invoker = true) AS
SELECT 'material sin fechas'::text AS alerta,
       c.codigo || '-' || chr(64 + mt.secuencia) AS referencia,
       m.codigo AS mercado, c.id AS compra_id, mt.id AS material_id
FROM materiales mt
JOIN compras c  ON c.id = mt.compra_id
JOIN mercados m ON m.id = c.mercado_id
WHERE mt.fecha_inicio IS NULL
UNION ALL
SELECT 'material sin sub campaña',
       c.codigo || '-' || chr(64 + mt.secuencia),
       m.codigo, c.id, mt.id
FROM materiales mt
JOIN compras c  ON c.id = mt.compra_id
JOIN mercados m ON m.id = c.mercado_id
WHERE mt.sub_campana_id IS NULL
UNION ALL
SELECT 'material fuera del periodo de su compra',
       c.codigo || '-' || chr(64 + mt.secuencia),
       m.codigo, c.id, mt.id
FROM materiales mt
JOIN compras c  ON c.id = mt.compra_id
JOIN mercados m ON m.id = c.mercado_id
WHERE mt.fecha_inicio IS NOT NULL
  AND (mt.fecha_inicio < c.fecha_inicio OR mt.fecha_fin > c.fecha_fin)
UNION ALL
SELECT 'compra sin materiales',
       c.codigo,
       m.codigo, c.id, NULL::bigint
FROM compras c
JOIN mercados m ON m.id = c.mercado_id
WHERE NOT EXISTS (SELECT 1 FROM materiales mt WHERE mt.compra_id = c.id)
UNION ALL
SELECT 'sub campaña de otro mercado',
       c.codigo || '-' || chr(64 + mt.secuencia),
       m.codigo, c.id, mt.id
FROM materiales mt
JOIN compras c   ON c.id = mt.compra_id
JOIN mercados m  ON m.id = c.mercado_id
JOIN campanas sc ON sc.id = mt.sub_campana_id
WHERE sc.mercado_id <> c.mercado_id;

COMMIT;

-- Verificación: mismo conteo por alerta que antes, y ninguna fila sin mercado.
-- SELECT alerta, count(*), count(mercado) FROM v_alertas GROUP BY 1;
