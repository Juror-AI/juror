import {
  QA_CHECKPOINT_ASSERTION_KINDS,
  QA_CHECKPOINT_LOCATOR_KINDS,
  QA_MUTATION_CATEGORIES,
  QA_OUTCOMES,
  QA_SCHEMA_VERSION,
  type QaCheckpoint,
  type QaCheckpointAssertion,
  type QaCheckpointLocator,
  type QaMutationCategory,
  type QaPlan,
  type QaPlanHardLimits,
  type QaScenario,
  type QaViewport,
} from './types.js';

const CONTROLLER_MAX_SCENARIOS = 6;
const CONTROLLER_MAX_CHECKPOINTS_PER_SCENARIO = 20;
const MAX_SHORT_TEXT = 500;
const MAX_LONG_TEXT = 4_000;
const MAX_LIST_ITEMS = 30;
const ID_PATTERN = '^[a-z][a-z0-9-]{0,63}$';

/** Keep controller-authored long text within the public QA schema boundary. */
export function boundQaLongText(value: string): string {
  return value.slice(0, MAX_LONG_TEXT);
}

/** Stable, intentionally shallow declaration type; the schema payload remains ordinary JSON. */
export interface QaJsonSchemaDocument {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
  readonly $defs?: Readonly<Record<string, unknown>>;
  readonly allOf?: readonly unknown[];
}

const nonEmptyString = (maxLength: number): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  maxLength,
});

const stringList = (maxItems = MAX_LIST_ITEMS): Record<string, unknown> => ({
  type: 'array',
  maxItems,
  items: nonEmptyString(MAX_SHORT_TEXT),
});

const httpUrl = (): Record<string, unknown> => ({
  type: 'string',
  format: 'uri',
  pattern: '^[Hh][Tt][Tt][Pp][Ss]?://',
  // Runtime validation also parses the URL and rejects username/password.
  not: { pattern: '^[Hh][Tt][Tt][Pp][Ss]?://[^/?#]*@' },
});

/**
 * Public contract given to the planning model. Runtime validation is performed by
 * `parseQaPlan`; this schema exists so prompts and protocol clients share the exact wire shape.
 */
export const QA_PLAN_JSON_SCHEMA: QaJsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://juror.dev/schemas/qa-plan-v1.json',
  title: 'Juror QA plan',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'impact_assessment',
    'testability',
    'no_testable_surface_reason',
    'surfaces',
    'scenarios',
    'risk_notes',
    'blind_spots',
  ],
  properties: {
    schema_version: { const: QA_SCHEMA_VERSION },
    impact_assessment: nonEmptyString(MAX_LONG_TEXT),
    testability: { enum: ['testable', 'no_testable_surface'] },
    no_testable_surface_reason: {
      oneOf: [{ type: 'null' }, nonEmptyString(MAX_LONG_TEXT)],
    },
    surfaces: stringList(),
    scenarios: {
      type: 'array',
      maxItems: CONTROLLER_MAX_SCENARIOS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'title',
          'rationale',
          'viewport',
          'preconditions',
          'seeded_state',
          'checkpoints',
          'allowed_mutations',
          'cleanup_expectations',
        ],
        properties: {
          id: { type: 'string', pattern: ID_PATTERN },
          title: nonEmptyString(MAX_SHORT_TEXT),
          rationale: nonEmptyString(MAX_LONG_TEXT),
          viewport: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'width', 'height', 'justification'],
            properties: {
              kind: { enum: ['desktop', 'mobile'] },
              width: { type: 'integer', minimum: 240, maximum: 3_840 },
              height: { type: 'integer', minimum: 320, maximum: 2_160 },
              justification: nonEmptyString(MAX_SHORT_TEXT),
            },
          },
          preconditions: stringList(),
          seeded_state: stringList(),
          checkpoints: {
            type: 'array',
            minItems: 1,
            maxItems: CONTROLLER_MAX_CHECKPOINTS_PER_SCENARIO,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'description', 'expected', 'assertion'],
              properties: {
                id: { type: 'string', pattern: ID_PATTERN },
                description: nonEmptyString(MAX_SHORT_TEXT),
                expected: nonEmptyString(MAX_LONG_TEXT),
                assertion: { $ref: '#/$defs/checkpointAssertion' },
              },
            },
          },
          allowed_mutations: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { enum: QA_MUTATION_CATEGORIES },
          },
          cleanup_expectations: stringList(),
        },
      },
    },
    risk_notes: stringList(),
    blind_spots: stringList(),
  },
  allOf: [
    {
      if: { properties: { testability: { const: 'no_testable_surface' } } },
      then: {
        properties: {
          no_testable_surface_reason: nonEmptyString(MAX_LONG_TEXT),
          scenarios: { maxItems: 0 },
        },
      },
      else: {
        properties: {
          no_testable_surface_reason: { type: 'null' },
          scenarios: { minItems: 1 },
        },
      },
    },
  ],
  $defs: {
    checkpointLocator: {
      type: 'object',
      additionalProperties: false,
      required: ['by', 'value', 'name', 'exact', 'nth'],
      properties: {
        by: { enum: QA_CHECKPOINT_LOCATOR_KINDS },
        value: nonEmptyString(MAX_LONG_TEXT),
        name: { oneOf: [{ type: 'null' }, nonEmptyString(MAX_SHORT_TEXT)] },
        exact: { type: 'boolean' },
        nth: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 10_000 }] },
      },
    },
    checkpointAssertion: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'locator', 'url_contains'],
      properties: {
        kind: { enum: QA_CHECKPOINT_ASSERTION_KINDS },
        locator: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/checkpointLocator' }] },
        url_contains: { oneOf: [{ type: 'null' }, nonEmptyString(MAX_LONG_TEXT)] },
      },
    },
  },
};

