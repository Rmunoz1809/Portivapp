# PORTIV — Auditoría device-matrix (iPhone/iPad, ambas orientaciones)

Objetivo: que `index.html` (single-file, Capacitor iOS) funcione correctamente en toda la
matriz de iPhone/iPad soportados, en vertical y horizontal, sin regresiones. **No rediseñar** —
que lo existente funcione bien en cada pantalla.

Archivo canónico: `/Users/rafael/Desktop/index.html` (27.423 líneas).
Bundle iOS shipped: `portiv-cap/www/index.html` (mismo repo Desktop; **no** es repo separado).
Verificación visual: **el usuario** en Simulador iOS / devices reales (safe-area no se ve en desktop).

Repo: `audit/fix-20-egress-hash`. Commits device-matrix: #4 `96b66ff`(desktop)/`77ce0fa`(iOS),
#5 `ca334c2`(desktop)/`17c459c`(iOS).

---

## Matriz de dispositivos (puntos CSS, vertical × horizontal)

| Device | Vert | Horz | Banda breakpoint (nav) |
|---|---|---|---|
| iPhone SE 3ª | 375×667 | 667×375 | móvil / móvil |
| iPhone 13 mini | 375×812 | 812×375 | móvil / móvil |
| iPhone 15/16 | 393×852 | 852×393 | móvil / móvil |
| iPhone 16 Pro Max | 440×956 | 956×440 | móvil / **desktop(≥900)** |
| iPad mini 6ª | 744×1133 | 1133×744 | **móvil(≤899)** / desktop |
| iPad 10ª / Air 11" | 820×1180 | 1180×820 | **móvil(≤899)** / desktop |
| iPad Pro 11" | 834×1194 | 1194×834 | **móvil(≤899)** / desktop |
| iPad Air/Pro 13" | 1024×1366 | 1366×1024 | desktop / desktop |
| + Split View / Slide Over / Stage Manager (ancho arbitrario) | | | según ancho |

---

## FASE 0 — Línea base (medida en código)

- **Breakpoints CSS: 16 anchos distintos** (no 24): 380, 560, 600, 640, 700, 760, 800, 860,
  880, 899, 900, 1000, 1024, 1100, 1150, 1500 (+ `hover:none`, `prefers-reduced-motion`).
  46 bloques `@media`. Paradigma de nav: **≥900 = sidebar; ≤899 = bottom-nav; ≤760 = re-estilo v2**.
- **Safe-area: 11 usos, 0 left/right** → notch lateral en horizontal nunca contemplado.
- **17 `position:fixed`**; solo el bloque `.bottom-tabs`≤760 referenciaba safe-area (ahora unificado).
- Viewport units: **7×`100vh`**, 2×`dvh`, 0×`svh/lvh/-webkit-fill-available`.
- **`overscroll-behavior`: 0 usos.**
- Viewport meta (L16): `maximum-scale=1.0, user-scalable=no, viewport-fit=cover`.
- **0 listeners `resize`/`orientationchange`/`visualViewport`** en todo el archivo.
- Nav real en móvil = `.bottom-tabs`. `.navbar`=sidebar desktop/oculto móvil. `.bottom-nav`/`.bnav`=muerto.

---

## Bugs (línea / severidad / estado)

