// 지역별 민족 구성 지도: Stats NZ 2023 인구총조사(동네=SA2 단위)의 거주자 구성. 범죄 자료가 아닙니다.
// 데이터: data/census-akl.json (scripts/census.py). 큰 분류 6개만 공개 자료에 있어, 한국·중국·동남아 등 세부는 통계청 API 키가 필요합니다.
type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

interface Props { c: string; n: string; t: number; g: number[]; t18: number; g18: number[] }
interface Census { features: { type: "Feature"; geometry: unknown; properties: Props }[] }

interface Group { key: string; i: number; label: string; short: string; sub: string; hue: number }
// i = census-akl.json 의 g 배열 위치 (european, maori, pacific, asian, melaa, other)
const GROUPS: Group[] = [
  { key: "asian", i: 3, label: "아시아계", short: "아시아", sub: "한국·중국·인도·동남아 등을 합친 값", hue: 28 },
  { key: "european", i: 0, label: "유럽계", short: "유럽", sub: "영국·유럽 등", hue: 215 },
  { key: "melaa", i: 4, label: "중동·라틴·아프리카계", short: "중동 등", sub: "세 지역이 합쳐진 분류", hue: 280 },
  { key: "pacific", i: 2, label: "태평양계", short: "태평양", sub: "사모아·통가 등", hue: 170 },
  { key: "maori", i: 1, label: "마오리", short: "마오리", sub: "", hue: 140 },
  { key: "other", i: 5, label: "기타", short: "기타", sub: "", hue: 0 },
];

let cache: Census | null | undefined;
async function load(): Promise<Census | null> {
  if (cache !== undefined) return cache;
  try {
    const r = await fetch("data/census-akl.json", { cache: "no-cache" });
    cache = r.ok ? ((await r.json()) as Census) : null;
  } catch {
    cache = null;
  }
  return cache;
}

const share = (p: Props, g: Group) => (p.t ? (p.g[g.i] / p.t) * 100 : 0);
const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const ramp = (hue: number, step: number) => `hsl(${hue} ${hue === 0 ? 0 : 70}% ${92 - step * 15}%)`; // step 0(연함)~4(진함)

/** 분위수 기준 5단계 경계 (인구가 너무 적은 동네는 제외하고 계산) */
function breaks(values: number[]): number[] {
  const v = [...values].sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.floor(q * (v.length - 1))]);
}
const classOf = (x: number, br: number[]) => br.filter((b) => x > b).length;

