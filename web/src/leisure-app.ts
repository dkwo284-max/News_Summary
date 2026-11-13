// '주말 나들이' 앱: 데일리 브리프의 레저 화면을 따로 연 페이지 (같은 데이터·같은 화면 코드, 브리프 없이도 열림)
import "./style.css";
import { applySettings, loadSettings } from "./settings";
import { loadGP } from "./gpmap";
import { loadWatch } from "./areas";
import { leisureView } from "./leisure";
import type { Brief } from "./types";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c);
  return el;
}
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const extLink = (url: string, label: string) => h("a", { href: safeUrl(url), target: "_blank", rel: "noopener noreferrer" }, label);

async function start(): Promise<void> {
  applySettings(loadSettings());
  const main = document.getElementById("main")!;
  const [brief, gp] = await Promise.all([
    fetch("data/latest.json", { cache: "no-cache" }).then((r) => (r.ok ? (r.json() as Promise<Brief>) : null)).catch(() => null),
    loadGP(),
  ]);
  const when = document.getElementById("when");
  if (when) when.textContent = new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long", timeZone: "Pacific/Auckland" }) + " · 오클랜드";
  const view = await leisureView(h, { suburbs: loadWatch().suburbs, gp, fx: brief?.extras?.nzd_krw, link: extLink, week: brief?.extras?.auckland_weather?.days });
  main.replaceChildren(view);
  main.removeAttribute("aria-busy");
}
void start();
if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
