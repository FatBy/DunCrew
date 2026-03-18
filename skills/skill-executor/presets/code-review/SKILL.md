---
name: code-review
description: "Comprehensive code review focusing on quality, security, and best practices"
version: "1.0.0"
author: "DunCrew Team"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
tags: ["review", "code", "quality", "security", "best-practices"]
inputs:
  target:
    type: "string"
    required: false
    description: "File, directory, or git diff to review"
  focus:
    type: "array"
    required: false
    description: "Review focus areas (security, performance, style, logic)"
  strict:
    type: "boolean"
    required: false
    description: "Enable strict mode for more thorough review"
---

# Code Review

## Description
Perform comprehensive code review focusing on correctness, security, performance, and adherence to best practices. Identify bugs, vulnerabilities, and improvement opportunities.

## Instructions

1. **Identify Review Target**
   - If `target` is specified, focus on that file/directory
   - If not specified, review recent git changes: `git diff HEAD~1`
   - For PR review, check staged/unstaged changes

2. **Security Analysis**
   Check for common vulnerabilities:
   - **Injection flaws**: SQL injection, command injection, XSS
   - **Authentication issues**: Hardcoded credentials, weak validation
   - **Data exposure**: Sensitive data in logs, improper error handling
   - **Insecure dependencies**: Check for known CVEs
   
   Search patterns:
   ```
   - eval(, exec(, shell=True
   - password, secret, api_key (hardcoded)
   - innerHTML, dangerouslySetInnerHTML
   - SQL string concatenation
   ```

3. **Logic & Correctness**
   - Check for off-by-one errors
   - Verify null/undefined handling
   - Check edge cases (empty arrays, zero values)
   - Verify error handling completeness
   - Check async/await usage
   - Verify state mutations are intentional

4. **Performance Review**
   - Identify N+1 query patterns
   - Check for unnecessary re-renders (React)
   - Look for memory leaks (event listeners, subscriptions)
   - Check for inefficient loops/algorithms
   - Verify proper use of caching

5. **Code Style & Maintainability**
   - Check naming conventions
   - Verify function length (< 50 lines preferred)
   - Look for code duplication
   - Check for proper error messages
   - Verify comments explain "why" not "what"

6. **Testing Impact**
   - Identify if changes need new tests
   - Check if existing tests cover the changes
   - Verify test assertions are meaningful
   - Check for test coverage gaps

7. **Generate Review Report**
   Format findings as:
   ```
   ## Code Review Summary
   
   ### Critical Issues 🔴
   - [File:Line] Issue description
   
   ### Warnings ⚠️
   - [File:Line] Issue description
   
   ### Suggestions 💡
   - [File:Line] Improvement suggestion
   
   ### Positive Notes ✅
   - Good practices observed
   ```

## Examples

**Security Issue Found:**
```
🔴 CRITICAL: SQL Injection vulnerability
File: src/api/users.js:45
Code: `SELECT * FROM users WHERE id = ${userId}`
Fix: Use parameterized queries
```

**Performance Issue:**
```
⚠️ WARNING: N+1 query pattern
File: src/services/orders.js:23
Issue: Fetching related items in a loop
Fix: Use batch query or eager loading
```

## Notes

- Always explain WHY something is an issue
- Provide concrete fix suggestions
- Be constructive, not critical
- Prioritize issues by severity
- Consider the context and constraints
