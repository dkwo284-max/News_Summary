// 오클랜드 → 레저 칩: 골프장·요트·카약·낚시를 지도 한 장에. 골프는 지도 + 회원권 비교표, 나머지는 지도에서 눌러 보는 방식.
// 데이터: data/leisure.json (시설·요금, 공식 페이지에서 바뀐 것만 갱신 — scripts/leisure.py), data/spots.json (보트 램프·부두·해변, OSM — scripts/spots.py).
// 요금은 "확인일"과 공식 링크를 함께 보여주고, 평점은 직접 적은 값(data) 또는 이 기기에서 입력한 값(localStorage)만 씁니다.
import { km, type GPData } from "./gpmap";
import { dayStats, verdict, type Activity, type Hourly, type Level } from "./leisure-score";

type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

type Kind = "golf" | "sailing" | "kayak" | "fishing";
type SpotType = "ramp" | "pier" | "beach";
interface Fee { label: string; kind: string; amount: number; period: string; quote?: string; source?: string }
interface Rating { v: number; n?: number; asof?: string }
interface Facility {
  id: string; kind: Kind; name: string; area?: string; ll: [number, number] | null; home?: string; gmaps: string;
  fees: Fee[]; status?: string; season?: string; note?: string; checked?: string; rating?: Rating; src?: string[];
}
interface Change { date: string; id: string; name: string; field: string; old: number | string; new: number | string }
interface LeisureData { updated_at: string; source: string; facilities: Facility[]; changes?: Change[] }
interface Spot { t: SpotType; n: string; ll: [number, number] }
interface SpotData { updated_at: string; spots: Spot[] }

export interface LeisureOpts {
  suburbs: string[];
  gp: GPData | null;
  fx: number | null | undefined;
  link: (url: string, label: string) => HTMLElement;
}

const KINDS: { key: Kind; label: string; icon: string; color: string; activity: Activity }[] = [
  { key: "golf", label: "골프", icon: "⛳", color: "#16a34a", activity: "golf" },
  { key: "sailing", label: "요트·세일링", icon: "⛵", color: "#2563eb", activity: "sailing" },
  { key: "kayak", label: "카약·패들", icon: "🛶", color: "#0d9488", activity: "kayak" },
  { key: "fishing", label: "낚시", icon: "🎣", color: "#7c3aed", activity: "fishing" },
];
const SPOTS: { key: SpotType; label: string; icon: string; color: string; hint: string }[] = [
  { key: "ramp", label: "보트 램프", icon: "⚓", color: "#475569", hint: "보트·카약 출발 지점으로 쓰이는 경사로예요. 사용 가능 여부·주차·요금·조석은 현장 표지판이나 오클랜드 시의회 정보를 확인하세요." },
  { key: "pier", label: "부두·낚시 포인트", icon: "🎣", color: "#a855f7", hint: "부두·낚시 장소로 지도에 올라 있는 곳이에요. 어종별 허용량·최소 크기를 꼭 확인하고, 안전·접근 제한 표지를 지키세요." },
  { key: "beach", label: "해변", icon: "🏖️", color: "#d97706", hint: "이름이 있는 해변이에요. 수영 전에는 Safeswim 에서 수질·안전 정보를 확인하세요." },
];
const CBD: [number, number] = [-36.8485, 174.7633];
const PERIOD: Record<string, string> = { year: "/년", season: "/시즌", month: "/월", week: "/주", day: "/일", hour: "/시간", round: "/라운드", once: " (1회)", person: "/인" };
const STATUS: Record<string, string> = { open: "가입 가능", waitlist: "대기 명단", closed: "신규 마감", unknown: "미확인" };
const FIELD: Record<string, string> = { adult: "성인 연회비", couple: "커플 연회비", family: "가족 연회비", joining: "입회비", greenfee18: "방문자 18홀", status: "가입 상태" };
const RATING_KEY = "daily-brief:leisure-ratings";
const WX_KEY = "daily-brief:leisure-wx";

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function localRatings(): Record<string, Rating> {
  try {
    return JSON.parse(localStorage.getItem(RATING_KEY) || "{}") as Record<string, Rating>;
  } catch {
    return {};
  }
}
function saveRating(id: string, r: Rating | null): void {
  try {
    const all = localRatings();
    if (r) all[id] = r;
    else delete all[id];
    localStorage.setItem(RATING_KEY, JSON.stringify(all));
  } catch {
    /* 저장 불가(시크릿 모드 등) — 화면에서만 반영 */
  }
}

const num = (n: number) => n.toLocaleString("en-NZ", { maximumFractionDigits: 2 });
const monthsAgo = (asof: string): number | null => {
  const m = /^(\d{4})-(\d{2})/.exec(asof);
  if (!m) return null;
  const now = new Date();
  return (now.getFullYear() - +m[1]) * 12 + (now.getMonth() + 1 - +m[2]);
};
const feeOf = (f: Facility, kind: string): Fee | undefined => f.fees.find((x) => x.kind === kind);
const yearly = (f: Facility, kind: string): number | null => {
  const x = feeOf(f, kind);
  return x && (x.period === "year" || x.period === "season") ? x.amount : null;
};
const kindInfo = (k: Kind) => KINDS.find((x) => x.key === k) ?? KINDS[0];

