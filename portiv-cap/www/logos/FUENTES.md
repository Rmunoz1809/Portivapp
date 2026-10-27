# Logos de empresas

`<TICKER>.jpg`, 128 × 128 px: las empresas del S&P 500 (lista de Wikipedia del 27-oct-2026) más algunas
populares (TSM, ASML, ARM, BABA, SHOP, SPOT, MELI, NU, SE, RIVN, SOFI, HOOD, RBLX, SNOW, NET, MSTR, COIN, SMCI, SNDK).

Fuente: Finnhub (`stock_logo/<TICKER>.png`, o el campo `logo` de `/stock/profile2` cuando el ticker no está así,
p. ej. META → FB.png). `GOOGL` usa el de `GOOG` (el de Finnhub es una «A» equivocada). Sin logo en Finnhub: HONA, VYLR.

La app sabe qué tickers tienen logo por `_PV_LOGOS` en index.html: al añadir o quitar un archivo, actualiza esa lista
(y `_PV_LOGO_NAMES` si quieres que se reconozca en los titulares de noticias). Copia la carpeta también a portiv-cap/www/logos.
