// "오늘 가기 좋은가": Open-Meteo 시간별 예보로 활동별 점수를 낸다(참고용 — 해상 안전은 MetService·코스트가드 확인).
export type Level = "good" | "ok" | "bad";
export interface Hourly {
  time: string[];
  temperature_2m?: (number | null)[];
  precipitation_probability?: (number | null)[];
  wind_speed_10m?: (number | null)[];
  wind_gusts_10m?: (number | null)[];
  wave_height?: (number | null)[];
}
export interface DayStats { date: string; temp: number; rain: number; wind: number; gust: number; wave: number | null }
export interface Verdict { level: Level; text: string }
export type Activity = "golf" | "sailing" | "kayak" | "fishing" | "kids" | "swim";

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

/** 날짜별(현지 시각 8~18시) 평균·최대. time 은 "YYYY-MM-DDTHH:00" 형식 */
export function dayStats(forecast: Hourly, marine: Hourly | null, fromHour = 8, toHour = 18): DayStats[] {
  const days = [...new Set(forecast.time.map((t) => t.slice(0, 10)))];
  return days.map((date) => {
    const idx = forecast.time.map((t, i) => (t.startsWith(date) && +t.slice(11, 13) >= fromHour && +t.slice(11, 13) <= toHour ? i : -1)).filter((i) => i >= 0);
    const pick = (arr?: (number | null)[]) => nums(idx.map((i) => arr?.[i]));
    let wave: number | null = null;
    if (marine) {
      const mi = marine.time.map((t, i) => (t.startsWith(date) && +t.slice(11, 13) >= fromHour && +t.slice(11, 13) <= toHour ? i : -1)).filter((i) => i >= 0);
      const w = nums(mi.map((i) => marine.wave_height?.[i]));
      wave = w.length ? Math.max(...w) : null;
    }
    const rain = pick(forecast.precipitation_probability);
    const gust = pick(forecast.wind_gusts_10m);
    return { date, temp: avg(pick(forecast.temperature_2m)), rain: rain.length ? Math.max(...rain) : 0, wind: avg(pick(forecast.wind_speed_10m)), gust: gust.length ? Math.max(...gust) : 0, wave };
  });
}

const r = (n: number) => Math.round(n);

/** 풍속 단위는 노트(kn), 파고는 m */
export function verdict(activity: Activity, d: DayStats): Verdict {
  const facts = `💨${r(d.wind)}(${r(d.gust)})kn ☔${r(d.rain)}%${d.wave != null ? ` 🌊${d.wave.toFixed(1)}m` : ""}`;
  const wave = d.wave ?? 0;
  if (activity === "golf") {
    if (d.rain >= 60 || d.gust >= 35) return { level: "bad", text: `비·강풍 — ${facts}` };
    if (d.rain >= 30 || d.gust >= 25 || d.temp < 10) return { level: "ok", text: `보통 — ${facts} · ${r(d.temp)}°C` };
    return { level: "good", text: `좋음 — ${facts} · ${r(d.temp)}°C` };
  }
  if (activity === "sailing") {
    if (d.wind > 25 || d.gust > 35 || d.rain >= 70) return { level: "bad", text: `바람 강함 — ${facts}` };
    if (d.wind >= 8 && d.wind <= 20 && d.gust < 30 && d.rain < 60) return { level: "good", text: `세일링 적당 — ${facts}` };
    return { level: "ok", text: `${d.wind < 8 ? "바람 약함" : "다소 거침"} — ${facts}` };
  }
  if (activity === "kayak") {
    if (d.wind > 15 || d.gust > 22 || wave > 0.9) return { level: "bad", text: `비추천 — ${facts}` };
    if (d.wind <= 10 && d.gust <= 16 && wave <= 0.5) return { level: "good", text: `잔잔함 — ${facts}` };
    return { level: "ok", text: `보통 — ${facts}` };
  }
  if (activity === "kids") {
    // 키즈카페·실내 놀이터: 비 오거나 쌀쌀한 날 특히 좋음
    if (d.rain >= 50 || d.temp < 14 || d.gust >= 30) return { level: "good", text: `실내 놀이 추천 — ${facts} · ${r(d.temp)}°C` };
    return { level: "ok", text: `야외도 좋은 날 — ${facts} · ${r(d.temp)}°C` };
  }
  if (activity === "swim") {
    // 실내 수영장은 날씨 무관, 해변·야외 풀은 기온·바람 영향
    if (d.temp >= 21 && d.wind <= 14 && d.rain < 40) return { level: "good", text: `야외 수영도 좋음 — ${facts} · ${r(d.temp)}°C` };
    return { level: "ok", text: `실내 수영장 추천 — ${facts} · ${r(d.temp)}°C` };
  }
  // fishing
  if (d.wind > 20 || wave > 1.5 || d.gust > 30) return { level: "bad", text: `비추천 — ${facts}` };
  if (d.wind <= 12 && wave <= 0.8) return { level: "good", text: `좋음 — ${facts}` };
  return { level: "ok", text: `보통 — ${facts}` };
}
