# Sistema de diseño — OASIS v2.0

Las pantallas de OASIS siguen el sistema visual del Planificador de Campañas ZetaBé y del dashboard Parque Fijo LATAM. Son la misma familia de herramientas y deben verse como tal.

Referencia de origen: el prototipo del Planificador de Campañas ZetaBé (artefacto interno, fuera de este repositorio). Esta especificación lo resume; si algo no está aquí, se decide siguiendo las reglas de uso de abajo, no consultando el prototipo.

## Carácter

Hoja de cálculo editorial. Fondo papel cálido, no blanco puro. Negro y amarillo Mercado Libre como únicos acentos fuertes. Títulos en condensada mayúscula, números en monoespaciada con dígitos tabulares. Nada de sombras suaves, bordes redondeados grandes ni degradados: las esquinas son rectas y los bordes son de 1 px.

Lo que **no** es: no es Material Design, no es shadcn, no es Tailwind por defecto. Si una herramienta genera botones redondeados azules o cards con sombra, está mal.

## Tokens

```css
:root {
  /* Superficies */
  --ground:    #F2F0EA;   /* fondo de página */
  --surface:   #FFFFFF;   /* cards, tablas, inputs */
  --calc:      #F4F1E7;   /* celdas calculadas, solo lectura */

  /* Texto */
  --ink:       #16150F;
  --ink-soft:  #4B4636;
  --muted:     #6E6858;

  /* Líneas */
  --rule:      #E0DCD0;   /* bordes principales */
  --rule-soft: #ECE9E0;   /* separadores de fila */

  /* Acentos */
  --k:         #000000;   /* negro: barra superior, encabezados de tabla, filas de total */
  --y:         #FDC62C;   /* amarillo ML: activo, primario, foco */
  --y-wash:    #FFF5D6;   /* fondo de input con foco, filas observadas */
  --y-deep:    #7A5A00;   /* amarillo oscuro para texto sobre claro */

  /* Estados */
  --err:       #B42318;  --err-wash:  #FDECEA;
  --warn:      #A14A06;  --warn-wash: #FEF1E1;
  --ok:        #2E6B34;  --ok-wash:   #E7F2E8;
}
```

Modo oscuro: el prototipo lo soporta pero OASIS v2.0 arranca solo en claro.

## Tipografía

| Uso | Fuente | Peso | Tamaño |
|---|---|---|---|
| Cuerpo, formularios, tablas | Mulish | 400–700 | 12–13 px en tablas, 14–15 en texto |
| Títulos de pantalla y de card | Sofia Sans Extra Condensed | 800, mayúsculas | 34 px pantalla, 26 px card |
| Números, códigos, fechas, etiquetas pequeñas | JetBrains Mono | 400–500 | 9.5–12 px, `font-variant-numeric: tabular-nums` |

Carga desde Google Fonts:
```
https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@700;800&family=Mulish:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap
```

Los códigos de compra y material (`001`, `001-A`), los montos y las fechas van siempre en JetBrains Mono. El texto descriptivo —ubicación, nombre de campaña— va en Mulish.

## Componentes

### Barra superior
Fondo `--k`, altura mínima 50 px, texto blanco. Contiene: marca, navegación principal, migas de pan, usuario.
- Ítem de navegación: 12.5 px, bold, color `#D8D3C4`; activo en `--y` con subrayado de 2 px del mismo color.
- Migas: 12 px, `#A39D8B`, con el nivel actual en `--y` bold.
- Usuario: dos líneas, nombre y rol, 12 y 11 px.

### Título de pantalla
Sofia Sans Extra Condensed 800, 34 px, mayúsculas, línea de 0.95. Encima puede ir un eyebrow en JetBrains Mono 11 px, espaciado 0.16 em, `--muted`.

### Pestañas
Borde 1 px `--rule`, 12 px bold, texto `--muted`, fondo `--surface`. Activa: fondo `--k`, texto `--y`. Pegadas entre sí (margen −1 px).

### Card
Fondo `--surface`, borde 1 px `--rule`, **borde superior de 4 px en `--k`**. Encabezado con padding 12 × 14, título en condensada 26 px, separador inferior 1 px. Sin radio, sin sombra.

### KPIs
Franja horizontal con borde `--rule`. Cada KPI: etiqueta 9.5 px mayúscula espaciada en `--muted`, valor en JetBrains Mono. Separados por línea vertical `--rule-soft`.

