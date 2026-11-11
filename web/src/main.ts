import "./style.css";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import { fetchLive, loadLive, type LiveData } from "./live";
import { headerPill, importFromHash, renderEditor, visaCard } from "./visa";
import { gpSection, loadGP } from "./gpmap";
import { loadIncidents, safetyAlert, safetySection, vaguePlace } from "./crimemap";
import { findHits, importWatchFromHash, loadAreas, loadWatch, mentions, neighbourhoodView, renderWatchEditor, type Hit } from "./areas";
import { EDU_OTHER, EDU_TOPICS, buildSeen, eduTopic, followUpdates, isFollowed, isOld, isSaved, loadFollows, loadNewOnly, saveNewOnly, toggleFollow, toggleSaved, unfollow, type SeenIndex } from "./news-tools";
import { homeView, statusPanel } from "./home";
import { trackerCard } from "./tracker";
import type { PolicyData, PolicyNews } from "./policy";
import type { Alert, ArchiveIndex, Brief, FuelPrice, Item, ProcessingItem, SectionKey } from "./types";

// ── 탭/카테고리 정의 ───────────────────────────────────────
interface TabDef {
  id: string;
  icon: string;
  label: string;
  sections: SectionKey[];
}

const TABS: TabDef[] = [
  { id: "home", icon: "🏠", label: "홈", sections: [] },
  { id: "akl", icon: "🏙️", label: "오클랜드", sections: ["akl_safety", "akl_life", "akl_property", "akl_health", "akl_education", "nz_auckland"] },
  { id: "leisure", icon: "🏌️", label: "레저", sections: [] },
  { id: "nz", icon: "🇳🇿", label: "뉴질랜드", sections: ["nz_society", "nz_education", "nz_economy", "nz_politics", "nz_national"] },
  { id: "imm", icon: "🛂", label: "이민", sections: ["nz_immigration"] },
  { id: "kr", icon: "🇰🇷", label: "한국", sections: ["kr_society", "kr_economy", "kr_entertainment", "kr_politics"] },
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
type ChipKey = SectionKey | "all" | "hood" | "leisure";
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
  { key: "akl_safety", label: "치안" },
  { key: "akl_life", label: "생활" },
  { key: "hood", label: "📍 내 동네" },
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
let liveBusy = false;
const AUTO_REFRESH_MS = 60 * 1000;
const AUTO_REFRESH_MIN_AGE_MS = 50 * 1000; // 갱신 직후 타이머가 겹쳐도 한 번 건너뛰지 않도록 주기보다 조금 짧게
let watch = loadWatch();
let newOnly = loadNewOnly(); // 새 소식만 보기 (지난 브리핑에 나온 기사·반복 기사·지난 소식 숨김)
let eduFilter = "all"; // 교육 칩 주제 필터
const HIGHER_KEY = "daily-brief:edu-higher";
let eduHigher = (() => { try { return localStorage.getItem(HIGHER_KEY) === "1"; } catch { return false; } })(); // 대학·유학생 기사 보기 (기본 숨김)
const eduHidden = (it: Item, key: SectionKey) => (key === "akl_education" || key === "nz_education") && !eduHigher && eduTopic(it).key === "higher";
const CARD_MODE_KEY = "daily-brief:card-mode";
let cardMode: "compact" | "full" = (() => { try { return localStorage.getItem(CARD_MODE_KEY) === "full" ? "full" : "compact"; } catch { return "compact"; } })(); // 기본은 간단히(제목·한 줄 요약)
let searchPast = false; // 검색에 지난 30일 브리핑 포함
let pastCache: Brief[] | null = null;
let seenIdx: SeenIndex | null = null; // 지금 보는 브리핑 이전 3일치 기사 (새 소식 판단용)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const main = $<HTMLElement>("main");

const IMPACT_LABEL = { high: "높음", medium: "보통", low: "낮음", none: "없음" } as const;

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
  seenIdx = null;
  renderAll();
  autoRefreshLive();
  // 지난 브리핑을 받아 '새 소식' 판단 기준을 만든 뒤 다시 그린다 (받기 전에는 '지난 소식'만 숨김)
  const cur = brief;
  if (cur) void recentBriefs().then((r) => {
    if (brief !== cur) return;
    seenIdx = buildSeen(cur, r);
    if (!query) renderMain();
  }).catch(() => undefined);
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
  const usd = useLive && live!.usd != null ? live!.usd : brief.extras?.usd_krw;
  if (usd) extras.append(h("span", { class: "pill" }, "💵 1 USD = ", h("strong", {}, `${usd.toLocaleString("ko-KR")}원`)));
  const jpy = useLive && live!.jpy != null ? live!.jpy : brief.extras?.jpy100_krw;
  if (jpy) extras.append(h("span", { class: "pill" }, "💴 100 JPY = ", h("strong", {}, `${jpy.toLocaleString("ko-KR")}원`)));
  const btc = useLive && live!.btc != null ? live!.btc : brief.extras?.btc_usd;
  if (btc) extras.append(h("span", { class: "pill" }, "₿ 1 BTC = ", h("strong", {}, `$${btc.toLocaleString("en-US")}`)));
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
    const btn = h("button", { class: `refresh${liveBusy ? " spinning" : ""}`, type: "button", "aria-label": "환율·날씨 새로고침", title: "환율·날씨 새로고침" }, "↻");
    btn.disabled = liveBusy;
    btn.addEventListener("click", () => void refreshLive());
    const stamp = liveError
      ? liveError
      : useLive
        ? `${new Date(live!.at).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })} 기준${live!.fxSource ? ` · 환율 ${live!.fxSource}` : ""}`
        : "브리핑 생성 시점 기준";
    extras.append(h("span", { class: "live-row" }, btn, h("span", { class: "stamp", role: "status" }, stamp)));
  }
}

