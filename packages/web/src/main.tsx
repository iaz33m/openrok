import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cable,
  CircleStop,
  Clipboard,
  KeyRound,
  Laptop,
  Monitor,
  Network,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  UserRound
} from "lucide-react";
import "./styles.css";

type ClientMetadata = {
  clientKind?: "cli" | "electron";
  appVersion?: string;
  hostname?: string;
  username?: string;
  platform?: string;
  release?: string;
  arch?: string;
  localIps?: string[];
};

type Tunnel = {
  id: string;
  agentId: string;
  displayName?: string;
  name?: string;
  targetHost: string;
  targetPort: number;
  metadata?: ClientMetadata;
  publicHost: string;
  publicPort: number;
  publicEndpoint: string;
  connectedAt: string;
  lastSeenAt: string;
  uptimeSeconds: number;
  stats: {
    bytesFromClient: number;
    bytesFromTarget: number;
    totalConnections: number;
    activeConnections: number;
  };
  streams: Array<{
    streamId: string;
    remoteAddress?: string;
    remotePort?: number;
    openedAt: string;
  }>;
};

type ServerConfig = {
  publicHost: string;
  httpPort: number;
  tcpPortRange: string;
  agentEndpoint: string;
};

const TOKEN_STORAGE_KEY = "openrock-admin-token";

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const [draftToken, setDraftToken] = useState(token);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const authed = token.length > 0;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  async function refresh() {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [cfg, tunnelList] = await Promise.all([
        request<ServerConfig>("/api/config"),
        request<{ tunnels: Tunnel[] }>("/api/tunnels")
      ]);
      setServerConfig(cfg);
      setTunnels(tunnelList.tunnels);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!token) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [token]);

  function signIn(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = draftToken.trim();
    localStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
    setToken(trimmed);
  }

  function signOut() {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken("");
    setDraftToken("");
    setServerConfig(null);
    setTunnels([]);
  }

  async function disconnect(id: string) {
    await request(`/api/tunnels/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
    await refresh();
  }

  const totalActive = useMemo(
    () => tunnels.reduce((sum, tunnel) => sum + tunnel.stats.activeConnections, 0),
    [tunnels]
  );

  if (!authed) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-lockup">
            <div className="brand-icon">
              <Cable size={28} />
            </div>
            <div>
              <h1>OpenRock Tunnel</h1>
              <p>Server dashboard</p>
            </div>
          </div>
          <form onSubmit={signIn} className="login-form">
            <label htmlFor="admin-token">Admin token</label>
            <div className="token-field">
              <KeyRound size={18} />
              <input
                id="admin-token"
                type="password"
                value={draftToken}
                onChange={(event) => setDraftToken(event.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <button type="submit">Open dashboard</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon">
            <Cable size={26} />
          </div>
          <div>
            <h1>OpenRock Tunnel</h1>
            <p>{serverConfig ? `${serverConfig.publicHost}:${serverConfig.httpPort}` : "Loading server"}</p>
          </div>
        </div>
        <div className="toolbar">
          <button className="icon-button" title="Refresh" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={18} />
          </button>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}

      <section className="metrics">
        <Metric icon={<Laptop size={18} />} label="Connected clients" value={tunnels.length.toString()} />
        <Metric icon={<Activity size={18} />} label="Active sessions" value={totalActive.toString()} />
        <Metric icon={<Shield size={18} />} label="Tunnel ports" value={serverConfig?.tcpPortRange ?? "-"} />
      </section>

      <section className="tunnel-section">
        <div className="section-heading">
          <h2>Connected clients</h2>
          <span>{loading ? "Refreshing" : "Updated every 5s"}</span>
        </div>
        {tunnels.length === 0 ? (
          <div className="empty-state">
            <Terminal size={32} />
            <h3>No clients connected</h3>
            <p>Install and start the OpenRock Client on a machine with RDP access.</p>
          </div>
        ) : (
          <div className="tunnel-list">
            {tunnels.map((tunnel) => (
              <TunnelCard key={tunnel.id} tunnel={tunnel} onDisconnect={() => void disconnect(tunnel.id)} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Metric(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-icon">{props.icon}</div>
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
}

function TunnelCard(props: { tunnel: Tunnel; onDisconnect: () => void }) {
  const { tunnel } = props;
  const metadata = tunnel.metadata ?? {};
  const localIps = metadata.localIps?.length ? metadata.localIps.join(", ") : "Unavailable";
  return (
    <article className="tunnel-card">
      <div className="tunnel-card-header">
        <div>
          <h3>{tunnel.displayName || tunnel.name || metadata.hostname || tunnel.agentId}</h3>
          <p>{metadata.clientKind === "electron" ? "Desktop client" : "Tunnel client"} - {tunnel.agentId}</p>
        </div>
        <button className="danger icon-text" onClick={props.onDisconnect} title="Disconnect tunnel">
          <CircleStop size={17} />
          Disconnect
        </button>
      </div>

      <div className="route">
        <Endpoint icon={<Monitor size={20} />} label="Local RDP target" value={`${tunnel.targetHost}:${tunnel.targetPort}`} />
        <div className="route-line" />
        <Endpoint icon={<Server size={20} />} label="TCP connection URL" value={tunnel.publicEndpoint} copyable />
      </div>

      <div className="client-details">
        <Detail icon={<UserRound size={16} />} label="Username" value={metadata.username ?? "Unavailable"} />
        <Detail icon={<Laptop size={16} />} label="Hostname" value={metadata.hostname ?? "Unavailable"} />
        <Detail icon={<Network size={16} />} label="Local IPs" value={localIps} />
        <Detail icon={<Shield size={16} />} label="Platform" value={formatPlatform(metadata)} />
      </div>

      <div className="stats-grid">
        <Stat label="Active" value={tunnel.stats.activeConnections.toString()} />
        <Stat label="Total" value={tunnel.stats.totalConnections.toString()} />
        <Stat label="Inbound" value={formatBytes(tunnel.stats.bytesFromClient)} />
        <Stat label="Outbound" value={formatBytes(tunnel.stats.bytesFromTarget)} />
        <Stat label="Uptime" value={formatDuration(tunnel.uptimeSeconds)} />
        <Stat label="Last seen" value={formatTime(tunnel.lastSeenAt)} />
      </div>
    </article>
  );
}

function Detail(props: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="detail">
      {props.icon}
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Endpoint(props: { icon: React.ReactNode; label: string; value: string; copyable?: boolean }) {
  return (
    <div className="endpoint">
      <div className="endpoint-icon">{props.icon}</div>
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
      {props.copyable && (
        <button className="icon-button small" title="Copy endpoint" onClick={() => void navigator.clipboard.writeText(props.value)}>
          <Clipboard size={15} />
        </button>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatPlatform(metadata: ClientMetadata): string {
  return [metadata.platform, metadata.release, metadata.arch].filter(Boolean).join(" ") || "Unavailable";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
