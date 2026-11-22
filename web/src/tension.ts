// 🌐 세계 군사 긴장도 — 홈 요약 카드 + '안보' 탭 (data/tension.json, GDELT 뉴스 기반 · AI 없음)
//  1) 긴장 온도계(게이지)·90일 추이  2) 지역 지도(핫스팟 → 한국/뉴질랜드 영향선)  3) 한국·뉴질랜드 노출도 비교
//  4) 단계별 대비 체크리스트(이 기기에 체크 저장)  5) 지역 × 주 단위 히트맵
type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];

export interface Hotspot {
  id: string; name: string; lat: number; lon: number; base: number; score: number; level: string;
  pct7: number | null; chg7: number | null; stale?: boolean;
  series: { d: string; v: number; s: number | null }[];
  articles: { title: string; url: string; domain: string; date: string }[];
}
export interface Exposure { name: string; score: number; level: string; drivers: { id: string; w: number; contrib: number; why: string }[] }
export interface Tension {
  updated: string; source: string; stale?: boolean; last_try?: string;
  world: { score: number; level: string; series: { d: string; s: number }[] };
  hotspots: Hotspot[];
  exposure: { kr: Exposure; nz: Exposure };
}

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
const safe = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const ext = (h: H, url: string, text: string) => h("a", { href: safe(url), target: "_blank", rel: "noopener noreferrer" }, text);
const svgEl = (html: string, cls: string, label: string) => {
  const d = document.createElement("div"); d.className = cls; d.setAttribute("role", "img"); d.setAttribute("aria-label", label); d.innerHTML = html; return d;
};

let cache: Promise<Tension | null> | null = null;
export function loadTension(): Promise<Tension | null> {
  cache ??= fetch("./data/tension.json", { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<Tension>) : null)).catch(() => null);
  return cache;
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

/** 추이 선 그래프 + 단계 색 띠(배경) */
function lineChart(vals: { d: string; s: number }[], w = 640, hh = 150): string {
  if (vals.length < 2) return "";
  const pad = { l: 26, r: 8, t: 8, b: 20 }, iw = w - pad.l - pad.r, ih = hh - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / (vals.length - 1)) * iw, y = (s: number) => pad.t + ih - (s / 100) * ih;
  const bands = [...LV].reverse().map((b, i, arr) => { const top = i < arr.length - 1 ? arr[i + 1].min : 100;
    return `<rect x="${pad.l}" y="${y(top)}" width="${iw}" height="${y(b.min) - y(top)}" fill="${b.color}" opacity=".09"/>`; }).join("");
  const pts = vals.map((p, i) => `${x(i).toFixed(1)},${y(p.s).toFixed(1)}`).join(" ");
  const ticks = [0, Math.floor(vals.length / 2), vals.length - 1].map((i) => `<text x="${x(i)}" y="${hh - 4}" text-anchor="${i === 0 ? "start" : i === vals.length - 1 ? "end" : "middle"}" font-size="10" fill="currentColor" opacity=".6">${vals[i].d.slice(5).replace("-", "/")}</text>`).join("");
  const yl = [30, 50, 65, 80].map((s) => `<text x="${pad.l - 4}" y="${y(s) + 3}" text-anchor="end" font-size="9" fill="currentColor" opacity=".5">${s}</text>`).join("");
  const last = vals[vals.length - 1];
  return `<svg viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" style="width:100%;height:${hh}px">${bands}${yl}
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(vals.length - 1)}" cy="${y(last.s)}" r="4" fill="${lv(last.s).color}" stroke="var(--surface)" stroke-width="2"/>${ticks}</svg>`;
}

const delta = (series: { s: number }[], days = 7) => (series.length > days ? series[series.length - 1].s - series[series.length - 1 - days].s : null);
const arrow = (d: number | null) => (d == null ? "" : d >= 3 ? `▲${Math.round(d)}` : d <= -3 ? `▼${Math.round(-d)}` : "＝");
const badge = (h: H, level: string) => h("span", { class: "tz-badge", style: `--c:${LV.find((x) => x.name === level)?.color ?? "#888"}` }, level);
function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
}