// auto: 자동 갱신은 버튼을 돌리지 않고, 실패해도 직전 값을 그대로 둔다(1분마다 오류 문구가 깜빡이지 않게)
async function refreshLive(auto = false): Promise<void> {
  if (liveBusy) return;
  liveBusy = true;
  if (!auto) renderHeader();
  try {
    live = await fetchLive(live);
    liveError = "";
  } catch {
    if (!auto || !live) liveError = navigator.onLine ? "새로고침 실패 — 잠시 후 다시" : "오프라인 — 새로고침 불가";
  }
  liveBusy = false;
  renderHeader();
}

// 접속·탭 복귀·온라인 복구 때, 그리고 탭이 열려 있는 동안 1분마다 환율·날씨를 자동 갱신한다. 방금 갱신했다면 건너뛴다.
function autoRefreshLive(): void {
  if (!viewingLatest || document.hidden || !navigator.onLine) return;
  if (live && Date.now() - new Date(live.at).getTime() < AUTO_REFRESH_MIN_AGE_MS) return;
  void refreshLive(true);
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
        title: t.id === "imm" ? "이민 레이더" : t.label,
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
  if (item.sources.length >= 2) meta.append(h("span", { class: "press", title: item.sources.map((s) => s.name).join(", ") }, `📰 ${item.sources.length}곳 보도`));
  const near = mentions(item, [...watch.suburbs, ...watch.schools]);
  if (near.length) meta.append(h("span", { class: "near" }, `📍 ${near.join(", ")}`));
  // 치안 기사: 사건이 난 지역을 한눈에 (주택 침입·강도는 특히 지역이 중요)
  if (item.incident && (item.incident.suburb || item.incident.location)) {
    // 구체적인 장소가 없는 기사는 "Auckland Central" 처럼 추측한 동네를 보여 주지 않는다
    const vague = vaguePlace(item.incident.location);
    if (!vague) meta.append(h("span", { class: "place", title: item.incident.location }, `📍 ${item.incident.suburb || item.incident.location}`));
    else if (!/^(auckland( central)?)?$/i.test(item.incident.suburb)) meta.append(h("span", { class: "place", title: item.incident.location }, `📍 ${item.incident.suburb}`));
    else meta.append(h("span", { class: "place muted", title: "기사에 구체적인 장소가 없어요" }, "📍 위치 미공개"));
  }
  if (item.carried_from) meta.append(h("span", { class: "carried", title: "오늘은 새 소식이 없어 최근 소식을 보여줍니다" }, `지난 소식 · ${fmtDateShort(item.carried_from)}`));
  if (item.id && (brief?.sections.akl_education?.items.some((x) => x.id === item.id) || brief?.sections.nz_education?.items.some((x) => x.id === item.id))) {
    const tp = eduTopic(item);
    meta.append(h("span", { class: "edu-badge", style: `--c:${tp.color}` }, `${tp.icon} ${tp.label}`));
  }
  const rt = relTime(item.published_at);
  if (rt) meta.append(h("span", {}, rt));

  const summary = h("ul", { class: "summary" }, ...item.summary_ko.map((s) => h("li", {}, s)));
  const compact = cardMode === "compact";
  const art = h("article", { class: `card${item.impact && item.impact.level !== "none" ? ` imp-${item.impact.level}` : ""}${item.importance >= 9 ? " hero" : ""}${compact ? " compact" : ""}` }, meta, title, summary);
  if (item.impact && item.impact.level !== "none") meta.append(h("span", { class: `impact-badge ${item.impact.level}` }, `영향 ${IMPACT_LABEL[item.impact.level]}`));

  const imp = item.impact;
  if (imp && imp.level !== "none") {
    // 내게 미치는 영향: 영향도·이유·할 일·지켜볼 것 (이유가 없으면 이민자 관점 문장)
    const box = h("div", { class: `why impact-${imp.level}` },
      h("span", { class: "why-label" }, "내게 미치는 영향 ", h("span", { class: `impact-badge ${imp.level}` }, IMPACT_LABEL[imp.level])),
      h("p", {}, imp.reason || item.why_it_matters || ""));
    if (imp.actions.length) box.append(h("ul", { class: "impact-actions", "aria-label": "할 일" }, ...imp.actions.map((x) => h("li", {}, x))));
    if (imp.watch) box.append(h("p", { class: "impact-watch" }, h("strong", {}, "지켜볼 것 "), imp.watch));
    art.append(box);
  } else if (imp) {
    art.append(h("p", { class: "impact-none" }, `내 상황 영향 거의 없음${imp.reason ? ` · ${imp.reason}` : ""}`));
  } else if (region === "nz" && item.why_it_matters) {
    art.append(h("div", { class: "why" }, h("span", { class: "why-label" }, "이민자 관점"), h("p", {}, item.why_it_matters)));
  }
  if (item.timeline?.length) {
    // 이 이슈의 흐름: 지난 브리핑의 같은 이슈 보도 (오래된 순) + 이번에 달라진 점
    const list = h("ol", { class: "timeline" },
      ...item.timeline.map((t) => h("li", {}, h("span", { class: "tl-date" }, fmtDateShort(t.date)),
        /^https?:/.test(t.url) ? h("a", { href: safeUrl(t.url), target: "_blank", rel: "noopener noreferrer" }, t.title_ko) : t.title_ko)),
      h("li", { class: "tl-now" }, h("span", { class: "tl-date" }, "오늘"), item.title_ko));
    art.append(h("details", { class: "thread" },
      h("summary", {}, `🧵 이 이슈의 흐름 ${item.timeline.length + 1}건`, item.changed ? h("span", { class: "tl-changed" }, `달라진 점: ${item.changed}`) : null),
      list));
  }
  if (item.original_title && item.original_title !== item.title_ko) {
    art.append(h("p", { class: "orig", lang: region === "nz" ? "en" : "ko" }, item.original_title));
  }
  const foot = h("div", { class: "card-foot" });
  if (item.tags.length) foot.append(h("ul", { class: "tags", "aria-label": "태그" }, ...item.tags.map((t) => h("li", {}, `#${t}`))));
  const fol = h("button", { type: "button", class: "follow-btn", "aria-pressed": String(isFollowed(item)) }, isFollowed(item) ? "📌 팔로우 중" : "📌 팔로우");
  fol.addEventListener("click", () => {
    const on = toggleFollow(item, brief?.date ?? "");
    fol.setAttribute("aria-pressed", String(on));
    fol.textContent = on ? "📌 팔로우 중" : "📌 팔로우";
  });
  const sv = h("button", { type: "button", class: "follow-btn", "aria-pressed": String(isSaved(item.id)) }, isSaved(item.id) ? "🔖 저장됨" : "🔖 저장");
  sv.addEventListener("click", () => {
    const on = toggleSaved(item, brief?.date ?? "", sectionLabel ?? "");
    sv.setAttribute("aria-pressed", String(on));
    sv.textContent = on ? "🔖 저장됨" : "🔖 저장";
  });
  foot.append(
    h("div", { class: "sources" }, ...item.sources.map((s) =>
      h("a", { href: safeUrl(s.url), target: "_blank", rel: "noopener noreferrer" }, `${s.name} ↗`),
    ), fol, sv),
  );
  art.append(foot);
  if (compact) {
    const more = h("button", { type: "button", class: "card-more", "aria-expanded": "false" }, "자세히 ▾");
    more.addEventListener("click", () => {
      const open = art.classList.toggle("compact");
      more.setAttribute("aria-expanded", String(!open));
      more.textContent = open ? "자세히 ▾" : "접기 ▴";
    });
    art.append(more);
  }
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
  const isEdu = key === "akl_education" || key === "nz_education";
  const visible = isEdu ? sec.items.filter((it) => !eduHidden(it, key)) : sec.items;
  const base = isEdu && eduFilter !== "all" ? visible.filter((it) => eduTopic(it).key === eduFilter) : visible;
  const shown = newOnly ? base.filter((it) => !isOld(it, seenIdx)) : base;
  const hidden = base.length - shown.length;
  if (newOnly && sec.items.length && !shown.length) wrap.append(h("p", { class: "empty" }, `오늘 처음 나온 소식이 없어요 (지난 소식 ${hidden}건 숨김).`));
  // 이민 레이더는 최신 기사가 맨 위(발행 시각 내림차순, 시각이 없는 기사는 뒤로 — 같으면 선별 순서 유지)
  const items = key === "nz_immigration"
    ? [...shown].sort((x, y) => (y.published_at ? Date.parse(y.published_at) : -Infinity) - (x.published_at ? Date.parse(x.published_at) : -Infinity))
    : shown;
  for (const item of items) wrap.append(card(item, region));
  if (newOnly && hidden && shown.length) wrap.append(h("p", { class: "muted hidden-note" }, `지난 브리핑에 나온 소식 ${hidden}건은 숨겼어요.`));
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
          item.impact?.reason ?? "", ...(item.impact?.actions ?? []), item.changed ?? "",
          ...item.sources.map((s) => s.name)].join(" ").toLowerCase();
        if (hay.includes(q) && !hits.some((x) => x.item.id === item.id)) hits.push({ item, key }); // 이민 레이더 중복 제외
      }
    }
  }
  const pastBtn = h("button", { type: "button", class: "chip", "aria-pressed": String(searchPast) }, "🗂 지난 30일까지 검색");
  pastBtn.addEventListener("click", () => { searchPast = !searchPast; renderMain(); });
  main.append(h("div", { class: "chips" }, pastBtn), h("p", { class: "result-count", role: "status" }, `‘${query}’ 오늘 브리핑 검색 결과 ${hits.length}건`));
  for (const { item, key } of hits) {
    // 검색 결과에서는 '사회'처럼 같은 이름이 두 나라에 있으므로 나라를 붙여 표시
    const label = brief.sections[key].label;
    const tagged = key.startsWith("kr_") ? `한국 ${label}` : key.startsWith("akl_") ? `오클랜드 ${label}`
      : ["nz_auckland", "nz_immigration"].includes(key) ? label : `뉴질랜드 ${label}`;
    main.append(card(item, key.startsWith("kr_") ? "kr" : "nz", tagged));
  }
  if (searchPast) {
    const slot = h("section", { class: "past-hits" }, h("p", { class: "muted" }, "지난 브리핑을 불러오는 중…"));
    main.append(slot);
    void allBriefs().then((all) => {
      if (!slot.isConnected) return;
      const rows: { date: string; label: string; item: Item }[] = [];
      for (const b of all) {
        if (b.date === brief!.date) continue;
        const done = new Set<string>();
        for (const [k, sec] of Object.entries(b.sections)) {
          if (k === "kr_politics" && !settings.showPolitics) continue;
          for (const it of sec.items) {
            const hay = [it.title_ko, it.original_title ?? "", ...it.summary_ko, ...it.tags].join(" ").toLowerCase();
            if (hay.includes(q) && !done.has(it.id)) { done.add(it.id); rows.push({ date: b.date, label: sectionLabelOf(b, k as SectionKey), item: it }); }
          }
        }
      }
      rows.sort((a, c) => c.date.localeCompare(a.date));
      slot.replaceChildren(h("h2", { class: "sec-title" }, `지난 브리핑 검색 결과 ${rows.length}건`),
        rows.length ? h("ul", { class: "hm-list past-list" }, ...rows.slice(0, 80).map((r) => h("li", {}, h("small", { class: "muted" }, `${r.date.slice(5).replace("-", "/")} ${r.label} · `),
          r.item.sources[0] ? h("a", { href: safeUrl(r.item.sources[0].url), target: "_blank", rel: "noopener noreferrer" }, r.item.title_ko) : r.item.title_ko))) : h("p", { class: "muted" }, "지난 30일에는 없어요."));
    });
  }
}

