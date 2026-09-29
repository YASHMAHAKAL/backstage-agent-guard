import { CloudMetricsObserver, parseRizzMetrics } from './cloudMetrics';
import { CloudTarget } from './cloudTarget';

const sample = `# HELP rizz_ai_http_requests_total Requests
# TYPE rizz_ai_http_requests_total counter
rizz_ai_http_requests_total{route="/api/rizz",status="200"} 3
rizz_ai_http_requests_total{route="/api/chat",status="503"} 1
rizz_ai_http_duration_seconds_bucket{route="/api/rizz",le="+Inf"} 3
rizz_ai_http_duration_seconds_sum{route="/api/rizz"} 0.9
rizz_ai_http_duration_seconds_count{route="/api/rizz"} 3
rizz_ai_http_duration_seconds_sum{route="/api/chat"} 0.1
rizz_ai_http_duration_seconds_count{route="/api/chat"} 1
rizz_ai_gemini_requests_total{route="rizz",outcome="success"} 3
rizz_ai_gemini_requests_total{route="chat",outcome="rate_limited"} 1
rizz_ai_gemini_inflight 0
rizz_ai_demo_provider_calls_total 4
rizz_ai_demo_provider_call_limit 100
`;
const target = {
  namespace: 'rizz-staging',
} as CloudTarget;

it('reduces fixed-label private metrics to one-replica numeric evidence', () => {
  expect(parseRizzMetrics(sample)).toEqual({
    scope: 'one_backend_replica',
    apiRequests: 4,
    apiErrors: 1,
    meanApiLatencySeconds: 0.25,
    providerOutcomes: { success: 3, rate_limited: 1 },
    providerCalls: 4,
    providerCallLimit: 100,
    providerInFlight: 0,
  });
  expect(() =>
    parseRizzMetrics(`${sample}private_prompt{value="secret"} 1\n`),
  ).toThrow();
  expect(() =>
    parseRizzMetrics(
      sample.replace('route="/api/rizz"', 'route="/api/secret"'),
    ),
  ).toThrow();
  expect(() =>
    parseRizzMetrics(sample.replace('rizz_ai_gemini_inflight 0\n', '')),
  ).toThrow();
});

it('reads only the fixed Kubernetes Service proxy and never returns raw failures', async () => {
  const readText = jest.fn().mockResolvedValue(sample);
  const observer = new CloudMetricsObserver({
    readers: {
      readClusterConnection: jest.fn().mockResolvedValue({
        endpoint: 'https://cluster.example/',
        ca: 'fixture-ca',
        token: 'fixture-token',
      }),
    },
    readText,
  });
  const result = await observer.observe(target);
  expect(result).toMatchObject({ state: 'observed', apiRequests: 4 });
  expect(readText.mock.calls[0][0].url.pathname).toBe(
    '/api/v1/namespaces/rizz-staging/services/rizz-backend-service/proxy/metrics',
  );
  readText.mockRejectedValueOnce(new Error('secret provider token'));
  expect(await observer.observe(target)).toMatchObject({
    state: 'unavailable',
  });
});
