// 이민 정책 추적: 주요 정당의 이민 정책 입장(쟁점별 비교) · 정부 반영 상태 · 변화 기록 · 관련 기사.
// 입장·상태는 사람이 공식 자료로 확인해 적은 data/policy.json, 관련 기사는 규칙으로 모은 policy-news.json 을 읽기만 한다 (AI 없음).
import { STAGES, currentStage } from "./tracker";
import { daysUntil, loadPlan } from "./visa";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

interface Src { label: string; url: string; type: string }
interface Pos { dir: string; status: string; text: string; src: string[]; conf?: string }
interface Party { id: string; name: string; short: string; role: string; positions: Record<string, Pos> }
interface Issue { id: string; icon: string; label: string; stages: string[] }
interface TLItem { date: string; party: string; issue: string; dir: string; title: string; detail: string; src: string[]; conf?: string }
interface Govt { id: string; type: "done" | "pending" | "pledge"; title: string; party?: string; parties?: string[]; date?: string | null; stages: string[]; detail: string; src: string[]; conf?: string }
interface Watch { when: string; title: string; why: string; src: string[] }
export interface PolicyData {
  updated: string; note: string;
  election: { date: string; status: string; detail: string; sources: string[] };
  sources: Record<string, Src>;
  dirs: Record<string, { label: string; icon: string }>;
  statuses: Record<string, string>;
  issues: Issue[]; parties: Party[]; timeline: TLItem[]; govt: Govt[]; watch: Watch[];
}
export interface PolicyNews { updated: string; items: { date: string; title: string; url: string; source: string; parties: string[]; issues: string[]; change: boolean }[] }

const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const TAB_KEY = "daily-brief:policy-tab";
type Tab = "compare" | "govt" | "log" | "news";
const TABS: { key: Tab; label: string }[] = [
  { key: "compare", label: "정당 비교" },
  { key: "govt", label: "정부 반영" },
  { key: "log", label: "변화 기록" },
  { key: "news", label: "관련 기사" },
];

/** 2026-08-24 → 2026.8.24, 2026-10 → 2026.10 */
export const fmtPolicyDate = (s: string): string => s.split("-").map((x) => String(Number(x))).join(".");

/** 내 단계(현재·다음)에 해당하는 단계 키. 일정이 없으면 빈 배열 */
export function myStageKeys(): string[] {
  const cur = currentStage(loadPlan().visas);
  if (!cur) return [];
  return [STAGES[cur.idx]?.key, STAGES[cur.idx + 1]?.key].filter((k): k is string => !!k);
}

