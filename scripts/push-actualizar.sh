#!/bin/bash
# Push a TODOS los dispositivos: "hay versión nueva de Portiv, actualiza".
# Pensado para los usuarios de builds viejas (≤1.0.3) que no traen el bloqueo de versión.
#
#   ./scripts/push-actualizar.sh            # ensayo: cuenta destinatarios, NO envía
#   ./scripts/push-actualizar.sh --enviar   # envía de verdad
#
# Seguridad: con --enviar se niega si la App Store todavía no publica la versión
# VERSION_ESPERADA (mandar el aviso antes = gente que abre la tienda y no ve nada).
set -e
cd "$(dirname "$0")/.."
REF=zblhifszlhdgkhnymwjh
VERSION_ESPERADA=${VERSION_ESPERADA:-1.0.5}
TITULO="Nueva versión de Portiv"
CUERPO="Ya está disponible en la App Store. Actualiza para tener las últimas mejoras."

TIENDA=$(curl -s "https://itunes.apple.com/lookup?bundleId=com.portivapp.portafolio&t=$(date +%s)" \
  | python3 -c "import json,sys;r=json.load(sys.stdin)['results'];print(r[0]['version'].split('(')[0] if r else '')")
echo "App Store publica: ${TIENDA:-?}  (se espera $VERSION_ESPERADA)"

# El secreto vive en Vault; se lee al vuelo y nunca se imprime.
SECRETO=$(supabase db query --linked -o json \
  "select decrypted_secret as s from vault.decrypted_secrets where name='push_cron_secret'" 2>/dev/null \
  | python3 -c "import json,sys;d=json.load(sys.stdin);r=d.get('rows',d) if isinstance(d,dict) else d;print(r[0]['s'])")
[ -z "$SECRETO" ] && { echo "No pude leer push_cron_secret de Vault (¿supabase login / link?)."; exit 1; }

MODO='"dry_run":true,'
if [ "$1" = "--enviar" ]; then
  python3 -c "import sys;a=[int(x) for x in '$TIENDA'.split('.')];b=[int(x) for x in '$VERSION_ESPERADA'.split('.')];sys.exit(0 if a>=b else 1)" 2>/dev/null \
    || { echo "✋ La App Store aún no publica $VERSION_ESPERADA. No se envía."; exit 1; }
  MODO=''
fi

curl -s -X POST "https://$REF.supabase.co/functions/v1/apns-push" \
  -H "content-type: application/json" -H "x-cron-secret: $SECRETO" \
  -d "{\"todos\":true,$MODO\"titulo\":\"$TITULO\",\"cuerpo\":\"$CUERPO\",\"deeplink\":\"portiv://home\"}"
echo
[ "$1" = "--enviar" ] || echo "(ensayo — para enviar: ./scripts/push-actualizar.sh --enviar)"
