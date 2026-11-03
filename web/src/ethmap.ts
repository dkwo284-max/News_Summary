// 지역별 민족 구성 지도: Stats NZ 2023 인구총조사 거주자 구성. 범죄 자료가 아닙니다.
//  - 동네(SA2 640곳) 지도: 상세 3단계 분류 (data/census-akl.json, scripts/census_detail.py)
//  - 출신별 세부(지역위원회 21곳): 상세 4단계 — 미국인·캐나다인·러시아인·아랍·이란·브라질·멕시코 등 (data/census-akl-detail.json)
// 한 사람이 여러 민족을 답할 수 있어(복수 응답) 비율의 합이 100%를 넘을 수 있습니다.
type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

interface Props { c: string; n: string; t: number; t18: number; d: number[]; d18: number[] }
interface Census { codes: string[]; features: { type: "Feature"; geometry: unknown; properties: Props }[] }

interface Cat { key: string; label: string; sub: string; codes: string[]; hue: number; row: string }
// codes = 통계청 3단계 민족 코드(총 응답자 7777 기준). 여러 코드는 합산(복수 응답이라 겹치는 사람은 중복 집계될 수 있음)
const ROWS = ["아시아", "중동·남미·아프리카", "유럽", "태평양·마오리"];
const CATS: Cat[] = [
  { key: "asian", label: "아시아계 전체", sub: "한국·일본·중국·동남아·인도 등 모두 포함", codes: ["4"], hue: 28, row: ROWS[0] },
  { key: "korean", label: "한국인", sub: "", codes: ["443"], hue: 345, row: ROWS[0] },
  { key: "chinese", label: "중국인", sub: "홍콩·대만계 포함", codes: ["421"], hue: 18, row: ROWS[0] },
  { key: "japanese", label: "일본인", sub: "", codes: ["442"], hue: 300, row: ROWS[0] },
  { key: "sea", label: "동남아인", sub: "필리핀·베트남·캄보디아·태국·인도네시아 등", codes: ["410", "411", "412", "413", "414"], hue: 120, row: ROWS[0] },
  { key: "south", label: "인도·스리랑카계", sub: "", codes: ["431", "441"], hue: 55, row: ROWS[0] },
  { key: "middle", label: "중동계", sub: "아랍·이란·터키·이스라엘 등 (아시아계에 넣지 않음)", codes: ["511"], hue: 270, row: ROWS[1] },
  { key: "latin", label: "남미(라틴아메리카)계", sub: "", codes: ["521"], hue: 175, row: ROWS[1] },
  { key: "african", label: "아프리카계", sub: "", codes: ["531"], hue: 95, row: ROWS[1] },
  { key: "european", label: "유럽계 전체", sub: "미국·캐나다 출신 포함", codes: ["1"], hue: 215, row: ROWS[2] },
  { key: "nzeuro", label: "뉴질랜드 유럽계", sub: "", codes: ["111"], hue: 228, row: ROWS[2] },
  { key: "british", label: "영국·아일랜드계", sub: "", codes: ["121"], hue: 202, row: ROWS[2] },
  { key: "euother", label: "그 외 유럽계", sub: "독일·네덜란드·이탈리아·그리스·호주·미국 등", codes: ["122", "123", "124", "125", "126", "127", "128", "129"], hue: 190, row: ROWS[2] },
  { key: "pacific", label: "태평양계", sub: "사모아·통가·쿡제도 등", codes: ["3"], hue: 160, row: ROWS[3] },
  { key: "maori", label: "마오리", sub: "", codes: ["2"], hue: 140, row: ROWS[3] },
];
// 팝업·요약표에 보여줄 순서 = CATS 순서

let cache: Census | null | undefined;
async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { cache: "no-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
async function load(): Promise<Census | null> {
  if (cache === undefined) cache = await loadJson<Census>("data/census-akl.json");
  return cache;
}

/** 화면에 붙을 때까지 기다린다 (섹션은 데이터를 다 받은 뒤에 붙으므로 지도 초기화가 먼저 오면 안 됨). 5초 안에 안 붙으면 포기 */
function whenConnected(el: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => (el.isConnected ? resolve(true) : ++tries > 100 ? resolve(false) : setTimeout(tick, 50));
    tick();
  });
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const ramp = (hue: number, step: number) => `hsl(${hue} 70% ${92 - step * 15}%)`; // step 0(연함)~4(진함)

