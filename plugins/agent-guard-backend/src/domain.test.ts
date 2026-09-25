import { decideReview, proposalInputSchema, SemanticResult } from './domain';

const validInput = {
  declaredIntent: 'Create a staging Node.js payments API',
  templateId: 'nodejs-api',
  inputs: {
    serviceName: 'payments-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging',
    description: 'Internal payments API',
  },
};

const aligned: SemanticResult = {
  kind: 'evaluated',
  model: 'jev-test',
  choice: 'aligned',
  choiceConfidence: 0.9,
  choiceProbabilities: { aligned: 0.9 },
  noul: 0.9,
  score: 0.2,
  scoreProbabilities: { '0': 0.8, '1': 0.2 },
  scoreLegend: { '0': 'No material mismatch', '1': 'Minor ambiguity' },
};

describe('proposal validation', () => {
  it('accepts a narrow staging API request', () => {
    expect(proposalInputSchema.safeParse(validInput).success).toBe(true);
  });

  it.each([
    {
      ...validInput,
      inputs: { ...validInput.inputs, environment: 'production' },
    },
    { ...validInput, inputs: { ...validInput.inputs, publicIngress: true } },
    { ...validInput, requester: 'user:default/admin' },
    { ...validInput, templateId: 'arbitrary-template' },
    { ...validInput, inputs: { ...validInput.inputs, schedule: '* * * * *' } },
    { ...validInput, inputs: { ...validInput.inputs, replicas: 3 } },
    { ...validInput, inputs: { ...validInput.inputs, replicas: 0 } },
  ])('rejects unsupported or authority-bearing input', input => {
    expect(proposalInputSchema.safeParse(input).success).toBe(false);
  });

  it('requires a schedule only for the worker', () => {
    expect(
      proposalInputSchema.safeParse({
        ...validInput,
        templateId: 'scheduled-worker',
      }).success,
    ).toBe(false);
    expect(
      proposalInputSchema.safeParse({
        ...validInput,
        templateId: 'scheduled-worker',
        inputs: { ...validInput.inputs, schedule: '0 2 * * *' },
      }).success,
    ).toBe(true);
    expect(
      proposalInputSchema.safeParse({
        ...validInput,
        templateId: 'scheduled-worker',
        inputs: {
          ...validInput.inputs,
          schedule: '0 2 * * *',
          replicas: 1,
        },
      }).success,
    ).toBe(false);
  });

  it('defaults API replicas to one and accepts at most two', () => {
    expect(proposalInputSchema.parse(validInput).inputs.replicas).toBe(1);
    expect(
      proposalInputSchema.parse({
        ...validInput,
        inputs: { ...validInput.inputs, replicas: 2 },
      }).inputs.replicas,
    ).toBe(2);
  });
});

describe('deterministic review routing', () => {
  it('requires clarification when Jev is unavailable', () => {
    expect(
      decideReview({
        semantic: { kind: 'unavailable', reason: 'api_key_not_configured' },
        owner: 'group:default/payments-team',
        ownershipEntityRefs: ['group:default/payments-team'],
      }),
    ).toMatchObject({ status: 'needs_clarification', reviewLane: null });
  });

  it('requires a distinct owner-group reviewer for same-team and cross-team proposals', () => {
    expect(
      decideReview({
        semantic: aligned,
        owner: 'group:default/payments-team',
        ownershipEntityRefs: ['group:default/payments-team'],
      }).reviewLane,
    ).toBe('owner_review');
    expect(
      decideReview({
        semantic: aligned,
        owner: 'group:default/payments-team',
        ownershipEntityRefs: ['group:default/other-team'],
      }).reviewLane,
    ).toBe('owner_review');
  });

  it('holds a mismatched or conflicting semantic result', () => {
    expect(
      decideReview({
        semantic: { ...aligned, choice: 'wrong_template' },
        owner: 'group:default/payments-team',
        ownershipEntityRefs: [],
      }).status,
    ).toBe('needs_clarification');
    expect(
      decideReview({
        semantic: { ...aligned, noul: 0.1 },
        owner: 'group:default/payments-team',
        ownershipEntityRefs: [],
      }).status,
    ).toBe('needs_clarification');
  });
});