export async function ethnicSection(h: H, watched: string[]): Promise<HTMLElement> {
  const sec = h("section", { class: "hood-card eth" }, h("h2", {}, "🌏 지역별 민족 구성 지도"));
  const data = await load();
  if (!data) {
    sec.append(h("p", { class: "muted" }, "민족 구성 데이터를 불러오지 못했어요."));
    return sec;
  }
  const feats = data.features;
  const total = feats.reduce((s, f) => s + f.properties.t, 0);
  const avg = (g: Group) => (feats.reduce((s, f) => s + f.properties.g[g.i], 0) / total) * 100;
  let cur = GROUPS[0];

  const chips = h("div", { class: "gp-tools eth-chips" });
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "지역별 민족 구성 지도" });
  const legend = h("p", { class: "gp-legend" });
  const find = h("input", { type: "text", list: "eth-sa2", placeholder: "동네 찾기 (예: Albany, Parnell)", "aria-label": "동네 찾기" });
  const dl = h("datalist", { id: "eth-sa2" }, ...feats.map((f) => h("option", { value: f.properties.n })));
  const mine = h("div", { class: "table-wrap" });
  sec.append(
    h("p", { class: "board-note" }, "2023 인구총조사 거주자의 민족 구성이에요. ", h("b", {}, "범죄와는 무관한 인구 분포"), "이며, 한 사람이 여러 민족을 답할 수 있어 비율의 합이 100%를 넘을 수 있어요."),
    chips, h("div", { class: "eth-find" }, find, dl), mapEl, legend, mine,
    h("p", { class: "board-note" },
      "출처: Stats NZ 2023 Census (동네 = Statistical Area 2). 통계청이 소수 값을 무작위로 반올림해 인구가 적은 동네는 오차가 큽니다. ",
      "공개 자료에는 큰 분류만 있어 한국·중국·동남아·미국 등 세부 구분은 아직 없어요(아시아계에 합쳐짐, 미국계는 별도 분류 없음)."));

  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let map: import("leaflet").Map | null = null;
  let layer: import("leaflet").GeoJSON | null = null;
  const watchedRe = watched.map((w) => w.toLowerCase());
  const isMine = (n: string) => watchedRe.some((w) => n.toLowerCase().startsWith(w));

  function detail(p: Props): HTMLElement {
    return h("div", { class: "gp-info" }, h("strong", {}, p.n), h("div", { class: "muted" }, `거주자 약 ${p.t.toLocaleString("ko-KR")}명 (2023)`),
      h("ul", { class: "eth-bars" }, ...GROUPS.map((g) => {
        const s = share(p, g), s18 = p.t18 ? (p.g18[g.i] / p.t18) * 100 : null;
        const d = s18 != null ? Math.round(s - s18) : null;
        return h("li", {}, h("span", { class: "eth-name" }, g.label),
          h("span", { class: "eth-track" }, h("i", { style: `width:${Math.min(100, s)}%;background:${ramp(g.hue, 3)}` })),
          h("span", { class: "eth-val" }, pct(s), d ? h("small", { class: d > 0 ? "up" : "down" }, ` ${d > 0 ? "▲" : "▼"}${Math.abs(d)}`) : ""));
      })),
      h("div", { class: "muted", style: "font-size:.75rem" }, "▲▼ = 2018년 대비 %p 변화"));
  }

  function draw() {
    legend.replaceChildren();
    const vals = feats.filter((f) => f.properties.t >= 300).map((f) => share(f.properties, cur));
    const br = breaks(vals);
    legend.append(h("strong", {}, `${cur.label} 비율`), cur.sub ? ` (${cur.sub}) ` : " ",
      ...[0, 1, 2, 3, 4].flatMap((k) => [h("span", { class: "dot", style: `background:${ramp(cur.hue, k)};border:1px solid #9ca3af` }),
        `${k === 0 ? `~${pct(br[0])}` : k === 4 ? `${pct(br[3])}~` : `${pct(br[k - 1])}~${pct(br[k])}`} `]),
      h("span", { class: "muted" }, `· 오클랜드 전체 ${pct(avg(cur))}`));
    chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.g === cur.key)));
    if (!L || !map) return;
    layer?.remove();
    layer = L.geoJSON(data as unknown as import("geojson").GeoJsonObject, {
      style: (f) => {
        const p = f!.properties as Props;
        const mineHere = isMine(p.n);
        return { fillColor: ramp(cur.hue, classOf(share(p, cur), br)), fillOpacity: 0.85, color: mineHere ? "#1d4ed8" : "#ffffff", weight: mineHere ? 2.5 : 0.6 };
      },
      onEachFeature: (f, lyr) => {
        const p = f.properties as Props;
        lyr.bindTooltip(`${p.n} · ${cur.label} ${pct(share(p, cur))}`, { sticky: true });
        lyr.bindPopup(detail(p), { maxWidth: 260 });
        lyr.on("mouseover", () => (lyr as import("leaflet").Path).setStyle({ weight: 2.5, color: "#111827" }));
        lyr.on("mouseout", () => layer?.resetStyle(lyr as import("leaflet").Path));
      },
    }).addTo(map);
  }

  for (const g of GROUPS) {
    const b = h("button", { type: "button", class: "chip", "data-g": g.key, "aria-pressed": String(g === cur) }, g.label);
    b.addEventListener("click", () => {
      cur = g;
      draw();
    });
    chips.append(b);
  }
  find.addEventListener("change", () => {
    const f = feats.find((x) => x.properties.n.toLowerCase() === find.value.trim().toLowerCase()) ??
      feats.find((x) => x.properties.n.toLowerCase().startsWith(find.value.trim().toLowerCase()) && find.value.trim().length >= 3);
    if (!f || !L || !map || !layer) return;
    layer.eachLayer((lyr) => {
      const gl = lyr as import("leaflet").GeoJSON & { feature?: { properties: Props } };
      if (gl.feature?.properties.c === f.properties.c) {
        map!.fitBounds((lyr as import("leaflet").Polygon).getBounds(), { maxZoom: 14 });
        (lyr as import("leaflet").Path).openPopup();
      }
    });
  });

  // 관심 동네 요약표: 관심 동네에 걸리는 SA2 합산 vs 오클랜드 평균
  const rows = watched.map((w) => {
    const m = feats.filter((f) => f.properties.n.toLowerCase().startsWith(w.toLowerCase()));
    const t = m.reduce((s, f) => s + f.properties.t, 0);
    return { w, t, s: GROUPS.map((g) => (t ? (m.reduce((s, f) => s + f.properties.g[g.i], 0) / t) * 100 : null)) };
  }).filter((r) => r.t > 0);
  if (rows.length) {
    mine.append(h("table", { class: "hood-table" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "관심 동네"), ...GROUPS.slice(0, 5).map((g) => h("th", { scope: "col" }, g.short)))),
      h("tbody", {}, ...rows.map((r) => h("tr", {}, h("th", { scope: "row" }, r.w), ...r.s.slice(0, 5).map((v) => h("td", {}, v == null ? "—" : pct(v))))),
        h("tr", { class: "avg-row" }, h("th", { scope: "row" }, "오클랜드 평균"), ...GROUPS.slice(0, 5).map((g) => h("td", {}, pct(avg(g))))))));
  }

  draw();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([mod]) => {
    if (!mapEl.isConnected) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.86, 174.77], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    draw();
  }).catch(() => mapEl.replaceChildren(h("p", { class: "muted" }, "지도를 불러오지 못했어요 (오프라인).")));
  return sec;
}
