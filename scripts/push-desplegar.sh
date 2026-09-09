#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Despliegue completo del sistema de notificaciones push
#  ───────────────────────────────────────────────────────────────────────
#  Se comprobó el 2026-09-09 que en el proyecto NO existía nada del lado
#  servidor: ni las tablas, ni el RPC, ni las tres funciones, ni los cron.
#  Este script hace todo en el orden correcto y falla ruidosamente.
#
#  Lo único que NO hace es meter el secreto en Vault: eso queda como un solo
#  pegado en el editor SQL, con el valor ya puesto en el portapapeles.
#
#  Uso:  ./scripts/push-desplegar.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

REF=zblhifszlhdgkhnymwjh
cd "$(dirname "$0")/.."

paso() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

paso "1/5 · Sesión del CLI"
if ! supabase projects list >/dev/null 2>&1; then
  echo "No hay sesión. Se abre el navegador para autenticar."
  supabase login
fi
echo "Sesión OK."

paso "2/5 · Enlazar el proyecto"
# Pide la contraseña de la base de datos la primera vez.
supabase link --project-ref "$REF"

paso "3/5 · Migraciones (tablas, RLS, RPC y los dos cron)"
# El historial remoto tiene 18 migraciones de junio y julio cuyos archivos nunca
# se guardaron en el repo. `db push` se niega a seguir mientras esa divergencia
# exista. `migration repair --status reverted` sólo BORRA ESAS FILAS DE LA TABLA
# DE HISTORIAL: no revierte nada, no toca ni un objeto de la base. El esquema que
# crearon sigue exactamente igual. Es lo que recomienda el propio CLI y es la
# única salida, porque los archivos no existen en ninguna parte para recuperarlos.
HUERFANAS=(
  20260625000000 20260702120000 20260712170000 20260712170100 20260713172000
  20260713173000 20260713173100 20260713180000 20260714110000 20260714120000
  20260714130000 20260714140000 20260714150000 20260714160000 20260714182943
  20260714182945 20260720120000 20260720120100
)
if ! supabase db push --dry-run >/dev/null 2>&1; then
  echo "Historial divergente: se limpian las 18 entradas sin archivo."
  supabase migration repair --status reverted "${HUERFANAS[@]}"
fi
# --include-all: tres migraciones locales de snaptrade son más antiguas que la
# última del remoto y sin esto el CLI se planta. Se comprobó una por una que son
# re-ejecutables: `add column if not exists`, `create table/index if not exists`,
# y el único `update` está filtrado por `is null`, así que no pisa datos.
supabase db push --include-all

paso "4/5 · Secreto compartido y credenciales de APNs"
# Se genera aquí y no se escribe a mano en ningún sitio.
SECRETO=$(openssl rand -hex 32)
supabase secrets set PUSH_CRON_SECRET="$SECRETO"
echo "PUSH_CRON_SECRET puesto en las Edge Functions."

# Las de APNs sólo si aún no están: no se pisan las que ya existan.
if ! supabase secrets list 2>/dev/null | grep -q APNS_KEY_ID; then
  echo
  echo "⚠️  Faltan los secretos de APNs. Ponlos con:"
  echo "    supabase secrets set APNS_KEY_ID=…"
  echo "    supabase secrets set APNS_TEAM_ID=K97579JSV7"
  echo "    supabase secrets set APNS_BUNDLE_ID=…"
  echo "    supabase secrets set APNS_KEY_P8=\"\$(cat AuthKey_XXXX.p8)\""
fi

paso "5/5 · Desplegar las tres funciones"
supabase functions deploy apns-push    --no-verify-jwt
supabase functions deploy push-morning --no-verify-jwt
supabase functions deploy push-close   --no-verify-jwt

# ── Último paso, manual a propósito ─────────────────────────────────────────
# pg_cron no ve los secretos de las Edge Functions: necesita el mismo valor en
# Vault. Se deja en el portapapeles para pegarlo una vez.
printf "select vault.create_secret('%s', 'push_cron_secret');\n" "$SECRETO" | pbcopy

cat <<FIN

═══════════════════════════════════════════════════════════════════════════
 Falta UN pegado y queda listo.

 En el portapapeles tienes la línea que crea el secreto en Vault. Pégala en:
   https://supabase.com/dashboard/project/$REF/sql/new

 Sin eso los cron mandan la cabecera vacía y las funciones responden 403.

 Para comprobar que quedó bien:
   select jobname, schedule from cron.job where jobname like 'push-%';
   select name from vault.secrets;
═══════════════════════════════════════════════════════════════════════════
FIN
