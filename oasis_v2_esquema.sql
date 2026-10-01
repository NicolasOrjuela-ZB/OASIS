-- ============================================================================
-- OASIS v2.0 — Esquema inicial
-- Postgres 15+ / Cloud SQL
--
-- Fase 1: modelo de datos y vistas de cálculo.
-- No incluye row level security (Fase 3) ni la tabla de facturación.
--
-- Decisión de modelado registrada:
--   `materiales` representa una LÍNEA DE COSTO, no un soporte físico.
--   Un mismo paradero con arriendo y producción son dos filas con códigos
--   distintos, igual que hoy en el Flow. Si más adelante se necesita contar
--   soportes físicos, se agrega una tabla `soportes` sin tocar lo demás.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. TIPOS
-- ---------------------------------------------------------------------------

CREATE TYPE tipo_costo_enum  AS ENUM ('EXHIBICION', 'PRODUCCION', 'IMPUESTOS');
CREATE TYPE tipo_compra_enum AS ENUM ('DIRECTO', 'BONIFICADO');
CREATE TYPE medio_enum       AS ENUM ('OOH', 'DOOH');
CREATE TYPE rol_enum         AS ENUM ('PLANNING', 'ZB', 'AGENCIA', 'PROVEEDOR', 'LECTURA', 'ADMIN');


-- ---------------------------------------------------------------------------
-- 2. CATÁLOGOS
-- ---------------------------------------------------------------------------

CREATE TABLE mercados (
    id      smallserial PRIMARY KEY,
    codigo  text        NOT NULL UNIQUE,
    nombre  text        NOT NULL,
    activo  boolean     NOT NULL DEFAULT true,
    UNIQUE (id, codigo)
);

INSERT INTO mercados (codigo, nombre) VALUES
    ('MCO', 'Colombia'), ('MLB', 'Brasil'), ('MLM', 'México'),
    ('MLA', 'Argentina'), ('MLC', 'Chile'), ('MLU', 'Uruguay'), ('MPE', 'Perú');


-- Espejo del glosario oficial de ZetaB. No se edita en OASIS: se sincroniza.
CREATE TABLE campanas (
    id                  serial    PRIMARY KEY,
    mercado_id          smallint  NOT NULL REFERENCES mercados(id),
    nombre_unico        text      NOT NULL,
    nombre_calendario   text,
    categorizacion      text,
    matt_campaign_type  text,
    activo              boolean   NOT NULL DEFAULT true,
    sincronizado_en     timestamptz,
    UNIQUE (mercado_id, nombre_unico),
    UNIQUE (id, mercado_id)          -- habilita la FK compuesta de materiales
);


-- Agrupa al mismo proveedor entre países (EFECTIMEDIOS CO + EFECTIMEDIOS MX).
CREATE TABLE proveedor_grupos (
    id     serial PRIMARY KEY,
    nombre text   NOT NULL UNIQUE
);


-- Una fila por proveedor-mercado: cada país tiene su equipo local.
CREATE TABLE proveedores (
    id            serial   PRIMARY KEY,
    mercado_id    smallint NOT NULL REFERENCES mercados(id),
    nombre        text     NOT NULL,
    grupo_id      integer  REFERENCES proveedor_grupos(id),
    razon_social  text,                  -- para conciliar contra facturación
    activo        boolean  NOT NULL DEFAULT true,
    UNIQUE (mercado_id, nombre),
    UNIQUE (id, mercado_id)
);


-- ---------------------------------------------------------------------------
-- 3. NÚCLEO
-- ---------------------------------------------------------------------------

