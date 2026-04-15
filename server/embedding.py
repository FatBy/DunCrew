"""DunCrew Server - Embedding Model Manager (ONNX)"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

from server.constants import RESOURCES_DIR

class EmbeddingManager:
    """本地 Embedding 模型管理器 — ONNX Runtime 版本

    bge-large-zh-v1.5 ONNX FP32 模型，提供 OpenAI 兼容的 embedding 接口。
    首次使用时自动从 HuggingFace 下载模型 (支持国内镜像)。
    启动时后台预热，请求时若仍在加载则排队等待（而非返回 503）。
    模型常驻内存，不做空闲卸载。

    推理管线: tokenizers → ONNX Runtime → CLS pooling → L2 normalize
    """
    MODEL_REPO = 'BAAI/bge-large-zh-v1.5'
    MODEL_DIR_NAME = 'bge-large-zh-v1.5-onnx-int8'
    ONNX_FILE = 'model_quantized.onnx'
    LOAD_TIMEOUT = 300  # 含下载时间，放宽到 5 分钟
    DIMENSION = 1024

    def __init__(self):
        self._clawd_path: Path | None = None
        self._session = None   # onnxruntime.InferenceSession
        self._tokenizer = None  # tokenizers.Tokenizer
        self._lock = threading.Lock()
        self._encode_semaphore = threading.Semaphore(2)
        self._loading = False
        self._ready_event = threading.Event()
        self._available = None  # None=未检测

    def is_available(self) -> bool:
        """检测 onnxruntime + tokenizers 是否已安装"""
        if self._available is None:
            try:
                import onnxruntime  # noqa: F401
                import tokenizers  # noqa: F401
                import numpy  # noqa: F401
                self._available = True
            except ImportError:
                self._available = False
        return self._available

    def get_status(self) -> dict:
        return {
            'available': self.is_available(),
            'model_loaded': self._session is not None,
            'model_name': self.MODEL_DIR_NAME,
            'loading': self._loading,
            'model_exists': self._model_exists(),
            'dimension': self.DIMENSION,
        }

    def _get_model_dir(self) -> Path:
        """模型存储路径：优先 clawd_path/models (已有模型)，其次项目目录/models"""
        # 优先检查 clawd_path（用户数据目录）
        if self._clawd_path:
            clawd_model = self._clawd_path / 'models' / self.MODEL_DIR_NAME
            if (clawd_model / self.ONNX_FILE).exists():
                return clawd_model
        # 其次检查项目目录（开发模式 / 打包时内置）
        app_model = RESOURCES_DIR / 'models' / self.MODEL_DIR_NAME
        if (app_model / self.ONNX_FILE).exists():
            return app_model
        # 都没有时，返回 clawd_path 路径（下载目标）
        if self._clawd_path:
            return self._clawd_path / 'models' / self.MODEL_DIR_NAME
        return app_model

    def _model_exists(self) -> bool:
        return (self._get_model_dir() / self.ONNX_FILE).exists()

    def _detect_hf_mirror(self):
        """自动检测 HuggingFace 中国镜像可达性（保留备用）"""
        if os.environ.get('HF_ENDPOINT') or os.environ.get('HF_MIRROR'):
            return
        try:
            import urllib.request
            req = urllib.request.Request('https://hf-mirror.com', method='HEAD')
            urllib.request.urlopen(req, timeout=3)
            os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
            print('[Embedding] Using HuggingFace mirror: hf-mirror.com', file=sys.stderr)
        except Exception:
            pass

    def _ensure_model(self):
        """懒加载: 查找本地内置模型并加载 ONNX session + tokenizer"""
        if self._session is not None:
            return
        with self._lock:
            if self._session is not None:
                return
            if not self.is_available():
                raise RuntimeError(
                    'onnxruntime or tokenizers not installed. '
                    'Install with: pip install onnxruntime tokenizers numpy'
                )

            self._loading = True
            self._ready_event.clear()
            try:
                model_dir = self._get_model_dir()
                onnx_path = model_dir / self.ONNX_FILE

                # 本地没有模型 → 报错（模型应随安装包内置）
                if not onnx_path.exists():
                    raise FileNotFoundError(
                        f'Embedding model not found: {onnx_path}. '
                        f'The ONNX model should be bundled with the application.'
                    )

                # 加载 ONNX Runtime session
                import onnxruntime as ort

                print(f'[Embedding] Loading ONNX model from {onnx_path}...', file=sys.stderr)
                sess_options = ort.SessionOptions()
                sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                sess_options.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)

                self._session = ort.InferenceSession(
                    str(onnx_path),
                    sess_options,
                    providers=['CPUExecutionProvider'],
                )

                # 加载 tokenizer (使用 tokenizers 库直接加载, 不依赖 transformers)
                from tokenizers import Tokenizer

                tokenizer_path = model_dir / 'tokenizer.json'
                if not tokenizer_path.exists():
                    raise FileNotFoundError(
                        f'tokenizer.json not found in {model_dir}. '
                        f'Model files may be incomplete.'
                    )
                self._tokenizer = Tokenizer.from_file(str(tokenizer_path))
                # 配置 padding 和 truncation
                self._tokenizer.enable_padding(
                    direction="right",
                    pad_id=0,
                    pad_token='[PAD]',
                )
                self._tokenizer.enable_truncation(max_length=512)

                print(f'[Embedding] ONNX model loaded (dim={self.DIMENSION})', file=sys.stderr)
            finally:
                self._loading = False
                self._ready_event.set()

    def wait_until_ready(self, timeout: float | None = None) -> bool:
        """阻塞等待模型加载完成，返回是否就绪"""
        if self._session is not None:
            return True
        t = timeout if timeout is not None else self.LOAD_TIMEOUT
        return self._ready_event.wait(timeout=t)

    def preheat(self):
        """后台线程预加载模型（服务启动时调用）"""
        if not self.is_available():
            print('[Embedding] Preheat skipped: onnxruntime/tokenizers not installed', file=sys.stderr)
            return
        def _load():
            try:
                self._ensure_model()
            except Exception as e:
                print(f'[Embedding] Preheat failed: {e}', file=sys.stderr)
        t = threading.Thread(target=_load, name='embedding-preheat', daemon=True)
        t.start()

    def encode(self, texts: list) -> list:
        """批量编码文本为向量 (CLS pooling + L2 normalize)"""
        self._ensure_model()
        import numpy as np

        self._encode_semaphore.acquire()
        try:
            # Tokenize
            encodings = self._tokenizer.encode_batch(texts)
            input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
            attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            token_type_ids = np.array([e.type_ids for e in encodings], dtype=np.int64)

            # ONNX 推理
            feeds = {
                'input_ids': input_ids,
                'attention_mask': attention_mask,
                'token_type_ids': token_type_ids,
            }
            # 只传模型实际接受的输入
            valid_input_names = {inp.name for inp in self._session.get_inputs()}
            feeds = {k: v for k, v in feeds.items() if k in valid_input_names}

            outputs = self._session.run(None, feeds)

            # CLS pooling: 取 [CLS] token (index 0) 的向量
            # outputs[0] shape: (batch_size, seq_len, hidden_dim)
            cls_embeddings = outputs[0][:, 0, :]  # (batch_size, hidden_dim)

            # L2 normalize
            norms = np.linalg.norm(cls_embeddings, axis=1, keepdims=True)
            norms = np.clip(norms, a_min=1e-12, a_max=None)
            normalized = cls_embeddings / norms

            return normalized.tolist()
        finally:
            self._encode_semaphore.release()

    def shutdown(self):
        with self._lock:
            if self._session is not None:
                del self._session
                self._session = None
                self._tokenizer = None
                import gc
                gc.collect()
                print('[Embedding] Model unloaded', file=sys.stderr)


    def set_clawd_path(self, path: Path):
        """设置数据目录路径 (解耦: 不再依赖 ClawdDataHandler)"""
        self._clawd_path = path
