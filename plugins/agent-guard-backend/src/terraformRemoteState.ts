import { z } from 'zod/v3';

const accountId = z.string().regex(/^[0-9]{12}$/);
const profile = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const bucket = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  .refine(value => !value.includes('replace-with'));
const stateKeys = {
  registry: 'rizz-platform/registry/terraform.tfstate',
  staging: 'rizz-platform/eks-staging/terraform.tfstate',
} as const;

function oneMatch(text: string, expression: RegExp) {
  const matches = [...text.matchAll(expression)];
  if (matches.length !== 1) throw new Error('Invalid Terraform backend target');
  return matches[0][1];
}

export function verifyTerraformBackendTarget(input: {
  backendText: string;
  root: 'registry' | 'staging';
  expectedProfile: string;
  expectedAccountId: string;
}) {
  const expectedProfile = profile.parse(input.expectedProfile);
  const expectedAccountId = accountId.parse(input.expectedAccountId);
  const backendBucket = bucket.parse(
    oneMatch(input.backendText, /^\s*bucket\s*=\s*"([^"]+)"\s*$/gm),
  );
  const backendProfile = profile.parse(
    oneMatch(input.backendText, /^\s*profile\s*=\s*"([^"]+)"\s*$/gm),
  );
  const backendAccount = accountId.parse(
    oneMatch(
      input.backendText,
      /^\s*allowed_account_ids\s*=\s*\[\s*"([^"]+)"\s*\]\s*$/gm,
    ),
  );
  if (
    backendProfile !== expectedProfile ||
    backendAccount !== expectedAccountId
  )
    throw new Error('Remote backend target differs from the reviewed runner');
  return { bucket: backendBucket, key: stateKeys[input.root] };
}

/** Terraform's state-pull failure is ambiguous on a new backend. This
 * read-only S3 check distinguishes a verified absent first-state object from
 * a failed read of an existing object. A bucket/permission failure still
 * fails closed. No state is created by this function. */
export async function readTerraformStateIdentity(input: {
  root: 'registry' | 'staging';
  backendText: string;
  expectedProfile: string;
  expectedAccountId: string;
  run: (binary: string, args: string[]) => Promise<string>;
  terraformBinary?: string;
  awsBinary?: string;
}) {
  const target = verifyTerraformBackendTarget(input);
  try {
    const state = z
      .object({
        lineage: z.string().uuid(),
        serial: z.number().int().nonnegative(),
      })
      .parse(
        JSON.parse(
          await input.run(input.terraformBinary ?? 'terraform', [
            'state',
            'pull',
          ]),
        ),
      );
    return { stateLineage: state.lineage, stateSerial: state.serial };
  } catch {
    let response: unknown;
    try {
      response = JSON.parse(
        await input.run(input.awsBinary ?? 'aws', [
          's3api',
          'list-objects-v2',
          '--bucket',
          target.bucket,
          '--prefix',
          target.key,
          '--max-keys',
          '2',
          '--expected-bucket-owner',
          input.expectedAccountId,
          '--profile',
          input.expectedProfile,
          '--region',
          'us-east-1',
          '--output',
          'json',
        ]),
      ) as unknown;
    } catch {
      throw new Error('Unable to verify remote Terraform state object');
    }
    const listing = z
      .object({
        Name: z.literal(target.bucket),
        Prefix: z.literal(target.key),
        IsTruncated: z.literal(false),
        KeyCount: z.literal(0),
        Contents: z.array(z.unknown()).max(0).optional(),
      })
      .safeParse(response);
    if (!listing.success)
      throw new Error('Remote state is not proven absent; refusing first plan');
    return { stateLineage: null, stateSerial: null };
  }
}
