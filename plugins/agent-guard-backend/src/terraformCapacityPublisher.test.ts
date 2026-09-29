import {
  capacityFile,
  GitHubTerraformCapacityPublisher,
} from './terraformCapacityPublisher';

const baseSha = 'a'.repeat(40);
const fileSha = 'b'.repeat(40);
const headSha = 'c'.repeat(40);
const requestId = 'ff26811f-bbfc-42f3-843f-e2bb4e13c7df';
const branch = `agent-guard/terraform-capacity-${requestId}`;

function github() {
  let ref = '';
  let workers = 1;
  let prCreated = false;
  let mainSha = baseSha;
  let changedFiles = [{ filename: capacityFile, status: 'modified' }];
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body });
    let status = 200;
    let response: any;
    if (path.endsWith('/git/ref/heads/main'))
      response = { object: { sha: mainSha } };
    else if (path.includes('/git/ref/heads/agent-guard/')) {
      if (!ref) status = 404;
      else response = { object: { sha: ref } };
    } else if (path.includes(`/contents/${capacityFile}?`)) {
      const selected = path.includes('ref=main') ? 1 : workers;
      response = {
        type: 'file',
        sha: fileSha,
        encoding: 'base64',
        content: Buffer.from(
          JSON.stringify({ worker_desired_size: selected }),
        ).toString('base64'),
      };
    } else if (path.endsWith('/git/refs') && method === 'POST') {
      ref = baseSha;
      response = { ref: `refs/heads/${branch}`, object: { sha: ref } };
    } else if (path.endsWith(`/contents/${capacityFile}`) && method === 'PUT') {
      workers = JSON.parse(
        Buffer.from(body.content, 'base64').toString(),
      ).worker_desired_size;
      ref = headSha;
      response = { commit: { sha: headSha } };
    } else if (path.includes('/compare/')) response = { files: changedFiles };
    else if (path.includes('/pulls?')) {
      response = prCreated
        ? [
            {
              html_url: 'https://github.com/example/portal/pull/9',
              state: 'open',
              head: { sha: headSha },
              base: { ref: 'main' },
            },
          ]
        : [];
    } else if (path.endsWith('/pulls') && method === 'POST') {
      prCreated = true;
      response = {
        html_url: 'https://github.com/example/portal/pull/9',
        head: { sha: headSha },
      };
    } else throw new Error(`Unexpected GitHub request ${method} ${path}`);
    return new Response(JSON.stringify(response ?? {}), { status });
  });
  return {
    publisher: new GitHubTerraformCapacityPublisher({
      owner: 'example',
      repo: 'portal',
      token: 'test-token',
      fetcher: fetcher as typeof fetch,
    }),
    calls,
    setMain: (value: string) => {
      mainSha = value;
    },
    setFiles: (value: typeof changedFiles) => {
      changedFiles = value;
    },
  };
}

describe('bounded Terraform capacity PR publisher', () => {
  it('changes exactly the capacity file and recovers an ambiguous repeat', async () => {
    const { publisher, calls } = github();
    const baseline = await publisher.readBaseline();
    expect(baseline).toEqual({ mainSha: baseSha, fileSha, workers: 1 });
    const input = {
      requestId,
      requester: 'user:default/platform',
      desiredWorkers: 2,
      baseline,
    };
    const first = await publisher.publish(input);
    const second = await publisher.publish(input);
    expect(second).toEqual(first);
    expect(first.url).toContain('/pull/9');
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(
      calls.filter(
        call => call.method === 'POST' && call.path.endsWith('/pulls'),
      ),
    ).toHaveLength(1);
    const write = calls.find(call => call.method === 'PUT')!;
    expect(write.path).toContain(capacityFile);
    expect(write.body.sha).toBe(fileSha);
    expect(
      JSON.parse(Buffer.from(write.body.content, 'base64').toString()),
    ).toEqual({ worker_desired_size: 2 });
  });

  it('rejects a moved main, no-op, or an expanded branch', async () => {
    const state = github();
    const baseline = await state.publisher.readBaseline();
    await expect(
      state.publisher.publish({
        requestId,
        requester: 'user:default/platform',
        desiredWorkers: 1,
        baseline,
      }),
    ).rejects.toThrow('no-op');
    state.setMain('d'.repeat(40));
    await expect(
      state.publisher.publish({
        requestId,
        requester: 'user:default/platform',
        desiredWorkers: 2,
        baseline,
      }),
    ).rejects.toThrow('baseline changed');
    state.setMain(baseSha);
    state.setFiles([
      { filename: 'infra/aws/environments/staging/iam.tf', status: 'modified' },
    ]);
    await expect(
      state.publisher.publish({
        requestId,
        requester: 'user:default/platform',
        desiredWorkers: 2,
        baseline,
      }),
    ).rejects.toThrow('exact bounded change');
  });
});
