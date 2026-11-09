export function normalizeApiServerUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("API server URL is required");
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultSchemeFor(trimmed)}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid Raven API server URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Raven API server URL must start with http:// or https://");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * The scheme for an address typed without one. A public name ("raven.example.org") is a
 * deployed server behind TLS: macOS's WebView refuses plain HTTP to it outright (App
 * Transport Security), and it should not be spoken to in the clear anywhere. A local
 * name, an IP address or an explicit port ("192.168.1.5:6977") is a development or LAN
 * server, which usually has no certificate.
 */
function defaultSchemeFor(address: string): "http" | "https" {
  const authority = address.split(/[/?#]/, 1)[0];
  if (/^\[[0-9a-f:.]+\](:\d+)?$/i.test(authority)) return "http";
  const [host, port] = authority.split(":");
  if (port !== undefined) return "http";
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return "http";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return "http";
  if (!name.includes(".")) return "http";
  return "https";
}