CREATE TABLE materiales (
    id              bigserial        PRIMARY KEY,
    mercado_id      smallint         NOT NULL REFERENCES mercados(id),
    codigo          text             NOT NULL,       -- 001, 002... único por mercado
    cliente         text             NOT NULL,
    campana_id      integer          NOT NULL,
    proveedor_id    integer          NOT NULL,
    tipo_compra     tipo_compra_enum NOT NULL,
    medio           medio_enum       NOT NULL,
    tipo_costo      tipo_costo_enum  NOT NULL,
    formato         text             NOT NULL,
    ubicacion       text             NOT NULL,
    ciudad          text             NOT NULL,
    trafico         numeric,
    tiempo          text,
    tarifa_bruta    numeric(16,2)    NOT NULL DEFAULT 0,
    descuento_pct   numeric(7,4)     NOT NULL DEFAULT 0,
    tarifa_neta     numeric(16,2)    NOT NULL DEFAULT 0,
    cantidad        integer          NOT NULL DEFAULT 1,
    nro_semanas     numeric(6,2),
    valor_total     numeric(16,2)    NOT NULL DEFAULT 0,
    fecha_inicio    date             NOT NULL,
    fecha_fin       date             NOT NULL,
    creado_en       timestamptz      NOT NULL DEFAULT now(),
    actualizado_en  timestamptz      NOT NULL DEFAULT now(),

    UNIQUE (mercado_id, codigo),

    -- La campaña y el proveedor deben ser del mismo mercado que el material.
    FOREIGN KEY (campana_id, mercado_id)   REFERENCES campanas(id, mercado_id),
    FOREIGN KEY (proveedor_id, mercado_id) REFERENCES proveedores(id, mercado_id),

    CONSTRAINT materiales_fechas CHECK (fecha_fin >= fecha_inicio),
    CONSTRAINT materiales_valor  CHECK (valor_total >= 0),
    CONSTRAINT materiales_desc   CHECK (descuento_pct BETWEEN 0 AND 100)
);

CREATE INDEX ON materiales (mercado_id, fecha_inicio, fecha_fin);
CREATE INDEX ON materiales (proveedor_id);


CREATE TABLE ejecuciones (
    id                      bigserial PRIMARY KEY,
    material_id             bigint    NOT NULL REFERENCES materiales(id) ON DELETE CASCADE,
    secuencia               smallint  NOT NULL,      -- 1=A, 2=B, 3=C...
    sub_campana_id          integer   REFERENCES campanas(id),
    referencia              text,
    enlace                  text,
    reporte_implementacion  text,
    evidencia_url           text,
    fecha_inicio            date,
    fecha_fin               date,
    creado_en               timestamptz NOT NULL DEFAULT now(),
    actualizado_en          timestamptz NOT NULL DEFAULT now(),

    UNIQUE (material_id, secuencia),

    CONSTRAINT ejecuciones_fechas CHECK (fecha_fin >= fecha_inicio),
    -- Las fechas son opcionales (hoy existen 36 ejecuciones sin programar),
    -- pero o van las dos o ninguna.
    CONSTRAINT ejecuciones_fechas_par CHECK (
        (fecha_inicio IS NULL) = (fecha_fin IS NULL)
    )
);

CREATE INDEX ON ejecuciones (material_id);
CREATE INDEX ON ejecuciones (fecha_inicio, fecha_fin);


-- ---------------------------------------------------------------------------
-- 4. USUARIOS Y ALCANCE
-- ---------------------------------------------------------------------------

CREATE TABLE usuarios (
    id            bigserial PRIMARY KEY,
    correo        text      NOT NULL UNIQUE,
    nombre        text      NOT NULL,
    rol           rol_enum  NOT NULL,
    proveedor_id  integer   REFERENCES proveedores(id),
    activo        boolean   NOT NULL DEFAULT true,
    creado_en     timestamptz NOT NULL DEFAULT now(),

    -- Solo el rol proveedor lleva proveedor_id, y lo lleva obligatoriamente.
    CONSTRAINT usuarios_proveedor CHECK (
        (rol = 'PROVEEDOR') = (proveedor_id IS NOT NULL)
    )
);


-- Mercados a los que accede cada usuario interno.
-- Una fila = su país. Varias filas = la excepción regional.
CREATE TABLE usuario_mercados (
    usuario_id bigint   NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    mercado_id smallint NOT NULL REFERENCES mercados(id),
    PRIMARY KEY (usuario_id, mercado_id)
);


-- ---------------------------------------------------------------------------
-- 5. CONFIGURACIÓN
-- ---------------------------------------------------------------------------

CREATE TABLE configuracion (
    clave text PRIMARY KEY,
    valor text
);

