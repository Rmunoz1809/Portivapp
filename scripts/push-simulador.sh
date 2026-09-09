#!/bin/bash
# Ver las notificaciones en el SIMULADOR.
#
# El simulador NO recibe push de APNs de verdad: no hay token válido de Apple. Lo que
# sí acepta es un payload local con `simctl push`, que es idéntico al que manda la
# Edge Function. Sirve para ver el texto, el corte de la pantalla de bloqueo y el tap.
# Para probar el camino completo (servidor → Apple → teléfono) hace falta un iPhone real.
#
#   ./scripts/push-simulador.sh            # genera los payloads y los manda
#   ./scripts/push-simulador.sh matutina   # sólo la de la mañana
#   ./scripts/push-simulador.sh cierre     # sólo la del cierre
set -e
BUNDLE=com.portivapp.portafolio
UDID=$(xcrun simctl list devices booted -j | python3 -c "
import json,sys
d=json.load(sys.stdin)['devices']
for _,ds in d.items():
    for x in ds:
        print(x['udid']); raise SystemExit
print('', end='')")
[ -z "$UDID" ] && { echo "No hay simulador arrancado. Abre Xcode → Open Developer Tool → Simulator."; exit 1; }
OUT=$(mktemp -d)

# Los textos salen del MOTOR REAL, no están escritos a mano aquí.
TZ=America/New_York node --input-type=module -e "
import { macroEventsForDay, pvNewsRank, textoMatutino, textoCierre } from './supabase/functions/_shared/push-rank.js';
import { writeFileSync } from 'node:fs';
const D='$OUT/';
const h=(t,w,d)=>({ticker:t,qty:w*1000,price:100,dayChgPct:d});
const cartera=[h('NVDA',.30,-2.1),h('AAPL',.20,1.4),h('MSFT',.20,.3),h('VOO',.30,-.4)];
const ev=macroEventsForDay('2026-09-16');
const r=pvNewsRank({fechaISO:'2026-09-16',eventos:ev,holdings:cartera,historial:[]});
const am=textoMatutino(r.ganador,cartera);
writeFileSync(D+'matutina.apns',JSON.stringify({'Simulator Target Bundle':'$BUNDLE',
  aps:{alert:{title:am.titulo,body:am.cuerpo},sound:'default','interruption-level':'active'},
  deeplink:'portiv://calendario/'+encodeURIComponent(r.ganador.evento.id),
  titulo_evento:r.ganador.evento.titulo,log_id:null}));
const cl=textoCierre(cartera);
writeFileSync(D+'cierre.apns',JSON.stringify({'Simulator Target Bundle':'$BUNDLE',
  aps:{alert:{title:cl.titulo,body:cl.cuerpo},sound:'default','interruption-level':'active'},
  deeplink:'portiv://posicion/'+cl.ticker,titulo_evento:null,log_id:null}));
console.log('  matutina:', am.titulo, '|', am.cuerpo);
console.log('  cierre  :', cl.titulo, '|', cl.cuerpo);
"
CUAL=${1:-ambas}
[ "$CUAL" = "ambas" ] || [ "$CUAL" = "matutina" ] && xcrun simctl push "$UDID" "$BUNDLE" "$OUT/matutina.apns"
[ "$CUAL" = "ambas" ] || [ "$CUAL" = "cierre" ]   && xcrun simctl push "$UDID" "$BUNDLE" "$OUT/cierre.apns"
echo
echo "Enviado. Si no ves nada:"
echo "  · La app tiene que estar INSTALADA y con el permiso de notificaciones concedido."
echo "  · Mándala a segundo plano (Cmd+Shift+H) antes de disparar."
echo "  · Desliza desde arriba para ver el centro de notificaciones."
