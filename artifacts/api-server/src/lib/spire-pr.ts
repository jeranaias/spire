import { db } from "@workspace/db";
import { spirePrsTable, unitsTable, type SpirePr } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { githubRequest, toBase64, GitHubNotConfiguredError } from "./github";
import { logger } from "./logger";

export type SpirePrSourceKind = "calculator" | "schedule" | "supply";

export class SpireRepoNotConfiguredError extends Error {
  constructor() {
    super(
      "SPIRE GitHub repository is not configured. Set SPIRE_GITHUB_REPO_OWNER and SPIRE_GITHUB_REPO_NAME (and optionally SPIRE_GITHUB_BASE_BRANCH, default 'main').",
    );
    this.name = "SpireRepoNotConfiguredError";
  }
}

interface SpireRepoConfig {
  owner: string;
  name: string;
  baseBranch: string;
}

export function getSpireRepoConfig(): SpireRepoConfig {
  const owner = process.env.SPIRE_GITHUB_REPO_OWNER?.trim();
  const name = process.env.SPIRE_GITHUB_REPO_NAME?.trim();
  if (!owner || !name) {
    throw new SpireRepoNotConfiguredError();
  }
  return {
    owner,
    name,
    baseBranch: process.env.SPIRE_GITHUB_BASE_BRANCH?.trim() || "main",
  };
}

export interface CreateSpirePrInput {
  sourceKind: SpirePrSourceKind;
  sourceId?: string | null;
  sourceLabel: string;
  title: string;
  summary?: string;
  payload: unknown;
  /** Optional structured fields persisted alongside the row for the list page. */
  payloadSummary?: Record<string, unknown>;
  createdBy?: string | null;
}

export interface CreateSpirePrResult {
  id: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  filePath: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "item";
}

function timestampSlug(): string {
  // YYYYMMDD-HHMMSS in UTC
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function buildFilePath(input: CreateSpirePrInput): string {
  const folder =
    input.sourceKind === "calculator"
      ? "calculator"
      : input.sourceKind === "schedule"
      ? "schedules"
      : "supply";
  const stem =
    input.sourceKind === "schedule"
      ? slugify(input.sourceId ?? input.sourceLabel)
      : `${slugify(input.sourceLabel)}-${timestampSlug()}`;
  return `proposals/${folder}/${stem}.json`;
}

function buildBranchName(input: CreateSpirePrInput): string {
  return `marlog/${input.sourceKind}/${slugify(input.sourceLabel)}-${timestampSlug()}`;
}

function buildPrBody(input: CreateSpirePrInput, filePath: string): string {
  const lines: string[] = [];
  lines.push(`# MARLOG → SPIRE proposal`);
  lines.push("");
  lines.push(`**Source:** ${input.sourceKind}`);
  lines.push(`**Subject:** ${input.sourceLabel}`);
  if (input.sourceId) lines.push(`**Source ID:** \`${input.sourceId}\``);
  if (input.createdBy) lines.push(`**Submitted by:** ${input.createdBy}`);
  lines.push(`**File:** \`${filePath}\``);
  lines.push("");
  if (input.summary) {
    lines.push(input.summary);
    lines.push("");
  }
  lines.push(
    "_This pull request was opened automatically by MARLOG. Review the JSON payload, request changes, and merge to ingest into SPIRE master data._",
  );
  return lines.join("\n");
}

interface RefResponse {
  object: { sha: string };
}
interface CommitResponse {
  sha: string;
  commit: { tree: { sha: string } };
}
interface PrResponse {
  number: number;
  html_url: string;
  state: string;
  merged_at?: string | null;
  closed_at?: string | null;
}

export async function createSpirePullRequest(
  input: CreateSpirePrInput,
): Promise<CreateSpirePrResult> {
  const repo = getSpireRepoConfig();
  const branch = buildBranchName(input);
  const filePath = buildFilePath(input);
  const title = input.title;
  const body = buildPrBody(input, filePath);

  // 1. Resolve base SHA
  const baseRef = await githubRequest<RefResponse>(
    `/repos/${repo.owner}/${repo.name}/git/ref/heads/${repo.baseBranch}`,
  );
  const baseSha = baseRef.object.sha;

  // 2. Create new branch
  await githubRequest(`/repos/${repo.owner}/${repo.name}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  });

  // 3. Commit the proposal file
  const fileContent = JSON.stringify(input.payload, null, 2) + "\n";
  await githubRequest(
    `/repos/${repo.owner}/${repo.name}/contents/${encodeURI(filePath)}`,
    {
      method: "PUT",
      body: {
        message: `MARLOG: ${title}`,
        branch,
        content: toBase64(fileContent),
      },
    },
  );

  // 4. Open the pull request
  const pr = await githubRequest<PrResponse>(
    `/repos/${repo.owner}/${repo.name}/pulls`,
    {
      method: "POST",
      body: {
        title,
        head: branch,
        base: repo.baseBranch,
        body,
      },
    },
  );

  // 5. Persist the tracking row
  const inserted = await db
    .insert(spirePrsTable)
    .values({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null,
      sourceLabel: input.sourceLabel,
      repoOwner: repo.owner,
      repoName: repo.name,
      branch,
      baseBranch: repo.baseBranch,
      filePath,
      prNumber: pr.number,
      prUrl: pr.html_url,
      title,
      state: pr.state,
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
      createdBy: input.createdBy ?? null,
      payloadSummary: input.payloadSummary ?? null,
    })
    .returning({ id: spirePrsTable.id });

  return {
    id: inserted[0].id,
    prNumber: pr.number,
    prUrl: pr.html_url,
    branch,
    filePath,
  };
}

/** Refresh the cached state of a single PR row from GitHub. Best-effort — failures are logged and the existing row is returned. */
export async function refreshSpirePrState(row: SpirePr): Promise<SpirePr> {
  try {
    const pr = await githubRequest<PrResponse>(
      `/repos/${row.repoOwner}/${row.repoName}/pulls/${row.prNumber}`,
    );
    const newState = pr.merged_at ? "merged" : pr.state;
    const updated = await db
      .update(spirePrsTable)
      .set({
        state: newState,
        mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
        closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
        refreshedAt: new Date(),
      })
      .where(eq(spirePrsTable.id, row.id))
      .returning();
    return updated[0] ?? row;
  } catch (err) {
    logger.warn(
      { prId: row.id, prNumber: row.prNumber, err: (err as Error).message },
      "Failed to refresh SPIRE PR state",
    );
    return row;
  }
}

export async function listSpirePrs(opts: {
  sourceKind?: SpirePrSourceKind;
  sourceId?: string;
  limit?: number;
}): Promise<SpirePr[]> {
  const where = [];
  if (opts.sourceKind) where.push(eq(spirePrsTable.sourceKind, opts.sourceKind));
  if (opts.sourceId) where.push(eq(spirePrsTable.sourceId, opts.sourceId));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(spirePrsTable)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(spirePrsTable.createdAt))
    .limit(limit);
  return rows;
}

export async function refreshOpenSpirePrs(rows: SpirePr[]): Promise<SpirePr[]> {
  const out: SpirePr[] = [];
  for (const row of rows) {
    if (row.state === "open") {
      out.push(await refreshSpirePrState(row));
    } else {
      out.push(row);
    }
  }
  return out;
}

export async function getUnitNameById(unitId: string): Promise<string | null> {
  const rows = await db
    .select({ name: unitsTable.name })
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId))
    .limit(1);
  return rows[0]?.name ?? null;
}

export { GitHubNotConfiguredError };
