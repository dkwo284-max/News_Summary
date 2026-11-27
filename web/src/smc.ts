// 숙련 이민(SMC) 한눈에: 매일 아침 INZ 공식 페이지를 읽어 만든 data/smc.json 을 보여 준다 (AI 없음).
// 한국어 요건은 근거 원문 문장이 오늘도 그대로 있을 때만 ✓, 사라지면 ⚠ (규정이 바뀌었을 수 있음).
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

interface Page { label: string; url: string; status: "ok" | "fail"; checked: string; ok_at?: string }
interface Check { group: string; id: string; page: string; ko: string; ok: boolean | null; quote?: string; stale?: boolean }
interface Change { date: string; page: string; label: string; url: string; added: string[]; removed: string[] }
interface Pts { q: string; pts: number; bachelor?: string }
export interface SmcData {
  checked_at: string; checked_date: string; ok: boolean; baseline?: boolean;
  pages: Record<string, Page>; links: { label: string; url: string }[];
  facts: {
    fee_from_nzd?: number; age_max?: number;
    threshold?: { base: number; x15: number; x2: number; x3: number; from: string; annual_40h: number; cross_check?: boolean };
    qual_nz?: Pts[]; qual_intl?: Pts[]; income_pts?: Pts[]; work_pts?: Pts[];
  };
  checks: Check[]; changes: Change[]; changed_today: Change[];
}
interface Proc { items?: { key: string; p50?: string; p90?: string; pct?: number }[] }

