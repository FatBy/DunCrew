---
name: deep-research
description: "Async deep research via Gemini Interactions API (no Gemini CLI dependency). RAG-ground queries on local files (--context), preview costs (--dry-run), structured JSON output, adaptive polling. Universal skill for 30+ AI agents including Claude Code, Amp, Codex, and Gemini CLI."
version: "1.0.0"
author: "DunCrew"
license: MIT
metadata:
  openclaw:
    emoji: "🔬"
    primaryEnv: "shell"
---

# Deep Research Skill 
Perform deep research powered by Google Gemini's deep research agent. Upload documents to file search stores for RAG-grounded answers. Manage research sessions with persistent workspace state. 

## For AI Agents 
Get a full capabilities manifest, decision trees, and output contracts: 
```bash 
uv run {baseDir}/scripts/onboard.py --agent 
``` 
See [AGENTS.md]({baseDir}/AGENTS.md) for the complete structured briefing. 

| Command | What It Does | 
|---------|-------------| 
| `uv run {baseDir}/scripts/research.py start "question"` | Launch deep research | 
| `uv run {baseDir}/scripts/research.py start "question" --context ./path --dry-run` | Estimate cost | 
| `uv run {baseDir}/scripts/research.py start "question" --context ./path --output report.md` | RAG-grounded research | 
| `uv run {baseDir}/scripts/store.py query "question"` | Quick Q&A against uploaded docs | 

