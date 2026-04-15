"""DunCrew Server - Browser Automation Manager (Playwright)"""
from __future__ import annotations

import json
import time
import base64
import threading
from pathlib import Path

class BrowserManager:
    """
    Playwright 浏览器管理器 - 懒启动 + 空闲自动回收
    
    提供持久化浏览器会话，支持跨工具调用复用同一个 page。
    首次调用浏览器工具时启动 Chromium，空闲 5 分钟自动关闭。
    """
    IDLE_TIMEOUT = 300  # 空闲超时 (秒)
    
    def __init__(self):
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._lock = threading.Lock()
        self._last_used = 0.0
        self._idle_timer = None
        self._available = None  # None = 未检测, True/False
    
    def is_available(self) -> bool:
        """检测 Playwright 是否可用"""
        if self._available is not None:
            return self._available
        try:
            from playwright.sync_api import sync_playwright
            self._available = True
        except ImportError:
            self._available = False
            print("[BrowserManager] playwright not installed. Run: pip install playwright && playwright install chromium")
        return self._available
    
    def _ensure_browser(self):
        """确保浏览器已启动 (线程安全)"""
        if self._page and not self._page.is_closed():
            self._last_used = time.time()
            return
        
        with self._lock:
            # double check
            if self._page and not self._page.is_closed():
                self._last_used = time.time()
                return
            
            self._cleanup_internal()
            
            from playwright.sync_api import sync_playwright
            
            print("[BrowserManager] Launching Chromium...")
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-blink-features=AutomationControlled',
                ]
            )
            self._context = self._browser.new_context(
                viewport={'width': 1280, 'height': 900},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                locale='zh-CN',
            )
            self._page = self._context.new_page()
            self._last_used = time.time()
            self._schedule_idle_check()
            print("[BrowserManager] Browser ready")
    
    def _schedule_idle_check(self):
        """定时检测空闲超时"""
        if self._idle_timer:
            self._idle_timer.cancel()
        self._idle_timer = threading.Timer(60, self._check_idle)
        self._idle_timer.daemon = True
        self._idle_timer.start()
    
    def _check_idle(self):
        """检查空闲超时，自动关闭浏览器"""
        if self._page and (time.time() - self._last_used > self.IDLE_TIMEOUT):
            print("[BrowserManager] Idle timeout, shutting down browser")
            self.shutdown()
        elif self._page:
            self._schedule_idle_check()
    
    def _cleanup_internal(self):
        """内部清理 (不加锁)"""
        try:
            if self._page and not self._page.is_closed():
                self._page.close()
        except Exception:
            pass
        try:
            if self._context:
                self._context.close()
        except Exception:
            pass
        try:
            if self._browser:
                self._browser.close()
        except Exception:
            pass
        try:
            if self._playwright:
                self._playwright.stop()
        except Exception:
            pass
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None
    
    def shutdown(self):
        """关闭浏览器 (线程安全)"""
        with self._lock:
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None
            self._cleanup_internal()
            print("[BrowserManager] Browser shut down")
    
    # ---- 工具方法 ----
    
    def navigate(self, url: str, wait_until: str = 'domcontentloaded') -> str:
        """导航到 URL，返回页面标题和摘要"""
        self._ensure_browser()
        try:
            self._page.goto(url, wait_until=wait_until, timeout=30000)
            title = self._page.title()
            # 提取可见文本摘要
            text = self._page.evaluate('''() => {
                const sel = document.querySelectorAll('article, main, [role="main"], .content, #content, body');
                const el = sel[0] || document.body;
                return el.innerText.slice(0, 6000);
            }''')
            return json.dumps({
                'status': 'ok',
                'url': self._page.url,
                'title': title,
                'text': text.strip()[:4000] if text else '',
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)
    
    def click(self, selector: str) -> str:
        """点击页面元素"""
        self._ensure_browser()
        try:
            self._page.click(selector, timeout=10000)
            self._page.wait_for_load_state('domcontentloaded', timeout=10000)
            title = self._page.title()
            return json.dumps({
                'status': 'ok',
                'url': self._page.url,
                'title': title,
                'message': f'Clicked "{selector}" successfully',
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)
    
    def fill(self, selector: str, value: str) -> str:
        """填写表单字段"""
        self._ensure_browser()
        try:
            self._page.fill(selector, value, timeout=10000)
            return json.dumps({
                'status': 'ok',
                'message': f'Filled "{selector}" with value',
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)
    
    def extract(self, selector: str = 'body') -> str:
        """提取页面元素文本内容"""
        self._ensure_browser()
        try:
            if selector == 'body':
                text = self._page.evaluate('''() => {
                    const sel = document.querySelectorAll('article, main, [role="main"], .content, #content, body');
                    const el = sel[0] || document.body;
                    return el.innerText;
                }''')
            else:
                el = self._page.query_selector(selector)
                text = el.inner_text() if el else ''
            
            return json.dumps({
                'status': 'ok',
                'url': self._page.url,
                'title': self._page.title(),
                'text': (text or '').strip()[:6000],
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)
    
    def screenshot(self, selector: str = None, full_page: bool = False) -> str:
        """截图并返回 base64 编码"""
        self._ensure_browser()
        try:
            import base64
            if selector:
                el = self._page.query_selector(selector)
                if el:
                    img_bytes = el.screenshot()
                else:
                    return json.dumps({'status': 'error', 'error': f'Selector "{selector}" not found'}, ensure_ascii=False)
            else:
                img_bytes = self._page.screenshot(full_page=full_page)
            
            b64 = base64.b64encode(img_bytes).decode('ascii')
            return json.dumps({
                'status': 'ok',
                'url': self._page.url,
                'title': self._page.title(),
                'image_base64': b64[:200] + '...(truncated)',
                'image_size': len(img_bytes),
                'message': f'Screenshot taken ({len(img_bytes)} bytes)',
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)
    
    def evaluate(self, expression: str) -> str:
        """在页面上执行 JavaScript 表达式"""
        self._ensure_browser()
        try:
            result = self._page.evaluate(expression)
            return json.dumps({
                'status': 'ok',
                'result': result if isinstance(result, (str, int, float, bool, list, dict, type(None))) else str(result),
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)


# 全局浏览器管理器单例

