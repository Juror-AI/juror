import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import {
  QaBrowserBroker,
  qaBrowserEnvironment,
  type QaBrowserBrokerOptions,
} from '../src/qa/browser.js';
import {
  QA_SCHEMA_VERSION,
  type QaCheckpointAssertion,
  type QaCheckpointAssertionKind,
  type QaPlan,
} from '../src/qa/types.js';

let fixtureServer: Server;
let fixtureUrl: string;
let sessionServer: Server;
let sessionServerUrl: string;
let unsafeRequests = 0;
let passivePostRequests = 0;
let passiveSocketConnections = 0;
let authBootstrapRequests = 0;
let authHttpErrorRequests = 0;
let slowAuthAborts = 0;
let sessionRequests = 0;
let failedOneTimeNavigations = 0;
const sessionAuthorizations: Array<string | undefined> = [];
const sessionBodies: string[] = [];
const mintedSessionTokens: string[] = [];
const targetSecretHeaders: Array<string | undefined> = [];
const targetSessionCookies: Array<string | undefined> = [];
const crossOriginSecretHeaders: Array<string | undefined> = [];
const passiveSockets = new Set<import('node:net').Socket>();
const temporaryDirectories = new Set<string>();
const AUTH_COOKIE_CANARY = 'derived-http-only-cookie-canary';
const AUTH_LOCAL_CANARY = 'derived-local-storage-canary';
const AUTH_SESSION_CANARY = 'derived-session-storage-canary';
const AUTH_INDEXED_DB_CANARY = 'derived-indexed-db-canary';
const AUTH_TRANSIENT_CANARY = 'same-operation-transient-canary';
const AUTH_URL_CANARY = 'page-controlled-url-canary';
const AUTH_OPTION_CANARY = 'page-controlled-option-canary';
const AUTH_POLICY_CANARY = 'blocked-policy-url-canary';
const AUTH_BOUNDARY_CANARY = 'truncation-boundary-canary';
const SESSION_BEARER_CANARY = 'staging-session-bearer-canary-value';
const BROWSER_HEADER_CANARY = 'staging-browser-header-canary-value';

function cssAssertion(
  kind: Exclude<QaCheckpointAssertionKind, 'url' | 'status'>,
  value: string,
  nth: number | null = null,
): QaCheckpointAssertion {
  return {
    kind,
    locator: { by: 'css', value, name: null, exact: false, nth },
    url_contains: null,
  };
}

function roleAssertion(
  kind: Exclude<QaCheckpointAssertionKind, 'url' | 'status'>,
  value: string,
  name: string | null,
): QaCheckpointAssertion {
  return {
    kind,
    locator: { by: 'role', value, name, exact: false, nth: null },
    url_contains: null,
  };
}

function plan(): QaPlan {
  return {
    schema_version: QA_SCHEMA_VERSION,
    impact_assessment: 'The fixture form and its confirmation are affected.',
    testability: 'testable',
    no_testable_surface_reason: null,
    surfaces: ['Fixture form'],
    scenarios: [
      {
        id: 'exercise-fixture',
        title: 'Exercise the fixture form',
        rationale: 'The form represents the changed browser surface.',
        viewport: {
          kind: 'desktop',
          width: 1_440,
          height: 900,
          justification: 'The fixture is a desktop form.',
        },
        preconditions: ['The local fixture server is running.'],
        seeded_state: [],
        checkpoints: [
          {
            id: 'fixture-heading',
            description: 'Inspect the fixture heading.',
            expected: 'QA fixture',
            assertion: cssAssertion('text', 'h1'),
          },
        ],
        allowed_mutations: ['none'],
        cleanup_expectations: [],
      },
    ],
    risk_notes: [],
    blind_spots: [],
  };
}

function evidenceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'juror-qa-browser-'));
  temporaryDirectories.add(directory);
  return directory;
}

function brokerOptions(
  evidenceDir: string,
  overrides: Partial<QaBrowserBrokerOptions> = {},
): QaBrowserBrokerOptions {
  return {
    targetUrl: fixtureUrl,
    evidenceDir,
    allowedOrigins: [],
    maxScenarios: 2,
    maxOperations: 20,
    timeoutMs: 30_000,
    headless: true,
    // GitHub-hosted Ubuntu disables the user-namespace sandbox. Production does
    // not pass this override and is validated in the hardened QA container.
    chromiumSandbox: process.platform !== 'linux',
    video: 'off',
    trace: 'off',
    screenshot: 'off',
    // Production uses a fixed 10s admission window; tests retain the same
    // outcome-independent behavior with a shorter trusted-only window.
    sensitiveSetupWindowMs: 1_500,
    ...overrides,
  };
}

function scenarioEvidence(evidenceDir: string, attempt: 1 | 2): string {
  return join(evidenceDir, 'scenarios', 'exercise-fixture', `attempt-${attempt}`);
}

function mediaFiles(directory: string): string[] {
  return readdirSync(directory).filter((file) =>
    file.endsWith('.webm') || file === 'trace.zip' || file === 'final.png',
  );
}

