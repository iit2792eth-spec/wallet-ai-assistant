import { describe, expect, it } from "vitest";
import { NetworkPolicyError, assertAllowedUrl, guardedFetch } from "@/ai/net/guarded-fetch";
import { hostLockedFetch } from "@/ai/net/host-locked-fetch";
import { isBlockedAddress } from "@/ai/net/ip";

// Network policy, checked without making any outbound request.
// Capturing traffic from a local model's own process is a manual test (see README).

describe("address classification", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "not-an-ip",
  ])("blocks %s", (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"])(
    "allows %s",
    (address) => expect(isBlockedAddress(address)).toBe(false),
  );
});

describe("scraper URL rules", () => {
  const check = (url: string, host = "example.com") => () => assertAllowedUrl(new URL(url), host);

  it("allows the host the user gave, with or without www", () => {
    expect(check("https://example.com/a")).not.toThrow();
    expect(check("https://www.example.com/a")).not.toThrow();
  });
  it("blocks a redirect to another host", () => expect(check("https://evil.example/a")).toThrow(NetworkPolicyError));
  it("blocks a redirect to an internal address", () => expect(check("http://10.0.0.1/", "10.0.0.1")).toThrow(NetworkPolicyError));
  it("blocks cloud metadata", () => expect(check("http://169.254.169.254/latest/meta-data", "169.254.169.254")).toThrow(NetworkPolicyError));
  it("blocks localhost", () => expect(check("http://localhost/", "localhost")).toThrow(NetworkPolicyError));
  it("blocks IPv6 loopback", () => expect(check("http://[::1]/", "[::1]")).toThrow(NetworkPolicyError));
  it("blocks other ports", () => expect(check("http://example.com:8545/")).toThrow(NetworkPolicyError));
  it("blocks other schemes", () => expect(check("file:///etc/passwd", "")).toThrow(NetworkPolicyError));
  it("blocks credentials in the URL", () => expect(check("https://user:pass@example.com/")).toThrow(NetworkPolicyError));
});

describe("guardedFetch", () => {
  it.each(["http://127.0.0.1:8545/", "http://localhost/", "http://169.254.169.254/", "http://[::1]/", "ftp://example.com/x", "not a url"])(
    "refuses %s before connecting",
    async (url) => {
      await expect(guardedFetch(url, 1024)).rejects.toBeInstanceOf(NetworkPolicyError);
    },
  );
});

describe("model client host lock", () => {
  it("refuses a host other than the provider's", () => {
    const lockedFetch = hostLockedFetch("api.anthropic.com");
    expect(() => lockedFetch("https://attacker.example/v1/messages")).toThrow(NetworkPolicyError);
  });
});