| # | Fase | Sev | Bug | Línea(s) | Estado |
|---|---|---|---|---|---|
| 4 | 1 | 🔴 | Banda 761–899px: `.bottom-tabs`/`#tab-*` sin safe-area (solo ≤760 la tenía). iPad vertical 820/834 tapado por home indicator. | 2568/2560 vs 2735/2679 | ✅ **FIXED** `96b66ff`+`77ce0fa` |
| 5 | 1 | 🔴 | JS usa 700px (`_PERF_MOB`, `showTab`) vs CSS 899/900. iPad vertical = desktop-JS + móvil-CSS. | 14098, 12479 | ✅ **FIXED** `ca334c2`+`17c459c` |
| 3 | 1 | 🟠 | Mapear 24→consolidar a set chico. Mapa hecho (16 anchos). Consolidación CSS = riesgo visible, pendiente. | (46 @media) | ⏳ mapeado; consolidación pendiente |
| 6 | 2 | 🔴 | 0 listeners resize/orientationchange. Rotar cruza breakpoints y nada re-renderiza. | 14284 | ✅ **FIXED** `5b18b93`+`93d3a8c` |
| 7 | 2 | 🟠 | Split View / Slide Over: ancho cambia sin rotar. | n/a | ✅ cubierto por handler #6 (resize→resize()); verif device |
| 8 | 2 | 🟠 | Stage Manager: resize continuo → thrashing. | n/a | ✅ cubierto por debounce de #6 (ráfaga 50→1); verif device |
| 9 | 2 | 🟠 | Gráfica: escala/periodo/eje Y deben sobrevivir a rotación. | n/a | ✅ cubierto por #6 (resize() no regenera datos); verif device |
| 10 | 3 | 🟠 | Safe-area lateral (left/right) nunca usada; horizontal con notch mete contenido bajo el recorte. | 11 usos | ⬜ TODO |
| 11 | 3 | 🟠 | `.toast` z-index 999 < `.bottom-tabs` 9000 → toast tapado por el nav; nunca se ve en teléfono. | 374 | ✅ **FIXED** `57fe6ab`+`c9e3238` |
| 12 | 3 | 🟠 | `#acctMenu top:62px` sin `safe-area-inset-top`. | 25786 | ✅ **FIXED** `57fe6ab`+`c9e3238` |
| 13 | 3 | 🟠 | Modales (noticias/búsqueda/paywall/auth/trade): safe-areas en las 8 pantallas. | varios fixed | ⬜ TODO |
| 14 | 4 | 🟠 | 7×`100vh` (iOS ≠ área visible) → migrar a `dvh`/`-webkit-fill-available`. Chat IA + overlays. | 90,709,830,980,2442,2502,4221 | ⬜ TODO |
| 15 | 4 | 🟡 | `overscroll-behavior` ausente → scroll-chain al body / rubber-band. | 0 usos | ⬜ TODO |
| 16 | 4 | 🟠 | Al abrir modal: fondo no debe scrollear; al cerrar, restaurar scroll exacto. | n/a | ⬜ TODO |
| 17 | 4 | 🟠 | Scroll horizontal accidental; tabla 12 col debe hacer swipe sin pelear con nav del sistema. | n/a | ⬜ TODO |
| 18 | 5 | 🟠 | Sin plugin `@capacitor/keyboard`; 18 fixed. Input tapado / nav flotando / chat sin scroll. | n/a | ⬜ TODO |
| 19 | 5 | 🟠 | Probar cada input con teclado (iPhone 375×667 + iPad vertical). | n/a | ⬜ TODO |
| 20 | 5 | 🟡 | Todos los inputs `font-size ≥16px` (settings en 12px hace zoom iOS). | n/a | ⬜ TODO |
| 21 | 6 | 🟠 | 148 `:hover`, 1 `@media(hover:none)`. Hover "pegado" en táctil. Envolver en `(hover:hover)`. | n/a | ⬜ TODO |
| 22 | 6 | 🟠 | Targets táctiles <44×44 (pills periodo, DRIP, botones trade en filas, iconos header, X modales). | n/a | ⬜ TODO |
| 23 | 6 | 🟡 | `maximum-scale=1.0, user-scalable=no` bloquea pinch-zoom (accesibilidad + revisión App Store). | 16 | ⬜ TODO |
| 24 | 6 | 🟡 | Texto Dinámico grande + Zoom de Pantalla: qué se corta. | n/a | ⬜ TODO |
| 25 | 7 | 🟡 | Sin StatusBar/SplashScreen plugins. | n/a | ⬜ TODO |
| 26 | 7 | 🟠 | `location.hostname`=`localhost` en WKWebView; ramas gateadas por localhost no deben activarse en prod. | n/a | ⬜ TODO |
| 27 | 7 | 🟠 | Ciclo background/foreground + rotar en background. | n/a | ⬜ TODO |
| 28 | 7 | 🟡 | Arranque en frío SE 3ª: tiempo hasta portafolio usable. | n/a | ⬜ TODO |

