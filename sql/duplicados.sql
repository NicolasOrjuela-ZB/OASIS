-- =============================================================================
-- OASIS v2.0 — Detector de duplicados
-- =============================================================================
-- La IA propone (Edge Function detectar-duplicados), el humano confirma desde
-- Alertas. Nada se unifica sin clic.
--
-- valores: lista de objetos, uno por texto agrupado. Todos tienen `texto` (lo
-- que se muestra) y además lo que identifica las filas exactas que se tocan:
--   PROVEEDOR: {texto, proveedor_id, compras}
--   SOPORTE:   {texto, ubicacion, proveedor_id, proveedor, ciudad, formatos, compras}
-- Se guarda la identidad y no solo el texto porque hay textos con caracteres
-- invisibles (p. ej. un espacio de ancho cero) y el mismo texto en otra ciudad.
--
-- cargar_oasis.py lee las propuestas UNIFICADO y traduce lo que llega del
-- Sheets, para que la siguiente carga no deshaga la unificación.
--
-- Se ejecuta en una sola transacción. Es repetible.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.duplicados_propuestos (
    id            bigserial   PRIMARY KEY,
    mercado_id    smallint    NOT NULL REFERENCES public.mercados(id),
    tipo          text        NOT NULL CHECK (tipo IN ('SOPORTE', 'PROVEEDOR')),
    valores       jsonb       NOT NULL CHECK (jsonb_typeof(valores) = 'array' AND jsonb_array_length(valores) >= 2),
    canonico      text        NOT NULL,
    confianza     text        NOT NULL CHECK (confianza IN ('ALTA', 'MEDIA', 'BAJA')),
    razon         text,
    estado        text        NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'UNIFICADO', 'RECHAZADO')),
    creado_en     timestamptz NOT NULL DEFAULT now(),
    resuelto_en   timestamptz,
    resuelto_por  bigint      REFERENCES public.usuarios(id),
    CONSTRAINT duplicados_resuelto CHECK ((estado = 'PENDIENTE') = (resuelto_en IS NULL))
);

CREATE INDEX IF NOT EXISTS duplicados_mercado_tipo_estado
    ON public.duplicados_propuestos (mercado_id, tipo, estado);


-- -----------------------------------------------------------------------------
-- RLS: igual que compras. Internos leen las de sus mercados; LECTURA no escribe.
-- -----------------------------------------------------------------------------

ALTER TABLE public.duplicados_propuestos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lectura_mercado   ON public.duplicados_propuestos;
DROP POLICY IF EXISTS escritura_mercado ON public.duplicados_propuestos;

CREATE POLICY lectura_mercado ON public.duplicados_propuestos
    FOR SELECT TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    );

CREATE POLICY escritura_mercado ON public.duplicados_propuestos
    FOR ALL TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    )
    WITH CHECK (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    );

REVOKE ALL ON public.duplicados_propuestos FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.duplicados_propuestos TO authenticated;
GRANT USAGE ON SEQUENCE public.duplicados_propuestos_id_seq TO authenticated;


-- -----------------------------------------------------------------------------
-- Unificar: una transacción por propuesta.
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER porque desactivar un proveedor es escritura en un catálogo
-- (solo ADMIN por RLS) y PLANNING y ZB también unifican. Por eso los permisos se
-- revisan aquí, a mano: rol que escribe y mercado propio, como en compras.
--
-- SOPORTE: compras.ubicacion = canónico en las compras de cada valor (mismo
-- mercado, proveedor, ubicación y ciudad exactos).
-- PROVEEDOR: el canónico es un proveedor del mercado con ese nombre; si no
-- existe, se renombra el del grupo con más compras. Las compras de los demás
-- pasan a él y los demás quedan con activo = false.
--
-- Devuelve cuántas compras cambiaron.

