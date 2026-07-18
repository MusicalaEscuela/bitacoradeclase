# Contrato de datos

## 1. Identidad mínima (estudiantes-musicala/estudiantes/{studentId})

```js
{
  studentId: "aB3xK9mP2vR7sT4wX8",   // == ID del documento (canónico)
  studentName: "Nombre completo",     // campo real existente del formulario
  normalizedName: "nombre completo normalizado",
  contactId: "UUID heredado",         // alias secundario, NO oficial
  documentFingerprint: "hmac-hex",    // huella HMAC v2, escrita SOLO por backend
  fingerprintVersion: 2,              // sin este campo la huella NO es definitiva
  documentShaLegacy: "sha-hex",       // apoyo de migración; NUNCA es la huella oficial
  schemaVersion: 2,
  identitySource: "estudiantes-musicala",
  createdAt: Timestamp,
  updatedAt: Timestamp,
  // ...resto de campos del formulario (studentEmail, birthDate, course,
  // instrument, guardián, etc.) sin cambios.
}
```

- Si un documento trae `studentId !== doc.id`, NO se sobrescribe: se conserva
  y queda `studentIdConflict {expected, found, detectedAt}` para revisión
  (el sync y la migración lo reportan; la autoridad final es el ID de la ruta).
- `studentDocument` (número de documento) es dato privado: no viaja a
  Bitácoras, no aparece en rutas/URLs/logs. Para duplicados se usa
  `documentFingerprint` = HMAC-SHA256("musicala:doc:v2:" + documento
  normalizado, DOC_INDEX_SECRET), calculada SOLO en backend y válida
  únicamente con `fingerprintVersion: 2` (ver sección 7). Un SHA sin llave
  solo puede existir como `documentShaLegacy` y nunca cuenta como huella.

## 2. Identidad publicada por Lista

### rip-musicala/students/{studentId}
```js
{
  studentId, officialStudentId: studentId,
  name, estudiante: name,                 // compat
  nameKey, estudianteKey, normalizedName, // alias de nombre
  emails: [...], email,
  contactId,
  aliases: [...],                         // IDs heredados NO sensibles (el documento JAMÁS)
  identitySource: "estudiantes-musicala",
  schemaVersion: 2, identityUpdatedAt, updatedAt, createdAt
}
```
Además, si existe un doc legado `students/{nameKey}`, se le anota
`officialStudentId` (no se crean stubs nuevos por nombre).

### bitacoras-de-clase/students/{studentId}
```js
{
  // planos de compatibilidad (identidad)
  studentId, studentKey: studentId, id: studentId,
  studentIds: [canónico + aliases],
  nombre, name, normalizedName, email, emails, contactId,
  edad, intereses*, area, programa, instrumento, modalidad, sede,
  docente, teacher, acudiente, processes[], sourceDocId, sourceRow,
  schemaVersion: 2,
  identity: { name, normalizedName, emails, contactId, source, updatedAt },
  // SOLO si el doc aún no tiene rip.statusVersion (transición):
  estado, status, active
}
```

### bitacoras-de-clase/users/{email}
```js
{
  email, role: "student",
  studentId,               // canónico
  studentIds: [...],       // canónico + aliases
  displayName,
  // Propiedad de RIP cuando statusSource == "rip-musicala":
  active, studentStatus, statusSource, statusVersion
}
```

**Lista NUNCA escribe:** estado oficial, `active` (si RIP ya lo gobierna),
saldo, clases pagadas/tomadas, última/próxima clase, permisos derivados.

## 3. Estado publicado por RIP

### rip-musicala/studentComputed/{key}
Campos existentes (sin cambios de cálculo): `studentId`, `estudiante`,
`saldo`, `totalClases`, `totalPagos`, `ultimaClase`, `ultimoPago`,
`clasificacionFinal`, `programacionStatus`, `nextClassDate`,
`futureClassCount`, `cursos[]`, `instrumentos[]`, `estilos[]`, `enfasis[]`.
Nuevos: `canonicalStudentId` (lo consume syncStudentStatus), `estudianteKey`,
`schemaVersion: 2`.

Mapeo hacia el contrato pedido: `statusLabel=clasificacionFinal`,
`balance=saldo` (solo interno RIP), `takenClasses=totalClases`,
`lastClassDate=ultimaClase`, `lastPaymentDate=ultimoPago`,
`remainingClasses=saldo`, `curso/instrumento/estilo/enfasis = cursos[0]/...`
(se conservan los nombres en español existentes).

### Proyección RIP → bitacoras-de-clase/students/{studentId}.rip
```js
{
  studentId, statusCode, statusLabel, statusReason,
  active, canAccessHub, showInTeacherLists, canReceiveBitacoras,
  lastClassDate, nextClassDate, remainingClasses,
  curso, instrumento, estilo, enfasis, cursos[], instrumentos[], estilos[],
  ripUpdatedAt, statusSource: "rip-musicala", statusVersion, schemaVersion: 2
}
```
**Prohibido en la proyección:** saldo en dinero, pagos, medios de pago,
movimientos, totales financieros. (Verificado por prueba unitaria.)

RIP también actualiza los planos `estado/status/active/showInTeacherLists`
del doc y `users.{active,studentStatus,statusSource}` de los usuarios
vinculados (`studentIds array-contains studentId`).

