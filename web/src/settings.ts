// 사용자 설정: localStorage 에 저장 (사파리 개인정보 보호 모드 등에서 실패해도 동작하도록 try/catch)
export interface Settings {
  showPolitics: boolean;
  fontScale: number; // 0.9 | 1 | 1.15 | 1.3
  theme: "system" | "light" | "dark";
  tab: string;
}

const KEY = "daily-brief:settings";
const DEFAULTS: Settings = { showPolitics: false, fontScale: 1, theme: "system", tab: "akl" };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function applySettings(s: Settings): void {
  const root = document.documentElement;
  root.style.setProperty("--font-scale", String(s.fontScale));
  if (s.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", s.theme);
  const dark =
    s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0f172a" : "#ffffff");
}
