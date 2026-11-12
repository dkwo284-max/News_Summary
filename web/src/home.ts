// 홈 화면: 오늘 핵심 3 · 내게 영향 큰 소식 · 탭별 새 소식 · 추이 그래프 · 최근 7일 정리 · 저장한 기사. AI 없음 (이미 만들어진 브리핑·데이터 파일만 읽는다).
import { costsCard, numbersCard, pairsCard, quickRead, safetyCard, threadsCard, topicsHeat, weatherCard, monthlyCard, type Monthly, type Topics, type WeekThread } from "./home-extra";
import { loadSaved, removeSaved } from "./news-tools";
import { procDays } from "./tracker";
import type { Brief, Item, SectionKey } from "./types";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

export interface HomeCtx {
  brief: Brief;
  recent: Brief[] | null;
  tabs: { id: string; icon: string; label: string; sections: SectionKey[] }[];
  sections: (tab: { id: string; icon: string; label: string; sections: SectionKey[] }) => SectionKey[];
  fresh: (it: Item) => boolean;
  hidden: (it: Item, key: SectionKey) => boolean;
  goTab: (id: string) => void;
  goSafety: () => void;
  suburbs: string[];
  rerender: () => void;
}

const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const IMPACT = { high: "영향 높음", medium: "영향 보통", low: "영향 낮음", none: "" } as const;
const NS = "http://www.w3.org/2000/svg";

/** 작은 추이 선 그래프 (SVG). values 는 오래된 순. 마지막 점을 강조한다. */
export function sparkline(values: number[], opts: { w?: number; h?: number; label: string }): SVGElement {
  const w = opts.w ?? 120, hh = opts.h ?? 34, pad = 3;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hh}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", opts.label);
  if (values.length < 2) return svg;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), hh - pad - ((v - min) / span) * (hh - pad * 2)] as const);
  const path = document.createElementNS(NS, "polyline");
  path.setAttribute("points", pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "));
  path.setAttribute("class", "spark-line");
  svg.append(path);
  const last = pts[pts.length - 1];
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", last[0].toFixed(1));
  dot.setAttribute("cy", last[1].toFixed(1));
  dot.setAttribute("r", "2.6");
  dot.setAttribute("class", "spark-dot");
  svg.append(dot);
  return svg;
}

