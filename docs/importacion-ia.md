# Importar bitácoras con IA

Desde el perfil del estudiante, administración puede abrir **Importar bitácoras
con IA**, elegir el proceso, pegar texto libre o subir PDF/imágenes/TXT/CSV/TSV,
y pulsar **Ordenar con IA**. Word y Google Docs se admiten copiando el texto o
exportando a PDF. Se aceptan hasta 4 documentos, 5 MB y 40 sesiones por análisis.

Gemini (Vertex AI) transcribe y organiza las sesiones sin inventar datos. La
vista previa permite corregir fecha, hora, docente, título, participantes,
observaciones y componentes, y excluir clases. Si el documento omite el año,
docente o participantes, los campos comunes permiten completarlos una vez.
Sin participantes se usa explícitamente el perfil abierto; un nombre ambiguo
o no encontrado bloquea esa clase. No se crea nada al analizar.

El guardado permanece en el flujo autorizado del cliente y en las reglas de
Firestore existentes. Se comprueba el historial antes de guardar y se usan
IDs deterministas en transacciones para no repetir importaciones idénticas.
Cada escritura se confirma con una lectura del servidor. Los registros ya
guardados sobreviven a un fallo posterior y se omiten al reintentar.

El backend reutiliza `generateStudentReport` con la operación
`normalize-bitacoras`, autorizada exclusivamente a administradores activos.
Los informes existentes mantienen su operación habitual. El contenido de los
documentos no controla las instrucciones del modelo, las identidades ni las
escrituras. Los análisis tienen un cupo separado de 60 diarios por cuenta.
No se cambiaron reglas de Firestore/Storage ni permisos de otras apps.

Validación: `tests/ai-bitacoras-import.test.mjs` comprueba formatos, límites,
fechas, preservación de información incompleta, participantes ambiguos e IDs
de reintento. `tests/profile-save.test.mjs` incluye dos importaciones idénticas
que producen una escritura y dos confirmaciones de servidor. Se mantienen las
pruebas de búsqueda, cobertura y redacción de informes.

El PDF PRE-BALLET se verificó con el modelo real: ocho sesiones, continuaciones
entre páginas, hora inicial 16:00, descripción truncada conservada y marcada,
sin atribuir año, docente ni estudiantes que el documento no contiene.
