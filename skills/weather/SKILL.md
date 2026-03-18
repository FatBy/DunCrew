---
name: weather
description: "Query weather information for any location."
version: "1.0.0"
author: "DunCrew"
executable: execute.py
runtime: python
dangerLevel: safe
inputs:
  location:
    type: string
    required: true
    description: "City name (e.g., Beijing, Tokyo, London)"
keywords: [weather, temperature, forecast, rain, sunny, cloudy, 天气, 气温, 预报, 下雨, 晴天, 多云, 温度]
metadata:
  openclaw:
    emoji: "☁️"
    primaryEnv: "python"
---

# Weather Skill

Query weather information for any location.

## Usage

```json
{"thought": "...", "tool": "weather", "args": {"location": "city name"}}
```

## Examples

### Direct Query
User: "惠州今天天气怎么样"
```json
{"thought": "用户想知道惠州的天气，直接查询", "tool": "weather", "args": {"location": "惠州"}}
```

### Multi-location Comparison
User: "对比一下北京和上海的天气"
Step 1:
```json
{"thought": "需要分别查询两个城市天气来对比，先查北京", "tool": "weather", "args": {"location": "北京"}}
```
Step 2:
```json
{"thought": "北京天气已获取，现在查上海", "tool": "weather", "args": {"location": "上海"}}
```
Step 3: Compare and summarize both cities' weather.

### Implicit Query
User: "今天出门需要带伞吗？我在深圳"
```json
{"thought": "用户想知道是否需要带伞，本质是查天气中的降雨信息。用户在深圳。", "tool": "weather", "args": {"location": "深圳"}}
```

## Notes

- Uses wttr.in API (no authentication required)
- Returns current conditions and forecast
- Supports Chinese and English city names
