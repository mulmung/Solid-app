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
const ST = { present: "출석", prev: "이전 결제분", same: "당일취소", prior: "사전취소" };
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
try { const v = localStorage.getItem("solid.view"); if (["trainer", "time", "mine"].includes(v)) view = v; } catch (e) {}
function setView(v) { view = v; try { localStorage.setItem("solid.view", v); } catch (e) {} render(); }

const T = id => trainers.find(t => t.id === id);
const B = id => branches.find(b => b.id === id);
const BN = id => (B(id) || {}).name || Object.values(workCache).flat().find(b => b && b.id === id)?.name || "다른 지점";
const inBranch = (map, id, b) => !!(map[id] && map[id].has(b));
const athletesHere = () => athletes.filter(a => !a.archived && inBranch(athleteBr, a.id, curBranch));
const archivedHere = () => athletes.filter(a => a.archived && inBranch(athleteBr, a.id, curBranch));
const canManageAthlete = a => isSuper() || [...(athleteBr[a.id] || [])].some(b => managerBr[me.id] && managerBr[me.id].has(b));
function setBranch(id) { curBranch = id; try { localStorage.setItem("solid.branch", String(id)); } catch (e) {} }
const TN = id => { const t = T(id); return t ? `${t.name} 트레이너` : "트레이너 미지정"; };
const A = id => athletes.find(a => a.id === id);
const isAdmin = () => me && me.role === "admin";          // 앱 관리자: 사람·지점 관리까지
const isCeo = () => me && me.position === "ceo";
const isSuper = () => isAdmin() || isCeo();               // 대표·앱 관리자: 전 지점 운영
const POS = { ceo: "대표", staff: "정직원", instructor: "강사" };
let managerBr = {};            // trainerId → Set(지점 관리자인 지점)
const isManagerOf = b => isSuper() || !!(me && managerBr[me.id] && managerBr[me.id].has(b));
const managedBranches = () => branches.filter(b => b.active && isManagerOf(b.id));
const canEdit = l => isSuper() || (me && l.trainer === me.id) || isManagerOf(l.branch);

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
const mapTrainer = r => ({ id: r.id, name: r.name, email: r.email, role: r.role, position: r.position || "staff", active: r.active, linked: !!r.user_id });
const mapAthlete = r => ({ id: r.id, name: r.name, team: r.team, plan: r.plan, price: r.price, by: r.birth_year, archived: !!r.archived, gender: r.gender || null });
const mapPay = r => ({ id: r.id, branch: r.branch_id, aid: r.athlete_id, kind: r.kind, date: r.date, count: r.count, used: r.used || 0, price: r.price, vat: r.vat, method: r.method, memo: r.memo, month: r.month, lessonId: r.lesson_id });
function mapLesson(r, rows) {
  const att = {}, ids = [];
  (rows || []).forEach(x => { ids.push(x.athlete_id); if (x.status) att[x.athlete_id] = { s: x.status, deduct: x.deduct, memo: x.memo }; });
  return { id: r.id, type: r.type, trainer: r.trainer_id, branch: r.branch_id, date: r.date, start: r.start_time.slice(0, 5), team: r.team, grade: r.grade, ids, att };
}

async function loadBase() {
  const [br, tbr, abr, tr, at, tpl, pa, st, rc] = await Promise.all([
    fetchAll("branches", "id,name,active", q => q.order("id")),
    fetchAll("trainer_branches", "trainer_id,branch_id,is_manager"),
    fetchAll("athlete_branches", "athlete_id,branch_id"),
    fetchAll("trainers", "id,name,email,role,position,active,user_id", q => q.order("id")),
    fetchAll("athletes", "id,name,team,plan,price,birth_year,archived,gender", q => q.order("id")),
    fetchAll("lesson_templates", "*", q => q.order("start_time")),
    fetchAll("payments", "*", q => q.order("id")),
    fetchAll("athlete_month_stats", "*"),
    fetchAll("athlete_trainer_recent", "*"),
  ]);
  branches = br;
  trainerBr = {}; managerBr = {};
  tbr.forEach(r => { (trainerBr[r.trainer_id] ||= new Set()).add(r.branch_id); if (r.is_manager) (managerBr[r.trainer_id] ||= new Set()).add(r.branch_id); });
  athleteBr = {}; abr.forEach(r => (athleteBr[r.athlete_id] ||= new Set()).add(r.branch_id));
  trainers = tr.map(mapTrainer);
  athletes = at.map(mapAthlete);
  templates = tpl.map(r => ({ id: r.id, branch: r.branch_id, wd: r.weekday, type: r.type, trainer: r.trainer_id, start: r.start_time.slice(0, 5), team: r.team, grade: r.grade, ids: r.athlete_ids || [] }));
  payments = pa.map(mapPay);
  stats = {};
  st.forEach(r => {
    const s = stats[r.athlete_id] || (stats[r.athlete_id] = { charged: 0, byMonth: {}, unchecked: 0, unpaid: 0 });
    s.charged += Number(r.charged); s.byMonth[r.month] = Number(r.charged); s.unchecked += Number(r.unchecked); s.unpaid += Number(r.unpaid_visit);
  });
  recent = {}; rc.forEach(r => recent[`${r.athlete_id}-${r.trainer_id}`] = r.last_date);
  rankData = null;
  await loadMyCheckin(); workCache = {};
  // 보고 있던 지점 유지, 없으면 내 첫 지점
  const mine = branches.filter(b => b.active && (isSuper() || inBranch(trainerBr, me.id, b.id)));
  let saved = null; try { saved = Number(localStorage.getItem("solid.branch")); } catch (e) {}
  if (!mine.some(b => b.id === curBranch)) setBranch((mine.find(b => b.id === saved) || mine[0] || {}).id ?? null);
  drawBranchSel();
  if ($("meSub")) {
    const mb = managedBranches().filter(b => managerBr[me.id] && managerBr[me.id].has(b.id)).map(b => b.name);
    const home = myBranches().filter(b => inBranch(trainerBr, me.id, b.id)).map(b => b.name).join(", ");
    $("meSub").textContent = isCeo() ? "대표 · 전 지점" : `${POS[me.position] || "정직원"} · ${home || "지점 없음"}${mb.length ? " 지점 관리자" : ""}${isAdmin() ? " · 앱 관리자" : ""}`;
  }
}
function myBranches() { return branches.filter(b => b.active && (isSuper() || inBranch(trainerBr, me.id, b.id))); }
function drawBranchSel() {
  const sel = $("branchSel"), list = myBranches();
  sel.innerHTML = list.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  if (curBranch) sel.value = curBranch;
  sel.hidden = !list.length;
}

/* ---------- 출근 ---------- */
let myCheckin = null;          // 오늘 내 출근 (어느 지점이든)
let dayCheckins = {};          // `${지점}|${날짜}` → { trainerId: 출근 }
const KST = { timeZone: "Asia/Seoul" };
const hm = ts => new Date(ts).toLocaleTimeString("ko-KR", { ...KST, hour: "2-digit", minute: "2-digit", hour12: false });
const fullTime = ts => { const d = new Date(ts); return `${d.toLocaleDateString("ko-KR", { ...KST, year: "numeric", month: "long", day: "numeric", weekday: "short" }).replace(/\((.)\)/, "($1)")} ${d.toLocaleTimeString("ko-KR", { ...KST, hour: "numeric", minute: "2-digit" })}`; };
async function loadMyCheckin() {
  const { data } = await sb.from("checkins").select("*").eq("trainer_id", me.id).eq("work_date", todayIso()).maybeSingle();
  myCheckin = data || null;
}
async function loadDay(d) {
  const { data: ck } = await sb.from("checkins").select("*").eq("branch_id", curBranch).eq("work_date", d);
  const m = {}; (ck || []).forEach(c => m[c.trainer_id] = c); dayCheckins[`${curBranch}|${d}`] = m;
  const { data, error } = await sb.from("lessons")
    .select("id,type,trainer_id,branch_id,date,start_time,team,grade,lesson_athletes(athlete_id,status,deduct,memo)")
    .eq("date", d).eq("branch_id", curBranch).order("start_time");
  if (error) throw error;
  dayCache[`${curBranch}|${d}`] = data.map(r => mapLesson(r, r.lesson_athletes));
}

async function fetchAthleteLessons(aid) {
  const rows = await fetchAll("lesson_athletes",
    "athlete_id,status,deduct,memo,lesson:lessons(id,type,trainer_id,branch_id,date,start_time,team,grade)",
    q => q.eq("athlete_id", aid));
  return rows.filter(r => r.lesson).map(r => mapLesson(r.lesson, [r]));
}
async function loadLedger(aid) {
  const [ls, ms] = await Promise.all([fetchAthleteLessons(aid), fetchAll("measurements", "*", q => q.eq("athlete_id", aid).order("measured_on", { ascending: false }).order("id", { ascending: false }))]);
  ledgerLessons = ls; ledgerMs = ms;
}

/* 저장 후 화면 갱신 */
let lastRefresh = 0;
async function refresh() {
  lastRefresh = Date.now();
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
    const total = paysOf(a).filter(p => p.kind === "pass" || p.kind === "trial" || p.kind === "carry").reduce((n, p) => n + p.count - (p.used || 0), 0);
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
    const units = paysOf(a).filter(p => p.kind === "pass" || p.kind === "trial" || p.kind === "carry");
    let u = 0, n = units.length ? (units[0].used || 0) : 0;
    ch.forEach(l => {
      while (u < units.length && n >= units[u].count) { u++; n = u < units.length ? (units[u].used || 0) : 0; }
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
      const a = A(id); if (!a) return; const x = l.att[id];
      const tap = canEdit(l) && l.date <= todayIso();
      const s = document.createElement(tap ? "button" : "span");
      s.className = "nm " + (x ? x.s : "") + (tap ? " tap" : "");
      if (tap) { s.type = "button"; s.onclick = () => openAtt(a, l); s.setAttribute("aria-label", `${a.name} 출석 기록`); }
      else s.onclick = null; s.textContent = a.name + (x && x.s !== "present" && x.s !== "prev" ? ` · ${ST[x.s]}` : ""); box.appendChild(s);
    });
  }
  return el;
}
async function renderSched() {
  const d = iso(cur);
  $("dateMain").textContent = `${cur.getMonth() + 1}월 ${cur.getDate()}일 (${days[cur.getDay()]})`;
  $("dateSub").textContent = d === todayIso() ? "오늘" : `${cur.getFullYear()}년`; $("datePick").value = d;
  $("vTrainer").setAttribute("aria-pressed", view === "trainer"); $("vTime").setAttribute("aria-pressed", view === "time"); $("vMine").setAttribute("aria-pressed", view === "mine");
  const list = $("list");
  if (!curBranch) { $("summary").innerHTML = ""; list.innerHTML = `<div class="empty">배정된 지점이 없어요.<br>관리자에게 지점 배정을 요청하세요.</div>`; return; }
  const key = `${curBranch}|${d}`;
  if (!dayCache[key]) {
    $("summary").innerHTML = ""; list.innerHTML = `<div class="loading">불러오는 중…</div>`;
    try { await loadDay(d); } catch (e) { list.innerHTML = `<div class="empty">${esc(friendly(e))}</div>`; return; }
    if (tab !== "sched" || iso(cur) !== d || `${curBranch}|${d}` !== key) return; // 그사이 화면이 바뀜
  }
  const all = dayCache[key].slice().sort((a, b) => toMin(a.start) - toMin(b.start) || a.trainer - b.trainer);
  const bad = conflicts(all);
  const day = view === "mine" ? all.filter(l => me && l.trainer === me.id) : all;
  const cnt = t => day.filter(l => l.type === t).length;
  const cks = dayCheckins[key] || {};
  $("summary").innerHTML = `<span>${view === "mine" ? "내 수업" : "총"} ${day.length}개${view === "mine" ? "" : " 수업"}</span>` + ["personal", "group", "team"].map(t => `<span class="chip ${t}">${LABEL[t]} ${cnt(t)}</span>`).join("");
  list.innerHTML = "";
  if (d === todayIso()) list.appendChild(checkinCard());
  const lb = loadBtn(d, all); if (lb) list.appendChild(lb);
  if (!day.length) { list.insertAdjacentHTML("beforeend", `<div class="empty">${view === "mine" ? (all.length ? `이 날은 내 수업이 없어요.<br>지점 전체 ${all.length}개 수업은 트레이너별이나 시간순에서 볼 수 있어요.` : "이 날은 내 수업이 없어요.") : "이 날은 등록된 수업이 없어요."}<br>아래 <b>+ 수업 추가</b>로 등록해보세요.</div>`); return; }
  if (view === "trainer") {
    const order = [...trainers].sort((x, y) => (me && x.id === me.id ? -1 : 0) - (me && y.id === me.id ? -1 : 0));
    for (const t of order) {
      const mine = day.filter(l => l.trainer === t.id); if (!mine.length) continue;
      const s = document.createElement("section"); s.className = "section";
      s.innerHTML = `<h2>${esc(t.name)} 트레이너${t.active ? "" : " (퇴사)"}<span class="count">${mine.length}개</span>${cks[t.id] ? `<span class="ckmark">${hm(cks[t.id].checked_at)} 출근</span>` : ""}</h2>`;
      mine.forEach(l => s.appendChild(card(l, bad, false))); list.appendChild(s);
    }
  } else {
    const s = document.createElement("section"); s.className = "section"; day.forEach(l => s.appendChild(card(l, bad, view !== "mine"))); list.appendChild(s);
  }
}

