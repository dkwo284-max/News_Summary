// 📅 일정 달력 + 🧭 시즌 생활 안내 (홈). AI 없음.
// - 공휴일: 뉴질랜드 법정 규칙으로 계산(주말이면 월요일로 대체, 부활절 계산, 오클랜드 기념일 = 1월 29일에 가장 가까운 월요일), 마타리키는 법으로 정한 날짜표
// - 쇼핑 시즌: 블랙프라이데이(미국 추수감사절 다음 날)·사이버먼데이·박싱데이 세일
// - 학교 방학·오클랜드 축제: 공식 페이지로 확인한 날짜만 data/calendar.json 에 (출처 링크 포함, 미확정은 표시)
// - 안내 카드: 일정 7일 전부터 다음 날까지 (영업시간·대중교통·수당·소비자 권리 — 공식 안내 링크)
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

export type Kind = "holiday" | "shopping" | "event" | "school";
export interface CalEvent { date: string; end?: string; title: string; kind: Kind; note?: string; url?: string; tentative?: boolean; key?: string; actual?: string }

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const D = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const addD = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
const dow = (d: Date) => d.getUTCDay();
const nthWeekday = (y: number, m: number, wd: number, n: number) => { const f = D(y, m, 1); return addD(f, ((wd - dow(f) + 7) % 7) + (n - 1) * 7); };
const mondayise = (d: Date) => (dow(d) === 6 ? addD(d, 2) : dow(d) === 0 ? addD(d, 1) : d);
/** 연달아 있는 두 공휴일(1/1·1/2, 12/25·12/26)의 대체 규칙(Holidays Act 2003 s45·45A)
 *  금·토 → 금·월 / 토·일 → 월·화 / 일·월 → 화·월(둘째 날은 그대로) */
function pair(a: Date, b: Date): [Date, Date] {
  const w = dow(a);
  if (w === 5) return [a, addD(a, 3)];
  if (w === 6) return [addD(a, 2), addD(a, 3)];
  if (w === 0) return [addD(a, 2), b];
  return [a, b];
}
function easter(y: number): Date {   // 그레고리력 부활절(익명 알고리즘)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return D(y, mo, da);
}
// 마타리키 공휴일(Te Kāhui o Matariki Public Holiday Act 2022 날짜표)
const MATARIKI: Record<number, string> = { 2026: "2026-07-10", 2027: "2027-06-25", 2028: "2028-07-14", 2029: "2029-07-06", 2030: "2030-06-21" };

function holidays(y: number): CalEvent[] {
  const out: CalEvent[] = [];
  const add = (d: Date, title: string, actual?: Date, key?: string) => out.push({ date: ymd(d), title, kind: "holiday", key, actual: actual ? ymd(actual) : ymd(d),
    note: actual && ymd(actual) !== ymd(d) ? `${md(ymd(actual))}이 주말이라 이날 쉼` : undefined });
  const [ny1, ny2] = pair(D(y, 1, 1), D(y, 1, 2));
  add(ny1, "새해 첫날", D(y, 1, 1)); add(ny2, "새해 다음 날", D(y, 1, 2));
  const a29 = D(y, 1, 29), back = (dow(a29) + 6) % 7, fwd = (8 - dow(a29)) % 7;
  add(back <= fwd ? addD(a29, -back) : addD(a29, fwd), "오클랜드 기념일 (오클랜드만)");
  add(mondayise(D(y, 2, 6)), "와이탕이 데이", D(y, 2, 6));
  const e = easter(y);
  add(addD(e, -2), "성금요일", undefined, "easter"); add(addD(e, 1), "부활절 월요일");
  add(mondayise(D(y, 4, 25)), "안작 데이", D(y, 4, 25), "anzac");
  add(nthWeekday(y, 6, 1, 1), "국왕 탄신일");
  if (MATARIKI[y]) out.push({ date: MATARIKI[y], title: "마타리키", kind: "holiday" });
  add(nthWeekday(y, 10, 1, 4), "노동절");
  const [x1, x2] = pair(D(y, 12, 25), D(y, 12, 26));
  add(x1, "크리스마스", D(y, 12, 25), "closed"); add(x2, "박싱데이", D(y, 12, 26));
  return out;
}
function shopping(y: number): CalEvent[] {
  const bf = addD(nthWeekday(y, 11, 4, 4), 1);
  return [
    { date: ymd(bf), title: "블랙프라이데이 세일", kind: "shopping", key: "sale" },
    { date: ymd(addD(bf, 3)), title: "사이버먼데이 (온라인 세일)", kind: "shopping", key: "sale" },
    { date: `${y}-12-26`, end: `${y + 1}-01-02`, title: "박싱데이 세일", kind: "shopping", key: "sale" },
  ];
}

