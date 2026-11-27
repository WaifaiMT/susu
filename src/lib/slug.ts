export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Paths under /o/<slug> that would collide with app routes or look official
export const RESERVED_SLUGS = new Set(["new", "admin", "api", "settings", "billing", "www", "app"]);
