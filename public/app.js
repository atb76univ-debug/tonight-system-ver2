const STORAGE_KEY = "tonight_reception_v1";

const DEFAULT_PRICING = Object.freeze({ entryFee: 1000, drinkFee: 500, boxFee: 10000, discount1: 500, discount2: 1000 });
function normalizePricing(pricing) {
  const p = { ...DEFAULT_PRICING, ...(pricing || {}) };
  for (const key of Object.keys(DEFAULT_PRICING)) p[key] = Math.max(0, Math.round(Number(p[key] ?? DEFAULT_PRICING[key]) || 0));
  return p;
}
function getPricing() {
  return ctx?.pricing ? normalizePricing(ctx.pricing) : normalizePricing(ctx?.ev?.pricing);
}
const CASH_DENOMINATIONS = [
  10000,
  5000,
  1000,
  500,
  100,
  50,
  10
];

const screen = document.getElementById("app");
const backBtn = document.getElementById("backBtn");
const eventHomeBtn = document.getElementById("eventHomeBtn");
const pageTitleEl = document.getElementById("pageTitle");

let pageHistory = [];
let barPage = "sales";

let state = createInitialState();
let currentRender = null;
let successReturnTimer = null;

function createInitialState() {
  return {
    initialized: false,

    startCash: 0,

    startCashBreakdown: {},

    drinkTickets: 0,

    totals: {
      general: 0,
      tmp: 0,
      grossEntrance: 0,
      totalDiscount: 0
    },

    receptionHistory: [],
    deletedReceptionHistory: [],

    currentReception: null
  };
}

const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------- 受付履歴のマージ（履歴1件ごとに削除／復元の新しい方を採用） ---------- */
const RECEPTION_PER_PERSON = DEFAULT_PRICING.entryFee + DEFAULT_PRICING.drinkFee;
function receptionTombVersion(t) { return Math.max(Number(t?.deletedAt || 0), Number(t?.restoredAt || 0)); }
function receptionTombRestored(t) { return Number(t?.restoredAt || 0) > Number(t?.deletedAt || 0); }
function applyReceptionEntryEffect(st, entry, sign) {
  const people = Number(entry.general || 0) + Number(entry.tmp || 0);
  st.totals.general += sign * Number(entry.general || 0);
  st.totals.tmp += sign * Number(entry.tmp || 0);
  st.totals.grossEntrance += sign * Number(entry.grossEntrance || people * RECEPTION_PER_PERSON);
  st.totals.totalDiscount += sign * Number(entry.totalDiscount || 0);
  st.drinkTickets = Math.max(0, Number(st.drinkTickets || 0) - sign * people);
}
// newer: u.rec が新しい側（金額・設定など単独値はこちらを採用）／older: 古い側
function mergeReceptionStates(older, newer) {
  const base = structuredClone(newer || older || {});
  base.totals = { general: 0, tmp: 0, grossEntrance: 0, totalDiscount: 0, ...(base.totals || {}) };
  const cutoff = Date.now() - DELETION_RETENTION_MS;
  const tombs = new Map(), live = new Map();
  for (const side of [newer, older]) {
    if (!side) continue;
    for (const t of (side.deletedReceptionHistory || [])) {
      if (t?.entry?.id == null) continue;
      const id = String(t.entry.id), prev = tombs.get(id);
      if (!prev || receptionTombVersion(t) > receptionTombVersion(prev)) tombs.set(id, t);
    }
    for (const e of (side.receptionHistory || [])) {
      if (e?.id == null) continue;
      if (!live.has(String(e.id))) live.set(String(e.id), e);
    }
  }
  const entries = [];
  for (const [id, e] of live) {
    const t = tombs.get(id);
    if (t && !receptionTombRestored(t)) continue;      // 削除が最新 → 履歴に出さない
    entries.push(structuredClone(e));
  }
  for (const [id, t] of tombs) {
    if (receptionTombRestored(t) && !live.has(id)) entries.push(structuredClone(t.entry)); // 復元が最新
  }
  entries.sort((x, y) => Number(y.id || 0) - Number(x.id || 0));
  const outIds = new Set(entries.map(e => String(e.id)));
  const baseList = Array.isArray(base.receptionHistory) ? base.receptionHistory : [];
  const baseIds = new Set(baseList.map(e => String(e.id)));
  for (const e of entries) if (!baseIds.has(String(e.id))) applyReceptionEntryEffect(base, e, +1);
  for (const e of baseList) if (!outIds.has(String(e.id))) applyReceptionEntryEffect(base, e, -1);
  base.receptionHistory = entries;
  base.deletedReceptionHistory = [...tombs.values()]
    .filter(t => Number(t.deletedAt || 0) >= cutoff)
    .sort((x, y) => receptionTombVersion(y) - receptionTombVersion(x))
    .map(t => structuredClone(t));
  return base;
}
function logReceptionDeletion(entry, at) {
  ensureDeletionLogs();
  const id = String(entry.id);
  const floor = state.deletedReceptionHistory.filter(x => String(x.entry?.id) === id)
    .reduce((m, x) => Math.max(m, receptionTombVersion(x)), 0);
  state.deletedReceptionHistory = state.deletedReceptionHistory.filter(x => String(x.entry?.id) !== id);
  state.deletedReceptionHistory.unshift({ entry: structuredClone(entry), deletedAt: Math.max(at || Date.now(), floor + 1), restoredAt: 0 });
}
function refreshCurrentView() {
  try { currentRender(); renderReceptionTabs(); updateBackButton(); }
  catch (error) { showNavigationError(error); }
}

function pruneDeletionLog(items) {
  const cutoff = Date.now() - DELETION_RETENTION_MS;
  return (Array.isArray(items) ? items : []).filter(x => Number(x.deletedAt || 0) >= cutoff);
}
function ensureDeletionLogs() {
  if (!state) return;
  state.deletedReceptionHistory = pruneDeletionLog(state.deletedReceptionHistory || []);
}
function ensureBarDeletionLog(bar) {
  bar.deletedSales = pruneDeletionLog(bar.deletedSales || []);
  return bar;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return createInitialState();
  }

  try {
    const parsed = JSON.parse(raw);

    parsed.totals = {
      general: 0,
      tmp: 0,
      grossEntrance: 0,
      totalDiscount: 0,
      ...(parsed.totals || {})
    };

    parsed.receptionHistory =
      parsed.receptionHistory || [];
    parsed.deletedReceptionHistory =
      pruneDeletionLog(parsed.deletedReceptionHistory || []);

    parsed.startCashBreakdown =
      parsed.startCashBreakdown || {};

    return parsed;
  } catch {
    return createInitialState();
  }
}

function saveState() {
  // 回ごとのデータとして保存（アーカイブ済みの回は「保存確認」付きの作業コピーを編集）
  if (!ctx) return;
  if (ctx.mode === "archive") {
    ctx.dirty = true;
    return;
  }
  ctx.ev.state = state;
  ctx.ev.u.rec = Date.now();
  persistDb();
}

function showNavigationError(error) {
  console.error("画面遷移エラー:", error);
  const box = document.createElement("div");
  box.className = "navigation-error";
  box.textContent = "画面の表示に失敗しました。もう一度操作するか、ページを再読み込みしてください。";
  screen.prepend(box);
}

function navigate(renderFunc) {
  if (typeof renderFunc !== "function") return false;

  const oldHistory = pageHistory.slice();
  const oldRender = currentRender;
  pageHistory.push(renderFunc);
  currentRender = renderFunc;

  try {
    renderFunc();
    renderReceptionTabs();
    updateBackButton();
    window.scrollTo(0, 0);
    return true;
  } catch (error) {
    // 描画失敗時に履歴だけが先へ進まないよう、直前の状態へ戻す
    pageHistory = oldHistory;
    currentRender = oldRender;
    if (oldRender) {
      try {
        oldRender();
        renderReceptionTabs();
        updateBackButton();
      } catch (restoreError) {
        console.error("前画面の復元にも失敗しました:", restoreError);
      }
    }
    showNavigationError(error);
    return false;
  }
}

function back() {
  // 受付完了画面は履歴上の入力途中画面へ戻さない。ヘッダー戻る操作は受付ホームへ戻す。
  if (currentRender === renderSuccessScreen) {
    clearTimeout(successReturnTimer);
    state.currentReception = null;
    pageHistory = [renderHome];
    currentRender = renderHome;
    try {
      renderHome();
      renderReceptionTabs();
      updateBackButton();
      window.scrollTo(0, 0);
      return true;
    } catch (error) {
      showNavigationError(error);
      return false;
    }
  }
  if (pageHistory.length <= 1) return false;

  const oldHistory = pageHistory.slice();
  const oldRender = currentRender;
  const previous = pageHistory[pageHistory.length - 2];

  // 回の一覧に戻るとき、アーカイブの未保存変更を確認する
  if (previous === renderEventList && !leaveEvent()) return false;

  pageHistory.pop();
  currentRender = previous;

  try {
    previous();
    renderReceptionTabs();
    updateBackButton();
    window.scrollTo(0, 0);
    return true;
  } catch (error) {
    // 戻り先の描画に失敗した場合は、履歴を元に戻す
    pageHistory = oldHistory;
    currentRender = oldRender;
    if (oldRender) {
      try {
        oldRender();
        renderReceptionTabs();
        updateBackButton();
      } catch (restoreError) {
        console.error("戻る前の画面の復元にも失敗しました:", restoreError);
      }
    }
    showNavigationError(error);
    return false;
  }
}

function renderReceptionTabs() {
  if (![renderHome, renderReceptionInput, renderHistory, renderResult, renderCashCheck].includes(currentRender)) return;
  const active = currentRender === renderHome ? "home" : currentRender === renderReceptionInput ? "input" : currentRender === renderHistory ? "history" : currentRender === renderResult ? "result" : "cash";
  const nav = document.createElement("nav");
  nav.className = "reception-page-nav";
  nav.innerHTML = `
    <button class="reception-page-tab ${active === "home" ? "active" : ""}" data-rec-page="home">ホーム</button>
    <button class="reception-page-tab ${active === "input" ? "active" : ""}" data-rec-page="input">受付</button>
    <button class="reception-page-tab ${active === "history" ? "active" : ""}" data-rec-page="history">履歴</button>
    <button class="reception-page-tab ${active === "result" ? "active" : ""}" data-rec-page="result">リザルト</button>
    <button class="reception-page-tab ${active === "cash" ? "active" : ""}" data-rec-page="cash">金庫照合</button>`;
  screen.prepend(nav);
  nav.querySelectorAll("[data-rec-page]").forEach(btn => btn.addEventListener("click", () => {
    if (state.currentReception && btn.dataset.recPage !== "input") {
      if (!confirm("入力途中の受付を中止して移動しますか？")) return;
      state.currentReception = null;
    }
    const pages = {home:renderHome,input:renderReceptionInput,history:renderHistory,result:renderResult,cash:renderCashCheck};
    navigate(pages[btn.dataset.recPage]);
  }));
}

function getPageTitle(renderFunc) {
  const titles = new Map([
    [renderEventList, "tonight!"], [renderGuide, "使い方"], [renderEventNew, "新しい回を作成"],
    [renderMemberProfileEdit, "出演者プロフィール編集"],
    [renderEventPage, "イベントホーム"], [renderEventEdit, "イベント情報"], [renderMembers, "メンバー名簿"],
    [renderSetup, "会計準備"], [renderHome, "受付ホーム"],
    [renderReceptionInput, "受付"], [renderDiscountScreen, "割引設定"],
    [renderPaymentScreen, "お支払い"], [renderChecklist, "受付確認"],
    [renderSuccessScreen, "受付完了"], [renderHistory, "受付履歴"],
    [renderResult, "受付リザルト"], [renderCashCheck, "金庫照合"],
    [renderEditStartCash, "初期金庫額"], [renderEditDrinkTickets, "ドリチケ設定"],
    [renderBarHome, "バーカウンター"], [renderTimetable, "タイムテーブル"], [renderShifts, "シフト"]
  ]);
  if (renderFunc === renderBarHome) return ({sales:"ドリンク販売",products:"商品管理",history:"販売履歴・集計",cash:"金庫・精算"})[barPage] || "バーカウンター";
  return titles.get(renderFunc) || "tonight!";
}

function updateBackButton() {
  const canGoBack = pageHistory.length > 1 && currentRender !== renderEventPage;
  backBtn.classList.toggle("hidden", !canGoBack);
  backBtn.disabled = !canGoBack;
  if (pageTitleEl) pageTitleEl.textContent = getPageTitle(currentRender);
  const scheduleSwitchBtn = document.getElementById("scheduleSwitchBtn");
  if (scheduleSwitchBtn) {
    const onSchedule = currentRender === renderTimetable || currentRender === renderShifts;
    scheduleSwitchBtn.classList.toggle("hidden", !onSchedule);
    scheduleSwitchBtn.textContent = currentRender === renderShifts ? "タイムテーブル" : "シフト";
    scheduleSwitchBtn.setAttribute("aria-label", currentRender === renderShifts ? "タイムテーブルへ移動" : "シフトへ移動");
  }
  if (eventHomeBtn) {
    eventHomeBtn.classList.toggle("hidden", !ctx);
    const onEventHome = currentRender === renderEventPage;
    eventHomeBtn.setAttribute("aria-label", onEventHome ? "トップページへ移動" : "イベントホームへ移動");
    const label = eventHomeBtn.querySelector("span");
    if (label) label.textContent = onEventHome ? "トップページ" : "イベントホーム";
  }
  const pulse = document.getElementById("eventPulse");
  if (pulse) pulse.classList.toggle("hidden", !ctx);
  const headerLive = document.getElementById("headerLive");
  if (headerLive) headerLive.classList.toggle("hidden", !ctx || ctx.mode === "archive");
  document.body.classList.toggle("in-event", !!ctx);

  // ヘッダー更新ではNOW/NEXTだけを更新し、重いタイムライン再構築は行わない
  try { updateNow({ refreshTimeline: false }); }
  catch (error) { console.warn("ヘッダーのスケジュール表示を更新できませんでした:", error); }
}

function goEventHome() {
  if (!ctx || currentRender === renderEventPage) return;
  if (state.currentReception && [renderDiscountScreen, renderPaymentScreen, renderChecklist].includes(currentRender)) {
    if (!confirm("入力途中の受付を中止してイベントホームに戻りますか？")) return;
    state.currentReception = null;
  }
  if (currentRender === renderSuccessScreen) {
    clearTimeout(successReturnTimer);
    state.currentReception = null;
  }
  const homeIndex = pageHistory.lastIndexOf(renderEventPage);
  if (homeIndex >= 0) pageHistory = pageHistory.slice(0, homeIndex + 1);
  else pageHistory.push(renderEventPage);
  currentRender = renderEventPage;
  try {
    renderEventPage();
    renderReceptionTabs();
    updateBackButton();
    window.scrollTo(0, 0);
  } catch (error) {
    showNavigationError(error);
  }
}

function goTopPage() {
  if (!ctx || currentRender !== renderEventPage) return;
  if (!leaveEvent()) return;
  pageHistory = [renderEventList];
  currentRender = renderEventList;
  try {
    renderEventList();
    renderReceptionTabs();
    updateBackButton();
    window.scrollTo(0, 0);
  } catch (error) {
    showNavigationError(error);
  }
}

backBtn.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  back();
}, { capture: true });
const scheduleSwitchBtn = document.getElementById("scheduleSwitchBtn");
if (scheduleSwitchBtn) scheduleSwitchBtn.addEventListener("click", () => {
  if (currentRender === renderShifts) navigate(renderTimetable);
  else if (currentRender === renderTimetable) navigate(renderShifts);
});
if (eventHomeBtn) eventHomeBtn.addEventListener("click", event => {
  event.preventDefault();
  if (currentRender === renderEventPage) goTopPage();
  else goEventHome();
});

function tallyString(count) {

  let result = "";

  const groups = Math.floor(count / 5);

  for (let i = 0; i < groups; i++) {
    result += "||||/ ";
  }

  result += "|".repeat(count % 5);

  return result;
}

function getTotalPeople() {

  return (
    state.totals.general +
    state.totals.tmp
  );
}

function getLastReception() {

  if (
    state.receptionHistory.length === 0
  ) {
    return null;
  }

  return state.receptionHistory[0];
}

function formatMoney(value) {

  return value.toLocaleString("ja-JP");
}

function formatSignedMoney(value) {

  const sign =
    value >= 0
      ? "+"
      : "-";

  return `${sign}¥${formatMoney(Math.abs(value))}`;
}

function getReceptionTotal() {

  return state.receptionHistory
    .reduce(
      (sum, reception) =>
        sum + reception.totalAmount,
      0
    );
}

function getDiscountCounts(receptions) {
  const counts = {};
  (receptions || []).forEach(reception => {
    (reception.guests || []).forEach(guest => {
      const amount = Number(guest.discount || 0);
      if (amount > 0) counts[amount] = (counts[amount] || 0) + 1;
    });
  });
  return counts;
}

