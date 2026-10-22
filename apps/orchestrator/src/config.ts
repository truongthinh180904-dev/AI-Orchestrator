import { loadEnv, type Env } from '@ai-orchestrator/shared';

export function getOrchestratorConfig(): Env {
  return loadEnv();
}

export { loadEnv, type Env };
