-- =============================================================================
-- OASIS v2.0 — Fase 2: autenticación y RLS para roles internos
-- =============================================================================
-- Roles internos: PLANNING, ZB, LECTURA, ADMIN.
-- AGENCIA y PROVEEDOR quedan sin políticas (sin acceso) hasta la Fase 3.
--
-- El rol postgres (carga desde Sheets, conexiones directas) tiene BYPASSRLS:
-- nada de esto lo afecta.
--
-- Se ejecuta en una sola transacción. Es repetible: borra y recrea lo suyo.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Vínculo entre el login de Supabase y la tabla usuarios
-- -----------------------------------------------------------------------------

ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;


-- -----------------------------------------------------------------------------
-- 2. Funciones de identidad
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER: leen usuarios y usuario_mercados saltándose RLS. Sin eso,
-- las políticas de usuarios se llamarían a sí mismas en bucle.
-- search_path fijo en public, y además todo va calificado con esquema.

-- Fila de usuarios del login actual. Solo usuarios activos: un usuario
-- desactivado queda sin acceso a todo.
CREATE OR REPLACE FUNCTION public.fn_usuario_actual()
RETURNS SETOF public.usuarios
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT u.*
    FROM public.usuarios u
    WHERE u.auth_user_id = auth.uid()
      AND u.activo
$$;

-- Rol del login actual (nulo si no hay usuario activo vinculado).
-- Atajo para que las políticas se lean más fácil.
CREATE OR REPLACE FUNCTION public.fn_rol_actual()
RETURNS public.rol_enum
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT rol FROM public.fn_usuario_actual()
$$;

-- Mercados a los que accede el login actual. ADMIN ve todos.
CREATE OR REPLACE FUNCTION public.fn_mis_mercados()
RETURNS SETOF smallint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT m.id
    FROM public.mercados m
    WHERE public.fn_rol_actual() = 'ADMIN'
    UNION
    SELECT um.mercado_id
    FROM public.usuario_mercados um
    JOIN public.fn_usuario_actual() u ON u.id = um.usuario_id
$$;

REVOKE ALL ON FUNCTION public.fn_usuario_actual() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_rol_actual()     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mis_mercados()   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_usuario_actual() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rol_actual()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mis_mercados()   TO authenticated;


-- -----------------------------------------------------------------------------
-- 3. Políticas
-- -----------------------------------------------------------------------------
-- Todas aplican solo al rol authenticated (anon no tiene ninguna).
-- Las llamadas a funciones van dentro de (SELECT ...) para que Postgres las
-- evalúe una vez por consulta y no una vez por fila.

-- 3.1 Catálogos: lectura para internos activos, escritura solo ADMIN ----------

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['mercados', 'campanas', 'proveedores', 'proveedor_grupos', 'configuracion']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS lectura_internos ON public.%I', t);
        EXECUTE format('DROP POLICY IF EXISTS escritura_admin  ON public.%I', t);

        EXECUTE format($p$
            CREATE POLICY lectura_internos ON public.%I
                FOR SELECT TO authenticated
                USING ((SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN'))
        $p$, t);

        EXECUTE format($p$
            CREATE POLICY escritura_admin ON public.%I
                FOR ALL TO authenticated
                USING      ((SELECT public.fn_rol_actual()) = 'ADMIN')
                WITH CHECK ((SELECT public.fn_rol_actual()) = 'ADMIN')
        $p$, t);
    END LOOP;
END
$$;

-- 3.2 compras: por mercado -----------------------------------------------------

DROP POLICY IF EXISTS lectura_mercado   ON public.compras;
DROP POLICY IF EXISTS escritura_mercado ON public.compras;

CREATE POLICY lectura_mercado ON public.compras
    FOR SELECT TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    );

-- USING filtra qué filas se pueden modificar o borrar; WITH CHECK impide
-- mover una compra a un mercado ajeno o crearla allí.
CREATE POLICY escritura_mercado ON public.compras
    FOR ALL TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    )
    WITH CHECK (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND mercado_id IN (SELECT public.fn_mis_mercados())
    );

-- 3.3 materiales: el mercado sale de su compra ---------------------------------

DROP POLICY IF EXISTS lectura_mercado   ON public.materiales;
DROP POLICY IF EXISTS escritura_mercado ON public.materiales;

CREATE POLICY lectura_mercado ON public.materiales
    FOR SELECT TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN')
        AND EXISTS (
            SELECT 1 FROM public.compras c
            WHERE c.id = materiales.compra_id
              AND c.mercado_id IN (SELECT public.fn_mis_mercados())
        )
    );

