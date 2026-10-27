# Logos de empresas

`<TICKER>.jpg`, 128 × 128 px, empaquetados con la app (web y Xcode):
- Las empresas del S&P 500 (lista de Wikipedia del 27-oct-2026), todas las acciones del catálogo `STOCK_DB` y algunas populares.
  Fuente: Finnhub (`stock_logo/<TICKER>.png`, o el campo `logo` de `/stock/profile2`, p. ej. META → FB.png).
  `GOOGL` usa el de `GOOG` (el de Finnhub es una «A» equivocada).
- ETF: el cuadro de su gestora (`_iss-<gestora>.jpg`): Vanguard, iShares, SPDR, Invesco, Schwab, ARK, VanEck, Global X,
  First Trust, WisdomTree, KraneShares, Amplify, U.S. Global, USCF, Grayscale, ProShares, Fidelity. iShares, ARK y VanEck
  son sus logos vectoriales (Wikimedia) en blanco; Invesco y Schwab, los de Finnhub; el resto, el nombre sobre el color de marca.

Cualquier otra acción carga su logo sola (`_pvLogoUrl` → `/stock/profile2` por el proxy) y lo guarda en el dispositivo
(`pv_logo_remote_v1`). La lista de empaquetados es `_PV_LOGOS` en index.html: al añadir archivos, actualízala.
Copia la carpeta también a portiv-cap/www/logos.
