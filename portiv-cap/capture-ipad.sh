#!/bin/bash
# Captura screenshots iPad Pro 13" (2064x2752) para App Store Connect.
# www/index.html se mantiene LIMPIO (sin bypass). El desbloqueo/navegación
# se inyecta en una copia temporal usada solo para el simulador.
UDID=F0A618C3-1B0A-4DF2-A6F6-ED141129B62D
APP=/tmp/portiv-dd/Build/Products/Debug-iphonesimulator/App.app
PUB="$APP/public/index.html"
SRC_CLEAN=/Users/rafael/Desktop/portiv-cap/www/index.html
SHOT=/tmp/portiv-shot-src.html
OUT=/Users/rafael/Desktop/portiv-ipad-screenshots
BID=com.portivapp.portafolio
mkdir -p "$OUT"

# Construir fuente de screenshot = www limpio + script de desbloqueo/navegación
python3 - "$SRC_CLEAN" "$SHOT" <<'PY'
import sys
src,dst=sys.argv[1],sys.argv[2]
h=open(src,encoding='utf-8').read()
inj=('<script>(function(){function u(){document.documentElement.classList.remove("app-locked");'
     'var o=document.getElementById("authOverlay");if(o)o.style.display="none";'
     'var t="__SHOT_TAB_DEFAULT__";if(t&&t.charAt(0)!=="_"&&typeof showTab==="function"){'
     'var n=0,iv=setInterval(function(){try{showTab(t);}catch(e){}if(++n>16)clearInterval(iv);},250);}}'
     'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",u);else u();})();</script></body>')
open(dst,"w",encoding='utf-8').write(h.replace("</body>",inj,1))
PY

xcrun simctl boot $UDID 2>/dev/null || true
sleep 3
for tab in portfolio analizar aianalyst watchlist noticias; do
  sed "s/__SHOT_TAB_DEFAULT__/$tab/g" "$SHOT" > "$PUB"
  xcrun simctl install $UDID "$APP" >/dev/null 2>&1
  xcrun simctl terminate $UDID $BID >/dev/null 2>&1 || true
  xcrun simctl launch $UDID $BID >/dev/null 2>&1
  sleep 11
  xcrun simctl io $UDID screenshot "$OUT/portiv-ipad-$tab.png" >/dev/null 2>&1
  echo "captured: $tab"
done
echo "--- resultado ---"
sips -g pixelWidth -g pixelHeight "$OUT"/portiv-ipad-portfolio.png 2>/dev/null | grep pixel
