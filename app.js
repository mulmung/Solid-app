/* 솔리드 피지컬 트레이닝 — 센터 관리 앱
 * 데이터: Supabase (보안은 데이터베이스 RLS 규칙이 담당)
 * 화면: 스케줄 / 출석부(선수별 장부) / 트레이너 관리(관리자)
 */
"use strict";

const sb = window.supabase.createClient(window.SOLID_CONFIG.SUPABASE_URL, window.SOLID_CONFIG.SUPABASE_KEY);

/* ---------- 상수·도구 ---------- */
const DUR = { personal: 80, group: 80, team: 90 };
const LABEL = { personal: "개인", group: "그룹", team: "단체" };
const PLAN = { pass: "회차권", monthly: "월 정산", visit: "매회 결제" };
const ST = { present: "출석", same: "당일취소", prior: "사전취소" };
const VATM = ["카드", "계좌이체"]; // 부가세 10% 붙는 결제 수단
const days = ["일", "월", "화", "수", "목", "금", "토"];
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const endOf = l => toTime(toMin(l.start) + DUR[l.type]);
const won = n => Number(n || 0).toLocaleString("ko-KR") + "원";
const md = s => { const d = parse(s); return `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
const dow = s => days[parse(s).getDay()];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const $ = id => document.getElementById(id);
const vatOf = (price, method) => VATM.includes(method) ? Math.round(price * 0.1) : 0;
const todayIso = () => iso(new Date());
const thisMonth = () => todayIso().slice(0, 7);

/* 초성 검색 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const cho = s => [...s].map(c => { const k = c.charCodeAt(0) - 0xAC00; return k >= 0 && k < 11172 ? CHO[Math.floor(k / 588)] : c; }).join("");
const match = (a, q) => { q = q.replace(/\s/g, ""); if (!q) return true; return (a.name + a.team).includes(q) || cho(a.name).includes(q); };

/* 나이: 입력은 한국 나이, 저장은 출생연도 */
const THIS_YEAR = () => new Date().getFullYear();
const ageOf = by => THIS_YEAR() - by + 1;
const byOf = age => THIS_YEAR() - age + 1;
const yy = by => String(by).slice(2);
const ageText = a => a.by ? `${yy(a.by)}년생 · ${ageOf(a.by)}살` : "";

/* ---------- 상태 ---------- */
let me = null;                 // 내 트레이너 정보
let branches = [];             // 볼 수 있는 지점
let curBranch = null;          // 지금 보고 있는 지점
let athleteBr = {};            // athleteId → Set(branchId)
let trainerBr = {};            // trainerId → Set(branchId)
let trainers = [], athletes = [], payments = [];
let stats = {};                // athleteId → { charged, byMonth:{m:n}, unchecked, unpaid }
let recent = {};               // `${athleteId}-${trainerId}` → 최근 수업일
let dayCache = {};             // 날짜 → 수업 목록
let ledgerLessons = null;      // 열린 선수의 전체 수업
let cur = parse(todayIso());
let tab = "sched", view = "trainer", ledgerId = null;

const T = id => trainers.find(t => t.id === id);
const B = id => branches.find(b => b.id === id);
const BN = id => (B(id) || {}).name || "다른 지점";
const inBranch = (map, id, b) => !!(map[id] && map[id].has(b));
const athletesHere = () => athletes.filter(a => inBranch(athleteBr, a.id, curBranch));
function setBranch(id) { curBranch = id; try { localStorage.setItem("solid.branch", String(id)); } catch (e) {} }
const TN = id => { const t = T(id); return t ? `${t.name} 트레이너` : "트레이너 미지정"; };
const A = id => athletes.find(a => a.id === id);
const isAdmin = () => me && me.role === "admin";
const canEdit = l => isAdmin() || (me && l.trainer === me.id);

/* ---------- 알림 ---------- */
let toastTimer;
function toast(msg, isErr) {
  const t = $("toast"); t.textContent = msg; t.className = "toast" + (isErr ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, isErr || msg.length > 40 ? 7000 : 2200);
}
function friendly(err) {
  const m = (err && err.message) || String(err);
  if (/row-level security|permission denied/i.test(m)) return "권한이 없어요. 본인 수업만 수정할 수 있어요.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "인터넷 연결을 확인해주세요.";
  return "저장하지 못했어요: " + m;
}

/* ---------- 데이터 불러오기 ---------- */
async function fetchAll(table, select, build) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    let q = sb.from(table).select(select).range(from, from + size - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data);
    if (data.length < size) return out;
  }
}
const mapTrainer = r => ({ id: r.id, name: r.name, email: r.email, role: r.role, active: r.active, linked: !!r.user_id });
const mapAthlete = r => ({ id: r.id, name: r.name, team: r.team, plan: r.plan, price: r.price, by: r.birth_year });
const mapPay = r => ({ id: r.id, branch: r.branch_id, aid: r.athlete_id, kind: r.kind, date: r.date, count: r.count, price: r.price, vat: r.vat, method: r.method, memo: r.memo, month: r.month, lessonId: r.lesson_id });
function mapLesson(r, rows) {
  const att = {}, ids = [];
  (rows || []).forEach(x => { ids.push(x.athlete_id); if (x.status) att[x.athlete_id] = { s: x.status, deduct: x.deduct, memo: x.memo }; });
  return { id: r.id, type: r.type, trainer: r.trainer_id, branch: r.branch_id, date: r.date, start: r.start_time.slice(0, 5), team: r.team, grade: r.grade, ids, att };
}

async function loadBase() {
  const [br, tbr, abr, tr, at, pa, st, rc] = await Promise.all([
    fetchAll("branches", "id,name,active", q => q.order("id")),
    fetchAll("trainer_branches", "trainer_id,branch_id"),
    fetchAll("athlete_branches", "athlete_id,branch_id"),
    fetchAll("trainers", "id,name,email,role,active,user_id", q => q.order("id")),
    fetchAll("athletes", "id,name,team,plan,price,birth_year", q => q.order("id")),
    fetchAll("payments", "*", q => q.order("id")),
    fetchAll("athlete_month_stats", "*"),
    fetchAll("athlete_trainer_recent", "*"),
  ]);
  branches = br;
  trainerBr = {}; tbr.forEach(r => (trainerBr[r.trainer_id] ||= new Set()).add(r.branch_id));
  athleteBr = {}; abr.forEach(r => (athleteBr[r.athlete_id] ||= new Set()).add(r.branch_id));
  trainers = tr.map(mapTrainer);
  athletes = at.map(mapAthlete);
  payments = pa.map(mapPay);
  stats = {};
  st.forEach(r => {
    const s = stats[r.athlete_id] || (stats[r.athlete_id] = { charged: 0, byMonth: {}, unchecked: 0, unpaid: 0 });
    s.charged += Number(r.charged); s.byMonth[r.month] = Number(r.charged); s.unchecked += Number(r.unchecked); s.unpaid += Number(r.unpaid_visit);
  });
  recent = {}; rc.forEach(r => recent[`${r.athlete_id}-${r.trainer_id}`] = r.last_date);
  // 보고 있던 지점 유지, 없으면 내 첫 지점
  const mine = branches.filter(b => b.active && (isAdmin() || inBranch(trainerBr, me.id, b.id)));
  let saved = null; try { saved = Number(localStorage.getItem("solid.branch")); } catch (e) {}
  if (!mine.some(b => b.id === curBranch)) setBranch((mine.find(b => b.id === saved) || mine[0] || {}).id ?? null);
  drawBranchSel();
}
function myBranches() { return branches.filter(b => b.active && (isAdmin() || inBranch(trainerBr, me.id, b.id))); }
function drawBranchSel() {
  const sel = $("branchSel"), list = myBranches();
  sel.innerHTML = list.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  if (curBranch) sel.value = curBranch;
  sel.hidden = !list.length;
}

async function loadDay(d) {
  const { data, error } = await sb.from("lessons")
    .select("id,type,trainer_id,branch_id,date,start_time,team,grade,lesson_athletes(athlete_id,status,deduct,memo)")
    .eq("date", d).eq("branch_id", curBranch).order("start_time");
  if (error) throw error;
  dayCache[`${curBranch}|${d}`] = data.map(r => mapLesson(r, r.lesson_athletes));
}

async function loadLedger(aid) {
  const rows = await fetchAll("lesson_athletes",
    "athlete_id,status,deduct,memo,lesson:lessons(id,type,trainer_id,branch_id,date,start_time,team,grade)",
    q => q.eq("athlete_id", aid));
  ledgerLessons = rows.filter(r => r.lesson).map(r => mapLesson(r.lesson, [r]));
}

/* 저장 후 화면 갱신 */
async function refresh() {
  dayCache = {};
  try {
    await loadBase();
    if (tab === "roll" && ledgerId) await loadLedger(ledgerId);
  } catch (e) { toast(friendly(e), true); }
  render();
}

/* ---------- 계산 ---------- */
const charged = x => !!x && (x.s === "present" || (x.s === "same" && x.deduct));
const sortL = (a, b) => a.date.localeCompare(b.date) || toMin(a.start) - toMin(b.start);
const paysOf = a => payments.filter(p => p.aid === a.id).sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id);

/* 목록 화면용: 집계 뷰 + 결제 기록으로 상태 계산 */
function status(a) {
  const s = stats[a.id] || { charged: 0, byMonth: {}, unchecked: 0, unpaid: 0 };
  if (a.plan === "pass") {
    const total = paysOf(a).filter(p => p.kind === "pass" || p.kind === "trial").reduce((n, p) => n + p.count, 0);
    const left = total - s.charged;
    return { left, total, chip: left < 0 ? ["bad", `${-left}회 초과`] : left === 0 ? ["bad", "재등록 필요"] : left === 1 ? ["warn", "남은 1회"] : ["ok", `남은 ${left}회`] };
  }
  if (a.plan === "monthly") {
    const paid = new Set(paysOf(a).filter(p => p.kind === "month").map(p => p.month));
    const ym = thisMonth();
    const open = Object.keys(s.byMonth).filter(m => m < ym && s.byMonth[m] > 0 && !paid.has(m)).sort();
    const n = s.byMonth[ym] || 0;
    return { open, n, chip: open.length ? ["bad", `미정산 ${open.length}개월`] : ["plain", `이번 달 ${n}회`] };
  }
  return { unpaid: s.unpaid, chip: s.unpaid ? ["bad", `미결제 ${s.unpaid}건`] : ["ok", "결제 완료"] };
}

/* 장부 화면용: 차감된 수업마다 회차 번호 */
function rounds(a, ls) {
  const ch = ls.filter(l => charged(l.att[a.id]));
  const map = {};
  if (a.plan === "pass") {
    const units = paysOf(a).filter(p => p.kind === "pass" || p.kind === "trial");
    let u = 0, n = 0;
    ch.forEach(l => {
      while (u < units.length && n >= units[u].count) { u++; n = 0; }
      if (u < units.length) { n++; map[l.id] = units[u].kind === "trial" ? "체험" : `${n}/${units[u].count}회차`; }
      else map[l.id] = "초과";
    });
  } else if (a.plan === "monthly") {
    const per = {}; ch.forEach(l => { const m = l.date.slice(0, 7); per[m] = (per[m] || 0) + 1; map[l.id] = `${Number(m.slice(5))}월 ${per[m]}회차`; });
  } else ch.forEach((l, i) => map[l.id] = `${i + 1}회차`);
  return map;
}

/* ---------- 스케줄 ---------- */
function conflicts(list) {
  const bad = new Set();
  for (const a of list) for (const b of list) {
    if (a.id >= b.id || a.trainer !== b.trainer) continue;
    const a1 = toMin(a.start), a2 = a1 + DUR[a.type], b1 = toMin(b.start), b2 = b1 + DUR[b.type];
    if (a1 < b2 && b1 < a2) { bad.add(a.id); bad.add(b.id); }
  }
  return bad;
}
function card(l, bad, showTrainer) {
  const el = document.createElement("div"); el.className = `lesson ${l.type}`;
  el.innerHTML = `<div class="time">${l.start}<small>~ ${endOf(l)}</small></div>
  <div class="body"><div class="row1"><span class="chip ${l.type}">${LABEL[l.type]}</span>${showTrainer ? `<span class="meta">${esc(TN(l.trainer))}</span>` : ""}${canEdit(l) ? `<button class="edit">수정</button>` : ""}</div>
  ${l.type === "team" ? `<div class="whoT">${esc(l.team)} · ${esc(l.grade)}</div><div class="meta">90분</div>` : `<div class="names"></div>`}
  ${bad.has(l.id) ? `<div class="conflict">시간이 겹치는 수업이 있어요</div>` : ""}</div>`;
  const eb = el.querySelector(".edit"); if (eb) eb.onclick = () => openLesson(l);
  if (l.type !== "team") {
    const box = el.querySelector(".names");
    l.ids.forEach(id => {
      const a = A(id); if (!a) return; const x = l.att[id]; const s = document.createElement("span");
      s.className = "nm " + (x ? x.s : ""); s.textContent = a.name + (x && x.s !== "present" ? ` · ${ST[x.s]}` : ""); box.appendChild(s);
    });
  }
  return el;
}
async function renderSched() {
  const d = iso(cur);
  $("dateMain").textContent = `${cur.getMonth() + 1}월 ${cur.getDate()}일 (${days[cur.getDay()]})`;
  $("dateSub").textContent = d === todayIso() ? "오늘" : `${cur.getFullYear()}년`; $("datePick").value = d;
  $("vTrainer").setAttribute("aria-pressed", view === "trainer"); $("vTime").setAttribute("aria-pressed", view === "time");
  const list = $("list");
  if (!curBranch) { $("summary").innerHTML = ""; list.innerHTML = `<div class="empty">배정된 지점이 없어요.<br>관리자에게 지점 배정을 요청하세요.</div>`; return; }
  const key = `${curBranch}|${d}`;
  if (!dayCache[key]) {
    $("summary").innerHTML = ""; list.innerHTML = `<div class="loading">불러오는 중…</div>`;
    try { await loadDay(d); } catch (e) { list.innerHTML = `<div class="empty">${esc(friendly(e))}</div>`; return; }
    if (tab !== "sched" || iso(cur) !== d || `${curBranch}|${d}` !== key) return; // 그사이 화면이 바뀜
  }
  const day = dayCache[key].slice().sort((a, b) => toMin(a.start) - toMin(b.start) || a.trainer - b.trainer);
  const bad = conflicts(day); const cnt = t => day.filter(l => l.type === t).length;
  $("summary").innerHTML = `<span>총 ${day.length}개 수업</span>` + ["personal", "group", "team"].map(t => `<span class="chip ${t}">${LABEL[t]} ${cnt(t)}</span>`).join("");
  list.innerHTML = "";
  if (!day.length) { list.innerHTML = `<div class="empty">이 날은 등록된 수업이 없어요.<br>아래 <b>+ 수업 추가</b>로 등록해보세요.</div>`; return; }
  if (view === "trainer") {
    const order = [...trainers].sort((x, y) => (me && x.id === me.id ? -1 : 0) - (me && y.id === me.id ? -1 : 0));
    for (const t of order) {
      const mine = day.filter(l => l.trainer === t.id); if (!mine.length) continue;
      const s = document.createElement("section"); s.className = "section";
      s.innerHTML = `<h2>${esc(t.name)} 트레이너${t.active ? "" : " (퇴사)"}<span class="count">${mine.length}개</span></h2>`;
      mine.forEach(l => s.appendChild(card(l, bad, false))); list.appendChild(s);
    }
  } else {
    const s = document.createElement("section"); s.className = "section"; day.forEach(l => s.appendChild(card(l, bad, true))); list.appendChild(s);
  }
}

/* ---------- 출석부: 선수 목록 ---------- */
function renderList() {
  const q = $("aSearch").value.trim();
  const here = athletesHere();
  const list = here.filter(a => match(a, q)).sort((x, y) => x.name.localeCompare(y.name, "ko"));
  const need = here.filter(a => ["bad", "warn"].includes(status(a).chip[0])).length;
  const unc = here.reduce((s, a) => s + ((stats[a.id] || {}).unchecked || 0), 0);
  $("summary").innerHTML = `<span>${esc(BN(curBranch))} 선수 ${here.length}명</span>${need ? `<span class="chip bad">결제 확인 ${need}명</span>` : ""}${unc ? `<span class="chip warn">출석 미체크 ${unc}건</span>` : ""}`;
  const box = $("list"); box.innerHTML = "";
  if (!curBranch) { box.innerHTML = `<div class="empty">배정된 지점이 없어요.<br>관리자에게 지점 배정을 요청하세요.</div>`; return; }
  if (!here.length) { box.innerHTML = `<div class="empty">아직 등록된 선수가 없어요.<br>아래 <b>+ 선수 등록</b>으로 시작하세요.</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty">'${esc(q)}'에 맞는 선수가 없어요.</div>`; return; }
  const wrap = document.createElement("div"); wrap.className = "plist";
  list.forEach(a => {
    const s = status(a); const u = (stats[a.id] || {}).unchecked || 0; const b = document.createElement("button"); b.className = "prow";
    b.innerHTML = `<span class="n">${esc(a.name)}</span><span class="s">${esc(a.team)}${a.by ? " · " + ageText(a) : ""} · ${PLAN[a.plan]}${athleteBr[a.id] && athleteBr[a.id].size > 1 ? " · 여러 지점" : ""}</span>
    <span class="st"><span class="chip ${s.chip[0]}">${s.chip[1]}</span>${u ? `<span class="chip warn">미체크 ${u}</span>` : ""}</span>`;
    b.onclick = () => openLedger(a.id); wrap.appendChild(b);
  });
  box.appendChild(wrap);
}
async function openLedger(id) {
  if (layer() !== "ledger") history.pushState({ layer: "ledger" }, "");
  ledgerId = id; ledgerLessons = null; render(); window.scrollTo(0, 0);
  try { await loadLedger(id); } catch (e) { toast(friendly(e), true); }
  if (ledgerId === id) render();
}