// ── 홈 요약 카드 ──
export function tensionHomeCard(h: H, t: Tension, goTab: (id: string) => void): HTMLElement {
  const w = t.world, d = delta(w.series), top = t.hotspots.slice(0, 3), L = lv(w.score);
  const card = h("section", { class: "home-card tz-home", "aria-labelledby": "hm-tz" },
    h("h2", { id: "hm-tz" }, "🌐 세계 군사 긴장도"),
    h("div", { class: "tz-home-row" },
      svgEl(gauge(w.score, 150), "tz-gauge", `세계 군사 긴장도 ${Math.round(w.score)}점, ${L.name}`),
      h("div", { class: "tz-home-txt" },
        h("p", {}, badge(h, L.name), d != null ? h("small", { class: d >= 3 ? "up" : d <= -3 ? "down" : "muted" }, ` 지난주보다 ${arrow(d)}`) : null),
        h("p", { class: "tz-exp-mini" }, `🇰🇷 한국 `, badge(h, t.exposure.kr.level), `  🇳🇿 뉴질랜드 `, badge(h, t.exposure.nz.level)),
        h("p", { class: "tz-hot" }, "뜨거운 곳 ", ...top.map((x) => h("span", { class: "tz-hot-i" }, h("i", { class: "tz-dot", style: `background:${lv(x.score).color}` }), `${short(x)} `, h("b", {}, String(Math.round(x.score)))))))),
    h("button", { type: "button", class: "tz-more" }, "지도·대비 체크리스트 보기 ›"));
  card.querySelector(".tz-more")!.addEventListener("click", () => goTab("world"));
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

// ── 노출도 비교 ──
function exposureCard(h: H, t: Tension): HTMLElement {
  const name = (id: string) => t.hotspots.find((x) => x.id === id)?.name ?? id;
  const one = (k: "kr" | "nz", flag: string) => {
    const e = t.exposure[k], L = lv(e.score), top = e.drivers.slice(0, 4), tot = e.drivers.reduce((a, d) => a + d.contrib, 0) || 1;
    const marks = [30, 50, 65, 80].map((m) => h("i", { class: "tz-tick", style: `left:${m}%` }));
    return h("div", { class: "tz-exp" },
      h("div", { class: "tz-exp-head" }, h("strong", {}, `${flag} ${e.name}`), badge(h, L.name), h("b", { class: "tz-exp-score" }, String(Math.round(e.score)))),
      h("div", { class: "tz-bar" }, ...marks, h("span", { class: "tz-bar-dot", style: `left:${Math.min(100, e.score)}%;background:${L.color}` })),
      h("div", { class: "tz-stack", title: "어느 지역 때문에 얼마나" }, ...e.drivers.filter((d) => d.contrib > 0.3).map((d) =>
        h("i", { style: `flex:${d.contrib};background:${lv(t.hotspots.find((x) => x.id === d.id)?.score ?? 0).color}`, title: `${name(d.id)} ${Math.round((d.contrib / tot) * 100)}%` }))),
      h("ul", { class: "tz-drivers" }, ...top.map((d) => h("li", {}, h("span", {}, name(d.id)), h("small", { class: "muted" }, ` — ${d.why}`), h("b", {}, ` ${Math.round((d.contrib / tot) * 100)}%`)))));
  };
  return h("section", { class: "home-card", "aria-labelledby": "tz-exp" }, h("h2", { id: "tz-exp" }, "🎯 한국·뉴질랜드가 받는 영향"),
    h("div", { class: "tz-exp-grid" }, one("kr", "🇰🇷"), one("nz", "🇳🇿")),
    h("p", { class: "board-note" }, "지역별 긴장 점수에 그 지역이 각 나라에 미치는 영향 정도(거리·동맹·교역로·에너지 의존)를 곱해 합친 값이에요. 색 막대는 어느 지역 때문에 얼마나 높은지 보여 줍니다."));
}

// ── 지도: 핫스팟 원 + 한국/뉴질랜드로 이어지는 영향선 ──
const HOME_LL: Record<"kr" | "nz", [number, number]> = { kr: [37.57, 126.98], nz: [-36.85, 174.76] };
function mapCard(h: H, t: Tension): HTMLElement {
  let side: "kr" | "nz" = "nz";
  const mapEl = h("div", { class: "tz-map", role: "region", "aria-label": "분쟁 지역 지도" });
  const seg = h("div", { class: "chips" });
  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null, map: import("leaflet").Map | null = null, layer: import("leaflet").LayerGroup | null = null;
  const draw = () => {
    seg.replaceChildren(...(["nz", "kr"] as const).map((k) => { const b = h("button", { type: "button", class: "chip", "aria-pressed": String(side === k) }, k === "nz" ? "🇳🇿 뉴질랜드로 오는 영향" : "🇰🇷 한국으로 오는 영향");
      b.addEventListener("click", () => { side = k; draw(); }); return b; }));
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const home = HOME_LL[side], ex = t.exposure[side];
    for (const hs of t.hotspots) {
      const d = ex.drivers.find((x) => x.id === hs.id), c = lv(hs.score).color;
      if (d && d.contrib > 0.5) {
        let lon = hs.lon; if (Math.abs(lon - home[1]) > 180) lon += lon < home[1] ? 360 : -360;
        L.polyline([[hs.lat, lon], home], { color: c, weight: Math.max(1.5, d.contrib / 2.2), opacity: 0.55, dashArray: "6 6" }).addTo(layer);
      }
      const pop = document.createElement("div");
      pop.append(h("strong", {}, `${hs.name} · ${Math.round(hs.score)}점 (${hs.level})`),
        h("div", { class: "muted" }, `최근 7일 보도량: 3개월 중 상위 ${hs.pct7 != null ? 100 - hs.pct7 : "–"}% · 직전 3주 대비 ${hs.chg7 != null ? (hs.chg7 >= 0 ? "+" : "") + hs.chg7 + "%" : "–"}`),
        h("ul", { class: "tz-pop" }, ...hs.articles.slice(0, 3).map((a) => h("li", {}, ext(h, a.url, a.title), h("small", { class: "muted" }, ` ${a.domain} ${a.date.slice(5)}`)))));
      L.circleMarker([hs.lat, hs.lon], { radius: 7 + hs.score / 7, color: c, fillColor: c, fillOpacity: 0.45, weight: 2 })
        .bindTooltip(`${hs.name} ${Math.round(hs.score)}`, { permanent: true, direction: "top", className: "tz-tip" }).bindPopup(pop, { maxWidth: 280 }).addTo(layer);
    }
    L.circleMarker(home, { radius: 8, color: "#1d4ed8", fillColor: "#fff", fillOpacity: 1, weight: 4 }).bindTooltip(side === "nz" ? "오클랜드" : "서울", { permanent: true, direction: "bottom" }).addTo(layer);
  };
  draw();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false, worldCopyJump: true }).setView([10, 125], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 6, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    draw();
  });
  const list = h("ul", { class: "tz-list" }, ...t.hotspots.map((hs) => {
    const ds = hs.series.filter((p) => p.s != null) as { d: string; s: number }[], d = delta(ds);
    return h("li", {}, h("details", {},
      h("summary", {}, h("i", { class: "tz-dot", style: `background:${lv(hs.score).color}` }), h("span", { class: "tz-name" }, hs.name),
        h("b", {}, String(Math.round(hs.score))), badge(h, hs.level), h("small", { class: d != null && d >= 3 ? "up" : d != null && d <= -3 ? "down" : "muted" }, ` ${arrow(d)}`), hs.stale ? h("small", { class: "muted" }, " (지난 값)") : null),
      h("p", { class: "muted" }, `기본 긴장도 ${hs.base} · 최근 7일 보도량 3개월 중 상위 ${hs.pct7 != null ? 100 - hs.pct7 : "–"}% · 직전 3주 대비 ${hs.chg7 != null ? (hs.chg7 >= 0 ? "+" : "") + hs.chg7 + "%" : "–"}`),
      hs.articles.length ? h("ul", { class: "tz-arts" }, ...hs.articles.map((a) => h("li", {}, ext(h, a.url, a.title), h("small", { class: "muted" }, ` · ${a.domain} ${a.date.slice(5).replace("-", "/")}`)))) : h("p", { class: "muted" }, "최근 3일 대표 기사 없음")));
  }));
  return h("section", { class: "home-card", "aria-labelledby": "tz-map" }, h("h2", { id: "tz-map" }, "🗺 분쟁 지역 지도"), seg, mapEl,
    h("p", { class: "board-note" }, "원 크기·색 = 지역 긴장 점수, 점선 굵기 = 그 지역이 선택한 나라에 주는 영향. 원을 누르면 최근 기사가 나와요."), list);
}

