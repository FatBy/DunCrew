# Example: Building a Utility Library with ReAct Execution

## Scenario

Using the `skill-scout` Nexus (or a coding-focused Nexus) to build a TypeScript date formatting utility library from scratch.

## Setup

1. DunCrew running with backend connected
2. API configured (any OpenAI-compatible model with function calling support)
3. Enter a coding Nexus from the World View

## Prompt

```
Create a TypeScript utility library called "datekit" with these functions:
1. formatRelative(date) - "3 hours ago", "in 2 days", etc.
2. parseNatural(str) - parse "next friday", "last month" into Date objects
3. rangeOverlap(range1, range2) - check if two date ranges overlap

Include unit tests with Vitest. Initialize as a proper npm package.
```

## Execution Flow

The ReAct engine decomposes this into steps:

```
Step 1/6: Initialize project structure
  Tool: runCmd → npm init -y && npm i -D typescript vitest
  Tool: writeFile → tsconfig.json
  Critic: ✓ Verified package.json exists

Step 2/6: Implement formatRelative
  Tool: writeFile → src/formatRelative.ts
  Critic: ✓ Read back file, confirmed function signature

Step 3/6: Implement parseNatural
  Tool: writeFile → src/parseNatural.ts
  Critic: ✓ Verified file content

Step 4/6: Implement rangeOverlap
  Tool: writeFile → src/rangeOverlap.ts
  Critic: ✓ Verified file content

Step 5/6: Write tests
  Tool: writeFile → tests/datekit.test.ts
  Critic: ✓ Verified test file

Step 6/6: Run tests
  Tool: runCmd → npx vitest run
  Result: 12 tests passed ✓
```

### What If Tests Fail?

This is where DunCrew differs from other agents. When `vitest run` returns failures:

1. **Reflexion triggers**: The AI doesn't blindly retry. It generates a structured self-reflection:
   ```
   FAILURE ANALYSIS:
   - parseNatural("next friday") returned wrong date
   - Root cause: weekday calculation doesn't account for current day
   - Fix: adjust offset when target weekday <= current weekday
   ```

2. **Targeted fix**: Only the broken function gets patched, not a full rewrite

3. **Critic re-verification**: After the fix, tests run again automatically

4. **Gene Pool capture**: The successful fix pattern (weekday calculation edge case) gets harvested as a reusable gene

## Key Features Demonstrated

| Feature | How It's Used |
|---------|--------------|
| **Task Decomposition** | Complex request split into 6 executable steps |
| **Critic Verification** | Every `writeFile` and `runCmd` gets auto-verified |
| **Reflexion** | Test failures trigger structured error analysis, not blind retry |
| **File Registry** | All created files auto-registered with O(1) lookup |
| **Dangerous Op Approval** | `runCmd` classified by risk level, user approves if needed |
| **Gene Pool** | Successful patterns saved for future similar tasks |

## Project Structure Created

```
datekit/
├── package.json
├── tsconfig.json
├── src/
│   ├── formatRelative.ts
│   ├── parseNatural.ts
│   └── rangeOverlap.ts
├── tests/
│   └── datekit.test.ts
└── index.ts
```

## Tips

- For complex projects, break into multiple prompts: "first set up the project", then "implement feature X"
- The File Registry means you can say "update the test file" without specifying the path
- Successive coding sessions with the same Nexus build its scoring, improving future code quality
