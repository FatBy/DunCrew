#!/usr/bin/env python3
"""
Playwright browser controller for web automation.
Provides a persistent browser context with page management.
"""

import os
import asyncio
import json
from pathlib import Path
from typing import Dict, Any, Optional, List
from datetime import datetime

try:
    from playwright.async_api import async_playwright, Browser, BrowserContext, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


class BrowserController:
    """Controls a Playwright browser instance with persistent context."""
    
    def __init__(self, headless: bool = True, user_data_dir: Optional[str] = None):
        self.headless = headless
        self.user_data_dir = user_data_dir or str(Path.home() / '.duncrew' / 'browser_data')
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self._screenshots_dir = Path.home() / '.duncrew' / 'screenshots'
        self._screenshots_dir.mkdir(parents=True, exist_ok=True)
    
    async def initialize(self):
        """Initialize the browser."""
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError(
                "Playwright is not installed. "
                "Install with: pip install playwright && playwright install chromium"
            )
        
        self.playwright = await async_playwright().start()
        
        # Launch browser with persistent context
        Path(self.user_data_dir).mkdir(parents=True, exist_ok=True)
        
        self.context = await self.playwright.chromium.launch_persistent_context(
            user_data_dir=self.user_data_dir,
            headless=self.headless,
            viewport={'width': 1280, 'height': 720},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            accept_downloads=True,
        )
        
        # Get or create a page
        if self.context.pages:
            self.page = self.context.pages[0]
        else:
            self.page = await self.context.new_page()
    
    async def close(self):
        """Close the browser."""
        if self.context:
            await self.context.close()
        if self.playwright:
            await self.playwright.stop()
    
    async def navigate(
        self,
        url: Optional[str] = None,
        action: str = 'goto',
        wait_until: str = 'domcontentloaded',
        timeout: int = 30000
    ) -> Dict[str, Any]:
        """Navigate to URL or perform navigation action."""
        if not self.page:
            await self.initialize()
        
        try:
            if action == 'goto':
                if not url:
                    return {'success': False, 'error': 'URL is required for goto action'}
                
                # Ensure URL has protocol
                if not url.startswith(('http://', 'https://')):
                    url = 'https://' + url
                
                response = await self.page.goto(
                    url,
                    wait_until=wait_until,
                    timeout=timeout
                )
                
                return {
                    'success': True,
                    'url': self.page.url,
                    'title': await self.page.title(),
                    'status': response.status if response else None
                }
            
            elif action == 'back':
                await self.page.go_back(wait_until=wait_until, timeout=timeout)
            elif action == 'forward':
                await self.page.go_forward(wait_until=wait_until, timeout=timeout)
            elif action == 'reload':
                await self.page.reload(wait_until=wait_until, timeout=timeout)
            else:
                return {'success': False, 'error': f'Unknown action: {action}'}
            
            return {
                'success': True,
                'url': self.page.url,
                'title': await self.page.title()
            }
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    async def click(
        self,
        selector: Optional[str] = None,
        text: Optional[str] = None,
        button: str = 'left',
        click_count: int = 1,
        timeout: int = 10000
    ) -> Dict[str, Any]:
        """Click on an element."""
        if not self.page:
            await self.initialize()
        
        try:
            if text:
                # Find by text content
                locator = self.page.get_by_text(text, exact=False)
            elif selector:
                locator = self.page.locator(selector)
            else:
                return {'success': False, 'error': 'Either selector or text is required'}
            
            await locator.first.click(
                button=button,
                click_count=click_count,
                timeout=timeout
            )
            
            # Wait for any navigation
            await self.page.wait_for_load_state('domcontentloaded', timeout=5000)
            
            return {
                'success': True,
                'url': self.page.url,
                'message': f'Clicked element'
            }
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    async def fill(
        self,
        value: str,
        selector: Optional[str] = None,
        label: Optional[str] = None,
        placeholder: Optional[str] = None,
        clear: bool = True,
        press_enter: bool = False,
        timeout: int = 10000
    ) -> Dict[str, Any]:
        """Fill a form field."""
        if not self.page:
            await self.initialize()
        
        try:
            if label:
                locator = self.page.get_by_label(label)
            elif placeholder:
                locator = self.page.get_by_placeholder(placeholder)
            elif selector:
                locator = self.page.locator(selector)
            else:
                return {'success': False, 'error': 'Either selector, label, or placeholder is required'}
            
            element = locator.first
            
            if clear:
                await element.clear(timeout=timeout)
            
            await element.fill(value, timeout=timeout)
            
            if press_enter:
                await element.press('Enter')
                await self.page.wait_for_load_state('domcontentloaded', timeout=5000)
            
            return {
                'success': True,
                'message': f'Filled field with value'
            }
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    async def extract(
        self,
        selector: Optional[str] = None,
        extract_type: str = 'text',
        attributes: Optional[List[str]] = None,
        limit: int = 100
    ) -> Dict[str, Any]:
        """Extract content from the page."""
        if not self.page:
            await self.initialize()
        
        try:
            if selector:
                elements = self.page.locator(selector)
            else:
                elements = self.page.locator('body')
            
            if extract_type == 'text':
                text = await elements.first.inner_text()
                return {
                    'success': True,
                    'content': text[:10000],  # Limit text length
                    'url': self.page.url
                }
            
            elif extract_type == 'html':
                html = await elements.first.inner_html()
                return {
                    'success': True,
                    'content': html[:20000],
                    'url': self.page.url
                }
            
            elif extract_type == 'links':
                links = await self.page.eval_on_selector_all(
                    selector or 'a[href]',
                    '''elements => elements.slice(0, ''' + str(limit) + ''').map(el => ({
                        text: el.innerText.trim().slice(0, 100),
                        href: el.href
                    }))'''
                )
                return {
                    'success': True,
                    'links': links,
                    'count': len(links),
                    'url': self.page.url
                }
            
            elif extract_type == 'images':
                images = await self.page.eval_on_selector_all(
                    selector or 'img[src]',
                    '''elements => elements.slice(0, ''' + str(limit) + ''').map(el => ({
                        src: el.src,
                        alt: el.alt || ''
                    }))'''
                )
                return {
                    'success': True,
                    'images': images,
                    'count': len(images),
                    'url': self.page.url
                }
            
            elif extract_type == 'table':
                # Extract table data
                table_data = await self.page.eval_on_selector(
                    selector or 'table',
                    '''table => {
                        const rows = Array.from(table.querySelectorAll('tr'));
                        return rows.slice(0, ''' + str(limit) + ''').map(row => {
                            return Array.from(row.querySelectorAll('th, td')).map(cell => cell.innerText.trim());
                        });
                    }'''
                )
                return {
                    'success': True,
                    'table': table_data,
                    'rows': len(table_data) if table_data else 0,
                    'url': self.page.url
                }
            
            elif extract_type == 'attributes':
                if not attributes:
                    attributes = ['id', 'class', 'name', 'value']
                
                attrs = await elements.first.evaluate(
                    '''(el, attrs) => {
                        const result = {};
                        attrs.forEach(attr => {
                            result[attr] = el.getAttribute(attr);
                        });
                        return result;
                    }''',
                    attributes
                )
                return {
                    'success': True,
                    'attributes': attrs,
                    'url': self.page.url
                }
            
            else:
                return {'success': False, 'error': f'Unknown extract type: {extract_type}'}
            
        except Exception as e:
            return {'success': False, 'error': str(e)}
    
    async def screenshot(
        self,
        selector: Optional[str] = None,
        path: Optional[str] = None,
        full_page: bool = False,
        format: str = 'png',
        quality: int = 80
    ) -> Dict[str, Any]:
        """Take a screenshot."""
        if not self.page:
            await self.initialize()
        
        try:
            # Generate path if not provided
            if not path:
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                path = str(self._screenshots_dir / f'screenshot_{timestamp}.{format}')
            
            # Ensure directory exists
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            
            if selector:
                element = self.page.locator(selector).first
                await element.screenshot(
                    path=path,
                    type=format,
                    quality=quality if format == 'jpeg' else None
                )
            else:
                await self.page.screenshot(
                    path=path,
                    full_page=full_page,
                    type=format,
                    quality=quality if format == 'jpeg' else None
                )
            
            return {
                'success': True,
                'path': path,
                'url': self.page.url,
                'message': f'Screenshot saved to {path}'
            }
            
        except Exception as e:
            return {'success': False, 'error': str(e)}