// ── 지역 × 주 히트맵 ──
function heatCard(h: H, t: Tension): HTMLElement | null {
  const weeks = 13;
  const rows = t.hotspots.map((hs) => {
    const s = hs.series.filter((p) => p.s != null) as { d: string; s: number }[];
    const cols: (number | null)[] = [];
    for (let k = weeks - 1; k >= 0; k--) {
      const seg = s.slice(Math.max(0, s.length - (k + 1) * 7), s.length - k * 7);
      cols.push(seg.length ? seg.reduce((a, p) => a + p.s, 0) / seg.length : null);
    }
    return { hs, cols };
  });
  if (!rows.some((r) => r.cols.some((c) => c != null))) return null;
  const rise = [...rows].map((r) => ({ r, d: (r.cols[weeks - 1] ?? 0) - (r.cols[weeks - 2] ?? r.cols[weeks - 1] ?? 0) })).sort((a, b) => b.d - a.d)[0];
  const grid = h("div", { class: "tz-heat", style: `grid-template-columns: 5.2em repeat(${weeks}, 1fr)` },
    h("span", {}, ""), ...Array.from({ length: weeks }, (_, i) => h("small", { class: "muted" }, i === weeks - 1 ? "이번" : i % 4 === 0 ? `${weeks - 1 - i}주` : "")),
    ...rows.flatMap(({ hs, cols }) => [h("span", { class: "tz-heat-l", title: hs.name }, short(hs)), ...cols.map((c) => h("i", {
      style: c == null ? "background:var(--line);opacity:.4" : `background:${lv(c).color};opacity:${(0.25 + (c / 100) * 0.75).toFixed(2)}`, title: c == null ? "자료 없음" : `${hs.name} ${Math.round(c)}점` }))]));
  return h("section", { class: "home-card", "aria-labelledby": "tz-heat" }, h("h2", { id: "tz-heat" }, "🔥 최근 3개월 흐름"),
    rise && rise.d >= 2 ? h("p", {}, "이번 주 가장 크게 오른 곳: ", h("strong", {}, rise.r.hs.name), ` (지난주보다 +${Math.round(rise.d)}점)`) : h("p", { class: "muted" }, "이번 주 크게 오른 곳은 없어요."),
    grid, h("p", { class: "board-note" }, "칸 하나 = 1주 평균 점수, 오른쪽 끝이 이번 주. 진하고 붉을수록 긴장이 높았던 주예요."));
}

