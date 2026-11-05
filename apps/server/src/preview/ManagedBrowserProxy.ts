// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns the browser's proxy sockets outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

export const MANAGED_BROWSER_DENIAL_HEADER = "x-t3-browser-network-denied";

const privateAddresses = new NodeNet.BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  // Carrier-grade NAT, which is where Tailscale gives each tailnet host its address.
  ["100.64.0.0", 10],
] as const)
  privateAddresses.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  privateAddresses.addSubnet(network, bits, "ipv6");

const hostname = (host: string) =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
const isPrivate = (address: string) =>
  privateAddresses.check(address, NodeNet.isIP(address) === 6 ? "ipv6" : "ipv4");
const allowedAddress = (host: string, port: number, entries: ReadonlyArray<string>) =>
  entries.some((entry) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)(?:-(\d+))?$/.exec(entry);
    return (
      match !== null &&
      hostname(match[1]!) === host &&
      port >= Number(match[2]) &&
      port <= Number(match[3] ?? match[2])
    );
  });

/** Hands Node's connect the addresses already validated for a name, so it tries each in turn without a second lookup. */
const pinnedLookup =
  (addresses: ReadonlyArray<{ address: string; family: number }>): NodeNet.LookupFunction =>
  (_host, options, callback) =>
    options.all
      ? callback(null, [...addresses])
      : callback(null, addresses[0]!.address, addresses[0]!.family);

interface Options {
  readonly serverPort: number;
  /** null revokes the context, including already established tunnels. */
  readonly policy: () => Promise<ReadonlyArray<string> | null>;
  readonly resolve?: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
}

/** Each context owns its listener, credentials and sockets; validated IPs are used without a second DNS lookup. */
export class ManagedBrowserProxy {
  private readonly sockets = new Set<NodeStream.Duplex>();
  private readonly server = NodeHttp.createServer();
  private readonly username = NodeCrypto.randomBytes(24).toString("hex");
  private readonly password = NodeCrypto.randomBytes(24).toString("hex");
  private readonly authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  private port = 0;
  private closed = false;
  readonly refusals: string[] = [];
  refusalCount = 0;

  private readonly options: Options;
  private constructor(options: Options) {
    this.options = options;
  }

  static async start(options: Options) {
    const proxy = new ManagedBrowserProxy(options);
    proxy.server.on("connection", (socket) => proxy.track(socket));
    proxy.server.on("request", (request, response) => {
      void proxy.forward(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end("The managed browser proxy could not reach the destination.");
      });
    });
    proxy.server.on("connect", (request, socket, head) => {
      void proxy.tunnel(request, socket, head, true);
    });
    proxy.server.on("upgrade", (request, socket, head) => {
      void proxy.tunnel(request, socket, head, false);
    });
    proxy.server.headersTimeout = 10_000;
    proxy.server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, "127.0.0.1", () => {
        proxy.server.off("error", reject);
        resolve();
      });
    });
    proxy.port = (proxy.server.address() as NodeNet.AddressInfo).port;
    return proxy;
  }

  get configuration() {
    return {
      server: `http://127.0.0.1:${this.port}`,
      username: this.username,
      password: this.password,
    };
  }

  private track(socket: NodeStream.Duplex) {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.sockets.delete(socket));
    if (this.closed) socket.destroy();
  }

  private authenticate(request: NodeHttp.IncomingMessage) {
    const supplied = Buffer.from(request.headers["proxy-authorization"] ?? "");
    const expected = Buffer.from(this.authorization);
    return supplied.length === expected.length && NodeCrypto.timingSafeEqual(supplied, expected);
  }

  private async destination(url: URL) {
    const host = hostname(url.hostname);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const deny = () => {
      const message = `Managed browser blocked address ${host}:${port}.`;
      this.refusalCount += 1;
      this.refusals.push(message);
      if (this.refusals.length > 100) this.refusals.shift();
      throw new Error(message);
    };
    const entries = await this.options.policy();
    if (entries === null) {
      void this.close();
      return deny();
    }
    if (port === this.port || port === this.options.serverPort) return deny();
    const allowed = allowedAddress(host, port, entries);
    if (!allowed && (host === "localhost" || host.endsWith(".localhost"))) return deny();
    const addresses = NodeNet.isIP(host)
      ? [{ address: host, family: NodeNet.isIP(host) }]
      : host === "localhost" || host.endsWith(".localhost")
        ? [
            { address: "127.0.0.1", family: 4 },
            { address: "::1", family: 6 },
          ]
        : await bounded(
            this.options.resolve?.(host) ?? NodeDnsPromises.lookup(host, { all: true }),
            5_000,
          ).catch(deny);
    if (
      addresses.length === 0 ||
      addresses.some(({ address }) => NodeNet.isIP(address) === 0) ||
      (!allowed && addresses.some(({ address }) => isPrivate(address)))
    )
      return deny();
    return { host, addresses, port };
  }

  private async forward(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    if (!this.authenticate(request)) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="T3 managed browser"' });
      response.end();
      return;
    }
    const url = new URL(request.url!);
    if (url.protocol !== "http:") {
      response.writeHead(400);
      response.end();
      return;
    }
    let target;
    try {
      target = await this.destination(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Destination resolution refused.";
      response.writeHead(403, { [MANAGED_BROWSER_DENIAL_HEADER]: message });
      response.end(message);
      return;
    }
    const {
      "proxy-authorization": _auth,
      "proxy-connection": _connection,
      ...headers
    } = request.headers;
    const upstream = NodeHttp.request(
      {
        hostname: target.host,
        lookup: pinnedLookup(target.addresses),
        port: target.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("socket", (socket) => this.track(socket));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    upstream.setTimeout(15_000, () => upstream.destroy());
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  private async tunnel(
    request: NodeHttp.IncomingMessage,
    client: NodeStream.Duplex,
    head: Buffer,
    connect: boolean,
  ) {
    if (!this.authenticate(request)) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="T3 managed browser"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    try {
      const url = new URL(connect ? `https://${request.url}` : request.url!);
      if (!["http:", "https:", "ws:"].includes(url.protocol))
        throw new Error("Unsupported proxy protocol.");
      const target = await this.destination(url);
      const upstream = NodeNet.connect({
        host: target.host,
        lookup: pinnedLookup(target.addresses),
        port: target.port,
      });
      this.track(upstream);
      const timer = setTimeout(() => {
        upstream.destroy();
        client.destroy();
      }, 10_000);
      upstream.once("connect", () => {
        clearTimeout(timer);
        if (connect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else {
          const headers = Object.entries(request.headers)
            .filter(([key]) => !key.startsWith("proxy-"))
            .flatMap(([key, value]) =>
              value === undefined
                ? []
                : [`${key}: ${Array.isArray(value) ? value.join(", ") : value}`],
            );
          upstream.write(
            `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`,
          );
        }
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => {
        clearTimeout(timer);
        client.destroy();
      });
      client.once("close", () => {
        clearTimeout(timer);
        upstream.destroy();
      });
      upstream.once("close", () => client.destroy());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Destination resolution refused.";
      client.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
      );
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const bounded = async <A>(promise: Promise<A>, timeout: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser destination lookup timed out.")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