function checkinCard() {
  const box = document.createElement("div");
  if (myCheckin) {
    box.className = "ckcard done";
    box.innerHTML = `<div class="ckt"><b>출근 완료</b><span>${esc(fullTime(myCheckin.checked_at))} · ${esc(BN(myCheckin.branch_id))}</span></div><button type="button" class="cklink">출근 기록</button>`;
  } else {
    box.className = "ckcard";
    box.innerHTML = `<div class="ckt"><b>아직 출근 전이에요</b><span>${esc(BN(curBranch))}에 출근으로 기록돼요</span></div><button type="button" class="ckbtn">출근하기</button><button type="button" class="cklink">출근 기록</button>`;
    const b = box.querySelector(".ckbtn");
    b.onclick = () => confirmBtn(b, "한 번 더 누르면 출근", () => busy(b, async () => {
      const { data, error } = await sb.rpc("check_in", { p_branch: curBranch });
      if (error) return toast(/이미 출근/.test(error.message) ? "오늘은 이미 출근했어요" : friendly(error), true);
      myCheckin = data; toast(`출근했어요 · ${fullTime(data.checked_at)}`); refresh();
    }));
  }
  box.querySelector(".cklink").onclick = openWork;
  return box;
}

/* ---------- 출근 기록 화면 (하루 단위, 전 지점) ---------- */
let workOpen = false, workDay = null, workCache = {};
function openWork() {
  if (layer() !== "work") history.pushState({ layer: "work" }, "");
  workOpen = true; workDay = workDay || parse(todayIso());
  render(); window.scrollTo(0, 0);
}
function leaveWork() { if (layer() === "work") history.back(); else { workOpen = false; render(); } }
async function renderWork() {
  const d = iso(workDay), today = todayIso();
  $("wkMonth").textContent = `${workDay.getMonth() + 1}월 ${workDay.getDate()}일 (${days[workDay.getDay()]})`;
  $("wkSub").textContent = d === today ? "오늘" : `${workDay.getFullYear()}년`;
  $("wkPick").value = d; $("wkTitle").textContent = "출근 기록 · 전 지점";
  const box = $("list"); $("summary").innerHTML = "";
  if (d > today) { box.innerHTML = `<div class="empty">아직 지나지 않은 날이에요.</div>`; return; }
  if (!workCache[d]) {
    box.innerHTML = `<div class="loading">불러오는 중…</div>`;
    const { data, error } = await sb.rpc("checkin_board", { p_date: d });
    if (error) { box.innerHTML = `<div class="empty">${esc(friendly(error))}</div>`; return; }
    workCache[d] = data || [];
    if (!workOpen || iso(workDay) !== d) return;
  }
  const board = workCache[d];
  let total = 0; board.forEach(b => b.people.forEach(p => { if (p.checkin_branch === b.id) total++; }));
  $("summary").innerHTML = `<span>전 지점 ${total}명 출근</span>${managedBranches().length ? `<span class="hint">${isSuper() ? "기록을 눌러 수정하거나, 빈 칸을 눌러 추가할 수 있어요" : "관리하는 지점은 눌러서 수정·추가할 수 있어요"}</span>` : ""}`;
  box.innerHTML = "";
  const lg = document.createElement("div"); lg.className = "ledger";
  board.forEach(b => {
    const here = b.people.filter(p => p.checkin_branch === b.id).sort((x, y) => x.checked_at.localeCompare(y.checked_at));
    const rest = b.people.filter(p => p.checkin_branch !== b.id).sort((x, y) => x.name.localeCompare(y.name, "ko"));
    const mb = document.createElement("div"); mb.className = "monthbar";
    mb.textContent = `${b.name} · ${b.people.length}명 중 ${here.length}명 출근`; lg.appendChild(mb);
    if (!b.people.length) { const e = document.createElement("div"); e.className = "lr muted"; e.innerHTML = `<span class="d"></span><span class="c"><b>배정된 트레이너가 없어요</b></span><span class="rn"></span>`; lg.appendChild(e); }
    [...here, ...rest].forEach(p => {
      const atHere = p.checkin_branch === b.id, elsewhere = p.checkin_id && !atHere;
      const can = p.checkin_id ? isManagerOf(p.checkin_branch) : isManagerOf(b.id);
      const row = document.createElement(can ? "button" : "div"); row.className = "lr" + (atHere ? "" : " muted"); if (can) row.type = "button";
      const label = atHere ? `${hm(p.checked_at)} 출근` : elsewhere ? `${esc(p.checkin_branch_name)} 출근 · ${hm(p.checked_at)}` : "출근 기록 없음";
      row.innerHTML = `<span class="d" style="font-family:var(--sans)">${esc(p.name)}</span><span class="c"><b>${label}</b>${p.edited ? `<span>관리자 수정</span>` : ""}</span><span class="rn"></span>`;
      if (can) row.onclick = () => openCk({ id: p.id, name: p.name }, d, p.checkin_id ? { id: p.checkin_id, checked_at: p.checked_at } : null, p.checkin_id ? p.checkin_branch : b.id);
      lg.appendChild(row);
    });
  });
  box.appendChild(lg);
}
/* 출근 기록 수정·추가 (지점 관리자·전체 관리자) */
let ckT = null, ckDate = null, ckRow = null, ckBranch = null;
function openCk(t, date, r, branchId) {
  ckT = t; ckDate = date; ckRow = r || null; ckBranch = branchId; $("ckErr").textContent = "";
  $("ckTitle").textContent = r ? "출근 기록 수정" : "출근 기록 추가";
  $("ckSub").textContent = `${t.name} 트레이너 · ${md(date)} (${dow(date)}) · ${BN(branchId)}`;
  $("ckTime").value = r ? hm(r.checked_at) : "09:00"; $("ckDel").hidden = !r; show($("ckSheet"));
}
$("ckForm").onsubmit = e => { e.preventDefault(); busy($("ckForm").querySelector(".primary"), async () => {
  const tm = $("ckTime").value; if (!tm) return $("ckErr").textContent = "출근 시간을 입력해주세요.";
  const at = new Date(`${ckDate}T${tm}:00+09:00`).toISOString();
  const { error } = ckRow ? await sb.from("checkins").update({ checked_at: at }).eq("id", ckRow.id)
    : await sb.from("checkins").insert({ trainer_id: ckT.id, branch_id: ckBranch, work_date: ckDate, checked_at: at });
  if (error) return $("ckErr").textContent = /duplicate|unique/i.test(error.message) ? "그날 다른 지점에 출근 기록이 있어요." : friendly(error);
  close(); toast("저장했어요"); refresh();
}); };
$("ckDel").onclick = () => confirmBtn($("ckDel"), "정말 삭제", () => busy($("ckDel"), async () => {
  const { error } = await sb.from("checkins").delete().eq("id", ckRow.id);
  if (error) return $("ckErr").textContent = friendly(error);
  close(); toast("삭제했어요"); refresh();
}));
$("wkBack").onclick = leaveWork;
$("wkPrev").onclick = () => { workDay = new Date(workDay); workDay.setDate(workDay.getDate() - 1); renderWork(); };
$("wkNext").onclick = () => { workDay = new Date(workDay); workDay.setDate(workDay.getDate() + 1); renderWork(); };
$("wkPick").onchange = e => { if (e.target.value) { workDay = parse(e.target.value); renderWork(); } };

