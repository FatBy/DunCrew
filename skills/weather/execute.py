#!/usr/bin/env python3
"""
Weather Skill Plugin for DunCrew
Reads location from stdin (JSON), outputs weather report to stdout.

Protocol:
  - stdin: {"location": "Beijing"}
  - stdout: Weather report string
  - stderr: Error messages
  - exit 0: success, non-zero: error
"""

import sys
import json
import urllib.request
import urllib.parse


def query_weather(location: str) -> str:
    """Query weather using wttr.in API (no auth required)"""
    encoded_location = urllib.parse.quote(location)

    try:
        # Get detailed weather info
        url = f"https://wttr.in/{encoded_location}?format=j1"
        req = urllib.request.Request(url, headers={'User-Agent': 'curl/7.68.0'})

        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))

        current = data.get('current_condition', [{}])[0]
        area = data.get('nearest_area', [{}])[0]

        city_name = area.get('areaName', [{}])[0].get('value', location)
        country = area.get('country', [{}])[0].get('value', '')

        result = f"""天气查询结果 - {city_name}, {country}

当前温度: {current.get('temp_C', 'N/A')}°C (体感: {current.get('FeelsLikeC', 'N/A')}°C)
天气状况: {current.get('weatherDesc', [{}])[0].get('value', 'N/A')}
湿度: {current.get('humidity', 'N/A')}%
风速: {current.get('windspeedKmph', 'N/A')} km/h ({current.get('winddir16Point', '')})
能见度: {current.get('visibility', 'N/A')} km
紫外线指数: {current.get('uvIndex', 'N/A')}
"""
        return result

    except Exception as e:
        # Fallback to simple format
        try:
            simple_url = f"https://wttr.in/{encoded_location}?format=%l:+%c+%t+(%f)+%h+%w"
            req = urllib.request.Request(simple_url, headers={'User-Agent': 'curl/7.68.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.read().decode('utf-8')
        except Exception:
            return f"无法查询 {location} 的天气: {str(e)}"


def main():
    try:
        # Read JSON from stdin
        input_json = sys.stdin.read()
        args = json.loads(input_json)

        location = args.get('location', args.get('city', ''))
        if not location:
            print("Error: location/city is required", file=sys.stderr)
            sys.exit(1)

        result = query_weather(location)
        print(result)
        sys.exit(0)

    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
