-- ============================================================================
-- OASIS v2.0 — Corrección de vocabulario
--
-- Lo que se llamaba `materiales` es en realidad una COMPRA: un paquete de OOH
-- con su ID propio (001, 002...). Lo que se llamaba `ejecuciones` es el
-- MATERIAL: lo que corre sobre esa compra (001-A, 001-B...).
--
-- Los datos no se tocan. Solo cambian nombres de tablas, una columna y las
-- vistas. RLS se conserva.
--
-- Excepción deliberada: las columnas de salida de v_inversion_diaria,
-- v_inversion_semanal y v_inversion_total conservan `id` e `id_ejecucion`
-- porque replican la hoja Inversion_Daily del Sheets, que es el contrato
-- con BI. Internamente todo usa el vocabulario correcto.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Quitar las vistas (dependen de las tablas y se recrean abajo)
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS v_cuadre, v_alertas, v_inversion_total,
                    v_inversion_semanal, v_inversion_diaria, v_ejecuciones CASCADE;


-- ---------------------------------------------------------------------------
-- 2. Renombrar tablas (con paso intermedio para que no choquen)
-- ---------------------------------------------------------------------------

ALTER TABLE ejecuciones RENAME TO materiales_tmp;
ALTER TABLE materiales  RENAME TO compras;
ALTER TABLE materiales_tmp RENAME TO materiales;


-- ---------------------------------------------------------------------------
-- 3. Renombrar la columna de relación
-- ---------------------------------------------------------------------------

ALTER TABLE materiales RENAME COLUMN material_id TO compra_id;


-- ---------------------------------------------------------------------------
-- 4. Renombrar las restricciones con nombre propio
-- (las automáticas —pkey, fkey, key— conservan el nombre viejo; es cosmético)
-- ---------------------------------------------------------------------------

ALTER TABLE compras    RENAME CONSTRAINT materiales_fechas      TO compras_fechas;
ALTER TABLE compras    RENAME CONSTRAINT materiales_valor       TO compras_valor;
ALTER TABLE compras    RENAME CONSTRAINT materiales_desc        TO compras_desc;
ALTER TABLE materiales RENAME CONSTRAINT ejecuciones_fechas     TO materiales_fechas;
ALTER TABLE materiales RENAME CONSTRAINT ejecuciones_fechas_par TO materiales_fechas_par;


-- ---------------------------------------------------------------------------
-- 5. Recrear las vistas con el vocabulario correcto
-- ---------------------------------------------------------------------------

