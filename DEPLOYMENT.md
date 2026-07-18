# Despliegue

> ⚠️ NADA de lo descrito aquí fue desplegado. Cada paso marcado con 🔴 afecta
> producción y requiere autorización explícita.

## IAM requerido (identidades administradas, sin claves JSON)

Las funciones v2 corren por defecto con la cuenta
`PROJECT_NUMBER-compute@developer.gserviceaccount.com` de su proyecto
(o la que se configure como service account de la función).

| Cuenta de servicio (origen) | Necesita | En proyecto destino |
|---|---|---|
| SA de funciones de `estudiantes-musicala` | `roles/datastore.user` | `bitacoras-de-clase` |
| SA de funciones de `estudiantes-musicala` | `roles/datastore.user` | `rip-musicala` |
| SA de funciones de `rip-musicala` | `roles/datastore.user` | `bitacoras-de-clase` |

```bash
# Ejemplo (ajustar el número de proyecto / SA real):
gcloud projects add-iam-policy-binding bitacoras-de-clase \
  --member="serviceAccount:SA_DE_ESTUDIANTES_MUSICALA" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding rip-musicala \
  --member="serviceAccount:SA_DE_ESTUDIANTES_MUSICALA" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding bitacoras-de-clase \
  --member="serviceAccount:SA_DE_RIP_MUSICALA" --role="roles/datastore.user"
```

No se otorga nada más: cada SA solo escribe lo requerido en el destino.

## Orden exacto de despliegue

1. **IAM** (arriba). Sin esto, las funciones fallarán hacia los destinos.
2. 🔴 **Funciones de identidad** (`firebase-sync/`):
   ```bash
   # Prerrequisito: secreto de la huella de documento
   firebase functions:secrets:set DOC_INDEX_SECRET --project estudiantes-musicala

   cd firebase-sync/functions && npm install
   # .env: BACKFILL_TOKEN=<clave NUEVA — el token anterior está comprometido>
   firebase deploy --only functions --project estudiantes-musicala
   ```
   - El deploy pedirá **eliminar** `mirrorStudentToBitacoras` y
     `backfillStudentsToBitacoras` (renombradas a `syncStudentIdentity` y
     `backfillStudentIdentity`). Aceptar: las nuevas cubren lo mismo.
   - Si el IAM hacia rip-musicala aún no está listo, desplegar con
     `RIP_TARGET_ENABLED=false` en `.env` y reactivarlo después.
3. 🔴 **Backfill de identidades** (puebla RIP y refresca Bitácoras; POST + header):
   ```bash
   curl -X POST -H "x-sync-token: $TOKEN" \
     "https://us-central1-estudiantes-musicala.cloudfunctions.net/backfillStudentIdentity?limit=5000"
   ```
4. **Migración de Lista** — dry-run, revisar reporte, luego 🔴 `--apply`
   (ver MIGRATION.md).
5. **Migración de RIP** — dry-run, revisar, luego 🔴 `--apply`.
6. 🔴 **Funciones de estado** (`firebase-sync/rip-functions/`):
   ```bash
   cd firebase-sync/rip-functions/functions && npm install
   # .env: BACKFILL_TOKEN=<clave larga>
   firebase deploy --only functions --project rip-musicala
   ```
7. 🔴 **Backfill de estado** (POST + header):
   ```bash
   curl -X POST -H "x-sync-token: $TOKEN" \
     "https://us-central1-rip-musicala.cloudfunctions.net/backfillStudentStatus?limit=5000"
   ```
8. **Migración de Bitácoras** — dry-run, revisar, luego 🔴 `--apply`.
   Después: **sanitize-sensitive-aliases** — dry-run, revisar, 🔴 `--apply`.
9. 🔴 **Frontends** (hosting/copias estáticas segun cada proyecto):
   - RIP: `rip.identity.js` + archivos modificados (repository, registrar-clases,
     HTML). Es compatible hacia atrás: sin datos sincronizados se comporta como hoy.
   - Bitácoras: js/api actualizados.
   - HUB: `src/normalizers.js` (+ `firestore.rules` compartidas).
   - Formulario v2: `app.js`.