/**
 * Persisted controller result contract. The plan reference resolves to `QA_PLAN_JSON_SCHEMA`;
 * schema consumers should register both exported schemas by `$id`.
 */
export const QA_RUN_RESULT_JSON_SCHEMA: QaJsonSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://juror.dev/schemas/qa-run-result-v1.json',
  title: 'Juror QA run result',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'run_id',
    'repository',
    'pr_number',
    'merge_sha',
    'base_resolution',
    'source_base_sha',
    'policy_base_shas',
    'started_at',
    'completed_at',
    'duration_ms',
    'outcome',
    'conclusion',
    'target',
    'plan',
    'attempts',
    'issues',
    'cleanup',
    'artifacts',
    'runtime',
    'cost',
    'warnings',
  ],
  properties: {
    schema_version: { const: QA_SCHEMA_VERSION },
    run_id: nonEmptyString(200),
    repository: { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' },
    pr_number: { type: 'integer', minimum: 1 },
    merge_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
    base_resolution: { enum: ['exact', 'conservative'] },
    source_base_sha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
    policy_base_shas: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
    },
    started_at: { type: 'string', format: 'date-time' },
    completed_at: { type: 'string', format: 'date-time' },
    duration_ms: { type: 'integer', minimum: 0 },
    outcome: { enum: QA_OUTCOMES },
    conclusion: { enum: ['success', 'failure', 'cancelled'] },
    target: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/target' }] },
    plan: {
      oneOf: [{ type: 'null' }, { $ref: 'https://juror.dev/schemas/qa-plan-v1.json' }],
    },
    attempts: { type: 'array', items: { $ref: '#/$defs/attempt' } },
    issues: { type: 'array', items: { $ref: '#/$defs/issue' } },
    cleanup: { $ref: '#/$defs/cleanup' },
    artifacts: { type: 'array', items: { $ref: '#/$defs/artifact' } },
    runtime: { $ref: '#/$defs/runtime' },
    cost: { $ref: '#/$defs/cost' },
    warnings: stringList(100),
  },
  $defs: {
    revision: {
      type: 'object',
      additionalProperties: false,
      required: [
        'verified_against',
        'expected_sha',
        'observed_sha',
        'relation',
        'method',
        'contains_merge_sha',
        'additional_commits',
        'additional_commits_truncated',
      ],
      properties: {
        verified_against: { enum: ['merge', 'head', 'none'] },
        expected_sha: {
          oneOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9a-fA-F]{40}$' }],
        },
        observed_sha: {
          oneOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9a-fA-F]{40}$' }],
        },
        relation: { enum: ['exact', 'descendant', 'unverified'] },
        method: { enum: ['github-compare', 'deployment-sha', 'static-probe', 'none'] },
        contains_merge_sha: { type: ['boolean', 'null'] },
        additional_commits: {
          type: 'array',
          items: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
        },
        additional_commits_truncated: { type: 'boolean' },
      },
    },
    target: {
      type: 'object',
      additionalProperties: false,
      required: [
        'kind',
        'url',
        'allowed_origin',
        'environment',
        'deployment_id',
        'deployment_status_id',
        'revision',
        'stability',
        'verdict_eligible',
        'resolved_at',
        'ready_at',
      ],
      properties: {
        kind: { enum: ['staging-deployment', 'staging-static', 'preview-deployment'] },
        url: httpUrl(),
        allowed_origin: httpUrl(),
        environment: { type: ['string', 'null'] },
        deployment_id: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
        deployment_status_id: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 1 }] },
        revision: { $ref: '#/$defs/revision' },
        stability: { enum: ['unchecked', 'stable', 'drifted'] },
        verdict_eligible: { type: 'boolean' },
        resolved_at: { type: 'string', format: 'date-time' },
        ready_at: { type: 'string', format: 'date-time' },
      },
    },
    operation: {
      type: 'object',
      additionalProperties: false,
      required: ['sequence', 'action', 'summary', 'status', 'started_at', 'duration_ms', 'error'],
      properties: {
        sequence: { type: 'integer', minimum: 1 },
        action: {
          enum: [
            'navigate',
            'locate',
            'click',
            'fill',
            'select',
            'press',
            'wait',
            'inspect_text',
            'inspect_url',
            'checkpoint',
          ],
        },
        summary: nonEmptyString(MAX_LONG_TEXT),
        status: { enum: ['succeeded', 'failed', 'denied'] },
        started_at: { type: 'string', format: 'date-time' },
        duration_ms: { type: 'integer', minimum: 0 },
        error: { oneOf: [{ type: 'null' }, nonEmptyString(MAX_LONG_TEXT)] },
      },
    },
    checkpointResult: {
      type: 'object',
      additionalProperties: false,
      required: ['checkpoint_id', 'status', 'expected', 'observed'],
      properties: {
        checkpoint_id: { type: 'string', pattern: ID_PATTERN },
        status: { enum: ['passed', 'failed', 'blocked'] },
        expected: nonEmptyString(MAX_LONG_TEXT),
        observed: nonEmptyString(MAX_LONG_TEXT),
      },
    },
    observation: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'summary', 'observed_at'],
      properties: {
        kind: { enum: ['browser', 'checkpoint', 'console', 'network', 'policy'] },
        summary: nonEmptyString(MAX_LONG_TEXT),
        observed_at: { type: 'string', format: 'date-time' },
      },
    },
    attempt: {
      type: 'object',
      additionalProperties: false,
      required: [
        'scenario_id',
        'attempt',
        'status',
        'started_at',
        'duration_ms',
        'operations',
        'checkpoints',
        'observations',
        'evidence_artifact_ids',
      ],
      properties: {
        scenario_id: { type: 'string', pattern: ID_PATTERN },
        attempt: { enum: [1, 2] },
        status: { enum: ['passed', 'failed', 'blocked', 'infrastructure_error'] },
        started_at: { type: 'string', format: 'date-time' },
        duration_ms: { type: 'integer', minimum: 0 },
        operations: { type: 'array', items: { $ref: '#/$defs/operation' } },
        checkpoints: { type: 'array', items: { $ref: '#/$defs/checkpointResult' } },
        observations: { type: 'array', items: { $ref: '#/$defs/observation' } },
        evidence_artifact_ids: { type: 'array', items: nonEmptyString(200), uniqueItems: true },
      },
    },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id',
        'scenario_id',
        'checkpoint_id',
        'severity',
        'classification',
        'reproducible',
        'title',
        'expected',
        'actual',
        'attempt_numbers',
      ],
      properties: {
        id: nonEmptyString(200),
        scenario_id: { type: 'string', pattern: ID_PATTERN },
        checkpoint_id: { type: 'string', pattern: ID_PATTERN },
        severity: { enum: ['P0', 'P1', 'P2', 'P3'] },
        classification: { enum: ['verified', 'advisory'] },
        reproducible: { type: 'boolean' },
        title: nonEmptyString(MAX_SHORT_TEXT),
        expected: nonEmptyString(MAX_LONG_TEXT),
        actual: nonEmptyString(MAX_LONG_TEXT),
        attempt_numbers: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { enum: [1, 2] },
        },
      },
    },
    cleanup: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'error'],
      properties: {
        status: { enum: ['passed', 'failed', 'not_required'] },
        summary: nonEmptyString(MAX_LONG_TEXT),
        error: { oneOf: [{ type: 'null' }, nonEmptyString(MAX_LONG_TEXT)] },
      },
    },
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'path', 'sanitized', 'sha256', 'retention_days', 'upload'],
      properties: {
        id: nonEmptyString(200),
        kind: {
          enum: ['video', 'trace', 'screenshot', 'console', 'network', 'ledger', 'plan', 'report'],
        },
        path: nonEmptyString(4_000),
        sanitized: { type: 'boolean' },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        retention_days: { type: 'integer', minimum: 1 },
        upload: {
          oneOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'url'],
              properties: {
                name: nonEmptyString(200),
                url: httpUrl(),
              },
            },
          ],
        },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['uncachedIn', 'cacheRead', 'cacheWrite', 'out'],
      properties: {
        uncachedIn: { type: 'integer', minimum: 0 },
        cacheRead: { type: 'integer', minimum: 0 },
        cacheWrite: { type: 'integer', minimum: 0 },
        out: { type: 'integer', minimum: 0 },
      },
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['model_id', 'model_version', 'browser_name', 'browser_version'],
      properties: {
        model_id: nonEmptyString(200),
        model_version: { type: ['string', 'null'] },
        browser_name: { const: 'chromium' },
        browser_version: nonEmptyString(200),
      },
    },
    cost: {
      type: 'object',
      additionalProperties: false,
      required: ['usage', 'usd', 'source'],
      properties: {
        usage: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/usage' }] },
        usd: { oneOf: [{ type: 'null' }, { type: 'number', minimum: 0 }] },
        source: { enum: ['reported', 'estimated', 'unknown'] },
      },
    },
  },
};

