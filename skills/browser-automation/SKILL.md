---
name: browser-automation
description: "Playwright-based browser automation for web interaction"
version: "1.0.0"
author: "DunCrew"
executable: execute.py
runtime: python
tools:
  - toolName: browser_navigate
    description: "Navigate browser to a URL or perform navigation actions (back, forward, reload)"
    dangerLevel: medium
    inputs:
      url:
        type: string
        required: false
        description: "URL to navigate to"
      action:
        type: string
        required: false
        enum: [goto, back, forward, reload]
        default: goto
        description: "Navigation action"
      wait_until:
        type: string
        required: false
        enum: [load, domcontentloaded, networkidle]
        default: domcontentloaded
        description: "Wait until this event before continuing"
      timeout:
        type: integer
        required: false
        default: 30000
        description: "Navigation timeout in milliseconds"
    keywords: [浏览器, 打开, 访问, 网页, browser, navigate, open, url, website]
  - toolName: browser_click
    description: "Click on an element identified by selector or text"
    dangerLevel: medium
    inputs:
      selector:
        type: string
        required: false
        description: "CSS selector or XPath of the element"
      text:
        type: string
        required: false
        description: "Text content to find and click"
      button:
        type: string
        required: false
        enum: [left, right, middle]
        default: left
        description: "Mouse button to use"
      click_count:
        type: integer
        required: false
        default: 1
        description: "Number of clicks (2 for double-click)"
      timeout:
        type: integer
        required: false
        default: 10000
        description: "Timeout for finding element"
    keywords: [点击, click, button, 按钮, 链接]
  - toolName: browser_fill
    description: "Fill in form fields (input, textarea, select)"
    dangerLevel: medium
    inputs:
      selector:
        type: string
        required: false
        description: "CSS selector of the input element"
      label:
        type: string
        required: false
        description: "Label text associated with the input"
      placeholder:
        type: string
        required: false
        description: "Placeholder text of the input"
      value:
        type: string
        required: true
        description: "Value to fill in"
      clear:
        type: boolean
        required: false
        default: true
        description: "Clear existing content before filling"
      press_enter:
        type: boolean
        required: false
        default: false
        description: "Press Enter after filling"
    keywords: [填写, 输入, fill, input, type, 表单, form]
  - toolName: browser_extract
    description: "Extract content from the page (text, links, tables, etc.)"
    dangerLevel: safe
    inputs:
      selector:
        type: string
        required: false
        description: "CSS selector to extract from (default: whole page)"
      extract_type:
        type: string
        required: false
        enum: [text, html, links, images, table, attributes]
        default: text
        description: "Type of content to extract"
      attributes:
        type: array
        required: false
        description: "Attribute names to extract (for extract_type=attributes)"
      limit:
        type: integer
        required: false
        default: 100
        description: "Maximum number of items to extract"
    keywords: [提取, 获取, extract, get, read, 内容, 文本]
  - toolName: browser_screenshot
    description: "Take a screenshot of the page or element"
    dangerLevel: safe
    inputs:
      selector:
        type: string
        required: false
        description: "CSS selector of element to screenshot (default: full page)"
      path:
        type: string
        required: false
        description: "Path to save screenshot (default: auto-generated)"
      full_page:
        type: boolean
        required: false
        default: false
        description: "Capture full scrollable page"
      format:
        type: string
        required: false
        enum: [png, jpeg]
        default: png
        description: "Image format"
      quality:
        type: integer
        required: false
        default: 80
        description: "JPEG quality (0-100)"
    keywords: [截图, screenshot, capture, 拍照, 屏幕]
metadata:
  openclaw:
    emoji: "🌐"
    primaryEnv: "python"
---

# Browser Automation

Playwright-based browser automation for web interaction.

## Tools

### browser_navigate
Navigate browser to a URL or perform navigation actions.

```json
{"tool": "browser_navigate", "args": {"url": "https://example.com"}}
```

### browser_click
Click on an element identified by selector or text.

```json
{"tool": "browser_click", "args": {"text": "Submit"}}
```

### browser_fill
Fill in form fields (input, textarea, select).

```json
{"tool": "browser_fill", "args": {"selector": "#email", "value": "user@example.com"}}
```

### browser_extract
Extract content from the page.

```json
{"tool": "browser_extract", "args": {"extract_type": "links", "limit": 20}}
```

### browser_screenshot
Take a screenshot of the page or element.

```json
{"tool": "browser_screenshot", "args": {"full_page": true, "format": "png"}}
```

## Notes

- Requires Playwright to be installed (`pip install playwright && playwright install`)
- Browser instance is shared across tool calls within a session
- Supports CSS selectors, XPath, and text-based element matching
