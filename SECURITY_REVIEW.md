# Revisión de seguridad de MoonWolf Panel

Fecha: 2026-10-04

## Resumen

No se han detectado vulnerabilidades críticas inmediatas en las dependencias (`npm audit --omit=dev`: 0 vulnerabilidades) ni un bypass evidente de la autorización actual. Helmet ya está integrado y el límite manual existente de la API se conserva.

La superficie de mayor riesgo no está en las cabeceras HTTP, sino en las operaciones privilegiadas de archivos, descargas e interacción con procesos y bases de datos.

## Recomendaciones priorizadas

### Alta prioridad

1. **Limitar el tamaño total de las subidas**
   - `express.json` acepta hasta 50 MB y Socket.IO hasta 64 MB.
   - La subida por bloques valida el tamaño de cada bloque, pero no impone un máximo global de `totalSize` ni limpia automáticamente subidas abandonadas.
   - Recomendación: definir un máximo global configurable, validar estrictamente Base64, rechazar `totalSize` fuera de rango y eliminar archivos temporales expirados.

2. **Proteger las descargas iniciadas por el servidor contra SSRF**
   - `/api/plugins/install` y la instalación de versiones reciben una URL y descargan contenido desde el servidor.
   - Recomendación: aceptar únicamente HTTPS, seguir redirecciones con validación, bloquear loopback/privadas/link-local/metadata IP y preferir una allowlist de dominios oficiales (Modrinth, Spiget, Hangar, Adoptium y fuentes soportadas).

3. **Verificar artefactos antes de ejecutarlos**
   - Los JAR descargados se guardan en el directorio del servidor y pueden acabar ejecutándose como Minecraft.
   - Recomendación: imponer límite de tamaño, calcular SHA-256 y validar contra hashes publicados cuando existan; no permitir URLs arbitrarias para instalaciones privilegiadas.

4. **Endurecer la configuración de MySQL**
   - El usuario root y la contraseña tienen valores por defecto, incluida contraseña vacía si no se configura el entorno.
   - Los usuarios creados reciben acceso desde `%`.
   - Recomendación: exigir una contraseña explícita para activar la función, conectar MySQL por localhost o una red privada, usar un usuario de administración con privilegios mínimos y conceder acceso a usuarios de aplicación solo desde el origen necesario.

### Prioridad media

5. **Hacer configurable `trust proxy`**
   - Actualmente está fijado a `1`. Es correcto detrás de un único proxy controlado, pero puede permitir falsificar IPs si el proceso se expone directamente.
   - Recomendación: activarlo solo en despliegues conocidos mediante una variable de entorno y documentar la topología esperada.

6. **Añadir límites por conexión y evento de Socket.IO**
   - La autorización de Socket.IO es sólida, pero `maxHttpBufferSize` permite mensajes de hasta 64 MB y no hay un límite explícito de frecuencia para `rpc`, `event` o `pairing_create`.
   - Recomendación: validar tamaños y esquemas de cada evento, limitar solicitudes RPC pendientes por panel y aplicar backoff/cierre ante abuso.

7. **Reducir filtraciones de información en respuestas de error**
   - Algunas rutas devuelven `e.message` directamente y `/api/debug/start` expone rutas locales y detalles del ejecutable Java.
   - Recomendación: devolver mensajes genéricos al cliente y registrar el detalle en el servidor; restringir el endpoint de diagnóstico a administración local o eliminar rutas y credenciales de la respuesta.

8. **Revisar CSP y eliminar comodines gradualmente**
   - La CSP actual permite `https:` en `connect-src` e `img-src` y `unsafe-inline` en estilos para mantener compatibilidad.
   - Recomendación: sustituirlos por dominios concretos y migrar estilos inline a CSS externo cuando sea posible.

### Prioridad baja / defensa en profundidad

9. **Limitar la concurrencia de operaciones costosas**
   - Compresión, backups, consultas externas, instalación de Java y descargas pueden consumir CPU, RAM, disco o red.
   - Recomendación: usar colas por operación, límites de concurrencia, timeouts y límites de tamaño de respuesta.

10. **Permisos y limpieza de archivos sensibles**
    - Mantener con permisos `0600` los stores de agentes, tokens, sesiones y credenciales; limpiar temporales de subidas y descargas tras errores o expiración.
    - Ejecutar el proceso con un usuario sin privilegios y separar el directorio de datos del código cuando sea posible.

11. **No exponer RCON ni query a Internet**
    - Mantenerlos ligados a localhost o a una red privada, con contraseñas fuertes y firewall. El panel debe ser el único componente que pueda acceder a ellos.

## Medidas ya presentes

- Helmet con CSP y cabeceras de seguridad.
- CORS restringido al origen del panel Render.
- Sesiones firmadas con HMAC y expiración.
- Comparaciones de tokens con tiempo constante.
- Tokens compartidos almacenados mediante hash y revocables.
- Autorización por permisos para sesiones compartidas.
- Límite manual de 120 peticiones por minuto para la API.
- Límite manual de 10 intentos de emparejamiento por IP cada 5 minutos.
- Límite de Socket.IO de 20 conexiones simultáneas por IP y 40 intentos por minuto.
- Cuotas por evento Socket.IO, buffer máximo de 4 MB y hasta 100 RPC pendientes por panel.
- Validación de rutas y rechazo de enlaces simbólicos existentes en `safePath`.
- Consultas MySQL parametrizadas en los valores dinámicos.

## Validación realizada

- `node --check server.js`: correcto.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades.
- `git diff --check`: correcto.
- Se retiró `express-rate-limit`; el limitador manual de emparejamiento original se restauró para evitar una regresión accidental.
- El servidor arranca correctamente con la configuración de límites Socket.IO.

## Plan recomendado

Implementar primero, en este orden:

1. límites y limpieza de subidas;
2. protección SSRF y límites de descargas;
3. validación de artefactos JAR;
4. endurecimiento de MySQL;
5. límites de Socket.IO y reducción de exposición de errores.
