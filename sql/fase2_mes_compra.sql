-- =============================================================================
-- OASIS v2.0 — Fase 2: mes de compra en las vistas de inversión
-- =============================================================================
-- Agrega al final de v_inversion_diaria, v_inversion_semanal y v_inversion_total
-- la columna mes_compra (date): primer día del mes de compras.fecha_inicio.
--
-- Dos lecturas del mismo dinero:
--   month       mes de ejecución: OASIS reparte el valor de la compra por día.
--   mes_compra  mes de compra: como el Flow y la facturación, todo el valor de
--               la compra cae en el mes en que empieza.
--
-- Las 18 columnas del contrato con BI no cambian (nombre, orden, tipo ni
-- cálculo); mes_compra va en la posición 19. La lógica del reparto no cambia.
-- fn_inversion_* devuelven la vista con SELECT *: toman la columna nueva solas.
-- Repetible.
-- =============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_inversion_diaria
WITH (security_invoker = true) AS
WITH dias AS (
    SELECT mt.id AS material_id,
           mt.compra_id,
           d.d::date AS fecha
    FROM materiales mt
    CROSS JOIN LATERAL generate_series(mt.fecha_inicio::timestamptz, mt.fecha_fin::timestamptz, '1 day'::interval) d(d)
    WHERE mt.fecha_inicio IS NOT NULL
), pesos AS (
    SELECT d.material_id,
           d.compra_id,
           d.fecha,
           1.0 / count(*) OVER (PARTITION BY d.compra_id, d.fecha)::numeric AS peso
    FROM dias d
), normalizado AS (
    SELECT p.material_id,
           p.compra_id,
           p.fecha,
           p.peso,
           sum(p.peso) OVER (PARTITION BY p.compra_id) AS peso_compra
    FROM pesos p
), corte AS (
    SELECT COALESCE(NULLIF((SELECT configuracion.valor FROM configuracion
                            WHERE configuracion.clave = 'fecha_corte'), '')::date,
                    CURRENT_DATE) AS fecha_corte
)
SELECT v.mercado AS site,
       v.cliente AS bu,
       EXTRACT(year FROM n.fecha)::integer AS year,
       EXTRACT(month FROM n.fecha)::integer AS month,
       EXTRACT(week FROM n.fecha)::integer AS week,
       n.fecha AS date,
       v.proveedor,
       v.tipo_costo,
       v.formato,
       v.valor_total,
       v.compra_codigo AS id,
       v.material_codigo AS id_ejecucion,
       v.campana,
       v.sub_campana,
       v.valor_total * n.peso / n.peso_compra / NULLIF(v.valor_total, 0::numeric) AS pct_participacion,
       round(v.valor_total * n.peso / n.peso_compra, 2) AS costo_proyectado,
       CASE WHEN n.fecha <= k.fecha_corte THEN 'EJECUTADO'::text ELSE 'PROGRAMADO'::text END AS estado,
       CASE WHEN n.fecha <= k.fecha_corte THEN round(v.valor_total * n.peso / n.peso_compra, 2)
            ELSE 0::numeric END AS costo_ejecutado,
       date_trunc('month', cm.fecha_inicio)::date AS mes_compra
FROM normalizado n
JOIN v_materiales v ON v.material_id = n.material_id
JOIN compras cm ON cm.id = v.compra_id
CROSS JOIN corte k;

-- mes_compra depende solo de la compra (id): agruparlo no parte ninguna fila.
CREATE OR REPLACE VIEW public.v_inversion_semanal
WITH (security_invoker = true) AS
SELECT site, bu, year, month, week, proveedor, tipo_costo, formato, valor_total,
       id, id_ejecucion, campana, sub_campana,
       min(date) AS fecha_inicio,
       max(date) AS fecha_fin,
       count(*) AS dias,
       sum(costo_proyectado) AS costo_proyectado,
       sum(costo_ejecutado) AS costo_ejecutado,
       mes_compra
FROM v_inversion_diaria
GROUP BY site, bu, year, month, week, proveedor, tipo_costo, formato, valor_total,
         id, id_ejecucion, campana, sub_campana, mes_compra;

CREATE OR REPLACE VIEW public.v_inversion_total
WITH (security_invoker = true) AS
SELECT site, bu, proveedor, tipo_costo, formato, valor_total,
       id, id_ejecucion, campana, sub_campana,
       min(date) AS fecha_inicio,
       max(date) AS fecha_fin,
       count(*) AS dias,
       sum(costo_proyectado) / NULLIF(valor_total, 0::numeric) AS pct_participacion,
       sum(costo_proyectado) AS costo_proyectado,
       sum(costo_ejecutado) AS costo_ejecutado,
       mes_compra
FROM v_inversion_diaria
GROUP BY site, bu, proveedor, tipo_costo, formato, valor_total,
         id, id_ejecucion, campana, sub_campana, mes_compra;

COMMIT;

-- Verificación: por mes de compra, el reparto suma el valor total de las
-- compras con materiales fechados (diferencia solo de redondeo a centavos).
-- SELECT mes_compra, sum(costo_proyectado) FROM v_inversion_diaria GROUP BY 1;
-- SELECT date_trunc('month', fecha_inicio)::date, sum(valor_total) FROM compras c
--  WHERE EXISTS (SELECT 1 FROM materiales m WHERE m.compra_id = c.id AND m.fecha_inicio IS NOT NULL)
--  GROUP BY 1;
