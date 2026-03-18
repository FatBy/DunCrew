---
name: dd-os-data
description: "Provides structured data from OpenClaw's configuration files for DunCrew frontend visualization."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "💾"
    primaryEnv: "shell"
---

# DunCrew Data Provider

Provides structured data from OpenClaw's configuration files for DunCrew frontend visualization.

## What This Skill Does

When DunCrew frontend requests data, this skill instructs the agent to:
- **Read SOUL.md** — Extract soul identity, core truths, boundaries, and vibe
- **Read IDENTITY.md** — Extract agent identity information
- **List Skills** — Scan skills directory and return all installed skills
- **Read Memories** — Extract memory entries from memory directory

## Usage

When the user or DunCrew requests data, respond with the appropriate structured format.

### Get Soul Data

When asked for soul data, read `SOUL.md` and `IDENTITY.md`, then return:

```json
{
  "type": "ddos.soul",
  "data": {
    "identity": {
      "name": "<from IDENTITY.md or SOUL.md>",
      "essence": "<subtitle from SOUL.md>",
      "symbol": "<emoji if any>"
    },
    "coreTruths": [
      {
        "id": "truth-0",
        "title": "<short title>",
        "principle": "<the principle statement>",
        "description": "<explanation>"
      }
    ],
    "boundaries": [
      {
        "id": "boundary-0",
        "rule": "<boundary rule text>"
      }
    ],
    "vibeStatement": "<vibe section content>",
    "continuityNote": "<continuity section content>",
    "rawContent": "<full SOUL.md content>"
  }
}
```

### Get Skills List

When asked for skills, scan the skills directories and return:

```json
{
  "type": "ddos.skills",
  "data": {
    "skills": [
      {
        "name": "<skill folder name>",
        "description": "<from SKILL.md first line>",
        "location": "global|local|workspace",
        "path": "<full path>",
        "status": "active",
        "enabled": true
      }
    ]
  }
}
```

Skills directories to scan:
1. `~/.openclaw/skills/` (global)
2. `./skills/` (workspace)
3. Bundled skills

### Get Memories

When asked for memories, read the memory directory or MEMORY.md:

```json
{
  "type": "ddos.memories",
  "data": {
    "memories": [
      {
        "id": "<unique id>",
        "title": "<memory title>",
        "content": "<memory content>",
        "timestamp": "<ISO timestamp if available>",
        "tags": ["tag1", "tag2"]
      }
    ]
  }
}
```

### Get Full Status

When asked for full DunCrew status, combine all data:

```json
{
  "type": "ddos.status",
  "data": {
    "soul": { ... },
    "skills": { ... },
    "memories": { ... },
    "health": {
      "status": "healthy|degraded|unhealthy",
      "uptime": "<uptime in ms>",
      "version": "<agent version>"
    }
  }
}
```

## Integration with DunCrew

DunCrew frontend will send requests via WebSocket. When you see messages like:
- "DunCrew requesting soul data"
- "Get DunCrew status"
- "Refresh skills list for DunCrew"

Read the appropriate files and respond with the structured JSON format above.

## File Locations

| Data | Source Files |
|------|--------------|
| Soul | `~/clawd/SOUL.md`, `~/clawd/IDENTITY.md` |
| Skills | `~/.openclaw/skills/`, `./skills/` |
| Memories | `~/clawd/memory/`, `~/clawd/MEMORY.md` |
| User | `~/clawd/USER.md` |

## Example Workflow

1. DunCrew connects to OpenClaw Gateway
2. DunCrew sends: `{"method": "ddos.soul"}`
3. Agent reads SOUL.md and IDENTITY.md
4. Agent parses content into structured format
5. Agent returns JSON response
6. DunCrew renders the data in Soul Tower UI

## Notes

- Always read fresh data from files (don't cache)
- Parse markdown sections by headers (## Core Truths, ## Boundaries, etc.)
- Handle missing files gracefully (return empty arrays/objects)
- Preserve original content in `rawContent` field for debugging
