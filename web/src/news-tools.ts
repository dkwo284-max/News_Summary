// 매일 보는 편의 기능 (AI 없음, 이 기기에만 저장):
//  - 새 소식만: 지난 브리핑(최근 3일)에 이미 나왔던 기사·같은 이슈 반복 기사·'지난 소식'을 숨긴다
//  - 이슈 팔로우: 기사를 팔로우하면 이후 브리핑에 같은 이슈의 새 기사가 나올 때 맨 위에 모아 보여준다
import type { Brief, Item } from "./types";

const NEW_KEY = "daily-brief:new-only";
const FOLLOW_KEY = "daily-brief:follows";

const STOP = new Set(`the a an of in on for to and or after as at by with from new zealand zealand's nz auckland auckland's says say said
over into about more its his her their is are be will has have had up out amid first than this that what why how who
not no but was were been being can could would should may might before off down just now still also year years
day days week weeks today mum dad man woman people`.split(/\s+/));

/** 제목 핵심어 (scripts/rank.py 의 _keys 와 같은 규칙): 영어 4글자 이상 앞 5글자, 한국어 2글자 이상 어절의 앞 2글자 */
export function titleKeys(...titles: (string | undefined)[]): Set<string> {
  const t = titles.filter(Boolean).join(" ").toLowerCase();
  const en = (t.match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5));
  const ko = (t.match(/[가-힣]{2,}/g) ?? []).map((w) => w.slice(0, 2));
  return new Set([...en, ...ko]);
}
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

// ── 새 소식만 ──
export function loadNewOnly(): boolean {
  try {
    return localStorage.getItem(NEW_KEY) === "1";
  } catch {
    return false;
  }
}
export function saveNewOnly(v: boolean): void {
  try {
    localStorage.setItem(NEW_KEY, v ? "1" : "0");
  } catch {
    /* 무시 */
  }
}

export interface SeenIndex { ids: Set<string>; keys: Set<string>[] }

/** 오늘 브리핑 이전 n개 브리핑의 기사 id·제목 핵심어 */
export function buildSeen(today: Brief, recent: Brief[], n = 3): SeenIndex {
  const prev = recent.filter((b) => b.date < today.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  const ids = new Set<string>();
  const keys: Set<string>[] = [];
  for (const b of prev) for (const sec of Object.values(b.sections)) for (const it of sec.items) {
    ids.add(it.id);
    keys.push(titleKeys(it.title_ko, it.original_title));
  }
  return { ids, keys };
}

/** 지난 소식인가: 이어 온 기사, 지난 브리핑에 같은 id, 또는 제목 핵심어 4개 이상이 겹치는 반복 기사 (흐름이 붙은 후속 보도는 새 소식으로 둔다) */
export function isOld(item: Item, seen: SeenIndex | null): boolean {
  if (item.carried_from) return true;
  if (!seen) return false;
  if (seen.ids.has(item.id)) return true;
  if (item.changed) return false; // AI 가 '달라진 점'을 찾은 후속 보도
  const k = titleKeys(item.title_ko, item.original_title);
  return k.size >= 4 && seen.keys.some((p) => overlap(k, p) >= 4);
}

// ── 이슈 팔로우 ──
export interface Follow { id: string; title: string; keys: string[]; since: string }

export function loadFollows(): Follow[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]") as Follow[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveFollows(f: Follow[]): void {
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(f.slice(-30)));
  } catch {
    /* 무시 */
  }
}
export function isFollowed(item: Item): boolean {
  return loadFollows().some((f) => f.id === item.id || (item.timeline ?? []).some((t) => t.id === f.id));
}
export function toggleFollow(item: Item, date: string): boolean {
  const all = loadFollows();
  const i = all.findIndex((f) => f.id === item.id || (item.timeline ?? []).some((t) => t.id === f.id));
  if (i >= 0) {
    all.splice(i, 1);
    saveFollows(all);
    return false;
  }
  all.push({ id: item.id, title: item.title_ko, keys: [...titleKeys(item.title_ko, item.original_title)], since: date });
  saveFollows(all);
  return true;
}
export function unfollow(id: string): void {
  saveFollows(loadFollows().filter((f) => f.id !== id));
}

