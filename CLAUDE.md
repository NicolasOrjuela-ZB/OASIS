# OASIS v2.0

Sistema de seguimiento de pauta OOH (publicidad exterior) de Mercado Libre, operado por el equipo ZetaB. Reemplaza un sistema construido en Google Sheets. Responde siempre en español.

## Qué es

Hay dos entidades centrales:

- **materiales** — una compra de pauta: una valla, un paradero, una pantalla. Tiene proveedor, formato, ubicación, fechas de compra y **valor_total**. Equivale a la hoja `Flow` del Sheets. Un material representa una línea de costo, no un soporte físico: un mismo paradero con arriendo y producción son dos materiales distintos.
- **ejecuciones** — cada uso de un material para una sub campaña, con sus propias fechas. Un material puede tener varias (001-A, 001-B…). Equivale a la hoja `Tracking`.

El objetivo del sistema es saber cuánta plata corresponde a cada ejecución, día por día, repartiendo el valor del material.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Base de datos | Supabase, proyecto `tjlteqhqctdtlbppigdi` (Postgres), conectado por MCP en modo lectura |
| Esquema | `oasis_v2_esquema.sql` — la fuente de verdad del modelo |
| Carga desde Sheets | `cargar_oasis.py` — lee un `.xlsx` exportado y hace upsert |
| Código | GitHub `NicolasOrjuela-ZB/OASIS` |
| Fuente de captura actual | Google Sheets `OASIS_FLOW_TRACKING_MCO_MERCADOLIBRE` (los equipos siguen llenando ahí hasta que exista la interfaz) |

## Modelo de datos

```
mercados ──< campanas            (glosario oficial de ZetaB, no se edita aquí)
mercados ──< proveedores         (una fila por proveedor-mercado, agrupadas por grupo_id)
mercados ──< materiales ──< ejecuciones
usuarios ──< usuario_mercados    (a qué países accede cada usuario interno)
configuracion                    (clave fecha_corte: nula = hoy)
```

Siete mercados: MCO, MLB, MLM, MLA, MLC, MLU, MPE. Hoy solo hay datos de MCO (Colombia).

Enums: `tipo_costo` (EXHIBICION, PRODUCCION, IMPUESTOS), `tipo_compra` (DIRECTO, BONIFICADO), `medio` (OOH, DOOH), `rol` (PLANNING, ZB, AGENCIA, PROVEEDOR, LECTURA, ADMIN).

## Reglas de negocio — no cambiar sin consultar

**Reparto de inversión.** El valor de un material se reparte entre sus ejecuciones según los días de calendario que ocupó cada una. Cuando varias ejecuciones corren el mismo día —lo normal en pantallas digitales—, el costo de ese día se divide en partes iguales entre las activas. Está implementado en `v_inversion_diaria`. Propiedad de verificación: sumar el costo de un material por fecha da siempre `valor_total / días calendario`, constante.

**Nunca repartir por días-ejecución.** Ese fue el modelo original y estaba mal: con ejecuciones simultáneas cuenta el mismo día varias veces e infla la curva de gasto.

**Costo proyectado vs ejecutado.** Proyectado es todo el periodo. Ejecutado solo los días hasta `configuracion.fecha_corte` (nula = hoy). Ambos se reportan siempre.

**Las vistas se encadenan.** `v_inversion_semanal` y `v_inversion_total` se agregan desde `v_inversion_diaria`. No duplicar lógica en ellas.

**Código de ejecución.** `material.codigo + '-' + letra` donde la letra es la secuencia (1=A). La letra no implica orden cronológico.

**Taxonomía de 11 piezas.** Calculada en `v_ejecuciones`. El mercado sale del material, no es fijo.

**Validaciones.** Fecha fin ≥ fecha inicio. Campaña y proveedor del mismo mercado que el material (FK compuesta). Sub campaña del glosario del mismo mercado.

## Contrato con BI

