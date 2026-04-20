/**
 * Shared prompt strings so that all three agent examples send the LLM the
 * same task. This also makes it trivial to tweak the demo scenario in one
 * place and see the effect across every framework.
 */

import type { DemoEnv } from './env';
import { CHAIN_ID, TOKEN_ID } from './pact-spec';

/** System prompt given to every agent in the demos. */
export const DEMO_SYSTEM_PROMPT =
  'Submit a pact before execution, wait until it is active, execute compliant ' +
  'blockchain actions, and if a tool returns policy denial guidance then retry ' +
  'inside the allowed boundary.';

/**
 * Standard demo task: submit a pact, perform a compliant transfer, deliberately
 * trigger a denial, then retry with a compliant amount.
 */
export function buildDemoPrompt(env: DemoEnv): string {
  return (
    `Use wallet ${env.walletId}. ` +
    `Submit a pact for a controlled transfer task and wait until it is active. ` +
    `Using the newly created pact, transfer 0.001 ${TOKEN_ID} to ${env.destination} on ${CHAIN_ID}. ` +
    `Next, using the same pact, attempt 0.005 ${TOKEN_ID}. If denied, follow the denial ` +
    `guidance and retry with a compliant amount. ` +
    `Track the result by request_id and summarize what happened.`
  );
}
