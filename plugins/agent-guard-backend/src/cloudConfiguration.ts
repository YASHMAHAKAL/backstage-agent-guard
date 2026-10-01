import { Config } from '@backstage/config';
import { AuthenticatedCloudReaders } from './cloudReaders';
import { cloudTargetMetadataSchema } from './cloudTarget';
import { ReleaseCatalog } from './releases';
import { CloudServiceConfiguration } from './services/CloudProposalService';
import { CloudDeliveryObserver } from './cloudDelivery';
import { CloudRuntimeVerifier } from './cloudRuntime';
import { CloudMetricsObserver } from './cloudMetrics';

// Parsing/constructing this adapter makes NO provider calls. Disabled defaults
// require no AWS configuration and never repoint the existing Kind service.
export function createCloudConfiguration(
  config: Config,
  releases: ReleaseCatalog,
): CloudServiceConfiguration | undefined {
  if (!config.getOptionalBoolean('agentGuard.rizzCloud.enabled'))
    return undefined;
  if (!config.getOptionalBoolean('agentGuard.rizzReleases.enabled'))
    throw new Error(
      'Cloud governance requires the authenticated release source',
    );
  const c = config.getConfig('agentGuard.rizzCloud');
  const target = cloudTargetMetadataSchema.parse(c.get('target'));
  const source = config.getConfig('agentGuard.rizzReleases');
  if (
    source.getString('repository') !== target.sourceRepository ||
    (['frontend', 'backend'] as const).some(
      part =>
        source.getString(`${part}Repository`) !==
        `${target.accountId}.dkr.ecr.us-east-1.amazonaws.com/rizz-staging-${part}`,
    )
  )
    throw new Error('Release source and cloud target disagree');
  const readers = new AuthenticatedCloudReaders({
    awsProfile: c.getString('awsProfile'),
    githubToken: c.getString('githubToken'),
    requireMetadata: true,
  });
  const delivery = c.getOptionalBoolean('delivery.enabled')
    ? new CloudDeliveryObserver({
        readers,
        argoCdUrl: c.getString('delivery.argoCdUrl'),
        argoCdToken: c.getString('delivery.argoCdToken'),
        argoCdCaBase64: c.getOptionalString('delivery.argoCdCaBase64'),
        destinationServer: c.getString('delivery.destinationServer'),
        runtime: new CloudRuntimeVerifier({ readers }),
      })
    : undefined;
  return {
    target,
    releases,
    submitterGroups: c.getStringArray('submitterGroups'),
    readers,
    metrics: new CloudMetricsObserver({ readers }),
    ...(delivery ? { delivery } : {}),
  };
}