/** 골프 마커 색: 성인 연회비 구간(저·중·고) */
export function golfTier(fee: number | null): { color: string; label: string } {
  if (fee == null) return { color: "#9ca3af", label: "요금 미확인" };
  if (fee < 1500) return { color: "#16a34a", label: "연 $1,500 미만" };
  if (fee <= 2500) return { color: "#d97706", label: "연 $1,500~2,500" };
  return { color: "#dc2626", label: "연 $2,500 초과" };
}

export function describeChange(c: Change): string {
  if (c.field === "status") return `${c.name}: 가입 상태 ${STATUS[String(c.old)] ?? c.old} → ${STATUS[String(c.new)] ?? c.new}`;
  const pct = typeof c.old === "number" && typeof c.new === "number" && c.old > 0 ? ` (${c.new >= c.old ? "+" : ""}${(((c.new - c.old) / c.old) * 100).toFixed(1)}%)` : "";
  return `${c.name}: ${FIELD[c.field] ?? c.field} $${num(+c.old)} → $${num(+c.new)}${pct}`;
}

/** 가입 유형별 N년 총비용: 연회비(해당 유형) × 햇수 + 입회비 1회(성인 1인 입회비 기준) */
export function totalCost(f: Facility, household: "adult" | "couple" | "family", years: number): { yearly: number; total: number; joining: number } | null {
  const y = yearly(f, household);
  if (y == null) return null;
  const joining = feeOf(f, "joining")?.amount ?? 0;
  return { yearly: y, joining, total: y * years + joining };
}

function whenConnected(el: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => (el.isConnected ? resolve(true) : ++tries > 100 ? resolve(false) : setTimeout(tick, 50));
    tick();
  });
}

