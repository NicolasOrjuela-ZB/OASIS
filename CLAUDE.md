# OASIS v2.0

Sistema de seguimiento de pauta OOH (publicidad exterior) de Mercado Libre, operado por el equipo ZetaB. Reemplaza un sistema construido en Google Sheets. Responde siempre en español.

## Vocabulario — usarlo con precisión

- **Compra** — un paquete de OOH comprado a un proveedor: una valla, un paradero, un circuito de pantallas. Tiene ID propio (001, 002…), formato, ubicación, fechas de compra y **valor_total**. Equivale a una fila de la hoja `Flow`. Una compra es una línea de costo: el mismo paradero con arriendo y producción son dos compras distintas.
- **Material** — lo que corre sobre una compra para una sub campaña, con sus propias fechas. Una compra puede tener varios materiales (001-A, 001-B…). Equivale a una fila de la hoja `Tracking`.

No usar "ejecución" para referirse al material. La única excepción es la columna `id_ejecucion` de las vistas de inversión, que conserva ese nombre por compatibilidad con la hoja `Inversion_Daily` que consume BI.

El objetivo del sistema es saber cuánta plata corresponde a cada material, día por día, repartiendo el valor de la compra.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Base de datos | Supabase, proyecto `tjlteqhqctdtlbppigdi` (Postgres), conectado por MCP en modo lectura |
| Esquema original | `oasis_v2_esquema.sql` (vocabulario viejo; ver `migracion_vocabulario.sql`) |
| Carga desde Sheets | `cargar_oasis.py` — lee el Sheets en vivo y hace upsert |
| Credenciales Google | `credenciales_google.json` — cuenta de servicio, nunca al repositorio |
| Credenciales Postgres | `.env` — nunca al repositorio |
| Autenticación y RLS | `rls_fase2.sql` — funciones de identidad, políticas, trigger de vínculo |
| Sistema de diseño | `DISENO.md` — tokens, tipografía, componentes y pantallas de la interfaz |
| Interfaz interna | `app/` — sitio estático; login con código de 6 dígitos por correo (contraseña solo en localhost) |
| Plantilla de correo de acceso | `supabase/plantilla_codigo.html` — se pega a mano en Supabase → Authentication → Emails (Magic Link y Confirm signup) |
| Código | GitHub `NicolasOrjuela-ZB/OASIS` |
| Fuente de captura actual | Google Sheets `13Vh45CymNMntNG-EW3NQnglnfyvq39nT7nvediDTV1g` (los equipos siguen llenando ahí hasta que exista la interfaz) |

## Modelo de datos

```
mercados ──< campanas            (glosario oficial de ZetaB, no se edita aquí)
mercados ──< proveedores         (una fila por proveedor-mercado, agrupadas por grupo_id)
mercados ──< compras ──< materiales
usuarios ──< usuario_mercados    (a qué países accede cada usuario interno)
configuracion                    (clave fecha_corte: nula = hoy)
```

Siete mercados: MCO, MLB, MLM, MLA, MLC, MLU, MPE. Hoy solo hay datos de MCO.

Enums: `tipo_costo` (EXHIBICION, PRODUCCION, IMPUESTOS), `tipo_compra` (DIRECTO, BONIFICADO), `medio` (OOH, DOOH), `rol` (PLANNING, ZB, AGENCIA, PROVEEDOR, LECTURA, ADMIN).

Vistas: `v_materiales` (nivel material, con taxonomía), `v_inversion_diaria`, `v_inversion_semanal`, `v_inversion_total`, `v_alertas`, `v_cuadre`, `v_sub_campanas` (glosario de cada mercado sin su campaña OOH; para elegir sub campaña en Materiales).

**Campaña de la compra.** La fija el mercado: `mercados.campana_ooh_id` (MCO = PARQUE-FIJO). Los demás mercados aún no la tienen y no pueden crear compras. La carga avisa si el Sheets trae otra y usa la del mercado.

**Valor total.** `compras.valor_total_manual`: false = tarifa neta × cantidad, lo recalcula la interfaz; true = escrito a mano (marcado cuando difiere más de $1 de la fórmula, al migrar y al cargar). `descuento_pct` es fracción 0–1.

Cambios de Fase 2 sobre el esquema: `sql/fase2_compras.sql`.

## Reglas de negocio — no cambiar sin consultar

**Reparto de inversión.** El valor de una compra se reparte entre sus materiales según los días de calendario que ocupó cada uno. Cuando varios materiales corren el mismo día —lo normal en pantallas digitales—, el costo de ese día se divide en partes iguales entre los activos. Está en `v_inversion_diaria`. Verificación: sumar el costo de una compra por fecha da siempre `valor_total / días calendario`, constante.

**Nunca repartir por días-material.** Ese fue el modelo original y estaba mal: con materiales simultáneos cuenta el mismo día varias veces.

**Un material nunca excede su compra.** Las compras son mensuales y las campañas no respetan el calendario. Si una campaña cruza dos compras del mismo soporte, se parte en dos materiales, uno por compra: 001-A del 15 al 30 de junio bajo la compra de junio, 002-A del 1 al 15 de julio bajo la de julio. En la herramienta es **bloqueo al guardar**, no aviso. El formulario debe ofrecer crear el segundo tramo bajo la compra siguiente, buscándola por soporte y proveedor.

