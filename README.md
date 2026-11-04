# Reto 02 · Registro de contratos vigentes

Prototipo independiente que procesa los seis mensajes ficticios del reto, registra contratos en un maestro CSV simulado y genera alertas. La conversación usa OpenAI y las herramientas deterministas también pueden ejecutarse sin clave.

## Requisitos y ejecución

Node.js 20 o superior y npm. Desde la carpeta raíz:

```bash
npm install
npm run demo
```

La demo limpia `out/` al comenzar. Muestra el bloqueo de `msg-006` y una segunda llamada con fechas de ejemplo introducidas por un revisor simulado: **esas fechas no están en el contrato y no se deben asumir en un caso real**.

Para el chat, crea `.env` a partir de `.env.example` y configura `OPENAI_API_KEY` en ese archivo local. En Windows con PowerShell 7, cifra la clave para tu cuenta de Windows y retírala de `.env` con `pwsh -NoProfile -File scripts/encrypt-key.ps1`. El archivo cifrado `.secrets/openai.dpapi` está excluido de Git y solo lo descifra la misma cuenta de Windows en la misma máquina. En otros servidores, usa el almacén de secretos del proveedor para proporcionar `OPENAI_API_KEY` al proceso. Ejecuta:

```bash
npm run dev
```

Abre `http://127.0.0.1:3000`. Alternativamente establece `PORT`. No incluyas `.env`, `.secrets/`, `out/` ni `node_modules` en el repositorio. La clave se descifra en memoria para enviarla exclusivamente a OpenAI; cualquier proceso malicioso ejecutado como el mismo usuario de Windows podría acceder a ella. El proyecto no necesita conexión a correo ni SharePoint reales.

El servidor escucha solo en localhost por defecto. Para uso por red hay que definir `HOST`, una `ACCESS_PASSWORD` única de al menos 20 caracteres y un proxy HTTPS. La autenticación Basic, los límites en memoria y la ausencia de una auditoría externa no hacen de este prototipo un servicio de producción: proteger además con un límite de gasto duro y controles de acceso del proveedor. No compartir la contraseña de acceso con personas no autorizadas.

## API

`GET /api/health` devuelve proveedor y modelo; `GET /api/sessions/:id` devuelve el historial en memoria; `POST /api/chat` recibe `{ "sessionId": "una-sesion", "message": "..." }` y responde con `reply`, `toolCalls`, `needsConfirmation` y uso acumulado. La sesión se pierde al reiniciar. Las herramientas escriben en `out/log.jsonl`; el maestro original en `fixtures/` nunca se modifica.

El procesamiento se limita con `MAX_TURNS`, `MAX_SESSION_TOKENS`, `MAX_TOTAL_TOKENS` y un máximo de 100 turnos por proceso. Estos topes en memoria se reinician al reiniciar el servidor, pueden excederse en peticiones concurrentes y no sustituyen un límite de gasto configurado en OpenAI. El control de gasto puede superar levemente el límite por latencia de aplicación. No expongas este prototipo sin autenticación y límites de servidor adecuados. El modelo está fijado a `gpt-5.4`.

La clave de API de proyecto puede tener fecha de expiración. Configúrala por un máximo de tres días y establece un límite de gasto en el proyecto: https://developers.openai.com/api/docs/guides/spend-limits .

## Prueba propuesta

«Procesa el buzón de contratos con fecha 2026-09-03. Registra los casos sin dudas y muéstrame los que requieren revisión». Para confirmar, el mensaje debe comenzar por `Confirmo` o `Autorizo` e incluir literalmente los valores corregidos. La fecha de firma ausente no se deduce del correo.

Pruebas técnicas: `npm run check`, `npm test` y `npm run demo`.

## Demostración en Vercel

El repositorio permite importar el proyecto en Vercel como Express. Configura en Vercel las variables de producción `OPENAI_API_KEY` y `ACCESS_PASSWORD` como **Secret**, con una contraseña aleatoria única de al menos 20 caracteres; nunca pongas la clave en el código ni en el navegador. Sin contraseña el servidor alojado no arranca. Comparte la contraseña de acceso solo con la persona evaluadora por un canal seguro; el nombre de usuario de Basic Auth puede ser cualquiera. Vercel sirve HTTPS.

El historial visible se guarda en el almacenamiento de la pestaña y el contexto que devuelve el servidor está cifrado y autenticado antes de almacenarse en la pestaña. El maestro y los archivos generados de la demo se escriben en almacenamiento temporal: una instancia puede reiniciarse o cambiar y perderlos, y las instancias no comparten ese estado. Los contadores de límite también son temporales y pueden reiniciarse o ser distintos entre instancias; fija además un límite de gasto duro en OpenAI. Para producción se requiere persistencia y limitación centralizadas, autenticación por usuario y auditoría de seguridad. El enlace alojado queda sujeto al acceso y configuración de la cuenta de Vercel.
