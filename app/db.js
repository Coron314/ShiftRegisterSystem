// リーダー用の各画面で共通に使う、Supabaseとのデータの読み書きとログインの処理。
// 以前は全データを localStorage（キー shiftAvailabilityData_v2）の1つのオブジェクトに保存していた。
// 各画面のコードはそのオブジェクト（state）を前提にしているため、ここで同じ形に組み立てて渡し、
// 保存時は次のように分けて書き込む：
//   ・シフト希望（state.cells）… availability テーブル（1人×1日 = 1行）。メンバーがLINEから同時に入力しても
//     上書きし合わないよう、前回読み込んだ内容との差分（変わったマスだけ）を書き込む。
//   ・それ以外（スタッフ・設定・生成済みシフトなど）… app_state テーブルの1行（id = 1）にJSONのまま保存。
(function () {
  const cfg = window.SHIFT_CONFIG;
  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
  const SAVE_DELAY_MS = 400;

  let loadedState = null;
  let cellSnapshot = {};   // cellKey（スタッフID_日付）→ 前回DBと一致していた内容（JSON文字列）
  let latestState = null;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let dirty = false;
  let statusEl = null;
  let statusHideTimer = null;

  // ---------- ログイン ----------

  async function ready() {
    injectStyle();
    const { data } = await client.auth.getSession();
    if (!data.session) await showLogin();
    await load();
  }

  function showLogin() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sdb-overlay";
      overlay.innerHTML = `
        <form class="sdb-popup" autocomplete="on">
          <div class="sdb-title">ログイン</div>
          <label class="sdb-label" for="sdbEmail">メールアドレス</label>
          <input class="sdb-input" type="email" id="sdbEmail" autocomplete="username" required>
          <label class="sdb-label" for="sdbPassword">パスワード</label>
          <input class="sdb-input" type="password" id="sdbPassword" autocomplete="current-password" required>
          <div class="sdb-msg" id="sdbError"></div>
          <button class="sdb-submit" type="submit">ログイン</button>
        </form>
      `;
      document.body.appendChild(overlay);
      const form = overlay.querySelector("form");
      const errorEl = overlay.querySelector("#sdbError");
      const submitBtn = overlay.querySelector(".sdb-submit");
      overlay.querySelector("#sdbEmail").focus();

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.textContent = "";
        submitBtn.disabled = true;
        const { error } = await client.auth.signInWithPassword({
          email: overlay.querySelector("#sdbEmail").value.trim(),
          password: overlay.querySelector("#sdbPassword").value
        });
        submitBtn.disabled = false;
        if (error) {
          errorEl.textContent = /invalid/i.test(error.message)
            ? "メールアドレスかパスワードが違います"
            : "ログインできませんでした（" + error.message + "）";
          return;
        }
        overlay.remove();
        resolve();
      });
    });
  }

  async function signOut() {
    await flush();
    await client.auth.signOut();
    window.location.reload();
  }

  // ---------- 読み込み ----------

  async function load() {
    const [stateRes, cells] = await Promise.all([
      client.from("app_state").select("data").eq("id", 1).maybeSingle(),
      fetchAllCells()
    ]);
    if (stateRes.error) throw stateRes.error;
    cellSnapshot = {};
    for (const key of Object.keys(cells)) cellSnapshot[key] = JSON.stringify(cells[key]);
    if (!stateRes.data) {
      loadedState = null;
      return;
    }
    loadedState = stateRes.data.data || {};
    loadedState.cells = cells;
  }

  async function fetchAllCells() {
    const PAGE = 1000;
    const cells = {};
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from("availability")
        .select("staff_id, date, cell")
        .order("staff_id")
        .order("date")
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const row of data) cells[row.staff_id + "_" + row.date] = row.cell;
      if (data.length < PAGE) break;
    }
    return cells;
  }

  // 読み込んだ state（まだ一度も保存されていなければ null）。各画面の loadState() から呼ぶ。
  function loaded() {
    return loadedState;
  }

  // ---------- 保存 ----------

  function save(state) {
    latestState = state;
    dirty = true;
    setStatus("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(kick, SAVE_DELAY_MS);
  }

  function kick() {
    saveTimer = null;
    saveChain = saveChain.then(runSave);
    return saveChain;
  }

  async function runSave() {
    if (!dirty) return;
    dirty = false;
    try {
      await writeState(latestState);
      if (!dirty) setStatus("saved");
    } catch (e) {
      console.error(e);
      dirty = true;
      setStatus("error");
    }
  }

  // 保存待ち・保存中の内容をすべて書き込み終えるまで待つ。保存できていれば true。
  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      kick();
    }
    await saveChain;
    if (dirty) {
      kick();
      await saveChain;
    }
    return !dirty;
  }

  async function writeState(state) {
    const rest = Object.assign({}, state);
    delete rest.cells;
    const { error: stateError } = await client
      .from("app_state")
      .upsert({ id: 1, data: JSON.parse(JSON.stringify(rest)), updated_at: new Date().toISOString() });
    if (stateError) throw stateError;

    const cells = state.cells || {};
    const cellKeys = Object.keys(cells);

    // 募集を新しく始めた時など、シフト希望が全て空になった場合は、この画面を開いた後に
    // メンバーが入力した分も含めて全て消す（前の募集期間の回答を残さない）。
    if (cellKeys.length === 0) {
      if (Object.keys(cellSnapshot).length > 0) {
        const { error } = await client.from("availability").delete().neq("staff_id", "");
        if (error) throw error;
        cellSnapshot = {};
      }
      return;
    }

    const upserts = [];
    for (const key of cellKeys) {
      const json = JSON.stringify(cells[key]);
      if (cellSnapshot[key] === json) continue;
      const [staffId, date] = splitCellKey(key);
      upserts.push({ staff_id: staffId, date, cell: cells[key], updated_at: new Date().toISOString() });
    }
    const deletesByStaff = {};
    for (const key of Object.keys(cellSnapshot)) {
      if (key in cells) continue;
      const [staffId, date] = splitCellKey(key);
      (deletesByStaff[staffId] = deletesByStaff[staffId] || []).push(date);
    }

    if (upserts.length > 0) {
      const { error } = await client.from("availability").upsert(upserts);
      if (error) throw error;
      for (const row of upserts) cellSnapshot[row.staff_id + "_" + row.date] = JSON.stringify(row.cell);
    }
    for (const staffId of Object.keys(deletesByStaff)) {
      const dates = deletesByStaff[staffId];
      const { error } = await client.from("availability").delete().eq("staff_id", staffId).in("date", dates);
      if (error) throw error;
      for (const date of dates) delete cellSnapshot[staffId + "_" + date];
    }
  }

  function splitCellKey(cellKey) {
    const idx = cellKey.lastIndexOf("_");
    return [cellKey.slice(0, idx), cellKey.slice(idx + 1)];
  }

  // 保存を済ませてからページを移動する（保存中に移動すると書き込みが途中で切れるため）。
  async function go(url) {
    const ok = await flush();
    if (!ok && !confirm("保存できていない変更があります。このまま移動しますか？")) return;
    window.location.href = url;
  }

  window.addEventListener("beforeunload", (e) => {
    if (dirty || saveTimer) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- 保存状態の表示 ----------

  function setStatus(kind) {
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "sdb-status";
      document.body.appendChild(statusEl);
    }
    clearTimeout(statusHideTimer);
    statusEl.className = "sdb-status sdb-" + kind;
    statusEl.textContent = kind === "saving" ? "保存中…"
      : kind === "saved" ? "保存しました"
      : "保存できませんでした。通信状態を確認してください";
    statusEl.style.display = "block";
    if (kind === "saved") {
      statusHideTimer = setTimeout(() => { statusEl.style.display = "none"; }, 1500);
    }
  }

  function injectStyle() {
    if (document.getElementById("sdbStyle")) return;
    const style = document.createElement("style");
    style.id = "sdbStyle";
    style.textContent = `
      .sdb-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
      .sdb-popup { background: #fff; border-radius: 10px; padding: 20px 24px; width: 340px; max-width: 90vw; box-shadow: 0 4px 20px rgba(0,0,0,0.3); display: flex; flex-direction: column; font-family: "Yu Gothic", "Meiryo", sans-serif; }
      .sdb-title { font-size: 20px; font-weight: bold; text-align: center; margin-bottom: 14px; }
      .sdb-label { font-size: 12px; color: #555; margin: 8px 0 2px; }
      .sdb-input { font-size: 16px; padding: 6px; width: 100%; box-sizing: border-box; }
      .sdb-msg { color: #c01c28; font-size: 12px; min-height: 16px; margin-top: 8px; }
      .sdb-submit { margin-top: 10px; padding: 8px 18px; font-size: 14px; border-radius: 6px; border: 1px solid #1a5fb4; background: #1a5fb4; color: #fff; font-weight: bold; cursor: pointer; }
      .sdb-submit:disabled { opacity: 0.6; }
      .sdb-status { position: fixed; right: 12px; bottom: 12px; padding: 6px 12px; border-radius: 6px; font-size: 12px; z-index: 900; display: none; font-family: "Yu Gothic", "Meiryo", sans-serif; }
      .sdb-saving { background: #f0f0f0; color: #555; border: 1px solid #ccc; }
      .sdb-saved { background: #e6f4ea; color: #1e6b34; border: 1px solid #a8d5b5; }
      .sdb-status.sdb-error { background: #fde3e3; color: #c01c28; border: 1px solid #f2a7a7; font-weight: bold; }
      @media print { .sdb-status { display: none !important; } }
    `;
    document.head.appendChild(style);
  }

  // Edge Function を呼び出す。失敗した場合は画面に出せる文章を持った Error を投げる。
  async function callFunction(name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let message = "通信に失敗しました。";
      try {
        const detail = await error.context.json();
        if (detail && detail.error) message = detail.error;
      } catch (e) {
        // 応答がJSONでない（関数が未作成など）
      }
      throw new Error(message);
    }
    return data;
  }

  window.ShiftDB = { client, ready, loaded, save, flush, go, signOut, callFunction };
})();
