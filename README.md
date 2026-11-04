# Reto 02 · Registro de contratos vigentes

Prototipo independiente que procesa los seis mensajes ficticios del reto, registra contratos en un maestro CSV simulado y genera alertas. La conversación usa OpenAI y las herramientas deterministas también pueden ejecutarse sin clave.

## Requisitos y ejecución

Node.js 20 o superior y npm. Desde la carpeta raíz:

```bash
npm install
npm run demo
```

La demo limpia `out/` al comenzar. Muestra el bloqueo de `msg-006` y una segunda llamada con fechas de ejemplo introducidas por un revisor simulado: **esas fechas no están en el contrato y no se deben asumir en un caso real**.

Para el chat, crea `.env` a partir de `.env.example`, configura `OPENAI_API_KEY` solo en ese archivo local o como variable de entorno del servidor, y ejecuta:

```bash
npm run dev
```

Abre `http://localhost:3000`. Alternativamente establece `PORT`. No incluyas `.env`, `out/` ni `node_modules` en el repositorio. La clave no se envía al navegador. El proyecto no necesita conexión a correo ni SharePoint reales.

## API

`GET /api/health` devuelve proveedor y modelo; `GET /api/sessions/:id` devuelve el historial en memoria; `POST /api/chat` recibe `{ "sessionId": "una-sesion", "message": "..." }` y responde con `reply`, `toolCalls`, `needsConfirmation` y uso acumulado. La sesión se pierde al reiniciar. Las herramientas escriben en `out/log.jsonl`; el maestro original en `fixtures/` nunca se modifica.

El procesamiento se limita con `MAX_TURNS`, `MAX_SESSION_TOKENS`, `MAX_TOTAL_TOKENS` y un máximo de 100 turnos por proceso. Estos topes en memoria se reinician al reiniciar el servidor y no sustituyen un límite de gasto configurado en OpenAI. El control de gasto puede superar levemente el límite por latencia de aplicación. No expongas este prototipo sin autenticación y límites de servidor adecuados.

La clave de API de proyecto puede tener fecha de expiración. Configúrala por un máximo de tres días y establece un límite de gasto en el proyecto: https://developers.openai.com/api/docs/guides/spend-limits .

## Prueba propuesta

«Procesa el buzón de contratos con fecha 2026-09-03. Registra los casos sin dudas y muéstrame los que requieren revisión». Para confirmar, el mensaje debe comenzar por `Confirmo` o `Autorizo` e incluir literalmente los valores corregidos. La fecha de firma ausente no se deduce del correo.

Pruebas técnicas: `npm run check` y `npm run demo`. El acceso público a la aplicación está pendiente de despliegue; puede demostrarse localmente.