export async function leisureView(h: H, o: LeisureOpts): Promise<HTMLElement> {
  const root = h("div", { class: "leisure" });
  const [data, spotData] = await Promise.all([loadJson<LeisureData>("data/leisure.json"), loadJson<SpotData>("data/spots.json")]);
  const mine = localRatings();
  const facilities = data?.facilities ?? [];
  const spots = spotData?.spots ?? [];
  const on = new Set<Kind>(KINDS.map((k) => k.key));
  const spotOn = new Set<SpotType>();
  let sort = "dist";
  let krw = false;
  let radius = 0;
  let base = o.suburbs.find((s) => o.gp?.suburbs[s]) ?? "";
  let selected: { fac?: string; spot?: number } = {};
  let household: "adult" | "couple" | "family" = "adult";
  let years = 5;

  const money = (amount: number, period = "") => {
    const nz = `$${num(amount)}${PERIOD[period] ?? ""}`;
    return krw && o.fx ? `${nz} ≈ ${Math.round((amount * o.fx) / 10000).toLocaleString("ko-KR")}만원` : nz;
  };
  const origin = (): [number, number] => (base && o.gp?.suburbs[base]) || CBD;
  const dist = (ll: [number, number] | null) => (ll ? km(origin(), ll) : null);
  const ratingOf = (f: Facility): Rating | undefined => f.rating ?? mine[f.id];

  root.append(h("section", { class: "hood-card" },
    h("h2", {}, "🏌️ 레저 — 골프·요트·카약·낚시"),
    h("p", { class: "board-note" },
      "골프는 지도와 비교표를, 요트·카약·낚시는 지도에서 눌러 요금과 위치를 봅니다. 요금은 각 시설 공식 사이트의 값이고 ", h("b", {}, "확인일"),
      "을 함께 보여줘요(페이지가 바뀌었을 때만 새로 읽습니다). 금액은 NZD이며 클럽은 입회 심사·대기가 있을 수 있어 가입 전 공식 사이트나 전화로 꼭 확인하세요. 구글 평점은 약관상 자동 수집하지 않고, 직접 적은 값만 기준 시점과 함께 보여줘요.")));

  const today = h("section", { class: "hood-card leisure-today" }, h("h2", {}, "🌤️ 오늘·내일 가기 좋은가"), h("p", { class: "muted" }, "예보를 불러오는 중…"));
  root.append(today);

  const recent = (data?.changes ?? []).filter((c) => Date.now() - new Date(c.date).getTime() < 120 * 86400000).reverse();
  if (recent.length) {
    root.append(h("section", { class: "hood-card" }, h("h2", {}, "🔔 최근 요금·가입 상태 변경"),
      h("ul", { class: "leisure-fees" }, ...recent.slice(0, 8).map((c) => h("li", {}, describeChange(c), h("small", { class: "muted" }, ` (${c.date})`))))));
  }

  const controls = h("div", { class: "leisure-controls" });
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "레저 지도" });
  const panel = h("aside", { class: "eth-panel leisure-side", "aria-live": "polite" });
  const sizeBtn = h("button", { type: "button", class: "chip", "aria-pressed": "false" }, "⤢ 지도 크게");
  const stage = h("div", { class: "eth-stage leisure-stage" }, mapEl, panel);
  const legend = h("p", { class: "gp-legend" });
  const golfBox = h("div", {});
  const costBox = h("div", {});
  const listBox = h("div", {});
  const missBox = h("div", {});
  root.append(controls, h("div", { class: "leisure-mapbar" }, sizeBtn), stage, legend, golfBox, costBox, listBox, missBox);

  // ── 지도 ──
  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let map: import("leaflet").Map | null = null;
  let layer: import("leaflet").LayerGroup | null = null;
  let ring: import("leaflet").Circle | null = null;
  let fitted = false;

  const facColor = (f: Facility) => (f.kind === "golf" ? golfTier(yearly(f, "adult")).color : kindInfo(f.kind).color);

  function drawMap() {
    if (!L || !map) return;
    layer?.remove();
    ring?.remove();
    const group = L.layerGroup();
    const pts: [number, number][] = [];
    for (const f of facilities) {
      if (!on.has(f.kind) || !f.ll) continue;
      const sel = selected.fac === f.id;
      const m = L.circleMarker(f.ll, { radius: sel ? 11 : 8, color: sel ? "#111827" : "#ffffff", weight: sel ? 3 : 1.5, fillColor: facColor(f), fillOpacity: 0.95 });
      m.bindTooltip(`${kindInfo(f.kind).icon} ${f.name}`, { sticky: true });
      m.on("click", () => select({ fac: f.id }, false));
      m.addTo(group);
      pts.push(f.ll);
    }
    spots.forEach((s, i) => {
      if (!spotOn.has(s.t)) return;
      const info = SPOTS.find((x) => x.key === s.t)!;
      const sel = selected.spot === i;
      const m = L!.circleMarker(s.ll, { radius: sel ? 9 : 5, color: sel ? "#111827" : "#ffffff", weight: sel ? 3 : 1, fillColor: info.color, fillOpacity: 0.85 });
      m.bindTooltip(`${info.icon} ${s.n}`, { sticky: true });
      m.on("click", () => select({ spot: i }, false));
      m.addTo(group);
    });
    group.addTo(map);
    layer = group;
    if (radius > 0) ring = L.circle(origin(), { radius: radius * 1000, color: "#2563eb", weight: 1.5, fillOpacity: 0.05, dashArray: "6 6" }).addTo(map);
    if (!fitted && pts.length) {
      map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 12 });
      fitted = true;
    }
  }

  function select(sel: { fac?: string; spot?: number }, pan = true) {
    selected = sel;
    renderPanel();
    renderGolf();
    drawMap();
    if (pan && map) {
      const ll = sel.fac ? facilities.find((f) => f.id === sel.fac)?.ll : sel.spot != null ? spots[sel.spot]?.ll : null;
      if (ll) map.flyTo(ll, Math.max(map.getZoom(), 13), { duration: 0.6 });
      mapEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ── 상세 패널 ──
  function ratingForm(f: Facility): HTMLElement {
    const r = ratingOf(f);
    const v = h("input", { type: "number", step: "0.1", min: "1", max: "5", placeholder: "4.5", value: r ? String(r.v) : "", "aria-label": "평점" });
    const n = h("input", { type: "number", min: "0", placeholder: "리뷰 수", value: r?.n ? String(r.n) : "", "aria-label": "리뷰 수" });
    const save = h("button", { type: "button", class: "link-btn" }, "이 기기에 저장");
    save.addEventListener("click", () => {
      const val = parseFloat(v.value);
      if (!(val >= 1 && val <= 5)) return;
      const d = new Date();
      mine[f.id] = { v: val, n: +n.value || undefined, asof: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` };
      saveRating(f.id, mine[f.id]);
      renderAll();
    });
    const clear = h("button", { type: "button", class: "link-btn" }, "지우기");
    clear.addEventListener("click", () => { delete mine[f.id]; saveRating(f.id, null); renderAll(); });
    return h("div", { class: "leisure-rate" }, h("span", { class: "muted" }, "구글 지도 평점 직접 입력: "), v, n, save, mine[f.id] ? clear : null);
  }

  function breakEven(f: Facility): HTMLElement {
    const box = h("div", { class: "leisure-calc" });
    const member = yearly(f, "adult"), joining = feeOf(f, "joining")?.amount ?? 0, g18 = feeOf(f, "greenfee18")?.amount ?? null;
    if (member == null || g18 == null) {
      box.append(h("p", { class: "muted" }, "회원 vs 방문자 손익분기 계산은 성인 연회비와 방문자 18홀 요금이 둘 다 있을 때만 해요."));
      return box;
    }
    const rounds = h("input", { type: "number", min: "1", max: "365", value: "40", "aria-label": "연 라운드 수" });
    const yrs = h("input", { type: "number", min: "1", max: "30", value: "5", "aria-label": "입회비 나눌 햇수" });
    const out = h("p", {});
    const calc = () => {
      const n = Math.max(1, +rounds.value || 1), y = Math.max(1, +yrs.value || 1);
      const memberCost = member + joining / y, visitor = g18 * n, be = Math.ceil(memberCost / g18);
      out.replaceChildren(`회원 연 ${money(memberCost)}${joining ? ` (입회비 ${money(joining)}를 ${y}년에 나눔)` : ""} vs 방문자 ${n}라운드 ${money(visitor)} → `,
        h("b", {}, memberCost < visitor ? `회원이 ${money(visitor - memberCost)} 유리` : `방문자가 ${money(memberCost - visitor)} 유리`),
        ` · 손익분기 약 연 ${be}라운드`);
    };
    [rounds, yrs].forEach((i) => i.addEventListener("input", calc));
    calc();
    box.append(h("div", { class: "leisure-calc-in" }, "연 ", rounds, "라운드 · 입회비 ", yrs, "년 분할"), out,
      h("p", { class: "muted" }, "방문자 요금은 클럽·요일·제휴 여부에 따라 달라요. 카트·연습장·클럽 행사 비용은 포함하지 않았어요."));
    return box;
  }

  function facilityDetail(f: Facility): HTMLElement {
    const d = h("div", { class: "gp-info leisure-detail" });
    const ki = kindInfo(f.kind), dd = dist(f.ll), r = ratingOf(f);
    d.append(h("strong", {}, `${ki.icon} ${f.name}`),
      h("div", { class: "muted" }, `${f.area ?? ""}${dd != null ? ` · ${base || "시내"}에서 ${dd.toFixed(1)}km` : " · 지도 위치 미확인"}${r ? ` · ★${r.v.toFixed(1)}${r.n ? ` (${r.n.toLocaleString("ko-KR")}건)` : ""}${r.asof ? ` ${r.asof}` : ""}` : ""}`));
    const row = (x: Fee) => h("li", {}, h("strong", {}, money(x.amount, x.period)), ` ${x.label}`,
      x.source === "manual" ? h("small", { class: "muted" }, " (직접 입력)") : null,
      x.quote && x.source !== "manual" ? h("small", { class: "muted fee-quote" }, `원문: “${x.quote}”`) : null);
    const main = f.fees.filter((x) => x.kind !== "other"), extra = f.fees.filter((x) => x.kind === "other");
    if (!f.fees.length) d.append(h("p", { class: "muted" }, "요금을 자동으로 읽지 못했어요. 공식 사이트·전화로 확인하세요."));
    if (main.length) d.append(h("ul", { class: "leisure-fees" }, ...main.map(row)));
    if (extra.length) d.append(h("details", {}, h("summary", {}, `기타·다른 회원 유형 요금 ${extra.length}개`), h("ul", { class: "leisure-fees" }, ...extra.map(row))));
    const meta = [f.season ? `적용 시즌: ${f.season}` : "", f.status ? `상태: ${STATUS[f.status] ?? f.status}` : "", f.checked ? `확인일 ${f.checked}` : "확인 전"].filter(Boolean).join(" · ");
    d.append(h("p", { class: "muted" }, meta));
    if (f.note) d.append(h("p", {}, `ℹ️ ${f.note}`));
    const hist = (data?.changes ?? []).filter((c) => c.id === f.id);
    if (hist.length) d.append(h("div", { class: "leisure-hist" }, h("b", {}, "변경 기록"), ...hist.slice(-4).map((c) => h("div", {}, describeChange(c).replace(`${f.name}: `, ""), h("small", { class: "muted" }, ` (${c.date})`)))));
    if (f.kind === "golf") d.append(breakEven(f));
    d.append(ratingForm(f));
    const links = h("div", { class: "hood-links" }, o.link(f.gmaps, "🗺️ 구글 지도·리뷰"));
    if (f.home) links.append(o.link(f.home, "🌐 공식 사이트"));
    for (const s of (f.src ?? []).filter((u) => u !== f.home).slice(0, 2)) links.append(o.link(s, "📄 요금 페이지"));
    if (f.kind === "fishing") links.append(o.link("https://www.mpi.govt.nz/fishing-aquaculture/recreational-fishing/fishing-rules/auckland-kermadec-fishing-rules", "📋 낚시 규칙"));
    d.append(links);
    return d;
  }

  function spotDetail(s: Spot): HTMLElement {
    const info = SPOTS.find((x) => x.key === s.t)!;
    const dd = dist(s.ll);
    const d = h("div", { class: "gp-info leisure-detail" }, h("strong", {}, `${info.icon} ${s.n}`),
      h("div", { class: "muted" }, `${info.label}${dd != null ? ` · ${base || "시내"}에서 ${dd.toFixed(1)}km` : ""}`), h("p", {}, info.hint));
    const links = h("div", { class: "hood-links" }, o.link(`https://www.google.com/maps/search/?api=1&query=${s.ll[0]},${s.ll[1]}`, "🗺️ 구글 지도"));
    if (s.t === "beach") links.append(o.link("https://www.safeswim.org.nz", "🏊 Safeswim 수질·안전"));
    if (s.t === "pier") links.append(o.link("https://www.mpi.govt.nz/fishing-aquaculture/recreational-fishing/fishing-rules/auckland-kermadec-fishing-rules", "📋 낚시 규칙"));
    links.append(o.link("https://www.metservice.com/marine", "🌊 해상 예보"));
    d.append(links, h("p", { class: "muted" }, "위치는 OpenStreetMap 데이터라 정확한 진입로·사용 가능 여부는 현장에서 확인하세요."));
    return d;
  }

  function renderPanel() {
    const f = selected.fac ? facilities.find((x) => x.id === selected.fac) : undefined;
    const s = selected.spot != null ? spots[selected.spot] : undefined;
    if (f) panel.replaceChildren(facilityDetail(f));
    else if (s) panel.replaceChildren(spotDetail(s));
    else panel.replaceChildren(h("p", { class: "muted" }, "지도의 점을 누르거나 아래 표에서 클럽을 고르면 요금·평점·링크가 여기에 나와요."));
  }

  // ── 컨트롤 ──
  function renderControls() {
    const kindChips = KINDS.map((k) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(on.has(k.key)) }, `${k.icon} ${k.label}`);
      b.addEventListener("click", () => { on.has(k.key) ? on.delete(k.key) : on.add(k.key); renderAll(); });
      return b;
    });
    const spotChips = SPOTS.map((s) => {
      const n = spots.filter((x) => x.t === s.key).length;
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(spotOn.has(s.key)) }, `${s.icon} ${s.label}${spots.length ? ` (${n || "데이터 없음"})` : ""}`);
      b.addEventListener("click", () => { spotOn.has(s.key) ? spotOn.delete(s.key) : spotOn.add(s.key); renderAll(); });
      return b;
    });
    const baseSel = h("select", { "aria-label": "거리 기준 동네" }, h("option", { value: "" }, "기준: 시내(CBD)"),
      ...o.suburbs.filter((s) => o.gp?.suburbs[s]).map((s) => h("option", { value: s }, `기준: ${s}`)));
    baseSel.value = base;
    baseSel.addEventListener("change", () => { base = baseSel.value; renderAll(); });
    const radSel = h("select", { "aria-label": "반경 표시" }, h("option", { value: "0" }, "반경: 끔"), ...[5, 10, 20].map((r) => h("option", { value: String(r) }, `반경 ${r}km`)));
    radSel.value = String(radius);
    radSel.addEventListener("change", () => { radius = +radSel.value; drawMap(); });
    const sortSel = h("select", { "aria-label": "골프 표 정렬" },
      h("option", { value: "dist" }, "표: 가까운 순"), h("option", { value: "fee" }, "표: 연회비 낮은 순"),
      h("option", { value: "rating" }, "표: 평점 높은 순"), h("option", { value: "name" }, "표: 이름순"));
    sortSel.value = sort;
    sortSel.addEventListener("change", () => { sort = sortSel.value; renderGolf(); });
    const krwBox = h("input", { type: "checkbox", id: "leisure-krw" });
    krwBox.checked = krw;
    krwBox.disabled = !o.fx;
    krwBox.addEventListener("change", () => { krw = krwBox.checked; renderAll(); });
    controls.replaceChildren(
      h("div", { class: "chips", role: "group", "aria-label": "표시할 시설" }, ...kindChips),
      h("div", { class: "chips", role: "group", "aria-label": "표시할 장소" }, h("span", { class: "eth-rowlabel" }, "장소"), ...spotChips,
        spots.length ? null : h("small", { class: "muted" }, " (장소 데이터는 Actions → Fishing / kayak / swim spots 실행 후 표시)")),
      h("div", { class: "leisure-row" }, baseSel, radSel, sortSel,
        h("label", { class: "leisure-krw", for: "leisure-krw" }, krwBox, o.fx ? ` 원화 환산 (1NZD≈${Math.round(o.fx).toLocaleString("ko-KR")}원)` : " 원화 환산(환율 없음)")));
    const items = [
      ...KINDS.filter((k) => on.has(k.key) && k.key !== "golf").map((k) => `<i style="background:${k.color}"></i>${k.icon} ${k.label}`),
      ...SPOTS.filter((s) => spotOn.has(s.key)).map((s) => `<i style="background:${s.color}"></i>${s.icon} ${s.label}`),
    ];
    if (on.has("golf")) {
      const tiers = ([500, 2000, 3000, null] as (number | null)[]).map((f, i) => `<i style="background:${golfTier(f).color}"></i>${i === 0 ? "⛳ " : ""}${golfTier(f).label}`);
      items.unshift(...tiers);
    }
    legend.innerHTML = items.join(" &nbsp; ");
  }

  // ── 골프 표 ──
  const sortedGolf = (): Facility[] => {
    const items = facilities.filter((f) => f.kind === "golf");
    const val = (f: Facility): number => {
      if (sort === "fee") return yearly(f, "adult") ?? Number.POSITIVE_INFINITY;
      if (sort === "rating") return -(ratingOf(f)?.v ?? -1);
      return dist(f.ll) ?? Number.POSITIVE_INFINITY;
    };
    return [...items].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : val(a) - val(b)));
  };

  function ratingCell(f: Facility): HTMLElement {
    const r = ratingOf(f);
    if (!r) return h("td", { class: "muted" }, "—");
    const age = r.asof ? monthsAgo(r.asof) : null;
    return h("td", {}, `★${r.v.toFixed(1)}`, r.n ? h("small", {}, `${r.n.toLocaleString("ko-KR")}건`) : null,
      r.asof ? h("small", { class: age != null && age >= 9 ? "old" : "" }, `${r.asof}${age != null && age >= 9 ? " (오래됨)" : ""}`) : null);
  }

  function renderGolf() {
    if (!on.has("golf") || !facilities.some((f) => f.kind === "golf")) { golfBox.replaceChildren(); return; }
    const items = sortedGolf();
    const head = h("tr", {}, ...["클럽", "거리", "성인 1", "커플(2인)", "가족", "입회비", "평점"].map((t) => h("th", { scope: "col" }, t)));
    const body = items.map((f) => {
      const d = dist(f.ll);
      const cell = (k: string) => {
        const x = feeOf(f, k);
        return x ? h("td", {}, money(x.amount, k === "joining" ? "" : x.period === "year" ? "" : x.period)) : h("td", { class: "muted" }, "—");
      };
      const name = h("button", { type: "button", class: "leisure-name", "aria-expanded": String(selected.fac === f.id) }, f.name);
      name.addEventListener("click", () => select(selected.fac === f.id ? {} : { fac: f.id }));
      const state = f.status && f.status !== "open" && f.status !== "unknown" ? h("small", { class: "tag" }, STATUS[f.status]) : null;
      return h("tr", { class: selected.fac === f.id ? "cur" : "" },
        h("th", { scope: "row" }, name, h("small", { class: "muted" }, `${f.area ?? ""}${f.checked ? "" : " · 요금 미확인"}`), state),
        h("td", {}, d != null ? `${d.toFixed(1)}km` : "—"), cell("adult"), cell("couple"), cell("family"), cell("joining"), ratingCell(f));
    });
    golfBox.replaceChildren(h("section", { class: "hood-card" }, h("h2", {}, `⛳ 골프장 회원권 (${items.length}곳)`),
      h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-table" }, h("thead", {}, head), h("tbody", {}, ...body))),
      h("p", { class: "board-note" }, `클럽 이름을 누르면 지도가 그 클럽으로 이동하고 옆(모바일은 지도 아래) 패널에 전체 요금·손익분기 계산·평점 입력이 열려요. 연회비는 성인 1인 정규(풀 플레잉) 기준, 커플은 성인 2인 합계예요. “—”는 공식 페이지에서 확인되지 않은 항목입니다. 갱신 ${data?.updated_at ?? ""}. 정회원 가입은 입회 심사·대기 명단이 있는 곳이 많고, 일부 클럽은 요금을 공개하지 않아요.`)));
  }

  // ── 가입 비용 비교 ──
  function renderCost() {
    if (!facilities.length) { costBox.replaceChildren(); return; }
    const pool = facilities.filter((f) => (f.kind === "golf" || f.kind === "sailing") && on.has(f.kind));
    const rows = pool.map((f) => ({ f, c: totalCost(f, household, years) })).filter((x): x is { f: Facility; c: NonNullable<ReturnType<typeof totalCost>> } => x.c != null)
      .sort((a, b) => a.c.total - b.c.total);
    const hsel = h("select", { "aria-label": "가입 유형" }, h("option", { value: "adult" }, "성인 1인"), h("option", { value: "couple" }, "커플(성인 2인)"), h("option", { value: "family" }, "가족"));
    hsel.value = household;
    hsel.addEventListener("change", () => { household = hsel.value as typeof household; renderCost(); });
    const ysel = h("select", { "aria-label": "기간" }, ...[1, 3, 5, 10].map((y) => h("option", { value: String(y) }, `${y}년`)));
    ysel.value = String(years);
    ysel.addEventListener("change", () => { years = +ysel.value; renderCost(); });
    const last = (id: string) => (data?.changes ?? []).filter((c) => c.id === id && c.field === household).slice(-1)[0];
    costBox.replaceChildren(h("section", { class: "hood-card" }, h("h2", {}, "💰 가입 비용 비교"),
      h("div", { class: "leisure-row" }, hsel, ysel, h("span", { class: "muted" }, "골프·요트 클럽, 낮은 순")),
      rows.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-table" },
          h("thead", {}, h("tr", {}, ...["클럽", "연회비", "입회비", `${years}년 총액`, "상태"].map((t) => h("th", { scope: "col" }, t)))),
          h("tbody", {}, ...rows.map(({ f, c }) => {
            const ch = last(f.id);
            const name = h("button", { type: "button", class: "leisure-name" }, `${kindInfo(f.kind).icon} ${f.name}`);
            name.addEventListener("click", () => select({ fac: f.id }));
            return h("tr", {}, h("th", { scope: "row" }, name, ch ? h("small", { class: "tag" }, `${typeof ch.old === "number" && typeof ch.new === "number" ? (ch.new >= ch.old ? "▲" : "▼") : "변경"} ${ch.date}`) : null),
              h("td", {}, money(c.yearly)), h("td", {}, c.joining ? money(c.joining) : "—"), h("td", {}, h("b", {}, money(c.total))),
              h("td", {}, f.status && f.status !== "unknown" ? STATUS[f.status] : "미확인"));
          }))))
        : h("p", { class: "muted" }, "선택한 가입 유형의 요금이 확인된 클럽이 아직 없어요."),
      h("p", { class: "board-note" }, "총액 = 연회비 × 기간 + 입회비 1회(성인 1인 입회비 기준 — 커플·가족 입회비는 클럽마다 달라 문의가 필요해요). 물가·요금 인상, 카트·라운드·행사 비용은 빼고, 대기 명단이면 가입까지 시간이 걸려요.")));
  }

  // ── 나머지 목록·낚시 규칙·위치 미확인 ──
  function renderLists() {
    const others = facilities.filter((f) => f.kind !== "golf" && on.has(f.kind));
    const order = ["adult", "couple", "family", "social", "joining", "tour", "berth", "hire", "student", "junior", "greenfee18", "greenfee9", "other"];
    const rank = (x: Fee) => (order.includes(x.kind) ? order.indexOf(x.kind) : order.length);
    const cards = others.map((f) => {
      const d = dist(f.ll);
      const top = [...f.fees].sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((x) => `${x.label} ${money(x.amount, x.period)}`).join(" · ");
      const b = h("button", { type: "button", class: "leisure-name" }, `${kindInfo(f.kind).icon} ${f.name}`);
      b.addEventListener("click", () => select({ fac: f.id }));
      return h("li", {}, b, h("small", { class: "muted" }, ` ${f.area ?? ""}${d != null ? ` · ${d.toFixed(1)}km` : ""}`), h("div", {}, top || h("span", { class: "muted" }, "요금 미확인")));
    });
    listBox.replaceChildren(
      others.length ? h("details", { class: "hood-card eth-mine" }, h("summary", {}, `⛵🛶🎣 요트·카약·낚시 목록 (${others.length}곳, 눌러서 펼치기)`), h("ul", { class: "leisure-fees leisure-list" }, ...cards)) : h("span", {}),
      on.has("fishing") ? fishingRules() : h("span", {}));
    const missing = facilities.filter((f) => on.has(f.kind) && !f.ll);
    missBox.replaceChildren(missing.length ? h("section", { class: "hood-card" }, h("h2", {}, "📍 지도 위치를 못 찾은 곳"),
      h("ul", { class: "leisure-fees" }, ...missing.map((f) => {
        const b = h("button", { type: "button", class: "leisure-name" }, `${kindInfo(f.kind).icon} ${f.name}`);
        b.addEventListener("click", () => select({ fac: f.id }, false));
        return h("li", {}, b, h("small", { class: "muted" }, ` ${f.area ?? ""}`), " ", o.link(f.gmaps, "지도에서 찾기"));
      }))) : h("span", {}));
  }

  function fishingRules(): HTMLElement {
    return h("section", { class: "hood-card" }, h("h2", {}, "🎣 낚시 규칙 (꼭 확인)"),
      h("ul", { class: "leisure-fees" },
        h("li", {}, "바다 낚시: 일반적으로 면허는 필요 없지만 ", h("b", {}, "어종·지역별 1일 허용량(bag limit)과 최소 크기"), "가 있어요. 예) 스내퍼는 오클랜드 동해안 7마리·30cm 이상, 서해안 10마리·27cm 이상 (2024 기준, 바뀔 수 있음)."),
        h("li", {}, "민물 송어·연어 낚시는 Fish & Game 낚시 면허가 필요해요."),
        h("li", {}, "규칙 확인: 무료 앱 “NZ Fishing Rules”, 또는 어종 이름을 문자로 9889에 보내면 크기·허용량을 알려줘요."),
        h("li", {}, "보트: 구명조끼 착용, 출항 전 해상 예보·조석 확인, 출항 계획을 가족에게 알리기.")),
      h("div", { class: "hood-links" },
        o.link("https://www.mpi.govt.nz/fishing-aquaculture/recreational-fishing/fishing-rules/auckland-kermadec-fishing-rules", "📋 FNZ 오클랜드 낚시 규칙"),
        o.link("https://www.metservice.com/marine", "🌊 MetService 해상 예보"),
        o.link("https://www.coastguard.nz", "🛟 코스트가드 안전 정보"),
        o.link("https://fishandgame.org.nz", "🐟 Fish & Game 면허")));
  }

  function renderAll() {
    renderControls();
    renderPanel();
    renderGolf();
    renderCost();
    renderLists();
    drawMap();
  }

  if (!data) {
    root.append(h("section", { class: "hood-card" }, h("p", { class: "muted" }, "레저 데이터가 아직 없어요. GitHub Actions → “Leisure fees” 워크플로를 한 번 실행하면 생깁니다.")));
  }
  sizeBtn.addEventListener("click", () => {
    const big = stage.classList.toggle("big");
    sizeBtn.setAttribute("aria-pressed", String(big));
    sizeBtn.textContent = big ? "⤡ 지도 작게" : "⤢ 지도 크게";
    setTimeout(() => map?.invalidateSize(), 50);
  });
  renderAll();
  void forecast(h, today, origin());
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css"), whenConnected(mapEl)]).then(([mod, , ok]) => {
    if (!ok) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.86, 174.77], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    drawMap();
  }).catch(() => mapEl.replaceChildren(h("p", { class: "muted" }, "지도를 불러오지 못했어요 (오프라인).")));
  return root;
}

