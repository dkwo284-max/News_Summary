// 관심 동네·학교: 이 기기(localStorage)에만 저장. 동네별 렌트·집값은 매주 갱신되는 data/areas.json 에서.
import type { Brief, Item, SectionKey } from "./types";
import { loadPlan } from "./visa";

type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

export interface Watch {
  suburbs: string[];
  schools: string[];
}

interface RentRow { bonds: number; lower: number; median: number; upper: number }
interface SuburbData {
  district: string;
  rent: ({ name: string; period?: string; all?: RentRow } & Partial<Record<"house" | "apartment" | "flat", Record<string, RentRow>>>) | null;
}
export interface AreasData {
  updated_at: string;
  rent_source: string;
  value_source: string;
  suburbs: Record<string, SuburbData>;
  districts: Record<string, { name: string; avg_value: number }>;
}

const KEY = "daily-brief:areas";
const UOA = "University of Auckland City Campus, Auckland";

// 기본 관심 동네. 저장된 값이 이전 버전(v 없음)이면 한 번 이 기본값으로 바꾼다 (학교는 유지).
const DEFAULT_SUBURBS = ["Parnell", "Newmarket", "Milford"];
const DEFAULT_SCHOOLS = ["Milford School"];
const VERSION = 2;

export function loadWatch(): Watch {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    const schools = Array.isArray(raw.schools) ? raw.schools : [];
    if (raw.v !== VERSION) {
      const w = { suburbs: DEFAULT_SUBURBS, schools: schools.length ? schools : DEFAULT_SCHOOLS };
      saveWatch(w);
      return w;
    }
    return { suburbs: Array.isArray(raw.suburbs) ? raw.suburbs : [], schools };
  } catch {
    return { suburbs: DEFAULT_SUBURBS, schools: DEFAULT_SCHOOLS };
  }
}

export function saveWatch(w: Watch): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...w, v: VERSION }));
  } catch {
    /* ignore */
  }
}

const clean = (list: string[]) =>
  [...new Set(list.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s.length >= 3 && s.length <= 40))].slice(0, 6);

