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
  | "nz_national"
  | "nz_auckland"
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
  };
  meta?: { mode?: string; failed_feeds?: { id: string; name?: string; error: string }[] };
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
  note: string;
  url: string;
  as_of: string;
  status: "ok" | "stale" | "missing";
}
