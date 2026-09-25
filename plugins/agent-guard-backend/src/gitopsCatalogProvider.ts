import {
  LoggerService,
  SchedulerService,
  UrlReaderService,
} from '@backstage/backend-plugin-api';
import {
  EntityProvider,
  EntityProviderConnection,
  parseEntityYaml,
} from '@backstage/plugin-catalog-node';

const serviceNamePattern = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Discovers only merged staging descriptors in the platform-owned GitOps repo. */
export class GitopsCatalogProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  private readonly searchUrl: string;
  private readonly descriptorPattern: RegExp;

  constructor(
    private readonly options: {
      owner: string;
      repo: string;
      reader: UrlReaderService;
      scheduler: SchedulerService;
      logger: LoggerService;
    },
  ) {
    const { owner, repo } = options;
    this.searchUrl = `https://github.com/${owner}/${repo}/blob/main/apps/staging/*/catalog-info.yaml`;
    this.descriptorPattern = new RegExp(
      `^https://github\\.com/${owner}/${repo}/blob/main/apps/staging/([^/]+)/catalog-info\\.yaml$`,
    );
  }

  getProviderName(): string {
    return `agent-guard-gitops:${this.options.owner}/${this.options.repo}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.options.scheduler.scheduleTask({
      id: 'discover-merged-gitops-components',
      frequency: { minutes: 1 },
      timeout: { minutes: 1 },
      fn: async () => this.refresh(),
    });
  }

  async refresh(): Promise<void> {
    if (!this.connection) {
      throw new Error('GitOps Catalog provider is not connected');
    }

    // Search uses the GitHub integration's server-side credentials. A failed
    // search must leave the previous Catalog locations intact.
    const result = await this.options.reader.search(this.searchUrl);
    const entities = await Promise.all(
      result.files.map(async file => {
        const match = this.descriptorPattern.exec(file.url);
        if (!match || !serviceNamePattern.test(match[1])) {
          return undefined;
        }
        const location = { type: 'url', target: file.url };
        const parsed = Array.from(
          parseEntityYaml(await file.content(), location),
        );
        const descriptor = parsed.length === 1 ? parsed[0] : undefined;
        if (
          descriptor?.type !== 'entity' ||
          descriptor.entity.kind !== 'Component' ||
          descriptor.entity.metadata.name !== match[1] ||
          descriptor.entity.metadata.annotations?.[
            'backstage.io/kubernetes-id'
          ] !== match[1] ||
          descriptor.entity.spec?.lifecycle !== 'staging'
        ) {
          this.options.logger.warn(
            'Ignoring invalid GitOps Catalog descriptor',
            {
              serviceName: match[1],
            },
          );
          return undefined;
        }
        // Older merged descriptors predate the namespace annotation. This
        // provider is platform-owned and accepts only the fixed staging path,
        // so normalizing that annotation lets the namespace-scoped reader
        // query them without granting cluster-wide access.
        return {
          entity: {
            ...descriptor.entity,
            metadata: {
              ...descriptor.entity.metadata,
              annotations: {
                ...descriptor.entity.metadata.annotations,
                'backstage.io/kubernetes-namespace': 'staging',
                // Entity providers must set their managed locations when
                // emitting entities directly rather than Location entities.
                // Catalog location references are typed; a bare HTTPS URL is
                // not a valid location reference.
                'backstage.io/managed-by-location': `url:${file.url}`,
                'backstage.io/managed-by-origin-location': `url:${file.url}`,
              },
            },
          },
          locationKey: file.url,
        };
      }),
    );
    const accepted = entities.filter(entity => entity !== undefined);
    await this.connection.applyMutation({ type: 'full', entities: accepted });
    this.options.logger.info('Discovered merged GitOps Catalog descriptors', {
      count: accepted.length,
    });
  }
}
