export function buildShareUrl(shareToken: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/s/${shareToken}`;
}
