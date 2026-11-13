// 자동차 칩: 정비소 지도(OSM, 매달 갱신) · 한인 정비소(hanin.nz 목록 + 이름 추정) · 차보험 비교 · 사고 대처 · 믿을 만한 곳 찾기
// 보험 정보는 공개 비교 자료·보험사 안내 기준의 큐레이션이며 요율·조건은 보험사마다, 때마다 다르므로 '견적으로 확인'을 원칙으로 한다.
import { km } from "./gpmap";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];
type LL = [number, number];
interface Shop { n: string; k: string[]; ll: LL; a?: string; p?: string; w?: string; h?: string; ko_guess?: boolean }
interface HaninShop { n: string; a: string; p: string; w: string; maps: string; note: string; ll: LL | null; src: string }
export interface CarData { updated_at: string; shops: Shop[]; hanin: { status: string; source: string; shops: HaninShop[] } }

let cache: CarData | null = null;
export async function loadCar(): Promise<CarData | null> {
  if (cache) return cache;
  try {
    const r = await fetch("data/car.json", { cache: "no-cache" });
    if (r.ok) cache = (await r.json()) as CarData;
  } catch { /* 오프라인 */ }
  return cache;
}

const KINDS: [string, string, string][] = [
  ["repair", "🔧 일반 정비", "#2563eb"],
  ["wof", "✅ WoF 검사", "#16a34a"],
  ["panel", "🚙 판금·사고 수리", "#dc2626"],
  ["tyre", "🛞 타이어", "#7c3aed"],
  ["glass", "🪟 유리", "#0891b2"],
  ["toyota", "Toyota 서비스", "#eb0a1e"],
];
const KCOLOR = Object.fromEntries(KINDS.map(([k, , c]) => [k, c]));
const KLABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l]));
const safe = (u?: string) => (u && /^https?:\/\//.test(u) ? u : "");
const ext = (h: H, url: string, label: string) => h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);

