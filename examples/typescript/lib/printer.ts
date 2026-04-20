/**
 * Framework-agnostic pretty-printing of agent tool traces.
 *
 * Each framework exposes a different shape for tool calls and results; the
 * adapter living in each agent file is responsible for normalising to the
 * `ToolCallRecord[]` interface below, after which the printer can render the
 * trace uniformly across frameworks.
 */

export interface ToolCallRecord {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

const NOISY_ARG_KEYS = new Set<string>(['wallet_uuid', 'wallet_id', '__mastraMetadata']);

/** Clamp any value's string representation to `limit` characters with an ellipsis. */
export function truncate(value: unknown, limit = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…';
}

/** Formats a tool call's arguments as `k=v` pairs, skipping wallet identifiers. */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '-';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (NOISY_ARG_KEYS.has(k)) continue;
    parts.push(`${k}=${truncate(v, 80)}`);
  }
  return parts.join(', ') || '-';
}

/**
 * Compresses a tool result (object or JSON-encoded string) into a one-line
 * summary tailored to each known CAW response shape.
 */
export function summariseToolResult(raw: unknown): string {
  if (raw === undefined || raw === null) return '(no result)';

  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return truncate(raw.replace(/\n/g, ' '));
    }
  }
  if (!payload || typeof payload !== 'object') return truncate(payload);

  const p = payload as Record<string, unknown>;

  // submit_pact result envelope
  if ('pact_id' in p && 'status' in p && !('request_id' in p) && !('spec' in p)) {
    return `pact_id=${truncate(p.pact_id, 36)} status=${p.status}`;
  }
  // get_pact result — full pact record (contains id + spec)
  if ('id' in p && 'status' in p && 'spec' in p) {
    return (
      `pact_id=${truncate(p.id, 36)} status=${p.status} ` +
      `api_key=${p.api_key ? 'present' : 'null'}`
    );
  }
  // transfer / record result
  if ('request_id' in p) {
    const bits: string[] = [`request_id=${truncate(p.request_id, 36)}`];
    if (p.status_display) bits.push(`status=${p.status_display}`);
    else if ('status' in p) bits.push(`status=${p.status}`);
    if (p.transaction_hash) bits.push(`hash=${p.transaction_hash}`);
    return bits.join(' ');
  }
  // estimate-fee result
  if ('fee' in p || 'gas_price' in p || 'estimated_fee' in p) {
    return `fee=${truncate(p.fee ?? p.estimated_fee ?? p.gas_price)}`;
  }
  // audit-logs wrapper from `listRecentAuditLogs`
  if ('items' in p && Array.isArray(p.items) && 'allowed' in p && 'denied' in p) {
    return `audit entries=${p.items.length} allowed=${p.allowed} denied=${p.denied}`;
  }
  // raw audit-logs page
  if ('items' in p && Array.isArray(p.items)) {
    const items = p.items as { result?: string }[];
    const allowed = items.filter(it => it.result === 'allowed').length;
    const denied = items.filter(it => it.result === 'denied').length;
    return `audit entries=${items.length} allowed=${allowed} denied=${denied}`;
  }
  // policy-denial envelope from `returnPolicyDenial`
  if ('error' in p) {
    const err = p.error;
    if (err && typeof err === 'object') {
      const e = err as { code?: string; reason?: string; message?: string };
      const code = e.code ?? '-';
      const reason = e.reason ?? e.message ?? '-';
      const sug = p.suggestion ? ` suggestion=${truncate(p.suggestion, 80)}` : '';
      // When the server returns a truthy-but-empty error envelope (e.g.
      // partial denial response during pact activation races), fall back to
      // dumping whatever fields we got so the log stays debuggable.
      if (code === '-' && reason === '-') {
        return `DENIED raw=${truncate(err, 100)}${sug}`;
      }
      return `DENIED code=${code} reason=${reason}${sug}`;
    }
    return `ERROR ${err}`;
  }
  return truncate(p);
}

/** Prints a numbered list of tool calls with arguments and one-line results. */
export function printToolCalls(records: ToolCallRecord[]): void {
  console.log('\nTool calls:');
  if (records.length === 0) {
    console.log('  (none)');
    return;
  }
  records.forEach((call, idx) => {
    console.log(`  ${idx + 1}. ${call.name}(${formatToolArgs(call.args)})`);
    console.log(`     → ${summariseToolResult(call.result)}`);
  });
}

/** Prints the agent's final answer under a `Final answer:` header. */
export function printFinalAnswer(text: string | undefined): void {
  console.log('\nFinal answer:');
  console.log(text || '(no final answer produced)');
}