/* ---------- 출석부: 선수 목록 ---------- */
let listFilter = null; // null | "pay" | "unc"
let showArchived = false;
const needsPay = a => status(a).chip[0] === "bad";
const hasUnc = a => ((stats[a.id] || {}).unchecked || 0) > 0;
function renderList() {
  const q = $("aSearch").value.trim();
  const here = athletesHere();
  const need = here.filter(needsPay).length;
  const unc = here.reduce((s, a) => s + ((stats[a.id] || {}).unchecked || 0), 0);
  if ((listFilter === "pay" && !need) || (listFilter === "unc" && !unc)) listFilter = null;
  const list = here.filter(a => match(a, q) && (listFilter !== "pay" || needsPay(a)) && (listFilter !== "unc" || hasUnc(a)))
    .sort((x, y) => x.name.localeCompare(y.name, "ko"));
  const chip = (key, cls, text) => `<button type="button" class="chip ${cls} fchip" data-f="${key}" aria-pressed="${listFilter === key}">${text}${listFilter === key ? " ✕" : ""}</button>`;
  $("summary").innerHTML = `<span>${esc(BN(curBranch))} 선수 ${here.length}명</span>${need ? chip("pay", "bad", `결제 확인 ${need}명`) : ""}${unc ? chip("unc", "warn", `출석 미체크 ${unc}건`) : ""}${listFilter ? `<span class="hint">${list.length}명 보는 중</span>` : ""}`;
  $("summary").querySelectorAll(".fchip").forEach(b => b.onclick = () => { listFilter = listFilter === b.dataset.f ? null : b.dataset.f; renderList(); });
  const box = $("list"); box.innerHTML = "";
  if (!curBranch) { box.innerHTML = `<div class="empty">배정된 지점이 없어요.<br>관리자에게 지점 배정을 요청하세요.</div>`; return; }
  const arch = archivedHere();
  const archBtn = () => {
    if (!arch.length) return;
    const b = document.createElement("button"); b.type = "button"; b.className = "archtoggle";
    b.textContent = showArchived ? `보관된 선수 ${arch.length}명 접기` : `보관된 선수 ${arch.length}명`;
    b.onclick = () => { showArchived = !showArchived; renderList(); };
    box.appendChild(b);
    if (showArchived) {
      const w = document.createElement("div"); w.className = "plist";
      arch.filter(a => match(a, q)).sort((x, y) => x.name.localeCompare(y.name, "ko")).forEach(a => {
        const r = document.createElement("button"); r.className = "prow archived";
        r.innerHTML = `<span class="n">${esc(a.name)}</span><span class="s">${esc(a.team)}${a.by ? " · " + ageText(a) : ""} · ${PLAN[a.plan]}</span><span class="st"><span class="chip plain">보관됨</span></span>`;
        r.onclick = () => openLedger(a.id); w.appendChild(r);
      });
      box.appendChild(w);
    }
  };
  if (!here.length) { box.innerHTML = `<div class="empty">아직 등록된 선수가 없어요.<br>아래 <b>+ 선수 등록</b>으로 시작하세요.</div>`; archBtn(); return; }

  if (!list.length) { box.innerHTML = `<div class="empty">${q ? `'${esc(q)}'에 맞는 선수가 없어요.` : "해당하는 선수가 없어요."}</div>`; archBtn(); return; }
  const wrap = document.createElement("div"); wrap.className = "plist";
  list.forEach(a => {
    const s = status(a); const u = (stats[a.id] || {}).unchecked || 0; const b = document.createElement("button"); b.className = "prow";
    b.innerHTML = `<span class="n">${esc(a.name)}</span><span class="s">${esc(a.team)}${a.by ? " · " + ageText(a) : ""} · ${PLAN[a.plan]}${athleteBr[a.id] && athleteBr[a.id].size > 1 ? " · 여러 지점" : ""}</span>
    <span class="st"><span class="chip ${s.chip[0]}">${s.chip[1]}</span>${u ? `<span class="chip warn">미체크 ${u}</span>` : ""}</span>`;
    b.onclick = () => openLedger(a.id); wrap.appendChild(b);
  });
  box.appendChild(wrap);
  archBtn();
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
  if (p.kind === "carry") return `이전 ${p.count}회권 이어서 (${p.used}회 사용)`;
  if (p.kind === "pass") return `${p.count}회권 결제`;
  if (p.kind === "month") return `${Number(p.month.slice(5))}월분 정산 (${p.count}회)`;
  const l = (ledgerLessons || []).find(x => x.id === p.lessonId); return `1회 결제${l ? ` · ${md(l.date)} 수업` : ""}`;
}
function renderLedger() {
  const a = A(ledgerId); if (!a) { ledgerId = null; return render(); }
  $("lgName").textContent = a.name;
  $("lgSub").textContent = `${a.archived ? "보관됨 · " : ""}${[...(athleteBr[a.id] || [])].map(BN).join("·")} · ${a.team}${a.by ? " · " + ageText(a) : ""} · ${PLAN[a.plan]} · 단가 ${won(a.price)}`;
  $("summary").innerHTML = "";
  const box = $("list");
  if (!ledgerLessons) { box.innerHTML = `<div class="loading">불러오는 중…</div>`; return; }
  const s = status(a); const ls = ledgerLessons.slice().sort(sortL); const map = rounds(a, ls); const today = todayIso();
  let top = "";
  if (a.plan === "pass") top = `<div><div class="hint">남은 회차</div><div class="big num" style="color:var(--${s.left <= 0 ? "danger" : s.left === 1 ? "warn" : "ok"})">${s.left}<span style="font-size:15px;color:var(--muted)"> / ${s.total}</span></div></div>`;
  if (a.plan === "monthly") top = `<div><div class="hint">이번 달 진행</div><div class="big num">${s.n}회 <span style="font-size:15px;color:var(--muted)">· ${won(s.n * a.price)}</span></div>${s.open.length ? `<div class="hint" style="color:var(--danger)">미정산: ${s.open.map(m => Number(m.slice(5)) + "월").join(", ")}</div>` : ""}</div>`;
  if (a.plan === "visit") top = `<div><div class="hint">미결제</div><div class="big num" style="color:var(--${s.unpaid ? "danger" : "ok"})">${s.unpaid}건</div></div>`;
  const TABS = [["pay", "결제 기록"], ["ms", "측정 기록"], ["info", "선수 정보"]];
  box.innerHTML = `<div class="sumbox"><div class="sumrow">${top}<span class="chip ${s.chip[0]}">${s.chip[1]}</span></div></div>
    <div class="lgtabs" role="tablist">${TABS.map(([k, t]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${ledgerTab === k}">${t}</button>`).join("")}</div>`;
  box.querySelectorAll(".lgtabs button").forEach(b => b.onclick = () => { ledgerTab = b.dataset.k; try { localStorage.setItem("solid.lgtab", ledgerTab); } catch (e) {} renderLedger(); });
  if (ledgerTab === "info") return renderInfo(a, box);
  if (ledgerTab === "ms") return renderMs(a, box);
  const addP = document.createElement("button"); addP.type = "button"; addP.className = "tabadd"; addP.textContent = "+ 결제 추가";
  addP.onclick = () => openPay(a); box.appendChild(addP);

  const rows = [...ls.map(l => ({ t: "l", date: l.date, k: toMin(l.start), l })), ...paysOf(a).map(p => ({ t: "p", date: p.date, k: -1, p }))]
    .sort((x, y) => y.date.localeCompare(x.date) || y.k - x.k); // 최신 순
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
      b.innerHTML = `<span class="d">${md(p.date)}<small>${dow(p.date)}</small></span><span class="c"><b>${payLabel(p)}</b><span>${p.kind === "carry" ? `${p.used + 1}회차부터 앱에서 기록` : `${p.method} · ${won(p.price + p.vat)}${p.vat ? " (부가세 포함)" : ""}`}${p.memo ? " · " + esc(p.memo) : ""}</span></span><span class="rn">${p.kind === "carry" ? "이월" : "결제"}</span>`;
      b.onclick = () => openPay(a, p);
    } else {
      const l = r.l, x = l.att[a.id], future = l.date > today;
      const label = x ? (x.s === "prev" ? "출석 · 이전 결제분" : ST[x.s]) + (x.s === "same" ? (x.deduct ? " (차감)" : " (미차감)") : "") : future ? "예정" : "미체크";
      b.className = "lr" + (future ? " future" : "") + (x && !charged(x) ? " muted" : "");
      const rn = map[l.id] || (x && x.s === "prev" ? "이전" : "");
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

/* ---------- 장부 탭: 선수 정보 ---------- */
let ledgerTab = "pay", ledgerMs = [];
try { const t = localStorage.getItem("solid.lgtab"); if (["pay", "ms", "info"].includes(t)) ledgerTab = t; } catch (e) {}
const GEN = { M: "남", F: "여" };
function renderInfo(a, box) {
  const kv = [["이름", a.name], ["성별", a.gender ? GEN[a.gender] : "미입력"], ["나이", a.by ? ageText(a) : "미입력"], ["소속", a.team],
    ["지점", [...(athleteBr[a.id] || [])].map(BN).join(", ")], ["결제 방식", PLAN[a.plan]], ["회당 단가", won(a.price)]];
  if (a.archived) kv.push(["상태", "보관됨"]);
  const d = document.createElement("div"); d.className = "infobox";
  d.innerHTML = kv.map(([k, v]) => `<div class="kv2"><span>${k}</span><b>${esc(v)}</b></div>`).join("") + `<button type="button" class="tabadd" id="infoEdit">수정</button>`;
  box.appendChild(d); $("infoEdit").onclick = () => openAthForm(a);
}

/* ---------- 측정 기록 · 순위 ---------- */
let rankData = null, rankLoading = null;
const DIVN = { elem: "초등부", mid: "중등부", high: "고등부", adult: "성인부" };
const DIVA = { elem: "8~13살", mid: "14~16살", high: "17~19살", adult: "20살 이상" };
const divOf = age => age == null ? null : age <= 13 ? "elem" : age <= 16 ? "mid" : age <= 19 ? "high" : "adult";
const GN = { M: "남자", F: "여자" };
function loadRank() {
  if (rankData) return Promise.resolve(rankData);
  return rankLoading ||= sb.rpc("speed_rankings").then(({ data, error }) => { rankLoading = null; if (error) throw error; rankData = data || { div: {}, age: {} }; return rankData; });
}
const kmh = v => `${Number(v).toFixed(1)} km/h`;
function renderMs(a, box) {
  const add = document.createElement("button"); add.type = "button"; add.className = "tabadd"; add.textContent = "+ 기록 추가";
  add.onclick = () => openMs(a); 
  const ms = ledgerMs || [];
  if (!ms.length) { box.insertAdjacentHTML("beforeend", `<div class="empty">아직 측정 기록이 없어요.<br>무동력 트레드밀 최대 속도를 기록해보세요.</div>`); box.appendChild(add); return; }
  const best = ms.reduce((m, x) => Number(x.speed) > Number(m.speed) ? x : m, ms[0]);
  const card = document.createElement("div"); card.className = "mscard";
  card.innerHTML = `<div class="hint">최고 기록</div><div class="big num">${Number(best.speed).toFixed(1)}<span style="font-size:15px;color:var(--muted)"> km/h</span></div>
    <div class="hint">${md(best.measured_on)} 측정${best.age_at ? ` · ${best.age_at}살` : ""}</div><div class="mslines" id="msLines"><span class="hint">순위 확인 중…</span></div>`;
  box.appendChild(card);
  // 변화 그래프
  if (ms.length >= 2) {
    const pts = ms.slice().reverse(); const vals = pts.map(x => Number(x.speed));
    const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1), W = 320, H = 110, P = 26;
    const X = i => P + (pts.length === 1 ? 0 : i * (W - P * 2) / (pts.length - 1)), Y = v => H - 20 - (v - lo) / (hi - lo || 1) * (H - 40);
    const line = pts.map((x, i) => `${X(i).toFixed(1)},${Y(vals[i]).toFixed(1)}`).join(" ");
    const g = document.createElement("div"); g.className = "mschart";
    g.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최대 속도 변화">
      <line x1="${P}" x2="${W - P}" y1="${H - 20}" y2="${H - 20}" stroke="var(--line)"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
      ${pts.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(vals[i]).toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 3}" fill="var(--accent)"/>`).join("")}
      <text x="${X(0)}" y="${H - 4}" font-size="11" fill="var(--muted)" text-anchor="start">${md(pts[0].measured_on)}</text>
      <text x="${X(pts.length - 1)}" y="${H - 4}" font-size="11" fill="var(--muted)" text-anchor="end">${md(pts[pts.length - 1].measured_on)}</text>
      <text x="${X(pts.length - 1)}" y="${(Y(vals[vals.length - 1]) - 9).toFixed(1)}" font-size="12" font-weight="700" fill="var(--fg)" text-anchor="end">${vals[vals.length - 1].toFixed(1)}</text>
    </svg>`;
    box.appendChild(g);
  }
  box.appendChild(add);
  const lg = document.createElement("div"); lg.className = "ledger";
  ms.forEach((x, i) => {
    const prev = ms[i + 1]; const diff = prev ? Number(x.speed) - Number(prev.speed) : 0;
    const b = document.createElement("button"); b.type = "button"; b.className = "lr";
    b.innerHTML = `<span class="d">${md(x.measured_on)}<small>${dow(x.measured_on)}</small></span><span class="c"><b>${kmh(x.speed)}${diff > 0 ? ` <span class="up">+${diff.toFixed(1)}</span>` : ""}</b><span>${x.age_at ? x.age_at + "살 · " : ""}${esc(TN(x.trainer_id))}${x.memo ? " · " + esc(x.memo) : ""}</span></span><span class="rn"></span>`;
    b.onclick = () => openMs(a, x); lg.appendChild(b);
  });
  box.appendChild(lg);
  // 순위 줄
  loadRank().then(rd => {
    const el = $("msLines"); if (!el || ledgerId !== a.id) return;
    if (!a.gender) { el.innerHTML = `<span class="hint">성별을 입력하면 순위를 볼 수 있어요</span>`; return; }
    const lines = [];
    const cdiv = a.by ? divOf(THIS_YEAR() - a.by + 1) : null;
    if (cdiv) {
      const arr = rd.div[`${cdiv}|${a.gender}`] || []; const i = arr.findIndex(r => r.id === a.id);
      if (i >= 0) lines.push(`<button type="button" class="msline" data-div="${cdiv}">${DIVN[cdiv]} ${GN[a.gender]} <b>${i + 1}위</b> <span>(${arr.length}명 중)</span></button>`);
    }
    const age = ms[0].age_at;
    if (age) {
      const mine = Math.max(...ms.filter(x => x.age_at === age).map(x => Number(x.speed)));
      const arr = (rd.age[`${a.gender}|${age}`] || []).map(Number);
      if (arr.length < 5) lines.push(`<span class="msline">${age}살 ${GN[a.gender]} · 비교 인원이 아직 적어요 (${arr.length}명)</span>`);
      else { const rank = arr.filter(v => v > mine).length + 1; lines.push(`<span class="msline">${age}살 ${GN[a.gender]} 중 <b>상위 ${Math.max(1, Math.ceil(rank / arr.length * 100))}%</b> <span>(${arr.length}명 중 ${rank}위)</span></span>`); }
    } else lines.push(`<span class="msline">나이를 입력하면 같은 나이와 비교할 수 있어요</span>`);
    el.innerHTML = lines.join("");
    el.querySelectorAll("button.msline").forEach(b => b.onclick = () => { rankG = a.gender; openRank(b.dataset.div); });
  }).catch(() => { const el = $("msLines"); if (el) el.innerHTML = ""; });
}
/* 측정 기록 입력 */
let msA = null, msRow = null;
function openMs(a, m) {
  msA = a; msRow = m || null; $("msErr").textContent = "";
  $("msTitle").textContent = m ? "측정 기록 수정" : `${a.name} 측정 기록`;
  $("msDate").value = m ? m.measured_on : todayIso(); $("msSpeed").value = m ? Number(m.speed).toFixed(1) : ""; $("msMemo").value = m ? m.memo : "";
  $("msDel").hidden = !m; show($("msSheet"));
}
$("msForm").onsubmit = e => { e.preventDefault(); busy($("msForm").querySelector(".primary"), async () => {
  const d = $("msDate").value, v = Number(String($("msSpeed").value).replace(",", "."));
  if (!d) return $("msErr").textContent = "측정일을 입력해주세요.";
  if (!(v >= 5 && v <= 45)) return $("msErr").textContent = "최대 속도 값을 다시 확인해주세요 (5~45 km/h).";
  const row = { athlete_id: msA.id, measured_on: d, speed: Math.round(v * 10) / 10, memo: $("msMemo").value.trim() };
  const { error } = msRow ? await sb.from("measurements").update(row).eq("id", msRow.id) : await sb.from("measurements").insert(row);
  if (error) return $("msErr").textContent = friendly(error);
  close(); toast("측정 기록을 저장했어요"); rankData = null; refresh();
}); };
$("msDel").onclick = () => confirmBtn($("msDel"), "정말 삭제", () => busy($("msDel"), async () => {
  const { error } = await sb.from("measurements").delete().eq("id", msRow.id);
  if (error) return $("msErr").textContent = friendly(error);
  close(); toast("삭제했어요"); rankData = null; refresh();
}));

/* 순위 화면 */
let rankOpen = false, rankDiv = null, rankG = "M";
function openRank(div) {
  if (layer() !== "rank" && layer() !== "rankdiv") history.pushState({ layer: "rank" }, "");
  rankOpen = true; rankDiv = null;
  if (div) { history.pushState({ layer: "rankdiv" }, ""); rankDiv = div; }
  render(); window.scrollTo(0, 0);
}
async function renderRank() {
  $("rkTitle").textContent = rankDiv ? `${DIVN[rankDiv]} 최대 속도 순위` : "최대 속도 순위";
  $("rkSeg").hidden = !rankDiv;
  $("rkM").setAttribute("aria-pressed", rankG === "M"); $("rkF").setAttribute("aria-pressed", rankG === "F");
  const box = $("list"); $("summary").innerHTML = "";
  if (!rankData) {
    box.innerHTML = `<div class="loading">불러오는 중…</div>`;
    try { await loadRank(); } catch (e) { box.innerHTML = `<div class="empty">${esc(friendly(e))}</div>`; return; }
    if (!rankOpen) return;
  }
  box.innerHTML = "";
  if (!rankDiv) {
    $("summary").innerHTML = `<span class="hint">전 지점 · 무동력 트레드밀 최대 속도 · 부문을 눌러 순위를 보세요</span>`;
    const g = document.createElement("div"); g.className = "divgrid";
    ["elem", "mid", "high", "adult"].forEach(d => {
      const top = (rankData.div[`${d}|M`] || [])[0];
      const b = document.createElement("button"); b.type = "button"; b.className = "divcard";
      b.innerHTML = `<b>${DIVN[d]}</b><span class="hint">${DIVA[d]}</span><span class="dtop">${top ? `1위 ${Number(top.speed).toFixed(1)}` : "기록 없음"}</span>`;
      b.onclick = () => { history.pushState({ layer: "rankdiv" }, ""); rankDiv = d; render(); window.scrollTo(0, 0); };
      g.appendChild(b);
    });
    box.appendChild(g); return;
  }
  const arr = rankData.div[`${rankDiv}|${rankG}`] || [];
  $("summary").innerHTML = `<span>${DIVN[rankDiv]} ${GN[rankG]} ${arr.length}명</span><span class="hint">${DIVA[rankDiv]} · 전 지점</span>`;
  if (!arr.length) { box.innerHTML = `<div class="empty">아직 ${DIVN[rankDiv]} ${GN[rankG]} 기록이 없어요.</div>`; return; }
  const lg = document.createElement("div"); lg.className = "ledger rank";
  const MED = ["🥇", "🥈", "🥉"]; let prev = null, shown = 0;
  arr.forEach((r, i) => {
    const sp = Number(r.speed); const rk = prev === sp ? shown : i + 1; prev = sp; shown = rk;
    const row = document.createElement(r.open ? "button" : "div"); row.className = "lr rkrow"; if (r.open) row.type = "button";
    row.innerHTML = `<span class="rk">${rk <= 3 ? MED[rk - 1] : ""}<b>${rk}</b></span><span class="c"><b>${esc(r.name)}</b><span>${esc(r.team || "")}${r.branch ? " · " + esc(r.branch) : ""}</span></span><span class="rn num">${sp.toFixed(1)}</span>`;
    if (r.open) row.onclick = () => { rankOpen = false; rankDiv = null; ledgerTab = "ms"; tab = "roll"; openLedger(r.id); };
    lg.appendChild(row);
  });
  box.appendChild(lg);
}
$("rankBtn").onclick = () => { rankG = "M"; openRank(); };
$("rkBack").onclick = () => history.back();
$("rkM").onclick = () => { rankG = "M"; renderRank(); };
$("rkF").onclick = () => { rankG = "F"; renderRank(); };

/* ---------- 관리 화면 (앱 관리자) ---------- */
let mgrOpen = false, mgrTab = "branch", mgrDetail = null, mgrFilter = "all";
const homeBranch = t => t.position === "ceo" ? null : [...(trainerBr[t.id] || [])][0] || null;
const isMgr = (t, b) => !!(managerBr[t.id] && managerBr[t.id].has(b));
function openMgr() { if (layer() !== "mgr" && layer() !== "mgrd") history.pushState({ layer: "mgr" }, ""); mgrOpen = true; mgrDetail = null; render(); window.scrollTo(0, 0); }
function openMgrDetail(d) { history.pushState({ layer: "mgrd" }, ""); mgrDetail = d; render(); window.scrollTo(0, 0); }
function renderMgr() {
  $("mgTabs").hidden = !!mgrDetail;
  $("mgTabs").querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", b.dataset.k === mgrTab));
  $("summary").innerHTML = ""; const box = $("list"); box.innerHTML = "";
  if (mgrDetail && mgrDetail.kind === "branch") return renderBranchDetail(box, B(mgrDetail.id));
  if (mgrDetail && (mgrDetail.kind === "trainer" || mgrDetail.kind === "new")) return renderTrainerDetail(box, mgrDetail.kind === "new" ? null : T(mgrDetail.id));
  $("mgTitle").textContent = "관리";
  if (mgrTab === "branch") {
    const lg = document.createElement("div"); lg.className = "plist";
    branches.forEach(b => {
      const inB = trainers.filter(t => t.active && t.position !== "ceo" && homeBranch(t) === b.id);
      const mg = inB.filter(t => isMgr(t, b.id)).map(t => t.name);
      const n = athletes.filter(a => !a.archived && inBranch(athleteBr, a.id, b.id)).length;
      const row = document.createElement("button"); row.className = "prow";
      row.innerHTML = `<span class="n">${esc(b.name)}</span><span class="s">관리자 ${mg.length ? esc(mg.join(", ")) : "없음"} · 트레이너 ${inB.length}명 · 선수 ${n}명</span><span class="st"><span class="chev">›</span></span>`;
      row.onclick = () => openMgrDetail({ kind: "branch", id: b.id }); lg.appendChild(row);
    });
    box.appendChild(lg);
    const open = document.createElement("button"); open.type = "button"; open.className = "tabadd"; open.textContent = "+ 지점 추가";
    const add = document.createElement("div"); add.className = "addrow2"; add.hidden = true;
    add.innerHTML = `<input id="mgBrNew" placeholder="새 지점 이름 (예: 강남점)" aria-label="새 지점 이름"><button type="button" id="mgBrAdd">추가</button><button type="button" class="ghost" id="mgBrCancel">취소</button>`;
    box.appendChild(open); box.appendChild(add);
    open.onclick = () => { open.hidden = true; add.hidden = false; $("mgBrNew").focus(); };
    $("mgBrCancel").onclick = () => { add.hidden = true; open.hidden = false; $("mgBrNew").value = ""; };
    $("mgBrAdd").onclick = () => busy($("mgBrAdd"), async () => {
      const name = $("mgBrNew").value.trim(); if (!name) return toast("지점 이름을 입력해주세요", true);
      const { error } = await sb.from("branches").insert({ name }); if (error) return toast(friendly(error), true);
      toast(`${name}을(를) 추가했어요`); refresh();
    });
    return;
  }
  // 트레이너 관리
  const f = document.createElement("select"); f.className = "tpwho"; f.setAttribute("aria-label", "지점 필터");
  f.innerHTML = `<option value="all">전체 지점</option>` + branches.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  f.value = String(mgrFilter); f.onchange = () => { mgrFilter = f.value === "all" ? "all" : Number(f.value); renderMgr(); };
  box.appendChild(f);
  const lg = document.createElement("div"); lg.className = "ledger";
  const byName = (x, y) => x.name.localeCompare(y.name, "ko");
  const line = (t, showBranch) => {
    const hb = homeBranch(t); const tags = [];
    if (t.position === "ceo") tags.push("전 지점"); else if (showBranch) tags.push(hb ? BN(hb) : "지점 없음");
    if (hb && isMgr(t, hb)) tags.push("지점 관리자"); if (t.role === "admin") tags.push("앱 관리자");
    if (!t.linked) tags.push("가입 전");
    const b = document.createElement("button"); b.type = "button"; b.className = "lr tline" + (t.active ? "" : " muted");
    b.innerHTML = `<span class="d" style="font-family:var(--sans)">${esc(t.name)}</span><span class="c"><b style="font-weight:500">${esc(tags.join(" · "))}</b></span><span class="rn chev">›</span>`;
    b.onclick = () => openMgrDetail({ kind: "trainer", id: t.id }); return b;
  };
  const head = (text, cls) => { const d = document.createElement("div"); d.className = cls; d.textContent = text; lg.appendChild(d); };
  const none = () => { const d = document.createElement("div"); d.className = "lr muted tline"; d.innerHTML = `<span class="d"></span><span class="c"><span>없음</span></span><span class="rn"></span>`; lg.appendChild(d); };
  // 대표
  const ceos = trainers.filter(t => t.active && t.position === "ceo").sort(byName);
  if (ceos.length) { head(`대표`, "grphead"); ceos.forEach(t => lg.appendChild(line(t))); }
  // 지점별: 정직원(지점 관리자 먼저, 가나다) → 강사(가나다)
  branches.filter(b => b.active && (mgrFilter === "all" || b.id === mgrFilter)).forEach(b => {
    head(b.name, "grphead");
    const inB = trainers.filter(t => t.active && t.position !== "ceo" && homeBranch(t) === b.id);
    [["staff", "정직원"], ["instructor", "강사"]].forEach(([k, label]) => {
      const list = inB.filter(t => t.position === k).sort((x, y) => (isMgr(y, b.id) - isMgr(x, b.id)) || byName(x, y));
      head(`${label} ${list.length}명`, "monthbar");
      if (!list.length) none(); else list.forEach(t => lg.appendChild(line(t)));
    });
  });
  // 지점 없는 사람 (예외)
  const lost = trainers.filter(t => t.active && t.position !== "ceo" && !homeBranch(t));
  if (lost.length && mgrFilter === "all") { head("지점 미지정", "grphead"); lost.sort(byName).forEach(t => lg.appendChild(line(t, true))); }
  // 퇴사
  const gone = trainers.filter(t => !t.active && (mgrFilter === "all" || homeBranch(t) === mgrFilter)).sort(byName);
  if (gone.length) { head(`퇴사 ${gone.length}명`, "grphead"); gone.forEach(t => lg.appendChild(line(t, true))); }
  box.appendChild(lg);
  const add = document.createElement("button"); add.type = "button"; add.className = "tabadd"; add.textContent = "+ 트레이너 추가";
  add.onclick = () => openMgrDetail({ kind: "new" }); box.appendChild(add);
}
function renderBranchDetail(box, b) {
  if (!b) { mgrDetail = null; return renderMgr(); }
  $("mgTitle").textContent = b.name;
  const staff = trainers.filter(t => t.active && t.position === "staff" && homeBranch(t) === b.id).sort((x, y) => x.name.localeCompare(y.name, "ko"));
  const inB = trainers.filter(t => t.active && t.position !== "ceo" && homeBranch(t) === b.id);
  const cur = staff.find(t => isMgr(t, b.id));
  const d = document.createElement("div"); d.className = "infobox form";
  d.innerHTML = `<div class="field"><label for="bdName">지점 이름</label><input id="bdName"></div>
    <div class="field"><label for="bdMgr">지점 관리자 (정직원만)</label><select id="bdMgr"><option value="">없음</option>${staff.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></div>
    <button type="button" class="primary" id="bdSave">저장</button>`;
  box.appendChild(d);
  $("bdName").value = b.name; $("bdMgr").value = cur ? String(cur.id) : "";
  $("bdSave").onclick = () => busy($("bdSave"), async () => {
    const name = $("bdName").value.trim(); if (!name) return toast("지점 이름을 입력해주세요", true);
    if (name !== b.name) { const { error } = await sb.from("branches").update({ name }).eq("id", b.id); if (error) return toast(friendly(error), true); }
    const want = Number($("bdMgr").value) || null;
    for (const t of staff) {
      const on = t.id === want;
      if (on !== isMgr(t, b.id)) { const { error } = await sb.from("trainer_branches").update({ is_manager: on }).eq("trainer_id", t.id).eq("branch_id", b.id); if (error) return toast(friendly(error), true); }
    }
    toast("저장했어요"); refresh();
  });
  const lg = document.createElement("div"); lg.className = "ledger";
  lg.innerHTML = `<div class="monthbar">소속 트레이너 ${inB.length}명</div>`;
  inB.sort((x, y) => (x.position === y.position ? x.name.localeCompare(y.name, "ko") : x.position === "staff" ? -1 : 1)).forEach(t => {
    const r = document.createElement("button"); r.type = "button"; r.className = "lr";
    r.innerHTML = `<span class="d" style="font-family:var(--sans)">${esc(t.name)}</span><span class="c"><b style="font-weight:500">${POS[t.position]}${isMgr(t, b.id) ? " · 지점 관리자" : ""}</b></span><span class="rn chev">›</span>`;
    r.onclick = () => openMgrDetail({ kind: "trainer", id: t.id }); lg.appendChild(r);
  });
  box.appendChild(lg);
}
function renderTrainerDetail(box, t) {
  $("mgTitle").textContent = t ? `${t.name} 트레이너` : "트레이너 추가";
  const hb = t ? homeBranch(t) : (mgrFilter !== "all" ? mgrFilter : (branches[0] || {}).id);
  const self = t && t.id === me.id;
  const d = document.createElement("div"); d.className = "infobox form";
  d.innerHTML = `<div class="field"><label for="tdName">이름</label><input id="tdName" placeholder="예: 홍길동"></div>
    <div class="field"><label for="tdEmail">가입 이메일</label><input id="tdEmail" type="email" inputmode="email" ${t && t.linked ? "disabled" : ""}>${t && t.linked ? `<span class="hint">가입을 마쳐서 이메일은 바꿀 수 없어요</span>` : ""}</div>
    <div class="two"><div class="field"><label for="tdPos">직급</label><select id="tdPos"><option value="ceo">대표</option><option value="staff">정직원</option><option value="instructor">강사</option></select></div>
    <div class="field"><label for="tdBr">소속 지점</label><select id="tdBr">${branches.filter(b => b.active).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}</select></div></div>
    <label class="tdmgr" id="tdMgrBox"><input type="checkbox" id="tdMgr"> 소속 지점의 지점 관리자</label>
    <p class="err" id="tdErr" role="alert"></p>
    <button type="button" class="primary" id="tdSave">${t ? "저장" : "추가"}</button>`;
  box.appendChild(d);
  $("tdName").value = t ? t.name : ""; $("tdEmail").value = t ? t.email : "";
  $("tdPos").value = t ? t.position : "staff"; if (hb) $("tdBr").value = String(hb);
  $("tdMgr").checked = !!(t && hb && isMgr(t, hb));
  const sync = () => {
    const p = $("tdPos").value; const ceo = p === "ceo";
    $("tdBr").disabled = ceo; if (ceo) { if (![...$("tdBr").options].some(o => o.value === "all")) $("tdBr").insertAdjacentHTML("afterbegin", `<option value="all">전 지점</option>`); $("tdBr").value = "all"; }
    else { const o = $("tdBr").querySelector('option[value="all"]'); if (o) { o.remove(); $("tdBr").value = String(hb || (branches[0] || {}).id); } }
    $("tdMgrBox").hidden = p !== "staff"; if (p !== "staff") $("tdMgr").checked = false;
  };
  $("tdPos").onchange = sync; sync();
  if (self) { $("tdPos").disabled = true; }
  $("tdSave").onclick = () => busy($("tdSave"), async () => {
    const name = $("tdName").value.trim().replace(/\s*트레이너$/, ""), email = $("tdEmail").value.trim().toLowerCase(), pos = $("tdPos").value;
    if (!name) return $("tdErr").textContent = "이름을 입력해주세요.";
    if ((!t || !t.linked) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return $("tdErr").textContent = "가입할 이메일을 정확히 입력해주세요.";
    const br = pos === "ceo" ? null : Number($("tdBr").value);
    const { data, error } = await sb.rpc("admin_save_trainer", { p_id: t ? t.id : null, p_name: name, p_email: email || null, p_position: pos, p_branch: br, p_manager: $("tdMgr").checked });
    if (error) return $("tdErr").textContent = /duplicate|unique/i.test(error.message) ? "이미 등록된 이메일이에요." : error.message.replace(/^.*?: /, "");
    toast(t ? "저장했어요" : `${name} 트레이너를 추가했어요. 이 이메일로 '처음 가입'하면 돼요.`);
    if (!t) { mgrDetail = { kind: "trainer", id: data }; history.replaceState({ layer: "mgrd" }, ""); }
    refresh();
  });
  if (!t) return;
  // 계정 관리
  const acts = document.createElement("div"); acts.className = "infobox form";
  acts.innerHTML = `<div class="monthbar" style="padding:0">계정</div>
    ${!t.linked ? `<span class="hint">아직 가입 전이에요. 위 이메일로 '처음 가입'하면 연결돼요.</span>`
      : self ? `<span class="hint">본인 비밀번호는 설정(⚙️) → 비밀번호 변경에서 바꿀 수 있어요.</span>`
      : `<button type="button" class="secondary" id="tdPwOpen">비밀번호 초기화</button>
         <div id="tdPwBox" hidden style="display:grid;gap:6px"><span class="hint">아래 임시 비밀번호로 바뀌어요. 버튼을 누르기 전에는 바뀌지 않아요.</span>
         <div class="pwbox"><input type="text" id="tdPw" autocomplete="off" aria-label="임시 비밀번호"><button type="button" id="tdPwGo">이 값으로 바꾸기</button></div></div>`}
    ${self ? "" : `<div style="display:flex;gap:8px"><button type="button" class="secondary" id="tdAct">${t.active ? "퇴사 처리" : "복귀"}</button><button type="button" class="secondary danger" id="tdDel">삭제</button></div>`}`;
  box.appendChild(acts);
  if ($("tdPwOpen")) $("tdPwOpen").onclick = () => {
    const box = $("tdPwBox"); box.hidden = !box.hidden;
    $("tdPwOpen").textContent = box.hidden ? "비밀번호 초기화" : "닫기";
    if (!box.hidden && !$("tdPw").value) $("tdPw").value = "solid" + String(Math.floor(1000 + Math.random() * 9000));
  };
  if ($("tdPw")) {
    $("tdPwGo").onclick = () => confirmBtn($("tdPwGo"), "정말 초기화", () => busy($("tdPwGo"), async () => {
      const v = $("tdPw").value.trim(); if (v.length < 6) return toast("임시 비밀번호는 6자 이상으로 정해주세요", true);
      const { error } = await sb.rpc("admin_reset_password", { p_id: t.id, p_password: v });
      if (error) return toast(error.message.replace(/^.*?: /, ""), true);
      toast(`${t.name} 님 임시 비밀번호: ${v} — 알려드린 뒤 로그인해서 바꾸라고 안내해주세요.`);
    }));
  }
  if ($("tdAct")) $("tdAct").onclick = () => confirmBtn($("tdAct"), t.active ? "정말 퇴사 처리" : "정말 복귀", () => busy($("tdAct"), async () => {
    const { error } = await sb.from("trainers").update({ active: !t.active }).eq("id", t.id);
    if (error) return toast(friendly(error), true); toast(t.active ? "퇴사 처리했어요" : "복귀했어요"); refresh();
  }));
  if ($("tdDel")) $("tdDel").onclick = () => confirmBtn($("tdDel"), "정말 삭제", () => busy($("tdDel"), async () => {
    const { error } = await sb.rpc("delete_trainer", { p_id: t.id });
    if (error) return toast(error.message.replace(/^.*?: /, ""), true);
    toast(`${t.name} 트레이너를 삭제했어요`); history.back(); refresh();
  }));
}
$("mgrBtn").onclick = openMgr;
$("mgBack").onclick = () => history.back();
$("mgTabs").querySelectorAll("button").forEach(b => b.onclick = () => { mgrTab = b.dataset.k; renderMgr(); });

/* ---------- 고정표 ---------- */
let templates = [], tplOpen = false, tplWd = 1, tplMode = false, tplTrainer = null;
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const tplOf = (wd, tid) => templates.filter(t => t.branch === curBranch && t.wd === wd && t.trainer === tid).sort((a, b) => toMin(a.start) - toMin(b.start));
const tplHere = wd => tplOf(wd, tplTrainer);
const myTpl = wd => tplOf(wd, me.id);
const tplWho = t => t.type === "team" ? `${t.team} · ${t.grade}` : t.ids.map(id => (A(id) || {}).name).filter(Boolean).join(", ") || "(선수 없음)";
function openTpl() {
  if (layer() !== "tpl") history.pushState({ layer: "tpl" }, "");
  tplOpen = true; tplWd = cur.getDay(); tplTrainer = me.id; render(); window.scrollTo(0, 0);
}
function leaveTpl() { if (layer() === "tpl") history.back(); else { tplOpen = false; render(); } }
function renderTpl() {
  const mgr = isManagerOf(curBranch);
  if (!mgr) tplTrainer = me.id;
  $("tpTitle").textContent = `${tplTrainer === me.id ? "내 고정표" : `${TN(tplTrainer)} 고정표`} · ${BN(curBranch)}`;
  const who = $("tpWho"); who.hidden = !mgr;
  if (mgr) {
    const others = trainers.filter(t => t.id !== me.id && t.active && inBranch(trainerBr, t.id, curBranch)).sort((x, y) => x.name.localeCompare(y.name, "ko"));
    who.innerHTML = `<option value="${me.id}">나 (${esc(me.name)})</option>` + others.map(t => `<option value="${t.id}">${esc(t.name)} 트레이너</option>`).join("");
    if (![me.id, ...others.map(t => t.id)].includes(tplTrainer)) tplTrainer = me.id;
    who.value = String(tplTrainer);
  }
  const days = $("tpDays"); days.innerHTML = "";
  WD_ORDER.forEach(w => {
    const n = tplHere(w).length; const b = document.createElement("button"); b.type = "button";
    b.setAttribute("aria-pressed", w === tplWd); b.innerHTML = `${WD[w]}${n ? `<small>${n}</small>` : ""}`;
    b.onclick = () => { tplWd = w; renderTpl(); }; days.appendChild(b);
  });
  const list = tplHere(tplWd);
  $("summary").innerHTML = `<span>${WD[tplWd]}요일 고정 수업 ${list.length}개</span><span class="hint">스케줄에서 불러오기를 누르면 그날 수업으로 만들어져요</span>`;
  const box = $("list"); box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<div class="empty">${WD[tplWd]}요일 고정 수업이 없어요.<br>아래 <b>+ 고정 수업 추가</b>로 등록해보세요.</div>`; return; }
  const sec = document.createElement("section"); sec.className = "section";
  list.forEach(t => {
    const can = canEdit({ trainer: t.trainer, branch: t.branch });
    const el = document.createElement("div"); el.className = `lesson ${t.type}`;
    el.innerHTML = `<div class="time">${t.start}<small>~ ${toTime(toMin(t.start) + DUR[t.type])}</small></div>
      <div class="body"><div class="row1"><span class="chip ${t.type}">${LABEL[t.type]}</span><span class="meta">${esc(TN(t.trainer))}</span>${can ? `<button class="edit">수정</button>` : ""}</div><div class="whoT"></div></div>`;
    el.querySelector(".whoT").textContent = tplWho(t);
    const e = el.querySelector(".edit"); if (e) e.onclick = () => openLesson(t, "tpl");
    sec.appendChild(el);
  });
  box.appendChild(sec);
}
$("tplBtn").onclick = openTpl;
$("tpWho").onchange = e => { tplTrainer = Number(e.target.value); renderTpl(); };
$("tpBack").onclick = leaveTpl;

