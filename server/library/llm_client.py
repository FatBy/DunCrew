"""LLM API 客户端 (OpenAI 兼容格式)

独立于 DunCrew 前端的 LLM 配置, 支持:
- 阿里云 DashScope
- OpenAI
- Ollama 本地
- 任何 OpenAI 兼容 API
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

import httpx

from .config import LLMConfig
from .models import TokenUsage

logger = logging.getLogger(__name__)


class LLMClient:
    """LLM API 客户端"""

    def __init__(self, config: LLMConfig):
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.config.timeout, connect=10),
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                },
            )
        return self._client

    async def chat(
        self,
        messages: list[dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> tuple[str, TokenUsage]:
        """
        发送 chat completion 请求.
        返回 (response_text, token_usage).
        """
        client = await self._get_client()
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"

        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        last_error = None
        for attempt in range(self.config.retry_limit + 1):
            try:
                start = time.perf_counter()
                resp = await client.post(url, json=payload)
                elapsed_ms = int((time.perf_counter() - start) * 1000)

                if resp.status_code != 200:
                    error_text = resp.text[:500]
                    logger.warning(
                        "LLM API %d (attempt %d/%d): %s",
                        resp.status_code, attempt + 1,
                        self.config.retry_limit + 1, error_text,
                    )
                    last_error = RuntimeError(f"LLM API error {resp.status_code}: {error_text}")
                    if resp.status_code in (429, 500, 502, 503):
                        # 可重试的错误
                        await _sleep_backoff(attempt)
                        continue
                    raise last_error

                data = resp.json()
                text = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                token_usage = TokenUsage(
                    input_tokens=usage.get("prompt_tokens", 0),
                    output_tokens=usage.get("completion_tokens", 0),
                )

                logger.debug(
                    "LLM 响应: %d ms, %d+%d tokens",
                    elapsed_ms, token_usage.input_tokens, token_usage.output_tokens,
                )
                return text, token_usage

            except httpx.TimeoutException as e:
                logger.warning("LLM API 超时 (attempt %d): %s", attempt + 1, e)
                last_error = e
                if attempt < self.config.retry_limit:
                    await _sleep_backoff(attempt)
                    continue
            except httpx.HTTPError as e:
                logger.warning("LLM API 网络错误 (attempt %d): %s", attempt + 1, e)
                last_error = e
                if attempt < self.config.retry_limit:
                    await _sleep_backoff(attempt)
                    continue

        raise RuntimeError(f"LLM API 调用失败 (重试 {self.config.retry_limit} 次后): {last_error}")

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None


async def _sleep_backoff(attempt: int):
    """指数退避"""
    import asyncio
    delay = min(2 ** attempt, 10)
    await asyncio.sleep(delay)
