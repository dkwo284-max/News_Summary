// 🌐 세계 군사 긴장도 — 홈 요약 카드 + '안보' 탭 (data/tension.json + tension-detail.json, GDELT 뉴스 기반 · 화면은 AI 없음)
//  점수만이 아니라 '왜 그렇게 움직였나'를 클릭으로 파고들 수 있다:
//  · 추이 그래프·히트맵 칸 → 그날의 주요 사건·기사   · 지역 → 상세 패널(유형·맞선 쪽·기사·한국/뉴질랜드 영향·우리 브리핑 기사)
//  · 급변 알림(+점수가 오른 이유 한 줄)   · 사건 유형 필터(무력 시위 / 공격·교전 / 대량 피해)   · 대표 기사 한국어 제목(하루 1회 AI)
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

export interface Art { title: string; title_ko?: string; url: string; domain: string; date: string; n?: number; type?: string }
export interface Hotspot {
  id: string; name: string; lat: number; lon: number; base: number; score: number; level: string;
  pct7: number | null; chg7: number | null; stale?: boolean;
  series: { d: string; v: number; s: number | null }[];
  articles: Art[];
  mix?: number[]; pairs?: { a: string; b: string; share: number }[]; why?: string; delta7?: number | null; situation_ko?: string;
}
export interface Exposure { name: string; score: number; level: string; drivers: { id: string; w: number; contrib: number; why: string }[] }
export interface Alert { id: string; name: string; delta7: number; score: number; level: string; text: string }
export interface Tension {
  updated: string; data_through?: string; source: string; stale?: boolean; last_try?: string;
  world: { score: number; level: string; series: { d: string; s: number }[] };
  hotspots: Hotspot[];
  exposure: { kr: Exposure; nz: Exposure };
  alerts?: Alert[];
}
interface PresetData { world: Tension["world"]; exposure: Tension["exposure"]; hotspots: { id: string; score: number; level: string; pct7: number | null; chg7: number | null; series: { d: string; s: number | null }[] }[] }
export interface Detail {
  v: number; data_through: string; type_names: string[];
  days: Record<string, Record<string, { k: number[]; p: [string, string, number][]; a: [number, string, string, number][] }>>;
  presets: Record<string, PresetData>;
}
export interface BriefItem { label: string; title: string; text: string; url: string }

const LV = [
  { min: 80, name: "매우 높음", color: "#7f1d1d", desc: "여러 곳에서 실제 충돌이 커지거나 새 전선이 생기는 수준" },
  { min: 65, name: "높음", color: "#dc2626", desc: "무력 충돌·위협 보도가 평소보다 크게 늘어난 상태" },
  { min: 50, name: "경계", color: "#ea580c", desc: "진행 중인 전쟁에 더해 다른 지역 긴장도 높아진 상태" },
  { min: 30, name: "주의", color: "#ca8a04", desc: "분쟁이 있지만 평소 흐름 안에 있는 상태" },
  { min: 0, name: "낮음", color: "#16a34a", desc: "군사 충돌 보도가 평소보다 적은 상태" },
];
const lv = (s: number) => LV.find((x) => s >= x.min)!;
const SHORT: Record<string, string> = { korea: "한반도", taiwan: "대만", scs: "남중국해", ukraine: "우크라이나", mideast: "중동", southasia: "인도·파키", pacific: "남태평양" };
const short = (hs: { id: string; name: string }) => SHORT[hs.id] ?? hs.name;
const TYPE_COLORS = ["#ca8a04", "#ea580c", "#dc2626", "#7f1d1d"];
const PRESETS: { id: string; label: string; hint: string }[] = [
  { id: "all", label: "전체", hint: "무력 시위·공격·교전·대량 피해 모두" },
  { id: "show", label: "무력 시위", hint: "군함·전투기 배치, 훈련 같은 힘 과시" },
  { id: "fight", label: "공격·교전", hint: "폭격·포격·실제 전투" },
  { id: "mass", label: "대량 피해", hint: "민간인 대량 피해·학살 같은 가장 심각한 사건" },
];
const REGION_KW: Record<string, RegExp> = {
  korea: /북한|한반도|김정은|평양|핵실험|North Korea|DPRK/i,
  taiwan: /대만|타이완|양안|Taiwan|TSMC/i,
  scs: /남중국해|스프래틀리|스카버러|South China Sea|Spratly/i,
  ukraine: /우크라이나|러시아|젤렌스키|푸틴|Ukraine|Russia/i,
  mideast: /중동|이란|이스라엘|가자|하마스|헤즈볼라|후티|홍해|호르무즈|Iran|Israel|Gaza|Houthi|Hormuz/i,
  southasia: /카슈미르|파키스탄|Pakistan|Kashmir/i,
  pacific: /솔로몬|바누아투|피지|통가|태평양 도서|남태평양|Solomon Islands|Vanuatu|Fiji|Tonga|Pacific Islands/i,
};
const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const ext = (h: H, url: string, text: string) => h("a", { href: safe(url), target: "_blank", rel: "noopener noreferrer" }, text);
const svgEl = (html: string, cls: string, label: string) => {
  const d = document.createElement("div"); d.className = cls; d.setAttribute("role", "img"); d.setAttribute("aria-label", label); d.innerHTML = html; return d;
};
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

let cache: Promise<Tension | null> | null = null;
export function loadTension(): Promise<Tension | null> {
  cache ??= fetch("./data/tension.json", { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<Tension>) : null)).catch(() => null);
  return cache;
}
let dcache: Promise<Detail | null> | null = null;
function loadDetail(): Promise<Detail | null> {
  dcache ??= fetch("./data/tension-detail.json", { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<Detail>) : null)).catch(() => null);
  return dcache;
}
/** 홈 카드에서 지역을 눌러 안보 탭으로 넘어올 때 그 지역을 바로 펼치기 위한 전달값 */
let pending: string | null = null;
export function setPendingRegion(id: string | null): void { pending = id; }
const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : x);
/** 급변 알림 설명: '무슨 일이 몇 % 늘었다' 한 줄 + 가장 크게 보도된 소식(한국어 제목이 있으면 그것) */
function alertLines(t: Tension, a: Alert): { main: string; news: string } {
  const main = a.text.split(". 가장 크게 보도된")[0].replace(/, 가장 많이 등장한 쪽은.*$/, "");
  const art = t.hotspots.find((x) => x.id === a.id)?.articles[0];
  return { main, news: art ? clip(art.title_ko ?? art.title, 80) : "" };
}

