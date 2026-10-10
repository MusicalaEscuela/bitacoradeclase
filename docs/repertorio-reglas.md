# Repertorio: corrección del límite de evaluación (2026-10-10)

La versión de reglas publicada el 25 de septiembre rechazaba guardar cuatro
canciones o más con `PERMISSION_DENIED`: el emulador reportó que se superaban
las 1.000 expresiones. El rechazo se reprodujo tanto como admin como docente,
sin escrituras a datos de producción.

Se tomó como fuente el ruleset publicado
`33caa321-ab9a-4c22-95dd-4d4b916236c7`, cuyo contenido SHA-256 es
`4f7a1a925ec4bff3ca3e8c8f1efd0827065edf43d0499d1809c0545bfb3ee8cb`.
Coincidía exactamente con las reglas aportadas por el usuario.

El contrato completo se valida para canciones nuevas o modificadas. Las
canciones idénticas a las almacenadas se conservan sin volver a validar sus
seis campos. Las listas completas siguen comprobando máximo 20, nombres
únicos, correspondencia nombre/posición, campos bilingües y auditoría.
Este flujo cubre agregar, editar, ordenar y quitar canciones desde el perfil;
no constituye una migración masiva de repertorios ni cambia la escritura
atómica entre documentos académicos y canónicos.

Todo el texto fuera de los validadores de repertorio coincide con producción,
salvo finales de línea. El diff de Git incluye la sincronización de tres
diferencias que ya existían en la copia local: la llamada al validador,
`teacherCanEditStudent()` y `expected_class_logs`. Conservarlas evita publicar
permisos obsoletos o eliminar el acceso existente de Docentes HUB.

## Validación

`tests/repertoire-rules.test.mjs` usa exclusivamente un emulador del proyecto
`demo-repertoire` en `127.0.0.1:8186`. Cargar el archivo de reglas del repositorio
en el emulador y ejecutar `node tests/repertoire-rules.test.mjs`.

102 comprobaciones verifican altas sucesivas hasta 20 canciones, edición a
capacidad, reordenar/eliminar, formatos y tamaños inválidos, campos ausentes o
adicionales, duplicados, identidad protegida, auditoría, usuarios inactivos,
acudientes, terceros, visibilidad RIP, prohibición de crear/borrar estudiantes,
clases propias de Docentes HUB, notas privadas y escritura reservada al backend.
Las 12 pruebas de guardado del perfil y 8 de búsqueda también pasan.

Publicar exclusivamente `firestore:rules`; no desplegar Storage, Functions ni
Hosting por esta corrección. El cliente ya conserva el texto ante un rechazo
y confirma el resultado mediante lectura del servidor.
