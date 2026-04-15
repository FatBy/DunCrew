"""DunCrew Server - Browser Automation + Screen/OCR Tools Mixin"""
from __future__ import annotations

import os
import re
import json
import time
import uuid
import base64
from pathlib import Path
from datetime import datetime

from server.constants import HAS_OCR, HAS_SCREEN_CAPTURE
from server.state import _browser_manager

if HAS_SCREEN_CAPTURE:
    import mss as mss_lib
    import pygetwindow as gw

class BrowserToolsMixin:
    """Browser Automation + Screen/OCR Tools Mixin"""

    # ============================================
    # 🌐 浏览器自动化工具 (Playwright)
    # ============================================

    def _tool_browser_navigate(self, args: dict) -> str:
        """浏览器导航到指定 URL"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装。请运行: pip install playwright && playwright install chromium")
        url = args.get('url', '')
        if not url:
            raise ValueError("url is required")
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        wait_until = args.get('waitUntil', 'domcontentloaded')
        return _browser_manager.navigate(url, wait_until=wait_until)

    def _tool_browser_click(self, args: dict) -> str:
        """点击页面元素"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装")
        selector = args.get('selector', '')
        if not selector:
            raise ValueError("selector is required")
        return _browser_manager.click(selector)

    def _tool_browser_fill(self, args: dict) -> str:
        """填写表单字段"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装")
        selector = args.get('selector', '')
        value = args.get('value', '')
        if not selector:
            raise ValueError("selector is required")
        return _browser_manager.fill(selector, value)

    def _tool_browser_extract(self, args: dict) -> str:
        """提取页面文本内容"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装")
        selector = args.get('selector', 'body')
        return _browser_manager.extract(selector)

    def _tool_browser_screenshot(self, args: dict) -> str:
        """页面截图"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装")
        selector = args.get('selector')
        full_page = args.get('fullPage', False)
        return _browser_manager.screenshot(selector=selector, full_page=full_page)

    def _tool_browser_evaluate(self, args: dict) -> str:
        """执行 JavaScript"""
        if not _browser_manager.is_available():
            raise RuntimeError("Playwright 未安装")
        expression = args.get('expression', '')
        if not expression:
            raise ValueError("expression is required")
        return _browser_manager.evaluate(expression)

    # ============================================
    # 📸 屏幕截图 & OCR 工具
    # ============================================

    def _tool_screen_capture(self, args: dict) -> str:
        """截取屏幕截图（全屏/区域/窗口/列出窗口）"""
        if not HAS_SCREEN_CAPTURE:
            raise RuntimeError("mss/pygetwindow 未安装，请运行 pip install mss pygetwindow")
        if not HAS_OCR:
            raise RuntimeError("Pillow 未安装（截图保存需要），请运行 pip install Pillow")

        mode = args.get('mode', 'fullscreen')

        # --- list_windows 模式 ---
        if mode == 'list_windows':
            all_wins = gw.getAllWindows()
            visible = []
            for w in all_wins:
                if w.visible and w.title and w.title.strip():
                    visible.append({
                        'title': w.title.strip(),
                        'rect': {'x': w.left, 'y': w.top, 'width': w.width, 'height': w.height},
                    })
            visible.sort(key=lambda v: v['rect']['width'] * v['rect']['height'], reverse=True)
            if not visible:
                return json.dumps({'windows': [], 'message': '未发现可见窗口'}, ensure_ascii=False)
            return json.dumps({'windows': visible}, ensure_ascii=False)

        # 截图保存目录
        screenshot_dir = self.clawd_path / 'temp' / 'screenshots'
        screenshot_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        unique_name = f"{ts}_{uuid.uuid4().hex[:8]}.png"
        save_path = screenshot_dir / unique_name

        with mss_lib.mss() as sct:
            # --- fullscreen 模式 ---
            if mode == 'fullscreen':
                monitor_idx = int(args.get('monitor', 1))
                if monitor_idx < 0 or monitor_idx >= len(sct.monitors):
                    raise ValueError(f"显示器编号 {monitor_idx} 无效，可用范围: 0-{len(sct.monitors)-1}")
                mon = sct.monitors[monitor_idx]
                sct_img = sct.grab(mon)

            # --- region 模式 ---
            elif mode == 'region':
                region = args.get('region', {})
                x = int(region.get('x', 0))
                y = int(region.get('y', 0))
                w = int(region.get('width', 0))
                h = int(region.get('height', 0))
                if w <= 0 or h <= 0:
                    raise ValueError("region 的 width 和 height 必须大于 0")
                sct_img = sct.grab({'left': x, 'top': y, 'width': w, 'height': h})

            # --- window 模式 ---
            elif mode == 'window':
                window_title = args.get('windowTitle', '')
                if not window_title:
                    raise ValueError("window 模式需要提供 windowTitle 参数。可先用 list_windows 模式查看可用窗口")
                matches = gw.getWindowsWithTitle(window_title)
                # 模糊匹配: 标题包含关键词
                matches = [w for w in matches if window_title.lower() in w.title.lower() and w.title.strip()]
                if not matches:
                    raise ValueError(f"未找到标题包含 '{window_title}' 的窗口。请先用 list_windows 模式查看可用窗口")
                # 取面积最大的
                win = max(matches, key=lambda w: max(w.width, 1) * max(w.height, 1))
                # 最小化窗口恢复
                if win.isMinimized:
                    win.restore()
                    time.sleep(0.3)
                # 获取窗口区域，确保有效
                left, top, width, height = win.left, win.top, win.width, win.height
                if width <= 0 or height <= 0:
                    raise ValueError(f"窗口 '{win.title}' 尺寸无效 ({width}x{height})")
                # 边界保护
                left = max(left, 0)
                top = max(top, 0)
                sct_img = sct.grab({'left': left, 'top': top, 'width': width, 'height': height})
            else:
                raise ValueError(f"不支持的模式: {mode}。可选: fullscreen / region / window / list_windows")

            # 保存为 PNG
            img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
            img.save(str(save_path), 'PNG')

        result = {
            'filePath': str(save_path),
            'width': sct_img.size[0] if 'sct_img' in dir() else img.width,
            'height': sct_img.size[1] if 'sct_img' in dir() else img.height,
        }
        if mode == 'window':
            result['windowTitle'] = win.title
        return json.dumps(result, ensure_ascii=False)

    def _tool_ocr_extract(self, args: dict) -> str:
        """智能 OCR 文字提取（支持预处理和表格还原）"""
        if not HAS_OCR:
            raise RuntimeError("pytesseract/Pillow 未安装，请运行 pip install pytesseract Pillow")

        image_path_str = args.get('imagePath') or args.get('path', '')
        if not image_path_str:
            raise ValueError("imagePath is required")

        file_path = self._resolve_path(image_path_str, allow_outside=True)
        if not file_path.exists():
            raise FileNotFoundError(f"文件不存在: {image_path_str}")
        if file_path.stat().st_size > MAX_FILE_SIZE:
            raise ValueError(f"文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)")

        lang = args.get('language', 'eng+chi_sim')
        output_format = args.get('outputFormat', 'text')
        preprocess = args.get('preprocess', True)

        img = Image.open(str(file_path))

        # 图像预处理
        if preprocess:
            img = img.convert('L')  # 灰度化
            import numpy as np
            img_array = np.array(img)
            # Otsu 自适应二值化
            hist, _ = np.histogram(img_array.flatten(), bins=256, range=(0, 256))
            total = img_array.size
            sum_total = np.dot(np.arange(256), hist)
            sum_bg, weight_bg, max_var, threshold = 0.0, 0, 0.0, 0
            for t in range(256):
                weight_bg += hist[t]
                if weight_bg == 0:
                    continue
                weight_fg = total - weight_bg
                if weight_fg == 0:
                    break
                sum_bg += t * hist[t]
                mean_bg = sum_bg / weight_bg
                mean_fg = (sum_total - sum_bg) / weight_fg
                var_between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
                if var_between > max_var:
                    max_var = var_between
                    threshold = t
            img_array = ((img_array > threshold) * 255).astype(np.uint8)
            img = Image.fromarray(img_array)
            # 小图放大
            if img.width < 300:
                img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)

        # OCR 识别
        if output_format == 'markdown':
            try:
                data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)
                return self._ocr_to_markdown(data)
            except Exception:
                # 表格还原失败，降级为纯文本
                text = pytesseract.image_to_string(img, lang=lang)
        else:
            text = pytesseract.image_to_string(img, lang=lang)

        if not text.strip():
            return "[图片中未检测到可识别文字]"

        # 截断
        encoded = text.encode('utf-8')
        if len(encoded) > MAX_OUTPUT_SIZE:
            safe_idx = MAX_OUTPUT_SIZE
            while safe_idx > 0 and (encoded[safe_idx] & 0xC0) == 0x80:
                safe_idx -= 1
            text = encoded[:safe_idx].decode('utf-8')
            text += f"\n\n[内容过长，已截断至约 {MAX_OUTPUT_SIZE // 1024}KB]"

        return text

    def _ocr_to_markdown(self, data: dict) -> str:
        """将 pytesseract image_to_data 结果转为 Markdown（尝试还原表格）"""
        blocks = {}
        n = len(data['text'])
        for i in range(n):
            conf = int(data['conf'][i]) if str(data['conf'][i]).lstrip('-').isdigit() else -1
            text = data['text'][i].strip()
            if conf < 30 or not text:
                continue
            block_num = data['block_num'][i]
            line_num = data['line_num'][i]
            if block_num not in blocks:
                blocks[block_num] = {}
            if line_num not in blocks[block_num]:
                blocks[block_num][line_num] = []
            blocks[block_num][line_num].append({
                'text': text,
                'left': data['left'][i],
                'width': data['width'][i],
            })

        if not blocks:
            return "[图片中未检测到可识别文字]"

        output_parts = []
        for block_num in sorted(blocks.keys()):
            lines = blocks[block_num]
            # 收集所有单词的 left 坐标，检测是否为表格
            all_lefts = []
            for line_num in sorted(lines.keys()):
                for word in lines[line_num]:
                    all_lefts.append(word['left'])

            # 列检测: 对 left 坐标聚类（间距 > 50px 为不同列）
            all_lefts_sorted = sorted(set(all_lefts))
            columns = []
            if all_lefts_sorted:
                columns = [all_lefts_sorted[0]]
                for l in all_lefts_sorted[1:]:
                    if l - columns[-1] > 50:
                        columns.append(l)

            is_table = len(columns) >= 2 and len(lines) >= 2

            if is_table:
                # 表格模式: 按列分配单词
                table_rows = []
                for line_num in sorted(lines.keys()):
                    row = [''] * len(columns)
                    for word in lines[line_num]:
                        # 找最近的列
                        col_idx = 0
                        min_dist = abs(word['left'] - columns[0])
                        for ci, col_left in enumerate(columns):
                            dist = abs(word['left'] - col_left)
                            if dist < min_dist:
                                min_dist = dist
                                col_idx = ci
                        if row[col_idx]:
                            row[col_idx] += ' ' + word['text']
                        else:
                            row[col_idx] = word['text']
                    table_rows.append(row)

                # 生成 Markdown 表格
                if table_rows:
                    header = '| ' + ' | '.join(table_rows[0]) + ' |'
                    separator = '| ' + ' | '.join(['---'] * len(columns)) + ' |'
                    body_rows = ['| ' + ' | '.join(r) + ' |' for r in table_rows[1:]]
                    output_parts.append('\n'.join([header, separator] + body_rows))
            else:
                # 段落模式
                para_lines = []
                for line_num in sorted(lines.keys()):
                    line_text = ' '.join(w['text'] for w in lines[line_num])
                    para_lines.append(line_text)
                output_parts.append('\n'.join(para_lines))

        result = '\n\n'.join(output_parts)
        if not result.strip():
            return "[图片中未检测到可识别文字]"
        return result