const sectionLabelOf = (b: Brief, key: SectionKey): string => {
  const l = b.sections[key]?.label ?? "";
  return key.startsWith("kr_") ? `한국 ${l}` : key.startsWith("akl_") ? `오클랜드 ${l}` : ["nz_auckland", "nz_immigration"].includes(key) ? l : `뉴질랜드 ${l}`;
};

async function allBriefs(): Promise<Brief[]> {
  if (pastCache) return pastCache;
  const dates = await loadIndex();
  const got = await Promise.all(dates.map((d) => getJSON<Brief>(`./data/${d}.json`).catch(() => null)));
  pastCache = got.filter((b): b is Brief => !!b);
  return pastCache;
}

// AI 요약·선별이 실패한 날: 원문으로 보이는 이유와 자동 재시도 안내
function degradedBanner(): HTMLElement | null {
  const m = brief?.meta;
  if (!m?.degraded || !viewingLatest) return null;
  const tries = m.retries ?? 0;
  const msg = tries >= 2
    ? "오늘은 AI 서버 오류로 요약·번역이 일부 실패했고, 자동 재시도(2회)도 실패했어요. 영어 원문으로 보이는 기사가 있어요."
    : `오늘은 AI 서버 오류로 요약·번역이 일부 실패해 영어 원문으로 보이는 기사가 있어요. 오클랜드 시간 ${tries === 0 ? "10시·14시쯤" : "14시쯤"} 자동으로 다시 만들어요.`;
  return h("section", { class: "degraded", role: "status" }, h("strong", {}, "⚠️ AI 요약 일부 실패 "), msg);
}

