import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useListSpirePrs,
  useGetSpirePrConfig,
  useRefreshSpirePr,
  getListSpirePrsQueryKey,
  type SpirePr,
} from "@workspace/api-client-react";
import {
  ExternalLink,
  GitPullRequest,
  RefreshCcw,
  CheckCircle2,
  XCircle,
  CircleDot,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";

const KIND_LABEL: Record<string, string> = {
  calculator: "Calculator bill",
  schedule: "Comms-denied schedule",
  supply: "Supply snapshot",
};

function StateBadge({ state }: { state: string }) {
  if (state === "merged") {
    return (
      <span
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-success/15 border-success/40 text-success"
        data-testid={`badge-state-${state}`}
      >
        <CheckCircle2 className="w-3 h-3" /> Merged
      </span>
    );
  }
  if (state === "closed") {
    return (
      <span
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-destructive/10 border-destructive/40 text-destructive"
        data-testid={`badge-state-${state}`}
      >
        <XCircle className="w-3 h-3" /> Closed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-primary/10 border-primary/40 text-primary"
      data-testid={`badge-state-${state}`}
    >
      <CircleDot className="w-3 h-3" /> Open
    </span>
  );
}

function PrRow({ pr }: { pr: SpirePr }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSpirePr();

  async function handleRefresh() {
    await refresh.mutateAsync({ id: pr.id });
    queryClient.invalidateQueries({ queryKey: getListSpirePrsQueryKey() });
  }

  return (
    <div
      className="px-4 py-3 border-b border-border last:border-b-0 flex items-start justify-between gap-3 hover:bg-muted/20 transition-colors"
      data-testid={`row-spire-pr-${pr.prNumber}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span
            className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
            data-testid={`text-pr-source-${pr.prNumber}`}
          >
            {KIND_LABEL[pr.sourceKind] ?? pr.sourceKind}
          </span>
          <StateBadge state={pr.state} />
        </div>
        <a
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono font-bold text-sm hover:underline inline-flex items-center gap-1 break-all"
          data-testid={`link-pr-title-${pr.prNumber}`}
        >
          #{pr.prNumber} · {pr.title}
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
          {pr.repoOwner}/{pr.repoName} · branch{" "}
          <code className="text-foreground/80">{pr.branch}</code> →{" "}
          <code className="text-foreground/80">{pr.baseBranch}</code>
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">
          File: <code className="text-foreground/80">{pr.filePath}</code>
        </div>
        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
          Subject: {pr.sourceLabel}
          {pr.createdBy ? ` · by ${pr.createdBy}` : ""} · opened{" "}
          {format(new Date(pr.createdAt), "ddMMMyy HHmm'Z'").toUpperCase()}
          {pr.mergedAt
            ? ` · merged ${format(new Date(pr.mergedAt), "ddMMMyy HHmm'Z'").toUpperCase()}`
            : pr.closedAt
            ? ` · closed ${format(new Date(pr.closedAt), "ddMMMyy HHmm'Z'").toUpperCase()}`
            : ""}
        </div>
      </div>
      <div className="flex flex-col gap-1 items-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={refresh.isPending}
          className="font-mono uppercase text-[10px] tracking-widest h-7 px-2"
          data-testid={`button-refresh-pr-${pr.prNumber}`}
          title="Re-poll GitHub for the latest state"
        >
          <RefreshCcw
            className={`w-3 h-3 ${refresh.isPending ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
    </div>
  );
}

export default function SpirePrsPage() {
  const { data: config } = useGetSpirePrConfig({
    query: { queryKey: ["spire-pr-config"] },
  });
  const { data: prs, isLoading, refetch, isFetching } = useListSpirePrs(
    { refresh: true, limit: 100 },
    { query: { queryKey: getListSpirePrsQueryKey({ refresh: true, limit: 100 }) } },
  );

  return (
    <Layout>
      <Title title="SPIRE Pull Requests" />
      <PageHeader
        title="SPIRE Pull Requests"
        tag="Sync"
        subtitle="MARLOG-opened pull requests against the SPIRE master-data repository"
      />

      <Card className="border-border">
        <CardHeader className="border-b border-border pb-3 pt-4 px-4 flex flex-row items-center justify-between">
          <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
            <GitPullRequest className="w-3.5 h-3.5 text-primary" /> Open & Recent PRs
          </CardTitle>
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
              data-testid="text-spire-repo-config"
            >
              {config?.configured
                ? `Repo: ${config.owner}/${config.name} · ${config.baseBranch}`
                : "SPIRE repo not configured"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="font-mono uppercase text-[10px] tracking-widest h-7 px-2"
              data-testid="button-refresh-all"
            >
              <RefreshCcw
                className={`w-3 h-3 mr-1.5 ${isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground uppercase tracking-widest">
              Loading...
            </div>
          ) : !prs || prs.length === 0 ? (
            <div
              className="px-4 py-8 text-center font-mono text-xs text-muted-foreground uppercase tracking-widest"
              data-testid="text-spire-empty"
            >
              No SPIRE pull requests yet. Use the "Push to SPIRE" button on the
              Calculator, a Unit, or a Schedule to open the first one.
            </div>
          ) : (
            prs.map((pr) => <PrRow key={pr.id} pr={pr} />)
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
