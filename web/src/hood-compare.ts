// 동네 비교: 치안(보도 건수)·렌트·시내 거리를 동네별로 나란히 (AI 없음, 데일리 브리프가 가진 데이터만)
// 역할 분담: 학교(학군·EQI·성적)와 매매가 비교는 '이주 설계실'이 맡고, 여기서는 다루지 않는다(데이터를 옮겨 오지 않음).
import type { Incident } from "./crimemap";

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string>, ...children: (Node | string | null | undefined)[]) => HTMLElementTagNameMap[K];
interface Rent { median: number; bonds: number }
interface AreaSub { rent?: { period?: string; house?: Record<string, Rent> } }
export interface CompareOpts {
  watch: string[];
  areas: { suburbs: Record<string, AreaSub>; rent_source?: string } | null;
  incidents: Incident[];
  coords: Record<string, [number, number]>;
  link: (url: string, label: string) => HTMLElement;
}

const KEY = "daily-brief:hood-compare";
const CBD: [number, number] = [-36.8485, 174.7633];
const km = (a: [number, number], b: [number, number]) => {
  const R = 6371, r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const money = (v: number | null | undefined, unit = "") => (v == null ? "—" : `$${v.toLocaleString("en-NZ")}${unit}`);

export function compareCard(h: H, o: CompareOpts): HTMLElement {
  const all = [...new Set([...Object.keys(o.areas?.suburbs ?? {}), ...Object.keys(o.coords)])].sort();
  let picked: string[];
  try { picked = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { picked = null as unknown as string[]; }
  if (!Array.isArray(picked) || !picked.length) picked = o.watch.slice(0, 4);
  picked = picked.filter((s) => all.includes(s)).slice(0, 4);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(picked)); } catch { /* 저장 불가 */ } };

  const box = h("section", { class: "hood-card hood-cmp" });
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const recent = o.incidents.filter((e) => e.date >= since);

  function metrics(s: string) {
    const lc = s.toLowerCase(), at = o.coords[s];
    const inc = recent.filter((e) => (e.suburb || "").toLowerCase() === lc);
    const near = at ? recent.filter((e) => e.latlon && (e.precision ?? "exact") === "exact" && km(at, e.latlon) <= 1.5 && (e.suburb || "").toLowerCase() !== lc) : [];
    const rent = o.areas?.suburbs[s]?.rent?.house?.["3"];
    return { inc, s1: inc.filter((e) => e.severity === "1").length, near: near.filter((e) => e.severity === "1").length,
      rent: rent && rent.bonds >= 5 ? rent.median : null, rentBonds: rent?.bonds ?? 0, dist: at ? km(at, CBD) : null, at };
  }

  function draw() {
    const ms = picked.map((s) => [s, metrics(s)] as const);
    const minOf = (f: (m: ReturnType<typeof metrics>) => number | null) => {
      const xs = ms.map(([, m]) => f(m)).filter((v): v is number => v != null);
      return xs.length > 1 ? Math.min(...xs) : null;
    };
    const best = { inc: minOf((m) => m.inc.length), rent: minOf((m) => m.rent), dist: minOf((m) => m.dist) };
    const td = (v: string, hi = false, sub = "") => h("td", hi ? { class: "best" } : {}, v, sub ? h("small", {}, sub) : null);
    const rows: [string, string, (m: ReturnType<typeof metrics>, s: string) => HTMLElement][] = [
      ["🚨 치안", "최근 90일 보도 건수 (1급)", (m) => td(`${m.inc.length}건`, best.inc === m.inc.length, ` 1급 ${m.s1}${m.near ? ` · 주변 1.5km 1급 ${m.near}` : ""}`)],
      ["🏠 렌트", "3침실 주택 주간 중위", (m) => td(money(m.rent, "/주"), best.rent != null && m.rent === best.rent, m.rent != null ? ` 본드 ${m.rentBonds}건` : m.rentBonds ? " 신고 5건 미만" : "")],
      ["🚗 시내까지", "직선거리 (추정)", (m, s) => {
        const c = td(m.dist != null ? `${m.dist.toFixed(1)}km` : "—", best.dist != null && m.dist === best.dist);
        if (m.at) c.append(h("br"), o.link(`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(s + ", Auckland")}&destination=${encodeURIComponent("Britomart, Auckland")}&travelmode=transit`, "실제 경로"));
        return c;
      }],
    ];
    const head = h("tr", {}, h("th", {}, ""), ...ms.map(([s]) => {
      const x = h("button", { type: "button", class: "chip small", "aria-label": `${s} 빼기` }, "✕");
      x.addEventListener("click", () => { picked = picked.filter((p) => p !== s); save(); draw(); });
      return h("th", {}, s, " ", x);
    }));
    const body = rows.map(([lab, sub, f]) => h("tr", {}, h("th", { scope: "row" }, lab, h("small", {}, sub)), ...ms.map(([s, m]) => f(m, s))));
    const input = h("input", { type: "text", list: "hood-cmp-list", placeholder: picked.length >= 4 ? "최대 4곳 (하나를 빼고 추가)" : "동네 추가 (예: Epsom)", "aria-label": "비교할 동네 추가" }) as HTMLInputElement;
    if (picked.length >= 4) input.disabled = true;
    const dl = h("datalist", { id: "hood-cmp-list" }, ...all.filter((s) => !picked.includes(s)).map((s) => h("option", { value: s })));
    input.addEventListener("change", () => {
      const v = all.find((s) => s.toLowerCase() === input.value.trim().toLowerCase());
      if (v && !picked.includes(v) && picked.length < 4) { picked.push(v); save(); draw(); } else input.value = "";
    });
    box.replaceChildren(
      h("h2", {}, "⚖️ 동네 비교"),
      h("p", { class: "board-note" }, "치안·렌트·시내 거리를 한 표로 봅니다. 초록 칸은 고른 동네 중 가장 낮은 값입니다. 학교(학군·EQI)와 매매가 비교는 '이주 설계실'에서 보세요."),
      h("div", { class: "hood-cmp-add" }, input, dl),
      picked.length ? h("div", { class: "tbl-scroll" }, h("table", { class: "hood-cmp-table" }, h("thead", {}, head), h("tbody", {}, ...body)))
        : h("p", { class: "muted" }, "비교할 동네를 위 칸에서 골라 주세요 (최대 4곳). 설정의 '관심 동네'가 처음에 들어갑니다."),
      h("ul", { class: "hood-cmp-notes" },
        h("li", {}, "치안: 뉴스에 보도된 사건 수일 뿐 실제 범죄율이 아닙니다(큰 사건·인구 많은 동네일수록 많이 보도). '주변 1.5km'는 장소가 확인된 1급 사건만 셉니다."),
        h("li", {}, "렌트: 주택임대차 본드 신고 중위값", o.areas?.rent_source ? h("span", {}, " (", o.link(o.areas.rent_source, "Tenancy Services"), ")") : null, ". 신고가 5건 미만이면 표시하지 않습니다."),
        h("li", {}, "시내까지: 동네 중심에서 Britomart 까지 직선거리(추정)입니다. 실제 통근 시간은 '실제 경로'로 확인하세요.")));
  }
  draw();
  return box;
}
