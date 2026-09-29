#!/usr/bin/env node
// Designated operator/runner process. This is never imported into Backstage's
// HTTP server and has no browser, MCP, or Scaffolder execution route.
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const {
  createTerraformRunnerProof,
  executeApprovedTerraformPlan,
  GitHubTerraformConfigurationReader,
  prepareTerraformSavedPlan,
} = require('../plugins/agent-guard-backend/dist/index.cjs.js');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Runner configuration missing: ${name}`);
  return value;
}

function key(name) {
  const encoded = required(name);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new Error(`Runner key encoding invalid: ${name}`);
  return Buffer.from(encoded, 'base64');
}

function url() {
  const base = new URL(required('AGENT_GUARD_RUNNER_BACKSTAGE_URL'));
  if (
    base.protocol !== 'https:' &&
    !(
      base.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(base.hostname)
    )
  )
    throw new Error('Runner Backstage URL must use HTTPS or local loopback');
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error('Runner Backstage URL must be a bare origin');
  return base;
}

async function main() {
  const [command, requestId, ...rest] = process.argv.slice(2);
  if (
    !['plan', 'wait', 'apply'].includes(command) ||
    !/^[a-f0-9-]{36}$/.test(requestId ?? '')
  )
    throw new Error(
      'Usage: terraform-runner.cjs plan|wait|apply <request-uuid> ...',
    );
  if (
    command === 'apply' &&
    (rest.length !== 1 ||
      rest[0] !== '--execute-approved-plan' ||
      process.env.AGENT_GUARD_ENABLE_TERRAFORM_APPLY !==
        'YES-I-AUTHORIZE-AWS-APPLY')
  )
    throw new Error('Live apply requires explicit operator activation');
  const runnerKey = key('AGENT_GUARD_TERRAFORM_RUNNER_KEY');
  const serviceToken = required('AGENT_GUARD_RUNNER_SERVICE_TOKEN');
  const base = url();
  const endpoint = path =>
    new URL(`/api/agent-guard/internal/rizz/terraform/${path}`, base);
  const post = async (path, message) => {
    const response = await fetch(endpoint(path), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...message,
        proof: createTerraformRunnerProof(message, runnerKey),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `Terraform runner service request failed (${response.status})`,
      );
    const body = await response.text();
    if (Buffer.byteLength(body) > 256 * 1024)
      throw new Error('Terraform runner service response exceeded limit');
    return JSON.parse(body);
  };
  const runnerId = required('AGENT_GUARD_TERRAFORM_RUNNER_ID');
  if (command === 'wait') {
    if (rest.length) throw new Error('Wait accepts only a request ID');
    const deadline = Date.now() + 24 * 60 * 1000;
    while (Date.now() < deadline) {
      const review = await post('review-state', { requestId });
      if (review?.state === 'approved') {
        // A state label is not authorization. Retrieve and check the live
        // receipt; apply will fetch and verify it again before execution.
        const receipt = await post('receipt', { requestId });
        if (
          receipt?.approval?.binding?.requestId !== requestId ||
          receipt.approval.binding.runnerId !== runnerId
        )
          throw new Error('Approved receipt is for another request or runner');
        process.stdout.write('Exact plan approval is ready.\n');
        return;
      }
      if (review?.state !== 'awaiting_review')
        throw new Error('Plan review ended without an executable approval');
      await new Promise(resolveTimeout => setTimeout(resolveTimeout, 15000));
    }
    throw new Error('Plan review wait timed out; generate a new plan');
  }
  const checkoutDirectory = resolve(required('AGENT_GUARD_TERRAFORM_CHECKOUT'));
  const privateArtifactDirectory = resolve(
    required('AGENT_GUARD_TERRAFORM_PRIVATE_ARTIFACT_DIR'),
  );
  if (command === 'plan') {
    if (rest.length !== 2 || !/^[a-f0-9]{40}$/.test(rest[1]))
      throw new Error('Plan needs the reviewed PR URL and merged commit');
    const [prUrl, mergedCommit] = rest;
    const repository = required('AGENT_GUARD_TERRAFORM_REPOSITORY');
    const match = repository.match(
      /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/,
    );
    if (!match) throw new Error('Invalid runner configuration repository');
    const reader = new GitHubTerraformConfigurationReader({
      owner: match[1],
      repo: match[2],
      token: required('AGENT_GUARD_TERRAFORM_GITHUB_READ_TOKEN'),
    });
    const pending = await post('request', { requestId });
    const result = await prepareTerraformSavedPlan({
      request: pending,
      configurationPr: { url: prUrl, mergedCommit },
      checkoutDirectory,
      privateArtifactDirectory,
      backendConfigFile: 'state.backend.hcl',
      awsProfile: required('AGENT_GUARD_TERRAFORM_AWS_PROFILE'),
      expectedAccountId: required('AGENT_GUARD_TERRAFORM_EXPECTED_ACCOUNT_ID'),
      runnerId,
      runnerKey,
      verifyMergedReview: input => reader.verifyMergedReview(input),
      registerPlan: async message => {
        // This message already includes a runner proof over the full binding.
        const { proof, ...payload } = message;
        await post('plans', payload);
      },
    });
    process.stdout.write(
      JSON.stringify({
        requestId: result.requestId,
        planDigest: result.planDigest,
      }) + '\n',
    );
    return;
  }
  const receipt = await post('receipt', { requestId });
  const binding = receipt?.approval?.binding;
  if (
    !binding ||
    binding.requestId !== requestId ||
    binding.runnerId !== runnerId
  )
    throw new Error('Approved receipt is for another request or runner');
  const stillApproved = async () => {
    const current = await post('receipt', { requestId });
    return (
      current?.approval?.bindingDigest === receipt.approval.bindingDigest &&
      current.signature === receipt.signature
    );
  };
  const runId = randomUUID();
  const result = await executeApprovedTerraformPlan({
    root: binding.root,
    checkoutDirectory,
    privateArtifactDirectory,
    planFileName: `${requestId}.tfplan`,
    runId,
    receipt,
    signingKey: key('AGENT_GUARD_TERRAFORM_APPROVAL_KEY'),
    runnerId,
    backendConfigFile: 'state.backend.hcl',
    isCurrentPlatformReviewer: async reviewer =>
      reviewer === receipt.approval.reviewer && (await stillApproved()),
    isCurrentSourceCommit: async commit =>
      commit === binding.sourceCommit && (await stillApproved()),
  });
  const outcome = {
    requestId,
    bindingDigest: receipt.approval.bindingDigest,
    runId,
    status: result.status,
  };
  await post('outcome', outcome);
  process.stdout.write(
    JSON.stringify({ requestId, runId: outcome.runId, status: result.status }) +
      '\n',
  );
}

main().catch(error => {
  // Never print provider, Terraform, HTTP response, or token data.
  process.stderr.write(`Terraform runner stopped: ${error.message}\n`);
  process.exitCode = 1;
});
