# Bitácoras de clase — base canónica de producción

## Regla no negociable

La fuente de verdad de la aplicación es **la versión activa en Firebase Hosting** (`https://bitacoras-de-clase.web.app`), no GitHub, archivos ZIP, ramas, worktrees ni borradores locales.

La copia local fue comparada nuevamente contra los archivos públicos servidos por Firebase Hosting el 31 de julio de 2026. La versión activa de referencia es `20260730.6` (estilos `20260730.3`) y la carpeta principal de este computador coincide con ella.

## Protocolo antes de cualquier cambio o despliegue

1. Consultar y guardar la versión `live` de Firebase Hosting antes de editar; esa versión es la base funcional que se está usando.
2. Trabajar únicamente sobre una copia que se haya comparado contra esa versión viva.
3. Si llega un ZIP, una rama, un commit, un worktree o un cambio de otra persona, compararlo por archivos contra `live` y traer solo las modificaciones necesarias; nunca restaurarlo completo ni usarlo para regresar a una versión anterior.
4. Mantener los cambios visuales y los cambios de lógica/rendimiento separados durante la integración.
5. Verificar localmente la apariencia y los flujos afectados.
6. Desplegar solo a Firebase Hosting después de confirmar que la versión actual se conserva; ningún despliegue debe reemplazarla accidentalmente por una versión anterior.
7. Comprobar la URL pública y su versión después del despliegue.

## Sincronización obligatoria: Firebase y computador

Después de cada publicación aprobada en Firebase Hosting, sincronizar la misma fuente validada con esta carpeta principal y comprobar los archivos modificados. No basta con actualizar Firebase: la copia local debe quedar igual a lo publicado para que el siguiente arreglo parta de la versión correcta.

- Carpeta operativa principal: `Bitácoras de clase` dentro de este proyecto.
- Publicar únicamente en Firebase Hosting y verificar la URL pública.
- No recuperar ni publicar la visual desde GitHub, ramas antiguas, worktrees o borradores. Esas fuentes pueden aportar cambios puntuales, pero nunca sustituyen la versión pública vigente.
- Durante arreglos de interfaz estática, no tocar `firebase rules`, `firebase-sync/migrations` ni cambios ajenos sin que estén expresamente dentro del alcance.

## Publicación

- Canal único: Firebase Hosting, proyecto/sitio `bitacoras-de-clase`.
- URL canónica: `https://bitacoras-de-clase.web.app`.
- GitHub puede conservar código, pero no define qué versión visual se publica ni se usa como canal de despliegue.

## Protección contra regresiones

No reemplazar la interfaz publicada por una rama antigua, una carpeta temporal o un borrador, aunque contenga arreglos útiles. Los arreglos se trasladan de manera selectiva y se prueban sobre la base viva actual.
