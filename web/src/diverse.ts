// 오클랜드·이민 탭을 다채롭게: 이민 기사 세 갈래(공식/언론/커뮤니티)·비자 종류 필터·이민 숫자 카드,
// 이번 주 일정 카드(기사 속 날짜), 사건 위치 요약 카드, 주간 정리(일요일엔 펼침). 모두 이미 만든 브리핑·데이터만 씀 (AI 요청 없음).
import type { Brief, Item, SectionKey } from "./types";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const nzDate = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Pacific/Auckland" });
export const isSundayNZ = () => new Date().toLocaleDateString("en-US", { timeZone: "Pacific/Auckland", weekday: "short" }) === "Sun";

// ── 이민 기사 세 갈래 ──
export type Lane = "official" | "media" | "community";
export const LANES: { key: Lane; label: string; note: string }[] = [
  { key: "official", label: "🏛 공식 발표", note: "이민성(INZ)·정부·통계청 원문" },
  { key: "media", label: "📰 언론 보도", note: "뉴질랜드 주요 언론의 해석·현장 기사" },
  { key: "community", label: "🤝 커뮤니티 시각", note: "한인·인도계·중국계·태평양계 매체" },
];
const OFFICIAL = /immigration new zealand|\binz\b|beehive|govt\.nz|government|ministry|mbie|stats nz|statistics new zealand|tribunal|ombudsman|parliament/i;
const COMMUNITY = /awaaz|indian|desi|sikh|pacific media|pmn|samoa|tonga|fiji|filipino|chinese|新西兰|华|chinaz|skykiwi|korea|코리아|한인|일요시사|교민|nzkorea|asian|migrant voice/i;
export function laneOf(it: Item): Lane {
  const src = it.sources.map((s) => `${s.name} ${s.url}`).join(" ");
  if (OFFICIAL.test(src)) return "official";
  if (COMMUNITY.test(src) || /[가-힣]/.test(it.original_title || "") || /[一-鿿]/.test(it.original_title || "")) return "community";
  return "media";
}

// ── 비자 종류 태그 (제목·요약·태그의 낱말로 판정) ──
export const VISAS: { key: string; label: string; re: RegExp }[] = [
  { key: "student", label: "학생", re: /student visa|international student|유학|학생 ?비자|학비|study visa|fee-paying/i },
  { key: "work", label: "취업(AEWV)", re: /aewv|accredited employer|work visa|working holiday|post[- ]study|pswv|green list|그린 ?리스트|취업 ?비자|워크 ?비자|워홀|고용주 인증|잡체크|job check/i },
  { key: "smc", label: "기술이민(SMC)", re: /skilled migrant|\bsmc\b|기술 ?이민|six[- ]point|6점|points system|포인트/i },
  { key: "pr", label: "영주권", re: /residen|permanent resident|\bprv\b|영주권|거주 ?비자|straight to residence|work to residence/i },
  { key: "family", label: "가족", re: /partner|parent|family|spouse|dependent|부모|배우자|가족|자녀|parent boost/i },
  { key: "visitor", label: "방문", re: /visitor visa|tourist|nzeta|\beta\b|방문 ?비자|관광/i },
];
export function visaTags(it: Item): string[] {
  const text = [it.original_title, it.title_ko, ...it.summary_ko, ...it.tags, it.why_it_matters].filter(Boolean).join(" ");
  return VISAS.filter((v) => v.re.test(text)).map((v) => v.key);
}

/** 이민 탭 위쪽: 비자 종류 칩 (전체 + 기사가 있는 종류만) */
export function visaChips(h: H, items: Item[], cur: string, onPick: (k: string) => void): HTMLElement | null {
  const counts = new Map<string, number>();
  for (const it of items) for (const k of visaTags(it)) counts.set(k, (counts.get(k) || 0) + 1);
  if (!counts.size) return null;
  const row = h("div", { class: "chips visa-chips", role: "group", "aria-label": "비자 종류로 보기" });
  const mk = (k: string, label: string, n?: number) => {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(cur === k) }, label, n ? h("small", {}, ` ${n}`) : null);
    b.addEventListener("click", () => onPick(k));
    return b;
  };
  row.append(mk("all", "전체"));
  for (const v of VISAS) if (counts.get(v.key)) row.append(mk(v.key, v.label, counts.get(v.key)));
  return row;
}