export class QaSchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid QA plan at ${path}: ${message}`);
    this.name = 'QaSchemaError';
    this.path = path;
  }
}

/**
 * Strictly validate the model-authored plan before browser tools are enabled.
 * Unknown keys and invalid enum values fail closed; no executable field is defaulted.
 */
export function parseQaPlan(raw: unknown, hardLimits: QaPlanHardLimits): QaPlan {
  const maxScenarios = hardLimit(
    hardLimits.max_scenarios,
    CONTROLLER_MAX_SCENARIOS,
    'hardLimits.max_scenarios',
  );
  const maxCheckpoints = hardLimit(
    hardLimits.max_checkpoints_per_scenario ?? CONTROLLER_MAX_CHECKPOINTS_PER_SCENARIO,
    CONTROLLER_MAX_CHECKPOINTS_PER_SCENARIO,
    'hardLimits.max_checkpoints_per_scenario',
  );

  const root = record(raw, '$');
  exactKeys(
    root,
    [
      'schema_version',
      'impact_assessment',
      'testability',
      'no_testable_surface_reason',
      'surfaces',
      'scenarios',
      'risk_notes',
      'blind_spots',
    ],
    '$',
  );

  if (root['schema_version'] !== QA_SCHEMA_VERSION) {
    fail('$.schema_version', `expected ${QA_SCHEMA_VERSION}`);
  }

  const testability = oneOf(
    root['testability'],
    ['testable', 'no_testable_surface'] as const,
    '$.testability',
  );
  const reason = nullableString(
    root['no_testable_surface_reason'],
    MAX_LONG_TEXT,
    '$.no_testable_surface_reason',
  );
  const surfaces = stringArray(root['surfaces'], '$.surfaces');
  const scenarioValues = array(root['scenarios'], '$.scenarios', maxScenarios);
  const scenarios = scenarioValues.map((value, index) =>
    parseScenario(value, `$.scenarios[${index}]`, maxCheckpoints),
  );
  uniqueBy(scenarios, (scenario) => scenario.id, '$.scenarios', 'scenario id');

  if (testability === 'no_testable_surface') {
    if (reason === null) fail('$.no_testable_surface_reason', 'must explain why no surface is testable');
    if (scenarios.length !== 0) fail('$.scenarios', 'must be empty when testability is no_testable_surface');
  } else {
    if (reason !== null) fail('$.no_testable_surface_reason', 'must be null when testability is testable');
    if (surfaces.length === 0) fail('$.surfaces', 'must name at least one affected surface');
    if (scenarios.length === 0) fail('$.scenarios', 'must contain at least one scenario');
  }

  return {
    schema_version: QA_SCHEMA_VERSION,
    impact_assessment: string(root['impact_assessment'], MAX_LONG_TEXT, '$.impact_assessment'),
    testability,
    no_testable_surface_reason: reason,
    surfaces,
    scenarios,
    risk_notes: stringArray(root['risk_notes'], '$.risk_notes'),
    blind_spots: stringArray(root['blind_spots'], '$.blind_spots'),
  };
}

function parseScenario(raw: unknown, path: string, maxCheckpoints: number): QaScenario {
  const value = record(raw, path);
  exactKeys(
    value,
    [
      'id',
      'title',
      'rationale',
      'viewport',
      'preconditions',
      'seeded_state',
      'checkpoints',
      'allowed_mutations',
      'cleanup_expectations',
    ],
    path,
  );

  const checkpointValues = array(value['checkpoints'], `${path}.checkpoints`, maxCheckpoints);
  if (checkpointValues.length === 0) fail(`${path}.checkpoints`, 'must contain at least one checkpoint');
  const checkpoints = checkpointValues.map((checkpoint, index) =>
    parseCheckpoint(checkpoint, `${path}.checkpoints[${index}]`),
  );
  uniqueBy(checkpoints, (checkpoint) => checkpoint.id, `${path}.checkpoints`, 'checkpoint id');

  const mutationValues = array(value['allowed_mutations'], `${path}.allowed_mutations`, 5);
  if (mutationValues.length === 0) fail(`${path}.allowed_mutations`, 'must not be empty');
  const allowedMutations = mutationValues.map((mutation, index) =>
    oneOf(
      mutation,
      QA_MUTATION_CATEGORIES,
      `${path}.allowed_mutations[${index}]`,
    ),
  );
  uniqueBy(allowedMutations, (mutation) => mutation, `${path}.allowed_mutations`, 'mutation');
  if (allowedMutations.includes('none') && allowedMutations.length > 1) {
    fail(`${path}.allowed_mutations`, '`none` cannot be combined with a mutating category');
  }

  return {
    id: identifier(value['id'], `${path}.id`),
    title: string(value['title'], MAX_SHORT_TEXT, `${path}.title`),
    rationale: string(value['rationale'], MAX_LONG_TEXT, `${path}.rationale`),
    viewport: parseViewport(value['viewport'], `${path}.viewport`),
    preconditions: stringArray(value['preconditions'], `${path}.preconditions`),
    seeded_state: stringArray(value['seeded_state'], `${path}.seeded_state`),
    checkpoints,
    allowed_mutations: allowedMutations as QaMutationCategory[],
    cleanup_expectations: stringArray(
      value['cleanup_expectations'],
      `${path}.cleanup_expectations`,
    ),
  };
}

function parseViewport(raw: unknown, path: string): QaViewport {
  const value = record(raw, path);
  exactKeys(value, ['kind', 'width', 'height', 'justification'], path);
  return {
    kind: oneOf(value['kind'], ['desktop', 'mobile'] as const, `${path}.kind`),
    width: integer(value['width'], 240, 3_840, `${path}.width`),
    height: integer(value['height'], 320, 2_160, `${path}.height`),
    justification: string(value['justification'], MAX_SHORT_TEXT, `${path}.justification`),
  };
}

function parseCheckpoint(raw: unknown, path: string): QaCheckpoint {
  const value = record(raw, path);
  exactKeys(value, ['id', 'description', 'expected', 'assertion'], path);
  const expected = string(value['expected'], MAX_LONG_TEXT, `${path}.expected`);
  const assertion = parseCheckpointAssertion(value['assertion'], `${path}.assertion`);
  if (assertion.kind === 'status' && !/^(?:[2-4]\d{2})$/.test(expected)) {
    fail(`${path}.expected`, 'must be an HTTP status string from 200 through 499 for a status assertion');
  }
  return {
    id: identifier(value['id'], `${path}.id`),
    description: string(value['description'], MAX_SHORT_TEXT, `${path}.description`),
    expected,
    assertion,
  };
}

function parseCheckpointAssertion(raw: unknown, path: string): QaCheckpointAssertion {
  const value = record(raw, path);
  exactKeys(value, ['kind', 'locator', 'url_contains'], path);
  const kind = oneOf(value['kind'], QA_CHECKPOINT_ASSERTION_KINDS, `${path}.kind`);
  const locator = value['locator'] === null
    ? null
    : parseCheckpointLocator(value['locator'], `${path}.locator`);
  const urlContains = nullableString(value['url_contains'], MAX_LONG_TEXT, `${path}.url_contains`);

  if (kind === 'url') {
    if (locator !== null) fail(`${path}.locator`, 'must be null for a URL assertion');
    if (urlContains === null) fail(`${path}.url_contains`, 'must provide the exact URL matcher');
  } else if (kind === 'status') {
    if (locator !== null) fail(`${path}.locator`, 'must be null for a status assertion');
    if (urlContains !== null) fail(`${path}.url_contains`, 'must be null for a status assertion');
  } else {
    if (locator === null) fail(`${path}.locator`, `must be provided for a ${kind} assertion`);
    if (urlContains !== null) fail(`${path}.url_contains`, `must be null for a ${kind} assertion`);
  }

  return { kind, locator, url_contains: urlContains };
}

function parseCheckpointLocator(raw: unknown, path: string): QaCheckpointLocator {
  const value = record(raw, path);
  exactKeys(value, ['by', 'value', 'name', 'exact', 'nth'], path);
  const by = oneOf(value['by'], QA_CHECKPOINT_LOCATOR_KINDS, `${path}.by`);
  const name = nullableString(value['name'], MAX_SHORT_TEXT, `${path}.name`);
  const exact = value['exact'];
  if (typeof exact !== 'boolean') fail(`${path}.exact`, 'expected a boolean');
  const nth = value['nth'] === null
    ? null
    : integer(value['nth'], 0, 10_000, `${path}.nth`);
  if (by !== 'role' && name !== null) fail(`${path}.name`, 'is valid only for a role locator');
  if ((by === 'css' || by === 'test_id') && exact) {
    fail(`${path}.exact`, `must be false for a ${by} locator`);
  }
  return {
    by,
    value: string(value['value'], MAX_LONG_TEXT, `${path}.value`),
    name,
    exact,
    nth,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field');
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'missing required field');
  }
}

function string(value: unknown, maxLength: number, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  const trimmed = value.trim();
  if (!trimmed) fail(path, 'must not be empty');
  if (trimmed.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return trimmed;
}

function nullableString(value: unknown, maxLength: number, path: string): string | null {
  return value === null ? null : string(value, maxLength, path);
}

function identifier(value: unknown, path: string): string {
  const id = string(value, 64, path);
  if (!new RegExp(ID_PATTERN).test(id)) {
    fail(path, 'must start with a lowercase letter and contain only lowercase letters, digits, or hyphens');
  }
  return id;
}

function stringArray(value: unknown, path: string): string[] {
  const values = array(value, path, MAX_LIST_ITEMS).map((item, index) =>
    string(item, MAX_SHORT_TEXT, `${path}[${index}]`),
  );
  uniqueBy(values, (item) => item, path, 'value');
  return values;
}

function array(value: unknown, path: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  if (value.length > maxItems) fail(path, `must contain at most ${maxItems} items`);
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function integer(value: unknown, min: number, max: number, path: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(path, `expected an integer from ${min} to ${max}`);
  }
  return value as number;
}

function hardLimit(value: number, controllerMax: number, path: string): number {
  if (!Number.isInteger(value) || value < 1) fail(path, 'expected a positive integer');
  return Math.min(value, controllerMax);
}

function uniqueBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) fail(path, `contains a duplicate ${label}: ${JSON.stringify(key)}`);
    seen.add(key);
  }
}

function fail(path: string, message: string): never {
  throw new QaSchemaError(path, message);
}