function renderDiscountCounts(counts) {
  const entries = Object.entries(counts || {})
    .map(([amount, count]) => [Number(amount), Number(count)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!entries.length) return `<div class="sub-text">割引なし</div>`;
  return `<div class="discount-counts">${entries.map(([amount, count]) => `
    <div><span>¥${formatMoney(amount)}OFF</span><strong>${count}人</strong></div>
  `).join("")}</div>`;
}

function renderCashBreakdown(breakdown) {

  const hasBreakdown =
    CASH_DENOMINATIONS
      .some(
        value =>
          Number(breakdown[value] || 0) > 0
      );

  if (!hasBreakdown) {
    return `
      <div class="sub-text">
        金種別枚数は保存されていません
      </div>
    `;
  }

  return `<div class="cash-entry-list">` + CASH_DENOMINATIONS
    .map(
      value => {

        const count =
          Number(
            breakdown[value] || 0
          );

        return `
          <div class="row compact-row">
            <span>
              ${formatMoney(value)}円
            </span>
            <strong>
              ${count}枚
            </strong>
          </div>
        `;
      }
    )
    .join("");
}

function renderSetup() {
  screen.innerHTML = `
    <div class="card">
      
      <div class="card-title">受付開始準備</div>
      <p class="sub-text">受付開始前に、金庫に入っている現金を金種ごとに登録してください。</p>
      <div class="cash-entry-heading"><span>STARTING CASH</span><small>金種ごとの枚数を入力してください</small></div>
      ${renderCashInputs()}
      <div class="money-display">
        <div class="label">開始時の金庫額</div>
        <div class="amount" id="receptionSetupTotal">¥${formatMoney(0)}</div>
      </div>
      <div class="row setup-ticket-row">
        <label>ドリンクチケット枚数</label>
        <input id="ticketCount" type="number" min="0" step="1" inputmode="numeric" value="${state.drinkTickets}">
      </div>
      <button class="btn btn-primary btn-large" id="startEventBtn">金庫額を登録して受付開始</button>
    </div>`;
  const updateTotal = () => {
    const total = [...screen.querySelectorAll("[data-cash]")].reduce((sum,input)=>sum+Number(input.dataset.cash)*Number(input.value||0),0);
    const el = document.getElementById("receptionSetupTotal");
    if (el) el.textContent = `¥${formatMoney(total)}`;
  };
  screen.querySelectorAll("[data-cash]").forEach(input => input.addEventListener("input", updateTotal));
  document.getElementById("startEventBtn").addEventListener("click", startEvent);
  updateTotal();
}

function renderCashInputs(breakdown = {}) {
  return `<div class="cash-entry-list">` + CASH_DENOMINATIONS
    .map(value => {
      const count = Number(breakdown[value] || 0);
      return `
        <div class="cash-entry-row">
          <label class="cash-denomination">
            <span class="cash-denom-value">${value.toLocaleString()}</span>
            <span class="cash-denom-unit">円</span>
          </label>
          <div class="cash-entry-input-wrap">
            <input type="number" min="0" step="1" inputmode="numeric"
              value="${count}" data-cash="${value}"
              aria-label="${value.toLocaleString()}円の枚数">
            <span>枚</span>
          </div>
        </div>`;
    })
    .join("") + `</div>`;
}

function readCashInputState() {

  let total = 0;
  const startCashBreakdown = {};

  document
    .querySelectorAll("[data-cash]")
    .forEach(input => {

      const value =
        Number(
          input.dataset.cash
        );

      const count =
        Number(
          input.value || 0
        );

      total += value * count;
      startCashBreakdown[value] = count;
    });

  return {
    total,
    startCashBreakdown
  };
}

function startEvent() {

  const cashState =
    readCashInputState();

  state.startCash = cashState.total;
  state.startCashBreakdown =
    cashState.startCashBreakdown;

  state.drinkTickets =
    Number(
      document.getElementById(
        "ticketCount"
      ).value
    );

  state.initialized = true;

  saveState();

  navigate(renderHome);
}

function renderEditStartCash() {
  screen.innerHTML = `
    <div class="card">
      
      <div class="card-title">初期金庫額を編集</div>
      <p class="sub-text">金種ごとの枚数を変更してください。</p>
      <div class="cash-entry-heading"><span>STARTING CASH</span><small>金種ごとの枚数を入力してください</small></div>
      ${renderCashInputs(state.startCashBreakdown)}
      <div class="money-display">
        <div class="label">開始時の金庫額</div>
        <div class="amount" id="receptionSetupTotal">¥${formatMoney(Number(state.startCash||0))}</div>
      </div>
      <button class="btn btn-primary btn-large" id="saveStartCashBtn">金庫額を保存</button>
    </div>`;
  const updateTotal = () => {
    const total = [...screen.querySelectorAll("[data-cash]")].reduce((sum,input)=>sum+Number(input.dataset.cash)*Number(input.value||0),0);
    document.getElementById("receptionSetupTotal").textContent = `¥${formatMoney(total)}`;
  };
  screen.querySelectorAll("[data-cash]").forEach(input => input.addEventListener("input", updateTotal));
  document.getElementById("saveStartCashBtn").onclick = () => {
    const cashState = readCashInputState();
    state.startCash = cashState.total;
    state.startCashBreakdown = cashState.startCashBreakdown;
    saveState();
    navigate(renderHome);
  };
  updateTotal();
}

function renderEditDrinkTickets() {

  screen.innerHTML = `

  <div class="card">

    <div class="card-title">
      ドリチケ枚数を編集
    </div>

    <div class="row">
      <label>
        ドリンクチケット残数
      </label>

      <input
        id="editTicketCount"
        type="number"
        min="0"
        value="${state.drinkTickets}"
      >
    </div>

    <button
      class="btn btn-primary btn-large"
      id="saveDrinkTicketsBtn"
    >
      保存
    </button>

  </div>
  `;

  document
    .getElementById(
      "saveDrinkTicketsBtn"
    )
    .onclick = () => {

      state.drinkTickets =
        Number(
          document
            .getElementById(
              "editTicketCount"
            )
            .value ||
            0
        );

      saveState();

      navigate(renderHome);
    };
}

function renderHome() {

  const last =
    getLastReception();

  const totalDiscountCounts =
    getDiscountCounts(
      state.receptionHistory
    );

  screen.innerHTML = `
  
  <div class="card">

    <div class="card-title">
      来場状況
    </div>

    <div class="stats-grid">

      <div class="stat">

        <div class="stat-label">
          一般
        </div>

        <div class="stat-value">
          ${state.totals.general}
        </div>

        <div class="tally">
          ${tallyString(
            state.totals.general
          )}
        </div>

      </div>

      <div class="stat">

        <div class="stat-label">
          TMP
        </div>

        <div class="stat-value">
          ${state.totals.tmp}
        </div>

        <div class="tally">
          ${tallyString(
            state.totals.tmp
          )}
        </div>

      </div>

      <div class="stat">

        <div class="stat-label">
          合計
        </div>

        <div class="stat-value">
          ${getTotalPeople()}
        </div>

      </div>

    </div>

    <div class="discount-count-block">
      <div class="section-label">
        うち割引入場人数
      </div>
      ${renderDiscountCounts(
        totalDiscountCounts
      )}
    </div>

  </div>

  <div class="card">

    <div class="card-title">
      直近受付
    </div>

    ${
      last
        ? `
        <div>
          ${last.timestamp}
        </div>

        <div>
          一般 ${last.general}名
        </div>

        <div>
          TMP ${last.tmp}名
        </div>

        <div class="discount-count-block">
          <div class="section-label">
            うち割引入場人数
          </div>
          ${renderDiscountCounts(
            getDiscountCounts([last])
          )}
        </div>
      `
        : "まだ受付履歴はありません"
    }

  </div>

  <button
    class="btn btn-primary btn-large"
    id="newReceptionBtn"
  >
    新規受付
  </button>

  <br><br>
  <br><br>

  <div class="card drink-ticket-card">

    <div class="card-title">
      ドリチケ残数
    </div>

    <div class="ticket-count">
      ${state.drinkTickets}
      <span>枚</span>
    </div>

    <button
      class="btn btn-secondary"
      id="editDrinkTicketsBtn"
    >
      ドリチケ枚数を編集
    </button>

  </div>

  <div class="card">

    <div class="card-title">
      初期金庫額
    </div>

    <div class="row">

      <span>
        合計
      </span>

      <strong>
        ¥${formatMoney(state.startCash)}
      </strong>

    </div>

    ${renderCashBreakdown(
      state.startCashBreakdown
    )}

    <br>

    <button
      class="btn btn-secondary"
      id="editStartCashBtn"
    >
      初期金庫額を編集
    </button>

  </div>


  <br><br>

  <button
    class="btn btn-danger btn-large"
    id="clearEventBtn"
  >
    受付の会計データを一括削除
  </button>
  `;

  document
    .getElementById(
      "newReceptionBtn"
    )
    .addEventListener(
      "click",
      () => navigate(
        renderReceptionInput
      )
    );

  document
    .getElementById(
      "editStartCashBtn"
    )
    .addEventListener(
      "click",
      () => navigate(
        renderEditStartCash
      )
    );

  document
    .getElementById(
      "editDrinkTicketsBtn"
    )
    .addEventListener(
      "click",
      () => navigate(
        renderEditDrinkTickets
      )
    );

  document
    .getElementById(
      "clearEventBtn"
    )
    .addEventListener(
      "click",
      clearReceptionAccountingData
    );
}

function renderReceptionInput() {

  screen.innerHTML = `

  <div class="card reception-card">

    <div class="card-title">
      新規受付
    </div>

    <div class="reception-counter-list">

      <div class="counter-row">

        <div class="counter-label">
          <span>一般</span>
          <small>通常来場者</small>
        </div>

        <div class="counter">

          <button
            class="counter-btn"
            id="generalMinus"
          >
            −
          </button>

          <div
            class="counter-value"
            id="generalCount"
          >
            0
          </div>

          <button
            class="counter-btn"
            id="generalPlus"
          >
            +
          </button>

        </div>

      </div>

      <div class="counter-row">

        <div class="counter-label">
          <span>TMP</span>
          <small>関係者・招待</small>
        </div>

        <div class="counter">

          <button
            class="counter-btn"
            id="tmpMinus"
          >
            −
          </button>

          <div
            class="counter-value"
            id="tmpCount"
          >
            0
          </div>

          <button
            class="counter-btn"
            id="tmpPlus"
          >
            +
          </button>

        </div>

      </div>

    </div>

    <div class="reception-total">
      <span>合計</span>
      <strong id="receptionTotalCount">0名</strong>
    </div>

    <div id="tmpNamesContainer" style="display:none; margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
      <div class="section-label">
        TMPメンバーは名前を記録
      </div>
      <div id="tmpNamesList" style="display:grid; gap:8px; margin-bottom:8px;">
      </div>
      
    </div>

    <button
      class="btn btn-primary btn-large"
      id="goDiscount"
    >
      次へ
    </button>

  </div>
  `;

  let general = 0;
  let tmp = 0;
  let tmpNames = [];

  const refresh = () => {

    document.getElementById(
      "generalCount"
    ).textContent = general;

    document.getElementById(
      "tmpCount"
    ).textContent = tmp;

    document.getElementById(
      "receptionTotalCount"
    ).textContent =
      `${general + tmp}名`;

    // TMP名入力欄の表示制御
    const container = document.getElementById(
      "tmpNamesContainer"
    );
    if (tmp > 0) {
      container.style.display = "block";
      updateTmpNamesList();
    } else {
      container.style.display = "none";
      tmpNames = [];
    }
  };

  const updateTmpNamesList = () => {
    const listContainer = document.getElementById("tmpNamesList");
    tmpNames = tmpNames.map(item => typeof item === "string"
      ? { name: item, memberId: "", customName: item }
      : { name: item.name || "", memberId: item.memberId || "", customName: item.customName || "" });

    listContainer.innerHTML = tmpNames.map((item, index) => {
      const selectedMember = (db.members || []).find(m => String(m.id) === String(item.memberId));
      const selectedLabel = selectedMember ? memberDisplayName(selectedMember) : "名簿から選択";
      return `<div class="member-pick-row tmp-member-entry" data-index="${index}">
        <div class="tmp-member-select-area">
          <button type="button" class="tmp-member-toggle" data-index="${index}" aria-expanded="false">${esc(selectedLabel)} <span aria-hidden="true">▾</span></button>
          <div class="tmp-member-results" data-index="${index}" role="listbox" aria-label="TMPメンバー候補" hidden></div>
        </div>
        <div class="tmp-member-free-area">
          <label class="tmp-member-free-label" for="tmpFreeName${index}">名簿にない場合（自由入力）</label>
          <input id="tmpFreeName${index}" type="text" class="tmp-member-free-input" data-index="${index}" value="${esc(item.customName)}" placeholder="名前を入力">
        </div>
        <button class="tmp-name-delete" data-index="${index}" type="button" aria-label="このTMP来場者を削除">削</button>
      </div>`;
    }).join("");

    const normalizeMemberSearch = value => String(value || "").normalize("NFKC").toLocaleLowerCase("ja").replace(/[ァ-ン]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)).replace(/[　\s・ー‐‑–—]/g, "");
    // 候補一覧：全員を表示（件数の上限なし）。上部の検索欄で絞り込み（ひらがな／カタカナ・全角半角・空白の揺れに対応）
    const showMemberResults = (index, query = "") => {
      const resultBox = listContainer.querySelector(`.tmp-member-results[data-index="${index}"]`);
      if (!resultBox) return;
      const allMembers = [...(db.members || [])].sort((a, b) => memberDisplayName(a).localeCompare(memberDisplayName(b), "ja"));
      const justOpened = resultBox.hidden || !resultBox.querySelector(".tmp-member-search-input");
      if (!resultBox.querySelector(".tmp-member-search-input")) {
        resultBox.innerHTML = `
          <div class="tmp-member-search-row">
            <input type="search" class="tmp-member-search-input" data-index="${index}" placeholder="名前・DJネームで検索（ひらがなOK）" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="TMPメンバーを検索">
          </div>
          <div class="tmp-member-results-list"></div>`;
        resultBox.querySelector(".tmp-member-search-input").addEventListener("input", e => renderList(e.target.value));
      }
      const searchInput = resultBox.querySelector(".tmp-member-search-input");
      const renderList = value => {
        const q = normalizeMemberSearch(value);
        const matches = allMembers.filter(m => !q || normalizeMemberSearch([m.name, m.nickname, memberDisplayName(m)].filter(Boolean).join(" ")).includes(q));
        const list = resultBox.querySelector(".tmp-member-results-list");
        list.innerHTML = matches.length
          ? `<div class="tmp-member-results-hint">${q ? `${matches.length}名が該当（全${allMembers.length}名）` : `メンバーを選択してください（全${allMembers.length}名）`}</div>${matches.map(m => `<button type="button" role="option" class="tmp-member-result" data-member-id="${esc(m.id)}" data-index="${index}"><strong>${esc(memberDisplayName(m))}</strong>${m.nickname ? `<small>本名：${esc(m.name)}</small>` : ""}${m.grade ? `<small>${esc(m.grade)}</small>` : ""}</button>`).join("")}`
          : `<div class="tmp-member-no-result">該当するメンバーがいません。名簿にない場合は下の自由入力をお使いください。</div>`;
      };
      if (justOpened) searchInput.value = query;
      renderList(searchInput.value);
      resultBox.hidden = false;
      const toggle = listContainer.querySelector(`.tmp-member-toggle[data-index="${index}"]`);
      if (toggle) toggle.setAttribute("aria-expanded", "true");
      if (justOpened) searchInput.focus({ preventScroll: false });
    };

    listContainer.querySelectorAll(".tmp-member-toggle").forEach(button => button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      const box = listContainer.querySelector(`.tmp-member-results[data-index="${index}"]`);
      if (!box) return;
      if (!box.hidden) {
        box.hidden = true;
        button.setAttribute("aria-expanded", "false");
      } else {
        showMemberResults(index);
      }
    }));

    listContainer.querySelectorAll(".tmp-member-free-input").forEach(input => input.addEventListener("input", e => {
      const index = Number(e.target.dataset.index);
      tmpNames[index].customName = e.target.value;
      if (e.target.value.trim()) { tmpNames[index].memberId = ""; tmpNames[index].name = e.target.value.trim(); }
    }));

    if (!listContainer.dataset.memberResultClickBound) {
      listContainer.dataset.memberResultClickBound = "1";
      listContainer.addEventListener("click", e => {
        const btn = e.target.closest(".tmp-member-result");
        if (!btn || !listContainer.contains(btn)) return;
        const index = Number(btn.dataset.index);
        const member = (db.members || []).find(m => String(m.id) === String(btn.dataset.memberId));
        if (!member) return;
        tmpNames[index].name = memberDisplayName(member);
        tmpNames[index].memberId = member.id;
        tmpNames[index].customName = "";
        const freeInput = listContainer.querySelector(`.tmp-member-free-input[data-index="${index}"]`);
        if (freeInput) freeInput.value = "";
        const toggle = listContainer.querySelector(`.tmp-member-toggle[data-index="${index}"]`);
        if (toggle) {
          toggle.innerHTML = `${esc(memberDisplayName(member))} <span aria-hidden="true">▾</span>`;
          toggle.setAttribute("aria-expanded", "false");
        }
        const box = listContainer.querySelector(`.tmp-member-results[data-index="${index}"]`);
        if (box) box.hidden = true;
      });
    }

    // 外側をタップすると候補を閉じる。自由入力欄は常に表示したまま。
    if (!listContainer.dataset.outsideCloseBound) {
      listContainer.dataset.outsideCloseBound = "1";
      if (window.__tmpOutsideClose) document.removeEventListener("click", window.__tmpOutsideClose);
      window.__tmpOutsideClose = e => {
        if (listContainer.contains(e.target)) return;
        listContainer.querySelectorAll(".tmp-member-results:not([hidden])").forEach(box => {
          box.hidden = true;
          const toggle = listContainer.querySelector(`.tmp-member-toggle[data-index="${box.dataset.index}"]`);
          if (toggle) toggle.setAttribute("aria-expanded", "false");
        });
      };
      document.addEventListener("click", window.__tmpOutsideClose);
    }

    listContainer.querySelectorAll(".tmp-name-delete").forEach(btn => btn.addEventListener("click", e => {
      const index = Number(e.currentTarget.dataset.index);
      tmpNames.splice(index, 1);
      tmp--;
      refresh();
    }));
  };

  refresh();

  document
    .getElementById("generalPlus")
    .onclick = () => {
      general++;
      refresh();
    };

  document
    .getElementById("generalMinus")
    .onclick = () => {
      if (general > 0) {
        general--;
        refresh();
      }
    };

  document
    .getElementById("tmpPlus")
    .onclick = () => {
      tmp++;
      tmpNames.push("");
      refresh();
    };

  document
    .getElementById("tmpMinus")
    .onclick = () => {
      if (tmp > 0) {
        tmp--;
        tmpNames.pop();
        refresh();
      }
    };

  document
    .getElementById("goDiscount")
    .onclick = () => {

      const total =
        general + tmp;

      if (total === 0) {

        alert(
          "人数を入力してください"
        );

        return;
      }

      // TMP客の名前入力チェック
      if (tmp > 0) {
        const emptyNames = tmpNames.filter(item => !(typeof item === "string" ? item : ((item.memberId || "") || (item.customName || ""))).trim());
        
        if (emptyNames.length > 0) {
          alert(
            "TMPメンバーの名前を全て入力してください"
          );
          return;
        }
      }

      state.currentReception = {

        general,
        tmp,

        guests: []
      };

      for (
        let i = 0;
        i < general;
        i++
      ) {

        state.currentReception
          .guests.push({

          type: "general",

          discount: 0

        });
      }

      for (
        let i = 0;
        i < tmp;
        i++
      ) {

        state.currentReception
          .guests.push({

          type: "tmp",

          discount: 0,

          name: (typeof tmpNames[i] === "string" ? tmpNames[i] : (tmpNames[i].customName || tmpNames[i].name)) || "",
          memberId: typeof tmpNames[i] === "object" ? (tmpNames[i].memberId || "") : ""

        });
      }

      navigate(
        renderDiscountScreen
      );
    };
}

function renderDiscountScreen() {

  const guests =
    state.currentReception.guests;

  let html = `

  <div class="card">

    <div class="card-title">
      割引設定
    </div>
  `;

  guests.forEach(
    (guest,index) => {

      html += `

      <div class="discount-card">

        <div class="discount-card-header">

          <strong>

            ${
              guest.type === "tmp"
                ? esc(guest.name || "TMP来場者")
                : `来場者 ${index + 1}`
            }

          </strong>

          <span class="guest-type">

            ${
              guest.type ===
              "general"
                ? "一般"
                : "TMP"
            }

          </span>

        </div>

        <div
          class="discount-options"
        >

          <div
            class="discount-option"
          >

            <button
              class="${guest.discount === 0 ? "active" : ""}"
              onclick="
              setDiscount(
              ${index},
              0
              )"
            >

              通常

            </button>

          </div>

          ${[getPricing().discount1, getPricing().discount2].filter((v, i, arr) => v > 0 && arr.indexOf(v) === i).map(amount => `
            <div class="discount-option">
              <button class="${guest.discount === amount ? "active" : ""}" onclick="setDiscount(${index}, ${amount})">-${formatMoney(amount)}</button>
            </div>`).join("")}

        </div>

        <div class="discount-current">

          現在:
          ¥${guest.discount}

        </div>

      </div>
      `;
    }
  );

  html += `

    <button
      class="
      btn
      btn-primary
      btn-large
      "
      id="proceedPayment"
    >

      会計へ

    </button>

  </div>
  `;

  screen.innerHTML = html;

  document
    .getElementById(
      "proceedPayment"
    )
    .onclick = () =>
      navigate(
        renderPaymentScreen
      );
}

function setDiscount(
  index,
  discount
) {

  state
    .currentReception
    .guests[index]
    .discount = discount;

  renderDiscountScreen();
}

function renderPaymentScreen() {
  const guests = state.currentReception.guests;
  const pricing = getPricing();
  const total = guests.reduce((sum, guest) => sum + pricing.entryFee + pricing.drinkFee - guest.discount, 0);
  state.currentReception.totalAmount = total;
  let paid = 0;
  screen.innerHTML = `
    <div class="cashier-overlay">
      <div class="cashier-dialog">
        <div class="cashier-head"><h2>預かり金額</h2><button class="cashier-cancel" id="cashierCancel">中断</button></div>
        <div class="cashier-total-row"><span>合計</span><strong>¥${formatMoney(total)}</strong></div>
        <div class="cashier-paid" id="cashierPaid">¥0</div>
        <div class="cashier-status" id="cashierStatus">受け取ったお札・硬貨のボタンを押して積み上げてください</div>
        <button type="button" class="cashier-exact-button" id="cashierExact">ちょうど受け取り</button>
        <div class="cashier-keypad">
          <button data-add-cash="100">+100</button><button data-add-cash="500">+500</button><button data-add-cash="1000">+1000</button>
          <button data-add-cash="5000">+5000</button><button data-add-cash="10000">+10000</button><button id="cashierClear">C</button>
        </div>
        <p class="cashier-help">受け取ったお札・硬貨のボタンを押して積み上げてください（押し間違いはC）</p>
        <button class="cashier-confirm" id="cashierConfirm" disabled>確認へ</button>
      </div>
    </div>`;
  const paidEl = document.getElementById("cashierPaid");
  const statusEl = document.getElementById("cashierStatus");
  const confirmBtn = document.getElementById("cashierConfirm");
  const refresh = () => {
    paidEl.textContent = `¥${formatMoney(paid)}`;
    const diff = paid - total;
    if (paid === total) { statusEl.textContent = "お釣り ¥0"; statusEl.className = "cashier-status exact"; }
    else if (paid > total) { statusEl.textContent = `お釣り ¥${formatMoney(diff)}`; statusEl.className = "cashier-status change"; }
    else { statusEl.textContent = `あと ¥${formatMoney(total-paid)} 不足しています`; statusEl.className = "cashier-status short"; }
    confirmBtn.disabled = paid < total;
  };
  screen.querySelectorAll("[data-add-cash]").forEach(btn => btn.onclick = () => { paid += Number(btn.dataset.addCash); refresh(); });
  document.getElementById("cashierExact").onclick = () => { paid = total; refresh(); };
  document.getElementById("cashierClear").onclick = () => { paid = 0; refresh(); };
  document.getElementById("cashierCancel").onclick = () => navigate(renderReceptionInput);
  confirmBtn.onclick = () => {
    state.currentReception.paidAmount = paid;
    state.currentReception.change = paid - total;
    navigate(renderChecklist);
  };
  refresh();
}

function renderChecklist() {
  const reception = state.currentReception;
  // 受付データが完了処理などで破棄された後に古い履歴から戻ってきた場合は、ホームへ戻す
  if (!reception) {
    clearTimeout(successReturnTimer);
    pageHistory = [renderHome];
    currentRender = renderHome;
    renderHome();
    renderReceptionTabs();
    updateBackButton();
    return;
  }

  // ドリンク会計の「会計確認」と同じ見た目・手順（ダイアログ＋チェック全部で確定ボタンが有効）
  screen.innerHTML = `
    <div class="cashier-overlay">
      <div class="cashier-dialog">
        <div class="cashier-head"><h2>会計確認</h2><button type="button" class="cashier-cancel" id="receptionChecklistBack">戻る</button></div>
        <div class="cashier-total-row"><span>合計</span><strong>¥${formatMoney(reception.totalAmount)}</strong></div>
        <div class="cashier-total-row"><span>預かり</span><strong>¥${formatMoney(reception.paidAmount)}</strong></div>
        <div class="cashier-status change">お釣り ¥${formatMoney(reception.change)}</div>
        <div class="bar-payment-checklist" aria-label="受付確認">
          <label><input type="checkbox" id="checkTicket"><span>ドリンクチケットを渡した</span></label>
          <label><input type="checkbox" id="checkMoney"><span>お金を受け取った</span></label>
          <label><input type="checkbox" id="checkChange"><span>お釣りを渡した</span></label>
        </div>
        <button type="button" class="cashier-confirm" id="completeReceptionBtn" disabled>会計を確定</button>
      </div>
    </div>`;

  const checks = ["checkTicket", "checkMoney", "checkChange"].map(id => document.getElementById(id));
  const confirmBtn = document.getElementById("completeReceptionBtn");
  const refresh = () => { confirmBtn.disabled = !checks.every(c => c.checked); };
  checks.forEach(c => c.onchange = refresh);
  document.getElementById("receptionChecklistBack").onclick = back;
  confirmBtn.onclick = () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;          // 二重確定防止
    completeReception();
  };
}

function completeReception() {

  const ticket =
    document.getElementById(
      "checkTicket"
    ).checked;

  const money =
    document.getElementById(
      "checkMoney"
    ).checked;

  const change =
    document.getElementById(
      "checkChange"
    ).checked;

  if (
    !ticket ||
    !money ||
    !change
  ) {

    alert(
      "全項目確認してください"
    );

    return;
  }

  const reception =
    state.currentReception;

  const pricing = getPricing();
  const grossEntrance =
    reception.guests.length *
    (pricing.entryFee + pricing.drinkFee);

  const totalDiscount =
    reception.guests.reduce(
      (sum, guest) =>
        sum + guest.discount,
      0
    );

  const timestamp =
    new Date()
      .toLocaleString(
        "ja-JP"
      );

  const historyEntry = {

    id:
      Date.now(),

    timestamp,

    general:
      reception.general,

    tmp:
      reception.tmp,

    guests:
      structuredClone(
        reception.guests
      ),

    totalAmount:
      reception.totalAmount,

    grossEntrance,

    totalDiscount,

    paidAmount:
      reception.paidAmount,

    change:
      reception.change
  };

  state.receptionHistory
    .unshift(
      historyEntry
    );

  state.totals.general +=
    reception.general;

  state.totals.tmp +=
    reception.tmp;

  state.totals.grossEntrance +=
    grossEntrance;

  state.totals.totalDiscount +=
    totalDiscount;

  state.drinkTickets -=

    (
      reception.general +
      reception.tmp
    );

  saveState();

  renderSuccessScreen();
}

function renderSuccessScreen() {
  currentRender = renderSuccessScreen;
  const latest =
    state.receptionHistory[0];

  screen.innerHTML = `

  <div class="success-screen">

    <div class="success-icon">
      ✓
    </div>

    <div class="success-text">
      受付完了
    </div>

    <div class="success-subtext">
      3秒後にホームへ戻ります
    </div>

    <div class="success-summary">

      <div>
        <span>受付時刻</span>
        <strong>${latest.timestamp}</strong>
      </div>

      <div>
        <span>一般</span>
        <strong>${latest.general}名</strong>
      </div>

      <div>
        <span>TMP</span>
        <strong>${latest.tmp}名</strong>
      </div>

      <div>
        <span>支払い金額</span>
        <strong>¥${formatMoney(latest.totalAmount)}</strong>
      </div>

    </div>

  </div>
  `;
  updateBackButton();
  backBtn.classList.add("hidden");

  clearTimeout(successReturnTimer);
  successReturnTimer = setTimeout(
    () => {
      state.currentReception = null;
      // 完了前の割引・会計・確認画面を履歴に残さない。
      pageHistory = [renderHome];
      currentRender = renderHome;
      renderHome();
      renderReceptionTabs();
      updateBackButton();
    },
    3000
  );
}

function renderHistory() {

  let html = `

  <div class="card">

    <div class="card-title">

      受付履歴

    </div>
  `;

  if (
    state.receptionHistory
      .length === 0
  ) {

    html += `
      履歴はありません
    `;
  } else {

    html += `

      <button
        class="
        btn
        btn-danger
        "
        id="clearReceptionHistoryBtn"
      >

        受付履歴を一括削除

      </button>

      <br><br>
    `;
  }

  state.receptionHistory
    .forEach(
      entry => {

        const discountCounts =
          getDiscountCounts([entry]);

        html += `

        <div
          class="
          history-item
          "
        >

          <div
            class="
            history-time
            "
          >

            ${
              entry.timestamp
            }

          </div>

          <div>

            一般
            ${
              entry.general
            }名

          </div>

          <div>

            TMP
            ${
              entry.tmp
            }名

          </div>

          <div>

            ¥${formatMoney(
              entry.totalAmount
            )}

          </div>

          <div class="discount-count-block">
            <div class="section-label">
              うち割引入場人数
            </div>
            ${renderDiscountCounts(
              discountCounts
            )}
          </div>

          ${entry.tmp > 0 ? `
            <div class="discount-count-block">
              <div class="section-label">
                TMPメンバー受付済
              </div>
              <div style="background:#fafafa; padding:12px; border-radius:12px; border:1px solid var(--border);">
                ${(entry.guests || [])
                  .filter(g => g.type === "tmp")
                  .map(g => `
                    <div style="padding:8px 0; border-bottom:1px solid var(--border);">
                      <span style="font-weight:600;">${esc(g.name || "名前未記入")}</span>
                    </div>
                  `)
                  .join("")}
              </div>
            </div>
          ` : ""}

          <br>

          <button
            class="
            btn
            btn-secondary
            "
            onclick="
            deleteHistory(
            ${
              entry.id
            }
            )
            "
          >

            削除

          </button>

        </div>
        `;
      }
    );

  const deletedEntries = pruneDeletionLog(state.deletedReceptionHistory || []);
  if (deletedEntries.length) {
    html += `<div class="deleted-history-section"><div class="card-title">削除した履歴（30日間保存）</div><div class="deleted-history-list">`;
    deletedEntries.forEach(item => {
      const entry = item.entry;
      const deletedAt = new Date(item.deletedAt).toLocaleString("ja-JP");
      const restored = Number(item.restoredAt || 0) > Number(item.deletedAt || 0);
      html += `<div class="deleted-history-row ${restored ? "is-restored" : ""}"><div class="deleted-history-content"><s>${esc(entry.timestamp || "")} ・ 一般 ${Number(entry.general||0)}名 / TMP ${Number(entry.tmp||0)}名 ・ ¥${formatMoney(entry.totalAmount || 0)}</s><small>${restored ? "復元済み" : `削除日時：${deletedAt}`}</small></div>${restored ? `<span class="sub-text">復元済み</span>` : `<button class="btn btn-secondary" data-restore-reception="${esc(entry.id)}">復元</button>`}</div>`;
    });
    html += `</div></div>`;
  }

  html += `
  </div>
  `;

  screen.innerHTML = html;
  screen.querySelectorAll("[data-restore-reception]").forEach(btn => btn.onclick = () => {
    if (!confirm("この受付履歴を復元しますか？来場者数・金額・ドリチケ残数も元に戻ります。")) return;
    restoreHistory(btn.dataset.restoreReception);
  });

  const clearEventBtn =
    document.getElementById(
      "clearEventBtn"
    );

  if (clearEventBtn) {

    clearEventBtn.onclick =
      clearReceptionAccountingData;
  }

  const clearReceptionHistoryBtn =
    document.getElementById(
      "clearReceptionHistoryBtn"
    );

  if (clearReceptionHistoryBtn) {

    clearReceptionHistoryBtn.onclick =
      clearReceptionHistory;
  }
}

function deleteHistory(id) {

  const target =
    state.receptionHistory
      .find(
        x =>
          x.id === id
      );

  if (!target) return;

  if (
    !confirm(
      "削除しますか？"
    )
  ) {
    return;
  }

  state.totals.general -=
    target.general;

  state.totals.tmp -=
    target.tmp;

  state.totals.grossEntrance -=
    target.grossEntrance ||
    (
      (target.general + target.tmp) *
      (DEFAULT_PRICING.entryFee + DEFAULT_PRICING.drinkFee)
    );

  state.totals.totalDiscount -=
    target.totalDiscount ||
    0;

  state.drinkTickets +=

    target.general +
    target.tmp;

  logReceptionDeletion(target, Date.now());
  state.receptionHistory =
    state.receptionHistory.filter(x => x.id !== id);

  saveState();

  refreshCurrentView();
}
function restoreHistory(id) {
  ensureDeletionLogs();
  const record = state.deletedReceptionHistory.find(x => String(x.entry?.id) === String(id) && !receptionTombRestored(x));
  if (!record) return;
  const entry = structuredClone(record.entry);
  // 端末の時計がずれていても「削除より後」の復元として扱われるようにする
  record.restoredAt = Math.max(Date.now(), Number(record.deletedAt || 0) + 1);
  if (state.receptionHistory.some(x => String(x.id) === String(entry.id))) {
    saveState();
    refreshCurrentView();
    return;
  }
  const people = Number(entry.general || 0) + Number(entry.tmp || 0);
  state.drinkTickets = Math.max(0, Number(state.drinkTickets || 0) - people);
  state.totals.general += Number(entry.general || 0);
  state.totals.tmp += Number(entry.tmp || 0);
  state.totals.grossEntrance += Number(entry.grossEntrance || (people * (DEFAULT_PRICING.entryFee + DEFAULT_PRICING.drinkFee)));
  state.totals.totalDiscount += Number(entry.totalDiscount || 0);
  state.receptionHistory.unshift(entry);
  state.receptionHistory.sort((x, y) => Number(y.id || 0) - Number(x.id || 0));
  saveState();
  refreshCurrentView();
}

