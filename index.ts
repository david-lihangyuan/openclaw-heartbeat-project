/**
 * Heartbeat Project Plugin v0.2.0
 *
 * Core: Turn heartbeat into a continuous project worker.
 * Aux: Reply to heartbeat messages to give feedback.
 *
 * Safe: no shell commands or dangerous code patterns.
 *
 * Hooks:
 * 1. before_prompt_build — inject tasks + pending replies into heartbeat prompt
 * 2. before_dispatch — intercept quoted replies to marked heartbeat messages
 *
 * Tool:
 * - heartbeat_task — create, update, complete, pause, resume, list tasks
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ==================== Configuration Defaults ====================

const DEFAULT_CONFIG = {
  marker: "[🩷]",
  markerOnlyForTasks: false,
  maxTasksInPrompt: 5,
  taskCooldownMinutes: 120,
  replyFilePath: ".heartbeat-project/pending-replies.json",
  tasksFilePath: ".heartbeat-project/heartbeat-tasks.json",
};

// ==================== Types ====================

interface Task {
  id: string;
  title: string;
  description: string;
  status: "active" | "paused" | "completed";
  priority: "high" | "medium" | "low";
  subtasks: string[];
  currentStep: number;
  currentObjective: string;
  nextAction: string;
  lastProgressNote: string;
  lastOutcome: string;
  lastError: string;
  errorCount: number;
  requiresApproval: boolean;
  awaitingUserDecision: boolean;
  createdAt: number;
  updatedAt: number;
  lastProgressAt?: number;
}

interface TaskStore {
  version: number;
  tasks: Task[];
}

interface PendingReply {
  id: string;
  createdAt: number;
  userMessage: string;
  quotedHeartbeat: string;
  taskId?: string;
}

interface ReplyStore {
  pendingReplies: PendingReply[];
}

type PluginConfig = {
  marker?: string;
  markerOnlyForTasks?: boolean;
  maxTasksInPrompt?: number;
  taskCooldownMinutes?: number;
  replyFilePath?: string;
  tasksFilePath?: string;
};

// ==================== Helpers ====================

/** Atomic write: write to temp file then rename */
function atomicWriteJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + crypto.randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Safe JSON read with graceful recovery */
function safeReadJSON<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Check if a session is a heartbeat session using multiple signals */
function isHeartbeatSession(sessionKey: string, ctx: any): boolean {
  // Primary: check session key pattern
  if (sessionKey.endsWith(":heartbeat")) return true;
  // Secondary: check if the session key contains heartbeat segment
  const parts = sessionKey.split(":");
  if (parts.includes("heartbeat")) return true;
  // Tertiary: check context hints
  if (ctx?.isHeartbeat === true) return true;
  return false;
}

/** Extract task ID from heartbeat message if present */
function extractTaskId(text: string, marker: string): string | undefined {
  // Pattern: [🩷][task-123456] or [🩷] [task-123456]
  const pattern = new RegExp(`\\${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\[(task-\\d+)\\]`);
  const match = text.match(pattern);
  return match?.[1];
}

// ==================== Plugin Entry ====================

