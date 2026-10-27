import "./style.css";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import { fetchLive, loadLive, type LiveData } from "./live";
import { headerPill, importFromHash, renderEditor, visaCard } from "./visa";
import { findHits, importWatchFromHash, loadAreas, loadWatch, mentions, neighbourhoodView, renderWatchEditor, type Hit } from "./areas";
import type { Alert, ArchiveIndex, Brief, FuelPrice, Item, ProcessingItem, SectionKey } from "./types";

// ── 탭/카테고리 정의 ───────────────────────────────────────
interface TabDef {
  id: string;
  icon: string;
  label: string;
  sections: SectionKey[];
}

const TABS: TabDef[] = [
  { id: "kr", icon: "🇰🇷", label: "한국", sections: ["kr_society", "kr_economy", "kr_entertainment", "kr_politics"] },
  { id: "nz", icon: "🇳🇿", label: "뉴질랜드", sections: ["nz_society", "nz_education", "nz_economy", "nz_politics", "nz_national"] },
  { id: "akl", icon: "🏙️", label: "오클랜드", sections: ["akl_life", "akl_safety", "akl_property", "akl_health", "akl_education", "nz_auckland"] },
  { id: "imm", icon: "🛂", label: "이민 레이더", sections: ["nz_immigration"] },
];
const KR_CHIPS: { key: SectionKey | "all"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "kr_society", label: "사회" },
  { key: "kr_economy", label: "경제" },
  { key: "kr_entertainment", label: "연예" },
  { key: "kr_politics", label: "정치" },
];

// ── 상태 ──────────────────────────────────────────────────
const settings: Settings = loadSettings();
let brief: Brief | null = null;
type ChipKey = SectionKey | "all" | "hood";
type Chip = { key: ChipKey; label: string };
const NZ_CHIPS: Chip[] = [
  { key: "all", label: "전체" },
  { key: "nz_society", label: "사회" },
  { key: "nz_education", label: "교육" },
  { key: "nz_economy", label: "경제" },
  { key: "nz_politics", label: "정치" },
];
const AKL_CHIPS: Chip[] = [
  { key: "all", label: "전체" },
  { key: "hood", label: "📍 내 동네" },
  { key: "akl_life", label: "생활" },
  { key: "akl_safety", label: "치안" },
  { key: "akl_property", label: "부동산" },
  { key: "akl_health", label: "의료" },
  { key: "akl_education", label: "교육" },
];
// 탭별로 선택한 카테고리 칩
const chipState: Record<string, ChipKey> = { kr: "all", nz: "all", akl: "all" };
let query = "";
let viewingLatest = true;
let live: LiveData | null = loadLive();
let liveError = "";
let watch = loadWatch();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $<HTMLElement>("main");

// ── 유틸 ──────────────────────────────────────────────────
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c); // 문자열은 텍스트 노드 → XSS 안전
  return el;
}

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");

// 생성 시각은 브리핑 기준 타임존(예: Asia/Seoul)으로 표시
function fmtTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
  } catch {
    return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  }
}

function fmtDateLabel(date: string): string {
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (!Number.isFinite(diff) || diff < 0) return "";
  if (diff < 60) return `${Math.max(1, Math.round(diff))}분 전`;
  if (diff < 60 * 36) return `${Math.round(diff / 60)}시간 전`;
  return `${Math.round(diff / 1440)}일 전`;
}

function visibleSections(tab: TabDef): SectionKey[] {
  return tab.sections.filter((k) => k !== "kr_politics" || settings.showPolitics);
}

// ── 데이터 ────────────────────────────────────────────────
async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

async function loadIndex(): Promise<string[]> {
  try {
    return (await getJSON<ArchiveIndex>("./data/index.json")).dates.slice(0, 30);
  } catch {
    return [];
  }
}