10. 🔴 **Reglas de Firestore** (después de que los backfills hayan corrido):
    ```bash
    # bitacoras-de-clase (la copia canónica vive en Estudiantes HUB/firestore.rules;
    # 'firebase rules/firestore.rules' del repo de Bitácoras es copia espejo)
    firebase deploy --only firestore:rules --project bitacoras-de-clase

    # rip-musicala (sin cambios funcionales, solo documentación)
    firebase deploy --only firestore:rules --project rip-musicala

    # estudiantes-musicala — ¡ATENCIÓN!: cierra la lectura pública de
    # `estudiantes` Y el update público (creación única). Debe ir DESPUÉS del
    # paso 3, porque el importador Wix de RIP pierde su fallback de lectura.
    # Se despliega desde la carpeta "Formulario v2" (firebase.json propio):
    firebase deploy --only firestore:rules,storage --project estudiantes-musicala
    ```
11. **Índices**: no se requieren índices compuestos nuevos. Las consultas
    nuevas (`registro.studentId ==`, `students.rip.showInTeacherLists ==`,
    `users.studentIds array-contains`) usan índices automáticos de un solo
    campo. `firestore.indexes.json` de RIP queda sin cambios; no se crearon
    índices especulativos.

## Pasos que afectan producción (resumen)

- Todo deploy de funciones y reglas (pasos 2, 6, 10).
- Ambos backfills (3, 7): escriben en los tres Firestore.
- Toda migración con `--apply` (4, 5, 8).
- Publicación de frontends (9).

## Secretos y variables (configurar ANTES de desplegar)

| Secreto/variable | Dónde | Cómo |
|---|---|---|
| `DOC_INDEX_SECRET` | Secret Manager (estudiantes-musicala) | `firebase functions:secrets:set DOC_INDEX_SECRET --project estudiantes-musicala` (valor: `openssl rand -hex 32`) |
| `BACKFILL_TOKEN` (identidad) | `firebase-sync/functions/.env` (NO versionado) | **ROTAR**: el token anterior circuló en un ZIP y está comprometido. `openssl rand -hex 32` |
| `BACKFILL_TOKEN` (estado) | `firebase-sync/rip-functions/functions/.env` | Igual que el anterior (otro valor) |
| `APP_CHECK_SITE_KEY` | `Formulario v2/app.js` | Site key de reCAPTCHA v3 (ver App Check) |

Los backfills son POST-only y el token solo se acepta por header
`x-sync-token`. Preferencia futura: quitarles el acceso público
(`--no-allow-unauthenticated` + `roles/run.invoker`) o reemplazarlos por
scripts ADC. Se mantuvieron como HTTP por compatibilidad operativa.

## Firebase App Check (pasos exactos pendientes de consola)

1. Consola de Google reCAPTCHA → registrar el dominio del Formulario (v3) →
   obtener site key + secret.
2. Consola Firebase (estudiantes-musicala) → App Check → registrar la web app
   con reCAPTCHA v3 (pegar el secret).
3. Pegar la site key en `Formulario v2/app.js` (`APP_CHECK_SITE_KEY`) y
   publicar el frontend (el script compat ya está incluido en `index.html`).
4. Observar métricas de App Check unos días (modo monitor).
5. Activar **enforcement** en Firestore y Storage cuando el tráfico verificado
   sea estable. (Hacer lo mismo después en bitacoras-de-clase para el HUB si
   se desea; requiere añadir el SDK allí.)

## Plan piloto (5-10 estudiantes)

1. Con todo desplegado y migrado en dry-run revisado, elegir 5-10 estudiantes
   reales: 2 nuevos (inscritos por Formulario), 2 activos históricos, 1 en
   pausa corta, 1 inactivo >3 meses, 2 homónimos si existen, 1 acudiente con
   dos hijos.
