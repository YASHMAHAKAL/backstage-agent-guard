import {
  mockCredentials,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { permissionsServiceFactory } from '@backstage/backend-defaults/permissions';
import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import permissionPlugin from '@backstage/plugin-permission-backend';
import scaffolderPlugin from '@backstage/plugin-scaffolder-backend';
import request from 'supertest';
import { permissionModuleAgentGuard } from './module';

const template = {
  apiVersion: 'scaffolder.backstage.io/v1beta3',
  kind: 'Template',
  metadata: { name: 'nodejs-api' },
  spec: {
    owner: 'group:default/platform-team',
    type: 'service',
    parameters: [],
    steps: [],
  },
};

// Backstage's mock auth service drops the actor on a user token forwarded
// between plugins. The permission backend rejects actorless resource queries
// before our task-read policy can handle them, so preserve the service actor
// here to exercise the same route/policy path as the running app.
const actingAuthFactory = createServiceFactory({
  service: coreServices.auth,
  deps: { plugin: coreServices.pluginMetadata },
  factory({ plugin }) {
    const auth = mockServices.auth({ pluginId: plugin.getId() });
    const original = auth.getPluginRequestToken.bind(auth);
    auth.getPluginRequestToken = async options => {
      if (
        options.targetPluginId === 'permission' &&
        auth.isPrincipal(options.onBehalfOf, 'user')
      ) {
        return {
          token: mockCredentials.user.token(
            options.onBehalfOf.principal.userEntityRef,
            { actor: { subject: `plugin:${plugin.getId()}` } },
          ),
        };
      }
      return original(options);
    };
    return auth;
  },
});

function startBackend() {
  // The publisher and GitHub integration are intentionally absent: these
  // tests exercise only local Scaffolder tasks and permission decisions.
  return startTestBackend({
    features: [
      mockServices.rootConfig.factory({
        data: { permission: { enabled: true } },
      }),
      actingAuthFactory,
      permissionsServiceFactory,
      catalogServiceMock.factory({ entities: [template] }),
      scaffolderPlugin,
      permissionPlugin,
      permissionModuleAgentGuard,
    ],
  });
}

describe('Scaffolder HTTP bypass protection', () => {
  it.each(['user:default/yashmahakal', 'user:default/mystic-koragg'])(
    'denies direct task and dry-run requests from %s',
    async userRef => {
      const backend = await startBackend();
      try {
        const authorization = mockCredentials.user.header(userRef);

        // Confirm the Scaffolder HTTP routes are mounted before probing writes.
        await request(backend.server)
          .get('/api/scaffolder/v2/actions')
          .set('Authorization', authorization)
          .expect(200);

        await request(backend.server)
          .get('/api/scaffolder/v2/tasks')
          .set('Authorization', authorization)
          .expect(response => {
            if (response.status !== 200) {
              throw new Error(
                `Expected 200, got ${response.status}: ${JSON.stringify(
                  response.body,
                )}`,
              );
            }
          })
          .expect(response => expect(response.body.totalTasks).toBe(0));

        await request(backend.server)
          .get('/api/scaffolder/v2/tasks')
          .set('Authorization', mockCredentials.service.header())
          .expect(200)
          .expect(response => expect(response.body.totalTasks).toBe(0));

        await request(backend.server)
          .post('/api/scaffolder/v2/tasks')
          .set('Authorization', authorization)
          .send({
            templateRef: 'template:default/nodejs-api',
            values: {
              serviceName: 'bypass-check-api',
              requestedOwner: 'group:default/payments-team',
              environment: 'staging',
              description: 'Must not create a task',
            },
          })
          .expect(403)
          .expect(response =>
            expect(response.body.error.name).toBe('NotAllowedError'),
          );

        await request(backend.server)
          .post('/api/scaffolder/v2/dry-run')
          .set('Authorization', authorization)
          .send({ template, values: {}, directoryContents: [] })
          .expect(403)
          .expect(response =>
            expect(response.body.error.name).toBe('NotAllowedError'),
          );

        await request(backend.server)
          .get('/api/scaffolder/v2/tasks')
          .set('Authorization', authorization)
          .expect(200)
          .expect(response => expect(response.body.totalTasks).toBe(0));

        await request(backend.server)
          .get('/api/scaffolder/v2/tasks')
          .set('Authorization', mockCredentials.service.header())
          .expect(200)
          .expect(response => expect(response.body.totalTasks).toBe(0));
      } finally {
        await backend.stop();
      }
    },
  );

  it('hides a service-created task from browser users but not the service', async () => {
    const backend = await startBackend();
    try {
      const serviceAuthorization = mockCredentials.service.header();
      const created = await request(backend.server)
        .post('/api/scaffolder/v2/tasks')
        .set('Authorization', serviceAuthorization)
        .send({ templateRef: 'template:default/nodejs-api', values: {} })
        .expect(201);
      const taskId = created.body.id;
      expect(taskId).toEqual(expect.any(String));

      await request(backend.server)
        .get('/api/scaffolder/v2/tasks')
        .set('Authorization', serviceAuthorization)
        .expect(200)
        .expect(response => expect(response.body.totalTasks).toBe(1));

      const userAuthorization = mockCredentials.user.header(
        'user:default/yashmahakal',
      );
      await request(backend.server)
        .get('/api/scaffolder/v2/tasks')
        .set('Authorization', userAuthorization)
        .expect(200)
        .expect(response => expect(response.body.totalTasks).toBe(0));
      await request(backend.server)
        .get(`/api/scaffolder/v2/tasks/${encodeURIComponent(taskId)}`)
        .set('Authorization', userAuthorization)
        .expect(403);
      await request(backend.server)
        .post(`/api/scaffolder/v2/tasks/${encodeURIComponent(taskId)}/cancel`)
        .set('Authorization', userAuthorization)
        .expect(403);
    } finally {
      await backend.stop();
    }
  });
});
