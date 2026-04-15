---
name: ocr-extract
description: "智能 OCR 文字提取工具。从图片中识别文字，支持中英文混排、图像预处理（灰度化+二值化提升识别率）、表格结构还原为 Markdown 格式。"
version: "1.0.0"
author: "DunCrew"
tags:
  - ocr
  - text-extraction
  - image-processing
keywords:
  - OCR
  - 文字识别
  - 图片文字
  - 表格识别
  - text recognition
  - 截图识别
dangerLevel: safe
inputs:
  - name: imagePath
    type: string
    required: true
    description: "图片文件路径"
  - name: language
    type: string
    required: false
    description: "Tesseract 语言代码，默认 eng+chi_sim"
  - name: outputFormat
    type: string
    required: false
    description: "输出格式: text / markdown"
  - name: preprocess
    type: boolean
    required: false
    description: "是否图像预处理，默认 true"
metadata:
  openclaw:
    emoji: "🔍"
    primaryEnv: "python"
    requires:
      bins: ["python3", "tesseract"]
---

# OCR Extract

智能 OCR 文字提取工具，比 parseFile 的 OCR 功能更强大。

## Instructions

使用 `ocrExtract` 工具从图片中提取文字。支持预处理优化和表格还原。

### 功能特点

- **图像预处理**: 灰度化 + Otsu 自适应二值化，显著提升低对比度图片的识别率
- **小图放大**: 宽度 < 300px 的图片自动放大 2 倍
- **表格还原**: markdown 模式下检测列结构，还原为 Markdown 表格
- **多语言**: 支持 Tesseract 所有语言包

### 与 parseFile 的区别

| 特性 | parseFile | ocrExtract |
|------|-----------|------------|
| 图像预处理 | 无 | 灰度+二值化 |
| 表格识别 | 不支持 | Markdown 表格 |
| 语言选择 | 固定 | 可配置 |
| 预处理开关 | 无 | 可控 |

## Examples

基本文字提取:
```json
{"imagePath": "C:/screenshots/test.png"}
```

日文识别:
```json
{"imagePath": "C:/screenshots/jp.png", "language": "jpn"}
```

表格识别:
```json
{"imagePath": "C:/screenshots/table.png", "outputFormat": "markdown"}
```

不做预处理（已经是高清图片时）:
```json
{"imagePath": "C:/screenshots/hd.png", "preprocess": false}
```

## Notes

- 依赖系统安装的 Tesseract-OCR 引擎
- 默认支持英文 + 简体中文 (eng+chi_sim)
- 表格还原是启发式的，复杂表格可能不完美
- 对于需要语义理解的场景，建议配合 imageUnderstand 使用
