# Planeador Docente Musicala

Módulo de planeación de clase integrado al HUB de Bitácoras. Permite a docentes
y coordinación crear, guardar, editar, duplicar y compartir planeaciones con la
estructura pedagógica de Musicala, más un tablero de post-its tipo kanban.

## Qué se agregó

| Archivo | Rol |
|---|---|
| `js/utils/planeador.constants.js` | Estructura pedagógica: tipos de clase, componentes, habilidades, momentos, plantillas, estados, columnas, colores y factorías de documentos. |
| `js/api/planeador.api.js` | CRUD de `planeaciones` y `planeador_postits` + **puente con los catálogos existentes**. |
| `js/views/planeador.view.js` | Vista completa: lista con filtros, formulario por bloques, detalle, tablero y datos de ejemplo. |
| `css/planeador.css` | Estilos (paleta violeta/lila/fucsia, responsive, impresión). |
| `firebase rules/firestore.rules` | Reglas para las nuevas colecciones (solo equipo admin/docente). |

Integración: nueva ruta `planeador` en `js/config.js`, `js/app.js`, `js/authz.js`
e `index.html` (chips de navegación arriba y abajo).

## Mismo lenguaje que las bitácoras (lo importante)

El planeador usa **exactamente** los mismos campos que el editor de bitácoras:

- **Categorías** (`categorias`)
- **Componente corporal** (`componenteCorporal`)
- **Componente técnico** (`componenteTecnico`)
- **Componente teórico** (`componenteTeorico`)
- **Componente de repertorio / obras** (`componenteObras`)

Cada uno es una lista multivalor (chips), igual que en bitácoras. Las opciones
salen del mismo documento `app_config/catalogos`, resueltas por **área
artística** (`musica`, `danza`, `teatro`, `artesPlasticas`) con la misma lógica
del editor: primero la matriz `…PorArte` del campo, luego el catálogo general.
Si un área aún no tiene catálogo cargado, los campos permiten escribir
libremente. 👉 Cuando agregas un ítem en **Configuración**, aparece sugerido
aquí y en las bitácoras. Función puente: `buildAreaCatalog()` en
`planeador.api.js`.

Como en el planeador no hay un estudiante seleccionado (no existe el proceso del
que las bitácoras derivan el área), el docente elige el **área artística** con
un selector; eso es lo único que filtra las listas.

Los docentes del selector también vienen de `catalogos.docentes`.

## Privacidad: cada docente ve solo lo suyo

Cada planeación y cada post-it guardan `ownerEmail` (y `ownerUid`) con el correo
de quien lo creó.

- **Docente:** solo ve, edita y borra **sus** documentos. La app consulta con
  `where("ownerEmail","==", su_correo)` y las reglas de Firestore lo exigen.
- **Admin / coordinación:** ve **todo** lo que va agregando cada usuario, con el
  filtro **"Docente"** en la vista de lista.

Esto se aplica en dos capas: la consulta del cliente (`ownerScope()` en
`planeador.view.js`) y las reglas de seguridad (`firestore.rules`). Las dos son
necesarias: la regla es la que realmente impide que un docente lea lo de otro.

> Nota: si ya tenías documentos creados **antes** de este cambio, no tendrán
> `ownerEmail` y no aparecerán para los docentes (solo para admin). Como el
> módulo es nuevo, normalmente no hay datos previos; si los hubiera, ábrelos como
> admin y vuélvelos a guardar para sellarles el dueño.

## Colecciones nuevas en Firestore

- `planeaciones` — una planeación por documento (ver forma en
  `createEmptyPlaneacion()`).
- `planeador_postits` — un post-it por documento.

Los comentarios internos de coordinación se guardan **dentro** del documento de
la planeación, en el arreglo `comentariosCoordinacion`.

## Configurar Firebase (pasos)

1. **Reglas de seguridad.** Abre la consola de Firebase → Firestore Database →
   pestaña *Rules*. Copia el contenido actualizado de
   `firebase rules/firestore.rules` y publica. Esto habilita lectura/escritura
   de `planeaciones` y `planeador_postits` solo para admin y docentes (las
   mismas reglas que ya usan las bitácoras).

2. **No requiere índices compuestos.** Las consultas usan `orderBy("updatedAt")`
   con *fallback* automático a lectura simple si el índice no existe, así que
   funciona sin configuración extra. Si Firestore te sugiere crear un índice de
   un solo campo para `updatedAt`, acéptalo (es opcional y mejora el orden).

3. **Catálogos.** Asegúrate de tener cargado `app_config/catalogos` desde la
   vista de *Configuración* (docentes y, opcionalmente, las matrices por arte).
   Sin esto, el planeador funciona igual usando las listas de respaldo.

No hay que tocar `firebase.client.js`: el planeador reutiliza la misma
instancia de Firestore y los mismos helpers.

## Probar con datos de ejemplo

En la vista **Planeador**:
- Si no hay planeaciones, el estado vacío ofrece **"Cargar datos de ejemplo"**
  (crea 3 planeaciones —incluida una de reemplazo— y 5 post-its).
- En el **Tablero**, el botón **"Datos de ejemplo"** crea post-its de muestra.

## Flujo del docente

```
Entrar → Planeador → (Plantilla o Nueva) → Componente → Objetivo y momentos
→ Materiales y evidencia → Guardar → Copiar resumen / WhatsApp → Coordinación
```

## Compartir

- **Copiar resumen**: genera el texto estándar Musicala listo para pegar.
- **WhatsApp**: abre `https://wa.me/?text=...` con el resumen codificado.
- **Imprimir / PDF**: usa el diálogo de impresión del navegador (hay estilos
  `@media print`).

## Dejar listo para el futuro

La forma del documento incluye `grupoId`, `docenteId` y campos de estado para
conectar más adelante con registros de clase o informes mensuales sin migrar
datos.
