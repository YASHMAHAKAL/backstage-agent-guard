import {
  AuthorizeResult,
  PolicyDecision,
  isPermission,
} from '@backstage/plugin-permission-common';
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
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';

export class AgentGuardPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    // Ordinary users cannot start tasks, inline dry-runs, or actions through
    // Scaffolder UI/REST. Agent Guard uses a backend service principal for the
    // approved handoff; its publisher separately checks the live snapshot,
    // task-bound claim, and rendered file hashes before any GitOps write.
    if (
      isPermission(request.permission, taskCreatePermission) ||
      isPermission(request.permission, taskCancelPermission) ||
      isPermission(request.permission, templateDryRunPermission) ||
      isPermission(request.permission, actionExecutePermission)
    ) {
      return { result: AuthorizeResult.DENY };
    }
    if (isPermission(request.permission, taskReadPermission)) {
      const userEntityRef = user?.info.userEntityRef;
      if (!userEntityRef) {
        return { result: AuthorizeResult.DENY };
      }
      // Scaffolder task reads are resource permissions: a blanket ALLOW for
      // an unscoped list request is rejected by Backstage. Ordinary users may
      // only see tasks attributed to themselves, never Agent Guard's
      // service-created approval tasks or another user's task/logs.
      return createScaffolderTaskConditionalDecision(
        request.permission,
        scaffolderTaskConditions.isTaskOwner({ createdBy: [userEntityRef] }),
      );
    }
    return { result: AuthorizeResult.ALLOW };
  }
}
