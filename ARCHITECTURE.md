# Arquitectura del ecosistema Musicala

> Regla conceptual: **Formulario identifica, RIP decide, Bitácoras integra y HUB muestra.**

## Proyectos y responsabilidades

| Proyecto | Firebase | Rol | Fuente de verdad de |
|---|---|---|---|
| Formulario v2 / Lista | `estudiantes-musicala` | Crea la identidad oficial | Identidad: nombre, correos, contactId, documento (privado), procesos iniciales |
| RIP + Programación | `rip-musicala` | Opera pagos/clases/programación | Estado operativo: statusLabel, active, permisos, clases restantes, últimas/próximas clases |
| Bitácoras de clase | `bitacoras-de-clase` | Centro de integración académico | Proceso académico: bitácoras, rutas, progreso, usuarios de acceso |
| Estudiantes HUB | (lee `bitacoras-de-clase`) | Portal del estudiante | Nada: solo lee lo consolidado |

## Flujo de sincronización (event-driven, sin polling)

```text
Formulario v2 (navegador)
   crea estudiantes-musicala/estudiantes/{studentId}
        │  (trigger onDocumentWritten)
        ▼
syncStudentIdentity            ← Cloud Function EN estudiantes-musicala
   ├─→ rip-musicala/students/{studentId}          (directorio local de identidades)
   ├─→ bitacoras-de-clase/students/{studentId}    (mapa `identity` + planos compat)
   └─→ bitacoras-de-clase/users/{email}           (acceso por correo)

RIP (navegador, staff) escribe registro/pagos/programación
   → recalcula rip-musicala/studentComputed/{key}
        │  (trigger onDocumentWritten)
        ▼
syncStudentStatus              ← Cloud Function EN rip-musicala
   ├─→ bitacoras-de-clase/students/{studentId}.rip   (proyección segura de estado)
   └─→ bitacoras-de-clase/users/{email}.active       (acceso derivado del estado)

Estudiantes HUB
   lee users/{email}.studentIds → students/{studentId} → bitácoras/rutas/recursos
```

No hay lecturas periódicas entre proyectos: todo es por eventos de escritura.
Las sincronizaciones críticas viven en Cloud Functions (Admin SDK), nunca en el
navegador. Los syncs manuales del frontend de Bitácoras (pantalla Ajustes)
siguen existiendo como herramienta administrativa, pero respetan la propiedad
de campos (no pisan lo de RIP).

## Contrato del studentId

- El **studentId canónico** es el ID automático del documento
  `estudiantes-musicala/estudiantes/{studentId}`. Ejemplo: `aB3xK9mP2vR7sT4wX8`.
- Nunca son ID canónico: nombre normalizado, correo, teléfono, número de
  documento, `contactId`.
- `contactId` (UUID del formulario) se conserva como **alias heredado**.
- Aliases de compatibilidad aceptados en consultas durante la transición:
  `officialStudentId`, `estudianteKey`, `nameKey`, `studentKey`, `studentIds[]`,
  `contactId`, IDs heredados de Bitácoras (`stu_nombre_fila`).
  Están **obsoletos** para escrituras nuevas: toda escritura nueva prioriza
  `studentId`.
- El **número de documento NO es alias válido**: los syncs lo filtran siempre
  y los residuos históricos los retira `sanitize-sensitive-aliases.js`.
- Un `studentId` canónico **jamás** pasa por `norm()`.

## Propiedad de campos en bitacoras-de-clase/students/{studentId}

| Campo | Dueño | Escrito por |
|---|---|---|
| `identity.*`, `nombre/name`, `emails`, `contactId`, `studentIds`, `processes`, `normalizedName`, `sourceDocId` | Lista | `syncStudentIdentity` |
| `rip.*` (statusCode, statusLabel, statusReason, active, canAccessHub, showInTeacherLists, canReceiveBitacoras, lastClassDate, nextClassDate, remainingClasses, curso/instrumento/estilo/enfasis, ripUpdatedAt, statusSource, statusVersion) | RIP | `syncStudentStatus` |
| planos `estado/status/active/showInTeacherLists` | RIP cuando existe `rip.statusVersion`; Lista solo como fallback transicional | ambos, con guardas |
| `docente`, `repertorio*`, áreas manuales (`processes` agregadas a mano) | Bitácoras (staff) | frontend Bitácoras |
| `legacyAliasOf` | migraciones/sync | backend |

Las dos funciones escriben con `set(..., { merge: true })` sobre campos propios;
ninguna reescribe el mapa de la otra. Las reglas de Firestore además impiden
que cualquier cliente modifique `studentId` o el mapa `rip`.

## Resolución de identidad (compartida)