/** 팔로우한 이슈별로 오늘 브리핑에 나온 관련 기사 (같은 기사, 흐름에 그 기사가 있는 후속 보도, 제목 핵심어 3개 이상 겹침) */
export function followUpdates(brief: Brief): { follow: Follow; items: { item: Item; section: string }[] }[] {
  const out: { follow: Follow; items: { item: Item; section: string }[] }[] = [];
  for (const f of loadFollows()) {
    const fk = new Set(f.keys);
    const items: { item: Item; section: string }[] = [];
    const seen = new Set<string>();
    for (const [key, sec] of Object.entries(brief.sections)) {
      for (const it of sec.items) {
        if (seen.has(it.id)) continue;
        const hit = it.id === f.id || (it.timeline ?? []).some((t) => t.id === f.id) || overlap(titleKeys(it.title_ko, it.original_title), fk) >= 3;
        if (hit) {
          seen.add(it.id);
          items.push({ item: it, section: key === "nz_immigration" ? "이민 레이더" : sec.label });
        }
      }
    }
    out.push({ follow: f, items });
  }
  return out;
}

// ── 교육 주제 분류 (규칙 기반, AI 없음) ──
export interface EduTopic { key: string; label: string; icon: string; color: string; words: RegExp }
/** 위에서부터 먼저 맞는 주제 하나로 분류 (안전·징계처럼 학부모가 먼저 봐야 할 것을 앞에) */
export const EDU_TOPICS: EduTopic[] = [
  { key: "safety", label: "안전·징계", icon: "🛡️", color: "#dc2626", words: /안전|폭행|학대|괴롭힘|왕따|징계|재판소|체포|사고|위험|보안|사건|bully|assault|abuse|discipline|tribunal|safety|police|lockdown/i },
  { key: "admission", label: "학군·입학", icon: "🏫", color: "#2563eb", words: /학군|입학|등록|전학|정원|학교 신설|통학|zone|enrol|roll|new school|intake|waitlist/i },
  { key: "teacher", label: "교사·인력", icon: "👩‍🏫", color: "#7c3aed", words: /교사|교원|교직|파업|임금|노조|인력|채용|교장|보조 교사|teacher|principal|strike|pay|union|staff|nzeI|ppta/i },
  { key: "life", label: "급식·시설·복지", icon: "🍎", color: "#16a34a", words: /급식|점심|건강|시설|건물|교실|예산|지원금|복지|결석|출석|지각|도서관|운동장|lunch|school meal|building|property|attendance|absence|funding|ka ora/i },
  { key: "policy", label: "정책·교육과정", icon: "📘", color: "#d97706", words: /정책|교육과정|커리큘럼|개혁|평가|시험|문해|수학|읽기|ncea|ero|curriculum|reform|literacy|maths|assessment|review|ministry|minister|검토|법안|장관/i },
  { key: "higher", label: "대학·유학생", icon: "🎓", color: "#0d9488", words: /대학|유학생|학위|연구|학자금|polytech|university|student loan|international student|tertiary|학부|대학원/i },
];
export const EDU_OTHER: EduTopic = { key: "other", label: "기타", icon: "📌", color: "#6b7280", words: /./ };

export function eduTopic(item: Item): EduTopic {
  const text = `${item.title_ko} ${(item.summary_ko ?? []).join(" ")} ${item.original_title ?? ""} ${(item.tags ?? []).join(" ")}`;
  return EDU_TOPICS.find((t) => t.words.test(text)) ?? EDU_OTHER;
}

// ── 저장한 기사 (이 기기에만 저장) ──
const SAVED_KEY = "daily-brief:saved";
export interface Saved { id: string; title: string; url: string; date: string; section: string; at: string }
export function loadSaved(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]") as Saved[];
  } catch {
    return [];
  }
}
function putSaved(v: Saved[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(v.slice(0, 200)));
  } catch {
    /* 무시 */
  }
}
export const isSaved = (id: string): boolean => loadSaved().some((x) => x.id === id);
export function removeSaved(id: string): void {
  putSaved(loadSaved().filter((x) => x.id !== id));
}
/** 저장/해제 토글. 저장하면 true */
export function toggleSaved(item: Item, date: string, section: string): boolean {
  const list = loadSaved();
  if (list.some((x) => x.id === item.id)) {
    putSaved(list.filter((x) => x.id !== item.id));
    return false;
  }
  putSaved([{ id: item.id, title: item.title_ko, url: item.sources[0]?.url ?? "", date, section, at: new Date().toISOString() }, ...list]);
  return true;
}

