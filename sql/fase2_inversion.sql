-- =============================================================================
-- OASIS v2.0 — Fase 2: lectura de las vistas de inversión desde la interfaz
-- =============================================================================
-- Con RLS, el planificador estima ~4 compras visibles (son cientos), elige
-- nested loops y las vistas de inversión pasan de 0,5 s a 14 s. El rol
-- `authenticated` tiene statement_timeout de 8 s: la interfaz no podía leerlas.
--
-- Estas funciones devuelven la vista tal cual, sin cambiar su lógica:
--   - SECURITY INVOKER: corren como el usuario, RLS aplica igual que en la vista.
--   - SET enable_nestloop = off: solo dentro de la función, fuerza hash joins.
-- La interfaz las llama con sb.rpc(...); filtros, orden y paginación se aplican
-- encima, como en una vista.
--
-- No cambia ninguna vista. BI sigue leyendo v_inversion_diaria directamente (sin
-- RLS, no le pasa esto). Repetible.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_inversion_diaria()
RETURNS SETOF public.v_inversion_diaria
LANGUAGE sql STABLE SECURITY INVOKER
SET enable_nestloop = off
AS $$ SELECT * FROM public.v_inversion_diaria $$;

CREATE OR REPLACE FUNCTION public.fn_inversion_semanal()
RETURNS SETOF public.v_inversion_semanal
LANGUAGE sql STABLE SECURITY INVOKER
SET enable_nestloop = off
AS $$ SELECT * FROM public.v_inversion_semanal $$;

CREATE OR REPLACE FUNCTION public.fn_inversion_total()
RETURNS SETOF public.v_inversion_total
LANGUAGE sql STABLE SECURITY INVOKER
SET enable_nestloop = off
AS $$ SELECT * FROM public.v_inversion_total $$;

REVOKE ALL ON FUNCTION public.fn_inversion_diaria(), public.fn_inversion_semanal(),
                       public.fn_inversion_total() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_inversion_diaria(), public.fn_inversion_semanal(),
                          public.fn_inversion_total() TO authenticated;

COMMIT;

-- Verificación (como usuario autenticado): mismas filas que la vista, en < 1 s.
-- SELECT count(*), sum(costo_proyectado) FROM fn_inversion_diaria();