/* ---------- 출석부: 선수별 장부 ---------- */
function payLabel(p) {
  if (p.kind === "trial") return "체험수업 결제";
  if (p.kind === "pass") return `${p.count}회권 결제`;
  if (p.kind === "month") return `${Number(p.month.slice(5))}월분 정산 (${p.count}회)`;
  const l = (ledgerLessons || []).find(x => x.id === p.lessonId); return `1회 결제${l ? ` · ${md(l.date)} 수업` : ""}`;
}
function renderLedger() {
  const a = A(ledgerId); if (!a) { ledgerId = null; return render(); }
  $("lgName").textContent = a.name;
  $("lgSub").textContent = `${[...(athleteBr[a.id] || [])].map(BN).join("·")} · ${a.team}${a.by ? " · " + ageText(a) : ""} · ${PLAN[a.plan]} · 단가 ${won(a.price)}`;
  $("summary").innerHTML = "";
  const box = $("list");
  if (!ledgerLessons) { box.innerHTML = `<div class="loading">불러오는 중…</div>`; return; }
  const s = status(a); const ls = ledgerLessons.slice().sort(sortL); const map = rounds(a, ls); const today = todayIso();
  let top = "";
  if (a.plan === "pass") top = `<div><div class="hint">남은 회차</div><div class="big num" style="color:var(--${s.left <= 0 ? "danger" : s.left === 1 ? "warn" : "ok"})">${s.left}<span style="font-size:15px;color:var(--muted)"> / ${s.total}</span></div></div>`;
  if (a.plan === "monthly") top = `<div><div class="hint">이번 달 진행</div><div class="big num">${s.n}회 <span style="font-size:15px;color:var(--muted)">· ${won(s.n * a.price)}</span></div>${s.open.length ? `<div class="hint" style="color:var(--danger)">미정산: ${s.open.map(m => Number(m.slice(5)) + "월").join(", ")}</div>` : ""}</div>`;
  if (a.plan === "visit") top = `<div><div class="hint">미결제</div><div class="big num" style="color:var(--${s.unpaid ? "danger" : "ok"})">${s.unpaid}건</div></div>`;
  box.innerHTML = `<div class="sumbox"><div class="sumrow">${top}<span class="chip ${s.chip[0]}">${s.chip[1]}</span></div>
    <div class="sumbtns"><button id="editAth">선수 정보</button><button class="primary" id="addPay">+ 결제 기록</button></div></div>`;
  $("editAth").onclick = () => openAthForm(a); $("addPay").onclick = () => openPay(a);

  const rows = [...ls.map(l => ({ t: "l", date: l.date, k: toMin(l.start), l })), ...paysOf(a).map(p => ({ t: "p", date: p.date, k: -1, p }))]
    .sort((x, y) => x.date.localeCompare(y.date) || x.k - y.k);
  const lg = document.createElement("div"); lg.className = "ledger";
  lg.innerHTML = `<div class="lh"><span>날짜</span><span>내용</span><span>회차</span></div>`;
  if (!rows.length) lg.innerHTML += `<div class="monthbar" style="text-align:center;padding:20px">아직 기록이 없어요</div>`;
  let lastM = "";
  rows.forEach(r => {
    const m = r.date.slice(0, 7);
    if (m !== lastM) { lastM = m; const mb = document.createElement("div"); mb.className = "monthbar"; mb.textContent = `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`; lg.appendChild(mb); }
    const b = document.createElement("button"); b.type = "button";
    if (r.t === "p") {
      const p = r.p; b.className = "lr pay";
      b.innerHTML = `<span class="d">${md(p.date)}<small>${dow(p.date)}</small></span><span class="c"><b>${payLabel(p)}</b><span>${p.method} · ${won(p.price + p.vat)}${p.vat ? " (부가세 포함)" : ""}${p.memo ? " · " + esc(p.memo) : ""}</span></span><span class="rn">결제</span>`;
      b.onclick = () => openPay(a, p);
    } else {
      const l = r.l, x = l.att[a.id], future = l.date > today;
      const label = x ? ST[x.s] + (x.s === "same" ? (x.deduct ? " (차감)" : " (미차감)") : "") : future ? "예정" : "미체크";
      b.className = "lr" + (future ? " future" : "") + (x && !charged(x) ? " muted" : "");
      const rn = map[l.id] || "";
      b.innerHTML = `<span class="d">${md(l.date)}<small>${dow(l.date)}</small></span>
        <span class="c"><b style="${!x && !future ? "color:var(--warn)" : x && x.s === "same" ? "color:var(--danger)" : ""}">${label}</b><span>${l.branch !== curBranch ? `<b style="color:var(--accent);font-weight:600">${esc(BN(l.branch))}</b> · ` : ""}${l.start} · ${LABEL[l.type]} · ${esc(TN(l.trainer))}${x && x.memo ? " · " + esc(x.memo) : ""}</span></span>
        <span class="rn" style="${rn === "초과" ? "color:var(--danger)" : ""}">${rn}</span>`;
      if (!future) b.onclick = () => canEdit(l) ? openAtt(a, l) : toast(`${TN(l.trainer)}의 수업이라 출석은 담당 트레이너가 기록해요.`);
    }
    lg.appendChild(b);
  });
  box.appendChild(lg);
  box.insertAdjacentHTML("beforeend", `<p class="hint" style="margin:0">수업 줄을 누르면 출석·취소를 기록하고, 결제 줄을 누르면 수정할 수 있어요.</p>`);
}

