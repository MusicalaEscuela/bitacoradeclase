# Reporte de pruebas — Corrección final y validación (2026-07-11)

## Suites unitarias (Node local, sin red)

| Suite | Ubicación | Resultado |
|---|---|---|
| Identidad + huella HMAC v2 (`syncStudentIdentity`) | `firebase-sync/functions/test/identity.test.js` | ✅ **17/17** |
| Política de acceso + endpoint backfill (`syncStudentStatus`) | `firebase-sync/rip-functions/functions/test/permissions.test.js` | ✅ **12/12** |
| Resolutor de identidad de RIP | `RIP + Programación (Firebase)/tests/rip.identity.test.js` | ✅ **12/12** |
| Agrupación única por studentId | `RIP + Programación (Firebase)/tests/rip.grouping.test.js` | ✅ **8/8** |

**49/49 unitarias en verde.** Incluyen los 5 casos de huella exigidos
(nuevo sin huella → calcula; SHA legado sin `fingerprintVersion: 2` →
recalcula y reemplaza; HMAC v2 → definitiva; duplicado por HMAC (mismo
documento → misma huella); reejecución idempotente) y la prueba del backfill
de RIP (POST obligatorio, token solo por header, **query string rechazado
aunque el token sea correcto**).

## Pruebas de reglas en EMULADOR (ejecutadas de verdad)

Emulador de Firestore con Java 21 (instalado vía winget) + `firebase-tools`
15.22.3, config `Estudiantes HUB/firebase.test.json` (raíz del HUB, una sola
copia de reglas). Comando: `cd tests/firestore-rules && npm test`.

✅ **29/29 PASS**, incluyendo los 11 escenarios exigidos:

1. Estudiante lee únicamente su perfil (`students/S1` ✔, `students/SX` ✘).
2. Conocer un studentId ajeno NO concede lectura.
3. Estudiante lee sus bitácoras (agrupadas, por alias y legacy `studentId ==`).
4. Estudiante no lee bitácoras ajenas (consulta y lectura directa).
5. Comentarios y evidencias respetan `studentIds` (lectura propia ✔, ajena ✘,
   creación exige `studentId` autorizado).
6. Acudiente lee a sus dos hijos.
7. Docente mantiene acceso operativo (lee estudiantes, crea bitácoras).
8. El cliente NO puede modificar `studentId` (ni siquiera un admin).
9. El cliente NO puede modificar el mapa `rip` (solo Admin SDK).
10. Usuario bloqueado (active=false por RIP) no accede a nada.
11. Usuario en pausa corta (1-3 meses) sí accede.

## Validaciones estáticas

| Validación | Alcance | Resultado |
|---|---|---|
| `node --check` | Todos los JS de los 4 proyectos (sin node_modules) | ✅ |
| Auditoría de imports relativos | Bitácoras `js/` + HUB `src/`/`tests/` | ✅ sin imports rotos |
| Rutas locales en HTML | 7 HTML principales | ✅ todas existen |
| Higiene de secretos | `git ls-files` en los 4 repos | ✅ solo `.env.example` versionados; `.gitignore` bloquea `.env`, `**/.env` y claves de servicio |
| Tokens | 2 `BACKFILL_TOKEN` nuevos (64 hex, distintos entre sí), generados con `openssl rand -hex 32`, escritos directo a los `.env` locales **sin imprimirse** | ✅ |

## No probado aún (requiere credenciales/red — Parte 4-5 del despliegue)

- Cloud Functions desplegadas y triggers reales (IAM entre proyectos,
  Secret Manager `DOC_INDEX_SECRET`).
- Backfills contra producción.
- Migraciones dry-run/apply contra datos reales (sin ADC en esta máquina).
- Inscripción de prueba del Formulario contra producción.
- Piloto funcional (docente, estudiante, acudiente, PWA instalada).

Este reporte solo afirma lo ejecutado arriba; el resto queda condicionado al
despliegue controlado de DEPLOYMENT.md.

## Arquitectura transitoria del Formulario (2026-07-11, sin despliegue)

### Regresión completa

Las **78 pruebas preexistentes** volvieron a ejecutarse y pasaron:

- 17 identidad/HMAC de `syncStudentIdentity`.
- 12 permisos y backfill de `syncStudentStatus`.
- 12 resolución de identidad RIP.
- 8 agrupación RIP por `studentId`.
- 29 reglas del HUB/Bitácoras en emulador.

### 30 pruebas nuevas

| Suite nueva | Resultado |
|---|---:|
| Backend de registro: duplicados, privacidad, payload, estados y retries | 10/10 |
| Frontend: cero Apps Script público, callables, éxito Firestore y studentId | 9/9 |
| Harness real de `Code.gs`: doble ejecución, fallo parcial y token | 3/3 |
| Reglas `estudiantes-musicala` en emulador | 8/8 |

**Total acumulado ejecutado: 108/108 pruebas en verde.**

Los casos nuevos demuestran que:

1. el navegador no contiene ni solicita el dominio/URL de Apps Script;
2. el modal de éxito ocurre después de Firestore y no espera efectos externos;
3. duplicados por correo/documento se resuelven en Firebase sin revelar datos;
4. el payload legado usa `studentId` y excluye huellas, secretos y foto;
5. dos ejecuciones de Apps Script crean una sola fila y un solo correo de cada tipo;
6. un fallo parcial conserva avances y el retry ejecuta solo lo faltante;
7. clientes no escriben `integration_jobs`, `registration_events` ni rate limits;
8. la regla existente permite todavía crear `estudiantes/{id}` con `studentId == id`;
9. `syncStudentIdentity` conserva su trigger separado.

### Validaciones estáticas de esta fase

- `node --check`: **74 archivos JavaScript**, todos correctos.
- `Code.gs`: parseo de sintaxis con `new Function`, correcto.
- Auditoría de archivos públicos: **0 referencias** a `script.google.com`,
  `CONFIG.apiUrl`, `APPS_SCRIPT_URL` o secretos legacy.
- `git diff --check`: correcto en los repositorios modificados.
- Emuladores ejecutados con Java 21 localizado en
  `C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot\bin`.

### Deliberadamente no ejecutado

No se desplegaron Functions, Apps Script, reglas ni Hosting. Tampoco se hicieron
escrituras de prueba en Firestore/Sheets productivos ni se configuraron valores
de secretos. La verificación de red real queda para el despliegue autorizado y
ordenado descrito en `DEPLOYMENT.md`.
