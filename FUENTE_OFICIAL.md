# Fuente oficial de publicación

## Regla obligatoria para cualquier trabajo futuro

La versión de referencia y fuente de verdad de Bitácoras de clase es siempre la que está publicada y funcionando en Firebase Hosting:

https://bitacoras-de-clase.web.app

Antes de modificar código, comprobar la versión y los archivos reales servidos por Firebase Hosting y comparar la copia local contra ellos. Si hay diferencias, actualizar primero el computador desde `live` y trabajar sobre esa base. Los arreglos nuevos se agregan encima de la versión pública actual.

No usar GitHub, ramas, commits, ZIP, worktrees ni copias locales antiguas como referencia para decidir qué versión está vigente ni para restaurar una publicación. Esas fuentes solo pueden aportar cambios puntuales después de compararlos con `live`.

Nunca revertir Firebase Hosting a una versión anterior por confusión entre ramas o copias locales. Ningún cambio local queda autorizado para reemplazar la versión pública vigente sin una decisión explícita y una verificación completa.

Canal y URL canónicos: proyecto/sitio Firebase `bitacoras-de-clase`, https://bitacoras-de-clase.web.app

La configuración local de Git se mantiene sin remoto para evitar publicaciones o sincronizaciones accidentales.