// 오늘 한눈에: 지금 탭의 새 소식·영향 높음·팔로우 업데이트 수 + '새 소식만' 토글
function overview(keys: SectionKey[]): HTMLElement | null {
  if (!brief) return null;
  const ids = new Set<string>();
  const items = keys.flatMap((k) => (brief!.sections[k]?.items ?? []).filter((it) => !eduHidden(it, k))).filter((it) => (ids.has(it.id) ? false : (ids.add(it.id), true)));
  if (!items.length) return null;
  const fresh = items.filter((it) => !isOld(it, seenIdx)).length;
  const high = items.filter((it) => it.impact?.level === "high").length;
  const fu = followUpdates(brief).reduce((n, f) => n + f.items.length, 0);
  const tile = (n: number | string, label: string, cls = "") => h("div", { class: `ov-tile ${cls}` }, h("span", { class: "ov-n" }, String(n)), h("span", { class: "ov-l" }, label));
  const tog = h("button", { type: "button", class: "chip ov-toggle", "aria-pressed": String(newOnly) }, newOnly ? "🆕 새 소식만 보는 중" : "🆕 새 소식만 보기");
  tog.addEventListener("click", () => {
    newOnly = !newOnly;
    saveNewOnly(newOnly);
    renderMain();
  });
  // 새 소식 비율 막대 (새 소식 / 전체)
  const bar = h("div", { class: "ov-bar", role: "img", "aria-label": `전체 ${items.length}건 중 새 소식 ${fresh}건` },
    h("i", { style: `width:${Math.round((fresh / items.length) * 100)}%` }));
  return h("section", { class: "overview", "aria-label": "오늘 한눈에" },
    h("div", { class: "ov-tiles" },
      tile(fresh, seenIdx ? "새 소식" : "새 소식(확인 중)", "ov-new"),
      tile(items.length - fresh, "지난·반복"),
      tile(high, "영향 높음", high ? "ov-high" : ""),
      fu ? tile(fu, "팔로우 업데이트", "ov-follow") : null),
    bar, tog);
}

