import { useEffect, useState } from "react";
import { loadRecent, rememberJoin, forgetCampaign, forgetAll, type RecentCampaign } from "../lib/recent";
import { api } from "../lib/api";

function urlParam(k: string): string | null {
  return new URLSearchParams(window.location.search).get(k);
}

interface Props {
  banner: string;
  onEnter: (campaignId: string, displayName: string, role: "dm" | "player", token?: string) => void;
}

export function Lobby({ banner, onEnter }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => urlParam("c") ?? "");
  const [inviteToken, setInviteToken] = useState(() => urlParam("inv") ?? "");
  const [role, setRole] = useState<"dm" | "player">("player");
  const [creating, setCreating] = useState(false);
  const [recent, setRecent] = useState<RecentCampaign[]>(() => loadRecent());
  const [resolving, setResolving] = useState(false);
  const [resolvedInvite, setResolvedInvite] = useState<null | { displayName: string; role: "dm" | "player"; campaignId: string; revokedAt?: string }>(null);
  const [error, setError] = useState<string | null>(null);

  function enter(campaignId: string, displayName: string, r: "dm" | "player", campaignName?: string, token?: string) {
    rememberJoin({ campaignId, displayName, role: r, name: campaignName, token });
    onEnter(campaignId, displayName, r, token);
  }

  // Auto-resolve invite token from URL, then auto-join if valid.
  useEffect(() => {
    const c = urlParam("c");
    const inv = urlParam("inv");
    if (inv && c) {
      setResolving(true);
      fetch(api(`/api/invites/${encodeURIComponent(inv)}?c=${encodeURIComponent(c)}`))
        .then((r) => r.json())
        .then((data) => {
          if (data?.invite && !data.invite.revokedAt) {
            setResolvedInvite({ displayName: data.invite.displayName, role: data.invite.role, campaignId: data.invite.campaignId });
            // Auto-join with server-provided identity.
            enter(data.invite.campaignId, data.invite.displayName, data.invite.role, undefined, inv);
          } else {
            setError(data?.invite?.revokedAt ? "This invite has been revoked." : "Invite not found.");
          }
        })
        .catch(() => setError("Could not resolve invite."))
        .finally(() => setResolving(false));
      return;
    }
    // Otherwise, try a stored token for the campaign in URL.
    if (c) {
      const match = loadRecent().find((r) => r.campaignId === c);
      if (match && match.token) {
        enter(match.campaignId, match.displayName, match.role, match.name, match.token);
      }
    }
  }, []);

  async function createCampaign() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(api("/api/campaigns"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${name || "guest"}'s campaign`, displayName: name || "DM" }),
      });
      const data = await res.json();
      if (!data?.dmInvite?.token) {
        setError("Campaign created, but no DM invite was issued. Try again.");
        return;
      }
      enter(data.inviteCode, name || "DM", "dm", data.name, data.dmInvite.token);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  function rejoin(r: RecentCampaign) {
    enter(r.campaignId, r.displayName, r.role, r.name, r.token);
  }

  function remove(campaignId: string) {
    forgetCampaign(campaignId);
    setRecent(loadRecent());
  }

  if (resolving) {
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: "40px auto" }}>
        <pre className="ascii">{banner}</pre>
        <p style={{ color: "var(--phosphor-dim)" }}>{"> resolving invite..."}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "40px auto" }}>
      <pre className="ascii">{banner}</pre>
      <p style={{ color: "var(--phosphor-dim)" }}>{"> ready to begin. paste an invite token, rejoin a saved campaign, or forge a new world."}</p>

      {error && (
        <div style={{ border: "1px solid var(--danger)", color: "var(--danger)", padding: 8, marginTop: 8, fontSize: 12 }}>
          {error}
        </div>
      )}

      {resolvedInvite && (
        <div style={{ border: "1px dashed var(--phosphor)", padding: 8, marginTop: 16, fontSize: 12 }}>
          joining {resolvedInvite.campaignId} as <strong>{resolvedInvite.displayName}</strong> ({resolvedInvite.role})…
        </div>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 16, border: "1px solid var(--border)", padding: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ color: "var(--phosphor-dim)", fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>
              recent campaigns
            </div>
            <button
              className="btn"
              style={{ fontSize: 10, padding: "0 6px" }}
              onClick={() => {
                if (confirm("Forget ALL recent campaigns from this browser? Server-side data is not affected.")) {
                  forgetAll();
                  setRecent([]);
                }
              }}
            >
              forget all
            </button>
          </div>
          <ul className="codex-list" style={{ marginTop: 4 }}>
            {recent.map((r) => (
              <li
                key={r.campaignId}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
              >
                <span onClick={() => rejoin(r)} style={{ cursor: "pointer", flex: 1 }}>
                  {"> "}
                  {r.name || r.campaignId}
                  <span style={{ color: "var(--phosphor-dim)" }}>
                    {"  ("}
                    {r.role}
                    {" as "}
                    {r.displayName}
                    {r.token ? ", token saved" : ", no token"}
                    {")"}
                  </span>
                </span>
                <button
                  className="btn"
                  style={{ fontSize: 11, padding: "0 6px" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(r.campaignId);
                  }}
                  title="forget this campaign"
                >
                  x
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <label>{"display name (used only if your invite doesn't specify one)"}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label>{"campaign id"}<input placeholder="abcDef12" value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label>{"invite token"}<input placeholder="dm_xxx or p_xxx" value={inviteToken} onChange={(e) => setInviteToken(e.target.value)} /></label>
        </div>
        <button
          className="btn"
          disabled={!code || !inviteToken}
          onClick={() => {
            // Resolve manually-entered invite, then enter with server identity.
            setResolving(true);
            fetch(api(`/api/invites/${encodeURIComponent(inviteToken)}?c=${encodeURIComponent(code)}`))
              .then((r) => r.json())
              .then((data) => {
                if (data?.invite && !data.invite.revokedAt) {
                  enter(data.invite.campaignId, data.invite.displayName, data.invite.role, undefined, inviteToken);
                } else {
                  setError(data?.invite?.revokedAt ? "Revoked invite." : "Invite not found.");
                }
              })
              .catch(() => setError("Could not resolve invite."))
              .finally(() => setResolving(false));
          }}
        >
          join with invite
        </button>
        <button className="btn" disabled={creating || !name} onClick={createCampaign}>
          {creating ? "forging..." : "create new campaign (becomes DM)"}
        </button>
        <div style={{ color: "var(--phosphor-dim)", fontSize: 10, marginTop: 4 }}>
          {"> Players need a token from the DM. Create a campaign and you'll get a DM token + can issue more from inside the room."}
        </div>
      </div>
    </div>
  );
}