export async function loadCalendar(): Promise<CalEvent[]> {
  const y = +today().slice(0, 4);
  let curated: CalEvent[] = [];
  try { const r = await fetch("./data/calendar.json", { cache: "no-cache" }); if (r.ok) curated = ((await r.json()).events || []) as CalEvent[]; } catch { /* 없으면 규칙 일정만 */ }
  const rule = [y - 1, y, y + 1].flatMap((n) => [...holidays(n), ...shopping(n)]);
  return [...rule, ...curated].sort((a, b) => a.date.localeCompare(b.date));
}

const KIND = { holiday: { ic: "🏖", l: "공휴일" }, shopping: { ic: "🛍", l: "쇼핑 시즌" }, event: { ic: "🎉", l: "행사" }, school: { ic: "🎒", l: "학교" } } as const;
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Pacific/Auckland" });
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const md = (s: string) => { const d = new Date(s + "T12:00:00Z"); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"일월화수목금토"[d.getUTCDay()]})`; };
const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");

/** 홈: 앞으로 2주 일정 + 가장 가까운 D-day */
export function calendarCard(h: H, ev: CalEvent[]): HTMLElement | null {
  const t = today(), end = new Date(Date.parse(t) + 14 * 864e5).toISOString().slice(0, 10);
  const up = ev.filter((e) => (e.end || e.date) >= t && e.date <= end);
  const next = ev.find((e) => e.date > t && e.kind !== "school");
  if (!up.length && !next) return null;
  const row = (e: CalEvent) => { const dd = days(t, e.date);
    return h("li", { class: `cal-${e.kind}` }, h("span", { class: "cal-d" }, md(e.date)),
      h("span", { class: "cal-t" }, `${KIND[e.kind].ic} `, e.url ? h("a", { href: safe(e.url), target: "_blank", rel: "noopener noreferrer" }, e.title) : e.title,
        e.tentative ? h("small", { class: "muted" }, " (미확정)") : null, e.note ? h("small", { class: "muted" }, ` · ${e.note}`) : null),
      h("span", { class: "cal-dd" }, dd <= 0 ? (e.end && e.end >= t ? "진행 중" : "오늘") : `D-${dd}`)); };
  return h("section", { class: "home-card cal-card", "aria-labelledby": "hm-cal" },
    h("h2", { id: "hm-cal" }, "📅 앞으로 2주 일정", next && !up.includes(next) ? h("small", { class: "muted" }, ` · 다음: ${next.title} D-${days(t, next.date)}`) : null),
    up.length ? h("ul", { class: "cal-list" }, ...up.slice(0, 7).map(row)) : h("p", { class: "muted" }, "2주 안에 공휴일·쇼핑 시즌·주요 행사가 없어요."),
    h("p", { class: "muted small" }, "공휴일은 법정 규칙으로 계산(주말이면 대체 휴일), 학교·행사 날짜는 교육부·오클랜드 공식 안내 기준이에요. 학교별 개학일은 학교에 확인하세요."));
}

// ── 시즌 생활 안내: 일정 7일 전부터 다음 날까지 ──
const LINK = {
  holidays: ["공휴일 근무·수당 (고용부)", "https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-rights-for-employees"],
  at: ["대중교통 시간표 (AT)", "https://at.govt.nz/"],
  rubbish: ["쓰레기 수거일 (오클랜드 시청)", "https://www.aucklandcouncil.govt.nz/"],
  consumer: ["소비자 권리 (소비자보호)", "https://www.consumerprotection.govt.nz/"],
  netsafe: ["온라인 사기 신고 (Netsafe)", "https://netsafe.org.nz/"],
  school: ["학기·방학 날짜 (교육부)", "https://www.education.govt.nz/term-dates-and-holidays"],
} as const;
function guideFor(e: CalEvent): { title: string; tips: string[]; links: (keyof typeof LINK)[] } {
  if (e.kind === "holiday") return { title: `${e.title} 준비`, tips: [
    e.key === "closed" ? `${md(e.actual || e.date)} 당일은 법에 따라 대부분의 상점이 문을 닫아요(편의점·약국·주유소 등 일부 예외). 장보기는 전날까지.`
      : e.key === "easter" ? "성금요일과 부활절 일요일에는 법에 따라 대부분의 상점이 문을 닫아요(편의점·약국·주유소 등 일부 예외)."
      : e.key === "anzac" ? `안작 데이 당일 ${md(e.actual || e.date)}에는 오후 1시 전까지 대부분의 상점이 문을 닫아요.`
      : "슈퍼·약국·병원 영업시간이 줄 수 있어요. 가는 곳 시간을 미리 확인하세요.",
    "공휴일에 일하면 평소 임금의 1.5배, 원래 근무일이었다면 대체 휴일 하루를 받아요.",
    "버스·기차·페리는 공휴일 시간표(보통 일요일 수준)로 운행해요.", "쓰레기 수거 요일이 바뀌는 경우가 있어요."], links: ["holidays", "at", "rubbish"] };
  if (e.kind === "shopping") return { title: `${e.title} — 사기 전에`, tips: [
    "하자 있는 물건은 소비자보장법에 따라 수리·교환·환불을 요구할 수 있어요. 단순 변심 환불은 매장 정책에 따라 달라요.",
    "'정가 대비 할인' 표시가 사실이 아니면 공정거래법 위반이에요. 원래 가격을 확인하세요.",
    "가짜 쇼핑몰·택배 문자 사기가 몰리는 시기예요. 처음 보는 사이트는 후기·회사 정보를 확인하고, 신용카드로 결제하세요."], links: ["consumer", "netsafe"] };
  if (e.kind === "event") return { title: `${e.title} 가기 전에`, tips: ["행사장 주변 도로 통제가 있을 수 있어요. 대중교통 이용을 권해요.", "야외 행사는 날씨에 따라 연기·취소될 수 있어요. 당일 공식 안내를 확인하세요."], links: ["at"] };
  return { title: `${e.title}`, tips: ["방학 프로그램·돌봄은 일찍 마감돼요. 미리 예약하세요.", "학교마다 개학·방학일이 하루 이틀 다를 수 있어요."], links: ["school"] };
}
export function seasonGuides(h: H, ev: CalEvent[]): HTMLElement | null {
  const t = today();
  // 시작 7일 전부터 끝난 다음 날까지(방학은 시작 다음 날까지만)
  const near = ev.filter((e) => days(t, e.date) <= 7 && days(e.kind === "school" ? e.date : e.end || e.date, t) <= 1 && !e.tentative);
  const seen = new Set<string>(), cards: HTMLElement[] = [];
  for (const e of near) {
    const g = guideFor(e), k = e.kind === "shopping" ? "shopping" : e.kind === "holiday" ? "holiday" : `${e.kind}-${e.title}`;   // 공휴일 안내는 가장 가까운 하나만
    if (seen.has(k) || cards.length >= 2) continue;
    seen.add(k);
    const dd = days(t, e.date);
    cards.push(h("details", { class: `guide-card guide-${e.kind}` }, h("summary", {}, `🧭 ${g.title}`, h("small", { class: "muted" }, ` · ${md(e.date)} ${dd > 0 ? `D-${dd}` : dd === 0 ? "오늘" : "진행 중"}`)),
      h("ul", {}, ...g.tips.map((x) => h("li", {}, x))),
      h("p", { class: "guide-links" }, ...g.links.map((l) => h("a", { href: LINK[l][1], target: "_blank", rel: "noopener noreferrer" }, `${LINK[l][0]} ↗`)))));
  }
  if (!cards.length) return null;
  (cards[0] as HTMLDetailsElement).open = true;
  return h("div", { class: "guides" }, ...cards);
}