/** 지도 + 목록 */
function shopSection(h: H, data: CarData, homes: { s: string; at: LL }[]): HTMLElement {
  let kind = "all", onlyKo = false, radius = homes.length ? 5 : 0;
  const sec = h("section", { class: "hood-card gp car" }, h("h2", {}, "🔧 가까운 정비소 지도"));
  const tools = h("div", { class: "gp-tools gp-prec" });
  const rTools = h("div", { class: "gp-tools gp-prec" });
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "정비소 위치 지도" });
  const count = h("p", { class: "muted car-count" });
  const list = h("ul", { class: "gp-list" });
  const nearest = (s: Shop) => homes.length ? homes.map((x) => ({ s: x.s, d: km(x.at, s.ll) })).sort((a, b) => a.d - b.d)[0] : null;
  const shown = () => data.shops
    .filter((s) => kind === "all" || s.k.includes(kind))
    .filter((s) => !onlyKo || s.ko_guess)
    .map((s) => ({ s, near: nearest(s) }))
    .filter((x) => !radius || !x.near || x.near.d <= radius)
    .sort((a, b) => (a.near?.d ?? 0) - (b.near?.d ?? 0) || a.s.n.localeCompare(b.s.n));
  const info = (s: Shop, near: { s: string; d: number } | null) => {
    const links = h("span", { class: "gp-links" });
    if (s.p) links.append(h("a", { href: `tel:${s.p.replace(/[^\d+]/g, "")}` }, `📞 ${s.p}`));
    if (safe(s.w)) links.append(ext(h, s.w!, "웹사이트 ↗"));
    links.append(ext(h, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.n} ${s.a || ""} Auckland`)}`, "지도·후기 ↗"));
    return h("div", { class: "gp-info" },
      h("div", { class: "gp-name" }, h("strong", {}, s.n), " ", ...s.k.map((k) => h("span", { class: "car-kind", style: `--kc:${KCOLOR[k]}` }, KLABEL[k] || k)),
        s.ko_guess ? h("span", { class: "car-kind ko", title: "이름에 한글·Korea 가 들어가 한인 운영으로 추정 — 확인 필요" }, "🇰🇷 한인 추정") : null,
        near ? h("span", { class: "muted" }, ` · ${near.s}에서 ${near.d.toFixed(1)}km(직선)`) : null),
      s.a ? h("div", { class: "muted" }, s.a) : null,
      s.h ? h("div", { class: "muted" }, `영업시간(OSM): ${s.h}`) : null,
      links);
  };
  const N = 30;
  let more = false;
  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null, layer: import("leaflet").LayerGroup | null = null, map: import("leaflet").Map | null = null;
  const draw = () => {
    const xs = shown();
    count.textContent = `${xs.length}곳${radius && homes.length ? ` · 관심 동네 ${radius}km 안` : ""}${xs.length > N && !more ? ` · 가까운 ${N}곳 표시` : ""}`;
    const vis = more ? xs : xs.slice(0, N);
    list.replaceChildren(...vis.map((x) => h("li", {}, info(x.s, x.near))));
    if (xs.length > N && !more) {
      const b = h("button", { type: "button", class: "chip" }, `${xs.length - N}곳 더 보기`);
      b.addEventListener("click", () => { more = true; draw(); });
      list.append(h("li", {}, b));
    }
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const pts: LL[] = [];
    for (const { s, near } of vis) {
      pts.push(s.ll);
      const k = kind !== "all" ? kind : s.k.find((x) => x !== "repair") || s.k[0];
      L.circleMarker(s.ll, { radius: s.ko_guess ? 9 : 7, weight: s.ko_guess ? 3 : 2, color: s.ko_guess ? "#111827" : "#fff", fillColor: KCOLOR[k] || "#2563eb", fillOpacity: 0.9 })
        .bindPopup(info(s, near)).addTo(layer);
    }
    for (const x of homes) {
      pts.push(x.at);
      L.circleMarker(x.at, { radius: 6, weight: 2, color: "#1d4ed8", fillColor: "#93c5fd", fillOpacity: 0.9 }).bindTooltip(x.s, { direction: "top", className: "gp-home-label" }).addTo(layer);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 14 });
  };
  const chip = (label: string, on: () => boolean, click: () => void) => {
    const b = h("button", { type: "button", class: "chip", "aria-pressed": String(on()) }, label);
    b.addEventListener("click", () => { click(); more = false; for (const x of [...tools.children, ...rTools.children]) (x as HTMLElement & { sync?: () => void }).sync?.(); draw(); });
    (b as HTMLElement & { sync?: () => void }).sync = () => b.setAttribute("aria-pressed", String(on()));
    return b;
  };
  tools.append(chip("전체", () => kind === "all", () => { kind = "all"; }), ...KINDS.map(([k, l]) => chip(l, () => kind === k, () => { kind = k; })),
    chip("🇰🇷 한글·Korea 이름만", () => onlyKo, () => { onlyKo = !onlyKo; }));
  if (homes.length) rTools.append(h("span", {}, "관심 동네에서"), ...[3, 5, 10, 0].map((r) => chip(r ? `${r}km` : "전체", () => radius === r, () => { radius = r; })));
  sec.append(tools, rTools, mapEl, h("p", { class: "gp-legend" }, ...KINDS.flatMap(([, l, c]) => [h("span", { class: "dot", style: `background:${c}` }), `${l} `]),
    h("span", { class: "dot", style: "background:#fff;border:3px solid #111827" }), "한인 추정 ", homes.length ? h("span", { class: "dot home" }) : null, homes.length ? "관심 동네" : null),
  count, list,
  h("p", { class: "board-note" }, "출처: OpenStreetMap 기여자 데이터(", data.updated_at.slice(5).replace("-", "/"),
    " 확인, 매달 갱신). 모든 정비소가 지도에 올라 있지는 않고 폐업·이전이 늦게 반영될 수 있어요. 종류는 지도 태그와 이름으로 나눈 것이라 실제 서비스는 전화로 확인하세요. 거리는 직선거리(추정)입니다. ",
    !homes.length ? "설정에서 관심 동네를 넣으면 가까운 순으로 정렬돼요." : ""));
  draw();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.85, 174.76], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    draw();
  });
  return sec;
}