/** #areas=Milford,Takapuna&schools=Milford School 링크로 관심 동네를 저장하고 주소에서 지운다. */
export function importWatchFromHash(): boolean {
  if (!location.hash.startsWith("#areas=")) return false;
  const q = new URLSearchParams(location.hash.slice(1));
  saveWatch({ suburbs: clean((q.get("areas") ?? "").split(",")), schools: clean((q.get("schools") ?? "").split(",")) });
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

let cache: AreasData | null = null;
export async function loadAreas(): Promise<AreasData | null> {
  if (cache) return cache;
  try {
    const r = await fetch("data/areas.json", { cache: "no-cache" });
    if (r.ok) cache = (await r.json()) as AreasData;
  } catch {
    /* 오프라인 */
  }
  return cache;
}

// 최근 브리핑들에서 관심 동네·학교가 나온 기사 찾기
const wordRe = (w: string) => new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i");
export function mentions(item: Item, names: string[]): string[] {
  const hay = [item.original_title ?? "", item.title_ko, ...item.summary_ko, ...item.tags].join(" ");
  return names.filter((n) => wordRe(n).test(hay));
}

export interface Hit { item: Item; key: SectionKey; label: string; date: string; names: string[] }
export function findHits(briefs: Brief[], names: string[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const b of briefs) {
    for (const [key, sec] of Object.entries(b.sections) as [SectionKey, Brief["sections"][SectionKey]][]) {
      for (const item of sec.items) {
        if (item.carried_from || seen.has(item.id)) continue;
        const n = mentions(item, names);
        if (n.length) {
          seen.add(item.id);
          out.push({ item, key, label: sec.label, date: b.date, names: n });
        }
      }
    }
  }
  return out;
}

const money = (n: number) => `$${n.toLocaleString("en-NZ")}`;
const gmaps = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const transit = (from: string) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(UOA)}&travelmode=transit`;
const google = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;

// 아파트 방 수별 오클랜드 평균: 받아 둔 모든 동네의 중간값을 계약 건수로 가중 평균
const BEDS = ["2", "3", "4"];
function aptAverage(areas: AreasData | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of BEDS) {
    let sum = 0, n = 0;
    for (const s of Object.values(areas?.suburbs ?? {})) {
      const r = s.rent?.apartment?.[b];
      if (r) {
        sum += r.median * r.bonds;
        n += r.bonds;
      }
    }
    if (n) out[b] = Math.round(sum / n);
  }
  return out;
}

function vsAvg(h: H, v: number, avg: number | undefined): HTMLElement | string {
  if (!avg) return "";
  const pct = Math.round((v / avg - 1) * 100);
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return h("span", { class: `vs ${cls}` }, pct === 0 ? "평균" : `${pct > 0 ? "+" : ""}${pct}%`);
}

function aptCell(h: H, s: SuburbData | undefined, beds: string, avg: Record<string, number>): HTMLElement {
  const r = s?.rent?.apartment?.[beds];
  return r ? h("td", {}, money(r.median), " ", vsAvg(h, r.median, avg[beds])) : h("td", {}, "—");
}

/** 관심 동네 비교표 + 동네별 카드 + 관심 학교 카드 */
export function neighbourhoodView(h: H, w: Watch, areas: AreasData | null, hits: Hit[], fx: number | null | undefined,
  link: (url: string, label: string) => HTMLElement, openSettings: () => void): HTMLElement {
  const root = h("div", { class: "hood" });
  if (!w.suburbs.length && !w.schools.length) {
    const b = h("button", { type: "button", class: "link-btn" }, "관심 동네 입력하기");
    b.addEventListener("click", openSettings);
    root.append(h("section", { class: "hood-card" },
      h("h2", {}, "📍 내 동네"),
      h("p", { class: "muted" }, "설정에서 관심 동네(예: Milford, Takapuna)와 학교를 넣으면 렌트·집값 비교, 관련 뉴스, 통근 경로를 모아 보여줘요. 이 기기에만 저장됩니다."),
      b));
    return root;
  }
  // 1) 비교표
  if (w.suburbs.length) {
    const avg = aptAverage(areas);
    const head = h("tr", {}, h("th", { scope: "col" }, "아파트"), ...BEDS.map((b) => h("th", { scope: "col" }, `${b}룸`)));
    const rows = w.suburbs.map((name) => {
      const s = areas?.suburbs[name];
      return h("tr", {}, h("th", { scope: "row" }, name), ...BEDS.map((b) => aptCell(h, s, b, avg)));
    });
    rows.push(h("tr", { class: "avg-row" }, h("th", { scope: "row" }, "오클랜드 평균"),
      ...BEDS.map((b) => h("td", {}, avg[b] ? money(avg[b]) : "—"))));
    const period = w.suburbs.map((n) => areas?.suburbs[n]?.rent?.period).find(Boolean);
    root.append(h("section", { class: "hood-card" },
      h("h2", {}, "📊 관심 동네 비교"),
      h("div", { class: "table-wrap" }, h("table", { class: "hood-table" }, h("thead", {}, head), h("tbody", {}, ...rows))),
      h("p", { class: "board-note" },
        `아파트 주간 렌트 중간값${period ? ` (${period} 보증금 신고 기준)` : ""}, Tenancy Services. %는 오클랜드 ${Object.values(areas?.suburbs ?? {}).filter((x) => x.rent?.apartment).length}개 동네 평균(계약 건수 가중) 대비.`,
        areas ? ` ${areas.updated_at.slice(5).replace("-", "/")} 갱신.` : " 데이터는 다음 아침 실행 뒤 표시됩니다."),
    ));
  }
  // 2) 동네별 카드
  for (const name of w.suburbs) {
    const s = areas?.suburbs[name];
    const r = s?.rent;
    const my = hits.filter((x) => x.names.includes(name));
    const safety = my.filter((x) => x.key === "akl_safety").length;
    const card = h("section", { class: "hood-card" }, h("h2", {}, `📍 ${name}`));
    const apt = r?.apartment;
    const beds = BEDS.filter((b) => apt?.[b]);
    if (apt && beds.length) {
      const avg = aptAverage(areas);
      card.append(h("ul", { class: "hood-rents" }, ...beds.map((b) => {
        const x = apt[b];
        const month = fx ? ` · 한 달 ≈ ${Math.round((x.median * 52 / 12 * fx) / 10000).toLocaleString("ko-KR")}만 원` : "";
        return h("li", {}, h("strong", {}, `아파트 ${b}룸 ${money(x.median)}/주 `), vsAvg(h, x.median, avg[b]),
          h("span", { class: "muted" }, ` 대부분 ${money(x.lower)}~${money(x.upper)}${month} · ${x.bonds}건`));
      })));
    } else if (areas) {
      card.append(h("p", { class: "muted" }, "아파트 2룸 이상 렌트 자료가 없어요 (계약 건수가 적거나 다음 주 갱신 대기)."));
    }
    card.append(h("p", { class: "hood-news" },
      my.length ? `최근 2주 뉴스 ${my.length}건${safety ? ` (치안 ${safety}건)` : ""}` : "최근 2주 이 동네가 나온 뉴스는 없어요."));
    for (const x of my.slice(0, 4)) {
      const url = x.item.sources[0]?.url ?? "";
      card.append(h("p", { class: "hood-hit" }, h("span", { class: "sec-label" }, x.label), " ", url ? link(url, x.item.title_ko) : x.item.title_ko,
        h("span", { class: "muted" }, ` · ${x.date.slice(5).replace("-", "/")}`)));
    }
    card.append(h("div", { class: "hood-links" },
      link(transit(`${name}, Auckland`), "🚌 UoA 대중교통 경로"),
      link(`https://www.tenancy.govt.nz/rent-bond-and-bills/market-rent/?location=${encodeURIComponent(`Auckland - ${r?.name ?? name}`)}&action_doSearch=Search`, "🏠 렌트 상세"),
      link("https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz", "🚓 범죄 통계"),
      link("https://geomapspublic.aucklandcouncil.govt.nz/viewer/index.html", "🌊 침수·용도지역"),
      link(gmaps(`Korean grocery near ${name}, Auckland`), "🛒 한인마트"),
      link(gmaps(`GP medical centre ${name}, Auckland`), "🩺 근처 GP"),
    ));
    root.append(card);
  }
  // 3) 관심 학교
  if (w.schools.length) {
    const plan = loadPlan();
    let timing = "";
    if (plan.childBirth) {
      const b = new Date(`${plan.childBirth}T00:00:00`);
      const five = new Date(b.getFullYear() + 5, b.getMonth(), b.getDate());
      const check = new Date(five.getFullYear(), five.getMonth() - 6, five.getDate());
      const f = (d: Date) => d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
      timing = `자녀 만 5세 ${f(five)} — 늦어도 ${f(check)}부터 학군(zone) 안 주소 확보와 등록 서류를 준비하세요. 학군 안에 살면 그 학교 입학이 보장돼요.`;
    }
    for (const school of w.schools) {
      const my = hits.filter((x) => x.names.includes(school));
      const card = h("section", { class: "hood-card" }, h("h2", {}, `🎒 ${school}`));
      if (timing) card.append(h("p", { class: "hood-timing" }, timing));
      card.append(h("p", { class: "hood-news" }, my.length ? `최근 2주 뉴스 ${my.length}건` : "최근 2주 이 학교가 나온 뉴스는 없어요."));
      for (const x of my.slice(0, 3)) {
        const url = x.item.sources[0]?.url ?? "";
        card.append(h("p", { class: "hood-hit" }, url ? link(url, x.item.title_ko) : x.item.title_ko));
      }
      card.append(h("div", { class: "hood-links" },
        link(google(`${school} Auckland enrolment zone`), "🗺️ 학군(zone) 확인"),
        link(google(`site:ero.govt.nz ${school}`), "📋 ERO 평가 보고서"),
        link(google(`${school} Auckland school roll equity index site:educationcounts.govt.nz`), "📈 학생 수·형평성 지수"),
        link(gmaps(`${school}, Auckland`), "📍 지도"),
      ));
      root.append(card);
    }
  }
  return root;
}

