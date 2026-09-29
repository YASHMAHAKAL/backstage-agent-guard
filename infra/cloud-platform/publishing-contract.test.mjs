import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const yaml = createRequire(import.meta.url)('yaml');
const checkout = process.env.RIZZ_APP_CHECKOUT;
test(
  'source publisher is opt-in, commit-pinned, scanned before AWS and never deploys',
  { skip: !checkout },
  () => {
    const workflow = yaml.parse(
      readFileSync(resolve(checkout, '.github/workflows/publish.yml'), 'utf8'),
    );
    assert.deepEqual(workflow.on.push.branches, ['master']);
    assert.ok(!workflow.on.pull_request && !workflow.on.workflow_run);
    const job = workflow.jobs.publish;
    assert.ok(
      job.if.includes("RIZZ_ECR_PUBLISH_ENABLED == 'true'") &&
        job.if.includes('refs/heads/master'),
    );
    assert.deepEqual(job.permissions, {
      contents: 'read',
      'id-token': 'write',
    });
    assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
    assert.equal(job.steps[0].with['persist-credentials'], false);
    const steps = job.steps.map(s => s.name);
    assert.ok(
      steps.indexOf('Scan both local images (fail on HIGH or CRITICAL)') <
        steps.indexOf('Obtain ECR-only OIDC session'),
    );
    assert.ok(
      steps.indexOf('Push scanned images and create release record') <
        steps.indexOf('Upload paired release record'),
    );
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.run) {
        assert.doesNotMatch(
          step.run,
          /terraform|kubectl|aws\s+eks|argocd\s+(sync|app)/,
        );
        assert.equal(
          spawnSync('bash', ['-n'], {
            input: step.run,
            encoding: 'utf8',
            timeout: 5000,
          }).status,
          0,
        );
      }
    }
    const artifact = job.steps.find(
      s => s.name === 'Upload paired release record',
    );
    assert.equal(artifact.with.path, 'release.json');
    assert.equal(artifact.with['retention-days'], 30);
    assert.equal(artifact.with.overwrite, false);
    assert.equal(artifact.with.archive, true);
    assert.equal(artifact.if, undefined); // Never upload a release from always()/failure().
  },
);
