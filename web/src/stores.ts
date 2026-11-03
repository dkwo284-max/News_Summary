// 울월쓰·케미스트웨어하우스까지의 직선거리: data/stores.json (OpenStreetMap, 한 달에 한 번 갱신, scripts/stores.py)
import { km } from "./gpmap";

export interface Store { n: string; ll: [number, number] }
export interface StoreData {
  updated_at: string;
  source: string;
  chains: Record<"woolworths" | "chemist", { label: string; stores: Store[] }>;
}

let cache: StoreData | null | undefined;
export async function loadStores(): Promise<StoreData | null> {
  if (cache !== undefined) return cache;
  try {
    const r = await fetch("data/stores.json", { cache: "no-cache" });
    cache = r.ok ? ((await r.json()) as StoreData) : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** 동네 중심에서 가장 가까운 매장 (직선거리 km) */
export function nearestStore(data: StoreData | null, at: [number, number] | undefined, chain: "woolworths" | "chemist"): { s: Store; d: number } | null {
  const list = data?.chains[chain]?.stores;
  if (!at || !list?.length) return null;
  let best: { s: Store; d: number } | null = null;
  for (const s of list) {
    const d = km(at, s.ll);
    if (!best || d < best.d) best = { s, d };
  }
  return best;
}
