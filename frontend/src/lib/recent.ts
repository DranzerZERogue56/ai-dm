const KEY = "ai-dm.recent-campaigns";

export interface RecentCampaign {
  campaignId: string;
  name?: string;
  displayName: string;
  role: "dm" | "player";
  token?: string;
  lastJoinedAt: number;
}

export function loadRecent(): RecentCampaign[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentCampaign[];
    return parsed.sort((a, b) => b.lastJoinedAt - a.lastJoinedAt);
  } catch {
    return [];
  }
}

export function rememberJoin(entry: Omit<RecentCampaign, "lastJoinedAt">) {
  const list = loadRecent().filter((r) => r.campaignId !== entry.campaignId);
  list.unshift({ ...entry, lastJoinedAt: Date.now() });
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12)));
}

export function forgetCampaign(campaignId: string) {
  const list = loadRecent().filter((r) => r.campaignId !== campaignId);
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function forgetAll() {
  localStorage.removeItem(KEY);
}
