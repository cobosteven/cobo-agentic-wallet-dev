/**
 * Error classification helpers for the CAW service.
 *
 * The service returns denials (policy, rate-limit, etc.) as structured
 * `{ error, suggestion }` payloads on non-2xx responses. Agent tools should
 * surface those payloads back to the LLM so it can self-correct, rather than
 * letting the exception bubble up and abort the agent loop.
 */

/** Structured payload returned to an LLM when a tool is denied by policy. */
export interface DenialEnvelope {
  error: Record<string, unknown> | string;
  suggestion?: string;
}

interface RawApiErrorShape {
  response?: {
    status?: number;
    data?: {
      error?: Record<string, unknown>;
      suggestion?: string;
    };
  };
}

/**
 * Parses an axios-style API error into a `{ http, error, suggestion }` shape.
 * Safe to call on any unknown value.
 */
export function parseApiError(err: unknown): {
  http: number | '-';
  error?: Record<string, unknown>;
  suggestion?: string;
} {
  const response = (err as RawApiErrorShape | null | undefined)?.response;
  return {
    http: response?.status ?? '-',
    error: response?.data?.error,
    suggestion: response?.data?.suggestion,
  };
}

/**
 * Runs `work`; on API failure returns a `DenialEnvelope` suitable to hand back
 * to the agent so it can self-correct instead of propagating the exception.
 */
export async function returnPolicyDenial<T>(
  work: () => Promise<T>,
): Promise<T | DenialEnvelope> {
  try {
    return await work();
  } catch (err) {
    const { error, suggestion } = parseApiError(err);
    if (error) {
      return { error, suggestion };
    }
    return { error: 'UNKNOWN_ERROR' };
  }
}