**Costo proyectado vs ejecutado.** Proyectado es todo el periodo. Ejecutado solo los días hasta `configuracion.fecha_corte` (nula = hoy). Ambos se reportan siempre.

**Las vistas se encadenan.** Semanal y total se agregan desde la diaria. No duplicar lógica.

**Código de material.** `compra.codigo + '-' + letra` donde la letra es la secuencia (1=A). La letra no implica orden cronológico.

**Taxonomía de 11 piezas.** Calculada en `v_materiales`. El mercado sale de la compra.

**Validaciones al capturar.** Fecha fin ≥ fecha inicio. Material dentro del periodo de su compra. Campaña y proveedor del mismo mercado que la compra (FK compuesta). Sub campaña del glosario del mismo mercado. Formato entre los que maneja ese proveedor.

## Contrato con BI

`v_inversion_diaria` es lo que consume BI. Sus 18 columnas y nombres deben mantenerse estables: site, bu, year, month, week, date, proveedor, tipo_costo, formato, valor_total, id (compra), id_ejecucion (material), campana, sub_campana, pct_participacion, costo_proyectado, estado, costo_ejecutado.

## Verificación

```sql
SELECT * FROM v_cuadre;    -- debe salir vacío: compras donde la suma no da el valor total
SELECT * FROM v_alertas;   -- pendientes de captura
```

Fase 1 validada: `v_inversion_diaria` reproduce la hoja `Inversion_Daily` con diferencia menor a $2 sobre $3.080 millones.

## Cómo cargar datos

```
source .env
python3 cargar_oasis.py --sheet 13Vh45CymNMntNG-EW3NQnglnfyvq39nT7nvediDTV1g --dry-run   # simula
python3 cargar_oasis.py --sheet 13Vh45CymNMntNG-EW3NQnglnfyvq39nT7nvediDTV1g             # carga
```

El script localiza encabezados por nombre, no por posición. Si falta uno, se detiene y dice cuál. Es repetible: hace upsert por llave natural. Detecta compras y materiales que ya no están en el Sheets pero no los borra: eso se decide a mano.

## Qué NO hacer

- **Nunca** hacer commit de `.xlsx`, `.csv`, `.env` ni `credenciales_google.json`. El `.gitignore` los excluye; no lo cambies.
- No modificar el Google Sheets. La carga es Sheets → Supabase, en una sola dirección.
- No cambiar las reglas de reparto ni el contrato con BI sin confirmar con Nicolás.
- Preferir cambios pequeños y verificables. Después de tocar vistas, correr `v_cuadre`.
- No dar de alta a alguien en un solo paso. Son dos: (1) su fila en `usuarios` con el correo exacto, **antes** de su primer login, para que el trigger complete `auth_user_id`; si entra antes, el vínculo hay que hacerlo a mano. (2) Sus filas en `usuario_mercados`. Un PLANNING o ZB sin mercados entra, ve los catálogos, pero no ve ninguna compra ni material. ADMIN no necesita mercados: ve todos.

## Estado y pendientes

**Hecho:** esquema, vistas de cálculo, carga en vivo desde Sheets, validación contra Sheets, repositorio, corrección de vocabulario, autenticación y RLS para roles internos.

**RLS:** activo con 18 políticas para roles internos (PLANNING, ZB, LECTURA, ADMIN), definidas en `rls_fase2.sql`. Catálogos: lectura para internos, escritura ADMIN. `compras` y `materiales`: según `fn_mis_mercados()`; LECTURA no escribe. `usuarios` y `usuario_mercados`: cada uno lo suyo, ADMIN todo. Las vistas tienen `security_invoker` y `anon` no tiene acceso. AGENCIA y PROVEEDOR no tienen políticas: sin acceso hasta la Fase 3. `postgres` salta RLS, así que la carga y BI no se ven afectados.

**Fase 2 (en curso):** interfaz interna para planning y ZB. Se construye con Claude Code siguiendo `DISENO.md` (pantallas Compras, Materiales, Consulta, Inversión y Alertas). El portal de proveedores pasa a la Fase 3.

**Datos por limpiar en el Sheets** (trabajo del equipo, no del sistema): 31 materiales sin fechas, 17 con sub campaña `ODM` fuera del glosario, 92 materiales fuera del periodo de su compra (el equipo los está revisando con el detalle de patrones), proveedores duplicados (`JCDECAUX`/`JCDX`, `PUBLICIDAD BARRANQUILLA`/`PUBLICIDAD BQUILLA`).

**Decisiones abiertas:** días de montaje entre campañas, reparto por share of voice, evidencias con copia propia, identidad individual de proveedores, campo que enlace los tramos de una misma campaña partida entre compras.

## Contexto del usuario

Nicolás trabaja en OOH para Mercado Libre Colombia. No es desarrollador; maneja bien Sheets y está aprendiendo el stack. Prefiere explicaciones paso a paso, respuestas directas, y que se le señalen problemas y tradeoffs con claridad en vez de validarlo todo. Las decisiones de arquitectura están documentadas y no se re-litigan salvo que él lo pida.

## Permisos de Nicolás en GCP (proyecto mbw-spl-brazil)

Editor, Create Service Accounts, Service Account Key Admin, BigQuery User, BigQuery Job User, BigQuery Connection User, BigQuery Metadata Viewer. Puede crear cuentas de servicio, llaves, Cloud SQL, Cloud Run, datasets BigQuery y habilitar APIs. No puede asignar permisos a otros ni ver facturación.
