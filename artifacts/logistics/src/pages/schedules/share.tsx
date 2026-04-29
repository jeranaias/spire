import { useRoute } from "wouter";
import { ShieldAlert } from "lucide-react";
import { Title } from "@/components/title";
import { ScheduleView } from "@/components/schedule-view";
import {
  useGetScheduleByShareToken,
  getGetScheduleByShareTokenQueryKey,
} from "@workspace/api-client-react";

function ShareShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="border-b border-border bg-card px-4 md:px-8 py-3 flex items-center gap-2.5 print:hidden">
        <ShieldAlert className="w-5 h-5 text-primary shrink-0" />
        <span className="font-mono font-bold text-base tracking-[0.2em] uppercase text-foreground">
          MARLOG
        </span>
        <span className="font-mono text-[10px] tracking-widest uppercase text-muted-foreground ml-2">
          · Shared Schedule
        </span>
      </header>
      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}

export default function SharedSchedulePage() {
  const [, params] = useRoute("/s/:shareToken");
  const shareToken = params?.shareToken ?? "";

  const scheduleQueryKey = getGetScheduleByShareTokenQueryKey(shareToken);
  const { data: schedule, isLoading, isError } = useGetScheduleByShareToken(
    shareToken,
    { query: { queryKey: scheduleQueryKey, enabled: !!shareToken, retry: false } },
  );

  if (!shareToken || isError) {
    return (
      <ShareShell>
        <Title title="Schedule not found" />
        <div
          className="flex flex-col items-center justify-center h-64 text-center gap-2"
          data-testid="share-not-found"
        >
          <div className="font-mono text-xs uppercase tracking-widest text-destructive">
            Schedule not found
          </div>
          <div className="font-mono text-[10px] text-muted-foreground max-w-md">
            This share link is invalid or the schedule is no longer available.
            Ask the publishing unit for a current link.
          </div>
        </div>
      </ShareShell>
    );
  }

  if (isLoading || !schedule) {
    return (
      <ShareShell>
        <Title title="Loading schedule..." />
        <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Loading schedule...
        </div>
      </ShareShell>
    );
  }

  return (
    <ShareShell>
      <Title title={`Schedule — ${schedule.label}`} />
      <ScheduleView
        schedule={schedule}
        scheduleQueryKey={scheduleQueryKey}
        shareMode
      />
    </ShareShell>
  );
}
