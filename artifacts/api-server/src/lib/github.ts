import { logger } from "./logger";

/**
 * Replit GitHub connector access. Mirrors the standard "uncacheable client"
 * pattern: never cache the access token, always read it fresh per request,
 * because the connector hostname rotates short-lived tokens for us.
 */

const CONNECTORS_HOSTNAME = process.env.REPLIT_CONNECTORS_HOSTNAME;
const REPL_IDENTITY = process.env.REPL_IDENTITY;
const WEB_REPL_RENEWAL = process.env.WEB_REPL_RENEWAL;

export class GitHubNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNotConfiguredError";
  }
}

interface ConnectorRecord {
  settings?: {
    access_token?: string;
    oauth?: {
      credentials?: {
        access_token?: string;
      };
    };
  };
}

interface ConnectorsResponse {
  items?: ConnectorRecord[];
}

async function fetchGithubAccessToken(): Promise<string> {
  if (!CONNECTORS_HOSTNAME) {
    throw new GitHubNotConfiguredError(
      "REPLIT_CONNECTORS_HOSTNAME is not set; the GitHub connector is unavailable in this environment.",
    );
  }
  const xReplitToken = REPL_IDENTITY
    ? `repl ${REPL_IDENTITY}`
    : WEB_REPL_RENEWAL
    ? `depl ${WEB_REPL_RENEWAL}`
    : null;
  if (!xReplitToken) {
    throw new GitHubNotConfiguredError(
      "Neither REPL_IDENTITY nor WEB_REPL_RENEWAL is set; cannot authenticate to the connectors service.",
    );
  }
  const url = `https://${CONNECTORS_HOSTNAME}/api/v2/connection?include_secrets=true&connector_names=github`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      X_REPLIT_TOKEN: xReplitToken,
    },
  });
  if (!res.ok) {
    throw new GitHubNotConfiguredError(
      `Failed to read GitHub connector token: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as ConnectorsResponse;
  const record = body.items?.[0];
  const token =
    record?.settings?.access_token ??
    record?.settings?.oauth?.credentials?.access_token;
  if (!token) {
    throw new GitHubNotConfiguredError(
      "GitHub connector is not connected; ask a project member to connect their GitHub account.",
    );
  }
  return token;
}

interface GitHubRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  expectStatus?: number;
}

export async function githubRequest<T = unknown>(
  path: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  const token = await fetchGithubAccessToken();
  const method = options.method ?? "GET";
  const url = path.startsWith("https://")
    ? path
    : `https://api.github.com${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "marlog-spire-pr",
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const errBody = (await res.json()) as { message?: string };
      detail = errBody?.message ? ` — ${errBody.message}` : "";
    } catch {
      /* non-JSON body */
    }
    const msg = `GitHub ${method} ${path} failed: ${res.status} ${res.statusText}${detail}`;
    logger.warn({ method, path, status: res.status }, msg);
    const err = new Error(msg);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

/** Base64-encode a UTF-8 string for the Contents API. */
export function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