Severidad: 🔴 crítico · 🟠 alto · 🟡 medio.

---

## Detalle de fixes aplicados

### #4 — Geometría única del bottom-nav con safe-area (FIXED)
`:root` con `--pv-safe-b/--pv-nav-h/--pv-nav-total/--pv-page-pad-b` como fuente única; ambos
bloques (@899 y @760) derivan de ahí. **Teléfonos ≤760: sin cambio** (valores computados idénticos).
**iPad vertical: nav respeta home indicator + padding correcto.** **Desktop ≥900: intacto.**

### #5 — Fuente única de breakpoints JS↔CSS (FIXED)
`PV_isMobile()` (≤899, = bottom-nav CSS) / `PV_isPhone()` (≤760). `_PERF_MOB()` y el guard de
animación de `showTab` ahora los consumen. Eliminado el único `innerWidth<=700` suelto.
**Medido:** acuerdo JS↔CSS **11/16 → 16/16** anchos de la matriz. Cambio visible aprobado:
iPad vertical (744/820/834) + teléfono horizontal (812/852) → gráfica **limpia** (sin ejes/grid),
acorde al layout móvil. Desktop / tablet-landscape (≥900) sin cambio. Sintaxis 9/9.

---

### #6 — Manejador único de rotación/resize (FIXED)
UN `(function _pvInstallViewportHandler(){…})()` con debounce 160ms sobre `resize`+`orientationchange`
que fuerza `perfChart.resize()` **solo si la gráfica está visible** (`offsetParent!=null`). Su `onResize`
re-lee `_PERF_MOB()`/`PV_isMobile()` y repinta con los mismos datos → período y eje Y sobreviven.
**Auditado (por qué es mínimo):** tabla de posiciones (`renderTable`) y análisis dependen del ancho
solo por `@media` CSS → se adaptan solos, no necesitan JS. La única cosa dependiente del ancho
construida por JS es la gráfica. **Medido:** listeners 0→1+1; el bloque **no** contiene ningún nombre
de red/IA (`fetchLivePrices`/`_aiFetch`/`PV_AI`/`generate`/`renderAll`/`showTab`/`EPS.`/…); ráfaga de
50 eventos → **1** `resize()` (0 durante la ráfaga = sin thrashing); gráfica oculta → 0; sintaxis 9/9.
Cubre #7 (Split View), #8 (Stage Manager) y #9 (escala) por el mismo camino.

### #11 / #12 — Toast sobre el nav + acctMenu con safe-area-top (FIXED)
**#11:** el toast (`bottom:24px; z-index:999`) quedaba detrás del bottom-nav (`z-index:9000`) y a
`bottom:24px` caía sobre él → nunca visible en teléfono. Fix **solo móvil (≤899)**: `z-index:9500`
(sobre el nav) + `bottom: calc(var(--pv-nav-total) + 12px)`. Con `*{box-sizing:border-box}` (L89)
el nav ocupa exactamente `--pv-nav-total` → el toast queda 12px por encima, sin solapar. Desktop
intacto (regla base `bottom:24px/z-index:999` sigue; la de móvil no aplica). **#12:** `#acctMenu`
`top:62px` → `calc(62px + env(safe-area-inset-top))`; desktop (inset 0) sigue en 62px. **Medido:**
z-index 9500>9000, bottom libera el box del nav, acctMenu inset-aware, desktop sin cambio, sintaxis 9/9.

## Pendiente de verificación en device (usuario)
Simulador iOS / devices: confirmar en las 8 pantallas × 2 orientaciones que (a) el nav no tapa
contenido ni se mete bajo el home indicator, (b) la gráfica en iPad vertical se ve limpia como
esperado. Screenshots "después" van acá cuando estén.