// ── 이민 숫자 카드: 최근 7일 이민 기사 속 핵심 수치 + 처리 기간 변화 ──
interface Proc { key: string; name: string; from: string; to: string; delta_days: number }
export function immNumbersCard(h: H, recent: Brief[], proc: Proc[]): HTMLElement | null {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), seen = new Set<string>();
  const figs: { v: string; l: string; t: string; url: string }[] = [];
  for (const b of [...recent].sort((x, y) => y.date.localeCompare(x.date))) {
    if (b.date < since) continue;
    for (const it of b.sections.nz_immigration?.items ?? []) {
      if (!it.figure?.v || seen.has(it.id)) continue;
      seen.add(it.id);
      figs.push({ v: it.figure.v, l: it.figure.l, t: it.title_ko, url: it.sources[0]?.url || "" });
    }
  }
  const tiles = [
    ...proc.slice(0, 2).map((p) => h("div", { class: "num-tile" }, h("b", { class: p.delta_days > 0 ? "down" : "up" }, `${p.from} → ${p.to}`), h("span", {}, `${p.name} 처리 기간`), h("small", { class: "muted" }, p.delta_days > 0 ? `${p.delta_days}일 늘어남` : `${-p.delta_days}일 줄어듦`))),
    ...figs.slice(0, 4 - Math.min(2, proc.length)).map((f) => h("a", { class: "num-tile", href: safe(f.url), target: "_blank", rel: "noopener noreferrer", title: f.t }, h("b", {}, f.v), h("span", {}, f.l), h("small", { class: "muted" }, f.t))),
  ];
  if (!tiles.length) return null;
  return h("section", { class: "num-card", "aria-label": "이번 주 이민 숫자" }, h("h2", { class: "sec-title" }, "🔢 이번 주 이민 숫자"), h("div", { class: "num-grid" }, ...tiles),
    h("p", { class: "muted small" }, "최근 7일 이민 기사 속 핵심 수치와 비자 처리 기간 변화예요."));
}

// ── 이번 주 일정: 기사 제목·요약에 나온 앞으로 14일 안의 날짜 ──
export function scheduleCard(h: H, brief: Brief, keys: SectionKey[]): HTMLElement | null {
  const today = nzDate(), y = +today.slice(0, 4), end = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const rows: { d: string; t: string; url: string; sec: string }[] = [], seen = new Set<string>();
  for (const k of keys) for (const it of brief.sections[k]?.items ?? []) {
    const text = [it.title_ko, ...it.summary_ko].join(" ");
    for (const m of text.matchAll(/(\d{1,2})월\s?(\d{1,2})일/g)) {
      const mo = +m[1], da = +m[2];
      if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
      let d = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
      if (d < today && mo < +today.slice(5, 7) - 6) d = `${y + 1}${d.slice(4)}`;   // 연말에 내년 1월 날짜
      if (d < today || d > end || seen.has(it.id + d)) continue;
      seen.add(it.id + d);
      rows.push({ d, t: it.title_ko, url: it.sources[0]?.url || "", sec: brief.sections[k]?.label || "" });
    }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.d.localeCompare(b.d));
  const dow = (d: string) => "일월화수목금토"[new Date(d + "T12:00:00").getDay()];
  return h("section", { class: "sched-card", "aria-label": "다가오는 일정" }, h("h2", { class: "sec-title" }, "🗓 다가오는 일정 ", h("small", { class: "muted" }, "기사에 나온 날짜 · 2주 안")),
    h("ul", {}, ...rows.slice(0, 6).map((r) => h("li", {}, h("span", { class: "sd" }, `${+r.d.slice(5, 7)}/${+r.d.slice(8)}(${dow(r.d)})`),
      h("a", { href: safe(r.url), target: "_blank", rel: "noopener noreferrer" }, r.t), h("small", { class: "muted" }, ` ${r.sec}`)))));
}