async function loadBrief(date?: string): Promise<void> {
  main.setAttribute("aria-busy", "true");
  try {
    brief = await getJSON<Brief>(date ? `./data/${date}.json` : "./data/latest.json");
    viewingLatest = !date;
  } catch {
    brief = null;
  }
  main.removeAttribute("aria-busy");
  renderAll();
}

// ── 렌더링 ────────────────────────────────────────────────
function renderHeader(): void {
  const when = $<HTMLParagraphElement>("when");
  const extras = $<HTMLDivElement>("extras");
  extras.replaceChildren();
  if (!brief) {
    when.textContent = "브리핑을 불러오지 못했습니다";
    return;
  }
  when.textContent = `${fmtDateLabel(brief.date)} · ${fmtTime(brief.generated_at, brief.timezone)} 생성`;
  // 최신 브리핑을 볼 때는 새로고침한 실시간 값이 있으면 그것을, 아니면 브리핑 생성 시점 값을 보여준다
  const useLive = viewingLatest && live != null;
  const fx = useLive && live!.fx != null ? live!.fx : brief.extras?.nzd_krw;
  if (fx) extras.append(h("span", { class: "pill" }, "💱 1 NZD = ", h("strong", {}, `${fx.toLocaleString("ko-KR")}원`)));
  const lw = useLive ? live!.weather : null;
  const w = brief.extras?.auckland_weather;
  if (lw) {
    const rain = lw.rain != null ? ` · 강수 ${lw.rain}%` : "";
    extras.append(h("span", { class: "pill" }, "🌤 오클랜드 지금 ", h("strong", {}, `${lw.now}°`), ` (${lw.min}°~${lw.max}°) ${lw.desc}${rain}`));
  } else if (w) {
    const rain = w.rain_chance != null ? ` · 강수 ${w.rain_chance}%` : "";
    extras.append(h("span", { class: "pill" }, "🌤 오클랜드 ", h("strong", {}, `${w.min}°~${w.max}°`), ` ${w.desc}${rain}`));
  }
  const vp = headerPill(h);
  if (vp) extras.append(vp);
  if (viewingLatest) {
    const btn = h("button", { class: "refresh", type: "button", "aria-label": "환율·날씨 새로고침", title: "환율·날씨 새로고침" }, "↻");
    btn.addEventListener("click", () => void refreshLive(btn));
    const stamp = liveError
      ? liveError
      : useLive
        ? `${new Date(live!.at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })} 기준${live!.fxSource ? ` · 환율 ${live!.fxSource}` : ""}`
        : "브리핑 생성 시점 기준";
    extras.append(h("span", { class: "live-row" }, btn, h("span", { class: "stamp", role: "status" }, stamp)));
  }
}

async function refreshLive(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.classList.add("spinning");
  try {
    live = await fetchLive();
    liveError = "";
  } catch {
    liveError = navigator.onLine ? "새로고침 실패 — 잠시 후 다시" : "오프라인 — 새로고침 불가";
  }
  renderHeader();
}

function renderTabs(): void {
  const nav = $<HTMLElement>("tabs");
  nav.replaceChildren(
    ...TABS.map((t) => {
      const selected = settings.tab === t.id;
      const btn = h("button", {
        class: "tab",
        role: "tab",
        id: `tab-${t.id}`,
        "aria-selected": String(selected),
        "aria-controls": "main",
        tabindex: selected ? "0" : "-1",
      }, h("span", { class: "tab-icon", "aria-hidden": "true" }, t.icon));
      const label = h("span", { class: "tab-label" }, t.label);
      if (t.id === "imm" && brief) {
        const n = brief.sections.nz_immigration?.items.length ?? 0;
        if (n) label.append(h("span", { class: "badge", "aria-label": `${n}건` }, String(n)));
      }
      btn.append(label);
      btn.addEventListener("click", () => selectTab(t.id));
      btn.addEventListener("keydown", (e) => {
        const i = TABS.findIndex((x) => x.id === t.id);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
          selectTab(next.id);
          document.getElementById(`tab-${next.id}`)?.focus();
        }
      });
      return btn;
    }),
  );
}