async function getJSON<T>(p: string): Promise<T | null> {
  try {
    const r = await fetch(p, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const sectionLabel = (b: Brief, key: SectionKey) => {
  const l = b.sections[key]?.label ?? "";
  return key.startsWith("kr_") ? `한국 ${l}` : key.startsWith("akl_") ? `오클랜드 ${l}` : ["nz_auckland", "nz_immigration"].includes(key) ? l : `뉴질랜드 ${l}`;
};

let onWeekly: ((w: Weekly) => void) | null = null;

export function homeView(h: H, ctx: HomeCtx): HTMLElement {
  const { brief } = ctx;
  const root = h("div", { class: "home" });
  const all: { it: Item; key: SectionKey; tab: string }[] = [];
  const seen = new Set<string>();
  for (const t of ctx.tabs) {
    for (const key of ctx.sections(t)) {
      for (const it of brief.sections[key]?.items ?? []) {
        if (seen.has(it.id) || ctx.hidden(it, key)) continue;
        seen.add(it.id);
        all.push({ it, key, tab: t.id });
      }
    }
  }
  const link = (it: Item, text: string) => (it.sources[0] ? h("a", { href: safe(it.sources[0].url), target: "_blank", rel: "noopener noreferrer" }, text) : text);

  // 0) 3분 읽기 전환 + 오늘의 숫자
  let quick = false;
  try { quick = localStorage.getItem("daily-brief:quick") === "1"; } catch { /* 무시 */ }
  const qb = h("button", { type: "button", class: "quick-btn", "aria-pressed": String(quick) }, quick ? "📖 전체 보기" : "⚡ 3분 읽기");
  qb.addEventListener("click", () => { try { localStorage.setItem("daily-brief:quick", quick ? "0" : "1"); } catch { /* 무시 */ } ctx.rerender(); });
  root.append(h("div", { class: "quick-bar" }, qb, h("small", { class: "muted" }, quick ? "핵심만 모은 요약이에요." : "바쁜 날엔 핵심만 3분 안에.")));

  // 1) 오늘 핵심 3
  const score = (x: { it: Item }) => x.it.importance * 10 + (x.it.impact?.level === "high" ? 18 : x.it.impact?.level === "medium" ? 6 : 0) + (ctx.fresh(x.it) ? 4 : 0);
  const top = [...all].filter((x) => !x.it.carried_from).sort((a, b) => score(b) - score(a)).slice(0, 3);
  if (quick) {
    root.append(quickRead(h, brief, all, top));
    return root;
  }
  const nums = numbersCard(h, all);
  if (nums) root.append(nums);
  const todo = (it: Item) => (it.impact?.actions?.[0] ? h("p", { class: "todo" }, `👉 ${it.impact.actions[0]}`) : null);
  const press = (it: Item) => (it.sources.length >= 2 ? h("span", { class: "press", title: it.sources.map((s) => s.name).join(", ") }, `📰 ${it.sources.length}곳 보도`) : null);
  if (top.length) {
    root.append(h("section", { class: "home-card", "aria-labelledby": "hm-top" }, h("h2", { id: "hm-top" }, "⭐ 오늘 핵심 3"),
      h("ol", { class: "hm-top" }, ...top.map(({ it, key, tab }, i) => {
        const go = h("button", { type: "button", class: "link-btn" }, "탭에서 보기");
        go.addEventListener("click", () => ctx.goTab(tab));
        return h("li", {}, h("span", { class: "hm-rank", "aria-hidden": "true" }, String(i + 1)),
          h("div", {}, h("div", { class: "hm-meta" }, h("span", { class: "sec-label" }, sectionLabel(brief, key)),
            it.impact && it.impact.level !== "none" ? h("span", { class: `impact-badge ${it.impact.level}` }, IMPACT[it.impact.level]) : null, press(it)),
            h("strong", {}, link(it, it.title_ko)), h("p", {}, it.summary_ko[0] ?? ""), todo(it), go));
      }))));
  }

  // 2) 내게 영향 큰 소식
  const high = all.filter((x) => x.it.impact?.level === "high" && !top.some((t) => t.it.id === x.it.id)).slice(0, 5);
  if (high.length) {
    root.append(h("section", { class: "home-card", "aria-labelledby": "hm-high" }, h("h2", { id: "hm-high" }, "🎯 내게 영향 큰 소식"),
      h("ul", { class: "hm-list" }, ...high.map(({ it, key }) => h("li", {}, h("span", { class: "sec-label" }, sectionLabel(brief, key)), " ", h("strong", {}, link(it, it.title_ko)),
        it.impact?.reason ? h("small", { class: "muted" }, ` — ${it.impact.reason}`) : null, todo(it))))));
  }

  // 2-1) 이어지는 이슈 · 주간 날씨 · 생활비 · 두 나라 같은 주제 · 오늘 치안
  const thrSlot = h("div", { class: "home-slot" });
  const thr0 = threadsCard(h, brief, all);
  if (thr0) thrSlot.append(thr0);
  root.append(thrSlot);
  const monSlot = h("div", { class: "home-slot" });
  onWeekly = (w) => {
    const c = threadsCard(h, brief, all, w.threads);
    if (c) thrSlot.replaceChildren(c);
    const mc = monthlyCard(h, w.monthly);
    if (mc) monSlot.replaceChildren(mc);
  };
  for (const c of [weatherCard(h, brief), costsCard(h, brief, ctx.recent), pairsCard(h, all)]) if (c) root.append(c);
  const safeSlot = h("div", { class: "home-slot" });
  root.append(monSlot, safeSlot);
  void safetyCard(h, brief, ctx.suburbs, ctx.goSafety).then((c) => { if (c) safeSlot.append(c); }).catch(() => undefined);

  // 3) 탭별 새 소식 타일
  root.append(h("section", { class: "home-card", "aria-labelledby": "hm-tabs" }, h("h2", { id: "hm-tabs" }, "📚 탭별 오늘 소식"),
    h("div", { class: "hm-tiles" }, ...ctx.tabs.filter((t) => t.sections.length).map((t) => {
      const items = all.filter((x) => x.tab === t.id);
      const fresh = items.filter((x) => ctx.fresh(x.it)).length;
      const b = h("button", { type: "button", class: "hm-tile" }, h("span", { class: "hm-ic", "aria-hidden": "true" }, t.icon), h("span", { class: "hm-n" }, String(items.length)),
        h("span", { class: "hm-l" }, t.label), h("small", {}, fresh ? `새 소식 ${fresh}` : "지난·반복"));
      b.addEventListener("click", () => ctx.goTab(t.id));
      return b;
    }))));

  // 4) 추이 (환율·비자 처리 기간) — 비동기
  const trend = h("section", { class: "home-card", "aria-labelledby": "hm-trend" }, h("h2", { id: "hm-trend" }, "📈 추이"), h("p", { class: "muted" }, "불러오는 중…"));
  root.append(trend);
  void fillTrend(h, trend, ctx);

  // 5) 최근 7일 정리 — 비동기
  const weekly = h("section", { class: "home-card", "aria-labelledby": "hm-week" }, h("h2", { id: "hm-week" }, "📅 최근 7일 정리"), h("p", { class: "muted" }, "불러오는 중…"));
  root.append(weekly);
  void fillWeekly(h, weekly);

  // 6) 저장한 기사
  const saved = loadSaved();
  if (saved.length) {
    root.append(h("section", { class: "home-card", "aria-labelledby": "hm-saved" }, h("h2", { id: "hm-saved" }, `🔖 저장한 기사 ${saved.length}`),
      h("ul", { class: "hm-list" }, ...saved.slice(0, 12).map((s) => {
        const x = h("button", { type: "button", class: "link-btn", "aria-label": `${s.title} 저장 해제` }, "삭제");
        x.addEventListener("click", () => { removeSaved(s.id); ctx.rerender(); });
        return h("li", {}, h("small", { class: "muted" }, `${s.date.slice(5).replace("-", "/")} ${s.section} · `), h("a", { href: safe(s.url), target: "_blank", rel: "noopener noreferrer" }, s.title), " ", x);
      }))));
  }
  return root;
}

async function fillTrend(h: H, box: HTMLElement, ctx: HomeCtx): Promise<void> {
  const rows: HTMLElement[] = [];
  const recent = [...(ctx.recent ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const fx = recent.map((b) => b.extras?.nzd_krw).filter((v): v is number => typeof v === "number");
  const row = (label: string, now: string, delta: string, cls: string, svg: SVGElement) =>
    h("li", { class: "trend-row" }, h("span", { class: "tr-l" }, label), h("span", { class: "tr-v" }, now, h("small", { class: cls }, delta)), svg);
  if (fx.length >= 2) {
    const d = fx[fx.length - 1] - fx[0];
    rows.push(row(`💱 NZD/KRW ${fx.length}일`, `${fx[fx.length - 1].toLocaleString("ko-KR")}원`, `${d > 0 ? "▲" : d < 0 ? "▼" : "＝"}${Math.abs(d).toFixed(1)}`, d > 0 ? "up" : d < 0 ? "down" : "flat",
      sparkline(fx, { label: `NZD/KRW 최근 ${fx.length}일 추이` })));
  }
  const hist = await getJSON<Record<string, { date: string; p50: string; p90: string }[]>>("./data/processing-history.json");
  const names = Object.fromEntries((ctx.brief.extras?.processing_times?.items ?? []).map((i) => [i.key, i.name.replace(/\s*\(.*\)/, "")]));
  for (const [key, list] of Object.entries(hist ?? {})) {
    const vals = list.map((r) => procDays(r.p90 || r.p50)).filter((v): v is number => v != null);
    if (vals.length < 3 || !names[key]) continue;
    const last = list[list.length - 1], d = vals[vals.length - 1] - vals[0];
    rows.push(row(`🛂 ${names[key]}`, last.p90 || last.p50, d === 0 ? "변동 없음" : `${d > 0 ? "▲" : "▼"}${Math.abs(d)}일`, d > 0 ? "up" : d < 0 ? "down" : "flat",
      sparkline(vals, { label: `${names[key]} 처리 기간 추이` })));
  }
  // 변동이 있는 항목을 먼저 보여주고, 변동 없는 비자는 접어 둔다
  const moving = rows.filter((r) => !/변동 없음/.test(r.textContent ?? ""));
  const flat = rows.filter((r) => /변동 없음/.test(r.textContent ?? ""));
  box.replaceChildren(h("h2", { id: "hm-trend" }, "📈 추이"),
    rows.length ? h("ul", { class: "trend" }, ...moving) : h("p", { class: "muted" }, "추이를 그릴 만큼 기록이 쌓이지 않았어요."),
    ...(flat.length ? [h("details", {}, h("summary", {}, `변동 없는 처리 기간 ${flat.length}개`), h("ul", { class: "trend" }, ...flat))] : []),
    h("p", { class: "board-note" }, "환율은 최근 브리핑 값, 처리 기간은 INZ 공식 안내 기록이에요. 오를수록(▲) 길어졌다는 뜻이에요."));
}

interface Weekly {
  from: string; to: string; days: number;
  groups: { id: string; label: string; items: { title_ko: string; url: string; source: string; date: string; section: string; importance: number; impact: string; days: number }[] }[];
  threads: WeekThread[];
  alerts: { date: string; text: string; url?: string }[];
  processing: { name: string; from: string; to: string; delta_days: number }[];
  topics?: Topics;
  monthly?: Monthly | null;
  fx: { first: number; last: number } | null;
}

async function fillWeekly(h: H, box: HTMLElement): Promise<void> {
  const w = await getJSON<Weekly>("./data/weekly.json");
  if (!w) {
    box.replaceChildren(h("h2", { id: "hm-week" }, "📅 최근 7일 정리"), h("p", { class: "muted" }, "아직 정리가 없어요 (내일 브리핑부터 만들어져요)."));
    return;
  }
  onWeekly?.(w);
  const md = (d: string) => d.slice(5).replace("-", "/");
  const parts: (Node | null)[] = [h("p", { class: "muted" }, `${md(w.from)} ~ ${md(w.to)} (${w.days}일치 브리핑)`)];
  if (w.processing.length) parts.push(h("p", {}, h("strong", {}, "⏱ 처리 기간 변화 "), w.processing.map((p) => `${p.name.replace(/\s*\(.*\)/, "")} ${p.from}→${p.to}`).join(" · ")));
  if (w.fx) parts.push(h("p", {}, h("strong", {}, "💱 환율 "), `${w.fx.first.toLocaleString("ko-KR")} → ${w.fx.last.toLocaleString("ko-KR")}원 (${w.fx.last - w.fx.first >= 0 ? "+" : ""}${(w.fx.last - w.fx.first).toFixed(1)})`));
  if (w.threads.length) parts.push(h("p", {}, h("strong", {}, "🧵 여러 날 이어진 이슈 "), w.threads.map((t) => `${t.title_ko} (${t.days}일)`).join(" · ")));
  if (w.alerts.length) parts.push(h("details", {}, h("summary", {}, `🚨 이민 알림 ${w.alerts.length}건`),
    h("ul", { class: "hm-list" }, ...w.alerts.map((a) => h("li", {}, h("small", { class: "muted" }, `${md(a.date)} `), a.url ? h("a", { href: safe(a.url), target: "_blank", rel: "noopener noreferrer" }, a.text) : a.text)))));
  for (const g of w.groups) {
    if (!g.items.length) continue;
    parts.push(h("details", {}, h("summary", {}, `${g.label} 이번 주 핵심 ${g.items.length}`),
      h("ul", { class: "hm-list" }, ...g.items.map((i) => h("li", {}, h("small", { class: "muted" }, `${md(i.date)} · `), h("a", { href: safe(i.url), target: "_blank", rel: "noopener noreferrer" }, i.title_ko),
        i.days > 1 ? h("small", { class: "muted" }, ` · ${i.days}일 보도`) : null, i.impact === "high" ? h("span", { class: "impact-badge high" }, "영향 높음") : null)))));
  }
  const heat = topicsHeat(h, w.topics);
  box.replaceChildren(h("h2", { id: "hm-week" }, "📅 최근 7일 정리"), ...parts.filter((x): x is Node => x != null), ...(heat ? [heat] : []));
}

// ── 데이터 상태 ──
interface Status {
  brief: { date: string; generated_at: string; mode: string; degraded: boolean; degraded_reason: string; retries: number; requests: number };
  feeds: { total: number | null; failed: { id: string; name?: string }[] };
  ai: { today: number; cap: number | null };
  files: Record<string, string | null>;
  week?: { days: number; degraded: number; repaired: number; retries: number; bad_items: number; items: number; redone: number; requests: number; by: Record<string, number> };
}
const KIND_KO: Record<string, string> = { scheduled: "정기", retry: "복구", manual: "수동", side: "부가 작업" };

const FILE_LABEL: Record<string, string> = { processing: "비자 처리 기간", leisure: "레저 요금", spots: "지도 장소", areas: "동네 시세", stores: "매장", policy: "정당 정책", incidents: "치안 사건" };

export async function statusPanel(h: H, host: HTMLElement): Promise<void> {
  const st = await getJSON<Status>("./data/status.json");
  if (!st) {
    host.replaceChildren(h("p", { class: "muted" }, "상태 정보를 불러오지 못했어요."));
    return;
  }
  const ago = (iso: string | null | undefined) => {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    const mins = (Date.now() - d.getTime()) / 60000;
    if (!Number.isFinite(mins)) return iso;
    return mins < 90 ? `${Math.max(1, Math.round(mins))}분 전` : mins < 2880 ? `${Math.round(mins / 60)}시간 전` : `${Math.round(mins / 1440)}일 전`;
  };
  const dot = (ok: boolean, warn = false) => h("i", { class: `st-dot ${ok ? "ok" : warn ? "warn" : "bad"}`, "aria-hidden": "true" });
  const b = st.brief;
  const rows: HTMLElement[] = [
    h("li", {}, dot(!b.degraded, b.degraded), h("span", {}, `브리핑 ${b.date}`), h("small", {}, `${ago(b.generated_at)} 생성 · AI 요청 ${b.requests}회${b.degraded ? ` · ⚠️ 요약 일부 실패(${b.retries}회 재시도)` : ""}`)),
    h("li", {}, dot(st.feeds.failed.length === 0, st.feeds.failed.length < 3), h("span", {}, "뉴스 피드"), h("small", {}, `${st.feeds.total ?? "?"}개 중 실패 ${st.feeds.failed.length}${st.feeds.failed.length ? ` (${st.feeds.failed.map((f) => f.name || f.id).slice(0, 3).join(", ")})` : ""}`)),
    h("li", {}, dot(true), h("span", {}, "AI 사용"), h("small", {}, `오늘 ${st.ai.today}회${st.ai.cap ? ` (브리핑 몫 ${st.ai.cap}회)` : ""}`)),
  ];
  for (const [k, label] of Object.entries(FILE_LABEL)) {
    const v = st.files[k];
    const days = v ? (Date.now() - new Date(v.length === 10 ? v + "T00:00:00" : v).getTime()) / 86400000 : 999;
    rows.push(h("li", {}, dot(days < 3, days < 14), h("span", {}, label), h("small", {}, ago(v))));
  }
  const wk = st.week;
  if (wk && wk.days) {
    const by = Object.entries(wk.by ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${KIND_KO[k] ?? k} ${v}`).join(" · ");
    rows.push(h("li", {}, dot(wk.degraded === 0, wk.degraded <= 1), h("span", {}, "지난 7일 품질"),
      h("small", {}, `요약 실패로 끝난 날 ${wk.degraded}/${wk.days}일 · 자동 복구 ${wk.repaired}일 · 재시도 ${wk.retries}회${wk.items ? ` · 기준 미달 기사 ${wk.bad_items}/${wk.items}건` : ""}${wk.redone ? ` · 품질 재요약 ${wk.redone}회` : ""} · AI ${wk.requests}회${by ? ` (${by})` : ""}`)));
  }
  host.replaceChildren(h("ul", { class: "st-list" }, ...rows),
    h("p", { class: "board-note" }, "초록: 최신 · 노랑: 며칠 지남 · 빨강: 오래됨/문제. 레저·장소·동네·매장은 일부러 드물게(연 몇 회) 갱신해요."));
}
