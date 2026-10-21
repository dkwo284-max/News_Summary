// 내 비자 일정 (D-day): 기기(localStorage)에만 저장한다. 저장소가 공개라 서버·데이터 파일에는 절대 넣지 않는다.
export type VisaKind = "student" | "visitor" | "work" | "resident" | "other";

export interface VisaEntry {
  label: string; // 예: "본인 학생비자"
  kind: VisaKind;
  start?: string; // YYYY-MM-DD
  expiry: string; // YYYY-MM-DD
}

export interface VisaPlan {
  visas: VisaEntry[];
  childBirth?: string; // 자녀 생년월일 (초등학교 입학 시기 계산용, 선택)
}

const KEY = "daily-brief:visa";
const KIND_LABEL: Record<VisaKind, string> = {
  student: "학생비자",
  visitor: "방문비자",
  work: "취업비자",
  resident: "영주권",
  other: "기타",
};
const INZ = {
  pswv: "https://www.immigration.govt.nz/visas/post-study-work-visa/",
  expired: "https://www.immigration.govt.nz/expired-visa",
  partner: "https://www.immigration.govt.nz/visas/",
  school: "https://www.education.govt.nz/parents-and-caregivers/schooling/starting-school/",
};

export function loadPlan(): VisaPlan {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as VisaPlan;
      if (Array.isArray(p.visas)) return p;
    }
  } catch {
    /* ignore */
  }
  return { visas: [] };
}

export function savePlan(p: VisaPlan): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 설정 링크(#setup=...)로 받은 일정을 저장하고 주소에서 지운다. 해시는 서버로 전송되지 않는다. */
export function importFromHash(): boolean {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
    const raw = JSON.parse(json) as { v?: { l: string; k: VisaKind; s?: string; e: string }[]; c?: string };
    const visas = (raw.v ?? [])
      .filter((x) => x && typeof x.l === "string" && DATE_RE.test(x.e))
      .slice(0, 8)
      .map((x) => ({ label: x.l.slice(0, 40), kind: (x.k in KIND_LABEL ? x.k : "other") as VisaKind, start: x.s && DATE_RE.test(x.s) ? x.s : undefined, expiry: x.e }));
    savePlan({ visas, childBirth: raw.c && DATE_RE.test(raw.c) ? raw.c : undefined });
    history.replaceState(null, "", location.pathname + location.search);
    return visas.length > 0;
  } catch {
    return false;
  }
}

