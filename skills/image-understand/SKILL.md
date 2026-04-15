---
name: image-understand
description: "多模态 AI 图片理解工具。将图片发送给支持 vision 的 LLM 模型，获取图片的语义理解和详细描述。可分析截图、设计稿、图表、报错信息等。"
version: "1.0.0"
author: "DunCrew"
tags:
  - vision
  - image-understanding
  - multimodal
keywords:
  - 图片理解
  - 视觉分析
  - 截图分析
  - 图片描述
  - image understanding
  - vision
  - 看图
  - 分析图片
dangerLevel: safe
inputs:
  - name: imagePath
    type: string
    required: true
    description: "图片文件路径（本地绝对路径）"
  - name: prompt
    type: string
    required: false
    description: "分析指令/问题"
  - name: detail
    type: string
    required: false
    description: "视觉精度: low / high / auto"
metadata:
  openclaw:
    emoji: "👁️"
    primaryEnv: "shell"
---

# Image Understand

多模态 AI 图片理解工具，使用 LLM 的 vision 能力分析图片内容。

## Instructions

使用 `imageUnderstand` 工具让 AI 理解图片内容。与 OCR 不同，此工具不仅能提取文字，还能理解 UI 布局、图表含义、设计意图等语义信息。

### 使用场景

- **分析报错截图**: 理解错误对话框、控制台报错的含义
- **解读设计稿**: 描述 UI 布局、配色、元素关系
- **理解图表**: 解读数据可视化图表的含义和趋势
- **代码截图**: 分析截图中的代码逻辑

### 前置要求

- chat 通道绑定的模型需支持 vision（如 GPT-4o、Claude 3.5 Sonnet、Gemini Pro Vision 等）
- 如果模型不支持 vision，会返回错误并建议使用 ocrExtract 替代

### 典型工作流

1. 使用 `screenCapture` 截取目标内容
2. 使用 `imageUnderstand` 进行语义理解
3. 如需精确文字，配合 `ocrExtract` 提取

## Examples

分析截图内容:
```json
{"imagePath": "C:/temp/screenshots/error.png", "prompt": "这个错误窗口在说什么？如何解决？"}
```

解读图表:
```json
{"imagePath": "C:/charts/sales.png", "prompt": "请分析这个销售数据图表的趋势"}
```

使用低精度模式（节省 token）:
```json
{"imagePath": "C:/screenshots/overview.png", "prompt": "简要描述这个页面的布局", "detail": "low"}
```

## Notes

- 使用主 chat 通道配置，不需要额外的 vision 通道
- 图片通过 base64 编码传输，大文件可能消耗较多 token
- detail 参数: low (节省 token) / high (高精度) / auto (模型自动判断)
- 如果理解失败，可降级使用 ocrExtract 提取文字