### Tabla
- `th`: fondo `--k`, texto `#F5F3EC`, 10 px, bold, mayúsculas, espaciado 0.06 em. Columnas calculadas con texto en `--y`.
- `td`: 12 px, padding 6 × 10, borde inferior `--rule-soft`, sin ajuste de línea.
- Celda calculada: fondo `--calc`, texto `--ink-soft`.
- Celda numérica: JetBrains Mono, alineada a la derecha.
- Celda con error: fondo `--err-wash`, línea inferior de 2 px en `--err`.
- Fila de subtotal: fondo `#F7F5EF`, bold.
- Fila de total: fondo `--k`, texto claro, bold; los montos destacados en `--y`.
- Primeras columnas pegajosas (sticky) en tablas anchas.

### Inputs dentro de tabla
Sin borde, sin fondo, altura 31 px, padding 0 × 9. Al enfocar, fondo `--y-wash`. Numéricos alineados a la derecha en monoespaciada. El input vive dentro de la celda; la celda es el contenedor visual.

### Inputs fuera de tabla
Borde 1 px `--rule`, altura 32 px, fondo `--surface`. Deshabilitado: fondo `--calc`, borde transparente.

### Etiqueta de campo
11 px, bold, mayúsculas, espaciado 0.06 em, `--muted`, 14 px de margen arriba.

### Botones
12.5 px, bold, padding 9 × 14, borde 1 px `--rule`, fondo `--surface`. Hover: borde `--k`.
- **Primario** (`.p`): fondo `--y`, borde `--k`. Hover: `#FFD24D`.
- Foco visible: contorno 2 px `--k` o `--y`, desplazado 1–2 px.
- Sin iconos salvo que aporten; el texto basta.

### Alertas en línea
Borde izquierdo 4 px, padding 10 × 14, fondo `--surface`, 12.5 px.
- Error: borde `--err`, fondo `--err-wash`.
- Advertencia: borde `--warn`, fondo `--warn-wash`.
- Neutra: borde `--k`.

### Pills de estado
JetBrains Mono 10.5 px, padding 2 × 8, radio completo. Validado en `--ok` sobre `--ok-wash`; propuesto en `--y-deep` sobre `--y-wash`; pendiente en `--err` sobre `--err-wash`.

### Calendario
Celdas de 28 px de ancho, 30 px de alto. Encabezado de día 9.5 px en dos líneas (día de semana, número). Fines de semana con fondo `#F8F6F0` en cuerpo y `#26241E` en encabezado. Cambio de mes con borde izquierdo `#CFCABB`. Día activo marcado con `--y`; día compartido entre varias campañas con rayado diagonal `--y` / `#D6D1C3`.

### Login
Dos columnas: izquierda `--k` con la marca y una frase en `#A39D8B`; derecha el formulario centrado, máximo 520 px.

## Reglas de uso

1. **El amarillo es escaso.** Solo para lo activo, lo primario y el foco. Nunca como fondo de sección ni como decoración.
2. **El negro estructura.** Barra superior, encabezados de tabla, filas de total, borde superior de card. Es lo que hace que una pantalla se lea como parte del sistema.
3. **Las celdas calculadas se ven distintas.** Fondo `--calc`. El usuario tiene que saber de un vistazo qué puede editar y qué no.
4. **Los números siempre en monoespaciada y alineados a la derecha.** Sin excepciones, incluidos códigos y fechas.
5. **Los errores se marcan en la celda**, no solo en un mensaje general. Fondo rojo claro y línea inferior roja.
6. **Nada de modales para capturar.** Las compras y los materiales se editan en tabla. Los modales solo para confirmaciones.

## Pantallas de la Fase 2 (interfaz interna)

| Pantalla | Equivale a | Componentes |
|---|---|---|
| Compras | Flow | Card con tabla editable; una fila por compra; filtros por mes, proveedor, tipo de costo; KPIs de total y cantidad |
| Materiales | Tracking | Card con tabla editable; una fila por material; columnas calculadas de compra en `--calc`; calendario a la derecha; validación de fechas en celda |
| Consulta | Vista | Tabla de solo lectura con los mismos filtros; exportar a CSV |
| Inversión | Inversion_total / semanal / diaria | Tres pestañas sobre la misma card; totales en fila negra |
| Alertas | v_alertas | Lista agrupada por tipo con enlace a la fila que falla |

Cada pantalla lleva la barra superior, el título condensado y una card. Las tablas editables siguen el patrón de tabla editable: inputs sin borde dentro de la celda, calculadas en `--calc`, errores en la celda.