function clearReceptionHistory() {

  if (
    !confirm(
      "受付履歴をすべて削除しますか？"
    )
  ) {
    return;
  }

  const totalPeople =
    state.totals.general +
    state.totals.tmp;

  state.drinkTickets += totalPeople;
  ensureDeletionLogs();
  const deletedAt = Date.now();
  state.receptionHistory.forEach(entry => logReceptionDeletion(entry, deletedAt));
  state.receptionHistory = [];

  state.totals = {
    general: 0,
    tmp: 0,
    grossEntrance: 0,
    totalDiscount: 0
  };

  saveState();

  refreshCurrentView();
}

function clearReceptionAccountingData() {
  if (!confirm(
    "この回の受付会計データを一括削除しますか？\n受付履歴・来場者数・初期金庫額・ドリチケ残数をリセットします。\nイベント情報、出番／シフト、バーカウンターの会計データは削除されません。"
  )) return;

  const oldEntries = state.receptionHistory.slice();
  const deletedReceptionHistory = pruneDeletionLog(state.deletedReceptionHistory || []);
  state = createInitialState();
  state.deletedReceptionHistory = deletedReceptionHistory;
  const resetAt = Date.now();
  oldEntries.forEach(entry => logReceptionDeletion(entry, resetAt));
  saveState();
  pageHistory = [renderEventList, renderEventPage];
  navigate(renderSetup);
}

function renderResult() {

  const people = state.totals.general + state.totals.tmp;
  const pricing = getPricing();

  // TMP来場者一覧を集計
  const allTmpGuests = state.receptionHistory
    .flatMap(r => 
      (r.guests || [])
        .filter(g => g.type === "tmp")
        .map(g => ({ name: g.name, timestamp: r.timestamp }))
    );

  const grossEntrance =
    state.receptionHistory
      .reduce(
        (sum, r) =>
          sum +
          (
            r.grossEntrance ||
            (
              (r.general + r.tmp) *
              (pricing.entryFee + pricing.drinkFee)
            )
          ),
        0
      );

  const totalDiscount =
    state.receptionHistory
      .reduce(
        (sum, r) =>
          sum +
          (
            r.totalDiscount ||
            0
          ),
        0
      );

  const discountCounts =
    getDiscountCounts(
      state.receptionHistory
    );

  const entranceIncome =

    grossEntrance -

    totalDiscount;

  const drinkTicketAmount =

    people *
    pricing.drinkFee;

  const profitTargetIncome =

    entranceIncome -

    drinkTicketAmount;

  const profit =
    profitTargetIncome -
    pricing.boxFee;

  const theoreticalCash =

    state.startCash +

    getReceptionTotal();

  const cashIncrease =
    theoreticalCash -
    state.startCash;

  screen.innerHTML = `

  <div class="card">

    <div class="card-title">

      イベント結果

    </div>

    <div class="stats-grid">

      <div class="stat">

        <div class="stat-label">
          一般
        </div>

        <div class="stat-value">
          ${state.totals.general}
        </div>

      </div>

      <div class="stat">

        <div class="stat-label">
          TMP
        </div>

        <div class="stat-value">
          ${state.totals.tmp}
        </div>

      </div>

      <div class="stat">

        <div class="stat-label">
          合計
        </div>

        <div class="stat-value">
          ${people}
        </div>

      </div>

    </div>
    <div class="discount-count-block">
      <div class="section-label">
        うち割引入場人数
      </div>
      ${renderDiscountCounts(
        discountCounts
      )}
    </div>

    <div class="discount-count-block row">

      <span class="section-label">
        総割引額
      </span>

      <strong>

        ¥${formatMoney(
          totalDiscount
        )}

      </strong>

    </div>

  </div>

 <div class="card">
  ${allTmpGuests.length > 0 ? `
    <div class="discount-count-block">
      <div class="section-label">
        受付済TMPメンバー（${allTmpGuests.length}名）
      </div>

      <div style="
        background:#fafafa;
        padding:12px;
        border-radius:12px;
        border:1px solid var(--border);
        max-height:300px;
        overflow-y:auto;
      ">
        ${allTmpGuests
          .map((guest, idx) => `
            <div style="
              padding:10px 0;
              border-bottom:1px solid var(--border);
              display:flex;
              justify-content:space-between;
              align-items:center;
            ">
              <span style="font-weight:600;">${esc(guest.name)}</span>
              <span style="font-size:12px; color:var(--sub);">
                ${guest.timestamp}
              </span>
            </div>
          `)
          .join("")}
      </div>
    </div>
  ` : ""}
</div>

  <div class="card" style="text-align: center; padding: 40px 20px; background:#0071e3; color: white; border-radius: 20px;">
    <div style="font-size: 14px; font-weight: 700; opacity: 0.8; margin-bottom: 16px;">
      精算額
    </div>
    <div style="font-size: 64px; font-weight: 900; margin-bottom: 8px; line-height: 1;">
      ¥${formatMoney(drinkTicketAmount + getPricing().boxFee)}
    </div>
    <div style="font-size: 13px; opacity: 0.8; line-height: 1.6;">
      <div>1D(ドリチケ)分：¥${formatMoney(drinkTicketAmount)}</div>
      <div style="margin-top: 8px;">箱代：¥${formatMoney(pricing.boxFee)}</div>
    </div>
  </div>

  <div class="card">
  <div class="stat">

    <div class="row">

      <span>
        入場料+1Dの総額
      </span>

      <strong>

        ¥${formatMoney(
          entranceIncome
        )}

      </strong>

    </div>


    <div class="row">

      <span class="highlight-blue">
        1D(ドリチケ)分
      </span>

      <strong class="highlight-blue">

        ¥${formatMoney(
          drinkTicketAmount
        )}

      </strong>

    </div>

    <div class="row">

      <span>
        利益対象収入
      </span>

      <strong>

        ¥${formatMoney(
          profitTargetIncome
        )}

      </strong>

    </div>

    <div class="row">

      <span class="highlight-blue">
        箱代
      </span>

      <strong class="highlight-blue">

        -¥${formatMoney(pricing.boxFee)}

      </strong>

    </div>

    <div class="row">

      <span class="highlight-red">
        利益
      </span>

      <strong class="highlight-red">

        ¥${formatMoney(
          profit
        )}

      </strong>

    </div>
    </div>

  </div>


  <div class="card">

    <div class="row">

      <span>
        受付終了時・精算前の金庫額
      </span>

      <strong>

        ¥${formatMoney(
          theoreticalCash
        )}
        (${formatSignedMoney(
          cashIncrease
        )})

      </strong>

    </div>

<div class="row">

      <span>
        精算後の金庫額
      </span>

      <strong>

        ¥${formatMoney(
          theoreticalCash - drinkTicketAmount - pricing.boxFee
        )}
        (${formatSignedMoney(
          cashIncrease - drinkTicketAmount - pricing.boxFee
        )})

      </strong>

    </div>

  </div>

  <button
    class="
    btn
    btn-secondary
    btn-large
    "
    id="cashCheckBtn"
  >

    金庫照合

  </button>

  <br><br>

  <button
    class="
    btn
    btn-danger
    btn-large
    "
    id="clearEventBtn"
  >

    受付の会計データを一括削除

  </button>

  `;

  document
    .getElementById(
      "cashCheckBtn"
    )
    .onclick =
      () =>
      navigate(
        renderCashCheck
      );

  document
    .getElementById(
      "clearEventBtn"
    )
    .onclick =
      clearReceptionAccountingData;
}

function renderCashCheck() {
  screen.innerHTML = `
    <div class="card">
      
      <div class="card-title">金庫照合</div>
      <p class="sub-text">金庫に残っている現金を、金種ごとに数えて入力してください。</p>
      <div class="cash-entry-heading">
        <span>COUNT CASH</span>
        <small>金種ごとの枚数を入力してください</small>
      </div>
      <div class="cash-entry-list">
        ${CASH_DENOMINATIONS.map(value => `
          <div class="cash-entry-row">
            <label class="cash-denomination" for="c${value}">
              <span class="cash-denom-value">${value.toLocaleString()}</span>
              <span class="cash-denom-unit">円</span>
            </label>
            <div class="cash-entry-input-wrap">
              <input id="c${value}" type="number" min="0" step="1" inputmode="numeric"
                value="0" data-cash-check="${value}"
                aria-label="${value.toLocaleString()}円の枚数">
              <span>枚</span>
            </div>
          </div>`).join("")}
      </div>
      <div class="money-display">
        <div class="label">実金庫額</div>
        <div class="amount" id="cashCheckTotal">¥0</div>
      </div>
      <button id="calcCashBtn" class="btn btn-primary btn-large">金庫額を照合</button>
    </div>
  `;
  const updateTotal = () => {
    const total = [...screen.querySelectorAll("[data-cash-check]")]
      .reduce((sum, input) => sum + Number(input.dataset.cashCheck) * Number(input.value || 0), 0);
    document.getElementById("cashCheckTotal").textContent = `¥${formatMoney(total)}`;
  };
  screen.querySelectorAll("[data-cash-check]").forEach(input => input.addEventListener("input", updateTotal));
  document.getElementById("calcCashBtn").onclick = calculateCashCheck;
  updateTotal();
}

function calculateCashCheck() {

  const bills = [
    10000,
    5000,
    1000,
    500,
    100,
    50,
    10
  ];

  const actualCash =
    bills.reduce(
      (sum, value) =>
        sum +
        value *
        Number(
          document
            .getElementById(
              `c${value}`
            )
            .value ||
            0
        ),
      0
    );

    const people =
    state.totals.general +
    state.totals.tmp;

  const drinkTicketAmount =
    people * getPricing().drinkFee;

  const theoreticalCash =
    state.startCash +
    state.receptionHistory
      .reduce(
        (sum, r) =>
          sum + r.totalAmount,
        0
      );

  const diff =
    actualCash - theoreticalCash + drinkTicketAmount + getPricing().boxFee;

  alert(
    `実金庫額: ¥${formatMoney(actualCash)}\n` +
    `理論金庫額: ¥${formatMoney(theoreticalCash - drinkTicketAmount - getPricing().boxFee)}\n` +
    `差額: ¥${formatMoney(diff)}`
  );
}

/* ==========================================================
   ここから追加：回ごとの管理 / クラウド同期 / フライヤー / バーカウンター
   （既存の受付まわりの関数は変更していません）
   ========================================================== */

const DB_KEY = "tonight_db_v1";
const BAR_CUP = 500;
const BAR_TOLERANCE = 5;

let db = loadDb();
let ctx = null;          // 開いている回 { ev, mode: "live" | "archive", dirty, bar }
let pushTimer = null;
let barCart = [];
let barCartEventId = null;
let barCheckoutPage = false;
let barOrderComplete = false;
let barOrderCompleteTimer = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function uid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function defaultBarProducts() {
  return [{ id: uid(), name: "ドリンク", price: 500 }];
}
function createBar() {
  return { started: false, startBreakdown: {}, endBreakdown: {}, tally: 0, tickets: 0, ticketCollected: "", receptionTicketRemaining: "", ticketChecks: {}, remain: "", checks: {}, products: defaultBarProducts(), sales: [], resetAt: 0, voidedSales: [], deletedSales: [] };
}
function ensureBar(bar) {
  const b = bar || createBar();
  b.started = Boolean(b.started || Object.values(b.startBreakdown || {}).some(Number));
  b.startBreakdown = b.startBreakdown || {};
  b.endBreakdown = b.endBreakdown || {};
  b.tally = Number(b.tally || 0);
  b.tickets = Number(b.tickets || 0); // 旧データ互換用
  b.ticketCollected = b.ticketCollected ?? "";
  b.receptionTicketRemaining = b.receptionTicketRemaining ?? "";
  b.ticketChecks = b.ticketChecks || {};
  b.remain = b.remain ?? "";
  b.checks = b.checks || {};
  if (!Array.isArray(b.products)) b.products = defaultBarProducts();
  if (!Array.isArray(b.sales)) b.sales = [];
  b.resetAt = Number(b.resetAt || 0);
  if (!Array.isArray(b.voidedSales)) b.voidedSales = [];
  ensureBarDeletionLog(b);
  return b;
}
function newEvent(name, date, st) {
  const t = Date.now();
  return {
    id: uid(), name, date, flyer: 0, archived: false, deleted: false, participants: [],
    state: st || createInitialState(), pricing: { ...DEFAULT_PRICING }, bar: createBar(), tt: createTt(),
    u: { meta: t, rec: t, bar: t, tt: t }
  };
}
function loadDb() {
  try {
    const r = localStorage.getItem(DB_KEY);
    if (r) {
      const d = JSON.parse(r); d.events = d.events || []; d.members = Array.isArray(d.members) ? d.members : [];
      for (const e of d.events) {
        e.state = e.state || createInitialState();
        e.pricing = normalizePricing(e.pricing);
        e.state.deletedReceptionHistory = pruneDeletionLog(e.state.deletedReceptionHistory || []);
        e.bar = ensureBar(e.bar);
      }
      if (!Array.isArray(d.drinkLineup)) {
        const first = d.events.find(e => Array.isArray(e.bar?.products) && e.bar.products.length);
        d.drinkLineup = first ? first.bar.products.map(p => ({ id:p.id || uid(), name:p.name, price:Number(p.price||0) })) : defaultBarProducts();
        d.drinkLineupUpdated = Date.now();
      }
      return d;
    }
  } catch {}
  const d = { events: [], members: [], membersUpdated: 0, drinkLineup: null, drinkLineupUpdated: 0, updated: 0 };
  // これまでの端末内データ（1回分）を最初の回として引き継ぐ
  const old = loadState();
  if (old.initialized || old.receptionHistory.length) {
    d.events.push(newEvent("過去データ（移行）", todayStr(), old));
  }
  d.drinkLineup = defaultBarProducts().map(p => ({ id:p.id, name:p.name, price:p.price }));
  d.drinkLineupUpdated = Date.now();
  return d;
}

/* ---------- 同期（部分ごとに新しい方を採用してマージ） ---------- */
function mergeBarTransactions(a = {}, b = {}) {
  const resetAt = Math.max(Number(a.resetAt || 0), Number(b.resetAt || 0));
  const voided = new Set([...(a.voidedSales || []), ...(b.voidedSales || [])]);
  const deletedMap = new Map();
  [...(a.deletedSales || []), ...(b.deletedSales || [])].forEach(x => {
    if (!x?.sale?.id || Number(x.deletedAt || 0) < Date.now() - DELETION_RETENTION_MS) return;
    const prev = deletedMap.get(x.sale.id);
    if (!prev || Math.max(Number(x.deletedAt||0),Number(x.restoredAt||0)) > Math.max(Number(prev.deletedAt||0),Number(prev.restoredAt||0))) deletedMap.set(x.sale.id, structuredClone(x));
  });
  for (const [id, item] of deletedMap) {
    if (Number(item.restoredAt || 0) > Number(item.deletedAt || 0)) voided.delete(id);
    else voided.add(id);
  }
  const byId = new Map();
  [...(a.sales || []), ...(b.sales || [])].forEach(sale => {
    if (!sale?.id || Number(sale.timestamp || 0) <= resetAt || voided.has(sale.id)) return;
    if (!byId.has(sale.id)) byId.set(sale.id, structuredClone(sale));
  });
  return {
    sales: [...byId.values()].sort((x, y) => Number(y.timestamp || 0) - Number(x.timestamp || 0)),
    resetAt,
    voidedSales: [...voided],
    deletedSales: [...deletedMap.values()].sort((x,y) => Number(y.deletedAt||0)-Number(x.deletedAt||0))
  };
}
function mergeInto(t, s) {
  t.events = t.events || [];
  if ((s.membersUpdated || 0) > (t.membersUpdated || 0)) { t.members = structuredClone(s.members || []); t.membersUpdated = s.membersUpdated; }
  if ((s.drinkLineupUpdated || 0) > (t.drinkLineupUpdated || 0)) {
    t.drinkLineup = structuredClone(s.drinkLineup || []);
    t.drinkLineupUpdated = s.drinkLineupUpdated;
  }
  if (!Array.isArray(t.drinkLineup)) {
    const first = t.events.find(e => Array.isArray(e.bar?.products) && e.bar.products.length);
    t.drinkLineup = first ? first.bar.products.map(p => ({id:p.id || uid(),name:p.name,price:Number(p.price||0)})) : defaultBarProducts().map(p => ({id:p.id,name:p.name,price:p.price}));
  }
  for (const e of (s.events || [])) {
    const o = t.events.find(x => x.id === e.id);
    if (!o) { t.events.push(structuredClone(e)); continue; }
    o.u = o.u || {};
    const eu = e.u || {};
    if ((eu.meta || 0) > (o.u.meta || 0)) {
      for (const k of ["name", "date", "flyer", "archived", "deleted", "participants"]) o[k] = e[k];
      o.u.meta = eu.meta;
    }
    {
      const incomingNewer = (eu.rec || 0) > (o.u.rec || 0);
      if (e.state || o.state) {
        const localCurrent = o.state ? o.state.currentReception : null;
        const merged = incomingNewer ? mergeReceptionStates(o.state, e.state) : mergeReceptionStates(e.state, o.state);
        merged.currentReception = localCurrent || null;   // 入力途中の受付は自端末のもの（同じオブジェクト）を残す
        if (o.state && typeof o.state === "object") {
          if (JSON.stringify(o.state) !== JSON.stringify(merged)) {   // 変化があるときだけ更新
            for (const k of Object.keys(o.state)) delete o.state[k];
            Object.assign(o.state, merged);
          }
        } else o.state = merged;
      }
      if (incomingNewer) o.u.rec = eu.rec;
    }
    const mergedBarTransactions = mergeBarTransactions(o.bar || {}, e.bar || {});
    if ((eu.bar || 0) > (o.u.bar || 0)) { o.bar = structuredClone(e.bar); o.u.bar = eu.bar; }
    o.bar = o.bar || {};
    o.bar.sales = mergedBarTransactions.sales;
    o.bar.resetAt = mergedBarTransactions.resetAt;
    o.bar.voidedSales = mergedBarTransactions.voidedSales;
    o.bar.deletedSales = mergedBarTransactions.deletedSales;
    if ((eu.tt || 0) > (o.u.tt || 0)) { o.tt = structuredClone(e.tt); o.u.tt = eu.tt; }
  }
  return t;
}
function dbSig() {
  return "members=" + (db.membersUpdated || 0) + ":" + (db.members || []).map(m => `${m.id}:${m.name}:${m.grade}:${m.nickname||""}`).join("|") + "||lineup=" + (db.drinkLineup || []).map(p => `${p.id}:${p.name}:${p.price}`).join("|") + ":" + (db.drinkLineupUpdated || 0) + "||" + db.events.map(e => e.id + ":" + ["meta", "rec", "bar", "tt"].map(p => (e.u || {})[p] || 0).join(",") + ":sales=" + (e.bar?.sales || []).map(x => x.id).sort().join(".") + ":deletedSales=" + (e.bar?.deletedSales || []).map(x => `${x.sale?.id}:${x.deletedAt}:${x.restoredAt||0}`).sort().join(".") + ":hist=" + (e.state?.receptionHistory || []).map(x => x.id).sort().join(".") + ":deletedRec=" + (e.state?.deletedReceptionHistory || []).map(x => `${x.entry?.id}:${x.deletedAt}:${x.restoredAt||0}`).sort().join(".") + ":reset=" + Number(e.bar?.resetAt || 0)).join("|");
}
function setSync(t) { const e = document.getElementById("sync"); if (e) e.textContent = t; }
function saveLocalDb() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch {} }
function persistDb() {
  db.updated = Date.now();
  saveLocalDb();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncPush, 1200);
}
async function syncPush() {
  try {
    const r = await fetch("/api/db", { method: "PUT", body: JSON.stringify(db) });
    if (!r.ok) throw 0;
    applyRemote(await r.json());
    setSync("☁ 同期済み");
  } catch { setSync("オフライン（この端末に保存済み）"); }
}
async function syncPull() {
  try {
    const r = await fetch("/api/db", { cache: "no-store" });
    if (!r.ok) throw 0;
    applyRemote(await r.json());
    setSync("☁ 同期済み");
  } catch { setSync("オフライン（この端末に保存済み）"); }
}
function applyRemote(rem) {
  const before = dbSig();
  mergeInto(db, rem);
  if (ctx && ctx.mode === "live") {
    const ev = db.events.find(e => e.id === ctx.ev.id);
    if (ev) {
      ctx.ev = ev;
      if (state !== ev.state) {           // 他端末の受付データの方が新しい場合
        const cur = state.currentReception;
        state = ev.state;
        if (cur) state.currentReception = cur;   // 入力途中の受付は消さない
      }
      ctx.bar = ev.bar;
      ctx.tt = ensureTt(ev.tt || ctx.tt);
    }
  }
  saveLocalDb();
  if (before !== dbSig() && !(ctx && ctx.dirty)) {
    // タイムテーブル編集中に同期が走っても、入力欄やクリック対象を丸ごと破棄しない
    const safe = [renderEventList, renderEventPage, renderHome, renderHistory, renderResult, renderBarHome, renderMembers];
    if (safe.includes(currentRender)) {
      try { currentRender(); renderReceptionTabs(); updateBackButton(); }
      catch (error) { showNavigationError(error); }
    } else if (currentRender === renderTimetable) {
      // 進行中表示だけを追従させる。登録フォーム・一覧は操作を邪魔しない
      updateNow();
    }
  }
}

/* ---------- 保存まわり（既存の saveState から呼ばれる） ---------- */
function saveBar() {
  if (!ctx) return;
  if (ctx.mode === "archive") { ctx.dirty = true; return; }
  ctx.ev.bar = ctx.bar;
  ctx.ev.u.bar = Date.now();
  persistDb();
}
function commitCtx() {
  const ev = ctx.ev, t = Date.now();
  ev.state = structuredClone(state);
  ev.pricing = normalizePricing(ctx.pricing);
  ev.bar = structuredClone(ctx.bar);
  ev.tt = structuredClone(ctx.tt);
  ev.u.rec = t; ev.u.bar = t; ev.u.tt = t; ev.u.meta = t;
  ctx.dirty = false;
  persistDb();
}
function leaveEvent() {
  if (ctx && ctx.mode === "archive" && ctx.dirty) {
    if (confirm("変更を保存しますか？\n［OK］保存して戻る\n［キャンセル］次の確認へ")) {
      commitCtx();
    } else if (!confirm("保存せずに破棄して戻りますか？\n［OK］変更を破棄して戻る\n［キャンセル］編集に戻る")) {
      return false;
    }
  }
  ctx = null;
  return true;
}
window.addEventListener("beforeunload", e => {
  if (ctx && ctx.mode === "archive" && ctx.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- フライヤー ---------- */
function flyerUrl(ev) { return ev.flyer ? `/api/flyer/${ev.id}?v=${ev.flyer}` : ""; }
function resizeImage(file, max = 900) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(), "image/jpeg", 0.8);
    };
    img.onerror = rej;
    img.src = url;
  });
}
async function uploadFlyer(ev, file) {
  try {
    const blob = await resizeImage(file);
    const r = await fetch("/api/flyer/" + ev.id, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!r.ok) throw 0;
    ev.flyer = (ev.flyer || 0) + 1;
    ev.u.meta = Date.now();
    persistDb();
    return true;
  } catch {
    alert("フライヤーのアップロードに失敗しました（通信状況を確認してください）");
    return false;
  }
}

/* ---------- 集計 ---------- */
function sumCash(o) { return CASH_DENOMINATIONS.reduce((s, v) => s + v * Number(o[v] || 0), 0); }
function barCalc(b) {
  const start = sumCash(b.startBreakdown || {}), end = sumCash(b.endBreakdown || {});
  const hasEnd = end > 0;
  return { start, end, hasEnd, revenue: end - start, cups: (end - start) / BAR_CUP };
}
function summarizeBarSales(bar) {
  const summary = { totalUnits: 0, cashUnits: 0, ticketUnits: 0, cashRevenue: 0, ticketRevenue: 0, byProduct: {} };
  (bar?.sales || []).forEach(sale => {
    (sale.items || []).forEach(item => {
      const qty = Math.max(0, Number(item.qty || 0));
      const key = item.productId || item.name || "unknown";
      if (!summary.byProduct[key]) summary.byProduct[key] = { name: item.name || "商品", totalUnits: 0, cashUnits: 0, ticketUnits: 0, cashRevenue: 0 };
      const p = summary.byProduct[key];
      p.totalUnits += qty;
      summary.totalUnits += qty;
      if (sale.paymentMethod === "ticket") {
        p.ticketUnits += qty;
        summary.ticketUnits += qty;
      } else {
        const amount = Number(item.price || 0) * qty;
        p.cashUnits += qty;
        p.cashRevenue += amount;
        summary.cashUnits += qty;
        summary.cashRevenue += amount;
      }
    });
  });
  return summary;
}