-- Vacío o nulo = usar la fecha de hoy.
-- Se fija en una fecha para cerrar un mes.
INSERT INTO configuracion (clave, valor) VALUES ('fecha_corte', NULL);


-- ---------------------------------------------------------------------------
-- 6. VISTAS DE CÁLCULO
-- ---------------------------------------------------------------------------

-- Nivel ejecución: une material y ejecución, arma el código y la taxonomía.
CREATE VIEW v_ejecuciones AS
SELECT
    e.id                                              AS ejecucion_id,
    m.id                                              AS material_id,
    mk.codigo                                         AS mercado,
    m.codigo                                          AS material_codigo,
    m.codigo || '-' || chr(64 + e.secuencia)          AS ejecucion_codigo,
    m.cliente,
    c.nombre_unico                                    AS campana,
    sc.nombre_unico                                   AS sub_campana,
    p.nombre                                          AS proveedor,
    m.medio,
    m.tipo_costo,
    m.tipo_compra,
    m.formato,
    m.ubicacion,
    m.ciudad,
    m.valor_total,
    e.referencia,
    e.enlace,
    e.reporte_implementacion,
    e.evidencia_url,
    e.fecha_inicio,
    e.fecha_fin,
    CASE WHEN e.fecha_inicio IS NULL THEN 0
         ELSE (e.fecha_fin - e.fecha_inicio) + 1 END  AS dias,
    -- Taxonomía de 11 piezas
    concat_ws('_',
        mk.codigo,
        upper(regexp_replace(m.cliente,   '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(p.nombre,    '[^A-Za-z0-9]', '', 'g')) || '-' ||
        upper(regexp_replace(m.formato,   '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(m.ciudad,    '[^A-Za-z0-9]', '', 'g')),
        upper(c.nombre_unico),
        'X',
        upper(regexp_replace(split_part(m.ubicacion, '(', 1), '[^A-Za-z0-9]', '', 'g')),
        upper(coalesce(sc.nombre_unico, '')),
        upper(regexp_replace(coalesce(e.referencia, ''), '[^A-Za-z0-9]', '', 'g')),
        m.codigo || '-' || chr(64 + e.secuencia)
    )                                                 AS taxonomia
FROM ejecuciones e
JOIN materiales  m  ON m.id  = e.material_id
JOIN mercados    mk ON mk.id = m.mercado_id
JOIN campanas    c  ON c.id  = m.campana_id
JOIN proveedores p  ON p.id  = m.proveedor_id
LEFT JOIN campanas sc ON sc.id = e.sub_campana_id;


-- Nivel día: una fila por día activo, con el reparto entre ejecuciones
-- concurrentes del mismo material.
--
-- El costo del día de un material se divide entre las ejecuciones activas
-- esa fecha. Equivale a: valor_total / dias_calendario / activas.
CREATE VIEW v_inversion_diaria AS
WITH dias AS (
    SELECT
        e.id          AS ejecucion_id,
        e.material_id,
        d::date       AS fecha
    FROM ejecuciones e
    CROSS JOIN LATERAL generate_series(e.fecha_inicio, e.fecha_fin, interval '1 day') d
    WHERE e.fecha_inicio IS NOT NULL
),
pesos AS (
    SELECT
        d.*,
        1.0 / count(*) OVER (PARTITION BY d.material_id, d.fecha) AS peso
    FROM dias d
),
normalizado AS (
    SELECT
        p.*,
        sum(p.peso) OVER (PARTITION BY p.material_id) AS peso_material
    FROM pesos p
),
corte AS (
    SELECT coalesce(
        nullif((SELECT valor FROM configuracion WHERE clave = 'fecha_corte'), '')::date,
        current_date
    ) AS fecha_corte
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
    v.material_codigo                           AS id,
    v.ejecucion_codigo                          AS id_ejecucion,
    v.campana,
    v.sub_campana,
    (v.valor_total * n.peso / n.peso_material)
        / nullif(v.valor_total, 0)              AS pct_participacion,
    round(v.valor_total * n.peso / n.peso_material, 2) AS costo_proyectado,
    CASE WHEN n.fecha <= k.fecha_corte
         THEN 'EJECUTADO' ELSE 'PROGRAMADO' END AS estado,
    CASE WHEN n.fecha <= k.fecha_corte
         THEN round(v.valor_total * n.peso / n.peso_material, 2)
         ELSE 0 END                             AS costo_ejecutado
FROM normalizado n
JOIN v_ejecuciones v ON v.ejecucion_id = n.ejecucion_id
CROSS JOIN corte k;


-- Nivel semana: agrupa los días por ejecución, año, mes y semana ISO.
-- Una semana partida entre dos meses genera dos filas.
CREATE VIEW v_inversion_semanal AS
SELECT
    site, bu, year, month, week,
    proveedor, tipo_costo, formato, valor_total,
    id, id_ejecucion, campana, sub_campana,
    min(date)                AS fecha_inicio,
    max(date)                AS fecha_fin,
    count(*)                 AS dias,
    sum(costo_proyectado)    AS costo_proyectado,
    sum(costo_ejecutado)     AS costo_ejecutado
FROM v_inversion_diaria
GROUP BY site, bu, year, month, week,
         proveedor, tipo_costo, formato, valor_total,
         id, id_ejecucion, campana, sub_campana;


-- Nivel ejecución: el total de cada ejecución.
CREATE VIEW v_inversion_total AS
SELECT
    site, bu, proveedor, tipo_costo, formato, valor_total,
    id, id_ejecucion, campana, sub_campana,
    min(date)                                      AS fecha_inicio,
    max(date)                                      AS fecha_fin,
    count(*)                                       AS dias,
    sum(costo_proyectado) / nullif(valor_total, 0) AS pct_participacion,
    sum(costo_proyectado)                          AS costo_proyectado,
    sum(costo_ejecutado)                           AS costo_ejecutado
FROM v_inversion_diaria
GROUP BY site, bu, proveedor, tipo_costo, formato, valor_total,
         id, id_ejecucion, campana, sub_campana;


-- ---------------------------------------------------------------------------
-- 7. VALIDACIONES DE CALIDAD
-- Las que hoy no existen y hay que vigilar al migrar.
-- ---------------------------------------------------------------------------

CREATE VIEW v_alertas AS
SELECT 'ejecucion sin fechas'            AS alerta, e.id::text AS referencia
FROM ejecuciones e WHERE e.fecha_inicio IS NULL
UNION ALL
SELECT 'ejecucion sin sub campaña',       e.id::text
FROM ejecuciones e WHERE e.sub_campana_id IS NULL
UNION ALL
SELECT 'ejecucion fuera del periodo de compra', e.id::text
FROM ejecuciones e
JOIN materiales m ON m.id = e.material_id
WHERE e.fecha_inicio IS NOT NULL
  AND (e.fecha_inicio < m.fecha_inicio OR e.fecha_fin > m.fecha_fin)
UNION ALL
SELECT 'material sin ejecuciones',        m.codigo
FROM materiales m
WHERE NOT EXISTS (SELECT 1 FROM ejecuciones e WHERE e.material_id = m.id)
UNION ALL
SELECT 'sub campaña de otro mercado',     e.id::text
FROM ejecuciones e
JOIN materiales m ON m.id = e.material_id
JOIN campanas  sc ON sc.id = e.sub_campana_id
WHERE sc.mercado_id <> m.mercado_id;


-- ---------------------------------------------------------------------------
-- 8. PRUEBA DE ACEPTACIÓN
-- La suma por material debe dar su valor_total.
-- ---------------------------------------------------------------------------

CREATE VIEW v_cuadre AS
SELECT
    m.codigo,
    m.valor_total,
    coalesce(sum(d.costo_proyectado), 0)                    AS asignado,
    coalesce(sum(d.costo_proyectado), 0) - m.valor_total    AS diferencia
FROM materiales m
LEFT JOIN v_inversion_diaria d ON d.id = m.codigo
GROUP BY m.id, m.codigo, m.valor_total
HAVING abs(coalesce(sum(d.costo_proyectado), 0) - m.valor_total) > 1;
