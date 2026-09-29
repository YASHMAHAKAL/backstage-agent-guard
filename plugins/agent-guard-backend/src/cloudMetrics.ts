import { AuthenticatedCloudReaders } from './cloudReaders';
import { readCloudHttpsText } from './cloudHttps';
import { CloudTarget } from './cloudTarget';

const apiRoutes = new Set(['/api/rizz', '/api/chat', '/api/analyze']);
const httpRoutes = new Set([
  ...apiRoutes,
  '/healthz',
  '/readyz',
  '/metrics',
  '/auth/check',
  'other',
]);
const outcomes = new Set([
  'success',
  'timeout',
  'rate_limited',
  'unavailable',
  'invalid_response',
  'cancelled',
]);
const number = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e12)
    throw new Error('Invalid metric value');
  return parsed;
};

/** Only bounded numeric aggregates leave the backend. A service proxy samples
 * one backend replica and must never be called an application-wide total. */
export function parseRizzMetrics(body: string) {
  if (Buffer.byteLength(body) > 65536) throw new Error('Metrics too large');
  const seen = new Set<string>();
  const provider: Record<string, number> = {};
  let requests = 0;
  let errors = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let providerCalls: number | undefined;
  let providerLimit: number | undefined;
  let inFlight: number | undefined;
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line.split(' ')[0]))
      throw new Error('Duplicate metric series');
    seen.add(line.split(' ')[0]);
    let match =
      /^rizz_ai_http_requests_total\{route="([^"]+)",status="([1-5][0-9]{2})"\} ([0-9]+)$/.exec(
        line,
      );
    if (match) {
      if (!httpRoutes.has(match[1])) throw new Error('Unbounded route label');
      if (apiRoutes.has(match[1])) {
        const value = number(match[3]);
        requests += value;
        if (Number(match[2]) >= 400) errors += value;
      }
      continue;
    }
    match =
      /^rizz_ai_http_duration_seconds_(sum|count)\{route="([^"]+)"\} ([0-9]+(?:\.[0-9]+)?)$/.exec(
        line,
      );
    if (match) {
      if (!httpRoutes.has(match[2])) throw new Error('Unbounded route label');
      if (apiRoutes.has(match[2])) {
        if (match[1] === 'sum') latencySum += number(match[3]);
        else latencyCount += number(match[3]);
      }
      continue;
    }
    match =
      /^rizz_ai_http_duration_seconds_bucket\{route="([^"]+)",le="(\+Inf|[0-9]+(?:\.[0-9]+)?)"\} ([0-9]+)$/.exec(
        line,
      );
    if (match) {
      if (!httpRoutes.has(match[1])) throw new Error('Unbounded route label');
      number(match[3]);
      continue;
    }
    match =
      /^rizz_ai_gemini_requests_total\{route="(rizz|chat|analyze|other)",outcome="([^"]+)"\} ([0-9]+)$/.exec(
        line,
      );
    if (match) {
      if (!outcomes.has(match[2])) throw new Error('Unbounded outcome label');
      provider[match[2]] = (provider[match[2]] ?? 0) + number(match[3]);
      continue;
    }
    match =
      /^rizz_ai_(gemini_inflight|demo_provider_calls_total|demo_provider_call_limit) ([0-9]+)$/.exec(
        line,
      );
    if (match) {
      const value = number(match[2]);
      if (match[1] === 'gemini_inflight') inFlight = value;
      else if (match[1] === 'demo_provider_calls_total') providerCalls = value;
      else providerLimit = value;
      continue;
    }
    throw new Error('Unexpected metric series');
  }
  if (
    providerCalls === undefined ||
    providerLimit === undefined ||
    inFlight === undefined ||
    !Number.isSafeInteger(requests) ||
    !Number.isSafeInteger(errors) ||
    !Number.isSafeInteger(latencyCount) ||
    latencyCount > requests
  )
    throw new Error('Incomplete metric sample');
  return {
    scope: 'one_backend_replica' as const,
    apiRequests: requests,
    apiErrors: errors,
    meanApiLatencySeconds: latencyCount ? latencySum / latencyCount : null,
    providerOutcomes: provider,
    providerCalls,
    providerCallLimit: providerLimit,
    providerInFlight: inFlight,
  };
}

export interface CloudMetricsReader {
  observe(
    target: CloudTarget,
  ): Promise<
    | ({ state: 'observed'; checkedAt: string } & ReturnType<
        typeof parseRizzMetrics
      >)
    | { state: 'unavailable'; checkedAt: string }
  >;
}

export class CloudMetricsObserver implements CloudMetricsReader {
  constructor(
    private readonly options: {
      readers: Pick<AuthenticatedCloudReaders, 'readClusterConnection'>;
      readText?: typeof readCloudHttpsText;
    },
  ) {}
  async observe(target: CloudTarget) {
    const checkedAt = new Date().toISOString();
    try {
      const signal = AbortSignal.timeout(20000);
      const connection = await this.options.readers.readClusterConnection(
        target,
        signal,
      );
      const url = new URL(
        `/api/v1/namespaces/${target.namespace}/services/rizz-backend-service/proxy/metrics`,
        connection.endpoint,
      );
      const body = await (this.options.readText ?? readCloudHttpsText)({
        url,
        ca: connection.ca,
        token: connection.token,
        signal,
        maxBytes: 65536,
      });
      return {
        state: 'observed' as const,
        checkedAt,
        ...parseRizzMetrics(body),
      };
    } catch {
      return { state: 'unavailable' as const, checkedAt };
    }
  }
}
