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