/** 값이 있는 동네만 분위수 5단계 (0 인 동네는 가장 연한 색) */
function breaks(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0, 0];
  return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.floor(q * (v.length - 1))]);
}
const classOf = (x: number, br: number[]) => br.filter((b) => x > b).length;

export async function ethnicSection(h: H, watched: string[]): Promise<HTMLElement> {
  const sec = h("section", { class: "hood-card eth" }, h("h2", {}, "🌏 지역별 민족 구성 지도"));
  const data = await load();
  if (!data || !data.codes) {
    sec.append(h("p", { class: "muted" }, "민족 구성 데이터를 불러오지 못했어요."));
    return sec;
  }
  const feats = data.features;
  const ix = Object.fromEntries(data.codes.map((c, i) => [c, i]));
  const count = (p: Props, cat: Cat, old = false) => cat.codes.reduce((s, c) => s + ((old ? p.d18 : p.d)[ix[c]] ?? 0), 0);
  const share = (p: Props, cat: Cat) => (p.t ? (count(p, cat) / p.t) * 100 : 0);
  const total = feats.reduce((s, f) => s + f.properties.t, 0);
  const avg = (cat: Cat) => (feats.reduce((s, f) => s + count(f.properties, cat), 0) / total) * 100;
  let cur = CATS[1]; // 한국인부터

  const chips = h("div", { class: "eth-chips" });
  const mapEl = h("div", { class: "gp-map", role: "region", "aria-label": "지역별 민족 구성 지도" });
  const legend = h("p", { class: "gp-legend" });
  const find = h("input", { type: "text", list: "eth-sa2", placeholder: "동네 찾기 (예: Albany, Newmarket)", "aria-label": "동네 찾기" });
  const dl = h("datalist", { id: "eth-sa2" }, ...feats.map((f) => h("option", { value: f.properties.n })));
  const mine = h("div", {});
  sec.append(
    h("p", { class: "board-note" }, "2023 인구총조사 거주자의 민족 구성이에요. ", h("b", {}, "범죄와는 무관한 인구 분포"), "이며, 한 사람이 여러 민족을 답할 수 있어 비율의 합이 100%를 넘을 수 있어요."),
    chips, h("div", { class: "eth-find" }, find, dl), mapEl, legend, mine,
    h("p", { class: "board-note" },
      "출처: Stats NZ 2023 Census (동네 = Statistical Area 2, 자료 CEN23_ECI_016). 통계청이 소수 값을 무작위로 반올림해 인구가 적은 동네는 오차가 큽니다. ",
      "미국인·캐나다인·아랍·브라질 등 더 세부 구분은 동네 단위 자료가 없어 아래 '출신별 세부(지역위원회)'에서 봅니다."));

  type Leaflet = typeof import("leaflet");
  let L: Leaflet | null = null;
  let map: import("leaflet").Map | null = null;
  let layer: import("leaflet").GeoJSON | null = null;
  const watchedLc = watched.map((w) => w.toLowerCase());
  const isMine = (n: string) => watchedLc.some((w) => n.toLowerCase().startsWith(w));

  function detail(p: Props): HTMLElement {
    return h("div", { class: "gp-info" }, h("strong", {}, p.n), h("div", { class: "muted" }, `응답자 약 ${p.t.toLocaleString("ko-KR")}명 (2023)`),
      h("ul", { class: "eth-bars" }, ...CATS.map((c) => {
        const s = share(p, c), s18 = p.t18 ? (count(p, c, true) / p.t18) * 100 : null;
        const d = s18 != null ? Math.round(s - s18) : null;
        return h("li", {}, h("span", { class: "eth-name" }, c.label.replace(" 전체", "")),
          h("span", { class: "eth-track" }, h("i", { style: `width:${Math.min(100, s)}%;background:${ramp(c.hue, 3)}` })),
          h("span", { class: "eth-val" }, pct(s), d ? h("small", { class: d > 0 ? "up" : "down" }, ` ${d > 0 ? "▲" : "▼"}${Math.abs(d)}`) : ""));
      })),
      h("div", { class: "muted", style: "font-size:.75rem" }, "▲▼ = 2018년 대비 %p 변화"));
  }

  function draw() {
    const vals = feats.filter((f) => f.properties.t >= 300).map((f) => share(f.properties, cur));
    const br = breaks(vals);
    legend.replaceChildren(h("strong", {}, `${cur.label} 비율`), cur.sub ? ` (${cur.sub}) ` : " ",
      ...[0, 1, 2, 3, 4].flatMap((k) => [h("span", { class: "dot", style: `background:${ramp(cur.hue, k)};border:1px solid #9ca3af` }),
        `${k === 0 ? `~${pct(br[0])}` : k === 4 ? `${pct(br[3])}~` : `${pct(br[k - 1])}~${pct(br[k])}`} `]),
      h("span", { class: "muted" }, `· 오클랜드 전체 ${pct(avg(cur))}`));
    chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === cur.key)));
    if (!L || !map) return;
    layer?.remove();
    layer = L.geoJSON(data as unknown as import("geojson").GeoJsonObject, {
      style: (f) => {
        const p = f!.properties as Props;
        const m = isMine(p.n);
        return { fillColor: ramp(cur.hue, classOf(share(p, cur), br)), fillOpacity: 0.85, color: m ? "#1d4ed8" : "#ffffff", weight: m ? 2.5 : 0.6 };
      },
      onEachFeature: (f, lyr) => {
        const p = f.properties as Props;
        lyr.bindTooltip(`${p.n} · ${cur.label} ${pct(share(p, cur))} (${count(p, cur).toLocaleString("ko-KR")}명)`, { sticky: true });
        lyr.bindPopup(detail(p), { maxWidth: 270 });
        lyr.on("mouseover", () => (lyr as import("leaflet").Path).setStyle({ weight: 2.5, color: "#111827" }));
        lyr.on("mouseout", () => layer?.resetStyle(lyr as import("leaflet").Path));
      },
    }).addTo(map);
  }

  // 분류 칩 (행별로 묶음)
  for (const row of ROWS) {
    const wrap = h("div", { class: "eth-row" }, h("span", { class: "eth-rowlabel" }, row));
    for (const c of CATS.filter((x) => x.row === row)) {
      const b = h("button", { type: "button", class: "chip", "data-k": c.key, "aria-pressed": String(c === cur) }, c.label);
      b.addEventListener("click", () => {
        cur = c;
        draw();
      });
      wrap.append(b);
    }
    chips.append(wrap);
  }
  find.addEventListener("change", () => {
    const q = find.value.trim().toLowerCase();
    const f = feats.find((x) => x.properties.n.toLowerCase() === q) ?? (q.length >= 3 ? feats.find((x) => x.properties.n.toLowerCase().startsWith(q)) : undefined);
    if (!f || !L || !map || !layer) return;
    layer.eachLayer((lyr) => {
      const gl = lyr as import("leaflet").Layer & { feature?: { properties: Props } };
      if (gl.feature?.properties.c === f.properties.c) {
        map!.fitBounds((lyr as import("leaflet").Polygon).getBounds(), { maxZoom: 14 });
        (lyr as import("leaflet").Path).openPopup();
      }
    });
  });

  // 관심 동네 비교표: 행 = 분류, 열 = 관심 동네 + 오클랜드 평균
  const cols = watched.map((w) => {
    const m = feats.filter((f) => f.properties.n.toLowerCase().startsWith(w.toLowerCase()));
    const t = m.reduce((s, f) => s + f.properties.t, 0);
    return { w, t, m };
  }).filter((c) => c.t > 0);
  if (cols.length) {
    mine.append(h("details", { class: "eth-mine", open: "" },
      h("summary", {}, "📍 관심 동네 비교표"),
      h("div", { class: "table-wrap" }, h("table", { class: "hood-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "분류"), ...cols.map((c) => h("th", { scope: "col" }, c.w)), h("th", { scope: "col" }, "오클랜드"))),
        h("tbody", {}, ...CATS.map((cat) => h("tr", {}, h("th", { scope: "row" }, cat.label.replace(" 전체", "").replace("(라틴아메리카)", "").replace(/계$/, "")),
          ...cols.map((c) => h("td", {}, pct((c.m.reduce((s, f) => s + count(f.properties, cat), 0) / c.t) * 100))),
          h("td", { class: "avg-row" }, pct(avg(cat))))))))));
  }

  draw();
  void Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css"), whenConnected(mapEl)]).then(([mod, , ok]) => {
    if (!ok) return;
    L = (mod as unknown as { default?: Leaflet }).default ?? (mod as unknown as Leaflet);
    map = L.map(mapEl, { scrollWheelZoom: false }).setView([-36.86, 174.77], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    draw();
  }).catch(() => mapEl.replaceChildren(h("p", { class: "muted" }, "지도를 불러오지 못했어요 (오프라인).")));
  return sec;
}

