# Example: Research Report with Web Search

## Scenario

Using DunCrew to research a topic, gather information from the web, and produce a structured report -- all in one automated flow.

## Setup

1. DunCrew running with backend connected
2. API configured with a capable model (GPT-4o recommended for research tasks)
3. Enter any Nexus from the World View

## Prompt

```
Research the current state of WebAssembly (Wasm) adoption in 2025. 
Cover: browser support, server-side usage, language support, major companies using it.
Write a structured report and save it as wasm-report-2025.md.
```

## Execution Flow

```
Step 1/5: Research browser support
  Tool: webSearch → "WebAssembly browser support 2025"
  Tool: webFetch → MDN compatibility page
  Result: Gathered browser support data

Step 2/5: Research server-side Wasm
  Tool: webSearch → "WebAssembly server side WASI 2025"
  Tool: webFetch → Top 3 relevant articles
  Result: WASI, Spin, Wasmtime status

Step 3/5: Research language ecosystem
  Tool: webSearch → "languages compiling to WebAssembly 2025"
  Result: Rust, Go, C++, AssemblyScript, Kotlin, C# status

Step 4/5: Research enterprise adoption
  Tool: webSearch → "companies using WebAssembly production 2025"
  Result: Figma, Cloudflare, Amazon, Shopify, etc.

Step 5/5: Compile and write report
  Tool: writeFile → wasm-report-2025.md
  Critic: ✓ Verified report structure and completeness
```

## Output Structure

The AI produces a well-structured markdown report:

```markdown
# WebAssembly Adoption Report (2025)

## Executive Summary
...

## Browser Support
| Browser | Wasm | SIMD | Threads | GC |
|---------|------|------|---------|----|
...

## Server-Side Usage
### WASI
### Edge Computing
...

## Language Support
| Language | Maturity | Key Toolchain |
...

## Enterprise Adoption
...

## Conclusions & Outlook
...

## Sources
[1] ...
[2] ...
```

## What Makes This Different from ChatGPT?

| Aspect | DunCrew | ChatGPT |
|--------|-------|---------|
| **Web access** | Real-time search + full page fetch | Limited browsing |
| **File output** | Saved as actual .md file on your machine | Copy-paste from chat |
| **Memory** | Research context saved to L1, reusable later | Gone after session |
| **Verification** | Critic checks file was written correctly | No verification |
| **Iterability** | "Update the section on WASI" works without re-explaining | Full re-prompt needed |

## Key Features Demonstrated

| Feature | How It's Used |
|---------|--------------|
| **Multi-step planning** | Research broken into logical phases |
| **webSearch + webFetch** | Combined for broad search + deep page reading |
| **writeFile + Critic** | Report saved to disk and auto-verified |
| **L1 Memory** | Research context persisted for follow-up questions |
| **File Registry** | Report path auto-registered for future reference |

## Tips

- Follow up with "add a section about performance benchmarks" -- the AI remembers the full report
- Ask "summarize the report in 3 bullet points" for a quick overview
- Use "search for more recent data on WASI" to incrementally improve sections
- The research context stays in L1 memory, so you can return days later and continue