// ── 오늘 사건 위치 요약(지도 칩으로 이어짐) ──
export function incidentPinsCard(h: H, brief: Brief, onMap: () => void): HTMLElement | null {
  const items = brief.sections.akl_safety?.items ?? [];
  const pins = items.map((it) => it.incident?.suburb || it.incident?.location || "").filter(Boolean);
  if (!pins.length) return null;
  const counts = new Map<string, number>();
  for (const p of pins) counts.set(p, (counts.get(p) || 0) + 1);
  const btn = h("button", { type: "button", class: "chip" }, "🗺 지도에서 보기");
  btn.addEventListener("click", onMap);
  return h("section", { class: "pins-card", "aria-label": "오늘 사건 위치" }, h("div", { class: "pins-head" }, h("b", {}, "📍 오늘 사건 위치"), btn),
    h("div", { class: "pins" }, ...[...counts].map(([s, n]) => h("span", { class: "pin" }, `📍 ${s}${n > 1 ? ` ×${n}` : ""}`))));
}

// ── 주간 정리: 일요일엔 펼쳐서, 다른 날엔 접어서 ──
interface WeeklyItem { title_ko: string; url: string; source: string; date: string; section: string; importance: number; days?: number }
interface Weekly { from: string; to: string; groups: { id: string; label: string; items: WeeklyItem[] }[]; processing: Proc[] }
interface PolicyNews { items: { date: string; title: string; url: string; change?: boolean }[] }
export function weeklyCard(h: H, kind: "akl" | "imm", w: Weekly | null, pn: PolicyNews | null): HTMLElement | null {
  if (!w) return null;
  const open = isSundayNZ();
  const head = kind === "akl" ? "🗞 이번 주 오클랜드에서 바뀐 것" : "🧾 이번 주 이민 규정 변화 요약";
  let list: HTMLElement[] = [];
  if (kind === "akl") {
    const g = w.groups.find((x) => x.id === "akl");
    list = (g?.items ?? []).slice(0, 5).map((it, i) => h("li", {}, h("span", { class: "wn" }, String(i + 1)),
      h("span", {}, h("a", { href: safe(it.url), target: "_blank", rel: "noopener noreferrer" }, it.title_ko), h("small", { class: "muted" }, ` ${it.section} · ${it.date.slice(5).replace("-", "/")}${it.days && it.days > 1 ? ` · ${it.days}일 이어짐` : ""}`))));
  } else {
    const changes = (pn?.items ?? []).filter((x) => x.change && x.date >= w.from).slice(0, 5);
    list = [
      ...changes.map((c, i) => h("li", {}, h("span", { class: "wn" }, String(i + 1)), h("span", {}, h("a", { href: safe(c.url), target: "_blank", rel: "noopener noreferrer" }, c.title), h("small", { class: "muted" }, ` ${c.date.slice(5).replace("-", "/")}`)))),
      ...w.processing.map((p) => h("li", {}, h("span", { class: "wn" }, "⏱"), h("span", {}, `${p.name} 처리 기간 ${p.from} → ${p.to}`))),
    ];
    if (!list.length) list = [h("li", {}, h("span", { class: "wn" }, "✓"), h("span", {}, "이번 주에 확인된 이민 규정 변경 소식이 없어요."))];
  }
  if (!list.length) return null;
  const d = h("details", { class: "weekly-card" }, h("summary", {}, head, h("small", { class: "muted" }, ` ${w.from.slice(5).replace("-", "/")}~${w.to.slice(5).replace("-", "/")}${open ? " · 일요일 정리" : ""}`)), h("ol", {}, ...list));
  if (open) d.open = true;
  return d;
}
