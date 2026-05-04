/**
 * ChannelsView — UIS-P5.1 channels admin surface.
 *
 * Single-page operator UI for the pull-mode ingestion channels
 * built across UIS-P4.1.x. Without this view, channels were
 * fully invisible to operators — silent staleness was the worst
 * failure mode (data went stale, no signal).
 *
 * Surfaces:
 *   - Channels list with health-roll-up chip per row (reachable,
 *     pending count, circuit state, last error, last polled_at)
 *   - Inline detail panel: config, on-demand poll, DLQ list with
 *     replay/discard, circuit-breaker reset
 *   - Create-new-channel form with channel-type-specific fields
 *
 * Scope-gated to data_custodian + security_manager via VIEW_SCOPE.
 * The same role gate the /api/uis/channels backend enforces.
 */
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ChannelConfig,
  type ChannelConfigCreate,
  type ChannelDlqItem,
  type ChannelHealth,
  type ChannelPollResult,
  type ChannelType,
} from "../../api";
import { formatApiError } from "../../api-retry";
import { Button, ErrorState, LoadingState } from "../../components/ui";

const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  filesystem: "Filesystem (airgap watcher / fileshare / SMB-mount)",
  sftp: "SFTP — paramiko-backed pull",
  imap: "IMAP — email-attachment intake",
  http_poll: "HTTP poll — REST / SOAP",
  db_cdc: "DB CDC — watermark polling",
  kafka: "Kafka — streaming consumer",
};

const REQUIRED_BY_TYPE: Record<ChannelType, string[]> = {
  filesystem: ["root"],
  sftp: ["host", "username", "base_path"],
  imap: ["host", "username", "password_env"],
  http_poll: ["url"],
  db_cdc: ["dialect"],
  kafka: ["bootstrap_servers", "topic", "group_id"],
};

