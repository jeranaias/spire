import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <Layout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
        <div className="w-16 h-16 rounded-sm bg-muted/50 border border-border flex items-center justify-center">
          <ShieldAlert className="w-8 h-8 text-muted-foreground opacity-40" />
        </div>
        <div>
          <div className="font-mono text-[10px] text-primary tracking-[0.25em] uppercase border border-primary/40 px-1.5 py-0.5 rounded-sm inline-block mb-3">
            404
          </div>
          <h1 className="text-2xl font-mono font-bold uppercase tracking-[0.12em] text-foreground mb-2">
            Page Not Found
          </h1>
          <p className="text-muted-foreground text-xs font-mono tracking-wide">
            This route does not exist or has been moved.
          </p>
        </div>
        <Link href="/">
          <Button className="font-mono uppercase text-xs tracking-widest">
            Return to Dashboard
          </Button>
        </Link>
      </div>
    </Layout>
  );
}
