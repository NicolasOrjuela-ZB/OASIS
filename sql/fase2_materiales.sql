-- =============================================================================
-- OASIS v2.0 — Fase 2: pantalla de Materiales
-- =============================================================================
-- 1. grupo_tramo: cuando una campaña cruza dos compras del mismo soporte se parte
--    en un material por compra; los tramos comparten grupo_tramo.
-- 2. fn_guardar_tramos: crea un material, o lo parte en tramos, en una sola
--    transacción. Es lo que llama el panel lateral de la interfaz.
--
-- La regla "un material nunca excede su compra" se aplica en la interfaz y en
-- esta función, no como CHECK en la tabla: el Sheets todavía trae materiales
-- fuera del periodo de su compra y la carga no debe fallar por ellos.
--
-- No cambia ninguna vista ni columna de v_inversion_diaria (contrato con BI).
-- Repetible. Se ejecuta en una sola transacción.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Grupo de tramos
-- -----------------------------------------------------------------------------

ALTER TABLE public.materiales
    ADD COLUMN IF NOT EXISTS grupo_tramo uuid;

CREATE INDEX IF NOT EXISTS materiales_grupo_tramo_idx
    ON public.materiales (grupo_tramo)
    WHERE grupo_tramo IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 2. Guardar un material en uno o varios tramos
-- -----------------------------------------------------------------------------
-- p_material_id  null = material nuevo; si no, el material que se parte. Ese
--                material se queda con el tramo de su propia compra.
-- p_datos        {sub_campana_id, referencia, enlace, reporte_implementacion}:
--                lo comparten todos los tramos.
-- p_tramos       [{compra_id, fecha_inicio, fecha_fin}, …]
--
-- La letra de cada tramo nuevo es la siguiente libre de su compra. La compra se
-- bloquea mientras tanto: dos personas guardando a la vez no chocan.
-- Corre con los permisos de quien la llama (SECURITY INVOKER): RLS aplica igual
-- que en un insert directo.

CREATE OR REPLACE FUNCTION public.fn_guardar_tramos(
    p_material_id bigint,
    p_datos       jsonb,
    p_tramos      jsonb
)
RETURNS SETOF public.materiales
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_actual   materiales;
    v_grupo    uuid;
    v_mercado  smallint;
    v_sub      integer := nullif(p_datos ->> 'sub_campana_id', '')::integer;
    v_ref      text    := nullif(btrim(p_datos ->> 'referencia'), '');
    v_enlace   text    := nullif(btrim(p_datos ->> 'enlace'), '');
    v_reporte  text    := nullif(btrim(p_datos ->> 'reporte_implementacion'), '');
    v_t        jsonb;
    v_c        compras;
    v_fi       date;
    v_ff       date;
    v_prev_ff  date;
    v_sec      smallint;
    v_id       bigint;
    v_ids      bigint[] := '{}';
    v_usado    boolean := false;
BEGIN
    IF jsonb_typeof(p_tramos) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tramos) = 0 THEN
        RAISE EXCEPTION 'No hay tramos para guardar' USING ERRCODE = '22023';
    END IF;

    IF p_material_id IS NOT NULL THEN
        SELECT * INTO v_actual FROM materiales WHERE id = p_material_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'El material % no existe o no tienes permiso', p_material_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    v_grupo := CASE
        WHEN jsonb_array_length(p_tramos) > 1 THEN coalesce(v_actual.grupo_tramo, gen_random_uuid())
        ELSE v_actual.grupo_tramo
    END;

    -- Tramos en orden cronológico; no pueden pisarse entre sí.
    FOR v_t IN
        SELECT t FROM jsonb_array_elements(p_tramos) t ORDER BY (t ->> 'fecha_inicio')::date
    LOOP
        v_fi := (v_t ->> 'fecha_inicio')::date;
        v_ff := (v_t ->> 'fecha_fin')::date;

        SELECT * INTO v_c FROM compras WHERE id = (v_t ->> 'compra_id')::bigint FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'La compra % no existe o no tienes permiso', v_t ->> 'compra_id'
                USING ERRCODE = '42501';
        END IF;

        IF v_mercado IS NULL THEN
            v_mercado := v_c.mercado_id;
        ELSIF v_c.mercado_id <> v_mercado THEN
            RAISE EXCEPTION 'Los tramos son de compras de mercados distintos' USING ERRCODE = '23514';
        END IF;

        IF v_fi IS NULL OR v_ff IS NULL OR v_ff < v_fi THEN
            RAISE EXCEPTION 'Fechas inválidas en el tramo de la compra %', v_c.codigo USING ERRCODE = '23514';
        END IF;
        IF v_fi < v_c.fecha_inicio OR v_ff > v_c.fecha_fin THEN
            RAISE EXCEPTION 'La compra % cubre del % al %; el tramo va del % al %',
                v_c.codigo, v_c.fecha_inicio, v_c.fecha_fin, v_fi, v_ff
                USING ERRCODE = '23514';
        END IF;
        IF v_prev_ff IS NOT NULL AND v_fi <= v_prev_ff THEN
            RAISE EXCEPTION 'Los tramos se pisan' USING ERRCODE = '23514';
        END IF;
        v_prev_ff := v_ff;

        IF NOT v_usado AND v_actual.id IS NOT NULL AND v_c.id = v_actual.compra_id THEN
            UPDATE materiales SET
                sub_campana_id         = v_sub,
                referencia             = v_ref,
                enlace                 = v_enlace,
                reporte_implementacion = v_reporte,
                fecha_inicio           = v_fi,
                fecha_fin              = v_ff,
                grupo_tramo            = v_grupo,
                actualizado_en         = now()
            WHERE id = v_actual.id;
            v_id := v_actual.id;
            v_usado := true;
        ELSE
            SELECT coalesce(max(secuencia), 0) + 1 INTO v_sec FROM materiales WHERE compra_id = v_c.id;
            INSERT INTO materiales (
                compra_id, secuencia, sub_campana_id, referencia, enlace,
                reporte_implementacion, fecha_inicio, fecha_fin, grupo_tramo
            ) VALUES (
                v_c.id, v_sec, v_sub, v_ref, v_enlace,
                v_reporte, v_fi, v_ff, v_grupo
            )
            RETURNING id INTO v_id;
        END IF;

        v_ids := v_ids || v_id;
    END LOOP;

    IF v_actual.id IS NOT NULL AND NOT v_usado THEN
        RAISE EXCEPTION 'Ningún tramo cae en la compra del material que se parte' USING ERRCODE = '23514';
    END IF;

    -- Sub campaña: del glosario del mercado de la compra, sin su campaña OOH.
    IF v_sub IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM v_sub_campanas WHERE id = v_sub AND mercado_id = v_mercado
    ) THEN
        RAISE EXCEPTION 'La sub campaña no es del glosario de este mercado' USING ERRCODE = '23503';
    END IF;

    RETURN QUERY SELECT * FROM materiales WHERE id = ANY (v_ids) ORDER BY fecha_inicio;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_guardar_tramos(bigint, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_guardar_tramos(bigint, jsonb, jsonb) TO authenticated;

COMMIT;
