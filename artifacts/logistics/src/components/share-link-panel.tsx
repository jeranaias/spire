import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRevokeScheduleShareLink,
  useRotateScheduleShareLink,
} from "@workspace/api-client-react";
import { Check, Link2, RotateCw, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

interface ShareLinkPanelProps {
  scheduleId: string;
  shareToken: string | null;
  /** Called after successful revoke/rotate so the host page can update its state. */
  onTokenChange: (newToken: string | null) => void;
  /** Query keys to invalidate after revoke/rotate (so listing UIs refresh). */
  invalidateKeys?: ReadonlyArray<readonly unknown[]>;
}

function buildShareUrl(token: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/s/${token}`;
}

export function ShareLinkPanel({
  scheduleId,
  shareToken,
  onTokenChange,
  invalidateKeys = [],
}: ShareLinkPanelProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const revoke = useRevokeScheduleShareLink();
  const rotate = useRotateScheduleShareLink();

  const invalidateAll = useCallback(() => {
    for (const key of invalidateKeys) {
      qc.invalidateQueries({ queryKey: key });
    }
  }, [invalidateKeys, qc]);

  const handleCopy = useCallback(async (token: string) => {
    const url = buildShareUrl(token);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = url;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Could not copy share link",
        description: "Copy it manually from the address bar.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleRevoke = useCallback(async () => {
    try {
      const result = await revoke.mutateAsync({ scheduleId });
      onTokenChange(result.shareToken);
      invalidateAll();
      toast({
        title: "Share link revoked",
        description: "The old link now returns 404. Issue a new one if you need to re-distribute.",
      });
      setConfirmRevokeOpen(false);
    } catch {
      toast({ title: "Failed to revoke share link", variant: "destructive" });
    }
  }, [revoke, scheduleId, onTokenChange, invalidateAll, toast]);

  const handleRotate = useCallback(async () => {
    try {
      const result = await rotate.mutateAsync({ scheduleId });
      onTokenChange(result.shareToken);
      invalidateAll();
      toast({
        title: shareToken ? "New share link issued" : "Share link reissued",
        description: "Distribute this new URL — the previous link no longer works.",
      });
    } catch {
      toast({ title: "Failed to issue share link", variant: "destructive" });
    }
  }, [rotate, scheduleId, onTokenChange, invalidateAll, toast, shareToken]);

  if (shareToken) {
    return (
      <div className="space-y-1.5" data-testid="share-link-panel-active">
        <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
          Share link — receiving echelon
        </Label>
        <div className="flex gap-2 items-stretch">
          <Input
            readOnly
            value={buildShareUrl(shareToken)}
            onFocus={(e) => e.currentTarget.select()}
            className="font-mono text-[11px] h-8 bg-muted/30"
            data-testid="input-share-url"
            aria-label="Public share URL for this schedule"
          />
          <Button
            type="button"
            size="sm"
            variant={copied ? "default" : "outline"}
            className="font-mono uppercase text-[10px] tracking-widest h-8 whitespace-nowrap"
            onClick={() => handleCopy(shareToken)}
            data-testid="button-copy-share-url"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 mr-1.5" /> Copied
              </>
            ) : (
              <>
                <Link2 className="w-3 h-3 mr-1.5" /> Copy Link
              </>
            )}
          </Button>
        </div>
        <p className="font-mono text-[10px] text-muted-foreground">
          Anyone with this link can view and print the schedule — no MARLOG account required.
        </p>
        <div className="flex gap-2 pt-1">
          <AlertDialog open={confirmRevokeOpen} onOpenChange={setConfirmRevokeOpen}>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="font-mono uppercase text-[10px] tracking-widest h-8 text-destructive border-destructive/40 hover:bg-destructive/5"
                disabled={revoke.isPending}
                data-testid="button-revoke-share-link"
              >
                <ShieldOff className="w-3 h-3 mr-1.5" />
                {revoke.isPending ? "Revoking..." : "Revoke Share Link"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="font-mono uppercase text-sm tracking-widest">
                  Revoke share link?
                </AlertDialogTitle>
                <AlertDialogDescription className="font-mono text-xs">
                  Anyone using the current link will get a 404 immediately. The
                  schedule itself stays intact — you can issue a new link
                  afterward to re-distribute it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="font-mono uppercase text-[10px] tracking-widest">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleRevoke}
                  disabled={revoke.isPending}
                  className="font-mono uppercase text-[10px] tracking-widest bg-destructive hover:bg-destructive/90"
                  data-testid="button-confirm-revoke-share-link"
                >
                  Revoke Link
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="font-mono uppercase text-[10px] tracking-widest h-8"
            onClick={handleRotate}
            disabled={rotate.isPending}
            data-testid="button-rotate-share-link"
          >
            <RotateCw className={`w-3 h-3 mr-1.5 ${rotate.isPending ? "animate-spin" : ""}`} />
            {rotate.isPending ? "Rotating..." : "Rotate Link"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="share-link-panel-revoked">
      <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
        Share link
      </Label>
      <div className="p-2 border border-dashed border-border/60 rounded-sm font-mono text-[11px] text-muted-foreground">
        Share link is revoked. The previously distributed URL returns 404.
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="font-mono uppercase text-[10px] tracking-widest h-8"
        onClick={handleRotate}
        disabled={rotate.isPending}
        data-testid="button-issue-share-link"
      >
        <Link2 className="w-3 h-3 mr-1.5" />
        {rotate.isPending ? "Issuing..." : "Issue New Link"}
      </Button>
    </div>
  );
}
