/**
 * Heartbeat Project Plugin
 *
 * Core: Turn heartbeat into a continuous project worker.
 * Aux: Reply to heartbeat messages to give feedback.
 *
 * Hooks:
 * 1. before_prompt_build: inject task management + pending reply instructions
 * 2. before_dispatch: intercept quoted replies to [🩷] messages
 *
 * Safe: no shell commands or dangerous code patterns.
 * Reply delivery relies on the next heartbeat tick reading the pending reply.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_MARKER = "[🩷]";
const REPLY_SECTION = "## 用户回复";
const TASKS_FILE = "heartbeat-tasks.json";

// --- Task types ---
interface Task {
  id: string;
  title: string;
  description: string;
  status: "active" | "paused" | "completed";
  subtasks: string[];
  currentStep: number;
  createdAt: number;
  updatedAt: number;
  lastProgressAt?: number;
}

interface TaskStore {
  tasks: Task[];
}

export default definePluginEntry({
  id: "heartbeat-project",
  name: "Heartbeat Project",
  description: "Turn heartbeat into a continuous project worker. Manages long-running tasks across heartbeat sessions with reply-based feedback.",

  register(api) {
    const logger = api.logger;
    const workspaceDir = api.config?.agents?.defaults?.workspace ?? process.cwd();
    const dataDir = path.join(workspaceDir, ".heartbeat-project");
    const chainPath = path.join(workspaceDir, "memory", "heartbeat-chain.md");
    const tasksPath = path.join(dataDir, TASKS_FILE);

    // Ensure data dir exists
    try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}

    logger.info("heartbeat-project: registered", { workspaceDir });

    // ==================== Task Management ====================

    function loadTasks(): TaskStore {
      try {
        return JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
      } catch {
        return { tasks: [] };
      }
    }

    function saveTasks(store: TaskStore): void {
      fs.writeFileSync(tasksPath, JSON.stringify(store, null, 2));
    }

    function getActiveTasks(): Task[] {
      return loadTasks().tasks.filter(t => t.status === "active");
    }

    function buildTaskPrompt(): string | null {
      const active = getActiveTasks();
      if (active.length === 0) return null;

      const lines = ["You have the following ongoing tasks:", ""];
      for (const task of active) {
        const ago = task.lastProgressAt
          ? `${Math.round((Date.now() - task.lastProgressAt) / 60000)} min ago`
          : "not started";
        lines.push(`- **${task.title}** — last progress: ${ago}`);
        if (task.description) lines.push(`  Description: ${task.description}`);
        if (task.subtasks.length > 0) {
          const current = task.subtasks[task.currentStep] ?? task.subtasks[task.subtasks.length - 1];
          lines.push(`  Current step: ${current}`);
        }
      }
      lines.push("");
      lines.push("Work on at least one task per heartbeat tick. Report meaningful progress to the user. Prefix all replies with [🩷].");
      return lines.join("\n");
    }

    // ==================== Reply Management ====================

    function readPendingReply(): string | null {
      try {
        const chain = fs.readFileSync(chainPath, "utf-8");
        const match = chain.match(/## 用户回复\n([\s\S]*?)(?=\n## |$)/);
        return match?.[1]?.trim() || null;
      } catch {
        return null;
      }
    }

    function writePendingReply(text: string): void {
      try {
        let chain = "";
        try { chain = fs.readFileSync(chainPath, "utf-8"); } catch {}
        // Remove old reply section
        chain = chain.replace(/\n+## 用户回复[\s\S]*?(?=\n## |$)/, "");
        // Append new reply section
        chain = chain.trimEnd() + `\n\n${REPLY_SECTION}\n${text}\n`;
        fs.writeFileSync(chainPath, chain);
        logger.info("heartbeat-project: reply written to heartbeat-chain.md");
      } catch (err) {
        logger.error("heartbeat-project: write failed", { error: String(err) });
      }
    }

    function clearPendingReply(): void {
      try {
        let chain = fs.readFileSync(chainPath, "utf-8");
        chain = chain.replace(/\n+## 用户回复[\s\S]*?(?=\n## |$)/, "");
        fs.writeFileSync(chainPath, chain.trimEnd() + "\n");
      } catch {}
    }

    // ==================== Hook 1: before_prompt_build ====================

    (api as any).on(
      "before_prompt_build",
      async (_event: any, ctx: any) => {
        const sessionKey = ctx?.sessionKey ?? "";
        if (!sessionKey.includes(":heartbeat")) return undefined;

        const parts: string[] = [];

        // Pending user reply takes highest priority
        const pendingReply = readPendingReply();
        if (pendingReply) {
          parts.push([
            "⚠️ HIGHEST PRIORITY: The user replied to your heartbeat message.",
            "Do NOT work on tasks. Respond to the user directly. Prefix with [🩷].",
            "",
            pendingReply,
          ].join("\n"));
          clearPendingReply();
        }

        // Inject task management (only when no pending reply)
        const taskPrompt = buildTaskPrompt();
        if (taskPrompt && !pendingReply) {
          parts.push(taskPrompt);
        }

        // Always remind about the marker
        parts.push("Reminder: Every heartbeat reply MUST start with [🩷]. No exceptions.");

        if (parts.length === 0) return undefined;

        logger.info("heartbeat-project: injecting prompt", {
          hasPendingReply: !!pendingReply,
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
        const replyToBody = event?.replyToBody;
        const userMessage = event?.content ?? "";

        // Only intercept quoted replies containing the heartbeat marker
        if (!replyToBody || !replyToBody.includes(HEARTBEAT_MARKER)) return undefined;

        logger.info("heartbeat-project: reply intercepted");

        // Write to heartbeat-chain.md for the next heartbeat tick to pick up
        writePendingReply(
          `User said: "${userMessage}"\nReplied to: "${replyToBody.slice(0, 200).trim()}"`
        );

        // Return handled — message does not go to the main session
        return {
          handled: true,
          text: "[🩷] Got it — heartbeat will respond on its next tick.",
        };
      },
      { name: "heartbeat-project-dispatch" },
    );

    // ==================== Tool: heartbeat_task ====================

    api.registerTool({
      name: "heartbeat_task",
      description: "Manage heartbeat project tasks. Create, update, complete, or list persistent tasks that the heartbeat works on across sessions.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: ["create", "update_progress", "complete", "pause", "resume", "list"],
            description: "Action to perform",
          },
          task_id: { type: "string" as const, description: "Task ID (for update/complete/pause/resume)" },
          title: { type: "string" as const, description: "Task title (for create)" },
          description: { type: "string" as const, description: "Task description (for create)" },
          subtasks: {
            type: "array" as const,
            items: { type: "string" as const },
            description: "List of subtask descriptions (for create)",
          },
          progress_note: { type: "string" as const, description: "What was done (for update_progress)" },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const store = loadTasks();
        const action = params.action;

        if (action === "list") {
          const summary = store.tasks.map(t =>
            `[${t.status}] ${t.id}: ${t.title} (step ${t.currentStep + 1}/${t.subtasks.length || 1})`
          ).join("\n") || "No tasks.";
          return { content: [{ type: "text" as const, text: summary }] };
        }

        if (action === "create") {
          const id = `task-${Date.now()}`;
          const task: Task = {
            id,
            title: params.title ?? "Untitled task",
            description: params.description ?? "",
            status: "active",
            subtasks: params.subtasks ?? [],
            currentStep: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          store.tasks.push(task);
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Task created: ${id} — ${task.title}` }] };
        }

        const task = store.tasks.find(t => t.id === params.task_id);
        if (!task) {
          return { content: [{ type: "text" as const, text: `Task not found: ${params.task_id}` }] };
        }

        if (action === "update_progress") {
          task.currentStep = Math.min(task.currentStep + 1, Math.max(task.subtasks.length - 1, 0));
          task.lastProgressAt = Date.now();
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text" as const, text: `Progress: ${task.title} — step ${task.currentStep + 1}/${task.subtasks.length || 1}` }] };
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

        return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
      },
    });
  },
});