export function policyPanel(h: H, d: PolicyData, news: PolicyNews | null): HTMLElement {
  const mine = myStageKeys();
  const isMine = (stages: string[]) => stages.some((s) => mine.includes(s));
  const partyName = (id: string) => (id === "gov" ? "정부·INZ" : d.parties.find((p) => p.id === id)?.name ?? id);
  const issueOf = (id: string) => d.issues.find((i) => i.id === id);
  const stageName = (k: string) => STAGES.find((s) => s.key === k)?.short ?? k;

  let tab: Tab = (() => {
    try {
      const t = sessionStorage.getItem(TAB_KEY) as Tab | null;
      return t && TABS.some((x) => x.key === t) ? t : "compare";
    } catch {
      return "compare";
    }
  })();
  let pick: { party: string; issue: string } | null = null;
  let logFilter = "all";
  let newsFilter = "all";

  const srcLinks = (ids: string[]) => h("span", { class: "pol-src" }, ...ids.flatMap((id, i) => {
    const s = d.sources[id];
    return s ? [i ? " · " : "", h("a", { href: safe(s.url), target: "_blank", rel: "noopener noreferrer", title: s.label }, `${s.type} · ${s.label} ↗`)] : [];
  }));
  const dirBadge = (dir: string) => {
    const x = d.dirs[dir] ?? d.dirs.none;
    return h("span", { class: `pol-dir d-${dir}` }, `${x.icon} ${x.label}`);
  };
  const confNote = (c?: string) => (c === "secondary" ? h("small", { class: "pol-warn" }, "2차 자료(기사 요약) 기준 — 공식 원문 확인 필요") : null);

  const body = h("div", { class: "pol-body" });
  const tabBar = h("div", { class: "pol-tabs", role: "tablist", "aria-label": "이민 정책 추적" });

  // ── 탭 1: 정당 비교 ──
  function compare(): HTMLElement {
    const wrap = h("div", {});
    const detail = h("div", { class: "pol-detail", "aria-live": "polite" });
    const showDetail = () => {
      if (!pick) {
        detail.replaceChildren(h("p", { class: "muted" }, "칸을 누르면 그 정당의 입장과 근거를 볼 수 있어요."));
        return;
      }
      const p = d.parties.find((x) => x.id === pick!.party)!;
      const iss = issueOf(pick.issue)!;
      const pos = p.positions[pick.issue];
      detail.replaceChildren(h("div", { class: "pol-card" },
        h("div", { class: "pol-card-head" }, h("strong", {}, `${p.name} · ${iss.icon} ${iss.label}`), pos ? dirBadge(pos.dir) : dirBadge("none"),
          pos ? h("span", { class: `pol-status s-${pos.status}` }, d.statuses[pos.status] ?? pos.status) : null),
        h("p", { class: "muted pol-role" }, p.role),
        pos ? h("p", {}, pos.text) : h("p", { class: "muted" }, "이 쟁점에 대한 공식 공약을 확인하지 못했어요. 입장이 없다는 뜻이 아니라 확인된 자료가 없다는 뜻이에요."),
        pos ? confNote(pos.conf) : null, pos ? srcLinks(pos.src) : null));
    };
    const rows = d.issues.map((iss) => h("tr", { class: isMine(iss.stages) ? "mine" : "" },
      h("th", { scope: "row" }, `${iss.icon} ${iss.label}`, isMine(iss.stages) ? h("span", { class: "pol-me", title: "내 비자 단계와 관련" }, " 🎯") : null),
      ...d.parties.map((p) => {
        const pos = p.positions[iss.id];
        const dir = pos?.dir ?? "none";
        const x = d.dirs[dir];
        const btn = h("button", { type: "button", class: `pol-cell d-${dir}`, "aria-label": `${p.name} ${iss.label}: ${x.label}`, "aria-pressed": "false" },
          h("span", { class: "pol-ic", "aria-hidden": "true" }, x.icon), h("span", { class: "pol-lb" }, dir === "none" ? "–" : x.label));
        if (pick && pick.party === p.id && pick.issue === iss.id) btn.setAttribute("aria-pressed", "true");
        btn.addEventListener("click", () => {
          pick = { party: p.id, issue: iss.id };
          wrap.querySelectorAll(".pol-cell").forEach((b) => b.setAttribute("aria-pressed", "false"));
          btn.setAttribute("aria-pressed", "true");
          showDetail();
        });
        return h("td", {}, btn);
      })));
    const table = h("table", { class: "pol-matrix" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, ""), ...d.parties.map((p) => h("th", { scope: "col", title: p.role }, p.short)))),
      h("tbody", {}, ...rows));
    const legend = h("p", { class: "pol-legend" }, ...["loosen", "tighten", "keep", "mixed", "review"].map((k) => dirBadge(k)),
      h("small", { class: "muted" }, " 방향은 '기존 규정 대비'가 아니라 이민자 입장에서의 문턱 변화를 요약한 것이에요. 좋고 나쁨의 평가가 아닙니다."));
    wrap.append(h("div", { class: "table-wrap" }, table), legend, detail);
    if (!mine.length) wrap.append(h("p", { class: "muted pol-hint" }, "🎯 비자 일정을 입력하면 내 단계와 관련 있는 쟁점이 표시돼요."));
    showDetail();
    return wrap;
  }

  // ── 탭 2: 정부 반영 ──
  function govt(): HTMLElement {
    const wrap = h("div", {});
    const groups: { type: Govt["type"]; title: string; note: string }[] = [
      { type: "done", title: "✅ 시행·확정", note: "이미 규정이 바뀌었거나 날짜가 정해진 것" },
      { type: "pending", title: "⏳ 진행·예정", note: "법안 심의 중이거나 시행일이 아직 안 정해진 것" },
      { type: "pledge", title: "🗳️ 선거 공약 (연정 협상 대기)", note: "정당이 약속했지만 정부가 되어 협상을 거쳐야 정책이 되는 것 · 같은 방향의 정당이 많을수록 반영될 여지가 큼" },
    ];
    for (const g of groups) {
      const list = d.govt.filter((x) => x.type === g.type).sort((a, b) => Number(isMine(b.stages)) - Number(isMine(a.stages)));
      if (!list.length) continue;
      wrap.append(h("h3", { class: "pol-h" }, g.title), h("p", { class: "muted pol-note" }, g.note),
        h("ul", { class: "pol-list" }, ...list.map((x) => {
          const n = x.parties?.length ?? 0;
          const days = x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? daysUntil(x.date) : null;
          return h("li", { class: `pol-item ${isMine(x.stages) ? "mine" : ""}` },
            h("div", { class: "pol-item-head" }, h("strong", {}, x.title),
              isMine(x.stages) ? h("span", { class: "pol-badge me" }, "🎯 내 단계 관련") : null,
              x.party ? h("span", { class: "pol-badge" }, `${partyName(x.party)} 정부 정책`) : null,
              n ? h("span", { class: "pol-badge" }, `${x.parties!.map(partyName).join("·")}`) : null,
              n > 1 ? h("span", { class: "pol-badge cross" }, `${n}개 정당 공통`) : null,
              x.date ? h("span", { class: "pol-badge date" }, days != null && days > 0 ? `${fmtPolicyDate(x.date)} (D-${days})` : fmtPolicyDate(x.date)) : g.type !== "pledge" ? h("span", { class: "pol-badge date" }, "시행일 미정") : null),
            h("p", {}, x.detail),
            x.stages.length ? h("p", { class: "muted pol-stages" }, `관련 단계: ${x.stages.map(stageName).join(" · ")}`) : null,
            confNote(x.conf), srcLinks(x.src));
        })));
    }
    wrap.append(h("h3", { class: "pol-h" }, "👀 앞으로 확인할 것"),
      h("ul", { class: "pol-list" }, ...d.watch.map((w) => h("li", { class: "pol-item" },
        h("div", { class: "pol-item-head" }, h("span", { class: "pol-badge date" }, /^\d{4}-\d{2}-\d{2}$/.test(w.when) ? fmtPolicyDate(w.when) : w.when), h("strong", {}, w.title)),
        h("p", {}, w.why), srcLinks(w.src)))));
    return wrap;
  }

  // ── 탭 3: 변화 기록 ──
  function log(): HTMLElement {
    const wrap = h("div", {});
    const ids = ["all", ...d.parties.map((p) => p.id), "gov"];
    const chips = h("div", { class: "chips", role: "group", "aria-label": "정당 필터" }, ...ids.map((id) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(logFilter === id) }, id === "all" ? "전체" : partyName(id));
      b.addEventListener("click", () => { logFilter = id; render(); });
      return b;
    }));
    const list = d.timeline.filter((t) => logFilter === "all" || t.party === logFilter).sort((a, b) => b.date.localeCompare(a.date));
    wrap.append(chips, h("ol", { class: "pol-tl" }, ...list.map((t) => {
      const iss = issueOf(t.issue);
      return h("li", { class: "pol-tl-item" },
        h("span", { class: "pol-tl-date" }, fmtPolicyDate(t.date)),
        h("div", {},
          h("div", { class: "pol-item-head" }, h("span", { class: "pol-badge" }, partyName(t.party)), iss ? h("span", { class: "pol-badge" }, `${iss.icon} ${iss.label}`) : null, dirBadge(t.dir)),
          h("strong", {}, t.title), h("p", {}, t.detail), confNote(t.conf), srcLinks(t.src)));
    })));
    if (!list.length) wrap.append(h("p", { class: "muted" }, "기록이 없어요."));
    return wrap;
  }

  // ── 탭 4: 관련 기사 ──
  function newsTab(): HTMLElement {
    const wrap = h("div", {});
    if (!news || !news.items.length) return h("p", { class: "muted" }, "아직 모인 기사가 없어요. 매일 아침 브리핑에서 정당·정부 이민 기사를 자동으로 모읍니다.");
    const ids = ["all", ...d.parties.map((p) => p.id), "gov"];
    const chips = h("div", { class: "chips", role: "group", "aria-label": "정당 필터" }, ...ids.map((id) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(newsFilter === id) }, id === "all" ? "전체" : partyName(id));
      b.addEventListener("click", () => { newsFilter = id; render(); });
      return b;
    }));
    const list = news.items.filter((x) => newsFilter === "all" || x.parties.includes(newsFilter));
    // 정당별 최근 30일 기사 수 (관심이 어디 쏠리는지)
    const cut = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const cnt = [...d.parties.map((p) => p.id), "gov"].map((id) => ({ id, n: news.items.filter((x) => x.date >= cut && x.parties.includes(id)).length }));
    const mx = Math.max(1, ...cnt.map((c) => c.n));
    wrap.append(h("div", { class: "pol-bars", role: "img", "aria-label": "정당별 최근 30일 관련 기사 수" }, ...cnt.map((c) => h("div", { class: "pol-bar" }, h("span", { class: "pb-l" }, partyName(c.id)),
      h("span", { class: "pb-t" }, h("i", { style: `width:${(c.n / mx * 100).toFixed(0)}%` })), h("span", { class: "pb-n" }, String(c.n))))));
    wrap.append(chips, h("ul", { class: "pol-list" }, ...list.slice(0, 40).map((x) => h("li", { class: "pol-item" },
      h("div", { class: "pol-item-head" }, h("span", { class: "muted" }, fmtPolicyDate(x.date)), ...x.parties.map((p) => h("span", { class: "pol-badge" }, partyName(p))),
        x.change ? h("span", { class: "pol-badge cross" }, "정책 변화 신호") : null),
      h("a", { href: safe(x.url), target: "_blank", rel: "noopener noreferrer" }, x.title),
      x.source ? h("small", { class: "muted" }, ` · ${x.source}`) : null))),
      h("p", { class: "board-note" }, "키워드 규칙으로 자동 분류한 기사예요 (AI 미사용). 정당·쟁점 분류가 틀릴 수 있으니 기사 원문을 확인하세요."));
    return wrap;
  }

  function render() {
    try { sessionStorage.setItem(TAB_KEY, tab); } catch { /* 무시 */ }
    tabBar.replaceChildren(...TABS.map((t) => {
      const b = h("button", { type: "button", role: "tab", class: "pol-tab", "aria-selected": String(t.key === tab) }, t.label);
      b.addEventListener("click", () => { tab = t.key; render(); });
      return b;
    }));
    body.replaceChildren(tab === "compare" ? compare() : tab === "govt" ? govt() : tab === "log" ? log() : newsTab());
  }
  render();

  return h("details", { class: "policy", open: "" },
    h("summary", {}, "🏛️ 정당 이민 정책 추적"),
    h("div", { class: "pol-election" }, h("strong", {}, `🗳️ ${d.election.status}`), h("p", {}, d.election.detail), srcLinks(d.election.sources)),
    tabBar, body,
    h("p", { class: "board-note" }, `${d.note} (정리일 ${fmtPolicyDate(d.updated)})`));
}
