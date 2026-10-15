// リーダー用画面から公式LINEの友だち全員へ一斉送信する Edge Function。
//   action "recruit" … シフト希望の募集通知（文章）
//   action "shift"   … 完成シフトの画像（＋文章）
//   action "quota"   … 今月の送信可能数・使用数と、送信先の人数（目安）
//
// 必要なシークレット：LINE_CHANNEL_ACCESS_TOKEN（Messaging APIチャネルの長期チャネルアクセストークン）
// 設定：「Verify JWT with legacy secret」はオフにする（ログイン確認はこの中で行う）
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const LINE_API = "https://api.line.me/v2/bot";
const MAX_IMAGES = 4; // 1回の送信は吹き出し5つまで（文章1＋画像4）

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function lineHeaders() {
  return {
    Authorization: "Bearer " + Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN"),
    "Content-Type": "application/json",
  };
}

async function broadcast(messages: unknown[]) {
  const res = await fetch(LINE_API + "/message/broadcast", {
    method: "POST",
    headers: { ...lineHeaders(), "X-Line-Retry-Key": crypto.randomUUID() },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("LINE broadcast failed", res.status, detail);
    if (res.status === 429) return json({ error: "今月の無料送信数の上限に達したため送信できませんでした。" }, 429);
    return json({ error: "LINEへの送信に失敗しました（" + res.status + "）。" }, 502);
  }
  return json({ ok: true });
}

// 送信先の人数の目安：前日時点の「メッセージが届く友だち数」（LINEの集計値。取れなければ null）
async function targetedReaches() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000 - 24 * 3600 * 1000);
  const ymd = jst.toISOString().slice(0, 10).replaceAll("-", "");
  const res = await fetch(LINE_API + "/insight/followers?date=" + ymd, { headers: lineHeaders() });
  if (!res.ok) return null;
  const body = await res.json();
  return body.status === "ready" && typeof body.targetedReaches === "number" ? body.targetedReaches : null;
}

async function quota() {
  const [limitRes, usageRes, reaches] = await Promise.all([
    fetch(LINE_API + "/message/quota", { headers: lineHeaders() }),
    fetch(LINE_API + "/message/quota/consumption", { headers: lineHeaders() }),
    targetedReaches(),
  ]);
  if (!limitRes.ok || !usageRes.ok) return json({ error: "LINEの送信可能数を取得できませんでした。" }, 502);
  const limit = await limitRes.json();
  const usage = await usageRes.json();
  return json({
    limit: limit.type === "limited" ? limit.value : null,
    used: usage.totalUsage ?? 0,
    recipients: reaches,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await admin.auth.getUser(jwt);
    if (!userData?.user) return json({ error: "ログインし直してください。" }, 401);

    const body = await req.json();

    if (body.action === "quota") return await quota();

    if (body.action === "recruit") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 4000) return json({ error: "文章が空か、長すぎます。" }, 400);
      return await broadcast([{ type: "text", text }]);
    }

    if (body.action === "shift") {
      const images = Array.isArray(body.images) ? body.images : [];
      const allowedPrefix = supabaseUrl + "/storage/v1/object/public/shift-images/";
      const valid = images.length >= 1 && images.length <= MAX_IMAGES && images.every((img: { original?: unknown; preview?: unknown }) =>
        typeof img.original === "string" && img.original.startsWith(allowedPrefix) &&
        typeof img.preview === "string" && img.preview.startsWith(allowedPrefix)
      );
      if (!valid) return json({ error: "画像の指定が正しくありません。" }, 400);
      const messages: unknown[] = [];
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text) messages.push({ type: "text", text: text.slice(0, 4000) });
      for (const img of images) {
        messages.push({ type: "image", originalContentUrl: img.original, previewImageUrl: img.preview });
      }
      return await broadcast(messages);
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "サーバーでエラーが発生しました。" }, 500);
  }
});
