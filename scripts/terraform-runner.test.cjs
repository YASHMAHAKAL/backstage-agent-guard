const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { test } = require('node:test');

const script = resolve(__dirname, 'terraform-runner.cjs');
const requestId = 'd61b54fe-f63c-49fb-b926-74892f216bed';
const runnerId = 'test-runner';

async function exercise(state, receipt) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.endsWith('/review-state')) {
      response.end(JSON.stringify({ state }));
    } else if (request.url?.endsWith('/receipt')) {
      response.end(JSON.stringify(receipt));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise(resolveListen =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  try {
    const port = server.address().port;
    const result = await new Promise(resolveRun => {
      const child = spawn(process.execPath, [script, 'wait', requestId], {
        env: {
          ...process.env,
          AGENT_GUARD_RUNNER_BACKSTAGE_URL: `http://127.0.0.1:${port}/`,
          AGENT_GUARD_RUNNER_SERVICE_TOKEN: 'test-service-token',
          AGENT_GUARD_TERRAFORM_RUNNER_KEY: `${'A'.repeat(43)}=`,
          AGENT_GUARD_TERRAFORM_RUNNER_ID: runnerId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('close', code => resolveRun({ code, stdout, stderr }));
    });
    return { ...result, calls };
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

test('wait accepts only a live receipt for the same request and runner', async () => {
  const accepted = await exercise('approved', {
    approval: { binding: { requestId, runnerId } },
  });
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /Exact plan approval is ready/);
  assert.equal(accepted.calls.length, 2);

  const swapped = await exercise('approved', {
    approval: { binding: { requestId, runnerId: 'different-runner' } },
  });
  assert.notEqual(swapped.code, 0);
  assert.doesNotMatch(swapped.stdout, /ready/);
});

test('wait stops on rejection without requesting a receipt', async () => {
  const rejected = await exercise('rejected', null);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.calls.length, 1);
  assert.doesNotMatch(rejected.stdout, /ready/);
});
