// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Real Chromium and local network fixtures exercise the proxy boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { ManagedBrowserProxy } from "./ManagedBrowserProxy.ts";

const listen = async (server: NodeHttp.Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as NodeNet.AddressInfo).port;
};
const close = (server: NodeHttp.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

it("enforces redirects, subresources, popup, fetch, WebSockets, aliases and CONNECT below Chromium", async () => {
  let deniedHits = 0;
  const denied = NodeHttp.createServer((_request, response) => {
    deniedHits++;
    response.end("should never be reached");
  });
  const deniedPort = await listen(denied);
  const blocked = `http://127.0.0.1:${deniedPort}`;
  const allowed = NodeHttp.createServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: `${blocked}/redirected` });
    else response.setHeader("Content-Type", "text/html");
    response.end(
      request.url === "/subresource"
        ? `<img src="${blocked}/image">`
        : "<title>Allowed preview</title><button>Ready</button>",
    );
  });
  const allowedPort = await listen(allowed);
  let policy: ReadonlyArray<string> | null = [
    `127.0.0.1:${allowedPort}`,
    `public.example.test:${allowedPort}`,
  ];
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => policy,
    // Offline public-page stub uses a second allowed hostname; a non-allowed alias still resolves to private and is refused.
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: "per-context" },
    args: [
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  try {
    const context = await browser.newContext({
      proxy: { ...proxy.configuration, bypass: "<-loopback>" },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${allowedPort}`;
    await page.goto(origin);
    expect(await page.title()).toBe("Allowed preview");
    expect((await page.goto(`${blocked}/direct`))?.status()).toBe(403);
    expect(await page.textContent("body")).toContain(`127.0.0.1:${deniedPort}`);
    expect((await page.goto(`${origin}/redirect`))?.status()).toBe(403);
    const beforeImage = proxy.refusalCount;
    await page.goto(`${origin}/subresource`);
    expect(proxy.refusalCount).toBeGreaterThan(beforeImage);
    expect(proxy.refusals).toContain(`Managed browser blocked address 127.0.0.1:${deniedPort}.`);
    const popupCreated = context.waitForEvent("page");
    await page.evaluate(`window.open(${JSON.stringify(`${blocked}/popup`)})`);
    const popup = await popupCreated;
    await popup.waitForLoadState();
    expect(await popup.textContent("body")).toContain(`127.0.0.1:${deniedPort}`);
    await page.goto(origin);
    const count = proxy.refusals.length;
    await page.evaluate(async (url) => {
      await fetch(url).catch(() => undefined);
    }, `${blocked}/fetch`);
    expect(proxy.refusals.length).toBeGreaterThan(count);
    const beforeSocket = proxy.refusalCount;
    await page.evaluate(
      (url) =>
        new Promise<void>((resolve) => {
          const socket = new WebSocket(url);
          socket.addEventListener("error", () => resolve(), { once: true });
          socket.addEventListener(
            "open",
            () => {
              socket.close();
              resolve();
            },
            { once: true },
          );
        }),
      `ws://127.0.0.1:${deniedPort}/socket`,
    );
    expect(proxy.refusalCount).toBeGreaterThan(beforeSocket);
    expect(proxy.refusals.at(-1)).toContain(`127.0.0.1:${deniedPort}`);
    expect((await page.goto(`http://rebound.example.test:${deniedPort}/`))?.status()).toBe(403);
    expect(proxy.refusals.at(-1)).toContain(`rebound.example.test:${deniedPort}`);
    const tlsPage = await context.newPage();
    await expect(tlsPage.goto(`https://127.0.0.1:${deniedPort}/`)).rejects.toThrow();
    await tlsPage.close();
    expect(proxy.refusals.at(-1)).toContain(`127.0.0.1:${deniedPort}`);
    expect(deniedHits).toBe(0);
    await page.goto(`http://public.example.test:${allowedPort}/`);
    expect(await page.title()).toBe("Allowed preview");
    policy = [];
    expect((await page.goto(`${origin}/revoked`))?.status()).toBe(403);
    expect(proxy.refusals.at(-1)).toContain(`127.0.0.1:${allowedPort}`);
  } finally {
    await browser.close();
    await proxy.close();
    await Promise.all([close(allowed), close(denied)]);
  }
});

const proxyRequest = (proxy: ManagedBrowserProxy, url: string, authenticate = true) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const config = proxy.configuration;
    const endpoint = new URL(config.server);
    const request = NodeHttp.request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: url,
        headers: authenticate
          ? {
              "Proxy-Authorization": `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
            }
          : {},
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode!, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });

it("requires its context credential and checks every resolved IP, mapped IPv6, self and server ports", async () => {
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => ["localhost:9999", "127.0.0.1:1-65535"],
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  try {
    expect((await proxyRequest(proxy, "http://example.test/", false)).status).toBe(407);
    for (const url of [
      "http://mixed.test/",
      "http://localhost:9999/",
      "http://[::ffff:127.0.0.1]/",
      proxy.configuration.server,
    ]) {
      const result = await proxyRequest(proxy, url);
      expect(result.status).toBe(403);
      expect(result.body).toContain("blocked address");
    }
  } finally {
    await proxy.close();
  }
});

it("denies every private range and alternate loopback spelling with an empty allow list", async () => {
  const proxy = await ManagedBrowserProxy.start({ serverPort: 9999, policy: async () => [] });
  try {
    for (const host of [
      "127.2.3.4",
      "localhost",
      "preview.localhost",
      "2130706433",
      "0x7f000001",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.0.1",
      "100.64.0.1",
      "100.100.100.100",
      "100.127.255.255",
      "[::ffff:100.64.0.1]",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[fc00::1]",
      "[fdff::1]",
      "[fe80::1]",
      "[febf::1]",
    ]) {
      const result = await proxyRequest(proxy, `http://${host}/`);
      expect(result.status, host).toBe(403);
      expect(result.body).toContain("blocked address");
    }
  } finally {
    await proxy.close();
  }
});

