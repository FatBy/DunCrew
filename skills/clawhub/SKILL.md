---
name: clawhub
description: "Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed clawhub CLI."
version: "1.0.0"
author: "DunCrew"
tags: ["cli", "package-management", "skill-registry", "agent-tools"]
keywords: ["clawhub", "install skill", "update skill", "search skills", "publish skill", "sync skills"]
dangerLevel: "high"
inputs:
  - name: "action"
    type: "string"
    description: "CLI operation to perform (search, install, update, list, publish)"
  - name: "skill_name"
    type: "string"
    description: "Target skill slug or identifier"
  - name: "version"
    type: "string"
    description: "Specific version to install or update to"
  - name: "query"
    type: "string"
    description: "Search keywords for discovering skills"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
    requires:
      bins: ["clawhub"]
      env: ["CLAWHUB_REGISTRY", "CLAWHUB_WORKDIR"]
    install:
      - id: "node"
        kind: "node"
        package: "clawhub"
        bins: ["clawhub"]
        label: "Install ClawHub CLI (npm)"
---

# ClawHub CLI

Install

```bash
npm i -g clawhub
```

Auth (publish)

```bash
clawhub login
clawhub whoami
```

Search

```bash
clawhub search "postgres backups"
```

Install

```bash
clawhub install my-skill
clawhub install my-skill --version 1.2.3
```

Update (hash-based match + upgrade)

```bash
clawhub update my-skill
clawhub update my-skill --version 1.2.3
clawhub update --all
clawhub update my-skill --force
clawhub update --all --no-input --force
```

List

```bash
clawhub list
```

Publish

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

Notes

- Default registry: https://clawhub.com (override with CLAWHUB_REGISTRY or --registry)
- Default workdir: cwd (falls back to OpenClaw workspace); install dir: ./skills (override with --workdir / --dir / CLAWHUB_WORKDIR)
- Update command hashes local files, resolves matching version, and upgrades to latest unless --version is set