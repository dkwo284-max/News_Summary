// 레저 탭 보강 (AI 없음): 운영 시간 해석("지금 영업 중"), 4인 가족 1회 비용, 방문 정보 한 줄, 주말 날씨 판정.

export interface OsmInfo { hours?: string; phone?: string; wheelchair?: string; parking_near?: number }
export interface Details { booking?: "required" | "recommended" | "walkin"; parking?: string; bring?: string; busy?: string; hours?: string }
interface FeeLike { kind: string; amount: number; period: string }

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** 오클랜드 현지의 요일(0=일)과 자정부터 분 */
export function nzNow(now = new Date()): { dow: number; min: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Pacific/Auckland", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { dow: Math.max(0, DAYS.indexOf(get("weekday").slice(0, 2))), min: (+get("hour") % 24) * 60 + +get("minute") };
}

/** "Mo-Fr,Su" → 요일 집합. 요일 표기가 없으면 매일. 공휴일(PH)·학기(SH)는 무시 */
function daySet(sel: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of sel.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^(PH|SH)$/i.test(part)) continue;
    const m = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
    if (!m) return null;
    const a = DAYS.indexOf(m[1]), b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return out;
}

/** OSM opening_hours 의 흔한 형식만 해석: 요일별 [시작분, 끝분][] (해석 못 하면 null). 뒤 규칙이 같은 요일의 앞 규칙을 덮는다 */
export function parseHours(oh: string): [number, number][][] | null {
  const week: [number, number][][] = Array.from({ length: 7 }, () => []);
  const text = oh.trim();
  if (!text) return null;
  if (/^24\/7$/.test(text)) return week.map(() => [[0, 1440]] as [number, number][]);
  let any = false;
  for (const rule of text.split(";").map((r) => r.trim()).filter(Boolean)) {
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(rule)) continue;  // 특정 날짜 예외(예: "Dec 25 off")는 평소 영업에 영향 없음
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)*)\s*(.*)$/);
    if (!m) return null;
    const onlyHoliday = /^(PH|SH)(\s*,\s*(PH|SH))*$/i.test(m[1].trim());
    if (onlyHoliday) continue;
    const days = m[1].trim() ? daySet(m[1]) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    const body = m[2].trim();
    let spans: [number, number][] = [];
    if (/^(off|closed)$/i.test(body)) spans = [];
    else if (/^24\/7$|^00:00-24:00$/.test(body)) spans = [[0, 1440]];
    else {
      for (const r of body.split(",").map((x) => x.trim())) {
        const t = r.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
        if (!t) return null;
        const a = +t[1] * 60 + +t[2];
        let b = +t[3] * 60 + +t[4];
        if (b <= a) b += 1440;  // 자정을 넘기는 영업
        spans.push([a, b]);
      }
    }
    for (const d of days) week[d] = spans;
    any = true;
  }
  return any ? week : null;
}

const hm = (m: number) => `${Math.floor((m % 1440) / 60)}:${String(m % 60).padStart(2, "0")}`;

/** 지금 열려 있나: open=true/false, 해석 못 하면 null. text 는 화면에 쓸 한 줄 */
export function openStatus(oh: string | undefined, now = new Date()): { open: boolean | null; text: string } {
  if (!oh) return { open: null, text: "" };
  const week = parseHours(oh);
  if (!week) return { open: null, text: "" };
  const { dow, min } = nzNow(now);
  const today = week[dow], yest = week[(dow + 6) % 7];
  const late = yest.find(([, b]) => b > 1440 && min < b - 1440);  // 어제 시작해 자정을 넘긴 영업
  if (late) return { open: true, text: `지금 영업 중 · ${hm(late[1])} 마감` };
  const cur = today.find(([a, b]) => min >= a && min < b);
  if (cur) return { open: true, text: cur[0] === 0 && cur[1] >= 1440 ? "24시간 영업" : `지금 영업 중 · ${hm(cur[1])} 마감${cur[1] - min <= 60 ? " (곧 닫음)" : ""}` };
  const next = today.find(([a]) => a > min);
  if (next) return { open: false, text: `지금 닫힘 · 오늘 ${hm(next[0])} 열어요` };
  for (let i = 1; i <= 7; i++) {
    const d = week[(dow + i) % 7];
    if (d.length) return { open: false, text: `지금 닫힘 · ${i === 1 ? "내일" : "일월화수목금토"[(dow + i) % 7] + "요일"} ${hm(d[0][0])} 열어요` };
  }
  return { open: false, text: "운영 안 함" };
}

