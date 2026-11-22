import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Throws when a request to this hostname must not be made. */
export type HostPolicy = (hostname: string) => Promise<void>;

const PRIVATE = new BlockList();
PRIVATE.addSubnet("0.0.0.0", 8);
PRIVATE.addSubnet("10.0.0.0", 8);
PRIVATE.addSubnet("100.64.0.0", 10);
PRIVATE.addSubnet("127.0.0.0", 8);
PRIVATE.addSubnet("169.254.0.0", 16);
PRIVATE.addSubnet("172.16.0.0", 12);
PRIVATE.addSubnet("192.168.0.0", 16);
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

function isPrivate(address: string, family: number): boolean {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : null;
  if (mapped && isIP(mapped) === 4) return PRIVATE.check(mapped, "ipv4");
  return PRIVATE.check(address, family === 6 ? "ipv6" : "ipv4");
}

export const publicHost: HostPolicy = async (hostname) => {
  const literal = isIP(hostname);
  const records = literal ? [{ address: hostname, family: literal }] : await lookup(hostname, { all: true });
  if (records.length === 0 || records.some((r) => isPrivate(r.address, r.family))) {
    throw new Error(`${hostname} is not a public host`);
  }
};

export function listedHosts(hosts: readonly string[], base: HostPolicy): HostPolicy {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  return async (hostname) => {
    if (!allowed.has(hostname.toLowerCase())) throw new Error(`${hostname} is not one of this watch's hosts`);
    await base(hostname);
  };
}

export type HttpResult = {
  status: number;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
};

export type HttpOptions = {
  allow: HostPolicy;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_REDIRECTS = 5;

async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { body: Buffer.concat(chunks).toString("utf8"), truncated };
}

/** One GET. Every hop is checked against `allow`, so a redirect cannot reach a host the caller did not permit. */
export async function httpGet(url: string, options: HttpOptions): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`unsupported URL scheme ${current.protocol}`);
    }
    await options.allow(current.hostname.replace(/^\[|\]$/g, ""));
    const res = await fetch(current, {
      headers: { accept: "*/*", "user-agent": "Mozilla/5.0" },
      redirect: "manual",
      signal,
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(location, current);
      continue;
    }
    const { body, truncated } = await readCapped(res, options.maxBytes ?? 5_000_000);
    return {
      status: res.status,
      url: current.toString(),
      contentType: res.headers.get("content-type") ?? "",
      body,
      truncated,
    };
  }
}