function evStats(st, bar, pricing = getPricing()) {
  const h = st.receptionHistory || [];
  const people = st.totals.general + st.totals.tmp;
  const gross = h.reduce((s, r) => s + (r.grossEntrance || ((r.general + r.tmp) * (pricing.entryFee + pricing.drinkFee))), 0);
  const disc = h.reduce((s, r) => s + (r.totalDiscount || 0), 0);
  const actualReceptionRevenue = gross - disc;
  const profit = people ? actualReceptionRevenue - people * pricing.drinkFee - pricing.boxFee : 0;
  return { people, profit, bar: barCalc(bar || createBar()) };
}

/* ---------- 回の一覧（月ごとの概要） ---------- */
function renderEventList() {
  const evs = db.events.filter(e => !e.deleted).sort((a, b) => b.date.localeCompare(a.date));
  const months = {};
  evs.forEach(e => { (months[e.date.slice(0, 7)] = months[e.date.slice(0, 7)] || []).push(e); });

  let html = `<div class="event-list-toolbar">
    <div class="event-list-brand"><img class="event-list-logo" src="TMPlogo.png" alt="Tsukuba Music Project"><div><div class="list-heading">パーティを始めよう。</div></div></div>
    <div class="event-list-actions"><button class="btn btn-secondary guide-open-btn" id="guideBtn">使い方</button><button class="btn btn-primary new-event-compact" id="newEventBtn">＋ 新しい回</button></div>
  </div>`;
  if (!evs.length) html += `<div class="card sub-text">まだ回がありません。「新しい回」から作成してください。</div>`;

  Object.keys(months).sort((a, b) => b.localeCompare(a)).forEach(m => {
    const list = months[m];
    const stats = list.map(e => evStats(e.state, e.bar, normalizePricing(e.pricing)));
    const people = stats.reduce((s, x) => s + x.people, 0);
    const profit = stats.reduce((s, x) => s + x.profit, 0);
    const [y, mo] = m.split("-");
    html += `<section class="event-month">
      <div class="month-head"><div><div class="month-title">${y}年${Number(mo)}月</div>
      <div class="sub-text">${list.length}回 ／ 来場 ${people}名 ／ 受付利益 ¥${formatMoney(profit)}</div></div></div>
      <div class="event-grid">`;
    list.forEach((e, i) => {
      const s = stats[i], url = flyerUrl(e), drinks = summarizeBarSales(e.bar);
      const drinkCount = drinks.totalUnits || Number(e.bar?.tally || 0);
      html += `<button class="event-card compact-event ${url ? "" : "noflyer"}" data-open="${esc(e.id)}" ${url ? `style="background-image:url('${url}')"` : ""}>
        <span class="event-card-status ${e.archived ? "archived" : "live"}">${e.archived ? "ARCHIVE" : "LIVE"}</span>
        <span class="event-card-overlay">
          <span class="event-card-title">${esc(e.name)}</span>
          <span class="event-card-sub">${esc(e.date.slice(5).replace("-", "/"))} ・ 来場${s.people}名 ・ ${drinkCount}杯</span>
        </span></button>`;
    });
    html += `</div></section>`;
  });
  screen.innerHTML = html;
  document.getElementById("newEventBtn").onclick = () => navigate(renderEventNew);
  document.getElementById("guideBtn").onclick = () => navigate(renderGuide);
  screen.querySelectorAll("[data-open]").forEach(el => el.onclick = () => openEvent(el.dataset.open));
}

function guideIllustration(kind) {
  const common = `viewBox="0 0 320 150" role="img" aria-hidden="true"`;
  const svg = {
    event: `<svg ${common}><rect x="18" y="18" width="284" height="114" rx="15" fill="#f3f5f9"/><rect x="34" y="34" width="74" height="82" rx="9" fill="#0071e3"/><path d="M48 57h46M48 69h36M48 81h42" stroke="white" stroke-width="5" stroke-linecap="round"/><rect x="121" y="34" width="164" height="34" rx="8" fill="white" stroke="#dce2ec"/><path d="M136 51h72" stroke="#0071e3" stroke-width="6" stroke-linecap="round"/><rect x="121" y="78" width="164" height="38" rx="8" fill="white" stroke="#dce2ec"/><circle cx="143" cy="97" r="8" fill="#27b77a"/><path d="M160 97h93" stroke="#aeb8c8" stroke-width="5" stroke-linecap="round"/></svg>`,
    reception: `<svg ${common}><rect x="24" y="18" width="272" height="114" rx="15" fill="#f3f5f9"/><rect x="43" y="31" width="104" height="88" rx="10" fill="white" stroke="#dce2ec"/><circle cx="95" cy="56" r="13" fill="#dce8f8"/><path d="M68 91h54M78 104h34" stroke="#0071e3" stroke-width="6" stroke-linecap="round"/><rect x="164" y="31" width="113" height="88" rx="10" fill="white" stroke="#dce2ec"/><path d="M179 50h82M179 69h82M179 88h82" stroke="#c4ccda" stroke-width="7" stroke-linecap="round"/><circle cx="246" cy="104" r="8" fill="#27b77a"/></svg>`,
    bar: `<svg ${common}><rect x="22" y="18" width="276" height="114" rx="15" fill="#f3f5f9"/><rect x="39" y="32" width="115" height="84" rx="10" fill="white" stroke="#dce2ec"/><rect x="52" y="45" width="38" height="28" rx="5" fill="#e5edf8"/><rect x="101" y="45" width="38" height="28" rx="5" fill="#e5edf8"/><path d="M52 88h87" stroke="#c4ccda" stroke-width="7" stroke-linecap="round"/><rect x="171" y="32" width="110" height="84" rx="10" fill="#0071e3"/><path d="M187 51h78M187 68h78" stroke="#b8c7dc" stroke-width="6" stroke-linecap="round"/><rect x="187" y="82" width="78" height="21" rx="6" fill="#27b77a"/></svg>`,
    schedule: `<svg ${common}><rect x="22" y="18" width="276" height="114" rx="15" fill="#f3f5f9"/><rect x="38" y="31" width="244" height="88" rx="10" fill="white" stroke="#dce2ec"/><rect x="50" y="43" width="94" height="28" rx="7" fill="#e8f0ff"/><rect x="155" y="43" width="113" height="28" rx="7" fill="#e8f8ef"/><path d="M60 57h70M165 57h88" stroke="#526f9c" stroke-width="5" stroke-linecap="round"/><path d="M50 87h218" stroke="#dce2ec" stroke-width="5" stroke-linecap="round"/><circle cx="91" cy="101" r="6" fill="#526f9c"/><circle cx="207" cy="101" r="6" fill="#27b77a"/></svg>`
  };
  return svg[kind] || "";
}

function renderGuide() {
  screen.innerHTML = `
    <div class="guide-intro"><h2>tonight! の使い方</h2><p>イベントを作成して、受付・ドリンク販売・メンバー名簿・タイムテーブルをまとめて管理できます。</p></div>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("event")}</div><div class="guide-copy"><span class="guide-number">01</span><h3>イベントを作成</h3><p>「＋ 新しい回」からイベント名と開催日を登録します。フライヤーも設定できます。作成したイベントを選ぶと、その回の管理画面に進みます。</p></div></section>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("reception")}</div><div class="guide-copy"><span class="guide-number">02</span><h3>受付を管理</h3><p>最初に金庫の初期金額などを設定します。受付では来場区分・割引・支払金額を入力し、履歴やリザルト、金庫照合を確認できます。</p></div></section>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("bar")}</div><div class="guide-copy"><span class="guide-number">03</span><h3>ドリンクを販売</h3><p>最初に金庫の準備を行い、商品管理で共通のドリンクラインナップを登録します。登録内容はすべての回で共有され、追加・削除・価格変更も各回に反映されます。販売画面で商品・数量・支払方法を選択して会計します。</p></div></section>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("schedule")}</div><div class="guide-copy"><span class="guide-number">04</span><h3>出番・シフトを登録</h3><p>タイムテーブルではDJ・VJ・LIVE・その他の種別で出番を登録できます。フェスアプリ風の縦型タイムラインは現在位置を自動表示。進行時間の調整はマイナスで巻き、プラスで押しとして出番時刻に反映されます。スタッフのシフトも登録でき、NOW / NEXT は自動更新されます。</p></div></section>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("schedule")}</div><div class="guide-copy"><span class="guide-number">05</span><h3>ヘッダーのNOW / NEXT表示</h3><p>イベント画面上部には、出番とシフトが左右2列で表示され、それぞれNOW（進行中）とNEXT（次の予定）が横並びになります。「縮小」を押すと文字・余白・カードの高さを小さくして縦幅を抑えられます。「しまう」で内容を隠し、「通常」「ひらく」で元に戻せます。表示設定は端末ごとに保持されます。</p></div></section>
    <section class="guide-step"><div class="guide-visual">${guideIllustration("event")}</div><div class="guide-copy"><span class="guide-number">06</span><h3>メンバー名簿・参加予定</h3><p>イベントホームから名簿を開き、本名・学年・任意のニックネーム（DJネーム）を登録できます。ニックネームがあるメンバーは基本的にニックネームで表示し、ない場合は本名を表示します。名簿は画面幅に合わせて読みやすく表示され、CSV／Excelから名前・学年だけを抽出した一括登録、複数端末間の名簿同期、参加予定メンバーの受付状況、参加回数・DJ出演回数・最終出演日を確認できます。出番・シフトの担当者は参加予定者から選び、チップ形式で複数人を追加・解除できます。</p></div></section><div class="card guide-notes"><h3>覚えておくと便利なこと</h3><ul><li>受付・販売履歴・スケジュールはイベントごとに管理されます。メンバー名簿は全イベント共通です。</li><li>タイムテーブルの進行時間調整は出番に反映されます。マイナスが巻き、プラスが押しです。</li><li>ドリンクの商品名・価格のラインナップは全イベント共通です。商品管理で追加・変更・削除すると、すべての回に反映されます。</li><li>売切れ設定はイベントごとに管理されます。ある回で売切れにしても、別の回の販売状態には影響しません。</li><li>受付履歴や販売履歴を削除・取消した場合、削除履歴は横並びのカードで赤い取り消し線付きで記録され、30日以内なら「復元」できます。復元済みの記録もログに残り、同期後も復元状態が維持されます。</li><li>イベントホームへ戻ると、受付・バーカウンター・タイムテーブルに移動できます。</li><li>終了したイベントはアーカイブできます。アーカイブ中の変更は保存確認が表示されます。</li><li>複数端末で使う場合は、同じイベントURLにアクセスしてください。名簿の追加・編集・削除もクラウド同期されます。</li></ul></div>
    <button class="btn btn-primary btn-large guide-back" id="guideBack">イベント一覧に戻る</button>`;
  document.getElementById("guideBack").onclick = () => navigate(renderEventList);
}

function renderEventNew() {
  screen.innerHTML = `<div class="card">
    <div class="card-title">新しい回を作る</div>
    <div class="form-row"><label>イベント名</label><input id="evName" placeholder="例：tonight! vol.12"></div>
    <div class="form-row"><label>開催日</label><input id="evDate" type="date" value="${todayStr()}"></div>
    <div class="form-row"><label>フライヤー（任意）</label><input id="evFlyer" type="file" accept="image/*"></div>
    <button class="btn btn-primary" id="createEvBtn">作成</button></div>`;
  document.getElementById("createEvBtn").onclick = async () => {
    const name = document.getElementById("evName").value.trim();
    const date = document.getElementById("evDate").value;
    if (!name || !date) { alert("イベント名と開催日を入力してください"); return; }
    const ev = newEvent(name, date);
    db.events.push(ev);
    persistDb();
    const f = document.getElementById("evFlyer").files[0];
    if (f) await uploadFlyer(ev, f);
    pageHistory.pop();
    openEvent(ev.id);
    updateBackButton();
  };
}

function openEvent(id) {
  const ev = db.events.find(e => e.id === id);
  if (!ev) return;
  ev.bar = ensureBar(ev.bar);
  ev.tt = ensureTt(ev.tt);
  ev.u.tt = ev.u.tt || 0;
  if (ev.archived) {
    ctx = { ev, mode: "archive", dirty: false, pricing: normalizePricing(ev.pricing), bar: structuredClone(ev.bar), tt: structuredClone(ev.tt) };
    state = structuredClone(ev.state);
  } else {
    ctx = { ev, mode: "live", dirty: false, pricing: normalizePricing(ev.pricing), bar: ev.bar, tt: ev.tt };
    state = ev.state;
  }
  navigate(renderEventPage);
}