/* 스케줄: 고정 수업 불러오기 */
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const tplExists = (t, day) => day.some(l => l.trainer === t.trainer && l.start === t.start && l.type === t.type &&
  (t.type === "team" ? l.team === t.team && l.grade === t.grade : sameSet(l.ids, t.ids.filter(id => A(id) && !A(id).archived))));
function loadBtn(d, all) {
  const wd = parse(d).getDay();
  const mine = myTpl(wd);
  if (!mine.length) return null;
  const left = mine.filter(t => !tplExists(t, all));
  const b = document.createElement("button"); b.type = "button"; b.className = "loadbtn";
  if (!left.length) { b.textContent = "고정 수업 모두 불러옴"; b.disabled = true; }
  else { b.textContent = `${WD[wd]}요일 내 고정 수업 불러오기 (${left.length}개)`; b.onclick = () => openLoad(d, mine, all); }
  return b;
}
let loadItems = [], loadDate = null;
function openLoad(d, mine, all) {
  loadDate = d; loadItems = mine.map(t => ({ t, exists: tplExists(t, all), on: !tplExists(t, all) }));
  $("ldTitle").textContent = `${md(d)} (${dow(d)}) 내 고정 수업 불러오기`; $("ldErr").textContent = "";
  drawLoad(); show($("loadSheet"));
}
function drawLoad() {
  const box = $("ldList"); box.innerHTML = "";
  loadItems.forEach(it => {
    const t = it.t; const row = document.createElement("label"); row.className = "ldrow" + (it.exists ? " off" : "");
    row.innerHTML = `<input type="checkbox" ${it.on ? "checked" : ""} ${it.exists ? "disabled" : ""}><span class="ldt">${t.start}</span><span class="ldc"><b></b><span>${LABEL[t.type]} · ${esc(TN(t.trainer))}${it.exists ? " · 이미 있음" : ""}</span></span>`;
    row.querySelector("b").textContent = tplWho(t);
    row.querySelector("input").onchange = e => { it.on = e.target.checked; drawLoadBtn(); };
    box.appendChild(row);
  });
  drawLoadBtn();
}
function drawLoadBtn() { const n = loadItems.filter(i => i.on && !i.exists).length; $("ldGo").textContent = n ? `${n}개 추가` : "추가할 수업 없음"; $("ldGo").disabled = !n; }
$("ldGo").onclick = () => busy($("ldGo"), async () => {
  const todo = loadItems.filter(i => i.on && !i.exists); let done = 0;
  for (const { t } of todo) {
    const row = { type: t.type, branch_id: curBranch, trainer_id: t.trainer, date: loadDate, start_time: t.start, team: t.type === "team" ? t.team : null, grade: t.type === "team" ? t.grade : null };
    const { data, error } = await sb.from("lessons").insert(row).select("id").single();
    if (error) { $("ldErr").textContent = friendly(error); break; }
    const ids = t.type === "team" ? [] : t.ids.filter(id => A(id) && !A(id).archived);
    if (ids.length) { const { error: e2 } = await sb.from("lesson_athletes").insert(ids.map(a => ({ lesson_id: data.id, athlete_id: a }))); if (e2) { $("ldErr").textContent = friendly(e2); break; } }
    done++;
  }
  if (done) { if (done === todo.length) close(); toast(`고정 수업 ${done}개를 추가했어요`); refresh(); }
});

