// INZ 규정 변경 이력: data/inz-changes.json (매일 아침 INZ 공식 페이지를 어제와 비교해 쌓은 기록)을 보여 준다.
// 1층 숫자·요건 '이전 → 이후' · 2층 바뀐 문장(단어 형광펜) + AI 한 줄 요약(원문 병기) · 주제 필터 · 되돌려진 변경 숨김
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

interface Fact { key: string; name: string; before: string; after: string }
interface Pair { before: string; after: string; ops: [string, string][]; numeric: boolean }
interface Text { pairs: Pair[]; added: string[]; removed: string[]; counts: { pairs: number; added: number; removed: number } }
interface Entry { id: string; date: string; page: string; topic: string; label: string; url: string; facts?: Fact[]; text?: Text; ai?: { summary: string; model?: string }; reverted?: string; revert_of?: string }
interface PageMeta { topic: string; label: string; url: string; status: string; checked: string; since?: string; ok_at?: string }
export interface InzLog { updated: string; checked_at: string; topics: Record<string, string>; pages: Record<string, PageMeta>; baseline?: boolean; entries: Entry[] }

const safe = (u: string) => (/^https:\/\//i.test(u) ? u : "#");
const ext = { target: "_blank", rel: "noopener noreferrer" };
const ymd = (s: string) => (s ? s.split("-").map((x) => String(Number(x))).join(".") : "");
const md = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`; };
const KEY = "daily-brief:inzlog";

export function inzLogCard(h: H, d: InzLog): HTMLElement {
  let st: { topic: string; reverted: boolean; n: number } = { topic: "all", reverted: false, n: 8 };
  try { st = { ...st, ...JSON.parse(sessionStorage.getItem(KEY) || "{}"), n: 8 }; } catch { /* 저장소를 못 쓰는 환경 */ }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ topic: st.topic, reverted: st.reverted })); } catch { /* 무시 */ } };
  const pages = Object.entries(d.pages);
  const since = pages.map(([, p]) => p.since || "").filter(Boolean).sort()[0] || d.updated;
  const visible = (e: Entry) => st.reverted || (!e.reverted && !e.revert_of);

  const body = h("div", { class: "il-body" });
  const chips = h("div", { class: "il-chips", role: "group", "aria-label": "주제" });
  const revBox = h("input", { type: "checkbox", id: "il-rev" });
  revBox.checked = st.reverted;
  revBox.onchange = () => { st.reverted = revBox.checked; save(); draw(); };

  const factRow = (f: Fact) => h("li", { class: "il-fact" }, h("span", { class: "il-fname" }, f.name),
    h("span", { class: "il-ba" }, h("s", {}, f.before), " → ", h("b", {}, f.after)));
  const pairEl = (p: Pair) => h("div", { class: `il-pair${p.numeric ? " num" : ""}`, lang: "en" },
    p.numeric ? h("span", { class: "il-tag" }, "숫자 변경") : null,
    ...p.ops.flatMap(([t, s], i) => [i ? " " : "", t === "=" ? s : t === "-" ? h("del", {}, s) : h("ins", {}, s)]));
  const entryEl = (e: Entry) => {
    const t = e.text, more = t ? t.counts.pairs + t.counts.added + t.counts.removed - (t.pairs.length + t.added.length + t.removed.length) : 0;
    return h("li", { class: `il-entry${e.reverted || e.revert_of ? " rev" : ""}` },
      h("div", { class: "il-head" }, h("b", {}, ymd(e.date)), h("span", { class: "il-topic" }, d.topics[e.topic] ?? e.topic),
        h("a", { href: safe(e.url), ...ext }, `${e.label} ↗`),
        e.reverted ? h("small", { class: "il-flag" }, ` ${ymd(e.reverted)}에 원래대로 돌아감`) : e.revert_of ? h("small", { class: "il-flag" }, " 이전 변경을 되돌림") : null),
      e.facts?.length ? h("ul", { class: "il-facts" }, ...e.facts.map(factRow)) : null,
      e.ai?.summary ? h("p", { class: "il-ai" }, h("span", { class: "il-aitag" }, "AI 요약"), ` ${e.ai.summary}`) : null,
      t ? h("details", { class: "il-text", ...(e.facts?.length ? {} : { open: "" }) },
        h("summary", {}, `바뀐 문장 ${t.counts.pairs + t.counts.added + t.counts.removed}곳 (원문)`),
        ...t.pairs.map(pairEl),
        ...t.added.map((x) => h("div", { class: "il-add", lang: "en" }, `+ ${x}`)),
        ...t.removed.map((x) => h("div", { class: "il-del", lang: "en" }, `− ${x}`)),
        more > 0 ? h("small", { class: "il-note" }, `외 ${more}곳은 원문 링크에서 확인하세요.`) : null) : null);
  };

  const draw = () => {
    const all = d.entries.filter(visible);
    const count = (k: string) => all.filter((e) => k === "all" || e.topic === k).length;
    chips.replaceChildren(...[["all", "전체"], ...Object.entries(d.topics)].map(([k, l]) => {
      const b = h("button", { type: "button", class: `il-chip${st.topic === k ? " on" : ""}`, "aria-pressed": String(st.topic === k) }, `${l} ${count(k)}`);
      b.onclick = () => { st.topic = k; st.n = 8; save(); draw(); };
      return b;
    }));
    const list = all.filter((e) => st.topic === "all" || e.topic === st.topic);
    if (!list.length) {
      body.replaceChildren(h("p", { class: "il-empty" }, `${ymd(since)}부터 매일 비교 중이에요. ${st.topic === "all" ? "" : (d.topics[st.topic] ?? "") + " "}아직 바뀐 내용이 없어요. 바뀌면 이전 → 이후로 여기에 쌓이고 '오늘의 이민 알림'에도 떠요.`));
      return;
    }
    const ul = h("ol", { class: "il-list" }, ...list.slice(0, st.n).map(entryEl));
    const nodes: Node[] = [ul];
    if (list.length > st.n) {
      const mb = h("button", { type: "button", class: "il-more" }, `더 보기 (${list.length - st.n}건)`);
      mb.onclick = () => { st.n += 10; draw(); };
      nodes.push(mb);
    }
    body.replaceChildren(...nodes);
  };
  draw();

  const failed = pages.filter(([, p]) => p.status !== "ok");
  return h("section", { class: "il", id: "inz-history", "aria-labelledby": "il-title" },
    h("div", { class: "il-headrow" },
      h("h2", { id: "il-title" }, "🗂 INZ 규정 변경 이력"),
      h("span", { class: "il-meta" }, `공식 페이지 ${pages.length - 1}곳 + 처리 기간 · ${md(d.checked_at)} 확인${failed.length ? ` · ${failed.length}곳 확인 실패` : ""}`)),
    chips,
    h("label", { class: "il-rev", for: "il-rev" }, revBox, " 며칠 안에 원래대로 돌아간 변경도 보기"),
    body,
    h("details", { class: "il-pages" }, h("summary", {}, "감시 중인 공식 페이지"),
      h("ul", {}, ...pages.map(([, p]) => h("li", {}, h("a", { href: safe(p.url), ...ext }, `${p.label} ↗`), h("small", {}, ` · ${d.topics[p.topic] ?? ""}${p.since ? ` · ${ymd(p.since)}부터` : ""}${p.status !== "ok" ? ` · 확인 실패${p.ok_at ? `(마지막 성공 ${md(p.ok_at)})` : ""}` : ""}`))))),
    h("p", { class: "il-note" }, "숫자·요건은 AI 없이 원문 값으로 비교하고, 'AI 요약'은 바뀐 문장을 읽기 쉽게 옮긴 보조 설명이에요. 판단은 아래 원문 문장과 공식 링크로 하세요. 서식·메뉴만 바뀐 줄은 빼고, 3년치를 보관합니다."));
}