// ── 🔤 뉴스 영어 표현 → English Trainer 복습: 기사 영어 제목(또는 그 일부)을 영어 앱의 '복습 문장 직접 추가'로 보낸다 ──
// 영어 앱 주소는 계정마다 달라(…workers.dev) 처음 한 번만 입력받아 이 기기에 저장한다. 서버로 보내는 것 없음.
const ENG_KEY = "daily-brief:english-url";
export function englishUrl(): string {
  try { return localStorage.getItem(ENG_KEY) || ""; } catch { return ""; }
}
export function setEnglishUrl(u: string): boolean {
  const v = u.trim().replace(/\/+$/, "");
  if (v && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(v)) return false;
  try { if (v) localStorage.setItem(ENG_KEY, v); else localStorage.removeItem(ENG_KEY); } catch { /* 무시 */ }
  window.dispatchEvent(new CustomEvent("english-url"));   // 화면에 떠 있는 모든 기사 카드에 바로 반영
  return true;
}
/** 영어 앱으로 보낼 주소: ?add=문장&from=news&ko=한국어 제목(뜻 참고용) */
export function englishAddUrl(base: string, text: string, ko = ""): string {
  const q = new URLSearchParams({ add: text.trim().slice(0, 600), from: "news" });
  if (ko) q.set("ko", ko.slice(0, 200));
  return `${base}/?${q.toString()}`;
}
export function englishPanel(en: string, ko: string): HTMLElement {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
    const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x;
  };
  const box = el("details", "eng");
  box.append(el("summary", "", "🔤 영어로 익히기"));
  const body = el("div", "eng-body");
  box.append(body);
  const draw = (): void => {
    body.replaceChildren();
    const base = englishUrl();
    if (!base) {
      body.append(el("p", "muted", "처음 한 번만: English Trainer 주소를 넣어 주세요 (예: https://english-trainer.<계정>.workers.dev). 한 번 넣으면 모든 기사에 적용되고, ⚙ 설정에서도 바꿀 수 있어요."));
      const inp = el("input", "eng-url"); inp.type = "url"; inp.placeholder = "https://english-trainer.….workers.dev"; inp.setAttribute("aria-label", "English Trainer 주소");
      const save = el("button", "follow-btn", "저장"); save.type = "button";
      const msg = el("small", "muted");
      save.addEventListener("click", () => { if (setEnglishUrl(inp.value) && inp.value.trim()) draw(); else msg.textContent = "https:// 로 시작하는 주소를 넣어 주세요"; });
      body.append(el("div", "eng-row"), msg); body.querySelector(".eng-row")!.append(inp, save);
      return;
    }
    body.append(el("p", "muted", "익히고 싶은 부분만 남기고 보내세요. 영어 앱이 뜻·문법·원어민이 말로 할 때의 자연스러운 문장을 검토해 복습에 넣어 줘요."));
    const ta = el("textarea", "eng-text"); ta.rows = 2; ta.value = en; ta.lang = "en"; ta.setAttribute("aria-label", "보낼 영어 문장");
    const go = el("a", "follow-btn eng-go", "영어 앱 복습에 추가 ↗"); go.target = "_blank"; go.rel = "noopener";
    const upd = (): void => { go.setAttribute("href", englishAddUrl(base, ta.value || en, ko)); };
    ta.addEventListener("input", upd); upd();
    const row = el("div", "eng-row"); row.append(go);
    body.append(ta, row);
  };
  // 펼칠 때 그리고(그때의 저장 주소 사용), 다른 카드·설정에서 주소를 바꾸면 펼쳐 둔 카드도 다시 그림
  let drawn = false;
  box.addEventListener("toggle", () => { if (box.open && !drawn) { drawn = true; draw(); } });
  const onChange = (): void => { if (!box.isConnected) { window.removeEventListener("english-url", onChange); return; } if (drawn) draw(); };
  window.addEventListener("english-url", onChange);
  return box;
}
