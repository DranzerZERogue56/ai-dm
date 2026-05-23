import { useEffect, useState } from "react";
import type { Invite, Participant } from "@ai-dm/shared";
import { api } from "../lib/api";

interface Props {
  campaignId: string;
  dmToken: string;
  participants: Participant[];
  open: boolean;
  onClose: () => void;
}

export function InviteManager({ campaignId, dmToken, participants, open, onClose }: Props) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ displayName: string; role: "dm" | "player" }>({
    displayName: "",
    role: "dm",
  });

  async function refresh() {
    if (!dmToken) return;
    const r = await fetch(api(`/api/campaigns/${encodeURIComponent(campaignId)}/invites`), {
      headers: { "x-invite-token": dmToken },
    });
    if (!r.ok) { setError(`load failed: ${r.status}`); return; }
    const data = await r.json();
    setInvites(data?.invites ?? []);
    setError(null);
  }
  useEffect(() => { if (open) refresh(); }, [open, campaignId, dmToken]);

  async function createInvite() {
    if (!form.displayName.trim()) { setError("Display name required."); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(api(`/api/campaigns/${encodeURIComponent(campaignId)}/invites`), {
        method: "POST",
        headers: { "content-type": "application/json", "x-invite-token": dmToken },
        body: JSON.stringify({ displayName: form.displayName.trim(), role: form.role }),
      });
      if (!r.ok) { setError(`create failed: ${r.status}`); return; }
      setForm({ displayName: "", role: form.role });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string, name: string) {
    if (!confirm(`Revoke ${name}'s invite? They'll be kicked from the room if connected, and any future use of the token will be rejected.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(api(`/api/campaigns/${encodeURIComponent(campaignId)}/invites/${encodeURIComponent(token)}/revoke`), {
        method: "POST",
        headers: { "x-invite-token": dmToken },
      });
      if (!r.ok) { setError(`revoke failed: ${r.status}`); return; }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function magicLinkFor(token: string): string {
    const url = new URL(window.location.href);
    url.search = `?c=${encodeURIComponent(campaignId)}&inv=${encodeURIComponent(token)}`;
    return url.toString();
  }

  const onlineTokens = new Set(participants.map((p) => p.id));

  if (!open) return null;
  return (
    <div className="invite-overlay" onClick={onClose}>
      <div className="invite-panel" onClick={(e) => e.stopPropagation()}>
        <div className="invite-panel-header">
          <span>CO-DM INVITES — {campaignId}</span>
          <button className="btn" onClick={onClose}>close</button>
        </div>
        {error && <div className="invite-error">{error}</div>}

        <div className="invite-form" style={{ gridTemplateColumns: "2fr 1fr auto" }}>
          <label>name<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="e.g. Sam" /></label>
          <label>role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as any })}>
              <option value="dm">co-DM</option>
              <option value="player">player (legacy)</option>
            </select>
          </label>
          <button className="btn" disabled={busy} onClick={createInvite}>+ issue invite</button>
        </div>

        <table className="invite-table">
          <thead>
            <tr>
              <th>name</th>
              <th>role</th>
              <th>online</th>
              <th>created</th>
              <th>last used</th>
              <th>magic link</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <tr><td colSpan={7} style={{ color: "var(--phosphor-dim)", textAlign: "center", padding: 16 }}>
                no invites yet — issue one above to add a co-DM
              </td></tr>
            )}
            {invites.map((inv) => {
              const isOnline = onlineTokens.has(inv.token);
              const link = magicLinkFor(inv.token);
              return (
                <tr key={inv.token} className={inv.revokedAt ? "invite-revoked" : ""}>
                  <td><strong>{inv.displayName}</strong><br /><code style={{ fontSize: 10, color: "var(--phosphor-dim)" }}>{inv.token}</code></td>
                  <td>{inv.role}</td>
                  <td>
                    {inv.revokedAt ? <span style={{ color: "var(--danger)" }}>revoked</span>
                      : isOnline ? <span className="invite-dot-on" title="online">● online</span>
                      : <span className="invite-dot-off" title="offline">○ offline</span>}
                  </td>
                  <td style={{ color: "var(--phosphor-dim)", fontSize: 10 }}>{inv.createdAt.slice(0, 19)}</td>
                  <td style={{ color: "var(--phosphor-dim)", fontSize: 10 }}>{inv.lastUsedAt?.slice(0, 19) ?? "never"}</td>
                  <td>
                    {!inv.revokedAt && (
                      <button className="btn" style={{ fontSize: 10 }}
                        onClick={() => navigator.clipboard.writeText(link)}
                        title="copy the magic link to share via DM"
                      >📋 copy link</button>
                    )}
                  </td>
                  <td>
                    {!inv.revokedAt && (
                      <button className="btn"
                        style={{ fontSize: 10, color: "var(--danger)", borderColor: "var(--danger)" }}
                        onClick={() => revoke(inv.token, inv.displayName)}
                      >revoke</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ color: "var(--phosphor-dim)", fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--amber)" }}>Friend-level note:</strong> all co-DMs have equal powers —
          edit codex, invoke AI, pause AI, mint or revoke other invites. Trust accordingly.
          Send magic links via Discord DM, not public channels. Revoke at the end of an arc to keep
          the token list clean.
        </div>
      </div>
    </div>
  );
}
