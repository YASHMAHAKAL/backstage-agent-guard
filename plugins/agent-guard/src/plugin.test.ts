import { agentGuardPlugin } from './plugin';

describe('agent-guard', () => {
  it('should export plugin', () => {
    expect(agentGuardPlugin).toBeDefined();
  });
});
