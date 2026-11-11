// 홈 화면 추가 카드: 오늘의 숫자 · 이어지는 이슈 타임라인 · 주간 날씨 · 생활비 대시보드 · 한국↔뉴질랜드 같은 주제 · 오늘 치안과 내 동네 거리 ·
// 주제 흐름 히트맵 · 3분 읽기. 모두 이미 만들어진 브리핑·데이터 파일만 읽는다 (AI 요청 없음).
import { loadIncidents } from "./crimemap";
import { km, loadGP } from "./gpmap";
import type { Brief, Item, SectionKey } from "./types";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];
export interface Row { it: Item; key: SectionKey; tab: string }

const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const a = (h: H, url: string, text: string) => h("a", { href: safe(url), target: "_blank", rel: "noopener noreferrer" }, text);
const card = (h: H, id: string, title: string, ...children: (Node | string | null | undefined)[]) =>
  h("section", { class: "home-card", "aria-labelledby": id }, h("h2", { id }, title), ...children);

// ── 오늘의 숫자 ──
const NUM_RE = /(약\s?)?\d[\d,.]*\s?(?:%|퍼센트|억\s?(?:달러|원)?|조\s?(?:달러|원)?|만\s?(?:명|달러|원|건|가구)?|달러|원|명|건|배|가구)/;
/** 기사에서 핵심 수치 하나: AI 가 뽑은 figure 가 있으면 그것, 없으면 요약 첫 두 줄에서 단위가 붙은 첫 숫자 */
export function figureOf(it: Item): { v: string; l: string } | null {
  if (it.figure?.v && it.figure.l) return it.figure;
  for (const line of it.summary_ko.slice(0, 2)) {
    const m = line.match(NUM_RE);
    if (m) return { v: m[0].replace(/\s+/g, " ").trim(), l: it.tags[0] ?? "" };
  }
  return null;
}
export function numbersCard(h: H, rows: Row[]): HTMLElement | null {
  const picked: { f: { v: string; l: string }; it: Item }[] = [];
  for (const { it } of [...rows].filter((x) => !x.it.carried_from).sort((x, y) => y.it.importance - x.it.importance)) {
    const f = figureOf(it);
    if (f && !picked.some((p) => p.f.v === f.v)) picked.push({ f, it });
    if (picked.length === 3) break;
  }
  if (!picked.length) return null;
  return card(h, "hm-num", "🔢 오늘의 숫자", h("div", { class: "num-tiles" }, ...picked.map(({ f, it }) =>
    h("a", { class: "num-tile", href: safe(it.sources[0]?.url ?? "#"), target: "_blank", rel: "noopener noreferrer" },
      h("b", {}, f.v), f.l ? h("span", { class: "num-l" }, f.l) : null, h("small", {}, it.title_ko)))));
}

// ── 이어지는 이슈 타임라인 ──
export interface WeekThread { title_ko: string; days: number; steps?: { date: string; title_ko: string; url: string }[] }
/** 오늘 기사에 붙은 지난 보도(AI 가 확인한 흐름)를 먼저, 모자라면 최근 7일 규칙 기반 묶음(weekly.json)으로 채운다 */
export function threadsCard(h: H, brief: Brief, rows: Row[], week: WeekThread[] = []): HTMLElement | null {
  type Step = { date: string; title: string; url: string };
  const list: { steps: Step[]; changed?: string }[] = rows.filter((x) => (x.it.timeline?.length ?? 0) >= 1 && !x.it.carried_from)
    .sort((x, y) => (y.it.timeline!.length - x.it.timeline!.length) || (y.it.importance - x.it.importance)).slice(0, 3)
    .map(({ it }) => ({ changed: it.changed, steps: [...(it.timeline ?? []).slice(-4).map((t) => ({ date: t.date, title: t.title_ko, url: t.url })),
      { date: brief.date, title: it.title_ko, url: it.sources[0]?.url ?? "" }] }));
  const recentDay = new Date(Date.parse(brief.date) - 2 * 864e5).toISOString().slice(0, 10);
  for (const t of week) {
    if (list.length >= 3) break;
    const steps = (t.steps ?? []).filter((s) => s.date <= brief.date);
    if (steps.length < 2 || steps[steps.length - 1].date < recentDay) continue;  // 최근 이틀 안에 이어진 이슈만
    if (list.some((l) => l.steps.some((s) => steps.some((x) => x.url && x.url === s.url)))) continue;
    list.push({ steps: steps.slice(-5).map((s) => ({ date: s.date, title: s.title_ko, url: s.url })) });
  }
  if (!list.length) return null;
  return card(h, "hm-thr", "🧵 이어지는 이슈", h("p", { class: "muted" }, "며칠째 이어지는 소식의 흐름이에요. 제목을 누르면 그날 기사로 갑니다."),
    ...list.map(({ steps, changed }) => h("div", { class: "thr" }, h("ol", { class: "thr-line" }, ...steps.map((s, i) => {
      const now = i === steps.length - 1;
      return h("li", { class: now ? "now" : "" }, h("span", { class: "thr-d" }, s.date === brief.date ? "오늘" : md(s.date)), h("i", { "aria-hidden": "true" }), s.url ? a(h, s.url, s.title) : h("span", {}, s.title));
    })), changed ? h("p", { class: "thr-ch" }, h("strong", {}, "달라진 점 "), changed) : null)));
}

