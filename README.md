# Heartbeat Project Plugin 🩷

An OpenClaw plugin that turns heartbeat into a continuous project worker.

## What it does

- **Task Management**: Create persistent tasks that heartbeat works on across sessions
- **Reply Routing**: Quote-reply a heartbeat message to give feedback directly to the heartbeat
- **Auto-injection**: Active tasks are injected into heartbeat prompts automatically

## Install

```bash
openclaw plugins install openclaw-heartbeat-project
```

Or install from ClawHub:

```bash
openclaw plugins install clawhub:openclaw-heartbeat-project
```

## How it works

1. Tell your agent: "Help me monitor competitor prices every day"
2. Agent creates a persistent task via the `heartbeat_task` tool
3. Heartbeat picks up the task every tick and works on it
4. Progress updates are sent to you with a [🩷] marker
5. Quote-reply any [🩷] message to give feedback — it goes directly to the heartbeat

## Plugin Components

| Component | What it does |
|-----------|-------------|
| `before_prompt_build` hook | Injects active tasks + pending replies into heartbeat prompt |
| `before_dispatch` hook | Intercepts quote-replies to [🩷] messages |
| `heartbeat_task` tool | Create, update, complete, pause, resume, list tasks |

## Requirements

- OpenClaw ≥ 2026.4.5
- Heartbeat enabled (`agents.defaults.heartbeat.every` > 0)

## License

MIT