function render() {
  $("tabS").setAttribute("aria-pressed", tab === "sched"); $("tabR").setAttribute("aria-pressed", tab === "roll");
  $("hMgr").hidden = !mgrOpen;
  if (mgrOpen) { ["hRank", "hWork", "hTpl", "hSched", "hList", "hLedger"].forEach(id => $(id).hidden = true); $("fab").hidden = true; renderMgr(); return; }
  $("hRank").hidden = !rankOpen;
  $("hWork").hidden = !workOpen; $("hTpl").hidden = !tplOpen || workOpen;
  $("hSched").hidden = tab !== "sched" || workOpen || tplOpen; $("hList").hidden = !(tab === "roll" && !ledgerId) || workOpen || tplOpen || rankOpen; $("hLedger").hidden = !(tab === "roll" && ledgerId) || workOpen || tplOpen || rankOpen;
  $("fab").hidden = tab === "roll" && !!ledgerId; $("fab").textContent = tab === "sched" ? "+ 수업 추가" : "+ 선수 등록";
  $("mgrBtn").hidden = !isAdmin(); $("expBtn").hidden = !managedBranches().length;
  if (rankOpen) { $("fab").hidden = true; renderRank(); return; }
  if (workOpen) { $("fab").hidden = true; renderWork(); return; }
  if (tplOpen) { $("fab").hidden = false; $("fab").textContent = "+ 고정 수업 추가"; renderTpl(); return; }
  if (tab === "sched") renderSched(); else if (ledgerId) renderLedger(); else renderList();
}