// ── 주간 날씨 ──
const WICON = (c: number) => (c <= 1 ? "☀️" : c === 2 ? "🌤" : c === 3 ? "☁️" : c <= 48 ? "🌫" : c <= 67 ? "🌧" : c <= 77 ? "❄️" : c <= 82 ? "🌦" : "⛈");
const UV = (u: number) => (u < 3 ? "낮음" : u < 6 ? "보통" : u < 8 ? "높음" : u < 11 ? "매우 높음" : "위험");
/** [13,14,15,19] → "13~16시, 19~20시" */
export function hourRanges(hs: number[]): string {
  const out: string[] = [];
  let s = -1, p = -2;
  for (const x of [...hs, 99]) {
    if (x !== p + 1) { if (s >= 0) out.push(`${s}~${p + 1}시`); s = x; }
    p = x;
  }
  return out.join(", ");
}
export function weatherCard(h: H, brief: Brief): HTMLElement | null {
  const w = brief.extras?.auckland_weather;
  if (!w?.days?.length) return null;
  const lo = Math.min(...w.days.map((d) => d.min)), hi = Math.max(...w.days.map((d) => d.max)), span = Math.max(1, hi - lo);
  const dow = (d: string) => "일월화수목금토"[new Date(d + "T00:00:00").getDay()];
  const chips: string[] = [];
  if (w.rain_hours?.length) chips.push(`☔ 비 올 가능성 높은 시간 ${hourRanges(w.rain_hours)}`);
  else if (w.rain_chance != null) chips.push(w.rain_chance >= 50 ? `☔ 강수 확률 ${w.rain_chance}%` : "☂️ 오늘은 비 걱정 적음");
  if (w.uv != null) chips.push(`🕶 자외선 ${Math.round(w.uv)} (${UV(w.uv)})${w.uv >= 6 ? " · 선크림 필수" : ""}`);
  if (w.wind != null) chips.push(`💨 최대 풍속 ${Math.round(w.wind)}km/h${w.wind >= 40 ? " · 강풍 주의" : ""}`);
  const best = [...w.days.slice(1)].filter((d) => (d.rain_chance ?? 0) < 40).sort((x, y) => y.max - x.max)[0];
  if (best) chips.push(`🏖 야외 활동 추천 ${dow(best.date)}요일 (${best.max}°, 비 ${best.rain_chance ?? 0}%)`);
  return card(h, "hm-wx", "🌤 오클랜드 주간 날씨",
    h("div", { class: "wx", role: "list" }, ...w.days.map((d, i) => h("div", { class: `wx-d${i === 0 ? " today" : ""}`, role: "listitem", title: `${md(d.date)} ${d.desc} ${d.min}~${d.max}° 강수 ${d.rain_chance ?? "?"}%` },
      h("span", { class: "wx-w" }, i === 0 ? "오늘" : dow(d.date)), h("span", { class: "wx-i", "aria-hidden": "true" }, WICON(d.code)),
      h("span", { class: "wx-bar", "aria-hidden": "true" }, h("i", { style: `top:${((hi - d.max) / span * 100).toFixed(1)}%;bottom:${((d.min - lo) / span * 100).toFixed(1)}%` })),
      h("span", { class: "wx-t" }, h("b", {}, `${d.max}°`), ` ${d.min}°`), h("span", { class: `wx-r${(d.rain_chance ?? 0) >= 50 ? " wet" : ""}` }, d.rain_chance != null ? `${d.rain_chance}%` : "")))),
    h("ul", { class: "wx-chips" }, ...chips.map((c) => h("li", {}, c))),
    h("p", { class: "board-note" }, "막대는 최저~최고 기온, 아래 숫자는 강수 확률이에요. 출처: Open-Meteo."));
}