/** 한인 정비소: hanin.nz 목록(있을 때) + 이름 추정 + 커뮤니티 검색 링크 */
function koreanSection(h: H, data: CarData, homes: { s: string; at: LL }[]): HTMLElement {
  const sec = h("section", { class: "hood-card car-ko" }, h("h2", {}, "🇰🇷 한인 정비소"));
  const hs = data.hanin.shops || [];
  const near = (ll: LL | null) => (ll && homes.length ? homes.map((x) => ({ s: x.s, d: km(x.at, ll) })).sort((a, b) => a.d - b.d)[0] : null);
  if (hs.length) {
    sec.append(h("p", { class: "board-note" }, "한인.nz 목록 기준 · ", ext(h, data.hanin.source, "원문 ↗")),
      h("ul", { class: "gp-list" }, ...hs.map((s) => { const n = near(s.ll);
        return h("li", {}, h("div", { class: "gp-info" }, h("div", { class: "gp-name" }, h("strong", {}, s.n), n ? h("span", { class: "muted" }, ` · ${n.s}에서 ${n.d.toFixed(1)}km`) : null),
          s.note ? h("div", { class: "gp-doctors" }, s.note) : null, s.a ? h("div", { class: "muted" }, s.a) : null,
          h("span", { class: "gp-links" }, s.p ? h("a", { href: `tel:${s.p.replace(/[^\d+]/g, "")}` }, `📞 ${s.p}`) : null, safe(s.w) ? ext(h, s.w, "웹사이트 ↗") : null, safe(s.maps) ? ext(h, s.maps, "지도 ↗") : null))); })));
  } else {
    const src = data.hanin.source && data.hanin.source !== "https://hanin.nz/" ? data.hanin.source : "";
    sec.append(h("p", { class: "muted" }, `한인.nz: ${data.hanin.status}. `, src ? ext(h, src, "한인.nz 정비 관련 글 ↗") : null,
      " 매달 다시 확인해 업체 목록이 생기면 여기에 자동으로 나옵니다."));
  }
  const guess = data.shops.filter((s) => s.ko_guess);
  sec.append(h("p", {}, guess.length ? `지도 데이터에서 이름에 한글·Korea 가 들어간 곳 ${guess.length}곳 — 위 지도에서 '🇰🇷 한글·Korea 이름만'을 누르면 모아 볼 수 있어요(한인 운영 여부는 확인 필요).` : "지도 데이터에는 이름에 한글·Korea 가 들어간 정비소가 아직 없어요."));
  const q = (s: string) => `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  sec.append(h("div", { class: "car-links" },
    ext(h, q("오클랜드 한인 정비소 카센터"), "🔎 구글: 오클랜드 한인 정비"),
    ext(h, q("site:nzkoreapost.com 정비"), "🔎 코리아포스트 '정비'"),
    ext(h, q("오클랜드 한인 판금 사고수리"), "🔎 한인 판금·사고 수리"),
    ext(h, "https://hanin.nz/", "한인.nz ↗")),
  h("p", { class: "board-note" }, "커뮤니티 후기는 광고일 수 있어요. 견적은 2곳 이상 받고, 작업 전 견적서(quote)를 서면으로 받으세요."));
  return sec;
}

/** 차보험 비교·견적 링크 (큐레이션) */
const INSURERS: { n: string; who: string; url: string; quote: string; note: string }[] = [
  { n: "AA Insurance", who: "AA·Suncorp 합작", url: "https://www.aainsurance.co.nz/", quote: "https://www.aainsurance.co.nz/", note: "AA 회원 할인. 사고 시 지정 수리점 네트워크" },
  { n: "AMI", who: "IAG 브랜드", url: "https://www.ami.co.nz/", quote: "https://www.ami.co.nz/compare-car-insurance", note: "State 와 같은 IAG 계열(약관 구성 비슷). MotorHub 정비·WoF 운영" },
  { n: "State", who: "IAG 브랜드", url: "https://www.state.co.nz/", quote: "https://www.state.co.nz/", note: "AMI 와 같은 IAG 계열 — 둘 다 견적 받아 비교" },
  { n: "Tower", who: "독립 상장사", url: "https://www.tower.co.nz/", quote: "https://www.tower.co.nz/", note: "온라인 가입·청구 중심" },
  { n: "Cove", who: "온라인 전용", url: "https://www.cove.co.nz/", quote: "https://www.cove.co.nz/", note: "앱·웹으로만 운영" },
  { n: "Trade Me Insurance", who: "Trade Me", url: "https://www.trademeinsurance.co.nz/", quote: "https://www.trademeinsurance.co.nz/", note: "온라인 견적" },
];
function insuranceSection(h: H): HTMLElement {
  const sec = h("section", { class: "hood-card car-ins" }, h("h2", {}, "🛡️ 차보험"));
  sec.append(
    h("div", { class: "tbl-scroll" }, h("table", { class: "hood-table car-cover" },
      h("thead", {}, h("tr", {}, h("th", {}, "보장 종류"), h("th", {}, "상대 차·재산"), h("th", {}, "내 차 화재·도난"), h("th", {}, "내 차 사고 수리"), h("th", {}, "보험료"))),
      h("tbody", {},
        h("tr", {}, h("th", { scope: "row" }, "종합 (Comprehensive)"), h("td", {}, "✅"), h("td", {}, "✅"), h("td", {}, "✅"), h("td", {}, "가장 비쌈")),
        h("tr", {}, h("th", { scope: "row" }, "제3자·화재·도난 (TPF&T)"), h("td", {}, "✅"), h("td", {}, "✅"), h("td", {}, "—"), h("td", {}, "종합의 대략 30~50%")),
        h("tr", {}, h("th", { scope: "row" }, "제3자 (Third party)"), h("td", {}, "✅"), h("td", {}, "—"), h("td", {}, "—"), h("td", {}, "가장 쌈"))))),
    h("p", { class: "board-note" }, "보험료 비율은 비교 사이트들의 대략적인 안내예요. NZ 는 차보험이 의무가 아니지만, 남의 고급차를 들이받으면 수리비를 직접 물어야 해서 최소 제3자 보험은 권장돼요. 해외 면허·NZ 운전 경력이 짧으면 보험료가 높게 나올 수 있으니 가입 때 사실대로 알리세요(숨기면 청구 거절 사유)."),
    h("div", { class: "tbl-scroll" }, h("table", { class: "hood-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "보험사"), h("th", {}, "구분"), h("th", {}, "참고"), h("th", {}, "견적"))),
      h("tbody", {}, ...INSURERS.map((i) => h("tr", {}, h("th", { scope: "row" }, ext(h, i.url, i.n)), h("td", {}, i.who), h("td", {}, i.note), h("td", {}, ext(h, i.quote, "온라인 견적 ↗"))))))),
    h("div", { class: "car-links" },
      ext(h, "https://quashed.co.nz/car-insurance/", "🔎 Quashed 견적 한 번에 비교"),
      ext(h, "https://www.moneyhub.co.nz/ami-vs-aa-vs-cove-vs-state-vs-tower-vs-trade-me.html", "📊 MoneyHub 약관 비교"),
      ext(h, "https://www.canstarblue.co.nz/car-insurance", "⭐ Canstar Blue 만족도")),
    h("h3", {}, "한국어 상담 (보험 브로커)"),
    h("p", {}, "한국어로 상담하는 브로커는 확인된 목록이 없어 직접 싣지 않았어요. 찾은 브로커는 정부 금융서비스 등록부(FSPR)에서 등록 여부를 먼저 확인하세요."),
    h("div", { class: "car-links" },
      ext(h, "https://fsp-register.companiesoffice.govt.nz/", "🏛️ FSPR 등록 확인"),
      ext(h, "https://www.google.com/search?q=" + encodeURIComponent("오클랜드 한인 보험 브로커 자동차보험"), "🔎 한인 보험 브로커 검색")),
    h("p", { class: "board-note" }, "보험사 목록은 NZ 주요 비교 사이트에서 함께 다루는 곳 기준이며 추천·순위가 아니에요. 요율·자기부담금(excess)·조건은 견적으로 확인하세요."));
  return sec;
}

function accidentSection(h: H): HTMLElement {
  const steps: [string, string][] = [
    ["1. 안전 먼저", "다친 사람이 있으면 바로 111. 비상등을 켜고 가능하면 차를 안전한 곳으로."],
    ["2. 정보 교환", "상대 운전자 이름·주소·전화·면허 정보·차량 번호판·보험사를 받으세요. 상대가 거부하면 번호판을 적어 경찰에 신고."],
    ["3. 사진·증인", "현장, 양쪽 차 손상, 번호판, 도로 상태를 사진으로. 목격자 연락처도."],
    ["4. 잘못 인정하지 않기", "현장에서 '제 잘못이에요'라고 말하면 보험 처리에 불리할 수 있어요. 사실만 말하세요."],
    ["5. 경찰 신고 기준", "사람이 다쳤으면 가능한 빨리, 늦어도 24시간 안에 경찰 신고(의무). 주차된 차 등을 부딪치고 주인을 못 찾으면 늦어도 60시간 안에 신고. 그 밖은 105 또는 온라인."],
    ["6. 보험 청구", "보험사에 바로 연락. 보험사 지정 판금소를 쓰면 절차가 빠른 경우가 많아요. 수리 전 견적·승인을 받으세요."],
    ["7. 다쳤다면 ACC", "NZ 에서 사고로 다치면 비자와 상관없이 ACC 가 치료비를 지원해요. GP 에서 ACC 청구를 요청하세요."],
  ];
  return h("details", { class: "guide car-acc" },
    h("summary", {}, "🚨 사고 났을 때 순서"),
    h("ol", { class: "car-steps" }, ...steps.map(([t, d]) => h("li", {}, h("strong", {}, t), " — ", d))),
    h("p", { class: "board-note" }, "근거: ", ext(h, "https://communitylaw.org.nz/community-law-manual/chapter-31-driving-and-traffic-law/accidents-driver-responsibilities/", "Community Law (운전자 의무)"), " · ",
      ext(h, "https://www.aainsurance.co.nz/help/article/360019838132-What-details-should-I-collect-after-being-in-an-accident", "AA Insurance (교환할 정보)"), " · ",
      ext(h, "https://www.acc.co.nz/", "ACC"), ". 법적 기한은 경찰·NZTA 공식 안내로 다시 확인하세요."),
    h("div", { class: "car-links" }, h("a", { href: "tel:111" }, "📞 111 응급"), h("a", { href: "tel:105" }, "📞 105 비응급"), ext(h, "https://www.police.govt.nz/", "NZ Police 온라인 신고 ↗")));
}

function trustSection(h: H): HTMLElement {
  const L: [string, string, string][] = [
    ["MTA 회원 정비소 찾기", "자동차정비협회(MTA) 홈페이지의 'Find a Member' — 분쟁 조정 제도 있음", "https://mta.org.nz/"],
    ["Toyota 공식 서비스", "토요타 딜러 정비·리콜 확인(위 지도의 'Toyota 서비스'와 함께)", "https://www.toyota.co.nz/"],
    ["NZTA WoF 안내", "WoF 검사 항목·주기 (2026년 11월부터 주기 개편 — 내 차 기준은 여기서 확인)", "https://www.nzta.govt.nz/vehicles/warrants-and-certificates/warrant-of-fitness"],
    ["차 유지 정부 안내", "WoF·rego(차량 등록료) 갱신 등 정부 안내 모음", "https://www.govt.nz/browse/transport/keeping-a-vehicle-on-the-road/"],
    ["NoCowboys 후기", "현지인 별점·후기로 정비소 고르기", "https://nocowboys.co.nz/"],
    ["정부 소비자 보호: 차 수리 맡기기", "정비 맡길 때 소비자 권리(견적·보증·분쟁)", "https://consumerprotection.govt.nz/help-product-service/cars/fixing-your-car"],
  ];
  return h("details", { class: "guide" }, h("summary", {}, "✅ 믿을 만한 곳 찾기·WoF·rego"),
    h("ul", {}, ...L.map(([t, d, u]) => h("li", {}, ext(h, u, t), h("span", { class: "guide-desc" }, d)))));
}

export function carSection(h: H, data: CarData | null, homes: { s: string; at: LL }[]): HTMLElement {
  const root = h("div", { class: "car-root" });
  if (data) root.append(koreanSection(h, data, homes), shopSection(h, data, homes));
  else root.append(h("section", { class: "hood-card" }, h("h2", {}, "🔧 정비소 지도"), h("p", { class: "muted" }, "정비소 데이터는 다음 달 갱신 작업 뒤 표시됩니다.")));
  root.append(insuranceSection(h), accidentSection(h), trustSection(h));
  return root;
}
