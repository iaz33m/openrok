import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cable,
  CheckCircle2,
  Clipboard,
  KeyRound,
  Monitor,
  Plug,
  Power,
  RefreshCw,
  Save,
  Server,
  UserRound,
  Wifi
} from "lucide-react";
import type { DesktopClientState, SaveConfigInput } from "../shared/types.js";
import "./styles.css";

type FormState = {
  serverUrl: string;
  token: string;
  agentId: string;
  name: string;
  targetHost: string;
  targetPort: string;
  publicPort: string;
  openAtLogin: boolean;
};

function App() {
  const [state, setState] = useState<DesktopClientState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.openrock.getState().then((next: DesktopClientState) => {
      setState(next);
      setForm(toForm(next));
    });
    return window.openrock.onState((next: DesktopClientState) => {
      setState(next);
      setForm((current) => current ?? toForm(next));
    });
  }, []);

  const endpoint = state?.status.publicEndpoint;
  const connected = state?.status.state === "ready";
  const statusText = state ? labelForState(state.status.state) : "Loading";
  const localIps = state?.metadata.localIps?.join(", ") || "Unavailable";

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      const input: SaveConfigInput = {
        serverUrl: form.serverUrl,
        token: form.token.trim() || undefined,
        keepExistingToken: form.token.trim() === "",
        agentId: form.agentId,
        name: form.name,
        targetHost: form.targetHost,
        targetPort: Number(form.targetPort),
        publicPort: form.publicPort.trim() ? Number(form.publicPort) : undefined,
        openAtLogin: form.openAtLogin
      };
      const next = await window.openrock.saveConfig(input);
      setState(next);
      setForm(toForm(next));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function reconnect() {
    setError("");
    const next = await window.openrock.connect();
    setState(next);
  }

  async function disconnect() {
    setError("");
    const next = await window.openrock.disconnect();
    setState(next);
  }

  const recentLogs = useMemo(() => state?.logs.slice(0, 8) ?? [], [state?.logs]);

  if (!state || !form) {
    return <main className="loading">OpenRock Client</main>;
  }

  return (
    <main className="client-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-icon">
            <Cable size={26} />
          </div>
          <div>
            <h1>OpenRock Client</h1>
            <p>{state.config.name || state.metadata.hostname || state.config.agentId}</p>
          </div>
        </div>
        <div className={`status-pill ${connected ? "online" : ""}`}>
          {connected ? <CheckCircle2 size={17} /> : <Plug size={17} />}
          {statusText}
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <section className="status-grid">
        <StatusItem icon={<Server size={18} />} label="Server" value={state.config.serverUrl} />
        <StatusItem icon={<Monitor size={18} />} label="RDP endpoint" value={endpoint ?? "Pending"} copyValue={endpoint} />
        <StatusItem icon={<Activity size={18} />} label="Target" value={`${state.config.targetHost}:${state.config.targetPort}`} />
        <StatusItem icon={<Wifi size={18} />} label="Active sessions" value={state.status.activeStreams.toString()} />
      </section>

      <section className="details-grid">
        <div className="panel identity-panel">
          <div className="panel-heading">
            <UserRound size={18} />
            <h2>Machine</h2>
          </div>
          <dl className="detail-list">
            <Detail label="Username" value={state.metadata.username ?? "Unavailable"} />
            <Detail label="Hostname" value={state.metadata.hostname ?? "Unavailable"} />
            <Detail label="Local IPs" value={localIps} />
            <Detail label="Platform" value={formatPlatform(state.metadata.platform, state.metadata.release, state.metadata.arch)} />
          </dl>
        </div>

        <form className="panel settings-panel" onSubmit={saveConfig}>
          <div className="panel-heading">
            <KeyRound size={18} />
            <h2>Connection</h2>
          </div>
          <div className="form-grid">
            <Field label="Server URL">
              <input value={form.serverUrl} onChange={(event) => setForm({ ...form, serverUrl: event.target.value })} />
            </Field>
            <Field label="Agent token">
              <input
                type="password"
                value={form.token}
                placeholder={state.config.tokenConfigured ? "Configured" : "Required"}
                onChange={(event) => setForm({ ...form, token: event.target.value })}
              />
            </Field>
            <Field label="Client ID">
              <input value={form.agentId} onChange={(event) => setForm({ ...form, agentId: event.target.value })} />
            </Field>
            <Field label="Display name">
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Target host">
              <input value={form.targetHost} onChange={(event) => setForm({ ...form, targetHost: event.target.value })} />
            </Field>
            <Field label="Target port">
              <input inputMode="numeric" value={form.targetPort} onChange={(event) => setForm({ ...form, targetPort: event.target.value })} />
            </Field>
            <Field label="Public port">
              <input inputMode="numeric" value={form.publicPort} onChange={(event) => setForm({ ...form, publicPort: event.target.value })} />
            </Field>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={form.openAtLogin}
                onChange={(event) => setForm({ ...form, openAtLogin: event.target.checked })}
              />
              <span>Start at login</span>
            </label>
          </div>
          <div className="actions">
            <button type="submit" disabled={saving}>
              <Save size={17} />
              Save
            </button>
            <button type="button" className="secondary" onClick={() => void reconnect()}>
              <RefreshCw size={17} />
              Connect
            </button>
            <button type="button" className="secondary" onClick={() => void disconnect()}>
              <Power size={17} />
              Disconnect
            </button>
          </div>
        </form>
      </section>

      <section className="panel logs-panel">
        <div className="panel-heading">
          <Activity size={18} />
          <h2>Activity</h2>
        </div>
        {recentLogs.length === 0 ? (
          <p className="empty-log">No activity yet</p>
        ) : (
          <ul>
            {recentLogs.map((line: string) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusItem(props: { icon: React.ReactNode; label: string; value: string; copyValue?: string }) {
  return (
    <div className="status-item">
      <div className="status-icon">{props.icon}</div>
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
      {props.copyValue && (
        <button title="Copy" onClick={() => void navigator.clipboard.writeText(props.copyValue!)}>
          <Clipboard size={15} />
        </button>
      )}
    </div>
  );
}

function Detail(props: { label: string; value: string }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function toForm(state: DesktopClientState): FormState {
  return {
    serverUrl: state.config.serverUrl,
    token: "",
    agentId: state.config.agentId,
    name: state.config.name ?? "",
    targetHost: state.config.targetHost,
    targetPort: String(state.config.targetPort),
    publicPort: state.config.publicPort ? String(state.config.publicPort) : "",
    openAtLogin: state.config.openAtLogin
  };
}

function labelForState(state: string): string {
  switch (state) {
    case "ready":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Authorizing";
    case "error":
      return "Retrying";
    case "disconnected":
      return "Disconnected";
    default:
      return "Idle";
  }
}

function formatPlatform(platform?: string, release?: string, arch?: string): string {
  return [platform, release, arch].filter(Boolean).join(" ") || "Unavailable";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