/* ---------- 화면 전환 ---------- */
function render() {
  $("tabS").setAttribute("aria-pressed", tab === "sched"); $("tabR").setAttribute("aria-pressed", tab === "roll");
  $("hSched").hidden = tab !== "sched"; $("hList").hidden = !(tab === "roll" && !ledgerId); $("hLedger").hidden = !(tab === "roll" && ledgerId);
  $("fab").hidden = tab === "roll" && !!ledgerId; $("fab").textContent = tab === "sched" ? "+ 수업 추가" : "+ 선수 등록";
  $("mgrBtn").hidden = !isAdmin(); $("expBtn").hidden = !isAdmin();
  if (tab === "sched") renderSched(); else if (ledgerId) renderLedger(); else renderList();
}

/* ---------- 시트 공통 ---------- */
let openSheetEl = null;
/* 휴대폰 뒤로가기: 창을 열거나 선수 장부로 들어갈 때 기록을 하나 쌓고, 뒤로가기를 누르면 그 기록을 되돌림 */
let ignorePop = false;
const layer = () => history.state && history.state.layer;
function hideSheet() { if (openSheetEl) openSheetEl.hidden = true; openSheetEl = null; $("scrim").hidden = true; }
function show(el) {
  const wasOpen = !!openSheetEl;
  if (openSheetEl) openSheetEl.hidden = true; openSheetEl = el; $("scrim").hidden = false; el.hidden = false;
  if (!wasOpen) history.pushState({ layer: "sheet" }, "");
}
// next: 창을 닫으면서 다른 화면(예: 새 선수 장부)으로 바로 넘어갈 때
function close(next) {
  if (!openSheetEl) return;
  hideSheet();
  if (layer() === "sheet") {
    if (next) history.replaceState({ layer: next }, "");
    else { ignorePop = true; history.back(); }
  }
}
function leaveLedger() { if (layer() === "ledger") history.back(); else { ledgerId = null; render(); } }
window.addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; return; }
  if (openSheetEl) { hideSheet(); return; }
  if (ledgerId && layer() !== "ledger") { ledgerId = null; render(); }
});
$("scrim").onclick = () => close(); document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => close());
function confirmBtn(btn, label, fn) {
  if (btn.dataset.c !== "1") { btn.dataset.c = "1"; const o = btn.textContent; btn.textContent = label; setTimeout(() => { btn.dataset.c = ""; btn.textContent = o; }, 3000); return; }
  btn.dataset.c = ""; fn();
}
const press = (sel, attr, val) => document.querySelectorAll(sel).forEach(b => b.setAttribute("aria-pressed", b.dataset[attr] === val));
async function busy(btn, fn) { if (btn.disabled) return; btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } }

/* ---------- 출석 상태 ---------- */
let atA = null, atL = null, atS = "";
function setAt(v) { atS = v; press("#atOpts button", "v", v); $("atDed").hidden = v !== "same"; if (v === "same" && !$("atDeduct").dataset.touched) $("atDeduct").checked = true; }
document.querySelectorAll("#atOpts button").forEach(b => b.onclick = () => setAt(b.dataset.v));
$("atDeduct").onchange = () => $("atDeduct").dataset.touched = "1";
function openAtt(a, l) {
  atA = a; atL = l; const x = l.att[a.id]; $("atErr").textContent = "";
  $("atTitle").textContent = `${a.name} · ${md(l.date)} (${dow(l.date)})`;
  $("atSub").textContent = `${l.start}~${endOf(l)} · ${LABEL[l.type]} · ${TN(l.trainer)}`;
  $("atDeduct").checked = x ? x.deduct : true; $("atDeduct").dataset.touched = x && x.s === "same" ? "1" : "";
  $("atMemo").value = x ? x.memo : ""; setAt(x ? x.s : ""); show($("attSheet"));
}
$("atSave").onclick = () => busy($("atSave"), async () => {
  const row = !atS ? { status: null, deduct: false, memo: "" }
    : { status: atS, deduct: atS === "present" ? true : atS === "prior" ? false : $("atDeduct").checked, memo: $("atMemo").value.trim() };
  const { error } = await sb.from("lesson_athletes").update(row).eq("lesson_id", atL.id).eq("athlete_id", atA.id);
  if (error) return $("atErr").textContent = friendly(error);
  close(); toast("저장했어요"); refresh();
});

/* ---------- 결제 기록 ---------- */
let pA = null, pEdit = null, pKind = "pass", pMethod = "카드";
function showTotal() {
  const base = Number($("pPrice").value) || 0, vat = vatOf(base, pMethod);
  $("pTotal").innerHTML = vat
    ? `<div class="kv"><span>금액</span><span>${won(base)}</span></div><div class="kv"><span>부가세 10%</span><span>+ ${won(vat)}</span></div><div class="kv tot"><span>받을 금액</span><span>${won(base + vat)}</span></div>`
    : `<div class="kv tot"><span>받을 금액</span><span>${won(base)}</span></div><div class="kv"><span>현금은 부가세 없음</span><span></span></div>`;
}
const chargedIn = (m) => (ledgerLessons || []).filter(l => l.date.startsWith(m) && charged(l.att[pA.id])).length;
function setKind(k) {
  pKind = k; press("#pKinds button", "k", k);
  $("pCountBox").hidden = k !== "pass"; $("pMonthBox").hidden = k !== "month"; $("pLessonBox").hidden = k !== "visit";
  if (!pEdit) {
    if (k === "trial" || k === "visit") $("pPrice").value = pA.price;
    if (k === "pass") $("pPrice").value = $("pCount").value ? pA.price * Number($("pCount").value) : "";
    if (k === "month") monthCalc();
  }
  if (k === "visit") fillLessons();
  showTotal();
}
function monthCalc() {
  const m = $("pMonth").value; const n = m ? chargedIn(m) : 0;
  $("pMonthHint").textContent = m ? `${Number(m.slice(5))}월 차감 ${n}회 × ${won(pA.price)} = ${won(n * pA.price)}` : "";
  if (!pEdit) $("pPrice").value = n * pA.price; showTotal();
}
function fillLessons() {
  const paid = new Set(payments.filter(p => p.aid === pA.id && p.kind === "visit" && p !== pEdit).map(p => p.lessonId));
  const ls = (ledgerLessons || []).slice().sort(sortL).filter(l => charged(l.att[pA.id]) && (!paid.has(l.id) || (pEdit && pEdit.lessonId === l.id)));
  $("pLesson").innerHTML = ls.length ? ls.map(l => `<option value="${l.id}">${md(l.date)} (${dow(l.date)}) ${l.start} ${LABEL[l.type]}</option>`).join("") : `<option value="">결제할 수업이 없어요</option>`;
  if (pEdit && pEdit.lessonId) $("pLesson").value = pEdit.lessonId;
}
document.querySelectorAll("#pKinds button").forEach(b => b.onclick = () => setKind(b.dataset.k));
document.querySelectorAll("#pMethods button").forEach(b => b.onclick = () => { pMethod = b.dataset.m; press("#pMethods button", "m", pMethod); showTotal(); });
document.querySelectorAll("#pCountBox .presets button").forEach(b => b.onclick = () => { $("pCount").value = b.dataset.c; if (!pEdit) $("pPrice").value = pA.price * Number(b.dataset.c); showTotal(); });
$("pMonth").oninput = monthCalc; $("pPrice").addEventListener("input", showTotal);
function openPay(a, p) {
  pA = a; pEdit = p || null; $("pErr").textContent = ""; $("pDel").hidden = !p;
  $("pTitle").textContent = p ? "결제 기록 수정" : `${a.name} 결제 기록`;
  $("pDate").value = p ? p.date : todayIso(); $("pCount").value = p && p.kind === "pass" ? p.count : "";
  const st = status(a);
  $("pMonth").value = p && p.month ? p.month : (a.plan === "monthly" && st.open && st.open[0]) || thisMonth();
  $("pPrice").value = p ? p.price : ""; $("pMemo").value = p ? p.memo : "";
  pMethod = p ? p.method : "카드"; press("#pMethods button", "m", pMethod);
  setKind(p ? p.kind : a.plan === "monthly" ? "month" : a.plan === "visit" ? "visit" : "pass");
  showTotal(); show($("paySheet"));
}
$("pDel").onclick = () => confirmBtn($("pDel"), "정말 삭제", () => busy($("pDel"), async () => {
  const { error } = await sb.from("payments").delete().eq("id", pEdit.id);
  if (error) return $("pErr").textContent = friendly(error);
  close(); toast("삭제했어요"); refresh();
}));
$("pForm").onsubmit = e => { e.preventDefault(); busy($("pForm").querySelector(".primary"), async () => {
  const price = Number($("pPrice").value);
  const v = { athlete_id: pA.id, branch_id: pEdit ? (pEdit.branch || curBranch) : curBranch, kind: pKind, date: $("pDate").value, price, vat: vatOf(price, pMethod), method: pMethod, memo: $("pMemo").value.trim(), count: 1, month: null, lesson_id: null };
  if (!v.date) return $("pErr").textContent = "결제일을 입력해주세요.";
  if ($("pPrice").value === "" || !(price >= 0)) return $("pErr").textContent = "금액을 입력해주세요.";
  if (pKind === "pass") { v.count = Number($("pCount").value); if (!(v.count > 0)) return $("pErr").textContent = "횟수를 입력해주세요."; }
  if (pKind === "month") { v.month = $("pMonth").value; if (!v.month) return $("pErr").textContent = "정산 월을 선택해주세요."; v.count = chargedIn(v.month); }
  if (pKind === "visit") { v.lesson_id = Number($("pLesson").value); if (!v.lesson_id) return $("pErr").textContent = "결제할 수업을 선택해주세요."; }
  const { error } = pEdit ? await sb.from("payments").update(v).eq("id", pEdit.id) : await sb.from("payments").insert(v);
  if (error) return $("pErr").textContent = friendly(error);
  close(); toast("저장했어요"); refresh();
}); };