Orden (implementado en `rip.identity.js`, `firebase-sync/migrations/lib/common.js`
y replicado en las funciones):

1. `studentId` explícito ya guardado.
2. `officialStudentId` desde la copia local `students`.
3. Coincidencia **única** por correo.
4. Coincidencia única por documento (`documentFingerprint`) — solo backend/migración.
5. Alias heredado.
6. Nombre normalizado, únicamente como último recurso y solo si es único.

Ambigüedades (homónimos) **nunca** se asignan automáticamente: quedan en el
reporte de migración o en `sync_logs` para revisión manual.

## Política estado → permisos (ÚNICA, central, editable)

Única implementación en `firebase-sync/rip-functions/functions/index.js`
(`derivePermissionsFromStatus`). Bitácoras y el HUB OBEDECEN los campos
publicados; ningún frontend vuelve a interpretar el texto del estado.

| Estado (clasificacionFinal de RIP) | operationalActive | canAccessHub | accountEnabled | showInTeacherLists | canReceiveBitacoras |
|---|---|---|---|---|---|
| Activo / Activo no registro / Activo en pausa | ✔ | ✔ | ✔ | ✔ | ✔ |
| Inactivo en pausa (1-3 meses) | ✘ | ✔ | ✔ | ✔ | ✔ |
| Inactivo >3 meses / histórico / Exestudiante / sin info | ✘ | ✘ | ✘ | ✘ | ✘ |
| Archivado / Bloqueado | ✘ | ✘ | ✘ | ✘ | ✘ |

Compatibilidad: en `students`, `active = operationalActive`; en `users`,
`active = accountEnabled`. `statusVersion` es determinista (updatedAt del doc
computado / timestamp del evento — nunca `Date.now()` por reintento).
Acudientes con varios estudiantes: la cuenta (`users.accountEnabled`) queda
habilitada si AL MENOS UNO de sus estudiantes conserva acceso; el permiso por
estudiante lo decide `students/{id}.rip.canAccessHub`.

El cálculo del estado (`calculateStudentStatus` por días desde la última clase,
en `rip.calculations.js`) **no se modificó**: se conservó tal cual y se
centralizó su publicación.

## HUB

- Resuelve al estudiante por `users/{email}.studentIds` → `studentId` canónico
  → aliases solo como compatibilidad. Nunca por nombre.
- Lee `students/{studentId}`, bitácoras filtradas por `studentIds`/`studentId`,
  rutas, progreso, recursos y los permisos publicados en `students.rip`.
- No lee `rip-musicala` ni `estudiantes-musicala` ni datos financieros.
- No calcula estado: `normalizeStudent` (HUB) solo muestra `rip.statusLabel`.

## Registro de sincronización

- `bitacoras-de-clase/app_config/student_sync_status` — último evento Lista→*.
- `rip-musicala/app_config/rip_status_sync_status` — último evento RIP→Bitácoras.
- `sync_logs` (en cada proyecto emisor): SOLO errores, casos no resueltos y
  procesos administrativos. Nunca un log por lectura.

## Registro transitorio: Firebase primero, Apps Script en segundo plano

Firestore (`estudiantes-musicala/estudiantes/{studentId}`) es la única fuente
de verdad de estudiantes. El navegador nunca conoce la URL ni el token del Web
App legado y considera exitosa la inscripción inmediatamente después de que
Firestore confirma la creación.

```text
Formulario web
  -> checkStudentRegistrationDuplicate (callable, HMAC privado)
  -> Storage/fotos-estudiantes/{studentId}/{uuid}
  -> Firestore/estudiantes/{studentId}
       |-> syncStudentIdentity (identidad hacia RIP y Bitácoras)
       `-> processStudentRegistrationSideEffects
             -> integration_jobs/{studentId}
             -> Apps Script autenticado (upsert Sheets + correos)

Rechazo de términos
  -> createTermsRejectedEvent (callable)
  -> registration_events/{eventId}
  -> processRegistrationEvent
  -> Apps Script autenticado (notificación mínima)
```

Las responsabilidades siguen separadas: `syncStudentIdentity` no contiene
lógica de Sheets ni correo. `processStudentRegistrationSideEffects` no publica
identidad hacia otros proyectos. Los fallos del adaptador se reintentan y se
observan en `integration_jobs`, pero nunca revierten ni desacreditan una
inscripción que Firestore ya confirmó.

Apps Script es un adaptador transitorio. Conserva por ahora la copia
administrativa y las plantillas de correo; no es consultado por el navegador y
no decide duplicados ni éxito. La migración definitiva de correo a un servicio
Firebase/backend queda para una fase posterior.
