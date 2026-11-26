// 🎧 듣는 브리핑: 오늘 핵심·영향 큰 소식·탭별 브리핑을 한국어 음성(브라우저 내장 TTS)으로 읽어 준다. AI·서버 요청 없음.
// 문장 단위로 나눠 읽는다(Chrome 은 긴 문장을 15초쯤에서 끊는 문제가 있음). 일시정지는 '지금 문장 처음부터 다시'로 처리(모바일 pause 가 불안정).

export interface Track { title: string; text: string; readTitle?: boolean }   // readTitle=false: 제목은 목록에만, 읽지 않음(앵커 대본)

const RATES = [0.9, 1.0, 1.2, 1.4];
const RATE_KEY = "daily-brief:tts-rate";
let tracks: Track[] = [];
let ti = 0, ci = 0, playing = false, gen = 0;
let chunks: string[] = [];
let bar: HTMLElement | null = null;
let album = "데일리 브리프 듣기";
// 잠금 화면·이어폰 조작용: 폰 음성(TTS)만으로는 미디어 세션이 안 잡히는 기기가 많아, 소리 없는 오디오를 함께 틀어 둔다
let keep: HTMLAudioElement | null = null;
function silentUrl(): string {
  const n = 8000, b = new Uint8Array(44 + n), v = new DataView(b.buffer), w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, n, true); b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}
function keepAlive(on: boolean): void {
  try {
    if (on) { if (!keep) { keep = new Audio(silentUrl()); keep.loop = true; } void keep.play().catch(() => undefined); }
    else keep?.pause();
  } catch { /* 무시 */ }
}

const synth = (): SpeechSynthesis | null => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);
export const canListen = (): boolean => !!synth() && typeof SpeechSynthesisUtterance !== "undefined";

function rate(): number {
  try { const r = Number(localStorage.getItem(RATE_KEY)); if (RATES.includes(r)) return r; } catch { /* 무시 */ }
  return 1.0;
}

