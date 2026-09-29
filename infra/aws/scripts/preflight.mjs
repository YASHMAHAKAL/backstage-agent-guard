import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read-only, narrowly scoped metadata checks. Never emit raw AWS JSON/errors,
// credentials, account IDs, user ARNs or secret values.
export function preflight({ expectedAccountId, stateBucketName, call }) {
  if (
    !/^[0-9]{12}$/.test(expectedAccountId || '') ||
    !/^rizz-platform-state-[a-z0-9-]{6,35}$/.test(stateBucketName || '')
  ) {
    return {
      safeToReviewPlan: false,
      identity: 'inputs_required',
      resources: {},
    };
  }
  const identity = call(['sts', 'get-caller-identity']);
  if (identity.state !== 'present')
    return { safeToReviewPlan: false, identity: 'unavailable', resources: {} };
  if (
    identity.value.Account !== expectedAccountId ||
    typeof identity.value.Arn !== 'string' ||
    !new RegExp(
      `^arn:aws:(?:iam::${expectedAccountId}:user/[A-Za-z0-9_+=,.@/-]+|sts::${expectedAccountId}:assumed-role/[A-Za-z0-9_+=,.@/-]+)$`,
    ).test(identity.value.Arn)
  ) {
    return {
      safeToReviewPlan: false,
      identity: 'wrong_account_or_root',
      resources: {},
    };
  }
  const resources = {};
  for (const component of ['frontend', 'backend']) {
    resources[component] = call([
      'ecr',
      'describe-repositories',
      '--repository-names',
      `rizz-staging-${component}`,
    ]).state;
  }
  // Exact project names only, including the old source-repo Terraform names.
  // These checks do not establish ownership or enumerate every cloud resource.
  for (const [key, name] of [
    ['legacyFrontend', 'rizz-app'],
    ['legacyBackend', 'rizz-backend'],
  ]) {
    resources[key] = call([
      'ecr',
      'describe-repositories',
      '--repository-names',
      name,
    ]).state;
  }
  for (const [key, name] of [
    ['cluster', 'rizz-eks-staging'],
    ['legacyCluster', 'rizz-cluster'],
  ]) {
    resources[key] = call(['eks', 'describe-cluster', '--name', name]).state;
  }
  const vpcs = call([
    'ec2',
    'describe-vpcs',
    '--filters',
    'Name=tag:Name,Values=rizz-eks-staging,rizz-vpc',
  ]);
  resources.namedNetworks =
    vpcs.state === 'present'
      ? Array.isArray(vpcs.value?.Vpcs)
        ? vpcs.value.Vpcs.length > 0
          ? 'present'
          : 'absent'
        : 'unknown'
      : vpcs.state;
  resources.publisherRole = call([
    'iam',
    'get-role',
    '--role-name',
    'rizz-staging-image-publisher',
  ]).state;
  const oidc = call([
    'iam',
    'get-open-id-connect-provider',
    '--open-id-connect-provider-arn',
    `arn:aws:iam::${expectedAccountId}:oidc-provider/token.actions.githubusercontent.com`,
  ]);
  resources.githubOidc = oidc.state;
  if (
    oidc.state === 'present' &&
    (oidc.value.Url !== 'token.actions.githubusercontent.com' ||
      !oidc.value.ClientIDList?.includes('sts.amazonaws.com'))
  ) {
    resources.githubOidc = 'incompatible';
  }
  resources.stateBucket = call([
    's3api',
    'head-bucket',
    '--bucket',
    stateBucketName,
    '--expected-bucket-owner',
    expectedAccountId,
  ]).state;
  const unknown = Object.values(resources).some(
    state => !['present', 'absent', 'not_found_or_hidden'].includes(state),
  );
  const collision = [
    'frontend',
    'backend',
    'legacyFrontend',
    'legacyBackend',
    'cluster',
    'legacyCluster',
    'namedNetworks',
    'publisherRole',
    'stateBucket',
  ].some(key => resources[key] === 'present');
  return {
    safeToReviewPlan: !unknown && !collision,
    identity: 'non_root_expected_account',
    resources,
    inventoryComplete: false,
    guidance: collision
      ? 'Existing named resources require ownership/state reconciliation; do not fresh-apply.'
      : unknown
      ? 'Unknown/denied/incompatible metadata blocks provisioning.'
      : 'Read-only metadata only. Review state ownership, OIDC reuse/creation and bucket ownership before planning. This does not authorize apply.',
  };
}

export function awsCall(args) {
  const result = spawnSync(
    'aws',
    [
      ...args,
      '--profile',
      'rizz-platform',
      '--region',
      'us-east-1',
      '--output',
      'json',
      '--no-cli-pager',
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' },
    },
  );
  if (result.status === 0) {
    try {
      return {
        state: 'present',
        value: result.stdout.trim() ? JSON.parse(result.stdout) : {},
      };
    } catch {
      return { state: 'unknown' };
    }
  }
  const error = result.stderr || '';
  if (
    /RepositoryNotFoundException|NoSuchEntity/.test(error) ||
    (args[0] === 'eks' &&
      args[1] === 'describe-cluster' &&
      /ResourceNotFoundException/.test(error))
  )
    return { state: 'absent' };
  // HeadBucket 404 is not proof of global bucket-name availability or ownership.
  if (args[0] === 's3api' && /\(404\)|Not Found/.test(error))
    return { state: 'not_found_or_hidden' };
  return { state: 'unknown' };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = preflight({
    expectedAccountId: process.env.RIZZ_AWS_EXPECTED_ACCOUNT_ID,
    stateBucketName: process.env.RIZZ_AWS_STATE_BUCKET,
    call: awsCall,
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.safeToReviewPlan ? 0 : 1;
}
