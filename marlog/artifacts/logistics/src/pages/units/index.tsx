import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { useListUnits } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ShieldAlert, Plus, Search, MapPin, Users, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Progress } from "@/components/ui/progress";

export default function UnitsList() {
  const { data: units, isLoading } = useListUnits({
    query: { queryKey: ["units"] }
  });
  const [search, setSearch] = useState("");

  const filteredUnits = units?.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase()) ||
    (u.callsign && u.callsign.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <Layout>
      <Title title="Units" description="Command subordinate elements" />

      <PageHeader
        title="Units"
        tag="Order of Battle"
        subtitle="Manage subordinate elements and task organizations"
        right={
          <Link href="/units/new">
            <Button className="font-mono uppercase text-xs tracking-widest">
              <Plus className="w-3.5 h-3.5 mr-2" />
              Add Unit
            </Button>
          </Link>
        }
      />

      <div className="bg-card border border-border rounded-sm">
        <div className="p-3 border-b border-border">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search units or callsigns..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 font-mono text-xs h-8"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="divide-y divide-border">
            {[1, 2, 3].map(i => (
              <div key={i} className="p-4 flex items-center justify-between animate-pulse">
                <div className="flex gap-4">
                  <div className="w-10 h-10 bg-muted rounded-sm" />
                  <div className="space-y-2">
                    <div className="w-32 h-3 bg-muted rounded-sm" />
                    <div className="w-24 h-2 bg-muted rounded-sm" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : filteredUnits?.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
            No units found.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredUnits?.map((unit) => (
              <Link key={unit.id} href={`/units/${unit.id}`} className="block hover:bg-muted/20 transition-colors p-4 group">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 shrink-0 bg-primary/10 border border-primary/20 rounded-sm flex items-center justify-center text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                      <ShieldAlert className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-mono font-bold text-sm tracking-wide">{unit.name}</h3>
                        {unit.callsign && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded-sm tracking-widest">
                            {unit.callsign}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-muted-foreground font-mono tracking-wide">
                        <div className="flex items-center gap-1"><Users className="w-3 h-3" /> {unit.personnel} PAX</div>
                        <div className="flex items-center gap-1 uppercase"><Target className="w-3 h-3" /> {unit.echelon}</div>
                        {unit.location && <div className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {unit.location}</div>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 md:w-56 shrink-0">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">Readiness</span>
                        <StatusBadge value={unit.readiness} />
                      </div>
                      <Progress
                        value={unit.readiness}
                        className="h-1.5"
                        indicatorClassName={
                          unit.readiness >= 90 ? "bg-success" :
                          unit.readiness >= 75 ? "bg-warning" :
                          unit.readiness >= 60 ? "bg-orange" : "bg-destructive"
                        }
                      />
                    </div>

                    <div className="text-center shrink-0">
                      <div className="text-[10px] font-mono text-muted-foreground mb-0.5 tracking-widest uppercase">Defs</div>
                      <div className={`font-mono font-bold text-sm ${unit.deficiencyCount > 0 ? "text-destructive" : "text-success"}`}>
                        {unit.deficiencyCount}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
