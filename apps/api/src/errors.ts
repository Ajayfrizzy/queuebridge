import type { ZodError, ZodType } from 'zod';

/** Base URI for RFC 9457 `type` values. Not dereferenceable; identifies the problem class. */
const PROBLEM_BASE = 'https://queuebridge.dev/problems';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * An expected, client-safe failure. The global error handler renders it as an
 * RFC 9457 problem document. Messages must never include secrets, PII, or hints
 * about the existence of resources the caller cannot access.
 */
export class ApiProblem extends Error {
  public readonly status: number;
  public readonly slug: string;
  public readonly detail: string | undefined;
  public readonly errors: FieldError[] | undefined;
  public readonly headers: Record<string, string> | undefined;

  public constructor(
    status: number,
    slug: string,
    title: string,
    options: { detail?: string; errors?: FieldError[]; headers?: Record<string, string> } = {},
  ) {
    super(title);
    this.name = 'ApiProblem';
    this.status = status;
    this.slug = slug;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
  }

  public get type(): string {
    return `${PROBLEM_BASE}/${this.slug}`;
  }
}

export const problems = {
  validation: (errors: FieldError[]): ApiProblem =>
    new ApiProblem(400, 'validation-error', 'Request validation failed', {
      detail: 'One or more fields are invalid.',
      errors,
    }),
  unauthenticated: (): ApiProblem =>
    new ApiProblem(401, 'unauthenticated', 'Authentication required', {
      detail: 'Sign in to continue.',
    }),
  invalidCredentials: (): ApiProblem =>
    new ApiProblem(401, 'invalid-credentials', 'Invalid credentials', {
      detail: 'The organization, email or password is incorrect.',
    }),
  forbidden: (): ApiProblem =>
    new ApiProblem(403, 'forbidden', 'Forbidden', {
      detail: 'Your role does not permit this action.',
    }),
  csrf: (): ApiProblem =>
    new ApiProblem(403, 'csrf-rejected', 'Request rejected', {
      detail: 'Missing or invalid cross-site request protection header.',
    }),
  notFound: (): ApiProblem => new ApiProblem(404, 'not-found', 'Not found'),
  conflict: (detail: string): ApiProblem => new ApiProblem(409, 'conflict', 'Conflict', { detail }),
  invalidInvitation: (): ApiProblem =>
    new ApiProblem(410, 'invitation-unavailable', 'Invitation unavailable', {
      detail: 'This invitation is invalid, expired, or already used.',
    }),
};

/** Parse untrusted input with a Zod schema; throws a 400 problem listing field paths only. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw problems.validation(zodToFieldErrors(result.error));
  }
  return result.data;
}

export function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
    message: issue.message,
  }));
}

/** True for PostgreSQL unique_violation (23505), optionally for a specific constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  if (e.code !== '23505') return false;
  return constraint === undefined || e.constraint_name === constraint;
}