export default definePluginEntry({
  id: "heartbeat-project",
  name: "Heartbeat Project",
  description: "Turn heartbeat into a continuous project worker. Manages long-running tasks across heartbeat sessions with reply-based feedback.",

  register(api) {
    const logger = api.logger;
    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
    const workspaceDir = api.config?.agents?.defaults?.workspace ?? process.cwd();

    // Merge config with defaults
    const config = { ...DEFAULT_CONFIG, ...pluginConfig };
    const marker = config.marker;

    const replyPath = path.join(workspaceDir, config.replyFilePath);
    const tasksPath = path.join(workspaceDir, config.tasksFilePath);
    const dataDir = path.dirname(replyPath);

    // Ensure data dir
    try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}

    logger.info(`heartbeat-project v0.2.0: registered (marker=${marker}, maxTasks=${config.maxTasksInPrompt})`);

    // ==================== Task Management ====================

    function loadTasks(): TaskStore {
      return safeReadJSON<TaskStore>(tasksPath, { version: 1, tasks: [] });
    }

    function saveTasks(store: TaskStore): void {
      atomicWriteJSON(tasksPath, store);
    }

    function getActiveTasks(): Task[] {
      return loadTasks().tasks
        .filter(t => t.status === "active")
        .sort((a, b) => {
          // Priority ordering: high > medium > low
          const prio = { high: 0, medium: 1, low: 2 };
          if (prio[a.priority] !== prio[b.priority]) return prio[a.priority] - prio[b.priority];
          // Then by most recently progressed
          return (b.lastProgressAt ?? 0) - (a.lastProgressAt ?? 0);
        });
    }

    function buildTaskPrompt(): string | null {
      const active = getActiveTasks();
      if (active.length === 0) return null;

      const cooldownMs = config.taskCooldownMinutes * 60 * 1000;
      const now = Date.now();

      // Separate hot and cold tasks
      const hot = active.filter(t => !t.lastProgressAt || (now - t.lastProgressAt) < cooldownMs);
      const cold = active.filter(t => t.lastProgressAt && (now - t.lastProgressAt) >= cooldownMs);

      // Only inject up to maxTasksInPrompt
      const toInject = hot.slice(0, config.maxTasksInPrompt);

      const lines: string[] = [];

      if (toInject.length > 0) {
        lines.push(`Active tasks (${toInject.length}${cold.length > 0 ? ` + ${cold.length} cooling` : ""}):\n`);

        for (const task of toInject) {
          const ago = task.lastProgressAt
            ? `${Math.round((now - task.lastProgressAt) / 60000)}min ago`
            : "not started";
          const prio = task.priority !== "medium" ? ` [${task.priority}]` : "";
          lines.push(`- **${task.title}**${prio} (${ago})`);
          if (task.currentObjective) lines.push(`  Objective: ${task.currentObjective}`);
          if (task.nextAction) lines.push(`  Next: ${task.nextAction}`);
          if (task.lastError) lines.push(`  ⚠️ Last error: ${task.lastError}`);
          if (task.awaitingUserDecision) lines.push(`  🔒 Awaiting user decision`);
          if (task.requiresApproval) lines.push(`  🔒 Requires approval before next step`);
          if (task.subtasks.length > 0) {
            const current = task.subtasks[task.currentStep] ?? "all steps done";
            lines.push(`  Step ${task.currentStep + 1}/${task.subtasks.length}: ${current}`);
          }
        }
        lines.push("");
        lines.push(`Work on at least one task. Report progress with ${marker}. Use heartbeat_task tool to update progress.`);
      }

      if (cold.length > 0) {
        lines.push(`\n${cold.length} task(s) cooling down (no progress for ${config.taskCooldownMinutes}+ min). Resume with heartbeat_task(action:"resume").`);
      }

      return lines.length > 0 ? lines.join("\n") : null;
    }

    // ==================== Reply Management ====================

    function loadReplies(): ReplyStore {
      return safeReadJSON<ReplyStore>(replyPath, { pendingReplies: [] });
    }

    function saveReplies(store: ReplyStore): void {
      atomicWriteJSON(replyPath, store);
    }

    function addPendingReply(userMessage: string, quotedHeartbeat: string, taskId?: string): void {
      const store = loadReplies();
      store.pendingReplies.push({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        userMessage,
        quotedHeartbeat: quotedHeartbeat.slice(0, 300),
        taskId,
      });
      saveReplies(store);
      logger.info("heartbeat-project: pending reply added");
    }

    function consumePendingReplies(): PendingReply[] {
      const store = loadReplies();
      if (store.pendingReplies.length === 0) return [];
      const replies = [...store.pendingReplies];
      store.pendingReplies = [];
      saveReplies(store);
      return replies;
    }

    // ==================== Hook 1: before_prompt_build ====================

    (api as any).on(
      "before_prompt_build",
      async (_event: any, ctx: any) => {
        const sessionKey = ctx?.sessionKey ?? "";
        if (!isHeartbeatSession(sessionKey, ctx)) return undefined;

        const parts: string[] = [];

        // Pending user replies take highest priority
        const replies = consumePendingReplies();
        if (replies.length > 0) {
          const replyBlock = replies.map(r => {
            let line = `User said: "${r.userMessage}"`;
            if (r.quotedHeartbeat) line += `\n  (replying to: "${r.quotedHeartbeat.slice(0, 100)}...")`;
            if (r.taskId) line += `\n  (regarding task: ${r.taskId})`;
            return line;
          }).join("\n\n");

          parts.push([
            `⚠️ HIGHEST PRIORITY: User replied to your heartbeat message (${replies.length} reply/replies).`,
            "Do NOT work on tasks. Respond to the user directly.",
            `Prefix your reply with ${marker}.`,
            "",
            replyBlock,
          ].join("\n"));
        }

        // Task management (only when no pending replies)
        if (replies.length === 0) {
          const taskPrompt = buildTaskPrompt();
          if (taskPrompt) parts.push(taskPrompt);
        }

        // Marker reminder
        if (!config.markerOnlyForTasks || getActiveTasks().length > 0) {
          parts.push(`Reminder: prefix heartbeat replies with ${marker}.`);
        }

        if (parts.length === 0) return undefined;

        logger.info("heartbeat-project: prompt injected", {
          pendingReplies: replies.length,
          activeTasks: getActiveTasks().length,
        });

        return { prependContext: parts.join("\n\n") };
      },
      { name: "heartbeat-project-prompt" },
    );

    // ==================== Hook 2: before_dispatch ====================

    (api as any).on(
      "before_dispatch",
      async (event: any, _ctx: any) => {
        const replyToBody: string | undefined = event?.replyToBody;
        const userMessage: string = event?.content ?? "";

        if (!replyToBody || !replyToBody.includes(marker)) return undefined;

        logger.info("heartbeat-project: reply intercepted");

        // Try to extract task ID from the quoted message
        const taskId = extractTaskId(replyToBody, marker);

        // Store as structured pending reply
        addPendingReply(userMessage, replyToBody, taskId);

        return {
          handled: true,
          text: `${marker} Got it — heartbeat will respond on its next tick.`,
        };
      },
      { name: "heartbeat-project-dispatch" },
    );

    // ==================== Tool: heartbeat_task ====================

    api.registerTool({
      name: "heartbeat_task",
      description: "Manage heartbeat project tasks. Create, update, complete, pause, resume, or list persistent tasks. Use update_progress to record what was done and what's next.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: ["create", "update_progress", "complete", "pause", "resume", "list", "set_priority", "request_approval"],
            description: "Action to perform",
          },
          task_id: { type: "string" as const, description: "Task ID (required for all actions except create and list)" },
          title: { type: "string" as const, description: "Task title (for create)" },
          description: { type: "string" as const, description: "Task description (for create)" },
          priority: { type: "string" as const, enum: ["high", "medium", "low"], description: "Task priority" },
          subtasks: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "List of subtask steps (for create)",
          },
          requires_approval: { type: "boolean" as const, description: "Whether task needs user approval before proceeding" },
          progress_note: { type: "string" as const, description: "What was done this step (for update_progress)" },
          outcome: { type: "string" as const, description: "Result of this step (for update_progress)" },
          next_action: { type: "string" as const, description: "What to do next (for update_progress)" },
          current_objective: { type: "string" as const, description: "Current objective (for update_progress)" },
          error: { type: "string" as const, description: "Error encountered (for update_progress)" },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const store = loadTasks();
        const action: string = params.action;

        if (action === "list") {
          if (store.tasks.length === 0) {
            return { content: [{ type: "text" as const, text: "No tasks." }] };
          }
          const summary = store.tasks.map(t => {
            const prio = t.priority !== "medium" ? ` [${t.priority}]` : "";
            const step = t.subtasks.length > 0 ? ` (step ${t.currentStep + 1}/${t.subtasks.length})` : "";
            const flags = [
              t.awaitingUserDecision ? "🔒awaiting-decision" : "",
              t.requiresApproval ? "🔒needs-approval" : "",
              t.lastError ? "⚠️has-error" : "",
            ].filter(Boolean).join(" ");
            return `[${t.status}]${prio} ${t.id}: ${t.title}${step} ${flags}`.trim();
          }).join("\n");
          return { content: [{ type: "text" as const, text: summary }] };
        }

        if (action === "create") {
          const id = `task-${Date.now()}`;
          const task: Task = {
            id,
            title: params.title ?? "Untitled task",
            description: params.description ?? "",
            status: "active",
            priority: params.priority ?? "medium",
            subtasks: params.subtasks ?? [],
            currentStep: 0,
            currentObjective: params.current_objective ?? "",
            nextAction: params.next_action ?? (params.subtasks?.[0] ?? ""),
            lastProgressNote: "",
            lastOutcome: "",
            lastError: "",
            errorCount: 0,
            requiresApproval: params.requires_approval ?? false,
            awaitingUserDecision: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          store.tasks.push(task);
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Task created: ${id} — ${task.title} [${task.priority}]` }] };
        }

        // All other actions require task_id
        const task = store.tasks.find(t => t.id === params.task_id);
        if (!task) {
          return { content: [{ type: "text" as const, text: `Task not found: ${params.task_id}` }] };
        }

        if (action === "update_progress") {
          task.lastProgressNote = params.progress_note ?? task.lastProgressNote;
          task.lastOutcome = params.outcome ?? "";
          task.nextAction = params.next_action ?? task.nextAction;
          task.currentObjective = params.current_objective ?? task.currentObjective;
          if (params.error) {
            task.lastError = params.error;
            task.errorCount += 1;
          } else {
            task.lastError = "";
          }
          task.currentStep = Math.min(task.currentStep + 1, Math.max(task.subtasks.length - 1, 0));
          task.lastProgressAt = Date.now();
          task.updatedAt = Date.now();
          task.awaitingUserDecision = false;
          saveTasks(store);
          const stepInfo = task.subtasks.length > 0
            ? ` — step ${task.currentStep + 1}/${task.subtasks.length}`
            : "";
          return { content: [{ type: "text" as const, text: `Progress: ${task.title}${stepInfo}\nDone: ${task.lastProgressNote}\nNext: ${task.nextAction}` }] };
        }

        if (action === "complete") {
          task.status = "completed";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Completed: ${task.title}` }] };
        }

        if (action === "pause") {
          task.status = "paused";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Paused: ${task.title}` }] };
        }

        if (action === "resume") {
          task.status = "active";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Resumed: ${task.title}` }] };
        }

        if (action === "set_priority") {
          task.priority = params.priority ?? task.priority;
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Priority set: ${task.title} → ${task.priority}` }] };
        }

        if (action === "request_approval") {
          task.awaitingUserDecision = true;
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Approval requested: ${task.title} — awaiting user decision` }] };
        }

        return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
      },
    });
  },
});