export function ChannelsView() {
  const [channels, setChannels] = useState<ChannelConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.uis.listChannels();
      setChannels(r.channels);
      setError(null);
    } catch (e) {
      setError(formatApiError(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <header className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[var(--color-text)]">
            Ingest channels
          </h1>
          <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            pull-mode sources · sftp · imap · filesystem · http · db cdc · kafka
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={refresh} variant="secondary">
            Refresh
          </Button>
          <Button onClick={() => setCreating(true)}>+ New channel</Button>
        </div>
      </header>

      {error && <ErrorState title="Channels load failed" description={error} onRetry={refresh} />}

      {channels === null ? (
        <LoadingState />
      ) : channels.length === 0 ? (
        <EmptyChannels onCreate={() => setCreating(true)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {channels.map((ch) => (
            <li key={ch.channel_id}>
              <ChannelRow
                channel={ch}
                expanded={selected === ch.channel_id}
                onToggle={() =>
                  setSelected(selected === ch.channel_id ? null : ch.channel_id)
                }
                onChanged={refresh}
              />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateChannelDialog
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyChannels({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded border border-dashed border-[var(--color-border)] p-6">
      <p className="font-mono text-xs text-[var(--color-text)]">
        No channels configured.
      </p>
      <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        every adapter (gcss-mc/ecp, drrs-mc/c-rating, etc.) can be wired to a
        pull-mode source. drag-drop uploads still work without a channel.
      </p>
      <Button onClick={onCreate}>+ Add the first channel</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel row + expanded detail
// ---------------------------------------------------------------------------

function ChannelRow({
  channel,
  expanded,
  onToggle,
  onChanged,
}: {
  channel: ChannelConfig;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [health, setHealth] = useState<ChannelHealth | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.uis
      .channelHealth(channel.channel_id)
      .then((h) => !cancelled && setHealth(h))
      .catch((e) => !cancelled && setHealthErr(formatApiError(e)));
    return () => {
      cancelled = true;
    };
  }, [expanded, channel.channel_id]);

  return (
    <div className="rounded border border-[var(--color-border)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-[var(--color-surface-hover)]"
      >
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-[var(--color-text)]">
              {channel.channel_id}
            </span>
            <TypeBadge type={channel.channel_type} />
            <EnabledBadge enabled={channel.enabled} />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            adapter · {channel.adapter_id} · poll every{" "}
            {channel.poll_interval_seconds}s
          </span>
        </div>
        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
          {expanded ? "▼" : "▶"}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] p-3">
          <HealthPanel
            health={health}
            error={healthErr}
            onRefresh={() => {
              setHealth(null);
              api.uis
                .channelHealth(channel.channel_id)
                .then(setHealth)
                .catch((e) => setHealthErr(formatApiError(e)));
            }}
          />
          <ActionsPanel channel={channel} onChanged={onChanged} />
          <DlqPanel channelId={channel.channel_id} />
          <ConfigPanel channel={channel} />
          <DangerPanel channel={channel} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health panel — the warfighter-relevant chip
// ---------------------------------------------------------------------------

function HealthPanel({
  health,
  error,
  onRefresh,
}: {
  health: ChannelHealth | null;
  error: string | null;
  onRefresh: () => void;
}) {
  if (error) return <ErrorState title="Health probe failed" description={error} onRetry={onRefresh} />;
  if (!health) return <LoadingState label="Probing channel…" />;

  const reachableColor = health.reachable
    ? "text-emerald-400"
    : "text-amber-400";
  const failures = health.consecutive_failures;
  const circuitOpen = !!health.circuit_open;

  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Health
        </span>
        <Button onClick={onRefresh} variant="ghost">
          Re-probe
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
        <span className="text-[var(--color-text-muted)]">reachable</span>
        <span className={reachableColor}>
          {health.reachable ? "yes" : "no"}
        </span>

        <span className="text-[var(--color-text-muted)]">pending</span>
        <span>{health.pending_count ?? "—"}</span>

        <span className="text-[var(--color-text-muted)]">consecutive failures</span>
        <span className={failures > 0 ? "text-amber-400" : ""}>{failures}</span>

        {circuitOpen && (
          <>
            <span className="text-[var(--color-text-muted)]">circuit</span>
            <span className="text-rose-400">OPEN — channel suppressed</span>
          </>
        )}

        <span className="text-[var(--color-text-muted)]">last polled</span>
        <span>{health.last_polled_at || "—"}</span>

        <span className="text-[var(--color-text-muted)]">last success</span>
        <span>{health.last_success_at || "—"}</span>
      </div>

      {health.last_error && (
        <div className="rounded border border-amber-700/40 bg-amber-950/20 p-2 font-mono text-xs text-amber-300">
          last error: {health.last_error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions panel — on-demand poll + circuit reset
// ---------------------------------------------------------------------------

function ActionsPanel({
  channel,
  onChanged,
}: {
  channel: ChannelConfig;
  onChanged: () => void | Promise<void>;
}) {
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<ChannelPollResult | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);

  const handlePoll = async () => {
    setPolling(true);
    setPollErr(null);
    try {
      const r = await api.uis.pollChannel(channel.channel_id);
      setPollResult(r);
      await onChanged();
    } catch (e) {
      setPollErr(formatApiError(e));
    } finally {
      setPolling(false);
    }
  };

  const handleResetCircuit = async () => {
    try {
      await api.uis.resetCircuit(channel.channel_id);
      await onChanged();
    } catch (e) {
      setPollErr(formatApiError(e));
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Actions
      </span>
      <div className="flex flex-wrap gap-2">
        <Button onClick={handlePoll} disabled={polling}>
          {polling ? "Polling…" : "Run poll now"}
        </Button>
        <Button onClick={handleResetCircuit} variant="secondary">
          Reset circuit breaker
        </Button>
      </div>
      {pollErr && <ErrorState title="Action failed" description={pollErr} />}
      {pollResult && (
        <div className="flex flex-col gap-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-2 font-mono text-xs">
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Poll result · {pollResult.duration_ms.toFixed(0)}ms ·{" "}
            {pollResult.pending_count} pending
          </span>
          <span>
            applied <strong>{pollResult.counts.applied}</strong> · skipped{" "}
            {pollResult.counts.skipped} · quarantined{" "}
            <span className={pollResult.counts.quarantined > 0 ? "text-amber-400" : ""}>
              {pollResult.counts.quarantined}
            </span>
          </span>
          {pollResult.files.length > 0 && (
            <ul className="ml-2 mt-1 list-disc text-[10px] text-[var(--color-text-muted)]">
              {pollResult.files.map((f, i) => (
                <li key={i}>
                  <span className="text-[var(--color-text)]">{f.filename}</span>
                  {" — "}
                  <span
                    className={
                      f.status === "applied"
                        ? "text-emerald-400"
                        : f.status === "quarantined"
                          ? "text-amber-400"
                          : ""
                    }
                  >
                    {f.status}
                  </span>
                  {f.error && <span className="text-rose-400"> — {f.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DLQ panel — list quarantined files + replay/discard
// ---------------------------------------------------------------------------

function DlqPanel({ channelId }: { channelId: string }) {
  const [items, setItems] = useState<ChannelDlqItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.uis
      .listDlq(channelId)
      .then((r) => setItems(r.items))
      .catch((e) => setError(formatApiError(e)));
  }, [channelId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorState title="DLQ load failed" description={error} onRetry={load} />;
  if (items === null) return null;

  return (
    <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Dead-letter queue ({items.length})
        </span>
        <Button onClick={load} variant="ghost">
          Refresh
        </Button>
      </div>
      {items.length === 0 ? (
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          No quarantined files.
        </span>
      ) : (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {items.map((it) => (
            <DlqItemRow
              key={it.filename}
              channelId={channelId}
              item={it}
              onAction={load}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DlqItemRow({
  channelId,
  item,
  onAction,
}: {
  channelId: string;
  item: ChannelDlqItem;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const replay = async () => {
    setBusy(true);
    try {
      await api.uis.replayDlq(channelId, item.filename);
      onAction();
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (
      !window.confirm(
        `Permanently delete ${item.filename}? Audit chain will record the discard.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.uis.discardDlq(channelId, item.filename);
      onAction();
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-1 rounded border border-amber-900/40 bg-amber-950/10 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--color-text)]">{item.filename}</span>
        <div className="flex gap-1">
          <Button onClick={replay} disabled={busy} variant="ghost">
            Replay
          </Button>
          <Button onClick={discard} disabled={busy} variant="ghost">
            Discard
          </Button>
        </div>
      </div>
      <span className="text-[10px] text-[var(--color-text-muted)]">
        {item.size_bytes.toLocaleString()} bytes · quarantined{" "}
        {item.quarantined_at}
      </span>
      {item.reason && (
        <pre className="whitespace-pre-wrap text-[10px] text-amber-300">
          {item.reason}
        </pre>
      )}
      {err && <span className="text-[10px] text-rose-400">{err}</span>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Config + danger
// ---------------------------------------------------------------------------

function ConfigPanel({ channel }: { channel: ChannelConfig }) {
  return (
    <details className="rounded border border-[var(--color-border)] p-3">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Config (read-only — secrets resolved at runtime via env vars)
      </summary>
      <pre className="mt-2 overflow-x-auto font-mono text-[10px] text-[var(--color-text)]">
        {JSON.stringify(channel.config, null, 2)}
      </pre>
    </details>
  );
}

function DangerPanel({
  channel,
  onChanged,
}: {
  channel: ChannelConfig;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Delete channel ${channel.channel_id}? It will stop polling immediately. Pending files in incoming/ are NOT deleted.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.uis.deleteChannel(channel.channel_id);
      await onChanged();
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-rose-900/40 p-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-rose-400">
        Danger zone
      </span>
      <Button onClick={handleDelete} disabled={busy} variant="secondary">
        Delete channel
      </Button>
      {err && <ErrorState title="Operation failed" description={err} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-new-channel dialog
// ---------------------------------------------------------------------------

function CreateChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<ChannelType>("filesystem");
  const [channelId, setChannelId] = useState("");
  const [adapterId, setAdapterId] = useState("");
  const [pollSeconds, setPollSeconds] = useState(300);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adapters, setAdapters] = useState<{ id: string }[]>([]);

  useEffect(() => {
    api.uis.listAdapters().then((r) => setAdapters(r.adapters));
  }, []);

  const updateField = (key: string, value: string) =>
    setConfig({ ...config, [key]: value });

  const handleCreate = async () => {
    setErr(null);
    setBusy(true);
    try {
      // Coerce numeric-looking fields
      const coerced: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        if (v === "") continue;
        if (/^\d+$/.test(v)) coerced[k] = parseInt(v, 10);
        else coerced[k] = v;
      }
      const payload: ChannelConfigCreate = {
        channel_id: channelId,
        channel_type: type,
        adapter_id: adapterId,
        config: coerced,
        enabled: true,
        poll_interval_seconds: pollSeconds,
      };
      await api.uis.createChannel(payload);
      onCreated();
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  };

  const required = REQUIRED_BY_TYPE[type];
  const optional = OPTIONAL_FIELDS_BY_TYPE[type] ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="flex max-h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <header className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-[0.22em]">
            New channel
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            close
          </button>
        </header>

        <Field label="Channel type">
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as ChannelType);
              setConfig({});
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
          >
            {Object.entries(CHANNEL_TYPE_LABELS).map(([k, lbl]) => (
              <option key={k} value={k}>
                {lbl}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Channel id (unique)">
          <input
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            placeholder="dla/sftp-nightly"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
          />
        </Field>

        <Field label="Adapter id">
          <select
            value={adapterId}
            onChange={(e) => setAdapterId(e.target.value)}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
          >
            <option value="">— pick adapter —</option>
            {adapters.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Poll interval (seconds)">
          <input
            type="number"
            value={pollSeconds}
            onChange={(e) =>
              setPollSeconds(Math.max(1, parseInt(e.target.value, 10) || 1))
            }
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
          />
        </Field>

        <div className="flex flex-col gap-2 rounded border border-[var(--color-border)] p-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Required config
          </span>
          {required.map((k) => (
            <Field key={k} label={k}>
              <input
                value={config[k] ?? ""}
                onChange={(e) => updateField(k, e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
                placeholder={EXAMPLES[type]?.[k] ?? ""}
              />
            </Field>
          ))}

          {optional.length > 0 && (
            <>
              <span className="mt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Optional
              </span>
              {optional.map((k) => (
                <Field key={k} label={k} hint={OPTIONAL_HINTS[k]}>
                  <input
                    value={config[k] ?? ""}
                    onChange={(e) => updateField(k, e.target.value)}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
                    placeholder={EXAMPLES[type]?.[k] ?? ""}
                  />
                </Field>
              ))}
            </>
          )}
        </div>

        {err && <ErrorState title="Operation failed" description={err} />}

        <footer className="flex justify-end gap-2">
          <Button onClick={onClose} variant="secondary" disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={busy || !channelId || !adapterId}>
            {busy ? "Saving…" : "Save channel"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

const OPTIONAL_FIELDS_BY_TYPE: Record<ChannelType, string[]> = {
  filesystem: ["glob", "stability_seconds"],
  sftp: [
    "port",
    "glob",
    "key_path",
    "key_passphrase_env",
    "password_env",
    "host_key_policy",
    "remote_move_enabled",
  ],
  imap: [
    "port",
    "use_ssl",
    "inbox_folder",
    "processed_folder",
    "quarantine_folder",
    "attachment_glob",
  ],
  http_poll: [
    "method",
    "bearer_token_env",
    "basic_auth_username",
    "basic_auth_password_env",
    "soap_action",
    "watermark_param",
    "watermark_header",
    "watermark_jsonpath",
    "watermark_state_path",
  ],
  db_cdc: [
    "table",
    "watermark_column",
    "host",
    "port",
    "database",
    "username",
    "password_env",
    "max_rows_per_poll",
    "select_sql",
    "watermark_state_path",
  ],
  kafka: [
    "batch_size",
    "auto_offset_reset",
    "security_protocol",
    "sasl_mechanism",
    "sasl_username",
    "sasl_password_env",
  ],
};

const OPTIONAL_HINTS: Record<string, string> = {
  password_env: "name of env var holding the password (NEVER the password itself)",
  bearer_token_env: "name of env var holding the bearer token",
  sasl_password_env: "name of env var holding the SASL password",
  watermark_state_path: "must resolve under SPIRE_CHANNEL_STATE_ROOT",
  remote_move_enabled: "true / false — false = read-only SFTP fallback",
};

const EXAMPLES: Record<ChannelType, Record<string, string>> = {
  filesystem: { root: "/var/spool/spire-intake/airgap-conex" },
  sftp: { host: "sftp.dla.example.mil", base_path: "/exports/spire", port: "22" },
  imap: { host: "imap.usmc.mil", port: "993", inbox_folder: "INBOX" },
  http_poll: { url: "https://gcss-mc.usmc.mil/v1/srs", method: "GET" },
  db_cdc: { dialect: "postgresql", host: "db.usmc.mil", port: "5432", database: "ops" },
  kafka: { bootstrap_servers: "broker1:9092,broker2:9092", topic: "srs", group_id: "spire-srs" },
};

// ---------------------------------------------------------------------------
// Tiny presentational helpers
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
        {hint && (
          <span className="ml-1 normal-case tracking-normal text-[var(--color-text-muted)]/70">
            — {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

function TypeBadge({ type }: { type: ChannelType }) {
  return (
    <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-elevated)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted)]">
      {type}
    </span>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${
        enabled
          ? "border border-emerald-700 bg-emerald-950/40 text-emerald-300"
          : "border border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]"
      }`}
    >
      {enabled ? "enabled" : "paused"}
    </span>
  );
}
