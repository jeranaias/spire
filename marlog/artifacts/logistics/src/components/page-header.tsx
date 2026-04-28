import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  tag?: string;
  right?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, tag, right, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col md:flex-row md:items-start justify-between gap-4 mb-8", className)}>
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          {tag && (
            <span className="text-[10px] font-mono text-primary tracking-[0.25em] uppercase border border-primary/40 px-1.5 py-0.5 rounded-sm">
              {tag}
            </span>
          )}
          <h1 className="text-2xl font-mono font-bold uppercase tracking-[0.12em] text-foreground leading-tight">
            {title}
          </h1>
        </div>
        {subtitle && (
          <p className="text-muted-foreground mt-1 text-xs font-mono tracking-wide">
            · {subtitle}
          </p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

interface SectionHeaderProps {
  children: React.ReactNode;
  subtitle?: string;
  className?: string;
}

export function SectionHeader({ children, subtitle, className }: SectionHeaderProps) {
  return (
    <div className={cn("mb-4", className)}>
      <h2 className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-foreground">
        {children}
      </h2>
      {subtitle && (
        <p className="text-[10px] font-mono text-muted-foreground tracking-wide mt-0.5">· {subtitle}</p>
      )}
    </div>
  );
}