/* ---------- 수업 등록·수정 ---------- */
let editing = null, fType = "personal", picked = [];
function fillTrainers(sel) {
  const list = isAdmin() ? trainers.filter(t => (t.active && inBranch(trainerBr, t.id, curBranch)) || t.id === sel) : trainers.filter(t => t.id === me.id);
  $("fTrainer").innerHTML = list.map(t => `<option value="${t.id}">${esc(t.name)} 트레이너${t.active ? "" : " (퇴사)"}</option>`).join("");
  $("fTrainer").value = sel || (list.some(t => t.id === me.id) ? me.id : (list[0] || {}).id); $("fTrainer").disabled = !isAdmin();
}
function setType(t) {
  fType = t; press("#types button", "t", t);
  $("boxPick").hidden = t === "team"; $("boxTeam").hidden = t !== "team";
  $("pickLbl").textContent = t === "group" ? "선수 (여러 명 선택)" : "선수";
  if (t === "personal" && picked.length > 1) picked = picked.slice(0, 1);
  drawPicked(); updEnd();
}
function updEnd() { const s = $("fStart").value; $("fEnd").textContent = s ? toTime(toMin(s) + DUR[fType]) : "--:--"; }
function drawPicked() {
  const box = $("picked"); box.innerHTML = "";
  picked.forEach(id => {
    const a = A(id); if (!a) return; const s = document.createElement("span"); s.className = "tag"; s.textContent = a.name;
    const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", `${a.name} 빼기`);
    x.onclick = () => { picked = picked.filter(p => p !== id); drawPicked(); }; s.appendChild(x); box.appendChild(s);
  });
  const full = fType === "personal" && picked.length === 1; $("fFind").hidden = full; drawResults(full);
}
function drawResults(hide) {
  const r = $("results"); r.innerHTML = ""; if (hide) { r.hidden = true; return; } r.hidden = false;
  const q = $("fFind").value.trim(); const tr = Number($("fTrainer").value);
  const last = a => recent[`${a.id}-${tr}`] || "";
  const pool = editing && editing.branch !== curBranch ? athletes.filter(a => inBranch(athleteBr, a.id, editing.branch)) : athletesHere();
  let list = pool.filter(a => !picked.includes(a.id) && match(a, q));
  list.sort((x, y) => last(y).localeCompare(last(x)) || x.name.localeCompare(y.name, "ko"));
  list = list.slice(0, q ? 8 : 5);
  if (!list.length) { r.innerHTML = `<div class="none">이 지점에 맞는 선수가 없어요. 다른 지점 선수라면 선수 정보에서 이 지점을 추가해주세요.</div>`; return; }
  if (!q) { const h = document.createElement("div"); h.className = "none"; h.textContent = `${TN(tr)} 최근 수업 선수`; r.appendChild(h); }
  list.forEach(a => {
    const b = document.createElement("button"); b.type = "button"; b.innerHTML = `<b>${esc(a.name)}</b><span>${esc(a.team)}${a.by ? " · " + ageText(a) : ""}</span>`;
    b.onclick = () => { picked.push(a.id); $("fFind").value = ""; drawPicked(); if (fType === "group") $("fFind").focus(); }; r.appendChild(b);
  });
}
$("fFind").oninput = () => drawResults(false);
$("fTrainer").onchange = () => drawResults(fType === "personal" && picked.length === 1);
document.querySelectorAll("#types button").forEach(b => b.onclick = () => setType(b.dataset.t));
$("fStart").oninput = updEnd;
function openLesson(l) {
  editing = l || null; $("lTitle").textContent = l ? "수업 수정" : "수업 추가"; $("lDel").hidden = !l; $("lErr").textContent = "";
  fillTrainers(l ? l.trainer : null); $("fDate").value = l ? l.date : iso(cur); $("fStart").value = l ? l.start : "";
  picked = l ? [...l.ids] : []; $("fFind").value = "";
  $("fTeam").value = l && l.type === "team" ? l.team : ""; $("fGrade").value = l && l.type === "team" ? l.grade : "";
  setType(l ? l.type : "personal"); show($("lessonSheet"));
}
$("lDel").onclick = () => confirmBtn($("lDel"), "정말 삭제", () => busy($("lDel"), async () => {
  const { error } = await sb.from("lessons").delete().eq("id", editing.id);
  if (error) return $("lErr").textContent = friendly(error);
  close(); toast("삭제했어요"); refresh();
}));
$("lForm").onsubmit = e => { e.preventDefault(); busy($("lForm").querySelector(".primary"), async () => {
  if (!$("fTrainer").value) return $("lErr").textContent = "이 지점에 배정된 트레이너가 없어요. 트레이너 관리에서 지점을 배정해주세요.";
  const row = { type: fType, branch_id: editing ? editing.branch : curBranch, trainer_id: Number($("fTrainer").value), date: $("fDate").value, start_time: $("fStart").value, team: null, grade: null };
  if (!row.date || !row.start_time) return $("lErr").textContent = "날짜와 시작 시간을 입력해주세요.";
  if (fType === "personal" && picked.length !== 1) return $("lErr").textContent = "선수를 1명 선택해주세요.";
  if (fType === "group" && picked.length < 2) return $("lErr").textContent = "그룹 수업은 선수를 2명 이상 선택해주세요.";
  if (fType === "team") { row.team = $("fTeam").value.trim(); row.grade = $("fGrade").value.trim(); if (!row.team || !row.grade) return $("lErr").textContent = "학교·팀과 학년을 입력해주세요."; }
  const ids = fType === "team" ? [] : [...picked];
  let lid;
  if (editing) {
    const { error } = await sb.from("lessons").update(row).eq("id", editing.id);
    if (error) return $("lErr").textContent = friendly(error);
    lid = editing.id;
    const removed = editing.ids.filter(id => !ids.includes(id)), added = ids.filter(id => !editing.ids.includes(id));
    if (removed.length) { const { error: e2 } = await sb.from("lesson_athletes").delete().eq("lesson_id", lid).in("athlete_id", removed); if (e2) return $("lErr").textContent = friendly(e2); }
    if (added.length) { const { error: e3 } = await sb.from("lesson_athletes").insert(added.map(a => ({ lesson_id: lid, athlete_id: a }))); if (e3) return $("lErr").textContent = friendly(e3); }
  } else {
    const { data, error } = await sb.from("lessons").insert(row).select("id").single();
    if (error) return $("lErr").textContent = friendly(error);
    lid = data.id;
    if (ids.length) {
      const { error: e2 } = await sb.from("lesson_athletes").insert(ids.map(a => ({ lesson_id: lid, athlete_id: a })));
      if (e2) { await sb.from("lessons").delete().eq("id", lid); return $("lErr").textContent = friendly(e2); }
    }
  }
  cur = parse(row.date); close(); toast("저장했어요"); refresh();
}); };