const safe = (u: string) => (/^https:\/\//i.test(u) ? u : "#");
const ext = { target: "_blank", rel: "noopener noreferrer" };
const md = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`; };
const ymd = (s: string) => s ? s.split("-").map((x) => String(Number(x))).join(".") : "";
const nzd = (n: number, dp = 2) => `$${n.toLocaleString("en-NZ", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const GROUPS: [string, string][] = [["apply", "신청 방법"], ["job", "일자리 조건"], ["points", "점수·경로"]];

export function smcCard(h: H, d: SmcData, proc?: Proc | null): HTMLElement {
  const f = d.facts, t = f.threshold;
  const failed = Object.values(d.pages).filter((p) => p.status !== "ok");
  const missing = d.checks.filter((c) => c.ok === false);
  const today = d.changed_today ?? [];
  const status = failed.length ? ["warn", `${failed.length}개 페이지 확인 실패 · 어제 값 표시`]
    : today.length || missing.length ? ["warn", `원문 변경 감지${today.length ? ` ${today.length}곳` : ""}${missing.length ? ` · 확인 필요 ${missing.length}건` : ""}`]
    : ["ok", "원문과 일치"];
  const smcProc = proc?.items?.find((x) => x.key === "smc");

  const tile = (name: string, value: string, sub: string) =>
    h("li", { class: "smc-tile" }, h("span", { class: "smc-tname" }, name), h("b", { class: "smc-tval" }, value), h("span", { class: "smc-tsub" }, sub));
  const tiles = h("ul", { class: "smc-tiles" });
  if (t) {
    tiles.append(tile("SMC 임금 기준", `${nzd(t.base)}/시간`, `${t.from ? ymd(t.from) + "부터 · " : ""}주 40시간이면 연 ${nzd(t.annual_40h, 0)}`));
    tiles.append(tile("1.5배 기준", `${nzd(t.x15)}/시간`, "숙련도 4·5단계·목록 없는 직무, 연봉으로 3점"));
  }
  if (f.fee_from_nzd) tiles.append(tile("신청비", `NZD ${nzd(f.fee_from_nzd, 0)}~`, "EOI는 무료"));
  if (smcProc?.p90 || smcProc?.p50) tiles.append(tile("처리 기간", smcProc.p90 || smcProc.p50 || "", smcProc.p90 ? `${smcProc.pct ?? 80}% 결정${smcProc.p50 ? ` · 절반 ${smcProc.p50}` : ""}` : "절반 결정"));

  const item = (c: Check) => {
    const li = h("li", { class: `smc-chk ${c.ok ? "ok" : c.ok === false ? "bad" : "unk"}` },
      h("span", { class: "smc-mark", "aria-label": c.ok ? "원문 확인됨" : "원문 확인 필요" }, c.ok ? "✓" : "⚠"),
      h("span", {}, c.ko, c.ok === false ? h("small", { class: "smc-flag" }, " 오늘 원문에서 이 문장을 못 찾았어요 — 규정이 바뀌었을 수 있어요") : null,
        c.stale ? h("small", { class: "smc-flag" }, " (오늘 페이지를 못 읽어 어제 확인 기준)") : null));
    if (c.quote) li.append(h("details", { class: "smc-quote" }, h("summary", {}, "원문"), h("q", { lang: "en" }, c.quote),
      d.pages[c.page] ? h("a", { href: safe(d.pages[c.page].url), ...ext }, ` ${d.pages[c.page].label} ↗`) : null));
    return li;
  };
  const groups = GROUPS.map(([g, label]) => {
    const rows = d.checks.filter((c) => c.group === g);
    return rows.length ? h("div", { class: "smc-group" }, h("h3", {}, label), h("ul", { class: "smc-chks" }, ...rows.map(item))) : null;
  });

  const ptsTable = (title: string, rows: Pts[] | undefined, withBach: boolean) => rows?.length
    ? h("table", { class: "smc-table" }, h("caption", {}, title),
      h("thead", {}, h("tr", {}, h("th", {}, "원문 항목"), h("th", {}, "점수"), withBach ? h("th", {}, "학사 필요") : null)),
      h("tbody", {}, ...rows.map((r) => h("tr", {}, h("td", { lang: "en" }, r.q), h("td", { class: "num" }, String(r.pts)),
        withBach ? h("td", { lang: "en" }, r.bachelor ?? "") : null)))) : null;
  const points = h("details", { class: "smc-more" }, h("summary", {}, "점수표 (원문 표 그대로)"),
    h("p", { class: "smc-note" }, "점수제는 6점이 필요해요. 학위·연봉·직업 등록 중 하나로 점수를 내고, 모자라면 NZ 숙련 경력으로 최대 3점을 더해요."),
    ptsTable("NZ 학위", f.qual_nz, true), ptsTable("해외 학위", f.qual_intl, true), ptsTable("연봉", f.income_pts, false), ptsTable("NZ 숙련 경력 (추가 점수)", f.work_pts, false));

  const recent = (d.changes ?? []).slice(0, 8);
  const changes = h("details", { class: "smc-more", ...(today.length ? { open: "" } : {}) },
    h("summary", {}, `원문 변경 기록${recent.length ? ` ${recent.length}건` : ""}`),
    recent.length ? h("ul", { class: "smc-changes" }, ...recent.map((c) => h("li", {},
      h("div", { class: "smc-chead" }, h("b", {}, ymd(c.date)), " · ", h("a", { href: safe(c.url), ...ext }, `${c.label} ↗`)),
      ...c.added.map((x) => h("div", { class: "smc-add", lang: "en" }, `+ ${x}`)),
      ...c.removed.map((x) => h("div", { class: "smc-del", lang: "en" }, `− ${x}`)))))
      : h("p", { class: "smc-note" }, `아직 바뀐 문장이 없어요. ${d.baseline ? "오늘 기준 원문을 저장했고, " : ""}매일 아침 공식 페이지와 비교해 문장이 바뀌면 여기와 '오늘의 이민 알림'에 표시해요.`));

  const links = h("ul", { class: "smc-links" },
    ...Object.values(d.pages).map((p) => h("li", {}, h("a", { href: safe(p.url), ...ext }, `${p.label} ↗`),
      p.status !== "ok" ? h("small", { class: "smc-flag" }, ` 확인 실패${p.ok_at ? ` (마지막 성공 ${md(p.ok_at)})` : ""}`) : null)),
    ...d.links.map((l) => h("li", {}, h("a", { href: safe(l.url), ...ext }, `${l.label} ↗`))));

  return h("section", { class: "smc", "aria-labelledby": "smc-title" },
    h("div", { class: "smc-head" },
      h("h2", { id: "smc-title" }, "📘 숙련 이민(SMC) 한눈에"),
      h("span", { class: `smc-status ${status[0]}` }, status[1]),
      h("span", { class: "smc-meta" }, `INZ 공식 원문 · ${md(d.checked_at)} 확인`)),
    tiles.childElementCount ? tiles : null,
    ...groups, points, changes,
    h("details", { class: "smc-more" }, h("summary", {}, "공식 링크"), links),
    h("p", { class: "smc-note" }, "매일 아침 INZ 공식 페이지를 읽어 근거 문장이 그대로 있는지 확인해요. 요약은 이해를 돕기 위한 것이고, 신청 전에는 반드시 원문 링크로 확인하세요."));
}