/** 읽기 좋게 다듬기: 이모지·주소·괄호 속 영어 원문 제거, 기호를 말로 */
export function speakable(s: string): string {
  return String(s || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/(\d)\s*~\s*(\d)/g, "$1에서 $2")
    .replace(/(\d)\s*%/g, "$1퍼센트")
    .replace(/NZ\$\s?/g, "뉴질랜드 달러 ")
    .replace(/[·•|]/g, ", ")
    .replace(/👉|→/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 문장 단위로 나누기(너무 긴 문장은 쉼표에서 한 번 더) */
export function splitChunks(text: string, max = 160): string[] {
  const out: string[] = [];
  for (const sent of speakable(text).split(/(?<=[.!?。])\s+/)) {
    if (!sent.trim()) continue;
    if (sent.length <= max) { out.push(sent.trim()); continue; }
    let cur = "";
    for (const part of sent.split(/(?<=,)\s*/)) {
      if ((cur + " " + part).length > max && cur) { out.push(cur.trim()); cur = part; } else cur = cur ? cur + " " + part : part;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

function koVoice(): SpeechSynthesisVoice | null {
  const vs = synth()?.getVoices() ?? [];
  const ko = vs.filter((v) => /^ko/i.test(v.lang));
  return ko.find((v) => /google|yuna|sora|natural|neural/i.test(v.name)) ?? ko[0] ?? null;
}

function speakChunk(): void {
  const s = synth();
  if (!s || !playing) return;
  if (ci >= chunks.length) { // 다음 트랙
    if (ti + 1 >= tracks.length) { playing = false; ti = tracks.length - 1; keepAlive(false); render("끝까지 들었어요 👏"); return; }
    loadTrack(ti + 1);
  }
  const my = ++gen;
  const u = new SpeechSynthesisUtterance(chunks[ci]);
  u.lang = "ko-KR"; u.rate = rate();
  const v = koVoice(); if (v) u.voice = v;
  u.onend = () => { if (my !== gen || !playing) return; ci++; speakChunk(); };
  u.onerror = (e) => { if (my !== gen || !playing) return; if ((e as SpeechSynthesisErrorEvent).error === "interrupted" || (e as SpeechSynthesisErrorEvent).error === "canceled") return; ci++; speakChunk(); };
  s.speak(u);
  render();
}

function loadTrack(i: number): void {
  ti = Math.max(0, Math.min(tracks.length - 1, i));
  ci = 0;
  chunks = [tracks[ti].readTitle === false ? "" : speakable(tracks[ti].title), ...splitChunks(tracks[ti].text)].filter(Boolean);
}

function stopSpeech(): void { gen++; synth()?.cancel(); }

function play(): void { stopSpeech(); playing = true; keepAlive(true); speakChunk(); }
function pause(): void { playing = false; stopSpeech(); keepAlive(false); render(); }
function goTo(i: number): void { if (i < 0 || i >= tracks.length) return; stopSpeech(); loadTrack(i); if (!playing) { playing = true; keepAlive(true); } speakChunk(); }
function jump(d: number): void {
  const next = ti + d;
  if (next < 0 || next >= tracks.length) return;
  stopSpeech(); loadTrack(next); if (playing) speakChunk(); else render();
}
export function closePlayer(): void { playing = false; stopSpeech(); keepAlive(false); bar?.remove(); bar = null; document.body.classList.remove("has-player"); }

function mediaSession(): void {
  const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
  if (!ms || typeof MediaMetadata === "undefined") return;
  try {
    ms.metadata = new MediaMetadata({ title: tracks[ti]?.title || "데일리 브리프", artist: album, album: "데일리 브리프" });
    ms.playbackState = playing ? "playing" : "paused";
    ms.setActionHandler("play", play);
    ms.setActionHandler("pause", pause);
    ms.setActionHandler("nexttrack", () => jump(1));
    ms.setActionHandler("previoustrack", () => jump(-1));
    try { ms.setActionHandler("seekforward", () => jump(1)); ms.setActionHandler("seekbackward", () => jump(-1)); ms.setActionHandler("stop", closePlayer); } catch { /* 일부 기기 미지원 */ }
  } catch { /* 지원 안 하는 기기 */ }
}

function render(note = ""): void {
  if (!bar) return;
  const t = tracks[ti];
  const q = (sel: string) => bar!.querySelector(sel) as HTMLElement;
  q(".lp-title").textContent = note || t?.title || "";
  q(".lp-pos").textContent = `${ti + 1}/${tracks.length}`;
  const pp = q(".lp-play");
  pp.textContent = playing ? "⏸" : "▶";
  pp.setAttribute("aria-label", playing ? "일시정지" : "재생");
  q(".lp-rate").textContent = `${rate()}×`;
  const ch = bar.querySelector(".lp-chapters");
  if (ch) ch.querySelectorAll("button[data-ti]").forEach((b) => b.classList.toggle("on", Number((b as HTMLElement).dataset.ti) === ti));
  (q(".lp-prev") as HTMLButtonElement).disabled = ti === 0;
  (q(".lp-next") as HTMLButtonElement).disabled = ti >= tracks.length - 1;
  const prog = q(".lp-prog");
  prog.style.width = `${tracks.length ? ((ti + (chunks.length ? ci / chunks.length : 0)) / tracks.length) * 100 : 0}%`;
  mediaSession();
}

function ensureBar(): HTMLElement {
  if (bar && bar.isConnected) return bar;
  bar = document.createElement("div");
  bar.className = "lp";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "브리핑 듣기");
  const btn = (cls: string, label: string, text: string) => `<button type="button" class="${cls}" aria-label="${label}">${text}</button>`;
  bar.innerHTML = `<div class="lp-bar"><i class="lp-prog"></i></div>
    <div class="lp-row"><span class="lp-ico" aria-hidden="true">🎧</span><div class="lp-info"><strong class="lp-title"></strong><small class="lp-pos muted"></small></div>
    ${btn("lp-prev", "이전 항목", "⏮")}${btn("lp-play", "재생", "▶")}${btn("lp-next", "다음 항목", "⏭")}${btn("lp-rate", "읽는 속도", "1×")}${btn("lp-list", "소식 목록", "☰")}${btn("lp-close", "닫기", "✕")}</div>
    <div class="lp-chapters" hidden></div>`;
  bar.querySelector(".lp-list")!.addEventListener("click", () => { const c = bar!.querySelector(".lp-chapters") as HTMLElement; c.hidden = !c.hidden; });
  bar.querySelector(".lp-chapters")!.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest("button[data-ti]") as HTMLElement | null; if (b) goTo(Number(b.dataset.ti)); });
  bar.querySelector(".lp-play")!.addEventListener("click", () => (playing ? pause() : play()));
  bar.querySelector(".lp-prev")!.addEventListener("click", () => jump(-1));
  bar.querySelector(".lp-next")!.addEventListener("click", () => jump(1));
  bar.querySelector(".lp-close")!.addEventListener("click", closePlayer);
  bar.querySelector(".lp-rate")!.addEventListener("click", () => {
    const r = RATES[(RATES.indexOf(rate()) + 1) % RATES.length];
    try { localStorage.setItem(RATE_KEY, String(r)); } catch { /* 무시 */ }
    if (playing) { stopSpeech(); speakChunk(); } else render();
  });
  document.body.append(bar);
  document.body.classList.add("has-player");
  return bar;
}

/** 재생 목록으로 듣기 시작 (이미 듣는 중이면 처음부터 새 목록으로) */
export function startListening(list: Track[], name = "데일리 브리프 듣기"): void {
  if (!canListen() || !list.length) return;
  tracks = list.filter((t) => t.text || t.title);
  album = name;
  ensureBar();
  const ch = bar!.querySelector(".lp-chapters") as HTMLElement;
  ch.innerHTML = tracks.map((t, i) => `<button type="button" data-ti="${i}"><span>${i + 1}</span>${t.title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string)}</button>`).join("");
  loadTrack(0);
  // 일부 브라우저는 목소리 목록이 늦게 온다: 한 번 기다렸다가 시작
  if (!(synth()?.getVoices().length)) synth()?.addEventListener?.("voiceschanged", () => undefined, { once: true });
  play();
}

export const isListening = (): boolean => !!bar && bar.isConnected;
