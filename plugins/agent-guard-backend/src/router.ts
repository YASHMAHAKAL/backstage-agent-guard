import { HttpAuthService } from '@backstage/backend-plugin-api';
import express from 'express';
import Router from 'express-promise-router';
import { InputError, ServiceUnavailableError } from '@backstage/errors';
import { z } from 'zod/v3';
import { proposalDecisionSchema } from './domain';
import { ProposalService } from './services/ProposalService';
import { ReleaseCatalog } from './releases';
import { CloudProposalService } from './services/CloudProposalService';
import { TerraformControlService } from './services/TerraformControlService';

export function createRouter(options: {
  httpAuth: HttpAuthService;
  proposals: ProposalService;
  releases?: ReleaseCatalog;
  cloudProposals?: CloudProposalService;
  terraformControl?: TerraformControlService;
}): express.Router {
  const router = Router();
  // The internal sanitized Terraform plan summary can contain many resource
  // addresses. Schemas still bound its content; no raw plan JSON is accepted.
  router.use(express.json({ limit: '256kb' }));

  const cloud = () => {
    if (!options.cloudProposals)
      throw new ServiceUnavailableError(
        'Cloud release governance is not configured',
      );
    return options.cloudProposals;
  };
  const terraform = () => {
    if (!options.terraformControl)
      throw new ServiceUnavailableError(
        'Terraform request and plan review is not configured',
      );
    return options.terraformControl;
  };
  router.get('/rizz/terraform/capabilities', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    if (!options.terraformControl) {
      res.json({ state: 'disabled', executable: false });
      return;
    }
    await terraform().list(credentials);
    res.json({
      state: 'request_and_review',
      executable: false,
      capacityPublishing: terraform().capacityPublishingAvailable(),
    });
  });
  router.post('/rizz/terraform/requests', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await terraform().submit(req.body, credentials));
  });
  router.get('/rizz/terraform/requests', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await terraform().list(credentials) });
  });
  router.get('/rizz/terraform/requests/:id', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().get(req.params.id, credentials));
  });
  router.get(
    '/rizz/terraform/requests/:id/aws-observation',
    async (req, res) => {
      const credentials = await options.httpAuth.credentials(req, {
        allow: ['user'],
      });
      res.set('Cache-Control', 'no-store');
      res.json(await terraform().observe(req.params.id, credentials));
    },
  );
  router.post(
    '/rizz/terraform/requests/:id/configuration-pr',
    async (req, res) => {
      const credentials = await options.httpAuth.credentials(req, {
        allow: ['user'],
      });
      res.set('Cache-Control', 'no-store');
      res.json(await terraform().publishCapacity(req.params.id, credentials));
    },
  );
  router.post('/rizz/terraform/requests/:id/decision', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().decide(req.params.id, req.body, credentials));
  });
  router.post('/internal/rizz/terraform/plans', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await terraform().registerPlan(req.body));
  });
  router.post('/internal/rizz/terraform/request', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().runnerRequest(req.body));
  });
  router.post('/internal/rizz/terraform/receipt', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().approvedReceipt(req.body));
  });
  router.post('/internal/rizz/terraform/review-state', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().runnerReviewState(req.body));
  });
  router.post('/internal/rizz/terraform/outcome', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    res.set('Cache-Control', 'no-store');
    res.json(await terraform().reportRunnerOutcome(req.body));
  });
  router.get('/rizz/capabilities', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(
      options.cloudProposals
        ? await options.cloudProposals.capabilities(credentials)
        : { state: 'disabled', canSubmit: false },
    );
  });
  router.post('/rizz/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res
      .status(201)
      .json(await cloud().submit(req.body, credentials, 'backstage_rest'));
  });
  router.post('/rizz/runtime/preview', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().previewRuntime(req.body, credentials));
  });
  router.post('/rizz/runtime/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res
      .status(201)
      .json(
        await cloud().submitRuntime(req.body, credentials, 'backstage_rest'),
      );
  });
  router.post('/rizz/rollback/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res
      .status(201)
      .json(
        await cloud().submitRollback(req.body, credentials, 'backstage_rest'),
      );
  });
  router.post('/rizz/rollback/preview', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().previewRollback(req.body, credentials));
  });
  router.post('/rizz/retirement/preview', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().previewRetirement(req.body, credentials));
  });
  router.post('/rizz/retirement/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res
      .status(201)
      .json(
        await cloud().submitRetirement(req.body, credentials, 'backstage_rest'),
      );
  });
  router.get('/rizz/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await cloud().list(credentials) });
  });
  router.get('/rizz/verified-deployments', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json({ items: await cloud().listVerifiedDeployments(credentials) });
  });
  router.get('/rizz/readiness', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().readiness(credentials));
  });
  router.get('/rizz/metrics', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().metrics(credentials));
  });
  router.get('/rizz/proposals/:id', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().get(req.params.id, credentials));
  });
  router.get('/rizz/proposals/:id/delivery', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().observeDelivery(req.params.id, credentials));
  });
  router.get('/rizz/proposals/:id/retirement', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().observeRetirement(req.params.id, credentials));
  });
  router.post('/rizz/proposals/:id/decision', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().decide(req.params.id, req.body, credentials));
  });
  const cloudClaim = z
    .object({
      proposalId: z.string().uuid(),
      taskId: z.string().min(1).max(200),
      claim: z.string().min(40).max(100),
    })
    .strict();
  router.post('/internal/rizz/publish/reserve', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    const parsed = cloudClaim.safeParse(req.body);
    if (!parsed.success) throw new InputError('Invalid cloud publish claim');
    res.set('Cache-Control', 'no-store');
    res.json(await cloud().reservePublish(parsed.data));
  });
  router.post('/internal/rizz/publish/complete', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    const parsed = cloudClaim
      .extend({
        prUrl: z.string().url().max(500),
        prNumber: z.number().int().positive().safe(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      throw new InputError('Invalid cloud publish completion');
    await cloud().completePublish(parsed.data);
    res.status(204).end();
  });

  router.get('/rizz/releases', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['user'] });
    res.set('Cache-Control', 'no-store');
    res.json(await (options.releases ?? new ReleaseCatalog()).list());
  });

  router.post('/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    const record = await options.proposals.submit(
      req.body,
      credentials,
      'backstage_rest',
    );
    res.status(201).json(record);
  });

  router.get('/proposals', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.json({ items: await options.proposals.list(credentials) });
  });

  router.get('/proposals/:id', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.json(await options.proposals.get(req.params.id, credentials));
  });

  router.get('/proposals/:id/delivery', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    res.json(await options.proposals.getDelivery(req.params.id, credentials));
  });

  router.post('/proposals/:id/decision', async (req, res) => {
    const credentials = await options.httpAuth.credentials(req, {
      allow: ['user'],
    });
    const parsed = proposalDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.message);
    }
    res.json(
      await options.proposals.decide(req.params.id, parsed.data, credentials),
    );
  });

  const reserveSchema = z
    .object({
      proposalId: z.string().uuid(),
      taskId: z.string().min(1).max(200),
      claim: z.string().min(40).max(100),
      files: z
        .array(
          z
            .object({
              path: z.string().min(1).max(200),
              sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict();
  router.post('/internal/publish/reserve', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    const parsed = reserveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.message);
    }
    res.json(await options.proposals.reservePublish(parsed.data));
  });

  const completeSchema = z
    .object({
      proposalId: z.string().uuid(),
      taskId: z.string().min(1).max(200),
      claim: z.string().min(40).max(100),
      prUrl: z.string().url().max(500),
      prNumber: z.number().int().positive(),
    })
    .strict();
  router.post('/internal/publish/complete', async (req, res) => {
    await options.httpAuth.credentials(req, { allow: ['service'] });
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new InputError(parsed.error.message);
    }
    await options.proposals.completePublish(parsed.data);
    res.status(204).end();
  });

  return router;
}
