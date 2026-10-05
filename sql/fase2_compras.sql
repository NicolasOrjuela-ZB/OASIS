-- =============================================================================
-- OASIS v2.0 — Fase 2: ajustes de compras tras la primera prueba de la interfaz
-- =============================================================================
-- 1. Campaña OOH por mercado: la campaña de una compra la fija su mercado.
--    v_sub_campanas deja el glosario sin esa campaña, para Materiales.
-- 5. valor_total_manual: valor total escrito a mano en vez de tarifa neta × cantidad.
-- 6. descuento_pct es una fracción (0,15 = 15 %): la regla pasa a 0–1.
--
-- No cambia ninguna columna de v_inversion_diaria (contrato con BI).
-- Repetible. Se ejecuta en una sola transacción.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Campaña OOH del mercado
-- -----------------------------------------------------------------------------

ALTER TABLE public.mercados
    ADD COLUMN IF NOT EXISTS campana_ooh_id integer REFERENCES public.campanas(id);

-- Además, la campaña OOH tiene que ser del glosario del mismo mercado.
ALTER TABLE public.mercados DROP CONSTRAINT IF EXISTS mercados_campana_ooh_mismo_mercado;
ALTER TABLE public.mercados
    ADD CONSTRAINT mercados_campana_ooh_mismo_mercado
    FOREIGN KEY (campana_ooh_id, id) REFERENCES public.campanas(id, mercado_id);

UPDATE public.mercados m
SET campana_ooh_id = c.id
FROM public.campanas c
WHERE m.codigo = 'MCO'
  AND c.mercado_id = m.id
  AND c.nombre_unico = 'PARQUE-FIJO';

-- Glosario de cada mercado sin su campaña OOH: las sub campañas posibles de un material.
CREATE OR REPLACE VIEW public.v_sub_campanas
WITH (security_invoker = true) AS
SELECT
    c.id,
    c.mercado_id,
    mk.codigo           AS mercado,
    c.nombre_unico,
    c.nombre_calendario,
    c.categorizacion,
    c.matt_campaign_type,
    c.activo
FROM public.campanas c
JOIN public.mercados mk ON mk.id = c.mercado_id
WHERE c.id IS DISTINCT FROM mk.campana_ooh_id;

-- Supabase da por defecto todos los permisos a anon y authenticated: solo lectura.
REVOKE ALL ON public.v_sub_campanas FROM anon, authenticated;
GRANT SELECT ON public.v_sub_campanas TO authenticated;


-- -----------------------------------------------------------------------------
-- 5. Valor total manual
-- -----------------------------------------------------------------------------
-- false: valor_total = tarifa_neta × cantidad, lo recalcula la interfaz.
-- true:  valor_total escrito a mano; la interfaz no lo toca.

ALTER TABLE public.compras
    ADD COLUMN IF NOT EXISTS valor_total_manual boolean NOT NULL DEFAULT false;

-- Las compras heredadas del Sheets cuyo valor no sale de la fórmula.
-- Mismo criterio que cargar_oasis.py.
UPDATE public.compras
SET valor_total_manual = true
WHERE abs(valor_total - round(tarifa_neta * cantidad, 2)) > 1;


-- -----------------------------------------------------------------------------
-- 6. Descuento como fracción
-- -----------------------------------------------------------------------------

ALTER TABLE public.compras DROP CONSTRAINT IF EXISTS compras_desc;
ALTER TABLE public.compras
    ADD CONSTRAINT compras_desc CHECK (descuento_pct BETWEEN 0 AND 1);

COMMIT;
