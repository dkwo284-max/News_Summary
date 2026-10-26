export interface Source {
  name: string;
  url: string;
}

export interface Item {
  id: string;
  title_ko: string;
  summary_ko: string[];
  why_it_matters?: string;
  tags: string[];
  importance: number;
  sources: Source[];
  original_title?: string;
  published_at?: string | null;
  radar?: number;
  carried_from?: string; // 그날 새 소식이 없어 최근 브리핑에서 이어 온 기사
}

export interface Section {
  label: string;
  briefing: string;
  items: Item[];
}

export type SectionKey =
  | "kr_society"
  | "kr_economy"
  | "kr_entertainment"
  | "kr_politics"
  | "nz_national" // 이전 브리핑(10/19 이전) 호환
  | "nz_society"
  | "nz_education"
  | "nz_economy"
  | "nz_politics"
  | "nz_auckland" // 이전 브리핑(10/27 이전) 호환
  | "akl_life"
  | "akl_health"
  | "akl_education"
  | "akl_safety"
  | "akl_property"
  | "nz_immigration";

export interface Brief {
  date: string;
  generated_at: string;
  timezone: string;
  sections: Record<SectionKey, Section>;
  extras: {
    nzd_krw: number | null;
    auckland_weather: { max: number; min: number; desc: string; rain_chance?: number } | null;
    processing_times?: { updated_at: string; items: ProcessingItem[] };
    living_costs?: LivingCosts;
  };
  meta?: { mode?: string; failed_feeds?: { id: string; name?: string; error: string }[]; alerts?: Alert[] };
}

export interface ArchiveIndex {
  dates: string[];
}

export interface ProcessingItem {
  key: string;
  name: string;
  group: string;
  p50: string;
  p90: string;
  pct: number | null;
  sub: string;
  note: string;
  url: string;
  as_of: string;
  status: "ok" | "stale" | "missing";
  trend?: { since: string; prev_p90: string; delta_days: number };
}

export interface Alert {
  kind: "processing" | "radar";
  text: string;
  url: string;
}

export interface FuelPrice {
  date: string;
  nzd_per_l: number;
  wow_cents?: number;
}

export interface LivingCosts {
  updated_at: string;
  rent?: { month: string; median: number; lower: number | null; upper: number | null; yoy_pct?: number; source: string; url: string } | null;
  fuel?: { source: string; url: string; petrol91?: FuelPrice; petrol95?: FuelPrice; diesel?: FuelPrice } | null;
}