2. Ejecutar migraciones con `--limit` acotado o validar solo esos IDs tras el
   `--apply` global autorizado.
3. Verificar por cada uno el checklist de abajo; revisar `sync_logs` y los
   documentos de estado de sync.
4. Solo tras una semana estable, activar `RIP_REQUIRE_STUDENT_ID = true` y
   cerrar el fallback del importador Wix (reglas del Formulario).

## Checklist de verificación funcional

- [ ] **Inscripción**: Formulario crea `estudiantes/{id}` con `studentId == id`;
      reintento no reescribe Firestore; foto en `fotos-estudiantes/{id}/{uuid}`.
- [ ] **Identidad**: el estudiante aparece en `rip-musicala/students/{id}` y
      `bitacoras-de-clase/students/{id}` (mapa `identity`), sin documento en aliases.
- [ ] **RIP**: clase y pago nuevos guardan `studentId`; `studentComputed/{id}`
      canónico se recalcula; programación va a `programacion/{id}`.
- [ ] **Lista docente**: el estudiante activo aparece; el inactivo >3m no;
      ningún duplicado por docs legacyAliasOf.
- [ ] **Bitácora**: docente crea individual y grupal; el doc incluye
      studentId/studentNameSnapshot/teacherEmail.
- [ ] **Acceso estudiante**: entra con Google; solo ve sus bitácoras/rutas;
      un ID ajeno en la URL no carga nada.
- [ ] **Acceso acudiente**: con dos hijos, el selector muestra ambos y entra
      con el habilitado aunque el otro esté inactivo.
- [ ] **Procesos y recursos**: procesos manuales intactos tras un sync de
      Lista; recursos y rutas visibles; PWA vieja se actualiza sola
      (CACHE_VERSION nuevo).

## Plan de rollback

1. **Frontends**: cada repo tiene commits por fase — `git revert`/`git checkout`
   del commit anterior y republicar. La PWA del HUB fuerza recarga por
   `FORCE_REFRESH_VERSION`.
2. **Funciones**: redeploy del commit anterior (`git checkout <hash> --
   firebase-sync/` + deploy). Deshabilitar rápido: `RIP_TARGET_ENABLED=false`
   (identidad→RIP) o borrar el trigger de estado
   (`firebase functions:delete syncStudentStatus --project rip-musicala`).
3. **Reglas**: los archivos previos están en git; `firebase deploy --only
   firestore:rules` con la versión anterior. Las reglas viejas del Formulario
   reabren la lectura pública (solo si se necesita el fallback Wix).
4. **Datos**: las migraciones no borran nada; los campos añadidos
   (`studentId`, `officialStudentId`, `legacyAliasOf`, `canonicalStudentId`)
   son inertes para el código viejo. Revertir el saneamiento de aliases NO es
   automático (los valores sensibles no se re-insertan por diseño).
5. **Acceso**: si la política nueva bloquea a alguien por error, el override
   inmediato es `users/{email}.active = true` (admin) mientras se corrige el
   estado en RIP; quedará sobrescrito por el siguiente sync (documentado).

## Verificación post-deploy sugerida

1. Crear una inscripción de prueba en el Formulario → verificar
   `estudiantes/{id}.studentId == id` y que aparezca en
   `rip-musicala/students/{id}` y `bitacoras-de-clase/students/{id}`.
2. Registrar una clase en RIP para ese estudiante → verificar
   `studentComputed` y que `students/{id}.rip.statusLabel` cambie en Bitácoras.
3. Entrar al HUB con el correo del estudiante → debe ver su proceso.
4. Revisar `app_config/student_sync_status`, `app_config/rip_status_sync_status`
   y `sync_logs` de ambos proyectos emisores.

## Fase transitoria Formulario -> efectos secundarios (NO desplegada)

### Secretos requeridos, sin valores en el repositorio

