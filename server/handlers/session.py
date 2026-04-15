"""DunCrew Server - Session CRUD Mixin"""
from __future__ import annotations

import json
import time
import uuid

from server.state import _db_lock

class SessionMixin:
    """Session CRUD Mixin"""

    def handle_session_create(self, data: dict):
        """POST /api/sessions - 创建新会话"""
        db = self._get_db()
        session_id = data.get('id') or f"sess-{uuid.uuid4().hex[:12]}"
        title = data.get('title', '')
        sess_type = data.get('type', 'general')
        dun_id = data.get('dunId')
        now = int(time.time() * 1000)
        with _db_lock:
            db.execute(
                "INSERT OR IGNORE INTO sessions (id, title, type, dun_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (session_id, title, sess_type, dun_id, now, now)
            )
            db.commit()
        self.send_json({'id': session_id, 'title': title, 'type': sess_type, 'dunId': dun_id, 'createdAt': now, 'updatedAt': now})

    def handle_sessions_list(self, query: dict):
        """GET /api/sessions - 列出会话"""
        db = self._get_db()
        sess_type = query.get('type', [None])[0]
        dun_id = query.get('dunId', [None])[0]
        limit = int(query.get('limit', ['50'])[0])
        offset = int(query.get('offset', ['0'])[0])
        
        sql = "SELECT * FROM sessions WHERE 1=1"
        params = []
        if sess_type:
            sql += " AND type = ?"
            params.append(sess_type)
        if dun_id:
            sql += " AND dun_id = ?"
            params.append(dun_id)
        sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        rows = db.execute(sql, params).fetchall()
        sessions = [{'id': r['id'], 'title': r['title'], 'type': r['type'], 'dunId': r['dun_id'],
                      'createdAt': r['created_at'], 'updatedAt': r['updated_at'],
                      'lastMessagePreview': r['last_message_preview']} for r in rows]
        self.send_json(sessions)

    def handle_session_get(self, session_id: str):
        """GET /api/sessions/{id} - 获取会话详情"""
        db = self._get_db()
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            self.send_error_json('Session not found', 404)
            return
        messages = db.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp", (session_id,)).fetchall()
        checkpoint_row = db.execute("SELECT data FROM checkpoints WHERE session_id = ?", (session_id,)).fetchone()
        self.send_json({
            'meta': {'id': row['id'], 'title': row['title'], 'type': row['type'], 'dunId': row['dun_id'],
                     'createdAt': row['created_at'], 'updatedAt': row['updated_at']},
            'messages': [{'id': m['id'], 'role': m['role'], 'content': m['content'], 'timestamp': m['timestamp']} for m in messages],
            'checkpoint': json.loads(checkpoint_row['data']) if checkpoint_row else None,
        })

    def handle_session_delete(self, session_id: str):
        """DELETE /api/sessions/{id}"""
        db = self._get_db()
        with _db_lock:
            db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            db.commit()
        self.send_json({'status': 'ok'})

    def handle_session_messages_get(self, session_id: str, query: dict):
        """GET /api/sessions/{id}/messages"""
        db = self._get_db()
        limit = int(query.get('limit', ['100'])[0])
        offset = int(query.get('offset', ['0'])[0])
        since = query.get('since', [None])[0]
        
        sql = "SELECT * FROM messages WHERE session_id = ?"
        params: list = [session_id]
        if since:
            sql += " AND timestamp > ?"
            params.append(int(since))
        sql += " ORDER BY timestamp LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        rows = db.execute(sql, params).fetchall()
        self.send_json([{'id': r['id'], 'role': r['role'], 'content': r['content'], 'timestamp': r['timestamp']} for r in rows])

    def handle_session_message_append(self, session_id: str, data: dict):
        """POST /api/sessions/{id}/messages"""
        db = self._get_db()
        msg = data.get('message', data)
        msg_id = msg.get('id') or f"msg-{uuid.uuid4().hex[:12]}"
        role = msg.get('role', 'user')
        content = msg.get('content', '')
        timestamp = msg.get('timestamp') or int(time.time() * 1000)
        now = int(time.time() * 1000)
        
        with _db_lock:
            db.execute("INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)",
                       (msg_id, session_id, role, content, timestamp))
            db.execute("UPDATE sessions SET updated_at = ?, last_message_preview = ? WHERE id = ?",
                       (now, content[:100], session_id))
            db.commit()
        self.send_json({'status': 'ok', 'id': msg_id})

    def handle_session_meta_update(self, session_id: str, data: dict):
        """POST /api/sessions/{id}/meta"""
        db = self._get_db()
        updates = []
        params = []
        if 'title' in data:
            updates.append("title = ?")
            params.append(data['title'])
        if 'lastMessagePreview' in data:
            updates.append("last_message_preview = ?")
            params.append(data['lastMessagePreview'])
        if updates:
            params.append(int(time.time() * 1000))
            params.append(session_id)
            with _db_lock:
                db.execute(f"UPDATE sessions SET {', '.join(updates)}, updated_at = ? WHERE id = ?", params)
                db.commit()
        self.send_json({'status': 'ok'})

    def handle_session_checkpoint_get(self, session_id: str):
        """GET /api/sessions/{id}/checkpoint"""
        db = self._get_db()
        row = db.execute("SELECT data FROM checkpoints WHERE session_id = ?", (session_id,)).fetchone()
        self.send_json(json.loads(row['data']) if row else None)

    def handle_session_checkpoint_save(self, session_id: str, data: dict):
        """POST /api/sessions/{id}/checkpoint"""
        db = self._get_db()
        now = int(time.time() * 1000)
        with _db_lock:
            db.execute("INSERT OR REPLACE INTO checkpoints (session_id, data, created_at) VALUES (?,?,?)",
                       (session_id, json.dumps(data, ensure_ascii=False), now))
            db.commit()
        self.send_json({'status': 'ok'})

    def handle_session_checkpoint_delete(self, session_id: str):
        """DELETE /api/sessions/{id}/checkpoint"""
        db = self._get_db()
        with _db_lock:
            db.execute("DELETE FROM checkpoints WHERE session_id = ?", (session_id,))
            db.commit()
        self.send_json({'status': 'ok'})

    def handle_session_search(self, query: dict):
        """GET /api/sessions/search?query=xxx&limit=10 - 搜索会话"""
        search_query = query.get('query', [''])[0]
        limit = min(int(query.get('limit', ['10'])[0]), 50)

        if not search_query:
            self.send_json([])
            return

        db = self._get_db()
        pattern = f'%{search_query}%'
        rows = db.execute(
            "SELECT * FROM sessions WHERE title LIKE ? OR last_message_preview LIKE ? ORDER BY updated_at DESC LIMIT ?",
            (pattern, pattern, limit)
        ).fetchall()
        sessions = [{'id': r['id'], 'title': r['title'], 'type': r['type'], 'dunId': r['dun_id'],
                      'createdAt': r['created_at'], 'updatedAt': r['updated_at'],
                      'lastMessagePreview': r['last_message_preview']} for r in rows]
        self.send_json(sessions)

    def handle_session_messages_batch(self, session_id: str, data: dict):
        """POST /api/sessions/{id}/messages/batch - 批量追加消息"""
        messages = data.get('messages', [])
        if not isinstance(messages, list):
            self.send_error_json('messages must be an array', 400)
            return

        db = self._get_db()
        appended = 0
        now = int(time.time() * 1000)
        last_content = ''

        with _db_lock:
            for msg in messages:
                if not isinstance(msg, dict):
                    continue
                msg_id = msg.get('id') or f"msg-{uuid.uuid4().hex[:12]}"
                role = msg.get('role', 'user')
                content = msg.get('content', '')
                timestamp = msg.get('timestamp') or now
                db.execute(
                    "INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp) VALUES (?,?,?,?,?)",
                    (msg_id, session_id, role, content, timestamp)
                )
                last_content = content
                appended += 1
            if appended > 0:
                db.execute(
                    "UPDATE sessions SET updated_at = ?, last_message_preview = ? WHERE id = ?",
                    (now, last_content[:100], session_id)
                )
            db.commit()

        self.send_json({'status': 'ok', 'appended': appended})

