import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { ScheduleView } from "@/components/schedule-view";

import { useRoute } from "wouter";
import { useGetSchedule } from "@workspace/api-client-react";

export default function ScheduleDetailPage() {
  const [, params] = useRoute("/schedules/:scheduleId");
  const scheduleId = params?.scheduleId ?? "";

  const scheduleQueryKey = ["schedule", scheduleId] as const;
  const { data: schedule, isLoading } = useGetSchedule(
    scheduleId,
    { query: { queryKey: scheduleQueryKey } },
  );

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Loading schedule...
        </div>
      </Layout>
    );
  }

  if (!schedule) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-xs uppercase tracking-widest">
          Schedule not found.
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <Title title={`Schedule — ${schedule.label}`} />
      <ScheduleView schedule={schedule} scheduleQueryKey={scheduleQueryKey} />
    </Layout>
  );
}
