export function resolveApiOrigin(value: unknown, production: boolean): string {
  const message = "VITE_API_URL must be an HTTPS origin";
  if (value == null || value === "") {
    if (!production) return "";
    throw new Error(message);
  }
  if (
    typeof value !== "string" ||
    !/^https:\/\/[^/?#\\\s@]+\/?$/i.test(value)
  ) {
    throw new Error(message);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(message);
  }
  return url.origin;
}