// ── 날짜 계산 ───────────────────────────────────────────────
function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function today(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
export function daysUntil(s: string): number {
  return Math.round((parseDate(s).getTime() - today().getTime()) / 86400000);
}
function addMonths(s: string, n: number): string {
  const d = parseDate(s);
  const t = new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function addYears(s: string, n: number): string {
  return addMonths(s, n * 12);
}
function fmt(s: string): string {
  return parseDate(s).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}
function dLabel(n: number): string {
  return n > 0 ? `D-${n}` : n === 0 ? "D-Day" : `D+${-n}`;
}
function urgency(n: number): string {
  return n < 0 ? "past" : n <= 60 ? "urgent" : n <= 180 ? "soon" : "ok";
}

export interface Milestone {
  date: string;
  title: string;
  note?: string;
  link?: string;
}

/** 비자 종류별로 챙겨야 할 날짜. 근거는 INZ 비자 승인서·PSWV 안내 문구. */
export function milestones(p: VisaPlan): Milestone[] {
  const out: Milestone[] = [];
  // 같은 날 만료되는 비자(예: 본인·배우자·자녀)는 한 줄로 묶는다
  const byExpiry = new Map<string, VisaEntry[]>();
  for (const v of p.visas) byExpiry.set(v.expiry, [...(byExpiry.get(v.expiry) ?? []), v]);
  for (const [expiry, group] of byExpiry) {
    const names = group.map((v) => v.label).join(" · ");
    out.push({ date: expiry, title: `비자 만료: ${names}`, note: "만료 전에 다음 비자를 신청해야 합법 체류가 이어집니다.", link: INZ.expired });
    out.push({
      date: addMonths(expiry, -1),
      title: `다음 비자 신청 권장일: ${names}`,
      note: "INZ 승인서: 다음 비자는 현재 비자 만료 최소 1개월 전에 신청하라고 안내합니다.",
      link: INZ.expired,
    });
    if (group.some((v) => v.kind === "student")) {
      out.push({
        date: addMonths(expiry, -3),
        title: "졸업 후 취업비자(PSWV) 준비 시작",
        note: "학위 완료 확인서, 생활비 NZD 5,000 이상 증빙 등. 만료 후 신청 기한은 학업에 따라 3·6·12개월이지만 만료 전 신청이 안전합니다.",
        link: INZ.pswv,
      });
    }
    const family = group.filter((v) => v.kind === "visitor");
    if (family.length) {
      out.push({
        date: addMonths(expiry, -2),
        title: `가족 비자 준비: ${family.map((v) => v.label).join(" · ")}`,
        note: "가족 동반 비자는 본인 비자에 연동됩니다. 본인 다음 비자를 신청할 때 가족 비자 조건도 함께 확인하세요.",
        link: INZ.partner,
      });
    }
  }
  if (p.childBirth) {
    const five = addYears(p.childBirth, 5);
    out.push({ date: addMonths(five, -6), title: "자녀 초등학교 등록·학군(zone) 확인 시작", note: "입학 6개월 전쯤 학교 학군과 등록 절차를 확인하세요.", link: INZ.school });
    out.push({ date: five, title: "자녀 만 5세 — 초등학교 입학 가능", note: "뉴질랜드는 만 5세부터 입학할 수 있고 만 6세부터 의무교육입니다.", link: INZ.school });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 화면 ────────────────────────────────────────────────────
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

/** 헤더에 넣을 가장 가까운 만료 D-day 한 줄 */
export function headerPill(h: H): HTMLElement | null {
  const p = loadPlan();
  const upcoming = p.visas.filter((v) => daysUntil(v.expiry) >= 0).sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (!upcoming.length) return null;
  const v = upcoming[0];
  const n = daysUntil(v.expiry);
  return h("span", { class: `pill visa-pill ${urgency(n)}`, title: `${v.label} 만료 ${fmt(v.expiry)}` }, "📅 ", h("strong", {}, `${v.label} ${dLabel(n)}`));
}

/** 이민 레이더 탭 상단 카드 */
export function visaCard(h: H, openSettings: () => void): HTMLElement {
  const p = loadPlan();
  const wrap = h("section", { class: "visa-card", "aria-labelledby": "visa-title" });
  const head = h("div", { class: "visa-head" }, h("h2", { id: "visa-title" }, "📅 내 비자 일정"));
  const edit = h("button", { class: "link-btn", type: "button" }, p.visas.length ? "수정" : "입력하기");
  edit.addEventListener("click", openSettings);
  head.append(edit);
  wrap.append(head);
  if (!p.visas.length) {
    wrap.append(h("p", { class: "muted" }, "설정에서 비자 만료일을 입력하면 D-day와 준비 일정을 보여드려요. 정보는 이 기기에만 저장됩니다."));
    return wrap;
  }
  const list = h("ul", { class: "visa-list" });
  for (const v of [...p.visas].sort((a, b) => a.expiry.localeCompare(b.expiry))) {
    const n = daysUntil(v.expiry);
    list.append(h("li", { class: `visa-row ${urgency(n)}` },
      h("span", { class: "visa-label" }, v.label, h("small", {}, ` · ${KIND_LABEL[v.kind]}`)),
      h("span", { class: "visa-date" }, `${fmt(v.expiry)} 만료`),
      h("span", { class: "visa-d" }, dLabel(n))));
  }
  wrap.append(list);
  const next = milestones(p).filter((m) => daysUntil(m.date) >= 0).slice(0, 5);
  if (next.length) {
    wrap.append(h("h3", { class: "visa-sub" }, "다가오는 할 일"));
    wrap.append(h("ol", { class: "visa-steps" }, ...next.map((m) => {
      const n = daysUntil(m.date);
      const li = h("li", { class: urgency(n) },
        h("div", { class: "step-top" }, h("strong", {}, m.title), h("span", { class: "visa-d" }, dLabel(n))),
        h("div", { class: "step-date" }, fmt(m.date)));
      if (m.note) li.append(h("p", { class: "step-note" }, m.note));
      if (m.link) li.append(h("a", { href: m.link, target: "_blank", rel: "noopener noreferrer" }, "공식 안내 ↗"));
      return li;
    })));
  }
  wrap.append(h("p", { class: "board-note visa-note" }, "날짜 계산은 참고용이에요. 실제 신청 조건과 기한은 INZ 공식 안내와 본인 비자 승인서를 기준으로 확인하세요."));
  return wrap;
}

/** 설정 대화상자 안의 편집기 */
export function renderEditor(h: H, root: HTMLElement, onChange: () => void): void {
  const p = loadPlan();
  root.replaceChildren();
  const rows = h("div", { class: "visa-edit-rows" });
  const kindSelect = (val: VisaKind) => {
    const s = h("select", { "aria-label": "비자 종류" });
    for (const [k, label] of Object.entries(KIND_LABEL)) {
      const o = h("option", { value: k }, label);
      if (k === val) o.selected = true;
      s.append(o);
    }
    return s;
  };
  const addRow = (v?: VisaEntry) => {
    const row = h("div", { class: "visa-edit-row" });
    const label = h("input", { type: "text", placeholder: "예: 본인 학생비자", "aria-label": "이름", maxlength: "40" });
    label.value = v?.label ?? "";
    const kind = kindSelect(v?.kind ?? "student");
    const exp = h("input", { type: "date", "aria-label": "만료일" });
    exp.value = v?.expiry ?? "";
    const del = h("button", { type: "button", class: "link-btn", "aria-label": "삭제" }, "삭제");
    del.addEventListener("click", () => {
      row.remove();
      save();
    });
    for (const el of [label, kind, exp]) el.addEventListener("change", save);
    row.append(label, kind, exp, del);
    rows.append(row);
  };
  const child = h("input", { type: "date", "aria-label": "자녀 생년월일 (선택)" });
  child.value = p.childBirth ?? "";
  child.addEventListener("change", save);
  function save() {
    const visas: VisaEntry[] = [];
    rows.querySelectorAll<HTMLDivElement>(".visa-edit-row").forEach((r) => {
      const [label, kind, exp] = r.querySelectorAll<HTMLInputElement & HTMLSelectElement>("input, select");
      if (label.value.trim() && DATE_RE.test(exp.value)) visas.push({ label: label.value.trim(), kind: kind.value as VisaKind, expiry: exp.value });
    });
    savePlan({ visas, childBirth: DATE_RE.test(child.value) ? child.value : undefined });
    onChange();
  }
  p.visas.forEach((v) => addRow(v));
  if (!p.visas.length) addRow();
  const add = h("button", { type: "button", class: "link-btn" }, "+ 비자 추가");
  add.addEventListener("click", () => addRow());
  root.append(
    rows,
    add,
    h("label", { class: "visa-child" }, h("span", {}, "자녀 생년월일 (선택, 초등학교 입학 시기 계산)"), child),
    h("small", { class: "muted" }, "이 정보는 이 기기에만 저장되고 서버로 보내지 않습니다."),
  );
}