CREATE OR REPLACE FUNCTION public.fn_unificar_duplicado(p_id bigint, p_canonico text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_d        duplicados_propuestos;
    v_usuario  bigint := (SELECT id FROM public.fn_usuario_actual());
    v_canon    text   := nullif(btrim(p_canonico), '');
    v_ids      integer[];
    v_destino  integer;
    v_n        integer := 0;
    v_k        integer;
    v_e        jsonb;
BEGIN
    IF coalesce((SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN'), false) = false THEN
        RAISE EXCEPTION 'Tu rol no puede unificar duplicados' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_d FROM duplicados_propuestos WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_d.mercado_id NOT IN (SELECT public.fn_mis_mercados()) THEN
        RAISE EXCEPTION 'La propuesta % no existe o no tienes permiso', p_id USING ERRCODE = '42501';
    END IF;
    IF v_d.estado <> 'PENDIENTE' THEN
        RAISE EXCEPTION 'La propuesta ya está %',
            CASE v_d.estado WHEN 'UNIFICADO' THEN 'unificada' ELSE 'rechazada' END USING ERRCODE = '23514';
    END IF;
    IF v_canon IS NULL THEN
        RAISE EXCEPTION 'El nombre canónico está vacío' USING ERRCODE = '23514';
    END IF;

    IF v_d.tipo = 'SOPORTE' THEN
        -- Un soporte es el mismo solo con el mismo proveedor.
        IF (SELECT count(DISTINCT e ->> 'proveedor_id') FROM jsonb_array_elements(v_d.valores) e) > 1 THEN
            RAISE EXCEPTION 'El grupo mezcla proveedores: unifica primero los proveedores' USING ERRCODE = '23514';
        END IF;

        FOR v_e IN SELECT * FROM jsonb_array_elements(v_d.valores) LOOP
            UPDATE compras
            SET ubicacion = v_canon, actualizado_en = now()
            WHERE mercado_id   = v_d.mercado_id
              AND proveedor_id = (v_e ->> 'proveedor_id')::integer
              AND ubicacion    = v_e ->> 'ubicacion'
              AND ciudad       = v_e ->> 'ciudad'
              AND ubicacion   <> v_canon;
            GET DIAGNOSTICS v_k = ROW_COUNT;
            v_n := v_n + v_k;
        END LOOP;

    ELSE
        v_canon := upper(v_canon);   -- los nombres de proveedor van en mayúsculas
        SELECT array_agg((e ->> 'proveedor_id')::integer) INTO v_ids
        FROM jsonb_array_elements(v_d.valores) e;

        SELECT id INTO v_destino FROM proveedores
        WHERE mercado_id = v_d.mercado_id AND nombre = v_canon;

        IF v_destino IS NULL THEN
            SELECT p.id INTO v_destino
            FROM proveedores p
            LEFT JOIN compras c ON c.proveedor_id = p.id
            WHERE p.id = ANY (v_ids) AND p.mercado_id = v_d.mercado_id
            GROUP BY p.id
            ORDER BY count(c.id) DESC, p.id
            LIMIT 1;
            IF v_destino IS NULL THEN
                RAISE EXCEPTION 'Los proveedores de la propuesta ya no existen' USING ERRCODE = '23514';
            END IF;
            UPDATE proveedores SET nombre = v_canon WHERE id = v_destino;
        END IF;

        UPDATE compras
        SET proveedor_id = v_destino, actualizado_en = now()
        WHERE mercado_id = v_d.mercado_id
          AND proveedor_id = ANY (v_ids)
          AND proveedor_id <> v_destino;
        GET DIAGNOSTICS v_n = ROW_COUNT;

        UPDATE proveedores SET activo = (id = v_destino)
        WHERE mercado_id = v_d.mercado_id
          AND (id = ANY (v_ids) OR id = v_destino);
    END IF;

    UPDATE duplicados_propuestos
    SET estado = 'UNIFICADO', canonico = v_canon,
        resuelto_en = now(), resuelto_por = v_usuario
    WHERE id = p_id;

    RETURN v_n;
END
$$;

-- "No son lo mismo". Con permisos del usuario: RLS decide.
CREATE OR REPLACE FUNCTION public.fn_rechazar_duplicado(p_id bigint)
RETURNS void
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
BEGIN
    UPDATE duplicados_propuestos
    SET estado = 'RECHAZADO', resuelto_en = now(),
        resuelto_por = (SELECT id FROM public.fn_usuario_actual())
    WHERE id = p_id AND estado = 'PENDIENTE';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'La propuesta % no está pendiente o no tienes permiso', p_id USING ERRCODE = '42501';
    END IF;
END
$$;

REVOKE ALL ON FUNCTION public.fn_unificar_duplicado(bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_rechazar_duplicado(bigint)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_unificar_duplicado(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rechazar_duplicado(bigint)       TO authenticated;

COMMIT;
