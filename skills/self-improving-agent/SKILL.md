---
name: self-improvement
description: "Captures learnings, errors, and corrections to enable continuous improvement. Use when: (1) A command or operation fails unexpectedly, (2) User corrects Claude ('No, that's wrong...', 'Actually...'), (3) User requests a capability that doesn't exist, (4) An external API or tool fails, (5) Claude realizes its knowledge is outdated or incorrect, (6) A better approach is discovered for a recurring task. Also review learnings before major tasks."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
---

# Self-Improvement Skill 
Log learnings and errors to markdown files for continuous improvement. Coding agents can later process these into fixes, and important learnings get promoted to project memory. 

## Quick Reference 
| Situation | Action | 
|-----------|--------| 
| Command/operation fails | Log to `.learnings/ERRORS.md` | 
| User corrects you | Log to `.learnings/LEARNINGS.md` with category `correction` | 
| User wants missing feature | Log to `.learnings/FEATURE_REQUESTS.md` | 
| API/external tool fails | Log to `.learnings/ERRORS.md` with integration details | 
| Knowledge was outdated | Log to `.learnings/LEARNINGS.md` with category `knowledge_gap` | 
| Found better approach | Log to `.learnings/LEARNINGS.md` with category `best_practice` | 
| Similar to existing entry | Link with `**See Also**`, consider priority bump | 
| Broadly applicable learning | Promote to `CLAUDE.md`, `AGENTS.md`, and/or `.github/copilot-instructions.md` | 
| Workflow improvements | Promote to `AGENTS.md` (OpenClaw workspace) | 
| Tool gotchas | Promote to `TOOLS.md` (OpenClaw workspace) | 
| Behavioral patterns | Promote to `SOUL.md` (OpenClaw workspace) | 

## OpenClaw Setup (Recommended) 
OpenClaw is the primary platform for this skill. It uses workspace-based prompt injection with automatic skill loading. 

### Installation 
**Via ClawdHub (recommended):** 
```bash 
clawdhub install self-improving-agent 
``` 
**Manual:** 
```bash 
git clone https://github.com/peterskoett/self-improving-agent.git ~/.openclaw/skills/self-improving-agent 
``` 

### Workspace Structure 
OpenClaw injects these files into every session: 
``` 
~/.openclaw/workspace/ 
├── AGENTS.md # Multi-agent workflows, delegation patterns 
├── SOUL.md # Behavioral guidelines, personality, principles 
├── TOOLS.md # Tool capabilities, integration gotchas 
├── MEMORY.md # Long-term memory (main session only) 
├── memory/ # Daily memory files 
│   └── YYYY-MM-DD.md 
└── .learnings/ # This skill's log files 
    ├── LEARNINGS.md 
    ├── ERRORS.md 
    └── FEATURE_REQUESTS.md 
``` 

### Create Learning Files 
```bash 
mkdir -p ~/.openclaw/workspace/.learnings 
``` 
Then create the log files (or copy from `assets/`): 
- `LEARNINGS.md` — corrections, knowledge gaps, best practices 
- `ERRORS.md` — command failures, exceptions 
- `FEATURE_REQUESTS.md` — user-requested capabilities 

### Promotion Targets 
When learnings prove broadly applicable, promote them to workspace files: 
| Learning Type | Promote To | Example | 
|---------------|------------|---------| 
| Behavioral patterns | `SOUL.md` | "Be concise, avoid disclaimers" | 
| Workflow improvements | `AGENTS.md` | "Spawn sub-agents for long tasks" | 
| Tool gotchas | `TOOLS.md` | "Git push needs auth configured first" | 

### Inter-Session Communication 
OpenClaw provides tools to share learnings across sessions: 
- **sessions_list** — View active/recent sessions 
- **sessions_history** — Read another session's transcript 
- **sessions_send** — Send a learning to another session 
- **sessions_spawn** — Spawn a sub-agent for background work 

### Optional: Enable Hook 
For automatic reminders at session start: 
```bash 
# Copy hook to OpenClaw hooks directory 
cp -r hooks/openclaw ~/.openclaw/hooks/self-improvement 
# Enable it 
openclaw hooks enable self-improvement 
``` 
See `references/openclaw-integration.md` for complete details. 

--- 
## Generic Setup (Other Agents) 
For Claude Code, Codex, Copilot, or other agents, create `.learnings/` in your project: 
```bash 
mkdir -p .learnings 
``` 
Copy templates from `assets/` or create files