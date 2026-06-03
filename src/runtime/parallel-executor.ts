/**
 * parallel-executor.ts — Multi-session parallel task execution.
 *
 * Spawns up to OMNI_MAX_PARALLEL browser sessions simultaneously,
 * runs a directive in each, and collects results. Used for batch research,
 * competitive analysis, or any task where N items can be done in parallel.
 *
 * New command: { type: "parallel", tasks: string[], max_concurrency?: number }
 * Returns: { ok: true, results: [{ task, sessionId, summary, elapsed_ms }] }
 *
 * Each task spawns its own session via the service's createSession().
 * Sessions are closed automatically after each task completes.
 */

import { getOmniStandaloneService } from "../server/service.js";
import type { OmniStandaloneService } from "../server/service.js";

export interface ParallelTask {
  directive: string;
  objective?: string;
}

export interface ParallelTaskResult {
  directive: string;
  elapsed_ms: number;
  ok: boolean;
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface ParallelResult {
  ok: boolean;
  completedTasks: number;
  failedTasks: number;
  results: ParallelTaskResult[];
  total_elapsed_ms: number;
}

const MAX_PARALLEL_CAP = 10;
const DEFAULT_MAX_PARALLEL = 5;

export async function runParallelTasks(
  tasks: ParallelTask[],
  maxConcurrency: number,
  parentOrgId: string,
  parentUserId: string,
  creditBudgetPerTask: number,
): Promise<ParallelResult> {
  const service = getOmniStandaloneService() as OmniStandaloneService;
  const concurrency = Math.min(Math.max(maxConcurrency, 1), MAX_PARALLEL_CAP);
  const startTime = Date.now();
  const results: ParallelTaskResult[] = [];

  // Process tasks in batches of `concurrency`
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((task) => runSingleParallelTask(service, task, parentOrgId, parentUserId, creditBudgetPerTask)),
    );
    results.push(...batchResults);
  }

  const completedTasks = results.filter((r) => r.ok).length;
  const failedTasks = results.length - completedTasks;

  return {
    ok: failedTasks === 0,
    completedTasks,
    failedTasks,
    results,
    total_elapsed_ms: Date.now() - startTime,
  };
}

async function runSingleParallelTask(
  service: OmniStandaloneService,
  task: ParallelTask,
  orgId: string,
  userId: string,
  creditBudget: number,
): Promise<ParallelTaskResult> {
  const taskStart = Date.now();
  let sessionId: string | undefined;

  try {
    // Create a child session for this task
    const record = await service.createSession({
      agentId: userId,
      creditBudget,
      objective: task.objective ?? task.directive,
      orgId,
      userId,
      persistent: false,
    });
    sessionId = record.sessionId as string;

    // Send the directive
    await service.executeCommand(
      sessionId,
      { type: "directive", message: task.directive },
      { ip: "127.0.0.1", userId, orgId },
    );

    // Get status/summary after a brief wait
    await new Promise<void>((r) => setTimeout(r, 2000));
    const status = await service.executeCommand(
      sessionId,
      { type: "status" },
      { ip: "127.0.0.1", userId, orgId },
    ) as Record<string, unknown>;
    const summary = typeof status.objective === "string" ? status.objective : task.directive.slice(0, 100);

    return { directive: task.directive, elapsed_ms: Date.now() - taskStart, ok: true, sessionId, summary };
  } catch (err) {
    return {
      directive: task.directive,
      elapsed_ms: Date.now() - taskStart,
      ok: false,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always close the child session to free resources
    if (sessionId) {
      try {
        await service.executeCommand(sessionId, { type: "close", reason: "parallel_task_complete" }, { ip: "127.0.0.1", userId, orgId });
      } catch {
        // best effort
      }
    }
  }
}

export function defaultMaxParallel(): number {
  const env = Number(process.env.OMNI_MAX_PARALLEL);
  return Number.isFinite(env) && env > 0 ? Math.min(env, MAX_PARALLEL_CAP) : DEFAULT_MAX_PARALLEL;
}