beforeAll(async () => {
  fixtureServer = createServer((request, response) => {
    if (request.url?.startsWith('/failed-request-')) {
      request.socket.destroy();
      return;
    }
    if (request.url === '/auth-bootstrap') {
      authBootstrapRequests++;
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [
          `juror_session=${AUTH_COOKIE_CANARY}; Path=/; HttpOnly; SameSite=Lax`,
          'juror_preference=1; Path=/; SameSite=Lax',
        ],
      });
      response.end(`<!doctype html><html><body><p id="ready">Preparing</p><script>
        localStorage.setItem('juror-auth-token', ${JSON.stringify(AUTH_LOCAL_CANARY)});
        localStorage.setItem('juror-preference', '1');
        sessionStorage.setItem('juror-session-token', ${JSON.stringify(AUTH_SESSION_CANARY)});
        const open = indexedDB.open('juror-auth', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('sessions', { keyPath: 'id' });
        open.onsuccess = () => {
          const transaction = open.result.transaction('sessions', 'readwrite');
          transaction.objectStore('sessions').put({
            id: 'current',
            auth: { token: ${JSON.stringify(AUTH_INDEXED_DB_CANARY)}, expires: new Date() },
          });
          transaction.oncomplete = () => { document.querySelector('#ready').textContent = 'Ready'; };
        };
      </script></body></html>`);
      return;
    }
    if (request.url?.startsWith('/support-login?')) {
      const url = new URL(request.url, fixtureUrl);
      mintedSessionTokens.push(url.searchParams.get('token') ?? '');
      targetSecretHeaders.push(request.headers['x-staging-access'] as string | undefined);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'juror_support_session=ready; Path=/; HttpOnly; SameSite=Lax',
      });
      response.end(`<h1>QA fixture</h1><p>Support session redeeming</p><script>
        setTimeout(() => localStorage.setItem('juror-support-ready', 'ready'), 250);
      </script>`);
      return;
    }
    if (request.url?.startsWith('/support-login-fail?')) {
      failedOneTimeNavigations++;
      request.socket.destroy();
      return;
    }
    if (request.url === '/header-redirect') {
      targetSecretHeaders.push(request.headers['x-staging-access'] as string | undefined);
      targetSessionCookies.push(request.headers.cookie);
      response.writeHead(302, { location: `${sessionServerUrl}header-capture-redirect` }).end();
      return;
    }
    if (request.url === '/slow-auth') {
      response.once('close', () => {
        if (!response.writableEnded) slowAuthAborts++;
      });
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end('<h1>Slow login</h1>');
        }
      }, 5_000);
      return;
    }
    if (request.url?.startsWith('/sensitive-state')) {
      const serverCookie = request.headers.cookie ?? '';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><title>${AUTH_COOKIE_CANARY}</title></head><body>
        <h1>QA fixture</h1>
        <p id="state-ready">Checking state</p>
        <p id="idb-ready">Checking IndexedDB</p>
        <p id="secret">${serverCookie} | ${AUTH_LOCAL_CANARY} | ${AUTH_SESSION_CANARY}</p>
        <p id="boundary">${'x'.repeat(29_990)}${AUTH_BOUNDARY_CANARY}</p>
        <input id="secret-input" value="${AUTH_COOKIE_CANARY}">
        <select id="secret-select"><option value="${AUTH_OPTION_CANARY}" selected>Public option</option></select>
        <button id="transient" type="button">Render transient state</button>
        <script>
          const expectedCookie = ${JSON.stringify(AUTH_COOKIE_CANARY)};
          const stateReady = ${JSON.stringify(serverCookie)}.includes(expectedCookie)
            && localStorage.getItem('juror-auth-token') === ${JSON.stringify(AUTH_LOCAL_CANARY)}
            && sessionStorage.getItem('juror-session-token') === ${JSON.stringify(AUTH_SESSION_CANARY)};
          document.querySelector('#state-ready').textContent = stateReady ? 'State ready' : 'State missing';
          const open = indexedDB.open('juror-auth', 1);
          open.onsuccess = () => {
            const request = open.result.transaction('sessions').objectStore('sessions').get('current');
            request.onsuccess = () => {
              document.querySelector('#idb-ready').textContent = request.result?.auth?.token === ${JSON.stringify(AUTH_INDEXED_DB_CANARY)}
                ? 'IndexedDB ready'
                : 'IndexedDB missing';
            };
          };
          history.replaceState({}, '', '/sensitive-state/' + ${JSON.stringify(AUTH_URL_CANARY)});
          console.error('sensitive page', ${JSON.stringify(AUTH_COOKIE_CANARY)}, ${JSON.stringify(AUTH_LOCAL_CANARY)});
          fetch('/failed-request-' + encodeURIComponent(${JSON.stringify(AUTH_SESSION_CANARY)})).catch(() => {});
          const image = document.createElement('img');
          image.src = 'https://example.invalid/' + ${JSON.stringify(AUTH_POLICY_CANARY)};
          document.body.append(image);
          document.querySelector('#transient').onclick = () => {
            sessionStorage.setItem('ephemeral-token', ${JSON.stringify(AUTH_TRANSIENT_CANARY)});
            document.querySelector('#secret').textContent = sessionStorage.getItem('ephemeral-token');
            sessionStorage.removeItem('ephemeral-token');
            console.error('transient', ${JSON.stringify(AUTH_TRANSIENT_CANARY)});
          };
        </script>
      </body></html>`);
      return;
    }
    if (request.url === '/http-error') {
      authHttpErrorRequests++;
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Server error</h1>');
      return;
    }
    if (request.url === '/gone') {
      response.writeHead(410, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Endpoint retired</h1>');
      return;
    }
    if (request.url === '/optional-resource') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>QA fixture</h1><img src="https://example.invalid/optional.png">');
      return;
    }
    if (request.url === '/assertion-values') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<input id="empty-value" value=""><textarea id="long-value">${'x'.repeat(5_000)}</textarea>`,
      );
      return;
    }
    if (request.url === '/responsive-duplicates') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`
        <button class="responsive-action" style="display: none">Responsive action</button>
        <button class="responsive-action">Responsive action</button>
        <p class="all-hidden" hidden>Hidden desktop copy</p>
        <p class="all-hidden" style="visibility: hidden">Hidden mobile copy</p>
      `);
      return;
    }
    if (request.url === '/unsafe-form') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>QA fixture</h1><form onsubmit="event.preventDefault(); fetch(\'/mutated\',{method:\'POST\'})"><button>Save</button></form>');
      return;
    }
    if (request.url === '/passive-post') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<h1>QA fixture</h1><p id="loaded">Loading</p>
        <script>fetch('/read-query',{method:'POST',headers:{'content-type':'application/json'},body:'{"query":"query Viewer { viewer { id } }"}'})
          .then(() => { document.querySelector('#loaded').textContent = 'Loaded'; });</script>`);
      return;
    }
    if (request.url === '/passive-socket') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<h1>QA fixture</h1><p id="loaded">Loading</p>
        <script>const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/socket');
          ws.onopen=()=>{document.querySelector('#loaded').textContent='Loaded';};</script>`);
      return;
    }
    if (request.url === '/read-query') {
      passivePostRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":{"viewer":{"id":"qa"}}}');
      return;
    }
    if (request.url === '/mutated') {
      unsafeRequests++;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>Mutated</h1>');
      return;
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>Juror QA fixture</title></head>
        <body>
          <h1>QA fixture</h1>
          <label for="fixture-name">Name</label>
          <input id="fixture-name" />
          <button type="button" onclick="document.querySelector('#result').hidden = false">Save</button>
          <a id="synthetic-page" href="about:blank">Synthetic page</a>
          <p id="result" hidden>Saved</p>
          <p id="viewport"></p>
          <script>document.querySelector('#viewport').textContent = window.innerWidth + 'x' + window.innerHeight;</script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', () => {
      fixtureServer.off('error', reject);
      resolve();
    });
  });
  const address = fixtureServer.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind to TCP');
  fixtureUrl = `http://127.0.0.1:${address.port}/`;
  fixtureServer.on('upgrade', (request, socket) => {
    if (request.url !== '/socket' || typeof request.headers['sec-websocket-key'] !== 'string') {
      socket.destroy();
      return;
    }
    passiveSocketConnections++;
    passiveSockets.add(socket);
    socket.once('close', () => passiveSockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });

  sessionServer = createServer((request, response) => {
    if (request.url === '/header-capture-redirect') {
      crossOriginSecretHeaders.push(request.headers['x-staging-access'] as string | undefined);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<h1>QA fixture</h1><p>Cross-origin redirect complete</p>');
      return;
    }
    if (!request.url?.startsWith('/synthetic-session/')) {
      response.writeHead(404).end();
      return;
    }
    const mode = request.url.slice('/synthetic-session/'.length);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      sessionRequests++;
      sessionAuthorizations.push(request.headers.authorization);
      sessionBodies.push(body);
      const token = `one-time-session-${sessionRequests}`;
      const redirectOrigin = mode === 'wrong-origin' ? sessionServerUrl : fixtureUrl;
      const expiresAt = mode === 'expired'
        ? new Date(Date.now() - 60_000)
        : mode === 'too-long'
          ? new Date(Date.now() + 2 * 60 * 60_000)
        : new Date(Date.now() + 5 * 60_000);
      const status = mode === 'bad-status' ? 200 : 201;
      response.writeHead(status, {
        'content-type': mode === 'bad-content-type'
          ? 'text/plain; charset=utf-8'
          : 'application/json; charset=utf-8',
      });
      if (mode === 'bad-json') {
        response.end('{invalid');
        return;
      }
      if (mode === 'oversized') {
        response.end(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
        return;
      }
      response.end(JSON.stringify({
        status: 'success',
        message: 'Synthetic monitor support session created',
        data: {
          redirect_url: mode === 'missing-token'
            ? `${redirectOrigin}support-login`
            : mode === 'extra-query'
              ? `${redirectOrigin}support-login?token=${token}&locale=en`
              : mode === 'navigation-failure'
                ? `${redirectOrigin}support-login-fail?token=${token}`
                : `${redirectOrigin}support-login?token=${token}`,
          expires_at: expiresAt.toISOString(),
          token_type: mode === 'wrong-token-type' ? 'bearer' : 'support_session',
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    sessionServer.once('error', reject);
    sessionServer.listen(0, '127.0.0.1', () => {
      sessionServer.off('error', reject);
      resolve();
    });
  });
  const sessionAddress = sessionServer.address();
  if (!sessionAddress || typeof sessionAddress === 'string') {
    throw new Error('Session fixture server did not bind to TCP');
  }
  sessionServerUrl = `http://127.0.0.1:${sessionAddress.port}/`;
});

afterEach(() => {
  unsafeRequests = 0;
  passivePostRequests = 0;
  passiveSocketConnections = 0;
  authBootstrapRequests = 0;
  authHttpErrorRequests = 0;
  slowAuthAborts = 0;
  sessionRequests = 0;
  failedOneTimeNavigations = 0;
  sessionAuthorizations.length = 0;
  sessionBodies.length = 0;
  mintedSessionTokens.length = 0;
  targetSecretHeaders.length = 0;
  targetSessionCookies.length = 0;
  crossOriginSecretHeaders.length = 0;
  for (const socket of passiveSockets) socket.destroy();
  passiveSockets.clear();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

afterAll(async () => {
  await Promise.all([fixtureServer, sessionServer].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

describe.sequential('QaBrowserBroker policy boundary', () => {
  it('passes only a minimal non-secret environment to Chromium', () => {
    expect(qaBrowserEnvironment({
      PATH: '/usr/bin',
      HOME: '/tmp/qa-home',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: 'github-secret',
      OPENAI_API_KEY: 'provider-secret',
      JUROR_QA_SECRETS_B64: 'encoded-secret-map',
    })).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/qa-home',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
    });
  });

  it('accepts a Node-bracketed IPv6 loopback HTTP target', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      targetUrl: 'http://[::1]:4173/',
    }));

    await broker.initialize();
    expect(broker.startedBrowser()).toBe(false);
    await broker.close();
  });

  it('rejects staging authentication configuration that is not securely and exactly bound', () => {
    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      sessionBootstrap: {
        url: `${fixtureUrl}synthetic-session`,
        secret: 'session_token',
        targetOrigin: 'http://127.0.0.1:1',
        readyStorageKey: 'juror-support-ready',
      },
    }))).toThrow('exactly match');

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      allowedOrigins: ['http://example.test'],
      sessionBootstrap: {
        url: 'http://example.test/synthetic-session',
        secret: 'session_token',
        targetOrigin: new URL(fixtureUrl).origin,
        readyStorageKey: 'juror-support-ready',
      },
    }))).toThrow('HTTPS (or loopback HTTP)');

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      allowedOrigins: ['https://203.0.113.10'],
      sessionBootstrap: {
        url: 'https://203.0.113.10/synthetic-session',
        secret: 'session_token',
        targetOrigin: new URL(fixtureUrl).origin,
        readyStorageKey: 'juror-support-ready',
      },
    }))).toThrow('HTTPS (or loopback HTTP)');

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      allowedOrigins: ['http://example.test'],
      browserSecretHeaders: [{
        name: 'x-staging-access',
        secret: 'browser_access',
        origins: ['http://example.test'],
      }],
    }))).toThrow('HTTPS (or loopback HTTP)');

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      allowedOrigins: [new URL(sessionServerUrl).origin],
      browserSecretHeaders: [{
        name: 'x-staging-access',
        secret: 'browser_access',
        origins: [new URL(sessionServerUrl).origin],
      }],
    }))).toThrow('exactly match the QA target origin');

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      browserSecretHeaders: Array.from({ length: 21 }, () => ({
        name: 'x-staging-access',
        secret: 'browser_access',
        origins: [new URL(fixtureUrl).origin],
      })),
    }))).toThrow('at most 20 entries');
  });

  it('accepts only the Cloudflare Access service-token pair outside X-* browser headers', () => {
    const targetOrigin = new URL(fixtureUrl).origin;
    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      browserSecretHeaders: [
        {
          name: 'CF-Access-Client-Id',
          secret: 'cf_access_client_id',
          origins: [targetOrigin],
        },
        {
          name: 'CF-Access-Client-Secret',
          secret: 'cf_access_client_secret',
          origins: [targetOrigin],
        },
        {
          name: 'x-staging-waf-bypass',
          secret: 'staging_gateway_token',
          origins: [targetOrigin],
        },
      ],
    }))).not.toThrow();

    expect(() => new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      browserSecretHeaders: [{
        name: 'CF-Access-Jwt-Assertion',
        secret: 'cf_access_jwt_assertion',
        origins: [targetOrigin],
      }],
    }))).toThrow('standard Cloudflare Access service-token headers');
  });

  it('mints a fresh sealed staging session per attempt and scopes browser headers by exact origin', async () => {
    const evidenceDir = evidenceDirectory();
    const targetOrigin = new URL(fixtureUrl).origin;
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      allowedOrigins: [new URL(sessionServerUrl).origin],
      sessionBootstrap: {
        url: `${sessionServerUrl}synthetic-session/valid`,
        secret: 'staging_session_token',
        targetOrigin,
        readyStorageKey: 'juror-support-ready',
      },
      browserSecretHeaders: [{
        name: 'x-staging-access',
        secret: 'staging_browser_access',
        origins: [targetOrigin],
      }],
      secrets: {
        staging_session_token: SESSION_BEARER_CANARY,
        staging_browser_access: BROWSER_HEADER_CANARY,
      },
      timeoutMs: 60_000,
      sensitiveSetupWindowMs: 4_000,
      video: 'all',
      trace: 'all',
      screenshot: 'all',
    }));
    const outward: unknown[] = [];
    await broker.initialize();
    try {
      outward.push(await broker.handle('submit_plan', plan()));
      for (const attempt of [1, 2] as const) {
        outward.push(await broker.handle('start_scenario', {
          scenario_id: 'exercise-fixture',
          attempt,
        }));
        outward.push(await broker.handle('navigate', {
          url: attempt === 1 ? '/header-redirect' : '/',
        }));
        outward.push(await broker.handle('assert', {
          checkpoint: 'fixture-heading',
          kind: 'text',
          expected: 'QA fixture',
          css: 'h1',
        }));
        outward.push(await broker.handle('finish_scenario', {
          status: 'passed',
          summary: 'The staging-authenticated fixture passed.',
        }));
      }
      outward.push(await broker.handle('finish', {
        summary: 'Both sealed staging attempts passed.',
        issues: [],
      }));

      expect(sessionRequests).toBe(2);
      expect(sessionAuthorizations).toEqual([
        `Bearer ${SESSION_BEARER_CANARY}`,
        `Bearer ${SESSION_BEARER_CANARY}`,
      ]);
      expect(sessionBodies).toEqual(['{}', '{}']);
      expect(mintedSessionTokens).toEqual(['one-time-session-1', 'one-time-session-2']);
      expect(targetSecretHeaders.length).toBeGreaterThanOrEqual(3);
      expect(targetSecretHeaders).toEqual(
        Array.from({ length: targetSecretHeaders.length }, () => BROWSER_HEADER_CANARY),
      );
      expect(targetSessionCookies).toEqual(['juror_support_session=ready']);
      expect(crossOriginSecretHeaders).toEqual([undefined]);
      expect(broker.state().attempts).toMatchObject([
        { attempt: 1, status: 'passed', sensitiveOutput: true },
        { attempt: 2, status: 'passed', sensitiveOutput: true },
      ]);
      const exposed = JSON.stringify({ outward, state: broker.state() });
      for (const canary of [
        SESSION_BEARER_CANARY,
        BROWSER_HEADER_CANARY,
        'one-time-session-1',
        'one-time-session-2',
      ]) expect(exposed).not.toContain(canary);
      for (const attempt of [1, 2] as const) {
        expect(readdirSync(scenarioEvidence(evidenceDir, attempt))).toEqual([]);
      }
    } finally {
      await broker.close();
    }
  }, 60_000);

  it.each([
    ['wrong-origin', 'redirect'],
    ['expired', 'expiry'],
    ['too-long', 'lifetime'],
    ['wrong-token-type', 'token type'],
    ['missing-token', 'token'],
    ['extra-query', 'query contract'],
    ['bad-status', 'HTTP status'],
    ['bad-content-type', 'content type'],
    ['bad-json', 'JSON'],
    ['oversized', 'size'],
  ])('seals and blocks an invalid staging session %s response (%s)', async (mode) => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      allowedOrigins: [new URL(sessionServerUrl).origin],
      sessionBootstrap: {
        url: `${sessionServerUrl}synthetic-session/${mode}`,
        secret: 'staging_session_token',
        targetOrigin: new URL(fixtureUrl).origin,
        readyStorageKey: 'juror-support-ready',
      },
      secrets: { staging_session_token: SESSION_BEARER_CANARY },
      sensitiveSetupWindowMs: 3_000,
      video: 'all',
      trace: 'all',
      screenshot: 'all',
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      const result = await broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 1,
      });
      expect(result).toEqual({ accepted: true, observation: 'sealed' });
      await broker.handle('finish_scenario', {
        status: 'passed',
        summary: 'Agent cannot observe staging setup details.',
      });
      expect(broker.state().attempts).toMatchObject([{
        attempt: 1,
        status: 'blocked',
        sensitiveOutput: true,
      }]);
      const exposed = JSON.stringify({ result, state: broker.state() });
      expect(exposed).not.toContain(SESSION_BEARER_CANARY);
      expect(exposed).not.toContain('one-time-session-1');
      expect(readdirSync(scenarioEvidence(evidenceDir, 1))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('blocks sealed setup when an exact-origin browser header secret is missing', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      browserSecretHeaders: [{
        name: 'x-staging-access',
        secret: 'missing_browser_access',
        origins: [new URL(fixtureUrl).origin],
      }],
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 1,
      })).resolves.toEqual({ accepted: true, observation: 'sealed' });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup.' });
      expect(broker.state().attempts).toMatchObject([{ status: 'blocked', sensitiveOutput: true }]);
      expect(readdirSync(scenarioEvidence(evidenceDir, 1))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('blocks sealed setup when client-side support-session redemption never becomes ready', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      allowedOrigins: [new URL(sessionServerUrl).origin],
      sessionBootstrap: {
        url: `${sessionServerUrl}synthetic-session/valid`,
        secret: 'staging_session_token',
        targetOrigin: new URL(fixtureUrl).origin,
        readyStorageKey: 'missing-support-readiness',
      },
      secrets: { staging_session_token: SESSION_BEARER_CANARY },
      sensitiveSetupWindowMs: 2_000,
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 1,
      })).resolves.toEqual({ accepted: true, observation: 'sealed' });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup.' });
      expect(broker.state().attempts).toMatchObject([{
        attempt: 1,
        status: 'blocked',
        sensitiveOutput: true,
      }]);
      expect(readdirSync(scenarioEvidence(evidenceDir, 1))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('never replays a one-time support URL after its navigation fails', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      allowedOrigins: [new URL(sessionServerUrl).origin],
      sessionBootstrap: {
        url: `${sessionServerUrl}synthetic-session/navigation-failure`,
        secret: 'staging_session_token',
        targetOrigin: new URL(fixtureUrl).origin,
        readyStorageKey: 'juror-support-ready',
      },
      secrets: { staging_session_token: SESSION_BEARER_CANARY },
      sensitiveSetupWindowMs: 3_000,
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 1,
      })).resolves.toEqual({ accepted: true, observation: 'sealed' });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup.' });

      expect(sessionRequests).toBe(1);
      expect(failedOneTimeNavigations).toBe(1);
      expect(broker.state().attempts).toMatchObject([{
        attempt: 1,
        status: 'blocked',
        sensitiveOutput: true,
      }]);
      expect(readdirSync(scenarioEvidence(evidenceDir, 1))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('does not launch Chromium or perform login for a no-surface plan', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [{ action: 'fill', label: 'missing', secret: 'missing-secret' }],
    }));
    await broker.initialize();
    expect(broker.browserVersion()).toBe('unknown');
    const noSurface: QaPlan = {
      ...plan(),
      testability: 'no_testable_surface',
      no_testable_surface_reason: 'Only documentation changed.',
      scenarios: [],
    };
    await broker.handle('submit_plan', noSurface);
    await broker.handle('finish', { summary: 'No browser surface.', issues: [] });
    expect(broker.browserVersion()).toBe('unknown');
    expect(broker.startedBrowser()).toBe(false);
    await broker.close();
  });

  it('rejects oversized supplied storage state before Chromium starts', async () => {
    const evidenceDir = evidenceDirectory();
    const storageState = join(evidenceDir, 'oversized-state.json');
    writeFileSync(storageState, 'x'.repeat(4 * 1024 * 1024 + 1), 'utf8');
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, { storageState }));

    await expect(broker.initialize()).rejects.toThrow('regular file no larger than 4 MiB');
    expect(broker.startedBrowser()).toBe(false);
    await broker.close();
  });

  it('loads encoded IndexedDB storage state while keeping its page output sealed', async () => {
    const stateDir = evidenceDirectory();
    const evidenceDir = evidenceDirectory();
    const storageState = join(stateDir, 'auth-state.json');
    const browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      chromiumSandbox: process.platform !== 'linux',
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${fixtureUrl}auth-bootstrap`);
      await page.getByText('Ready').waitFor({ timeout: 10_000 });
      await context.storageState({ path: storageState, indexedDB: true });
      await context.close();
    } finally {
      await browser.close();
    }
    expect(readFileSync(storageState, 'utf8')).toContain('valueEncoded');

    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      storageState,
      video: 'all',
      trace: 'all',
      screenshot: 'all',
    }));
    const suppliedPlan = plan();
    suppliedPlan.scenarios[0]!.checkpoints = [
      {
        id: 'idb-ready',
        description: 'Confirm supplied IndexedDB state loaded.',
        expected: 'IndexedDB ready',
        assertion: cssAssertion('text', '#idb-ready'),
      },
    ];
    await broker.initialize();
    try {
      await broker.handle('submit_plan', suppliedPlan);
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      const navigation = await broker.handle('navigate', { url: '/sensitive-state' });
      await broker.handle('wait', { text: 'IndexedDB ready', timeout_ms: 5_000 });
      const assertion = await broker.handle('assert', {
        checkpoint: 'idb-ready',
        kind: 'text',
        expected: 'IndexedDB ready',
        css: '#idb-ready',
      });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Supplied state loaded.' });

      const exposed = JSON.stringify({ navigation, assertion, state: broker.state() });
      for (const canary of [AUTH_COOKIE_CANARY, AUTH_LOCAL_CANARY, AUTH_INDEXED_DB_CANARY]) {
        expect(exposed).not.toContain(canary);
      }
      expect(assertion).toEqual({ accepted: true, observation: 'sealed' });
      expect(broker.state().attempts[0]?.assertions[0]).toMatchObject({
        passed: true,
        actual: 'Authenticated checkpoint matched.',
      });
      expect(mediaFiles(scenarioEvidence(evidenceDir, 1))).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('records an active scenario as blocked when controller cleanup closes it', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/' });
    await broker.close();

    expect(broker.state().attempts).toMatchObject([{
      scenarioId: 'exercise-fixture',
      attempt: 1,
      status: 'blocked',
      summary: 'Controller closed the active scenario.',
    }]);
  }, 30_000);

  it('interrupts an active Playwright wait and still finalizes controller evidence', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/' });

    const wait = broker.handle('wait', { text: 'never rendered', timeout_ms: 15_000 }).then(
      () => 'resolved',
      () => 'interrupted',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    await broker.interrupt(1_000);
    await expect(wait).resolves.toBe('interrupted');
    await broker.close({ timeoutMs: 1_000 });

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(broker.state().attempts).toMatchObject([{
      scenarioId: 'exercise-fixture',
      attempt: 1,
      status: 'blocked',
      summary: 'Controller closed the active scenario.',
    }]);
    await expect(broker.handle('qa_status', {})).rejects.toThrow('interrupted by caller cancellation');
  }, 30_000);

  it('propagates interruption to trusted pre-attempt reset work', async () => {
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      beforeAttempt: async (_scenarioId, _attempt, signal) => {
        signalStarted?.();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error('reset interrupted'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    }));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    const start = broker.handle('start_scenario', {
      scenario_id: 'exercise-fixture',
      attempt: 1,
    });
    await started;

    await broker.interrupt(1_000);
    await expect(start).rejects.toThrow('reset interrupted');
    await broker.close({ timeoutMs: 1_000 });
    expect(broker.state().attempts).toEqual([]);
    expect(broker.startedBrowser()).toBe(false);
  });

  it('uses the exact planned viewport and enforces the trusted mobile switch', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir));
    const custom = plan();
    custom.scenarios[0]!.viewport.width = 777;
    custom.scenarios[0]!.viewport.height = 555;
    custom.scenarios[0]!.checkpoints[0]!.expected = '777x555';
    custom.scenarios[0]!.checkpoints[0]!.assertion = cssAssertion('text', '#viewport');
    await broker.initialize();
    await broker.handle('submit_plan', custom);
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/' });
    await expect(broker.handle('assert', {
      checkpoint: 'fixture-heading',
      kind: 'text',
      expected: '777x555',
      css: '#viewport',
    })).resolves.toMatchObject({ passed: true });
    await broker.handle('finish_scenario', { status: 'passed', summary: 'Viewport matched.' });
    await broker.close();

    const denied = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { mobileWhenRelevant: false }));
    const mobile = plan();
    mobile.scenarios[0]!.viewport.kind = 'mobile';
    await expect(denied.handle('submit_plan', mobile)).rejects.toThrow('does not allow mobile');
    await denied.close();
  }, 30_000);

  it('uses a concrete URL matcher while retaining the human checkpoint expectation', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir));
    const custom = plan();
    custom.scenarios[0]!.checkpoints[0]!.expected = 'The fixture remains on the local QA origin.';
    custom.scenarios[0]!.checkpoints[0]!.assertion = {
      kind: 'url',
      locator: null,
      url_contains: '127.0.0.1',
    };
    await broker.initialize();
    await broker.handle('submit_plan', custom);
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/' });
    await expect(broker.handle('assert', {
      checkpoint: 'fixture-heading',
      kind: 'url',
      expected: 'The fixture remains on the local QA origin.',
      url_contains: '127.0.0.1',
    })).resolves.toMatchObject({
      passed: true,
      expected: 'The fixture remains on the local QA origin.',
    });
    await broker.handle('finish_scenario', { status: 'passed', summary: 'URL matched.' });
    await broker.close();
  }, 30_000);

  it('rejects any runtime assertion semantics that differ from the accepted checkpoint', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/' });
    await expect(broker.handle('assert', {
      checkpoint: 'fixture-heading',
      kind: 'text',
      expected: 'QA fixture',
    })).rejects.toThrow('kind, locator, and URL matcher');
    await expect(broker.handle('assert', {
      checkpoint: 'fixture-heading',
      kind: 'visible',
      expected: 'QA fixture',
      css: 'h1',
    })).rejects.toThrow('kind, locator, and URL matcher');
    await expect(broker.handle('assert', {
      checkpoint: 'fixture-heading',
      kind: 'text',
      expected: 'QA fixture',
      css: 'h1',
      name: null,
      nth: null,
    })).resolves.toMatchObject({ passed: true, actual: 'QA fixture' });
    await broker.handle('finish_scenario', { status: 'passed', summary: 'Text matched.' });
    await broker.close();
  }, 30_000);

  it('normalizes empty and oversized observed values to the persisted result schema', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    const custom = plan();
    custom.scenarios[0]!.checkpoints = [
      {
        id: 'empty-value',
        description: 'Inspect the empty value.',
        expected: 'non-empty',
        assertion: cssAssertion('value', '#empty-value'),
      },
      {
        id: 'long-value',
        description: 'Inspect the long value.',
        expected: 'needle',
        assertion: cssAssertion('value', '#long-value'),
      },
    ];
    await broker.initialize();
    await broker.handle('submit_plan', custom);
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/assertion-values' });

    await expect(broker.handle('assert', {
      checkpoint: 'empty-value',
      kind: 'value',
      expected: 'non-empty',
      css: '#empty-value',
    })).resolves.toMatchObject({ passed: false, actual: '(empty string)' });
    const oversized = await broker.handle('assert', {
      checkpoint: 'long-value',
      kind: 'value',
      expected: 'needle',
      css: '#long-value',
    }) as { actual: string; passed: boolean };
    expect(oversized.passed).toBe(false);
    expect(oversized.actual).toHaveLength(4_000);

    await broker.handle('finish_scenario', {
      status: 'failed',
      summary: 'Both schema-boundary checkpoints failed as expected.',
    });
    expect(broker.state().attempts[0]?.assertions.map((item) => item.actual)).toEqual([
      '(empty string)',
      'x'.repeat(4_000),
    ]);
    await broker.close();
  }, 30_000);

  it('requires every matching element to be hidden unless nth selects one match', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    const custom = plan();
    custom.scenarios[0]!.checkpoints = [
      {
        id: 'responsive-hidden',
        description: 'Check duplicate responsive actions.',
        expected: 'No responsive action is visible.',
        assertion: cssAssertion('hidden', '.responsive-action'),
      },
      {
        id: 'all-hidden',
        description: 'Check copies that are all hidden.',
        expected: 'Every duplicate copy is hidden.',
        assertion: cssAssertion('hidden', '.all-hidden'),
      },
      {
        id: 'missing-hidden',
        description: 'Check an absent element.',
        expected: 'The removed action is absent.',
        assertion: cssAssertion('hidden', '.missing-action'),
      },
      {
        id: 'first-hidden',
        description: 'Check the explicitly selected hidden copy.',
        expected: 'The desktop copy is hidden.',
        assertion: cssAssertion('hidden', '.responsive-action', 0),
      },
      {
        id: 'second-visible',
        description: 'Check the explicitly selected visible copy.',
        expected: 'The mobile copy is hidden.',
        assertion: cssAssertion('hidden', '.responsive-action', 1),
      },
    ];
    await broker.initialize();
    await broker.handle('submit_plan', custom);
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await broker.handle('navigate', { url: '/responsive-duplicates' });

    await expect(broker.handle('assert', {
      checkpoint: 'responsive-hidden',
      kind: 'hidden',
      expected: 'No responsive action is visible.',
      css: '.responsive-action',
    })).resolves.toMatchObject({ passed: false, actual: 'visible (1 of 2 matches)' });
    await expect(broker.handle('assert', {
      checkpoint: 'all-hidden',
      kind: 'hidden',
      expected: 'Every duplicate copy is hidden.',
      css: '.all-hidden',
    })).resolves.toMatchObject({ passed: true, actual: 'hidden (2 matches)' });
    await expect(broker.handle('assert', {
      checkpoint: 'missing-hidden',
      kind: 'hidden',
      expected: 'The removed action is absent.',
      css: '.missing-action',
    })).resolves.toMatchObject({ passed: true, actual: 'absent (therefore hidden)' });
    await expect(broker.handle('assert', {
      checkpoint: 'first-hidden',
      kind: 'hidden',
      expected: 'The desktop copy is hidden.',
      css: '.responsive-action',
      nth: 0,
    })).resolves.toMatchObject({ passed: true, actual: 'hidden' });
    await expect(broker.handle('assert', {
      checkpoint: 'second-visible',
      kind: 'hidden',
      expected: 'The mobile copy is hidden.',
      css: '.responsive-action',
      nth: 1,
    })).resolves.toMatchObject({ passed: false, actual: 'visible' });

    await broker.handle('finish_scenario', {
      status: 'failed',
      summary: 'A responsive duplicate remained visible.',
    });
    await broker.close();
  }, 30_000);

  it('keeps browser methods locked until a strict plan is accepted', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));

    await expect(broker.handle('start_scenario', {
      scenario_id: 'exercise-fixture',
      attempt: 1,
    })).rejects.toThrow('Submit a valid QA plan');
    await expect(broker.handle('navigate', { url: '/' })).rejects.toThrow(
      'Submit a valid QA plan',
    );
    await expect(broker.handle('submit_plan', { ...plan(), executable: 'alert(1)' }))
      .rejects.toThrow('unknown field');
    expect(broker.state().plan).toBeNull();

    await expect(broker.handle('submit_plan', plan())).resolves.toMatchObject({
      accepted: true,
      browser_unlocked: true,
      scenario_ids: ['exercise-fixture'],
    });
    expect(broker.state().plan?.scenarios[0]?.id).toBe('exercise-fixture');
    await broker.close();
  });

  it('rejects a plan that cannot run every checkpoint in two attempts', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { maxOperations: 3 }));
    await broker.initialize();
    await expect(broker.handle('submit_plan', plan())).rejects.toThrow(
      'needs at least 6 browser operations',
    );
    expect(broker.state().plan).toBeNull();
    expect(broker.startedBrowser()).toBe(false);
    await broker.close();
  });

  it('denies another origin, records a sanitized ledger, and enforces the operation budget', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, { maxOperations: 6, allowMutations: true }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });

      await expect(broker.handle('navigate', { url: 'https://example.invalid/private' }))
        .rejects.toThrow('is not allowlisted');
      await expect(broker.handle('navigate', { url: '/' })).resolves.toMatchObject({ status: 200 });
      await expect(broker.handle('fill', {
        label: 'Name',
        value: 'must-not-appear-in-the-ledger',
        mutation: 'none',
      })).resolves.toEqual({ filled: true });
      await expect(broker.handle('snapshot', {})).resolves.toMatchObject({
        visible_text: expect.stringContaining('QA fixture'),
      });
      await broker.handle('snapshot', {});
      await broker.handle('snapshot', {});
      await expect(broker.handle('snapshot', {})).rejects.toThrow(
        'operation budget exhausted at 6',
      );
      await broker.handle('finish_scenario', {
        status: 'blocked',
        summary: 'The explicit policy denial was the subject of this test.',
      });

      const state = broker.state();
      expect(state.operationCount).toBe(6);
      expect(state.attempts).toHaveLength(1);
      expect(state.attempts[0]?.operations).toMatchObject([
        { sequence: 1, action: 'navigate', status: 'denied' },
        { sequence: 2, action: 'navigate', status: 'succeeded' },
        { sequence: 3, action: 'fill', status: 'succeeded' },
        { sequence: 4, action: 'inspect_text', status: 'succeeded' },
        { sequence: 5, action: 'inspect_text', status: 'succeeded' },
        { sequence: 6, action: 'inspect_text', status: 'succeeded' },
      ]);

      const attemptDir = scenarioEvidence(evidenceDir, 1);
      const ledger = readFileSync(join(attemptDir, 'operations.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(ledger).toHaveLength(6);
      expect(ledger[0]).toMatchObject({ sequence: 1, status: 'denied' });
      expect(ledger[2]?.summary).toContain('[input omitted]');
      expect(JSON.stringify(ledger)).not.toContain('must-not-appear-in-the-ledger');
      expect(mediaFiles(attemptDir)).toEqual([]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('does not turn optional denied subresources into a false blocked result when checkpoints pass', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/optional-resource' });
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'QA fixture',
        css: 'h1',
      });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Visible behavior passed.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'passed' });
      expect(broker.state().attempts[0]?.policyDenials).not.toHaveLength(0);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('allows a corrected protocol mistake when every sealed checkpoint later passes', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/' });
      await expect(broker.handle('assert', {
        checkpoint: 'The fixture heading is visible',
        kind: 'text',
        expected: 'QA fixture',
        css: 'h1',
      })).rejects.toThrow('not in the accepted scenario plan');
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'QA fixture',
        css: 'h1',
      });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'The corrected checkpoint passed.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'passed' });
      expect(broker.state().attempts[0]?.operations.some((operation) => operation.status === 'failed')).toBe(true);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('records a planned visible element that is absent as a concrete product observation', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    const custom = plan();
    custom.scenarios[0]!.checkpoints[0]!.expected = 'The removed control is visible.';
    custom.scenarios[0]!.checkpoints[0]!.assertion = roleAssertion(
      'visible',
      'button',
      'Removed control',
    );
    await broker.initialize();
    try {
      await broker.handle('submit_plan', custom);
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/' });
      await expect(broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'visible',
        expected: 'The removed control is visible.',
        role: 'button',
        name: 'Removed control',
      })).resolves.toMatchObject({ passed: false, actual: 'expected element was absent' });
      await broker.handle('finish_scenario', { status: 'failed', summary: 'The planned control is absent.' });
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('blocks HTTP error pages from counting as successful navigation', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await expect(broker.handle('navigate', { url: '/http-error' })).rejects.toThrow('HTTP 500');
      await broker.handle('finish_scenario', { status: 'blocked', summary: 'The target returned an error.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'blocked' });
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('admits only an explicitly expected non-success status for tombstone assertions', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    const statusPlan = plan();
    statusPlan.scenarios[0]!.checkpoints[0]!.expected = '410';
    statusPlan.scenarios[0]!.checkpoints[0]!.assertion = {
      kind: 'status',
      locator: null,
      url_contains: null,
    };
    await broker.initialize();
    try {
      await broker.handle('submit_plan', statusPlan);
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await expect(broker.handle('navigate', {
        url: '/gone',
        expected_statuses: [410],
      })).resolves.toMatchObject({ status: 410 });
      await expect(broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'status',
        expected: '410',
      })).resolves.toMatchObject({ passed: true });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'The tombstone matched.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'passed' });
    } finally {
      await broker.close();
    }

    const mismatch = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await mismatch.initialize();
    try {
      await mismatch.handle('submit_plan', statusPlan);
      await mismatch.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await expect(mismatch.handle('navigate', {
        url: '/gone',
        expected_statuses: [404],
      })).rejects.toThrow('accepted scenario plan');
      await mismatch.handle('navigate', { url: '/gone', expected_statuses: [410] });
      await expect(mismatch.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'status',
        expected: '404',
      })).rejects.toThrow('must exactly match the accepted scenario plan');
      await expect(mismatch.handle('navigate', {
        url: '/http-error',
        expected_statuses: [500],
      })).rejects.toThrow('from 200 through 499');
    } finally {
      await mismatch.close();
    }
  }, 30_000);

  it('does not authorize an expected HTTP status from a numeric non-status checkpoint', async () => {
    const numericTextPlan = plan();
    numericTextPlan.scenarios[0]!.checkpoints[0]!.expected = '410';
    // The assertion remains a text assertion against h1.
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    await broker.handle('submit_plan', numericTextPlan);
    await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
    await expect(broker.handle('navigate', { url: '/gone', expected_statuses: [410] }))
      .rejects.toThrow('accepted scenario plan');
    await broker.close();
  }, 30_000);

  it('allows passive same-origin POST reads while no model interaction is mutating state', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { allowMutations: false }));
    const custom = plan();
    custom.scenarios[0]!.checkpoints[0]!.expected = 'Loaded';
    custom.scenarios[0]!.checkpoints[0]!.assertion = cssAssertion('text', '#loaded');
    await broker.initialize();
    try {
      await broker.handle('submit_plan', custom);
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/passive-post' });
      await broker.handle('wait', { text: 'Loaded', timeout_ms: 5_000 });
      expect(passivePostRequests).toBe(1);
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'Loaded',
        css: '#loaded',
      });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Read-only data loaded.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'passed', policyDenials: [] });
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('allows passive same-origin WebSockets for read-only realtime pages', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { allowMutations: false }));
    const custom = plan();
    custom.scenarios[0]!.checkpoints[0]!.expected = 'Loaded';
    custom.scenarios[0]!.checkpoints[0]!.assertion = cssAssertion('text', '#loaded');
    await broker.initialize();
    try {
      await broker.handle('submit_plan', custom);
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/passive-socket' });
      await broker.handle('wait', { text: 'Loaded', timeout_ms: 5_000 });
      expect(passiveSocketConnections).toBe(1);
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'Loaded',
        css: '#loaded',
      });
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Realtime page loaded.' });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'passed', policyDenials: [] });
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('denies mislabeled form submissions and cannot report them passed without trusted reset', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { allowMutations: false }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/unsafe-form' });
      await expect(broker.handle('press', {
        role: 'button',
        name: 'Save',
        key: 'Enter',
        mutation: 'none',
      })).rejects.toThrow('trusted reset is not configured');
      expect(unsafeRequests).toBe(0);
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'QA fixture',
        css: 'h1',
      });
      await broker.handle('finish_scenario', {
        status: 'passed',
        summary: 'The model incorrectly claimed that the submission passed.',
      });
      expect(broker.state().attempts[0]).toMatchObject({ status: 'blocked' });
      expect(broker.state().attempts[0]?.policyDenials.join('\n')).toContain('trusted reset');
    } finally {
      await broker.close();
    }
  }, 30_000);

  it.each([
    'about:blank',
    'data:text/html,<h1>synthetic</h1>',
    'blob:https://example.test/00000000-0000-0000-0000-000000000000',
  ])('denies a non-HTTP(S) top-level navigation to %s', async (url) => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory()));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await expect(broker.handle('navigate', { url })).rejects.toThrow('is not allowlisted');
      expect(broker.state().attempts).toEqual([]);
    } finally {
      await broker.close();
    }
    expect(broker.state().attempts).toMatchObject([
      { status: 'blocked', operations: [{ action: 'navigate', status: 'denied' }] },
    ]);
  }, 30_000);

  it('denies a non-HTTP(S) authentication navigation before credentials are used', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [
        { action: 'navigate', url: 'data:text/html,<h1>synthetic login</h1>' },
        { action: 'fill', label: 'Password', secret: 'password' },
      ],
      secrets: { password: 'must-not-be-used' },
    }));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    await expect(broker.handle('start_scenario', {
      scenario_id: 'exercise-fixture',
      attempt: 1,
    })).resolves.toEqual({ accepted: true, observation: 'sealed' });
    await broker.handle('navigate', { url: '/' });
    await broker.handle('snapshot', {});
    await broker.handle('assert', {
      checkpoint: 'fixture-heading', kind: 'text', expected: 'QA fixture', css: 'h1',
    });
    await broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup.' });
    expect(broker.state().attempts).toMatchObject([{ status: 'blocked' }]);
    await broker.close();
  }, 30_000);

  it('rejects an authentication HTTP error with fixed feedback and caps setup admission', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [{ action: 'navigate', url: '/http-error' }],
    }));
    await broker.initialize();
    await broker.handle('submit_plan', plan());

    for (const attempt of [1, 2] as const) {
      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt,
      })).resolves.toEqual({ accepted: true, observation: 'sealed' });
      await expect(broker.handle('navigate', { url: '/' }))
        .resolves.toEqual({ accepted: true, observation: 'sealed' });
      await expect(broker.handle('snapshot', {}))
        .resolves.toEqual({ accepted: true, observation: 'sealed' });
      await expect(broker.handle('assert', {
        checkpoint: 'fixture-heading', kind: 'text', expected: 'QA fixture', css: 'h1',
      })).resolves.toEqual({ accepted: true, observation: 'sealed' });
      await expect(broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup.' }))
        .resolves.toEqual({ accepted: true, observation: 'sealed' });
    }
    expect(authHttpErrorRequests).toBe(2);
    expect(broker.state().attempts).toMatchObject([
      { attempt: 1, status: 'blocked' },
      { attempt: 2, status: 'blocked' },
    ]);
    await expect(broker.handle('start_scenario', {
      scenario_id: 'exercise-fixture', attempt: 2,
    })).rejects.toThrow('Authenticated browser operation failed; page-controlled details were omitted.');
    expect(authHttpErrorRequests).toBe(2);
    await broker.close();
  }, 30_000);

  it('uses one fixed admission window for successful and timed-out authenticated setup', async () => {
    const measure = async (url: string): Promise<{ elapsed: number; result: unknown; status: string }> => {
      const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
        authSteps: [{ action: 'navigate', url }],
        sensitiveSetupWindowMs: 1_500,
      }));
      await broker.initialize();
      await broker.handle('submit_plan', plan());
      const startedAt = Date.now();
      const result = await broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture', attempt: 1,
      });
      const elapsed = Date.now() - startedAt;
      await broker.handle('finish_scenario', { status: 'passed', summary: 'Sealed setup result.' });
      const status = broker.state().attempts[0]!.status;
      await broker.close();
      return { elapsed, result, status };
    };

    const succeeded = await measure('/auth-bootstrap');
    const failed = await measure('/http-error');
    const timedOut = await measure('/slow-auth');
    expect(succeeded.result).toEqual({ accepted: true, observation: 'sealed' });
    expect(failed.result).toEqual(succeeded.result);
    expect(timedOut.result).toEqual(succeeded.result);
    expect(succeeded.elapsed).toBeGreaterThanOrEqual(1_450);
    expect(failed.elapsed).toBeGreaterThanOrEqual(1_450);
    expect(timedOut.elapsed).toBeGreaterThanOrEqual(1_450);
    expect(succeeded.elapsed).toBeLessThan(2_250);
    expect(failed.elapsed).toBeLessThan(2_250);
    expect(timedOut.elapsed).toBeLessThan(2_250);
    expect(Math.max(succeeded.elapsed, failed.elapsed, timedOut.elapsed)
      - Math.min(succeeded.elapsed, failed.elapsed, timedOut.elapsed)).toBeLessThan(400);
    expect([succeeded.status, failed.status, timedOut.status]).toEqual(['blocked', 'blocked', 'blocked']);
    expect(slowAuthAborts).toBe(1);
  }, 20_000);

  it('returns a controller-owned cancellation error during authenticated setup', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [{ action: 'navigate', url: '/slow-auth' }],
    }));
    await broker.initialize();
    await broker.handle('submit_plan', plan());
    const start = broker.handle('start_scenario', {
      scenario_id: 'exercise-fixture',
      attempt: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await broker.interrupt(1_000);
    await expect(start).rejects.toThrow('QA browser broker was interrupted by caller cancellation');
    expect(broker.state().attempts).toEqual([]);
    await broker.close({ timeoutMs: 1_000 });
  }, 30_000);

  it('redacts configured secrets from browser and authentication errors returned to the agent', async () => {
    const canary = 'browser-secret-canary';
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [{ action: 'navigate', url: `data:text/html,${canary}` }],
      secrets: { QA_PASSWORD: canary },
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      let message = '';
      try {
        await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(canary);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('reruns authentication for each deterministic sealed attempt', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), {
      authSteps: [
        { action: 'navigate', url: '/auth-bootstrap' },
        { action: 'wait', text: 'Ready', timeout_ms: 10_000 },
      ],
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      for (const attempt of [1, 2] as const) {
        await expect(broker.handle('start_scenario', {
          scenario_id: 'exercise-fixture',
          attempt,
        })).resolves.toEqual({ accepted: true, observation: 'sealed' });
        await expect(broker.handle('navigate', { url: '/' }))
          .resolves.toEqual({ accepted: true, observation: 'sealed' });
        await expect(broker.handle('snapshot', {}))
          .resolves.toEqual({ accepted: true, observation: 'sealed' });
        await expect(broker.handle('assert', {
          checkpoint: 'fixture-heading',
          kind: 'text',
          expected: 'QA fixture',
          css: 'h1',
        })).resolves.toEqual({ accepted: true, observation: 'sealed' });
        await expect(broker.handle('finish_scenario', {
          // The controller ignores this claim and derives the sealed result.
          status: 'blocked',
          summary: 'Agent-visible outcome remains sealed.',
        })).resolves.toEqual({ accepted: true, observation: 'sealed' });

        if (attempt === 1) {
          await expect(broker.handle('finish', { summary: 'Too early.', issues: [] }))
            .rejects.toThrow('require two sealed attempts');
        }
      }
      expect(authBootstrapRequests).toBe(2);
      expect(broker.state().attempts.map(({ attempt, status }) => ({ attempt, status }))).toEqual([
        { attempt: 1, status: 'passed' },
        { attempt: 2, status: 'passed' },
      ]);
      await expect(broker.handle('finish', { summary: 'Both sealed attempts complete.', issues: [] }))
        .resolves.toMatchObject({ accepted: true, attempts: 2 });
    } finally {
      await broker.close();
    }
  }, 60_000);

  it('seals every page-controlled output while retaining authenticated checkpoint outcomes', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      authSteps: [
        { action: 'navigate', url: '/auth-bootstrap' },
        { action: 'wait', text: 'Ready', timeout_ms: 10_000 },
      ],
      allowMutations: true,
      video: 'all',
      trace: 'all',
      screenshot: 'all',
    }));
    const authenticatedPlan = plan();
    authenticatedPlan.scenarios[0]!.checkpoints = [
      {
        id: 'fixture-heading',
        description: 'Inspect the public heading.',
        expected: 'QA fixture',
        assertion: cssAssertion('text', 'h1'),
      },
      {
        id: 'state-ready',
        description: 'Confirm cookie and web storage survived login.',
        expected: 'State ready',
        assertion: cssAssertion('text', '#state-ready'),
      },
      {
        id: 'idb-ready',
        description: 'Confirm IndexedDB survived login.',
        expected: 'IndexedDB ready',
        assertion: cssAssertion('text', '#idb-ready'),
      },
      {
        id: 'sealed-mismatch',
        description: 'Exercise a real mismatch.',
        expected: 'Public expected value',
        assertion: cssAssertion('text', '#secret'),
      },
      {
        id: 'sealed-tool-error',
        description: 'Exercise a locator error.',
        expected: 'Missing element',
        assertion: cssAssertion('text', '#does-not-exist'),
      },
    ];
    const outward: unknown[] = [];
    await broker.initialize();
    try {
      outward.push(await broker.handle('submit_plan', authenticatedPlan));
      const status = await broker.handle('qa_status', {}) as { browser_output_policy: string };
      expect(status.browser_output_policy).toBe('sealed_authenticated_checkpoints');
      outward.push(status);
      outward.push(await broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 1,
      }));
      outward.push(await broker.handle('navigate', { url: '/sensitive-state' }));
      outward.push(await broker.handle('wait', { text: 'IndexedDB ready', timeout_ms: 5_000 }));
      outward.push(await broker.handle('snapshot', {}));
      outward.push(await broker.handle('click', {
        css: '#transient',
        mutation: 'none',
      }));
      outward.push(await broker.handle('select', {
        css: '#secret-select',
        option_label: 'Public option',
        mutation: 'none',
      }));

      for (const [checkpoint, expected, css] of [
        ['fixture-heading', 'QA fixture', 'h1'],
        ['state-ready', 'State ready', '#state-ready'],
        ['idb-ready', 'IndexedDB ready', '#idb-ready'],
      ] as const) {
        outward.push(await broker.handle('assert', {
          checkpoint,
          kind: 'text',
          expected,
          css,
        }));
      }
      const mismatch = await broker.handle('assert', {
        checkpoint: 'sealed-mismatch',
        kind: 'text',
        expected: 'Public expected value',
        css: '#secret',
      });
      expect(mismatch).toEqual({ accepted: true, observation: 'sealed' });
      outward.push(mismatch);
      const toolError = await broker.handle('assert', {
        checkpoint: 'sealed-tool-error',
        kind: 'text',
        expected: 'Missing element',
        css: '#does-not-exist',
      });
      expect(toolError).toEqual({ accepted: true, observation: 'sealed' });
      outward.push(toolError);
      outward.push(await broker.handle('finish_scenario', {
        status: 'failed',
        summary: 'The sealed mismatch and tool-error fixtures completed.',
      }));

      const attempt = broker.state().attempts[0]!;
      expect(attempt).toMatchObject({
        scenarioId: 'exercise-fixture',
        status: 'blocked',
        console: ['Browser console text omitted because authenticated state is active.'],
        failedRequests: ['Failed-request text omitted because authenticated state is active.'],
      });
      expect(attempt.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(attempt.assertions).toMatchObject([
        { checkpoint: 'fixture-heading', passed: true, failureReason: 'none' },
        { checkpoint: 'state-ready', passed: true, failureReason: 'none' },
        { checkpoint: 'idb-ready', passed: true, failureReason: 'none' },
        { checkpoint: 'sealed-mismatch', passed: false, failureReason: 'observed_mismatch' },
        { checkpoint: 'sealed-tool-error', passed: false, failureReason: 'tool_error' },
      ]);
      const sealedStatus = await broker.handle('qa_status', {}) as { attempts: unknown[] };
      expect(sealedStatus.attempts).toEqual([{
        scenario_id: 'exercise-fixture',
        attempt: 1,
        outcome: 'sealed',
      }]);
      expect(attempt.policyDenials).toContain(
        'A browser request was denied by the origin policy; its URL was omitted because authenticated state is active.',
      );

      const attemptDir = scenarioEvidence(evidenceDir, 1);
      expect(mediaFiles(attemptDir)).toEqual([]);
      const sensitiveLedgerNames = [
        'attempt.json',
        'console.json',
        'failed-requests.json',
        'operations.ndjson',
      ];
      expect(sensitiveLedgerNames.map((name) => existsSync(join(attemptDir, name))))
        .toEqual(sensitiveLedgerNames.map(() => false));
      const exposed = `${JSON.stringify(outward)}\n${JSON.stringify(broker.state())}`;
      for (const canary of [
        AUTH_COOKIE_CANARY,
        AUTH_LOCAL_CANARY,
        AUTH_SESSION_CANARY,
        AUTH_INDEXED_DB_CANARY,
        AUTH_TRANSIENT_CANARY,
        AUTH_URL_CANARY,
        AUTH_OPTION_CANARY,
        AUTH_POLICY_CANARY,
        AUTH_BOUNDARY_CANARY,
      ]) expect(exposed).not.toContain(canary);
      expect(exposed).not.toContain(AUTH_BOUNDARY_CANARY.slice(0, 12));
      expect(outward.slice(2)).toEqual(outward.slice(2).map(() => ({
        accepted: true,
        observation: 'sealed',
      })));
      expect(exposed).toContain('Authenticated checkpoint matched.');
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('fails closed when an allowed-page click navigates the top frame to a non-HTTP URL', async () => {
    const broker = new QaBrowserBroker(brokerOptions(evidenceDirectory(), { allowMutations: true }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/' });
      await expect(broker.handle('click', {
        css: '#synthetic-page',
        mutation: 'none',
      })).rejects.toThrow('outside an allowlisted HTTP(S) origin');
      await broker.handle('finish_scenario', {
        status: 'blocked',
        summary: 'The top-level navigation policy denied the synthetic page.',
      });
      expect(broker.state().attempts[0]?.operations).toMatchObject([
        { action: 'navigate', status: 'succeeded' },
        { action: 'click', status: 'denied' },
      ]);
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('permits one retry and retains visual evidence when secrets are reset-only', async () => {
    const evidenceDir = evidenceDirectory();
    const beforeAttempts: string[] = [];
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      video: 'all',
      trace: 'all',
      screenshot: 'all',
      secrets: { QA_RESET_TOKEN: 'reset-only-secret-value' },
      beforeAttempt: async (scenarioId, attempt) => {
        beforeAttempts.push(`${scenarioId}:${attempt}`);
      },
    }));
    const retryPlan = plan();
    retryPlan.scenarios[0]!.checkpoints[0]!.expected = 'Missing heading';
    await broker.initialize();
    try {
      await broker.handle('submit_plan', retryPlan);
      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 2,
      })).rejects.toThrow('only after a failed initial attempt');

      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/' });
      await expect(broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'Missing heading',
        css: 'h1',
      })).resolves.toMatchObject({ passed: false });
      await broker.handle('finish_scenario', {
        status: 'failed',
        summary: 'The first attempt intentionally failed its checkpoint.',
      });

      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 2 });
      await broker.handle('navigate', { url: '/' });
      await expect(broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'Missing heading',
        css: 'h1',
      })).resolves.toMatchObject({ passed: false });
      await broker.handle('finish_scenario', {
        status: 'failed',
        summary: 'The retry reproduced the same missing heading.',
      });

      await expect(broker.handle('start_scenario', {
        scenario_id: 'exercise-fixture',
        attempt: 2,
      })).rejects.toThrow('already has a retry');
      await expect(broker.handle('finish', { summary: 'Fixture complete.', issues: [] }))
        .resolves.toMatchObject({ accepted: true, attempts: 2 });

      expect(beforeAttempts).toEqual(['exercise-fixture:1', 'exercise-fixture:2']);
      expect(broker.state().attempts.map(({ attempt, status }) => ({ attempt, status }))).toEqual([
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'failed' },
      ]);
      for (const attempt of [1, 2] as const) {
        const files = mediaFiles(scenarioEvidence(evidenceDir, attempt));
        expect(files).toContain('final.png');
        expect(files).toContain('trace.zip');
        expect(files.some((file) => file.endsWith('.webm'))).toBe(true);
      }
    } finally {
      await broker.close();
    }
  }, 30_000);

  it('discards successful evidence when each policy is failure-only', async () => {
    const evidenceDir = evidenceDirectory();
    const broker = new QaBrowserBroker(brokerOptions(evidenceDir, {
      video: 'failure',
      trace: 'failure',
      screenshot: 'failure',
    }));
    await broker.initialize();
    try {
      await broker.handle('submit_plan', plan());
      await broker.handle('start_scenario', { scenario_id: 'exercise-fixture', attempt: 1 });
      await broker.handle('navigate', { url: '/' });
      await broker.handle('assert', {
        checkpoint: 'fixture-heading',
        kind: 'text',
        expected: 'QA fixture',
        css: 'h1',
      });
      await broker.handle('finish_scenario', {
        status: 'passed',
        summary: 'The checkpoint passed.',
      });

      const attemptDir = scenarioEvidence(evidenceDir, 1);
      expect(mediaFiles(attemptDir)).toEqual([]);
      expect(readdirSync(attemptDir)).toEqual(expect.arrayContaining([
        'attempt.json',
        'console.json',
        'failed-requests.json',
        'operations.ndjson',
      ]));
    } finally {
      await broker.close();
    }
  }, 30_000);
});
