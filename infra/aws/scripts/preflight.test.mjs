import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from './preflight.mjs';

const inputs = {
  expectedAccountId: '000000000000',
  stateBucketName: 'rizz-platform-state-test-only',
};
const identity = {
  state: 'present',
  value: {
    Account: '000000000000',
    Arn: 'arn:aws:iam::000000000000:user/test',
  },
};
const absent = args => (args[0] === 'sts' ? identity : { state: 'absent' });
test('missing inputs perform no AWS metadata calls', () => {
  assert.equal(
    preflight({
      call: () => {
        throw Error('must not run');
      },
    }).identity,
    'inputs_required',
  );
});
test('root/wrong-account stop before resource checks and never disclose identifiers', () => {
  for (const value of [
    { Account: '111111111111', Arn: identity.value.Arn },
    { ...identity.value, Arn: 'arn:aws:iam::000000000000:root' },
    { ...identity.value, Arn: 'not-an-arn' },
    { ...identity.value, Arn: 'arn:aws:iam::111111111111:user/test' },
  ]) {
    let calls = 0;
    const report = preflight({
      ...inputs,
      call: () => {
        calls++;
        return { state: 'present', value };
      },
    });
    assert.equal(calls, 1);
    assert.equal(report.safeToReviewPlan, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /000000000000|111111111111|arn:aws/,
    );
  }
});
test('known absent resources allow plan review only, never deployment', () => {
  const report = preflight({ ...inputs, call: absent });
  assert.equal(report.safeToReviewPlan, true);
  assert.match(report.guidance, /does not authorize apply/);
  assert.equal(report.inventoryComplete, false);
});
test('new and legacy resource names are read-only and each collision blocks a fresh plan', () => {
  const operations = [];
  preflight({
    ...inputs,
    call: args => {
      operations.push(args);
      return absent(args);
    },
  });
  for (const name of [
    'rizz-eks-staging',
    'rizz-cluster',
    'rizz-app',
    'rizz-backend',
  ]) {
    assert.ok(operations.some(args => args.includes(name)));
  }
  assert.ok(operations.every(args => /^(get-|describe-|head-)/.test(args[1])));
  for (const operation of operations.filter(
    args => ['eks', 'ecr', 's3api'].includes(args[0]) || args[1] === 'get-role',
  )) {
    const report = preflight({
      ...inputs,
      call: args =>
        JSON.stringify(args) === JSON.stringify(operation)
          ? { state: 'present' }
          : absent(args),
    });
    assert.equal(report.safeToReviewPlan, false, JSON.stringify(operation));
  }
});
test('filtered VPC results distinguish absence from malformed data without exposing IDs', () => {
  for (const [value, safe, state] of [
    [{ Vpcs: [] }, true, 'absent'],
    [{ Vpcs: [{ VpcId: 'vpc-private-identifier' }] }, false, 'present'],
    [{}, false, 'unknown'],
  ]) {
    const report = preflight({
      ...inputs,
      call: args =>
        args[0] === 'ec2' ? { state: 'present', value } : absent(args),
    });
    assert.equal(report.safeToReviewPlan, safe);
    assert.equal(report.resources.namedNetworks, state);
    assert.doesNotMatch(JSON.stringify(report), /vpc-private-identifier/);
  }
});
test('a same-account assumed-role identity is accepted without printing the role/session', () => {
  const report = preflight({
    ...inputs,
    call: args =>
      args[0] === 'sts'
        ? {
            state: 'present',
            value: {
              ...identity.value,
              Arn: 'arn:aws:sts::000000000000:assumed-role/test-role/private-session',
            },
          }
        : absent(args),
  });
  assert.equal(report.identity, 'non_root_expected_account');
  assert.doesNotMatch(JSON.stringify(report), /private-session|test-role/);
});
test('access denied is unknown, never falsely absent; collisions require reconciliation', () => {
  assert.equal(
    preflight({
      ...inputs,
      call: args => (args[0] === 'sts' ? identity : { state: 'unknown' }),
    }).safeToReviewPlan,
    false,
  );
  const report = preflight({
    ...inputs,
    call: args =>
      args[0] === 'sts'
        ? identity
        : args[0] === 'ecr'
        ? { state: 'present' }
        : { state: 'absent' },
  });
  assert.equal(report.safeToReviewPlan, false);
  assert.match(report.guidance, /reconciliation/);
});
test('OIDC provider audience must match; S3 404 is explicitly inconclusive', () => {
  const call = audience => args =>
    args[0] === 'sts'
      ? identity
      : args[0] === 's3api'
      ? { state: 'not_found_or_hidden' }
      : args[1] === 'get-open-id-connect-provider'
      ? {
          state: 'present',
          value: {
            Url: 'token.actions.githubusercontent.com',
            ClientIDList: [audience],
          },
        }
      : { state: 'absent' };
  assert.equal(
    preflight({ ...inputs, call: call('wrong') }).safeToReviewPlan,
    false,
  );
  assert.equal(
    preflight({ ...inputs, call: call('sts.amazonaws.com') }).resources
      .stateBucket,
    'not_found_or_hidden',
  );
});