/** 반원 게이지: 5단계 색 띠 + 바늘 + 가운데 점수 */
function gauge(score: number, size = 180): string {
  const r = 70, cx = 90, cy = 86, arc = (a0: number, a1: number) => {
    const p = (a: number) => [cx + r * Math.cos(Math.PI * (1 - a / 100)), cy - r * Math.sin(Math.PI * (1 - a / 100))];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const bands = [...LV].reverse().map((b, i, arr) => `<path d="${arc(b.min, i < arr.length - 1 ? arr[i + 1].min : 100)}" stroke="${b.color}" stroke-width="14" fill="none" opacity=".9"/>`).join("");
  const a = Math.PI * (1 - Math.max(0, Math.min(100, score)) / 100), nx = cx + (r - 16) * Math.cos(a), ny = cy - (r - 16) * Math.sin(a);
  return `<svg viewBox="0 0 180 118" width="${size}" height="${size * 0.66}">${bands}
    <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="currentColor"/>
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="24" font-weight="800" fill="currentColor">${Math.round(score)}</text></svg>`;
}

/** 눌러서 날짜를 고르는 추이 그래프: 세로로 얇은 투명 칸이 날마다 깔려 있고, 고른 날은 세로선으로 표시. 아래에 ◀▶ 버튼 */
function dayChart(h: H, vals: { d: string; s: number }[], sel: string | null, onPick: (d: string) => void, hh = 150): HTMLElement {
  const box = h("div", { class: "tz-dc" });
  if (vals.length < 2) return box;
  const w = 640, pad = { l: 26, r: 8, t: 8, b: 20 }, iw = w - pad.l - pad.r, ih = hh - pad.t - pad.b, n = vals.length;
  const x = (i: number) => pad.l + (i / (n - 1)) * iw, y = (s: number) => pad.t + ih - (Math.max(0, Math.min(100, s)) / 100) * ih;
  const bands = [...LV].reverse().map((b, i, arr) => { const top = i < arr.length - 1 ? arr[i + 1].min : 100;
    return `<rect x="${pad.l}" y="${y(top)}" width="${iw}" height="${y(b.min) - y(top)}" fill="${b.color}" opacity=".09"/>`; }).join("");
  const pts = vals.map((p, i) => `${x(i).toFixed(1)},${y(p.s).toFixed(1)}`).join(" ");
  const ticks = [0, Math.floor(n / 2), n - 1].map((i) => `<text x="${x(i)}" y="${hh - 4}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" font-size="10" fill="currentColor" opacity=".6">${md(vals[i].d)}</text>`).join("");
  const yl = [30, 50, 65, 80].map((s) => `<text x="${pad.l - 4}" y="${y(s) + 3}" text-anchor="end" font-size="9" fill="currentColor" opacity=".5">${s}</text>`).join("");
  const si = sel ? vals.findIndex((p) => p.d === sel) : -1, cur = si >= 0 ? si : n - 1, cp = vals[cur];
  const cw = iw / (n - 1);
  const hits = vals.map((p, i) => `<rect data-d="${p.d}" x="${(x(i) - cw / 2).toFixed(1)}" y="${pad.t}" width="${cw.toFixed(1)}" height="${ih}" fill="transparent" style="cursor:pointer"><title>${md(p.d)} · ${Math.round(p.s)}점</title></rect>`).join("");
  box.innerHTML = `<svg viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" style="width:100%;height:${hh}px;touch-action:manipulation">${bands}${yl}
    ${si >= 0 ? `<line x1="${x(si)}" x2="${x(si)}" y1="${pad.t}" y2="${pad.t + ih}" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" opacity=".7"/>` : ""}
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(cur)}" cy="${y(cp.s)}" r="${si >= 0 ? 5.5 : 4}" fill="${lv(cp.s).color}" stroke="var(--surface)" stroke-width="2"/>${ticks}${hits}</svg>
    <div class="tz-dc-nav"><button type="button" data-step="-1" aria-label="하루 전">◀</button><span>${si >= 0 ? `${md(cp.d)} · ${Math.round(cp.s)}점` : "그래프를 눌러 날짜를 고르세요"}</span><button type="button" data-step="1" aria-label="다음 날">▶</button></div>`;
  box.addEventListener("click", (e) => {
    const t = e.target as Element, hit = t.closest("[data-d]"), st = t.closest("[data-step]");
    if (hit) onPick((hit as HTMLElement).dataset.d!);
    else if (st) { const i = Math.max(0, Math.min(n - 1, (si >= 0 ? si : n - 1) + +(st as HTMLElement).dataset.step!)); onPick(vals[i].d); }
  });
  return box;
}

const delta = (series: { s: number }[], days = 7) => (series.length > days ? series[series.length - 1].s - series[series.length - 1 - days].s : null);
const arrow = (d: number | null | undefined) => (d == null ? "" : d >= 3 ? `▲${Math.round(d)}` : d <= -3 ? `▼${Math.round(-d)}` : "＝");
const dcls = (d: number | null | undefined) => (d != null && d >= 3 ? "up" : d != null && d <= -3 ? "down" : "muted");
const badge = (h: H, level: string) => h("span", { class: "tz-badge", style: `--c:${LV.find((x) => x.name === level)?.color ?? "#888"}` }, level);
function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}

// ── 홈 요약 카드 ──
export function tensionHomeCard(h: H, t: Tension, goTab: (id: string) => void): HTMLElement {
  const w = t.world, d = delta(w.series), top = t.hotspots.slice(0, 3), L = lv(w.score), al = (t.alerts ?? []).slice(0, 2);
  const go = (id: string | null) => { setPendingRegion(id); goTab("world"); };
  const card = h("section", { class: "home-card tz-home", "aria-labelledby": "hm-tz" },
    h("h2", { id: "hm-tz" }, "🌐 세계 군사 긴장도"),
    h("div", { class: "tz-home-row" },
      svgEl(gauge(w.score, 150), "tz-gauge", `세계 군사 긴장도 ${Math.round(w.score)}점, ${L.name}`),
      h("div", { class: "tz-home-txt" },
        h("p", {}, badge(h, L.name), d != null ? h("small", { class: dcls(d) }, ` 지난주보다 ${arrow(d)}`) : null),
        h("p", { class: "tz-exp-mini" }, `🇰🇷 한국 `, badge(h, t.exposure.kr.level), `  🇳🇿 뉴질랜드 `, badge(h, t.exposure.nz.level)),
        h("p", { class: "tz-hot" }, "뜨거운 곳 ", ...top.map((x) => h("span", { class: "tz-hot-i" }, h("i", { class: "tz-dot", style: `background:${lv(x.score).color}` }), `${short(x)} `, h("b", {}, String(Math.round(x.score)))))))),
    ...al.map((a) => { const l = alertLines(t, a); const b = h("button", { type: "button", class: "tz-alert" }, h("b", { class: a.delta7 > 0 ? "up" : "down" }, `${a.delta7 > 0 ? "▲" : "▼"}${Math.round(Math.abs(a.delta7))}`), ` ${a.name} `,
      h("span", { class: "muted" }, l.main + " ›"), l.news ? h("span", { class: "tz-alert-news" }, `📰 ${l.news}`) : null); b.addEventListener("click", () => go(a.id)); return b; }),
    h("button", { type: "button", class: "tz-more" }, "지도·원인·대비 체크리스트 보기 ›"));
  card.querySelector(".tz-more")!.addEventListener("click", () => go(null));
  return card;
}

// ── 대비 체크리스트 (단계가 오를수록 항목이 늘어남) ──
type Prep = { id: string; min: number; text: string; link?: [string, string] };
const PREP: Record<"nz" | "kr", { title: string; items: Prep[]; links: [string, string][] }> = {
  nz: {
    title: "🇳🇿 우리 집 (오클랜드)",
    items: [
      { id: "nz-contact", min: 0, text: "가족 비상 연락 방법 정하기 — 전화가 안 될 때 문자·카카오톡, 모일 장소", link: ["https://getready.govt.nz/prepared/household/make-a-plan/", "가정 비상 계획 ↗"] },
      { id: "nz-kit", min: 30, text: "비상용품 3일치: 1인당 물 9L, 통조림, 라디오·손전등·건전지, 구급약", link: ["https://getready.govt.nz/prepared/household/emergency-supplies/", "준비물 목록 ↗"] },
      { id: "nz-docs", min: 30, text: "여권·비자·보험 서류 사진을 클라우드에 보관" },
      { id: "nz-fuel", min: 50, text: "자동차 연료 반 이상 유지 — 중동·해상로 위기 땐 기름값이 먼저 오름" },
      { id: "nz-meds", min: 50, text: "처방약 2주치 확보" },
      { id: "nz-fx", min: 50, text: "NZD↔KRW 큰 송금은 나눠서 — 위기 땐 환율이 크게 흔들림" },
      { id: "nz-travel", min: 65, text: "해외여행 전 SafeTravel 등록·여행경보 확인", link: ["https://www.safetravel.govt.nz/", "SafeTravel ↗"] },
      { id: "nz-cyber", min: 65, text: "휴대폰·이메일 2단계 인증, 공유기 비밀번호 점검 — 위기 땐 사이버 공격이 늘어남" },
      { id: "nz-budget", min: 65, text: "생활비 예산에 기름값·식료품 상승분 미리 반영" },
      { id: "nz-cash", min: 80, text: "현금(NZD) 조금 집에 보관 — 카드 결제 장애 대비" },
      { id: "nz-alerts", min: 80, text: "민방위(Civil Defence)·경찰 공지와 휴대폰 긴급 알림 확인", link: ["https://www.civildefence.govt.nz/", "Civil Defence ↗"] },
    ],
    links: [["https://getready.govt.nz/", "Get Ready (뉴질랜드 재난 대비)"], ["https://www.safetravel.govt.nz/", "SafeTravel (여행경보)"]],
  },
  kr: {
    title: "🇰🇷 한국 가족·한국 방문",
    items: [
      { id: "kr-contact", min: 0, text: "한국 가족과 비상 시 연락 순서·방법 정하기 (카카오톡이 안 될 때 대안 포함)" },
      { id: "kr-shelter", min: 30, text: "한국 가족 집 근처 대피소 위치 같이 확인 (안전디딤돌 앱)", link: ["https://www.safekorea.go.kr/", "국민재난안전포털 ↗"] },
      { id: "kr-register", min: 30, text: "재외국민 등록이 돼 있는지 확인", link: ["https://consul.mofa.go.kr/", "영사민원24 ↗"] },
      { id: "kr-passport", min: 50, text: "가족 모두 여권 유효기간 6개월 이상인지 확인" },
      { id: "kr-insure", min: 50, text: "한국 방문 예정이면 여행자 보험의 전쟁·테러 면책 조항 확인" },
      { id: "kr-visit", min: 65, text: "한국 방문 일정 재검토 · 외교부 해외안전여행 공지 확인", link: ["https://www.0404.go.kr/", "해외안전여행 ↗"] },
      { id: "kr-bank", min: 65, text: "한국 계좌·연금에 뉴질랜드에서 접근할 수 있는지 점검 (인증서·OTP)" },
      { id: "kr-embassy", min: 80, text: "주뉴질랜드 대한민국 대사관 비상 연락처 저장", link: ["https://overseas.mofa.go.kr/nz-ko/index.do", "대사관 ↗"] },
      { id: "kr-family", min: 80, text: "한국 가족이 뉴질랜드로 올 경우 대비 (방문 비자·머물 곳)", link: ["https://www.immigration.govt.nz/visas/visitor-visa/", "방문 비자 ↗"] },
    ],
    links: [["https://www.0404.go.kr/", "외교부 해외안전여행"], ["https://www.safekorea.go.kr/", "국민재난안전포털"]],
  },
};
const PREP_KEY = "daily-brief:prep";
function loadChecks(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(PREP_KEY) || "{}"); } catch { return {}; } }
function saveChecks(c: Record<string, boolean>) { try { localStorage.setItem(PREP_KEY, JSON.stringify(c)); } catch { /* 무시 */ } }

function prepCard(h: H, t: Tension): HTMLElement {
  let side: "nz" | "kr" = "nz";
  const checks = loadChecks();
  const body = h("div", {});
  const seg = h("div", { class: "chips", role: "tablist" });
  const draw = () => {
    const P = PREP[side], s = t.exposure[side].score, L = lv(s);
    const now = P.items.filter((x) => s >= x.min), later = P.items.filter((x) => s < x.min);
    const done = now.filter((x) => checks[x.id]).length;
    seg.replaceChildren(...(["nz", "kr"] as const).map((k) => { const b = h("button", { type: "button", class: "chip", role: "tab", "aria-pressed": String(side === k) }, PREP[k].title);
      b.addEventListener("click", () => { side = k; draw(); }); return b; }));
    const row = (x: Prep, off = false) => {
      const cb = h("input", { type: "checkbox", id: `prep-${x.id}` }) as HTMLInputElement;
      cb.checked = !!checks[x.id]; cb.disabled = off;
      cb.addEventListener("change", () => { checks[x.id] = cb.checked; saveChecks(checks); draw(); });
      return h("li", { class: off ? "tz-later" : checks[x.id] ? "tz-done" : "" }, cb, h("label", { for: `prep-${x.id}` }, x.text), x.link ? h("span", {}, " ", ext(h, x.link[0], x.link[1])) : null,
        off ? h("small", { class: "muted" }, ` (${lv(x.min).name} 단계부터)`) : null);
    };
    body.replaceChildren(
      h("p", {}, `${t.exposure[side].name} 노출도 `, badge(h, L.name), h("span", { class: "muted" }, ` 기준 지금 해 둘 것 ${now.length}개 · `), h("strong", {}, `${done}/${now.length} 완료`)),
      h("div", { class: "tz-prog" }, h("i", { style: `width:${now.length ? (done / now.length) * 100 : 0}%` })),
      h("ul", { class: "tz-check" }, ...now.map((x) => row(x))),
      ...(later.length ? [h("details", {}, h("summary", {}, `단계가 오르면 할 일 ${later.length}개`), h("ul", { class: "tz-check" }, ...later.map((x) => row(x, true))))] : []),
      h("p", { class: "board-note" }, "공식 안내: ", ...P.links.flatMap(([u, l], i) => [i ? " · " : "", ext(h, u, l)]), " · 체크 표시는 이 기기에만 저장돼요."));
  };
  draw();
  return h("section", { class: "home-card", "aria-labelledby": "tz-prep" }, h("h2", { id: "tz-prep" }, "✅ 대비 체크리스트"), seg, body);
}


// ── 안보 탭 전체 ──
export function worldView(h: H, t: Tension, brief: BriefItem[] = []): HTMLElement {
  const root = h("div", { class: "tz-view" });
  let detail: Detail | null = null;
  let preset = "all", side: "kr" | "nz" = "nz";
  let region: string | null = pending; pending = null;
  let wDay: string | null = null, rDay: string | null = null;
  const koByUrl = new Map<string, string>();
  for (const x of t.hotspots) for (const a of x.articles) if (a.title_ko) koByUrl.set(a.url, a.title_ko);

  // 지금 선택한 유형 필터에 맞는 점수 묶음 (전체 = tension.json, 그 밖에는 detail.presets)
  const view = () => {
    const p = preset !== "all" ? detail?.presets[preset] : null;
    if (!p) return { world: t.world, exposure: t.exposure, hotspots: t.hotspots as Hotspot[] };
    const hs = t.hotspots.map((x) => { const q = p.hotspots.find((y) => y.id === x.id); return q ? { ...x, ...q, series: q.series.map((s) => ({ d: s.d, v: 0, s: s.s })), articles: articlesFor(x.id, preset), delta7: null, why: undefined } as Hotspot : x; });
    return { world: p.world, exposure: p.exposure, hotspots: hs.sort((a, b) => b.score - a.score) };
  };
  const typeIdx = (pr: string) => (pr === "show" ? [0] : pr === "fight" ? [1, 2] : pr === "mass" ? [3] : [0, 1, 2, 3]);
  function articlesFor(rid: string, pr: string): Art[] {
    if (!detail) return [];
    const ts = typeIdx(pr), dm = detail.days[rid] ?? {}, out: Art[] = [], seen = new Set<string>();
    for (const d of Object.keys(dm).sort().reverse().slice(0, 4)) for (const [n, title, url, ti] of dm[d].a) if (ts.includes(ti) && !seen.has(title.toLowerCase())) { seen.add(title.toLowerCase()); out.push({ title, url, domain: new URL(url).hostname.replace(/^www\./, ""), date: d, n, type: detail.type_names[ti] }); }
    return out.sort((a, b) => (b.n ?? 0) - (a.n ?? 0)).slice(0, 4);
  }
  const artLine = (a: Art | { title: string; url: string; date: string; n?: number; type?: string; title_ko?: string; domain?: string }) => {
    const ko = a.title_ko ?? koByUrl.get(a.url);
    return h("li", {}, ext(h, a.url, ko ?? a.title), ko ? h("small", { class: "muted tz-en" }, ` ${a.title}`) : null,
      h("small", { class: "muted" }, ` · ${a.type ? a.type + " · " : ""}${a.n ? `기사 ${a.n}건 · ` : ""}${md(a.date)}`));
  };
  const ranges = (p: string) => PRESETS.find((x) => x.id === p)?.hint ?? "";

  // 한국어 해설 한 줄: 규칙 기반 '왜' 문장 + (있으면) AI 한국어 상황 요약
  const reasonBox = (x: Hotspot) => h("div", { class: "tz-why" },
    x.situation_ko ? h("p", {}, h("strong", {}, "지금 상황 "), x.situation_ko, h("small", { class: "muted" }, " (대표 기사 기준 AI 요약)")) : null,
    x.why ? h("p", {}, h("strong", {}, "왜 이렇게? "), x.why) : null);

  // ── 세계 일별 패널: 그날 평소보다 유난히 많았던 지역과 그 대표 기사 ──
  function worldDayPanel(v: ReturnType<typeof view>): HTMLElement | null {
    if (!wDay) return null;
    const i = v.world.series.findIndex((p) => p.d === wDay);
    if (i < 0) return null;
    const s = v.world.series[i].s, prev = i > 0 ? v.world.series[i - 1].s : null;
    const box = h("div", { class: "tz-daybox" }, h("p", {}, h("strong", {}, `${md(wDay)} 세계 긴장 ${Math.round(s)}점`), prev != null ? h("small", { class: dcls(s - prev) }, ` 전날보다 ${arrow(s - prev) || "＝"}`) : null));
    if (!detail) { box.append(h("p", { class: "muted" }, "그날의 기사를 불러오는 중…")); return box; }
    const rows = v.hotspots.map((x) => {
      const dm = detail!.days[x.id] ?? {}, ks = ts(preset);
      const val = (d: string) => (dm[d] ? ks.reduce((a, t2) => a + dm[d].k[t2], 0) : 0);
      const all = Object.keys(dm), mean = all.reduce((a, d) => a + val(d), 0) / Math.max(1, all.length);
      return { x, ratio: mean > 0 ? val(wDay!) / mean : 0, rec: dm[wDay!] };
    }).filter((r) => r.rec && r.ratio >= 1.15).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
    if (!rows.length) box.append(h("p", { class: "muted" }, "이 날은 평소보다 유난히 많았던 지역이 없는 조용한 날이에요. 지역 이름을 눌러 그날의 기록을 직접 볼 수 있어요."));
    for (const r of rows) {
      const a = r.rec.a[0];
      box.append(h("div", { class: "tz-dayrow" }, h("button", { type: "button", class: "tz-link", "data-r": r.x.id }, `${r.x.name}`), h("span", { class: "up" }, ` 평소의 ${r.ratio.toFixed(1)}배`),
        a ? h("div", { class: "tz-dayart" }, ext(h, a[2], koByUrl.get(a[2]) ?? a[1]), h("small", { class: "muted" }, ` 기사 ${a[0]}건`)) : null));
    }
    return box;
  }
  const ts = (p: string) => typeIdx(p);

  // ── 지역 상세 패널 ──
  function regionCard(v: ReturnType<typeof view>): HTMLElement | null {
    const x = v.hotspots.find((y) => y.id === region);
    if (!x) return null;
    const ss = x.series.filter((p) => p.s != null) as { d: string; s: number }[];
    const d7 = x.delta7 ?? delta(ss);
    const card = h("section", { class: "home-card tz-region", id: "tz-region", "aria-labelledby": "tz-rg" },
      h("div", { class: "tz-rg-head" }, h("h2", { id: "tz-rg" }, `📍 ${x.name}`), badge(h, x.level), h("b", { class: "tz-exp-score" }, String(Math.round(x.score))), h("small", { class: dcls(d7) }, ` ${arrow(d7)}`),
        h("button", { type: "button", class: "tz-x", "aria-label": "상세 닫기" }, "✕")),
      reasonBox(x));
    card.querySelector(".tz-x")!.addEventListener("click", () => { region = null; rDay = null; render(); });
    card.append(h("p", { class: "muted" }, `기본 긴장도 ${x.base} · 최근 7일 군사 사건 3개월 중 상위 ${x.pct7 != null ? 100 - x.pct7 : "–"}% · 직전 3주 대비 ${x.chg7 != null ? (x.chg7 >= 0 ? "+" : "") + x.chg7 + "%" : "–"} · 필터: ${PRESETS.find((p) => p.id === preset)!.label}`));
    card.append(h("h3", {}, "점수 추이 — 날짜를 눌러 그날의 일 보기"), dayChart(h, ss, rDay, (d) => { rDay = d; render(true); }, 120));
    if (rDay && detail) {
      const rec = detail.days[x.id]?.[rDay], i = ss.findIndex((p) => p.d === rDay);
      const box = h("div", { class: "tz-daybox" }, h("p", {}, h("strong", {}, `${md(rDay)}`), i >= 0 ? ` ${Math.round(ss[i].s)}점` : "", i > 0 ? h("small", { class: dcls(ss[i].s - ss[i - 1].s) }, ` 전날보다 ${arrow(ss[i].s - ss[i - 1].s) || "＝"}`) : null));
      if (rec) {
        const tot = rec.k.reduce((a, b) => a + b, 0) || 1;
        box.append(h("div", { class: "tz-mixbar", title: "그날 사건 유형" }, ...rec.k.map((k, ti) => (k > 0 ? h("i", { style: `flex:${k};background:${TYPE_COLORS[ti]}`, title: `${detail!.type_names[ti]} ${Math.round((100 * k) / tot)}%` }) : null))),
          h("p", { class: "muted tz-legend" }, ...rec.k.flatMap((k, ti) => (k > 0 ? [h("span", {}, h("i", { class: "tz-dot", style: `background:${TYPE_COLORS[ti]}` }), `${detail!.type_names[ti]} ${Math.round((100 * k) / tot)}% `)] : []))));
        if (rec.p.length) box.append(h("p", { class: "muted" }, "그날 등장한 쪽: ", rec.p.map(([a, b]) => (b ? `${a}→${b}` : a)).join(" · ")));
        box.append(rec.a.length ? h("ul", { class: "tz-arts" }, ...rec.a.map(([n, title, url, ti]) => artLine({ title, url, date: rDay!, n, type: detail!.type_names[ti] }))) : h("p", { class: "muted" }, "이 날 대표 기사는 남아 있지 않아요."));
      } else box.append(h("p", { class: "muted" }, "이 날은 기록이 없어요."));
      card.append(box);
    } else if (rDay) card.append(h("p", { class: "muted" }, "그날의 기사를 불러오는 중…"));
    if (x.mix && x.mix.some((m) => m > 0)) card.append(h("h3", {}, "최근 7일 사건 유형"), h("div", { class: "tz-mixbar" }, ...x.mix.map((m, ti) => (m > 0 ? h("i", { style: `flex:${m};background:${TYPE_COLORS[ti]}`, title: `${(detail?.type_names ?? ["무력 시위", "공격", "교전", "대량 피해"])[ti]} ${m}%` }) : null))),
      h("p", { class: "muted tz-legend" }, ...x.mix.flatMap((m, ti) => (m > 0 ? [h("span", {}, h("i", { class: "tz-dot", style: `background:${TYPE_COLORS[ti]}` }), `${(detail?.type_names ?? ["무력 시위", "공격", "교전", "대량 피해"])[ti]} ${m}% `)] : []))));
    if (x.pairs?.length) card.append(h("h3", {}, "자주 맞선 쪽 (최근 2주)"), h("ul", { class: "tz-pairs" }, ...x.pairs.map((p) => h("li", {}, h("b", {}, p.b ? `${p.a} → ${p.b}` : p.a), h("small", { class: "muted" }, ` ${p.share}%`)))));
    card.append(h("h3", {}, "대표 기사"), x.articles.length ? h("ul", { class: "tz-arts" }, ...x.articles.map((a) => artLine(a))) : h("p", { class: "muted" }, "최근 며칠 대표 기사가 없어요."),
      h("p", { class: "board-note" }, "제목은 기사 주소에서 뽑은 영어 문장이라 실제 제목과 다를 수 있고, 한국어 제목은 AI가 옮긴 것이에요."));
    // 한국·뉴질랜드에 주는 영향
    const imp = (["kr", "nz"] as const).map((k) => ({ k, d: v.exposure[k].drivers.find((y) => y.id === x.id), tot: v.exposure[k].drivers.reduce((a, y) => a + y.contrib, 0) || 1 })).filter((r) => r.d && r.d.contrib > 0.3);
    if (imp.length) card.append(h("h3", {}, "우리에게 주는 영향"), h("ul", { class: "tz-imp" }, ...imp.map((r) => h("li", {}, h("b", {}, r.k === "kr" ? "🇰🇷 한국" : "🇳🇿 뉴질랜드"), ` — ${r.d!.why} `, h("small", { class: "muted" }, `(${v.exposure[r.k].name} 노출도의 ${Math.round((r.d!.contrib / r.tot) * 100)}%)`)))));
    // 우리 브리핑 기사
    const rx = REGION_KW[x.id];
    const rel = rx ? brief.filter((b) => rx.test(b.text)).slice(0, 4) : [];
    card.append(h("h3", {}, "오늘 우리 브리핑의 관련 기사"), rel.length ? h("ul", { class: "tz-arts" }, ...rel.map((b) => h("li", {}, h("small", { class: "tz-tag" }, b.label), " ", ext(h, b.url, b.title)))) : h("p", { class: "muted" }, "오늘 브리핑에는 이 지역과 직접 관련된 기사가 없어요."));
    return card;
  }

  // ── 지도 (한 번 만들어 계속 쓴다: 다시 그릴 때마다 지도를 새로 만들지 않게) ──
  const mapEl = h("div", { class: "tz-map", role: "region", "aria-label": "분쟁 지역 지도" });
  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null, map: import("leaflet").Map | null = null, layer: import("leaflet").LayerGroup | null = null;
  const HOME_LL: Record<"kr" | "nz", [number, number]> = { kr: [37.57, 126.98], nz: [-36.85, 174.76] };
  function drawMap(v: ReturnType<typeof view>) {
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const home = HOME_LL[side], ex = v.exposure[side];
    for (const hs of v.hotspots) {
      const d = ex.drivers.find((y) => y.id === hs.id), c = lv(hs.score).color;
      if (d && d.contrib > 0.5) {
        let lon = hs.lon; if (Math.abs(lon - home[1]) > 180) lon += lon < home[1] ? 360 : -360;
        L.polyline([[hs.lat, lon], home], { color: c, weight: Math.max(1.5, d.contrib / 2.2), opacity: 0.55, dashArray: "6 6" }).addTo(layer);
      }
      const pop = document.createElement("div");
      const more = h("button", { type: "button", class: "tz-link" }, "왜 이 점수? 자세히 ›");
      more.addEventListener("click", () => { region = hs.id; rDay = null; map?.closePopup(); render(); document.getElementById("tz-region")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
      pop.append(h("strong", {}, `${hs.name} · ${Math.round(hs.score)}점 (${hs.level})`), h("div", { class: "muted" }, `최근 7일 군사 사건 3개월 중 상위 ${hs.pct7 != null ? 100 - hs.pct7 : "–"}%`),
        ...(hs.why ? [h("div", { class: "tz-pop-why" }, hs.why.split(". ")[0].slice(0, 110))] : []), more);
      L.circleMarker([hs.lat, hs.lon], { radius: 7 + hs.score / 7, color: c, fillColor: c, fillOpacity: 0.45, weight: 2 })
        .bindTooltip(`${hs.name} ${Math.round(hs.score)}`, { permanent: true, direction: "top", className: "tz-tip" }).bindPopup(pop, { maxWidth: 280 }).addTo(layer);
    }
    L.circleMarker(home, { radius: 8, color: "#1d4ed8", fillColor: "#fff", fillOpacity: 1, weight: 4 }).bindTooltip(side === "nz" ? "오클랜드" : "서울", { permanent: true, direction: "bottom" }).addTo(layer);
  }
  let lastView: ReturnType<typeof view> = view();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected && !root.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false, worldCopyJump: true }).setView([10, 125], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 6, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    drawMap(lastView);
  });

  const exposureCard = (v: ReturnType<typeof view>) => {
    const name = (id: string) => t.hotspots.find((x) => x.id === id)?.name ?? id;
    const one = (k: "kr" | "nz", flag: string) => {
      const e = v.exposure[k], L2 = lv(e.score), top = e.drivers.slice(0, 4), tot = e.drivers.reduce((a, d) => a + d.contrib, 0) || 1;
      const marks = [30, 50, 65, 80].map((m) => h("i", { class: "tz-tick", style: `left:${m}%` }));
      return h("div", { class: "tz-exp" },
        h("div", { class: "tz-exp-head" }, h("strong", {}, `${flag} ${e.name}`), badge(h, L2.name), h("b", { class: "tz-exp-score" }, String(Math.round(e.score)))),
        h("div", { class: "tz-bar" }, ...marks, h("span", { class: "tz-bar-dot", style: `left:${Math.min(100, e.score)}%;background:${L2.color}` })),
        h("div", { class: "tz-stack", title: "어느 지역 때문에 얼마나" }, ...e.drivers.filter((d) => d.contrib > 0.3).map((d) =>
          h("i", { style: `flex:${d.contrib};background:${lv(v.hotspots.find((x) => x.id === d.id)?.score ?? 0).color}`, title: `${name(d.id)} ${Math.round((d.contrib / tot) * 100)}%` }))),
        h("ul", { class: "tz-drivers" }, ...top.map((d) => { const li = h("li", {}, h("button", { type: "button", class: "tz-link", "data-r": d.id }, name(d.id)), h("small", { class: "muted" }, ` — ${d.why}`), h("b", {}, ` ${Math.round((d.contrib / tot) * 100)}%`)); return li; })));
    };
    return h("section", { class: "home-card", "aria-labelledby": "tz-exp" }, h("h2", { id: "tz-exp" }, "🎯 한국·뉴질랜드가 받는 영향"),
      h("div", { class: "tz-exp-grid" }, one("kr", "🇰🇷"), one("nz", "🇳🇿")),
      h("p", { class: "board-note" }, "지역별 긴장 점수에 그 지역이 각 나라에 미치는 영향 정도(거리·동맹·교역로·에너지 의존)를 곱해 합친 값이에요. 지역 이름을 누르면 그 지역의 자세한 원인으로 가요."));
  };

  const heatCard = (v: ReturnType<typeof view>) => {
    const weeks = 13;
    const rows = v.hotspots.map((hs) => {
      const s = hs.series.filter((p) => p.s != null) as { d: string; s: number }[];
      const cols: { avg: number | null; day: string | null }[] = [];
      for (let k = weeks - 1; k >= 0; k--) {
        const seg = s.slice(Math.max(0, s.length - (k + 1) * 7), s.length - k * 7);
        const peak = seg.reduce<{ d: string; s: number } | null>((m, p) => (!m || p.s >= m.s ? p : m), null);
        cols.push({ avg: seg.length ? seg.reduce((a, p) => a + p.s, 0) / seg.length : null, day: peak?.d ?? null });
      }
      return { hs, cols };
    });
    if (!rows.some((r) => r.cols.some((c) => c.avg != null))) return null;
    const rise = [...rows].map((r) => ({ r, d: (r.cols[weeks - 1].avg ?? 0) - (r.cols[weeks - 2].avg ?? r.cols[weeks - 1].avg ?? 0) })).sort((a, b) => b.d - a.d)[0];
    const grid = h("div", { class: "tz-heat", style: `grid-template-columns: 5.2em repeat(${weeks}, 1fr)` },
      h("span", {}, ""), ...Array.from({ length: weeks }, (_, i) => h("small", { class: "muted" }, i === weeks - 1 ? "이번" : i % 4 === 0 ? `${weeks - 1 - i}주` : "")),
      ...rows.flatMap(({ hs, cols }) => [h("span", { class: "tz-heat-l", title: hs.name }, short(hs)), ...cols.map((c) => h("button", { type: "button", class: "tz-cell", "data-r": hs.id, "data-day": c.day ?? "",
        "aria-label": c.avg == null ? "자료 없음" : `${hs.name} ${Math.round(c.avg)}점`, title: c.avg == null ? "자료 없음" : `${hs.name} ${Math.round(c.avg)}점 — 눌러서 그 주 가장 뜨거웠던 날 보기`,
        style: c.avg == null ? "background:var(--line);opacity:.4" : `background:${lv(c.avg).color};opacity:${(0.25 + (c.avg / 100) * 0.75).toFixed(2)}` }))]));
    return h("section", { class: "home-card", "aria-labelledby": "tz-heat" }, h("h2", { id: "tz-heat" }, "🔥 최근 3개월 흐름"),
      rise && rise.d >= 2 ? h("p", {}, "이번 주 가장 크게 오른 곳: ", h("strong", {}, rise.r.hs.name), ` (지난주보다 +${Math.round(rise.d)}점)`) : h("p", { class: "muted" }, "이번 주 크게 오른 곳은 없어요."),
      grid, h("p", { class: "board-note" }, "칸 하나 = 1주 평균 점수. 칸을 누르면 그 주에서 가장 뜨거웠던 날의 사건·기사를 볼 수 있어요."));
  };

  // 한 번에 다시 그리기. keepScroll=true 면 스크롤을 그대로(날짜만 바꿨을 때)
  function render(keepScroll = false) {
    const y = window.scrollY;
    const v = view(); lastView = v;
    const w = v.world, L2 = lv(w.score), d = delta(w.series), d30 = delta(w.series, 30);
    const alerts = preset === "all" ? t.alerts ?? [] : [];
    const chips = h("div", { class: "chips tz-presets", role: "group", "aria-label": "사건 유형" }, ...PRESETS.map((p) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(preset === p.id), title: p.hint }, p.label);
      if (p.id !== "all" && !detail) b.setAttribute("disabled", "true");
      b.addEventListener("click", () => { preset = p.id; wDay = null; render(); });
      return b;
    }));
    const hero = h("section", { class: "home-card tz-hero", "aria-labelledby": "tz-hero" },
      h("h2", { id: "tz-hero" }, "🌐 세계 군사 긴장 온도계"),
      h("div", { class: "tz-hero-row" }, svgEl(gauge(w.score, 200), "tz-gauge", `세계 군사 긴장도 ${Math.round(w.score)}점, ${L2.name}`),
        h("div", {}, h("p", { class: "tz-hero-lv" }, badge(h, L2.name)), h("p", {}, L2.desc),
          h("p", { class: "muted" }, `지난주보다 ${arrow(d) || "–"} · 한 달 전보다 ${arrow(d30) || "–"}`),
          h("p", { class: "muted" }, "가장 뜨거운 곳: ", ...v.hotspots.slice(0, 3).flatMap((x, i) => [i ? ", " : "", h("button", { type: "button", class: "tz-link", "data-r": x.id }, x.name)])))),
      h("div", { class: "tz-filter" }, h("small", { class: "muted" }, "보는 사건 "), chips, h("small", { class: "muted" }, ranges(preset) + (detail ? "" : " (필터는 자세한 기록을 받은 뒤 켜져요)"))),
      ...(alerts.length ? [h("div", { class: "tz-alerts" }, h("p", { class: "tz-sub" }, "📈 지난주보다 크게 움직인 곳"), ...alerts.slice(0, 3).map((a) => {
        const l = alertLines(t, a);
        const row = h("button", { type: "button", class: "tz-alert", "data-r": a.id }, h("b", { class: a.delta7 > 0 ? "up" : "down" }, `${a.delta7 > 0 ? "▲" : "▼"}${Math.round(Math.abs(a.delta7))}`), ` ${a.name} ${Math.round(a.score)}점 `, h("span", { class: "muted" }, l.main),
          l.news ? h("span", { class: "tz-alert-news" }, `📰 ${l.news}`) : null);
        return row; })) ] : []),
      w.series.length > 2 ? h("p", { class: "tz-sub" }, "세계 추이 — 날짜를 눌러 그날 무슨 일이 있었는지 보기") : null,
      w.series.length > 2 ? dayChart(h, w.series, wDay, (dd) => { wDay = dd; render(true); }) : null,
      worldDayPanel(v),
      t.stale ? h("p", { class: "tz-stale" }, `⚠ 최근 수집이 늦어 지난 값이 섞여 있어요${t.last_try ? ` (마지막 시도 ${ago(t.last_try)})` : ""}.`) : null);

    // 지역 목록 (누르면 상세)
    const list = h("ul", { class: "tz-list" }, ...v.hotspots.map((x) => {
      const ss = x.series.filter((p) => p.s != null) as { d: string; s: number }[], dd = x.delta7 ?? delta(ss);
      return h("li", {}, h("button", { type: "button", class: `tz-row${region === x.id ? " on" : ""}`, "data-r": x.id, "aria-expanded": String(region === x.id) },
        h("i", { class: "tz-dot", style: `background:${lv(x.score).color}` }), h("span", { class: "tz-name" }, x.name), h("b", {}, String(Math.round(x.score))), badge(h, x.level), h("small", { class: dcls(dd) }, ` ${arrow(dd)}`)));
    }));
    const seg = h("div", { class: "chips" }, ...(["nz", "kr"] as const).map((k) => { const b = h("button", { type: "button", class: "chip", "aria-pressed": String(side === k) }, k === "nz" ? "🇳🇿 뉴질랜드로 오는 영향" : "🇰🇷 한국으로 오는 영향");
      b.addEventListener("click", () => { side = k; drawMap(lastView); render(true); }); return b; }));
    const mapCard = h("section", { class: "home-card", "aria-labelledby": "tz-map" }, h("h2", { id: "tz-map" }, "🗺 분쟁 지역 지도"), seg, mapEl,
      h("p", { class: "board-note" }, "원 크기·색 = 지역 긴장 점수, 점선 굵기 = 그 지역이 선택한 나라에 주는 영향. 원이나 아래 목록을 누르면 그 지역에서 무슨 일이 있었는지 나와요."), list);
    const rc = regionCard(v);
    root.replaceChildren(hero, exposureCard(v), mapCard, ...(rc ? [rc] : []), prepCard(h, t), ...(heatCard(v) ? [heatCard(v)!] : []),
      h("p", { class: "board-note tz-foot" }, `출처: ${t.source} — 전 세계 뉴스에서 뽑은 군사 사건(무력 시위·공격·교전)이 하루 전체 사건에서 차지하는 비율을 지역별로 집계(${t.data_through ?? "최근"}까지, ${ago(t.updated)} 갱신). `,
        "점수 = 지역별 기본 긴장도(진행 중인 전쟁 여부 등) 50% + 최근 7일 군사 사건 비율이 3개월 중 얼마나 높은지·늘었는지 50%. 기사 제목은 기사 주소에서 뽑은 것이라 실제 제목과 다를 수 있어요. ",
        "뉴스 흐름으로 만든 참고 지표이며 정부의 공식 경보가 아니에요. 실제 위험은 ", ext(h, "https://www.safetravel.govt.nz/", "SafeTravel"), "·", ext(h, "https://www.0404.go.kr/", "외교부 해외안전여행"), "을 확인하세요."));
    drawMap(v);
    if (map) setTimeout(() => map?.invalidateSize(), 0);
    if (keepScroll) window.scrollTo(0, y);
  }

  // 지역 이름 버튼(data-r) 클릭은 한 곳에서 처리
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("[data-r]") as HTMLElement | null;
    if (!b || !root.contains(b)) return;
    const id = b.dataset.r!;
    if (b.classList.contains("tz-cell")) { region = id; rDay = b.dataset.day || null; }
    else if (b.classList.contains("tz-row") && region === id) { region = null; rDay = null; }
    else { region = id; rDay = null; }
    render();
    if (region) document.getElementById("tz-region")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  render();
  void loadDetail().then((dd) => { if (dd && root.isConnected) { detail = dd; render(true); } else if (dd) { detail = dd; } });
  if (region) setTimeout(() => document.getElementById("tz-region")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
  return root;
}