const lvIcon: Record<Level, string> = { good: "🟢", ok: "🟡", bad: "🔴" };

type WxPair = { fc: { hourly: Hourly }; mr: { hourly: Hourly } | null };
/** 예보는 30분 동안 이 기기에 저장해 두고 다시 쓴다(같은 좌표) — 칩을 오가며 불필요하게 다시 부르지 않는다 */
async function cachedForecast(at: [number, number]): Promise<WxPair> {
  const key = `${at[0].toFixed(2)},${at[1].toFixed(2)}`;
  try {
    const c = JSON.parse(localStorage.getItem(WX_KEY) || "null") as { key: string; t: number; v: WxPair } | null;
    if (c && c.key === key && Date.now() - c.t < 30 * 60 * 1000) return c.v;
  } catch {
    /* 무시 */
  }
  const [fc, mr] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${at[0]}&longitude=${at[1]}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=Pacific%2FAuckland&forecast_days=2`).then((r) => r.json()),
    fetch("https://marine-api.open-meteo.com/v1/marine?latitude=-36.78&longitude=174.80&hourly=wave_height&timezone=Pacific%2FAuckland&forecast_days=2").then((r) => r.json()).catch(() => null),
  ]);
  const v: WxPair = { fc, mr };
  try {
    localStorage.setItem(WX_KEY, JSON.stringify({ key, t: Date.now(), v }));
  } catch {
    /* 무시 */
  }
  return v;
}

async function forecast(h: H, slot: HTMLElement, at: [number, number]): Promise<void> {
  const title = h("h2", {}, "🌤️ 오늘·내일 가기 좋은가");
  const note = h("p", { class: "board-note" }, "Open-Meteo 예보로 8~18시를 계산한 참고용 점수예요(30분 동안 저장해 다시 씀). 바다에 나가기 전에는 반드시 MetService 해상예보·조석을 확인하세요. 💨 풍속(돌풍) 노트 · ☔ 강수확률 · 🌊 파고");
  try {
    const { fc, mr } = await cachedForecast(at);
    const days = dayStats(fc.hourly, mr?.hourly ?? null);
    if (!days.length) throw new Error("no data");
    const label = ["오늘", "내일"];
    const rows = KINDS.map((k) => h("tr", {}, h("th", { scope: "row" }, `${k.icon} ${k.label}`),
      ...days.slice(0, 2).map((d) => {
        const v = verdict(k.activity, d);
        return h("td", {}, `${lvIcon[v.level]} `, h("small", {}, v.text));
      })));
    slot.replaceChildren(title, h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-weather" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "활동"), ...days.slice(0, 2).map((d, i) => h("th", { scope: "col" }, `${label[i]} (${d.date.slice(5).replace("-", "/")})`)))),
      h("tbody", {}, ...rows))), note);
  } catch {
    slot.replaceChildren(title, h("p", { class: "muted" }, "예보를 불러오지 못했어요 (오프라인이거나 일시 오류)."), note);
  }
}
