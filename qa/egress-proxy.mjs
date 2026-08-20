#!/usr/bin/env node

/** Deny-by-default forward proxy for the credential-bearing QA container. */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { inspectTlsClientHello } from './tls-client-hello.mjs';

const encoded = process.env.JUROR_QA_EGRESS_ALLOW_B64?.trim();
if (!encoded) throw new Error('JUROR_QA_EGRESS_ALLOW_B64 is required');

let configured;
try {
  configured = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
} catch {
  throw new Error('JUROR_QA_EGRESS_ALLOW_B64 must encode a JSON origin list');
}
if (!Array.isArray(configured) || configured.length === 0 || configured.length > 100) {
  throw new Error('egress allowlist must contain 1-100 exact origins');
}

function normalizedOrigin(value) {
  if (typeof value !== 'string') throw new Error('egress origins must be strings');
  const url = new URL(value);
  const hostname = bareHostname(url.hostname);
  const local = explicitLoopbackHostname(hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol === 'https:' && net.isIP(hostname))) {
    throw new Error(`invalid exact egress origin: ${value}`);
  }
  return url.origin;
}

const allowed = new Set(configured.map(normalizedOrigin));
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;

function privateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function privateAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) return privateIpv4(address);
  if (kind !== 6) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return privateIpv4(lower.slice('::ffff:'.length));
  return lower === '::' || lower === '::1' || lower.startsWith('fc') ||
    lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

function bareHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function explicitLoopbackHostname(hostname) {
  const bare = bareHostname(hostname).toLowerCase();
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1';
}

function loopbackAddress(address) {
  const lower = bareHostname(address).toLowerCase();
  return lower === '127.0.0.1' || lower === '::1' || lower === '::ffff:127.0.0.1';
}

async function publicAddress(hostname, allowLoopback = false) {
  const bare = bareHostname(hostname);
  if (net.isIP(bare)) {
    if (privateAddress(bare) && !(allowLoopback && loopbackAddress(bare))) {
      throw new Error('private address denied');
    }
    return bare;
  }
  const answers = await dns.lookup(bare, { all: true, verbatim: true });
  const allowedAnswer = answers.find((answer) =>
    !privateAddress(answer.address) || (allowLoopback && loopbackAddress(answer.address)));
  if (!allowedAnswer) throw new Error('hostname resolved only to denied private addresses');
  return allowedAnswer.address;
}

function deny(socket, status = '403 Forbidden') {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const server = http.createServer(async (request, response) => {
  let target;
  try {
    target = new URL(request.url ?? '');
    if (!allowed.has(target.origin)) throw new Error('origin denied');
    const address = await publicAddress(
      target.hostname,
      explicitLoopbackHostname(target.hostname),
    );
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...request.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: address,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  } catch {
    response.writeHead(403, { 'content-length': '0' });
    response.end();
  }
});

server.on('connect', (request, client, head) => {
  void (async () => {
    try {
      const authority = request.url ?? '';
      const portMatch = authority.match(/:(\d+)$/);
      if (!portMatch || !/^[^/?#]+:\d+$/.test(authority)) throw new Error('invalid CONNECT authority');
      const port = Number(portMatch[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid CONNECT port');
      const target = new URL(`https://${authority}`);
      if (!allowed.has(target.origin)) throw new Error('origin denied');
      const address = await publicAddress(
        target.hostname,
        explicitLoopbackHostname(target.hostname),
      );
      // Establish the upstream TCP socket before acknowledging CONNECT. If the
      // proxy replies first, the client's TLS-handshake timeout also includes a
      // slow upstream dial and can expire even though the proxy is healthy.
      // No bytes leave this socket until the ClientHello SNI is verified below.
      const upstream = net.connect({ host: address, port });
      let connectAcknowledged = false;
      const connectTimer = setTimeout(() => {
        upstream.destroy();
        deny(client, '504 Gateway Timeout');
      }, UPSTREAM_CONNECT_TIMEOUT_MS);
      upstream.once('connect', () => {
        clearTimeout(connectTimer);
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        connectAcknowledged = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let buffered = head;
        const helloTimer = setTimeout(() => {
          upstream.destroy();
          client.destroy();
        }, 10_000);
        const inspect = (chunk) => {
          if (chunk.length > 0) buffered = Buffer.concat([buffered, chunk]);
          const hello = inspectTlsClientHello(buffered);
          if (hello.state === 'more') return;
          client.off('data', inspect);
          clearTimeout(helloTimer);
          if (hello.state !== 'ok' || hello.servername !== target.hostname.toLowerCase()) {
            upstream.destroy();
            client.destroy();
            return;
          }
          client.pause();
          upstream.write(buffered);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        };
        client.on('data', inspect);
        if (head.length > 0) inspect(Buffer.alloc(0));
      });
      upstream.on('error', () => {
        clearTimeout(connectTimer);
        if (connectAcknowledged) client.destroy();
        else deny(client, '502 Bad Gateway');
      });
      client.on('error', () => upstream.destroy());
      client.on('close', () => {
        clearTimeout(connectTimer);
        upstream.destroy();
      });
    } catch {
      deny(client);
    }
  })();
});

server.on('upgrade', (_request, socket) => deny(socket));
const listenPort = Number(process.env.JUROR_QA_EGRESS_PORT ?? 8080);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('JUROR_QA_EGRESS_PORT must be a valid TCP port');
}
server.listen(listenPort, '0.0.0.0', () => process.stdout.write('juror-qa-egress-proxy ready\n'));
