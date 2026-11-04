# Solución · Registro de contratos vigentes

## Problema y elección

Administración y gerencia no cuentan con un registro completo y vigente porque los contratos llegan por canales dispersos. Se escogió el reto 02 porque sus adjuntos ya vienen como texto y su salida es un CSV, evitando generación de Excel/PDF del reto 01 y el conjunto de controles y adaptador SAP del 03.

## Arquitectura

`web/` chat → `src/server.ts` ciclo y sesión → `src/llm/` interfaz y adaptador OpenAI → `src/tools/contratos.ts` herramientas validadas con Zod → `fixtures/` lectura y `out/` escritura. `agent/prompt.md` define comportamiento; `src/knowledge/registro-contratos.md` contiene conocimiento. Un adaptador distinto implementa `LlmAdapter` sin alterar las herramientas. `demo.ts` ejecuta herramientas directamente sin modelo.

El ciclo envía mensajes y definiciones de herramientas, ejecuta las solicitudes y devuelve sus resultados al modelo hasta alcanzar el máximo por turno. Cada llamada se presenta en el chat y se registra. Para revisión humana se requiere un mensaje explícito en un turno posterior; el servidor compara los datos registrados con la extracción original y exige que cualquier modificación figure en el mensaje de confirmación. Las fechas ausentes impiden el registro. Errores se informan sin finalizar el proceso. El cliente no recibe claves.

## Modelo y costo

Se usa exclusivamente `gpt-5.4`, por instrucción de la persona usuaria. Referencia: [modelo y tarifas](https://developers.openai.com/api/docs/models/gpt-5.4). A USD 2,50 por millón de tokens de entrada y USD 15 por millón de salida, un ejemplo de 10.000 de entrada y 1.000 de salida cuesta aproximadamente USD 0,04; es una estimación, no una medición del caso. Los límites de la aplicación son aproximados y volátiles; el control de gasto efectivo se configura también en el proyecto de OpenAI. Los créditos de API elegibles de Pro se aplican a la organización vinculada y son distintos de la cuota de Codex.

## Extracción y validación

Se detectan el número, partes, identificación, cláusula de objeto, importe, moneda, plazo, póliza y remitente mediante patrones sobre el texto del adjunto. Los campos presentes reciben confianza 1; los ausentes, 0; el valor por demanda y la póliza condicional reciben 0,5. En `msg-006` el día de firma y las fechas de vigencia no aparecen, por lo que no se inventan. La fecha del correo tampoco prueba la fecha de firma. El modelo organiza y explica los resultados de las herramientas, pero el backend no acepta que altere valores salvo que una persona los indique y confirme explícitamente. Las heurísticas están adaptadas al formato de los fixtures: no son un extractor jurídico universal.

Los identificadores exactos prevalecen; como alternativa se compara NIT y similitud normalizada de objeto (distancia de edición). Un otrosí exige registro previo y mantiene datos no modificados. Se archiva el adjunto de texto realmente recibido, sin fingir que es un PDF. Alertas usan una fecha de referencia explícita y el maestro de salida.

## Regla de gobierno propuesta

1. Canal único: `contratos@periferia-ficticia.com`, administrado por la jefatura administrativa, con suplente designado.
2. Cada comercial envía contrato firmado, otrosí y acta de terminación dentro de dos días hábiles de la firma, con asunto `Contrato | cliente | identificador | fecha`. Incluye pólizas y anexos disponibles, aunque no requiera garantía.
3. Un acuse automático dentro de una hora informa identificador de recepción, documentos detectados y estado pendiente; no equivale a aprobación jurídica.
4. Sin firma, se solicita el documento firmado y se escala al gerente comercial en dos días hábiles. Sin valor determinado o con datos contradictorios, se mantiene en revisión y se solicita aclaración; no se inventan importes ni fechas. Si existe riesgo contractual, se consulta asesoría jurídica externa.
5. Para reconstruir junio–agosto de 2026 se cruza en una campaña única el listado de facturas y oportunidades cerradas con el maestro; cada comercial entrega faltantes, administración concilia duplicados y documenta excepciones, y gerencia firma el cierre de la campaña.
6. Indicador mensual: porcentaje de contratos facturados que tienen un registro vigente y soporte firmado en el maestro, con responsable, fecha de corte y seguimiento a faltantes.

## Decisiones, supuestos y límites

- CSV y archivos locales frente a SharePoint real: reproducibilidad y ausencia de credenciales; no hay transacciones distribuidas ni control multiusuario.
- Extracción determinista frente a delegar cifras al modelo: trazabilidad para fixtures; puede fallar ante redacción distinta y debe llevar revisión humana.
- Conservación estricta de ausencias frente a inferir la firma: evita inventar hechos; el contrato marco no se registra hasta recibir fechas.
- Se asume que el CSV y los textos son ficticios y reflejan los ejemplos del reto. El remitente desconocido se informa sin bloquear.

| Historia | Estado | Pendiente para producción |
|---|---|---|
| HU-1 buzón | Hecho para fixtures | Conector y acuse reales |
| HU-2 extracción | Parcial | Generalización, OCR, pruebas con contratos reales |
| HU-3 validación | Parcial | Revisión de similitud y clasificación en casos ambiguos |
| HU-4 registro y archivo | Parcial | Transacciones, concurrencia, archivo y control de acceso real |
| HU-5 alertas | Hecho para fixtures | Programación y entrega autorizada |
| HU-6 errores | Parcial | Cobertura de formatos y recuperación exhaustiva |

El adaptador de Vercel utiliza un contexto de sesión cifrado y autenticado en el navegador. El maestro y los archivos se guardan en almacenamiento temporal de la instancia y pueden desaparecer al reiniciar; distintas instancias no comparten esos datos. Los contadores de presupuesto están en memoria y se reinician. Para producción hacen falta persistencia, autenticación por usuario, presupuesto centralizado, auditoría sin datos sensibles y acceso restringido. Los fixtures no representan datos reales.

## Uso de IA

Se utilizó OpenAI Codex para comparar los requisitos, implementar el prototipo, ejecutar pruebas y redactar esta explicación. La decisión de no inventar la fecha del contrato marco descarta la inferencia de la fecha del correo. Antes de la defensa, la persona candidata debe revisar y poder explicar la implementación y sus limitaciones.
