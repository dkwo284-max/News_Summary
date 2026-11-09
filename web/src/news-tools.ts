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
