import { HttpAuthService } from '@backstage/backend-plugin-api';
import express from 'express';
import Router from 'express-promise-router';
import { InputError } from '@backstage/errors';
import { z } from 'zod/v3';
import { proposalDecisionSchema } from './domain';
import { ProposalService } from './services/ProposalService';

export function createRouter(options: {
  httpAuth: HttpAuthService;
  proposals: ProposalService;
}): express.Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));

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
