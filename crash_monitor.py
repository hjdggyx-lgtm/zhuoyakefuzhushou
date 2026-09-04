import os
import sys
import traceback
from datetime import datetime


def _log_dir():
    try:
        return os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'logs')
    except Exception:
        return os.path.join(os.getcwd(), 'logs')


LOG_FILE = os.path.join(_log_dir(), 'crash_monitor.log')
MAX_LOG_SIZE = 5 * 1024 * 1024


def _write(msg):
    try:
        d = os.path.dirname(LOG_FILE)
        os.makedirs(d, exist_ok=True)
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > MAX_LOG_SIZE:
            try:
                os.replace(LOG_FILE, LOG_FILE + '.old')
            except Exception:
                pass
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
            f.flush()
    except Exception:
        pass


def _mem():
    try:
        import psutil
        p = psutil.Process(os.getpid())
        rss = p.memory_info().rss
        child = 0
        nchild = 0
        for c in p.children(recursive=True):
            try:
                child += c.memory_info().rss
                nchild += 1
            except Exception:
                pass
        return f"py_rss={rss // 1024}KB children={nchild} child_rss={child // 1024}KB"
    except Exception:
        return "mem=n/a(psutil missing?)"


def _heartbeat(window):
    try:
        mem = _mem()
        cat = '?'
        try:
            cat = str(getattr(window, 'currentSelectedCategoryId', '?'))
        except Exception:
            pass
        try:
            browser = getattr(window, 'browser', None)
            if browser is not None:
                page = browser.page()
                if page is not None:
                    def _cb(res):
                        try:
                            _write(f"HEARTBEAT {mem} cat={cat} dom_nodes={res}")
                        except Exception:
                            pass
                    page.runJavaScript("document.querySelectorAll('*').length", _cb)
                    return
        except Exception:
            pass
        _write(f"HEARTBEAT {mem} cat={cat}")
    except Exception:
        pass


def setup_crash_monitor(window):
    try:
        _write("==== crash monitor started ====")
        from PyQt6.QtCore import QTimer
        try:
            profile = getattr(window, 'profile', None)
            if profile is not None:
                def _on_rt(reason, exit_code):
                    try:
                        _write(f"RENDER_TERMINATED reason={reason} exit_code={exit_code}")
                    except Exception:
                        pass
                profile.renderProcessTerminated.connect(_on_rt)
                _write("bound renderProcessTerminated")
        except Exception as e:
            _write(f"bind render failed: {e}")
        timer = QTimer(window)
        timer.timeout.connect(lambda: _heartbeat(window))
        timer.start(30000)
        window._crash_monitor_timer = timer
        _write("heartbeat timer started (30s)")
        _orig = sys.excepthook
        def _eh(etype, value, tb):
            try:
                _write("UNHANDLED EXCEPTION:\n" + ''.join(traceback.format_exception(etype, value, tb)))
            except Exception:
                pass
            _orig(etype, value, tb)
        sys.excepthook = _eh
        _write("bound excepthook")
    except Exception as e:
        try:
            _write(f"setup failed: {e}")
        except Exception:
            pass