// ── 출신별 세부 (지역위원회 21곳, 상세 4단계) ──
interface Detail {
  boards: { c: string; n: string }[];
  total: number[];
  groups: { label: string; items: { label: string; code: string; v: number[] }[] }[];
}

export async function originSection(h: H): Promise<HTMLElement | null> {
  const d = await loadJson<Detail>("data/census-akl-detail.json");
  if (!d) return null;
  const all = d.boards.length - 1; // 마지막 = 오클랜드 전체
  const items = d.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })));
  let cur = items[0];
  const sel = h("select", { "aria-label": "출신 선택" }, ...d.groups.map((g) =>
    h("optgroup", { label: g.label }, ...g.items.map((it) => h("option", { value: it.code }, it.label)))));
  const list = h("div", { class: "eth-origin" });
  const sec = h("section", { class: "hood-card" },
    h("h2", {}, "🌍 출신별 세부 (지역위원회 21곳)"),
    h("p", { class: "board-note" }, "미국인·캐나다인·러시아인, 아랍·이란·터키, 브라질·멕시코 같은 세부 출신은 동네 단위 자료가 없고 ", h("b", {}, "오클랜드 지역위원회(21곳) 단위"), "로만 공개돼요. 위 동네 지도보다 거칠지만 어느 지역에 많은지 볼 수 있어요."),
    h("div", { class: "eth-find" }, sel), list,
    h("p", { class: "board-note" }, "출처: Stats NZ 2023 Census (CEN23_ECI_018, 복수 응답, 소수 값은 무작위 반올림). 비율 = 그 지역 응답자 중 해당 출신을 답한 사람."));
  function render() {
    const rows = d!.boards.slice(0, all).map((b, i) => ({ n: b.n, v: cur.v[i], s: d!.total[i] ? (cur.v[i] / d!.total[i]) * 100 : 0 })).sort((a, b) => b.s - a.s);
    const max = Math.max(0.01, ...rows.map((r) => r.s));
    const whole = d!.total[all] ? (cur.v[all] / d!.total[all]) * 100 : 0;
    list.replaceChildren(h("p", { class: "hood-news" }, `${cur.label} · 오클랜드 전체 ${cur.v[all].toLocaleString("ko-KR")}명 (${whole.toFixed(2)}%)`),
      h("ul", { class: "eth-bars eth-wide" }, ...rows.map((r) => h("li", {}, h("span", { class: "eth-name" }, r.n),
        h("span", { class: "eth-track" }, h("i", { style: `width:${(r.s / max) * 100}%;background:hsl(215 70% 55%)` })),
        h("span", { class: "eth-val" }, `${r.s.toFixed(r.s < 1 ? 2 : 1)}%`, h("small", { class: "muted" }, ` ${r.v.toLocaleString("ko-KR")}명`))))));
  }
  sel.addEventListener("change", () => {
    cur = items.find((it) => it.code === sel.value) ?? cur;
    render();
  });
  sel.value = cur.code;
  render();
  // 미국인이 있으면 처음부터 보여준다 (자주 찾는 항목)
  const us = items.find((it) => it.code === "12943");
  if (us) {
    cur = us;
    sel.value = us.code;
    render();
  }
  return sec;
}
