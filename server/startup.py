"""DunCrew Server - Environment and Proxy Setup"""
from __future__ import annotations

import os
import sys
from pathlib import Path
import urllib.request as _urllib_req


def _load_dotenv():
    """从项目根目录的 .env 文件加载环境变量（不覆盖已有值）"""
    if getattr(sys, 'frozen', False):
        return  # 打包模式不需要 .env
    env_path = Path(__file__).resolve().parent.parent / '.env'
    if not env_path.exists():
        return
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' not in line:
                continue
            key, _, value = line.partition('=')
            key, value = key.strip(), value.strip()
            if key and key not in os.environ:
                os.environ[key] = value
    print(f'[Env] Loaded .env from {env_path}', file=sys.stderr)


def _setup_proxy():
    """检测系统代理配置，有就用，没有就直连"""
    proxy_url = (
        os.environ.get('HTTPS_PROXY')
        or os.environ.get('HTTP_PROXY')
        or os.environ.get('https_proxy')
        or os.environ.get('http_proxy')
        or os.environ.get('ALL_PROXY')
        or os.environ.get('all_proxy')
    )
    if proxy_url:
        print(f'[Proxy] Using env proxy: {proxy_url}', file=sys.stderr)
        handler = _urllib_req.ProxyHandler({
            'http': proxy_url,
            'https': proxy_url,
        })
        opener = _urllib_req.build_opener(handler)
    else:
        # 无环境变量代理 → 尝试读取系统代理（Windows 注册表）
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r'Software\Microsoft\Windows\CurrentVersion\Internet Settings') as key:
                enabled, _ = winreg.QueryValueEx(key, 'ProxyEnable')
                if enabled:
                    server, _ = winreg.QueryValueEx(key, 'ProxyServer')
                    if server:
                        proxy = server if '://' in server else f'http://{server}'
                        print(f'[Proxy] Using Windows system proxy: {proxy}', file=sys.stderr)
                        handler = _urllib_req.ProxyHandler({'http': proxy, 'https': proxy})
                        opener = _urllib_req.build_opener(handler)
                        _urllib_req.install_opener(opener)
                        return
        except Exception:
            pass
        # 真的无代理 → 直连
        print('[Proxy] No proxy detected, using direct connection', file=sys.stderr)
        opener = _urllib_req.build_opener()
    _urllib_req.install_opener(opener)
