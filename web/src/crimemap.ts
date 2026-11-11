// 치안 지도: 뉴스에 보도된 오클랜드 사건(data/incidents.json) + 경찰 공식 통계(data/crime-stats.json).
type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

type Sev = "1" | "2" | "3" | "accident";
export interface Incident {
  id: string;
  date: string;
  title_ko: string;
  url: string;
  severity: Sev;
  crime: string;
  location: string;
  suburb: string;
  summary?: string; // 한 줄 설명 (지도 팝업)
  latlon?: [number, number];
  precision?: "exact" | "suburb" | "region" | "none"; // 위치 확실도: 거리·건물까지 / 동네까지 / 권역만 / 모름 (원문 대조 결과)
  region?: string; // central · west · south · east · north
  place_from?: string; // 후속 보도에서 위치를 채웠을 때 그 기사 id
}
export const REGION_KO: Record<string, string> = { central: "도심", west: "서부", south: "남부", east: "동부", north: "북부(노스쇼어)" };
/** 지도에 점으로 찍어도 되는가 (거리·건물까지 확인된 사건). 예전 기록(확실도 없음)은 좌표가 있으면 점으로 본다 */
export const pinned = (e: Incident) => !!e.latlon && (e.precision ?? "exact") === "exact";
/** 사건 위치를 한 줄로: 확실도에 맞춰 표현을 달리한다 */
export function placeLabel(e: { location: string; suburb: string; precision?: string; region?: string }): string {
  if (e.precision === "suburb") return `${e.suburb || e.location} 일대 (동네까지만 확인)`;
  if (e.precision === "region") return `오클랜드 ${REGION_KO[e.region ?? ""] ?? ""} (구체 위치 미공개)`;
  if (e.precision === "none") return "위치 미공개";
  return e.suburb || e.location;
}
interface IncidentData { updated_at: string; keep_days: number; incidents: Incident[] }
interface AreaStat { total: number; prev_total: number | null; by_type: Record<string, number>; monthly: number[] }
interface CrimeStats { period: string; areas: Record<string, AreaStat>; source: string }

const SEV_LABEL: Record<Sev, string> = { "1": "1급", "2": "2급", "3": "3급", accident: "사고" };
const SEV_DESC: Record<Sev, string> = { "1": "살인·흉기·총기·성범죄·납치·마약", "2": "강도·폭행·램레이드", "3": "절도·파손·사기", accident: "교통사고·화재·실종" };
const SEV_COLOR: Record<Sev, string> = { "1": "#dc2626", "2": "#ea580c", "3": "#eab308", accident: "#9ca3af" };
const SEV_WEIGHT: Record<Sev, number> = { "1": 5, "2": 3, "3": 1, accident: 0 };
const RADIUS_KM = 2;

async function getJSON<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
let incCache: IncidentData | null = null;
let statCache: CrimeStats | null | undefined;
export async function loadIncidents(): Promise<IncidentData | null> {
  return (incCache ??= await getJSON<IncidentData>("data/incidents.json"));
}
async function loadStats(): Promise<CrimeStats | null> {
  if (statCache === undefined) statCache = await getJSON<CrimeStats>("data/crime-stats.json");
  return statCache;
}

function km(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const s = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}
const daysAgo = (d: string) => (Date.now() - new Date(`${d}T00:00:00`).getTime()) / 86400000;
const inDays = (list: Incident[], from: number, to = 0) => list.filter((e) => daysAgo(e.date) < from && daysAgo(e.date) >= to);
const score = (list: Incident[]) => list.reduce((s, e) => s + SEV_WEIGHT[e.severity], 0);
const short = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function badge(h: H, s: Sev): HTMLElement {
  return h("span", { class: `sev sev-${s}` }, SEV_LABEL[s]);
}
// 동네별 위험 요약: 사건 종류별 건수 (접어 두었다가 펼쳐 보기)
function typeDetails(h: H, list: Incident[]): HTMLElement | null {
  if (!list.length) return null;
  const order: Sev[] = ["1", "2", "3", "accident"];
  const groups = new Map<string, { sev: Sev; n: number }>();
  for (const e of list) {
    const key = `${e.severity}|${e.crime || SEV_LABEL[e.severity]}`;
    groups.set(key, { sev: e.severity, n: (groups.get(key)?.n ?? 0) + 1 });
  }
  const rows = [...groups.entries()].sort((a, b) => order.indexOf(a[1].sev) - order.indexOf(b[1].sev) || b[1].n - a[1].n);
  return h("details", { class: "type-break" }, h("summary", {}, "종류별 보기"),
    h("ul", {}, ...rows.map(([k, v]) => h("li", {}, badge(h, v.sev), `${k.split("|")[1]} ${v.n}건`))));
}

