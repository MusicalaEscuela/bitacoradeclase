# Migraciones

Scripts en `firebase-sync/migrations/`. Todos son idempotentes, corren en
`--dry-run` por defecto, **nunca borran documentos** y generan reporte JSON en
`firebase-sync/migrations/reports/`.

## Autenticación (sin claves en el repo)

```bash
gcloud auth application-default login
# o exportar GOOGLE_APPLICATION_CREDENTIALS hacia una clave FUERA del repo
cd "firebase-sync/migrations"
npm install
```

La cuenta usada necesita permiso de lectura/escritura Firestore
(`roles/datastore.user`) en el proyecto correspondiente a cada script.

## Orden y comandos (dry-run)

El orden importa. Los backfills son **POST** y el token va SOLO por header
(nunca en query string). El token anterior está comprometido: rotarlo antes.

```bash
# 1. Lista — dry-run
node migrate-lista.js --dry-run
# 2. REVISIÓN MANUAL de conflictos (mismatches) y duplicados del reporte.

# 3. Backfill de identidades (Cloud Function ya desplegada; puebla rip/students)
curl -X POST -H "x-sync-token: $BACKFILL_TOKEN" \
  "https://us-central1-estudiantes-musicala.cloudfunctions.net/backfillStudentIdentity?limit=5000"

# 4. RIP — dry-run (usa el directorio local creado en el paso 3)
node migrate-rip.js --dry-run
# 5. REVISIÓN MANUAL de ambiguos (homónimos) del reporte.

# 6. Backfill de estado RIP → Bitácoras
curl -X POST -H "x-sync-token: $BACKFILL_TOKEN" \
  "https://us-central1-rip-musicala.cloudfunctions.net/backfillStudentStatus?limit=5000"

# 7. Bitácoras — dry-run
node migrate-bitacoras.js --dry-run

# 8. Saneamiento de aliases sensibles (documento fuera de todos los destinos)
node sanitize-sensitive-aliases.js --dry-run

# 9. Prueba integral del HUB (checklist en DEPLOYMENT.md).
```

`--apply` ejecuta las escrituras. **NO ejecutar `--apply` sobre producción sin
autorización explícita y sin haber revisado el reporte del dry-run.**
Todas soportan `--limit=N` para ensayos parciales y son reejecutables sin
duplicar. Ningún reporte imprime números de documento.

## Qué hace cada script

### migrate-lista.js (estudiantes-musicala)
- `studentId = doc.id` donde falte; `normalizedName`, `schemaVersion: 2`,
  `identitySource`. **Nunca escribe `documentFingerprint`**: la huella oficial
  (HMAC + `fingerprintVersion: 2`) la calcula exclusivamente el backend en el
  backfill; la migración solo usa una huella temporal EN MEMORIA para agrupar
  duplicados en el reporte, y cuenta los docs con SHA legado pendientes de
  recálculo (`legacyShaPendingRecompute`).
- Reporta (sin corregir) documentos con `studentId !== doc.id`.
- Conserva `contactId`.
- Duplicados: por correo, por huella de documento y (señal secundaria) por
  nombre+fecha de nacimiento. Solo reporte; jamás fusiona.

### migrate-rip.js (rip-musicala)
- Resuelve el canónico por: `officialStudentId` → correo → documento (huella
  en aliases) → alias heredado → nombre normalizado único.
- `students` legados: anota `officialStudentId` + `legacyAliasOf`.
- `registro`, `primeraVez`: añade `studentId` donde falte.
- `clientesB2C`: añade `studentId` a cada usuario del arreglo.
- `programacion`: crea `programacion/{studentId}` espejo si no existe y marca
  el legado con `legacyAliasOf` (conserva ambos).
- `studentComputed`: anota `canonicalStudentId` y crea espejo canónico.
- Reporte con `resolved`, `unresolved[]`, `ambiguous[]` (homónimos: nunca
  adivina).

### migrate-bitacoras.js (bitacoras-de-clase)
- `students`: asegura `studentId = doc.id` en canónicos; en legados resuelve
  vía `sourceDocId` (guardado por el sync anterior) o aliases y marca
  `legacyAliasOf`. Nada se borra: rutas, progreso, comentarios, evidencias y
  permisos no se tocan.
- `users`: agrega el canónico a `studentIds` conservando todos los alias;
  fija `studentId` primario si es único.
- `bitacoras`: agrega el canónico a `studentIds` y fija `studentId`
  primario en bitácoras de un solo estudiante (el anterior queda en
  `legacyPrimaryStudentId`).
- Ambiguos → reporte, sin fusionar.

### sanitize-sensitive-aliases.js (rip-musicala + bitacoras-de-clase)
- Retira el número de documento de `students.aliases`/`studentIds` (RIP),
  `students.studentIds`, `users.studentIds`/`students` y
  `bitacoras.studentIds` (Bitácoras), por valor exacto (leído de la Lista,
  solo en memoria) y por patrón.
- Conserva el studentId canónico y todos los aliases no sensibles; nunca deja
  un vínculo vacío (esos casos van a `manualReview` del reporte).
- No borra información académica. El reporte solo trae conteos e IDs de
  documentos Firestore, jamás números de documento.

## Reejecución

Correr dos veces cualquier script (o los backfills) produce el mismo estado:
solo se escriben campos faltantes/derivados con `merge`, con los mismos
valores. Los reportes de cada corrida quedan fechados en `reports/`.

## Rollback

- Ningún script borra ni renombra: el rollback es dejar de usar los campos
  nuevos. Los documentos legados conservan su contenido original más los
  campos añadidos (`officialStudentId`, `legacyAliasOf`, `migratedAt`).
- Para revertir la publicación de estado: deshabilitar `syncStudentStatus`
  (o `RIP_TARGET_ENABLED=false` en el sync de identidad para RIP) y, si se
  desea, eliminar el mapa `rip` con un script inverso (no incluido a
  propósito: requiere decisión explícita).
- Las funciones anteriores (`mirrorStudentToBitacoras`,
  `backfillStudentsToBitacoras`) pueden restaurarse desde git
  (`firebase-sync/functions/index.js` en el commit previo).

## Casos que la migración deja para revisión manual

- `studentId !== doc.id` en Lista (reporte `mismatches`).
- Homónimos sin correo/alias diferenciador (`ambiguous`).
- Registros históricos cuyo nombre no existe en el directorio de identidades
  (`unresolved`) — típicamente estudiantes que nunca pasaron por el
  Formulario v2; decidir si se crean en Lista o se dejan como legado.
