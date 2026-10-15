// 各画面で共通に使う、Supabaseとのデータの読み書きと、管理用パスワード（4桁）の確認処理。
// 以前は全データを localStorage（キー shiftAvailabilityData_v2）の1つのオブジェクトに保存していた。
// 各画面のコードはそのオブジェクト（state）を前提にしているため、ここで同じ形に組み立てて渡し、
// 保存時は次のように分けて書き込む：
//   ・シフト希望（state.cells）… availability テーブル（1人×1日 = 1行）。全員が各自のスマホから同じ表に
//     同時に入力しても上書きし合わないよう、前回読み込んだ内容との差分（変わったマスだけ）を書き込む。
//   ・それ以外（スタッフ・設定・生成済みシフトなど）… app_state テーブルの1行（id = 1）にJSONのまま保存。
//     こちらも読み込み時から変わっていなければ書き込まない（シフト希望を入れただけの人の画面が、
//     古いスタッフ一覧や設定でリーダーの変更を上書きしないようにするため）。
// 管理用パスワードは誤操作防止のためのもの。DBの admin_settings（画面からは直接読めない）にあり、
// 関数 check_admin_password で照合する。
(function () {
  const cfg = window.SHIFT_CONFIG;
  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
  const SAVE_DELAY_MS = 400;
  const AUTH_FLAG_KEY = "shiftAdminAuthed";
  const AUTH_PASSWORD_KEY = "shiftAdminPassword";

  let loadedState = null;
  let cellSnapshot = {};   // cellKey（スタッフID_日付）→ 前回DBと一致していた内容（JSON文字列）
  let restSnapshot = null; // app_state の中身（cells 以外）の、前回DBと一致していた内容（JSON文字列）
  let latestState = null;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let dirty = false;
  let statusEl = null;
  let statusHideTimer = null;
  let memoryPassword = null; // sessionStorage が使えない環境用

  async function ready() {
    injectStyle();
    await load();
  }

  // ---------- 管理用パスワード ----------

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (e) {
      // sessionStorage unavailable
    }
  }

  // このタブで最後に正しく入力されたパスワード（LINE送信時にサーバー側でも照合するため保持する）
  function authedPassword() {
    if (sessionGet(AUTH_FLAG_KEY) === "1") return sessionGet(AUTH_PASSWORD_KEY) || memoryPassword;
    return memoryPassword;
  }

  function rememberPassword(password) {
    memoryPassword = password;
    sessionSet(AUTH_FLAG_KEY, "1");
    sessionSet(AUTH_PASSWORD_KEY, password);
  }

  async function verifyPassword(password) {
    const { data, error } = await client.rpc("check_admin_password", { input_password: password });
    if (error) throw error;
    return data === true;
  }

  async function changePassword(currentPassword, newPassword) {
    const { data, error } = await client.rpc("change_admin_password", {
      current_password: currentPassword,
      new_password: newPassword
    });
    if (error) throw error;
    if (data === true) rememberPassword(newPassword);
    return data === true;
  }

  // パスワード入力ポップアップ。各画面にある .overlay / .popup などのスタイルをそのまま使う。
  // 戻り値："ok"（正しいパスワード）／"sample"（デバッグ用コマンド sample が入力された）／null（キャンセル）
  // options.cancelable が false のときはキャンセルボタン・背景クリックで閉じない。
  function askPassword(options) {
    const opts = Object.assign({ cancelable: true }, options);
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.innerHTML = `
        <div class="popup">
          <div class="popup-header">
            <div class="p-date">パスワードを入力</div>
          </div>
          <div class="popup-field">
            <input type="password" class="sdb-password-input" inputmode="numeric" autocomplete="off">
            <div class="error-text"></div>
          </div>
          <div class="popup-footer">
            <button class="cancel-btn">キャンセル</button>
            <button class="confirm-btn">決定</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const input = overlay.querySelector(".sdb-password-input");
      const errorText = overlay.querySelector(".error-text");
      const cancelBtn = overlay.querySelector(".cancel-btn");
      const confirmBtn = overlay.querySelector(".confirm-btn");
      if (!opts.cancelable) cancelBtn.style.visibility = "hidden";
      input.focus();

      function finish(result) {
        overlay.remove();
        resolve(result);
      }

      async function submit() {
        const value = input.value.trim();
        if (value.toLowerCase() === "sample") {
          finish("sample");
          return;
        }
        confirmBtn.disabled = true;
        errorText.textContent = "";
        let ok = false;
        try {
          ok = await verifyPassword(value);
        } catch (e) {
          console.error(e);
          errorText.textContent = "確認できませんでした。通信状態を確認してください";
          confirmBtn.disabled = false;
          return;
        }
        confirmBtn.disabled = false;
        if (!ok) {
          errorText.textContent = "パスワードが違います";
          input.select();
          return;
        }
        rememberPassword(value);
        finish("ok");
      }

      confirmBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
      cancelBtn.addEventListener("click", () => {
        if (opts.cancelable) finish(null);
      });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay && opts.cancelable) finish(null);
      });
    });
  }

  // 管理用の各画面を開いた時に呼ぶ。このタブで既に正しいパスワードを入力済みならそのまま通し、
  // そうでなければ（URLを直接開いた場合など）パスワード入力ポップアップを出す。
  // キャンセルされた場合はシフト希望登録画面に戻る。
  // options.allowSample が true の画面では "sample" を返すことがある（それ以外では sample は無視して入力し直し）。
  async function requireAuth(options) {
    const opts = Object.assign({ allowSample: false }, options);
    injectStyle();
    const stored = authedPassword();
    if (stored) {
      try {
        // 別の端末でパスワードが変更されていた場合は入力し直してもらう
        if (await verifyPassword(stored)) return "ok";
      } catch (e) {
        console.error(e);
      }
    }
    for (;;) {
      const result = await askPassword();
      if (result === "ok") return "ok";
      if (result === "sample" && opts.allowSample) return "sample";
      if (result === null) {
        window.location.href = "shift_availability.html";
        return new Promise(() => {}); // 移動するまで先へ進ませない
      }
    }
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
      restSnapshot = null;
      return;
    }
    loadedState = stateRes.data.data || {};
    restSnapshot = JSON.stringify(loadedState);
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
    const restJson = JSON.stringify(rest);
    if (restJson !== restSnapshot) {
      const { error: stateError } = await client
        .from("app_state")
        .upsert({ id: 1, data: JSON.parse(restJson), updated_at: new Date().toISOString() });
      if (stateError) throw stateError;
      restSnapshot = restJson;
    }

    const cells = state.cells || {};
    const cellKeys = Object.keys(cells);

    // 募集を新しく始めた時など、シフト希望が全て空になった場合は、この画面を開いた後に
    // 他の人が入力した分も含めて全て消す（前の募集期間の回答を残さない）。
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

  // ---------- デバッグ用「sample」コマンド ----------
  // パスワード欄に sample と入力すると、ダミーのスタッフ8名と募集期間分のシフト希望を作って state に入れる。
  // （本番運用前に無効化・削除するかは未定。保存先はDBのため、登録済みのスタッフ・シフト希望は置き換わる）
  const SAMPLE_NAMES = ["田中 太郎", "田中 花子", "佐藤 健", "鈴木 美咲", "高橋 翔", "伊藤 結衣", "渡辺 大輝", "山本 さくら"];
  const SAMPLE_ATTRIBUTES = ["料理長", "厨房専門", "ホール専門", "厨房優先", "ホール優先", "指定なし", "ヘルプ", "研修"];
  const SAMPLE_STARTS = ["15:00~", "16:00~", "17:00~", "18:00~", "19:00~"];
  const SAMPLE_ENDS = ["~21:00", "~22:00", "~23:00"];
  const SAMPLE_WISHES = ["早イン", "早上がり", "ラスト"];
  const SAMPLE_EMPTY_COUNT = 3;       // 未入力のまま残すマスの数（募集期間全体・全スタッフ合計）
  const SAMPLE_CONDITIONAL_COUNT = 5; // 時刻か希望が付いた○にするマスの数（同上）

  function fillSampleData(state) {
    const attrs = shuffle(SAMPLE_ATTRIBUTES.slice());
    state.staff = SAMPLE_NAMES.map((full, i) => {
      const [lastName, firstName] = full.split(" ");
      return { id: Math.random().toString(36).slice(2, 10), lastName, firstName, name: full, attribute: attrs[i] };
    });
    state.cells = {};
    delete state.generatedShift;

    const params = state.shiftParams || {};
    const closedWeekdays = params.defaultClosedWeekdays || [];
    const tempClosed = params.temporaryClosedDates || [];
    const base = new Date(state.startDate + "T00:00:00");
    const days = (state.recruitWeeks || 2) * 7;
    const keys = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (closedWeekdays.includes(d.getDay()) || tempClosed.includes(iso)) continue;
      for (const p of state.staff) keys.push(p.id + "_" + iso);
    }
    shuffle(keys);
    keys.forEach((key, i) => {
      if (i < SAMPLE_EMPTY_COUNT) return;
      if (i < SAMPLE_EMPTY_COUNT + SAMPLE_CONDITIONAL_COUNT) {
        const cell = { mark: "○", start: "", end: "", wish: "" };
        const kind = Math.floor(Math.random() * 3); // 0=時刻のみ 1=希望のみ 2=両方
        if (kind !== 1) {
          if (Math.random() < 0.5) cell.start = pick(SAMPLE_STARTS);
          else cell.end = pick(SAMPLE_ENDS);
        }
        if (kind !== 0) cell.wish = pick(SAMPLE_WISHES);
        state.cells[key] = cell;
        return;
      }
      state.cells[key] = { mark: Math.random() < 0.5 ? "○" : "×", start: "", end: "", wish: "" };
    });
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

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
      .sdb-password-input { width: 100%; font-size: 16px; padding: 6px; box-sizing: border-box; }
      .sdb-status { position: fixed; right: 12px; bottom: 12px; padding: 6px 12px; border-radius: 6px; font-size: 12px; z-index: 900; display: none; font-family: "Yu Gothic", "Meiryo", sans-serif; }
      .sdb-saving { background: #f0f0f0; color: #555; border: 1px solid #ccc; }
      .sdb-saved { background: #e6f4ea; color: #1e6b34; border: 1px solid #a8d5b5; }
      .sdb-status.sdb-error { background: #fde3e3; color: #c01c28; border: 1px solid #f2a7a7; font-weight: bold; }
      @media print { .sdb-status { display: none !important; } }
    `;
    document.head.appendChild(style);
  }

  // Edge Function を呼び出す。管理用パスワードを添えて送り、サーバー側でも照合する。
  // 失敗した場合は画面に出せる文章を持った Error を投げる。
  async function callFunction(name, body) {
    const { data, error } = await client.functions.invoke(name, {
      body: Object.assign({ password: authedPassword() || "" }, body)
    });
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

  window.ShiftDB = {
    client, ready, loaded, save, flush, go, callFunction,
    askPassword, requireAuth, changePassword, fillSampleData
  };
})();
