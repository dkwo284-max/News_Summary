// 이민 단계 트래커: 내 비자 일정(이 기기 저장) + 비자 처리 기간 전광판 + 최근 이민 레이더 기사를 한 장으로.
// AI 를 쓰지 않는다. 날짜 계산은 참고용이며 실제 조건은 INZ 공식 안내를 따른다.
import type { Brief, Item, ProcessingItem } from "./types";
import { daysUntil, loadPlan } from "./visa";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

interface Stage { key: string; label: string; short: string; proc: string[]; words: RegExp }
export const STAGES: Stage[] = [
  { key: "student", label: "학생비자", short: "학생", proc: [], words: /student visa|학생비자|유학생/i },
  { key: "pswv", label: "졸업 후 취업비자 (PSWV)", short: "PSWV", proc: ["pswv"], words: /post.?study|pswv|졸업 후 취업/i },
  { key: "work", label: "취업비자 (AEWV)", short: "취업", proc: ["aewv"], words: /aewv|accredited employer|work visa|취업비자|고용주 인증/i },
  { key: "residence", label: "영주권 (SMC·Green List·WTR)", short: "영주권", proc: ["smc", "gl_str", "wtr"], words: /resident visa|residence|skilled migrant|green list|그린리스트|영주권|smc/i },
  { key: "pr", label: "영구 영주권", short: "영구", proc: ["pr"], words: /permanent resident|영구 영주권/i },
  { key: "citizenship", label: "시민권", short: "시민권", proc: ["citizenship"], words: /citizenship|시민권/i },
];

/** "3.5주"·"5개월"·"9주"·"2주"·"10일" → 일수 */
export function procDays(s: string | undefined): number | null {
  const m = /([\d.]+)\s*(일|주|개월|년)/.exec(s || "");
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(n * ({ 일: 1, 주: 7, 개월: 30.4, 년: 365 } as Record<string, number>)[m[2]]);
}

