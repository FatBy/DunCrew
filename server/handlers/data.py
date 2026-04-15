"""DunCrew Server - Data Persistence Mixin (Scoring, Confidence, Governor)"""
from __future__ import annotations

import json
import time
import threading
from pathlib import Path

from server.state import _db_lock

class DataMixin:
    """Data Persistence Mixin (Scoring, Confidence, Governor)"""

    # ---- Scoring ----

    def handle_scoring_get(self, dun_id: str):
        """GET /api/dun/{dunId}/scoring"""
        db = self._get_db()
        row = db.execute("SELECT scoring_data FROM dun_scoring WHERE dun_id = ?", (dun_id,)).fetchone()
        if row:
            self.send_json(json.loads(row['scoring_data']))
        else:
            # 同时尝试从旧 fitness 文件迁移
            dun_dir = self._resolve_dun_dir(dun_id)
            if dun_dir:
                fitness_file = dun_dir / 'sop-fitness.json'
                if fitness_file.exists():
                    try:
                        with fitness_file.open('r', encoding='utf-8') as f:
                            legacy_data = json.load(f)
                        # 迁移到 SQLite
                        now = int(time.time() * 1000)
                        with _db_lock:
                            db.execute("INSERT OR REPLACE INTO dun_scoring (dun_id, scoring_data, updated_at) VALUES (?,?,?)",
                                       (dun_id, json.dumps(legacy_data, ensure_ascii=False), now))
                            db.commit()
                        self.send_json(legacy_data)
                        return
                    except Exception:
                        pass
            self.send_json(None)

    def handle_scoring_put(self, dun_id: str, data: dict):
        """PUT /api/dun/{dunId}/scoring"""
        db = self._get_db()
        now = int(time.time() * 1000)
        scoring_json = json.dumps(data, ensure_ascii=False)
        with _db_lock:
            db.execute("INSERT OR REPLACE INTO dun_scoring (dun_id, scoring_data, updated_at) VALUES (?,?,?)",
                       (dun_id, scoring_json, now))
            db.commit()
        self.send_json({'status': 'ok'})
    

    # ============================================
    # 📦 前端数据持久化 API (/data)
    # ============================================

    # ── Confidence Tracker API ──

    def handle_confidence_entries_get(self):
        """GET /api/confidence/entries - 返回保存的置信度追踪条目"""
        data_dir = self.clawd_path / 'data'
        file_path = data_dir / 'confidence_entries.json'

        if not file_path.exists():
            self.send_json([])
            return

        try:
            content = file_path.read_text(encoding='utf-8')
            entries = json.loads(content)
            self.send_json(entries if isinstance(entries, list) else [])
        except Exception as e:
            print(f"[Confidence] Failed to read entries: {e}")
            self.send_json([])

    def handle_confidence_migrate(self, data: dict):
        """POST /api/confidence/migrate - 从前端迁移置信度追踪条目到后端"""
        entries = data.get('entries', [])
        if not isinstance(entries, list):
            self.send_error_json('entries must be an array', 400)
            return

        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        file_path = data_dir / 'confidence_entries.json'

        try:
            # 合并已有条目（以 id 为键去重，新条目覆盖旧条目）
            existing = []
            if file_path.exists():
                try:
                    existing = json.loads(file_path.read_text(encoding='utf-8'))
                except Exception:
                    existing = []

            merged = {e['id']: e for e in existing if isinstance(e, dict) and 'id' in e}
            for entry in entries:
                if isinstance(entry, dict) and 'id' in entry:
                    merged[entry['id']] = entry

            result = list(merged.values())
            file_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_json({'migrated': len(entries), 'total': len(result)})
            print(f"[Confidence] Migrated {len(entries)} entries, total {len(result)}")
        except Exception as e:
            self.send_error_json(f'Failed to migrate: {str(e)}', 500)

    # ── Data API ──

    def handle_data_get(self, key: str):
        """读取前端数据"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        
        # 安全检查：允许字母数字下划线中文等 Unicode 字符，禁止路径穿越
        if not key or '..' in key or '/' in key or '\\' in key or len(key) > 200:
            self.send_error_json('Invalid key format', 400)
            return
        
        file_path = data_dir / f'{key}.json'
        
        if not file_path.exists():
            self.send_json({'key': key, 'value': None, 'exists': False})
            return
        
        try:
            content = file_path.read_text(encoding='utf-8')
            self.send_json({'key': key, 'value': json.loads(content), 'exists': True})
        except Exception as e:
            self.send_error_json(f'Failed to read data: {str(e)}', 500)
    
    # 文件写入锁 (防止并发写入同一个 data/*.json 文件)
    _data_file_locks: dict = {}

    @staticmethod
    def _get_data_lock(key: str):
        """获取指定 key 的文件锁 (懒创建，setdefault 在 CPython GIL 保护下是原子操作)"""
        return DataMixin._data_file_locks.setdefault(key, threading.Lock())

    def handle_data_set(self, key: str, data: dict):
        """写入前端数据 (带文件锁防并发)"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        
        # 安全检查：允许字母数字下划线中文等 Unicode 字符，禁止路径穿越
        if not key or '..' in key or '/' in key or '\\' in key or len(key) > 200:
            self.send_error_json('Invalid key format', 400)
            return
        
        file_path = data_dir / f'{key}.json'
        value = data.get('value')
        
        try:
            with self._get_data_lock(key):
                if value is None:
                    # 删除数据
                    if file_path.exists():
                        file_path.unlink()
                    self.send_json({'key': key, 'deleted': True})
                else:
                    # 写入数据
                    file_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
                    self.send_json({'key': key, 'saved': True})
        except Exception as e:
            self.send_error_json(f'Failed to save data: {str(e)}', 500)
    
    def handle_data_list(self):
        """列出所有数据键"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        
        keys = []
        for f in data_dir.glob('*.json'):
            keys.append(f.stem)
        
        self.send_json({'keys': keys})
    

    def handle_governor_stats_get(self):
        """读取 Governor 统计数据"""
        stats_file = self.clawd_path / 'data' / 'governor_stats.json'
        if not stats_file.exists():
            self.send_json({})
            return
        try:
            content = stats_file.read_text(encoding='utf-8')
            self.send_json(json.loads(content))
        except Exception as e:
            self.send_error_json(f'Failed to read governor stats: {str(e)}', 500)

    def handle_governor_stats_save(self, data: dict):
        """保存 Governor 统计数据 (带文件锁)"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        stats_file = data_dir / 'governor_stats.json'
        try:
            with self._get_data_lock('governor_stats'):
                stats_file.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )
            self.send_json({'saved': True})
        except Exception as e:
            self.send_error_json(f'Failed to save governor stats: {str(e)}', 500)