// ── 생활비 대시보드 ──
export function costsCard(h: H, brief: Brief, recent: Brief[] | null): HTMLElement | null {
  const ex = brief.extras ?? ({} as Brief["extras"]);
  const past = [...(recent ?? [])].filter((b) => b.date < brief.date).sort((x, y) => x.date.localeCompare(y.date))[0];
  const ago = past ? `${Math.round((Date.parse(brief.date) - Date.parse(past.date)) / 864e5)}일 전` : "";
  const tiles: HTMLElement[] = [];
  const tile = (icon: string, label: string, value: string, delta: string, cls: string, note: string) =>
    tiles.push(h("div", { class: "cost-tile" }, h("span", { class: "cost-l" }, `${icon} ${label}`), h("b", {}, value), delta ? h("small", { class: cls }, delta) : null, note ? h("small", { class: "muted" }, note) : null));
  const dir = (d: number, unit: string, digits = 0) => (d === 0 ? "변동 없음" : `${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(digits)}${unit}`);
  const cls = (d: number) => (d > 0 ? "up" : d < 0 ? "down" : "flat");
  const rent = ex.living_costs?.rent;
  if (rent) tile("🏠", `오클랜드 중위 렌트 (${rent.month})`, `주 $${rent.median}`, rent.yoy_pct != null ? `1년 전보다 ${dir(rent.yoy_pct, "%", 1)}` : "", cls(rent.yoy_pct ?? 0), `한 달 약 $${Math.round(rent.median * 52 / 12).toLocaleString("en-NZ")}`);
  const f = ex.living_costs?.fuel?.petrol91, pf = past?.extras?.living_costs?.fuel?.petrol91;
  if (f) {
    const d = pf ? Math.round((f.nzd_per_l - pf.nzd_per_l) * 100) : f.wow_cents ?? 0;
    tile("⛽", "휘발유 91", `$${f.nzd_per_l.toFixed(2)}/L`, `${pf ? ago : "지난주"}보다 ${dir(d, "센트")}`, cls(d), `50L 주유 약 $${(f.nzd_per_l * 50).toFixed(0)}${d ? ` (${d > 0 ? "+" : "−"}$${Math.abs(d * 0.5).toFixed(1)})` : ""}`);
  }
  if (ex.nzd_krw) {
    const p = past?.extras?.nzd_krw, d = p ? ex.nzd_krw - p : 0;
    tile("💱", "NZD/KRW", `${ex.nzd_krw.toLocaleString("ko-KR")}원`, p ? `${ago}보다 ${dir(d, "원", 1)}` : "", cls(d),
      p && d ? `1,000달러 환전 시 ${d > 0 ? "+" : "−"}${Math.abs(Math.round(d * 1000)).toLocaleString("ko-KR")}원` : "1뉴질랜드달러 기준");
  }
  const nz = ex.policy_rates?.rates?.NZ;
  if (nz) {
    const d = nz.previous != null ? nz.value - nz.previous : 0;
    tile("🏦", "NZ 기준금리 (OCR)", `${nz.value}%`, nz.previous != null ? `직전 ${nz.previous}% → ${dir(d, "%p", 2)}` : "", cls(d), nz.changed_on ? `${nz.changed_on} 변경` : "");
  }
  if (tiles.length < 2) return null;
  return card(h, "hm-cost", "💸 생활비 한눈에", h("div", { class: "cost-tiles" }, ...tiles),
    h("p", { class: "board-note" }, "렌트는 Tenancy Services 신규 보증금 기준, 유가는 MBIE 전국 평균이에요. ▲는 올랐다(부담 증가)는 뜻이고, 환율 ▲는 원화로 바꿀 때 유리합니다."));
}