# Singleton instance for reuse across calls
_controller: Optional[BrowserController] = None


async def get_controller(headless: bool = True) -> BrowserController:
    """Get or create the browser controller singleton."""
    global _controller
    if _controller is None:
        _controller = BrowserController(headless=headless)
        await _controller.initialize()
    return _controller


async def execute_action(tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a browser action."""
    headless = args.pop('headless', True)
    controller = await get_controller(headless=headless)
    
    if tool == 'browser_navigate':
        return await controller.navigate(
            url=args.get('url'),
            action=args.get('action', 'goto'),
            wait_until=args.get('wait_until', 'domcontentloaded'),
            timeout=args.get('timeout', 30000)
        )
    
    elif tool == 'browser_click':
        return await controller.click(
            selector=args.get('selector'),
            text=args.get('text'),
            button=args.get('button', 'left'),
            click_count=args.get('click_count', 1),
            timeout=args.get('timeout', 10000)
        )
    
    elif tool == 'browser_fill':
        return await controller.fill(
            value=args.get('value', ''),
            selector=args.get('selector'),
            label=args.get('label'),
            placeholder=args.get('placeholder'),
            clear=args.get('clear', True),
            press_enter=args.get('press_enter', False)
        )
    
    elif tool == 'browser_extract':
        return await controller.extract(
            selector=args.get('selector'),
            extract_type=args.get('extract_type', 'text'),
            attributes=args.get('attributes'),
            limit=args.get('limit', 100)
        )
    
    elif tool == 'browser_screenshot':
        return await controller.screenshot(
            selector=args.get('selector'),
            path=args.get('path'),
            full_page=args.get('full_page', False),
            format=args.get('format', 'png'),
            quality=args.get('quality', 80)
        )
    
    else:
        return {'success': False, 'error': f'Unknown tool: {tool}'}


def run_async(coro):
    """Run async coroutine in sync context."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    
    return loop.run_until_complete(coro)


if __name__ == '__main__':
    # Test the controller
    async def test():
        controller = BrowserController(headless=False)
        await controller.initialize()
        
        result = await controller.navigate('https://example.com')
        print(json.dumps(result, indent=2))
        
        result = await controller.extract(extract_type='text')
        print(result['content'][:500])
        
        await controller.close()
    
    asyncio.run(test())
