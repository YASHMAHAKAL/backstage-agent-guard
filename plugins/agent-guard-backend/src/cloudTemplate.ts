import { canonicalize } from './snapshot';
import { JsonObject } from '@backstage/types';

export const cloudTemplateSpec = {
  owner: 'group:default/platform-team',
  type: 'service',
  parameters: [],
  steps: [
    {
      id: 'publish',
      name: 'Publish the approved Rizz.AI snapshot',
      action: 'agent-guard:publish-rizz-cloud-pr',
    },
  ],
  output: {
    links: [
      {
        title: 'Reviewed draft GitOps PR',
        url: '${{ steps.publish.output.pullRequestUrl }}',
      },
    ],
  },
};
export function cloudTemplateMatches(
  entity:
    | {
        apiVersion: string;
        kind: string;
        metadata: {
          name: string;
          namespace?: string;
          annotations?: Record<string, string>;
        };
        spec?: JsonObject;
      }
    | undefined,
) {
  return (
    !!entity &&
    entity.apiVersion === 'scaffolder.backstage.io/v1beta3' &&
    entity.kind === 'Template' &&
    entity.metadata.name === 'deploy-rizz-ai' &&
    (entity.metadata.namespace ?? 'default') === 'default' &&
    entity.metadata.annotations?.['agent-guard.backstage.io/recipe-version'] ===
      'rizz-paired-v1-restricted-alb' &&
    canonicalize(JSON.parse(JSON.stringify(entity.spec ?? {}))) ===
      canonicalize(cloudTemplateSpec)
  );
}
