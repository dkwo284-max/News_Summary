// 오클랜드 → 레저 칩: 골프장·요트·카약·낚시. 데이터는 data/leisure.json (공식 페이지에서 연 1회 수집, scripts/leisure.py).
// 요금은 "확인일"과 공식 링크를 함께 보여주고, 평점은 직접 적은 값(data) 또는 이 기기에서 입력한 값(localStorage)만 씁니다.
import { km, type GPData } from "./gpmap";
import { dayStats, verdict, type Activity, type Hourly, type Level } from "./leisure-score";

type H = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string | null | undefined)[]
) => HTMLElementTagNameMap[K];

type Kind = "golf" | "sailing" | "kayak" | "fishing";
interface Fee { label: string; kind: string; amount: number; period: string; quote?: string; source?: string }
interface Rating { v: number; n?: number; asof?: string }
interface Facility {
  id: string; kind: Kind; name: string; area?: string; ll: [number, number] | null; home?: string; gmaps: string;
  fees: Fee[]; status?: string; season?: string; note?: string; checked?: string; rating?: Rating; src?: string[];
}
interface LeisureData { updated_at: string; source: string; facilities: Facility[] }

export interface LeisureOpts {
  suburbs: string[];
  gp: GPData | null;
  fx: number | null | undefined;
  link: (url: string, label: string) => HTMLElement;
}

const KINDS: { key: Kind; label: string; activity: Activity }[] = [
  { key: "golf", label: "⛳ 골프", activity: "golf" },
  { key: "sailing", label: "⛵ 요트·세일링", activity: "sailing" },
  { key: "kayak", label: "🛶 카약·패들", activity: "kayak" },
  { key: "fishing", label: "🎣 낚시", activity: "fishing" },
];
const CBD: [number, number] = [-36.8485, 174.7633];
const PERIOD: Record<string, string> = { year: "/년", season: "/시즌", month: "/월", week: "/주", day: "/일", hour: "/시간", round: "/라운드", once: " (1회)", person: "/인" };
const STATUS: Record<string, string> = { open: "가입 가능", waitlist: "대기 명단", closed: "신규 마감", unknown: "미확인" };
const RATING_KEY = "daily-brief:leisure-ratings";

async function load(): Promise<LeisureData | null> {
  try {
    const r = await fetch("data/leisure.json", { cache: "no-cache" });
    return r.ok ? ((await r.json()) as LeisureData) : null;
  } catch {
    return null;
  }
}

function localRatings(): Record<string, Rating> {
  try {
    return JSON.parse(localStorage.getItem(RATING_KEY) || "{}") as Record<string, Rating>;
  } catch {
    return {};
  }
}
function saveRating(id: string, r: Rating | null): void {
  try {
    const all = localRatings();
    if (r) all[id] = r;
    else delete all[id];
    localStorage.setItem(RATING_KEY, JSON.stringify(all));
  } catch {
    /* 저장 불가(시크릿 모드 등) — 화면에서만 반영 */
  }
}

const num = (n: number) => n.toLocaleString("en-NZ", { maximumFractionDigits: 2 });
const monthsAgo = (asof: string): number | null => {
  const m = /^(\d{4})-(\d{2})/.exec(asof);
  if (!m) return null;
  const now = new Date();
  return (now.getFullYear() - +m[1]) * 12 + (now.getMonth() + 1 - +m[2]);
};
const feeOf = (f: Facility, kind: string): Fee | undefined => f.fees.find((x) => x.kind === kind);
const yearly = (f: Facility, kind: string): number | null => {
  const x = feeOf(f, kind);
  return x && (x.period === "year" || x.period === "season") ? x.amount : null;
};