/** 오늘 운영 시간 한 줄 (예: "오늘 6:00~21:00"). 모르면 "" */
export function todayHours(oh: string | undefined, now = new Date()): string {
  const week = oh ? parseHours(oh) : null;
  if (!week) return "";
  const spans = week[nzNow(now).dow];
  return spans.length ? `오늘 ${spans.map(([a, b]) => (a === 0 && b >= 1440 ? "24시간" : `${hm(a)}~${hm(b)}`)).join(", ")}` : "오늘 휴무";
}

/** 4인 가족(어른 2 + 아이 2)이 한 번 가면 얼마인가: 가족권과 낱장 합계 중 싼 쪽. 입장 요금이 확인된 곳만 */
export function familyCost(fees: FeeLike[]): { total: number; how: string } | null {
  const once = (k: string) => fees.filter((x) => x.kind === k && x.amount > 0 && !["year", "season", "month", "week"].includes(x.period)).map((x) => x.amount);
  const adult = once("adult_entry"), child = once("child"), pass = once("family_pass");
  const parts = adult.length && child.length ? 2 * Math.min(...adult) + 2 * Math.min(...child) : null;
  const fam = pass.length ? Math.min(...pass) : null;
  if (parts == null && fam == null) {
    if (child.length && !adult.length) return { total: 2 * Math.min(...child), how: "아이 2명 (보호자 요금 미확인)" };
    return null;
  }
  return fam != null && (parts == null || fam <= parts) ? { total: fam, how: "가족권" } : { total: parts!, how: "어른 2 + 아이 2" };
}

const BOOK = { required: "📅 예약 필수", recommended: "📅 예약 권장", walkin: "🚪 예약 없이 이용" } as const;
/** 카드에 붙일 방문 정보 조각들 (확인된 것만) */
export function visitBits(d: Details | undefined, osm: OsmInfo | undefined): string[] {
  const out: string[] = [];
  if (d?.booking && BOOK[d.booking]) out.push(BOOK[d.booking]);
  if (d?.parking) out.push(`🅿️ ${d.parking}`);
  else if (osm?.parking_near) out.push("🅿️ 바로 옆 주차장");
  if (d?.bring) out.push(`🎒 ${d.bring}`);
  if (d?.busy) out.push(`👥 ${d.busy}`);
  if (osm?.wheelchair === "yes") out.push("♿ 휠체어 가능");
  return out;
}

export interface WeekDay { date: string; max: number; min: number; code: number; rain_chance?: number | null; uv?: number | null; wind?: number | null }
/** 주말(토·일) 날씨를 나들이 관점으로: wet(비) / hot(물놀이) / mild(걷기·놀이터) */
export function weekendDays(days: WeekDay[] | undefined): { date: string; label: string; mood: "wet" | "hot" | "mild"; text: string }[] {
  const out = [];
  for (const d of days ?? []) {
    const dow = new Date(d.date + "T00:00:00").getDay();
    if (dow !== 6 && dow !== 0) continue;
    const rain = d.rain_chance ?? 0;
    const mood = rain >= 60 ? "wet" : d.max >= 23 ? "hot" : "mild";
    out.push({ date: d.date, label: dow === 6 ? "토요일" : "일요일", mood: mood as "wet" | "hot" | "mild",
      text: `${d.min}~${d.max}° · 비 ${rain}%${d.uv != null && d.uv >= 6 ? ` · 자외선 ${Math.round(d.uv)} 높음` : ""}${d.wind != null && d.wind >= 35 ? " · 바람 강함" : ""}` });
    if (out.length === 2) break;
  }
  return out;
}