CREATE POLICY escritura_mercado ON public.materiales
    FOR ALL TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND EXISTS (
            SELECT 1 FROM public.compras c
            WHERE c.id = materiales.compra_id
              AND c.mercado_id IN (SELECT public.fn_mis_mercados())
        )
    )
    WITH CHECK (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'ADMIN')
        AND EXISTS (
            SELECT 1 FROM public.compras c
            WHERE c.id = materiales.compra_id
              AND c.mercado_id IN (SELECT public.fn_mis_mercados())
        )
    );

-- 3.4 usuarios: cada uno su fila; ADMIN todo -----------------------------------

DROP POLICY IF EXISTS lectura_propia  ON public.usuarios;
DROP POLICY IF EXISTS escritura_admin ON public.usuarios;

CREATE POLICY lectura_propia ON public.usuarios
    FOR SELECT TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN')
        AND auth_user_id = (SELECT auth.uid())
    );

CREATE POLICY escritura_admin ON public.usuarios
    FOR ALL TO authenticated
    USING      ((SELECT public.fn_rol_actual()) = 'ADMIN')
    WITH CHECK ((SELECT public.fn_rol_actual()) = 'ADMIN');

-- 3.5 usuario_mercados: cada uno sus filas; ADMIN todo -------------------------

DROP POLICY IF EXISTS lectura_propia  ON public.usuario_mercados;
DROP POLICY IF EXISTS escritura_admin ON public.usuario_mercados;

CREATE POLICY lectura_propia ON public.usuario_mercados
    FOR SELECT TO authenticated
    USING (
        (SELECT public.fn_rol_actual()) IN ('PLANNING', 'ZB', 'LECTURA', 'ADMIN')
        AND usuario_id = (SELECT id FROM public.fn_usuario_actual())
    );

CREATE POLICY escritura_admin ON public.usuario_mercados
    FOR ALL TO authenticated
    USING      ((SELECT public.fn_rol_actual()) = 'ADMIN')
    WITH CHECK ((SELECT public.fn_rol_actual()) = 'ADMIN');


-- -----------------------------------------------------------------------------
-- 4. Vistas: que respeten RLS
-- -----------------------------------------------------------------------------
-- Hoy las vistas corren con los permisos de su dueño (postgres, que salta RLS),
-- y anon y authenticated tienen SELECT sobre ellas. Es decir: cualquiera con la
-- llave pública del proyecto puede leer v_inversion_diaria completa por la API.
--
-- security_invoker hace que la vista aplique el RLS de quien consulta. No cambia
-- columnas ni cálculos: el contrato con BI queda igual. postgres sigue viendo todo.

ALTER VIEW public.v_materiales        SET (security_invoker = true);
ALTER VIEW public.v_inversion_diaria  SET (security_invoker = true);
ALTER VIEW public.v_inversion_semanal SET (security_invoker = true);
ALTER VIEW public.v_inversion_total   SET (security_invoker = true);
ALTER VIEW public.v_alertas           SET (security_invoker = true);
ALTER VIEW public.v_cuadre            SET (security_invoker = true);

REVOKE ALL ON public.v_materiales, public.v_inversion_diaria, public.v_inversion_semanal,
              public.v_inversion_total, public.v_alertas, public.v_cuadre
    FROM anon;


-- -----------------------------------------------------------------------------
-- 5. Vínculo automático al primer login
-- -----------------------------------------------------------------------------
-- Cuando Supabase crea un usuario en auth.users, se busca su correo en usuarios
-- (sin distinguir mayúsculas) y se completa auth_user_id. Si el correo no está
-- en usuarios, no pasa nada: ese login queda sin acceso.

CREATE OR REPLACE FUNCTION public.fn_vincular_usuario_auth()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.usuarios
    SET auth_user_id = NEW.id
    WHERE lower(correo) = lower(NEW.email)
      AND auth_user_id IS NULL;
    RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.fn_vincular_usuario_auth() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vincular_usuario_auth ON auth.users;
CREATE TRIGGER vincular_usuario_auth
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.fn_vincular_usuario_auth();


-- -----------------------------------------------------------------------------
-- 6. Primer usuario: Nicolás, ADMIN, con acceso a MCO
-- -----------------------------------------------------------------------------

INSERT INTO public.usuarios (correo, nombre, rol, activo)
VALUES ('nicolas.orjuela@zetabe.com', 'Nicolás Orjuela', 'ADMIN', true)
ON CONFLICT (correo) DO UPDATE SET rol = 'ADMIN', activo = true;

INSERT INTO public.usuario_mercados (usuario_id, mercado_id)
SELECT u.id, m.id
FROM public.usuarios u, public.mercados m
WHERE u.correo = 'nicolas.orjuela@zetabe.com'
  AND m.codigo = 'MCO'
ON CONFLICT DO NOTHING;

COMMIT;