function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}
function downloadCurrentEventCsv() {
  if (!ctx?.ev) return;
  const ev = ctx.ev;
  const eventState = state || ev.state || createInitialState();
  const bar = ensureBar(ctx.bar || ev.bar || createBar());
  const tt = ensureTt(ctx.tt || ev.tt || createTt());
  const pricing = getPricing();
  const headers = ["データ種別", "イベント名", "開催日", "日時", "開始日", "開始時刻", "終了日", "終了時刻", "区分", "名前・内容", "数量", "金額", "支払方法", "割引額", "預かり金", "お釣り", "備考"];
  const rows = [];
  const add = values => rows.push(headers.map((_, i) => csvCell(values[i] ?? "")));
  const eventName = ev.name || "", eventDate = ev.date || "";
  const receptionHistory = Array.isArray(eventState.receptionHistory) ? eventState.receptionHistory : [];
  const sales = Array.isArray(bar.sales) ? bar.sales : [];
  const activeSales = sales.filter(sale => Number(sale.timestamp || 0) > Number(bar.resetAt || 0));
  const totalPeople = Number(eventState.totals?.general || 0) + Number(eventState.totals?.tmp || 0);
  const totalDrinkUnits = activeSales.reduce((sum, sale) => sum + (sale.items || []).reduce((n, item) => n + Number(item.qty || 0), 0), 0);
  const drinkSalesSummary = summarizeBarSales(bar);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "来場者", "", totalPeople, "", "", "", "", "", `一般 ${Number(eventState.totals?.general || 0)}名／TMP ${Number(eventState.totals?.tmp || 0)}名`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "料金設定", "", "", "", "", "", "", "", `エントランス ¥${formatMoney(pricing.entryFee)}／1stドリンク ¥${formatMoney(pricing.drinkFee)}／箱代 ¥${formatMoney(pricing.boxFee)}／割引 ¥${formatMoney(pricing.discount1)}・¥${formatMoney(pricing.discount2)}`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "受付売上", "", "", Number(eventState.totals?.grossEntrance || 0), "", Number(eventState.totals?.totalDiscount || 0), "", "", `受付履歴 ${receptionHistory.length}件`]);
  const discountAmount = Number(eventState.totals?.totalDiscount || 0);
  const actualReceptionRevenue = Math.max(0, Number(eventState.totals?.grossEntrance || 0) - discountAmount);
  const discountPeople = receptionHistory.reduce((sum, record) => {
    const guests = Array.isArray(record.guests) ? record.guests : [];
    return sum + guests.filter(guest => Number(guest.discount || 0) > 0).length;
  }, 0);
  const firstDrinkRevenue = totalPeople * pricing.drinkFee;
  const eventProfit = totalPeople ? actualReceptionRevenue - firstDrinkRevenue - pricing.boxFee : 0;
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "割引人数", "", discountPeople, "", "", "", "", "", "割引が適用された来場者数"]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "割引総額", "", "", discountAmount, "", "", "", "", ""]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "受付売上（割引後）", "", "", actualReceptionRevenue, "", "", "", "", `割引前受付売上 ¥${formatMoney(Number(eventState.totals?.grossEntrance || 0))} − 割引総額 ¥${formatMoney(discountAmount)}`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "1stドリンク売上額", "", totalPeople, firstDrinkRevenue, "", "", "", "", `来場者数 ${totalPeople}名 × 1stドリンク料金 ¥${formatMoney(pricing.drinkFee)}`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "利益", "", "", eventProfit, "", "", "", "", `割引後受付売上 − 1stドリンク売上額 − 箱代（¥${formatMoney(pricing.boxFee)}）`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "ドリンク販売", "", totalDrinkUnits, "", "", "", "", "", `販売履歴 ${activeSales.length}件`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "キャッシュドリンク売上", "", drinkSalesSummary.cashUnits, drinkSalesSummary.cashRevenue, "現金", "", "", "", `現金販売 ${drinkSalesSummary.cashUnits}杯`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "進行時間調整", "", "", "", "", "", "", "", `${Number(tt.offsetMinutes || 0)}分`]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "受付金庫初期金額", "", "", Number(eventState.startCash || 0), "", "", "", "", ""]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "ドリチケ残数", "", Number(eventState.drinkTickets || 0), "", "", "", "", "", ""]);
  const barCash = barCalc(bar);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "バー金庫開始額", "", "", barCash.start, "", "", "", "", ""]);
  add(["イベント概要", eventName, eventDate, "", "", "", "", "", "バー金庫終了額", "", "", barCash.hasEnd ? barCash.end : "", "", "", "", "", barCash.hasEnd ? "締め処理済み" : "未締め"]);
  (ev.participants || []).forEach(id => {
    const member = (db.members || []).find(m => String(m.id) === String(id));
    add(["参加予定", eventName, eventDate, "", "", "", "", "", "参加予定メンバー", member ? memberDisplayName(member) : "名簿から削除済み", 1, "", "", "", "", "", `メンバーID: ${id}`]);
  });
  receptionHistory.forEach(entry => {
    const guestNames = (entry.guests || []).map(g => `${g.type === "tmp" ? "TMP" : "一般"}:${g.name || ""}`).filter(Boolean).join(" / ");
    add(["受付履歴", eventName, eventDate, entry.timestamp || "", "", "", "", "", `一般${Number(entry.general || 0)}名・TMP${Number(entry.tmp || 0)}名`, guestNames, Number(entry.general || 0) + Number(entry.tmp || 0), Number(entry.totalAmount || 0), "受付", Number(entry.totalDiscount || 0), Number(entry.paidAmount || 0), Number(entry.change || 0), `受付ID: ${entry.id ?? ""}`]);
  });
  activeSales.forEach(sale => {
    const time = sale.timestamp ? new Date(Number(sale.timestamp)).toLocaleString("ja-JP") : "";
    (sale.items || []).forEach(item => {
      const qty = Number(item.qty || 0);
      add(["ドリンク販売", eventName, eventDate, time, "", "", "", "", sale.paymentMethod === "ticket" ? "ドリチケ" : "現金", item.name || "", qty, Number(item.price || 0) * qty, sale.paymentMethod === "ticket" ? "ドリチケ" : "現金", "", Number(sale.paidAmount || 0), Number(sale.change || 0), `販売ID: ${sale.id ?? ""}／注文合計: ${Number(sale.totalAmount || 0)}円`]);
    });
  });
  (tt.acts || []).slice().sort((a, b) => slotRange(a)[0] - slotRange(b)[0]).forEach(act => {
    add(["タイムテーブル", eventName, eventDate, "", act.startDate || eventDate, act.start || "", act.endDate || eventDate, act.end || "", act.type === "その他" ? (act.customType || "その他") : (act.type || "DJ"), act.name || recordMemberDisplay(act), "", "", "", "", "", "", `出演者ID: ${(act.memberIds || []).join(" / ")}`]);
  });
  (tt.shifts || []).slice().sort((a, b) => slotRange(a)[0] - slotRange(b)[0]).forEach(shift => {
    add(["シフト", eventName, eventDate, "", shift.startDate || eventDate, shift.start || "", shift.endDate || eventDate, shift.end || "", shift.role || "", shift.name || recordMemberDisplay(shift), "", "", "", "", "", "", `担当者ID: ${(shift.memberIds || []).join(" / ")}`]);
  });
  const csv = "\uFEFF" + [headers.map(csvCell), ...rows].map(row => row.join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = `${eventName}_${eventDate}`.replace(/[\\/:*?"<>|]/g, "_");
  link.href = url; link.download = `${safeName || "event-data"}.csv`;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderEventPage() {
  const ev = ctx.ev, arc = ctx.mode === "archive";
  const s = evStats(state, ctx.bar, getPricing()), url = flyerUrl(ev);
  const sales = summarizeBarSales(ctx.bar);
  screen.innerHTML = `
    ${url ? `<img class="flyer-hero" src="${url}" alt="フライヤー">` : `<div class="flyer-empty">フライヤー未登録</div>`}
    ${arc ? `<div class="banner">アーカイブ済み：変更すると「変更を保存しますか？」の確認が出ます${ctx.dirty ? "（未保存の変更あり）" : ""}</div>` : ""}
    <div class="card">
      <div class="card-title">${esc(ev.name)}</div>
      <div class="row"><span>開催日</span><strong>${esc(ev.date)}</strong></div>
      <div class="row"><span>来場者（受付）</span><strong>${s.people}名</strong></div>
      <div class="row"><span>受付利益</span><strong>¥${formatMoney(s.profit)}</strong></div>
      <div class="row"><span>ドリンク販売数</span><strong>${sales.totalUnits || (ctx.bar.tally || 0)}杯</strong></div>
      <div class="row"><span>ドリンク現金売上</span><strong>¥${formatMoney(sales.cashRevenue)}</strong></div>
      <button class="btn btn-secondary full" id="exportEventCsv">この回のデータをCSV出力</button>
    </div>
    
    <div class="event-action-grid">
      <button class="btn btn-primary" id="goRec"><span>受付</span><small>来場・入場会計</small></button>
      <button class="btn btn-primary" id="goBar"><span>バーカウンター</span><small>商品販売・ドリンク精算</small></button>
      <button class="btn btn-secondary" id="goTt"><span>タイムテーブル</span><small>出演スケジュール</small></button>
      <button class="btn btn-secondary" id="goShifts"><span>シフト</span><small>スタッフ配置・勤務時間</small></button>
    </div>

    <div class="card"><div class="card-title">参加予定メンバー</div><div class="sub-text">${(ev.participants||[]).length}名登録</div><div class="participant-home-list">${(ev.participants||[]).map(id=>{const m=(db.members||[]).find(x=>x.id===id);const done=(state.receptionHistory||[]).some(r=>(r.guests||[]).some(g=>g.type==="tmp"&&(g.memberId===id||(!g.memberId&&g.name===m?.name))));return `<span>${esc(m?memberDisplayName(m):"名簿から削除済み")} <b class="${done?"checked":"pending"}">${done?"受付済み":"未受付"}</b></span>`}).join("")||`<span class="sub-text">参加予定はまだ登録されていません。</span>`}</div></div>
    
    ${arc && ctx.dirty ? `<button class="btn btn-secondary" id="saveEv">変更を保存</button><div class="gap"></div>` : ""}
    <button class="btn btn-secondary" id="goMembers">メンバー名簿・参加予定</button><div class="gap"></div><button class="btn btn-secondary" id="editPricing">料金設定（この回）</button><div class="gap"></div><button class="btn btn-secondary" id="editEv">名前・日付・フライヤーを編集</button><div class="gap"></div>
    <button class="btn btn-secondary" id="arcEv">${arc ? "アーカイブを解除（開催中に戻す）" : "この回をアーカイブする"}</button><div class="gap"></div>
    <button class="btn btn-danger" id="delEv">この回を削除</button>`;
  document.getElementById("goRec").onclick = () => navigate(state.initialized ? renderHome : renderSetup);
  document.getElementById("goBar").onclick = () => navigate(ensureBar(ctx.bar).started ? renderBarHome : renderBarSetup);
  document.getElementById("goTt").onclick = () => navigate(renderTimetable);
  document.getElementById("goShifts").onclick = () => navigate(renderShifts);
  document.getElementById("goMembers").onclick = () => navigate(renderMembers);
  document.getElementById("exportEventCsv").onclick = downloadCurrentEventCsv;
  document.getElementById("editEv").onclick = () => navigate(renderEventEdit);
  document.getElementById("editPricing").onclick = () => navigate(renderEventPricing);
  const sv = document.getElementById("saveEv");
  if (sv) sv.onclick = () => { if (confirm("変更を保存しますか？")) { commitCtx(); renderEventPage(); updateBackButton(); } };
  document.getElementById("arcEv").onclick = () => {
    if (ctx.dirty && !confirm("未保存の変更があります。保存して切り替えますか？")) return;
    if (ctx.dirty) commitCtx();
    if (arc) {
      ev.archived = false; ctx.mode = "live"; state = ev.state; ctx.pricing = normalizePricing(ev.pricing); ctx.bar = ev.bar; ctx.tt = ev.tt;
    } else {
      if (!confirm("この回をアーカイブしますか？\n以降の編集時は保存確認が出ます。")) return;
      ev.archived = true; ctx.mode = "archive"; state = structuredClone(ev.state); ctx.pricing = normalizePricing(ev.pricing); ctx.bar = structuredClone(ev.bar); ctx.tt = structuredClone(ev.tt);
    }
    ev.u.meta = Date.now(); persistDb(); renderEventPage(); updateBackButton();
  };
  document.getElementById("delEv").onclick = () => {
    if (!confirm(`「${ev.name}」を削除しますか？\n受付・バーの記録もすべて消えます（元に戻せません）`)) return;
    ev.deleted = true; ev.u.meta = Date.now(); ctx = null; persistDb();
    pageHistory = []; navigate(renderEventList);
  };
}


function renderEventPricing() {
  const p = getPricing();
  screen.innerHTML = `
    <div class="card">
      
      <div class="card-title">このイベントの料金設定</div>
      <p class="sub-text">変更した金額は、このイベントの受付・割引・精算・利益計算・CSV出力に反映されます。他のイベントには影響しません。</p>
      <div class="form-row"><label for="priceEntry">エントランス代（円）</label><input id="priceEntry" type="number" min="0" step="1" value="${p.entryFee}"></div>
      <div class="form-row"><label for="priceDrink">ドリンクチケット代（円）</label><input id="priceDrink" type="number" min="0" step="1" value="${p.drinkFee}"></div>
      <div class="form-row"><label for="priceBox">箱代（円）</label><input id="priceBox" type="number" min="0" step="1" value="${p.boxFee}"></div>
      <div class="form-row"><label for="priceDiscount1">割引額 1（円）</label><input id="priceDiscount1" type="number" min="0" step="1" value="${p.discount1}"></div>
      <div class="form-row"><label for="priceDiscount2">割引額 2（円）</label><input id="priceDiscount2" type="number" min="0" step="1" value="${p.discount2}"></div>
      <p class="sub-text">割引額を0円にすると、その割引ボタンは受付画面に表示されません。</p>
      <div class="gap"></div>
      <button class="btn btn-primary btn-large" id="savePricing">料金設定を保存</button>
      <div class="gap"></div>
      <button class="btn btn-secondary" id="cancelPricing">キャンセル</button>
    </div>`;
  document.getElementById("savePricing").onclick = () => {
    const read = id => Math.max(0, Math.round(Number(document.getElementById(id).value || 0)));
    const next = { entryFee: read("priceEntry"), drinkFee: read("priceDrink"), boxFee: read("priceBox"), discount1: read("priceDiscount1"), discount2: read("priceDiscount2") };
    if (next.discount1 > next.entryFee + next.drinkFee || next.discount2 > next.entryFee + next.drinkFee) {
      if (!confirm("割引額が入場料金の合計を上回っています。このまま保存しますか？")) return;
    }
    ctx.pricing = next;
    if (ctx.mode === "archive") ctx.dirty = true;
    else { ctx.ev.pricing = normalizePricing(next); ctx.ev.u.meta = Date.now(); persistDb(); }
    navigate(renderEventPage);
  };
  document.getElementById("cancelPricing").onclick = () => navigate(renderEventPage);
}

function memberDisplayName(member) { const nickname = String(member?.nickname ?? "").trim(); return nickname || String(member?.name ?? "登録外メンバー"); }

function memberStats(memberId) {
  let attendance=0, dj=0, lastDate="";
  for (const ev of db.events.filter(e=>!e.deleted)) {
    const st=ev.state||createInitialState(), date=ev.date||"";
    const attended=(st.receptionHistory||[]).some(r=>(r.guests||[]).some(g=>g.type==="tmp" && (g.memberId===memberId || (!g.memberId && (db.members||[]).find(m=>m.id===memberId)?.name===g.name))));
    const appearances=(ev.tt?.acts||[]).filter(a=>(a.memberIds||[]).includes(memberId));
    const djCount=appearances.filter(a=>(a.type||"DJ")==="DJ").length;
    if(attended) attendance++;
    dj+=djCount;
    if(appearances.length && date>lastDate) lastDate=date;
  }
  return {attendance,dj,lastDate:lastDate||"—"};
}
let editingMemberId = null;
function renderMemberProfileEdit() {
  const member = (db.members || []).find(x => x.id === editingMemberId);
  if (!member) { alert("メンバーが見つかりませんでした。"); back(); return; }
  const photo = String(member.photo || "");
  screen.innerHTML = `
    <div class="member-profile-editor">
      <div class="member-profile-editor-heading">
        <div class="section-label">MEMBER PROFILE</div>
        <h2>出演者プロフィール</h2>
        <p class="sub-text">来場者用アプリに表示するプロフィールを編集します。</p>
      </div>
      <form id="memberProfileForm" class="card member-profile-form">
        <section class="profile-form-section">
          <h3>基本情報</h3>
          <div class="profile-form-grid">
            <label class="form-row"><span>本名・氏名 <b class="required-mark">必須</b></span><input id="profileName" required maxlength="80" value="${esc(member.name || "")}" placeholder="名前"></label>
            <label class="form-row"><span>学年</span><input id="profileGrade" maxlength="30" value="${esc(member.grade || "")}" placeholder="例：3年"></label>
            <label class="form-row profile-form-wide"><span>ニックネーム／DJネーム</span><input id="profileNickname" maxlength="80" value="${esc(member.nickname || "")}" placeholder="来場者に表示する名前"></label>
          </div>
        </section>
        <section class="profile-form-section">
          <h3>プロフィール写真</h3>
          <label class="form-row"><span>写真URL</span><input id="profilePhoto" type="url" value="${esc(photo)}" placeholder="https://example.com/photo.jpg"></label>
          <div class="profile-photo-preview-wrap"><img id="profilePhotoPreview" class="profile-photo-preview ${photo ? "" : "is-empty"}" src="${esc(photo)}" alt="プロフィール写真プレビュー" ${photo ? "" : "hidden"}><div id="profilePhotoEmpty" class="profile-photo-empty" ${photo ? "hidden" : ""}>写真URLを入力するとプレビューが表示されます</div></div>
          <p class="sub-text">インターネット上からアクセスできる画像URLを指定してください。</p>
        </section>
        <section class="profile-form-section">
          <h3>SNS・音楽</h3>
          <div class="profile-form-grid">
            <label class="form-row profile-form-wide"><span>Instagram</span><input id="profileInstagram" value="${esc(member.instagram || "")}" placeholder="URL または @ユーザー名"></label>
            <label class="form-row profile-form-wide"><span>Favorite（好きな音楽・アーティスト）</span><textarea id="profileFavorite" rows="3" placeholder="例：House、Hip-Hop、KID FRESINO、STUTS">${esc(member.favorite || [member.genre, member.favoriteArtists].filter(Boolean).join("、"))}</textarea></label>
            <label class="form-row profile-form-wide"><span>SpotifyプレイリストURL</span><input id="profileSpotify" type="url" value="${esc(member.spotifyPlaylist || "")}" placeholder="https://open.spotify.com/playlist/..."></label>
          </div>
        </section>
        <section class="profile-form-section">
          <h3>自己紹介</h3>
          <label class="form-row"><span>プロフィール文</span><textarea id="profileBio" rows="5" maxlength="1000" placeholder="音楽や活動について紹介してください">${esc(member.bio || member.profile || "")}</textarea></label>
        </section>
        <div class="profile-form-actions"><button type="button" class="btn btn-secondary" id="cancelMemberProfile">キャンセル</button><button type="submit" class="btn btn-primary">変更を保存</button></div>
      </form>
    </div>`;
  const photoInput = document.getElementById("profilePhoto");
  const preview = document.getElementById("profilePhotoPreview");
  const empty = document.getElementById("profilePhotoEmpty");
  const updatePhotoPreview = () => {
    const url = photoInput.value.trim();
    if (!url) { preview.hidden = true; empty.hidden = false; return; }
    preview.onload = () => { preview.hidden = false; empty.hidden = true; };
    preview.onerror = () => { preview.hidden = true; empty.hidden = false; empty.textContent = "画像を読み込めません。URLを確認してください。"; };
    preview.src = url;
  };
  photoInput.addEventListener("input", updatePhotoPreview);
  if (photo) updatePhotoPreview();
  document.getElementById("cancelMemberProfile").onclick = () => { editingMemberId = null; back(); };
  document.getElementById("memberProfileForm").onsubmit = event => {
    event.preventDefault();
    const name = document.getElementById("profileName").value.trim();
    if (!name) { alert("本名・氏名を入力してください。"); return; }
    const photoUrl = photoInput.value.trim();
    const instagram = document.getElementById("profileInstagram").value.trim();
    const spotify = document.getElementById("profileSpotify").value.trim();
    for (const [label, value] of [["プロフィール写真", photoUrl], ["Spotifyプレイリスト", spotify]]) {
      if (value && !/^https:\/\//i.test(value)) { alert(`${label}は https:// から始まるURLを入力してください。`); return; }
    }
    member.name = name;
    member.grade = document.getElementById("profileGrade").value.trim();
    member.nickname = document.getElementById("profileNickname").value.trim();
    member.photo = photoUrl;
    member.instagram = instagram;
    member.favorite = document.getElementById("profileFavorite").value.trim();
    // 旧データとの互換性を保つため、既存の個別項目も空にせず保持する。
    member.spotifyPlaylist = spotify;
    member.bio = document.getElementById("profileBio").value.trim();
    db.membersUpdated = Date.now();
    persistDb();
    editingMemberId = null;
    alert("プロフィールを保存しました。");
    back();
  };
}

function renderMembers() {
  const gradeNumber = value => {
    const match = String(value || "").match(/\\d+/);
    return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
  };
  const compareGrade = (a,b) => {
    const ga=String(a.grade||"").trim(), gb=String(b.grade||"").trim();
    const na=gradeNumber(ga), nb=gradeNumber(gb);
    if(na!==nb) return na-nb;
    if(!ga && gb) return 1;
    if(ga && !gb) return -1;
    return ga.localeCompare(gb,"ja") || memberDisplayName(a).localeCompare(memberDisplayName(b),"ja");
  };
  const members=(db.members||[]).slice().sort(compareGrade);
  const gradeOptions=[...new Set(members.map(m=>String(m.grade||"").trim()||"学年未登録"))]
    .sort((a,b)=>{
      if(a==="学年未登録")return 1;
      if(b==="学年未登録")return -1;
      const na=gradeNumber(a),nb=gradeNumber(b);
      return na!==nb?na-nb:a.localeCompare(b,"ja");
    });
  const planned=Array.isArray(ctx.ev.participants)?ctx.ev.participants:[];
  const receptionNames=new Set((state.receptionHistory||[]).flatMap(r=>(r.guests||[]).filter(g=>g.type==="tmp").flatMap(g=>[g.memberId||"",`name:${g.name||""}`])));
  screen.innerHTML=`<div class="card"><div class="card-title">参加予定メンバー</div><p class="sub-text">参加予定に登録したメンバーの受付状況を確認できます。チェックボックス・名前・受付状況は横並びで表示されます。</p><div class="member-filter-toolbar"><input type="search" id="participantNameSearch" placeholder="名前の一部で検索" aria-label="参加予定メンバーを名前で検索"><select id="participantGradeFilter" aria-label="参加予定メンバーを学年で絞り込み"><option value="">すべての学年</option>${gradeOptions.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join("")}</select></div><div class="member-check-grid">${members.map(m=>{const grade=String(m.grade||"").trim()||"学年未登録";const searchText=[m.name,m.nickname,memberDisplayName(m)].filter(Boolean).join(" ").toLocaleLowerCase("ja");return `<label class="member-check" data-participant-grade="${esc(grade)}" data-participant-search="${esc(searchText)}"><input type="checkbox" data-participant="${esc(m.id)}" ${planned.includes(m.id)?"checked":""}><span>${esc(memberDisplayName(m))}${m.nickname?` <small>(${esc(m.name)})</small>`:""} <small>${esc(grade)}</small></span><b class="${(receptionNames.has(m.id)||receptionNames.has(`name:${m.name}`))?"checked":"pending"}">${(receptionNames.has(m.id)||receptionNames.has(`name:${m.name}`))?"受付済み":"未受付"}</b></label>`}).join("")||`<div class="sub-text">先に名簿へメンバーを登録してください。</div>`}</div><button class="btn btn-primary full" id="saveParticipants">参加予定を保存</button></div>
  <div class="card"><div class="card-title">メンバー名簿</div><p class="sub-text">出演者プロフィールは各メンバーの「編集」から登録できます。写真URL・Instagram・好きなジャンル／アーティスト・Spotifyプレイリスト・自己紹介が来場者用アプリに表示されます。</p><div class="member-import"><label>CSV／Excelを読み込む<input type="file" id="memberFile" accept=".csv,.xlsx,.xls"></label><small>表に他の項目が含まれていても、「名前（氏名）」「学年」「ニックネーム（DJネーム）」の列を取り込みます。</small></div><div class="inline-form"><input id="memberName" placeholder="本名・氏名"><input id="memberGrade" placeholder="学年（例：3年）"><input id="memberNickname" placeholder="ニックネーム／DJネーム（任意）"><button class="btn btn-primary full" id="addMember">メンバーを追加</button></div><div class="member-bulk-toolbar"><label><input type="checkbox" id="selectAllMembers"> 全員選択</label><button type="button" class="btn btn-danger" id="deleteSelectedMembers" disabled>選択したメンバーを一括削除</button><small id="selectedMemberCount">0名選択中</small></div><div class="member-filter-toolbar"><input type="search" id="memberNameSearch" placeholder="名前の一部で検索" aria-label="名前の一部で検索"><select id="memberGradeFilter" aria-label="学年で絞り込み"><option value="">すべての学年</option>${gradeOptions.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join("")}</select></div><div id="memberList">${members.map(m=>{const st=memberStats(m.id);const grade=String(m.grade||"").trim()||"学年未登録";const searchText=[m.name,m.nickname,memberDisplayName(m)].filter(Boolean).join(" ").toLocaleLowerCase("ja");return `<div class="member-record" data-member-grade="${esc(grade)}" data-member-search="${esc(searchText)}"><input class="member-row-select" type="checkbox" data-select-member="${esc(m.id)}" aria-label="${esc(memberDisplayName(m))}を選択"><div class="member-record-main"><strong>${esc(memberDisplayName(m))}</strong>${m.nickname?`<small>本名：${esc(m.name)}</small>`:""}<small>${esc(grade)} ・ 参加 ${st.attendance}回 ・ DJ ${st.dj}回 ・ 最終出演 ${esc(st.lastDate)}</small></div><button class="btn btn-secondary" data-edit-member="${esc(m.id)}">編集</button><button class="x" data-delete-member="${esc(m.id)}">×</button></div>`}).join("")||`<p class="sub-text">名簿はまだ空です。</p>`}</div></div>`;
  const applyParticipantFilters=()=>{
    const query=(document.getElementById("participantNameSearch").value||"").trim().toLocaleLowerCase("ja");
    const grade=document.getElementById("participantGradeFilter").value;
    screen.querySelectorAll(".member-check-grid .member-check").forEach(row=>{
      const matchesName=!query || (row.dataset.participantSearch||"").includes(query);
      const matchesGrade=!grade || row.dataset.participantGrade===grade;
      row.hidden=!(matchesName&&matchesGrade);
    });
  };
  document.getElementById("participantNameSearch").addEventListener("input",applyParticipantFilters);
  document.getElementById("participantGradeFilter").addEventListener("change",applyParticipantFilters);
  document.getElementById("saveParticipants").onclick=()=>{ctx.ev.participants=[...screen.querySelectorAll('[data-participant]:checked')].map(x=>x.dataset.participant);ctx.ev.u.meta=Date.now();persistDb();alert("参加予定を保存しました");renderMembers();};
  const applyMemberFilters=()=>{
    const query=(document.getElementById("memberNameSearch").value||"").trim().toLocaleLowerCase("ja");
    const grade=document.getElementById("memberGradeFilter").value;
    screen.querySelectorAll("#memberList .member-record").forEach(row=>{
      const matchesName=!query || (row.dataset.memberSearch||"").includes(query);
      const matchesGrade=!grade || row.dataset.memberGrade===grade;
      row.hidden=!(matchesName&&matchesGrade);
    });
  };
  document.getElementById("memberNameSearch").addEventListener("input",applyMemberFilters);
  document.getElementById("memberGradeFilter").addEventListener("change",applyMemberFilters);
  const updateBulkSelection=()=>{const selected=[...screen.querySelectorAll("[data-select-member]:checked")];const all=[...screen.querySelectorAll("[data-select-member]")];const del=document.getElementById("deleteSelectedMembers");const count=document.getElementById("selectedMemberCount");del.disabled=selected.length===0;count.textContent=`${selected.length}名選択中`;const allBox=document.getElementById("selectAllMembers");allBox.checked=all.length>0&&selected.length===all.length;allBox.indeterminate=selected.length>0&&selected.length<all.length;};
  screen.querySelectorAll("[data-select-member]").forEach(box=>box.addEventListener("change",updateBulkSelection));
  document.getElementById("selectAllMembers").onchange=e=>{screen.querySelectorAll("[data-select-member]").forEach(box=>box.checked=e.target.checked);updateBulkSelection();};
  document.getElementById("deleteSelectedMembers").onclick=()=>{const ids=[...screen.querySelectorAll("[data-select-member]:checked")].map(x=>x.dataset.selectMember);if(!ids.length)return;const names=ids.map(id=>db.members.find(m=>m.id===id)?.name).filter(Boolean);if(!confirm(`${ids.length}名のメンバーを名簿から一括削除しますか？\n\n${names.slice(0,8).join("、")}${names.length>8?` ほか${names.length-8}名`:""}\n\n参加予定リストからも除外されます。過去の受付・売上・出演履歴は保持されます。`))return;const removed=new Set(ids);db.members=(db.members||[]).filter(m=>!removed.has(m.id));for(const ev of db.events||[]){if(Array.isArray(ev.participants)){const next=ev.participants.filter(id=>!removed.has(id));if(next.length!==ev.participants.length){ev.participants=next;ev.u=ev.u||{};ev.u.meta=Date.now();}}}db.membersUpdated=Date.now();persistDb();alert(`${ids.length}名を名簿から削除しました。過去の履歴は保持されています。`);renderMembers();};
  document.getElementById("addMember").onclick=()=>{const name=document.getElementById("memberName").value.trim(),grade=document.getElementById("memberGrade").value.trim(),nickname=document.getElementById("memberNickname").value.trim();if(!name){alert("名前を入力してください");return;}const found=(db.members||[]).find(m=>m.name.trim().toLowerCase()===name.toLowerCase());if(found){found.grade=grade;found.nickname=nickname;alert("登録済みメンバーの学年・ニックネームを更新しました。");}else{db.members.push({id:uid(),name,grade,nickname});}db.membersUpdated=Date.now();persistDb();renderMembers();};
  screen.querySelectorAll("[data-edit-member]").forEach(btn=>btn.onclick=()=>{editingMemberId=btn.dataset.editMember;navigate(renderMemberProfileEdit);});
  screen.querySelectorAll("[data-delete-member]").forEach(btn=>btn.onclick=()=>{const m=db.members.find(x=>x.id===btn.dataset.deleteMember);if(!m||!confirm(`${m.name}を名簿から削除しますか？過去の履歴は保持されます。`))return;db.members=db.members.filter(x=>x.id!==m.id);db.membersUpdated=Date.now();persistDb();renderMembers();});
  document.getElementById("memberFile").onchange=async e=>{
    const file=e.target.files[0]; if(!file)return;
    try {
      let table=[];
      if(/\.csv$/i.test(file.name)) {
        table=parseMemberCSVRows(await file.text());
      } else {
        if(!window.XLSX) throw new Error("Excel読み込みライブラリを読み込めません。CSV形式で保存して取り込んでください。");
        const data=new Uint8Array(await file.arrayBuffer());
        const wb=XLSX.read(data,{type:"array",cellDates:false});
        const sheet=wb.Sheets[wb.SheetNames[0]];
        table=XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false});
      }

      const norm=x=>String(x??"").replace(/^\uFEFF/,"").normalize("NFKC").toLowerCase().replace(/[\s　_*・:：()（）「」【】\[\]\-]/g,"");
      const findHeader=(headers, kind)=>{
        const hs=headers.map(norm);
        const exact = kind==="name"
          ? ["名前","氏名","name","メンバー","member","fullname","氏名漢字","名前漢字"]
          : kind==="grade"
            ? ["学年","年次","学籍年次","grade","year","学年(例3年)","学年例3年"]
            : kind==="studentId"
              ? ["学籍番号","学籍id","studentid","studentnumber","id"]
              : ["ニックネーム","djネーム","dj名","nickname","djname","artistname","活動名"];
        let i=hs.findIndex(h=>exact.map(norm).includes(h));
        if(i>=0)return i;
        if(kind==="grade") return hs.findIndex(h=>h.includes("学年") || h.includes("年次") || h==="grade" || h==="year");
        if(kind==="name") return hs.findIndex(h=>h.includes("氏名") || h.includes("名前") || h==="name" || h.includes("fullname"));
        if(kind==="studentId") return hs.findIndex(h=>h.includes("学籍番号") || h==="studentid" || h==="studentnumber");
        if(kind==="nickname") return hs.findIndex(h=>h.includes("ニックネーム") || h.includes("djネーム") || h.includes("dj名") || h.includes("nickname") || h.includes("活動名"));
        return -1;
      };

      let headerIndex=-1, col={name:-1,grade:-1,nickname:-1,studentId:-1};
      for(let r=0;r<Math.min(table.length,30);r++){
        const h=table[r]||[];
        const candidate={
          name:findHeader(h,"name"),
          grade:findHeader(h,"grade"),
          nickname:findHeader(h,"nickname"),
          studentId:findHeader(h,"studentId")
        };
        if(candidate.name>=0 && (candidate.grade>=0 || candidate.nickname>=0)){
          headerIndex=r; col=candidate; break;
        }
      }
      if(headerIndex<0) {
        const preview=(table[0]||[]).map(x=>String(x??"").trim()).filter(Boolean).join(" / ");
        throw new Error(`見出し行を特定できませんでした。検出した1行目：${preview||"空行"}。氏名・年次（または学年）の列見出しを確認してください。`);
      }

      const cleanCell=v=>String(v??"").replace(/^\uFEFF/,"").trim();
      const normalizeGrade=v=>{
        const value=cleanCell(v);
        if(!value) return "";
        return /^\d+$/.test(value) ? `${value}年` : value;
      };
      const matchName=v=>norm(v).replace(/[　\s]/g,"");
      let added=0,updated=0,skipped=0,gradeImported=0,gradeBlank=0;
      const imported=[];
      for(const row of table.slice(headerIndex+1)){
        const name=cleanCell(row[col.name]);
        const rawGrade=col.grade>=0?cleanCell(row[col.grade]):"";
        const grade=normalizeGrade(rawGrade);
        const nickname=col.nickname>=0?cleanCell(row[col.nickname]):"";
        const studentId=col.studentId>=0?cleanCell(row[col.studentId]):"";
        if(!name){skipped++;continue;}
        const found=(db.members||[]).find(m=>
          (studentId && m.studentId && norm(m.studentId)===norm(studentId)) ||
          matchName(m.name)===matchName(name)
        );
        if(found){
          let changed=false;
          if(grade && found.grade!==grade){found.grade=grade;changed=true;}
          if(studentId && found.studentId!==studentId){found.studentId=studentId;changed=true;}
          if(col.nickname>=0 && found.nickname!==(nickname||"")){found.nickname=nickname||"";changed=true;}
          if(changed)updated++;
        } else {
          db.members.push({id:uid(),name,grade,nickname,studentId});
          added++;
        }
        if(grade) gradeImported++; else gradeBlank++;
        imported.push({name,grade,studentId});
      }
      db.membersUpdated=Date.now();
      persistDb();
      const gradeColumn=col.grade>=0 ? (table[headerIndex][col.grade]||"（列名不明）") : "未検出";
      alert(
        `取り込み完了\n`+
        `氏名列：${table[headerIndex][col.name]}\n`+
        `学年列：${gradeColumn}\n`+
        `学年取得：${gradeImported}名／空欄：${gradeBlank}名\n`+
        `新規：${added}名／更新：${updated}名`+
        `${skipped?`／名前なし等 ${skipped}行をスキップ`:""}`
      );
      console.info("[名簿インポート診断]",{
        file:file.name,headerIndex,headers:table[headerIndex],columns:col,
        total:imported.length,gradeImported,gradeBlank,added,updated,skipped,
        sample:imported.slice(0,5)
      });
      renderMembers();
    } catch(err) {
      console.error("[名簿インポート失敗]",err);
      alert(`読み込みに失敗しました：${err.message}`);
    }
    e.target.value="";
  };
}
function parseMemberCSVRows(text){
  const lines=String(text||"").replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.trim());
  if(!lines.length)return [];
  const delimiter=[",","\t",";"].sort((a,b)=>(lines[0].split(b).length-lines[0].split(a).length))[0];
  return lines.map(line=>{const cells=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'&&quoted&&line[i+1]==='"'){value+='"';i++;}else if(c==='"')quoted=!quoted;else if(c===delimiter&&!quoted){cells.push(value);value="";}else value+=c;}cells.push(value);return cells;});
}
function parseMemberCSV(text){const rows=parseMemberCSVRows(text);if(!rows.length)return[];const headers=rows[0];return rows.slice(1).map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]||""]))); }

function renderEventEdit() {
  const ev = ctx.ev;
  screen.innerHTML = `<div class="card">
    <div class="card-title">回の情報を編集</div>
    <div class="form-row"><label>イベント名</label><input id="evName" value="${esc(ev.name)}"></div>
    <div class="form-row"><label>開催日</label><input id="evDate" type="date" value="${esc(ev.date)}"></div>
    <div class="form-row"><label>フライヤーを変更</label><input id="evFlyer" type="file" accept="image/*"></div>
    <button class="btn btn-primary" id="saveMeta">保存</button></div>`;
  document.getElementById("saveMeta").onclick = async () => {
    const name = document.getElementById("evName").value.trim();
    const date = document.getElementById("evDate").value;
    if (!name || !date) { alert("イベント名と開催日を入力してください"); return; }
    if (ctx.mode === "archive" && !confirm("変更を保存しますか？")) return;
    ev.name = name; ev.date = date; ev.u.meta = Date.now();
    const f = document.getElementById("evFlyer").files[0];
    if (f) await uploadFlyer(ev, f);
    persistDb();
    back();
  };
}