/* ---------- 시트 공통 ---------- */
let openSheetEl = null;
/* 휴대폰 뒤로가기: 창을 열거나 선수 장부로 들어갈 때 기록을 하나 쌓고, 뒤로가기를 누르면 그 기록을 되돌림 */
let ignorePop = false;
const layer = () => history.state && history.state.layer;
function hideSheet() { if (openSheetEl) openSheetEl.hidden = true; openSheetEl = null; $("scrim").hidden = true; if (updatePending) setTimeout(tryReload, 300); else if (livePending) setTimeout(liveApply, 300); }
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
  if (mgrDetail && layer() !== "mgrd") { mgrDetail = null; if (layer() === "mgr") { render(); return; } }
  if (mgrOpen && layer() !== "mgr" && layer() !== "mgrd") { mgrOpen = false; mgrDetail = null; render(); return; }
  if (rankDiv && layer() !== "rankdiv") { rankDiv = null; if (layer() === "rank") { render(); return; } }
  if (rankOpen && layer() !== "rank" && layer() !== "rankdiv") { rankOpen = false; rankDiv = null; render(); return; }
  if (workOpen && layer() !== "work") { workOpen = false; render(); return; }
  if (tplOpen && layer() !== "tpl") { tplOpen = false; render(); return; }
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
  fillRoundInfo(a, l);
}
/* 출석 창 위쪽: "이번 출석 시" 회차와 남은 횟수 */
async function fillRoundInfo(a, l) {
  const box = $("atRound"); box.textContent = "회차 확인 중…"; box.className = "roundinfo";
  try {
    const ls = (await fetchAthleteLessons(a.id)).sort(sortL);
    if (atL !== l || atA !== a) return; // 그사이 다른 창을 염
    // 이 수업을 '출석'으로 가정해서 계산
    const sim = ls.map(x => x.id === l.id ? { ...x, att: { ...x.att, [a.id]: { s: "present", deduct: true, memo: "" } } } : x);
    if (!sim.some(x => x.id === l.id)) sim.push({ ...l, att: { [a.id]: { s: "present", deduct: true, memo: "" } } });
    sim.sort(sortL);
    const map = rounds(a, sim);
    const used = sim.filter(x => charged(x.att[a.id])).length;
    const now = map[l.id] || "";
    let text = "", cls = "";
    if (a.plan === "pass") {
      const total = paysOf(a).filter(p => p.kind === "pass" || p.kind === "trial" || p.kind === "carry").reduce((n, p) => n + p.count - (p.used || 0), 0);
      const left = total - used;
      if (now === "초과" || !total) { text = `결제된 회차가 없어요 · 출석하면 ${total ? -left + "회 초과" : "초과"}`; cls = "bad"; }
      else { text = `이번 출석 시 ${now === "체험" ? "체험수업" : now} · 남은 ${left}회`; cls = left === 0 ? "bad" : left === 1 ? "warn" : ""; if (left === 0) text += " (재등록 필요)"; }
    } else if (a.plan === "monthly") {
      text = `이번 출석 시 ${now} · 월 정산`;
    } else {
      const paidL = new Set(paysOf(a).filter(p => p.kind === "visit").map(p => p.lessonId));
      const unpaid = sim.filter(x => charged(x.att[a.id]) && !paidL.has(x.id)).length;
      text = `이번 출석 시 ${now} · 미결제 ${unpaid}건`; cls = unpaid ? "warn" : "";
    }
    box.textContent = text; box.className = "roundinfo " + cls;
  } catch (e) { box.textContent = ""; }
}
$("atSave").onclick = () => busy($("atSave"), async () => {
  const row = !atS ? { status: null, deduct: false, memo: "" }
    : { status: atS, deduct: atS === "present" ? true : atS === "same" ? $("atDeduct").checked : false, memo: $("atMemo").value.trim() };
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
  const carry = k === "carry";
  $("pCarryBox").hidden = !carry; $("pPriceBox").hidden = $("pMethodBox").hidden = $("pTotal").hidden = carry;
  $("pDateLbl").textContent = carry ? "기준일 (이 날짜 이후 수업부터)" : "결제일";
  if (carry) carryHint();
  if (!pEdit) {
    if (k === "trial" || k === "visit") $("pPrice").value = pA.price;
    if (k === "pass") $("pPrice").value = $("pCount").value ? pA.price * Number($("pCount").value) : "";
    if (k === "month") monthCalc();
  }
  if (k === "visit") fillLessons();
  showTotal();
}
function carryHint() {
  const t = Number($("pCarryTotal").value), u = Number($("pCarryUsed").value);
  $("pCarryHint").textContent = t > 0 && u >= 0 && u < t ? `남은 ${t - u}회 · 앱에서 다음 출석이 ${u + 1}/${t}회차로 기록돼요.` : "종이 출석부 기준으로 넣어주세요. 앱에서 다음 출석부터 이어서 세요.";
}
$("pCarryTotal").addEventListener("input", carryHint); $("pCarryUsed").addEventListener("input", carryHint);
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
  $("pCarryTotal").value = p && p.kind === "carry" ? p.count : ""; $("pCarryUsed").value = p && p.kind === "carry" ? p.used : "";
  pMethod = p && p.method !== "이월" ? p.method : "카드"; press("#pMethods button", "m", pMethod);
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
  if (!v.date) return $("pErr").textContent = "날짜를 입력해주세요.";
  if (pKind === "carry") {
    const t = Number($("pCarryTotal").value), u = Number($("pCarryUsed").value);
    if (!(t > 0)) return $("pErr").textContent = "회차권 총 횟수를 입력해주세요.";
    if ($("pCarryUsed").value === "" || !(u >= 0) || u >= t) return $("pErr").textContent = "이미 한 횟수는 0 이상, 총 횟수보다 작게 입력해주세요.";
    Object.assign(v, { count: t, used: u, price: 0, vat: 0, method: "이월" });
  } else v.used = 0;
  if (pKind !== "carry" && $("pPrice").value === "" || !(price >= 0)) return $("pErr").textContent = "금액을 입력해주세요.";
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
  const b = editing ? editing.branch : curBranch, pick = isManagerOf(b);
  const list = pick ? trainers.filter(t => (t.active && inBranch(trainerBr, t.id, b)) || t.id === sel) : trainers.filter(t => t.id === me.id || t.id === sel);
  $("fTrainer").innerHTML = list.map(t => `<option value="${t.id}">${esc(t.name)} 트레이너${t.active ? "" : " (퇴사)"}</option>`).join("");
  $("fTrainer").value = sel || (list.some(t => t.id === me.id) ? me.id : (list[0] || {}).id); $("fTrainer").disabled = !pick;
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
/* 학년: 1~3학년 버튼(여러 개) + 기타 직접 입력. 저장 형태 "1학년", "1·2학년", "1·2학년 U15" */
let grades = new Set(), gradeEtc = false;
function drawGrades() {
  document.querySelectorAll("#fGrades button").forEach(b => b.setAttribute("aria-pressed", b.dataset.g === "etc" ? gradeEtc : grades.has(b.dataset.g)));
  $("fGrade").hidden = !gradeEtc;
}
function setGrades(text) {
  grades = new Set(); gradeEtc = false; $("fGrade").value = "";
  let t = String(text || "").trim();
  const m = t.match(/^([1-3](?:\s*[,·.\/]\s*[1-3])*)\s*학년\s*(.*)$/);
  if (m) { m[1].split(/[,·.\/]/).forEach(x => grades.add(x.trim())); t = m[2].trim(); }
  if (t) { gradeEtc = true; $("fGrade").value = t; }
  drawGrades();
}
function gradeText() {
  const nums = ["1", "2", "3"].filter(g => grades.has(g));
  const etc = $("fGrade").value.trim();
  if (gradeEtc && !etc) return null;
  return [nums.length ? `${nums.join("·")}학년` : "", gradeEtc ? etc : ""].filter(Boolean).join(" ");
}
document.querySelectorAll("#fGrades button").forEach(b => b.onclick = () => {
  if (b.dataset.g === "etc") { gradeEtc = !gradeEtc; drawGrades(); if (gradeEtc) $("fGrade").focus(); }
  else { grades.has(b.dataset.g) ? grades.delete(b.dataset.g) : grades.add(b.dataset.g); drawGrades(); }
});
function openLesson(l, mode) {
  tplMode = mode === "tpl";
  editing = l || null; $("lTitle").textContent = (tplMode ? "고정 수업 " : "수업 ") + (l ? "수정" : "추가"); $("lDel").hidden = !l; $("lErr").textContent = "";
  $("fDateBox").hidden = tplMode; $("fWdBox").hidden = !tplMode;
  $("fWd").value = String(l && tplMode ? l.wd : tplWd);
  fillTrainers(l ? l.trainer : tplMode ? tplTrainer : null); $("fDate").value = l && !tplMode ? l.date : iso(cur); $("fStart").value = l ? l.start : "";
  picked = l ? [...l.ids] : []; $("fFind").value = "";
  $("fTeam").value = l && l.type === "team" ? l.team : ""; setGrades(l && l.type === "team" ? l.grade : "");
  setType(l ? l.type : "personal"); show($("lessonSheet"));
}
$("lDel").onclick = () => confirmBtn($("lDel"), "정말 삭제", () => busy($("lDel"), async () => {
  const { error } = await sb.from(tplMode ? "lesson_templates" : "lessons").delete().eq("id", editing.id);
  if (error) return $("lErr").textContent = friendly(error);
  close(); toast("삭제했어요"); refresh();
}));
$("lForm").onsubmit = e => { e.preventDefault(); busy($("lForm").querySelector(".primary"), async () => {
  if (!$("fTrainer").value) return $("lErr").textContent = "이 지점에 배정된 트레이너가 없어요. 트레이너 관리에서 지점을 배정해주세요.";
  const row = { type: fType, branch_id: editing ? editing.branch : curBranch, trainer_id: Number($("fTrainer").value), date: $("fDate").value, start_time: $("fStart").value, team: null, grade: null };
  if (tplMode) { delete row.date; if (!row.start_time) return $("lErr").textContent = "시작 시간을 입력해주세요."; }
  else if (!row.date || !row.start_time) return $("lErr").textContent = "날짜와 시작 시간을 입력해주세요.";
  if (fType === "personal" && picked.length !== 1) return $("lErr").textContent = "선수를 1명 선택해주세요.";
  if (fType === "group" && picked.length < 2) return $("lErr").textContent = "그룹 수업은 선수를 2명 이상 선택해주세요.";
  if (fType === "team") { row.team = $("fTeam").value.trim(); row.grade = gradeText(); if (row.grade === null) return $("lErr").textContent = "기타 학년 내용을 입력해주세요."; if (!row.team || !row.grade) return $("lErr").textContent = !row.team ? "학교 또는 팀을 입력해주세요." : "학년을 선택해주세요."; }
  const ids = fType === "team" ? [] : [...picked];
  if (tplMode) {
    const trow = { ...row, weekday: Number($("fWd").value), athlete_ids: ids };
    const { error } = editing ? await sb.from("lesson_templates").update(trow).eq("id", editing.id) : await sb.from("lesson_templates").insert(trow);
    if (error) return $("lErr").textContent = friendly(error);
    tplWd = trow.weekday; close(); toast("고정표에 저장했어요"); refresh(); return;
  }
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
    r.innerHTML = `<div style="display:grid;gap:4px;min-width:0"><input aria-label="트레이너 이름">${t.linked ? "" : `<input class="temail" type="email" inputmode="email" aria-label="가입할 이메일">`}<span class="hint">${t.linked ? esc(t.email) + " · " : ""}${t.role === "admin" ? "전체 관리자" : managerBr[t.id] && managerBr[t.id].size ? "지점 관리자" : "트레이너"} · ${!t.active ? "퇴사" : t.linked ? "가입 완료" : "가입 전"}</span>${t.role === "admin" ? "" : `<div class="brchips"></div><div class="brchips mgrchips"></div>`}</div>${self ? "" : `<div style="display:grid;gap:6px">${t.role === "admin" ? `<button type="button" class="trole">전체 관리자 해제</button>` : ""}${t.linked ? `<button type="button" class="tpw">비밀번호 초기화</button>` : ""}<button type="button" class="tact">${t.active ? "퇴사 처리" : "복귀"}</button><button type="button" class="tdel" style="color:var(--danger)">삭제</button></div>`}`;
    const chips = r.querySelector(".brchips");
    if (chips) branches.filter(b => b.active).forEach(br => {
      const c = document.createElement("button"); c.type = "button"; c.className = "brchip"; c.textContent = br.name;
      c.setAttribute("aria-pressed", inBranch(trainerBr, t.id, br.id));
      c.onclick = () => busy(c, async () => {
        const on = inBranch(trainerBr, t.id, br.id);
        const { error } = on ? await sb.from("trainer_branches").delete().eq("trainer_id", t.id).eq("branch_id", br.id)
                             : await sb.from("trainer_branches").insert({ trainer_id: t.id, branch_id: br.id });
        if (error) return $("trErr").textContent = friendly(error);
        (trainerBr[t.id] ||= new Set())[on ? "delete" : "add"](br.id); if (on && managerBr[t.id]) managerBr[t.id].delete(br.id); drawTrainers(); dayCache = {}; render();
      });
      chips.appendChild(c);
    });
    const mchips = r.querySelector(".mgrchips");
    if (mchips) branches.filter(b => b.active && inBranch(trainerBr, t.id, b.id)).forEach(br => {
      const on = !!(managerBr[t.id] && managerBr[t.id].has(br.id));
      const c = document.createElement("button"); c.type = "button"; c.className = "brchip mgr"; c.textContent = `${br.name} 지점 관리자`;
      c.setAttribute("aria-pressed", on);
      c.onclick = () => busy(c, async () => {
        const { error } = await sb.from("trainer_branches").update({ is_manager: !on }).eq("trainer_id", t.id).eq("branch_id", br.id);
        if (error) return $("trErr").textContent = friendly(error);
        (managerBr[t.id] ||= new Set())[on ? "delete" : "add"](br.id); drawTrainers();
        toast(on ? `${t.name} 님의 ${br.name} 지점 관리자를 해제했어요` : `${t.name} 님을 ${br.name} 지점 관리자로 지정했어요`);
      });
      mchips.appendChild(c);
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
    if (rb) rb.onclick = () => confirmBtn(rb, "정말 해제", () => busy(rb, async () => {
      const role = "trainer";
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
let aEditing = null, fPlan = "pass", aBr = new Set(), aGender = null;
function setGender(g) { aGender = g; press("#aGenders button", "x", g || ""); }
document.querySelectorAll("#aGenders button").forEach(b => b.onclick = () => setGender(b.dataset.x));
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
  setPlan(a ? a.plan : "pass"); setGender(a ? a.gender : null);
  const mg = !!a && canManageAthlete(a);
  $("aManage").hidden = !mg;
  if (mg) {
    $("aArchive").textContent = a.archived ? "복원하기" : "보관하기";
    const hasRec = paysOf(a).length > 0 || (ledgerId === a.id && ledgerLessons ? ledgerLessons.length > 0 : true);
    $("aDelete").hidden = hasRec;
    $("aManageHint").textContent = a.archived ? "복원하면 선수 목록과 수업 검색에 다시 나와요." : hasRec ? "기록이 있는 선수는 보관만 할 수 있어요. 보관해도 지난 출석·결제 기록은 남아요." : "기록이 없는 선수라 완전히 삭제할 수도 있어요.";
  }
  show($("athForm"));
}
$("aArchive").onclick = () => confirmBtn($("aArchive"), aEditing && aEditing.archived ? "정말 복원" : "정말 보관", () => busy($("aArchive"), async () => {
  const to = !aEditing.archived;
  const { error } = await sb.from("athletes").update({ archived: to }).eq("id", aEditing.id);
  if (error) return $("aErr").textContent = error.message.replace(/^.*?: /, "");
  close(); toast(to ? `${aEditing.name} 선수를 보관했어요` : `${aEditing.name} 선수를 복원했어요`); refresh();
}));
$("aDelete").onclick = () => confirmBtn($("aDelete"), "정말 삭제", () => busy($("aDelete"), async () => {
  const { error } = await sb.rpc("delete_athlete", { p_id: aEditing.id });
  if (error) return $("aErr").textContent = error.message.replace(/^.*?: /, "");
  const name = aEditing.name; close(); if (ledgerId) leaveLedger(); toast(`${name} 선수를 삭제했어요`); refresh();
}));
$("aForm").onsubmit = e => { e.preventDefault(); busy($("aForm").querySelector(".primary"), async () => {
  const name = $("aName").value.trim(), team = $("aTeam").value.trim() || "개인", price = Number($("aPrice").value), ageIn = $("aBirth").value;
  if (!name) return $("aErr").textContent = "이름을 입력해주세요.";
  if ($("aPrice").value === "" || !(price >= 0)) return $("aErr").textContent = "회당 단가를 입력해주세요.";
  if (ageIn !== "" && !(Number(ageIn) >= 1 && Number(ageIn) <= 100)) return $("aErr").textContent = "나이는 1~100 사이 숫자로 입력해주세요.";
  if (!aBr.size) return $("aErr").textContent = "지점을 하나 이상 선택해주세요.";
  if (!aGender) return $("aErr").textContent = "성별을 선택해주세요.";
  const row = { name, team, plan: fPlan, price, birth_year: ageIn === "" ? null : byOf(Number(ageIn)), gender: aGender };
  if (aEditing) {
    const { error } = await sb.from("athletes").update(row).eq("id", aEditing.id);
    if (error) return $("aErr").textContent = friendly(error);
    const before = athleteBr[aEditing.id] || new Set();
    const add = [...aBr].filter(b => !before.has(b)), del = [...before].filter(b => !aBr.has(b) && myBranches().some(x => x.id === b));
    if (add.length) { const { error: e2 } = await sb.from("athlete_branches").insert(add.map(b => ({ athlete_id: aEditing.id, branch_id: b }))); if (e2) return $("aErr").textContent = friendly(e2); }
    if (del.length) { const { error: e3 } = await sb.from("athlete_branches").delete().eq("athlete_id", aEditing.id).in("branch_id", del); if (e3) return $("aErr").textContent = friendly(e3); }
  } else {
    const { data: newId, error } = await sb.rpc("create_athlete", { p_name: name, p_team: team, p_plan: fPlan, p_price: price, p_birth_year: row.birth_year, p_branch_ids: [...aBr], p_gender: aGender });
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
// 노트북 브라우저: 날짜·월 칸 어디를 눌러도 달력이 열리게
document.querySelectorAll('input[type="date"], input[type="month"]').forEach(inp => inp.addEventListener("click", () => { try { inp.showPicker(); } catch (e) {} }));
$("datePick").onchange = e => { if (e.target.value) { cur = parse(e.target.value); render(); } };
$("vTrainer").onclick = () => setView("trainer"); $("vTime").onclick = () => setView("time"); $("vMine").onclick = () => setView("mine");
$("tabS").onclick = () => { mgrOpen = false; mgrDetail = null; rankOpen = false; rankDiv = null; if (tplOpen) leaveTpl(); if (workOpen) leaveWork(); if (ledgerId) leaveLedger(); tab = "sched"; render(); };
$("tabR").onclick = () => { mgrOpen = false; mgrDetail = null; rankOpen = false; rankDiv = null; if (tplOpen) leaveTpl(); if (workOpen) leaveWork(); if (ledgerId) leaveLedger(); tab = "roll"; render(); };
$("backBtn").onclick = leaveLedger;
$("aSearch").oninput = renderList;
$("branchSel").onchange = e => { setBranch(Number(e.target.value)); if (ledgerId) leaveLedger(); render(); };
$("fab").onclick = () => tplOpen ? openLesson(null, "tpl") : tab === "sched" ? openLesson() : openAthForm();
// 다른 트레이너가 바꾼 내용을 반영: 앱으로 돌아올 때 새로고침
let lastLoad = Date.now();
/* ---------- 실시간 반영 ----------
 * 다른 트레이너가 데이터를 바꾸면 신호를 받아 화면을 다시 불러옴.
 * 입력 창이 열려 있으면 미뤘다가 닫을 때 반영. 짧은 시간 여러 변경은 한 번에 처리. */
let liveCh = null, livePending = false, liveTimer = null;
function liveApply() {
  livePending = false;
  if (openSheetEl) { livePending = true; return; }
  if (Date.now() - lastRefresh < 2000) return; // 방금 내가 저장하면서 이미 새로 불러옴
  refresh();
}
function onLive() { clearTimeout(liveTimer); liveTimer = setTimeout(liveApply, 1200); }
function startLive() {
  stopLive();
  liveCh = sb.channel("solid-live").on("postgres_changes", { event: "*", schema: "public" }, onLive).subscribe();
}
function stopLive() { if (liveCh) { sb.removeChannel(liveCh); liveCh = null; } }

/* ---------- 자동 업데이트 ----------
 * 앱 파일(index.html, app.js, style.css)의 버전 표시(ETag)를 처음 열 때 기억해두고,
 * 앱으로 돌아올 때와 5분마다 바뀌었는지 확인. 바뀌었으면 입력 창이 닫혀 있을 때 새로고침. */
const APP_FILES = ["/", "/app.js", "/style.css", "/changelog.js"];
let baseTags = null, updatePending = false;
async function fileTags() {
  const tags = await Promise.all(APP_FILES.map(async f => {
    const r = await fetch(f, { method: "HEAD", cache: "no-store" });
    return r.headers.get("etag") || r.headers.get("last-modified") || "";
  }));
  return tags.join("|");
}
function busyTyping() {
  const el = document.activeElement;
  // 입력 창이 열려 있거나, 로그인 칸 등에 입력 중일 때 (검색창·지점 선택은 제외)
  return !!openSheetEl || (!!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.id !== "aSearch" && el.id !== "branchSel");
}
function tryReload() {
  if (!updatePending) return;
  if (busyTyping()) return; // 입력 중이면 창을 닫을 때까지 기다림
  location.reload();
}
async function checkUpdate() {
  try {
    const t = await fileTags();
    if (!t.replace(/\|/g, "")) return; // 버전 정보를 못 받으면 건너뜀
    if (baseTags === null) { baseTags = t; return; }
    if (t !== baseTags) { updatePending = true; tryReload(); }
  } catch (e) { /* 오프라인 등은 무시 */ }
}
checkUpdate();
document.addEventListener("focusout", () => { if (updatePending) setTimeout(tryReload, 300); });
setInterval(() => { if (!document.hidden) checkUpdate(); }, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
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
/* 버전·업데이트 내역 */
const LOG = window.SOLID_CHANGELOG || [];
const APP_VERSION = (LOG[0] || {}).v || "";
$("verNum").textContent = APP_VERSION;
$("verBtn").onclick = () => {
  $("verList").innerHTML = LOG.map((r, i) => {
    const [y, m, d] = r.d.split("-").map(Number);
    return `<div class="verrow${i === 0 ? " cur" : ""}"><div class="vh"><b>${esc(r.v)}</b>${i === 0 ? `<span class="chip ok">현재</span>` : ""}<span class="hint">${y}.${m}.${d}</span></div><ul>${r.items.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  }).join("");
  show($("verSheet"));
};
/* 톱니바퀴 설정 메뉴 */
function setGear(open) { $("gearMenu").hidden = !open; $("gearBtn").setAttribute("aria-expanded", open); }
$("gearBtn").onclick = e => { e.stopPropagation(); setGear($("gearMenu").hidden); };
$("gearMenu").addEventListener("click", e => { if (e.target.closest("button")) setGear(false); });
document.addEventListener("click", e => { if (!$("gearMenu").hidden && !e.target.closest(".gearwrap")) setGear(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") setGear(false); });
/* ---------- 데이터 내보내기 (관리자) ---------- */
let expScope = "cur"; // "all" 또는 지점 번호
function expRange(r) {
  const t = new Date(); let a, b;
  if (r === "this") { a = new Date(t.getFullYear(), t.getMonth(), 1); b = new Date(t.getFullYear(), t.getMonth() + 1, 0); }
  if (r === "last") { a = new Date(t.getFullYear(), t.getMonth() - 1, 1); b = new Date(t.getFullYear(), t.getMonth(), 0); }
  if (r === "year") { a = new Date(t.getFullYear(), 0, 1); b = new Date(t.getFullYear(), 11, 31); }
  $("expFrom").value = iso(a); $("expTo").value = iso(b);
}
document.querySelectorAll("#expPresets button").forEach(b => b.onclick = () => expRange(b.dataset.r));
$("expBranch").onchange = e => { expScope = e.target.value === "all" ? "all" : Number(e.target.value); };
$("expBtn").onclick = () => {
  const list = managedBranches(); if (!list.length) return;
  expRange("this"); expScope = list.some(b => b.id === curBranch) ? curBranch : list[0].id;
  $("expBranch").innerHTML = (isSuper() ? `<option value="all">전 지점</option>` : "") + list.map(b => `<option value="${b.id}">${esc(b.name)}${b.id === curBranch ? " (지금 지점)" : ""}</option>`).join("");
  $("expBranch").value = String(expScope);
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
    if (expScope === "all" && !isSuper()) throw new Error("전 지점 내보내기는 대표·앱 관리자만 할 수 있어요");
    if (expScope !== "all" && !isManagerOf(expScope)) throw new Error("관리하는 지점만 내보낼 수 있어요");
    const one = expScope !== "all";
    const scope = q => one ? q.eq("branch_id", expScope) : q;
    const [ls, ps, cks] = await Promise.all([
      fetchAll("lessons", "id,type,trainer_id,branch_id,date,start_time,team,grade,lesson_athletes(athlete_id,status,deduct,memo)",
        q => scope(q.gte("date", from).lte("date", to)).order("date").order("start_time")),
      fetchAll("payments", "*", q => scope(q.gte("date", from).lte("date", to)).order("date")),
      fetchAll("checkins", "*", q => scope(q.gte("work_date", from).lte("work_date", to)).order("work_date")),
    ]);
    const lessonRows = [];
    let cP = 0, cPv = 0, cS = 0, cSd = 0, cPr = 0, cU = 0;
    ls.forEach(r => {
      const l = mapLesson(r, r.lesson_athletes);
      const base = { 날짜: l.date, 요일: dow(l.date), 지점: BN(l.branch), 시작: l.start, 종료: endOf(l), 종류: LABEL[l.type], 트레이너: TN(l.trainer) };
      if (l.type === "team") { lessonRows.push({ ...base, "선수/학교": `${l.team} ${l.grade}`, 상태: "", 차감: "", 메모: "" }); return; }
      l.ids.forEach(id => {
        const x = l.att[id];
        if (!x) cU++; else if (x.s === "present") cP++; else if (x.s === "prev") cPv++; else if (x.s === "prior") cPr++; else { cS++; if (x.deduct) cSd++; }
        lessonRows.push({ ...base, "선수/학교": (A(id) || {}).name || "(삭제된 선수)", 상태: x ? ST[x.s] : "미체크", 차감: charged(x) ? "차감" : "", 메모: x ? x.memo : "" });
      });
    });
    const KIND = { trial: "체험수업", pass: "회차권", month: "월 정산", visit: "1회 결제", carry: "이전 회차 이어서" };
    const byMethod = {};
    const payRows = ps.map(mapPay).map(p => {
      const total = p.price + p.vat; if (p.kind !== "carry") byMethod[p.method] = (byMethod[p.method] || 0) + total;
      return { 결제일: p.date, 지점: BN(p.branch), 선수: (A(p.aid) || {}).name || "(삭제된 선수)", 항목: KIND[p.kind], 횟수: p.kind === "carry" ? `${p.count}회 중 ${p.used}회 사용` : p.kind === "pass" || p.kind === "month" ? p.count : "", "정산 월": p.month || "", "금액(부가세 별도)": p.price, 부가세: p.vat, "받은 금액": total, 결제수단: p.method, 메모: p.memo };
    });
    const pool = one ? athletes.filter(a => inBranch(athleteBr, a.id, expScope)) : athletes;
    const athRows = pool.slice().sort((x, y) => x.name.localeCompare(y.name, "ko")).map(a => ({
      이름: a.name, 소속: a.team, 나이: a.by ? ageOf(a.by) : "", 출생연도: a.by || "", 지점: [...(athleteBr[a.id] || [])].map(BN).join(", "), 결제방식: PLAN[a.plan], 회당단가: a.price, 현재상태: status(a).chip[1] }));
    const sum = [
      ["솔리드 피지컬 트레이닝 데이터"], ["기간", `${from} ~ ${to}`], ["지점", one ? BN(expScope) : "전 지점"], ["만든 날", todayIso()], [],
      ["결제 합계 (받은 금액)"], ...["카드", "계좌이체", "현금"].map(m => [m, byMethod[m] || 0]), ["합계", Object.values(byMethod).reduce((a, b) => a + b, 0)], [],
      ["출석 현황 (개인·그룹)"], ["출석", cP], ["출석 (이전 결제분)", cPv], ["당일취소", cS], ["  그중 차감", cSd], ["사전취소", cPr], ["미체크", cU], ["수업 수", ls.length],
    ];
    const wb = XLSX.utils.book_new();
    const add = (name, ws, widths) => { if (widths) ws["!cols"] = widths.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
    add("요약", XLSX.utils.aoa_to_sheet(sum), [22, 24]);
    add("수업·출석", XLSX.utils.json_to_sheet(lessonRows.length ? lessonRows : [{ 안내: "이 기간 수업이 없어요" }]), [11, 5, 10, 7, 7, 6, 14, 18, 9, 6, 24]);
    add("결제", XLSX.utils.json_to_sheet(payRows.length ? payRows : [{ 안내: "이 기간 결제가 없어요" }]), [11, 10, 10, 9, 6, 9, 14, 9, 12, 9, 24]);
    const ckRows = cks.map(c => ({ 날짜: c.work_date, 요일: dow(c.work_date), 지점: BN(c.branch_id), 트레이너: TN(c.trainer_id), 출근시간: hm(c.checked_at), 관리자수정: c.edited_by ? "예" : "" }));
    add("출근 기록", XLSX.utils.json_to_sheet(ckRows.length ? ckRows : [{ 안내: "이 기간 출근 기록이 없어요" }]), [11, 5, 10, 14, 9, 9]);
    const msAll = await fetchAll("measurements", "*", q => q.gte("measured_on", from).lte("measured_on", to).order("measured_on"));
    const poolIds = new Set(pool.map(a => a.id));
    const msRows = msAll.filter(m => poolIds.has(m.athlete_id)).map(m => { const a = A(m.athlete_id) || {}; return { 측정일: m.measured_on, 선수: a.name || "", 성별: a.gender ? GEN[a.gender] : "", "측정 당시 나이": m.age_at || "", "최대 속도(km/h)": Number(m.speed), 소속: a.team || "", 측정트레이너: TN(m.trainer_id), 메모: m.memo }; });
    add("측정 기록", XLSX.utils.json_to_sheet(msRows.length ? msRows : [{ 안내: "이 기간 측정 기록이 없어요" }]), [11, 10, 5, 12, 14, 16, 14, 20]);
    add("선수 목록", XLSX.utils.json_to_sheet(athRows.length ? athRows : [{ 안내: "선수가 없어요" }]), [10, 16, 6, 8, 16, 10, 10, 14]);
    const tag = one ? BN(expScope) : "전지점";
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
  if (!session) { me = null; stopLive(); $("appView").hidden = true; $("authView").hidden = false; return; }
  const { data, error } = await sb.from("trainers").select("id,name,email,role,position,active,user_id").eq("user_id", session.user.id).maybeSingle();
  if (error || !data || !data.active) {
    await sb.auth.signOut();
    $("authErr").textContent = data && !data.active ? "퇴사 처리된 계정이에요. 관리자에게 문의하세요." : "트레이너로 등록되지 않은 계정이에요.";
    return;
  }
  me = mapTrainer(data);
  $("meLabel").textContent = `${me.name} 트레이너`;
  $("meSub").textContent = "트레이너";
  $("authView").hidden = true; $("appView").hidden = false;
  $("list").innerHTML = `<div class="loading">불러오는 중…</div>`;
  try { await loadBase(); } catch (e) { toast(friendly(e), true); }
  lastLoad = Date.now(); render(); startLive();
}
let entered; // undefined → 첫 이벤트(로그인 안 된 상태 포함)는 항상 처리
sb.auth.onAuthStateChange((evt, session) => {
  const uid = session ? session.user.id : null;
  if (uid === entered && evt !== "SIGNED_OUT") return; // 토큰 갱신 등은 무시
  entered = uid; setTimeout(() => enter(session), 0);
});