// 지도 팝업: 등급·종류·날짜 한 줄 + 무슨 일이었는지 한 문장 + 기사 링크
function incBrief(h: H, e: Incident): HTMLElement {
  return h("li", { class: "inc-brief" },
    h("div", {}, badge(h, e.severity), h("strong", {}, e.crime || SEV_LABEL[e.severity]), h("span", { class: "muted" }, ` · ${short(e.date)}`)),
    h("p", {}, e.summary || e.title_ko),
    /^https?:/.test(e.url) ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", class: "inc-link" }, "기사 보기 ↗") : null);
}

// ── 같은 사건의 후속 보도 합치기 ──
const GEO_WORDS = new Set(["auckland", "central", "south", "north", "east", "west", "city", "cbd", "nz", "new", "zealand", "region"]);
const ROAD_WORDS = new Set(["street", "st", "road", "rd", "highway", "hwy", "avenue", "ave", "the"]);
const STOP_KO = /오클랜드|뉴질랜드|사건|혐의|체포|기소|경찰/g;

/** 장소 이름에서 동네·도로 일반어를 뺀 핵심 단어. 쉼표 앞(가장 구체적인 부분)만 쓴다. 비면 "Auckland" 처럼 장소를 특정하지 못하는 이름 */
function placeWords(location: string): Set<string> {
  const head = location.split(",")[0].toLowerCase().replace(/\bmt\b/g, "mount");
  return new Set(head.split(/[^a-zā-ū0-9]+/).filter((w) => w && !GEO_WORDS.has(w) && !ROAD_WORDS.has(w)));
}
function samePlace(a: string, b: string): boolean {
  const x = placeWords(a), y = placeWords(b);
  if (!x.size || !y.size) return false;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return [...small].every((w) => big.has(w));
}
function bigrams(s: string): Map<string, number> {
  const t = s.replace(STOP_KO, "").replace(/[^가-힣a-z0-9]/gi, "");
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}
/** 제목 글자쌍 겹침 (Dice 계수, 0~1) */
function titleSim(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  let hit = 0, nx = 0, ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [k, v] of x) hit += Math.min(v, y.get(k) ?? 0);
  return nx + ny ? (2 * hit) / (nx + ny) : 0;
}
const amounts = (s: string) => new Set(s.match(/\d+[천백]?만|\d+억/g) ?? []);

/** 같은 등급이고 4일 안에 나온 보도가, 구체적인 장소가 같거나 제목이 거의 같으면 한 사건의 후속 보도로 본다.
 *  금액이 서로 다르면(예: 코카인 4천만 vs 8천만 달러) 비슷한 제목이어도 다른 사건. "Auckland" 처럼 장소를 특정 못 하는 보도끼리는 장소만으로 합치지 않는다. */
export function sameIncident(a: Incident, b: Incident): boolean {
  if (a.severity !== b.severity || Math.abs(daysAgo(a.date) - daysAgo(b.date)) > 4) return false;
  const ma = amounts(a.title_ko), mb = amounts(b.title_ko);
  if (ma.size && mb.size && ![...ma].some((m) => mb.has(m))) return false;
  return samePlace(a.location, b.location) || titleSim(a.title_ko, b.title_ko) >= 0.6;
}

/** 위치 문구가 "오클랜드 어딘가" 수준인가 (scripts/incidents.py 의 vague_place 와 같은 규칙) — 카드·지도에서 동네로 표시하지 않는다 */
export function vaguePlace(q: string | undefined): boolean {
  const parts = (q ?? "").toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return true;
  const words = new Set("auckland city region greater central north south east west northern southern eastern western counties tamaki makaurau nz new zealand the street road school area shopping centre center container terminal suburb town local near a an unknown somewhere".split(" "));
  const head = (parts[0].replace(/'/g, "").match(/[a-zāēīōū']+/g) ?? []);
  return !head.length || head.every((w) => words.has(w)) || parts[0] === "counties manukau";
}