/* ---------- バーカウンター初回準備 ---------- */
function renderBarSetup() {
  const b = ensureBar(ctx.bar);
  screen.innerHTML = `<div class="card">
    <div class="card-title">バーカウンター開始準備</div>
    <p class="sub-text">営業開始前に、金庫に入っている現金を金種ごとに登録してください。登録後、販売画面へ進みます。</p>
    <div class="cash-entry-heading"><span>STARTING CASH</span><small>金種ごとの枚数を入力してください</small></div>
    ${barCashRows("start", b.startBreakdown)}
    <div class="money-display"><div class="label">開始時の金庫額</div><div class="amount" id="barSetupTotal">¥${formatMoney(CASH_DENOMINATIONS.reduce((sum,v)=>sum+v*Number(b.startBreakdown[v]||0),0))}</div></div>
    <button class="btn btn-primary btn-large" id="startBarBtn">金庫額を登録して開始</button>
  </div>`;
  const update = () => { const total = [...screen.querySelectorAll('[data-bc="start"]')].reduce((sum,x)=>sum+Number(x.dataset.v)*Number(x.value||0),0); document.getElementById("barSetupTotal").textContent = `¥${formatMoney(total)}`; };
  screen.querySelectorAll('[data-bc="start"]').forEach(inp => inp.oninput = update);
  document.getElementById("startBarBtn").onclick = () => {
    let valid = true;
    screen.querySelectorAll('[data-bc="start"]').forEach(inp => { const n=Number(inp.value||0); if(!Number.isInteger(n)||n<0) valid=false; else b.startBreakdown[inp.dataset.v]=n; });
    if(!valid){alert("金種の枚数は0以上の整数で入力してください");return;}
    b.started = true; b.startedAt = Date.now(); barPage = "sales"; saveBar(); navigate(renderBarHome);
  };
}

/* ---------- バーカウンター ---------- */
function barCashRows(kind, breakdown) {
  return `<div class="cash-entry-list">` + CASH_DENOMINATIONS.map(v => `
    <div class="cash-entry-row"><label class="cash-denomination"><span class="cash-denom-value">${v.toLocaleString()}</span><span class="cash-denom-unit">円</span></label>
    <div class="cash-entry-input-wrap"><input type="number" min="0" step="1" inputmode="numeric" value="${Number(breakdown[v] || 0)}" data-bc="${kind}" data-v="${v}" aria-label="${v.toLocaleString()}円の枚数"><span>枚</span></div></div>`).join("") + `</div>`;
}
function getIssuedDrinkTicketCount(eventState) {
  const history = Array.isArray(eventState?.receptionHistory) ? eventState.receptionHistory : [];
  return history.reduce((sum, entry) => {
    const guests = Array.isArray(entry.guests) ? entry.guests.length : Number(entry.general || 0) + Number(entry.tmp || 0);
    return sum + Math.max(0, Number(guests || 0));
  }, 0);
}

function renderBarHome() {
  const $ = id => document.getElementById(id);
  const ev = ctx.ev, b = ensureBar(ctx.bar);
  if (!b.started) { renderBarSetup(); return; }
  const sharedLineup = Array.isArray(db.drinkLineup) ? db.drinkLineup : defaultBarProducts();
  const previousProducts = b.products || [];
  b.products = sharedLineup.map(p => ({ ...p, soldOut: Boolean(previousProducts.find(x => x.id === p.id)?.soldOut) }));
  ctx.bar = b;
  if (ctx.mode === "live") { ev.bar = b; }
  if (barCartEventId !== ev.id) { barCart = []; barCartEventId = ev.id; barCheckoutPage = false; barOrderComplete = false; if (barOrderCompleteTimer) clearTimeout(barOrderCompleteTimer); }
  const dt = new Date(ev.date + "T00:00:00"), md = `${dt.getMonth() + 1}/${dt.getDate()}`;
  const yen = n => "¥" + formatMoney(n);
  const sales = summarizeBarSales(b);
  const issuedTickets = getIssuedDrinkTicketCount(ev.state || state);
  const expectedUnusedTickets = issuedTickets - Number(sales.ticketUnits || 0);
  // 受付履歴から配布枚数を自動集計。現物回収枚数だけを独立して手入力する。
  b.tickets = issuedTickets;
  const productRows = Object.entries(sales.byProduct).map(([id, p]) => `
    <div class="sales-product-row"><strong>${esc(p.name)}</strong><span>${p.totalUnits}杯</span><span>現金 ${p.cashUnits}杯</span><span>チケ ${p.ticketUnits}杯</span><b>${yen(p.cashRevenue)}</b></div>
  `).join("");
  if (barOrderComplete) {
    const completedSale = (b.sales || []).slice().sort((a, z) => Number(z.timestamp || 0) - Number(a.timestamp || 0))[0];
    const completedItems = (completedSale?.items || []).map(item => `<div><span>${esc(item.name)} ×${Number(item.qty || 0)}</span></div>`).join("");
    const completedTime = completedSale?.timestamp ? new Date(completedSale.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
    screen.innerHTML = `
      <div class="success-screen" role="status" aria-live="polite">
        <div class="success-icon">✓</div>
        <div class="success-text">注文完了</div>
        <div class="success-subtext">3秒後に商品選択画面へ戻ります</div>
        <div class="success-summary">
          ${completedTime ? `<div><span>注文時刻</span><strong>${completedTime}</strong></div>` : ""}
          ${completedItems ? `<div class="bar-complete-items"><span>ご注文内容</span><strong>${completedItems}</strong></div>` : ""}
          <div><span>お支払い</span><strong>${completedSale?.paymentMethod === "ticket" ? "ドリチケ" : "現金"}</strong></div>
        </div>
        <button type="button" class="btn btn-primary btn-large" id="barOrderCompleteNext">次の注文へ進む</button>
      </div>`;
    const returnToProducts = () => {
      if (!barOrderComplete) return;
      barOrderComplete = false;
      if (barOrderCompleteTimer) clearTimeout(barOrderCompleteTimer);
      barOrderCompleteTimer = null;
      barCheckoutPage = false;
      barPage = "sales";
      renderBarHome();
    };
    const nextButton = $("barOrderCompleteNext");
    if (nextButton) nextButton.onclick = returnToProducts;
    // 同期などで renderBarHome が再実行されても、3秒タイマーをリセットしない。
    if (!barOrderCompleteTimer) {
      barOrderCompleteTimer = setTimeout(() => {
        barOrderCompleteTimer = null;
        returnToProducts();
      }, 3000);
    }
    return;
  }

  const latestOrders = (b.sales || [])
    .slice()
    .sort((a, z) => Number(z.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, 3);
  const latestOrdersHtml = latestOrders.map((sale, index) => {
    const details = (sale.items || []).map(item => `${esc(item.name)} ×${Number(item.qty || 0)}`).join("、");
    const time = new Date(sale.timestamp || Date.now()).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    const method = sale.paymentMethod === "ticket" ? "ドリチケ" : "現金";
    const amount = sale.paymentMethod === "ticket" ? "チケット払い" : yen(sale.totalAmount || 0);
    return `<div class="bar-latest-order">
      <div class="bar-latest-order-main">
        <div class="bar-latest-order-meta"><strong>${index + 1}. ${time}</strong><span class="bar-order-payment ${sale.paymentMethod === "ticket" ? "is-ticket" : "is-cash"}">${method}</span></div>
        <div class="bar-latest-order-items">${details || "商品情報なし"}</div>
      </div>
      <strong class="bar-latest-order-amount">${amount}</strong>
    </div>`;
  }).join("");
  const recent = (b.sales || []).slice(0, 12).map(s => {
    const detail = (s.items || []).map(i => `${esc(i.name)} ×${Number(i.qty || 0)}`).join("、");
    const time = new Date(s.timestamp || Date.now()).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    const method = s.paymentMethod === "ticket" ? "ドリチケ" : "現金";
    const paymentNote = s.paymentMethod === "ticket" ? "チケット使用" : `預かり ${yen(s.paidAmount || 0)} ／ お釣り ${yen(s.change || 0)}`;
    return `<div class="sale-history-row"><div><strong>${time} ・ ${method}</strong><small>${detail}</small><small>${paymentNote}</small></div><div class="sale-history-right"><b>${s.paymentMethod === "ticket" ? "チケット" : yen(s.totalAmount || 0)}</b><button class="mini-danger" data-cancel-sale="${esc(s.id)}">取消</button></div></div>`;
  }).join("");

  screen.innerHTML = `
  <div class="bar-page-nav">
    <button class="bar-page-tab ${barPage === "sales" ? "active" : ""}" data-bar-page="sales">販売</button>
    <button class="bar-page-tab ${barPage === "products" ? "active" : ""}" data-bar-page="products">商品管理</button>
    <button class="bar-page-tab ${barPage === "history" ? "active" : ""}" data-bar-page="history">販売履歴・集計</button>
    <button class="bar-page-tab ${barPage === "cash" ? "active" : ""}" data-bar-page="cash">金庫・精算</button>
  </div>
  <div class="card sales-card" data-bar-section="sales">
    <div class="sales-heading"><div class="card-title">ドリンク販売</div><span class="sales-live"><i></i> SALES LIVE</span></div>
    <div class="sales-summary-grid">
      <div><small>販売数</small><strong>${sales.totalUnits}<em>杯</em></strong></div>
      <div><small>うちドリチケ</small><strong>${sales.ticketUnits}<em>杯</em></strong></div>
      <div><small>現金売上</small><strong>${yen(sales.cashRevenue)}</strong></div>
    </div>
    ${barCheckoutPage ? `
      <div class="bar-checkout-page">
        <div class="bar-checkout-page-heading"><button type="button" class="bar-checkout-back" id="barBackToProducts">← 商品選択に戻る</button><div class="card-title">注文内容・会計</div></div>
        <div class="cart-panel bar-checkout-cart">
          <div class="cart-heading"><strong>選択中の商品</strong><button class="text-button" id="clearBarCart">すべてクリア</button></div>
          <div id="barCartLines"></div>
          <div class="cart-total"><span id="barCartCount">0点</span><strong id="barCartTotal">¥0</strong></div>
          <div class="checkout-actions">
            <button class="btn btn-primary" id="barCashCheckout">現金で会計</button>
            <button class="btn btn-ticket" id="barTicketCheckout">ドリチケで会計</button>
          </div>
          <p class="sub-text">ドリチケ会計は商品1点につきチケット1枚として記録します。</p>
        </div>
      </div>
    ` : `
      <div class="section-label">商品をタップして注文に追加</div>
      <div class="product-grid">
        ${b.products.map(p => {
          const selected = barCart.find(x => x.productId === p.id);
          const qty = selected ? selected.qty : 0;
          return `<div class="product-tile-card" data-product-card="${esc(p.id)}">
            <button type="button" class="product-tile ${p.soldOut ? "sold-out" : ""} ${qty ? "has-selection" : ""}" data-add-product="${esc(p.id)}" ${p.soldOut ? "disabled aria-disabled=\"true\"" : ""}>
              <span class="product-tile-name">${esc(p.name)}</span><strong>${yen(Number(p.price || 0))}</strong><small>${p.soldOut ? "売切れ" : "＋ 注文に追加"}</small>
            </button>
            <div class="product-selection-qty" data-selection-qty="${esc(p.id)}" ${qty ? "" : "hidden"}>
              <button type="button" class="qty-btn" data-selection-dec="${esc(p.id)}" aria-label="${esc(p.name)}を1つ減らす">−</button>
              <strong>${qty}</strong>
              <button type="button" class="qty-btn" data-selection-inc="${esc(p.id)}" aria-label="${esc(p.name)}を1つ増やす">＋</button>
            </div>
          </div>`;
        }).join("") || `<div class="sub-text">商品がありません。「商品・価格の設定」から追加してください。</div>`}
      </div>
      <div class="bar-cart-dock ${barCart.length ? "has-items" : ""}" id="barCartDock" aria-live="polite">
        <div class="bar-cart-dock-info"><strong id="barCartDockItems">${barCart.length ? barCart.map(x => `${esc(x.name)} ×${x.qty}`).join("　") : "商品を選択してください"}</strong><span id="barCartDockTotal">${yen(barCart.reduce((n,x)=>n+x.price*x.qty,0))}</span></div>
        <button type="button" class="bar-cart-dock-next" id="barGoCheckout" ${barCart.length ? "" : "disabled"}>会計へ進む <span aria-hidden="true">→</span></button>
      </div>
    `}
    <div class="bar-latest-orders" aria-live="polite">
      <div class="bar-latest-orders-heading"><strong>直近の注文</strong><span>最新3件</span></div>
      ${latestOrdersHtml || `<div class="bar-latest-orders-empty">まだ注文はありません。</div>`}
    </div>
  </div>

  <div class="card" data-bar-section="history">
    <div class="card-title">販売集計</div>
    <div class="sales-summary-grid report-summary">
      <div><small>販売数</small><strong>${sales.totalUnits}<em>杯</em></strong></div>
      <div><small>うちドリチケ</small><strong>${sales.ticketUnits}<em>杯</em></strong></div>
      <div><small>現金売上</small><strong>${yen(sales.cashRevenue)}</strong></div>
    </div>
    <div class="section-label">商品別内訳</div>
    ${productRows || `<div class="sub-text">まだ販売記録がありません。</div>`}
  </div>

  <div class="card" data-bar-section="products">
    <div class="product-management">
      <div class="card-title">商品・価格の設定</div>
      <p class="sub-text">ここで登録したドリンクラインナップは、すべてのイベント回で共通して使われます。商品を削除・追加すると、他の回にも反映されます。販売済みの記録は残ります。</p>
      <div class="product-admin-list">
        ${b.products.map(p => `<div class="product-admin-row" data-product-row="${esc(p.id)}">
          <input type="text" value="${esc(p.name)}" aria-label="商品名" data-product-name="${esc(p.id)}">
          <input type="number" min="1" step="1" value="${Number(p.price || 0)}" aria-label="価格" data-product-price="${esc(p.id)}">
          <div class="product-admin-actions">
            <button type="button" class="btn btn-secondary" data-save-product="${esc(p.id)}">更新</button>
            <button type="button" class="btn ${p.soldOut ? "btn-primary" : "btn-secondary"}" data-toggle-soldout="${esc(p.id)}">${p.soldOut ? "販売再開" : "売切れ"}</button>
            <button type="button" class="mini-danger" data-delete-product="${esc(p.id)}">削除</button>
          </div>
        </div>`).join("")}
      </div>
      <div class="add-product-form">
        <input id="newProductName" placeholder="商品名（例：ビール）" aria-label="追加する商品名">
        <input id="newProductPrice" type="number" min="1" step="1" value="500" aria-label="販売価格">
        <button class="btn btn-primary" id="addBarProduct">商品を追加</button>
      </div>
    </div>
  </div>

  <div class="card" data-bar-section="history">
    <div class="card-title">直近の販売</div>
    ${recent || `<div class="sub-text">販売履歴はまだありません。</div>`}
    ${(b.deletedSales || []).length ? `<div class="deleted-history-section"><div class="card-title">取消した販売履歴（30日間保存）</div><div class="deleted-history-list">${b.deletedSales.slice().sort((x,y)=>Number(y.deletedAt||0)-Number(x.deletedAt||0)).map(x => {
      const sale = x.sale || {};
      const details = (sale.items || []).map(i => `${esc(i.name)} ×${Number(i.qty||0)}`).join("、");
      const when = new Date(sale.timestamp || x.deletedAt).toLocaleString("ja-JP");
      const deleted = new Date(x.deletedAt).toLocaleString("ja-JP");
      const restored = Number(x.restoredAt||0) > Number(x.deletedAt||0);
      return `<div class="deleted-history-row ${restored ? "is-restored" : ""}"><div class="deleted-history-content"><s>${when} ・ ${sale.paymentMethod === "ticket" ? "ドリチケ" : "現金"} ・ ${details} ・ ${sale.paymentMethod === "ticket" ? "チケット" : yen(sale.totalAmount||0)}</s><small>${restored ? "復元済み" : `取消日時：${deleted}`}</small></div>${restored ? `<span class="sub-text">復元済み</span>` : `<button class="btn btn-secondary" data-restore-sale="${esc(sale.id)}">復元</button>`}</div>`;
    }).join("")}</div></div>` : ""}
  </div>

  <div class="card" data-bar-section="cash">
    <div class="card-title">① 開始時の金庫</div>
    ${barCashRows("start", b.startBreakdown)}
    <div class="money-display"><div class="label">開始時の金額</div><div class="amount" id="bStart"></div></div>
  </div>

  <div class="card" data-bar-section="cash">
    <div class="card-title">ドリンク精算</div>
    <div class="section-label"><span class="step">②</span>金庫内のお金を手で数える</div>
    ${barCashRows("end", b.endBreakdown)}
    <div class="row"><span>金庫内の金額</span><strong id="bEnd"></strong></div>
    <div class="row"><span>金庫の現金増加</span><strong id="bRev"></strong></div>
    <div class="row"><span>現金売上</span><strong id="bCashSales"></strong></div>
    <div class="row"><span>現金差額（金庫増加 − 現金売上）</span><strong id="bDiff"></strong></div>
    <div class="section-label" style="margin-top:12px">封筒に書く内容</div>
    <div class="env" id="bEnv"></div>
    <button class="btn btn-secondary" id="bCopy">文面をコピー</button>
  </div>

  <div class="card" data-bar-section="cash">
    <div class="card-title">確認・ドリチケ照合(試行運用)</div>
    <div class="ticket-reconciliation">
      <div class="ticket-reconciliation-heading"><strong>受付・販売記録から自動集計</strong><span>クラウド同期</span></div>
      <div class="ticket-reconciliation-grid">
        <div><small>受付で配布した枚数</small><strong id="bTickets">${issuedTickets}枚</strong></div>
        <div><small>販売記録上の使用枚数</small><strong id="bTicketSales">${sales.ticketUnits}枚</strong></div>
        <div><small>配布予定数と販売数の差</small><strong id="bTicketExpected">${expectedUnusedTickets}枚</strong></div>
      </div>
      <p class="sub-text">受付履歴の人数を配布予定枚数として集計します。受付履歴や販売履歴の追加・取消・復元は再集計に反映されます。</p>
      <div class="row ticket-stock-theory"><span>受付システム上の残数（理論値）</span><strong>${Math.max(0, Number((ev.state || state).drinkTickets || 0))}枚</strong></div>
    </div>
    <div class="form-row" style="margin-top:14px"><label>受付に実際に残っているドリチケ枚数</label>
      <input id="bReceptionTicketRemaining" type="number" min="0" step="1" inputmode="numeric" value="${esc(b.receptionTicketRemaining)}" placeholder="受付に残っている現物を数えて入力"></div>
    <div class="row"><span>受付の残数照合</span><strong id="bReceptionTicketSt"></strong></div>
    <div class="form-row" style="margin-top:14px"><label>バーカウンターで実際に回収したドリチケ枚数</label>
      <input id="bTicketCollected" type="number" min="0" step="1" inputmode="numeric" value="${esc(b.ticketCollected)}" placeholder="回収した現物を数えて入力"></div>
    <div class="row"><span>販売記録と回収枚数の照合</span><strong id="bTicketSt"></strong></div>
    <div class="ticket-checklist checklist">
      <label><input type="checkbox" data-ticket-check="reception" ${b.ticketChecks.reception ? "checked" : ""}><span>受付の配布記録を確認した</span></label>
      <label><input type="checkbox" data-ticket-check="receptionPhysical" ${b.ticketChecks.receptionPhysical ? "checked" : ""}><span>受付に残っているドリチケの現物を数えた</span></label>
      <label><input type="checkbox" data-ticket-check="sales" ${b.ticketChecks.sales ? "checked" : ""}><span>ドリチケの販売記録を確認した</span></label>
      <label><input type="checkbox" data-ticket-check="physical" ${b.ticketChecks.physical ? "checked" : ""}><span>バーカウンターで回収したドリチケの現物を数えた</span></label>
    </div>
    <div class="ticket-result-note" id="bTicketDiagnosis" aria-live="polite"></div>
    <div class="form-row" style="margin-top:14px"><label>（念のため）封筒を出した後、金庫に残った金額</label>
      <input id="bRemain" type="number" min="0" inputmode="numeric" value="${esc(b.remain)}" placeholder="数え直した金額"></div>
    <div class="row"><span>開始時の金額と一致</span><strong id="bRemainSt"></strong></div>
    <div class="checklist">
      <label><input type="checkbox" data-ck="env" ${b.checks.env ? "checked" : ""}><span>封筒に記入した</span></label>
      <label><input type="checkbox" data-ck="photo" ${b.checks.photo ? "checked" : ""}><span>受付精算の封筒と一緒に写真を撮った</span></label>
      <label><input type="checkbox" data-ck="fridge" ${b.checks.fridge ? "checked" : ""}><span>封筒を冷蔵庫に入れた</span></label>
    </div>
  </div>
  <button class="btn btn-danger btn-large" data-bar-section="cash" id="clearBarAccounting">バーカウンターの会計データを一括削除</button>
  `;

  screen.querySelectorAll("[data-bar-page]").forEach(btn => btn.onclick = () => { barPage = btn.dataset.barPage; barCheckoutPage = false; renderBarHome(); });
  screen.querySelectorAll("[data-bar-section]").forEach(el => { el.hidden = el.dataset.barSection !== barPage; });
  updateBackButton();
  const cartTotal = () => barCart.reduce((sum, x) => sum + x.price * x.qty, 0);
  const cartUnits = () => barCart.reduce((sum, x) => sum + x.qty, 0);
  const refreshCart = () => {
    const lines = $("barCartLines");
    const dock = $("barCartDock");
    if (dock) {
      $("barCartDockItems").textContent = barCart.length ? barCart.map(x => `${x.name} ×${x.qty}`).join("　") : "商品を選択してください";
      $("barCartDockTotal").textContent = yen(cartTotal());
      dock.classList.toggle("has-items", barCart.length > 0);
      $("barGoCheckout").disabled = !barCart.length;
    }
    screen.querySelectorAll("[data-selection-qty]").forEach(el => {
      const id = el.dataset.selectionQty;
      const line = barCart.find(x => x.productId === id);
      const selected = !!line && line.qty > 0;
      el.hidden = !selected;
      const card = el.closest(".product-tile-card");
      const tile = card && card.querySelector(".product-tile");
      if (tile) tile.classList.toggle("has-selection", selected);
      const count = el.querySelector("strong");
      if (count) count.textContent = String(line ? line.qty : 0);
    });
    if (!lines) return;
    lines.innerHTML = barCart.map(x => `<div class="cart-line">
      <div class="cart-line-title"><strong>${esc(x.name)}</strong><small>${yen(x.price)} × ${x.qty}</small></div>
      <div class="cart-line-actions"><button class="qty-btn" data-cart-dec="${esc(x.productId)}">−</button><b>${x.qty}</b><button class="qty-btn" data-cart-inc="${esc(x.productId)}">＋</button><button class="mini-danger" data-cart-remove="${esc(x.productId)}">削除</button></div>
    </div>`).join("") || `<div class="cart-empty">商品を選ぶとここに表示されます</div>`;
    $("barCartCount").textContent = `${cartUnits()}点`;
    $("barCartTotal").textContent = yen(cartTotal());
    lines.querySelectorAll("[data-cart-inc]").forEach(btn => btn.onclick = () => {
      const line = barCart.find(x => x.productId === btn.dataset.cartInc); if (line) line.qty++;
      refreshCart();
    });
    lines.querySelectorAll("[data-cart-dec]").forEach(btn => btn.onclick = () => {
      const line = barCart.find(x => x.productId === btn.dataset.cartDec); if (line) line.qty--;
      barCart = barCart.filter(x => x.qty > 0); refreshCart();
    });
    lines.querySelectorAll("[data-cart-remove]").forEach(btn => btn.onclick = () => {
      barCart = barCart.filter(x => x.productId !== btn.dataset.cartRemove); refreshCart();
    });
  };

  const goCheckout = $("barGoCheckout");
  if (goCheckout) goCheckout.onclick = () => {
    if (!barCart.length) return;
    barCheckoutPage = true;
    renderBarHome();
    // 商品選択画面でのスクロール位置を引き継がず、会計画面の先頭から表示する。
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };
  const backToProducts = $("barBackToProducts");
  if (backToProducts) backToProducts.onclick = () => {
    barCheckoutPage = false;
    renderBarHome();
    // 商品選択画面へ戻る場合も先頭から表示する。
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };
  screen.querySelectorAll("[data-add-product]").forEach(btn => btn.onclick = () => {
    const p = b.products.find(x => x.id === btn.dataset.addProduct); if (!p || p.soldOut) return;
    let line = barCart.find(x => x.productId === p.id);
    if (!line) { line = { productId: p.id, name: p.name, price: Number(p.price || 0), qty: 0 }; barCart.push(line); }
    line.qty++;
    refreshCart();
  });
  screen.querySelectorAll("[data-selection-inc]").forEach(btn => btn.onclick = () => {
    const line = barCart.find(x => x.productId === btn.dataset.selectionInc);
    if (line) line.qty++;
    refreshCart();
  });
  screen.querySelectorAll("[data-selection-dec]").forEach(btn => btn.onclick = () => {
    const line = barCart.find(x => x.productId === btn.dataset.selectionDec);
    if (line) line.qty--;
    barCart = barCart.filter(x => x.qty > 0);
    refreshCart();
  });
  const clearCartButton = $("clearBarCart");
  if (clearCartButton) clearCartButton.onclick = () => { barCart = []; refreshCart(); };
  const cashCheckoutButton = $("barCashCheckout");
  if (cashCheckoutButton) cashCheckoutButton.onclick = () => {
    if (!barCart.length) { alert("商品をカートに追加してください"); return; }
    const total = cartTotal();
    let paid = 0;
    screen.insertAdjacentHTML("beforeend", `<div class="cashier-overlay" id="barCashierOverlay"><div class="cashier-dialog" id="barCashierDialog"></div></div>`);
    const overlay = $("barCashierOverlay"), dialog = $("barCashierDialog");

    // 手順1：預かり金額（受付と同じ。チェックボックスは出さない）
    const renderAmountStep = () => {
      dialog.innerHTML = `
        <div class="cashier-head"><h2>預かり金額</h2><button class="cashier-cancel" id="barCashierCancel">中断</button></div>
        <div class="cashier-total-row"><span>合計</span><strong>${yen(total)}</strong></div>
        <div class="cashier-paid" id="barCashierPaid">¥0</div>
        <div class="cashier-status short" id="barCashierStatus">受け取ったお札・硬貨のボタンを押して積み上げてください</div>
        <button type="button" class="cashier-exact-button" id="barCashierExact">ちょうど受け取り</button>
        <div class="cashier-keypad">
          <button data-bar-add-cash="100">+100</button><button data-bar-add-cash="500">+500</button><button data-bar-add-cash="1000">+1000</button>
          <button data-bar-add-cash="5000">+5000</button><button data-bar-add-cash="10000">+10000</button><button id="barCashierClear">C</button>
        </div>
        <p class="cashier-help">受け取ったお札・硬貨のボタンを押して積み上げてください（押し間違いはC）</p>
        <button class="cashier-confirm" id="barCashierConfirm" disabled>確認へ</button>`;
      const paidEl = $("barCashierPaid"), statusEl = $("barCashierStatus"), confirmBtn = $("barCashierConfirm");
      const refreshPayment = () => {
        paidEl.textContent = yen(paid);
        const diff = paid - total;
        if (paid === total) { statusEl.textContent = "お釣り ¥0"; statusEl.className = "cashier-status exact"; }
        else if (paid > total) { statusEl.textContent = `お釣り ${yen(diff)}`; statusEl.className = "cashier-status change"; }
        else { statusEl.textContent = `あと ${yen(total - paid)} 不足しています`; statusEl.className = "cashier-status short"; }
        confirmBtn.disabled = paid < total;
      };
      dialog.querySelectorAll("[data-bar-add-cash]").forEach(btn => btn.onclick = () => { paid += Number(btn.dataset.barAddCash); refreshPayment(); });
      $("barCashierExact").onclick = () => { paid = total; refreshPayment(); };
      $("barCashierClear").onclick = () => { paid = 0; refreshPayment(); };
      $("barCashierCancel").onclick = () => overlay.remove();
      confirmBtn.onclick = () => { if (paid >= total) renderChecklistStep(); };
      refreshPayment();
    };

    // 手順2：会計確認（受付と同じ。金額確定後にチェックボックスを表示）
    const renderChecklistStep = () => {
      dialog.innerHTML = `
        <div class="cashier-head"><h2>会計確認</h2><button class="cashier-cancel" id="barCashierBack">戻る</button></div>
        <div class="cashier-total-row"><span>合計</span><strong>${yen(total)}</strong></div>
        <div class="cashier-total-row"><span>預かり</span><strong>${yen(paid)}</strong></div>
        <div class="cashier-status change" id="barChangeDisplay">お釣り ${yen(paid - total)}</div>
        <div class="bar-payment-checklist" aria-label="現金受け取り確認">
          <label><input type="checkbox" id="barCashReceivedCheck"><span>現金を受け取った</span></label>
          <label><input type="checkbox" id="barChangeGivenCheck"><span>お釣りを渡した</span></label>
        </div>
        <button class="cashier-confirm" id="barCashierSubmit" disabled>会計を確定</button>`;
      const submit = $("barCashierSubmit"), c1 = $("barCashReceivedCheck"), c2 = $("barChangeGivenCheck");
      const refreshChecks = () => { submit.disabled = !(c1.checked && c2.checked); };
      c1.onchange = refreshChecks; c2.onchange = refreshChecks;
      $("barCashierBack").onclick = renderAmountStep;
      submit.onclick = () => {
        if (submit.disabled) return;
        submit.disabled = true;                      // 二重確定防止
        b.sales.unshift({ id: uid(), timestamp: Date.now(), paymentMethod: "cash", items: structuredClone(barCart), totalAmount: total, paidAmount: paid, change: paid - total });
        barCart = []; barCheckoutPage = false; barOrderComplete = true; saveBar(); renderBarHome();
      };
    };
    renderAmountStep();
  };
  const ticketCheckoutButton = $("barTicketCheckout");
  if (ticketCheckoutButton) ticketCheckoutButton.onclick = () => {
    if (!barCart.length) { alert("商品をカートに追加してください"); return; }
    const total = cartTotal();
    const ticketUnits = cartUnits();
    const ticketItems = barCart.map(x => `<div class="ticket-confirm-item"><span>${esc(x.name)}</span><strong>× ${Number(x.qty)}</strong></div>`).join("");
    screen.insertAdjacentHTML("beforeend", `
      <div class="cashier-overlay" id="barTicketConfirmOverlay" role="dialog" aria-modal="true" aria-labelledby="barTicketConfirmTitle">
        <div class="cashier-dialog ticket-confirm-dialog">
          <div class="cashier-head"><h2 id="barTicketConfirmTitle">ドリチケで会計します。</h2><button type="button" class="cashier-cancel" id="barTicketConfirmCancel">戻る</button></div>
          <div class="cashier-total-row"><span>使用するドリチケ</span><strong>${ticketUnits}枚</strong></div>
          <div class="ticket-confirm-items">${ticketItems}</div>
          <div class="cashier-status short ticket-confirm-warning">この内容でドリチケ会計を確定します。<br>確定後は販売履歴に記録されます。</div>
          <div class="bar-payment-checklist" aria-label="ドリチケ受け取り確認">
            <label><input type="checkbox" id="barTicketReceivedCheck"><span>ドリチケを受け取った</span></label>
          </div>
          <button type="button" class="cashier-confirm" id="barTicketConfirmSubmit" disabled>ドリチケ会計を確定</button>
        </div>
      </div>`);
    const overlay = $("barTicketConfirmOverlay");
    $("barTicketConfirmCancel").onclick = () => overlay.remove();
    overlay.addEventListener("click", event => { if (event.target === overlay) overlay.remove(); });
    const ticketReceivedCheck = $("barTicketReceivedCheck");
    const ticketSubmitButton = $("barTicketConfirmSubmit");
    ticketReceivedCheck.onchange = () => { ticketSubmitButton.disabled = !ticketReceivedCheck.checked; };
    ticketSubmitButton.onclick = event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "会計を記録しています…";
      b.sales.unshift({ id: uid(), timestamp: Date.now(), paymentMethod: "ticket", items: structuredClone(barCart), totalAmount: total, paidAmount: 0, change: 0 });
      barCart = []; barCheckoutPage = false; barOrderComplete = true; saveBar(); renderBarHome();
    };
  };

  screen.querySelectorAll("[data-save-product]").forEach(btn => btn.onclick = () => {
    const id = btn.dataset.saveProduct, p = b.products.find(x => x.id === id);
    const row = btn.closest("[data-product-row]");
    const name = row.querySelector("[data-product-name]").value.trim();
    const price = Number(row.querySelector("[data-product-price]").value);
    if (!p || !name || !Number.isInteger(price) || price <= 0) { alert("商品名と1円以上の整数価格を入力してください"); return; }
    p.name = name; p.price = price;
    db.drinkLineup = (db.drinkLineup || []).map(x => x.id === id ? { id, name, price } : x);
    db.drinkLineupUpdated = Date.now();
    for (const event of db.events) if (event.bar) {
      const soldOut = Boolean(event.bar.products?.find(x => x.id === id)?.soldOut);
      event.bar.products = db.drinkLineup.map(x => ({ ...x, soldOut: x.id === id ? soldOut : Boolean(event.bar.products?.find(y => y.id === x.id)?.soldOut) }));
    }
    barCart = barCart.map(x => x.productId === id ? { ...x, name, price } : x);
    saveBar(); renderBarHome();
  });
  screen.querySelectorAll("[data-toggle-soldout]").forEach(btn => btn.onclick = () => {
    const p = b.products.find(x => x.id === btn.dataset.toggleSoldout); if (!p) return;
    p.soldOut = !p.soldOut;
    if (p.soldOut) barCart = barCart.filter(x => x.productId !== p.id);
    saveBar(); renderBarHome();
  });
  screen.querySelectorAll("[data-delete-product]").forEach(btn => btn.onclick = () => {
    if (!confirm("この商品を販売メニューから削除しますか？\n過去の販売履歴は残ります。")) return;
    const deletedId = btn.dataset.deleteProduct;
    db.drinkLineup = (db.drinkLineup || []).filter(x => x.id !== deletedId);
    db.drinkLineupUpdated = Date.now();
    for (const event of db.events) if (event.bar) event.bar.products = (event.bar.products || []).filter(x => x.id !== deletedId);
    b.products = b.products.filter(x => x.id !== deletedId);
    barCart = barCart.filter(x => x.productId !== deletedId);
    saveBar(); renderBarHome();
  });
  $("addBarProduct").onclick = () => {
    const name = $("newProductName").value.trim(), price = Number($("newProductPrice").value);
    if (!name || !Number.isInteger(price) || price <= 0) { alert("商品名と1円以上の整数価格を入力してください"); return; }
    const product = { id: uid(), name, price };
    db.drinkLineup = [...(db.drinkLineup || []), product];
    db.drinkLineupUpdated = Date.now();
    for (const event of db.events) if (event.bar) event.bar.products = [...(event.bar.products || []), { ...product }];
    b.products = [...b.products, { ...product }];
    saveBar(); renderBarHome();
  };
  screen.querySelectorAll("[data-cancel-sale]").forEach(btn => btn.onclick = () => {
    if (!confirm("この販売記録を取り消しますか？集計からも差し引かれます。削除ログは30日間保存され、あとから復元できます。")) return;
    const saleId = btn.dataset.cancelSale;
    const sale = b.sales.find(x => x.id === saleId);
    if (!sale) return;
    b.deletedSales = pruneDeletionLog(b.deletedSales || []);
    const prevFloor = b.deletedSales.filter(x => x.sale?.id === saleId).reduce((m, x) => Math.max(m, Number(x.deletedAt||0), Number(x.restoredAt||0)), 0);
    b.deletedSales = b.deletedSales.filter(x => x.sale?.id !== saleId);
    b.deletedSales.unshift({ sale: structuredClone(sale), deletedAt: Math.max(Date.now(), prevFloor + 1), restoredAt: 0 });
    b.voidedSales = [...new Set([...(b.voidedSales || []), saleId])];
    b.sales = b.sales.filter(x => x.id !== saleId);
    saveBar(); renderBarHome();
  });
  screen.querySelectorAll("[data-restore-sale]").forEach(btn => btn.onclick = () => {
    if (!confirm("この販売履歴を復元しますか？売上集計にも再び反映されます。")) return;
    const item = b.deletedSales.find(x => x.sale?.id === btn.dataset.restoreSale && Number(x.restoredAt||0) <= Number(x.deletedAt||0));
    if (!item) return;
    item.restoredAt = Math.max(Date.now(), Number(item.deletedAt || 0) + 1);
    if (!b.sales.some(x => x.id === item.sale.id)) b.sales.unshift(structuredClone(item.sale));
    b.voidedSales = (b.voidedSales || []).filter(id => id !== item.sale.id);
    saveBar(); renderBarHome();
  });

  const recalc = () => {
    const c = barCalc(b), s = summarizeBarSales(b), hasSales = (b.sales || []).length > 0;
    $("bStart").textContent = yen(c.start);
    $("bEnd").textContent = c.hasEnd ? yen(c.end) : "-";
    $("bRev").textContent = c.hasEnd ? yen(c.revenue) : "-";
    $("bCashSales").textContent = yen(s.cashRevenue);
    const receptionState = ev.state || state;
    const issued = getIssuedDrinkTicketCount(receptionState);
    $("bEnv").textContent = c.hasEnd ? `キャッシュドリンク：${formatMoney(s.cashRevenue)}円` : "（金庫内の金額を入力すると表示されます）";
    const rem = b.remain === "" ? null : Number(b.remain);
    $("bRemainSt").innerHTML = rem === null ? "-" : (rem === c.start ? `<span class="ok">一致 ✓</span>` : `<span class="ng">不一致（差 ${formatSignedMoney(rem - c.start)}）</span>`);
    const receptionExpectedRemaining = Math.max(0, Number(receptionState.drinkTickets || 0));
    const expectedUnused = issued - Number(s.ticketUnits || 0);
    $("bTickets").textContent = `${issued}枚`;
    $("bTicketSales").textContent = `${s.ticketUnits}枚`;
    $("bTicketExpected").textContent = `${expectedUnused}枚`;
    const receptionActualRemaining = b.receptionTicketRemaining === "" ? null : Number(b.receptionTicketRemaining);
    const collected = b.ticketCollected === "" ? null : Number(b.ticketCollected);
    const diagnosis = $("bTicketDiagnosis");
    const receptionStatus = $("bReceptionTicketSt");
    const barStatus = $("bTicketSt");
    const notes = [];
    let hasWarning = false;
    if (receptionActualRemaining === null) {
      receptionStatus.innerHTML = `<span class="sub-text">受付の現物枚数を入力してください</span>`;
      notes.push("受付に残っているドリチケを数えて入力してください。");
    } else {
      const receptionDiff = receptionActualRemaining - receptionExpectedRemaining;
      if (receptionDiff > 0) {
        receptionStatus.innerHTML = `<span class="ng">理論値より${receptionDiff}枚多い</span>`;
        notes.push(`受付の現物は理論上の残数より${receptionDiff}枚多く残っています。受付で${receptionDiff}枚を渡し忘れた可能性があります。`);
        hasWarning = true;
      } else if (receptionDiff < 0) {
        receptionStatus.innerHTML = `<span class="ng">理論値より${Math.abs(receptionDiff)}枚少ない</span>`;
        notes.push(`受付の現物は理論上の残数より${Math.abs(receptionDiff)}枚少なくなっています。余分な配布・紛失・数え間違いなどを確認してください。`);
        hasWarning = true;
      } else {
        receptionStatus.innerHTML = `<span class="ok">一致 ✓</span>`;
      }
    }
    if (collected === null) {
      barStatus.innerHTML = `<span class="sub-text">回収した現物枚数を入力してください</span>`;
      notes.push("バーカウンターで回収したドリチケも数えて入力してください。");
    } else if (collected !== Number(s.ticketUnits || 0)) {
      const diff = collected - Number(s.ticketUnits || 0);
      barStatus.innerHTML = `<span class="ng">不一致（${diff > 0 ? "+" : ""}${diff}枚）</span>`;
      notes.push(`バーカウンターの現物枚数と販売記録が${Math.abs(diff)}枚ずれています。販売記録・回収漏れ・数え間違いを確認してください。`);
      hasWarning = true;
    } else {
      barStatus.innerHTML = `<span class="ok">一致 ✓</span>`;
    }
    // 未使用チケットの可能性を示すのは、受付の現物残数が理論値と一致し、
    // かつバーの回収現物枚数が販売記録と一致している場合に限定する。
    if (receptionActualRemaining !== null && collected !== null) {
      const receptionMatches = receptionActualRemaining === receptionExpectedRemaining;
      const barMatches = collected === Number(s.ticketUnits || 0);
      const possiblyUnused = issued - Number(s.ticketUnits || 0);

      if (receptionMatches && barMatches) {
        if (possiblyUnused > 0) {
          notes.push(`受付の現物残数は理論値と一致し、バーの回収枚数も販売記録と一致しています。配布枚数${issued}枚に対して回収枚数は${Number(s.ticketUnits || 0)}枚のため、差の${possiblyUnused}枚は未使用チケットの可能性があります（人数ではなく枚数です）。`);
        } else if (possiblyUnused === 0 && !hasWarning) {
          notes.push("受付の現物残数・バーの回収枚数ともに理論値／販売記録と一致しています。未使用チケットの差はありません。");
        } else if (possiblyUnused < 0) {
          notes.push(`販売記録上の使用枚数が受付で配布した枚数を${Math.abs(possiblyUnused)}枚上回っています。受付の配布記録・販売記録を再確認してください。`);
          hasWarning = true;
        }
      } else if (!receptionMatches) {
        notes.push("受付の現物残数が理論値と一致していないため、未使用チケットの判定は保留しています。受付での渡し忘れ・余分な配布・紛失・数え間違いなどを先に確認してください。");
      } else if (!barMatches) {
        notes.push("バーの回収現物枚数と販売記録が一致していないため、未使用チケットの判定は保留しています。販売記録・回収漏れ・数え間違いを確認してください。");
      }
    }
    diagnosis.className = `ticket-result-note${hasWarning ? " is-warning" : notes.length && receptionActualRemaining !== null && collected !== null ? " is-ok" : ""}`;
    diagnosis.textContent = notes.join(" ");
    if (!c.hasEnd) $("bDiff").textContent = "-";
    else {
      const diff = c.revenue - s.cashRevenue;
      $("bDiff").innerHTML = diff === 0 ? `<span class="ok">一致 ✓</span>` : `<span class="ng">差 ${formatSignedMoney(diff)}</span>`;
    }
  };

  screen.querySelectorAll("[data-bc]").forEach(inp => inp.onchange = () => {
    const n = Number(inp.value || 0);
    if (!Number.isInteger(n) || n < 0) { alert("0以上の整数を入力してください"); inp.value = 0; }
    (inp.dataset.bc === "start" ? b.startBreakdown : b.endBreakdown)[inp.dataset.v] = Number(inp.value || 0);
    saveBar(); recalc();
  });
  $("bRemain").onchange = e => { const n = e.target.value === "" ? "" : Number(e.target.value); if (n !== "" && (!Number.isInteger(n) || n < 0)) { alert("0以上の整数を入力してください"); e.target.value = ""; return; } b.remain = e.target.value; saveBar(); recalc(); };
  $("bTicketCollected").onchange = e => { const n = e.target.value === "" ? "" : Number(e.target.value); if (n !== "" && (!Number.isInteger(n) || n < 0)) { alert("0以上の整数を入力してください"); e.target.value = b.ticketCollected; return; } b.ticketCollected = n; saveBar(); recalc(); };
  $("bReceptionTicketRemaining").onchange = e => { const n = e.target.value === "" ? "" : Number(e.target.value); if (n !== "" && (!Number.isInteger(n) || n < 0)) { alert("0以上の整数を入力してください"); e.target.value = b.receptionTicketRemaining; return; } b.receptionTicketRemaining = n; saveBar(); recalc(); };
  screen.querySelectorAll("[data-ticket-check]").forEach(cb => cb.onchange = () => { b.ticketChecks[cb.dataset.ticketCheck] = cb.checked; saveBar(); });
  screen.querySelectorAll("[data-ck]").forEach(cb => cb.onchange = () => { b.checks[cb.dataset.ck] = cb.checked; saveBar(); });
  $("bCopy").onclick = () => {
    const text = $("bEnv").textContent;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => alert("コピーしました"), () => alert("コピーできませんでした"));
    else { alert("この環境ではコピーできませんでした"); }
  };
  $("clearBarAccounting").onclick = () => {
    if (!confirm("この回のバーカウンター会計データを一括削除しますか？\n販売履歴・金庫の開始／終了額・受付に残っているチケット枚数・回収チケット枚数・チケット照合チェックをリセットします。\n商品名と価格の設定、受付データ、出番／シフトは残ります。")) return;
    const products = structuredClone(b.products);
    const deletedSales = pruneDeletionLog(b.deletedSales || []);
    Object.assign(b, createBar(), { products, sales: [], resetAt: Date.now(), voidedSales: [], deletedSales });
    barCart = []; barCheckoutPage = false; barOrderComplete = false; saveBar(); renderBarHome();
  };
  refreshCart();
  recalc();
}

