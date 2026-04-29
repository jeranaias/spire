import { Link, useLocation } from "wouter";
import { Activity, BookOpen, Calculator, Crosshair, GitPullRequest, Home, Settings, ShieldAlert, Users, Wifi, WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const isOnline = useOnlineStatus();

  const nav = [
    { href: "/", label: "Dashboard", icon: Home },
    { href: "/units", label: "Units", icon: Users },
    { href: "/calculator", label: "Calculator", icon: Calculator },
    { href: "/catalog", label: "Catalog", icon: BookOpen },
    { href: "/weapon-systems", label: "Weapons", icon: Crosshair },
    { href: "/sync", label: "Sync", icon: Activity },
    { href: "/spire-prs", label: "SPIRE PRs", icon: GitPullRequest },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Sidebar */}
      <aside className="w-full md:w-60 border-r border-border bg-card flex flex-col flex-shrink-0 print:hidden">
        {/* Wordmark */}
        <div className="px-4 py-4 border-b border-border flex items-center justify-between md:justify-start gap-3">
          <Link href="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm">
            <ShieldAlert className="w-5 h-5 text-primary shrink-0" />
            <span className="font-mono font-bold text-base tracking-[0.2em] uppercase text-foreground">
              MARLOG
            </span>
          </Link>
          {/* Mobile connectivity pill */}
          <div className="md:hidden">
            {isOnline ? (
              <div className="flex items-center gap-1 text-[10px] font-mono text-success tracking-widest">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> LIVE
              </div>
            ) : (
              <div className="flex items-center gap-1 text-[10px] font-mono text-destructive tracking-widest">
                <WifiOff className="w-3 h-3" /> OFFLINE
              </div>
            )}
          </div>
        </div>

        {/* System status row — desktop only */}
        <div className="hidden md:flex px-4 py-2.5 border-b border-border items-center justify-between">
          <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-mono">
            System Status
          </span>
          {isOnline ? (
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-success tracking-widest">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              LIVE
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-destructive tracking-widest">
              <WifiOff className="w-3 h-3" /> OFFLINE
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 flex md:flex-col overflow-x-auto md:overflow-y-auto gap-0.5">
          {nav.map((item) => {
            const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-sm transition-colors text-xs font-mono tracking-widest uppercase whitespace-nowrap
                  ${active
                    ? "bg-primary/10 text-primary border-l-2 border-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground border-l-2 border-transparent"
                  }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-[100dvh] overflow-y-auto">
        <div className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  );
}
