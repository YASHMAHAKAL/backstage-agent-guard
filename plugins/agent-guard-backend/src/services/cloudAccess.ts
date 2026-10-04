import {
  AuthService,
  BackstageCredentials,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { reviewerGroupsForPolicy } from '../cloudReviewPolicy';

export type CloudViewer = { ref: string; groups: string[] };

export async function getCloudViewer(
  options: {
    auth: AuthService;
    userInfo: UserInfoService;
    catalog: typeof catalogServiceRef.T;
  },
  credentials: BackstageCredentials,
): Promise<CloudViewer> {
  if (
    !options.auth.isPrincipal(credentials, 'user') ||
    credentials.principal.userEntityRef === 'user:default/guest'
  )
    throw new NotAllowedError('Cloud requests require a mapped non-guest user');

  const ref = credentials.principal.userEntityRef;
  const info = await options.userInfo.getUserInfo(credentials);
  const entity = await options.catalog.getEntityByRef(ref, { credentials });
  if (!entity || entity.kind !== 'User')
    throw new NotAllowedError('Cloud user is not mapped in the catalog');

  // Require both authenticated ownership claims and current catalog relations.
  const memberships = (entity.relations ?? [])
    .filter(relation => relation.type === 'memberOf')
    .map(relation => relation.targetRef);
  return {
    ref,
    groups: info.ownershipEntityRefs.filter(group =>
      memberships.includes(group),
    ),
  };
}

export function canViewCloudProposal(
  record: {
    requester: string;
    snapshot: { envelope: { policyVersion: string } };
  },
  viewer: CloudViewer,
): boolean {
  return (
    record.requester === viewer.ref ||
    reviewerGroupsForPolicy(record.snapshot.envelope.policyVersion).some(
      group => viewer.groups.includes(group),
    )
  );
}
