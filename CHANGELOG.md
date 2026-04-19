# Changelog

## 0.1.19

- Update README with current CLI commands, DeFi recipes, and framework integrations
- Add Claude Code skill documentation (README, evals, run_evals.sh)
- Fix StandardResponse schema generation (`model_serializer` → `ConfigDict(exclude_none=True)`)

## 0.1.18

- Fix StandardResponse OpenAPI schema generation broken by `@model_serializer`
- Regenerate SDK with fixed schema

## 0.1.17

- Fix `service_auth_key` not propagated to API requests
- Add x402 payment models and wallet claim API
- Align CLI parameters with WalletAPIClient mixin signatures
- Add lint and test steps to build pipeline
- Fix stale e2e test fixtures (constraints → policies, principal_type → wallet_type)

## 0.1.0

- Initial release
- Async Python SDK generated from OpenAPI spec
- CLI (`caw`) for wallet, transaction, delegation, and policy management
- Framework integrations: LangChain, OpenAI Agents, Agno, CrewAI, MCP