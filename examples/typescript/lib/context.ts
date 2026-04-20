/**
 * `DemoContext` bundles everything a CAW agent demo needs after startup:
 * the parsed environment, the owner-scoped API clients, and a shared
 * `PactSessionStore`. Each agent example builds a context once via
 * `DemoContext.load()`, replacing roughly twenty lines of module-top
 * boilerplate and ensuring the three framework integrations behave
 * identically against the same inputs.
 */

import { buildOwnerApis, type OwnerApis } from './clients';
import { loadEnv, type DemoEnv } from './env';
import { PactSessionStore } from './pact-session';

export class DemoContext {
  readonly env: DemoEnv;
  readonly apis: OwnerApis;
  readonly sessions: PactSessionStore;

  private constructor(env: DemoEnv, apis: OwnerApis, sessions: PactSessionStore) {
    this.env = env;
    this.apis = apis;
    this.sessions = sessions;
  }

  /** Reads env vars, wires up API clients, and returns a ready-to-use context. */
  static load(): DemoContext {
    const env = loadEnv();
    const apis = buildOwnerApis(env);
    const sessions = new PactSessionStore(apis.txApi, env.basePath);
    return new DemoContext(env, apis, sessions);
  }

  /**
   * After `submit_pact`, auto-activated pacts may carry `status=active` but
   * omit `api_key` from the initial response. This helper fills the gap by
   * fetching the full pact record and capturing the scoped api_key so that
   * subsequent transfer tool calls can resolve `pact_id → TransactionsApi`.
   * Best-effort: on failure, the agent can still call `get_pact` explicitly.
   */
  async backfillPactSessionIfActive(result: unknown): Promise<void> {
    if (!result || typeof result !== 'object') return;
    const r = result as Record<string, unknown>;
    const id = (r.pact_id ?? r.id) as string | undefined;
    if (r.status !== 'active' || !id || this.sessions.has(id)) return;
    try {
      const full = (await this.apis.pactsApi.getPact(id)).data.result;
      this.sessions.capture(full);
    } catch {
      // best-effort
    }
  }
}
