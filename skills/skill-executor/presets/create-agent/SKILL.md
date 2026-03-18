---
name: create-agent
description: "Create a new specialized AI agent with custom prompts and tools"
version: "1.0.0"
author: "DunCrew Team"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
tags: ["agent", "automation", "create"]
inputs:
  agent_name:
    type: "string"
    required: true
    description: "Name of the new agent"
  purpose:
    type: "string"
    required: true
    description: "Purpose/description of the agent"
  tools:
    type: "array"
    required: false
    description: "List of tools the agent should have access to"
  system_prompt:
    type: "string"
    required: false
    description: "Custom system prompt for the agent"
---

# Create Agent

## Description
Create a new specialized AI agent with customized capabilities, prompts, and tool access. This skill helps you define domain-specific agents that can be reused for particular tasks.

## Instructions

1. **Understand the Requirements**
   - Analyze the user's description of what the agent should do
   - Identify the key capabilities needed
   - Determine which tools would be most useful

2. **Design the Agent Configuration**
   - Create a descriptive name that reflects the agent's purpose
   - Write a clear system prompt that defines the agent's role and constraints
   - Select appropriate tools from the available tool registry

3. **Create the Agent Definition File**
   - Create a new directory: `.duncrew/agents/{agent_name}/`
   - Write `config.json` with:
     ```json
     {
       "name": "agent-name",
       "description": "Agent description",
       "system_prompt": "Custom system prompt...",
       "tools": ["tool1", "tool2"],
       "temperature": 0.7,
       "max_tokens": 4096
     }
     ```

4. **Add Custom Instructions (Optional)**
   - Create `INSTRUCTIONS.md` with detailed guidance
   - Add example interactions
   - Define success criteria

5. **Verify the Agent**
   - Test the agent with a sample task
   - Verify tool access works correctly
   - Adjust prompts if needed

## Examples

**Create a Code Review Agent:**
```
Agent Name: code-reviewer
Purpose: Review code for bugs, security issues, and best practices
Tools: search_codebase, search_symbol, read_file
```

**Create a Documentation Agent:**
```
Agent Name: doc-writer
Purpose: Generate and maintain project documentation
Tools: search_codebase, read_file, write_file
```

## Notes

- Keep the system prompt focused and specific
- Don't give agents more tools than they need
- Test with edge cases before deploying
- Consider adding constraints for safety