/* ---------- タイムテーブル・シフト（現在の出番を自動表示） ---------- */
function createTt() { return { acts: [], shifts: [], offsetMinutes: 0 }; }
// 旧バージョンや一部端末から同期された不完全なタイムテーブルでも画面遷移できるよう正規化
function ensureTt(value) {
  const tt = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (!Array.isArray(tt.acts)) tt.acts = [];
  if (!Array.isArray(tt.shifts)) tt.shifts = [];
  // 同期データや旧データに null / 不正行が混入していても描画処理を止めない
  tt.acts = tt.acts.filter(item => item && typeof item === "object");
  tt.shifts = tt.shifts.filter(item => item && typeof item === "object");
  const offset = Number(tt.offsetMinutes || 0);
  tt.offsetMinutes = Number.isFinite(offset) ? offset : 0;
  return tt;
}
function saveTt() {
  if (!ctx) return;
  if (ctx.mode === "archive") { ctx.dirty = true; return; }
  ctx.ev.u.tt = Date.now();
  persistDb();
}
// 日付＋時刻をイベント開始日からの経過分に変換する。旧データは開催日を基準に補完。
function toMin(t) { const [h, m] = String(t || "00:00").split(":").map(Number); return h * 60 + m; }
function dateMin(date, time) {
  const base = new Date((ctx?.ev?.date || date || "2000-01-01") + "T00:00:00").getTime();
  const target = new Date((date || ctx?.ev?.date || "2000-01-01") + "T00:00:00").getTime();
  return Math.round((target - base) / 60000) + toMin(time);
}
function slotRange(s) {
  const startDate = s.startDate || ctx?.ev?.date || "2000-01-01";
  const endDate = s.endDate || (toMin(s.end) < toMin(s.start) ? addDateDays(startDate, 1) : startDate);
  return [dateMin(startDate, s.start), dateMin(endDate, s.end)];
}
function addDateDays(date, days) { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function actSlotRange(s) { const off=Number(ctx?.tt?.offsetMinutes||0); const [a,b]=slotRange(s); return [a+off,b+off]; }
function formatOffsetTime(min){ const day=Math.floor(min/(24*60)); const within=((min%(24*60))+(24*60))%(24*60); return `${String(Math.floor(within/60)).padStart(2,"0")}:${String(within%60).padStart(2,"0")}`; }
function adjustedTime(s){const off=Number(ctx?.tt?.offsetMinutes||0);const [a,b]=slotRange(s);return {start:formatOffsetTime(a+off),end:formatOffsetTime(b+off),startDate:addDateDays(ctx?.ev?.date || s.startDate || "2000-01-01",Math.floor((a+off)/(24*60))),endDate:addDateDays(ctx?.ev?.date || s.startDate || "2000-01-01",Math.floor((b+off)/(24*60)))};}
function shortDate(date){const d=new Date(`${date}T00:00:00`);return `${d.getMonth()+1}/${d.getDate()}`;}
function scheduleRangeLabel(item, shifted=false){const x=shifted?adjustedTime(item):{start:item.start,end:item.end,startDate:item.startDate||ctx.ev.date,endDate:item.endDate||(toMin(item.end)<toMin(item.start)?addDateDays(item.startDate||ctx.ev.date,1):(item.startDate||ctx.ev.date))};const base=ctx.ev.date;const startLabel=x.startDate!==base?`${shortDate(x.startDate)} `:"";const endLabel=x.endDate!==x.startDate?`${shortDate(x.endDate)} `:"";return `${startLabel}${x.start}–${endLabel}${x.end}`;}
function isValidTimeRange(start, end, startDate, endDate) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end || "")) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) return false;
  return dateMin(endDate, end) > dateMin(startDate, start);
}
function recordMemberDisplay(item) {
  const ids = Array.isArray(item?.memberIds) ? item.memberIds : [];
  const savedNames = String(item?.name ?? "").split("、").map(name => name.trim()).filter(Boolean);
  if (!ids.length) return savedNames.join("、");
  const members = Array.isArray(db?.members) ? db.members : [];
  const names = ids.map((id, index) => {
    const member = members.find(m => m && m.id === id);
    return member ? memberDisplayName(member) : (savedNames[index] || "登録外メンバー");
  });
  const freeNames = savedNames.slice(ids.length);
  return [...names, ...freeNames].filter(Boolean).join("、");
}

