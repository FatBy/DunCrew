"""DunCrew Server - Web Search + Fetch Tools Mixin"""
from __future__ import annotations

import re
import sys
import json
import os
import time
import urllib.request
import urllib.error
import socket
from pathlib import Path

from server.constants import HAS_TRAFILATURA, HAS_BS4
from server.state import _browser_manager
from server.utils import safe_utf8_truncate

class WebMixin:
    """Web Search + Fetch Tools Mixin"""

    # ================================================================
    # 预编译正则: 搜索结果 HTML 解析
    # ================================================================
    _RE_STRIP_HTML = re.compile(r'<[^>]+>')

    # 搜索结果缓存 (query -> (timestamp, result_str))
    _web_search_cache: dict[str, tuple[float, str]] = {}
    _WEB_SEARCH_CACHE_TTL = 300  # 5 分钟

    def _tool_web_search(self, args: dict) -> str:
        """网页搜索 (并发竞速: SearXNG + Bing/搜狗/百度 同时发起，最快返回)"""
        import urllib.request
        import urllib.parse
        from concurrent.futures import ThreadPoolExecutor, as_completed

        query = args.get('query', args.get('q', ''))
        if not query:
            raise ValueError("Search query is required")

        # ── 缓存检查: 5 分钟内相同查询直接返回 ──
        cache_key = query.strip().lower()
        cached = self._web_search_cache.get(cache_key)
        if cached:
            ts, result = cached
            if time.time() - ts < self._WEB_SEARCH_CACHE_TTL:
                print(f"[webSearch] 命中缓存: '{query}'", file=sys.stderr)
                return result
            else:
                del self._web_search_cache[cache_key]

        def _cache_and_return(result_str: str) -> str:
            """缓存搜索结果并返回"""
            self._web_search_cache[cache_key] = (time.time(), result_str)
            # 防止缓存无限增长: 超过 100 条时清理最旧的
            if len(self._web_search_cache) > 100:
                oldest_key = min(self._web_search_cache, key=lambda k: self._web_search_cache[k][0])
                del self._web_search_cache[oldest_key]
            return result_str

        encoded_query = urllib.parse.quote(query)
        ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        mobile_ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
        strip_html = self._RE_STRIP_HTML.sub
        common_headers = {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        }

        # httpx 客户端 (精确超时: 连接3秒 + 读取5秒，避免 urllib DNS 卡死问题)
        import httpx
        _http_timeout = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=3.0)
        # 检测代理
        _proxy_url = (
            os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY')
            or os.environ.get('https_proxy') or os.environ.get('http_proxy')
            or os.environ.get('ALL_PROXY') or os.environ.get('all_proxy')
        )

        def _http_get(url: str, headers: dict | None = None, timeout: httpx.Timeout | None = None, use_proxy: bool = False) -> str:
            """统一 HTTP GET，返回响应文本"""
            h = {**common_headers, **(headers or {})}
            t = timeout or _http_timeout
            proxy = _proxy_url if (use_proxy and _proxy_url) else None
            with httpx.Client(timeout=t, proxy=proxy, follow_redirects=True, verify=False) as client:
                resp = client.get(url, headers=h)
                resp.raise_for_status()
                return resp.text

        # ----------------------------------------------------------------
        # 各搜索源实现 (每个返回 (source_label, results_list) 或抛异常)
        # ----------------------------------------------------------------

        def _log_search_health(engine: str, html_len: int, items_found: int, valid_results: int) -> None:
            """解析健康检测: HTML 非空但解析失败时告警，可能是引擎改版"""
            if html_len > 1000 and items_found == 0:
                print(f"[SearchHealth] {engine}: HTML {html_len} bytes 但选择器匹配 0 项 — 可能需要更新选择器", file=sys.stderr)
            elif items_found > 0 and valid_results == 0:
                print(f"[SearchHealth] {engine}: 匹配到 {items_found} 项但提取 0 条有效结果 — 选择器或过滤条件可能需要调整", file=sys.stderr)
            elif valid_results > 0:
                print(f"[webSearch] {engine}: 解析正常 ({valid_results}/{items_found} 有效)", file=sys.stderr)

        def _search_searxng(searxng_url: str) -> tuple[str, list[str]]:
            """SearXNG 搜索"""
            parsed_host = urllib.parse.urlparse(searxng_url).netloc
            is_local = searxng_url.startswith('http://localhost') or searxng_url.startswith('http://127.')
            if is_local:
                # 快速探测: 1 秒内无响应就跳过
                with httpx.Client(timeout=httpx.Timeout(connect=1.0, read=1.0, write=1.0, pool=1.0)) as c:
                    c.head(searxng_url)
            api_url = f"{searxng_url}/search?q={encoded_query}&format=json&language=zh-CN"
            t = httpx.Timeout(connect=2.0, read=4.0, write=2.0, pool=2.0) if is_local else httpx.Timeout(connect=3.0, read=6.0, write=3.0, pool=3.0)
            text = _http_get(api_url, headers={'Accept': 'application/json'}, timeout=t)
            data = json.loads(text)
            results = []
            for item in data.get('results', [])[:8]:
                title = item.get('title', '').strip()
                link = item.get('url', '').strip()
                snippet = (item.get('content', '') or '').strip()[:200]
                engine = item.get('engine', '')
                if title and link:
                    entry = f"{len(results)+1}. {title}\n   {link}"
                    if snippet:
                        entry += f"\n   {snippet}"
                    if engine:
                        entry += f"\n   [来源: {engine}]"
                    results.append(entry)
            if not results:
                raise ValueError(f"SearXNG ({parsed_host}) 返回 0 条结果")
            label = 'SearXNG' if is_local else f'SearXNG ({parsed_host})'
            return label, results[:6]

        def _search_bing() -> tuple[str, list[str]]:
            """Bing CN 搜索 (BeautifulSoup + 选择器瀑布)"""
            import urllib.request as _ureq
            from bs4 import BeautifulSoup as _BS
            bing_url = f"https://cn.bing.com/search?q={encoded_query}&ensearch=0"
            req = _ureq.Request(bing_url, headers=common_headers)
            with _ureq.urlopen(req, timeout=8) as response:
                html = response.read().decode('utf-8', errors='ignore')
            soup = _BS(html, 'html.parser')
            results = []
            # 选择器瀑布: 依次尝试，命中即停
            BING_ITEM_SELECTORS = [
                'li.b_algo',                        # 当前主结构
                'li[class*="b_algo"]',              # class 变体
                'ol#b_results > li',                # 最宽松兜底
            ]
            BING_TITLE_SELECTORS = [
                'h2 a[href]',                       # 当前标题
                'h3 a[href]',                       # h2→h3 变体
                '.b_title a[href]',                 # class 变体
                'a[href^="http"]',                  # 最宽松兜底
            ]
            BING_SNIPPET_SELECTORS = [
                'p.b_lineclamp2',                   # 当前摘要
                'p[class*="b_lineclamp"]',          # 变体
                '.b_caption p',                     # caption 内 p
                'span[class*="algoSlug"]',          # 新版 slug
                '.b_snippet',                       # snippet 类
            ]
            items = []
            for sel in BING_ITEM_SELECTORS:
                items = soup.select(sel)
                if items:
                    break
            for item in items[:8]:
                link_tag = None
                for tsel in BING_TITLE_SELECTORS:
                    link_tag = item.select_one(tsel)
                    if link_tag:
                        break
                if not link_tag:
                    continue
                link = link_tag.get('href', '')
                if not link or not link.startswith('http'):
                    continue
                title = link_tag.get_text(strip=True)
                if not title or len(title) < 4:
                    continue
                if 'bing.com' in link or 'microsoft.com/account' in link:
                    continue
                snippet = ''
                for ssel in BING_SNIPPET_SELECTORS:
                    snip_tag = item.select_one(ssel)
                    if snip_tag:
                        snippet = snip_tag.get_text(strip=True)[:200]
                        break
                entry = f"{len(results)+1}. {title}\n   {link}"
                if snippet:
                    entry += f"\n   {snippet}"
                results.append(entry)
                if len(results) >= 6:
                    break
            _log_search_health('Bing', len(html), len(items), len(results))
            if not results:
                raise ValueError(f"Bing 返回 HTML ({len(html)} bytes) 但解析出 0 条结果")
            return 'Bing', results[:6]

        def _search_sogou() -> tuple[str, list[str]]:
            """搜狗搜索 (BeautifulSoup + 选择器瀑布)"""
            from bs4 import BeautifulSoup as _BS
            html = _http_get(f"https://www.sogou.com/web?query={encoded_query}")
            soup = _BS(html, 'html.parser')
            results = []
            SOGOU_ITEM_SELECTORS = [
                'div.vrwrap',                       # 主结构
                'div.rb',                           # 备用结构
                'div[class*="vrwrap"]',             # class 变体
                'div.results > div',                # 最宽松
            ]
            items = []
            for sel in SOGOU_ITEM_SELECTORS:
                items = soup.select(sel)
                if items:
                    break
            for item in items[:10]:
                link_tag = item.select_one('h3 a[href]') or item.select_one('a[href]')
                if not link_tag:
                    continue
                raw_link = link_tag.get('href', '')
                title = link_tag.get_text(strip=True)
                if not title or len(title) < 4:
                    continue
                link = raw_link
                if link.startswith('/'):
                    link = 'https://www.sogou.com' + link
                if 'sogou.com' in link and '/link?' not in link:
                    continue
                snippet = ''
                snip_tag = item.select_one('p') or item.select_one('.ft')
                if snip_tag:
                    snippet = snip_tag.get_text(strip=True)[:200]
                entry = f"{len(results)+1}. {title}\n   {link}"
                if snippet:
                    entry += f"\n   {snippet}"
                results.append(entry)
                if len(results) >= 6:
                    break
            _log_search_health('搜狗', len(html), len(items), len(results))
            if not results:
                raise ValueError(f"搜狗返回 HTML ({len(html)} bytes) 但解析出 0 条结果")
            return '搜狗', results

        def _search_baidu() -> tuple[str, list[str]]:
            """百度搜索 (BeautifulSoup + 选择器瀑布)"""
            import urllib.request as _ureq
            from bs4 import BeautifulSoup as _BS
            baidu_url = f"https://www.baidu.com/s?wd={encoded_query}&rn=10"
            req = _ureq.Request(baidu_url, headers={**common_headers, 'Cookie': 'BAIDUID=0:FG=1'})
            with _ureq.urlopen(req, timeout=8) as response:
                html = response.read().decode('utf-8', errors='ignore')
            if '安全验证' in html or 'captcha' in html.lower() or 'verify' in html.lower():
                raise ValueError("百度触发了安全验证码")
            soup = _BS(html, 'html.parser')
            results = []
            BAIDU_ITEM_SELECTORS = [
                'div.result',                       # 经典结构
                'div[class*="result"]',             # class 变体
                'div.c-container',                  # 新版容器
                'div[class*="c-container"]',        # 变体
            ]
            items = []
            for sel in BAIDU_ITEM_SELECTORS:
                items = soup.select(sel)
                if items:
                    break
            for item in items[:10]:
                # 标题: 优先 h3 > a, 降级到 .t > a, 再降级到 .c-title-text
                link_tag = (
                    item.select_one('h3 a[href]')
                    or item.select_one('.t a[href]')
                    or item.select_one('a[href^="http"]')
                )
                if not link_tag:
                    continue
                link = link_tag.get('href', '')
                if not link.startswith('http'):
                    continue
                title = link_tag.get_text(strip=True)
                # 百度有时标题在 span.c-title-text 里
                if not title:
                    title_span = item.select_one('span[class*="c-title"]')
                    if title_span:
                        title = title_span.get_text(strip=True)
                if not title or len(title) < 4:
                    continue
                snippet = ''
                snip_tag = (
                    item.select_one('span[class*="content-right"]')
                    or item.select_one('.c-abstract')
                    or item.select_one('span[class*="c-color-text"]')
                )
                if snip_tag:
                    snippet = snip_tag.get_text(strip=True)[:200]
                entry = f"{len(results)+1}. {title}\n   {link}"
                if snippet:
                    entry += f"\n   {snippet}"
                results.append(entry)
                if len(results) >= 6:
                    break
            _log_search_health('百度', len(html), len(items), len(results))
            if not results:
                raise ValueError(f"百度返回 HTML ({len(html)} bytes) 但解析出 0 条结果")
            return '百度', results

        def _search_360() -> tuple[str, list[str]]:
            """360 搜索 (BeautifulSoup + 选择器瀑布)"""
            from bs4 import BeautifulSoup as _BS
            html = _http_get(f"https://www.so.com/s?q={encoded_query}")
            soup = _BS(html, 'html.parser')
            results = []
            ITEMS_360_SELECTORS = [
                'li[class*="res-list"]',            # 主列表项
                'h3.res-title',                     # 直接找标题
                'ul.result > li',                   # 结果列表
            ]
            items = []
            for sel in ITEMS_360_SELECTORS:
                items = soup.select(sel)
                if items:
                    break
            for item in items[:10]:
                link_tag = item.select_one('h3 a[href]') or item.select_one('a[href^="http"]')
                # 如果 item 本身就是 h3，直接找内部 a
                if not link_tag and item.name == 'h3':
                    link_tag = item.select_one('a[href]')
                if not link_tag:
                    continue
                link = link_tag.get('href', '')
                title = link_tag.get_text(strip=True)
                if not title or len(title) < 4:
                    continue
                snippet = ''
                snip_tag = item.select_one('p[class*="res-desc"]') or item.select_one('p')
                if snip_tag:
                    snippet = snip_tag.get_text(strip=True)[:200]
                entry = f"{len(results)+1}. {title}\n   {link}"
                if snippet:
                    entry += f"\n   {snippet}"
                results.append(entry)
                if len(results) >= 6:
                    break
            _log_search_health('360', len(html), len(items), len(results))
            if not results:
                raise ValueError(f"360 返回 HTML ({len(html)} bytes) 但解析出 0 条结果")
            return '360', results

        def _search_google() -> tuple[str, list[str]]:
            """Google 搜索 (BeautifulSoup, 需要代理)"""
            from bs4 import BeautifulSoup as _BS
            if not _proxy_url:
                raise ValueError("无代理，跳过 Google")
            html = _http_get(
                f"https://www.google.com/search?q={encoded_query}&hl=zh-CN&num=8",
                use_proxy=True,
            )
            soup = _BS(html, 'html.parser')
            results = []
            # Google 结果在 a[href^="/url?q="] 内包含 h3
            for a_tag in soup.select('a[href*="/url?q="]'):
                h3 = a_tag.select_one('h3')
                if not h3:
                    continue
                raw_href = a_tag.get('href', '')
                # 从 /url?q=https://...&sa= 中提取真实 URL
                if '/url?q=' in raw_href:
                    link = urllib.parse.unquote(raw_href.split('/url?q=')[1].split('&')[0])
                else:
                    continue
                title = h3.get_text(strip=True)
                if not title or len(title) < 4 or 'google.com' in link:
                    continue
                results.append(f"{len(results)+1}. {title}\n   {link}")
                if len(results) >= 6:
                    break
            _log_search_health('Google', len(html), 0, len(results))
            if not results:
                raise ValueError(f"Google 返回 HTML ({len(html)} bytes) 但解析出 0 条结果")
            return 'Google', results

        def _search_ddg() -> tuple[str, list[str]]:
            """DuckDuckGo 搜索 (BeautifulSoup)"""
            from bs4 import BeautifulSoup as _BS
            html = _http_get(f"https://html.duckduckgo.com/html/?q={encoded_query}")
            soup = _BS(html, 'html.parser')
            results = []
            # DDG HTML 版: 每个结果在 div.result 内
            DDG_SELECTORS = [
                'div.result',                       # 主结构
                'div[class*="result"]',             # 变体
            ]
            items = []
            for sel in DDG_SELECTORS:
                items = soup.select(sel)
                if items:
                    break
            for item in items[:6]:
                link_tag = item.select_one('a.result__a') or item.select_one('a[href]')
                if not link_tag:
                    continue
                raw_link = link_tag.get('href', '')
                title = link_tag.get_text(strip=True)
                # DDG 把真实 URL 放在 uddg= 参数里
                if 'uddg=' in raw_link:
                    link = urllib.parse.unquote(raw_link.split('uddg=')[-1].split('&')[0])
                else:
                    link = raw_link
                if not title:
                    continue
                snippet = ''
                snip_tag = item.select_one('a.result__snippet') or item.select_one('.result__snippet')
                if snip_tag:
                    snippet = snip_tag.get_text(strip=True)[:200]
                entry = f"{len(results)+1}. {title}\n   {link}"
                if snippet:
                    entry += f"\n   {snippet}"
                results.append(entry)
            _log_search_health('DuckDuckGo', len(html), len(items), len(results))
            if not results:
                raise ValueError("DuckDuckGo 返回 0 条结果")
            return 'DuckDuckGo', results

        # 所有阶段共享的"已尝试源"列表 (用于最终错误报告)
        tried_sources: list[str] = []

        # ----------------------------------------------------------------
        # 阶段 0: Tavily API 优先 (结构化 JSON，最稳定)
        # ----------------------------------------------------------------
        tavily_key = os.environ.get('TAVILY_API_KEY', '').strip()
        if tavily_key:
            tried_sources.append('Tavily')
            try:
                import httpx as _hx
                _tavily_timeout = _hx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
                proxy = _proxy_url if _proxy_url else None
                with _hx.Client(timeout=_tavily_timeout, proxy=proxy, verify=False) as tc:
                    tavily_r = tc.post('https://api.tavily.com/search', json={
                        'api_key': tavily_key,
                        'query': query,
                        'max_results': 8,
                        'include_answer': True,
                        'search_depth': 'basic',
                    })
                    tavily_r.raise_for_status()
                    tavily_data = tavily_r.json()

                tavily_results: list[str] = []
                tavily_answer = (tavily_data.get('answer') or '').strip()

                for item in tavily_data.get('results', [])[:8]:
                    title = (item.get('title') or '').strip()
                    url = (item.get('url') or '').strip()
                    snippet = (item.get('content') or '').strip()[:300]
                    score = item.get('score', 0)
                    if title and url:
                        entry = f"{len(tavily_results)+1}. {title}\n   {url}"
                        if snippet:
                            entry += f"\n   {snippet}"
                        if score:
                            entry += f"\n   [相关度: {score:.2f}]"
                        tavily_results.append(entry)

                if tavily_results:
                    header = f"搜索 '{query}' 的结果 (Tavily):\n"
                    if tavily_answer:
                        header += f"\nAI 摘要: {tavily_answer}\n"
                    header += "\n" + "\n\n".join(tavily_results)
                    print(f"[webSearch] Tavily 成功返回 {len(tavily_results)} 条结果", file=sys.stderr)
                    return _cache_and_return(header)

                print("[webSearch] Tavily 返回 0 条结果，降级到下一阶段", file=sys.stderr)
            except Exception as e:
                print(f"[webSearch] Tavily 失败: {e}", file=sys.stderr)

        # ----------------------------------------------------------------
        # 阶段 1: SearXNG 优先 (仅尝试本地/用户配置的实例，快速探测)
        # ----------------------------------------------------------------
        searxng_urls: list[str] = []
        env_searxng = os.environ.get('SEARXNG_URL', '').strip()
        if env_searxng:
            searxng_urls.append(env_searxng)
        # 只尝试本地实例 (远程公共实例国内基本不可达，白白浪费时间)
        searxng_urls.append('http://localhost:8888')
        # 去重
        searxng_urls = list(dict.fromkeys(searxng_urls))

        for sxng_url in searxng_urls:
            host = urllib.parse.urlparse(sxng_url).netloc
            tried_sources.append(f'SearXNG({host})')
            try:
                label, results = _search_searxng(sxng_url)
                print(f"[webSearch] {label} 成功返回 {len(results)} 条结果", file=sys.stderr)
                return _cache_and_return(f"搜索 '{query}' 的结果 ({label}):\n\n" + "\n\n".join(results))
            except Exception as e:
                print(f"[webSearch] SearXNG ({host}) 失败: {e}", file=sys.stderr)

        # ----------------------------------------------------------------
        # 阶段 2: 多源并发搜索 (Bing + 搜狗 + 360 + 百度 + Google，收集合并)
        # ----------------------------------------------------------------
        domestic_sources: list[tuple[str, object]] = [
            ('Bing', _search_bing),
            ('搜狗', _search_sogou),
            ('360', _search_360),
            ('百度', _search_baidu),
        ]
        # 有代理时加入 Google
        if _proxy_url:
            domestic_sources.append(('Google', _search_google))

        all_entries: list[tuple[str, str]] = []  # (label, entry_text)
        with ThreadPoolExecutor(max_workers=len(domestic_sources)) as pool:
            futures = {pool.submit(fn): name for name, fn in domestic_sources}
            try:
                for future in as_completed(futures, timeout=15):
                    name = futures[future]
                    tried_sources.append(name)
                    try:
                        label, results = future.result()
                        print(f"[webSearch] {label} 成功返回 {len(results)} 条结果", file=sys.stderr)
                        for entry in results:
                            all_entries.append((label, entry))
                    except Exception as e:
                        print(f"[webSearch] {name} 失败: {e}", file=sys.stderr)
            except TimeoutError:
                print(f"[webSearch] 国内搜索源阶段超时，使用已收集到的 {len(all_entries)} 条结果", file=sys.stderr)

        if all_entries:
            # 去重: 按 URL 去重，优先保留有摘要(行数多)的条目
            seen_urls: set[str] = set()
            merged: list[str] = []
            # 按条目行数降序排列(行数多 = 有摘要)，优先保留信息更丰富的
            all_entries.sort(key=lambda x: -x[1].count('\n'))
            sources_used: set[str] = set()
            for label, entry in all_entries:
                lines = entry.strip().split('\n')
                url_line = next((l.strip() for l in lines if l.strip().startswith('http')), '')
                if url_line and url_line in seen_urls:
                    continue
                if url_line:
                    seen_urls.add(url_line)
                sources_used.add(label)
                merged.append(entry)
                if len(merged) >= 10:
                    break
            # 重新编号
            renumbered = []
            for i, entry in enumerate(merged, 1):
                # 替换开头的序号
                renumbered.append(re.sub(r'^\d+\.', f'{i}.', entry, count=1))
            sources_label = '+'.join(sorted(sources_used))
            return _cache_and_return(f"搜索 '{query}' 的结果 ({sources_label}, 合并去重):\n\n" + "\n\n".join(renumbered))

        # ----------------------------------------------------------------
        # 阶段 3: DuckDuckGo (国际回退)
        # ----------------------------------------------------------------
        tried_sources.append('DuckDuckGo')
        try:
            label, results = _search_ddg()
            return _cache_and_return(f"搜索 '{query}' 的结果 ({label}):\n\n" + "\n\n".join(results))
        except Exception as e:
            print(f"[webSearch] DuckDuckGo 失败: {e}", file=sys.stderr)

        # ----------------------------------------------------------------
        # 阶段 4: 浏览器渲染兜底 (Playwright)
        # ----------------------------------------------------------------
        if _browser_manager.is_available():
            tried_sources.append('Browser')
            try:
                bing_url = f"https://cn.bing.com/search?q={encoded_query}&ensearch=0"
                result_json = _browser_manager.navigate(bing_url, wait_until='networkidle')
                parsed = json.loads(result_json)
                if parsed.get('status') == 'ok' and parsed.get('text'):
                    text = parsed['text'][:3000]
                    return _cache_and_return(f"搜索 '{query}' 的结果 (浏览器 Bing):\n\n{text}")
            except Exception as e:
                print(f"[webSearch] 浏览器兜底失败: {e}", file=sys.stderr)

        sources_str = '/'.join(tried_sources) if tried_sources else 'None'
        return f"搜索 '{query}' 失败: 所有搜索源均不可用（已尝试: {sources_str}）。建议: 1) 启动本地 SearXNG Docker (端口 8888) 2) 检查网络连接"
    
    def _tool_web_fetch(self, args: dict) -> str:
        """获取网页内容 (智能正文提取，优先使用 trafilatura)"""
        import urllib.request
        import urllib.parse
        import re

        url = args.get('url', '')
        if not url:
            raise ValueError("URL is required")

        # 确保 URL 有协议
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url

        ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

        try:
            # ── trafilatura 优先路径: 智能提取正文 ──
            if HAS_TRAFILATURA:
                downloaded = trafilatura.fetch_url(url)
                if downloaded:
                    text = trafilatura.extract(
                        downloaded,
                        include_links=False,
                        include_tables=True,
                        favor_recall=True,
                    )
                    if text and len(text.strip()) > 100:
                        title = ''
                        title_match = re.search(r'<title[^>]*>([^<]+)</title>', downloaded, re.IGNORECASE)
                        if title_match:
                            title = title_match.group(1).strip()
                        result = f"URL: {url}\n"
                        if title:
                            result += f"标题: {title}\n"
                        result += f"\n{text[:6000]}"
                        return result

            # ── 降级路径: 正则剥离 (trafilatura 未安装或提取失败) ──
            req = urllib.request.Request(url, headers={
                'User-Agent': ua,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            })

            with urllib.request.urlopen(req, timeout=15) as response:
                content_type = response.headers.get('Content-Type', '')
                if 'text/html' not in content_type and 'text/plain' not in content_type:
                    return f"无法读取此类型的内容: {content_type}"
                html = response.read().decode('utf-8', errors='ignore')

            # 提取 title
            title_match = re.search(r'<title[^>]*>([^<]*)</title>', html, re.IGNORECASE)
            title = title_match.group(1).strip() if title_match else ''

            # 移除非正文标签 (比原来多去掉 nav/footer/header/aside)
            for tag in ('script', 'style', 'head', 'nav', 'footer', 'header', 'aside'):
                html = re.sub(rf'<{tag}[^>]*>[\s\S]*?</{tag}>', '', html, flags=re.IGNORECASE)

            # 尝试优先提取 <article> 或 <main> 区域
            article_match = re.search(r'<(?:article|main)[^>]*>([\s\S]*?)</(?:article|main)>', html, re.IGNORECASE)
            if article_match:
                html = article_match.group(1)

            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            text = text[:4000]

            result = f"URL: {url}\n"
            if title:
                result += f"标题: {title}\n"
            result += f"\n内容摘要:\n{text}"
            return result

        except urllib.error.HTTPError as e:
            return f"HTTP 错误 {e.code}: {e.reason}"
        except urllib.error.URLError as e:
            return f"无法访问 URL: {e.reason}"
        except Exception as e:
            return f"获取网页失败: {str(e)}"
    