// 팔로우한 이슈: 오늘 브리핑에 나온 관련 기사
function followSection(): HTMLElement | null {
  if (!brief || !loadFollows().length) return null;
  const ups = followUpdates(brief);
  const n = ups.reduce((a, f) => a + f.items.length, 0);
  const box = h("details", { class: "follows" }, h("summary", {}, `📌 팔로우 중인 이슈 ${ups.length}개${n ? ` · 오늘 새 소식 ${n}건` : " · 오늘은 새 소식 없음"}`));
  box.open = n > 0;
  box.append(h("ul", {}, ...ups.map(({ follow, items }) => {
    const x = h("button", { type: "button", class: "link-btn", "aria-label": `${follow.title} 팔로우 해제` }, "해제");
    x.addEventListener("click", () => { unfollow(follow.id); renderMain(); });
    return h("li", {}, h("div", { class: "fl-head" }, h("strong", {}, follow.title), h("small", { class: "muted" }, ` ${follow.since.slice(5).replace("-", "/")}부터`), " ", x),
      items.length ? h("ul", { class: "fl-items" }, ...items.slice(0, 4).map(({ item, section }) => h("li", {},
        h("span", { class: "sec-label" }, section), " ",
        item.sources[0] ? h("a", { href: safeUrl(item.sources[0].url), target: "_blank", rel: "noopener noreferrer" }, item.title_ko) : item.title_ko))) : h("p", { class: "muted" }, "오늘은 관련 새 소식이 없어요."));
  })));
  return box;
}

