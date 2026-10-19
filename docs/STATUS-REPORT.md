# Reporte de estado de proyecto

Resumen de un proyecto de Linear que el bot publica en Slack. Te dice si el proyecto va al día, cuánto avance tiene, cómo van los entregables (milestones) y qué tickets están vencidos.

## Cómo pedirlo

- Escribe `/estado-proyecto [proyecto]` en cualquier canal.
- O menciona al bot: `@Pablito [proyecto]`.
- En staging el comando es `/estado-proyecto-dev`.

El nombre del proyecto no distingue mayúsculas, tildes ni espacios de más. Basta con escribir el inicio o una parte del nombre (por ejemplo `apoyo`). Si varios proyectos coinciden, el bot te pide que seas más específico. Si no encuentra ninguno, te muestra los proyectos disponibles.

Si no escribes el proyecto, el bot usa los proyectos vinculados al canal (se vinculan en el panel de administración, sección Canales). Si el canal no tiene proyectos vinculados, te responde solo a ti con la lista de proyectos disponibles.

Cuando el reporte se genera (con un proyecto indicado o en un canal con proyectos vinculados), se publica en el canal y lo ve todo el equipo. Las ayudas y los errores solo los ves tú. Los datos de Linear se guardan 60 segundos: un cambio reciente puede tardar hasta un minuto en verse.

## Ejemplo (proyecto atrasado)

```
📊 Estado de *APOYO-MAIA* — 19 oct
🔴 Atrasado · Avance 62% (31/50)

Entregables:
✅ 07 · Chat, historial y modelos — 100% (4/4)
🔵 08 · QA por módulos — 46% (12/26) · venció 16 oct ⚠️
⬜ 09 · Cierre y handoff — 0% (0/5) · vence 30 oct

Tickets vencidos (3):
• KAMAITI-44 Integrar fix de documentos — Sebastian (14 oct)
• KAMAITI-57 Corregir pnpm build — Rafhael (14 oct)
• KAMAITI-55 Procesos automáticos — Rafhael (15 oct)
```

El ID de cada ticket es un enlace a Linear. Los nombres se muestran como texto: el bot nunca menciona a nadie.

## Qué significa cada parte

### Encabezado

`📊 Estado de *Proyecto* — 19 oct`: nombre del proyecto y fecha de hoy. La fecha se calcula en la zona horaria configurada para el servicio (`STATUS_TIME_ZONE`, por defecto `America/Lima`), así que "hoy" cambia a medianoche de esa zona.

### Estado del proyecto

| Estado | Cuándo aparece |
|--------|----------------|
| 🟢 Al día | No hay tickets vencidos ni entregables vencidos. |
| 🟡 En riesgo | Hay tickets vencidos, pero ningún entregable vencido. |
| 🔴 Atrasado | Al menos un entregable tiene fecha objetivo anterior a hoy y no está al 100%. |

Si se cumplen varias condiciones, gana la más grave: un entregable vencido siempre da 🔴, aunque también haya tickets vencidos.

### Avance

`Avance 62% (31/50)`: tickets completados sobre el total de tickets del proyecto. Los tickets cancelados no cuentan, ni en el numerador ni en el total. El porcentaje es un número entero (se redondea). Un proyecto sin tickets muestra `Avance 0% (0/0)`.

### Entregables

Son los milestones del proyecto, en el mismo orden que tienen en Linear. Cada línea muestra el avance (`n/m`) calculado solo con los tickets de ese milestone, sin contar los cancelados.

| Icono | Significado |
|-------|-------------|
| ✅ | Hay tickets y todos están completados. |
| 🔵 | Hay trabajo en marcha: al menos un ticket está en progreso o completado, pero faltan otros. |
| ⬜ | Aún no empieza: ningún ticket está en progreso ni completado (o no tiene tickets). |

Al final de la línea puede aparecer la fecha objetivo del milestone:

- `· vence 30 oct`: la fecha objetivo es hoy o una fecha futura.
- `· venció 16 oct ⚠️`: la fecha objetivo ya pasó y el entregable no está completo.
- Sin fecha: el milestone no tiene fecha objetivo, o ya está completo (un entregable completado no muestra fecha).

Un milestone sin tickets aparece como `⬜ … — 0% (0/0)`. Si el proyecto no tiene milestones, la sección "Entregables" no aparece.

### Tickets vencidos

`Tickets vencidos (3):` lista los tickets con fecha de entrega anterior a hoy que no están completados ni cancelados. Un ticket que vence hoy todavía no se considera vencido.

- Orden: por fecha de entrega (el más antiguo primero) y, a igual fecha, por identificador.
- Cada línea: `• ID Título — Responsable (fecha)`. Si no hay responsable, dice `Sin asignar`.
- Los títulos se recortan a 120 caracteres.
- Se muestran como máximo 10 tickets. Si hay más, una última línea indica `+N más`; el número entre paréntesis del encabezado siempre es el total real.
- Si no hay tickets vencidos, la sección no aparece.

## Los tres estados

**Al día**

```
📊 Estado de *Gamma* — 19 oct
🟢 Al día · Avance 67% (2/3)

Entregables:
🔵 01 · Base — 67% (2/3) · vence 19 oct
```

**En riesgo**

```
📊 Estado de *Beta* — 19 oct
🟡 En riesgo · Avance 75% (3/4)

Entregables:
🔵 01 · Base — 75% (3/4) · vence 30 oct

Tickets vencidos (1):
• K-1 Late one — Luis (12 oct)
```

**Atrasado**: el ejemplo del inicio.

## Casos especiales

- **Proyecto vacío**: solo muestra el encabezado y `🟢 Al día · Avance 0% (0/0)`.
- **Un milestone vencido sin tickets** cuenta como atrasado, porque no está al 100%.
- **Más de un proyecto**: si el canal tiene varios proyectos vinculados y no indicas ninguno, el reporte trae un bloque por proyecto, ordenados por nombre y separados por una línea divisoria.
- **Proyectos muy grandes**: solo se leen los primeros 1.000 tickets. Si se alcanza ese límite, el reporte lo avisa al final.
- **Linear no disponible**: el bot responde que no pudo consultar Linear. Inténtalo de nuevo en unos minutos.

## Consejos para que el reporte sea fiel

- Mantén actualizadas las **fechas objetivo de los milestones** en Linear. Sin fecha, un entregable atrasado no se detecta.
- Mantén actualizadas las **fechas de entrega de los tickets**. Un ticket sin fecha nunca aparece como vencido.
- Pasa los tickets a **En progreso** cuando empieces a trabajarlos: así el entregable pasa de ⬜ a 🔵.
- Los tickets **cancelados no cuentan**. Si un ticket ya no aplica, cancélalo en vez de dejarlo abierto: así no frena el avance ni queda como vencido.
- Asigna un **responsable** a cada ticket para que se sepa a quién preguntar.