## Prerequisites 
- A Google API key (`GOOGLE_API_KEY` or `GEMINI_API_KEY` environment variable) 
- [uv](https://docs.astral.sh/uv/) installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`) 

## Quick Start 
```bash 
# Run a deep research query 
uv run {baseDir}/scripts/research.py "What are the latest advances in quantum computing?" 

# Check research status 
uv run {baseDir}/scripts/research.py status 

# Save a completed report 
uv run {baseDir}/scripts/research.py report --output report.md 

# Research grounded in local files (auto-creates store, uploads, cleans up) 
uv run {baseDir}/scripts/research.py start "How does auth work?" --context ./src --output report.md 

# Export as HTML or PDF 
uv run {baseDir}/scripts/research.py start "Analyze the API" --context ./src --format html --output report.html 

# Auto-detect prompt template based on context files 
uv run {baseDir}/scripts/research.py start "How does auth work?" --context ./src --prompt-template auto --output report.md 
``` 

## Environment Variables 
Set one of the following (checked in order of priority): 

| Variable | Description | 
|----------|-------------| 
| `GEMINI_DEEP_RESEARCH_API_KEY` | Dedicated key for this skill (highest priority) | 
| `GOOGLE_API_KEY` | Standard Google AI key | 
| `GEMINI_API_KEY` | Gemini-specific key | 

Optional model configuration: 

| Variable | Description | Default | 
|----------|-------------|---------| 
| `GEMINI_DEEP_RESEARCH_MODEL` | Model for file search queries | `models/gemini-flash-latest` | 
| `GEMINI_MODEL` | Fallback model name | `models/gemini-flash-latest` | 
| `GEMINI_DEEP_RESEARCH_AGENT` | Deep research agent identifier | `deep-research-pro-preview-12-2025` | 

## Research Commands 

### Start Research 
```bash 
uv run {baseDir}/scripts/research.py start "your research question" 
``` 

| Flag | Description | 
|------|-------------| 
| `--report-format FORMAT` | Output structure: `executive_summary`, `detailed_report`, `comprehensive` | 
| `--store STORE_NAME` | Ground research in a file search store (display name or resource ID) | 
| `--no-thoughts` | Hide intermediate thinking steps | 
| `--follow-up ID` | Continue a previous research session | 
| `--output FILE` | Wait for completion and save report to a single file | 
| `--output-dir DIR` | Wait for completion and save structured results to a directory (see below) | 
| `--timeout SECONDS` | Maximum wait time when polling (default: 1800 = 30 minutes) | 
| `--no-adaptive-poll` | Disable history-adaptive polling; use fixed interval curve instead | 
| `--context PATH` | Auto-create ephemeral store from a file or directory for RAG-grounded research | 
| `--context-extensions EXT` | Filter context uploads by extension (e.g. `py,md` or `.py .md`) | 
| `--keep-context` | Keep the ephemeral store instead of deleting it after research | 

### Output Directories 
When using `--output-dir DIR`, the following files are created: 

| File | Content | 
|------|---------| 
| `report.md` | Main research report | 
| `sources.json` | Sources cited during research | 
| `thoughts.md` | Intermediate thinking steps (if not using `--no-thoughts`) | 
| `query.json` | Research query metadata | 
| `store.json` | Store metadata (if a file search store was used) | 
| `costs.json` | Estimated token usage and cost breakdown | 

### Store Management 
Create and manage file search stores for RAG: 

```bash 
# List existing stores 
uv run {baseDir}/scripts/store.py list 

# Create a new store 
uv run {baseDir}/scripts/store.py create "My Store" 

# Upload files to a store 
uv run {baseDir}/scripts/store.py upload ./docs --store "My Store" 

# Query a store 
uv run {baseDir}/scripts/store.py query "How does authentication work?" --store "My Store" 

# Delete a store 
uv run {baseDir}/scripts/store.py delete "My Store" 
``` 

## Use Cases 

### Technical Documentation Research 
```bash 
# Research best practices for authentication 
uv run {baseDir}/scripts/research.py start "Modern authentication patterns for web apps" --context ./auth-docs --output auth-report.md 

# Compare authentication libraries 
uv run {baseDir}/scripts/research.py start "Passport.js vs Auth0 vs Firebase Auth" --context ./lib-comparisons --output lib-comparison.md 
``` 

### Competitive Analysis 
```bash 
# Analyze competitors' features 
uv run {baseDir}/scripts/research.py start "Features of competing SaaS platforms" --context ./market-research --output competitive-analysis.md 
``` 

### Academic Research 
```bash 
# Literature review on a topic 
uv run {baseDir}/scripts/research.py start "Recent advances in neural network architecture" --context ./papers --output literature-review.md 
``` 

## Integration with AI Agents 

### Claude Code 
```bash 
# Load skill in Claude Code workspace 
cp {baseDir}/AGENTS.md ~/.claude-code/AGENTS.md 

# Run research from Claude Code 
uv run {baseDir}/scripts/research.py start "Optimize database queries" --context ./src 
``` 

### Codex 
```bash 
# Add skill to Codex config 
echo '{"skills": ["deep-research"]}' > ~/.codex/skills.json 

# Use in Codex session 
/research "Explain microservices architecture" 
``` 

### Gemini CLI 
```bash 
# Install as Gemini CLI skill 
gemini skills install {baseDir} 

# Use with Gemini CLI 
gemini research "Blockchain use cases" --context ./docs 
``` 

## Cost Estimation 

Dry-run mode estimates cost before running: 

```bash 
# Preview cost without running 
uv run {baseDir}/scripts/research.py start "Complex topic" --dry-run 
``` 

Output includes: 
- Estimated tokens (input/output) 
- Approximate cost (based on Gemini pricing) 
- Research steps breakdown 

## Adaptive Polling 

The skill uses adaptive polling that learns from research duration history: 

1. First poll: 30 seconds 
2. Subsequent polls: increases based on expected completion time 
3. Maximum timeout: 30 minutes (configurable with `--timeout`) 

Disable with `--no-adaptive-poll` for fixed intervals. 

## Troubleshooting 

### API Key Issues 
```bash 
# Test API key 
uv run {baseDir}/scripts/test.py --api-key YOUR_KEY 

# Check environment variables 
echo $GOOGLE_API_KEY 
``` 

### Installation Issues 
```bash 
# Install uv if missing 
curl -LsSf https://astral.sh/uv/install.sh | sh 

# Check Python version (requires 3.9+) 
python --version 
``` 

### Research Timeout 
```bash 
# Increase timeout to 1 hour 
uv run {baseDir}/scripts/research.py start "Question" --timeout 3600 

# Check research status 
uv run {baseDir}/scripts/research.py status 
``` 

## License 
MIT License - see [LICENSE]({baseDir}/LICENSE) for details. 

## Support 
- Issues: https://github.com/24601/agent-deep-research/issues 
- Documentation: https://github.com/24601/agent-deep-research/wiki 
- Examples: https://github.com/24601/agent-deep-research/examples