/* ---------- 트레이너 관리 (관리자) ---------- */
function drawTrainers() {
  const box = $("trList"); box.innerHTML = "";
  trainers.forEach(t => {
    const r = document.createElement("div"); r.className = "trow" + (t.active ? "" : " off");
    const self = me && t.id === me.id;
    r.innerHTML = `<div style="display:grid;gap:4px;min-width:0"><input aria-label="트레이너 이름">${t.linked ? "" : `<input class="temail" type="email" inputmode="email" aria-label="가입할 이메일">`}<span class="hint">${t.linked ? esc(t.email) + " · " : ""}${t.role === "admin" ? "관리자(전 지점)" : "트레이너"} · ${!t.active ? "퇴사" : t.linked ? "가입 완료" : "가입 전"}</span>${t.role === "admin" ? "" : `<div class="brchips"></div>`}</div>${self ? "" : `<div style="display:grid;gap:6px"><button type="button" class="trole">${t.role === "admin" ? "관리자 해제" : "관리자 지정"}</button>${t.linked ? `<button type="button" class="tpw">비밀번호 초기화</button>` : ""}<button type="button" class="tact">${t.active ? "퇴사 처리" : "복귀"}</button><button type="button" class="tdel" style="color:var(--danger)">삭제</button></div>`}`;
    const chips = r.querySelector(".brchips");
    if (chips) branches.filter(b => b.active).forEach(br => {
      const c = document.createElement("button"); c.type = "button"; c.className = "brchip"; c.textContent = br.name;
      c.setAttribute("aria-pressed", inBranch(trainerBr, t.id, br.id));
      c.onclick = () => busy(c, async () => {
        const on = inBranch(trainerBr, t.id, br.id);
        const { error } = on ? await sb.from("trainer_branches").delete().eq("trainer_id", t.id).eq("branch_id", br.id)
                             : await sb.from("trainer_branches").insert({ trainer_id: t.id, branch_id: br.id });
        if (error) return $("trErr").textContent = friendly(error);
        (trainerBr[t.id] ||= new Set())[on ? "delete" : "add"](br.id); drawTrainers(); dayCache = {}; render();
      });
      chips.appendChild(c);
    });
    const inp = r.querySelector("input"); inp.value = t.name;
    inp.onchange = async () => {
      const v = inp.value.trim().replace(/\s*트레이너$/, ""); if (!v) { inp.value = t.name; return; }
      const { error } = await sb.from("trainers").update({ name: v }).eq("id", t.id);
      if (error) { $("trErr").textContent = friendly(error); inp.value = t.name; return; }
      t.name = v; toast("이름을 바꿨어요"); render();
    };
    const em = r.querySelector(".temail");
    if (em) {
      em.value = t.email;
      em.onchange = async () => {
        const v = em.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { $("trErr").textContent = "이메일 형식을 확인해주세요."; em.value = t.email; return; }
        const { error } = await sb.from("trainers").update({ email: v }).eq("id", t.id);
        if (error) { $("trErr").textContent = /duplicate|unique/i.test(error.message) ? "이미 등록된 이메일이에요." : friendly(error); em.value = t.email; return; }
        t.email = v; $("trErr").textContent = ""; toast("이메일을 바꿨어요");
      };
    }
    const rb = r.querySelector(".trole");
    if (rb) rb.onclick = () => confirmBtn(rb, t.role === "admin" ? "정말 해제" : "정말 지정", () => busy(rb, async () => {
      const role = t.role === "admin" ? "trainer" : "admin";
      const { error } = await sb.from("trainers").update({ role }).eq("id", t.id);
      if (error) return $("trErr").textContent = friendly(error);
      t.role = role; $("trErr").textContent = ""; drawTrainers();
      toast(role === "admin" ? `${t.name} 님이 관리자가 됐어요 (전 지점 관리)` : `${t.name} 님의 관리자 권한을 해제했어요`);
    }));
    const pw = r.querySelector(".tpw");
    if (pw) pw.onclick = () => {
      const box = r.querySelector(".pwbox");
      if (box) { box.remove(); return; }
      const d = document.createElement("div"); d.className = "pwbox";
      d.innerHTML = `<input type="text" autocomplete="off" aria-label="임시 비밀번호" placeholder="임시 비밀번호 (6자 이상)"><button type="button">설정</button>`;
      const inp2 = d.querySelector("input"), go = d.querySelector("button");
      inp2.value = "solid" + String(Math.floor(1000 + Math.random() * 9000));
      go.onclick = () => busy(go, async () => {
        const v = inp2.value.trim();
        if (v.length < 6) return $("trErr").textContent = "임시 비밀번호는 6자 이상으로 정해주세요.";
        const { error } = await sb.rpc("admin_reset_password", { p_id: t.id, p_password: v });
        if (error) return $("trErr").textContent = error.message.replace(/^.*?: /, "");
        $("trErr").textContent = ""; d.remove();
        toast(`${t.name} 님 임시 비밀번호: ${v} — 알려드린 뒤 로그인해서 바꾸라고 안내해주세요.`);
      });
      r.querySelector("div").appendChild(d); inp2.select();
    };
    const del = r.querySelector(".tdel");
    if (del) del.onclick = () => confirmBtn(del, "정말 삭제", () => busy(del, async () => {
      const { error } = await sb.rpc("delete_trainer", { p_id: t.id });
      if (error) return $("trErr").textContent = error.message.replace(/^.*?: /, "");
      trainers = trainers.filter(x => x.id !== t.id); delete trainerBr[t.id];
      $("trErr").textContent = ""; drawTrainers(); toast(`${t.name} 트레이너를 삭제했어요`); render();
    }));
    const b = r.querySelector(".tact");
    if (b) b.onclick = () => busy(b, async () => {
      const { error } = await sb.from("trainers").update({ active: !t.active }).eq("id", t.id);
      if (error) return $("trErr").textContent = friendly(error);
      t.active = !t.active; $("trErr").textContent = ""; drawTrainers(); render();
    });
    box.appendChild(r);
  });
}
function drawBranches() {
  const box = $("brList"); box.innerHTML = "";
  branches.forEach(br => {
    const r = document.createElement("div"); r.className = "trow";
    const n = athletes.filter(a => inBranch(athleteBr, a.id, br.id)).length, tn = trainers.filter(t => inBranch(trainerBr, t.id, br.id)).length;
    r.innerHTML = `<div style="display:grid;gap:2px;min-width:0"><input aria-label="지점 이름"><span class="hint">트레이너 ${tn}명 · 선수 ${n}명</span></div>`;
    const inp = r.querySelector("input"); inp.value = br.name;
    inp.onchange = async () => {
      const v = inp.value.trim(); if (!v) { inp.value = br.name; return; }
      const { error } = await sb.from("branches").update({ name: v }).eq("id", br.id);
      if (error) { $("trErr").textContent = friendly(error); inp.value = br.name; return; }
      br.name = v; drawBranchSel(); drawTrainers(); toast("지점 이름을 바꿨어요"); render();
    };
    box.appendChild(r);
  });
}
$("brAdd").onclick = () => busy($("brAdd"), async () => {
  const name = $("brNew").value.trim(); if (!name) return $("trErr").textContent = "지점 이름을 입력해주세요.";
  const { data, error } = await sb.from("branches").insert({ name }).select("id,name,active").single();
  if (error) return $("trErr").textContent = friendly(error);
  branches.push(data); $("brNew").value = ""; $("trErr").textContent = "";
  drawBranches(); drawBranchSel(); drawTrainers(); toast(`${name}을(를) 추가했어요. 트레이너에게 지점을 배정해주세요.`);
});
$("mgrBtn").onclick = () => { $("trErr").textContent = ""; $("trNew").value = ""; $("trEmail").value = ""; $("brNew").value = ""; drawBranches(); drawTrainers(); show($("trSheet")); };
$("trAdd").onclick = () => busy($("trAdd"), async () => {
  const name = $("trNew").value.trim().replace(/\s*트레이너$/, ""); const email = $("trEmail").value.trim().toLowerCase();
  if (!name) return $("trErr").textContent = "이름을 입력해주세요.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return $("trErr").textContent = "가입할 이메일을 정확히 입력해주세요.";
  const { data: newId, error } = await sb.rpc("create_trainer", { p_name: name, p_email: email, p_branch_ids: curBranch ? [curBranch] : [] });
  if (error) return $("trErr").textContent = /duplicate|unique/i.test(error.message) ? "이미 등록된 이메일이에요." : friendly(error);
  trainers.push({ id: newId, name, email, role: "trainer", active: true, linked: false });
  if (curBranch) (trainerBr[newId] ||= new Set()).add(curBranch); $("trNew").value = ""; $("trEmail").value = ""; $("trErr").textContent = "";
  drawTrainers(); toast(`${name} 트레이너를 ${BN(curBranch)}에 등록했어요. 이 이메일로 '처음 가입'하면 돼요.`);
});

