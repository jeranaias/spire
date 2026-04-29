import { useCallback, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { buildShareUrl } from "@/lib/share-url";

export function useCopyShareLink() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (token: string) => {
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
    },
    [toast],
  );

  return { copied, copy };
}
