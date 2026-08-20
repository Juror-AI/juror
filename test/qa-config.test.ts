import { describe, expect, it } from 'vitest';

import { loadConfigText } from '../src/config.js';
import { applyQaConfig, defaultQaConfig, unsafeQaConfigProblems } from '../src/qa/config.js';

describe('post-merge QA configuration', () => {
  it('is opt-in and starts from bounded, credential-free security defaults', () => {
    expect(defaultQaConfig()).toEqual({
      enabled: false,
      model: { id: 'gpt-5.6-luna', reasoning_effort: 'medium' },
      testability: { early_exit_paths: [] },
      target: {
        strategy: 'staging-first',
        environment: 'staging',
        deployment_environment: null,
        static_url: null,
        readiness_path: '/',
        readiness_statuses: null,
        commit_probe: null,
        preview_fallback: true,
        wait_seconds: 900,
      },
      auth: { session_bootstrap: null, browser_secret_headers: [], steps: [] },
      sandbox: { allowed_origins: [], reset: null },
      limits: {
        max_scenarios: 6,
        max_browser_operations: 40,
        timeout_seconds: 1200,
        mobile_when_relevant: true,
      },
      evidence: {
        video: 'all',
        trace: 'failure',
        screenshot: 'failure',
        retention_days: 14,
      },
    });
  });

  it('returns an independent deep configuration for each call', () => {
    const first = defaultQaConfig();
    first.model.id = 'mutated';
    first.testability.early_exit_paths.push('docs/**');
    first.auth.browser_secret_headers.push({
      name: 'x-mutated',
      secret_ref: 'MUTATED',
      origins: ['https://mutated.example'],
    });
    first.auth.steps.push({ type: 'goto', path: '/mutated' });
    first.sandbox.allowed_origins.push('https://mutated.example');
    first.evidence.video = 'off';

    const second = defaultQaConfig();
    expect(second.model.id).toBe('gpt-5.6-luna');
    expect(second.testability.early_exit_paths).toEqual([]);
    expect(second.auth.browser_secret_headers).toEqual([]);
    expect(second.auth.steps).toEqual([]);
    expect(second.sandbox.allowed_origins).toEqual([]);
    expect(second.evidence.video).toBe('all');
  });

  it('accepts HTTP URLs on Node-bracketed IPv6 loopback', () => {
    const loaded = loadConfigText(`
version: 1
qa:
  target:
    static_url: "http://[::1]:4173/app"
  sandbox:
    allowed_origins:
      - "http://[::1]:4173"
`, '.juror.yml');

    expect(loaded.problems).toEqual([]);
    expect(loaded.config.qa.target.static_url).toBe('http://[::1]:4173/app');
    expect(loaded.config.qa.sandbox.allowed_origins).toEqual(['http://[::1]:4173']);
  });

  it('rejects HTTPS IP targets and origins before the egress proxy starts', () => {
    const loaded = loadConfigText(`
version: 1
qa:
  target:
    static_url: "https://203.0.113.10/app"
  sandbox:
    allowed_origins:
      - "https://203.0.113.10"
      - "https://[2001:db8::1]"
`, '.juror.yml');

    expect(loaded.config.qa.target.static_url).toBeNull();
    expect(loaded.config.qa.sandbox.allowed_origins).toEqual([]);
    expect(loaded.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('qa.target.static_url'),
      expect.stringContaining('https://203.0.113.10'),
      expect.stringContaining('https://[2001:db8::1]'),
    ]));
  });

  it('accepts and normalizes the complete trusted configuration surface', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      enabled: true,
      model: { id: 'openai/gpt-5.6-luna_qa', reasoning_effort: 'high' },
      testability: {
        early_exit_paths: ['.github/**', 'infra/**', '.github/**'],
      },
      target: {
        strategy: 'staging-first',
        environment: 'staging',
        deployment_environment: 'web-staging',
        static_url: 'https://app.example.test',
        readiness_path: '/ready?deep=1',
        readiness_statuses: [200, 204, 204],
        commit_probe: { path: '/version.json', json_pointer: '/git/sha' },
        preview_fallback: false,
        wait_seconds: 0,
      },
      auth: {
        session_bootstrap: {
          url: 'https://api.example.test/qa/session',
          secret_ref: 'QA_SESSION_TOKEN',
          target_origin: 'https://app.example.test',
          ready_storage_key: 'qaSessionReady',
        },
        browser_secret_headers: [{
          name: 'X-Staging-Bypass',
          secret_ref: 'QA_BYPASS_TOKEN',
          origins: [
            'https://app.example.test',
            'https://app.example.test/',
          ],
        }],
        steps: [
          { type: 'goto', path: '/login?from=qa' },
          {
            type: 'fill',
            locator: { by: 'label', value: 'Email address' },
            secret_ref: 'QA_USER_EMAIL',
          },
          {
            type: 'fill',
            locator: { by: 'placeholder', value: 'Password' },
            secret_ref: '_QA_PASSWORD_2',
          },
          { type: 'click', locator: { by: 'role', role: 'button', name: 'Sign in' } },
          {
            type: 'wait',
            locator: { by: 'test-id', value: 'workspace' },
            state: 'visible',
            timeout_seconds: 60,
          },
        ],
      },
      sandbox: {
        allowed_origins: [
          'https://app.example.test',
          'https://api.example.test/',
          'https://app.example.test/',
        ],
        reset: {
          url: '/internal/qa/reset?scope=current',
          method: 'post',
          secret_headers: [
            { name: 'Authorization', secret_ref: 'QA_RESET_TOKEN', format: 'bearer' },
            { name: 'X-QA-Key', secret_ref: 'QA_RESET_KEY', format: 'raw' },
          ],
          expected_statuses: [200, 204, 204],
          timeout_seconds: 30,
        },
      },
      limits: {
        max_scenarios: 1,
        max_browser_operations: 1,
        timeout_seconds: 30,
        mobile_when_relevant: false,
      },
      evidence: {
        video: 'failure',
        trace: 'all',
        screenshot: 'off',
        retention_days: 1,
      },
    }, problems);

    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      enabled: true,
      model: { id: 'openai/gpt-5.6-luna_qa', reasoning_effort: 'high' },
      testability: { early_exit_paths: ['.github/**', 'infra/**'] },
      target: {
        environment: 'staging',
        deployment_environment: 'web-staging',
        static_url: 'https://app.example.test/',
        readiness_path: '/ready?deep=1',
        readiness_statuses: [200, 204],
        commit_probe: { path: '/version.json', json_pointer: '/git/sha' },
        preview_fallback: false,
        wait_seconds: 0,
      },
      sandbox: {
        allowed_origins: ['https://app.example.test', 'https://api.example.test'],
        reset: {
          url: '/internal/qa/reset?scope=current',
          method: 'POST',
          expected_statuses: [200, 204],
          timeout_seconds: 30,
        },
      },
      limits: {
        max_scenarios: 1,
        max_browser_operations: 1,
        timeout_seconds: 30,
        mobile_when_relevant: false,
      },
      evidence: {
        video: 'failure',
        trace: 'all',
        screenshot: 'off',
        retention_days: 1,
      },
    });
    expect(config.auth.session_bootstrap).toEqual({
      url: 'https://api.example.test/qa/session',
      secret_ref: 'QA_SESSION_TOKEN',
      target_origin: 'https://app.example.test',
      ready_storage_key: 'qaSessionReady',
    });
    expect(config.auth.browser_secret_headers).toEqual([{
      name: 'X-Staging-Bypass',
      secret_ref: 'QA_BYPASS_TOKEN',
      origins: ['https://app.example.test'],
    }]);
    expect(config.auth.steps).toHaveLength(5);
    expect(config.sandbox.reset?.secret_headers).toEqual([
      { name: 'Authorization', secret_ref: 'QA_RESET_TOKEN', format: 'bearer' },
      { name: 'X-QA-Key', secret_ref: 'QA_RESET_KEY', format: 'raw' },
    ]);
  });

  it('allows HTTP session bootstrapping only on explicit loopback hosts', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: {
        environment: 'staging',
        static_url: 'http://localhost:4173/app',
        preview_fallback: false,
      },
      auth: {
        session_bootstrap: {
          url: 'http://127.0.0.1:8787/session/create',
          secret_ref: 'LOCAL_SESSION_TOKEN',
          target_origin: 'http://localhost:4173',
          ready_storage_key: 'accessToken',
        },
      },
      sandbox: {
        allowed_origins: ['http://127.0.0.1:8787', 'http://localhost:4173'],
      },
    }, problems);

    expect(problems).toEqual([]);
    expect(config.auth.session_bootstrap).toEqual({
      url: 'http://127.0.0.1:8787/session/create',
      secret_ref: 'LOCAL_SESSION_TOKEN',
      target_origin: 'http://localhost:4173',
      ready_storage_key: 'accessToken',
    });

    const unsafe = defaultQaConfig();
    const unsafeProblems: string[] = [];
    applyQaConfig(unsafe, {
      auth: {
        session_bootstrap: {
          url: 'http://staging.example.test/session/create',
          secret_ref: 'SESSION_TOKEN',
          target_origin: 'https://staging.example.test',
          ready_storage_key: 'accessToken',
        },
      },
    }, unsafeProblems);
    expect(unsafe.auth.session_bootstrap).toBeNull();
    expect(unsafeProblems).toEqual(expect.arrayContaining([
      expect.stringContaining('qa.auth.session_bootstrap'),
    ]));
  });

  it('rejects malformed session and secret-header contracts without retaining credentials', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      auth: {
        session_bootstrap: {
          url: 'https://api.example.test/session?token=literal',
          secret_ref: 'literal-secret!',
          target_origin: 'https://app.example.test/path',
          ready_storage_key: 'accessToken',
          extra: true,
        },
        browser_secret_headers: [
          {
            name: 'Authorization',
            secret_ref: 'QA_TOKEN',
            origins: ['https://app.example.test'],
          },
          {
            name: 'X-Staging Bypass',
            secret_ref: 'QA_TOKEN',
            origins: ['https://app.example.test'],
          },
          {
            name: 'x-empty-origins',
            secret_ref: 'QA_TOKEN',
            origins: [],
          },
          {
            name: 'x-path-origin',
            secret_ref: 'QA_TOKEN',
            origins: ['https://app.example.test/path'],
          },
        ],
      },
    }, problems);

    expect(config.auth.session_bootstrap).toBeNull();
    expect(config.auth.browser_secret_headers).toEqual([]);
    expect(problems).toEqual(expect.arrayContaining([
      'unknown key `qa.auth.session_bootstrap.extra` — ignored',
      expect.stringContaining('qa.auth.session_bootstrap:'),
      expect.stringContaining('qa.auth.browser_secret_headers[0]:'),
      expect.stringContaining('qa.auth.browser_secret_headers[1]:'),
      expect.stringContaining('qa.auth.browser_secret_headers[2].origins:'),
      expect.stringContaining('qa.auth.browser_secret_headers[3]:'),
    ]));
    expect(unsafeQaConfigProblems(problems)).toEqual(problems);
  });

  it('allows only the standard Cloudflare Access service-token pair outside X-* headers', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: {
        environment: 'staging',
        static_url: 'https://staging.example.test',
        preview_fallback: false,
      },
      auth: {
        browser_secret_headers: [
          {
            name: 'CF-Access-Client-Id',
            secret_ref: 'CF_ACCESS_CLIENT_ID',
            origins: ['https://staging.example.test'],
          },
          {
            name: 'CF-Access-Client-Secret',
            secret_ref: 'CF_ACCESS_CLIENT_SECRET',
            origins: ['https://staging.example.test'],
          },
          {
            name: 'x-staging-waf-bypass',
            secret_ref: 'STAGING_GATEWAY_TOKEN',
            origins: ['https://staging.example.test'],
          },
          {
            name: 'CF-Access-Jwt-Assertion',
            secret_ref: 'UNSAFE_CF_HEADER',
            origins: ['https://staging.example.test'],
          },
        ],
      },
      sandbox: {
        allowed_origins: ['https://staging.example.test'],
      },
    }, problems);

    expect(config.auth.browser_secret_headers).toEqual([
      {
        name: 'CF-Access-Client-Id',
        secret_ref: 'CF_ACCESS_CLIENT_ID',
        origins: ['https://staging.example.test'],
      },
      {
        name: 'CF-Access-Client-Secret',
        secret_ref: 'CF_ACCESS_CLIENT_SECRET',
        origins: ['https://staging.example.test'],
      },
      {
        name: 'x-staging-waf-bypass',
        secret_ref: 'STAGING_GATEWAY_TOKEN',
        origins: ['https://staging.example.test'],
      },
    ]);
    expect(problems).toEqual([
      expect.stringContaining('qa.auth.browser_secret_headers[3]:'),
    ]);
  });

  it('requires literal staging policy and disables preview fallback for trusted browser auth', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: {
        environment: 'qa-staging',
        static_url: 'https://app.example.test',
        preview_fallback: true,
      },
      auth: {
        session_bootstrap: {
          url: 'https://api.example.test/session',
          secret_ref: 'QA_SESSION_TOKEN',
          target_origin: 'https://app.example.test',
          ready_storage_key: 'accessToken',
        },
      },
      sandbox: {
        allowed_origins: ['https://api.example.test', 'https://app.example.test'],
      },
    }, problems);

    expect(config.auth.session_bootstrap).not.toBeNull();
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('qa.target.environment'),
      expect.stringContaining('qa.target.preview_fallback=false'),
    ]));
    expect(unsafeQaConfigProblems(problems)).toEqual(problems);
  });

  it('rejects an empty deployment environment selector without changing the fallback', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: { deployment_environment: '   ' },
    }, problems);

    expect(config.target.deployment_environment).toBeNull();
    expect(problems).toEqual([
      expect.stringContaining('qa.target.deployment_environment'),
    ]);
    expect(unsafeQaConfigProblems(problems)).toEqual(problems);
  });

  it('binds every trusted auth origin to the sandbox and the static staging target', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: {
        environment: 'staging',
        static_url: 'https://other.example.test/app',
        preview_fallback: false,
      },
      auth: {
        session_bootstrap: {
          url: 'https://auth.example.test/session',
          secret_ref: 'QA_SESSION_TOKEN',
          target_origin: 'https://app.example.test',
          ready_storage_key: 'accessToken',
        },
        browser_secret_headers: [{
          name: 'x-staging-bypass',
          secret_ref: 'QA_BYPASS_TOKEN',
          origins: ['https://api.example.test'],
        }],
      },
      sandbox: {
        allowed_origins: ['https://app.example.test'],
      },
    }, problems);

    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('qa.auth.session_bootstrap.url: origin https://auth.example.test'),
      expect.stringContaining('qa.target.static_url: origin must exactly match'),
      expect.stringContaining('qa.auth.browser_secret_headers[0].origins: https://api.example.test'),
      expect.stringContaining('must exactly match the canonical qa.target.static_url origin'),
    ]));
    expect(unsafeQaConfigProblems(problems)).toEqual(problems);
  });

  it('requires a canonical static staging URL for header-only authentication', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      target: {
        environment: 'staging',
        static_url: null,
        preview_fallback: false,
      },
      auth: {
        browser_secret_headers: [{
          name: 'x-staging-bypass',
          secret_ref: 'QA_BYPASS_TOKEN',
          origins: ['https://staging.example.test'],
        }],
      },
      sandbox: {
        allowed_origins: ['https://staging.example.test'],
      },
    }, problems);

    expect(problems).toContain(
      'qa.target.static_url: canonical staging URL is required by session bootstrap and browser secret headers',
    );
  });

  it('rejects oversized trusted browser-auth lists', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      auth: {
        browser_secret_headers: Array.from({ length: 21 }, () => ({
          name: 'x-staging-bypass',
          secret_ref: 'QA_TOKEN',
          origins: ['https://app.example.test'],
        })),
      },
    }, problems);
    expect(config.auth.browser_secret_headers).toEqual([]);
    expect(problems).toContain(
      'qa.auth.browser_secret_headers: expected a list with at most 20 entries — using []',
    );

    const originProblems: string[] = [];
    applyQaConfig(config, {
      auth: {
        browser_secret_headers: [{
          name: 'x-staging-bypass',
          secret_ref: 'QA_TOKEN',
          origins: Array.from({ length: 11 }, (_, index) => `https://app-${index}.example.test`),
        }],
      },
    }, originProblems);
    expect(config.auth.browser_secret_headers).toEqual([]);
    expect(originProblems).toContain(
      'qa.auth.browser_secret_headers[0].origins: expected 1-10 exact secure origins — dropped',
    );
  });

  it('rejects duplicate case-insensitive secret-header bindings', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];
    applyQaConfig(config, {
      target: { environment: 'staging', preview_fallback: false },
      auth: {
        browser_secret_headers: [
          {
            name: 'X-Staging-Bypass',
            secret_ref: 'FIRST_TOKEN',
            origins: ['https://app.example.test'],
          },
          {
            name: 'x-staging-bypass',
            secret_ref: 'SECOND_TOKEN',
            origins: ['https://app.example.test'],
          },
        ],
      },
      sandbox: { allowed_origins: ['https://app.example.test'] },
    }, problems);

    expect(config.auth.browser_secret_headers).toEqual([{
      name: 'X-Staging-Bypass',
      secret_ref: 'FIRST_TOKEN',
      origins: ['https://app.example.test'],
    }]);
    expect(problems).toContain(
      'qa.auth.browser_secret_headers[1]: duplicate header name and origin binding — dropped',
    );
  });

  it('rejects cross-origin navigation, non-HTTP URLs, wildcards, and literal-looking secret refs', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      enabled: true,
      model: { id: '$(steal-token)', reasoning_effort: 'turbo' },
      testability: { early_exit_paths: ['!src/**'] },
      target: {
        strategy: 'preview-first',
        static_url: 'https://app.example.test/?protection-bypass=secret',
        readiness_path: '//attacker.example/ready',
        readiness_statuses: [500],
        commit_probe: { path: 'https://attacker.example/version', json_pointer: 'sha' },
        wait_seconds: 3601,
      },
      auth: {
        steps: [
          { type: 'goto', path: 'https://attacker.example/login' },
          {
            type: 'fill',
            locator: { by: 'label', value: 'Password' },
            secret_ref: 'literal-password!',
          },
          { type: 'click', locator: { by: 'css', value: '#danger' } },
          {
            type: 'wait',
            locator: { by: 'text', value: 'Done' },
            state: 'attached',
          },
        ],
      },
      sandbox: {
        allowed_origins: [
          'https://*.example.test',
          'https://safe.example.test/path',
          'javascript:alert(1)',
          'https://user:password@safe.example.test',
        ],
        reset: {
          url: 'file:///tmp/reset',
          method: 'GET',
          secret_headers: [],
          expected_statuses: [200],
        },
      },
      limits: {
        max_scenarios: 7,
        max_browser_operations: 41,
        timeout_seconds: 29,
      },
      evidence: {
        video: 'sometimes',
        trace: true,
        retention_days: 15,
      },
    }, problems);

    expect(config).toEqual({
      ...defaultQaConfig(),
      enabled: true,
    });
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('qa.model.id'),
      expect.stringContaining('qa.model.reasoning_effort'),
      expect.stringContaining('qa.testability.early_exit_paths'),
      expect.stringContaining('v1 supports only `staging-first`'),
      expect.stringContaining('qa.target.static_url'),
      expect.stringContaining('qa.target.readiness_path'),
      expect.stringContaining('qa.target.readiness_statuses'),
      expect.stringContaining('qa.target.commit_probe'),
      expect.stringContaining('qa.auth.steps[0].path'),
      expect.stringContaining('qa.auth.steps[1]'),
      expect.stringContaining('qa.sandbox.reset: invalid URL or method'),
      expect.stringContaining('qa.limits.max_scenarios'),
      expect.stringContaining('qa.evidence.video'),
    ]));
    expect(problems.filter((problem) => problem.includes('not an exact HTTP(S) origin'))).toHaveLength(4);
  });

  it('fails closed on oversized lists and malformed reset contracts', () => {
    const config = defaultQaConfig();
    const problems: string[] = [];

    applyQaConfig(config, {
      auth: { steps: Array.from({ length: 51 }, () => ({ type: 'goto', path: '/' })) },
      sandbox: {
        allowed_origins: Array.from({ length: 51 }, () => 'https://app.example.test'),
        reset: {
          url: '/reset',
          method: 'DELETE',
          secret_headers: [{ name: 'Authorization', secret_ref: 'not-a-name', format: 'bearer' }],
          expected_statuses: [199, 500],
        },
      },
    }, problems);

    expect(config.auth.steps).toEqual([]);
    expect(config.sandbox.allowed_origins).toEqual([]);
    expect(config.sandbox.reset).toBeNull();
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('at most 50 steps'),
      expect.stringContaining('at most 50 origins'),
      expect.stringContaining('invalid header'),
      expect.stringContaining('expected HTTP status integers'),
    ]));
  });

  it('is wired through YAML loading and reports unknown QA keys without enabling by accident', () => {
    const loaded = loadConfigText(`
version: 1
qa:
  enabled: true
  mystery: ignored
  target:
    readiness_path: /healthz
    extra_target_key: ignored
  limits:
    max_scenarios: 3
`, '.juror.yml');

    expect(loaded.config.qa.enabled).toBe(true);
    expect(loaded.config.qa.target.readiness_path).toBe('/healthz');
    expect(loaded.config.qa.limits.max_scenarios).toBe(3);
    expect(loaded.problems).toEqual(expect.arrayContaining([
      'unknown key `qa.mystery` — ignored',
      'unknown key `qa.target.extra_target_key` — ignored',
    ]));

    const malformed = loadConfigText('version: 1\nqa: enabled\n', '.juror.yml');
    expect(malformed.config.qa).toEqual(defaultQaConfig());
    expect(malformed.problems).toContain('qa: expected a mapping — using defaults');
    expect(unsafeQaConfigProblems(malformed.problems)).toContain(
      'qa: expected a mapping — using defaults',
    );
  });

  it('classifies root, nested, and backtick QA diagnostics without matching unrelated warnings', () => {
    const problems = [
      'qa: expected a mapping — using defaults',
      'qa.model: expected a mapping — using defaults',
      'unknown key `qa.target.extra` — ignored',
      'unknown key `qa` — ignored',
      'review: expected a mapping — using defaults',
      'aqua: expected a mapping — using defaults',
      'unknown key `equalizer` — ignored',
    ];

    expect(unsafeQaConfigProblems(problems)).toEqual(problems.slice(0, 4));
  });
});
