import { useEffect } from "react";

export function Title({ title, description }: { title: string; description?: string }) {
  useEffect(() => {
    document.title = `${title} | MARLOG`;
    if (description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) {
        meta.setAttribute("content", description);
      } else {
        const newMeta = document.createElement("meta");
        newMeta.name = "description";
        newMeta.content = description;
        document.head.appendChild(newMeta);
      }
    }
  }, [title, description]);

  return null;
}
