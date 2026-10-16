// 환율·날씨 실시간 새로고침: 브라우저에서 무료 공개 API(키 불필요, CORS 허용)를 직접 호출한다.
export interface LiveData {
  fx: number | null;
  weather: { now: number; max: number; min: number; desc: string; rain?: number } | null;
  at: string; // ISO
}

const KEY = "daily-brief:live";

const WMO_KO: Record<number, string> = {
  0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
  51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "어는 이슬비",
  61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "어는 비",
  71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
  80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "눈 소나기", 86: "강한 눈 소나기",
  95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 뇌우",
};

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function fetchFx(): Promise<number | null> {
  const urls = [
    "https://api.frankfurter.dev/v1/latest?base=NZD&symbols=KRW",
    "https://api.frankfurter.app/latest?from=NZD&to=KRW",
  ];
  for (const u of urls) {
    try {
      const j = await getJSON(u);
      const v = Number(j?.rates?.KRW);
      if (Number.isFinite(v)) return Math.round(v * 100) / 100;
    } catch {
      /* 다음 주소 시도 */
    }
  }
  return null;
}

async function fetchWeather(): Promise<LiveData["weather"]> {
  try {
    const j = await getJSON(
      "https://api.open-meteo.com/v1/forecast?latitude=-36.8485&longitude=174.7633" +
        "&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&timezone=Pacific%2FAuckland&forecast_days=1",
    );
    return {
      now: Math.round(j.current.temperature_2m),
      max: Math.round(j.daily.temperature_2m_max[0]),
      min: Math.round(j.daily.temperature_2m_min[0]),
      desc: WMO_KO[j.current.weather_code] ?? "알 수 없음",
      rain: j.daily.precipitation_probability_max?.[0] ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function fetchLive(): Promise<LiveData> {
  const [fx, weather] = await Promise.all([fetchFx(), fetchWeather()]);
  if (fx == null && weather == null) throw new Error("live fetch failed");
  const data: LiveData = { fx, weather, at: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
  return data;
}

/** 마지막으로 새로고침한 값 (6시간 이내만 사용) */
export function loadLive(): LiveData | null {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "null") as LiveData | null;
    if (d && Date.now() - new Date(d.at).getTime() < 6 * 3600 * 1000) return d;
  } catch {
    /* ignore */
  }
  return null;
}
