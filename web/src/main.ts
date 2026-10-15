import "./style.css";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import type { ArchiveIndex, Brief, Item, SectionKey } from "./types";

// ── 탭/카테고리 정의 ───────────────────────────────────────
interface TabDef {
  id: string;
  icon: string;
  label: string;
  sections: SectionKey[];
}

const TABS: TabDef[] = [
  { id: "kr", icon: "🇰🇷", label: "한국", sections: ["kr_society", "kr_economy", "kr_entertainment", "kr_politics"] },
  { id: "nz", icon: "🇳🇿", label: "뉴질랜드", sections: ["nz_national"] },
  { id: "akl", icon: "🏙️", label: "오클랜드", sections: ["nz_auckland"] },
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
let krChip: SectionKey | "all" = "all";
let query = "";

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
  const fx = brief.extras?.nzd_krw;
  if (fx) extras.append(h("span", { class: "pill" }, "💱 1 NZD = ", h("strong", {}, `${fx.toLocaleString("ko-KR")}원`)));
  const w = brief.extras?.auckland_weather;
  if (w) {
    const rain = w.rain_chance != null ? ` · 강수 ${w.rain_chance}%` : "";
    extras.append(h("span", { class: "pill" }, "🌤 오클랜드 ", h("strong", {}, `${w.min}°~${w.max}°`), ` ${w.desc}${rain}`));
  }
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
  const region = key.startsWith("nz") ? "nz" : "kr";
  const wrap = h("section", { class: "section", "aria-labelledby": `h-${key}` });
  wrap.append(h("h2", { id: `h-${key}`, class: showHeading ? "sec-title" : "sr-only" }, sec.label));
  if (sec.briefing) wrap.append(h("p", { class: "briefing" }, h("span", { class: "briefing-label" }, "오늘의 한 줄"), sec.briefing));
  if (!sec.items.length) wrap.append(h("p", { class: "empty" }, "새 소식이 없습니다."));
  for (const item of sec.items) wrap.append(card(item, region));
  return wrap;
}

function renderChips(): HTMLElement {
  const chips = KR_CHIPS.filter((c) => c.key !== "kr_politics" || settings.showPolitics);
  if (!chips.some((c) => c.key === krChip)) krChip = "all";
  return h("div", { class: "chips", role: "group", "aria-label": "카테고리" }, ...chips.map((c) => {
    const b = h("button", { class: "chip", "aria-pressed": String(krChip === c.key) }, c.label);
    b.addEventListener("click", () => {
      krChip = c.key;
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
    main.append(card(item, key.startsWith("nz") ? "nz" : "kr", brief.sections[key].label));
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
  if (tab.id === "kr") {
    main.append(renderChips());
    const keys = krChip === "all" ? visibleSections(tab) : [krChip];
    for (const k of keys) {
      const block = sectionBlock(k, true);
      if (block) main.append(block);
    }
  } else {
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

function initSettings(): void {
  const dialog = $<HTMLDialogElement>("settings");
  const politics = $<HTMLInputElement>("opt-politics");
  $("settings-btn").addEventListener("click", () => {
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