/** 후속 보도를 합치고(가장 먼저 보도된 기사를 남김), 동네 이름이 없거나 "Auckland" 뿐이면 가장 가까운 동네(3km 이내)로 채운다 */
function tidy(list: Incident[], suburbs: Record<string, [number, number]>): Incident[] {
  const out: Incident[] = [];
  for (const e of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
    const dup = out.find((x) => sameIncident(x, e));
    if (dup) {
      dup.latlon ??= e.latlon;
      continue;
    }
    let suburb = e.suburb;
    if ((!suburb || /^auckland$/i.test(suburb)) && e.latlon) {
      // 동네 목록에 도심이 없어서 CBD 사건이 Parnell 등으로 붙지 않도록 Auckland Central 을 후보에 넣는다
      const centres: Record<string, [number, number]> = { ...suburbs, "Auckland Central": [-36.8485, 174.7633] };
      const near = Object.entries(centres).map(([n, at]) => ({ n, d: km(at, e.latlon!) })).sort((a, b) => a.d - b.d)[0];
      suburb = near && near.d <= 3 ? near.n : suburb;
    }
    out.push({ ...e, suburb: /^auckland$/i.test(suburb) ? "" : suburb });
  }
  return out;
}

/** 관심 동네 반경 2km 안에서 최근 days 일 1급 사건 (알림 배너용) */
export function nearbySerious(data: IncidentData | null, homes: Record<string, [number, number]>, days = 7): { e: Incident; s: string; d: number }[] {
  const out: { e: Incident; s: string; d: number }[] = [];
  for (const e of inDays(tidy(data?.incidents ?? [], {}), days)) {
    if (e.severity !== "1" || !pinned(e)) continue;  // 동네·권역까지만 아는 사건은 거리 계산에 쓰지 않는다
    for (const [s, at] of Object.entries(homes)) {
      const d = km(at, e.latlon!);
      if (d <= RADIUS_KM) {
        out.push({ e, s, d });
        break;
      }
    }
  }
  return out;
}

export function safetyAlert(h: H, data: IncidentData | null, homes: Record<string, [number, number]>): HTMLElement | null {
  const hits = nearbySerious(data, homes);
  if (!hits.length) return null;
  return h("section", { class: "alerts", role: "status" },
    h("h2", {}, `🚨 관심 동네 근처 1급 사건 ${hits.length}건 (최근 7일)`),
    h("ul", {}, ...hits.map(({ e, s, d }) => h("li", {}, h("span", { class: "alert-kind" }, `${s} ${d.toFixed(1)}km`),
      /^https?:/.test(e.url) ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, `${e.crime || e.title_ko} · ${e.location}`) : e.title_ko))));
}