/* ---------- 선수 등록·수정 ---------- */
let aEditing = null, fPlan = "pass", aBr = new Set();
function drawAthBranches() {
  const box = $("aBranches"); box.innerHTML = "";
  const list = myBranches(); $("aBrBox").hidden = list.length < 2 && !(aEditing && (athleteBr[aEditing.id] || new Set()).size > 1);
  list.forEach(br => {
    const c = document.createElement("button"); c.type = "button"; c.className = "brchip"; c.textContent = br.name;
    c.setAttribute("aria-pressed", aBr.has(br.id));
    c.onclick = () => { aBr.has(br.id) ? aBr.delete(br.id) : aBr.add(br.id); drawAthBranches(); };
    box.appendChild(c);
  });
}
function setPlan(p) { fPlan = p; press("#plans button", "p", p); }
document.querySelectorAll("#plans button").forEach(b => b.onclick = () => setPlan(b.dataset.p));
function birthHint() {
  const v = Number($("aBirth").value);
  $("aAgeHint").textContent = v >= 1 && v <= 100 ? `${yy(byOf(v))}년생으로 저장돼요. 내년엔 ${v + 1}살로 자동 표시돼요.` : "입력하면 출생연도로 저장돼서, 해가 바뀌면 나이가 자동으로 한 살씩 올라가요.";
}
$("aBirth").addEventListener("input", birthHint);
function openAthForm(a) {
  aEditing = a || null; $("aErr").textContent = "";
  $("afTitle").textContent = a ? "선수 정보 수정" : "선수 등록";
  $("aName").value = a ? a.name : ""; $("aTeam").value = a ? a.team : ""; $("aPrice").value = a ? a.price : "";
  $("aBirth").value = a && a.by ? ageOf(a.by) : ""; birthHint();
  aBr = new Set(a ? [...(athleteBr[a.id] || [])] : [curBranch]); drawAthBranches();
  setPlan(a ? a.plan : "pass"); show($("athForm"));
}
$("aForm").onsubmit = e => { e.preventDefault(); busy($("aForm").querySelector(".primary"), async () => {
  const name = $("aName").value.trim(), team = $("aTeam").value.trim() || "개인", price = Number($("aPrice").value), ageIn = $("aBirth").value;
  if (!name) return $("aErr").textContent = "이름을 입력해주세요.";
  if ($("aPrice").value === "" || !(price >= 0)) return $("aErr").textContent = "회당 단가를 입력해주세요.";
  if (ageIn !== "" && !(Number(ageIn) >= 1 && Number(ageIn) <= 100)) return $("aErr").textContent = "나이는 1~100 사이 숫자로 입력해주세요.";
  if (!aBr.size) return $("aErr").textContent = "지점을 하나 이상 선택해주세요.";
  const row = { name, team, plan: fPlan, price, birth_year: ageIn === "" ? null : byOf(Number(ageIn)) };
  if (aEditing) {
    const { error } = await sb.from("athletes").update(row).eq("id", aEditing.id);
    if (error) return $("aErr").textContent = friendly(error);
    const before = athleteBr[aEditing.id] || new Set();
    const add = [...aBr].filter(b => !before.has(b)), del = [...before].filter(b => !aBr.has(b) && myBranches().some(x => x.id === b));
    if (add.length) { const { error: e2 } = await sb.from("athlete_branches").insert(add.map(b => ({ athlete_id: aEditing.id, branch_id: b }))); if (e2) return $("aErr").textContent = friendly(e2); }
    if (del.length) { const { error: e3 } = await sb.from("athlete_branches").delete().eq("athlete_id", aEditing.id).in("branch_id", del); if (e3) return $("aErr").textContent = friendly(e3); }
  } else {
    const { data: newId, error } = await sb.rpc("create_athlete", { p_name: name, p_team: team, p_plan: fPlan, p_price: price, p_birth_year: row.birth_year, p_branch_ids: [...aBr] });
    if (error) return $("aErr").textContent = friendly(error);
    ledgerId = newId; ledgerLessons = [];
    close("ledger"); toast("저장했어요"); refresh(); return;
  }
  close(); toast("저장했어요"); refresh();
}); };

/* ---------- 이벤트 ---------- */
function shift(n) { cur.setDate(cur.getDate() + n); render(); }
$("prev").onclick = () => shift(-1); $("next").onclick = () => shift(1);
$("todayBtn").onclick = () => { cur = parse(todayIso()); render(); };
$("datePick").onchange = e => { if (e.target.value) { cur = parse(e.target.value); render(); } };
$("vTrainer").onclick = () => { view = "trainer"; render(); }; $("vTime").onclick = () => { view = "time"; render(); };
$("tabS").onclick = () => { if (ledgerId) leaveLedger(); tab = "sched"; render(); };
$("tabR").onclick = () => { if (ledgerId) leaveLedger(); tab = "roll"; render(); };
$("backBtn").onclick = leaveLedger;
$("aSearch").oninput = renderList;
$("branchSel").onchange = e => { setBranch(Number(e.target.value)); if (ledgerId) leaveLedger(); render(); };
$("fab").onclick = () => tab === "sched" ? openLesson() : openAthForm();
// 다른 트레이너가 바꾼 내용을 반영: 앱으로 돌아올 때 새로고침
let lastLoad = Date.now();
document.addEventListener("visibilitychange", () => { if (!document.hidden && me && Date.now() - lastLoad > 30000) { lastLoad = Date.now(); refresh(); } });