// ── 한국 ↔ 뉴질랜드 같은 주제 ──
const PAIR_TOPICS = ["금리", "부동산", "주거", "렌트", "물가", "환율", "고용", "임금", "교육", "의료", "이민", "비자", "증시", "기술", "교통", "재난", "날씨", "치안"];
export function pairs(rows: Row[]): { topic: string; kr: Item; nz: Item }[] {
  const out: { topic: string; kr: Item; nz: Item }[] = [];
  const used = new Set<string>();
  for (const topic of PAIR_TOPICS) {
    const has = (x: Row) => x.it.tags.includes(topic) && !x.it.carried_from && !used.has(x.it.id);
    const best = (pre: (k: string) => boolean) => rows.filter((x) => pre(x.key) && has(x)).sort((x, y) => y.it.importance - x.it.importance)[0];
    const kr = best((k) => k.startsWith("kr_")), nz = best((k) => !k.startsWith("kr_"));
    if (kr && nz) {
      out.push({ topic, kr: kr.it, nz: nz.it });
      used.add(kr.it.id).add(nz.it.id);
    }
  }
  return out.sort((x, y) => (y.kr.importance + y.nz.importance) - (x.kr.importance + x.nz.importance)).slice(0, 3);
}
export function pairsCard(h: H, rows: Row[]): HTMLElement | null {
  const ps = pairs(rows);
  if (!ps.length) return null;
  const side = (flag: string, it: Item) => h("div", { class: "pair-side" }, h("span", { class: "pair-flag" }, flag), h("div", {}, h("strong", {}, it.sources[0] ? a(h, it.sources[0].url, it.title_ko) : it.title_ko), h("p", {}, it.summary_ko[0] ?? "")));
  return card(h, "hm-pair", "🇰🇷↔🇳🇿 같은 주제, 두 나라", ...ps.map((p) => h("div", { class: "pair" }, h("span", { class: "pair-topic" }, p.topic), side("🇰🇷", p.kr), side("🇳🇿", p.nz))));
}

// ── 오늘 치안: 내 동네에서 얼마나 떨어져 있나 ──
export async function safetyCard(h: H, brief: Brief, suburbs: string[], goTab: () => void): Promise<HTMLElement | null> {
  const [inc, gp] = await Promise.all([loadIncidents(), loadGP()]);
  if (!inc) return null;
  const today = inc.incidents.filter((e) => e.date === brief.date && e.latlon);
  if (!today.length) return null;
  const homes = suburbs.filter((s) => gp?.suburbs[s]).map((s) => [s, gp!.suburbs[s]] as const);
  const rows = today.map((e) => {
    const near = homes.map(([s, ll]) => ({ s, d: km(ll, e.latlon as [number, number]) })).sort((x, y) => x.d - y.d)[0];
    return { e, near };
  }).sort((x, y) => (x.near?.d ?? 999) - (y.near?.d ?? 999));
  const go = h("button", { type: "button", class: "link-btn" }, "지도에서 보기");
  go.addEventListener("click", goTab);
  const closest = rows[0].near;
  return card(h, "hm-safe", "🚓 오늘 치안 소식과 내 동네",
    h("p", {}, `오늘 위치가 확인된 사건 ${rows.length}건`, closest ? ` · 가장 가까운 곳은 ${closest.s}에서 약 ${closest.d.toFixed(closest.d < 10 ? 1 : 0)}km` : ""),
    h("ul", { class: "safe-list" }, ...rows.slice(0, 5).map(({ e, near }) => {
      const pct = near ? Math.max(4, Math.min(100, 100 - (near.d / 30) * 100)) : 0;
      return h("li", {}, h("span", { class: `sev sev-${e.severity}` }, e.crime || "사건"), h("span", { class: "safe-t" }, a(h, e.url, e.title_ko), h("small", { class: "muted" }, ` ${e.suburb || ""}`)),
        near ? h("span", { class: "safe-d", title: `${near.s} 기준 직선 거리` }, h("i", { "aria-hidden": "true" }, h("b", { style: `width:${pct.toFixed(0)}%` })), `${near.d.toFixed(near.d < 10 ? 1 : 0)}km`) : null);
    })), go,
    h("p", { class: "board-note" }, "거리는 관심 동네 중심에서 사건 위치까지의 직선 거리예요(막대가 길수록 가까움). 위치는 기사에 나온 지명 기준입니다."));
}

