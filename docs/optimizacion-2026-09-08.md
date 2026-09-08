# Optimización de carga, precios y costo de IA — 8 de septiembre de 2026

## Qué cambió

### Precios (cotizaciones en lote)
- `finnhub-proxy` acepta `/quote?symbols=A,B,C` (hasta 60): una invocación, UNA lectura de
  `fh_cache` para todos, upstream sólo para los que faltan (8 en paralelo) y un solo upsert.
  Comparte claves con el camino individual, así que la caché sigue siendo una.
- Cliente: `apiCall({action:'quote'})` pide el lote primero y cae símbolo a símbolo sólo si el
  lote no responde; `fetchLivePrices` pasa de rondas de 5 en serie (con 300 ms de pausa) a un
  lote de 40. Medido: 5 símbolos en 1,36 s en frío y 0,55 s con caché; antes ~0,5 s POR símbolo.

### Costo de IA (gemini-proxy)
- `thinkingConfig.thinkingLevel`: `low` para la familia flash (por defecto venía `medium` y
  los tokens de razonamiento se cobran como salida), `minimal` para -lite. Afecta a visión (OCR),
  chat en modo opinión y todo lo estructurado. Sin cambio de contrato con el cliente.
- Contabilidad real en `_PRICING`/`_tokAdd`: `claude-sonnet-5` $2/$10 (antes $3/$15),
  `gemini-3.5-flash-lite` $0.30/$2.50, búsqueda web Gemini $0.014 por consulta (Anthropic $0.01).

### Carga inicial (pendiente de un clic)
- `.github/workflows/pages.yml` construye `dist/index.html` (−42 % gzip: 937 KB → 541 KB,
  JS 2,45 MB → 1,43 MB) y lo publica en Pages. **Falta**: GitHub → Settings → Pages →
  Source = "GitHub Actions". Hasta entonces el workflow construye pero el sitio sigue sirviendo
  el fuente crudo (3,1 MB). El fuente no se toca; sus comentarios siguen siendo la documentación.

## Hallazgos que quedan abiertos
- `anthropic-proxy` está desplegado (v21) pero su código NO está en el repo: no se puede auditar
  ni versionar. Recuperarlo del dashboard y guardarlo en `supabase/functions/anthropic-proxy/`.
- Gemini 3.x cobra la búsqueda web POR CONSULTA y no acepta tope de consultas por petición: el
  `max_uses` del cliente no limita nada en Gemini. 5000 consultas/mes gratis, luego $14/1000.
- `gemini-3.1-flash-lite` (20 usos en el cliente) tiene retiro anunciado el 2027-05-07; el
  `MODEL_FALLBACK` del proxy lo reconduce a `gemini-3.5-flash-lite` cuando deje de existir.
- Prewarm de 3 briefs de noticias por sesión (`PREWARM_FEED_MAX`) sigue siendo gasto especulativo
  en la vía de pago; decisión de producto, no se tocó.