export async function leisureView(h: H, o: LeisureOpts): Promise<HTMLElement> {
  const root = h("div", { class: "leisure" });
  const data = await load();
  const mine = localRatings();
  let kind: Kind = "golf";
  let sort = "dist";
  let krw = false;
  let base = o.suburbs.find((s) => o.gp?.suburbs[s]) ?? "";
  let selected: string | null = null; // 상세를 펼친 시설 (골프는 표 아래, 나머지는 카드 안)

  const money = (amount: number, period = "") => {
    const nz = `$${num(amount)}${PERIOD[period] ?? ""}`;
    return krw && o.fx ? `${nz} ≈ ${Math.round((amount * o.fx) / 10000).toLocaleString("ko-KR")}만원` : nz;
  };
  const origin = (): [number, number] => (base && o.gp?.suburbs[base]) || CBD;
  const dist = (f: Facility) => (f.ll ? km(origin(), f.ll) : null);
  const ratingOf = (f: Facility): Rating | undefined => f.rating ?? mine[f.id];

  root.append(h("section", { class: "hood-card" },
    h("h2", {}, "🏌️ 레저 — 골프·요트·카약·낚시"),
    h("p", { class: "board-note" },
      "요금은 각 시설 공식 사이트에서 연 1회 읽어 정리한 값이고 ", h("b", {}, "확인일"), "을 함께 보여줘요. 금액은 NZD, 클럽은 입회 심사·대기가 있을 수 있어 가입 전 공식 사이트나 전화로 꼭 확인하세요. ",
      "구글 평점은 약관상 자동 수집하지 않아요 — 직접 적은 값이 있으면 기준 시점과 함께 보이고, 없으면 지도 링크로 보세요(이 기기에 직접 입력도 가능).")));

  // 오늘 가기 좋은가
  const today = h("section", { class: "hood-card leisure-today" }, h("h2", {}, "🌤️ 오늘·내일 가기 좋은가"), h("p", { class: "muted" }, "예보를 불러오는 중…"));
  root.append(today);

  const controls = h("div", { class: "leisure-controls" });
  const list = h("div", {});
  root.append(controls, list);

  function present(): Kind[] {
    return KINDS.map((k) => k.key).filter((k) => data?.facilities.some((f) => f.kind === k));
  }

  function renderControls() {
    const chips = h("div", { class: "chips", role: "group", "aria-label": "레저 종류" }, ...KINDS.map((k) => {
      const b = h("button", { type: "button", class: "chip", "aria-pressed": String(kind === k.key) }, k.label);
      b.addEventListener("click", () => { kind = k.key; renderAll(); });
      return b;
    }));
    const baseSel = h("select", { "aria-label": "거리 기준 동네" }, h("option", { value: "" }, "기준: 시내(CBD)"),
      ...o.suburbs.filter((s) => o.gp?.suburbs[s]).map((s) => h("option", { value: s }, `기준: ${s}`)));
    baseSel.value = base;
    baseSel.addEventListener("change", () => { base = baseSel.value; renderList(); });
    const sortSel = h("select", { "aria-label": "정렬" },
      h("option", { value: "dist" }, "가까운 순"), h("option", { value: "fee" }, "연회비 낮은 순"),
      h("option", { value: "rating" }, "평점 높은 순"), h("option", { value: "name" }, "이름순"));
    sortSel.value = sort;
    sortSel.addEventListener("change", () => { sort = sortSel.value; renderList(); });
    const krwBox = h("input", { type: "checkbox", id: "leisure-krw" });
    krwBox.checked = krw;
    krwBox.disabled = !o.fx;
    krwBox.addEventListener("change", () => { krw = krwBox.checked; renderList(); });
    controls.replaceChildren(chips, h("div", { class: "leisure-row" }, baseSel, sortSel,
      h("label", { class: "leisure-krw", for: "leisure-krw" }, krwBox, o.fx ? ` 원화 환산 (1NZD≈${Math.round(o.fx).toLocaleString("ko-KR")}원)` : " 원화 환산(환율 없음)")));
  }

  const sorted = (items: Facility[]): Facility[] => {
    const val = (f: Facility): number => {
      if (sort === "fee") return yearly(f, "adult") ?? Number.POSITIVE_INFINITY;
      if (sort === "rating") return -(ratingOf(f)?.v ?? -1);
      if (sort === "name") return 0;
      return dist(f) ?? Number.POSITIVE_INFINITY;
    };
    return [...items].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : val(a) - val(b)));
  };

  function ratingCell(f: Facility): HTMLElement {
    const r = ratingOf(f);
    if (!r) return h("td", { class: "muted" }, "—");
    const age = r.asof ? monthsAgo(r.asof) : null;
    return h("td", {}, `★${r.v.toFixed(1)}`, r.n ? h("small", {}, `${r.n.toLocaleString("ko-KR")}건`) : null,
      r.asof ? h("small", { class: age != null && age >= 9 ? "old" : "" }, `${r.asof}${age != null && age >= 9 ? " (오래됨)" : ""}`) : null);
  }

  function breakEven(f: Facility): HTMLElement {
    const box = h("div", { class: "leisure-calc" });
    const member = yearly(f, "adult"), joining = feeOf(f, "joining")?.amount ?? 0, g18 = feeOf(f, "greenfee18")?.amount ?? null;
    if (member == null || g18 == null) {
      box.append(h("p", { class: "muted" }, "회원 vs 방문자 손익분기 계산은 성인 연회비와 방문자 18홀 요금이 둘 다 있을 때만 해요."));
      return box;
    }
    const rounds = h("input", { type: "number", min: "1", max: "365", value: "40", "aria-label": "연 라운드 수" });
    const years = h("input", { type: "number", min: "1", max: "30", value: "5", "aria-label": "입회비 나눌 햇수" });
    const out = h("p", {});
    const calc = () => {
      const n = Math.max(1, +rounds.value || 1), y = Math.max(1, +years.value || 1);
      const memberCost = member + joining / y, visitor = g18 * n, be = Math.ceil(memberCost / g18);
      out.replaceChildren(`회원 연 ${money(memberCost)}${joining ? ` (입회비 ${money(joining)}를 ${y}년에 나눔)` : ""} vs 방문자 ${n}라운드 ${money(visitor)} → `,
        h("b", {}, memberCost < visitor ? `회원이 ${money(visitor - memberCost)} 유리` : `방문자가 ${money(memberCost - visitor)} 유리`),
        ` · 손익분기 약 연 ${be}라운드`);
    };
    [rounds, years].forEach((i) => i.addEventListener("input", calc));
    calc();
    box.append(h("div", { class: "leisure-calc-in" }, "연 ", rounds, "라운드 · 입회비 ", years, "년 분할"), out,
      h("p", { class: "muted" }, "방문자 요금은 클럽·요일·제휴 여부에 따라 달라요. 카트·연습장·클럽 행사 비용은 포함하지 않았어요."));
    return box;
  }

  function ratingForm(f: Facility): HTMLElement {
    const r = ratingOf(f);
    const v = h("input", { type: "number", step: "0.1", min: "1", max: "5", placeholder: "4.5", value: r ? String(r.v) : "", "aria-label": "평점" });
    const n = h("input", { type: "number", min: "0", placeholder: "리뷰 수", value: r?.n ? String(r.n) : "", "aria-label": "리뷰 수" });
    const save = h("button", { type: "button", class: "link-btn" }, "이 기기에 저장");
    save.addEventListener("click", () => {
      const val = parseFloat(v.value);
      if (!(val >= 1 && val <= 5)) return;
      const d = new Date();
      mine[f.id] = { v: val, n: +n.value || undefined, asof: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` };
      saveRating(f.id, mine[f.id]);
      renderList();
    });
    const clear = h("button", { type: "button", class: "link-btn" }, "지우기");
    clear.addEventListener("click", () => { delete mine[f.id]; saveRating(f.id, null); renderList(); });
    return h("div", { class: "leisure-rate" }, h("span", { class: "muted" }, "구글 지도 평점 직접 입력: "), v, n, save, mine[f.id] ? clear : null);
  }

  function detail(f: Facility): HTMLElement {
    const d = h("div", { class: "leisure-detail" });
    const rows = f.fees.map((x) => h("li", {}, h("strong", {}, money(x.amount, x.period)), ` ${x.label}`,
      x.source === "manual" ? h("small", { class: "muted" }, " (직접 확인)") : null));
    d.append(rows.length ? h("ul", { class: "leisure-fees" }, ...rows) : h("p", { class: "muted" }, "요금을 자동으로 읽지 못했어요. 공식 사이트·전화로 확인하세요."));
    const meta = [f.season ? `적용 시즌: ${f.season}` : "", f.status ? `상태: ${STATUS[f.status] ?? f.status}` : "", f.checked ? `확인일 ${f.checked}` : "확인 전"].filter(Boolean).join(" · ");
    d.append(h("p", { class: "muted" }, meta));
    if (f.note) d.append(h("p", {}, `ℹ️ ${f.note}`));
    if (f.kind === "golf") d.append(breakEven(f));
    d.append(ratingForm(f));
    const links = h("div", { class: "hood-links" }, o.link(f.gmaps, "🗺️ 구글 지도·리뷰"));
    if (f.home) links.append(o.link(f.home, "🌐 공식 사이트"));
    for (const s of (f.src ?? []).filter((u) => u !== f.home).slice(0, 2)) links.append(o.link(s, "📄 요금 페이지"));
    d.append(links);
    return d;
  }

  function golfTable(items: Facility[]): HTMLElement {
    const head = h("tr", {}, ...["클럽", "거리", "성인 1", "커플(2인)", "가족", "입회비", "평점"].map((t) => h("th", { scope: "col" }, t)));
    const body: HTMLElement[] = [];
    for (const f of items) {
      const d = dist(f);
      const cell = (k: string) => {
        const x = feeOf(f, k);
        return x ? h("td", {}, money(x.amount, k === "joining" ? "" : x.period === "year" ? "" : x.period)) : h("td", { class: "muted" }, "—");
      };
      const name = h("button", { type: "button", class: "leisure-name", "aria-expanded": String(selected === f.id) }, f.name);
      name.addEventListener("click", () => { selected = selected === f.id ? null : f.id; renderList(); });
      const state = f.status && f.status !== "open" && f.status !== "unknown" ? h("small", { class: "tag" }, STATUS[f.status]) : null;
      body.push(h("tr", { class: selected === f.id ? "cur" : "" },
        h("th", { scope: "row" }, name, h("small", { class: "muted" }, `${f.area ?? ""}${f.checked ? "" : " · 요금 미확인"}`), state),
        h("td", {}, d != null ? `${d.toFixed(1)}km` : "—"), cell("adult"), cell("couple"), cell("family"), cell("joining"), ratingCell(f)));
    }
    return h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-table" }, h("thead", {}, head), h("tbody", {}, ...body)));
  }

  function cards(items: Facility[]): HTMLElement[] {
    return items.map((f) => {
      const d = dist(f);
      const top = f.fees.slice(0, 3).map((x) => `${x.label} ${money(x.amount, x.period)}`).join(" · ");
      const head = h("button", { type: "button", class: "leisure-name", "aria-expanded": String(selected === f.id) }, f.name);
      head.addEventListener("click", () => { selected = selected === f.id ? null : f.id; renderList(); });
      const r = ratingOf(f);
      const card = h("section", { class: "hood-card" },
        h("h3", {}, head, h("small", { class: "muted" }, ` ${f.area ?? ""}${d != null ? ` · ${d.toFixed(1)}km` : ""}`), r ? h("small", {}, ` ★${r.v.toFixed(1)}`) : null),
        h("p", {}, top || h("span", { class: "muted" }, "요금 미확인 — 공식 사이트에서 확인하세요")));
      if (selected === f.id) card.append(detail(f));
      return card;
    });
  }

  function fishingRules(): HTMLElement {
    return h("section", { class: "hood-card" }, h("h2", {}, "🎣 낚시 규칙 (꼭 확인)"),
      h("ul", { class: "leisure-fees" },
        h("li", {}, "바다 낚시: 일반적으로 면허는 필요 없지만 ", h("b", {}, "어종·지역별 1일 허용량(bag limit)과 최소 크기"), "가 있어요. 예) 스내퍼는 오클랜드 동해안 7마리·30cm 이상, 서해안 10마리·27cm 이상 (2024 기준, 바뀔 수 있음)."),
        h("li", {}, "민물 송어·연어 낚시는 Fish & Game 낚시 면허가 필요해요."),
        h("li", {}, "규칙 확인: 무료 앱 “NZ Fishing Rules”, 또는 어종 이름을 문자로 9889에 보내면 크기·허용량을 알려줘요."),
        h("li", {}, "보트: 구명조끼 착용, 출항 전 해상 예보·조석 확인, 출항 계획을 가족에게 알리기.")),
      h("div", { class: "hood-links" },
        o.link("https://www.mpi.govt.nz/fishing-aquaculture/recreational-fishing/fishing-rules/auckland-kermadec-fishing-rules", "📋 FNZ 오클랜드 낚시 규칙"),
        o.link("https://www.metservice.com/marine", "🌊 MetService 해상 예보"),
        o.link("https://www.coastguard.nz", "🛟 코스트가드 안전 정보"),
        o.link("https://fishandgame.org.nz", "🐟 Fish & Game 면허")));
  }

  function renderList() {
    const items = sorted((data?.facilities ?? []).filter((f) => f.kind === kind));
    const nodes: Node[] = [];
    if (!data) {
      list.replaceChildren(h("section", { class: "hood-card" }, h("p", { class: "muted" },
        "레저 데이터가 아직 없어요. GitHub Actions → “Leisure fees” 워크플로를 한 번 실행하면 생깁니다.")));
      return;
    }
    if (!items.length) nodes.push(h("section", { class: "hood-card" }, h("p", { class: "muted" }, "이 종류는 아직 목록이 없어요.")));
    else if (kind === "golf") {
      const sel = items.find((f) => f.id === selected);
      nodes.push(h("section", { class: "hood-card" }, h("h2", {}, `⛳ 골프장 회원권 (${items.length}곳)`), golfTable(items),
        sel ? h("div", { class: "leisure-panel" }, h("h3", {}, sel.name, h("small", { class: "muted" }, ` ${sel.area ?? ""}`)), detail(sel)) : null,
        h("p", { class: "board-note" }, `클럽 이름을 누르면 전체 요금·손익분기 계산·평점 입력이 열려요. 연회비는 성인 1인 정규(풀 플레잉) 기준, 커플은 성인 2인 합계예요. 칸이 “—”이면 공식 페이지에서 확인되지 않은 항목입니다. 갱신 ${data.updated_at}. 정회원 가입은 입회 심사·대기 명단이 있는 곳이 많고, 일부 클럽은 요금을 공개하지 않아요.`)));
    } else {
      nodes.push(h("section", { class: "hood-card" }, h("h2", {}, `${KINDS.find((k) => k.key === kind)?.label} (${items.length}곳)`),
        h("p", { class: "board-note" }, kind === "sailing" ? "클럽 회원비와 정박료는 구조가 달라요(정박료는 보트 길이별). 이름을 눌러 상세를 보세요." : kind === "kayak" ? "클럽 회비와 렌탈·투어 요금이에요. 투어는 날짜·인원에 따라 달라져요." : "공개 낚시 보트·차터 요금이에요. 프라이빗 차터는 훨씬 비쌉니다.")),
        ...cards(items));
      if (kind === "fishing") nodes.push(fishingRules());
    }
    list.replaceChildren(...nodes);
  }

  function renderAll() {
    renderControls();
    renderList();
  }
  const avail = present();
  if (data && avail.length && !avail.includes(kind)) kind = avail[0];
  renderAll();
  void forecast(h, today, o, origin());
  return root;
}

const lvIcon: Record<Level, string> = { good: "🟢", ok: "🟡", bad: "🔴" };

async function forecast(h: H, slot: HTMLElement, o: LeisureOpts, at: [number, number]): Promise<void> {
  const title = h("h2", {}, "🌤️ 오늘·내일 가기 좋은가");
  const note = h("p", { class: "board-note" }, "Open-Meteo 예보로 8~18시를 계산한 참고용 점수예요. 바다에 나가기 전에는 반드시 MetService 해상예보·조석을 확인하세요. 💨 풍속(돌풍) 노트 · ☔ 강수확률 · 🌊 파고");
  try {
    const [fc, mr] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${at[0]}&longitude=${at[1]}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_gusts_10m&wind_speed_unit=kn&timezone=Pacific%2FAuckland&forecast_days=2`).then((r) => r.json()),
      fetch("https://marine-api.open-meteo.com/v1/marine?latitude=-36.78&longitude=174.80&hourly=wave_height&timezone=Pacific%2FAuckland&forecast_days=2").then((r) => r.json()).catch(() => null),
    ]);
    const days = dayStats(fc.hourly as Hourly, (mr?.hourly as Hourly | undefined) ?? null);
    if (!days.length) throw new Error("no data");
    const label = ["오늘", "내일"];
    const rows = KINDS.map((k) => h("tr", {}, h("th", { scope: "row" }, k.label),
      ...days.slice(0, 2).map((d) => {
        const v = verdict(k.activity, d);
        return h("td", {}, `${lvIcon[v.level]} `, h("small", {}, v.text));
      })));
    slot.replaceChildren(title, h("div", { class: "table-wrap" }, h("table", { class: "hood-table leisure-weather" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "활동"), ...days.slice(0, 2).map((d, i) => h("th", { scope: "col" }, `${label[i]} (${d.date.slice(5).replace("-", "/")})`)))),
      h("tbody", {}, ...rows))), note);
  } catch {
    slot.replaceChildren(title, h("p", { class: "muted" }, "예보를 불러오지 못했어요 (오프라인이거나 일시 오류)."), note);
  }
}
