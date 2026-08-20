import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import tls from 'node:tls';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectTlsClientHello } from '../qa/tls-client-hello.mjs';

const children = new Set<ChildProcessWithoutNullStreams>();
const fixtureServers = new Set<Server>();

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test port unavailable');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function startProxy(origins: string[]): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  const port = await freePort();
  const child = spawn(process.execPath, [path.resolve('qa/egress-proxy.mjs')], {
    env: {
      ...process.env,
      JUROR_QA_EGRESS_PORT: String(port),
      JUROR_QA_EGRESS_ALLOW_B64: Buffer.from(JSON.stringify(origins)).toString('base64'),
    },
    stdio: 'pipe',
  });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy start timed out')), 5_000);
    child.once('exit', (code) => reject(new Error(`proxy exited ${code}`)));
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return { child, port };
}

async function connectResponse(port: number, authority: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('end', () => resolve(response));
  });
}

async function startLoopbackFixture(): Promise<number> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      const body = 'loopback fixture reached';
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  fixtureServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '::', ipv6Only: false }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback fixture unavailable');
  return address.port;
}

async function proxyHttpResponse(port: number, target: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => socket.destroy(new Error('proxy request timed out')));
    socket.once('error', reject);
    socket.once('connect', () => {
      const url = new URL(target);
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('end', () => resolve(response));
  });
}

afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
  await Promise.all([...fixtureServers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  fixtureServers.clear();
});

describe('QA egress proxy containment', () => {
  it('does not acknowledge CONNECT until the allowlisted upstream socket is connected', () => {
    const source = readFileSync(path.resolve('qa/egress-proxy.mjs'), 'utf8');
    const connected = source.indexOf("upstream.once('connect'");
    const acknowledged = source.indexOf("client.write('HTTP/1.1 200 Connection Established");
    const inspected = source.indexOf('inspectTlsClientHello(buffered)');
    const forwarded = source.indexOf('upstream.write(buffered)');

    expect(connected).toBeGreaterThan(-1);
    expect(acknowledged).toBeGreaterThan(connected);
    expect(inspected).toBeGreaterThan(acknowledged);
    expect(forwarded).toBeGreaterThan(inspected);
  });

  it('denies unlisted hosts and ports before opening a tunnel', async () => {
    const { port } = await startProxy(['https://example.com']);
    await expect(connectResponse(port, 'api.openai.com:443')).resolves.toContain('403 Forbidden');
    await expect(connectResponse(port, 'example.com:444')).resolves.toContain('403 Forbidden');
  });

  it.each([
    ['localhost', (port: number) => `http://localhost:${port}`],
    ['IPv4 loopback', (port: number) => `http://127.0.0.1:${port}`],
    ['IPv6 loopback', (port: number) => `http://[::1]:${port}`],
  ])('proxies an explicitly allowlisted %s origin', async (_label, originForPort) => {
    const fixturePort = await startLoopbackFixture();
    const origin = originForPort(fixturePort);
    const { port } = await startProxy([origin]);

    const response = await proxyHttpResponse(port, `${origin}/health`);

    expect(response).toContain('200 OK');
    expect(response).toContain('loopback fixture reached');
  });

  it.each([
    'http://127.0.0.2:4321',
    'http://10.0.0.1:4321',
    'http://192.168.1.1:4321',
    'http://[fc00::1]:4321',
  ])('does not broaden local development access to another private origin: %s', async (origin) => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.resolve('qa/egress-proxy.mjs')], {
      env: {
        ...process.env,
        JUROR_QA_EGRESS_PORT: String(port),
        JUROR_QA_EGRESS_ALLOW_B64: Buffer.from(JSON.stringify([origin])).toString('base64'),
      },
      stdio: 'pipe',
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).not.toBe(0);
  });

  it('fails closed for non-origin allowlist entries', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.resolve('qa/egress-proxy.mjs')], {
      env: {
        ...process.env,
        JUROR_QA_EGRESS_PORT: String(port),
        JUROR_QA_EGRESS_ALLOW_B64: Buffer.from(JSON.stringify(['https://example.com/path'])).toString('base64'),
      },
      stdio: 'pipe',
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).not.toBe(0);
  });

  it('extracts the real TLS SNI so CONNECT cannot tunnel to another shared host', async () => {
    const server = createServer();
    const hello = await new Promise<Buffer>((resolve, reject) => {
      server.once('error', reject);
      server.on('connection', (socket) => {
        socket.once('data', (chunk) => {
          resolve(chunk);
          socket.destroy();
          server.close();
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('TLS fixture unavailable'));
        const client = tls.connect({
          host: '127.0.0.1',
          port: address.port,
          servername: 'cloudflare.com',
          rejectUnauthorized: false,
        });
        client.on('error', () => {});
      });
    });

    expect(inspectTlsClientHello(hello)).toEqual({ state: 'ok', servername: 'cloudflare.com' });
    expect(inspectTlsClientHello(hello.subarray(0, 8))).toEqual({ state: 'more' });
  });
});
