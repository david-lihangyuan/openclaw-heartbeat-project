---
name: heartbeat-project
description: "Manage continuous projects across heartbeat sessions. The heartbeat-project plugin handles task persistence and reply routing automatically. Use the heartbeat_task tool to create, update, and complete tasks."
---

# Heartbeat Project

The heartbeat-project plugin is installed. It provides:

## heartbeat_task tool

Use this tool to manage persistent tasks:

- `heartbeat_task(action: "create", title: "...", description: "...", subtasks: [...])` — create a task
- `heartbeat_task(action: "list")` — list all tasks
- `heartbeat_task(action: "update_progress", task_id: "...")` — advance to next step
- `heartbeat_task(action: "complete", task_id: "...")` — mark done
- `heartbeat_task(action: "pause", task_id: "...")` — pause a task
- `heartbeat_task(action: "resume", task_id: "...")` — resume a task

## How it works

1. User asks for something ongoing → create a task with subtasks
2. Each heartbeat tick, the plugin injects active tasks into the prompt
3. Heartbeat works on tasks and reports progress
4. User can reply to heartbeat messages to give feedback (quoted reply)

## Rules

- Always prefix heartbeat messages with [🩷]
- At least one task step per heartbeat tick
- Only report meaningful progress, not every tick
- 每次回复必须包含当前时间（HH:MM），避免 duplicate 检测拦截

## ⚠️ 心跳配置要求

插件只在心跳 session 中生效。确保你的心跳配置正确：

```json
// openclaw.json → agents.defaults.heartbeat
{
  "every": "30m",
  "target": "telegram",
  "to": "<your-chat-id>",
  "ackMaxChars": 50000
}
```

**常见问题：**

1. **target 不要用 `last`** — `isolatedSession: true` 下 `target: last` 无法投递。用 `target: telegram` + `to: chatID`
2. **ackMaxChars 要设大** — 默认值太小会把心跳内容当 HEARTBEAT_OK 吞掉。建议 50000
3. **duplicate 拦截** — 如果每轮回复内容一样会被跳过。确保回复包含时间戳或变化内容
4. **其他 Agent 的 channel 报错** — 如果有 Agent 的 Telegram token 失效导致 401 重试循环，会阻塞心跳调度。禁用出错的 Agent 或修复 token
5. **引用回复心跳消息进了主对话** — OpenClaw 2026.4.5 官方版不把 `replyToBody` 传给插件 hook，导致插件无法识别心跳回复。需要手动 patch：

```bash
FILE=$(grep -rl "replyToId: ctx.ReplyToId" /usr/local/lib/node_modules/openclaw/dist/message-hook-mappers*.js | head -1)
if grep -q "replyToBody: ctx.ReplyToBody" "$FILE"; then
  echo "已经 patch 过了"
else
  sed -i.bak 's/replyToId: ctx.ReplyToId/replyToId: ctx.ReplyToId,\n\t\treplyToBody: ctx.ReplyToBody/' "$FILE"
  echo "Patched: $FILE — 重启 gateway: openclaw gateway restart"
fi
```

等 PR #62966 合并后此 patch 不再需要。