/** 치안 칩: 사건 지도 + 동네 위험 요약 + 공식 통계 */
export function safetySection(h: H, data: IncidentData | null, homes: Record<string, [number, number]>,
  allSuburbs: Record<string, [number, number]>): HTMLElement {
  const root = h("div", { class: "hood" });
  const all = tidy(data?.incidents ?? [], allSuburbs);
  // ── 1) 지도 ──
  let period = 30;
  let onlySerious = false;
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "오클랜드 사건 지도" });
  const chips = h("div", { class: "gp-tools" });
  const mk = (label: string, on: () => boolean, act: () => void) => {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(on()) }, label);
    b.addEventListener("click", () => {
      act();
      chips.querySelectorAll("button").forEach((x, i) => x.setAttribute("aria-pressed", String(states[i]())));
      draw();
    });
    return b;
  };
  const states: (() => boolean)[] = [() => period === 7, () => period === 30, () => period === 90, () => onlySerious];
  chips.append(mk("7일", states[0], () => (period = 7)), mk("30일", states[1], () => (period = 30)),
    mk("90일", states[2], () => (period = 90)), mk("1급만", states[3], () => (onlySerious = !onlySerious)));
  const summary = h("p", { class: "board-note" });
  // 위치가 권역까지만 알려졌거나 아예 공개되지 않은 사건: 지도에 찍지 않고 권역별 목록으로
  const vagueBox = h("details", { class: "inc-vague" });
  const drawVague = (list: Incident[]) => {
    vagueBox.hidden = !list.length;
    if (!list.length) return;
    const by = new Map<string, Incident[]>();
    for (const e of list) { const k = e.precision === "region" && e.region ? e.region : ""; by.set(k, [...(by.get(k) ?? []), e]); }
    const order = ["central", "north", "west", "south", "east", ""].filter((k) => by.has(k));
    vagueBox.replaceChildren(h("summary", {}, `📭 지도에 찍지 않은 사건 ${list.length}건 `, h("span", { class: "muted" }, order.map((k) => `${k ? REGION_KO[k] : "위치 미공개"} ${by.get(k)!.length}`).join(" · "))),
      ...order.map((k) => h("div", {}, h("p", { class: "hood-news" }, k ? `오클랜드 ${REGION_KO[k]} 어딘가 (기사에 권역만 나옴)` : "기사에 장소가 나오지 않음"),
        h("ul", { class: "inc-list" }, ...by.get(k)!.sort((a, b) => b.date.localeCompare(a.date)).map((e) => incBrief(h, e))))));
  };
  const legend = h("p", { class: "gp-legend" }, ...(["1", "2", "3", "accident"] as Sev[]).flatMap((s) =>
    [h("span", { class: "dot", style: `background:${SEV_COLOR[s]}` }), `${SEV_LABEL[s]} ${SEV_DESC[s]} `]),
    Object.keys(homes).length ? h("span", { class: "dot home" }) : null, Object.keys(homes).length ? `관심 동네(반경 ${RADIUS_KM}km) ` : null,
    h("span", { class: "dot", style: "background:transparent;border:1.5px dashed #6b7280" }), "점선 원 = 동네까지만 확인된 사건(정확한 지점 아님)");
  root.append(h("section", { class: "hood-card" }, h("h2", {}, "🗺️ 오클랜드 사건 지도"), chips, mapEl, legend, summary, vagueBox,
    h("p", { class: "board-note" }, "뉴스에 보도된 사건만 표시해요. 큰 사건은 많이, 흔한 절도는 적게 보도되므로 실제 범죄 빈도는 아래 경찰 공식 통계와 함께 보세요. 지도 © OpenStreetMap")));

  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let map: import("leaflet").Map | null = null;
  let layer: import("leaflet").LayerGroup | null = null;
  const shown = () => inDays(all, period).filter((e) => !onlySerious || e.severity === "1");
  function draw() {
    const list = shown();
    const n = (s: Sev) => list.filter((e) => e.severity === s).length;
    summary.textContent = `최근 ${period}일 보도 ${list.length}건 · 1급 ${n("1")} · 2급 ${n("2")} · 3급 ${n("3")} · 사고 ${n("accident")}` +
      ` · 지도: 점 ${list.filter(pinned).length}건(장소 확인) · 옅은 원 ${list.filter((e) => e.latlon && !pinned(e)).length}건(동네까지만) · 아래 목록 ${list.filter((e) => !e.latlon).length}건(위치 미상)`;
    drawVague(list.filter((e) => !e.latlon));
    if (!L || !map || !layer) return;
    layer.clearLayers();
    // 관심 동네 원은 먼저 그리고 클릭을 통과시킨다 (위에 그리면 도심 사건 점을 가려 눌리지 않음)
    for (const [s, at] of Object.entries(homes)) {
      L.circle(at, { radius: RADIUS_KM * 1000, color: "#1d4ed8", weight: 1, dashArray: "4 4", fillOpacity: 0.04, interactive: false }).addTo(layer);
      L.circleMarker(at, { radius: 5, weight: 2, color: "#1d4ed8", fillColor: "#93c5fd", fillOpacity: 0.9 }).bindTooltip(s, { direction: "top" }).addTo(layer);
    }
    // 동네까지만 확인된 사건: 정확한 지점이 아니므로 점 대신 반경 1km 의 옅은 원으로 "이 일대"임을 보여 준다
    const areaGroups = new Map<string, Incident[]>();
    for (const e of list) if (e.latlon && !pinned(e)) areaGroups.set(e.latlon.join(","), [...(areaGroups.get(e.latlon.join(",")) ?? []), e]);
    for (const g of areaGroups.values()) {
      const worst = (["1", "2", "3", "accident"] as Sev[]).find((s) => g.some((e) => e.severity === s))!;
      L.circle(g[0].latlon!, { radius: 1000, weight: 1.5, dashArray: "5 5", color: SEV_COLOR[worst], fillColor: SEV_COLOR[worst], fillOpacity: 0.12 })
        .bindPopup(h("div", { class: "gp-info" }, h("div", { class: "inc-place" }, `📍 ${g[0].suburb || g[0].location} 일대 · 정확한 지점 미공개${g.length > 1 ? ` · ${g.length}건` : ""}`),
          h("ul", { class: "inc-list" }, ...g.sort((a, b) => b.date.localeCompare(a.date)).map((e) => incBrief(h, e)))), { maxWidth: 260 })
        .bindTooltip(`${g[0].suburb || g[0].location} 일대 ${g.length}건 (동네까지만 확인)`, { direction: "top" })
        .addTo(layer);
    }
    const groups = new Map<string, Incident[]>();
    for (const e of list) if (pinned(e)) groups.set(e.latlon!.join(","), [...(groups.get(e.latlon!.join(",")) ?? []), e]);
    for (const g of groups.values()) {
      const worst = (["1", "2", "3", "accident"] as Sev[]).find((s) => g.some((e) => e.severity === s))!;
      L.circleMarker(g[0].latlon!, { radius: 6 + 3 * Math.sqrt(g.length), weight: 2, color: "#fff", fillColor: SEV_COLOR[worst], fillOpacity: 0.85 })
        .bindPopup(h("div", { class: "gp-info" }, h("div", { class: "inc-place" }, `📍 ${g[0].location}${g.length > 1 ? ` · ${g.length}건` : ""}`),
          h("ul", { class: "inc-list" }, ...g.sort((a, b) => b.date.localeCompare(a.date)).map((e) => incBrief(h, e)))), { maxWidth: 260 })
        // 마우스를 올리면 무슨 사건인지 바로 (누르면 설명 팝업)
        .bindTooltip(h("div", {}, ...g.map((e) => h("div", {}, `${SEV_LABEL[e.severity]} ${e.crime || e.title_ko} · ${short(e.date)}`))), { direction: "top", offset: [0, -6] })
        .addTo(layer);
    }
  }
  draw();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.86, 174.76], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    draw();
  }).catch(() => mapEl.replaceChildren(h("p", { class: "muted" }, "지도를 불러오지 못했어요 (오프라인).")));

  // ── 2) 동네 위험 요약 ──
  const recent = inDays(all, 30);
  const prev = inDays(all, 60, 30);
  const bySub = new Map<string, Incident[]>();
  for (const e of recent) if (e.suburb) bySub.set(e.suburb, [...(bySub.get(e.suburb) ?? []), e]);
  const top = [...bySub.entries()].map(([s, l]) => ({ s, l, sc: score(l) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 5);
  const radius = (at: [number, number], l: Incident[]) => l.filter((e) => pinned(e) && km(at, e.latlon!) <= RADIUS_KM);
  const centres = Object.values(allSuburbs);
  const avg = centres.length ? centres.reduce((s, at) => s + score(radius(at, recent)), 0) / centres.length : 0;
  const card = h("section", { class: "hood-card" }, h("h2", {}, "⚖️ 동네별 위험 요약 (최근 30일 보도)"));
  if (Object.keys(homes).length) {
    card.append(h("ul", { class: "risk-list" }, ...Object.entries(homes).map(([s, at]) => {
      const l = radius(at, recent);
      const p = radius(at, prev);
      const sc = score(l);
      // 건수가 적어 %는 과장되므로 점수 차이로 표현 (평균의 2배 이상 / 절반 이하)
      const cls = !l.length ? "down" : sc >= avg * 2 && sc - avg >= 3 ? "up" : sc <= avg / 2 ? "down" : "flat";
      return h("li", {}, h("strong", {}, `📍 ${s} `), h("span", { class: `vs ${cls}` },
        !l.length ? "보도 없음" : cls === "up" ? "평균보다 많음" : cls === "down" ? "평균보다 적음" : "평균 수준"),
        h("span", { class: "muted" }, ` 점수 ${sc} (평균 ${avg.toFixed(1)}) · 반경 ${RADIUS_KM}km ${l.length}건` +
          (l.length ? ` (1급 ${l.filter((e) => e.severity === "1").length} · 2급 ${l.filter((e) => e.severity === "2").length} · 3급 ${l.filter((e) => e.severity === "3").length})` : "") +
          ` · 이전 30일 ${p.length}건`), typeDetails(h, l));
    })));
  }
  card.append(h("p", { class: "hood-news" }, "보도가 많았던 동네 Top 5"));
  if (top.length) {
    card.append(h("ol", { class: "risk-top" }, ...top.map(({ s, l }) => {
      const before = prev.filter((e) => e.suburb === s).length;
      const arrow = l.length > before ? ` ▲${l.length - before}` : l.length < before ? ` ▼${before - l.length}` : "";
      return h("li", {}, h("strong", {}, s), ` ${l.length}건`, h("span", { class: "muted" }, ` (1급 ${l.filter((e) => e.severity === "1").length})${arrow}`),
        typeDetails(h, l));
    })));
  } else {
    card.append(h("p", { class: "muted" }, "최근 30일 보도된 범죄가 아직 없어요."));
  }
  card.append(h("p", { class: "board-note" }, `점수: 1급 5 · 2급 3 · 3급 1 (사고 제외). 평균은 자주 찾는 동네 ${centres.length}곳 반경 ${RADIUS_KM}km 평균. ▲▼는 이전 30일 대비.`));
  root.append(card);

  // ── 3) 경찰 공식 통계 ──
  const statSlot = h("div", {});
  root.append(statSlot);
  void loadStats().then((st) => statSlot.replaceChildren(statsCard(h, st, Object.keys(homes))));
  return root;
}

function statsCard(h: H, st: CrimeStats | null, watched: string[]): HTMLElement {
  const card = h("section", { class: "hood-card" }, h("h2", {}, "📊 경찰 공식 통계 (12개월 범죄 피해 건수)"));
  if (!st) {
    card.append(h("p", { class: "muted" }, "아직 공식 통계가 올라오지 않았어요. 경찰 데이터 사이트가 자동 수집을 막아 분기마다 한 번 CSV 를 내려받아 저장소 data/police/ 폴더에 올리면 여기에 동네별 실제 건수가 표시돼요."),
      h("div", { class: "hood-links" },
        h("a", { href: "https://github.com/dkwo284-max/News_Summary/blob/main/data/police/README.md", target: "_blank", rel: "noopener noreferrer" }, "📄 올리는 방법"),
        h("a", { href: "https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz", target: "_blank", rel: "noopener noreferrer" }, "🚓 policedata.nz")));
    return card;
  }
  const match = (s: string) => Object.entries(st.areas).filter(([n]) => n.toLowerCase().startsWith(s.toLowerCase()));
  const sum = (rows: [string, AreaStat][]) => rows.reduce((a, [, v]) => ({ total: a.total + v.total, prev: a.prev + (v.prev_total ?? 0),
    by: Object.entries(v.by_type).reduce((m, [t, c]) => ({ ...m, [t]: (m[t] ?? 0) + c }), a.by) }), { total: 0, prev: 0, by: {} as Record<string, number> });
  const totals = Object.values(st.areas).map((a) => a.total).sort((a, b) => a - b);
  const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;
  if (watched.length) {
    card.append(h("ul", { class: "risk-list" }, ...watched.map((s) => {
      const rows = match(s);
      if (!rows.length) return h("li", {}, h("strong", {}, `📍 ${s} `), h("span", { class: "muted" }, "통계에서 이 동네 이름을 찾지 못했어요"));
      const t = sum(rows);
      const chg = t.prev ? Math.round((t.total / t.prev - 1) * 100) : null;
      const types = Object.entries(t.by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(" · ");
      return h("li", {}, h("strong", {}, `📍 ${s} `), `${t.total.toLocaleString()}건`,
        chg !== null ? h("span", { class: `vs ${chg > 0 ? "up" : "down"}` }, ` 전년 ${chg > 0 ? "+" : ""}${chg}%`) : null,
        h("span", { class: "muted" }, ` · ${types}${rows.length > 1 ? ` (${rows.map(([n]) => n).join(", ")} 합계)` : ""}`));
    })));
  }
  const top = Object.entries(st.areas).sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  card.append(h("p", { class: "hood-news" }, "건수가 많은 지역 Top 10"),
    h("ol", { class: "risk-top" }, ...top.map(([n, v]) => h("li", {}, h("strong", {}, n), ` ${v.total.toLocaleString()}건`,
      h("span", { class: "muted" }, ` · ${Object.keys(v.by_type).slice(0, 2).join("·")}`)))),
    h("p", { class: "board-note" }, `기간 ${st.period}. 지역 중앙값 ${median.toLocaleString()}건. 인구·상권 규모를 반영하지 않은 건수라 도심·쇼핑센터 지역이 높게 나와요. 출처: NZ Police policedata.nz`));
  return card;
}
