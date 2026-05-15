let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export type BeepKind = "new" | "update" | "delete";

export function beep(kind: BeepKind = "new") {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  // CRT-blip envelope: short, decaying, with a small pitch drop.
  const freq = kind === "new" ? 880 : kind === "update" ? 660 : 440;
  o.type = "square";
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 0.6), t + 0.09);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.14);
}

const KEY = "ai-dm.sound";
export function getSoundEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(KEY) === "1";
}
export function setSoundEnabled(on: boolean) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(KEY, on ? "1" : "0");
}
