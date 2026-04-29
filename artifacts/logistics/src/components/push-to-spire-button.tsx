import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { GitPullRequest, Loader2, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateSpirePr,
  useGetSpirePrConfig,
  getListSpirePrsQueryKey,
} from "@workspace/api-client-react";
import type {
  CreateSpirePrBody,
  SpirePrSourceKind,
} from "@workspace/api-client-react";

interface PushToSpireButtonProps {
  sourceKind: SpirePrSourceKind;
  sourceId?: string;
  /** Calculator-only scenario inputs. */
  scenario?: NonNullable<CreateSpirePrBody["scenario"]>;
  /** Used in the test ID and as a label fallback. */
  contextLabel: string;
  /** Disable when the source isn't ready (e.g. no calculator result yet). */
  disabled?: boolean;
  /** Optional smaller / outline appearance. */
  variant?: "default" | "outline";
  size?: "default" | "sm";
  className?: string;
}

export function PushToSpireButton({
  sourceKind,
  sourceId,
  scenario,
  contextLabel,
  disabled,
  variant = "outline",
  size = "sm",
  className,
}: PushToSpireButtonProps) {
  const { data: config } = useGetSpirePrConfig({
    query: { queryKey: ["spire-pr-config"] },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createPr = useCreateSpirePr();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [createdBy, setCreatedBy] = useState("");

  const repoConfigured = !!config?.configured;
  const repoLabel = config?.configured
    ? `${config.owner}/${config.name}`
    : "SPIRE repo not configured";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const result = await createPr.mutateAsync({
        data: {
          sourceKind,
          sourceId,
          scenario,
          title: title.trim() || undefined,
          summary: summary.trim() || undefined,
          createdBy: createdBy.trim() || undefined,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListSpirePrsQueryKey() });
      toast({
        title: `PR #${result.prNumber} opened`,
        description: (
          <a
            href={result.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-flex items-center gap-1"
            data-testid="link-spire-pr-toast"
          >
            View on GitHub <ExternalLink className="w-3 h-3" />
          </a>
        ),
      });
      setOpen(false);
      setTitle("");
      setSummary("");
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not open the SPIRE pull request.";
      toast({
        title: "Push failed",
        description: message,
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={variant}
          size={size}
          disabled={disabled}
          className={`font-mono uppercase text-[10px] tracking-widest ${
            size === "sm" ? "h-7 px-2" : ""
          } ${className ?? ""}`}
          data-testid={`button-push-spire-${sourceKind}`}
          title={
            repoConfigured
              ? `Open a PR against ${repoLabel}`
              : `Set SPIRE_GITHUB_REPO_OWNER + SPIRE_GITHUB_REPO_NAME to enable.`
          }
        >
          <GitPullRequest
            className={`${size === "sm" ? "w-3 h-3 mr-1.5" : "w-3.5 h-3.5 mr-2"}`}
          />
          Push to SPIRE
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase text-xs tracking-widest">
            Push to SPIRE as PR
          </DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <p
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
              data-testid="text-spire-target-repo"
            >
              Target: {repoLabel}
              {config?.configured ? ` · base ${config.baseBranch}` : ""}
            </p>
            {!repoConfigured && (
              <p
                className="font-mono text-[10px] text-destructive"
                data-testid="text-spire-not-configured"
              >
                Configure SPIRE_GITHUB_REPO_OWNER and SPIRE_GITHUB_REPO_NAME
                (and optionally SPIRE_GITHUB_BASE_BRANCH) to enable pushes.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              PR title (optional)
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`MARLOG ${sourceKind}: ${contextLabel}`}
              maxLength={120}
              data-testid="input-spire-title"
            />
          </div>
          <div className="space-y-1">
            <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              Summary / notes (optional)
            </Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Anything reviewers in SPIRE should know."
              rows={3}
              maxLength={4000}
              data-testid="textarea-spire-summary"
            />
          </div>
          <div className="space-y-1">
            <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              Submitted by (optional)
            </Label>
            <Input
              value={createdBy}
              onChange={(e) => setCreatedBy(e.target.value)}
              placeholder="Callsign or name"
              maxLength={120}
              data-testid="input-spire-created-by"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              className="font-mono uppercase text-[10px] tracking-widest"
              data-testid="button-spire-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createPr.isPending || !repoConfigured}
              className="font-mono uppercase text-[10px] tracking-widest"
              data-testid="button-spire-submit"
            >
              {createPr.isPending ? (
                <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              ) : (
                <GitPullRequest className="w-3 h-3 mr-1.5" />
              )}
              {createPr.isPending ? "Opening PR..." : "Open Pull Request"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