-- Nivel material: une compra y material, arma el código y la taxonomía.
CREATE VIEW v_materiales AS
SELECT
    mt.id                                             AS material_id,
    c.id                                              AS compra_id,
    mk.codigo                                         AS mercado,
    c.codigo                                          AS compra_codigo,
    c.codigo || '-' || chr(64 + mt.secuencia)         AS material_codigo,
    c.cliente,
    ca.nombre_unico                                   AS campana,
    sc.nombre_unico                                   AS sub_campana,
    p.nombre                                          AS proveedor,
    c.medio,
    c.tipo_costo,
    c.tipo_compra,
    c.formato,
    c.ubicacion,
    c.ciudad,
    c.valor_total,
    mt.referencia,
    mt.enlace,
    mt.reporte_implementacion,
    mt.evidencia_url,
    mt.fecha_inicio,
    mt.fecha_fin,
    CASE WHEN mt.fecha_inicio IS NULL THEN 0
         ELSE (mt.fecha_fin - mt.fecha_inicio) + 1 END AS dias,
    concat_ws('_',
        mk.codigo,
        upper(regexp_replace(c.cliente,   '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(p.nombre,    '[^A-Za-z0-9]', '', 'g')) || '-' ||
        upper(regexp_replace(c.formato,   '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(c.ciudad,    '[^A-Za-z0-9]', '', 'g')),
        upper(ca.nombre_unico),
        'X',
        upper(regexp_replace(split_part(c.ubicacion, '(', 1), '[^A-Za-z0-9]', '', 'g')),
        upper(coalesce(sc.nombre_unico, '')),
        upper(regexp_replace(coalesce(mt.referencia, ''), '[^A-Za-z0-9]', '', 'g')),
        c.codigo || '-' || chr(64 + mt.secuencia)
    )                                                 AS taxonomia
FROM materiales  mt
JOIN compras     c  ON c.id  = mt.compra_id
JOIN mercados    mk ON mk.id = c.mercado_id
JOIN campanas    ca ON ca.id = c.campana_id
JOIN proveedores p  ON p.id  = c.proveedor_id
LEFT JOIN campanas sc ON sc.id = mt.sub_campana_id;


-- Nivel día. El costo del día de una compra se divide entre los materiales
-- activos esa fecha.
--
-- Las columnas `id` e `id_ejecucion` conservan el nombre de la hoja
-- Inversion_Daily por compatibilidad con BI: `id` es la compra,
-- `id_ejecucion` es el material.
CREATE VIEW v_inversion_diaria AS
WITH dias AS (
    SELECT mt.id AS material_id, mt.compra_id, d::date AS fecha
    FROM materiales mt
    CROSS JOIN LATERAL generate_series(mt.fecha_inicio, mt.fecha_fin, interval '1 day') d
    WHERE mt.fecha_inicio IS NOT NULL
),
pesos AS (
    SELECT d.*, 1.0 / count(*) OVER (PARTITION BY d.compra_id, d.fecha) AS peso
    FROM dias d
),
normalizado AS (
    SELECT p.*, sum(p.peso) OVER (PARTITION BY p.compra_id) AS peso_compra
    FROM pesos p
),
corte AS (
    SELECT coalesce(
        nullif((SELECT valor FROM configuracion WHERE clave = 'fecha_corte'), '')::date,
        current_date) AS fecha_corte
)
SELECT
    v.mercado                                   AS site,
    v.cliente                                   AS bu,
    extract(year  FROM n.fecha)::int            AS year,
    extract(month FROM n.fecha)::int            AS month,
    extract(week  FROM n.fecha)::int            AS week,
    n.fecha                                     AS date,
    v.proveedor,
    v.tipo_costo,
    v.formato,
    v.valor_total,
    v.compra_codigo                             AS id,              -- compra
    v.material_codigo                           AS id_ejecucion,    -- material
    v.campana,
    v.sub_campana,
    (v.valor_total * n.peso / n.peso_compra)
        / nullif(v.valor_total, 0)              AS pct_participacion,
    round(v.valor_total * n.peso / n.peso_compra, 2) AS costo_proyectado,
    CASE WHEN n.fecha <= k.fecha_corte
         THEN 'EJECUTADO' ELSE 'PROGRAMADO' END AS estado,
    CASE WHEN n.fecha <= k.fecha_corte
         THEN round(v.valor_total * n.peso / n.peso_compra, 2)
         ELSE 0 END                             AS costo_ejecutado
FROM normalizado n
JOIN v_materiales v ON v.material_id = n.material_id
CROSS JOIN corte k;


CREATE VIEW v_inversion_semanal AS
SELECT site, bu, year, month, week,
       proveedor, tipo_costo, formato, valor_total,
       id, id_ejecucion, campana, sub_campana,
       min(date) AS fecha_inicio, max(date) AS fecha_fin, count(*) AS dias,
       sum(costo_proyectado) AS costo_proyectado,
       sum(costo_ejecutado)  AS costo_ejecutado
FROM v_inversion_diaria
GROUP BY site, bu, year, month, week, proveedor, tipo_costo, formato,
         valor_total, id, id_ejecucion, campana, sub_campana;


CREATE VIEW v_inversion_total AS
SELECT site, bu, proveedor, tipo_costo, formato, valor_total,
       id, id_ejecucion, campana, sub_campana,
       min(date) AS fecha_inicio, max(date) AS fecha_fin, count(*) AS dias,
       sum(costo_proyectado) / nullif(valor_total, 0) AS pct_participacion,
       sum(costo_proyectado) AS costo_proyectado,
       sum(costo_ejecutado)  AS costo_ejecutado
FROM v_inversion_diaria
GROUP BY site, bu, proveedor, tipo_costo, formato, valor_total,
         id, id_ejecucion, campana, sub_campana;


-- Pendientes de captura.
CREATE VIEW v_alertas AS
SELECT 'material sin fechas' AS alerta,
       c.codigo || '-' || chr(64 + mt.secuencia) AS referencia
FROM materiales mt JOIN compras c ON c.id = mt.compra_id
WHERE mt.fecha_inicio IS NULL
UNION ALL
SELECT 'material sin sub campaña',
       c.codigo || '-' || chr(64 + mt.secuencia)
FROM materiales mt JOIN compras c ON c.id = mt.compra_id
WHERE mt.sub_campana_id IS NULL
UNION ALL
SELECT 'material fuera del periodo de su compra',
       c.codigo || '-' || chr(64 + mt.secuencia)
FROM materiales mt JOIN compras c ON c.id = mt.compra_id
WHERE mt.fecha_inicio IS NOT NULL
  AND (mt.fecha_inicio < c.fecha_inicio OR mt.fecha_fin > c.fecha_fin)
UNION ALL
SELECT 'compra sin materiales', c.codigo
FROM compras c
WHERE NOT EXISTS (SELECT 1 FROM materiales mt WHERE mt.compra_id = c.id)
UNION ALL
SELECT 'sub campaña de otro mercado',
       c.codigo || '-' || chr(64 + mt.secuencia)
FROM materiales mt
JOIN compras  c  ON c.id  = mt.compra_id
JOIN campanas sc ON sc.id = mt.sub_campana_id
WHERE sc.mercado_id <> c.mercado_id;


-- Prueba de aceptación: la suma por compra debe dar su valor_total.
CREATE VIEW v_cuadre AS
SELECT c.codigo, c.valor_total,
       coalesce(sum(d.costo_proyectado), 0) AS asignado,
       coalesce(sum(d.costo_proyectado), 0) - c.valor_total AS diferencia
FROM compras c
LEFT JOIN v_inversion_diaria d ON d.id = c.codigo
GROUP BY c.id, c.codigo, c.valor_total
HAVING abs(coalesce(sum(d.costo_proyectado), 0) - c.valor_total) > 1;


-- ---------------------------------------------------------------------------
-- 6. Verificación
-- ---------------------------------------------------------------------------

-- Debe listar: campanas, compras, configuracion, materiales, mercados,
-- proveedor_grupos, proveedores, usuario_mercados, usuarios, y las seis vistas.
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY 1;

-- Los conteos no deben cambiar respecto a antes de la migración.
SELECT (SELECT count(*) FROM compras)             AS compras,
       (SELECT count(*) FROM materiales)          AS materiales,
       (SELECT count(*) FROM v_inversion_diaria)  AS filas_diarias;


-- ---------------------------------------------------------------------------
-- 7. v_cuadre solo evalúa compras con al menos un material con fechas
--
-- Las compras sin materiales, o cuyos materiales no tienen fechas, ya
-- aparecen en v_alertas como pendientes de captura. Aquí solo interesa
-- detectar repartos que no suman el valor total.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_cuadre AS
SELECT c.codigo, c.valor_total,
       coalesce(sum(d.costo_proyectado), 0) AS asignado,
       coalesce(sum(d.costo_proyectado), 0) - c.valor_total AS diferencia
FROM compras c
LEFT JOIN v_inversion_diaria d ON d.id = c.codigo
WHERE EXISTS (SELECT 1 FROM materiales mt
              WHERE mt.compra_id = c.id AND mt.fecha_inicio IS NOT NULL)
GROUP BY c.id, c.codigo, c.valor_total
HAVING abs(coalesce(sum(d.costo_proyectado), 0) - c.valor_total) > 1;