function nowHtml(tt, ev) {
  const eventStart = new Date(ev.date + "T00:00:00").getTime();
  const t = (Date.now() - eventStart) / 60000;
  const current = (list, shifted=false) => list.filter(item => {
    const [start, end] = shifted ? actSlotRange(item) : slotRange(item);
    return t >= start && t < end;
  }).sort((x,y) => (shifted ? actSlotRange(x)[0] : slotRange(x)[0]) - (shifted ? actSlotRange(y)[0] : slotRange(y)[0]));
  const next = (list, shifted=false) => list.filter(item => (shifted ? actSlotRange(item) : slotRange(item))[0] > t)
    .sort((x,y) => (shifted ? actSlotRange(x)[0] : slotRange(x)[0]) - (shifted ? actSlotRange(y)[0] : slotRange(y)[0]))[0];
  const actNow = current(tt.acts || [], true);
  const actNext = next(tt.acts || [], true);
  const shiftNow = current(tt.shifts || []);
  const shiftNext = next(tt.shifts || []);
  const actName = item => `${item.type === "その他" ? (item.customType || "その他") : (item.type || "DJ")}：${recordMemberDisplay(item)}`;
  const shiftName = item => `${item.role || "シフト"}：${recordMemberDisplay(item)}`;
  const nowItems = [
    ...actNow.map(item => ({kind:"出演",name:actName(item),time:scheduleRangeLabel(item,true)})),
    ...shiftNow.map(item => ({kind:"シフト",name:shiftName(item),time:scheduleRangeLabel(item,false)}))
  ];
  const nextItems = [
    ...(actNext ? [{kind:"出演",name:actName(actNext),time:scheduleRangeLabel(actNext,true)}] : []),
    ...(shiftNext ? [{kind:"シフト",name:shiftName(shiftNext),time:scheduleRangeLabel(shiftNext,false)}] : [])
  ];
  const renderItems = (items, label) => items.length
    ? items.map(item => `<details class="admin-pulse-entry"><summary><strong>${esc(item.name)}</strong></summary><small>${item.kind} · ${esc(item.time)}</small></details>`).join("")
    : `<span class="admin-pulse-empty">${label === "NOW" ? "現在の出演・シフトなし" : "次の予定なし"}</span>`;
  const hasSchedule = (tt.acts||[]).length || (tt.shifts||[]).length;
  return `<div class="admin-header-pulse">
    <span class="admin-pulse-status"><i class="live-orb"></i>${t < 0 ? "開催前" : (t > 30*60 ? "開催終了" : "LIVE")}</span>
    ${hasSchedule ? `<span class="admin-pulse-group">${renderItems(nowItems,"NOW")}</span><span class="admin-pulse-divider"></span><span class="admin-pulse-group">${renderItems(nextItems,"NEXT")}</span>` : `<strong class="admin-pulse-coming">COMING SOON...</strong>`}
  </div>`;
}
function updateNow(options = {}) {
  if (!ctx || !ctx.ev) return;
  try {
    const tt = ensureTt(ctx.tt || ctx.ev.tt || createTt());
    ctx.tt = tt;
    const html = nowHtml(tt, ctx.ev);
    const el = document.getElementById("nowBox");
    if (el) el.innerHTML = html;
    const global = document.getElementById("globalNowBox");
    if (global) global.innerHTML = html;
    if (options.refreshTimeline !== false && currentRender === renderTimetable) renderEventTimeline();
    if (options.refreshTimeline !== false && currentRender === renderShifts) renderShiftTimeline();
  } catch (error) {
    // 定期更新の例外で、ヘッダーやページ遷移まで止めない
    console.error("NOW/NEXT更新エラー:", error);
  }
}
function renderEventTimeline(){
 const host=document.getElementById("eventTimeline");
 if(!host)return;
 const tt=ctx.tt;
 const all=(tt.acts||[]).map(a=>({...a,_kind:"act"}))
   .sort((a,b)=>actSlotRange(a)[0]-actSlotRange(b)[0] || actSlotRange(a)[1]-actSlotRange(b)[1]);

 if(!all.length){
   host.innerHTML='<p class="sub-text">出番を登録するとタイムラインが表示されます。</p>';
   return;
 }

 // 重なり合う時間帯ごとにグループ化し、各項目へ横並び用のレーンを割り当てる
 const components=[];
 let component=null;
 all.forEach(item=>{
   const [start,end]=actSlotRange(item);
   if(!component || start>=component.end){
     component={items:[],end};
     components.push(component);
   }else{
     component.end=Math.max(component.end,end);
   }
   component.items.push(item);
 });

 const laneById=new Map();
 components.forEach(group=>{
   const laneEnds=[];
   group.items.forEach(item=>{
     const [start,end]=actSlotRange(item);
     let lane=laneEnds.findIndex(lastEnd=>lastEnd<=start);
     if(lane<0)lane=laneEnds.length;
     laneEnds[lane]=end;
     laneById.set(item.id,{lane,count:0});
   });
   group.items.forEach(item=>{
     const slot=laneById.get(item.id);
     slot.count=laneEnds.length;
   });
 });

 const now=(Date.now()-new Date(ctx.ev.date+"T00:00:00").getTime())/60000;
 const starts=all.map(a=>actSlotRange(a)[0]);
 const ends=all.map(a=>actSlotRange(a)[1]);
 const scheduleMin=Math.min(...starts);
 const scheduleMax=Math.max(...ends);
 const min=now>=scheduleMin&&now<=scheduleMax?Math.min(scheduleMin,Math.floor(now/60)*60):scheduleMin;
 const max=Math.max(scheduleMax,min+60);
 const span=Math.max(60,max-min);

 // 短い出番でもカードが読める高さを確保し、同時刻のカードは同じ縦位置で横に並べる
 const pxPerMinute=Math.max(1.2,...all.map(a=>60/Math.max(1,actSlotRange(a)[1]-actSlotRange(a)[0])));
 const trackHeight=Math.max(380,Math.ceil(span*pxPerMinute));
 const marker=Math.max(0,Math.min(100,(now-min)/span*100));

 const cards=all.map(a=>{
   const [st,en]=actSlotRange(a);
   const top=(st-min)/span*100;
   const height=Math.max(3,(en-st)/span*100);
   const active=now>=st&&now<en;
   const x=adjustedTime(a);
   const lane=laneById.get(a.id)||{lane:0,count:1};
   const parallel=lane.count>1;
   const gap=8;
   const left=parallel?`calc(16px + ${lane.lane*100/lane.count}%)`:"16px";
   const width=parallel?`calc(${100/lane.count}% - ${16+gap}px)`:"auto";
   const style=`top:${top}%;height:${height}%;left:${left};${parallel?`width:${width};right:auto;`:"right:0;"}`;
   return `<div class="timeline-item ${active?"active":""} ${parallel?"parallel":""} ${lane.count>2?"parallel-crowded":""}" style="${style}" aria-label="${esc(x.start)}から${esc(x.end)} ${esc(a.type==="その他"?(a.customType||"その他"):(a.type||"DJ"))} ${esc(recordMemberDisplay(a))}"><span class="timeline-time">${esc(x.start)}–${esc(x.end)}</span><strong>${esc(a.type==="その他"?(a.customType||"その他"):(a.type||"DJ"))}：${esc(recordMemberDisplay(a))}</strong></div>`;
 }).join("");

 host.innerHTML=`<div class="timeline-axis"><span>${formatOffsetTime(min)}</span><span>${formatOffsetTime(max)}</span></div><div class="timeline-track" style="height:${trackHeight}px"><div class="timeline-now-line" style="top:${marker}%"><span>NOW</span></div>${cards}</div>`;
}

function renderTimetable() {
  if (!ctx) {
    pageHistory = [renderEventList];
    currentRender = renderEventList;
    renderEventList();
    renderReceptionTabs();
    updateBackButton();
    return;
  }
  const tt = ctx.tt = ensureTt(ctx.tt);
  const sorted = l => l.slice().sort((a, b) => slotRange(a)[0] - slotRange(b)[0]);
  screen.innerHTML = `
  <div class="card"><div class="card-title">進行時間の調整</div><div class="offset-controls"><button class="btn btn-secondary" data-offset="-5">−5分</button><button class="btn btn-secondary" data-offset="-1">−1分</button><strong id="offsetValue">${Number(tt.offsetMinutes||0)>=0?"+":""}${Number(tt.offsetMinutes||0)}分</strong><button class="btn btn-secondary" data-offset="1">＋1分</button><button class="btn btn-secondary" data-offset="5">＋5分</button><button class="btn btn-secondary" id="resetOffset">リセット</button></div><small class="sub-text">マイナスは巻き、プラスは押し。出番の表示時刻に反映されます。</small></div>
  <div class="card"><div class="card-title">タイムライン</div><div class="timeline" id="eventTimeline"></div></div>

  <div class="card">
    <div class="card-title">タイムテーブル（出番）</div>
    ${sorted(tt.acts).map(a => `<div class="tt-record" data-act-row="${esc(a.id)}"><div class="tt-record-main"><span class="tt-record-time">${esc(scheduleRangeLabel(a,true))}</span><strong>${esc(a.type === "その他" ? (a.customType || "その他") : (a.type || "DJ"))}：${esc(recordMemberDisplay(a))}</strong></div><div class="tt-record-actions"><button type="button" class="btn btn-secondary tt-edit-btn" data-ea="${esc(a.id)}">編集</button><button type="button" class="x" data-da="${esc(a.id)}" aria-label="削除">×</button></div></div>`).join("") || `<div class="sub-text">まだ登録がありません</div>`}
    <div class="tt-form-panel" id="actFormPanel"><div class="tt-form-heading" id="actFormHeading">出番を追加</div><div class="inline-form">
      <label class="date-time-field"><span>開始日</span><input type="date" id="aStartDate" value="${esc(ctx.ev.date)}"></label><label class="date-time-field"><span>開始時刻</span><input type="time" id="aStart" value="20:00"></label><label class="date-time-field"><span>終了日</span><input type="date" id="aEndDate" value="${esc(ctx.ev.date)}"></label><label class="date-time-field"><span>終了時刻</span><input type="time" id="aEnd" value="20:30"></label>
      <div class="full act-type-options" id="actTypeOptions">
        <label><input type="radio" name="actType" value="DJ" checked> DJ</label>
        <label><input type="radio" name="actType" value="VJ"> VJ</label>
        <label><input type="radio" name="actType" value="LIVE"> LIVE</label>
        <label><input type="radio" name="actType" value="その他"> その他</label>
      </div>
      <input class="full" id="aCustomType" placeholder="その他の種別を入力（例：ダンス）" hidden>
      <div class="full member-picker"><label for="aMemberPick">出演メンバー（参加予定者から追加）</label><div class="member-picker-controls"><select id="aMemberPick" class="member-picker-select"><option value="">メンバーを選択</option>${(db.members||[]).filter(m=>(ctx.ev.participants||[]).includes(m.id)).sort((a,b)=>memberDisplayName(a).localeCompare(memberDisplayName(b),"ja")).map(m=>`<option value="${esc(m.id)}">${esc(memberDisplayName(m))}${m.nickname?`（${esc(m.name)}）`:""}${m.grade?`・${esc(m.grade)}`:""}</option>`).join("")}</select><button type="button" class="btn btn-secondary member-add-btn" id="aMemberAdd">追加</button></div><div id="aMemberChips" class="member-chips" aria-live="polite"></div><input class="full" id="aName" placeholder="名簿外の出演者名・グループ名（自由入力）"></div>
      <button class="btn btn-primary full" id="aAdd">出番を追加</button><button class="btn btn-secondary full" id="aCancel" hidden>編集をキャンセル</button>
    </div></div>
    <p class="sub-text">開始日・開始時刻と終了日・終了時刻をそれぞれ指定してください。日付をまたぐ予定も、終了日を翌日に設定すれば登録できます。</p>
  </div>

  <div class="card shift-management-card ${currentRender === renderShifts ? "" : "hidden"}">
    <div class="card-title">シフト</div>
    ${sorted(tt.shifts).map(s => `<div class="tt-record" data-shift-row="${esc(s.id)}"><div class="tt-record-main"><span class="tt-record-time">${esc(scheduleRangeLabel(s))}</span><strong>${esc(s.role)}：${esc(s.name)}</strong></div><div class="tt-record-actions"><button type="button" class="btn btn-secondary tt-edit-btn" data-es="${esc(s.id)}">編集</button><button type="button" class="x" data-ds="${esc(s.id)}" aria-label="削除">×</button></div></div>`).join("") || `<div class="sub-text">まだ登録がありません</div>`}
    <div class="tt-form-panel" id="shiftFormPanel"><div class="tt-form-heading" id="shiftFormHeading">シフトを追加</div><div class="inline-form">
      <label class="date-time-field"><span>開始日</span><input type="date" id="sStartDate" value="${esc(ctx.ev.date)}"></label><label class="date-time-field"><span>開始時刻</span><input type="time" id="sStart" value="19:00"></label><label class="date-time-field"><span>終了日</span><input type="date" id="sEndDate" value="${esc(ctx.ev.date)}"></label><label class="date-time-field"><span>終了時刻</span><input type="time" id="sEnd" value="21:00"></label>
      <input id="sRole" list="roleList" placeholder="役割（受付・バーなど）"><div class="full member-picker"><label for="sMemberPick">担当メンバー（参加予定者から追加）</label><div class="member-picker-controls"><select id="sMemberPick" class="member-picker-select"><option value="">メンバーを選択</option>${(db.members||[]).filter(m=>(ctx.ev.participants||[]).includes(m.id)).sort((a,b)=>memberDisplayName(a).localeCompare(memberDisplayName(b),"ja")).map(m=>`<option value="${esc(m.id)}">${esc(memberDisplayName(m))}${m.nickname?`（${esc(m.name)}）`:""}${m.grade?`・${esc(m.grade)}`:""}</option>`).join("")}</select><button type="button" class="btn btn-secondary member-add-btn" id="sMemberAdd">追加</button></div><div id="sMemberChips" class="member-chips" aria-live="polite"></div><input id="sName" placeholder="名簿外の担当者名（自由入力）"></div>
      <datalist id="roleList"><option>受付</option><option>バーカウンター</option><option>音響</option><option>照明</option><option>物販</option></datalist>
      <button class="btn btn-primary full" id="sAdd">シフトを追加</button><button class="btn btn-secondary full" id="sCancel" hidden>編集をキャンセル</button>
    </div></div>
  </div>`;
  renderEventTimeline();
  screen.querySelectorAll("[data-offset]").forEach(btn=>btn.onclick=()=>{tt.offsetMinutes=Number(tt.offsetMinutes||0)+Number(btn.dataset.offset);saveTt();renderTimetable();});
  document.getElementById("resetOffset").onclick=()=>{tt.offsetMinutes=0;saveTt();renderTimetable();};
  const $ = id => document.getElementById(id);
  let editA = null, editS = null;
  let actSelected = [], shiftSelected = [];
  const memberName = id => memberDisplayName((db.members||[]).find(m=>m.id===id));
  const drawChips = (prefix, ids) => {
    const box=$(prefix+"MemberChips");
    box.innerHTML=ids.map(id=>`<span class="member-chip">${esc(memberName(id))}<button type="button" data-remove-member="${esc(id)}" data-picker="${prefix}" aria-label="${esc(memberName(id))}を解除">×</button></span>`).join("") || `<span class="member-picker-empty">まだ選択されていません</span>`;
    box.querySelectorAll("[data-remove-member]").forEach(btn=>btn.onclick=()=>{
      const arr=prefix==="a"?actSelected:shiftSelected;
      const at=arr.indexOf(btn.dataset.removeMember);if(at>=0)arr.splice(at,1);
      drawChips(prefix,arr);
    });
  };
  const addPickedMember = prefix => {
    const select=$(prefix+"MemberPick"), id=select.value;
    if(!id)return;
    const arr=prefix==="a"?actSelected:shiftSelected;
    if(!arr.includes(id))arr.push(id);
    select.value="";
    drawChips(prefix,arr);
  };
  $("aMemberAdd").onclick=()=>addPickedMember("a");
  $("sMemberAdd").onclick=()=>addPickedMember("s");
  drawChips("a",actSelected); drawChips("s",shiftSelected);
  screen.querySelectorAll('input[name="actType"]').forEach(r => r.addEventListener("change", () => { $("aCustomType").hidden = r.value !== "その他" || !r.checked; }));
  $("aAdd").onclick = () => {
    const type = screen.querySelector('input[name="actType"]:checked')?.value || "DJ";
    const customType = $("aCustomType").value.trim();
    const chosen=actSelected.map(id=>({id,name:memberName(id)})); const free=$("aName").value.trim(); const o = { startDate: $("aStartDate").value, start: $("aStart").value, endDate: $("aEndDate").value, end: $("aEnd").value, type, customType: type === "その他" ? customType : "", name:[chosen.map(x=>x.name).join("、"),free].filter(Boolean).join("、"), memberIds:chosen.map(x=>x.id) };
    if (!o.start || !o.end || !o.name || (type === "その他" && !customType)) { alert("開始・終了時刻、種別、出演者名を入力してください"); return; }
    if (!isValidTimeRange(o.start, o.end, o.startDate, o.endDate)) { alert("終了日時は開始日時より後に設定してください。"); return; }
    if (editA) Object.assign(tt.acts.find(x => x.id === editA), o); else tt.acts.push({ id: uid(), ...o });
    saveTt(); renderTimetable();
  };
  $("sAdd").onclick = () => {
    const chosen=shiftSelected.map(id=>({id,name:memberName(id)})); const free=$("sName").value.trim(); const o = { startDate: $("sStartDate").value, start: $("sStart").value, endDate: $("sEndDate").value, end: $("sEnd").value, role: $("sRole").value.trim(), name:[chosen.map(x=>x.name).join("、"),free].filter(Boolean).join("、"), memberIds:chosen.map(x=>x.id) };
    if (!o.start || !o.end || !o.role || !o.name) { alert("開始・終了時刻、役割、担当者名を入力してください"); return; }
    if (!isValidTimeRange(o.start, o.end, o.startDate, o.endDate)) { alert("終了日時は開始日時より後に設定してください。"); return; }
    if (editS) Object.assign(tt.shifts.find(x => x.id === editS), o); else tt.shifts.push({ id: uid(), ...o });
    saveTt(); currentRender === renderShifts ? renderShifts() : renderTimetable();
  };
  screen.querySelectorAll("[data-ea]").forEach(el => el.onclick = () => {
    const a = tt.acts.find(x => x.id === el.dataset.ea); if (!a) return;
    editA = a.id; $("aStartDate").value = a.startDate || ctx.ev.date; $("aStart").value = a.start; $("aEndDate").value = a.endDate || (toMin(a.end) < toMin(a.start) ? addDateDays(a.startDate || ctx.ev.date,1) : (a.startDate || ctx.ev.date)); $("aEnd").value = a.end; $("aName").value = a.memberIds?.length ? a.name.split("、").slice(a.memberIds.length).join("、") : a.name; actSelected=(a.memberIds||[]).slice(); drawChips("a",actSelected); const actType = a.type || "DJ"; screen.querySelectorAll('input[name="actType"]').forEach(r => r.checked = r.value === actType); $("aCustomType").hidden = actType !== "その他"; $("aCustomType").value = a.customType || ""; $("aAdd").textContent = "変更を保存"; $("aCancel").hidden = false; $("actFormHeading").textContent = "出番を編集中"; $("actFormPanel").classList.add("is-editing"); screen.querySelectorAll("[data-act-row]").forEach(row => row.classList.toggle("is-selected", row.dataset.actRow === a.id)); $("actFormPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
  });
  screen.querySelectorAll("[data-es]").forEach(el => el.onclick = () => {
    const s = tt.shifts.find(x => x.id === el.dataset.es); if (!s) return;
    editS = s.id; $("sStartDate").value = s.startDate || ctx.ev.date; $("sStart").value = s.start; $("sEndDate").value = s.endDate || (toMin(s.end) < toMin(s.start) ? addDateDays(s.startDate || ctx.ev.date,1) : (s.startDate || ctx.ev.date)); $("sEnd").value = s.end; $("sRole").value = s.role; $("sName").value = s.memberIds?.length ? s.name.split("、").slice(s.memberIds.length).join("、") : s.name; shiftSelected=(s.memberIds||[]).slice(); drawChips("s",shiftSelected); $("sAdd").textContent = "変更を保存"; $("sCancel").hidden = false; $("shiftFormHeading").textContent = "シフトを編集中"; $("shiftFormPanel").classList.add("is-editing"); screen.querySelectorAll("[data-shift-row]").forEach(row => row.classList.toggle("is-selected", row.dataset.shiftRow === s.id)); $("shiftFormPanel").scrollIntoView({behavior:"smooth",block:"nearest"});
  });
  $("aCancel").onclick = () => { editA = null; $("aStartDate").value = ctx.ev.date; $("aEndDate").value = ctx.ev.date; $("aStart").value = "20:00"; $("aEnd").value = "20:30"; $("aName").value = ""; actSelected=[]; drawChips("a",actSelected); screen.querySelector('input[name="actType"][value="DJ"]').checked = true; $("aCustomType").value = ""; $("aCustomType").hidden = true; $("aAdd").textContent = "出番を追加"; $("aCancel").hidden = true; $("actFormHeading").textContent = "出番を追加"; $("actFormPanel").classList.remove("is-editing"); screen.querySelectorAll("[data-act-row]").forEach(row => row.classList.remove("is-selected")); };
  $("sCancel").onclick = () => { editS = null; $("sStartDate").value = ctx.ev.date; $("sEndDate").value = ctx.ev.date; $("sStart").value = "19:00"; $("sEnd").value = "21:00"; $("sRole").value = ""; $("sName").value = ""; shiftSelected=[]; drawChips("s",shiftSelected); $("sAdd").textContent = "シフトを追加"; $("sCancel").hidden = true; $("shiftFormHeading").textContent = "シフトを追加"; $("shiftFormPanel").classList.remove("is-editing"); screen.querySelectorAll("[data-shift-row]").forEach(row => row.classList.remove("is-selected")); };
  screen.querySelectorAll("[data-da]").forEach(btn => btn.onclick = () => {
    if (!confirm("この出番を削除しますか？")) return;
    tt.acts = tt.acts.filter(x => x.id !== btn.dataset.da); saveTt(); renderTimetable();
  });
  screen.querySelectorAll("[data-ds]").forEach(btn => btn.onclick = () => {
    if (!confirm("このシフトを削除しますか？")) return;
    tt.shifts = tt.shifts.filter(x => x.id !== btn.dataset.ds); saveTt(); currentRender === renderShifts ? renderShifts() : renderTimetable();
  });
}

/* ---------- シフト専用ページ ---------- */
function renderShifts() {
  if (!ctx) return;
  // 既存のシフト入力・編集処理をそのまま再利用し、出番関連だけを画面から分離する
  renderTimetable();
  const cards = [...screen.querySelectorAll(".card")];
  let shiftCard = cards.find(card => card.querySelector(".card-title")?.textContent.trim() === "シフト");
  let timelineCard = cards.find(card => card.querySelector(".card-title")?.textContent.trim() === "タイムライン");
  cards.forEach(card => { if (card !== shiftCard && card !== timelineCard) card.remove(); });
  if (!shiftCard) return;
  shiftCard.classList.remove("hidden");
  if (!timelineCard) {
    timelineCard = document.createElement("section");
    timelineCard.className = "card";
    timelineCard.innerHTML = '<div class="card-title">シフトタイムライン</div><div class="timeline" id="shiftTimeline"></div>';
    shiftCard.before(timelineCard);
  } else {
    timelineCard.querySelector(".card-title").textContent = "シフトタイムライン";
    const host = timelineCard.querySelector(".timeline");
    if (host) host.id = "shiftTimeline";
  }
  renderShiftTimeline();
  // 既存renderTimetableの最後に実行される再描画処理も、表示中ページに合わせる
}
function renderShiftTimeline() {
  const host = document.getElementById("shiftTimeline");
  if (!host || !ctx) return;
  const shifts = (ctx.tt?.shifts || []).slice().sort((a,b) => slotRange(a)[0]-slotRange(b)[0]);
  if (!shifts.length) {
    host.innerHTML = '<p class="sub-text">シフトを登録するとタイムラインが表示されます。</p>';
    return;
  }
  const min = Math.min(...shifts.map(x => slotRange(x)[0]));
  const max = Math.max(...shifts.map(x => slotRange(x)[1]));
  const span = Math.max(60, max-min);
  const pxPerMinute = Math.max(1.2, ...shifts.map(x => 60/Math.max(1,slotRange(x)[1]-slotRange(x)[0])));
  const height = Math.max(380, Math.ceil(span*pxPerMinute));
  const now = (Date.now()-new Date(ctx.ev.date+"T00:00:00").getTime())/60000;
  const marker = Math.max(0,Math.min(100,(now-min)/span*100));
  const groups=[];
  shifts.forEach(item=>{
    const [start,end]=slotRange(item);
    let group=groups.find(g=>start<g.end && end>g.start);
    if(!group){group={start,end,items:[]};groups.push(group);}
    group.start=Math.min(group.start,start);group.end=Math.max(group.end,end);group.items.push(item);
  });
  const lanes=new Map();
  groups.forEach(group=>{
    const ends=[];
    group.items.forEach(item=>{
      const [a,b]=slotRange(item);
      let lane=ends.findIndex(v=>v<=a);if(lane<0)lane=ends.length;
      ends[lane]=b;lanes.set(item.id,{lane,count:0});
    });
    group.items.forEach(item=>lanes.get(item.id).count=ends.length);
  });
  const items=shifts.map(item=>{
    const [a,b]=slotRange(item), lane=lanes.get(item.id)||{lane:0,count:1};
    const left=lane.count>1?`calc(${lane.lane*100/lane.count}% + 8px)`:"8px";
    const width=lane.count>1?`calc(${100/lane.count}% - 16px)`:"auto";
    const active=now>=a&&now<b;
    return `<div class="timeline-item shift-timeline-item ${active?"active":""}" style="top:${(a-min)/span*100}%;height:${Math.max(3,(b-a)/span*100)}%;left:${left};${lane.count>1?`width:${width};right:auto;`:"right:8px;"}">
      <span class="timeline-time">${esc(scheduleRangeLabel(item))}</span>
      <strong>${esc(item.role||"シフト")}：${esc(recordMemberDisplay(item))}</strong>
    </div>`;
  }).join("");
  host.innerHTML=`<div class="timeline-axis"><span>${formatOffsetTime(min)}</span><span>${formatOffsetTime(max)}</span></div><div class="timeline-track shift-timeline-track" style="height:${height}px"><div class="timeline-now-line" style="top:${marker}%"><span>NOW</span></div>${items}</div>`;
}

/* ---------- 起動 ---------- */
function initApp() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  navigate(renderEventList);
  setSync("接続中…");
  syncPull();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncPull(); });
  setInterval(() => { if (!document.hidden) syncPull(); }, 10000);
  setInterval(updateNow, 20000);   // 「いまの出番」を自動更新
}
initApp();