it("denies a name that resolves into the carrier-grade NAT range used by tailnets", async () => {
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [],
    resolve: async () => [{ address: "100.100.100.100", family: 4 }],
  });
  try {
    const result = await proxyRequest(proxy, "http://tailnet-host.test/");
    expect(result.status).toBe(403);
    expect(result.body).toContain("blocked address");
  } finally {
    await proxy.close();
  }
});

it("reaches an allowed .localhost preview that listens only on IPv6 loopback", async () => {
  const destination = NodeHttp.createServer((_request, response) => response.end("ipv6 preview"));
  await new Promise<void>((resolve, reject) => {
    destination.once("error", reject);
    destination.listen(0, "::1", resolve);
  });
  const port = (destination.address() as NodeNet.AddressInfo).port;
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [`preview.localhost:${port}`],
  });
  try {
    const result = await proxyRequest(proxy, `http://preview.localhost:${port}/`);
    expect(result.status).toBe(200);
    expect(result.body).toBe("ipv6 preview");
  } finally {
    await proxy.close();
    await close(destination);
  }
});

it("tunnels authenticated CONNECT traffic to the validated allowed IP", async () => {
  const destination = NodeHttp.createServer((_request, response) => response.end("tunnel fixture"));
  const port = await listen(destination);
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [`127.0.0.1:${port}`],
  });
  const endpoint = new URL(proxy.configuration.server);
  const socket = NodeNet.connect({ host: endpoint.hostname, port: Number(endpoint.port) });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      let received = "";
      let requested = false;
      socket.on("data", (data) => {
        received += String(data);
        if (!requested && received.includes("\r\n\r\n")) {
          requested = true;
          socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        }
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(received));
      socket.on("connect", () => {
        const authorization = Buffer.from(
          `${proxy.configuration.username}:${proxy.configuration.password}`,
        ).toString("base64");
        socket.write(
          `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
        );
      });
    });
    expect(response).toContain("200 Connection Established");
    expect(response).toContain("tunnel fixture");
    expect(proxy.refusals).toEqual([]);
  } finally {
    socket.destroy();
    await proxy.close();
    await close(destination);
  }
});

it("waits on a quiet allowed upstream until its answer, and cuts one that stays silent past the idle bound", async () => {
  const destination = NodeHttp.createServer((request, response) => {
    if (request.url === "/slow") setTimeout(() => response.end("solved"), 600);
  });
  const port = await listen(destination);
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [`127.0.0.1:${port}`],
    upstreamIdleMs: 300,
  });
  try {
    expect((await proxyRequest(proxy, `http://127.0.0.1:${port}/hang`)).status).toBe(502);
  } finally {
    await proxy.close();
  }
  const patient = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [`127.0.0.1:${port}`],
    upstreamIdleMs: 1_200,
  });
  try {
    expect(await proxyRequest(patient, `http://127.0.0.1:${port}/slow`)).toEqual({
      status: 200,
      body: "solved",
    });
  } finally {
    await patient.close();
    await close(destination);
  }
});

it("ends a waiting request's upstream connection when the page abandons it or its context closes", async () => {
  let received = Promise.withResolvers<void>();
  let upstreamClosed = Promise.withResolvers<void>();
  const destination = NodeHttp.createServer((request) => {
    request.socket.once("close", () => upstreamClosed.resolve());
    received.resolve();
  });
  const port = await listen(destination);
  const proxy = await ManagedBrowserProxy.start({
    serverPort: 9999,
    policy: async () => [`127.0.0.1:${port}`],
  });
  const endpoint = new URL(proxy.configuration.server);
  const { username, password } = proxy.configuration;
  const waiting = () => {
    const request = NodeHttp.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `http://127.0.0.1:${port}/solve`,
      headers: {
        "Proxy-Authorization": `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
    });
    request.on("error", () => undefined);
    request.end();
    return request;
  };
  try {
    const abandoned = waiting();
    await received.promise;
    abandoned.destroy();
    await upstreamClosed.promise;

    received = Promise.withResolvers<void>();
    upstreamClosed = Promise.withResolvers<void>();
    waiting();
    await received.promise;
    // Closing a tab and revoking its access both close the context, which closes its proxy.
    await proxy.close();
    await upstreamClosed.promise;
  } finally {
    await proxy.close();
    await close(destination);
  }
});
