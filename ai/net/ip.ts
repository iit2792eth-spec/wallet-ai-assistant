import { BlockList, isIP } from "node:net";

// Addresses the scraper must never reach: loopback, private, link-local
// (which includes cloud metadata at 169.254.169.254), and other non-public ranges.
const blocked = new BlockList();
const V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6: [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** True unless the address is a public unicast IP. Anything unparseable is treated as non-public. */
export function isBlockedAddress(address: string): boolean {
  const mapped = MAPPED_V4.exec(address);
  if (mapped) return isBlockedAddress(mapped[1]);
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // An IPv4-mapped address written in hex, e.g. ::ffff:7f00:1.
    if (/^::ffff:/i.test(address)) return true;
    return blocked.check(address, "ipv6");
  }
  return true;
}
