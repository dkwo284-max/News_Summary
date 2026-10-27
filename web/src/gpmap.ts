// 한인 GP 지도: data/korean-gp.json (출처 hanin.nz, 매일 갱신) 을 지도와 목록으로. Leaflet 은 이 화면을 열 때만 불러온다.
type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

export interface Clinic {
  name: string;
  status: string;
  doctors: string;
  address: string;
  maps_url: string;
  phone: string;
  region: string;
  website: string;
  healthpoint: string;
  latlon: [number, number] | null;
}
export interface GPData {
  updated_at: string;
  source: string;
  clinics: Clinic[];
  suburbs: Record<string, [number, number]>;
}

let cache: GPData | null = null;
export async function loadGP(): Promise<GPData | null> {
  if (cache) return cache;
  try {
    const r = await fetch("data/korean-gp.json", { cache: "no-cache" });
    if (r.ok) cache = (await r.json()) as GPData;
  } catch {
    /* 오프라인 */
  }
  return cache;
}

export function km(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

const statusClass = (s: string) => (s.includes("가능") ? "open" : s.includes("마감") ? "closed" : "partial");
const COLORS = { open: "#16a34a", partial: "#d97706", closed: "#9ca3af" };

/** 가까운 한인 GP (관심 동네 카드용) */
export function nearest(gp: GPData | null, suburb: string, n = 2): { c: Clinic; d: number }[] {
  const at = gp?.suburbs[suburb];
  if (!gp || !at) return [];
  return gp.clinics.filter((c) => c.latlon).map((c) => ({ c, d: km(at, c.latlon!) })).sort((x, y) => x.d - y.d).slice(0, n);
}

export function statusBadge(h: H, c: Clinic): HTMLElement {
  return h("span", { class: `gp-status ${statusClass(c.status)}` }, c.status || "확인 필요");
}

function clinicInfo(h: H, c: Clinic, extra?: string): HTMLElement {
  const links = h("span", { class: "gp-links" });
  if (c.phone) links.append(h("a", { href: `tel:${c.phone.replace(/\s/g, "")}` }, `📞 ${c.phone}`));
  for (const [url, label] of [[c.maps_url, "지도"], [c.website, "웹사이트"], [c.healthpoint, "Healthpoint"]] as const) {
    if (/^https?:\/\//.test(url)) links.append(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, `${label} ↗`));
  }
  return h("div", { class: "gp-info" },
    h("div", { class: "gp-name" }, h("strong", {}, c.name), " ", statusBadge(h, c), extra ? h("span", { class: "muted" }, ` · ${extra}`) : null),
    c.doctors ? h("div", { class: "gp-doctors" }, c.doctors) : null,
    c.address ? h("div", { class: "muted" }, c.address) : null,
    links);
}

/** 의료 칩: 지도 + 목록. watched 동네가 있으면 가까운 순으로 정렬하고 지도에 동네 위치도 표시 */
export function gpSection(h: H, gp: GPData | null, watched: string[]): HTMLElement {
  const sec = h("section", { class: "hood-card gp" }, h("h2", {}, "🇰🇷 한인 GP 지도"));
  if (!gp) {
    sec.append(h("p", { class: "muted" }, "한인 GP 목록은 다음 아침 실행 뒤 표시됩니다."));
    return sec;
  }
  const akl = gp.clinics.filter((c) => c.region === "오클랜드");
  const homes = watched.filter((s) => gp.suburbs[s]).map((s) => ({ s, at: gp.suburbs[s] }));
  const near = (c: Clinic) => (c.latlon && homes.length ? Math.min(...homes.map((x) => km(x.at, c.latlon!))) : Infinity);
  const nearName = (c: Clinic) => {
    if (!c.latlon || !homes.length) return "";
    const best = homes.map((x) => ({ s: x.s, d: km(x.at, c.latlon!) })).sort((a, b) => a.d - b.d)[0];
    return `${best.s}에서 ${best.d.toFixed(1)}km`;
  };
  let onlyOpen = false;
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "한인 GP 위치 지도" });
  const list = h("ul", { class: "gp-list" });
  const toggle = h("button", { type: "button", class: "chip", "aria-pressed": "false" }, "등록 가능만");
  const legend = h("p", { class: "gp-legend" },
    h("span", { class: "dot open" }), "등록 가능 ", h("span", { class: "dot partial" }), "조건부·일부 ", h("span", { class: "dot closed" }), "마감 ",
    homes.length ? h("span", { class: "dot home" }) : null, homes.length ? "관심 동네" : null);
  sec.append(h("div", { class: "gp-tools" }, toggle), mapEl, legend, list,
    h("p", { class: "board-note" },
      "출처: ", h("a", { href: gp.source, target: "_blank", rel: "noopener noreferrer" }, "한인.nz 뉴질랜드 한인 GP 목록"),
      ` · ${gp.updated_at.slice(5).replace("-", "/")} 확인. 의사 이동·등록 가능 여부는 수시로 바뀌니 방문 전 꼭 전화로 확인하세요. 지도 © OpenStreetMap`));

  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let layer: import("leaflet").LayerGroup | null = null;
  let map: import("leaflet").Map | null = null;
  const shown = () => akl.filter((c) => !onlyOpen || statusClass(c.status) === "open").sort((a, b) => near(a) - near(b) || a.name.localeCompare(b.name));

  const draw = () => {
    list.replaceChildren(...shown().map((c) => h("li", {}, clinicInfo(h, c, nearName(c)))));
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const pts: [number, number][] = [];
    for (const c of shown()) {
      if (!c.latlon) continue;
      pts.push(c.latlon);
      L.circleMarker(c.latlon, { radius: 8, weight: 2, color: "#fff", fillColor: COLORS[statusClass(c.status)], fillOpacity: 0.95 })
        .bindPopup(clinicInfo(h, c, nearName(c)))
        .addTo(layer);
    }
    for (const x of homes) {
      pts.push(x.at);
      L.circleMarker(x.at, { radius: 6, weight: 2, color: "#1d4ed8", fillColor: "#93c5fd", fillOpacity: 0.9 })
        .bindTooltip(x.s, { direction: "top", className: "gp-home-label" })
        .addTo(layer);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24], maxZoom: 13 });
  };
  toggle.addEventListener("click", () => {
    onlyOpen = !onlyOpen;
    toggle.setAttribute("aria-pressed", String(onlyOpen));
    draw();
  });
  draw();
  // 화면에 붙은 뒤 지도 초기화 (크기 계산 필요)
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.85, 174.76], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    layer = L.layerGroup().addTo(map);
    draw();
  }).catch(() => mapEl.replaceChildren(h("p", { class: "muted" }, "지도를 불러오지 못했어요 (오프라인). 아래 목록을 이용하세요.")));
  return sec;
}