// ── 주제 흐름 히트맵 ──
export interface Topics { dates: string[]; rows: { tag: string; counts: number[]; total: number }[] }
export function topicsHeat(h: H, t: Topics | undefined): HTMLElement | null {
  if (!t?.rows?.length || t.dates.length < 5) return null;
  const max = Math.max(1, ...t.rows.flatMap((r) => r.counts));
  const n = t.dates.length;
  const grid = h("div", { class: "heat", style: `--n:${n}`, role: "img", "aria-label": `최근 ${n}일 주제별 기사 수: ${t.rows.map((r) => `${r.tag} ${r.total}건`).join(", ")}` });
  grid.append(h("span", {}), ...t.dates.map((d, i) => h("span", { class: "heat-h" }, i === 0 || d.slice(8) === "01" || i === n - 1 ? md(d) : "")));
  for (const r of t.rows) {
    grid.append(h("span", { class: "heat-l" }, r.tag), ...r.counts.map((c, i) => h("i", { style: `--a:${(c / max).toFixed(2)}`, title: `${md(t.dates[i])} ${r.tag} ${c}건` })));
  }
  const rising = t.rows.map((r) => ({ tag: r.tag, d: r.counts.slice(-7).reduce((x, y) => x + y, 0) - r.counts.slice(-14, -7).reduce((x, y) => x + y, 0) })).sort((x, y) => y.d - x.d)[0];
  return h("div", { class: "heat-wrap" }, h("p", {}, h("strong", {}, "🗓 주제 흐름 "), `최근 ${n}일 동안 어떤 주제가 많이 나왔는지 (진할수록 많음)`,
    rising && rising.d > 0 ? ` · 이번 주 늘어난 주제: ${rising.tag} (+${rising.d}건)` : ""), h("div", { class: "heat-scroll" }, grid));
}

// ── 3분 읽기 ──
export function quickRead(h: H, brief: Brief, rows: Row[], top: Row[]): HTMLElement {
  const high = rows.filter((x) => x.it.impact?.level === "high" && !top.some((t) => t.it.id === x.it.id)).slice(0, 4);
  const w = brief.extras?.auckland_weather;
  const head = [w ? `${WICON((w as { code?: number }).code ?? 3)} ${w.desc} ${w.min}~${w.max}°${w.rain_chance != null ? ` · 비 ${w.rain_chance}%` : ""}` : "",
    brief.extras?.nzd_krw ? `💱 ${brief.extras.nzd_krw.toLocaleString("ko-KR")}원` : ""].filter(Boolean).join("  ·  ");
  const alerts = brief.meta?.alerts ?? [];
  const body = h("div", { class: "quick" });
  if (head) body.append(h("p", { class: "quick-head" }, head));
  if (alerts.length) body.append(h("p", { class: "quick-alert" }, `🚨 ${alerts[0].text}${alerts.length > 1 ? ` 외 ${alerts.length - 1}건` : ""}`));
  body.append(h("ol", { class: "quick-top" }, ...top.map(({ it }) => {
    const act = it.impact?.actions?.[0];
    return h("li", {}, h("strong", {}, it.sources[0] ? a(h, it.sources[0].url, it.title_ko) : it.title_ko), h("p", {}, it.summary_ko[0] ?? ""), act ? h("p", { class: "todo" }, `👉 ${act}`) : null);
  })));
  if (high.length) body.append(h("p", { class: "quick-sub" }, "내게 영향 큰 소식"), h("ul", { class: "hm-list" }, ...high.map(({ it }) =>
    h("li", {}, h("strong", {}, it.title_ko), it.impact?.actions?.[0] ? h("small", { class: "muted" }, ` — 👉 ${it.impact.actions[0]}`) : it.impact?.reason ? h("small", { class: "muted" }, ` — ${it.impact.reason}`) : null))));
  const nums = rows.filter((x) => !x.it.carried_from).sort((x, y) => y.it.importance - x.it.importance).map((x) => figureOf(x.it)).filter((f): f is { v: string; l: string } => !!f && !!f.l).slice(0, 3);
  if (nums.length) body.append(h("p", { class: "quick-sub" }, "오늘의 숫자"), h("p", {}, nums.map((f) => `${f.l} ${f.v}`).join("  ·  ")));
  const chars = (body.textContent ?? "").length;
  const mins = Math.max(1, Math.round(chars / 500));
  return h("section", { class: "home-card quick-card", "aria-labelledby": "hm-quick" }, h("h2", { id: "hm-quick" }, `⚡ 3분 읽기 `, h("small", { class: "muted" }, `약 ${mins}분 · ${chars.toLocaleString("ko-KR")}자`)), body);
}