`v_inversion_diaria` es lo que consume el equipo de BI. Sus 18 columnas y nombres deben mantenerse estables: site, bu, year, month, week, date, proveedor, tipo_costo, formato, valor_total, id, id_ejecucion, campana, sub_campana, pct_participacion, costo_proyectado, estado, costo_ejecutado.

## Verificación

```sql
SELECT * FROM v_cuadre;    -- debe salir vacío: materiales donde la suma no da el valor total
SELECT * FROM v_alertas;   -- pendientes de captura: sin fechas, sin sub campaña, etc.
```

La Fase 1 está validada: `v_inversion_diaria` reproduce la hoja `Inversion_Daily` del Sheets con diferencia menor a $2 sobre $3.080 millones.

## Cómo cargar datos

La carga lee el Google Sheets en vivo; ya no hace falta exportar el `.xlsx`. Las variables de conexión a Supabase (`PGHOST`, `PGUSER`, `PGPASSWORD`, etc.) viven en `.env`.

```
source .env && python3 cargar_oasis.py --sheet 13Vh45CymNMntNG-EW3NQnglnfyvq39nT7nvediDTV1g --dry-run   # simula
source .env && python3 cargar_oasis.py --sheet 13Vh45CymNMntNG-EW3NQnglnfyvq39nT7nvediDTV1g             # carga
```

Las credenciales de la cuenta de servicio de Google viven en `credenciales_google.json`, en la raíz del proyecto. Ese archivo **nunca** va al repositorio; está en `.gitignore`.

Sigue funcionando la carga desde un archivo (`python3 cargar_oasis.py oasis.xlsx`) como respaldo.

El script localiza encabezados por nombre, no por posición. Si el Sheets cambia de layout, se adapta; si falta un encabezado, se detiene y dice cuál.

Al final imprime avisos de calidad, entre ellos:
- **Ejecuciones huérfanas**: ejecuciones cuyo material no está cargado, y materiales que siguen en la base pero ya no están en el Sheets.
- **Fechas vacías o inválidas**: ejecuciones sin fechas, con una sola fecha, con fecha escrita como texto o con fechas invertidas.

## Qué NO hacer

- **Nunca** hacer commit de archivos `.xlsx` o `.csv`: contienen inversión publicitaria confidencial. El `.gitignore` los excluye; no lo cambies.
- **Nunca** escribir credenciales en archivos del repositorio. `.env` y `credenciales_google.json` están en `.gitignore`; no los saques de ahí.
- No modificar el Google Sheets. La carga es Sheets → Supabase, en una sola dirección.
- No cambiar las reglas de reparto ni el contrato con BI sin confirmar con Nicolás.
- Preferir cambios pequeños y verificables. Después de tocar vistas, correr `v_cuadre`.

## Estado y pendientes

**Hecho:** esquema, vistas de cálculo, carga repetible, validación contra Sheets, repositorio.

**Fase 2 (siguiente):** interfaz para planning y ZB que reemplace Flow y Tracking, o portal de proveedores con autenticación y RLS. Decisión pendiente.

**Datos por limpiar en el Sheets** (no es trabajo del sistema): 31 ejecuciones sin fechas, 30 materiales sin ejecución, 17 con sub campaña `ODM` que no está en el glosario, proveedores duplicados (`JCDECAUX`/`JCDX`, `PUBLICIDAD BARRANQUILLA`/`PUBLICIDAD BQUILLA`).

**Decisiones abiertas:** días de montaje entre campañas, reparto por share of voice, evidencias con copia propia, identidad individual de proveedores.

## Contexto del usuario

Nicolás trabaja en OOH para Mercado Libre Colombia. No es desarrollador; maneja bien Sheets y está aprendiendo el stack. Prefiere explicaciones paso a paso, respuestas directas, y que se le señalen problemas y tradeoffs con claridad en vez de validarlo todo. Las decisiones de arquitectura están documentadas y no se re-litigan salvo que él lo pida.
