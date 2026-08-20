import { describe, expect, it } from 'vitest';

import { QA_SCHEMA_VERSION, type QaPlan } from '../src/qa/types.js';
import {
  QA_PLAN_JSON_SCHEMA,
  QA_RUN_RESULT_JSON_SCHEMA,
  QaSchemaError,
  parseQaPlan,
} from '../src/qa/schema.js';

function scenario(id = 'create-project') {
  return {
    id,
    title: 'Create a project',
    rationale: 'The pull request changes the project creation form.',
    viewport: {
      kind: 'desktop',
      width: 1440,
      height: 900,
      justification: 'The changed form is a desktop surface.',
    },
    preconditions: ['The QA tenant has no project with the run prefix.'],
    seeded_state: [],
    checkpoints: [
      {
        id: 'project-visible',
        description: 'Submit the project creation form.',
        expected: 'The new project appears in the project list.',
        assertion: {
          kind: 'text',
          locator: { by: 'css', value: '#project-list', name: null, exact: false, nth: null },
          url_contains: null,
        },
      },
    ],
    allowed_mutations: ['create'],
    cleanup_expectations: ['Delete the run-prefixed project.'],
  };
}

function testablePlan(): unknown {
  return {
    schema_version: QA_SCHEMA_VERSION,
    impact_assessment: 'Project creation is the only affected user-facing surface.',
    testability: 'testable',
    no_testable_surface_reason: null,
    surfaces: ['Project creation form'],
    scenarios: [scenario()],
    risk_notes: [],
    blind_spots: ['External billing is outside the QA tenant.'],
  };
}

describe('parseQaPlan', () => {
  it('accepts the complete versioned plan contract', () => {
    const parsed = parseQaPlan(testablePlan(), { max_scenarios: 6 });

    expect(parsed).toMatchObject({
      schema_version: 1,
      testability: 'testable',
      scenarios: [{ id: 'create-project', allowed_mutations: ['create'] }],
    });
  });

  it('accepts an explained no-surface plan without scenarios', () => {
    const parsed = parseQaPlan(
      {
        schema_version: 1,
        impact_assessment: 'Only internal documentation changed.',
        testability: 'no_testable_surface',
        no_testable_surface_reason: 'No changed code is reachable through the browser.',
        surfaces: [],
        scenarios: [],
        risk_notes: [],
        blind_spots: [],
      },
      { max_scenarios: 6 },
    );

    expect(parsed.testability).toBe('no_testable_surface');
    expect(parsed.scenarios).toEqual([]);
  });

  it('rejects unknown fields instead of allowing hidden executable behavior', () => {
    const raw = testablePlan() as Record<string, unknown>;
    raw['browser_script'] = 'evaluate(document.cookie)';

    expect(() => parseQaPlan(raw, { max_scenarios: 6 })).toThrowError(
      new QaSchemaError('$.browser_script', 'unknown field'),
    );
  });

  it('rejects unknown nested enum values', () => {
    const raw = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    raw.scenarios[0] = { ...raw.scenarios[0]!, allowed_mutations: ['billing'] };

    expect(() => parseQaPlan(raw, { max_scenarios: 6 })).toThrow(
      /allowed_mutations\[0\].*expected one of none, create, update, delete, upload/,
    );
  });

  it('requires a closed, semantically valid assertion spec for every checkpoint', () => {
    const missing = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    const checkpoint = missing.scenarios[0]!.checkpoints[0]! as Partial<
      ReturnType<typeof scenario>['checkpoints'][number]
    >;
    delete checkpoint.assertion;
    expect(() => parseQaPlan(missing, { max_scenarios: 6 })).toThrow(
      /checkpoints\[0\]\.assertion.*missing required field/,
    );

    const mismatched = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    mismatched.scenarios[0]!.checkpoints[0]!.assertion = {
      kind: 'url',
      locator: { by: 'css', value: 'h1', name: null, exact: false, nth: null },
      url_contains: '/projects',
    };
    expect(() => parseQaPlan(mismatched, { max_scenarios: 6 })).toThrow(
      /locator.*must be null for a URL assertion/,
    );
  });

  it('enforces the caller limit and the immutable controller ceiling', () => {
    const two = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    two.scenarios.push(scenario('second-scenario'));
    expect(() => parseQaPlan(two, { max_scenarios: 1 })).toThrow(/at most 1 items/);

    const seven = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    for (let i = 2; i <= 7; i++) seven.scenarios.push(scenario(`scenario-${i}`));
    expect(() => parseQaPlan(seven, { max_scenarios: 99 })).toThrow(/at most 6 items/);
  });

  it('rejects duplicate scenario and checkpoint identities', () => {
    const duplicateScenario = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    duplicateScenario.scenarios.push(scenario());
    expect(() => parseQaPlan(duplicateScenario, { max_scenarios: 6 })).toThrow(
      /duplicate scenario id/,
    );

    const duplicateCheckpoint = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    const first = duplicateCheckpoint.scenarios[0]!;
    first.checkpoints.push({ ...first.checkpoints[0]! });
    expect(() => parseQaPlan(duplicateCheckpoint, { max_scenarios: 6 })).toThrow(
      /duplicate checkpoint id/,
    );
  });

  it('does not combine the non-mutating marker with mutating permissions', () => {
    const raw = testablePlan() as { scenarios: ReturnType<typeof scenario>[] };
    raw.scenarios[0] = { ...raw.scenarios[0]!, allowed_mutations: ['none', 'create'] };

    expect(() => parseQaPlan(raw, { max_scenarios: 6 })).toThrow(
      /`none` cannot be combined/,
    );
  });

  it('requires testability fields to agree', () => {
    const noReason = testablePlan() as Record<string, unknown>;
    noReason['testability'] = 'no_testable_surface';
    noReason['scenarios'] = [];
    noReason['surfaces'] = [];
    expect(() => parseQaPlan(noReason, { max_scenarios: 6 })).toThrow(
      /must explain why no surface is testable/,
    );

    const noScenarios = testablePlan() as Record<string, unknown>;
    noScenarios['scenarios'] = [];
    expect(() => parseQaPlan(noScenarios, { max_scenarios: 6 })).toThrow(
      /must contain at least one scenario/,
    );
  });

  it('returns the public TypeScript contract and publishes a closed JSON schema', () => {
    const parsed: QaPlan = parseQaPlan(testablePlan(), { max_scenarios: 6 });
    const planScenarios = QA_PLAN_JSON_SCHEMA.properties['scenarios'] as { maxItems: number };
    const runOutcome = QA_RUN_RESULT_JSON_SCHEMA.properties['outcome'] as { enum: string[] };
    const runPlan = QA_RUN_RESULT_JSON_SCHEMA.properties['plan'];
    expect(parsed.schema_version).toBe(1);
    expect(QA_PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(planScenarios.maxItems).toBe(6);
    expect(QA_RUN_RESULT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(runOutcome.enum).toContain('product_issue');
    expect(QA_RUN_RESULT_JSON_SCHEMA.required).toEqual(expect.arrayContaining([
      'base_resolution',
      'source_base_sha',
      'policy_base_shas',
    ]));
    expect(runPlan).toEqual({
      oneOf: [
        { type: 'null' },
        { $ref: 'https://juror.dev/schemas/qa-plan-v1.json' },
      ],
    });
  });
});
