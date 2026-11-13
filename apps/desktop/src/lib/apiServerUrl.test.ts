import { describe, expect, test } from "bun:test";
import { normalizeApiServerUrl, uniqueServerUrls } from "./apiServerUrl";

describe("normalizeApiServerUrl", () => {
  test("a public name typed without a scheme uses https", () => {
    expect(normalizeApiServerUrl("mimir.rvn.bluehour.cloud")).toBe("https://mimir.rvn.bluehour.cloud");
    expect(normalizeApiServerUrl(" raven.example.org/ ")).toBe("https://raven.example.org");
  });

  test("local and LAN addresses typed without a scheme keep http", () => {
    expect(normalizeApiServerUrl("127.0.0.1:6977")).toBe("http://127.0.0.1:6977");
    expect(normalizeApiServerUrl("192.168.28.172:6977")).toBe("http://192.168.28.172:6977");
    expect(normalizeApiServerUrl("10.0.0.5")).toBe("http://10.0.0.5");
    expect(normalizeApiServerUrl("localhost:6977")).toBe("http://localhost:6977");
    expect(normalizeApiServerUrl("raven.local")).toBe("http://raven.local");
    expect(normalizeApiServerUrl("homeserver")).toBe("http://homeserver");
    expect(normalizeApiServerUrl("[::1]:6977")).toBe("http://[::1]:6977");
  });

  test("an explicit port means a server without the standard TLS front", () => {
    expect(normalizeApiServerUrl("raven.example.org:6977")).toBe("http://raven.example.org:6977");
  });

  test("an explicit scheme is kept", () => {
    expect(normalizeApiServerUrl("http://raven.example.org")).toBe("http://raven.example.org");
    expect(normalizeApiServerUrl("HTTPS://raven.example.org:8443")).toBe("https://raven.example.org:8443");
  });
});

describe("uniqueServerUrls", () => {
  test("keeps one address per server, preferring https", () => {
    expect(uniqueServerUrls(["http://127.0.0.1:6977", "https://mimir.rvn.bluehour.cloud", "http://mimir.rvn.bluehour.cloud"])).toEqual([
      "http://127.0.0.1:6977",
      "https://mimir.rvn.bluehour.cloud",
    ]);
    expect(uniqueServerUrls(["http://127.0.0.1:6977", "http://mimir.rvn.bluehour.cloud", "https://mimir.rvn.bluehour.cloud"])).toEqual([
      "http://127.0.0.1:6977",
      "https://mimir.rvn.bluehour.cloud",
    ]);
  });

  test("leaves the server in use as it is", () => {
    expect(uniqueServerUrls(["http://raven.lan", "https://raven.lan"])).toEqual(["http://raven.lan"]);
  });

  test("tells servers apart by port and path", () => {
    const urls = ["http://127.0.0.1:6977", "http://127.0.0.1:7000", "https://example.org/raven", "https://example.org"];
    expect(uniqueServerUrls(urls)).toEqual(urls);
  });
});
