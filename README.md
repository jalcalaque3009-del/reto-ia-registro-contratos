# Reto 02 · Registro de contratos vigentes

Prototipo independiente que procesa los seis mensajes ficticios del reto, registra contratos en un maestro CSV simulado y genera alertas. La conversación usa OpenAI y las herramientas deterministas también pueden ejecutarse sin clave.

Demo: https://reto-ia-registro-contratos.vercel.app/ (requiere la contraseña de acceso facilitada por el propietario).

El reto exige procesar los adjuntos de texto que ya están en el buzón simulado. No requiere subir archivos desde el chat. La lectura de PDF nativo es opcional en el documento y no está implementada en este prototipo.

La extracción para el maestro usa reglas adaptadas a los fixtures y obtiene solo ciertos campos. Para responder preguntas sobre otras cláusulas de los contratos de muestra, el agente puede consultar el texto original de cada adjunto; no utiliza OCR ni acepta archivos subidos por el usuario. La interpretación del modelo puede equivocarse y debe cotejarse con el texto original.

## Requisitos y ejecución

Node.js 20 o superior y npm. Desde la carpeta raíz:

```bash
npm install
npm run demo
```

La demo limpia `out/` al comenzar, incluso si el servidor usa otro directorio de salida. No la ejecutes desde una carpeta cuyo `out/` necesites conservar. Para que sea reproducible usa el reloj simulado `2026-09-03` como fecha de registro; el servidor normal usa la fecha actual UTC al registrar, no la fecha del correo. Muestra el bloqueo de `msg-006` y una segunda llamada con fechas y moneda del valor introducidas como ejemplo por un revisor simulado: **esos datos no están determinados en el contrato y no se deben asumir en un caso real**. La mención de COP en el texto corresponde al umbral de una póliza, no establece la moneda del valor del contrato marco.

Para el chat, crea `.env` a partir de `.env.example` y configura `OPENAI_API_KEY` en ese archivo local. En Windows con PowerShell 7, cifra la clave para tu cuenta de Windows y retírala de `.env` con `pwsh -NoProfile -File scripts/encrypt-key.ps1`. El archivo cifrado `.secrets/openai.dpapi` está excluido de Git y solo lo descifra la misma cuenta de Windows en la misma máquina. En otros servidores, usa el almacén de secretos del proveedor para proporcionar `OPENAI_API_KEY` al proceso. Ejecuta:

```bash
npm run dev
```

Abre `http://127.0.0.1:3000`. Alternativamente establece `PORT`. No incluyas `.env`, `.secrets/`, `out/` ni `node_modules` en el repositorio. La clave se descifra en memoria para enviarla exclusivamente a OpenAI; cualquier proceso malicioso ejecutado como el mismo usuario de Windows podría acceder a ella. El proyecto no necesita conexión a correo ni SharePoint reales.

El servidor escucha solo en localhost por defecto. Para uso por red hay que definir `HOST`, una `ACCESS_PASSWORD` única de al menos 20 caracteres y un proxy HTTPS. La autenticación Basic, los límites en memoria y la ausencia de una auditoría externa no hacen de este prototipo un servicio de producción: proteger además con un límite de gasto duro y controles de acceso del proveedor. No compartir la contraseña de acceso con personas no autorizadas.

## API

`GET /api/health` devuelve proveedor y modelo; `GET /api/sessions/:id` devuelve solo el historial que conserva la instancia en memoria; `POST /api/chat` recibe `{ "sessionId": "una-sesion", "message": "..." }` y responde con `reply`, `toolCalls`, `needsConfirmation` y uso acumulado. En local, el contexto del servidor se pierde al reiniciar. En Vercel, el navegador devuelve un `sessionToken` cifrado con los turnos para restaurar el contexto entre peticiones; el historial visible permanece en ese navegador, pero el endpoint GET no garantiza recuperarlo entre instancias. Las herramientas escriben en `out/log.jsonl` en local; el maestro original en `fixtures/` nunca se modifica.

`contratos_consultar_maestro` consulta el maestro completo por fecha de vigencia, rango de vencimiento, cliente o identificador. Señala si usó la copia de salida o el fixture original y advierte si faltan fechas necesarias para determinar una coincidencia; el reporte de alertas de 60 días no equivale al total de vigentes. Listar el buzón no marca mensajes como procesados; el procesamiento marca expresamente un mensaje rechazado mediante `contratos_rechazar`.

El procesamiento se limita con `MAX_TURNS`, `MAX_SESSION_TOKENS`, `MAX_TOTAL_TOKENS` y un máximo de 100 turnos por proceso. Estos topes en memoria se reinician al reiniciar el servidor, pueden excederse en peticiones concurrentes y no sustituyen un límite de gasto configurado en OpenAI. El control de gasto puede superar levemente el límite por latencia de aplicación. No expongas este prototipo sin autenticación y límites de servidor adecuados. El modelo está fijado a `gpt-5.4`.

La clave de API de proyecto puede tener fecha de expiración. Configúrala por un máximo de tres días y establece un límite de gasto en el proyecto: https://developers.openai.com/api/docs/guides/spend-limits .

## Prueba propuesta

«Procesa el buzón de contratos con fecha 2026-09-03. Registra los casos sin dudas y muéstrame los que requieren revisión». Para confirmar, el mensaje debe comenzar por `Confirmo` o `Autorizo` e incluir literalmente los valores corregidos. La fecha de firma ausente no se deduce del correo.

Pruebas técnicas: `npm run check`, `npm test` y `npm run demo`.

## Demostración en Vercel

El repositorio permite importar el proyecto en Vercel como Express. Configura en Vercel las variables de producción `OPENAI_API_KEY` y `ACCESS_PASSWORD` como **Secret**, con una contraseña aleatoria única de al menos 20 caracteres; nunca pongas la clave en el código ni en el navegador. Sin contraseña el servidor alojado no arranca. Comparte la contraseña de acceso solo con la persona evaluadora por un canal seguro; el nombre de usuario de Basic Auth puede ser cualquiera. Vercel sirve HTTPS.

El historial visible se guarda en el almacenamiento local del navegador y permite abrir varias conversaciones, borrarlas o exportarlas. El texto del historial no está cifrado en ese navegador: no uses datos confidenciales ni dispositivos compartidos y elimina las conversaciones cuando acabes. El contexto que devuelve el servidor está cifrado y autenticado antes de almacenarse en el navegador.

En Vercel, el maestro, los archivos generados y los marcadores se guardan en una base PostgreSQL compartida, configurada mediante `POSTGRES_URL` o `DATABASE_URL` como secreto del proveedor. Cada operación usa una transacción con bloqueo para evitar sobrescrituras entre instancias; la instantánea de archivos está limitada a 16 MiB. Si la base no está disponible, el sitio no debe volver silenciosamente al almacenamiento temporal. Las salidas anteriores que existían solo en `/tmp` no se migran automáticamente. Los botones permiten descargar el maestro CSV y las alertas existentes en la base. En local se usan archivos en `out/` por defecto; para probar PostgreSQL localmente se puede establecer `CONTRATOS_PERSISTENCE=postgres` y la cadena de conexión como variable de entorno.

Los contadores de gasto siguen en memoria y pueden reiniciarse o ser distintos entre instancias; fija además un límite de gasto en OpenAI. El acceso compartido por contraseña, la extracción adaptada a los fixtures y la ausencia de auditoría externa mantienen el proyecto como prototipo; no se debe usar con datos reales sin controles adicionales.