```powershell
firebase functions:secrets:set LEGACY_APPS_SCRIPT_URL --project estudiantes-musicala
firebase functions:secrets:set LEGACY_APPS_SCRIPT_TOKEN --project estudiantes-musicala
```

`LEGACY_APPS_SCRIPT_TOKEN` debe configurarse con el mismo valor en Apps Script:
Configuración del proyecto -> Propiedades de secuencia de comandos. La URL y el
token nunca se agregan a `app.js`, Git, `.env` ni parámetros de URL.

### Publicar manualmente una versión nueva de Apps Script

1. Abrir el proyecto Apps Script que actualmente contiene `Code.gs`.
2. Crear/rotar `LEGACY_APPS_SCRIPT_TOKEN` en Script Properties.
3. Pegar la versión validada de `Formulario v2/Code.gs`.
4. Implementar -> Administrar implementaciones -> Editar -> Nueva versión.
5. Mantener la ejecución con la cuenta propietaria. Si el Web App exige sesión
   Google, habilitar invocación sin sesión y usar el token compartido como
   control efectivo; Apps Script no expone headers HTTP personalizados a
   `doPost`, por eso el token viaja dentro del cuerpo POST cifrado por HTTPS.
6. Copiar la URL `/exec` únicamente al secreto `LEGACY_APPS_SCRIPT_URL`.
7. No probar desde el navegador: una solicitud sin token debe devolver
   `UNAUTHORIZED_BACKEND` y GET debe devolver `METHOD_NOT_ALLOWED`.

### Orden de despliegue recomendado (requiere aprobación separada)

1. Publicar primero la nueva versión de Apps Script y configurar su token.
2. Crear los secretos `LEGACY_APPS_SCRIPT_URL` y
   `LEGACY_APPS_SCRIPT_TOKEN` en `estudiantes-musicala`.
3. Desplegar Functions: callable de duplicados, callable/evento de términos y
   triggers de efectos secundarios. Verificar que `syncStudentIdentity` siga
   desplegada sin cambios funcionales.
4. Desplegar las reglas nuevas de `estudiantes-musicala`.
5. Configurar TTL sobre `registration_rate_limits.expiresAt` para limpiar los
   contadores efímeros (su ausencia no cambia seguridad, solo almacenamiento).
6. Hacer pruebas backend controladas y revisar `integration_jobs`.
7. Desplegar Hosting al final. Solo entonces el navegador deja de invocar el
   adaptador legado.

No invertir los pasos 1-3: un trigger activo sin secretos/adaptador generaría
jobs fallidos; publicar Hosting antes de Functions dejaría el formulario sin
verificación callable.

### Rollback específico

1. Hosting: republicar el commit anterior solo si las callables nuevas fallan.
2. Functions: volver al commit anterior y redesplegar; eliminar únicamente
   `processStudentRegistrationSideEffects`, `checkStudentRegistrationDuplicate`,
   `createTermsRejectedEvent` y `processRegistrationEvent` si fuera necesario.
   No eliminar `syncStudentIdentity`.
3. Apps Script: seleccionar la implementación/version anterior. El código
   anterior vuelve a aceptar el flujo legado solo si también se revierte
   Hosting.
4. Reglas: redesplegar `firestore.rules` anterior. Los documentos de
   `integration_jobs` y `registration_events` son inertes para el código viejo.
5. Datos: no borrar estudiantes ni filas. El upsert por `studentId` permite
   reanudar tareas incompletas sin añadir una segunda fila.

### Riesgo residual conocido

Apps Script usa `MailApp`, que no ofrece una llave idempotente nativa. El
ledger persistente en Script Properties, el bloqueo de script y las banderas
por tarea evitan duplicados en reintentos normales y concurrentes. Persiste una
ventana extrema si el runtime termina abruptamente justo después de que
`MailApp` acepta un correo y antes de guardar la bandera; eliminarla por
completo requiere migrar el correo a un proveedor/backend con idempotencia
nativa, prevista para una fase posterior.
