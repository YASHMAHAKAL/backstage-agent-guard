import { mockCredentials } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  actionExecutePermission,
  taskCancelPermission,
  taskCreatePermission,
  taskReadPermission,
  templateDryRunPermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import {
  createScaffolderTaskConditionalDecision,
  scaffolderTaskConditions,
} from '@backstage/plugin-scaffolder-backend/alpha';
import { AgentGuardPolicy } from './AgentGuardPolicy';

describe('AgentGuardPolicy', () => {
  const policy = new AgentGuardPolicy();

  it.each([
    taskCreatePermission,
    taskCancelPermission,
    templateDryRunPermission,
    actionExecutePermission,
  ])('denies Scaffolder execution permission %s', async permission => {
    expect(await policy.handle({ permission })).toEqual({
      result: AuthorizeResult.DENY,
    });
  });

  it('scopes task and log reads to the task creator', async () => {
    const userEntityRef = 'user:default/yashmahakal';
    const decision = await policy.handle(
      { permission: taskReadPermission },
      {
        credentials: mockCredentials.user(userEntityRef),
        info: { userEntityRef, ownershipEntityRefs: [userEntityRef] },
      },
    );
    expect(decision).toEqual(
      createScaffolderTaskConditionalDecision(
        taskReadPermission,
        scaffolderTaskConditions.isTaskOwner({ createdBy: [userEntityRef] }),
      ),
    );
  });

  it('denies task reads without a user identity', async () => {
    expect(await policy.handle({ permission: taskReadPermission })).toEqual({
      result: AuthorizeResult.DENY,
    });
  });

  it('allows unrelated read permissions', async () => {
    const decision = await policy.handle({
      permission: {
        type: 'basic',
        name: 'test.read',
        attributes: { action: 'read' },
      },
    });
    expect(decision).toEqual({ result: AuthorizeResult.ALLOW });
  });
});
