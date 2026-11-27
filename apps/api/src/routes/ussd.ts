import type { FastifyInstance } from 'fastify';
import { SANDBOX_PREFIX, USSD_WEBHOOK_HEADERS } from '@queuebridge/channels';
import { FacilityUssdSettingsUpdateSchema, type UssdResponse } from '@queuebridge/contracts';
import { requireFacilityPermission } from '../auth/rbac.js';
import { requireAuth } from '../auth/session.js';
import { ApiProblem, parseInput, problems } from '../errors.js';
import { createUssdApplication } from '../ussd/application.js';
import {
  UssdGate,
  facilityUssdSettings,
  handleUssdStep,
  updateFacilityUssdSettings,
  ussdAdapterFor,
  ussdDeployment,
  ussdMonitoring,
} from '../ussd/service.js';
import { uuidParam, type RouteDeps } from './deps.js';

/**
 * M6.2 USSD routes (REQ-F12): the facility setting (API only; the channel screen is M6.3) and the
 * provider webhook. No route returns, logs or audits a phone number, a session id or an input.
 */
export async function ussdRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env, authenticate } = deps;
  const dep = ussdDeployment(env);
  const limited = {
    config: { rateLimit: { max: env.SMS_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  };
  /** GET /facilities/:id/ussd — the facility's USSD setting and access code (readers). */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/ussd',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_READ',
      );
      return reply.send({
        ussd: await facilityUssdSettings(db, dep, auth.organizationId, facility.id),
      });
    },
  );
  /** GET /facilities/:id/ussd/monitor — M6.3 session and join figures (OPERATIONS_VIEW). */
  app.get<{ Params: { id: string } }>(
    '/facilities/:id/ussd/monitor',
    { preHandler: authenticate },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'OPERATIONS_VIEW',
      );
      return reply.send({ monitor: await ussdMonitoring(db, auth.organizationId, facility.id) });
    },
  );
  /** PUT /facilities/:id/ussd — offer USSD at this facility or stop (administrators; audited). */
  app.put<{ Params: { id: string } }>(
    '/facilities/:id/ussd',
    { preHandler: authenticate, ...limited },
    async (req, reply) => {
      const auth = requireAuth(req);
      const facility = await requireFacilityPermission(
        db,
        auth,
        uuidParam(req.params.id),
        'FACILITY_CONFIGURE',
      );
      const body = parseInput(FacilityUssdSettingsUpdateSchema, req.body);
      await updateFacilityUssdSettings(db, {
        organizationId: auth.organizationId,
        facilityId: facility.id,
        actorId: auth.staffUserId,
        enabled: body.enabled,
        deploymentAvailable: dep.available,
      });
      return reply.send({
        ussd: await facilityUssdSettings(db, dep, auth.organizationId, facility.id),
      });
    },
  );
}

/**
 * POST /webhooks/ussd/:provider — one USSD step (REQ-F12.2, F12.3; security steering "Webhook
 * security"). Its own plugin, so the raw-body parser (the signature covers the exact bytes)
 * applies here only. No cookie or session is used; the CSRF hook exempts `/api/v1/webhooks/`.
 *
 * Order: provider must be the configured one (else 404) → structure (JSON body, the provider's
 * request shape, signature headers) → signature and timestamp window (401) → nonce, once per
 * provider (409) → the step. Failures after authentication still answer with a USSD screen, so the
 * subscriber is never left without a reply. Logs: provider, outcome codes and the source address
 * of rejections only.
 */
export async function ussdWebhookRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db, env } = deps;
  const dep = ussdDeployment(env);
  const adapter = dep.crypto
    ? ussdAdapterFor(
        dep,
        createUssdApplication({
          db,
          crypto: dep.crypto,
          recovery: deps.recovery,
          limits: { perSourcePerMinute: env.RECOVERY_RATE_LIMIT_MAX },
          joinsPerPhonePerHour: dep.joinsPerPhonePerHour,
        }),
      )
    : null;
  const gate = new UssdGate(2, 10_000);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { provider: string } }>(
    '/webhooks/ussd/:provider',
    {
      bodyLimit: 4 * 1024,
      config: { rateLimit: { max: env.USSD_WEBHOOK_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!adapter || req.params.provider !== adapter.provider) throw problems.notFound();
      const raw = typeof req.body === 'string' ? req.body : null;
      let payload: unknown;
      try {
        payload = raw === null ? undefined : JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      const headers: Record<string, string> = {};
      for (const h of Object.values(USSD_WEBHOOK_HEADERS)) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const request = payload === undefined ? null : adapter.parseUssdRequest(payload);
      if (raw === null || !request || Object.keys(headers).length !== 3) {
        throw new ApiProblem(400, 'ussd-webhook-malformed', 'Malformed USSD request');
      }
      if (!adapter.verifyWebhook(headers, raw)) {
        req.log.warn(
          { provider: adapter.provider, source: req.ip },
          'USSD webhook rejected: invalid signature',
        );
        throw new ApiProblem(401, 'ussd-webhook-signature', 'Invalid webhook signature');
      }
      const send = (r: UssdResponse, status = 200): unknown => {
        const out = adapter.renderUssdResponse(r);
        return reply.status(status).type(out.contentType).send(out.body);
      };
      const label = adapter.sandbox ? `${SANDBOX_PREFIX}\n` : '';
      const unavailable: UssdResponse = {
        action: 'END',
        message: `${label}QueueBridge is not available right now. Please try again later.`,
      };
      try {
        const fresh = await db<{ nonce: string }[]>`
          INSERT INTO sms_webhook_nonces (provider, nonce)
          VALUES (${`ussd:${adapter.provider}`}, ${headers[USSD_WEBHOOK_HEADERS.nonce] ?? ''})
          ON CONFLICT (provider, nonce) DO NOTHING
          RETURNING nonce`;
        if (fresh.length === 0) {
          req.log.warn(
            { provider: adapter.provider, source: req.ip },
            'USSD webhook rejected: replay',
          );
          throw new ApiProblem(409, 'ussd-webhook-replay', 'Webhook already received');
        }
        const result = await gate.run(
          () => handleUssdStep(db, dep, adapter, request),
          () => ({
            response: {
              action: 'END' as const,
              message: `${label}QueueBridge is busy. Please dial again in a moment.`,
            },
            outcome: 'busy' as const,
          }),
        );
        req.log.info(
          {
            provider: adapter.provider,
            sandbox: adapter.sandbox,
            outcome: result.outcome,
            action: result.response.action,
          },
          adapter.sandbox ? '[SANDBOX] USSD step' : 'USSD step',
        );
        return send(result.response);
      } catch (err) {
        if (err instanceof ApiProblem) throw err;
        // Database unreachable or any unexpected error: the step was not saved, so a retry runs
        // it again; a join that did commit is returned by its operation id, never repeated. The
        // subscriber still gets a screen. Logged: the error class only, never the request.
        req.log.error(
          { provider: adapter.provider, error: err instanceof Error ? err.name : 'unknown' },
          'USSD step failed',
        );
        return send(unavailable, 503);
      }
    },
  );
}
