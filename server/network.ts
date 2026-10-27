import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import { ensure } from "./security";

export async function resolvePublic(url: string) {
  const u = new URL(url);
  ensure(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      (!u.port || ["80", "443"].includes(u.port)),
    "仅支持公开的 HTTP(S) 地址",
  );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(host, { all: true });
  ensure(
    addresses.length &&
      addresses.every((a) => {
        const ip = ipaddr.process(a.address);
        return ip.range() === "unicast";
      }),
    "不允许访问内网、环回或保留地址",
  );
  return { url: u, addresses };
}
export async function fetchPublic(
  url: string,
  maxBytes = 100_000_000,
  hops = 0,
): Promise<{ buffer: Buffer; contentType: string; url: string }> {
  ensure(hops <= 4, "地址重定向次数过多");
  const { url: u, addresses } = await resolvePublic(url);
  const agent = new Agent({
    connect: {
      lookup: (_host, options, callback) => {
        const chosen = addresses[0];
        if ((options as any).all) (callback as any)(null, addresses);
        else callback(null, chosen.address, chosen.family);
      },
    },
    headersTimeout: 20000,
    bodyTimeout: 30000,
  });
  try {
    const result = await request(u, {
      dispatcher: agent,
      maxRedirections: 0,
      signal: AbortSignal.timeout(120000),
      headers: { "user-agent": "InfiniteCanvas/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      await result.body.dump();
      const location = result.headers.location;
      ensure(typeof location === "string", "重定向地址无效");
      return fetchPublic(new URL(location, u).toString(), maxBytes, hops + 1);
    }
    ensure(
      result.statusCode >= 200 && result.statusCode < 300,
      `素材读取失败 (${result.statusCode})`,
    );
    ensure(
      Number(result.headers["content-length"] || 0) <= maxBytes,
      "文件超过大小限制",
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of result.body) {
      size += chunk.length;
      ensure(size <= maxBytes, "文件超过大小限制");
      chunks.push(Buffer.from(chunk));
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType: String(
        result.headers["content-type"] || "application/octet-stream",
      ).split(";")[0],
      url: u.toString(),
    };
  } finally {
    await agent.close();
  }
}
