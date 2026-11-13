// 오클랜드 → 레저 칩: 골프장·요트·카약·낚시를 지도 한 장에. 골프는 지도 + 회원권 비교표, 나머지는 지도에서 눌러 보는 방식.
// 데이터: data/leisure.json (시설·요금, 공식 페이지에서 바뀐 것만 갱신 — scripts/leisure.py), data/spots.json (보트 램프·부두·해변, OSM — scripts/spots.py).
// 요금은 "확인일"과 공식 링크를 함께 보여주고, 평점은 직접 적은 값(data) 또는 이 기기에서 입력한 값(localStorage)만 씁니다.
import { km, type GPData } from "./gpmap";
import { dayStats, verdict, type Activity, type Hourly, type Level } from "./leisure-score";
import { familyCost, openStatus, todayHours, visitBits, weekendDays, type Details, type OsmInfo, type WeekDay } from "./leisure-plus";

type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

type Kind = "golf" | "sailing" | "kayak" | "fishing" | "kids" | "swim" | "sports" | "walk" | "gym" | "tennis" | "climb" | "studio";
type SpotType = "ramp" | "pier" | "beach" | "playground" | "splash" | "gym" | "studio" | "tennis" | "basketball" | "outgym" | "skate";
interface Fee { label: string; kind: string; amount: number; period: string; quote?: string; source?: string }
interface Rating { v: number; n?: number; asof?: string }
interface Facility {
  id: string; kind: Kind; name: string; area?: string; ll: [number, number] | null; home?: string; gmaps: string;
  fees: Fee[]; status?: string; season?: string; note?: string; checked?: string; rating?: Rating; src?: string[];
  ages?: Age[]; indoor?: boolean; free?: boolean; chain?: boolean; brand?: string | null; details?: Details;
}
interface OsmData { updated_at: string; facilities: Record<string, OsmInfo> }
interface Change { date: string; id: string; name: string; field: string; old: number | string; new: number | string }
interface LeisureData { updated_at: string; source: string; facilities: Facility[]; changes?: Change[] }
interface Spot { t: SpotType; n: string; ll: [number, number]; x?: string }
interface SpotData { updated_at: string; spots: Spot[] }

export interface LeisureOpts {
  suburbs: string[];
  gp: GPData | null;
  fx: number | null | undefined;
  link: (url: string, label: string) => HTMLElement;
  week?: WeekDay[]; // 오늘 브리핑의 7일 예보 (주말 코스 추천용)
  compact?: boolean; // 브리프 안의 요약판: 누구와·주말 코스·오늘 날씨만 + '주말 나들이' 앱 링크
}