/** 현재 단계: 아직 만료되지 않은 비자 중 가장 앞선 단계 (방문비자는 단계가 아님). 일정이 없으면 null */
export function currentStage(visas: { label: string; kind: string; expiry: string }[]): { idx: number; expiry?: string } | null {
  let best: { idx: number; expiry?: string } | null = null;
  for (const v of visas) {
    if (daysUntil(v.expiry) < 0 && v.kind !== "resident") continue;
    const idx = v.kind === "student" ? 0 : v.kind === "work" ? (/pswv|졸업|post.?study/i.test(v.label) ? 1 : 2) : v.kind === "resident" ? (/영구|permanent/i.test(v.label) ? 4 : 3) : -1;
    if (idx >= 0 && (!best || idx > best.idx)) best = { idx, expiry: v.expiry };
  }
  return best;
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const dLabel = (n: number) => (n > 0 ? `D-${n}` : n === 0 ? "D-Day" : `D+${-n}`);
const fmt = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${y}.${m}.${d}`; };

export function trackerCard(h: H, brief: Brief, recent: Brief[] | null, openSettings: () => void): HTMLElement {
  const plan = loadPlan();
  const cur = currentStage(plan.visas);
  const idx = cur?.idx ?? -1;
  const next = STAGES[Math.min(idx + 1, STAGES.length - 1)];
  const proc: Record<string, ProcessingItem> = Object.fromEntries((brief.extras?.processing_times?.items ?? []).map((p) => [p.key, p]));

  const steps = h("ol", { class: "trk-steps", "aria-label": "이민 단계" }, ...STAGES.map((s, i) => {
    const state = i < idx ? "done" : i === idx ? "now" : i === idx + 1 ? "next" : "later";
    const p = s.proc.map((k) => proc[k]).filter(Boolean)[0];
    return h("li", { class: `trk-step ${state}`, title: s.label },
      h("span", { class: "trk-dot", "aria-hidden": "true" }, state === "done" ? "✓" : String(i + 1)),
      h("span", { class: "trk-name" }, s.short),
      p && (p.p90 || p.p50) ? h("span", { class: "trk-proc" }, p.p90 || p.p50) : null,
      h("span", { class: "sr-only" }, state === "now" ? " (현재)" : state === "next" ? " (다음)" : ""));
  }));

  const body = h("div", { class: "trk-body" });
  if (idx < 0) {
    const b = h("button", { type: "button", class: "link-btn" }, "비자 일정 입력");
    b.addEventListener("click", openSettings);
    body.append(h("p", { class: "muted" }, "비자 일정(학생·취업·영주권)을 입력하면 현재 단계와 다음 단계 신청 시점을 계산해 드려요. "), b);
  } else if (idx < STAGES.length - 1) {
    const ps = next.proc.map((k) => proc[k]).filter((p): p is ProcessingItem => !!p && !!(p.p90 || p.p50));
    const days = ps.map((p) => procDays(p.p90 || p.p50)).filter((d): d is number => d != null);
    const worst = days.length ? Math.max(...days) : null;
    const line = h("p", { class: "trk-next" }, h("strong", {}, `다음 단계: ${next.label}`));
    if (ps.length) line.append(h("span", { class: "muted" }, ` · 현재 처리 기간 ${ps.map((p) => `${p.name.replace(/\s*\(.*\)/, "")} ${p.p90 || p.p50}`).join(", ")} (INZ 80% 기준)`));
    body.append(line);
    if (cur?.expiry && worst != null) {
      // 권장 신청일 = 현재 비자 만료 - 처리 기간 - 1개월 여유 (INZ: 다음 비자는 만료 1개월 전까지 신청 권장)
      const apply = addDays(cur.expiry, -(worst + 30));
      const n = daysUntil(apply);
      body.append(h("p", { class: `trk-apply ${n < 0 ? "past" : n <= 60 ? "urgent" : "ok"}` },
        "권장 신청 시점 ", h("strong", {}, `${fmt(apply)} (${dLabel(n)})`),
        h("span", { class: "muted" }, ` · 현재 비자 만료 ${fmt(cur.expiry)}에서 처리 기간(최장 ${worst}일)과 1개월 여유를 뺀 날`)));
    }
  } else {
    body.append(h("p", {}, "마지막 단계예요. 시민권 관련 소식만 모아 보여줘요."));
  }

  // 다음 단계와 관련된 최근 2주 이민 레이더 기사
  const focus = idx < 0 ? STAGES[1] : next;
  const pool: { item: Item; date: string }[] = [];
  const seen = new Set<string>();
  for (const b of [brief, ...(recent ?? [])]) {
    for (const it of b.sections.nz_immigration?.items ?? []) {
      if (seen.has(it.id)) continue;
      if (focus.words.test(`${it.title_ko} ${it.original_title ?? ""} ${it.tags.join(" ")}`)) {
        seen.add(it.id);
        pool.push({ item: it, date: b.date });
      }
    }
  }
  pool.sort((a, b) => b.date.localeCompare(a.date));
  body.append(h("div", { class: "trk-news" }, h("span", { class: "trk-news-title" }, `📰 ${focus.short} 관련 최근 소식 ${pool.length}건${recent ? " (최근 2주)" : ""}`),
    pool.length ? h("ul", {}, ...pool.slice(0, 3).map(({ item, date }) => h("li", {},
      h("span", { class: "muted" }, `${date.slice(5).replace("-", "/")} `),
      item.sources[0] ? h("a", { href: item.sources[0].url, target: "_blank", rel: "noopener noreferrer" }, item.title_ko) : item.title_ko,
      item.impact && item.impact.level === "high" ? h("span", { class: "impact-badge high" }, "영향 높음") : null))) : h("p", { class: "muted" }, "관련 기사가 아직 없어요.")));
  body.append(h("p", { class: "board-note" }, "참고용 계산이에요. 신청 조건·기한은 INZ 공식 안내와 본인 비자 승인서를 기준으로 확인하세요."));
  return h("section", { class: "trk", "aria-labelledby": "trk-title" }, h("h2", { id: "trk-title" }, "🧭 이민 단계 트래커"), steps, body);
}