## 4. Entidades de RIP

Toda entidad nueva relacionada con un estudiante guarda:
```js
{ studentId: "ID_CANONICO" | "",   // vacío solo si no se pudo resolver sin ambigüedad
  estudiante: "Nombre visible",
  estudianteKey: "nombre normalizado" }   // alias de compatibilidad
```
Aplica a: `registro`, `primeraVez`, `clientesB2C.usuarios[]`, `programacion`,
`studentComputed`, `students`. Las llaves de documento siguen siendo el
nameKey hasta que la migración cree los espejos canónicos; los docs legados
quedan con `officialStudentId`/`legacyAliasOf`.

## 5. Bitácoras nuevas (bitacoras-de-clase/bitacoras)

```js
{
  studentId,                 // primario canónico
  studentIds: [studentId, ...],  // incluye alias para compat de reglas/consultas
  primaryStudentId,          // se mantiene por compat (== studentId)
  studentNameSnapshot,       // nombre congelado al momento de escribir
  teacherId,                 // uid del autor
  teacherEmail,              // correo del autor
  date, fechaClase,          // misma fecha (alias)
  author, process, docentes, tags, attachments, studentOverrides, // existentes
  mode, studentRefs,         // grupales: sin cambios
  createdAt, updatedAt, schemaVersion: 2
}
```

## 6. Aliases obsoletos (no retirar hasta verificar datos reales)

`officialStudentId`, `estudianteKey`, `nameKey`, `studentKey`, `contactId`,
`legacyStudentKey` (`stu_nombre_fila`), documento como llave, `sourceRow`.
Se aceptan en lectura/consulta; ninguna escritura nueva debe crearlos como
identidad. Marcados en código con comentarios "alias/compatibilidad".

## 7. Documento de identidad: huella HMAC e índice privado (v2)

- La huella oficial se calcula SOLO en backend dentro de `syncStudentIdentity`:
  `HMAC-SHA256("musicala:doc:v2:" + documentoNormalizado, DOC_INDEX_SECRET)`
  con el secreto en **Secret Manager** (`firebase functions:secrets:set
  DOC_INDEX_SECRET`). El SHA del navegador quedó como campo legado
  (`documentShaLegacy`) solo para migración; ya no se usa.
- Índice privado `estudiantes-musicala/student_document_index/{fingerprint}`
  (reglas: `allow read, write: if false` — solo Admin SDK), mantenido por
  transacción.
- Duplicado por documento → el doc del estudiante queda con
  `identityHold: true` + `possibleDuplicateOf` y **NO se sincroniza** a RIP ni
  Bitácoras hasta que administración retire el hold.
- Ni el documento ni la huella se publican jamás en RIP, Bitácoras, usuarios,
  rutas, logs ni mensajes de error.

## 8. Aliases sensibles: PROHIBIDOS

El número de documento **nunca** es alias. `normalizeStudent` filtra valores
exactos y por patrón (`filterSensitiveAliases`) en `studentIds`, `aliases` y
`users.studentIds`. Los residuos históricos los limpia
`firebase-sync/migrations/sanitize-sensitive-aliases.js` (dry-run/apply).

## 9. Pendientes documentados

- **App Check**: código listo en el Formulario (site key vacía); activación en
  consola pendiente (pasos exactos en DEPLOYMENT.md).
- **Modo estricto de RIP** (`window.RIP_REQUIRE_STUDENT_ID = true` en
  `firebase.config.js`): activar después de las migraciones; desde entonces no
  se aceptan registros nuevos sin studentId (homónimos → resolución manual).
- **Duplicados del formulario**: `checkStudentRegistrationDuplicate` consulta
  correo en `estudiantes` y documento mediante el índice HMAC privado antes de
  crear. Si el servicio no está disponible, el navegador exige una decisión
  explícita para continuar. La fusión de duplicados sigue siendo manual.

## 10. Contrato de integración transitoria

### integration_jobs/{studentId}

Solo Admin SDK escribe; únicamente el personal autorizado puede leer. No
contiene documento, salud, formulario completo, secretos ni respuestas crudas.

```js
{
  studentId,
  type: "legacy_registration_side_effects",
  status: "pending" | "processing" | "completed" | "partial" | "failed",
  sheetSynced: true | false,
  welcomeEmailSent: true | false,
  internalNotificationSent: true | false,
  attempts: 1,
  lastErrorCode: "",
  createdAt,
  updatedAt
}
```

### registration_events/{eventId}

Evento mínimo, creado exclusivamente por callable; no admite lectura ni
escritura desde clientes.

```js
{ type: "terms_rejected", email, studentName, createdAt }
```

### Respuesta pública de duplicados

La callable recibe solo correo normalizado, tipo y número de documento. Su
respuesta se limita a `duplicate`, `duplicateByEmail`,
`duplicateByDocument`, `canContinue` y `message`. No devuelve nombres,
correos existentes, documentos, huellas ni IDs ajenos.

### Sobre la copia en Sheets

Sheets deja de ser fuente de verdad. Mientras siga activa, conserva las
columnas administrativas existentes y añade únicamente `studentId` como llave
canónica de upsert. No recibe `documentFingerprint`, índices privados,
secretos, URL de foto ni payloads técnicos. El documento puede conservarse
como dato administrativo existente, pero nunca se usa como identificador.