// ── 안보 탭 전체 ──
export function worldView(h: H, t: Tension): HTMLElement {
  const w = t.world, L = lv(w.score), d = delta(w.series), d30 = delta(w.series, 30);
  const hero = h("section", { class: "home-card tz-hero", "aria-labelledby": "tz-hero" },
    h("h2", { id: "tz-hero" }, "🌐 세계 군사 긴장 온도계"),
    h("div", { class: "tz-hero-row" }, svgEl(gauge(w.score, 200), "tz-gauge", `세계 군사 긴장도 ${Math.round(w.score)}점, ${L.name}`),
      h("div", {}, h("p", { class: "tz-hero-lv" }, badge(h, L.name)), h("p", {}, L.desc),
        h("p", { class: "muted" }, `지난주보다 ${arrow(d) || "–"} · 한 달 전보다 ${arrow(d30) || "–"}`),
        h("p", { class: "muted" }, "가장 뜨거운 곳: ", ...t.hotspots.slice(0, 3).flatMap((x, i) => [i ? ", " : "", h("strong", {}, x.name)])))),
    w.series.length > 2 ? svgEl(lineChart(w.series), "tz-line", "세계 긴장도 최근 3개월 추이") : null,
    t.stale ? h("p", { class: "tz-stale" }, `⚠ 최근 수집이 일부 실패해 지난 값이 섞여 있어요${t.last_try ? ` (마지막 시도 ${ago(t.last_try)})` : ""}.`) : null);
  return h("div", { class: "tz-view" }, hero, exposureCard(h, t), mapCard(h, t), prepCard(h, t), heatCard(h, t),
    h("p", { class: "board-note tz-foot" }, `출처: ${t.source} — 전 세계 온라인 뉴스에서 지역별 무력 충돌 관련 보도 비중을 매일 집계(${ago(t.updated)} 갱신). `,
      "점수 = 지역별 기본 긴장도(진행 중인 전쟁 여부 등) 50% + 최근 7일 보도량이 3개월 중 얼마나 많은지·늘었는지 50%. ",
      "뉴스 흐름으로 만든 참고 지표이며 정부의 공식 경보가 아니에요. 실제 위험은 ", ext(h, "https://www.safetravel.govt.nz/", "SafeTravel"), "·", ext(h, "https://www.0404.go.kr/", "외교부 해외안전여행"), "을 확인하세요."));
}
