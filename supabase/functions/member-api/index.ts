// メンバー用シフト希望登録画面（LIFF / member.html）からの読み書きを受け付ける Edge Function。
// LIFFのアクセストークンをLINEに問い合わせて本人確認し、本人が選んだスタッフの行だけを読み書きする。
//
// 必要なシークレット：LINE_LOGIN_CHANNEL_ID（LIFFアプリを登録したLINEログインチャネルのチャネルID）
// 設定：「Verify JWT with legacy secret」はオフにする（メンバーはSupabaseにログインしないため）
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// LIFFのアクセストークンを検証し、LINEのユーザーIDと表示名を返す
async function verifyLineUser(accessToken: string) {
  if (!accessToken) throw new HttpError(401, "auth");
  const verifyRes = await fetch(
    "https://api.line.me/oauth2/v2.1/verify?access_token=" + encodeURIComponent(accessToken),
  );
  if (!verifyRes.ok) throw new HttpError(401, "auth");
  const verified = await verifyRes.json();
  if (String(verified.client_id) !== Deno.env.get("LINE_LOGIN_CHANNEL_ID") || !(verified.expires_in > 0)) {
    throw new HttpError(401, "auth");
  }
  const profileRes = await fetch("https://api.line.me/v2/profile", {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!profileRes.ok) throw new HttpError(401, "auth");
  const profile = await profileRes.json();
  return { userId: profile.userId as string, displayName: (profile.displayName as string) ?? "" };
}

function periodDates(startDate: string, weeks: number) {
  const dates: string[] = [];
  const base = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function isClosed(date: string, params: Record<string, unknown>) {
  const temp = (params.temporaryClosedDates as string[]) ?? [];
  if (temp.includes(date)) return true;
  const weekdays = ((params.defaultClosedWeekdays as number[]) ?? []).map(Number);
  return weekdays.includes(new Date(date + "T00:00:00Z").getUTCDay());
}

function cleanCell(cell: unknown) {
  if (cell === null) return null;
  if (typeof cell !== "object") throw new HttpError(400, "bad cell");
  const c = cell as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 40) : "");
  if (c.mark === "×") return { mark: "×", start: "", end: "", wish: "" };
  if (c.mark === "○") return { mark: "○", start: text(c.start), end: text(c.end), wish: text(c.wish) };
  throw new HttpError(400, "bad cell");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const { userId, displayName } = await verifyLineUser(body.accessToken);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: stateRow, error: stateError } = await db
      .from("app_state").select("data").eq("id", 1).maybeSingle();
    if (stateError) throw stateError;
    const state = (stateRow?.data ?? {}) as Record<string, unknown>;
    const params = (state.shiftParams ?? {}) as Record<string, unknown>;
    const staff = ((state.staff as { id: string; name?: string }[]) ?? [])
      .filter((p) => p.name && p.name.trim() !== "")
      .map((p) => ({ id: p.id, name: p.name! }));
    const startDate = typeof state.startDate === "string" ? state.startDate : null;
    const weeks = Number(state.recruitWeeks) || 2;
    const dates = startDate ? periodDates(startDate, weeks) : [];

    const { data: link, error: linkError } = await db
      .from("line_links").select("staff_id").eq("line_user_id", userId).maybeSingle();
    if (linkError) throw linkError;
    let myStaffId = link && staff.some((s) => s.id === link.staff_id) ? link.staff_id : null;

    if (body.action === "link") {
      if (!staff.some((s) => s.id === body.staffId)) throw new HttpError(400, "unknown staff");
      const { error } = await db.from("line_links").upsert({
        line_user_id: userId,
        staff_id: body.staffId,
        display_name: displayName,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      myStaffId = body.staffId;
    } else if (body.action === "save") {
      if (!myStaffId) throw new HttpError(403, "not linked");
      const date = String(body.date);
      if (!dates.includes(date) || isClosed(date, params)) throw new HttpError(400, "closed");
      const cell = cleanCell(body.cell);
      if (cell) {
        const { error } = await db.from("availability").upsert({
          staff_id: myStaffId, date, cell, updated_at: new Date().toISOString(),
        });
        if (error) throw error;
      } else {
        const { error } = await db.from("availability").delete().eq("staff_id", myStaffId).eq("date", date);
        if (error) throw error;
      }
      return json({ ok: true, cell });
    } else if (body.action !== "init") {
      throw new HttpError(400, "unknown action");
    }

    let cells: Record<string, unknown> = {};
    if (myStaffId && dates.length > 0) {
      const { data, error } = await db
        .from("availability").select("date, cell").eq("staff_id", myStaffId).in("date", dates);
      if (error) throw error;
      cells = Object.fromEntries(data.map((r) => [r.date, r.cell]));
    }

    return json({
      staff,
      myStaffId,
      startDate,
      weeks,
      closedDates: dates.filter((d) => isClosed(d, params)),
      cells,
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