// 교육 칩: 주제별 필터 (정책·교사·급식·학군·안전·대학) — 규칙 기반, AI 없음
function eduTopicBar(keys: SectionKey[]): HTMLElement | null {
  if (!brief) return null;
  const all = keys.flatMap((k) => (brief!.sections[k]?.items ?? []).map((it) => ({ it, k })));
  const higherN = all.filter(({ it }) => eduTopic(it).key === "higher").length;
  const items = all.filter(({ it, k }) => !eduHidden(it, k)).map(({ it }) => it);
  if (!all.length) return null;
  const count: Record<string, number> = {};
  for (const it of items) count[eduTopic(it).key] = (count[eduTopic(it).key] ?? 0) + 1;
  const tabs = [{ key: "all", label: "전체", icon: "", color: "var(--accent)" }, ...EDU_TOPICS, EDU_OTHER].filter((t) => t.key === "all" || count[t.key]);
  if (eduFilter !== "all" && !count[eduFilter]) eduFilter = "all";
  const total = items.length;
  const dist = h("div", { class: "edu-dist", role: "img", "aria-label": "교육 기사 주제 비율" },
    ...tabs.filter((t) => t.key !== "all").map((t) => h("i", { style: `flex:${count[t.key]};background:${t.color}`, title: `${t.label} ${count[t.key]}건` })));
  const chips = h("div", { class: "chips edu-chips", role: "group", "aria-label": "교육 주제" }, ...tabs.map((t) => {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(eduFilter === t.key), style: t.key === "all" ? "" : `--c:${t.color}` },
      `${t.icon ? t.icon + " " : ""}${t.label} ${t.key === "all" ? total : count[t.key]}`);
    b.addEventListener("click", () => { eduFilter = t.key; renderMain(); });
    return b;
  }));
  // 대학·유학생은 기본 숨김 — 켜면 보이고 주제 칩에도 나타남 (이 기기에 저장)
  const hb = h("button", { type: "button", class: "chip edu-higher", "aria-pressed": String(eduHigher), style: "--c:#0d9488" },
    `🎓 대학·유학생 ${eduHigher ? "보는 중" : `보기${higherN ? ` (${higherN}건 숨김)` : ""}`}`);
  hb.addEventListener("click", () => {
    eduHigher = !eduHigher;
    try { localStorage.setItem(HIGHER_KEY, eduHigher ? "1" : "0"); } catch { /* 무시 */ }
    if (!eduHigher && eduFilter === "higher") eduFilter = "all";
    renderMain();
  });
  return h("section", { class: "edu-bar" }, dist, chips, hb);
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
  const banner = degradedBanner();
  if (banner) main.append(banner);
  if (tab.id === "home") {
    const al = alertBanner(brief.meta?.alerts ?? []);
    if (al) main.append(al);
    main.append(homeView(h, { brief, recent, tabs: TABS, sections: visibleSections, fresh: (it) => !isOld(it, seenIdx), hidden: eduHidden, goTab: selectTab, rerender: renderMain, suburbs: watch.suburbs,
      goSafety: () => { chipState.akl = "akl_safety"; selectTab("akl"); } }));
    const fs = followSection();
    if (fs) main.append(fs);
    if (!recent) { const cur = brief; void recentBriefs().then(() => { if (brief === cur && settings.tab === "home" && !query) renderMain(); }).catch(() => undefined); }
    return;
  }
  if (tab.id === "leisure") {
    void renderLeisure();
    return;
  }
  if (tab.id === "kr" || tab.id === "nz" || tab.id === "akl") {
    const chips = renderChips(tab.id);
    if (chips) main.append(chips);
    const sel = chipState[tab.id];
    if (sel !== "hood" && sel !== "leisure") {
      const ov = overview((sel === "all" ? visibleSections(tab) : [sel as SectionKey]).filter((k) => brief!.sections[k]));
      if (ov) main.append(ov);
      const fs = followSection();
      if (fs) main.append(fs);
    }
    if (tab.id === "akl") {
      // 관심 동네 반경 2km 안 최근 7일 1급 사건 알림 (모든 칩 위)
      const alertSlot = h("div", {});
      main.append(alertSlot);
      void Promise.all([loadIncidents(), loadGP()]).then(([inc, gp]) => {
        const homes = Object.fromEntries(watch.suburbs.filter((x) => gp?.suburbs[x]).map((x) => [x, gp!.suburbs[x]]));
        const a = safetyAlert(h, inc, homes);
        if (a && alertSlot.isConnected) alertSlot.replaceChildren(a);
      });
    }
    if (tab.id === "akl" && sel === "hood") {
      renderHood();
      return;
    }
    if (tab.id === "akl") {
      // 생활비 지표는 부동산에서만, 주제별 안내 링크는 해당 칩에서
      if (sel === "akl_property") {
        const costs = costBoard();
        if (costs) main.append(costs);
      }
      const guide = topicGuide(sel);
      if (guide) main.append(guide);
      if (sel === "akl_safety") {
        const slot = h("div", {});
        main.append(slot);
        void Promise.all([loadIncidents(), loadGP()]).then(([inc, gp]) => {
          const homes = Object.fromEntries(watch.suburbs.filter((x) => gp?.suburbs[x]).map((x) => [x, gp!.suburbs[x]]));
          if (slot.isConnected) slot.replaceChildren(safetySection(h, inc, homes, gp?.suburbs ?? {}));
        });
      }
      if (sel === "akl_property") {
        // 지역별 민족 구성(인구총조사 거주자 분포 — 동네 고를 때 참고, 범죄 자료 아님)
        const eslot = h("div", {});
        main.append(eslot);
        void import("./ethmap").then(async (m) => [await m.ethnicSection(h, watch.suburbs), await m.originSection(h)] as const).then(([el, origin]) => {
          if (eslot.isConnected) eslot.replaceChildren(el, ...(origin ? [origin] : []));
        });
      }
      if (sel === "akl_health") {
        const slot = h("div", {});
        main.append(slot);
        void loadGP().then((gp) => {
          if (slot.isConnected) slot.replaceChildren(gpSection(h, gp, watch.suburbs));
        });
      }
    }
    if (tab.id === "nz" && sel === "nz_economy") {
      const rates = ratesBoard();
      if (rates) main.append(rates);
    }
    const keys = (sel === "all" ? visibleSections(tab) : [sel as SectionKey]).filter((k) => brief!.sections[k]);
    if (sel === "akl_education" || sel === "nz_education") {
      const bar = eduTopicBar(keys);
      if (bar) main.append(bar);
    } else eduFilter = "all";
    for (const k of keys) {
      const block = sectionBlock(k, !!chips);
      if (block) main.append(block);
    }
  } else {
    if (tab.id === "imm") {
      const alerts = alertBanner(brief.meta?.alerts ?? []);
      if (alerts) main.append(alerts);
      main.append(visaCard(h, openSettings));
      // 이민 단계 트래커: 최근 2주 브리핑을 받으면 관련 소식까지 채운다
      const tslot = h("div", {}, trackerCard(h, brief, null, openSettings));
      main.append(tslot);
      const cur = brief;
      void recentBriefs().then((r) => {
        if (tslot.isConnected && brief === cur) tslot.replaceChildren(trackerCard(h, cur, r.filter((b) => b.date !== cur.date), openSettings));
      }).catch(() => undefined);
      const ov = overview(visibleSections(tab));
      if (ov) main.append(ov);
      const fs = followSection();
      if (fs) main.append(fs);
      const board = processingBoard();
      if (board) main.append(board);
      // 정당 이민 정책 추적 (큐레이션 JSON + 자동 모은 기사, AI 없음)
      const pslot = h("div", {});
      main.append(pslot);
      void loadPolicy().then(([d, n]) => {
        if (d && pslot.isConnected) void import("./policy").then((m) => { if (pslot.isConnected) pslot.replaceChildren(m.policyPanel(h, d, n)); });
      });
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

let policyCache: Promise<[PolicyData | null, PolicyNews | null]> | null = null;
function loadPolicy(): Promise<[PolicyData | null, PolicyNews | null]> {
  policyCache ??= Promise.all([getJSON<PolicyData>("./data/policy.json").catch(() => null), getJSON<PolicyNews>("./data/policy-news.json").catch(() => null)]);
  return policyCache;
}

// 이민 레이더 전광판: 비자별 처리 기간 (공식 페이지 기준, 매일 아침 갱신)
function processingBoard(): HTMLElement | null {
  const pt = brief?.extras?.processing_times;
  if (!pt || !pt.items?.length) return null;
  const tile = (it: ProcessingItem) => {
    const has = !!(it.p90 || it.p50);
    const pct = it.pct ?? 90;
    const sub = !has ? "공식 페이지에서 확인" : it.p50 && it.p90 ? `절반은 ${it.p50} 이내` : it.sub || "";
    const t = h("li", { class: `tile${has ? "" : " tile-missing"}`, "data-key": it.key },
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
  const board = h("section", { class: "board", "aria-labelledby": "board-title" },
    h("div", { class: "board-head" },
      h("h2", { id: "board-title" }, "⏱ 비자 처리 기간 전광판"),
      h("span", { class: "board-meta" }, `INZ·DIA 공식 안내 · ${fmtDateShort(pt.updated_at)} 확인`)),
    h("ul", { class: "tiles" }, ...pt.items.map(tile)),
    h("p", { class: "board-note" }, "‘80% 처리’는 신청의 80%가 결정된 기간이에요(INZ 기준, 근무일 계산). 서류 상태에 따라 달라질 수 있으니 신청 전 공식 페이지를 꼭 확인하세요."),
  );
  // 비자별 처리 기간 추이 (기록이 3일 이상 쌓인 것만)
  void getJSON<Record<string, { date: string; p50: string; p90: string }[]>>("./data/processing-history.json").then(async (hist) => {
    const { sparkline } = await import("./home");
    const { procDays } = await import("./tracker");
    for (const li of board.querySelectorAll<HTMLElement>("li.tile[data-key]")) {
      const rows = hist[li.dataset.key ?? ""] ?? [];
      const vals = rows.map((r) => procDays(r.p90 || r.p50)).filter((v): v is number => v != null);
      if (vals.length < 3) continue;
      const first = li.querySelector(".tile-sub");
      const wrap = h("span", { class: "tile-spark" }, sparkline(vals, { w: 110, h: 28, label: `처리 기간 ${vals.length}일 추이` }), h("small", {}, `${vals.length}일 추이`));
      first?.after(wrap);
    }
  }).catch(() => undefined);
  return board;
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

// 뉴질랜드 경제 칩: 뉴질랜드·한국·미국 기준금리 비교표
function ratesBoard(): HTMLElement | null {
  const pr = brief?.extras?.policy_rates;
  if (!pr || !Object.keys(pr.rates).length) return null;
  const pct = (v: number) => `${v.toFixed(2)}%`;
  const diff = (a: number, b: number) => {
    const bp = Math.round((a - b) * 100);
    return bp === 0 ? h("span", { class: "vs flat" }, "변동 없음") : h("span", { class: `vs ${bp > 0 ? "up" : "down"}` }, `${bp > 0 ? "▲" : "▼"}${Math.abs(bp)}bp`);
  };
  const order: ("NZ" | "KR" | "US")[] = ["NZ", "KR", "US"];
  const flag = { NZ: "🇳🇿", KR: "🇰🇷", US: "🇺🇸" };
  const rows = order.filter((c) => pr.rates[c]).map((c) => {
    const r = pr.rates[c]!;
    const now = r.range ? `${pct(r.range[0])}~${pct(r.range[1])}` : pct(r.value);
    return h("tr", {},
      h("th", { scope: "row" }, `${flag[c]} ${r.name}`, h("small", { class: "rate-label" }, r.label)),
      h("td", {}, h("strong", {}, now)),
      h("td", {}, r.changed_on && r.previous != null ? h("span", {}, diff(r.value, r.previous), h("small", { class: "rate-date" }, fmtDateShort(r.changed_on))) : "—"),
      h("td", {}, r.year_ago != null ? h("span", {}, pct(r.year_ago), " ", diff(r.value, r.year_ago)) : "—"));
  });
  const nz = pr.rates.NZ, kr = pr.rates.KR, us = pr.rates.US;
  const gaps = [nz && kr ? `뉴질랜드-한국 ${Math.round((nz.value - kr.value) * 100)}bp` : "", nz && us ? `뉴질랜드-미국 ${Math.round((nz.value - us.value) * 100)}bp` : ""].filter(Boolean);
  const asOf = [...new Set(order.filter((c) => pr.rates[c]).map((c) => fmtDateShort(pr.rates[c]!.as_of)))].join("·");
  return h("section", { class: "hood-card rates", "aria-labelledby": "rates-title" },
    h("h2", { id: "rates-title" }, "🏦 기준금리 비교"),
    h("div", { class: "table-wrap" }, h("table", { class: "hood-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "국가"), h("th", { scope: "col" }, "현재"), h("th", { scope: "col" }, "최근 변경"), h("th", { scope: "col" }, "1년 전"))),
      h("tbody", {}, ...rows))),
    h("p", { class: "board-note" },
      gaps.length ? `금리 차: ${gaps.join(" · ")}. ` : "",
      `${asOf} 기준 (BIS 중앙은행 정책금리, 미국은 FRED 목표 범위). BIS 자료는 1주 정도 늦게 반영되니 최근 결정은 뉴스를 함께 보세요.`));
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
    { label: "🇰🇷 한인 GP 목록 (한인.nz)", desc: "아래 지도의 원본 목록 — 지역별 한인 GP·등록 가능 여부", url: "https://hanin.nz/korean-gp" },
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
  const g = sel === "all" || sel === "hood" || sel === "leisure" ? undefined : GUIDES[sel];
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

async function renderLeisure(): Promise<void> {
  const holder = h("div", { "aria-busy": "true" }, h("p", { class: "muted" }, "레저 정보를 불러오는 중…"));
  main.append(holder);
  const [gp, mod] = await Promise.all([loadGP(), import("./leisure")]);
  if (settings.tab !== "leisure" || !holder.isConnected) return;
  const fx = (viewingLatest && live?.fx) || brief?.extras.nzd_krw;
  const view = await mod.leisureView(h, { suburbs: watch.suburbs, gp, fx, link: extLink });
  if (settings.tab !== "leisure" || !holder.isConnected) return;
  holder.replaceChildren(view);
  holder.removeAttribute("aria-busy");
}

async function renderHood(): Promise<void> {
  const holder = h("div", { "aria-busy": "true" }, h("p", { class: "muted" }, "내 동네 정보를 불러오는 중…"));
  main.append(holder);
  const names = [...watch.suburbs, ...watch.schools];
  const [areas, briefs, gp] = await Promise.all([loadAreas(), names.length ? recentBriefs() : Promise.resolve([] as Brief[]), loadGP()]);
  if (chipState.akl !== "hood" || settings.tab !== "akl" || !holder.isConnected) return;
  const hits: Hit[] = names.length ? findHits(briefs, names) : [];
  const fx = (viewingLatest && live?.fx) || brief?.extras.nzd_krw;
  const showGPMap = () => {
    chipState.akl = "akl_health";
    renderMain();
    window.scrollTo({ top: 0 });
  };
  holder.replaceChildren(neighbourhoodView(h, watch, areas, hits, fx, extLink, openSettings, gp, showGPMap));
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

// 카드 보기 전환(간단히/자세히) — 도구 줄 맨 뒤 버튼
function initCardMode(): void {
  const tools = document.querySelector(".tools");
  if (!tools) return;
  const btn = h("button", { type: "button", class: "icon-btn mode-btn", id: "card-mode", "aria-label": "카드 보기 방식 바꾸기" });
  const paint = () => {
    btn.textContent = cardMode === "compact" ? "☰ 간단히" : "▤ 자세히";
    btn.title = cardMode === "compact" ? "지금은 제목·한 줄 요약만 보여요 (누르면 자세히)" : "지금은 모든 내용을 보여요 (누르면 간단히)";
  };
  paint();
  btn.addEventListener("click", () => {
    cardMode = cardMode === "compact" ? "full" : "compact";
    try { localStorage.setItem(CARD_MODE_KEY, cardMode); } catch { /* 무시 */ }
    paint();
    renderMain();
  });
  tools.append(btn);
}

// 데이터 상태: 푸터의 접이식 패널 (열 때 status.json 을 읽는다)
function initStatus(): void {
  const foot = document.querySelector("footer.foot");
  if (!foot) return;
  const host = h("div", { class: "status-host" });
  const det = h("details", { class: "data-status" }, h("summary", {}, "🩺 데이터 상태 (브리핑·피드·AI·갱신 시각)"), host);
  let loaded = false;
  det.addEventListener("toggle", () => {
    if (det.open && !loaded) { loaded = true; host.append(h("p", { class: "muted" }, "불러오는 중…")); void statusPanel(h, host); }
  });
  foot.prepend(det);
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
  initCardMode();
  initStatus();
  await loadBrief();
  await initDates();
  document.addEventListener("visibilitychange", autoRefreshLive);
  window.addEventListener("online", autoRefreshLive);
  window.setInterval(autoRefreshLive, AUTO_REFRESH_MS); // 탭을 열어 둔 채로 있어도 1분마다 갱신 (숨겨진 탭은 건너뜀)
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
}

void init();