export function renderWatchEditor(h: H, root: HTMLElement, known: string[], onChange: () => void): void {
  const w = loadWatch();
  root.replaceChildren();
  const list = h("datalist", { id: "suburb-list" }, ...known.map((k) => h("option", { value: k })));
  const sub = h("input", { type: "text", list: "suburb-list", placeholder: "예: Milford, Takapuna", "aria-label": "관심 동네 (쉼표로 구분)" });
  sub.value = w.suburbs.join(", ");
  const sch = h("input", { type: "text", placeholder: "예: Milford School", "aria-label": "관심 학교 (쉼표로 구분)" });
  sch.value = w.schools.join(", ");
  const save = () => {
    saveWatch({ suburbs: clean(sub.value.split(",")), schools: clean(sch.value.split(",")) });
    onChange();
  };
  sub.addEventListener("change", save);
  sch.addEventListener("change", save);
  root.append(list,
    h("label", { class: "visa-child" }, h("span", {}, "관심 동네 (쉼표로 구분, 최대 6곳)"), sub),
    h("label", { class: "visa-child" }, h("span", {}, "관심 학교 (선택)"), sch),
    h("small", { class: "muted" }, "이 기기에만 저장되고 서버로 보내지 않습니다. 렌트 비교는 자주 찾는 오클랜드 동네 50여 곳을 지원해요."));
}
