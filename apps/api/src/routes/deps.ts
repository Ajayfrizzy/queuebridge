import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { Env } from '../env.js';
import { problems } from '../errors.js';

export interface RouteDeps {
  db: Db;
  env: Env;
  /** preHandler: validates the session cookie and populates `req.auth`, or throws 401. */
  authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const uuid = z.string().uuid();

/**
 * Validate a path parameter as a UUID. Malformed identifiers produce the same 404 as
 * unknown ones so that probing reveals nothing.
 */
export function uuidParam(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw problems.notFound();
  return parsed.data;
}