/* ---------- 로그인 ---------- */
let mode = "login";
function setMode(m) {
  mode = m; $("modeLogin").setAttribute("aria-pressed", m === "login"); $("modeSignup").setAttribute("aria-pressed", m === "signup");
  $("authTitle").textContent = m === "login" ? "로그인" : "처음 가입"; $("authBtn").textContent = m === "login" ? "로그인" : "가입하기";
  $("signupNote").hidden = $("pwHint").hidden = m !== "signup"; $("authPw").autocomplete = m === "login" ? "current-password" : "new-password";
  $("authErr").textContent = ""; $("authOk").textContent = "";
}
$("modeLogin").onclick = () => setMode("login"); $("modeSignup").onclick = () => setMode("signup");
$("authForm").onsubmit = e => { e.preventDefault(); busy($("authBtn"), async () => {
  const email = $("authEmail").value.trim().toLowerCase(), password = $("authPw").value;
  $("authErr").textContent = ""; $("authOk").textContent = "";
  if (!email || !password) return $("authErr").textContent = "이메일과 비밀번호를 입력해주세요.";
  if (mode === "signup") {
    if (password.length < 6) return $("authErr").textContent = "비밀번호는 6자 이상으로 정해주세요.";
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return $("authErr").textContent = /Database error|등록되지 않은/.test(error.message) ? "등록되지 않은 이메일이에요. 관리자에게 트레이너 등록을 요청하세요." : /already/i.test(error.message) ? "이미 가입한 이메일이에요. 로그인해주세요." : /not allowed/i.test(error.message) ? "지금은 가입이 막혀 있어요. 관리자에게 수파베이스 가입 허용 설정을 확인해달라고 해주세요." : error.message;
    if (!data.session) { $("authOk").textContent = "가입했어요. 이메일로 온 확인 링크를 누른 뒤 로그인해주세요."; setMode("login"); return; }
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return $("authErr").textContent = /Invalid login/i.test(error.message) ? "이메일 또는 비밀번호가 맞지 않아요." : /not confirmed/i.test(error.message) ? "이메일 확인이 아직 안 됐어요. 메일함의 확인 링크를 눌러주세요." : error.message;
  }
}); };
$("logoutBtn").onclick = async () => { await sb.auth.signOut(); };
/* ---------- 데이터 내보내기 (관리자) ---------- */
let expScope = "cur";
function expRange(r) {
  const t = new Date(); let a, b;
  if (r === "this") { a = new Date(t.getFullYear(), t.getMonth(), 1); b = new Date(t.getFullYear(), t.getMonth() + 1, 0); }
  if (r === "last") { a = new Date(t.getFullYear(), t.getMonth() - 1, 1); b = new Date(t.getFullYear(), t.getMonth(), 0); }
  if (r === "year") { a = new Date(t.getFullYear(), 0, 1); b = new Date(t.getFullYear(), 11, 31); }
  $("expFrom").value = iso(a); $("expTo").value = iso(b);
}
document.querySelectorAll("#expPresets button").forEach(b => b.onclick = () => expRange(b.dataset.r));
document.querySelectorAll("#expScope button").forEach(b => b.onclick = () => { expScope = b.dataset.s; press("#expScope button", "s", expScope); });
$("expBtn").onclick = () => {
  expRange("this"); expScope = "cur"; press("#expScope button", "s", "cur");
  $("expScope").querySelector('[data-s="cur"]').textContent = `지금 지점 (${BN(curBranch)})`;
  $("expErr").textContent = ""; show($("expSheet"));
};
let xlsxReady = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  return xlsxReady ||= new Promise((ok, no) => {
    const sc = document.createElement("script"); sc.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    sc.onload = ok; sc.onerror = () => { xlsxReady = null; no(new Error("엑셀 도구를 불러오지 못했어요. 인터넷 연결을 확인해주세요.")); };
    document.head.appendChild(sc);
  });
}
$("expForm").onsubmit = e => { e.preventDefault(); busy($("expGo"), async () => {
  const from = $("expFrom").value, to = $("expTo").value;
  if (!from || !to) return $("expErr").textContent = "기간을 선택해주세요.";
  if (from > to) return $("expErr").textContent = "시작일이 종료일보다 늦어요.";
  $("expErr").textContent = ""; $("expGo").textContent = "만드는 중…";
  try {
    await loadXlsx();
    const scope = q => expScope === "cur" ? q.eq("branch_id", curBranch) : q;
    const [ls, ps] = await Promise.all([
      fetchAll("lessons", "id,type,trainer_id,branch_id,date,start_time,team,grade,lesson_athletes(athlete_id,status,deduct,memo)",
        q => scope(q.gte("date", from).lte("date", to)).order("date").order("start_time")),
      fetchAll("payments", "*", q => scope(q.gte("date", from).lte("date", to)).order("date")),
    ]);
    const lessonRows = [];
    let cP = 0, cS = 0, cSd = 0, cPr = 0, cU = 0;
    ls.forEach(r => {
      const l = mapLesson(r, r.lesson_athletes);
      const base = { 날짜: l.date, 요일: dow(l.date), 지점: BN(l.branch), 시작: l.start, 종료: endOf(l), 종류: LABEL[l.type], 트레이너: TN(l.trainer) };
      if (l.type === "team") { lessonRows.push({ ...base, "선수/학교": `${l.team} ${l.grade}`, 상태: "", 차감: "", 메모: "" }); return; }
      l.ids.forEach(id => {
        const x = l.att[id];
        if (!x) cU++; else if (x.s === "present") cP++; else if (x.s === "prior") cPr++; else { cS++; if (x.deduct) cSd++; }
        lessonRows.push({ ...base, "선수/학교": (A(id) || {}).name || "(삭제된 선수)", 상태: x ? ST[x.s] : "미체크", 차감: charged(x) ? "차감" : "", 메모: x ? x.memo : "" });
      });
    });
    const KIND = { trial: "체험수업", pass: "회차권", month: "월 정산", visit: "1회 결제" };
    const byMethod = {};
    const payRows = ps.map(mapPay).map(p => {
      const total = p.price + p.vat; byMethod[p.method] = (byMethod[p.method] || 0) + total;
      return { 결제일: p.date, 지점: BN(p.branch), 선수: (A(p.aid) || {}).name || "(삭제된 선수)", 항목: KIND[p.kind], 횟수: p.kind === "pass" || p.kind === "month" ? p.count : "", "정산 월": p.month || "", "금액(부가세 별도)": p.price, 부가세: p.vat, "받은 금액": total, 결제수단: p.method, 메모: p.memo };
    });
    const pool = expScope === "cur" ? athletesHere() : athletes;
    const athRows = pool.slice().sort((x, y) => x.name.localeCompare(y.name, "ko")).map(a => ({
      이름: a.name, 소속: a.team, 나이: a.by ? ageOf(a.by) : "", 출생연도: a.by || "", 지점: [...(athleteBr[a.id] || [])].map(BN).join(", "), 결제방식: PLAN[a.plan], 회당단가: a.price, 현재상태: status(a).chip[1] }));
    const sum = [
      ["솔리드 피지컬 트레이닝 데이터"], ["기간", `${from} ~ ${to}`], ["지점", expScope === "cur" ? BN(curBranch) : "전 지점"], ["만든 날", todayIso()], [],
      ["결제 합계 (받은 금액)"], ...["카드", "계좌이체", "현금"].map(m => [m, byMethod[m] || 0]), ["합계", Object.values(byMethod).reduce((a, b) => a + b, 0)], [],
      ["출석 현황 (개인·그룹)"], ["출석", cP], ["당일취소", cS], ["  그중 차감", cSd], ["사전취소", cPr], ["미체크", cU], ["수업 수", ls.length],
    ];
    const wb = XLSX.utils.book_new();
    const add = (name, ws, widths) => { if (widths) ws["!cols"] = widths.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
    add("요약", XLSX.utils.aoa_to_sheet(sum), [22, 24]);
    add("수업·출석", XLSX.utils.json_to_sheet(lessonRows.length ? lessonRows : [{ 안내: "이 기간 수업이 없어요" }]), [11, 5, 10, 7, 7, 6, 14, 18, 9, 6, 24]);
    add("결제", XLSX.utils.json_to_sheet(payRows.length ? payRows : [{ 안내: "이 기간 결제가 없어요" }]), [11, 10, 10, 9, 6, 9, 14, 9, 12, 9, 24]);
    add("선수 목록", XLSX.utils.json_to_sheet(athRows.length ? athRows : [{ 안내: "선수가 없어요" }]), [10, 16, 6, 8, 16, 10, 10, 14]);
    const tag = expScope === "cur" ? BN(curBranch) : "전지점";
    XLSX.writeFile(wb, `솔리드_${tag}_${from}_${to}.xlsx`);
    close(); toast("엑셀 파일을 받았어요. 다운로드 폴더를 확인해주세요.");
  } catch (err) { $("expErr").textContent = friendly(err); }
  finally { $("expGo").textContent = "엑셀 받기"; }
}); };

$("pwBtn").onclick = () => { $("pwNew").value = ""; $("pwNew2").value = ""; $("pwErr").textContent = ""; show($("pwSheet")); };
$("pwForm").onsubmit = e => { e.preventDefault(); busy($("pwForm").querySelector(".primary"), async () => {
  const a = $("pwNew").value, b = $("pwNew2").value;
  if (a.length < 6) return $("pwErr").textContent = "비밀번호는 6자 이상으로 정해주세요.";
  if (a !== b) return $("pwErr").textContent = "두 비밀번호가 서로 달라요.";
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) return $("pwErr").textContent = /different from the old|same/i.test(error.message) ? "지금 비밀번호와 다른 비밀번호로 정해주세요." : /weak|short/i.test(error.message) ? "더 복잡한 비밀번호로 정해주세요." : error.message;
  close(); toast("비밀번호를 바꿨어요. 다음 로그인부터 새 비밀번호를 쓰세요.");
}); };

async function enter(session) {
  if (!session) { me = null; $("appView").hidden = true; $("authView").hidden = false; return; }
  const { data, error } = await sb.from("trainers").select("id,name,email,role,active,user_id").eq("user_id", session.user.id).maybeSingle();
  if (error || !data || !data.active) {
    await sb.auth.signOut();
    $("authErr").textContent = data && !data.active ? "퇴사 처리된 계정이에요. 관리자에게 문의하세요." : "트레이너로 등록되지 않은 계정이에요.";
    return;
  }
  me = mapTrainer(data);
  $("meLabel").textContent = `${me.name} 트레이너${isAdmin() ? " · 관리자" : ""}`;
  $("authView").hidden = true; $("appView").hidden = false;
  $("list").innerHTML = `<div class="loading">불러오는 중…</div>`;
  try { await loadBase(); } catch (e) { toast(friendly(e), true); }
  lastLoad = Date.now(); render();
}
let entered; // undefined → 첫 이벤트(로그인 안 된 상태 포함)는 항상 처리
sb.auth.onAuthStateChange((evt, session) => {
  const uid = session ? session.user.id : null;
  if (uid === entered && evt !== "SIGNED_OUT") return; // 토큰 갱신 등은 무시
  entered = uid; setTimeout(() => enter(session), 0);
});
