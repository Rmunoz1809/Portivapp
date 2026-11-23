// creators-admin — Edge Function (Deno)
// ─────────────────────────────────────────────────────────────────────────────
// Alta y edición de creadores desde portivapp.com/creadores/admin.html. Solo el dueño
// (access_grants.kind = 'owner'): se comprueba con su propio JWT llamando a las funciones
// SQL de admin, que vuelven a verificarlo por dentro.
//
// Lo único que hace con service_role es la cuenta de login del creador para el dashboard
// (magic link con shouldCreateUser:false): la busca por email y, si no existe, la crea ya
// confirmada. Así nadie puede auto-registrarse en el dashboard.
//
// POST { action: 'upsert', creator: {...} }
//   → { ok, creator, account: 'created' | 'linked_existing' | 'already_linked' | 'no_email' }
//
// Deploy: supabase functions deploy creators-admin   (con verificación de JWT)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const service = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const log = (...a: unknown[]) => console.log("[creators-admin]", ...a);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { ok: false, error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/.test(auth)) return jsonResponse(req, { ok: false, error: "sin sesión" }, 401);
  const asUser = createClient(SB_URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: auth } },
  });

  const { data: isAdmin, error: adminErr } = await asUser.rpc("creators_is_admin");
  if (adminErr || isAdmin !== true) return jsonResponse(req, { ok: false, error: "solo el administrador" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse(req, { ok: false, error: "bad_json" }, 400); }
  if (body?.action !== "upsert" || !body.creator || typeof body.creator !== "object") {
    return jsonResponse(req, { ok: false, error: "acción no válida" }, 400);
  }

  // 1 · Guardar el creador (la validación vive en SQL: código, %, meses, método de pago…).
  const { data: creator, error: upErr } = await asUser.rpc("admin_upsert_creator", { p: body.creator });
  if (upErr) return jsonResponse(req, { ok: false, error: upErr.message }, 400);

  // 2 · Cuenta de login para el dashboard.
  let account = "no_email";
  const email = String(creator?.email ?? "").trim().toLowerCase();
  if (creator?.auth_user_id) {
    account = "already_linked";
  } else if (email) {
    const { data: found, error: findErr } = await service.rpc("admin_find_auth_user", { p_email: email });
    if (findErr) return jsonResponse(req, { ok: false, error: findErr.message, creator }, 500);
    let uid: string | null = found ?? null;
    if (uid) {
      account = "linked_existing";
    } else {
      const { data: created, error: cErr } = await service.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { portiv_creator: true },
      });
      if (cErr || !created?.user) {
        return jsonResponse(req, { ok: false, error: cErr?.message ?? "no se pudo crear la cuenta", creator }, 500);
      }
      uid = created.user.id;
      account = "created";
    }
    const { error: linkErr } = await asUser.rpc("admin_link_creator_account", { p_creator: creator.id, p_auth_user: uid });
    if (linkErr) return jsonResponse(req, { ok: false, error: linkErr.message, creator }, 500);
    creator.auth_user_id = uid;
  }

  log("upsert", creator?.offer_code, account);
  return jsonResponse(req, { ok: true, creator, account });
});