const KINDS: { key: Kind; label: string; icon: string; color: string; activity: Activity }[] = [
  { key: "golf", label: "골프", icon: "⛳", color: "#16a34a", activity: "golf" },
  { key: "sailing", label: "요트·세일링", icon: "⛵", color: "#2563eb", activity: "sailing" },
  { key: "kayak", label: "카약·패들", icon: "🛶", color: "#0d9488", activity: "kayak" },
  { key: "fishing", label: "낚시", icon: "🎣", color: "#7c3aed", activity: "fishing" },
  { key: "kids", label: "키즈카페·가족", icon: "🧸", color: "#ec4899", activity: "kids" },
  { key: "swim", label: "수영·워터", icon: "🏊", color: "#0ea5e9", activity: "swim" },
  { key: "sports", label: "어린이 스포츠·태권도", icon: "🥋", color: "#f59e0b", activity: "sports" },
  { key: "walk", label: "걷기·자전거 코스", icon: "🚶", color: "#65a30d", activity: "walk" },
  { key: "gym", label: "헬스·피트니스", icon: "🏋️", color: "#ef4444", activity: "gym" },
  { key: "tennis", label: "테니스·라켓 클럽", icon: "🎾", color: "#84cc16", activity: "tennis" },
  { key: "climb", label: "클라이밍", icon: "🧗", color: "#f97316", activity: "climb" },
  { key: "studio", label: "요가·필라테스", icon: "🧘", color: "#a78bfa", activity: "studio" },
];
const SPOTS: { key: SpotType; label: string; icon: string; color: string; hint: string }[] = [
  { key: "ramp", label: "보트 램프", icon: "⚓", color: "#475569", hint: "보트·카약 출발 지점으로 쓰이는 경사로예요. 사용 가능 여부·주차·요금·조석은 현장 표지판이나 오클랜드 시의회 정보를 확인하세요." },
  { key: "pier", label: "부두·낚시 포인트", icon: "🎣", color: "#a855f7", hint: "부두·낚시 장소로 지도에 올라 있는 곳이에요. 어종별 허용량·최소 크기를 꼭 확인하고, 안전·접근 제한 표지를 지키세요." },
  { key: "beach", label: "해변", icon: "🏖️", color: "#d97706", hint: "이름이 있는 해변이에요. 수영 전에는 Safeswim 에서 수질·안전 정보를 확인하세요." },
  { key: "playground", label: "놀이터", icon: "🛝", color: "#db2777", hint: "시의회·공원의 이름 있는 놀이터예요(대부분 무료). 설비·그늘·화장실은 현장 상황이 달라요." },
  { key: "splash", label: "스플래시·워터 플레이", icon: "💦", color: "#0891b2", hint: "물놀이 놀이터예요. 보통 여름철(11~3월)·날씨 좋은 날 운영하니 가기 전에 운영 여부를 확인하세요." },
  { key: "gym", label: "헬스장(지점)", icon: "🏋️", color: "#ef4444", hint: "OpenStreetMap에 올라 있는 헬스장·피트니스 지점이에요. 요금·24시간 여부·체험 여부는 각 체인 공식 사이트에서 확인하세요(위 카드에 주요 체인 요금을 정리했어요)." },
  { key: "studio", label: "요가·필라테스 스튜디오", icon: "🧘", color: "#a78bfa", hint: "요가·필라테스 스튜디오예요. 수업 시간·체험 가격은 각 스튜디오 사이트에서 확인하세요." },
  { key: "tennis", label: "테니스 클럽·코트", icon: "🎾", color: "#84cc16", hint: "이름 있는 테니스 클럽과, 클럽 밖의 코트(가까운 코트는 한 점으로 묶고 면 수를 표시)예요. 학교·사유·클럽 전용 코트가 섞여 있을 수 있어서 이용 가능 여부와 예약 방법은 현장·시의회 안내를 확인하세요." },
  { key: "basketball", label: "농구 코트", icon: "🏀", color: "#ea580c", hint: "공원·학교의 농구 코트예요(사유로 표시된 곳은 뺐어요). 개방 여부는 현장에서 확인하세요." },
  { key: "outgym", label: "야외 운동기구", icon: "💪", color: "#0d9488", hint: "공원의 야외 운동기구(피트니스 스테이션)예요. 보통 무료로 쓸 수 있어요." },
  { key: "skate", label: "스케이트 파크", icon: "🛹", color: "#64748b", hint: "스케이트·킥보드 파크예요. 보호장비를 챙기세요." },
];
type Age = "baby" | "kid" | "teen" | "adult" | "family";
const AGES: { key: Age | "all"; label: string; icon: string }[] = [
  { key: "all", label: "전체", icon: "✨" },
  { key: "baby", label: "영유아 0~4", icon: "👶" },
  { key: "kid", label: "초등 5~12", icon: "🧒" },
  { key: "teen", label: "청소년 13~17", icon: "🧑‍🎓" },
  { key: "family", label: "가족 함께", icon: "👨‍👩‍👧" },
  { key: "adult", label: "성인", icon: "🧑" },
];
const AGE_SHORT: Record<Age, string> = { baby: "👶영유아", kid: "🧒초등", teen: "🧑‍🎓청소년", adult: "🧑성인", family: "👨‍👩‍👧가족" };
/** 카드 섹션 묶음 (종류를 활동 성격별로) */
const GROUPS: { key: string; label: string; icon: string; kinds: Kind[]; spot?: SpotType }[] = [
  { key: "play", label: "실내 놀이·가족 나들이", icon: "🧸", kinds: ["kids"] },
  { key: "water", label: "물놀이·수영", icon: "💦", kinds: ["swim"] },
  { key: "sport", label: "어린이 스포츠·태권도", icon: "🥋", kinds: ["sports"] },
  { key: "outdoor", label: "걷기·자전거 코스", icon: "🚶", kinds: ["walk"] },
  { key: "sea", label: "요트·카약·낚시", icon: "⛵", kinds: ["sailing", "kayak", "fishing"] },
  { key: "gym", label: "헬스·피트니스 (체인 비교)", icon: "🏋️", kinds: ["gym"], spot: "gym" },
  { key: "tennis", label: "테니스·라켓 클럽", icon: "🎾", kinds: ["tennis"], spot: "tennis" },
  { key: "climb", label: "클라이밍", icon: "🧗", kinds: ["climb"] },
  { key: "studio", label: "요가·필라테스", icon: "🧘", kinds: ["studio"], spot: "studio" },
];
/** 물놀이·수영 묶음 안의 갈래 */
const WATER_SUBS = [
  { key: "pool", label: "🏊 수영장·레저센터 (실내·야외)" },
  { key: "splash", label: "💦 무료 물놀이 — 스플래시 패드·항구 풀" },
  { key: "school", label: "🏫 여름 학교 수영장 (1월 무료 개방)" },
  { key: "lesson", label: "🎓 수영 교실 전문 풀" },
];
const waterSub = (f: Facility): string => (f.id.startsWith("w-sch-") ? "school" : /수영 교실 전문/.test(f.note ?? "") ? "lesson" : f.free ? "splash" : "pool");
const FAV_KEY = "daily-brief:leisure-fav";
const AGE_KEY = "daily-brief:leisure-age";
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
const feeOf = (f: Facility, kind: string): Fee | undefined => f.fees.find((x) => x.kind === kind);
const yearly = (f: Facility, kind: string): number | null => {
  const x = feeOf(f, kind);
  return x && (x.period === "year" || x.period === "season") ? x.amount : null;
};
const kindInfo = (k: Kind) => KINDS.find((x) => x.key === k) ?? KINDS[0];
const DEFAULT_AGES: Record<Kind, Age[]> = {
  golf: ["teen", "adult"], sailing: ["kid", "teen", "adult", "family"], kayak: ["teen", "adult", "family"], fishing: ["kid", "teen", "adult", "family"],
  kids: ["baby", "kid", "family"], swim: ["baby", "kid", "teen", "adult", "family"], sports: ["kid", "teen"], walk: ["baby", "kid", "teen", "adult", "family"],
  gym: ["teen", "adult"], tennis: ["kid", "teen", "adult", "family"], climb: ["kid", "teen", "adult", "family"], studio: ["adult"],
};
const agesOf = (f: Facility): Age[] => (f.ages?.length ? f.ages : DEFAULT_AGES[f.kind]);
const isIndoor = (f: Facility): boolean => f.indoor ?? (f.kind === "kids" || f.kind === "sports");
const MEMBER_KINDS = new Set<Kind>(["gym", "tennis", "climb", "studio"]);
const ENTRY_KINDS = new Set(["child", "adult_entry", "lesson", "family_pass", "tour", "hire", "berth", "social"]);
/** 카드에 붙일 가격 배지: 무료 / $N~ (입장·수강 기준 최저가) / 연 $N (골프·클럽) / 요금 미확인 */
export function priceBadge(f: Facility): { text: string; cls: string } {
  if (f.kind === "walk" || f.free) return { text: "무료", cls: "free" };
  const note = f.note ?? "";
  if (f.fees.some((x) => x.kind === "adult_entry" && x.amount === 0)) return { text: "전 연령 무료", cls: "free" };
  if (/(어린이|16세).{0,24}무료/.test(note) && !/않|참여하지|다르/.test(note)) return { text: "어린이 무료", cls: "free" };
  if (MEMBER_KINDS.has(f.kind)) {
    const ms = f.fees.filter((x) => x.kind === "adult" && x.amount > 0 && (x.period === "week" || x.period === "month"));
    if (ms.length) {
      const per = (x: Fee) => (x.period === "week" ? x.amount * 4.33 : x.amount);
      const best = ms.reduce((a, b) => (per(a) <= per(b) ? a : b));
      return { text: `${best.period === "week" ? "주" : "월"} $${num(best.amount)}~`, cls: per(best) <= 45 ? "cheap" : "" };
    }
  }
  const entry = f.fees.filter((x) => ENTRY_KINDS.has(x.kind) && x.period !== "year" && x.amount > 0).map((x) => x.amount);
  if (entry.length) return { text: `$${num(Math.min(...entry))}~`, cls: Math.min(...entry) <= 10 ? "cheap" : "" };
  const y = yearly(f, "adult") ?? yearly(f, "social") ?? yearly(f, "family");
  if (y != null) return { text: `연 $${num(y)}`, cls: "" };
  if (!MEMBER_KINDS.has(f.kind) && /무료/.test(note) && !/않|참여하지|다르/.test(note)) return { text: "무료/할인", cls: "free" };
  return { text: "요금 미확인", cls: "na" };
}
export function loadFavs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || "[]") as string[];
  } catch {
    return [];
  }
}
function saveFavs(v: string[]): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(v));
  } catch {
    /* 무시 */
  }
}

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
  const [data, spotData, osmData] = await Promise.all([loadJson<LeisureData>("data/leisure.json"), loadJson<SpotData>("data/spots.json"), loadJson<OsmData>("data/leisure-osm.json")]);
  const osm = osmData?.facilities ?? {};
  /** 운영 시간(opening_hours 형식): OpenStreetMap 값 우선, 없으면 공식 페이지에서 읽어 검증한 값 */
  const hoursOf = (f: Facility) => osm[f.id]?.hours || f.details?.hours_osm || undefined;
  // 화면을 네 갈래로: 오늘 뭐 하지(기본) · 지도·전체 목록 · 회원권·비용 · 낚시·안전 규칙
  type View = "today" | "map" | "member" | "rules";
  const VIEWS: { key: View; label: string }[] = [{ key: "today", label: "✨ 오늘 뭐 하지" }, { key: "map", label: "🗺️ 지도·전체 목록" }, { key: "member", label: "💳 회원권·비용" }, { key: "rules", label: "🎣 낚시·안전 규칙" }];
  const views = Object.fromEntries(VIEWS.map((v) => [v.key, h("div", { class: "lview" })])) as unknown as Record<View, HTMLElement>;
  const viewBar = h("div", { class: "lview-bar", role: "tablist", "aria-label": "레저 화면" });
  let view: View = (() => { try { const v = localStorage.getItem("daily-brief:leisure-view") as View | null; return v && VIEWS.some((x) => x.key === v) ? v : "today"; } catch { return "today"; } })();
  const pickerBox = h("div", {});
  const weekendBox = h("div", {});
  const pref = <T extends string>(key: string, def: T, ok: readonly T[]): T => { try { const v = localStorage.getItem(`daily-brief:leisure-${key}`) as T | null; return v && ok.includes(v) ? v : def; } catch { return def; } };
  const savePref = (key: string, v: string) => { try { localStorage.setItem(`daily-brief:leisure-${key}`, v); } catch { /* 무시 */ } };
  let who = pref("who", "kids", ["kids", "couple", "solo"] as const);
  let budget = pref("budget", "any", ["free", "20", "any"] as const);
  let far = pref("far", "10", ["5", "10", "20", "0"] as const);
  const mine = localRatings();
  const facilities = data?.facilities ?? [];
  const spots = spotData?.spots ?? [];
  const on = new Set<Kind>(KINDS.map((k) => k.key));
  const spotOn = new Set<SpotType>();
  let sort = "dist";
  let krw = false;
  let radius = 0;
  let base = o.suburbs.find((x) => o.gp?.suburbs[x]) ?? ""; // 거리 기준: 관심 동네 첫 번째(좌표를 아는 곳), 없으면 시내(CBD)
  let selected: { fac?: string; spot?: number } = {};
  let household: "adult" | "couple" | "family" = "adult";
  let years = 5;
  let age: Age | "all" = (() => {
    try {
      const a = localStorage.getItem(AGE_KEY) as Age | "all" | null;
      return a && AGES.some((x) => x.key === a) ? a : "all";
    } catch {
      return "all";
    }
  })();
  let freeOnly = false, indoorOnly = false, nearOnly = false, viewOnly = true;
  let favs = loadFavs();
  const cmp = new Set<string>();
  let rainy: boolean | null = null; // 오늘 비·쌀쌀한 날씨인지 (날씨 추천에 사용, 예보 로드 후 채움)
  const visible = (f: Facility): boolean => {
    if (!on.has(f.kind)) return false;
    if (age !== "all" && !agesOf(f).includes(age)) return false;
    if (freeOnly && !["free", "cheap"].includes(priceBadge(f).cls)) return false;
    if (indoorOnly && !isIndoor(f)) return false;
    if (nearOnly) {
      const d = distF(f);
      if (d == null || d > 15) return false;
    }
    return true;
  };

  const money = (amount: number, period = "") => {
    const nz = `$${num(amount)}${PERIOD[period] ?? ""}`;
    return krw && o.fx ? `${nz} ≈ ${Math.round((amount * o.fx) / 10000).toLocaleString("ko-KR")}만원` : nz;
  };
  const origin = (): [number, number] => (base && o.gp?.suburbs[base]) || CBD;
  const dist = (ll: [number, number] | null) => (ll ? km(origin(), ll) : null);
  /** 시설까지 거리. 지점이 여러 곳인 체인은 같은 이름의 가장 가까운 지점(장소 데이터)까지. */
  const distF = (f: Facility): number | null => {
    if (!f.chain || !f.brand) return dist(f.ll);
    const key = f.brand.toLowerCase();
    let best: number | null = null;
    for (const sp of spots) {
      if ((sp.t !== "gym" && sp.t !== "studio") || !sp.n.toLowerCase().includes(key)) continue;
      const d = dist(sp.ll);
      if (d != null && (best == null || d < best)) best = d;
    }
    return best;
  };
  const ratingOf = (f: Facility): Rating | undefined => f.rating ?? mine[f.id];

  views.map.append(h("section", { class: "hood-card" },
    h("h2", {}, "🗺️ 지도·전체 목록"),
    h("p", { class: "board-note" },
      "골프는 지도와 비교표를, 요트·카약·낚시·키즈카페·수영장·어린이 스포츠(태권도)·걷기 코스는 지도에서 눌러 요금과 위치를 봅니다. 요금은 각 시설 공식 사이트의 값이고 ", h("b", {}, "확인일"),
      "을 함께 보여줘요(페이지가 바뀌었을 때만 새로 읽습니다). 금액은 NZD이며 클럽은 입회 심사·대기가 있을 수 있어 가입 전 공식 사이트나 전화로 꼭 확인하세요. 구글 평점은 약관상 자동 수집하지 않고, 직접 적은 값만 기준 시점과 함께 보여줘요.")));

  const today = h("section", { class: "hood-card leisure-today" }, h("h2", {}, "🌤️ 오늘·내일 가기 좋은가"), h("p", { class: "muted" }, "예보를 불러오는 중…"));

  const recent = (data?.changes ?? []).filter((c) => Date.now() - new Date(c.date).getTime() < 120 * 86400000).reverse();
  if (recent.length) {
    views.member.append(h("section", { class: "hood-card" }, h("h2", {}, "🔔 최근 요금·가입 상태 변경"),
      h("ul", { class: "leisure-fees" }, ...recent.slice(0, 8).map((c) => h("li", {}, describeChange(c), h("small", { class: "muted" }, ` (${c.date})`))))));
  }

  const controls = h("div", { class: "leisure-controls" });
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "레저 지도" });
  const panel = h("aside", { class: "eth-panel leisure-side", "aria-live": "polite" });
  const sizeBtn = h("button", { type: "button", class: "chip", "aria-pressed": "false" }, "⤢ 지도 크게");
  const stage = h("div", { class: "eth-stage leisure-stage" }, mapEl, panel);
  const legend = h("p", { class: "gp-legend" });
  const settingsBox = h("div", {});
  const picksBox = h("div", {});
  const favBox = h("div", {});
  const cmpBox = h("div", {});
  const golfBox = h("div", {});
  const costBox = h("div", {});
  const listBox = h("div", {});
  const missBox = h("div", {});
  void picksBox;
  views.today.append(pickerBox, weekendBox, today, favBox);
  views.map.append(controls, settingsBox, h("div", { class: "leisure-mapbar" }, sizeBtn), stage, legend, cmpBox, listBox, missBox);
  views.member.append(golfBox, costBox);
  if (o.compact) root.append(h("section", { class: "hood-card lhead" }, h("h2", {}, "🏖️ 이번 주말 뭐 하지?"),
    h("p", { class: "board-note" }, "주말 코스와 오늘 날씨만 보여 드려요. 지도·요금·회원권 비교·낚시 규칙은 '주말 나들이' 앱에 있어요."),
    h("a", { class: "chip", href: "./leisure.html", style: "display:inline-block;margin-top:6px;text-decoration:none" }, "🗺️ 주말 나들이 전체 보기 →")), pickerBox, weekendBox, today);
  else root.append(h("section", { class: "hood-card lhead" }, h("h2", {}, "🏖️ 레저·운동 — 오늘 뭐 하지?"),
    h("p", { class: "board-note" }, `시설 ${facilities.length}곳 · 요금 확인 ${facilities.filter((f) => f.fees.length || f.free).length}곳 · 운영 시간 확인 ${facilities.filter((f) => hoursOf(f) || f.details?.hours).length}곳. 요금은 공식 페이지에서 읽은 값과 확인일을, 운영 시간은 OpenStreetMap 등록 값(없으면 공식 페이지에 적힌 시간)을 씁니다. 가기 전에 공식 사이트로 한 번 더 확인하세요.`),
    viewBar), views.today, views.map, views.member, views.rules);

  // ── 지도 ──
  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let map: import("leaflet").Map | null = null;
  let layer: import("leaflet").LayerGroup | null = null;
  let ring: import("leaflet").Circle | null = null;
  let fitted = false;

  const facColor = (f: Facility) => (f.kind === "golf" ? golfTier(yearly(f, "adult")).color : kindInfo(f.kind).color);

  function facIcon(f: Facility, sel: boolean) {
    const fav = favs.includes(f.id) ? '<b class="lm-fav">★</b>' : "";
    return L!.divIcon({ className: "lm-wrap", html: `<span class="lm${sel ? " sel" : ""}" style="background:${facColor(f)}">${kindInfo(f.kind).icon}</span>${fav}`, iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  function drawMap() {
    if (!L || !map) return;
    layer?.remove();
    ring?.remove();
    const group = L.layerGroup();
    const pts: [number, number][] = [];
    for (const f of facilities) {
      if (!visible(f) || !f.ll) continue;
      const sel = selected.fac === f.id;
      const m = L.marker(f.ll, { icon: facIcon(f, sel), zIndexOffset: sel ? 1000 : 0, keyboard: true, title: f.name });
      m.bindTooltip(`${kindInfo(f.kind).icon} ${f.name} · ${priceBadge(f).text}`, { sticky: true });
      m.on("click", () => select({ fac: f.id }, false));
      m.addTo(group);
      pts.push(f.ll);
    }
    // 장소(놀이터·램프·해변 등)는 많아서 축소 상태에서는 칸으로 묶어 개수로 표시
    const z = map.getZoom();
    const cell = z >= 14 ? 0 : 360 / 2 ** z * 0.28;
    const cells = new Map<string, { i: number; s: Spot }[]>();
    spots.forEach((sp, i) => {
      if (!spotOn.has(sp.t)) return;
      const key = cell ? `${Math.floor(sp.ll[0] / cell)}:${Math.floor(sp.ll[1] / cell)}` : `u${i}`;
      cells.set(key, [...(cells.get(key) ?? []), { i, s: sp }]);
    });
    for (const list of cells.values()) {
      if (list.length > 1) {
        const lat = list.reduce((a, x) => a + x.s.ll[0], 0) / list.length, lon = list.reduce((a, x) => a + x.s.ll[1], 0) / list.length;
        const m = L.marker([lat, lon], { icon: L.divIcon({ className: "lm-wrap", html: `<span class="lm-cluster">${list.length}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) });
        m.on("click", () => map!.fitBounds(L!.latLngBounds(list.map((x) => x.s.ll)).pad(0.3), { maxZoom: 15 }));
        m.addTo(group);
        continue;
      }
      const { i, s: sp } = list[0];
      const info = SPOTS.find((x) => x.key === sp.t)!;
      const sel = selected.spot === i;
      const m = L.circleMarker(sp.ll, { radius: sel ? 9 : 6, color: sel ? "#111827" : "#ffffff", weight: sel ? 3 : 1.2, fillColor: info.color, fillOpacity: 0.9 });
      m.bindTooltip(`${info.icon} ${sp.n}`, { sticky: true });
      m.on("click", () => select({ spot: i }, false));
      m.addTo(group);
    }
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
    renderSections();
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
    const ki = kindInfo(f.kind), dd = distF(f), r = ratingOf(f);
    d.append(h("strong", {}, `${ki.icon} ${f.name}`),
      h("div", { class: "muted" }, `${f.area ?? ""}${dd != null ? ` · ${base || "시내"}에서 ${dd.toFixed(1)}km` : " · 지도 위치 미확인"}${r ? ` · ★${r.v.toFixed(1)}${r.n ? ` (${r.n.toLocaleString("ko-KR")}건)` : ""}${r.asof ? ` ${r.asof}` : ""}` : ""}`));
    const row = (x: Fee) => h("li", {}, h("strong", {}, money(x.amount, x.period)), ` ${x.label}`,
      x.source === "manual" ? h("small", { class: "muted" }, " (직접 입력)") : null,
      x.quote && x.source !== "manual" ? h("small", { class: "muted fee-quote" }, `원문: “${x.quote}”`) : null);
    const main = f.fees.filter((x) => x.kind !== "other"), extra = f.fees.filter((x) => x.kind === "other");
    if (!f.fees.length) d.append(h("p", { class: "muted" }, f.kind === "walk" ? "무료 코스예요 (주차·화장실·조석은 현장·공식 안내 확인)." : "요금을 자동으로 읽지 못했어요. 공식 사이트·전화로 확인하세요."));
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
      h("div", { class: "muted" }, `${info.label}${s.x ? ` · ${s.x}` : ""}${dd != null ? ` · ${base || "시내"}에서 ${dd.toFixed(1)}km` : ""}`), h("p", {}, info.hint));
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
      h("option", { value: "name" }, "표: 이름순"));
    sortSel.value = sort;
    sortSel.addEventListener("change", () => { sort = sortSel.value; renderGolf(); });
    const krwBox = h("input", { type: "checkbox", id: "leisure-krw" });
    krwBox.checked = krw;
    krwBox.disabled = !o.fx;
    krwBox.addEventListener("change", () => { krw = krwBox.checked; renderAll(); });
    const ageChips = AGES.map((a) => {
      const n = facilities.filter((f) => (a.key === "all" || agesOf(f).includes(a.key)) && on.has(f.kind)).length;
      const b = h("button", { type: "button", class: "chip age-chip", "aria-pressed": String(age === a.key) }, `${a.icon} ${a.label}`, h("small", {}, ` ${n}`));
      b.addEventListener("click", () => {
        age = a.key;
        try { localStorage.setItem(AGE_KEY, age); } catch { /* 무시 */ }
        renderAll();
      });
      return b;
    });
    const qf = (label: string, on_: boolean, set: (v: boolean) => void) => {
      const b = h("button", { type: "button", class: "chip quick", "aria-pressed": String(on_) }, label);
      b.addEventListener("click", () => { set(!on_); renderAll(); });
      return b;
    };
    controls.replaceChildren(
      h("div", { class: "age-row", role: "group", "aria-label": "연령대" }, h("span", { class: "eth-rowlabel" }, "누가 가나요?"), ...ageChips),
      h("div", { class: "chips", role: "group", "aria-label": "빠른 필터" },
        qf("🆓 무료·저렴만", freeOnly, (v) => (freeOnly = v)), qf("☔ 실내만 (비 와도)", indoorOnly, (v) => (indoorOnly = v)),
        qf("📍 15km 이내", nearOnly, (v) => (nearOnly = v)), qf("🗺️ 지도 영역만 목록에", viewOnly, (v) => (viewOnly = v))));
    // 시설 종류·장소 레이어·거리 기준은 추천·즐겨찾기 아래 '지도 설정'으로 (펼쳐 둠)
    // 묶음 프리셋: 시설 종류 12개를 한 번에 고르기
    const PRESETS: { label: string; kinds: Kind[] | null }[] = [
      { label: "✨ 전체", kinds: null },
      { label: "👨‍👩‍👧 아이와", kinds: ["kids", "swim", "sports", "walk", "climb", "tennis"] },
      { label: "🏋️ 운동", kinds: ["gym", "tennis", "climb", "studio", "sports", "golf"] },
      { label: "💦 물놀이", kinds: ["swim", "kayak", "sailing", "fishing"] },
      { label: "⛵ 바다·골프", kinds: ["sailing", "kayak", "fishing", "golf"] },
    ];
    const presetRow = h("div", { class: "chips", role: "group", "aria-label": "빠른 묶음" }, h("span", { class: "eth-rowlabel" }, "묶음"), ...PRESETS.map((pr) => {
      const set = new Set<Kind>(pr.kinds ?? KINDS.map((k) => k.key));
      const active = set.size === on.size && [...set].every((k) => on.has(k));
      const b = h("button", { type: "button", class: "chip quick", "aria-pressed": String(active) }, pr.label);
      b.addEventListener("click", () => { on.clear(); set.forEach((k) => on.add(k)); renderAll(); });
      return b;
    }));
    const det = h("details", { class: "lset", open: "" }, h("summary", {}, "🗺️ 지도 설정 — 시설 종류 · 장소 레이어 · 거리 기준"), presetRow,
      h("div", { class: "chips", role: "group", "aria-label": "표시할 시설" }, ...kindChips),
      h("div", { class: "chips", role: "group", "aria-label": "표시할 장소" }, h("span", { class: "eth-rowlabel" }, "장소"), ...spotChips,
        spots.length ? null : h("small", { class: "muted" }, " (장소 데이터는 Actions → Fishing / kayak / swim spots 실행 후 표시)")),
      h("div", { class: "leisure-row" }, baseSel, radSel, sortSel,
        h("label", { class: "leisure-krw", for: "leisure-krw" }, krwBox, o.fx ? ` 원화 환산 (1NZD≈${Math.round(o.fx).toLocaleString("ko-KR")}원)` : " 원화 환산(환율 없음)")));
    det.open = settingsBox.querySelector("details")?.open ?? true;
    settingsBox.replaceChildren(det);
    const items = [
      ...KINDS.filter((k) => on.has(k.key) && k.key !== "golf" && facilities.some((f) => f.kind === k.key && visible(f))).map((k) => `<i style="background:${k.color}"></i>${k.icon} ${k.label}`),
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
    const items = facilities.filter((f) => f.kind === "golf" && visible(f));
    const val = (f: Facility): number => {
      if (sort === "fee") return yearly(f, "adult") ?? Number.POSITIVE_INFINITY;
      return distF(f) ?? Number.POSITIVE_INFINITY;
    };
    return [...items].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : val(a) - val(b)));
  };

  function renderGolf() {
    if (!on.has("golf") || !facilities.some((f) => f.kind === "golf" && visible(f))) { golfBox.replaceChildren(); return; }
    const items = sortedGolf();
    const head = h("tr", {}, ...["클럽", "거리", "성인 1", "입회비", "사이트"].map((t) => h("th", { scope: "col" }, t)));
    const body = items.map((f) => {
      const d = distF(f);
      const cell = (k: string) => {
        const x = feeOf(f, k);
        return x ? h("td", {}, money(x.amount, k === "joining" ? "" : x.period === "year" ? "" : x.period)) : h("td", { class: "muted" }, "—");
      };
      const name = h("button", { type: "button", class: "leisure-name", "aria-expanded": String(selected.fac === f.id) }, f.name);
      name.addEventListener("click", () => select(selected.fac === f.id ? {} : { fac: f.id }));
      const state = f.status && f.status !== "open" && f.status !== "unknown" ? h("small", { class: "tag" }, STATUS[f.status]) : null;
      return h("tr", { class: selected.fac === f.id ? "cur" : "" },
        h("th", { scope: "row" }, name, h("small", { class: "muted" }, `${f.area ?? ""}${f.checked ? "" : " · 요금 미확인"}`), state),
        h("td", {}, d != null ? `${d.toFixed(1)}km` : "—"), cell("adult"), cell("joining"),
        h("td", {}, f.home ? o.link(f.home, "🌐") : h("span", { class: "muted" }, "—")));
    });
    golfBox.replaceChildren(h("section", { class: "hood-card" }, h("h2", {}, `⛳ 골프장 회원권 (${items.length}곳)`),
      h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-table" }, h("thead", {}, head), h("tbody", {}, ...body))),
      h("p", { class: "board-note" }, `클럽 이름을 누르면 지도가 그 클럽으로 이동하고 옆(모바일은 지도 아래) 패널에 전체 요금·손익분기 계산·평점 입력이 열려요. 연회비는 성인 1인 정규(풀 플레잉) 기준, 커플은 성인 2인 합계예요. 커플·가족 연회비, 평점은 이 패널과 아래 가입 비용 비교에서 봐요. “—”는 공식 페이지에서 확인되지 않은 항목입니다. 갱신 ${data?.updated_at ?? ""}. 정회원 가입은 입회 심사·대기 명단이 있는 곳이 많고, 일부 클럽은 요금을 공개하지 않아요.`)));
  }

  // ── 가입 비용 비교 ──
  function renderCost() {
    if (!facilities.length) { costBox.replaceChildren(); return; }
    const pool = facilities.filter((f) => (f.kind === "golf" || f.kind === "sailing") && visible(f));
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

  // ── 카드 ──
  const feeOrder = ["adult", "couple", "family", "lesson", "child", "family_pass", "adult_entry", "social", "joining", "tour", "berth", "hire", "student", "junior", "greenfee18", "greenfee9", "other"];
  const feeRank = (x: Fee) => (feeOrder.includes(x.kind) ? feeOrder.indexOf(x.kind) : feeOrder.length);
  const changedRecently = (id: string) => (data?.changes ?? []).some((c) => c.id === id && Date.now() - new Date(c.date).getTime() < 120 * 86400000);

  function toggleFav(id: string) {
    favs = favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id];
    saveFavs(favs);
    renderAll();
  }
  function toggleCmp(id: string) {
    if (cmp.has(id)) cmp.delete(id);
    else if (cmp.size < 3) cmp.add(id);
    renderCompare();
    renderSections();
    renderFavs();
  }

  function card(f: Facility): HTMLElement {
    const d = distF(f), pb = priceBadge(f), ki = kindInfo(f.kind);
    const top = [...f.fees].sort((a, b) => feeRank(a) - feeRank(b)).slice(0, 2).map((x) => `${x.label.replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 26)} ${money(x.amount, x.period)}`);
    const name = h("button", { type: "button", class: "lc-name" }, f.name);
    name.addEventListener("click", () => select({ fac: f.id }));
    const star = h("button", { type: "button", class: "lc-star", "aria-pressed": String(favs.includes(f.id)), "aria-label": `${f.name} 즐겨찾기`, title: "즐겨찾기" }, favs.includes(f.id) ? "★" : "☆");
    star.addEventListener("click", () => toggleFav(f.id));
    const box = h("input", { type: "checkbox", "aria-label": `${f.name} 비교에 담기` });
    box.checked = cmp.has(f.id);
    box.disabled = !cmp.has(f.id) && cmp.size >= 3;
    box.addEventListener("change", () => toggleCmp(f.id));
    const ages = agesOf(f);
    return h("article", { class: `lcard${selected.fac === f.id ? " sel" : ""}`, style: `--c:${ki.color}` },
      h("div", { class: "lc-top" }, h("span", { class: "lc-ico", "aria-hidden": "true" }, ki.icon), name, star),
      h("div", { class: "lc-meta" }, `${f.area ?? ""}${d != null ? ` · ${d.toFixed(1)}km` : ""}`),
      h("div", { class: "lc-badges" }, h("span", { class: `pb ${pb.cls}` }, pb.text), h("span", { class: "pb io" }, isIndoor(f) ? "🏠 실내" : "🌳 야외"),
        f.season ? h("span", { class: "pb io", title: f.season }, `🗓 ${f.season.replace(/\(.*?\)/g, "").trim().slice(0, 14)}`) : null,
        f.status && f.status !== "open" && f.status !== "unknown" ? h("span", { class: "pb warn" }, STATUS[f.status]) : null,
        changedRecently(f.id) ? h("span", { class: "pb warn" }, "변경됨") : null),
      hoursLine(f),
      extraLine(f),
      h("div", { class: "lc-ages" }, ...ages.filter((a) => a !== "adult" || ages.length < 3).map((a) => h("span", { class: "age-b" }, AGE_SHORT[a]))),
      top.length ? h("ul", { class: "lc-fees" }, ...top.map((t) => h("li", {}, t))) : null,
      h("label", { class: "lc-cmp" }, box, " 비교"));
  }

  /** 운영 시간 한 줄: OSM 값이 있으면 "지금 영업 중 · 21:00 마감", 없으면 공식 페이지에 적힌 글 그대로, 둘 다 없으면 표시 안 함 */
  function hoursLine(f: Facility): HTMLElement | null {
    const st = openStatus(hoursOf(f));
    if (st.open != null) return h("div", { class: `lc-hours ${st.open ? "open" : "shut"}`, title: `${hoursOf(f)}${osm[f.id]?.hours ? " (OpenStreetMap)" : " (공식 페이지)"}` }, `${st.open ? "🟢" : "🔴"} ${st.text}`, h("small", {}, ` · ${todayHours(hoursOf(f))}`));
    return f.details?.hours ? h("div", { class: "lc-hours", title: "공식 페이지에 적힌 운영 시간" }, `🕒 ${f.details.hours}`) : null;
  }
  /** 4인 가족 1회 비용 + 방문 정보(예약·주차·준비물·붐비는 시간) — 확인된 것만 */
  function extraLine(f: Facility): HTMLElement | null {
    const fam = ["kids", "swim", "climb", "sports", "kayak"].includes(f.kind) ? familyCost(f.fees) : null;
    const bits = visitBits(f.details, osm[f.id]);
    if (!fam && !bits.length) return null;
    return h("div", { class: "lc-extra" }, fam ? h("span", { class: "pb fam", title: fam.how }, `👨‍👩‍👧‍👦 4인 1회 ${money(fam.total)}`) : null, ...bits.map((b) => h("span", {}, b)));
  }

  // ── 오늘 뭐 하지: 누구와·예산·거리만 고르면 날씨·운영 시간까지 반영해 5곳 ──
  const fitsWho = (f: Facility): boolean => {
    const ages = agesOf(f);
    if (who === "kids") return ages.some((a) => a === "baby" || a === "kid" || a === "family");
    return ages.includes("adult") && f.kind !== "kids" && f.kind !== "sports";
  };
  const entryMin = (f: Facility): number | null => {
    const xs = f.fees.filter((x) => ENTRY_KINDS.has(x.kind) && x.amount > 0 && !["year", "season", "month"].includes(x.period)).map((x) => x.amount);
    return xs.length ? Math.min(...xs) : null;
  };
  function renderPicker() {
    const chip = (label: string, on: boolean, act: () => void) => { const b = h("button", { type: "button", class: "chip", "aria-pressed": String(on) }, label); b.addEventListener("click", () => { act(); renderPicker(); renderWeekend(); }); return b; };
    const rowOf = (label: string, ...chips: HTMLElement[]) => h("div", { class: "chips", role: "group", "aria-label": label }, h("span", { class: "eth-rowlabel" }, label), ...chips);
    const maxKm = +far;
    const pool = facilities.filter((f) => f.status !== "closed" && !["golf", "sailing", "fishing"].includes(f.kind) && fitsWho(f)).map((f) => {
      const d = distF(f), pb = priceBadge(f), st = openStatus(hoursOf(f)), em = entryMin(f), indoor = isIndoor(f);
      const okBudget = budget === "any" || pb.cls === "free" || (budget === "20" && (pb.cls === "cheap" || (em != null && em <= 20)));
      const okFar = !maxKm || (d != null && d <= maxKm);
      const okWx = rainy ? indoor : true;
      const why: string[] = [];
      if (st.open) why.push(st.text);
      if (pb.cls === "free") why.push("무료");
      else if (em != null) why.push(`1인 $${num(em)}~`);
      if (d != null) why.push(`${d.toFixed(1)}km`);
      if (rainy && indoor) why.push("비 와도 가능");
      if (!rainy && !indoor && (f.kind === "swim" || f.kind === "walk")) why.push("오늘 날씨에 맞음");
      const score = (d ?? 30) + (st.open ? -4 : st.open === false ? 25 : 0) + (pb.cls === "free" ? -4 : pb.cls === "cheap" ? -2 : pb.cls === "na" ? 6 : 0)
        + (!rainy && !indoor && (f.kind === "swim" || f.kind === "walk") ? -3 : 0) + (favs.includes(f.id) ? -3 : 0);
      return { f, ok: okBudget && okFar && okWx, score, why, shut: st.open === false };
    });
    const picks = pool.filter((x) => x.ok).sort((a, b) => a.score - b.score).slice(0, 5);
    const wx = rainy == null ? "날씨 확인 중" : rainy ? "☔ 비·쌀쌀 → 실내 위주" : "☀️ 날씨 괜찮음 → 야외 포함";
    pickerBox.replaceChildren(h("section", { class: "hood-card picks" },
      h("h2", {}, "✨ 오늘 뭐 하지?"),
      rowOf("누구와", chip("🧒 아이와", who === "kids", () => { who = "kids"; savePref("who", who); }), chip("👫 둘이", who === "couple", () => { who = "couple"; savePref("who", who); }), chip("🧑 혼자", who === "solo", () => { who = "solo"; savePref("who", who); })),
      rowOf("예산", chip("무료만", budget === "free", () => { budget = "free"; savePref("budget", budget); }), chip("1인 $20 이하", budget === "20", () => { budget = "20"; savePref("budget", budget); }), chip("상관없음", budget === "any", () => { budget = "any"; savePref("budget", budget); })),
      rowOf("거리", ...(["5", "10", "20", "0"] as const).map((k) => chip(k === "0" ? "상관없음" : `${k}km 안`, far === k, () => { far = k; savePref("far", far); }))),
      h("p", { class: "muted" }, `${base || "시내"} 기준 · ${wx} · 지금 닫힌 곳은 뒤로 미뤄요`),
      picks.length ? h("div", { class: "lgrid" }, ...picks.map((x) => h("div", { class: "pick" }, card(x.f), h("p", { class: `pick-why${x.shut ? " shut" : ""}` }, x.why.join(" · ")))))
        : h("p", { class: "muted" }, "조건에 맞는 곳이 없어요. 예산이나 거리를 넓혀 보세요.")));
  }

  // ── 이번 주말 코스: 토·일 날씨에 맞춰 반나절 코스 (시설 + 가까운 무료 장소) ──
  function renderWeekend() {
    const days = weekendDays(o.week);
    if (!days.length) { weekendBox.replaceChildren(); return; }
    const MOOD = { wet: ["☔ 비 예보 — 실내 코스", (f: Facility) => isIndoor(f)], hot: ["🏖️ 더운 날 — 물놀이 코스", (f: Facility) => f.kind === "swim" || f.kind === "kayak"],
      mild: ["🌤️ 선선한 날 — 걷기·놀이 코스", (f: Facility) => f.kind === "walk" || f.kind === "climb" || (f.kind === "kids" && !isIndoor(f)) || f.kind === "swim"] } as const;
    const used = new Set<string>();
    const blocks = days.map((d) => {
      const [title, fit] = MOOD[d.mood];
      const mains = facilities.filter((f) => f.status !== "closed" && f.ll && fitsWho(f) && fit(f) && !used.has(f.id) && !["golf", "sailing", "fishing"].includes(f.kind))
        .sort((a, b) => (distF(a) ?? 99) - (distF(b) ?? 99) + (priceBadge(a).cls === "free" ? -3 : 0) - (priceBadge(b).cls === "free" ? -3 : 0)).slice(0, 2);
      mains.forEach((f) => used.add(f.id));
      const items = mains.map((f, i) => {
        const near = d.mood === "wet" || !f.ll ? null : spots.map((sp) => ({ sp, d: km(f.ll!, sp.ll) })).filter((x) => (x.sp.t === "playground" || x.sp.t === "beach" || x.sp.t === "splash") && x.d <= 2.5).sort((a, b) => a.d - b.d)[0];
        const b = h("button", { type: "button", class: "leisure-name" }, `${kindInfo(f.kind).icon} ${f.name}`);
        b.addEventListener("click", () => { if (o.compact) { location.href = "./leisure.html"; return; } showView("map"); select({ fac: f.id }); });
        const pb = priceBadge(f), dd = distF(f);
        return h("li", {}, h("b", {}, i === 0 ? "오전 " : "오후 "), b, h("small", { class: "muted" }, ` ${pb.text}${dd != null ? ` · ${dd.toFixed(1)}km` : ""}`),
          near ? h("span", {}, ` → ${SPOTS.find((x) => x.key === near.sp.t)!.icon} ${near.sp.n} `, h("small", { class: "muted" }, `(${near.d < 1 ? "걸어서" : "차로"} ${near.d.toFixed(1)}km · 무료)`)) : null);
      });
      return h("div", { class: "wk-day" }, h("h3", {}, `${d.label} `, h("small", {}, `${d.date.slice(5).replace("-", "/")} · ${d.text}`)), h("p", { class: "wk-mood" }, title),
        items.length ? h("ol", { class: "wk-course" }, ...items) : h("p", { class: "muted" }, "조건에 맞는 곳을 찾지 못했어요."));
    });
    weekendBox.replaceChildren(h("section", { class: "hood-card" }, h("h2", {}, "🗓️ 이번 주말 코스"), h("div", { class: "wk-grid" }, ...blocks),
      h("p", { class: "board-note" }, "주말 예보(오늘 브리핑 기준)와 위에서 고른 ‘누구와’에 맞춰 가까운 순으로 골랐어요. 화살표 뒤는 그 근처의 무료 놀이터·해변이에요. 이름을 누르면 지도에서 볼 수 있어요.")));
  }

  function showView(v: View) {
    view = v;
    try { localStorage.setItem("daily-brief:leisure-view", v); } catch { /* 무시 */ }
    for (const x of VIEWS) views[x.key].hidden = x.key !== v;
    viewBar.replaceChildren(...VIEWS.map((x) => { const b = h("button", { type: "button", class: "chip", role: "tab", "aria-selected": String(x.key === v), "aria-pressed": String(x.key === v) }, x.label); b.addEventListener("click", () => showView(x.key)); return b; }));
    if (v === "map") setTimeout(() => { map?.invalidateSize(); drawMap(); }, 60);
  }

  function inView(f: Facility): boolean {
    if (!viewOnly || !map || !f.ll) return true;
    return map.getBounds().contains(f.ll);
  }

  /** 그룹 아래 "지도에 지점 표시" 버튼 (해당 장소 레이어 켜기·끄기) */
  function spotToggle(t: SpotType): HTMLElement {
    const info = SPOTS.find((x) => x.key === t)!;
    const n = spots.filter((sp) => sp.t === t).length;
    const b = h("button", { type: "button", class: "chip quick", "aria-pressed": String(spotOn.has(t)) }, `🗺️ 지도에 ${info.label} ${spotOn.has(t) ? "숨기기" : `보기${n ? ` (${n}곳)` : ""}`}`);
    b.addEventListener("click", () => { spotOn.has(t) ? spotOn.delete(t) : spotOn.add(t); renderAll(); });
    return h("p", { class: "lspot" }, b, n ? null : h("small", { class: "muted" }, " (장소 데이터는 Actions → spots 실행 후 표시)"));
  }

  function renderSections() {
    const blocks: Node[] = [];
    for (const g of GROUPS) {
      const all = facilities.filter((f) => g.kinds.includes(f.kind) && visible(f));
      if (!all.length) continue;
      const shown = all.filter(inView).sort((a, b) => (distF(a) ?? 1e9) - (distF(b) ?? 1e9));
      const water = g.key === "water";
      const grid = !water ? (shown.length ? h("div", { class: "lgrid" }, ...shown.map(card)) : null) : h("div", {}, ...WATER_SUBS.flatMap((sub) => {
        const part = shown.filter((f) => waterSub(f) === sub.key);
        return part.length ? [h("h3", { class: "lsub" }, `${sub.label} `, h("small", {}, `${part.length}곳`)), h("div", { class: "lgrid" }, ...part.map(card))] : [];
      }));
      blocks.push(h("details", { class: "lgroup", open: "" },
        h("summary", {}, `${g.icon} ${g.label}`, h("small", {}, ` ${shown.length}${shown.length !== all.length ? `/${all.length}` : ""}곳`)),
        shown.length ? grid : h("p", { class: "muted" }, "지도에 보이는 영역에는 없어요. 지도를 움직이거나 “지도 영역만 목록에”를 꺼 보세요."),
        g.kinds.includes("fishing") && on.has("fishing") ? fishingRules() : null,
        g.spot ? spotToggle(g.spot) : null));
    }
    // 가까운 놀이터·물놀이 (장소 데이터)
    if (spots.length && (age === "all" || ["baby", "kid", "family"].includes(age))) {
      const near = spots.map((sp, i) => ({ sp, i, d: dist(sp.ll) ?? 1e9 })).filter((x) => x.sp.t === "playground" || x.sp.t === "splash").sort((a, b) => a.d - b.d).slice(0, 6);
      if (near.length) {
        blocks.push(h("details", { class: "lgroup", open: "" }, h("summary", {}, "🛝 가까운 놀이터·물놀이 (무료)", h("small", {}, ` ${near.length}곳`)),
          h("div", { class: "lgrid" }, ...near.map(({ sp, i, d }) => {
            const info = SPOTS.find((x) => x.key === sp.t)!;
            const b = h("button", { type: "button", class: "lc-name" }, sp.n);
            b.addEventListener("click", () => { spotOn.add(sp.t); select({ spot: i }); renderControls(); });
            return h("article", { class: "lcard", style: `--c:${info.color}` }, h("div", { class: "lc-top" }, h("span", { class: "lc-ico" }, info.icon), b),
              h("div", { class: "lc-meta" }, `${info.label} · ${d.toFixed(1)}km`), h("div", { class: "lc-badges" }, h("span", { class: "pb free" }, "무료"), h("span", { class: "pb io" }, "🌳 야외")));
          }))));
      }
    }
    if (!blocks.length) blocks.push(h("section", { class: "hood-card" }, h("p", { class: "muted" }, "조건에 맞는 시설이 없어요. 연령대나 필터를 바꿔 보세요.")));
    listBox.replaceChildren(...blocks);
    const missing = facilities.filter((f) => visible(f) && !f.ll && !f.chain);
    missBox.replaceChildren(missing.length ? h("section", { class: "hood-card" }, h("h2", {}, "📍 지도 위치를 못 찾은 곳"),
      h("ul", { class: "leisure-fees" }, ...missing.map((f) => {
        const b = h("button", { type: "button", class: "leisure-name" }, `${kindInfo(f.kind).icon} ${f.name}`);
        b.addEventListener("click", () => select({ fac: f.id }, false));
        return h("li", {}, b, h("small", { class: "muted" }, ` ${f.area ?? ""}`), " ", o.link(f.gmaps, "지도에서 찾기"));
      }))) : h("span", {}));
  }

  // ── 오늘 추천 (날씨 기반) ──
  function renderPicks() {
    if (rainy == null) { picksBox.replaceChildren(); return; }
    const pool = facilities.filter((f) => f.kind !== "golf" && visible(f) && f.status !== "closed");
    const score = (f: Facility) => {
      const fit = rainy ? (isIndoor(f) ? 0 : 5) : (f.kind === "walk" || f.kind === "swim" || f.kind === "kids" ? 0 : 1) + (isIndoor(f) ? 1 : 0);
      const pb = priceBadge(f);
      return fit * 100 + (distF(f) ?? 40) + (pb.cls === "free" ? -8 : pb.cls === "cheap" ? -4 : 0);
    };
    const picks = pool.filter((f) => (rainy ? isIndoor(f) : true)).sort((a, b) => score(a) - score(b)).slice(0, 3);
    if (!picks.length) { picksBox.replaceChildren(); return; }
    const ageLabel = AGES.find((a) => a.key === age)?.label ?? "전체";
    picksBox.replaceChildren(h("section", { class: "hood-card picks" },
      h("h2", {}, rainy ? "☔ 오늘은 실내로 — 추천 3곳" : "☀️ 오늘 나가기 좋아요 — 추천 3곳"),
      h("p", { class: "muted" }, `${ageLabel} 기준 · ${rainy ? "비 또는 쌀쌀한 날씨라 실내 시설 위주" : "날씨가 괜찮아 야외·물놀이 포함"} · ${base || "시내"}에서 가까운 순`),
      h("div", { class: "lgrid" }, ...picks.map(card))));
  }

  // ── 즐겨찾기 · 비교 ──
  function renderFavs() {
    const list = favs.map((id) => facilities.find((f) => f.id === id)).filter((f): f is Facility => !!f);
    favBox.replaceChildren(list.length ? h("section", { class: "hood-card" }, h("h2", {}, `⭐ 내 즐겨찾기 (${list.length})`),
      h("div", { class: "lgrid" }, ...list.map(card)), h("p", { class: "muted" }, "이 기기에만 저장돼요. 카드의 “비교”를 2~3곳 체크하면 아래에 나란히 비교해 줘요.")) : h("span", {}));
  }

  function renderCompare() {
    const list = [...cmp].map((id) => facilities.find((f) => f.id === id)).filter((f): f is Facility => !!f);
    if (list.length < 2) {
      cmpBox.replaceChildren(list.length === 1 ? h("p", { class: "muted lc-hint" }, "비교하려면 카드에서 한 곳 이상 더 “비교”를 체크하세요 (최대 3곳).") : h("span", {}));
      return;
    }
    const row = (label: string, fn: (f: Facility) => string | Node) => h("tr", {}, h("th", { scope: "row" }, label), ...list.map((f) => h("td", {}, fn(f))));
    const topFee = (f: Facility, kinds: string[]) => {
      const x = f.fees.find((y) => kinds.includes(y.kind));
      return x ? money(x.amount, x.period) : "—";
    };
    const clear = h("button", { type: "button", class: "link-btn" }, "비교 지우기");
    clear.addEventListener("click", () => { cmp.clear(); renderCompare(); renderSections(); renderFavs(); });
    cmpBox.replaceChildren(h("section", { class: "hood-card" }, h("h2", {}, "⚖️ 나란히 비교"),
      h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-table cmp-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...list.map((f) => h("th", { scope: "col" }, `${kindInfo(f.kind).icon} ${f.name.replace(/\s*\(.*?\)/, "")}`)))),
        h("tbody", {},
          row("가격", (f) => priceBadge(f).text),
          row("어린이 요금", (f) => topFee(f, ["child", "lesson"])),
          row("성인 요금", (f) => topFee(f, ["adult_entry", "adult"])),
          row("가족권", (f) => topFee(f, ["family_pass", "family"])),
          row("거리", (f) => { const d = distF(f); return d != null ? `${d.toFixed(1)}km` : "—"; }),
          row("연령", (f) => agesOf(f).map((a) => AGE_SHORT[a]).join(" ")),
          row("실내/야외", (f) => (isIndoor(f) ? "🏠 실내" : "🌳 야외")),
          row("상태", (f) => (f.status && f.status !== "unknown" ? STATUS[f.status] : "미확인")),
          row("확인일", (f) => f.checked || "확인 전")))),
      clear));
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
    renderPicker();
    renderWeekend();
    renderControls();
    renderPanel();
    renderPicks();
    renderFavs();
    renderCompare();
    renderSections();
    renderGolf();
    renderCost();
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
  views.rules.append(fishingRules(), h("section", { class: "hood-card" }, h("h2", {}, "🏊 물놀이 전에"),
    h("ul", { class: "leisure-fees" }, h("li", {}, "해변·항구 풀은 Safeswim 에서 수질과 안전 깃발을 먼저 확인하세요."), h("li", {}, "스플래시 패드·학교 수영장은 여름철(보통 11~3월)과 날씨 좋은 날에만 열어요."),
      h("li", {}, "자외선 지수가 6 이상이면 선크림·모자·래시가드를 챙기세요(뉴질랜드 여름은 한국보다 훨씬 강해요).")),
    h("div", { class: "hood-links" }, o.link("https://safeswim.org.nz", "🌊 Safeswim 수질·안전"), o.link("https://www.metservice.com/towns-cities/locations/auckland", "🌤️ MetService 오클랜드"))));
  showView(view);
  renderAll();
  void forecast(h, today, origin(), (days) => {
    const d0 = days[0];
    rainy = !!d0 && (d0.rain >= 50 || d0.temp < 14 || d0.gust >= 30);
    renderPicker();
  });
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css"), whenConnected(mapEl)]).then(([mod, , ok]) => {
    if (!ok) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.86, 174.77], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    drawMap();
    // 지도를 움직이거나 확대하면 장소 묶음과 옆 목록(지도 영역만)이 따라 바뀜
    let t: ReturnType<typeof setTimeout> | undefined;
    map.on("moveend", () => {
      clearTimeout(t);
      t = setTimeout(() => { drawMap(); if (viewOnly) renderSections(); }, 120);
    });
    renderSections();
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

async function forecast(h: H, slot: HTMLElement, at: [number, number], onDays?: (days: ReturnType<typeof dayStats>) => void): Promise<void> {
  const title = h("h2", {}, "🌤️ 오늘·내일 가기 좋은가");
  const note = h("p", { class: "board-note" }, "Open-Meteo 예보로 8~18시를 계산한 참고용 점수예요(30분 동안 저장해 다시 씀). 바다에 나가기 전에는 반드시 MetService 해상예보·조석을 확인하세요. 💨 풍속(돌풍) 노트 · ☔ 강수확률 · 🌊 파고");
  try {
    const { fc, mr } = await cachedForecast(at);
    const days = dayStats(fc.hourly, mr?.hourly ?? null);
    if (!days.length) throw new Error("no data");
    onDays?.(days);
    const label = ["오늘", "내일"];
    const rows = KINDS.filter((k) => !["gym", "climb", "studio"].includes(k.key)).map((k) => h("tr", {}, h("th", { scope: "row" }, `${k.icon} ${k.label}`),
      ...days.slice(0, 2).map((d) => {
        const v = verdict(k.activity, d);
        return h("td", { title: v.text }, `${lvIcon[v.level]} `, h("small", {}, v.text.split(" — ")[0]));
      })));
    const d0 = days[0];
    const facts = `오늘 8~18시: 💨 ${Math.round(d0.wind)}(${Math.round(d0.gust)})kn · ☔ ${Math.round(d0.rain)}% · ${Math.round(d0.temp)}°C${d0.wave != null ? ` · 🌊 ${d0.wave.toFixed(1)}m` : ""}`;
    slot.replaceChildren(title, h("p", { class: "lw-facts" }, facts), h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-weather lw-compact" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "활동"), ...days.slice(0, 2).map((d, i) => h("th", { scope: "col" }, `${label[i]} ${d.date.slice(5).replace("-", "/")}`)))),
      h("tbody", {}, ...rows))), note);
  } catch {
    slot.replaceChildren(title, h("p", { class: "muted" }, "예보를 불러오지 못했어요 (오프라인이거나 일시 오류)."), note);
  }
}
