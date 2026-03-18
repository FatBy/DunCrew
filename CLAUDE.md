# Claude/AI Agent Guidelines

This file is a mirror of AGENTS.md for compatibility with Claude and other AI assistants.

**Please refer to [AGENTS.md](./AGENTS.md) for the full project guidelines.**

The content below is automatically synced from AGENTS.md.

---

<!-- BEGIN AGENTS.md CONTENT -->

# DunCrew Repository Guidelines

> 本文件为 AI Agent (Qoder, Claude, Cursor 等) 提供项目级开发指南。

## Quick Reference

- **Dev server**: `npm run dev`
- **Build**: `npm run build`
- **Type check**: `npx tsc --noEmit`
- **Backend**: `python duncrew-server.py`

## Key Files

- `src/services/LocalClawService.ts` - ReAct 执行引擎
- `src/store/slices/aiSlice.ts` - AI 状态管理
- `duncrew-server.py` - Python 工具后端
- `skills/*/SKILL.md` - 技能定义

## Before Committing

1. Run `npx tsc --noEmit` to verify types
2. Run `npm run build` to verify build
3. Test both FC and Legacy modes if modifying LocalClawService.ts

See AGENTS.md for complete guidelines.
