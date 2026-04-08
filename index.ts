/**
 * Heartbeat Project Plugin
 *
 * Core: Turn heartbeat into a continuous project worker.
 * Aux: Reply to heartbeat messages to give feedback.
 *
 * Hooks:
 * 1. before_prompt_build: inject task management + pending reply instructions
 * 2. before_dispatch: intercept quoted replies to [🩷] messages
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

      const lines = ["你有以下持续任务：", ""];
      for (const task of active) {
        const ago = task.lastProgressAt
          ? `${Math.round((Date.now() - task.lastProgressAt) / 60000)}分钟前`
          : "未开始";
        lines.push(`- **${task.title}** — 上次进展：${ago}`);
        if (task.description) lines.push(`  说明：${task.description}`);
        if (task.subtasks.length > 0) {
          const current = task.subtasks[task.currentStep] ?? task.subtasks[task.subtasks.length - 1];
          lines.push(`  当前步骤：${current}`);
        }
      }
      lines.push("");
      lines.push("每轮至少推进一个任务。完成一步后更新进度。有值得汇报的就告诉用户，开头加 [🩷]。");
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
        chain = chain.replace(/\n+## 用户回复[\s\S]*?(?=\n## |$)/, "");
        chain = chain.trimEnd() + `\n\n${REPLY_SECTION}\n${text}\n`;
        fs.writeFileSync(chainPath, chain);
        logger.info("heartbeat-project: reply written");
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

    function triggerHeartbeatWake(): void {
      try {
        const { exec } = require("child_process");
        exec(
          'openclaw system event --text "用户回复了心跳消息" --mode now',
          { timeout: 15000 },
          (err: any) => {
            if (err) logger.error("heartbeat-project: wake error", { error: String(err) });
            else logger.info("heartbeat-project: wake triggered");
          },
        );
      } catch {}
    }

    // ==================== Hook 1: before_prompt_build ====================
    // Inject task management + reply handling into heartbeat prompt

    (api as any).on(
      "before_prompt_build",
      async (_event: any, ctx: any) => {
        const sessionKey = ctx?.sessionKey ?? "";
        if (!sessionKey.includes(":heartbeat")) return undefined;

        const parts: string[] = [];

        // Check for pending user reply (highest priority)
        const pendingReply = readPendingReply();
        if (pendingReply) {
          parts.push([
            "⚠️ 最高优先级：用户回复了你之前发的心跳消息。",
            "不要做任何任务。直接回应用户。回复开头加 [🩷]。",
            "",
            pendingReply,
          ].join("\n"));
          clearPendingReply();
        }

        // Inject task management instructions
        const taskPrompt = buildTaskPrompt();
        if (taskPrompt && !pendingReply) {
          parts.push(taskPrompt);
        }

        // Always remind about the marker
        parts.push("提醒：你的每条回复开头必须加 [🩷]。没有例外。");

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
    // Intercept user replies to heartbeat messages

    (api as any).on(
      "before_dispatch",
      async (event: any, _ctx: any) => {
        const replyToBody = event?.replyToBody;
        const userMessage = event?.content ?? "";

        if (!replyToBody || !replyToBody.includes(HEARTBEAT_MARKER)) return undefined;

        logger.info("heartbeat-project: reply intercepted");

        writePendingReply(
          `用户说：「${userMessage}」\n引用的心跳内容：「${replyToBody.slice(0, 200).trim()}」`
        );
        triggerHeartbeatWake();

        return { handled: true, text: "[🩷] 收到，心跳正在回复..." };
      },
      { name: "heartbeat-project-dispatch" },
    );

    // ==================== Tool: manage tasks ====================
    // Register a tool so the agent can create/update tasks

    api.registerTool({
      name: "heartbeat_task",
      description: "Manage heartbeat project tasks. Use to create, update, complete, or list persistent tasks that the heartbeat works on across sessions.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update_progress", "complete", "pause", "resume", "list"],
            description: "Action to perform",
          },
          task_id: { type: "string", description: "Task ID (for update/complete/pause/resume)" },
          title: { type: "string", description: "Task title (for create)" },
          description: { type: "string", description: "Task description (for create)" },
          subtasks: {
            type: "array",
            items: { type: "string" },
            description: "List of subtask descriptions (for create)",
          },
          progress_note: { type: "string", description: "What was done (for update_progress)" },
        },
        required: ["action"],
      },
      async execute(_id: string, params: any) {
        const store = loadTasks();
        const action = params.action;

        if (action === "list") {
          const summary = store.tasks.map(t =>
            `[${t.status}] ${t.id}: ${t.title} (step ${t.currentStep + 1}/${t.subtasks.length || 1})`
          ).join("\n") || "没有任务。";
          return { content: [{ type: "text", text: summary }] };
        }

        if (action === "create") {
          const id = `task-${Date.now()}`;
          const task: Task = {
            id,
            title: params.title ?? "未命名任务",
            description: params.description ?? "",
            status: "active",
            subtasks: params.subtasks ?? [],
            currentStep: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          store.tasks.push(task);
          saveTasks(store);
          return { content: [{ type: "text", text: `任务创建成功：${id} — ${task.title}` }] };
        }

        const task = store.tasks.find(t => t.id === params.task_id);
        if (!task) {
          return { content: [{ type: "text", text: `任务不存在：${params.task_id}` }] };
        }

        if (action === "update_progress") {
          task.currentStep = Math.min(task.currentStep + 1, Math.max(task.subtasks.length - 1, 0));
          task.lastProgressAt = Date.now();
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text", text: `进度更新：${task.title} — 步骤 ${task.currentStep + 1}/${task.subtasks.length || 1}` }] };
        }

        if (action === "complete") {
          task.status = "completed";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text", text: `任务完成：${task.title}` }] };
        }

        if (action === "pause") {
          task.status = "paused";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text", text: `任务暂停：${task.title}` }] };
        }

        if (action === "resume") {
          task.status = "active";
          task.updatedAt = Date.now();
          saveTasks(store);
          return { content: [{ type: "text", text: `任务恢复：${task.title}` }] };
        }

        return { content: [{ type: "text", text: `未知操作：${action}` }] };
      },
    });
  },
});
