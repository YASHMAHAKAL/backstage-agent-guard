import { JevClient } from './jev';

const input = {
  declaredIntent: 'Create a staging Node.js payments API',
  templateId: 'nodejs-api' as const,
  inputs: {
    serviceName: 'payments-api',
    requestedOwner: 'group:default/payments-team',
    environment: 'staging' as const,
    description: 'Internal payments API',
  },
};

describe('JevClient', () => {
  it('fails closed when no TypeSafe API credential is configured', async () => {
    const fetcher = jest.fn() as unknown as typeof fetch;
    expect(await new JevClient(undefined, fetcher).evaluate(input)).toEqual({
      kind: 'unavailable',
      reason: 'api_key_not_configured',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends all three typed questions and parses their distinct outputs', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-test',
          answers: {
            alignment: {
              type: 'choice',
              choice: 'aligned',
              probabilities: { aligned: 0.9, wrong_template: 0.1 },
              confidence: 0.8,
            },
            preservesIntent: { type: 'noul', noul: 0.95 },
            mismatchSeverity: {
              type: 'score',
              score: 0.2,
              probabilities: { '0': 0.8, '1': 0.2 },
              legend: { '0': 'No material mismatch', '1': 'Minor ambiguity' },
              confidence: 0.7,
            },
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await new JevClient('test-only', fetcher).evaluate(input);
    expect(result).toMatchObject({
      kind: 'evaluated',
      choice: 'aligned',
      choiceConfidence: 0.8,
      noul: 0.95,
      score: 0.2,
    });
    const body = JSON.parse((fetcher as jest.Mock).mock.calls[0][1].body);
    expect(Object.keys(body.questions)).toEqual([
      'alignment',
      'preservesIntent',
      'mismatchSeverity',
    ]);
  });

  it('does not turn an invalid response into permission', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ answers: {} }), { status: 200 }),
      ) as unknown as typeof fetch;
    expect(await new JevClient('test-only', fetcher).evaluate(input)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
  });
});
