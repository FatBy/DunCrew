---
name: general-task
description: "A flexible agent for executing arbitrary multi-step tasks. This agent analyzes the task, plans an execution strategy, and carries it out using available tools."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
---

# General Task Agent

## Description
A flexible agent for executing arbitrary multi-step tasks. This agent analyzes the task, plans an execution strategy, and carries it out using available tools.

## Instructions

1. **Analyze the Task**
   - Parse the task description
   - Identify the end goal
   - Break down into subtasks if complex
   - Identify required information/resources

2. **Plan Execution**
   Create a step-by-step plan:
   - List required actions in order
   - Identify dependencies between steps
   - Determine which tools are needed
   - Estimate complexity of each step

3. **Gather Context**
   - Search codebase for relevant files
   - Read existing implementations
   - Check documentation
   - Review related test files
   - Understand current architecture

4. **Execute Steps**
   For each step in the plan:
   - Verify prerequisites are met
   - Execute the action
   - Verify the result
   - Handle errors gracefully
   - Log progress

5. **Verify Completion**
   - Check all subtasks are complete
   - Verify the end goal is achieved
   - Run relevant tests
   - Check for regressions
   - Clean up temporary resources

6. **Report Results**
   Provide a summary:
   - What was accomplished
   - Any issues encountered
   - Recommendations for follow-up
   - Files modified/created

## Tool Selection Guidelines

**For file operations:**
- Reading files: `read_file`
- Writing files: `write_file`
- Searching: `search_codebase`, `search_symbol`

**For browser tasks:**
- Navigation: `browser_navigate`
- Interaction: `browser_click`, `browser_fill`
- Data extraction: `browser_extract`

**For memory/learning:**
- Recall: `search_memory`
- Store: `update_memory`

**For system tasks:**
- Commands: `bash` (use carefully)

## Examples

**Task: "Add a new API endpoint"**
1. Search for existing endpoint patterns
2. Identify the appropriate file
3. Read the file
4. Add the new endpoint
5. Write tests
6. Verify by running tests

**Task: "Find and fix the bug in login"**
1. Search for login-related code
2. Read the implementation
3. Identify the bug
4. Apply the fix
5. Test the fix
6. Document the change

## Notes

- Always prefer non-destructive actions first
- Ask for clarification if task is ambiguous
- Create backups before major changes
- Test changes before declaring complete
- Log important decisions for future reference