function selectTab(id: string): void {
  settings.tab = id;
  saveSettings(settings);
  renderTabs();
  renderMain();
  window.scrollTo({ top: 0 });
}

function card(item: Item, region: "kr" | "nz", sectionLabel?: string): HTMLElement {
  const title = h("h3", { class: "card-title" }, item.title_ko);
  const meta = h("div", { class: "card-meta" });
  if (sectionLabel) meta.append(h("span", { class: "sec-label" }, sectionLabel));
  if (item.importance >= 8) meta.append(h("span", { class: "hot", title: `중요도 ${item.importance}/10` }, `중요 ${item.importance}`));
  const near = mentions(item, [...watch.suburbs, ...watch.schools]);
  if (near.length) meta.append(h("span", { class: "near" }, `📍 ${near.join(", ")}`));
  if (item.carried_from) meta.append(h("span", { class: "carried", title: "오늘은 새 소식이 없어 최근 소식을 보여줍니다" }, `지난 소식 · ${fmtDateShort(item.carried_from)}`));
  const rt = relTime(item.published_at);
  if (rt) meta.append(h("span", {}, rt));

  const summary = h("ul", { class: "summary" }, ...item.summary_ko.map((s) => h("li", {}, s)));
  const art = h("article", { class: "card" }, meta, title, summary);

  if (region === "nz" && item.why_it_matters) {
    art.append(h("div", { class: "why" }, h("span", { class: "why-label" }, "이민자 관점"), h("p", {}, item.why_it_matters)));
  }
  if (item.original_title && item.original_title !== item.title_ko) {
    art.append(h("p", { class: "orig", lang: region === "nz" ? "en" : "ko" }, item.original_title));
  }
  const foot = h("div", { class: "card-foot" });
  if (item.tags.length) foot.append(h("ul", { class: "tags", "aria-label": "태그" }, ...item.tags.map((t) => h("li", {}, `#${t}`))));
  foot.append(
    h("div", { class: "sources" }, ...item.sources.map((s) =>
      h("a", { href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer" }, `${s.name} ↗`),
    )),
  );
  art.append(foot);
  return art;
}

function sectionBlock(key: SectionKey, showHeading: boolean): HTMLElement | null {
  if (!brief) return null;
  const sec = brief.sections[key];
  if (!sec) return null;
  const region = key.startsWith("kr_") ? "kr" : "nz";
  const wrap = h("section", { class: "section", "aria-labelledby": `h-${key}` });
  wrap.append(h("h2", { id: `h-${key}`, class: showHeading ? "sec-title" : "sr-only" }, sec.label));
  if (sec.briefing) wrap.append(h("p", { class: "briefing" }, h("span", { class: "briefing-label" }, "오늘의 한 줄"), sec.briefing));
  if (!sec.items.length) wrap.append(h("p", { class: "empty" }, "새 소식이 없습니다."));
  for (const item of sec.items) wrap.append(card(item, region));
  return wrap;
}

function renderChips(tabId: string): HTMLElement | null {
  let chips: Chip[];
  if (tabId === "kr") {
    chips = KR_CHIPS.filter((c) => c.key !== "kr_politics" || settings.showPolitics);
  } else if (tabId === "akl") {
    if (!brief?.sections.akl_life) return null; // 예전 브리핑(오클랜드 단일 섹션)
    chips = AKL_CHIPS;
  } else {
    // 예전 브리핑(뉴질랜드 단일 섹션)에는 칩을 보여주지 않음
    if (!brief?.sections.nz_society) return null;
    chips = NZ_CHIPS;
  }
  if (!chips.some((c) => c.key === chipState[tabId])) chipState[tabId] = "all";
  return h("div", { class: "chips", role: "group", "aria-label": "카테고리" }, ...chips.map((c) => {
    const b = h("button", { class: "chip", "aria-pressed": String(chipState[tabId] === c.key) }, c.label);
    b.addEventListener("click", () => {
      chipState[tabId] = c.key;
      renderMain();
    });
    return b;
  }));
}

function renderSearch(): void {
  if (!brief) return;
  const q = query.toLowerCase();
  const hits: { item: Item; key: SectionKey }[] = [];
  for (const tab of TABS) {
    for (const key of visibleSections(tab)) {
      for (const item of brief.sections[key]?.items ?? []) {
        const hay = [item.title_ko, item.original_title ?? "", item.why_it_matters ?? "", ...item.summary_ko, ...item.tags,
          ...item.sources.map((s) => s.name)].join(" ").toLowerCase();
        if (hay.includes(q) && !hits.some((x) => x.item.id === item.id)) hits.push({ item, key }); // 이민 레이더 중복 제외
      }
    }
  }
  main.append(h("p", { class: "result-count", role: "status" }, `‘${query}’ 검색 결과 ${hits.length}건`));
  for (const { item, key } of hits) {
    // 검색 결과에서는 '사회'처럼 같은 이름이 두 나라에 있으므로 나라를 붙여 표시
    const label = brief.sections[key].label;
    const tagged = key.startsWith("kr_") ? `한국 ${label}` : key.startsWith("akl_") ? `오클랜드 ${label}`
      : ["nz_auckland", "nz_immigration"].includes(key) ? label : `뉴질랜드 ${label}`;
    main.append(card(item, key.startsWith("kr_") ? "kr" : "nz", tagged));
  }
}

function renderMain(): void {
  main.replaceChildren();
  if (!brief) {
    main.append(h("div", { class: "empty-state" },
      h("p", {}, "아직 표시할 브리핑이 없습니다."),
      h("p", { class: "muted" }, navigator.onLine ? "매일 아침 8시 전에 새 브리핑이 올라옵니다." : "오프라인 상태이며 저장된 브리핑이 없습니다.")));
    return;
  }
  if (query) {
    renderSearch();
    return;
  }
  const tab = TABS.find((t) => t.id === settings.tab) ?? TABS[0];
  main.setAttribute("aria-labelledby", `tab-${tab.id}`);
  if (tab.id === "kr" || tab.id === "nz" || tab.id === "akl") {
    const chips = renderChips(tab.id);
    if (chips) main.append(chips);
    const sel = chipState[tab.id];
    if (tab.id === "akl" && sel === "hood") {
      renderHood();
      return;
    }
    if (tab.id === "akl") {
      // 생활비 지표는 전체·부동산에서, 주제별 안내 링크는 해당 칩에서
      if (sel === "all" || sel === "akl_property") {
        const costs = costBoard();
        if (costs) main.append(costs);
      }
      const guide = topicGuide(sel);
      if (guide) main.append(guide);
    }
    const keys = (sel === "all" ? visibleSections(tab) : [sel as SectionKey]).filter((k) => brief!.sections[k]);
    for (const k of keys) {
      const block = sectionBlock(k, !!chips);
      if (block) main.append(block);
    }
  } else {
    if (tab.id === "imm") {
      const alerts = alertBanner(brief.meta?.alerts ?? []);
      if (alerts) main.append(alerts);
      main.append(visaCard(h, openSettings));
      const board = processingBoard();
      if (board) main.append(board);
    }
    for (const k of visibleSections(tab)) {
      const block = sectionBlock(k, false);
      if (block) main.append(block);
    }
  }
  const failed = brief.meta?.failed_feeds ?? [];
  if (failed.length) {
    main.append(h("details", { class: "failed" },
      h("summary", {}, `수집 실패한 피드 ${failed.length}개`),
      h("ul", {}, ...failed.map((f) => h("li", {}, f.name ? `${f.name} (${f.id})` : f.id)))));
  }
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

// 이민 레이더 전광판: 비자별 처리 기간 (공식 페이지 기준, 매일 아침 갱신)
function processingBoard(): HTMLElement | null {
  const pt = brief?.extras?.processing_times;
  if (!pt || !pt.items?.length) return null;
  const tile = (it: ProcessingItem) => {
    const has = !!(it.p90 || it.p50);
    const pct = it.pct ?? 90;
    const sub = !has ? "공식 페이지에서 확인" : it.p50 && it.p90 ? `절반은 ${it.p50} 이내` : it.sub || "";
    const t = h("li", { class: `tile${has ? "" : " tile-missing"}` },
      h("span", { class: "tile-group" }, it.group),
      h("span", { class: "tile-name" }, it.name),
      h("span", { class: "tile-pct" }, has ? `${pct}% 처리` : ""),
      h("span", { class: "tile-value", "aria-label": has ? `${pct}% 처리 ${it.p90 || it.p50}` : "확인 불가" }, has ? it.p90 || it.p50 : "—"),
      h("span", { class: "tile-sub" }, sub),
    );
    const tr = it.trend;
    if (tr && has) {
      const d = tr.delta_days;
      const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
      const label = d === 0 ? "지난주와 같음" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}일 ${d > 0 ? "늘어남" : "줄어듦"}`;
      t.append(h("span", { class: `tile-trend ${cls}`, title: `${fmtDateShort(tr.since)} ${tr.prev_p90} → ${it.p90}` }, label));
    }
    const foot = h("span", { class: "tile-foot" });
    if (it.status === "stale" && it.as_of) foot.append(h("span", { class: "stale" }, `${it.as_of.slice(5).replace("-", "/")} 기준`));
    foot.append(h("a", { href: safeUrl(it.url), target: "_blank", rel: "noopener noreferrer" }, "출처 ↗"));
    t.append(foot);
    if (it.note) t.title = it.note;
    return t;
  };
  return h("section", { class: "board", "aria-labelledby": "board-title" },
    h("div", { class: "board-head" },
      h("h2", { id: "board-title" }, "⏱ 비자 처리 기간 전광판"),
      h("span", { class: "board-meta" }, `INZ·DIA 공식 안내 · ${fmtDateShort(pt.updated_at)} 확인`)),
    h("ul", { class: "tiles" }, ...pt.items.map(tile)),
    h("p", { class: "board-note" }, "‘80% 처리’는 신청의 80%가 결정된 기간이에요(INZ 기준, 근무일 계산). 서류 상태에 따라 달라질 수 있으니 신청 전 공식 페이지를 꼭 확인하세요."),
  );
}

// 이민 알림: 처리 기간 급변·레이더 9점 이상 기사
function alertBanner(alerts: Alert[]): HTMLElement | null {
  if (!alerts.length) return null;
  return h("section", { class: "alerts", role: "status", "aria-label": "이민 알림" },
    h("h2", {}, `🚨 오늘의 이민 알림 ${alerts.length}건`),
    h("ul", {}, ...alerts.map((a) => h("li", {},
      h("span", { class: "alert-kind" }, a.kind === "processing" ? "처리 기간" : "중요 뉴스"),
      a.url ? h("a", { href: safeUrl(a.url), target: "_blank", rel: "noopener noreferrer" }, a.text) : a.text))));
}

// 오클랜드 정착 비용판: 렌트 중간값·유가 (정부 공개 데이터)
function costBoard(): HTMLElement | null {
  const c = brief?.extras?.living_costs;
  if (!c || (!c.rent && !c.fuel)) return null;
  const fx = (viewingLatest && live?.fx) || brief!.extras.nzd_krw;
  const won = (nzd: number) => (fx ? `≈ ${Math.round((nzd * fx) / 10000).toLocaleString("ko-KR")}만 원` : "");
  const rows: HTMLElement[] = [];
  const r = c.rent;
  if (r) {
    const yoy = r.yoy_pct != null ? `작년 같은 달보다 ${r.yoy_pct > 0 ? "+" : ""}${r.yoy_pct}%` : "";
    rows.push(h("li", { class: "cost" },
      h("span", { class: "cost-name" }, `🏠 주간 렌트 중간값 (${Number(r.month.slice(5))}월 신규 계약)`),
      h("span", { class: "cost-value" }, `$${r.median.toLocaleString("en-NZ")}`, h("small", {}, " /주")),
      h("span", { class: "cost-sub" }, [won(r.median * 52 / 12) && `한 달 ${won(r.median * 52 / 12)}`, r.lower && r.upper ? `대부분 $${r.lower}~$${r.upper}` : "", yoy].filter(Boolean).join(" · ")),
      h("a", { class: "cost-src", href: safeUrl(r.url), target: "_blank", rel: "noopener noreferrer" }, "Tenancy Services ↗")));
  }
  const f = c.fuel;
  const fuel = (label: string, p?: FuelPrice) => {
    if (!p) return null;
    const w = p.wow_cents;
    const chg = w == null ? "" : w === 0 ? "지난주와 같음" : `지난주보다 ${w > 0 ? "▲" : "▼"}${Math.abs(w)}c`;
    return h("li", { class: "cost" },
      h("span", { class: "cost-name" }, label),
      h("span", { class: "cost-value" }, `$${p.nzd_per_l.toFixed(2)}`, h("small", {}, " /L")),
      h("span", { class: "cost-sub" }, [won(p.nzd_per_l * 50) && `50L ${won(p.nzd_per_l * 50)}`, chg].filter(Boolean).join(" · ")),
      h("a", { class: "cost-src", href: safeUrl(f!.url), target: "_blank", rel: "noopener noreferrer" }, `MBIE ${fmtDateShort(p.date)} ↗`));
  };
  if (f) {
    for (const el of [fuel("⛽ 휘발유 91", f.petrol91), fuel("🚚 경유", f.diesel)]) if (el) rows.push(el);
  }
  return h("section", { class: "costs", "aria-labelledby": "costs-title" },
    h("div", { class: "board-head" },
      h("h2", { id: "costs-title" }, "💰 오클랜드 생활비 지표"),
      h("span", { class: "board-meta" }, `${fmtDateShort(c.updated_at)} 확인`)),
    h("ul", { class: "cost-list" }, ...rows),
    h("p", { class: "board-note" }, "렌트는 그 달 새로 맺은 임대차의 보증금 신고 기준(오클랜드 전체), 유가는 전국 평균 주유소 게시 가격이에요. 원화는 현재 환율로 어림한 값입니다."));
}

// 오클랜드 주제별 안내: 새 소식이 없는 날에도 바로 쓸 수 있는 공식 창구
type Guide = { title: string; links: { label: string; desc: string; url: string }[] };
const GUIDES: Partial<Record<SectionKey, Guide>> = {
  akl_health: { title: "🏥 의료 이용 안내", links: [
    { label: "응급 111", desc: "생명이 위급할 때 (구급차)", url: "tel:111" },
    { label: "Healthline 0800 611 116", desc: "24시간 무료 전화 상담 · 통역 요청 가능", url: "tel:0800611116" },
    { label: "Healthpoint", desc: "GP·야간/주말 진료소(A&M)·약국 찾기, 신규 환자 등록 가능 여부", url: "https://www.healthpoint.co.nz/" },
    { label: "🇰🇷 한국어 GP 찾기 (지도)", desc: "오클랜드에서 한국어로 진료하는 GP — 등록 가능 여부는 병원에 직접 확인", url: "https://www.google.com/maps/search/?api=1&query=Korean%20speaking%20GP%20doctor%20Auckland" },
    { label: "🇰🇷 한인 GP 검색", desc: "한인 커뮤니티 글·후기로 한국인 의사 찾기", url: "https://www.google.com/search?q=%EC%98%A4%ED%81%B4%EB%9E%9C%EB%93%9C+%ED%95%9C%EA%B5%AD%EC%9D%B8+GP+%EC%9D%98%EC%82%AC" },
    { label: "Health NZ", desc: "공공의료 이용 자격(eligibility)은 비자 종류에 따라 달라요 — 사이트에서 'eligibility' 검색", url: "https://www.healthnz.govt.nz/" },
  ] },
  akl_education: { title: "🎒 초등학교 안내", links: [
    { label: "학교 찾기·학군(zone)", desc: "주소로 학군 학교와 학교 정보 확인 (Education Counts)", url: "https://www.educationcounts.govt.nz/find-school" },
    { label: "ERO 학교 평가 보고서", desc: "학교별 교육평가원 보고서", url: "https://ero.govt.nz/" },
  ] },
  akl_safety: { title: "🚓 치안 안내", links: [
    { label: "응급 111", desc: "범죄 진행 중·위험할 때", url: "tel:111" },
    { label: "비응급 신고 105", desc: "이미 지난 도난·피해 신고 (온라인 신고는 경찰 홈페이지)", url: "tel:105" },
    { label: "NZ Police", desc: "지역 경찰서·온라인 신고", url: "https://www.police.govt.nz/" },
    { label: "동네별 범죄 통계", desc: "경찰 공개 데이터 policedata.nz", url: "https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz" },
  ] },
  akl_property: { title: "🏠 부동산 확인 도구", links: [
    { label: "동네별 시세 렌트", desc: "지역·집 크기별 렌트 (Tenancy Services)", url: "https://www.tenancy.govt.nz/rent-bond-and-bills/market-rent/" },
    { label: "QV 집값 지수", desc: "오클랜드·지역별 주택 가치 추세", url: "https://www.qv.co.nz/price-index/" },
    { label: "GeoMaps", desc: "주소별 침수 위험·용도지역(Unitary Plan) 확인", url: "https://geomapspublic.aucklandcouncil.govt.nz/viewer/index.html" },
  ] },
};

function topicGuide(sel: ChipKey): HTMLElement | null {
  const g = sel === "all" || sel === "hood" ? undefined : GUIDES[sel];
  if (!g) return null;
  const empty = !(brief?.sections[sel as SectionKey]?.items.length);
  return h("details", { class: "guide", ...(empty ? { open: "" } : {}) },
    h("summary", {}, g.title),
    h("ul", {}, ...g.links.map((l) => h("li", {},
      h("a", { href: l.url.startsWith("tel:") ? l.url : safeUrl(l.url), ...(l.url.startsWith("tel:") ? {} : { target: "_blank", rel: "noopener noreferrer" }) }, l.label),
      h("span", { class: "guide-desc" }, l.desc)))));
}

// 📍 내 동네: 최근 2주 브리핑에서 관심 동네·학교가 나온 기사를 모으고, 동네별 렌트·집값과 함께 보여준다
let recent: Brief[] | null = null;
async function recentBriefs(): Promise<Brief[]> {
  if (recent) return recent;
  const dates = (await loadIndex()).slice(0, 14);
  const got = await Promise.all(dates.map((d) => getJSON<Brief>(`./data/${d}.json`).catch(() => null)));
  recent = got.filter((b): b is Brief => !!b);
  return recent;
}

const extLink = (url: string, label: string) => h("a", { href: safeUrl(url), target: "_blank", rel: "noopener noreferrer" }, label);

async function renderHood(): Promise<void> {
  const holder = h("div", { "aria-busy": "true" }, h("p", { class: "muted" }, "내 동네 정보를 불러오는 중…"));
  main.append(holder);
  const names = [...watch.suburbs, ...watch.schools];
  const [areas, briefs] = await Promise.all([loadAreas(), names.length ? recentBriefs() : Promise.resolve([] as Brief[])]);
  if (chipState.akl !== "hood" || settings.tab !== "akl" || !holder.isConnected) return;
  const hits: Hit[] = names.length ? findHits(briefs, names) : [];
  const fx = (viewingLatest && live?.fx) || brief?.extras.nzd_krw;
  holder.replaceChildren(neighbourhoodView(h, watch, areas, hits, fx, extLink, openSettings));
  holder.removeAttribute("aria-busy");
}

function renderAll(): void {
  renderHeader();
  renderTabs();
  renderMain();
}

// ── 날짜 선택 / 검색 / 설정 ───────────────────────────────
async function initDates(): Promise<void> {
  const select = $<HTMLSelectElement>("date-select");
  const dates = await loadIndex();
  const options = dates.length ? dates : brief ? [brief.date] : [];
  select.replaceChildren(...options.map((d, i) => h("option", { value: d }, i === 0 ? `${fmtDateLabel(d)} (최신)` : fmtDateLabel(d))));
  if (brief) select.value = brief.date;
  select.disabled = options.length < 2;
  select.addEventListener("change", () => {
    const latest = options[0];
    void loadBrief(select.value === latest ? undefined : select.value);
  });
}

function initSearch(): void {
  const input = $<HTMLInputElement>("search");
  let t: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      query = input.value.trim();
      renderMain();
    }, 150);
  });
}

function openSettings(): void {
  $("settings-btn").click();
}

function initSettings(): void {
  const dialog = $<HTMLDialogElement>("settings");
  const politics = $<HTMLInputElement>("opt-politics");
  $("settings-btn").addEventListener("click", () => {
    void loadAreas().then((a) => renderWatchEditor(h, $("watch-editor"), Object.keys(a?.suburbs ?? {}), () => {
      watch = loadWatch();
      renderMain();
    }));
    renderEditor(h, $("visa-editor"), () => {
      renderHeader();
      if (settings.tab === "imm") renderMain();
    });
    politics.checked = settings.showPolitics;
    dialog.querySelectorAll<HTMLInputElement>('input[name="font"]').forEach((r) => (r.checked = Number(r.value) === settings.fontScale));
    dialog.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((r) => (r.checked = r.value === settings.theme));
    dialog.showModal();
  });
  politics.addEventListener("change", () => {
    settings.showPolitics = politics.checked;
    saveSettings(settings);
    renderMain();
  });
  dialog.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.name === "font") settings.fontScale = Number(t.value);
    if (t.name === "theme") settings.theme = t.value as Settings["theme"];
    saveSettings(settings);
    applySettings(settings);
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close(); // 바깥 클릭으로 닫기
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applySettings(settings));

  const ua = navigator.userAgent;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  const hint = $<HTMLParagraphElement>("install-hint");
  if (!standalone) {
    hint.textContent = /iPhone|iPad|iPod/.test(ua)
      ? "홈 화면에 추가: Safari 공유 버튼 → ‘홈 화면에 추가’"
      : "홈 화면에 추가: 브라우저 메뉴 → ‘앱 설치’ 또는 ‘홈 화면에 추가’";
  }
}

function initOffline(): void {
  const banner = $<HTMLDivElement>("offline");
  const update = () => (banner.hidden = navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

async function init(): Promise<void> {
  applySettings(settings);
  if (importFromHash()) {
    settings.tab = "imm"; // 설정 링크로 들어오면 비자 일정을 바로 보여줌
    saveSettings(settings);
  }
  if (importWatchFromHash()) {
    settings.tab = "akl"; // 관심 동네 링크로 들어오면 내 동네를 바로 보여줌
    saveSettings(settings);
    chipState.akl = "hood";
    watch = loadWatch();
  }
  initSearch();
  initSettings();
  initOffline();
  await loadBrief();
  await initDates();
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
}

void init();
