#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卓雅话术助手 - 精简 PyQt6 启动器（加载现有 index.html）
"""
import sys
import os
import gc
import ctypes
import json
import shutil
from ctypes import wintypes
from pathlib import Path

# 在 WebEngine 初始化前设置 Chromium 参数：暴露 gc() 供定期内存清理使用
os.environ.setdefault('QTWEBENGINE_CHROMIUM_FLAGS', '--expose-gc')

from PyQt6.QtCore import QUrl, Qt, QObject, pyqtSlot, QSettings, QByteArray, QTimer, QEvent
from PyQt6.QtGui import QIcon, QKeySequence, QAction, QClipboard
from PyQt6.QtWidgets import QApplication, QMainWindow, QMessageBox, QDockWidget, QTextEdit, QDialog, QVBoxLayout, QLabel, QLineEdit, QHBoxLayout, QPushButton, QCheckBox, QWidget, QSystemTrayIcon, QStyle, QScrollArea, QSizePolicy, QFrame
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineSettings, QWebEngineProfile, QWebEngineScript, QWebEnginePage
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtWidgets import QMenu


def get_resource_path(relative_path):
    """获取资源文件路径（开发环境和打包环境通用）"""
    if getattr(sys, 'frozen', False):
        # 打包后：资源在 _internal 目录（PyInstaller onedir 模式）
        base_dir = Path(sys._MEIPASS)
    else:
        # 开发环境：资源在脚本所在目录
        base_dir = Path(__file__).parent
    return base_dir / relative_path


def get_app_data_dir():
    """获取应用数据目录（开发环境和打包环境通用）"""
    if getattr(sys, 'frozen', False):
        # 打包后的exe环境
        base_dir = Path(sys.executable).parent
    else:
        # 开发环境
        base_dir = Path(__file__).parent
    
    data_dir = base_dir / "data"
    data_dir.mkdir(exist_ok=True)
    return data_dir


def migrate_old_data():
    """迁移旧数据到新位置"""
    try:
        new_data_dir = get_app_data_dir()
        
        # 迁移 .zhuoya_phrases
        old_phrases_dir = Path.home() / ".zhuoya_phrases"
        new_phrases_dir = new_data_dir / "phrases"
        if old_phrases_dir.exists() and not new_phrases_dir.exists():
            print(f"[数据迁移] 迁移 .zhuoya_phrases -> {new_phrases_dir}")
            shutil.copytree(old_phrases_dir, new_phrases_dir)
        
        # 迁移 .zhuoya_desktop
        old_desktop_dir = Path.home() / ".zhuoya_desktop"
        new_desktop_dir = new_data_dir / "desktop"
        if old_desktop_dir.exists() and not new_desktop_dir.exists():
            print(f"[数据迁移] 迁移 .zhuoya_desktop -> {new_desktop_dir}")
            shutil.copytree(old_desktop_dir, new_desktop_dir)
            
    except Exception as e:
        print(f"[数据迁移] 错误: {e}")
        # 迁移失败不影响程序启动


class NoContextMenuWebEnginePage(QWebEnginePage):
    """禁用原生右键菜单的 QWebEnginePage"""
    
    def createStandardContextMenu(self):
        """重写此方法以禁用原生右键菜单"""
        return None


class TextEditorDialog(QDialog):
    """独立的文本编辑器窗口"""

    def __init__(self, parent: "DesktopApp", category_id: str, category_name: str) -> None:
        super().__init__(parent)
        self.category_id = category_id
        self.category_name = category_name
        self.app_window = parent
        self._load_timeout_timer = None
        self._is_closing = False
        self._web_channel = None
        self._bridge = None
        self._setup_window()

    def _setup_window(self) -> None:
        self.setWindowTitle(f"文本编辑器 - {self.category_name}（右键解锁编辑）")
        self.setMinimumSize(600, 500)
        
        # 恢复窗口大小和位置
        self._restore_window_geometry()
        
        # 定时保存窗口状态
        self._auto_save_timer = QTimer(self)
        self._auto_save_timer.timeout.connect(self._save_window_geometry_silent)
        self._auto_save_timer.start(60000)  # 每60秒保存一次
        
        # 设置窗口标志，精确控制不让Qt添加WS_EX_WINDOWEDGE
        self.setWindowFlags(
            Qt.WindowType.Window |
            Qt.WindowType.WindowTitleHint |
            Qt.WindowType.WindowSystemMenuHint |
            Qt.WindowType.WindowMinMaxButtonsHint |
            Qt.WindowType.WindowCloseButtonHint |
            Qt.WindowType.CustomizeWindowHint  # 告诉Qt不要自动添加额外的窗口修饰标志
        )
        
        # 设置最小宽度为 382px，允许窗口自由调整大小
        self.setMinimumWidth(382)

        # 去掉边框，避免黑线闪现（包括拖拽时的系统边框）
        self.setStyleSheet(
            "QDialog { "
            "background: #f5f5f5; "
            "border: 0px; "
            "outline: 0px; "
            "}"
            "QWebEngineView { "
            "border: 0px; "
            "background: transparent; "
            "outline: 0px; "
            "}"
        )
        # 设置窗口属性，去掉系统边框绘制
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        # 去掉窗口边框的绘制，避免拖拽时出现黑线
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, False)
        self.setContentsMargins(0, 0, 0, 0)

        # 创建布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # 创建 WebView
        self.browser = QWebEngineView()
        layout.addWidget(self.browser)

        # 使用主窗口的 profile 以确保共享 localStorage
        try:
            if self.app_window and self.app_window.profile:
                page = NoContextMenuWebEnginePage(self.app_window.profile, self.browser)
                self.browser.setPage(page)
            else:
                # 如果主窗口或 profile 不存在，创建新的 page
                page = NoContextMenuWebEnginePage(self.browser)
                self.browser.setPage(page)
        except Exception as e:
            print(f"警告：无法使用主窗口 profile，使用默认 page: {e}")
            page = NoContextMenuWebEnginePage(self.browser)
            self.browser.setPage(page)
        
        # 在 QWebEngineView 层面也禁用右键菜单
        self.browser.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

        # 设置 WebEngine 设置
        settings = self.browser.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)

        # 连接页面加载信号
        page = self.browser.page()
        page.loadStarted.connect(self._on_load_started)
        page.loadProgress.connect(self._on_load_progress)
        page.loadFinished.connect(self._on_load_finished)
        
        # 授予剪贴板访问权限
        page.featurePermissionRequested.connect(self._on_feature_permission_requested)
        
        # 连接 JavaScript 控制台消息，用于调试
        page.javaScriptConsoleMessage = self._on_js_console_message
        
        # 注入 Python Bridge（用于关闭窗口）
        self._inject_bridge()

        # 加载文本编辑器 HTML
        html_path = get_resource_path("text-editor.html").resolve()
        if html_path.exists():
            url = QUrl.fromLocalFile(str(html_path))
            url.setQuery(f"categoryId={self.category_id}&categoryName={self.category_name}")
            
            # 设置超时定时器（30秒）
            self._load_timeout_timer = QTimer()
            self._load_timeout_timer.setSingleShot(True)
            self._load_timeout_timer.timeout.connect(self._on_load_timeout)
            self._load_timeout_timer.start(30000)  # 30秒超时
            
            try:
                self.browser.load(url)
            except Exception as e:
                print(f"加载页面时出错: {e}")
                self._load_timeout_timer.stop()
                QMessageBox.warning(self, "错误", f"无法加载文本编辑器：\n{e}")
        else:
            QMessageBox.warning(self, "错误", f"找不到文本编辑器文件：\n{html_path}")

    def _inject_bridge(self) -> None:
        """注入 Python Bridge 以便关闭窗口"""
        try:
            page = self.browser.page()
            if not page:
                print("[文本编辑器] 警告：页面对象不存在，无法注入 Bridge")
                return
            
            self._bridge = TextEditorBridge(self)
            self._web_channel = QWebChannel(page)
            self._web_channel.registerObject("pythonBridge", self._bridge)
            page.setWebChannel(self._web_channel)
        except Exception as e:
            print(f"[文本编辑器] 注入 Bridge 时出错: {e}")
            import traceback
            traceback.print_exc()

        # 注入 WebChannel 加载器（使用页面级别的脚本，不添加到 profile）
        loader = QWebEngineScript()
        loader.setName("TextEditorQtWebChannelLoader")
        loader.setSourceCode(
            """
            (function(){
                function ensureQWebChannel(retry){
                    if (typeof QWebChannel === 'undefined'){
                        if (!document.head) {
                            if (retry > 0) {
                                setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                            }
                            return;
                        }
                        try {
                            var s = document.createElement('script');
                            s.src = 'qrc:///qtwebchannel/qwebchannel.js';
                            s.onload = function(){ /* loaded */ };
                            s.onerror = function(){ /* error */ };
                            document.head.appendChild(s);
                        } catch (error) {
                            console.error('[LOG] 无法加载 QWebChannel:', error);
                        }
                        if (retry > 0) setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                        return;
                    }
                }
                ensureQWebChannel(40);
            })();
            """
        )
        loader.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        loader.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        loader.setRunsOnSubFrames(False)
        page.scripts().insert(loader)

        # 注入桥接初始化脚本（使用页面级别的脚本）
        bridge_script = QWebEngineScript()
        bridge_script.setName("TextEditorBridgeSetup")
        bridge_script.setSourceCode(
            """
            (function() {
                function setup(retry) {
                    if (typeof qt === 'undefined' || typeof QWebChannel === 'undefined') {
                        if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 50);
                        return;
                    }
                    new QWebChannel(qt.webChannelTransport, function(channel) {
                        window.pythonBridge = channel.objects.pythonBridge;
                        console.log('[LOG] 文本编辑器 Python 桥接对象已注入');
                    });
                }
                if (typeof window.pythonBridge === 'undefined') {
                    setup(80);
                }
            })();
            """
        )
        bridge_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        bridge_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        bridge_script.setRunsOnSubFrames(False)
        page.scripts().insert(bridge_script)
        # 强制注入 CSS/DOM 修复脚本，确保在 Qt WebEngine 中 `.phrase-content` 使用 block 布局，
        # 并清理可能由编辑器插入的末尾空白块（解决 PyQt 版本中同样的“分行动作后出现空行”问题）。
        try:
            ui_fix_script = QWebEngineScript()
            ui_fix_script.setName("ForcePhraseContentBlock")
            ui_fix_script.setSourceCode(
                """
                (function(){
                    try {
                        // 插入全局样式规则（优先级靠后但使用 !important）
                        var style = document.createElement('style');
                        style.type = 'text/css';
                        style.id = 'zhuoya-force-phrase-content-style';
                        style.appendChild(document.createTextNode('.phrase-content{display:block !important; box-sizing:border-box;} .phrase-content .phrase-tags-inline{display:inline}'));
                        document.head && document.head.appendChild(style);

                        // 额外对已存在的 .phrase-content 做一次 DOM 清理（移除尾部空元素，清除最后子元素下边距）
                        function removeTrailingEmptyNodes(root){
                            var ZERO_WIDTH = /\\u200B/g;
                            function isNodeEmpty(node){
                                if(!node) return true;
                                if(node.nodeType === Node.TEXT_NODE){
                                    return ((node.textContent||'').replace(ZERO_WIDTH,'').trim() === '');
                                }
                                if(node.nodeType === Node.ELEMENT_NODE){
                                    var tag = (node.tagName||'').toLowerCase();
                                    if(tag === 'br') return true;
                                    for(var i=0;i<node.childNodes.length;i++){
                                        if(!isNodeEmpty(node.childNodes[i])) return false;
                                    }
                                    return true;
                                }
                                return true;
                            }
                            var cur = root;
                            while(cur && cur.lastChild){
                                var node = cur.lastChild;
                                if(node.nodeType === Node.ELEMENT_NODE && node.lastChild){
                                    cur = node;
                                    continue;
                                }
                                if(isNodeEmpty(node)){
                                    node.parentNode.removeChild(node);
                                    cur = node.parentNode;
                                    continue;
                                }
                                if(node.nodeType === Node.TEXT_NODE){
                                    var txt = (node.textContent||'');
                                    var trimmedEnd = txt.replace(/[\\r\\n]+$/g, '');
                                    if(trimmedEnd !== txt){
                                        node.textContent = trimmedEnd;
                                        if(trimmedEnd.trim() === ''){
                                            node.parentNode.removeChild(node);
                                            cur = node.parentNode;
                                            continue;
                                        }
                                    }
                                }
                                break;
                            }
                        }

                        Array.from(document.querySelectorAll('.phrase-content')).forEach(function(pc){
                            try{
                                removeTrailingEmptyNodes(pc);
                                pc.style.display = 'block';
                                pc.style.paddingBottom = '0';
                                pc.style.minHeight = '0';
                                var last = pc.lastElementChild;
                                if(last && last.style){
                                    last.style.marginBottom = '0';
                                    last.style.paddingBottom = '0';
                                    last.style.display = 'block';
                                }
                            }catch(e){}
                        });
                    } catch (e) {
                        console.error('[ForcePhraseContentBlock] injection failed', e);
                    }
                })();
                """
            )
            ui_fix_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            ui_fix_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            ui_fix_script.setRunsOnSubFrames(False)
            page.scripts().insert(ui_fix_script)
        except Exception as e:
            print(f"[文本编辑器] 注入 UI 修复脚本失败: {e}")

    def _on_load_started(self) -> None:
        """页面开始加载"""
        self.setWindowTitle(f"文本编辑器 - {self.category_name} (加载中...)")
        print(f"[文本编辑器] 开始加载页面...")

    def _on_load_progress(self, progress: int) -> None:
        """页面加载进度"""
        if progress % 25 == 0:
            print(f"[文本编辑器] 加载进度: {progress}%")
        # 不显示加载百分比，只显示"加载中..."
        # self.setWindowTitle(f"文本编辑器 - {self.category_name} (加载中 {progress}%)")

    def _on_load_finished(self, success: bool) -> None:
        """页面加载完成"""
        if self._is_closing:
            return
        
        if self._load_timeout_timer:
            try:
                self._load_timeout_timer.stop()
            except Exception:
                pass
        
        if success:
            self.setWindowTitle(f"文本编辑器 - {self.category_name}（右键解锁编辑）")
            print(f"[文本编辑器] 页面加载完成")
            
            # 延迟执行初始化，避免阻塞
            try:
                QTimer.singleShot(200, self._ensure_page_ready)
            except Exception as e:
                print(f"[文本编辑器] 延迟初始化失败: {e}")
        else:
            print(f"[文本编辑器] ⚠️ 页面加载失败，但窗口将保持打开以便调试")
            self.setWindowTitle(f"文本编辑器 - {self.category_name} (加载失败)")
            # 不显示错误对话框，避免干扰调试
            # 窗口保持打开，用户可以看到错误信息

    def _on_load_timeout(self) -> None:
        """页面加载超时"""
        print(f"[文本编辑器] 页面加载超时")
        if not self._is_closing:
            QMessageBox.warning(self, "超时", "文本编辑器页面加载超时，请检查网络连接或重试。")
    
    def _on_js_console_message(self, level, message: str, line_number: int, source_id: str) -> None:
        """处理JavaScript控制台消息"""
        from PyQt6.QtWebEngineCore import QWebEnginePage
        
        # 过滤掉 QWebChannel 的内部错误（不影响功能）
        if "channel.execCallbacks" in message or "qwebchannel" in message.lower():
            return
        
        # 判断消息级别
        is_important = False
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.InfoMessageLevel:
            level_str = "INFO"
            # 只打印包含 [LOG] 的信息
            is_important = "[LOG]" in message or "[文本编辑器" in message or "[DEBUG savePhrase]" in message
        elif level == QWebEnginePage.JavaScriptConsoleMessageLevel.WarningMessageLevel:
            level_str = "WARNING"
            is_important = True
        elif level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            level_str = "ERROR"
            is_important = True
        else:
            level_str = "UNKNOWN"
            is_important = True
        
        # 只打印错误和警告，以及包含 [LOG] 的重要信息
        if is_important:
            # 打印原始消息
            print(f"[文本编辑器 JS {level_str}] {message} (行 {line_number})")
            # 针对 savePhrase 的 DEBUG 信息，额外打印尾部的 repr（便于发现零宽字符 / 转义等不可见字符）
            try:
                if "[DEBUG savePhrase]" in message:
                    tail = message[-1000:]
                    print("[文本编辑器 JS DEBUG TAIL REPR]:", repr(tail))
                    # 也打印最后 200 字符的 Unicode 转义形式，便于定位特殊码点
                    try:
                        print("[文本编辑器 JS DEBUG TAIL UNICODE_ESC]:", tail.encode('unicode_escape').decode('ascii', errors='ignore')[-1000:])
                    except Exception:
                        pass
            except Exception:
                pass
    
    def _on_feature_permission_requested(self, origin: QUrl, feature) -> None:
        """处理功能权限请求（如剪贴板访问）"""
        from PyQt6.QtWebEngineCore import QWebEnginePage
        
        # 自动授予剪贴板读写权限
        if feature == QWebEnginePage.Feature.ClipboardReadWrite:
            page = self.browser.page()
            if page:
                page.setFeaturePermission(origin, feature, QWebEnginePage.PermissionPolicy.PermissionGrantedByUser)
                print(f"[文本编辑器权限] 已授予剪贴板访问权限: {origin.toString()}")
        else:
            print(f"[文本编辑器权限] 收到权限请求: {origin.toString()}, feature={feature}")

    def _ensure_page_ready(self) -> None:
        """确保页面准备就绪"""
        if self._is_closing:
            return
        
        try:
            if not hasattr(self, 'browser') or not self.browser:
                print("[文本编辑器] 浏览器对象不存在")
                return
            
            page = self.browser.page()
            if not page:
                print("[文本编辑器] 页面对象不存在")
                return
            
            # 检查页面是否完全加载
            try:
                page.runJavaScript(
                    """
                    (function() {
                        try {
                            if (document.readyState === 'complete') {
                                console.log('[LOG] 页面已完全加载');
                                return true;
                            }
                            return false;
                        } catch (e) {
                            console.error('[LOG] 检查页面状态时出错:', e);
                            return false;
                        }
                    })();
                    """, 
                    lambda result: print(f"[文本编辑器] 页面状态检查: {result}") if not self._is_closing else None
                )
            except Exception as e:
                print(f"[文本编辑器] 执行 JavaScript 检查时出错: {e}")
        except Exception as e:
            print(f"[文本编辑器] 检查页面状态时出错: {e}")

    def _restore_window_geometry(self) -> None:
        """恢复窗口大小和位置（每个分类独立保存）"""
        try:
            config_dir = get_app_data_dir() / "desktop"
            config_dir.mkdir(parents=True, exist_ok=True)
            config_file = config_dir / "text_editor_window.ini"
            settings = QSettings(str(config_file), QSettings.Format.IniFormat)
            
            # 使用分类ID作为键，每个分类独立保存
            key = f"category_{self.category_id}/geometry"
            geometry = settings.value(key)
            if geometry and isinstance(geometry, (bytes, QByteArray)):
                if isinstance(geometry, bytes):
                    geometry = QByteArray(geometry)
                self.restoreGeometry(geometry)
                print(f"[文本编辑器] 已恢复分类 {self.category_id} 的窗口大小")
            else:
                # 默认大小
                self.resize(800, 700)
                print(f"[文本编辑器] 分类 {self.category_id} 使用默认窗口大小")
        except Exception as e:
            print(f"[文本编辑器] 恢复窗口大小失败: {e}")
            self.resize(800, 700)
    
    def _save_window_geometry_silent(self) -> None:
        """静默保存窗口大小和位置（每个分类独立保存）"""
        try:
            config_dir = get_app_data_dir() / "desktop"
            config_dir.mkdir(parents=True, exist_ok=True)
            config_file = config_dir / "text_editor_window.ini"
            settings = QSettings(str(config_file), QSettings.Format.IniFormat)
            
            # 使用分类ID作为键，每个分类独立保存
            key = f"category_{self.category_id}/geometry"
            settings.setValue(key, self.saveGeometry())
            settings.sync()
        except Exception as e:
            print(f"[文本编辑器] 保存窗口大小失败: {e}")

    def closeEvent(self, event) -> None:
        """窗口关闭事件"""
        self._is_closing = True
        try:
            # 保存窗口大小
            self._save_window_geometry_silent()
            
            # 停止自动保存定时器
            if hasattr(self, '_auto_save_timer') and self._auto_save_timer:
                try:
                    self._auto_save_timer.stop()
                    self._auto_save_timer.deleteLater()
                except Exception:
                    pass
                self._auto_save_timer = None
            
            # 停止超时定时器
            if self._load_timeout_timer:
                try:
                    self._load_timeout_timer.stop()
                    self._load_timeout_timer.deleteLater()
                except Exception:
                    pass
                self._load_timeout_timer = None
            
            # 清理 QWebChannel（必须在清理 browser 之前）
            if self._web_channel:
                try:
                    # 先清除页面上的 web channel
                    if hasattr(self, 'browser') and self.browser:
                        page = self.browser.page()
                        if page:
                            page.setWebChannel(None)
                except Exception as e:
                    print(f"[文本编辑器] 清理 WebChannel 时出错: {e}")
                try:
                    self._web_channel.deleteLater()
                except Exception:
                    pass
                finally:
                    self._web_channel = None
            
            # 清理 Bridge 对象
            if self._bridge:
                try:
                    self._bridge.deleteLater()
                except Exception:
                    pass
                self._bridge = None
            
            # 断开信号连接（使用 try-except 保护每个断开操作）
            if hasattr(self, 'browser') and self.browser:
                try:
                    page = self.browser.page()
                    if page:
                        try:
                            page.loadStarted.disconnect()
                        except Exception:
                            pass
                        try:
                            page.loadProgress.disconnect()
                        except Exception:
                            pass
                        try:
                            page.loadFinished.disconnect()
                        except Exception:
                            pass
                        try:
                            page.javaScriptConsoleMessage = None
                        except Exception:
                            pass
                except Exception:
                    pass
                
                # 停止加载
                try:
                    self.browser.stop()
                except Exception:
                    pass
                
                # 清理浏览器对象
                try:
                    self.browser.deleteLater()
                except Exception:
                    pass
            
            event.accept()
        except Exception as e:
            print(f"[文本编辑器] 关闭窗口时出错: {e}")
            event.accept()


class AnnouncementDialog(QDialog):
    """公告解读对话框"""

    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._is_closing = False
        self._load_timeout_timer = None
        self._setup_window()

    def _setup_window(self) -> None:
        self.setWindowTitle("公告解读")
        self.setMinimumSize(700, 500)
        self.setModal(True)  # 模态对话框

        # 创建浏览器
        self.browser = QWebEngineView()
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.browser)
        self.setLayout(layout)

        # 连接信号
        self.browser.loadStarted.connect(self._on_load_started)
        self.browser.loadProgress.connect(self._on_load_progress)
        self.browser.loadFinished.connect(self._on_load_finished)

        # 设置超时定时器
        self._load_timeout_timer = QTimer(self)
        self._load_timeout_timer.setSingleShot(True)
        self._load_timeout_timer.timeout.connect(self._on_load_timeout)
        self._load_timeout_timer.setInterval(30000)  # 30秒超时

        # 注入 Python Bridge
        self._inject_bridge()

        # 加载公告解读 HTML
        html_path = get_resource_path("announcement-dialog.html").resolve()
        if html_path.exists():
            self._load_timeout_timer.start()
            url = QUrl.fromLocalFile(str(html_path))
            print(f"[公告解读] 加载页面: {url.toString()}")
            self.browser.load(url)
        else:
            QMessageBox.warning(self, "错误", f"找不到公告解读文件：\n{html_path}")

    def _inject_bridge(self) -> None:
        """注入 Python Bridge 以便关闭窗口"""
        try:
            page = self.browser.page()
            if not page:
                print("[公告解读] 警告：页面对象不存在，无法注入 Bridge")
                return

            self._bridge = AnnouncementBridge(self)
            self._web_channel = QWebChannel()
            self._web_channel.registerObject("pythonBridge", self._bridge)
            page.setWebChannel(self._web_channel)
        except Exception as e:
            print(f"[公告解读] 注入 Bridge 时出错: {e}")
            import traceback
            traceback.print_exc()

    def _on_load_started(self) -> None:
        """页面开始加载"""
        self.setWindowTitle("公告解读 (加载中...)")
        print("[公告解读] 开始加载页面...")

    def _on_load_progress(self, progress: int) -> None:
        """页面加载进度"""
        if progress % 25 == 0:
            print(f"[公告解读] 加载进度: {progress}%")

    def _on_load_finished(self, success: bool) -> None:
        """页面加载完成"""
        self._load_timeout_timer.stop()

        if success:
            self.setWindowTitle("公告解读")
            print("[公告解读] 页面加载完成")
        else:
            print("[公告解读] ⚠️ 页面加载失败")
            self.setWindowTitle("公告解读 (加载失败)")

    def _on_load_timeout(self) -> None:
        """页面加载超时"""
        print("[公告解读] 页面加载超时")
        if not self._is_closing:
            QMessageBox.warning(self, "超时", "公告解读页面加载超时，请检查网络连接或重试。")

    def closeEvent(self, event) -> None:
        """窗口关闭事件"""
        self._is_closing = True
        print("[公告解读] 正在关闭窗口...")

        try:
            # 停止加载
            if hasattr(self, 'browser') and self.browser:
                self.browser.stop()

            # 清理 WebChannel
            if hasattr(self, '_web_channel') and self._web_channel:
                try:
                    page = self.browser.page()
                    if page:
                        page.setWebChannel(None)
                except Exception as e:
                    print(f"[公告解读] 清理 WebChannel 时出错: {e}")
                try:
                    self._web_channel.deleteLater()
                except Exception:
                    pass

            # 清理浏览器
            if hasattr(self, 'browser') and self.browser:
                try:
                    self.browser.deleteLater()
                except Exception:
                    pass

            event.accept()
        except Exception as e:
            print(f"[公告解读] 关闭窗口时出错: {e}")
            event.accept()


class AnnouncementBridge(QObject):
    """公告解读对话框的 Python Bridge"""

    def __init__(self, dialog: AnnouncementDialog) -> None:
        super().__init__()
        self.dialog = dialog

    @pyqtSlot()
    def closeDialog(self) -> None:
        """关闭公告解读对话框"""
        self.dialog.close()


class TextEditorBridge(QObject):
    """文本编辑器窗口的 Python Bridge"""

    def __init__(self, dialog: TextEditorDialog) -> None:
        super().__init__()
        self.dialog = dialog

    @pyqtSlot()
    def closeTextEditor(self) -> None:
        """关闭文本编辑器窗口"""
        self.dialog.close()

    @pyqtSlot(str, result=bool)
    def copy_text(self, text: str) -> bool:
        """将文本写入系统剪贴板"""
        try:
            QApplication.clipboard().setText(text)
            return True
        except Exception:
            return False

    @pyqtSlot(result=str)
    def getClipboardText(self) -> str:
        """读取系统剪贴板文本内容"""
        try:
            clipboard = QApplication.clipboard()
            text = clipboard.text()
            return text if text else ""
        except Exception:
            return ""

    @pyqtSlot(result=str)
    def getClipboardHtml(self) -> str:
        """读取系统剪贴板 HTML 内容"""
        try:
            clipboard = QApplication.clipboard()
            mime_data = clipboard.mimeData()
            if mime_data.hasHtml():
                html = mime_data.html()
                if html:
                    return html
            return ""
        except Exception:
            return ""


class PlaceholderDialog(QDialog):
    """占位符补全独立窗口"""

    def __init__(self, parent: "DesktopApp", content: str, placeholders: list) -> None:
        super().__init__(parent)
        self.content = content
        self.placeholders = placeholders
        self.app_window = parent
        self._is_closing = False
        self._web_channel = None
        self._bridge = None
        self._setup_window()

    def _setup_window(self) -> None:
        self.setWindowTitle("补全占位符")
        self.setMinimumSize(500, 300)
        
        # 根据占位符数量动态调整窗口大小
        placeholder_count = len(self.placeholders)
        if placeholder_count == 0:
            # 没有占位符，最小窗口
            self.resize(600, 350)
        elif placeholder_count <= 2:
            # 1-2个占位符，小窗口
            self.resize(600, 400)
        elif placeholder_count <= 4:
            # 3-4个占位符，中等窗口
            self.resize(600, 500)
        else:
            # 5个以上占位符，大窗口
            self.resize(600, 600)
        
        # 设置窗口标志
        self.setWindowFlags(Qt.WindowType.Window | 
                           Qt.WindowType.WindowTitleHint | 
                           Qt.WindowType.WindowSystemMenuHint | 
                           Qt.WindowType.WindowMinimizeButtonHint | 
                           Qt.WindowType.WindowMaximizeButtonHint | 
                           Qt.WindowType.WindowCloseButtonHint)

        # 样式
        self.setStyleSheet(
            "QDialog { background: #f5f5f5; border: 0px; }"
            "QWebEngineView { border: 0px; background: transparent; }"
        )
        self.setContentsMargins(0, 0, 0, 0)

        # 创建布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # 创建 WebView
        self.browser = QWebEngineView()
        layout.addWidget(self.browser)

        # 使用主窗口的 profile
        try:
            if self.app_window and self.app_window.profile:
                page = NoContextMenuWebEnginePage(self.app_window.profile, self.browser)
                self.browser.setPage(page)
            else:
                page = NoContextMenuWebEnginePage(self.browser)
                self.browser.setPage(page)
        except Exception as e:
            print(f"警告：无法使用主窗口 profile: {e}")
            page = NoContextMenuWebEnginePage(self.browser)
            self.browser.setPage(page)
        
        self.browser.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

        # 设置
        settings = self.browser.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)

        # 注入 Bridge
        self._inject_bridge()

        # 加载 HTML
        html_path = get_resource_path("placeholder-dialog.html").resolve()
        if html_path.exists():
            import json
            from urllib.parse import quote
            
            placeholders_json = quote(json.dumps(self.placeholders))
            content_encoded = quote(self.content)
            
            url = QUrl.fromLocalFile(str(html_path))
            url.setQuery(f"content={content_encoded}&placeholders={placeholders_json}")
            
            try:
                self.browser.load(url)
            except Exception as e:
                print(f"加载页面时出错: {e}")
                QMessageBox.warning(self, "错误", f"无法加载占位符补全页面：\n{e}")
        else:
            QMessageBox.warning(self, "错误", f"找不到占位符补全页面文件：\n{html_path}")

    def _inject_bridge(self) -> None:
        """注入 Python Bridge"""
        try:
            page = self.browser.page()
            if not page:
                return
            
            self._bridge = PlaceholderDialogBridge(self)
            self._web_channel = QWebChannel(page)
            self._web_channel.registerObject("pythonBridge", self._bridge)
            page.setWebChannel(self._web_channel)
        except Exception as e:
            print(f"[占位符对话框] 注入 Bridge 时出错: {e}")

        # 注入 WebChannel 加载器
        loader = QWebEngineScript()
        loader.setName("PlaceholderQtWebChannelLoader")
        loader.setSourceCode(
            """
            (function(){
                function ensureQWebChannel(retry){
                    if (typeof QWebChannel === 'undefined'){
                        if (!document.head) {
                            if (retry > 0) setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                            return;
                        }
                        var s = document.createElement('script');
                        s.src = 'qrc:///qtwebchannel/qwebchannel.js';
                        document.head.appendChild(s);
                        if (retry > 0) setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                    }
                }
                ensureQWebChannel(40);
            })();
            """
        )
        loader.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        loader.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        page.scripts().insert(loader)

        # 注入桥接初始化脚本
        bridge_script = QWebEngineScript()
        bridge_script.setName("PlaceholderBridgeSetup")
        bridge_script.setSourceCode(
            """
            (function() {
                function setup(retry) {
                    if (typeof qt === 'undefined' || typeof QWebChannel === 'undefined') {
                        if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 50);
                        return;
                    }
                    new QWebChannel(qt.webChannelTransport, function(channel) {
                        window.pythonBridge = channel.objects.pythonBridge;
                        console.log('[LOG] 占位符对话框 Python 桥接对象已注入');
                    });
                }
                setup(80);
            })();
            """
        )
        bridge_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        bridge_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        page.scripts().insert(bridge_script)

    def closeEvent(self, event) -> None:
        """窗口关闭事件"""
        self._is_closing = True
        try:
            if self._web_channel:
                try:
                    if hasattr(self, 'browser') and self.browser:
                        page = self.browser.page()
                        if page:
                            page.setWebChannel(None)
                except Exception:
                    pass
                try:
                    self._web_channel.deleteLater()
                except Exception:
                    pass
                self._web_channel = None
            
            if self._bridge:
                try:
                    self._bridge.deleteLater()
                except Exception:
                    pass
                self._bridge = None
            
            if hasattr(self, 'browser') and self.browser:
                try:
                    self.browser.stop()
                    self.browser.deleteLater()
                except Exception:
                    pass
            
            event.accept()
        except Exception as e:
            print(f"[占位符对话框] 关闭窗口时出错: {e}")
            event.accept()


class CalculatorDialog(QDialog):
    """计算器独立窗口 - 使用 calculator.py 中的 Calculator（补全功能使用）"""

    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._is_closing = False
        self.target_input_id = None  # 目标输入框 ID，用于回填
        self._setup_window()

    def _setup_window(self) -> None:
        # 导入 Calculator 类
        try:
            from calculator import Calculator
        except ImportError:
            print("[计算器] 错误：无法导入 Calculator 类")
            QMessageBox.warning(self, "错误", "无法加载计算器组件")
            return

        self.setWindowTitle("🧮 计算器")
        self.resize(200, 229)
        self.setMinimumSize(200, 229)

        # 设置窗口标志 - 使用普通窗口，置顶显示，不抢焦点
        self.setWindowFlags(Qt.WindowType.Window |
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.WindowTitleHint |
                           Qt.WindowType.WindowSystemMenuHint |
                           Qt.WindowType.WindowCloseButtonHint |
                           Qt.WindowType.WindowDoesNotAcceptFocus)

        # 设置窗口属性，不激活窗口
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)

        # 创建布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # 创建 Calculator 实例（作为子控件，不设置窗口标志）
        self.calculator = Calculator(standalone=False)
        layout.addWidget(self.calculator)


class CalculatorDialogWeb(QDialog):
    """计算器独立窗口 - 使用 calculator-dialog.html（底部工具栏使用）"""

    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._is_closing = False
        self.target_input_id = None  # 目标输入框 ID，用于回填
        self._setup_window()

    def _setup_window(self) -> None:
        self.setWindowTitle("🧮 计算器")
        self.resize(344, 480)
        self.setMinimumSize(344, 480)

        # 设置窗口标志 - 使用普通窗口，置顶显示，不抢焦点
        self.setWindowFlags(Qt.WindowType.Window |
                           Qt.WindowType.WindowStaysOnTopHint |
                           Qt.WindowType.WindowTitleHint |
                           Qt.WindowType.WindowSystemMenuHint |
                           Qt.WindowType.WindowCloseButtonHint |
                           Qt.WindowType.WindowDoesNotAcceptFocus)

        # 设置窗口属性，不激活窗口
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)

        # 样式
        self.setStyleSheet(
            "QDialog { background: #f5f5f5; border: 0px; }"
            "QWebEngineView { border: 0px; background: transparent; }"
        )
        self.setContentsMargins(0, 0, 0, 0)

        # 创建布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # 创建 WebView
        self.browser = QWebEngineView()
        layout.addWidget(self.browser)

        # 使用主窗口的 profile
        try:
            if self.app_window and self.app_window.profile:
                page = NoContextMenuWebEnginePage(self.app_window.profile, self.browser)
                self.browser.setPage(page)
            else:
                page = NoContextMenuWebEnginePage(self.browser)
                self.browser.setPage(page)
        except Exception as e:
            print(f"警告：无法使用主窗口 profile: {e}")
            page = NoContextMenuWebEnginePage(self.browser)
            self.browser.setPage(page)

        # 不禁用右键菜单，让 calculator-dialog.html 中的 JavaScript 控制右键菜单行为
        # self.browser.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

        # 设置
        settings = self.browser.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.FocusOnNavigationEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.XSSAuditingEnabled, False)

        # 设置 WebChannel
        from PyQt6.QtWebChannel import QWebChannel
        self._web_channel = QWebChannel()
        self.browser.page().setWebChannel(self._web_channel)

        # 将 PythonBridge 注册到 WebChannel
        if self.app_window and self.app_window.python_bridge:
            self._web_channel.registerObject("pythonBridge", self.app_window.python_bridge)

        # 加载 HTML
        html_path = get_resource_path("calculator-dialog.html").resolve()
        file_url = QUrl.fromLocalFile(str(html_path))
        self.browser.setUrl(file_url)

    def closeEvent(self, event) -> None:
        """关闭事件"""
        try:
            if not self._is_closing:
                self._is_closing = True

                # 从父窗口的字典中移除
                if self.app_window and hasattr(self.app_window, 'calculator_dialog_web'):
                    self.app_window.calculator_dialog_web = None
            event.accept()
        except Exception as e:
            print(f"[计算器] 关闭窗口时出错: {e}")
            event.accept()


class TitleDialog(QDialog):
    """标题输入对话框"""

    def __init__(self, parent: "DesktopApp", mode: str = "add", current_title: str = "", show_text_editor: bool = False) -> None:
        super().__init__(parent)
        self.app_window = parent
        self.mode = mode  # "add" 或 "edit"
        self.current_title = current_title
        self.show_text_editor = show_text_editor  # 是否显示文本编辑按钮
        self.result_text = ""
        self.result_show_text_editor = show_text_editor  # 返回的结果
        self._is_closing = False
        self._setup_window()

    def _setup_window(self) -> None:
        if self.mode == "add":
            self.setWindowTitle("添加标题")
        else:
            self.setWindowTitle("编辑标题")

        # 设置窗口大小 - 根据内容调整
        self.resize(300, 200)
        self.setMinimumSize(280, 180)
        self.setMaximumSize(350, 220)

        # 设置窗口标志
        self.setWindowFlags(Qt.WindowType.Window |
                           Qt.WindowType.WindowTitleHint |
                           Qt.WindowType.WindowSystemMenuHint |
                           Qt.WindowType.WindowCloseButtonHint)

        # 设置窗口居中显示
        self.setModal(True)

        # 设置窗口属性，确保背景正确绘制
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground, False)
        self.setContentsMargins(0, 0, 0, 0)

        # 样式设置 - 模仿分类对话框的样式
        self.setStyleSheet("""
            QDialog {
                background: #ffffff;
                border-radius: 12px;
                border: 1px solid #e0e0e0;
                box-shadow: 0 4px 24px rgba(0,0,0,0.15);
            }
            QLabel {
                font-size: 14px;
                color: #666;
                font-weight: 500;
            }
            QLineEdit {
                border: 1px solid #d0d0d0;
                border-radius: 6px;
                padding: 6px 12px;
                font-size: 14px;
                color: #333;
                background: #ffffff;
                margin: 0;
            }
            QLineEdit:focus {
                border-color: var(--theme-primary, #0078d4);
                outline: none;
            }
            QCheckBox {
                font-size: 14px;
                color: #333;
                spacing: 8px;
            }
            QCheckBox {
                font-size: 14px;
                color: #333;
                spacing: 8px;
            }
            /* 按钮样式通过内联样式设置 */
        """)

        # 设置窗口内容边距
        self.setContentsMargins(0, 0, 0, 0)

        # 创建主布局 - 垂直布局
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # 头部区域 - 简化为最小化空间，对话框标题已显示标题文字
        header_widget = QWidget()
        header_widget.setFixedHeight(10)  # 最小化高度
        header_widget.setStyleSheet("background: transparent; border-top-left-radius: 12px; border-top-right-radius: 12px;")
        header_layout = QHBoxLayout(header_widget)
        header_layout.setContentsMargins(0, 0, 0, 0)

        main_layout.addWidget(header_widget)

        # 内容区域 - 参考分类对话框的dialog-body
        content_widget = QWidget()
        content_widget.setStyleSheet("background: transparent;")
        content_layout = QVBoxLayout(content_widget)
        content_layout.setContentsMargins(20, 6, 20, 8)
        content_layout.setSpacing(10)

        # 表单组1：标题内容输入
        title_form_group = QWidget()
        title_form_layout = QVBoxLayout(title_form_group)
        title_form_layout.setContentsMargins(0, 0, 0, 0)
        title_form_layout.setSpacing(5)

        title_label = QLabel("标题内容 *")
        title_label.setStyleSheet("margin: 0; padding: 0;")
        title_form_layout.addWidget(title_label)

        self.title_input = QLineEdit()
        if self.mode == "edit" and self.current_title:
            self.title_input.setText(self.current_title)
        self.title_input.setPlaceholderText("请输入标题内容...")
        self.title_input.setFixedHeight(32)
        # 强制垂直居中显示输入文本（不改变控件尺寸）
        self.title_input.setAlignment(Qt.AlignmentFlag.AlignVCenter)
        # 为该输入框设置局部内边距，确保输入文本垂直居中显示（不改变控件外部大小）
        self.title_input.setStyleSheet("padding-top:0px; padding-bottom:0px; padding-left:8px; padding-right:8px;")
        title_form_layout.addWidget(self.title_input)
        # 在事件循环后调整文本边距，确保文字在渲染时可垂直居中（不修改控件大小）
        QTimer.singleShot(0, self._adjust_title_input_margins)

        content_layout.addWidget(title_form_group)

        # 表单组2：显示文本编辑按钮选项
        editor_form_group = QWidget()
        editor_form_layout = QVBoxLayout(editor_form_group)
        editor_form_layout.setContentsMargins(0, 0, 0, 0)
        editor_form_layout.setSpacing(5)

        self.show_text_editor_checkbox = QCheckBox("显示文本编辑按钮")
        self.show_text_editor_checkbox.setChecked(self.show_text_editor)

        # 移除自定义样式，让系统使用默认对钩绘制
        editor_form_layout.addWidget(self.show_text_editor_checkbox)

        hint_label = QLabel("勾选后，该标题上会显示文本编辑图标")
        hint_label.setStyleSheet("color: #888; font-size: 12px; margin: 0; padding: 0;")
        hint_label.setWordWrap(True)
        editor_form_layout.addWidget(hint_label)

        content_layout.addWidget(editor_form_group)

        main_layout.addWidget(content_widget)

        # 底部按钮区域 - 参考分类对话框的dialog-footer
        footer_widget = QWidget()
        footer_widget.setFixedHeight(50)
        footer_widget.setStyleSheet("background: #ffffff; border-top: 1px solid #e0e0e0; border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;")
        footer_layout = QHBoxLayout(footer_widget)
        footer_layout.setContentsMargins(20, 0, 20, 0)

        footer_layout.addStretch()

        # 取消按钮
        cancel_btn = QPushButton("取消")
        cancel_btn.clicked.connect(self.reject)
        cancel_btn.setStyleSheet("""
            QPushButton {
                background: #f5f5f5;
                color: #666;
                border: none;
                border-radius: 6px;
                padding: 10px 24px;
                font-size: 14px;
                font-weight: 500;
                min-width: 80px;
                cursor: pointer;
            }
            QPushButton:hover {
                background: #e8e8e8;
                color: #666;
            }
        """)
        footer_layout.addWidget(cancel_btn)

        # 保存按钮
        save_btn = QPushButton("保存")
        save_btn.clicked.connect(self.accept)
        save_btn.setDefault(True)  # 设置为默认按钮，按Enter键会触发
        save_btn.setStyleSheet("""
            QPushButton {
                background: #0078d4;
                color: white;
                border: 2px solid #005a9e;
                border-radius: 6px;
                padding: 10px 24px;
                font-size: 14px;
                font-weight: 500;
                min-width: 80px;
                cursor: pointer;
            }
            QPushButton:hover {
                background: #106ebe;
                border-color: #004d87;
                color: white;
            }
            QPushButton:pressed {
                background: #005a9e;
                border-color: #004080;
            }
        """)
        footer_layout.addWidget(save_btn)

        main_layout.addWidget(footer_widget)

        # 设置焦点到输入框
        self.title_input.setFocus()
        if self.mode == "edit" and self.current_title:
            self.title_input.selectAll()

        # 窗口居中显示（相对于父窗口）
        QTimer.singleShot(0, self._center_on_parent)

    def _center_on_parent(self) -> None:
        """将对话框居中显示在父窗口中央"""
        try:
            parent = self.parent()
            if parent:
                parent_geo = parent.geometry()
                x = parent_geo.x() + (parent_geo.width() - self.width()) // 2
                y = parent_geo.y() + (parent_geo.height() - self.height()) // 2
                self.move(x, y)
            else:
                # 无父窗口时居中于屏幕
                screen = QApplication.primaryScreen()
                if screen:
                    screen_rect = screen.availableGeometry()
                    x = screen_rect.x() + (screen_rect.width() - self.width()) // 2
                    y = screen_rect.y() + (screen_rect.height() - self.height()) // 2
                    self.move(x, y)
        except Exception as e:
            print(f"[TitleDialog] 居中失败: {e}")

    def accept(self) -> None:
        """确认按钮点击"""
        self.result_text = self.title_input.text().strip()
        if not self.result_text:
            QMessageBox.warning(self, "提示", "标题内容不能为空")
            return
        self.result_show_text_editor = self.show_text_editor_checkbox.isChecked()
        super().accept()

    def reject(self) -> None:
        """取消按钮点击"""
        self.result_text = ""
        self.result_show_text_editor = False
        super().reject()

    def closeEvent(self, event) -> None:
        """窗口关闭事件"""
        self._is_closing = True
        event.accept()

    def _adjust_title_input_margins(self) -> None:
        """根据字体度量和控件高度动态调整 QLineEdit 的 text margins，使文字垂直居中"""
        try:
            fm = self.title_input.fontMetrics()
            text_h = fm.height()
            ascent = fm.ascent()
            descent = fm.descent()
            # 如果控件高度为0（尚未布局），使用 sizeHint 作为备选
            h = self.title_input.height() or self.title_input.sizeHint().height() or 28
            # 优先使用 ascent/descent 计算基线位置，尽量让光标和文本基线居中
            # 基本居中计算
            top = max(0, (h - text_h) // 2)
            bottom = max(0, h - text_h - top)
            # 视觉微调：有时光标偏低，向上移动若干像素可改善
            visual_tweak = 0
            top = max(0, top - visual_tweak)
            bottom = max(0, bottom + visual_tweak)
            # 保留左右 8px 内边距
            self.title_input.setTextMargins(8, top, 8, bottom)
            # 触发重绘，确保光标与文本位置更新
            self.title_input.update()
        except Exception:
            pass


class PlaceholderDialogBridge(QObject):
    """占位符对话框的 Python Bridge"""

    def __init__(self, dialog: PlaceholderDialog) -> None:
        super().__init__()
        self.dialog = dialog

    @pyqtSlot()
    def closePlaceholderDialog(self) -> None:
        """关闭占位符对话框"""
        self.dialog.close()

    @pyqtSlot(str, result=bool)
    def copy_text(self, text: str) -> bool:
        """复制文本到剪贴板"""
        try:
            QApplication.clipboard().setText(text)
            return True
        except Exception:
            return False

    @pyqtSlot(result=str)
    def getClipboardText(self) -> str:
        """读取系统剪贴板文本内容"""
        try:
            clipboard = QApplication.clipboard()
            text = clipboard.text()
            return text if text else ""
        except Exception:
            return ""


class FloatingPanelBridge(QObject):
    """悬浮面板与 WebView 通信桥接"""
    phrase_clicked = None
    
    @pyqtSlot(str)
    def onPhraseClick(self, content: str) -> None:
        """话术被点击"""
        if self.phrase_clicked:
            self.phrase_clicked(content)
    
    @pyqtSlot(str)
    def onPhraseNumberClick(self, content: str) -> None:
        """序号被点击"""
        if hasattr(self, 'phrase_number_clicked') and self.phrase_number_clicked:
            self.phrase_number_clicked(content)
    
    @pyqtSlot(str)
    def onPhraseTextClick(self, content: str) -> None:
        """文本被点击"""
        if hasattr(self, 'phrase_text_clicked') and self.phrase_text_clicked:
            self.phrase_text_clicked(content)
    
    @pyqtSlot(str)
    def onAliasClick(self, alias_data: str) -> None:
        """代名词被点击"""
        if hasattr(self, 'alias_clicked') and self.alias_clicked:
            self.alias_clicked(alias_data)
    
    @pyqtSlot(str)
    def onJumpClick(self, category_id: str) -> None:
        """跳转分类被点击"""
        if hasattr(self, 'jump_clicked') and self.jump_clicked:
            self.jump_clicked(category_id)


class FloatingWebViewPanel(QWidget):
    """使用 WebView 的悬浮话术面板 - 复用前台模式样式"""
    
    MAX_HEIGHT = 400
    MAX_WIDTH = 500
    
    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._phrases = []
        self._aliases = []
        self._dual_mode = False
        self._theme_color = "#667eea"
        self._bridge = FloatingPanelBridge(self)
        self._bridge.phrase_clicked = self._on_phrase_clicked
        self._bridge.phrase_number_clicked = self._on_phrase_number_clicked
        self._bridge.phrase_text_clicked = self._on_phrase_text_clicked
        self._bridge.alias_clicked = self._on_alias_clicked
        self._bridge.jump_clicked = self._on_jump_clicked
        
        self._setup_window()
        self._setup_ui()
    
    def nativeEvent(self, eventType: bytes, message: int) -> tuple:
        if eventType == b"windows_generic_MSG":
            try:
                import ctypes
                msg = ctypes.wintypes.MSG.from_address(message)
                if msg.message == 0x0021:
                    return True, 3
            except Exception:
                pass
        return super().nativeEvent(eventType, message)
    
    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        self.setWindowOpacity(1.0)
        self.setMinimumWidth(300)
        self.setMaximumWidth(self.MAX_WIDTH)
    
    def _setup_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        # 头部
        self._header = QLabel()
        self._header.setStyleSheet("""
            QLabel {
                font-size: 12px;
                font-weight: bold;
                color: #333;
                padding: 6px 10px;
                background: #f8f9fa;
                border-bottom: 1px solid #e9ecef;
            }
        """)
        layout.addWidget(self._header)
        
        # WebView
        self._web_view = QWebEngineView()
        self._web_view.setMinimumHeight(100)
        self._web_view.setMaximumHeight(self.MAX_HEIGHT)
        self._web_view.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding
        )
        
        # 设置 WebChannel
        self._channel = QWebChannel()
        self._channel.registerObject('pyBridge', self._bridge)
        self._web_view.page().setWebChannel(self._channel)
        
        layout.addWidget(self._web_view, 1)
        
        # 底部提示
        self._footer = QLabel("点击话术复制并发送 | ESC 关闭")
        self._footer.setStyleSheet("""
            QLabel {
                font-size: 10px;
                color: #666;
                padding: 4px 10px;
                background: #f8f9fa;
                border-top: 1px solid #e9ecef;
            }
        """)
        layout.addWidget(self._footer)
    
    def _generate_html(self, aliases: list = None, phrases: list = None, category_name: str = "", alias: str = "") -> str:
        """生成 HTML 内容，直接引入前台 styles.css 并复用话术卡片结构"""
        import os
        css_path = os.path.join(os.path.dirname(__file__), 'styles.css')
        
        html = """<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        /* 基础样式 */
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            height: 100%;
            width: 100%;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: white;
            overflow: hidden;
        }
        
        /* 双栏容器 - 使用flexbox布局确保分离 */
        .dual-container {
            display: flex;
            width: 100%;
            height: 100%;
            min-height: 300px;
        }
        
        /* 左栏 - 代名词列表 */
        .alias-panel {
            flex: 0 0 140px;
            width: 140px;
            background: #fafafa;
            border-right: 1px solid #e0e0e0;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
        }
        
        .alias-item {
            padding: 8px 10px;
            cursor: pointer;
            border-bottom: 1px solid #eee;
            font-size: 12px;
            transition: background 0.15s;
            flex-shrink: 0;
        }
        
        .alias-item:hover {
            background: #f0f0f0;
        }
        
        .alias-item.selected {
            background: #e8e8f0;
            border-left: 3px solid var(--theme-primary, #667eea);
            padding-left: 7px;
        }
        
        .alias-name {
            font-weight: bold;
            color: var(--theme-primary, #667eea);
        }
        
        .alias-category {
            font-size: 11px;
            color: #888;
            margin-top: 2px;
        }
        
        /* 右栏 - 话术列表 */
        .phrase-panel {
            flex: 1;
            padding: 4px;
            overflow-y: auto;
            background: white;
            min-width: 300px;
        }
        
        /* 话术卡片样式 - 与前台 styles.css 一致 */
        .phrase-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        
        .phrase-item {
            background: white;
            border: 1px solid #b0b0b0;
            border-radius: 8px;
            padding: 8px;
            margin: 0;
            cursor: pointer;
            transition: background 0.2s, box-shadow 0.2s, transform 0.2s;
            position: relative;
            display: flex;
            flex-direction: column;
        }
        
        .phrase-item:hover {
            background: #f8f9fa;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            transform: translateY(-1px);
        }
        
        .phrase-item:hover .phrase-actions {
            opacity: 1;
        }
        
        .phrase-content {
            font-size: 13px;
            color: #333;
            line-height: 1.4;
            word-break: break-word;
            padding: 4px 0;
            display: flex;
            align-items: flex-start;
            flex-wrap: wrap;
            -webkit-user-select: text;
            user-select: text;
            cursor: text;
        }
        
        /* 序号样式 */
        .phrase-number {
            display: inline-block;
            min-width: 18px;
            height: 18px;
            line-height: 18px;
            text-align: center;
            background: var(--theme-primary, #667eea);
            color: white;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            margin-right: 6px;
            vertical-align: middle;
            cursor: pointer;
            -webkit-user-select: none;
            user-select: none;
        }
        
        /* 话术操作按钮 */
        .phrase-actions {
            display: flex;
            gap: 6px;
            opacity: 1;  /* 始终显示按钮 */
            transition: opacity 0.2s;
            padding: 4px 0 0 0;
            margin-top: 4px;
            border-top: 1px solid #f0f0f0;
            padding-top: 6px;
        }
        
        .phrase-action-btn {
            padding: 4px 10px;
            font-size: 11px;
            border: 1px solid #ddd;
            background: #f5f5f5;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s;
            font-weight: 500;
        }
        
        .phrase-action-btn:hover {
            background: #e8e8e8;
            border-color: #ccc;
            transform: translateY(-1px);
        }
        
        .phrase-action-btn.copy-btn {
            background: var(--theme-primary, #667eea);
            color: white;
            border-color: var(--theme-primary, #667eea);
            font-weight: bold;
        }
        
        .phrase-action-btn.copy-btn:hover {
            background: #5a6fd6;
            box-shadow: 0 2px 4px rgba(102, 126, 234, 0.3);
        }
        
        /* 图片指示器 */
        .phrase-image-indicator {
            font-size: 14px;
            margin-right: 6px;
            color: #ff6b6b;
            background: #fff5f5;
            padding: 2px 4px;
            border-radius: 4px;
            border: 1px solid #ffcccc;
        }
        
        /* 跳转链接 */
        .phrase-jump-row {
            padding: 6px 0;
            margin-top: 4px;
            border-top: 1px solid #f0f0f0;
            display: flex;
            align-items: center;
        }
        
        .phrase-jump-link {
            font-size: 11px;
            color: var(--theme-primary, #667eea);
            cursor: pointer;
            background: #f0f4ff;
            padding: 3px 8px;
            border-radius: 4px;
            border: 1px solid #d0d8ff;
            font-weight: 500;
        }
        
        .phrase-jump-link:hover {
            background: #e0e8ff;
            text-decoration: none;
        }
        
        /* 标签 */
        .phrase-tags-inline {
            color: #666;
            font-size: 11px;
            background: #f8f9fa;
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid #e9ecef;
            margin-left: 8px;
            font-weight: 500;
        }
        
        /* 子话术 */
        .phrase-children {
            margin-top: 4px;
            padding: 4px 8px;
            border-top: 1px dashed #e0e0e0;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        
        .child-item {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            background: #f0f0f0;
            border-radius: 4px;
            font-size: 11px;
            color: var(--theme-primary, #667eea);
            cursor: pointer;
            transition: background 0.15s;
        }
        
        .child-item:hover {
            background: #e0e0e0;
        }
        
        .child-number {
            font-weight: bold;
            margin-right: 4px;
        }
        
        /* 单栏模式 */
        .single-panel {
            padding: 4px;
        }
        
        /* 滚动条样式 */
        ::-webkit-scrollbar {
            width: 8px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: #c1c1c1;
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #a8a8a8;
        }
        
        /* 主题色变量 */
        :root {
            --theme-primary: #667eea;
        }
    </style>
</head>
<body>
    <script src="qrc:///qtwebchannel/qwebchannel.js"></script>
    <script>
        var pyBridge = null;
        new QWebChannel(qt.webChannelTransport, function(channel) {
            pyBridge = channel.objects.pyBridge;
        });
        
        function onPhraseClick(content) {
            if (pyBridge) {
                pyBridge.onPhraseClick(content);
            }
        }
        
        function onPhraseNumberClick(content) {
            if (pyBridge) {
                pyBridge.onPhraseNumberClick(content);
            }
        }
        
        function onPhraseTextClick(content) {
            if (pyBridge) {
                pyBridge.onPhraseTextClick(content);
            }
        }
        
        function onAliasClick(alias, categoryId) {
            if (pyBridge) {
                pyBridge.onAliasClick(JSON.stringify({alias: alias, categoryId: categoryId}));
            }
        }
        
        function onJumpClick(categoryId) {
            if (pyBridge) {
                pyBridge.onJumpClick(categoryId);
            }
        }
        
        // ====== 序号悬浮样式兜底方案（参考天若OCR：状态锁 + 无防抖） ======
        
        function clearAllPhraseNumberHoverStyles() {
            const allPhraseNumbers = document.querySelectorAll('.phrase-number');
            allPhraseNumbers.forEach(btn => {
                btn.classList.remove('hover', 'active', 'focus');
                btn.style.removeProperty('background');
                btn.style.removeProperty('color');
                btn.style.removeProperty('transform');
                btn.style.removeProperty('box-shadow');
                btn.style.removeProperty('border-color');
            });
            console.log('[悬浮窗兜底] 已清除 ' + allPhraseNumbers.length + ' 个序号按钮的悬浮样式');
        }
        
        function isMouseOnPhraseNumber(target) {
            return target.classList && target.classList.contains('phrase-number') ||
                   target.closest && target.closest('.phrase-number');
        }
        
        // 鼠标离开序号时清除悬浮样式（状态锁 + 无防抖）
        document.addEventListener('mouseleave', function(e) {
            const target = e.target;
            if (target.classList && target.classList.contains('phrase-number') || 
                target.closest && target.closest('.phrase-number')) {
                console.log('[悬浮窗] 鼠标离开序号，清除悬浮样式');
                clearAllPhraseNumberHoverStyles();
            }
        }, true);
        
        // 点击序号按钮后强制清除悬浮样式
        document.addEventListener('click', function(e) {
            if (isMouseOnPhraseNumber(e.target)) {
                console.log('[悬浮窗兜底] 点击序号按钮，强制清除悬浮样式');
                clearAllPhraseNumberHoverStyles();
            }
        }, true);
    </script>
"""
        
        if aliases and phrases:
            # 双栏模式
            html += '    <div class="dual-container">\n'
            
            # 左栏 - 代名词
            html += '        <div class="alias-panel">\n'
            for i, item in enumerate(aliases):
                selected = ' selected' if i == 0 else ''
                html += f'''            <div class="alias-item{selected}" onclick="onAliasClick('{item.get("alias", "")}', '{item.get("categoryId", "")}')">
                <div class="alias-name">{item.get("alias", "")}</div>
                <div class="alias-category">{item.get("categoryName", "")}</div>
            </div>\n'''
            html += '        </div>\n'
            
            # 右栏 - 话术
            html += '        <div class="phrase-panel">\n'
            html += '            <div class="phrase-list">\n'
            for i, phrase in enumerate(phrases):
                html += self._generate_phrase_card_html(phrase, i + 1)
            html += '            </div>\n'
            html += '        </div>\n'
            html += '    </div>\n'
        elif phrases:
            # 单栏模式 - 只有话术
            html += '    <div class="single-panel">\n'
            html += '        <div class="phrase-list">\n'
            for i, phrase in enumerate(phrases):
                html += self._generate_phrase_card_html(phrase, i + 1)
            html += '        </div>\n'
            html += '    </div>\n'
        elif aliases:
            # 单栏模式 - 只有代名词
            html += '    <div class="single-panel">\n'
            html += '        <div class="phrase-list">\n'
            for i, item in enumerate(aliases):
                html += f'''            <div class="phrase-item" onclick="onAliasClick('{item.get("alias", "")}', '{item.get("categoryId", "")}')">
                <div class="phrase-content"><strong style="color:var(--theme-primary)">{item.get("alias", "")}</strong> - {item.get("categoryName", "")}</div>
            </div>\n'''
            html += '        </div>\n'
            html += '    </div>\n'
        
        html += """</body>
</html>"""
        return html
    
    def _generate_phrase_card_html(self, phrase: dict, index: int) -> str:
        """生成单个话术卡片的 HTML，与前台结构一致"""
        content = phrase.get('content', '')
        content_html = phrase.get('content_html', '')
        display_content = content_html if content_html else content.replace('<', '&lt;').replace('>', '&gt;')
        if len(content) > 150 and not content_html:
            display_content = content[:150].replace('<', '&lt;').replace('>', '&gt;') + '...'
        
        # 图片指示器
        has_images = phrase.get('images') and len(phrase.get('images', [])) > 0
        image_indicator = '<span class="phrase-image-indicator" title="包含图片">🖼️</span> ' if has_images else ''
        
        # 标签
        tags_str = phrase.get('tags', '')
        tag_prefix = phrase.get('tag_prefix', False)
        tags_display = ''
        if tags_str:
            tags = [t.strip() for t in tags_str.split(',') if t.strip()]
            if tags:
                prefix_class = ' tag-prefix' if tag_prefix else ''
                tags_display = ' <span class="phrase-tags-inline' + prefix_class + '">' + ' '.join(f'#{t}' for t in tags) + '</span>'

        # 跳转链接
        jump_category_id = phrase.get('jump_category_id')
        jump_category_name = phrase.get('jump_category_name', '跳转')
        jump_html = ''
        if jump_category_id:
            jump_html = f'''                <div class="phrase-jump-row">
                    <span class="phrase-jump-link" onclick="event.stopPropagation(); onJumpClick('{jump_category_id}')">{jump_category_name}➤</span>
                </div>\n'''
        
        # 子话术
        children = phrase.get('children', [])
        children_html = ''
        if children:
            children_html = '                <div class="phrase-children">\n'
            for j, child in enumerate(children):
                child_content = child.get('content', '').replace("'", "\\'").replace('"', '&quot;')
                children_html += f'''                    <div class="child-item" onclick="event.stopPropagation(); onPhraseClick('{child_content}')">
                        <span class="child-number">○{j + 1}</span>
                    </div>\n'''
            children_html += '                </div>\n'
        
        # 转义内容用于 onclick
        escaped_content = content.replace("'", "\\'").replace('"', '&quot;')
        
        # 操作按钮 - 确保即使没有特殊功能也显示复制按钮
        actions_html = '                <div class="phrase-actions">\n'
        actions_html += f'                    <button class="phrase-action-btn copy-btn" onclick="event.stopPropagation(); onPhraseClick(\'{escaped_content}\')">复制</button>\n'
        
        # 添加功能按钮
        has_special_buttons = False
        if phrase.get('enable_placeholder'):
            actions_html += f'                    <button class="phrase-action-btn" onclick="event.stopPropagation(); alert(\'补全功能\')">补全</button>\n'
            has_special_buttons = True
        if phrase.get('enable_images'):
            actions_html += f'                    <button class="phrase-action-btn" onclick="event.stopPropagation(); alert(\'图片功能\')">图片</button>\n'
            has_special_buttons = True
        if phrase.get('enable_description'):
            actions_html += f'                    <button class="phrase-action-btn" onclick="event.stopPropagation(); alert(\'说明功能\')">说明</button>\n'
            has_special_buttons = True
            
        # 如果没有特殊按钮，添加一个占位符来保持布局
        if not has_special_buttons:
            actions_html += '                    <div style="flex: 1"></div>\n'
            
        actions_html += '                </div>\n'
        
        # 构建完整的话术卡片HTML（根据 tag_prefix 决定标签位置）
        if tag_prefix:
            # 标签前置：序号 → 图片指示器 → 标签 → 话术内容
            content_line = f'{image_indicator}{tags_display}{display_content}'
        else:
            # 标签后置（默认）：序号 → 图片指示器 → 话术内容 → 标签
            content_line = f'{image_indicator}{display_content}{tags_display}'

        html = f'''            <div class="phrase-item" onclick="onPhraseTextClick('{escaped_content}')">
                <div class="phrase-content">
                    <span class="phrase-number" onclick="event.stopPropagation(); onPhraseNumberClick('{escaped_content}')">{index}</span>
                    {content_line}
                </div>
                {jump_html}
                {children_html}
                {actions_html}
            </div>\n'''

        return html
    
    def _on_phrase_number_clicked(self, content: str) -> None:
        """序号被点击 - 复制、不抢焦点粘贴、关闭"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            self.app_window.paste_to_last_external_no_focus_steal()
        self.hide()
    
    def _on_phrase_text_clicked(self, content: str) -> None:
        """文本被点击 - 仅复制到剪贴板，不粘贴，不关闭"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
    
    def _on_phrase_clicked(self, content: str) -> None:
        """话术被点击 - 兼容入口，走序号点击逻辑"""
        self._on_phrase_number_clicked(content)
    
    def _on_alias_clicked(self, alias_data: str) -> None:
        """代名词被点击"""
        try:
            import json
            data = json.loads(alias_data)
            alias = data.get('alias', '')
            category_id = data.get('categoryId', '')
            
            print(f"[FloatingWebViewPanel] 选择代名词: {alias}, 分类ID: {category_id}")
            
            # 调用 JavaScript 函数更新话术列表
            js_code = f"""
            (async function() {{
                if (window.__selectAliasAndShowPhrases) {{
                    await window.__selectAliasAndShowPhrases('{category_id}', '{alias}');
                }}
            }})();
            """
            self.app_window.web_view.page().runJavaScript(js_code)
        except Exception as e:
            print(f"[FloatingWebViewPanel] 代名词点击处理错误: {e}")
    
    def _on_jump_clicked(self, category_id: str) -> None:
        """跳转分类被点击"""
        try:
            print(f"[FloatingWebViewPanel] 跳转到分类: {category_id}")
            
            # 调用 JavaScript 函数跳转到分类
            js_code = f"""
            (async function() {{
                if (window.__jumpToCategory) {{
                    await window.__jumpToCategory('{category_id}');
                }}
            }})();
            """
            self.app_window.web_view.page().runJavaScript(js_code)
        except Exception as e:
            print(f"[FloatingWebViewPanel] 跳转处理错误: {e}")
    
    def show_phrases(self, category_name: str, alias: str, phrases: list, cursor_pos: tuple = None) -> None:
        """显示话术列表"""
        self._phrases = phrases
        self._aliases = []
        self._dual_mode = False
        
        self._header.setText(f"{alias} → {category_name}")
        self._footer.setText("点击话术复制并发送 | ESC 关闭")
        
        self.setMinimumWidth(300)
        self.setMaximumWidth(self.MAX_WIDTH)
        
        html = self._generate_html(phrases=phrases)
        self._web_view.setHtml(html)
        
        self._move_to_top_right()
        self.show()
        self.raise_()
    
    def show_aliases(self, aliases: list, current_input: str, cursor_pos: tuple = None) -> None:
        """显示代名词列表"""
        self._aliases = aliases
        self._phrases = []
        self._dual_mode = False
        
        self._header.setText(f"输入: {current_input}")
        self._footer.setText("点击选择 | ESC 关闭")
        
        self.setMinimumWidth(300)
        self.setMaximumWidth(self.MAX_WIDTH)
        
        html = self._generate_html(aliases=aliases)
        self._web_view.setHtml(html)
        
        self._move_to_top_right()
        self.show()
        self.raise_()
        self.activateWindow()
    
    def show_dual_panel(self, aliases: list, current_input: str, category_name: str, phrases: list, selected_alias: str = None, cursor_pos: tuple = None) -> None:
        """显示双栏面板"""
        self._aliases = aliases
        self._phrases = phrases
        self._dual_mode = True
        
        self._header.setText(f"{current_input} → {category_name}")
        self._footer.setText("点击话术发送 | 点击代名词切换 | ESC 关闭")
        
        self.setMinimumWidth(480)
        self.setMaximumWidth(600)
        
        # 调试：打印话术数据
        if phrases:
            print(f"[FloatingWebViewPanel] 收到 {len(phrases)} 个话术")
            for i, p in enumerate(phrases[:3]):  # 只打印前3个话术的详细信息
                print(f"[FloatingWebViewPanel] 话术 #{i+1} 字段: {list(p.keys())}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} content: '{p.get('content', '')[:50]}...'")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} tags: '{p.get('tags', '')}'")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} images: {len(p.get('images', []))}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} jump_category_id: {p.get('jump_category_id')}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} enable_placeholder: {p.get('enable_placeholder')}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} enable_images: {p.get('enable_images')}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} enable_description: {p.get('enable_description')}")
                print(f"[FloatingWebViewPanel] 话术 #{i+1} children: {len(p.get('children', []))}")
                print("---")
        
        html = self._generate_html(aliases=aliases, phrases=phrases)
        self._web_view.setHtml(html)
        
        self._move_to_top_right()
        self.show()
        self.raise_()
        self.activateWindow()
    
    def update_phrases(self, category_name: str, alias: str, phrases: list) -> None:
        """更新话术列表"""
        self._phrases = phrases
        self._header.setText(f"{alias} → {category_name}")
        
        html = self._generate_html(aliases=self._aliases, phrases=phrases)
        self._web_view.setHtml(html)
    
    def _move_to_top_right(self) -> None:
        """移动窗口到屏幕右上角"""
        screen = QApplication.primaryScreen()
        if screen:
            screen_rect = screen.availableGeometry()
            # 使用固定高度而不是 maximumHeight
            height = min(400, screen_rect.height() - 100)
            self.resize(self.minimumWidth(), height)
            x = screen_rect.right() - self.width() - 20
            y = screen_rect.top() + 20
            self.move(x, y)
    
    def keyPressEvent(self, event) -> None:
        """键盘事件处理"""
        if event.key() == Qt.Key.Key_Escape:
            self.hide()
            return
        super().keyPressEvent(event)


class _PhraseWebBridge(QObject):
    """WebEngine话术区域与Python的通信桥梁"""

    def __init__(self, panel: "SimpleFloatingPanel") -> None:
        super().__init__(panel)
        self._panel = panel

    @pyqtSlot(str)
    def onPhraseClicked(self, content: str) -> None:
        self._panel._on_phrase_clicked(content)

    @pyqtSlot(str)
    def onPhraseNumberClicked(self, content: str) -> None:
        self._panel._on_phrase_number_clicked(content)

    @pyqtSlot(str)
    def onPhraseTextClicked(self, content: str) -> None:
        self._panel._on_phrase_text_clicked(content)

    @pyqtSlot()
    def onPhraseListScrolled(self) -> None:
        self._panel._update_number_button_positions()


class SimpleFloatingPanel(QWidget):
    """简化版悬浮话术面板 - 支持多代名词选择和话术展示"""
    
    MAX_HEIGHT = 800  # 最大高度800px
    MIN_WIDTH = 420
    MAX_WIDTH = 650
    
    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._phrases = []
        self._aliases = []
        self._all_phrases_data = {}
        self._selected_alias_index = 0
        self._trigger_text = ""
        self._number_buttons = []  # 透明序号按钮列表
        self._phrase_contents = []  # 序号对应的话术内容列表
        
        self._setup_window()
        self._setup_ui()
    
    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool |
            Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setAutoFillBackground(False)
        self.setMinimumWidth(self.MIN_WIDTH)
        self.setMaximumWidth(self.MAX_WIDTH)
        
        self.setStyleSheet("""
            SimpleFloatingPanel {
                background: rgba(255, 255, 255, 224);
                border-radius: 4px;
                border: 1px solid rgba(200, 200, 200, 150);
            }
        """)
    
    def _setup_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(6, 6, 6, 6)
        main_layout.setSpacing(0)
        
        # ====== 代名词列表区域（垂直列表） ======
        self._alias_scroll_area = QScrollArea()
        self._alias_scroll_area.setWidgetResizable(True)
        self._alias_scroll_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._alias_scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._alias_scroll_area.setFrameShape(QScrollArea.Shape.NoFrame)
        self._alias_scroll_area.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._alias_scroll_area.setStyleSheet("""
            QScrollArea {
                border: none;
                background: rgba(248, 248, 248, 230);
                border-top-left-radius: 4px;
                border-top-right-radius: 4px;
                border-bottom: none;
            }
            QScrollBar:vertical {
                width: 2px;
                background: transparent;
            }
            QScrollBar::handle:vertical {
                background: #0066cc;
                border-radius: 1px;
                min-height: 20px;
            }
        """)
        
        # 代名词容器
        self._alias_container = QWidget()
        self._alias_container.setStyleSheet("background: transparent;")
        self._alias_layout = QVBoxLayout(self._alias_container)
        self._alias_layout.setContentsMargins(0, 0, 0, 0)
        self._alias_layout.setSpacing(0)
        self._alias_layout.addStretch()
        
        self._alias_scroll_area.setWidget(self._alias_container)
        self._alias_scroll_area.viewport().setStyleSheet("background: transparent;")  # 设置viewport样式
        main_layout.addWidget(self._alias_scroll_area)
        
        # ====== 话术列表区域（WebEngine渲染） ======
        self._phrase_webview = QWebEngineView(self)
        self._phrase_webview.setMinimumHeight(0)
        self._phrase_webview.setMaximumHeight(0)
        self._phrase_webview.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed
        )
        self._phrase_webview.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._phrase_webview.setStyleSheet("QWebEngineView { background: transparent; border: none; }")
        self._phrase_webview.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self._phrase_webview.hide()
        
        self._phrase_channel = QWebChannel(self)
        self._phrase_bridge = _PhraseWebBridge(self)
        self._phrase_channel.registerObject('pyBridge', self._phrase_bridge)
        self._phrase_webview.page().setWebChannel(self._phrase_channel)
        
        self._phrase_webview.page().setBackgroundColor(Qt.GlobalColor.transparent)
        
        main_layout.addWidget(self._phrase_webview)
    
    def show_aliases_and_phrases(self, aliases_json: str, phrases_json: str, trigger_text: str = "", all_phrases_json: str = "") -> None:
        """显示代名词列表和话术（主入口方法）
        
        Args:
            aliases_json: JSON格式的代名词列表
            phrases_json: JSON格式的话术列表（对应第一个代名词）
            trigger_text: 触发悬浮窗的输入文字
            all_phrases_json: JSON格式的所有代名词话术数据 {alias: [phrases]}
        """
        import json
        
        try:
            aliases = json.loads(aliases_json) if aliases_json else []
            initial_phrases = json.loads(phrases_json) if phrases_json else []
            
            self._trigger_text = trigger_text
            self._aliases = aliases
            self._all_phrases_data = {}
            
            if all_phrases_json:
                try:
                    self._all_phrases_data = json.loads(all_phrases_json)
                except json.JSONDecodeError:
                    pass
            
            if not self._all_phrases_data and aliases:
                first_alias_key = f"{aliases[0].get('alias', '')}"
                self._all_phrases_data[first_alias_key] = initial_phrases
            
            self._selected_alias_index = 0
            
            self._rebuild_alias_buttons()
            self._update_phrase_display(initial_phrases)
            
            if not initial_phrases:
                self._adjust_size_and_show()
            
        except json.JSONDecodeError as e:
            print(f"[SimpleFloatingPanel] JSON解析错误: {e}")
        except Exception as e:
            print(f"[SimpleFloatingPanel] show_aliases_and_phrases 错误: {e}")
            import traceback
            traceback.print_exc()
    
    def show_phrases(self, alias_info: str, phrases: list) -> None:
        """显示话术列表（兼容旧接口 - 单个代名词模式）
        
        Args:
            alias_info: 代名词信息，格式如 "a,问候和反馈同模版版"
            phrases: 话术列表，每个话术是字典
        """
        print(f"[SimpleFloatingPanel] 显示话术(单代名词模式): {len(phrases)} 个")
        print(f"[SimpleFloatingPanel] 代名词信息: {alias_info}")
        
        # 解析代名词信息
        parts = alias_info.split(',', 1)
        alias = parts[0] if parts else ''
        category_name = parts[1] if len(parts) > 1 else ''
        
        # 构造单个代名词的列表
        single_alias = [{
            'alias': alias,
            'categoryName': category_name,
            'categoryId': ''
        }]
        
        self._aliases = single_alias
        self._all_phrases_data = {alias: phrases}
        self._selected_alias_index = 0
        
        self._rebuild_alias_buttons()
        self._update_phrase_display(phrases)
        
        if not phrases:
            self._adjust_size_and_show()
    
    def _rebuild_alias_buttons(self) -> None:
        """重建代名词按钮列表"""
        # 清空现有按钮
        while self._alias_layout.count():
            item = self._alias_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        # 为每个代名词创建列表项（垂直布局）
        for i, alias_data in enumerate(self._aliases):
            alias = alias_data.get('alias', '')
            category_name = alias_data.get('categoryName', '')
            
            # 创建列表项容器
            item_widget = QWidget()
            item_widget.setCursor(Qt.CursorShape.PointingHandCursor)
            item_widget.setFixedHeight(28)  # 固定高度28px（更紧凑）
            
            # 水平布局：代名词 + 分类名称
            item_layout = QHBoxLayout(item_widget)
            item_layout.setContentsMargins(8, 0, 8, 0)  # 左右边距8px，上下边距0（文字上下贴边）
            item_layout.setSpacing(6)  # 减少间距
            
            # 代名词标签（左侧，加粗）
            alias_label = QLabel(alias)
            alias_label.setAlignment(Qt.AlignmentFlag.AlignVCenter)  # 垂直居中
            alias_label.setStyleSheet("""
                QLabel {
                    font-size: 15px;
                    font-weight: bold;
                    color: #000;
                    background: transparent;
                    border: none;
                    padding: 0;
                    margin: 0;
                    line-height: 1.0;
                }
            """)
            item_layout.addWidget(alias_label)
            
            # 分类名称标签（右侧，黑色）
            category_label = QLabel(category_name)
            category_label.setAlignment(Qt.AlignmentFlag.AlignVCenter)  # 垂直居中
            category_label.setStyleSheet("""
                QLabel {
                    font-size: 14px;
                    color: #000;
                    background: transparent;
                    border: none;
                    padding: 0;
                    margin: 0;
                    line-height: 1.0;
                }
            """)
            item_layout.addWidget(category_label)
            item_layout.addStretch()
            
            # 设置整体样式（选中 vs 普通）
            if i == self._selected_alias_index:
                item_widget.setStyleSheet("""
                    QWidget {
                        background: rgba(220, 232, 255, 240);
                        border: none;
                        border-left: 3px solid rgba(102, 126, 234, 255);
                        border-bottom: 1px solid rgba(192, 212, 240, 200);
                        padding: 0;
                        margin: 0;
                    }
                """)
                alias_label.setStyleSheet("""
                    QLabel {
                        font-size: 15px;
                        font-weight: bold;
                        color: #667eea;
                        background: transparent;
                        border: none;
                        padding: 0;
                        margin: 0;
                    }
                """)
            else:
                item_widget.setStyleSheet("""
                    QWidget {
                        background: transparent;
                        border: none;
                        border-left: 3px solid transparent;
                        border-bottom: 1px solid rgba(240, 240, 240, 200);
                        padding: 0;
                        margin: 0;
                    }
                    QWidget:hover {
                        background: rgba(245, 245, 245, 240);
                        border-left: 3px solid rgba(192, 192, 192, 255);
                    }
                """)
            
            # 绑定点击事件
            item_widget.mousePressEvent = lambda event, idx=i: self._on_alias_clicked(idx)
            
            self._alias_layout.addWidget(item_widget)
        
        # 添加弹性空间
        self._alias_layout.addStretch()
    
    def _on_alias_clicked(self, index: int) -> None:
        """代名词被点击"""
        if index < 0 or index >= len(self._aliases):
            return
        
        self._selected_alias_index = index
        alias_data = self._aliases[index]
        alias = alias_data.get('alias', '')
        
        self._rebuild_alias_buttons()
        
        phrases = self._all_phrases_data.get(alias, [])
        
        if not phrases:
            print(f"[SimpleFloatingPanel] 代名词 {alias} 暂无话术数据")
        
        self._update_phrase_display(phrases)
        
        if not phrases:
            self._adjust_size_and_show()
    
    def update_phrases_for_alias(self, alias: str, phrases: list) -> None:
        """更新指定代名词的话术数据（供外部调用）"""
        self._all_phrases_data[alias] = phrases
        
        if self._selected_alias_index < len(self._aliases):
            current_alias = self._aliases[self._selected_alias_index].get('alias', '')
            if current_alias == alias:
                self._update_phrase_display(phrases)
                if not phrases:
                    self._adjust_size_and_show()
    
    def _update_phrase_display(self, phrases: list) -> None:
        """更新话术列表显示（WebEngine渲染）"""
        self._phrases = phrases
        self._clear_number_buttons()  # 清除旧的透明按钮
        
        if not phrases:
            self._phrase_webview.hide()
            self._phrase_webview.setMinimumHeight(0)
            self._phrase_webview.setMaximumHeight(0)
            return
        
        self._phrase_webview.setMinimumHeight(0)
        self._phrase_webview.setMaximumHeight(0)
        self._phrase_webview.show()
        
        html = self._generate_phrase_html(phrases)
        self._phrase_webview.setHtml(html, QUrl("about:blank"))
        
        self._adjust_size_and_show()
        
        self._height_retry_count = 0
        QTimer.singleShot(200, self._on_webview_content_ready)
    
    def _on_webview_content_ready(self) -> None:
        """WebView内容加载完成后，精准计算卡片容器高度"""
        js_code = """
        (function() {
            var list = document.getElementById('phrase-list');
            if (!list) return 0;
            var rect = list.getBoundingClientRect();
            return Math.ceil(rect.height);
        })();
        """
        self._phrase_webview.page().runJavaScript(
            js_code,
            self._on_height_calculated
        )
    
    def _on_height_calculated(self, height) -> None:
        """WebView高度计算完成 - 精准设置WebView高度"""
        if height and height > 0:
            alias_count = len(self._aliases)
            alias_item_height = 28
            max_visible_items = 5
            if alias_count <= max_visible_items:
                alias_area_height = alias_count * alias_item_height
            else:
                alias_area_height = max_visible_items * alias_item_height
            
            max_phrase_height = self.MAX_HEIGHT - 6 - alias_area_height - 6
            actual_height = min(int(height), max(20, max_phrase_height))
            self._phrase_webview.setMinimumHeight(actual_height)
            self._phrase_webview.setMaximumHeight(actual_height)
            self._adjust_size_and_show()
            # WebView渲染完成后，获取序号位置并创建透明按钮
            QTimer.singleShot(100, self._create_number_overlay_buttons)
        else:
            self._height_retry_count = getattr(self, '_height_retry_count', 0) + 1
            if self._height_retry_count < 8:
                QTimer.singleShot(80, self._on_webview_content_ready)
            else:
                self._phrase_webview.setMinimumHeight(40)
                self._phrase_webview.setMaximumHeight(40)
                self._adjust_size_and_show()
    
    def _generate_phrase_html(self, phrases: list) -> str:
        """生成话术列表HTML（100%复用前台卡片样式）"""
        cards_html = ""
        for i, phrase in enumerate(phrases):
            cards_html += self._generate_card_html(phrase, i + 1)

        return '''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
    --theme-primary: #667eea;
    --theme-primary-dark: #5a6fd8;
    --theme-primary-light: rgba(102, 126, 234, 0.1);
    --theme-hover-shadow: rgba(102, 126, 234, 0.2);
    --phrase-used-bg: rgba(102, 126, 234, 0.18);
    --phrase-used-bg-hover: rgba(102, 126, 234, 0.26);
    --phrase-used-border: rgba(102, 126, 234, 0.55);
    --phrase-used-shadow: rgba(102, 126, 234, 0.28);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    overflow-y: auto;
    overflow-x: hidden;
    color: #333;
    height: auto;
}

::-webkit-scrollbar { width: 2px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #0066cc; border-radius: 1px; }

.phrase-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 2px 4px 2px 4px;
    background: rgba(248, 248, 248, 230);
    border-bottom-left-radius: 4px;
    border-bottom-right-radius: 4px;
}

.phrase-item {
    background: white;
    border: 1px solid #b0b0b0;
    border-radius: 8px;
    padding: 2px 4px 4px 4px;
    margin: 2px;
    cursor: pointer;
    transition: background 0.2s, box-shadow 0.2s, transform 0.2s;
    position: relative;
}

.phrase-item:first-child { margin-top: 0; }
.phrase-item:last-child { margin-bottom: 2px; }

.phrase-item:hover {
    border-color: var(--theme-primary);
    box-shadow: 0 2px 8px var(--theme-hover-shadow);
}

.phrase-content {
    font-size: 14px;
    line-height: 1.4;
    color: #333;
    word-break: break-word;
    padding: 0;
    margin: 0;
    transition: font-size 0.2s ease;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
}

.phrase-image-indicator {
    display: inline-block;
    margin-right: 2px;
    margin-left: 0px;
    margin-top: 0px;
    font-size: 12px;
    opacity: 0.7;
    vertical-align: middle;
    transform: translateY(-2px);
    transition: opacity 0.2s ease;
    user-select: none;
    line-height: 1;
}

.phrase-item:hover .phrase-image-indicator { opacity: 0.9; }

.phrase-tags-inline {
    margin-left: 8px;
    font-size: 15px;
    font-weight: 700;
    color: #2563eb;
    letter-spacing: 0.3px;
    -webkit-user-select: none;
    user-select: none;
    pointer-events: none;
}

.phrase-tag {
    display: inline-block;
    padding: 2px 6px;
    background: #e8e8e8;
    border-radius: 8px;
    margin-left: 4px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    color: #444;
}

.phrase-jump-row {
    display: block;
    margin-top: -3px;
    padding-left: 0;
}

.phrase-jump-link {
    display: inline-block;
    color: #007bff;
    font-weight: normal;
    font-size: 16px;
    cursor: pointer;
    margin-left: 0;
    padding: 0 1px;
    border-radius: 3px;
    transition: all 0.2s ease;
    text-decoration: none;
    border: 1px solid transparent;
    line-height: 1.1;
    -webkit-user-select: none;
    user-select: none;
}

.phrase-jump-link:hover {
    background-color: rgba(0, 123, 255, 0.1);
    border-color: rgba(0, 123, 255, 0.3);
    text-decoration: underline;
}

.phrase-number {
    display: inline-block;
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    font-size: 11px;
    font-weight: bold;
    color: white;
    background: var(--theme-primary);
    border-radius: 9px;
    margin-right: 6px;
    vertical-align: middle;
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
}

.phrase-category-label {
    display: inline-block;
    background: rgba(102, 126, 234, 0.1);
    color: var(--theme-primary);
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 11px;
    margin-right: 6px;
    font-weight: bold;
}

.phrase-children-group {
    margin: 2px 0 0 0;
    padding: 3px 4px 3px 4px;
    border: 1px solid #cc3333;
    border-radius: 4px;
    background: rgba(255, 240, 240, 0.5);
}

.child-item {
    display: flex;
    align-items: center;
    padding: 1px 4px 1px 2px;
    margin: 1px 0;
    cursor: pointer;
    border-radius: 3px;
    transition: background 0.15s;
}

.child-item:hover {
    background: rgba(204, 51, 51, 0.08);
}

.child-number {
    display: inline-block;
    min-width: 16px;
    height: 16px;
    line-height: 16px;
    text-align: center;
    font-size: 10px;
    font-weight: bold;
    color: white;
    background: #cc3333;
    border-radius: 8px;
    margin-right: 5px;
    vertical-align: middle;
}

.child-content {
    font-size: 13px;
    line-height: 1.3;
    color: #555;
    word-break: break-word;
}
</style>
</head>
<body>
<div id="phrase-list" class="phrase-list">
''' + cards_html + '''
</div>
<script src="qrc:///qtwebchannel/qwebchannel.js"></script>
<script>
new QWebChannel(qt.webChannelTransport, function(channel) {
    window.pyBridge = channel.objects.pyBridge;
});

function onPhraseNumberClick(content) {
    if (window.pyBridge) {
        window.pyBridge.onPhraseNumberClicked(content);
    }
}

function onPhraseTextClick(content) {
    if (window.pyBridge) {
        window.pyBridge.onPhraseTextClicked(content);
    }
}

function onPhraseClick(content) {
    if (window.pyBridge) {
        window.pyBridge.onPhraseClicked(content);
    }
}

// 监听滚动事件，通知Python更新透明按钮位置
document.addEventListener('scroll', function() {
    if (window.pyBridge && window.pyBridge.onPhraseListScrolled) {
        window.pyBridge.onPhraseListScrolled();
    }
}, true);
</script>
</body>
</html>'''
    
    def _generate_card_html(self, phrase: dict, index: int) -> str:
        """生成单个话术卡片HTML（100%复用前台createPhraseItem结构）"""
        import html as html_module

        content = phrase.get('content', '')
        content_html_field = phrase.get('content_html', '')
        tags_str = phrase.get('tags', '')
        images = phrase.get('images', [])
        jump_category_id = phrase.get('jump_category_id')
        jump_category_name = phrase.get('jump_category_name', '')
        text_color = phrase.get('text_color', '')
        bg_color = phrase.get('bg_color', '')
        is_bold = phrase.get('is_bold', False)

        tags = [t.strip() for t in tags_str.split(',') if t.strip()] if tags_str else []
        tags_for_display = ' '.join(f'#{t}' for t in tags) if tags else ''
        tag_prefix = phrase.get('tag_prefix', False)
        prefix_class = ' tag-prefix' if tag_prefix else ''
        tags_inline_html = f' <span class="phrase-tags-inline{prefix_class}">{html_module.escape(tags_for_display)}</span>' if tags_for_display else ''

        image_indicator = '<span class="phrase-image-indicator" title="此话术包含图片">🖼️</span>' if images else ''

        if content_html_field:
            display_content = content_html_field
        else:
            display_content = html_module.escape(content)

        style_attrs = []
        if not content_html_field:
            if text_color:
                style_attrs.append(f'color: {text_color}')
            if bg_color:
                style_attrs.append(f'background-color: {bg_color}')
            if is_bold:
                style_attrs.append('font-weight: bold')
        style_str = f' style="{"; ".join(style_attrs)}"' if style_attrs else ''

        jump_html = ''
        if jump_category_id:
            jump_name = html_module.escape(jump_category_name or '跳转')
            jump_html = f'<div class="phrase-jump-row"><span class="phrase-jump-link">{jump_name}➤</span></div>'

        escaped_content = content.replace('\\', '\\\\').replace("'", "\\'").replace('"', '&quot;').replace('\n', '\\n').replace('\r', '')

        number_html = f'<span class="phrase-number" data-content="{escaped_content}">{index}</span>'

        data_tags_attr = f' data-tags="{html_module.escape(tags_for_display)}"' if tags_for_display else ''

        children = phrase.get('children', [])
        children_html = ''
        if children:
            children_html = '<div class="phrase-children-group">'
            for ci, child in enumerate(children):
                child_content = child.get('content', '')
                escaped_child = child_content.replace('\\', '\\\\').replace("'", "\\'").replace('"', '&quot;').replace('\n', '\\n').replace('\r', '')
                children_html += f'''<div class="child-item" onclick="event.stopPropagation(); onPhraseNumberClick('{escaped_child}')">
    <span class="child-number">{ci + 1}</span>
    <span class="child-content">{html_module.escape(child_content)}</span>
</div>'''
            children_html += '</div>'

        # 根据 tag_prefix 决定标签位置
        if tag_prefix:
            content_line = f'{number_html}{image_indicator}{tags_inline_html}{display_content}'
        else:
            content_line = f'{number_html}{image_indicator}{display_content}{tags_inline_html}'

        return f'''<div class="phrase-item" onclick="onPhraseTextClick('{escaped_content}')">
    <div class="phrase-content"{data_tags_attr}{style_str}>
        {content_line}
    </div>
    {jump_html}
    {children_html}
</div>'''
    
    def _on_phrase_number_clicked(self, content: str) -> None:
        """序号被点击 - 复制内容、删除触发文字、不抢焦点粘贴、关闭"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            self._delete_trigger_text()
            self.app_window.paste_to_last_external_no_focus_steal()
        self.hide()
    
    def _on_phrase_text_clicked(self, content: str) -> None:
        """文本被点击 - 仅复制到剪贴板，不粘贴，不关闭悬浮窗"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
    
    def _on_phrase_clicked(self, content: str) -> None:
        """话术被点击 - 兼容入口，默认走序号点击逻辑"""
        self._on_phrase_number_clicked(content)
    
    def _clear_number_buttons(self) -> None:
        """清除所有透明序号按钮"""
        for btn in self._number_buttons:
            btn.deleteLater()
        self._number_buttons.clear()
        self._phrase_contents.clear()
    
    def _create_number_overlay_buttons(self) -> None:
        """通过JS获取HTML序号元素位置，在WebView上方创建透明Qt按钮"""
        self._clear_number_buttons()
        
        if not self._phrases:
            return
        
        # JS代码：获取所有 .phrase-number 元素的位置和对应content
        js_code = """
        (function() {
            var numbers = document.querySelectorAll('.phrase-number');
            var result = [];
            numbers.forEach(function(el) {
                var rect = el.getBoundingClientRect();
                var content = el.getAttribute('data-content') || '';
                result.push({
                    x: rect.left,
                    y: rect.top,
                    w: rect.width,
                    h: rect.height,
                    content: content
                });
            });
            return JSON.stringify(result);
        })();
        """
        self._phrase_webview.page().runJavaScript(
            js_code,
            self._on_number_positions_received
        )
    
    def _on_number_positions_received(self, result) -> None:
        """JS返回序号位置后，创建透明按钮"""
        if not result:
            return
        
        import json
        try:
            positions = json.loads(result) if isinstance(result, str) else []
        except (json.JSONDecodeError, TypeError):
            return
        
        if not positions:
            return
        
        # WebView在面板中的位置偏移
        webview_pos = self._phrase_webview.pos()
        
        for pos_data in positions:
            x = pos_data.get('x', 0)
            y = pos_data.get('y', 0)
            w = pos_data.get('w', 18)
            h = pos_data.get('h', 18)
            content = pos_data.get('content', '')
            
            if not content or w <= 0 or h <= 0:
                continue
            
            # 创建透明按钮，位置相对于面板
            btn = QPushButton(self)
            btn.setGeometry(
                webview_pos.x() + int(x) - 2,
                webview_pos.y() + int(y) - 2,
                int(w) + 4,
                int(h) + 4
            )
            btn.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    border: none;
                }
                QPushButton:hover {
                    background: rgba(102, 126, 234, 0.15);
                    border-radius: 9px;
                }
            """)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            btn.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, False)
            btn.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
            
            # 绑定点击事件
            captured_content = content  # 闭包捕获
            btn.mousePressEvent = lambda e, c=captured_content: self._on_overlay_number_click(c)
            
            btn.show()
            btn.raise_()
            
            self._number_buttons.append(btn)
            self._phrase_contents.append(content)
    
    def _on_overlay_number_click(self, content: str) -> None:
        """透明序号按钮被点击 - 复制、删除触发文字、不抢焦点粘贴、关闭"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            self._delete_trigger_text()
            self.app_window.paste_to_last_external_no_focus_steal()
        self.hide()
    
    def _update_number_button_positions(self) -> None:
        """滚动后更新透明按钮位置"""
        if not self._number_buttons:
            return
        
        js_code = """
        (function() {
            var numbers = document.querySelectorAll('.phrase-number');
            var result = [];
            numbers.forEach(function(el) {
                var rect = el.getBoundingClientRect();
                result.push({
                    x: rect.left,
                    y: rect.top,
                    w: rect.width,
                    h: rect.height
                });
            });
            return JSON.stringify(result);
        })();
        """
        self._phrase_webview.page().runJavaScript(
            js_code,
            self._on_scroll_positions_updated
        )
    
    def _on_scroll_positions_updated(self, result) -> None:
        """滚动后位置更新回调"""
        if not result or not self._number_buttons:
            return
        
        import json
        try:
            positions = json.loads(result) if isinstance(result, str) else []
        except (json.JSONDecodeError, TypeError):
            return
        
        if len(positions) != len(self._number_buttons):
            return
        
        webview_pos = self._phrase_webview.pos()
        
        for i, pos_data in enumerate(positions):
            if i >= len(self._number_buttons):
                break
            x = pos_data.get('x', 0)
            y = pos_data.get('y', 0)
            w = pos_data.get('w', 18)
            h = pos_data.get('h', 18)
            
            self._number_buttons[i].setGeometry(
                webview_pos.x() + int(x) - 2,
                webview_pos.y() + int(y) - 2,
                int(w) + 4,
                int(h) + 4
            )
    
    def _delete_trigger_text(self) -> None:
        """在目标输入框中删除触发悬浮窗的输入文字"""
        if not self._trigger_text:
            return
        try:
            import ctypes
            user32 = ctypes.windll.user32
            VK_BACK = 0x08
            for _ in self._trigger_text:
                user32.keybd_event(VK_BACK, 0, 0, 0)
                user32.keybd_event(VK_BACK, 0, 2, 0)
            import time
            time.sleep(0.02)
        except Exception:
            pass
    
    def _adjust_size_and_show(self) -> None:
        """调整窗口大小并显示 - 精准布局，类目区和话术区紧密贴合"""
        alias_count = len(self._aliases)
        alias_item_height = 28
        max_visible_items = 5
        outer_margin_top = 6
        outer_margin_bottom = 6
        section_gap = 0
        
        if alias_count <= max_visible_items:
            alias_area_height = alias_count * alias_item_height
            self._alias_scroll_area.setMinimumHeight(alias_area_height)
            self._alias_scroll_area.setMaximumHeight(alias_area_height)
            self._alias_scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        else:
            alias_area_height = max_visible_items * alias_item_height
            self._alias_scroll_area.setMinimumHeight(alias_area_height)
            self._alias_scroll_area.setMaximumHeight(alias_area_height)
            self._alias_scroll_area.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        
        phrase_count = len(self._phrases)
        phrase_area_height = self._phrase_webview.maximumHeight() if phrase_count > 0 else 0
        
        if phrase_area_height <= 0:
            total_height = outer_margin_top + alias_area_height + outer_margin_bottom
            total_height = max(total_height, 40)
        else:
            max_phrase_height = self.MAX_HEIGHT - outer_margin_top - alias_area_height - section_gap - outer_margin_bottom
            phrase_area_height = min(phrase_area_height, max(20, max_phrase_height))
            self._phrase_webview.setMinimumHeight(phrase_area_height)
            self._phrase_webview.setMaximumHeight(phrase_area_height)
            
            total_height = outer_margin_top + alias_area_height + section_gap + phrase_area_height + outer_margin_bottom
            total_height = min(total_height, self.MAX_HEIGHT)
        
        width = self.MIN_WIDTH
        self.resize(width, int(total_height))
        
        screen = QApplication.primaryScreen()
        if screen:
            screen_rect = screen.availableGeometry()
            x = screen_rect.right() - width - 20
            y = screen_rect.top() + 20
            self.move(x, y)
        
        self.show()
        self.raise_()
    
    def hideEvent(self, event) -> None:
        """面板隐藏时清除透明按钮"""
        self._clear_number_buttons()
        super().hideEvent(event)
    
    def keyPressEvent(self, event) -> None:
        """键盘事件处理"""
        if event.key() == Qt.Key.Key_Escape:
            self.hide()
        super().keyPressEvent(event)


class FloatingPhrasePanel(QWidget):
    """悬浮话术面板（参考 VS Code 代码补全样式）"""
    
    MAX_HEIGHT = 320
    ITEM_FONT_SIZE = 11
    NUM_FONT_SIZE = 10
    
    def __init__(self, parent: "DesktopApp") -> None:
        super().__init__(parent)
        self.app_window = parent
        self._is_closing = False
        self._selected_index = 0
        self._child_mode = False
        self._phrases = []
        self._aliases = []
        self._dual_mode = False
        self._theme_color = "#667eea"
        
        self._setup_window()
        self._setup_ui()
    
    def _setup_window(self) -> None:
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool |
            Qt.WindowType.WindowDoesNotAcceptFocus
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, False)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setWindowOpacity(1.0)
    
    def _setup_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        
        # 头部
        self._header = QLabel()
        self._header.setStyleSheet("""
            QLabel {
                font-size: 11px;
                font-weight: bold;
                color: #555;
                padding: 4px 8px;
                background: #f3f3f3;
                border-bottom: 1px solid #e0e0e0;
            }
        """)
        main_layout.addWidget(self._header)
        
        self._dual_container = QWidget()
        self._dual_layout = QHBoxLayout(self._dual_container)
        self._dual_layout.setContentsMargins(0, 0, 0, 0)
        self._dual_layout.setSpacing(0)
        self._dual_container.setStyleSheet("""
            QWidget#dualContainer {
                background-color: #ffffff;
            }
        """)
        self._dual_container.setObjectName("dualContainer")
        
        # 左栏框架 - 代名词列表
        self._alias_frame = QWidget()
        self._alias_frame.setStyleSheet("""
            QWidget#aliasFrame {
                background: #fafafa;
                border-right: 1px solid #e0e0e0;
            }
        """)
        self._alias_frame.setObjectName("aliasFrame")
        self._alias_frame.setFixedWidth(150)
        
        alias_frame_layout = QVBoxLayout(self._alias_frame)
        alias_frame_layout.setContentsMargins(0, 0, 0, 0)
        alias_frame_layout.setSpacing(0)
        
        self._alias_scroll = QScrollArea()
        self._alias_scroll.setWidgetResizable(True)
        self._alias_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._alias_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._alias_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self._alias_scroll.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._alias_scroll.setStyleSheet("""
            QScrollArea {
                background: transparent;
                border: none;
            }
            QScrollBar:vertical {
                background: transparent;
                width: 8px;
                margin: 0;
            }
            QScrollBar::handle:vertical {
                background: #c1c1c1;
                border-radius: 4px;
                min-height: 20px;
            }
            QScrollBar::handle:vertical:hover {
                background: #a8a8a8;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                height: 0;
            }
        """)
        self._alias_scroll.setMaximumHeight(self.MAX_HEIGHT)
        
        self._alias_widget = QWidget()
        self._alias_layout = QVBoxLayout(self._alias_widget)
        self._alias_layout.setContentsMargins(0, 0, 0, 0)
        self._alias_layout.setSpacing(0)
        self._alias_widget.setStyleSheet("QWidget { background: transparent; }")
        self._alias_scroll.setWidget(self._alias_widget)
        alias_frame_layout.addWidget(self._alias_scroll)
        self._dual_layout.addWidget(self._alias_frame)
        
        # 右栏框架 - 话术列表
        self._phrase_frame = QWidget()
        self._phrase_frame.setStyleSheet("""
            QWidget#phraseFrame {
                background: #ffffff;
            }
        """)
        self._phrase_frame.setObjectName("phraseFrame")
        self._phrase_frame.setMinimumWidth(300)
        
        phrase_frame_layout = QVBoxLayout(self._phrase_frame)
        phrase_frame_layout.setContentsMargins(0, 0, 0, 0)
        phrase_frame_layout.setSpacing(0)
        
        self._phrase_scroll = QScrollArea()
        self._phrase_scroll.setWidgetResizable(True)
        self._phrase_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._phrase_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._phrase_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self._phrase_scroll.setStyleSheet("""
            QScrollArea {
                background: transparent;
                border: none;
            }
            QScrollBar:vertical {
                background: transparent;
                width: 8px;
                margin: 0;
            }
            QScrollBar::handle:vertical {
                background: #c1c1c1;
                border-radius: 4px;
                min-height: 20px;
            }
            QScrollBar::handle:vertical:hover {
                background: #a8a8a8;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                height: 0;
            }
        """)
        self._phrase_scroll.setMaximumHeight(self.MAX_HEIGHT)
        
        self._phrase_widget = QWidget()
        self._phrase_layout = QVBoxLayout(self._phrase_widget)
        self._phrase_layout.setContentsMargins(0, 0, 0, 0)
        self._phrase_layout.setSpacing(0)
        self._phrase_widget.setStyleSheet("QWidget { background: transparent; }")
        self._phrase_scroll.setWidget(self._phrase_widget)
        phrase_frame_layout.addWidget(self._phrase_scroll)
        self._dual_layout.addWidget(self._phrase_frame, 1)
        
        self._phrase_frame.hide()
        
        main_layout.addWidget(self._dual_container)
        
        self._content_scroll = QScrollArea()
        self._content_scroll.setWidgetResizable(True)
        self._content_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._content_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self._content_scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self._content_scroll.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._content_scroll.setStyleSheet("""
            QScrollArea {
                background: #ffffff;
                border: none;
            }
            QScrollBar:vertical {
                background: #ffffff;
                width: 8px;
                margin: 0;
            }
            QScrollBar::handle:vertical {
                background: #c1c1c1;
                border-radius: 4px;
                min-height: 20px;
            }
            QScrollBar::handle:vertical:hover {
                background: #a8a8a8;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                height: 0;
            }
        """)
        self._content_scroll.setMaximumHeight(self.MAX_HEIGHT)
        
        self._content_widget = QWidget()
        self._content_layout = QVBoxLayout(self._content_widget)
        self._content_layout.setContentsMargins(0, 0, 0, 0)
        self._content_layout.setSpacing(0)
        self._content_widget.setStyleSheet("QWidget { background: #ffffff; }")
        self._content_scroll.setWidget(self._content_widget)
        main_layout.addWidget(self._content_scroll)
        
        # 底部状态栏
        self._footer = QLabel("点击选择 | 数字键选择 | ESC 关闭")
        self._footer.setStyleSheet("""
            QLabel {
                font-size: 10px;
                color: #666;
                padding: 3px 8px;
                background: #f3f3f3;
                border-top: 1px solid #e0e0e0;
            }
        """)
        main_layout.addWidget(self._footer)
        
        self._apply_theme()
    
    def _apply_theme(self) -> None:
        self.setStyleSheet(f"""
            FloatingPhrasePanel {{
                background-color: #ffffff;
                border: 1px solid #cccccc;
                border-radius: 5px;
            }}
        """)
    
    def set_theme_color(self, color: str) -> None:
        self._theme_color = color
        self._apply_theme()
    
    def show_phrases(self, category_name: str, alias: str, phrases: list, cursor_pos: tuple = None) -> None:
        print(f"[悬浮面板] show_phrases 被调用: category={category_name}, alias={alias}, phrases数量={len(phrases) if phrases else 0}")
        
        self._phrases = phrases
        self._selected_index = 0
        self._child_mode = False
        self._dual_mode = False
        
        self._header.setText(f"{alias} → {category_name}")
        
        while self._content_layout.count():
            item = self._content_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        for i, phrase in enumerate(phrases):
            item_widget = self._create_phrase_item(i + 1, phrase)
            self._content_layout.addWidget(item_widget)
        
        self._content_layout.addStretch()
        
        self._dual_container.hide()
        self._content_scroll.show()
        
        self._content_scroll.setMinimumWidth(280)
        self._content_scroll.setMaximumWidth(450)
        
        self._footer.setText("点击序号发送 | ESC关闭")
        
        self._move_to_top_right()
        
        self.show()
        self.raise_()
        print(f"[悬浮面板] 窗口已显示，位置: ({self.x()}, {self.y()}), 大小: ({self.width()}, {self.height()})")
    
    def _create_phrase_item(self, index: int, phrase: dict) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        main_row = QWidget()
        main_layout = QHBoxLayout(main_row)
        main_layout.setContentsMargins(6, 2, 6, 2)
        main_layout.setSpacing(4)
        
        # 序号标签
        num_label = QLabel(f"{index}.")
        num_label.setStyleSheet(f"""
            QLabel {{
                font-size: {self.NUM_FONT_SIZE}px;
                font-weight: bold;
                color: {self._theme_color};
                background: transparent;
                min-width: 14px;
                padding: 2px 0;
            }}
        """)
        num_label.setCursor(Qt.CursorShape.PointingHandCursor)
        num_label.mousePressEvent = lambda e, p=phrase: self._on_phrase_number_click(p)
        main_layout.addWidget(num_label)
        
        # 话术内容标签
        content_text = phrase.get('content', '')
        if len(content_text) > 80:
            content_text = content_text[:80] + '...'
        content_label = QLabel(content_text)
        content_label.setWordWrap(True)
        content_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        content_label.setStyleSheet(f"""
            QLabel {{
                font-size: {self.ITEM_FONT_SIZE}px;
                color: #333;
                background: transparent;
                padding: 2px 4px;
                border-radius: 3px;
            }}
            QLabel:hover {{
                background-color: #f0f0f0;
            }}
        """)
        content_label.setCursor(Qt.CursorShape.IBeamCursor)
        content_label.mousePressEvent = lambda e, p=phrase: self._on_phrase_text_click(p)
        main_layout.addWidget(content_label, 1)
        
        main_row.setStyleSheet("QWidget { background: transparent; border-bottom: 1px solid #e5e5e5; }")
        main_row.setMinimumHeight(20)
        main_row.setMaximumHeight(40)
        layout.addWidget(main_row)
        
        children = phrase.get('children', [])
        if children:
            child_row = QWidget()
            child_layout = QHBoxLayout(child_row)
            child_layout.setContentsMargins(20, 1, 6, 1)
            child_layout.setSpacing(2)
            
            for j, child in enumerate(children):
                child_label = QLabel(f"○{j + 1}")
                child_label.setStyleSheet(f"""
                    QLabel {{
                        font-size: {self.NUM_FONT_SIZE}px;
                        color: {self._theme_color};
                        background: transparent;
                        padding: 0 2px;
                        border-radius: 2px;
                    }}
                    QLabel:hover {{
                        background-color: #f0f0f0;
                    }}
                """)
                child_label.setCursor(Qt.CursorShape.PointingHandCursor)
                child_label.mousePressEvent = lambda e, c=child: self._on_phrase_click(c)
                child_layout.addWidget(child_label)
            
            child_layout.addStretch()
            child_row.setStyleSheet("QWidget { background: transparent; border-bottom: 1px solid #e5e5e5; }")
            child_row.setMinimumHeight(16)
            child_row.setMaximumHeight(20)
            layout.addWidget(child_row)
        
        return widget
    
    def _on_phrase_number_click(self, phrase: dict) -> None:
        """点击序号 - 复制、不抢焦点粘贴、关闭"""
        content = phrase.get('content', '')
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            self.app_window.paste_to_last_external_no_focus_steal()
        self.hide()
    
    def _on_phrase_text_click(self, phrase: dict) -> None:
        """点击文本 - 仅复制到剪贴板，不粘贴，不关闭"""
        content = phrase.get('content', '')
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
    
    def _on_phrase_click(self, phrase: dict) -> None:
        """点击话术 - 兼容入口（数字键快速选择等），走序号点击逻辑"""
        self._on_phrase_number_click(phrase)
    
    def _ensure_on_screen(self) -> None:
        """确保窗口在屏幕内"""
        screen = QApplication.primaryScreen()
        if screen:
            screen_rect = screen.availableGeometry()
            widget_rect = self.geometry()
            
            # 右边界
            if widget_rect.right() > screen_rect.right():
                self.move(screen_rect.right() - widget_rect.width(), widget_rect.y())
            
            # 下边界
            if widget_rect.bottom() > screen_rect.bottom():
                self.move(self.x(), screen_rect.bottom() - widget_rect.height())
    
    def _move_to_top_right(self) -> None:
        """移动窗口到屏幕右上角"""
        screen = QApplication.primaryScreen()
        if screen:
            screen_rect = screen.availableGeometry()
            self.adjustSize()
            x = screen_rect.right() - self.width() - 20
            y = screen_rect.top() + 20
            self.move(x, y)
    
    def keyPressEvent(self, event) -> None:
        """键盘事件处理"""
        key = event.key()
        text = event.text()
        
        if key == Qt.Key.Key_Escape:
            self.hide()
            return
        
        if text.isdigit():
            index = int(text)
            if self._aliases and len(self._aliases) > 0:
                if 1 <= index <= len(self._aliases):
                    self._on_alias_click(self._aliases[index - 1])
                    return
            elif self._phrases and len(self._phrases) > 0:
                if 1 <= index <= len(self._phrases):
                    self._on_phrase_click(self._phrases[index - 1])
                    return
        
        if text == '/':
            self._child_mode = True
            return
        
        super().keyPressEvent(event)
    
    def hideEvent(self, event) -> None:
        self._child_mode = False
        self._aliases = []
        self._dual_mode = False
        self._phrase_frame.hide()
        self._content_scroll.show()
        super().hideEvent(event)
    
    def show_aliases(self, aliases: list, current_input: str, cursor_pos: tuple = None) -> None:
        print(f"[悬浮面板] show_aliases 被调用: {len(aliases)} 个候选, 当前输入: {current_input}")
        
        self._aliases = aliases
        self._selected_index = 0
        self._dual_mode = False
        
        self._header.setText(f"输入: {current_input}")
        
        while self._alias_layout.count():
            item = self._alias_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        while self._content_layout.count():
            item = self._content_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        for i, alias_item in enumerate(aliases):
            item_widget = self._create_alias_item(i + 1, alias_item, False)
            self._content_layout.addWidget(item_widget)
        
        self._content_layout.addStretch()
        
        self._dual_container.hide()
        self._content_scroll.show()
        self._phrase_scroll.hide()
        
        self._footer.setText("点击选择 | 数字键选择 | ESC关闭")
        
        self._content_scroll.setMinimumWidth(200)
        self._content_scroll.setMaximumWidth(350)
        
        self._move_to_top_right()
        
        self.show()
        self.raise_()
        print(f"[悬浮面板] 代名词选择窗口已显示，位置: ({self.x()}, {self.y()})")
    
    def show_dual_panel(self, aliases: list, current_input: str, category_name: str, phrases: list, selected_alias: str = None, cursor_pos: tuple = None) -> None:
        print(f"[悬浮面板] show_dual_panel 被调用: {len(aliases)} 个代名词, {len(phrases)} 个话术, 选中: {selected_alias}")
        
        self._aliases = aliases
        self._phrases = phrases
        self._selected_index = 0
        self._child_mode = False
        self._dual_mode = True
        
        self._header.setText(f"{current_input} → {category_name}")
        
        while self._alias_layout.count():
            item = self._alias_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        while self._phrase_layout.count():
            item = self._phrase_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        while self._content_layout.count():
            item = self._content_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        for i, alias_item in enumerate(aliases):
            is_selected = (alias_item.get('alias') == selected_alias) or (i == 0 and not selected_alias)
            item_widget = self._create_alias_item(i + 1, alias_item, is_selected)
            self._alias_layout.addWidget(item_widget)
        
        self._alias_layout.addStretch()
        
        for i, phrase in enumerate(phrases):
            item_widget = self._create_phrase_item(i + 1, phrase)
            self._phrase_layout.addWidget(item_widget)
        
        self._phrase_layout.addStretch()
        
        self._content_scroll.hide()
        self._dual_container.show()
        self._alias_frame.show()
        self._phrase_frame.show()
        
        self._footer.setText("点击序号发送 | 点击代名词切换 | ESC关闭")
        
        self._move_to_top_right()
        
        self.show()
        self.raise_()
        print(f"[悬浮面板] 双栏面板已显示，位置: ({self.x()}, {self.y()})")
    
    def _create_alias_item(self, index: int, alias_item: dict, is_selected: bool = False) -> QWidget:
        widget = QWidget()
        layout = QHBoxLayout(widget)
        layout.setContentsMargins(6, 2, 6, 2)
        layout.setSpacing(4)
        
        bg_color = "#e8e8f0" if is_selected else "transparent"
        hover_bg = "#d0d0e0" if is_selected else "#f5f5f5"
        
        num_label = QLabel(f"{index}.")
        num_label.setStyleSheet(f"""
            QLabel {{
                font-size: {self.NUM_FONT_SIZE}px;
                font-weight: bold;
                color: {self._theme_color};
                background: transparent;
                min-width: 14px;
                padding: 2px 0;
            }}
        """)
        layout.addWidget(num_label)
        
        alias_label = QLabel(alias_item.get('alias', ''))
        alias_label.setStyleSheet(f"""
            QLabel {{
                font-size: {self.ITEM_FONT_SIZE}px;
                font-weight: bold;
                color: {self._theme_color};
                background: transparent;
                padding: 2px 4px;
            }}
        """)
        layout.addWidget(alias_label)
        
        name_label = QLabel(alias_item.get('categoryName', ''))
        name_label.setStyleSheet(f"""
            QLabel {{
                font-size: {self.ITEM_FONT_SIZE}px;
                color: #555;
                background: transparent;
                padding: 2px 4px;
            }}
        """)
        name_label.setIndent(4)
        layout.addWidget(name_label, 1)
        
        widget.setStyleSheet(f"""
            QWidget {{
                background-color: {bg_color};
                border-bottom: 1px solid #e5e5e5;
            }}
            QWidget:hover {{
                background-color: {hover_bg};
            }}
        """)
        widget.setCursor(Qt.CursorShape.PointingHandCursor)
        widget.mousePressEvent = lambda e, a=alias_item: self._on_alias_click(a)
        widget.setMinimumHeight(20)
        widget.setMaximumHeight(24)
        
        return widget
    
    def _on_alias_click(self, alias_item: dict) -> None:
        alias = alias_item.get('alias', '')
        category_id = alias_item.get('categoryId', '')
        
        print(f"[悬浮面板] 选择代名词: {alias}, 分类ID: {category_id}")
        
        if self._dual_mode:
            js_code = f"""
            (async function() {{
                if (window.__selectAliasAndShowPhrases) {{
                    await window.__selectAliasAndShowPhrases('{category_id}', '{alias}');
                }}
            }})();
            """
            self.app_window.web_view.page().runJavaScript(js_code)
        else:
            js_code = f"""
            (async function() {{
                if (window.__selectAliasAndShowPhrases) {{
                    await window.__selectAliasAndShowPhrases('{category_id}', '{alias}');
                }}
            }})();
            """
            self.app_window.web_view.page().runJavaScript(js_code)
    
    def update_phrases(self, category_name: str, alias: str, phrases: list) -> None:
        print(f"[悬浮面板] update_phrases 被调用: {category_name}, {len(phrases)} 个话术")
        
        self._phrases = phrases
        self._header.setText(f"{alias} → {category_name}")
        
        while self._phrase_layout.count():
            item = self._phrase_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        for i, phrase in enumerate(phrases):
            item_widget = self._create_phrase_item(i + 1, phrase)
            self._phrase_layout.addWidget(item_widget)
        
        self._phrase_layout.addStretch()
        self._phrase_scroll.verticalScrollBar().setValue(0)


class PythonBridge(QObject):
    """提供给 JavaScript 使用的最小桥接接口"""

    def __init__(self, app_window: "DesktopApp") -> None:
        super().__init__()
        self.app_window = app_window

    @pyqtSlot(str)
    def log_to_terminal(self, message: str) -> None:
        """将JavaScript日志输出到Python终端"""
        print(message)

    @pyqtSlot(result=str)
    def get_last_export_directory(self) -> str:
        return self.app_window.get_last_export_directory()

    @pyqtSlot(str, result=bool)
    def copy_text(self, text: str) -> bool:
        try:
            QApplication.clipboard().setText(text)
            return True
        except Exception:
            return False

    @pyqtSlot(result=str)
    def get_text(self) -> str:
        """从系统剪贴板读取文本"""
        try:
            clipboard = QApplication.clipboard()
            text = clipboard.text()
            return text if text else ""
        except Exception:
            return ""

    @pyqtSlot(result=str)
    def get_html(self) -> str:
        """从系统剪贴板读取HTML格式内容"""
        try:
            clipboard = QApplication.clipboard()
            mime_data = clipboard.mimeData()
            
            # 优先尝试读取 HTML 格式
            if mime_data.hasHtml():
                html = mime_data.html()
                if html:
                    return html
            
            # 如果没有 HTML，返回空字符串（JavaScript 端会回退到纯文本）
            return ""
        except Exception:
            return ""

    @pyqtSlot(str, str)
    def open_text_editor(self, category_id: str, category_name: str) -> None:
        """打开文本编辑器窗口"""
        self.app_window.open_text_editor(category_id, category_name)

    @pyqtSlot()
    def open_announcement_dialog(self) -> None:
        """打开公告解读对话框"""
        self.app_window.open_announcement_dialog()

    @pyqtSlot(str, str)
    def open_placeholder_dialog(self, content: str, placeholders_json: str) -> None:
        """打开占位符补全对话框"""
        self.app_window.open_placeholder_dialog(content, placeholders_json)

    @pyqtSlot()
    def open_calculator(self) -> None:
        """打开计算器窗口"""
        self.app_window.open_calculator()

    @pyqtSlot(str)
    def openCalculatorForInput(self, input_id: str) -> None:
        """为指定输入框打开计算器窗口"""
        self.app_window.open_calculator_for_input(input_id)

    @pyqtSlot(str, str, result=str)
    def handle_save_file_request(self, content: str, filename: str) -> str:
        """处理文件保存请求，显示文件保存对话框"""
        try:
            from PyQt6.QtWidgets import QFileDialog

            # 获取上次导出目录
            last_dir = self.app_window.get_last_export_directory()

            # 显示保存文件对话框
            file_path, _ = QFileDialog.getSaveFileName(
                self.app_window,
                "保存话术数据",
                str(Path(last_dir) / filename),
                "JSON 文件 (*.json);;所有文件 (*.*)"
            )

            if not file_path:
                print("[导出] 用户取消保存")
                return ""

            # 保存文件
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)

            # 保存导出目录
            export_dir = str(Path(file_path).parent)
            self.app_window.save_last_export_directory(export_dir)

            print(f"[导出] 文件已保存: {file_path}")
            return file_path

        except Exception as e:
            print(f"[导出] 保存文件失败: {e}")
            return ""

    @pyqtSlot(result=str)
    def open_add_title_dialog(self) -> str:
        """打开添加标题对话框"""
        try:
            dialog = TitleDialog(self.app_window, mode="add")
            result = dialog.exec()
            if result == QDialog.DialogCode.Accepted:
                import json
                return json.dumps({
                    "title": dialog.result_text,
                    "show_text_editor": dialog.result_show_text_editor
                })
            return ""
        except Exception as e:
            print(f"[标题对话框] 打开添加标题对话框失败: {e}")
            return ""

    @pyqtSlot(str, bool, result=str)
    def open_edit_title_dialog(self, current_title: str, show_text_editor: bool) -> str:
        """打开编辑标题对话框"""
        try:
            dialog = TitleDialog(self.app_window, mode="edit", current_title=current_title, show_text_editor=show_text_editor)
            result = dialog.exec()
            if result == QDialog.DialogCode.Accepted:
                import json
                return json.dumps({
                    "title": dialog.result_text,
                    "show_text_editor": dialog.result_show_text_editor
                })
            return ""
        except Exception as e:
            print(f"[标题对话框] 打开编辑标题对话框失败: {e}")
            return ""

    @pyqtSlot(str, str, int, int)
    def openWindow(self, url: str, title: str, width: int, height: int) -> None:
        """打开新窗口"""
        self.app_window.open_window(url, title, width, height)

    @pyqtSlot(result=bool)
    def paste_to_last_external(self) -> bool:
        """尝试切回上次外部窗口并发送 Ctrl+V（best-effort）"""
        try:
            return bool(self.app_window.paste_to_last_external())
        except Exception:
            return False

    @pyqtSlot(result=bool)
    def paste_no_focus_steal(self) -> bool:
        """不抢焦点的自动粘贴 - 直接发送Ctrl+V"""
        try:
            return bool(self.app_window.paste_to_last_external_no_focus_steal())
        except Exception:
            return False

    @pyqtSlot(str)
    def create_overlay_buttons(self, positions_json: str) -> None:
        """创建透明序号按钮覆盖在WebView上
        
        Args:
            positions_json: JSON数组，每个元素包含 {x, y, w, h, content}
        """
        self.app_window._create_main_overlay_buttons(positions_json)

    @pyqtSlot()
    def clear_overlay_buttons(self) -> None:
        """清除透明序号按钮"""
        self.app_window._clear_main_overlay_buttons()

    @pyqtSlot()
    def disable_focus_protection(self) -> None:
        """临时禁用焦点保护（点击输入框时调用）"""
        self.app_window._temporarily_disable_focus_protection()

    @pyqtSlot()
    def enable_focus_protection(self) -> None:
        """恢复焦点保护（点击非输入框区域时调用）"""
        self.app_window._restore_focus_protection()

    @pyqtSlot()
    def enable_no_focus_mode(self) -> None:
        """启用不抢焦点模式（鼠标悬停序号时调用）"""
        self.app_window._enable_no_focus_mode()

    @pyqtSlot()
    def disable_no_focus_mode(self) -> None:
        """禁用不抢焦点模式（鼠标离开序号时调用）"""
        self.app_window._disable_no_focus_mode()

    @pyqtSlot(str, str, str)
    def show_floating_panel(self, category_name: str, alias: str, phrases_json: str) -> None:
        """显示悬浮话术面板（旧版，供 JavaScript 调用）
        
        Args:
            category_name: 分类名称
            alias: 代名词
            phrases_json: 话术列表的 JSON 字符串
        """
        try:
            import json
            phrases = json.loads(phrases_json) if phrases_json else []
            self.app_window._show_floating_panel(category_name, alias, phrases)
        except Exception as e:
            print(f"[PythonBridge] show_floating_panel 异常: {e}")
    
    @pyqtSlot(str, str)
    def show_simple_floating_panel(self, alias_info: str, phrases_json: str) -> None:
        """显示简化版悬浮话术面板（新版，供 JavaScript 调用）
        
        Args:
            alias_info: 代名词信息，格式如 "a,问候和反馈同模版版"
            phrases_json: 话术列表的 JSON 字符串
        """
        try:
            self.app_window.show_simple_floating_panel(alias_info, phrases_json)
        except Exception as e:
            print(f"[PythonBridge] show_simple_floating_panel 异常: {e}")
    
    @pyqtSlot(str, str, str, str)
    def show_aliases_and_phrases(self, aliases_json: str, phrases_json: str, trigger_text: str = "", all_phrases_json: str = "") -> None:
        """显示代名词列表和话术（新版主方法，供 JavaScript 调用）
        
        Args:
            aliases_json: JSON格式的代名词列表字符串
            phrases_json: JSON格式的话术列表字符串
            trigger_text: 触发文本
            all_phrases_json: JSON格式的所有话术列表字符串
        """
        try:
            self.app_window.show_aliases_and_phrases(aliases_json, phrases_json, trigger_text, all_phrases_json)
        except Exception as e:
            print(f"[PythonBridge] show_aliases_and_phrases 异常: {e}")

    @pyqtSlot(str, str)
    def open_browser(self, path: str, default_url: str = None) -> None:
        """打开浏览器（支持快捷方式解析）并实现自动分屏

        Args:
            path: 浏览器快捷方式路径或网址
            default_url: 默认打开的网址（从设置中获取）
        """
        print(f"[分屏] 开始处理浏览器启动请求: {path}")
        if default_url:
            print(f"[分屏] 默认网址: {default_url}")

        try:
            import os
            import subprocess
            import re

            # 提取URL（如果是快捷方式则解析，如果是网址则直接使用）
            target_url = None
            
            # 检查是否是快捷方式
            if path.endswith('.lnk'):
                print(f"[分屏] 检测到快捷方式文件: {path}")
                # 使用Python的win32com解析快捷方式
                try:
                    import win32com.client
                    shell = win32com.client.Dispatch("WScript.Shell")
                    shortcut = shell.CreateShortCut(path)
                    target_path = shortcut.Targetpath
                    arguments = shortcut.Arguments
                    working_directory = shortcut.WorkingDirectory
                    
                    print(f"[分屏] 解析快捷方式:")
                    print(f"  路径: {path}")
                    print(f"  目标: {target_path}")
                    print(f"  参数: {arguments}")
                    print(f"  工作目录: {working_directory}")
                    
                    # 从参数中提取URL
                    if arguments:
                        # 匹配URL模式
                        url_pattern = r'https?://[^\s"]+'
                        url_match = re.search(url_pattern, arguments)
                        if url_match:
                            target_url = url_match.group(0)
                            print(f"[分屏] 从参数中提取到URL: {target_url}")
                        else:
                            print(f"[分屏] 参数中未找到URL: {arguments}")
                    
                    if not target_url and target_path:
                        # 如果参数中没有URL，检查目标路径是否是浏览器
                        if 'chrome.exe' in target_path.lower() or 'msedge.exe' in target_path.lower():
                            # 这是浏览器快捷方式，但参数中没有URL，使用传入的默认网址
                            target_url = default_url or "https://www.baidu.com"
                            print(f"[分屏] 浏览器快捷方式无URL参数，使用默认页面: {target_url}")
                    
                    if target_path and os.path.exists(target_path) and target_url:
                        # 直接启动浏览器并分屏，使用解析出的Chrome路径
                        success = self.app_window.launch_browser_with_split_screen(target_url, target_path, arguments, working_directory)
                        if success:
                            print(f"[分屏] 已使用分屏功能启动浏览器: {target_url}")
                            return
                        else:
                            print(f"[分屏] 分屏启动失败，使用传统方式")
                            # 分屏失败时回退到传统方式
                            if arguments:
                                cmd = f'"{target_path}" {arguments}'
                            else:
                                cmd = f'"{target_path}" {target_url}'
                            
                            if working_directory and os.path.exists(working_directory):
                                subprocess.Popen(cmd, cwd=working_directory, shell=True)
                            else:
                                subprocess.Popen(cmd, shell=True)
                            return
                    
                except ImportError:
                    print(f"[分屏] win32com 不可用，尝试直接打开")
                    pass
                except Exception as e:
                    print(f"[分屏] 解析快捷方式失败: {e}")
            
            # 如果不是快捷方式或者解析失败，检查是否是URL
            if not target_url:
                if re.match(r'https?://', path):
                    target_url = path
                else:
                    # 尝试作为文件路径打开
                    print(f"[分屏] 使用 os.startfile 打开: {path}")
                    os.startfile(path)
                    print(f"[分屏] 已打开: {path}")
                    return
            
            # 使用分屏功能启动浏览器
            if target_url:
                print(f"[分屏] 准备使用分屏功能启动浏览器: {target_url}")
                success = self.app_window.launch_browser_with_split_screen(target_url)
                if success:
                    print(f"[分屏] 分屏启动成功")
                else:
                    print(f"[分屏] 分屏启动失败，使用备用方法")
                    self.app_window._launch_browser_fallback(target_url)
            else:
                print(f"[分屏] 未能提取到URL，使用备用方法")
                self.app_window._launch_browser_fallback(path)

        except Exception as e:
            print(f"[分屏] 打开浏览器失败: {e}")
            import traceback
            traceback.print_exc()
            # 尝试备用方法
            try:
                self.app_window._launch_browser_fallback(path)
            except:
                pass

    @pyqtSlot(str)
    def open_url(self, url: str) -> None:
        """直接打开网址（不解析快捷方式）"""
        try:
            print(f"[打开网址] 请求打开: {url}")
            if url:
                self.app_window.launch_browser_with_split_screen(url)
        except Exception as e:
            print(f"[打开网址] 失败: {e}")
            # 备用方法：直接用系统默认浏览器打开
            try:
                import webbrowser
                webbrowser.open(url)
            except:
                pass

    @pyqtSlot()
    def open_file_dialog(self) -> None:
        """打开文件选择对话框（用于添加浏览器快捷方式）"""
        try:
            from PyQt6.QtWidgets import QFileDialog
            import os
            import json
            
            # 获取桌面路径
            desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
            
            # 显示文件选择对话框
            file_path, _ = QFileDialog.getOpenFileName(
                self.app_window,
                "选择浏览器快捷方式",
                desktop_path,
                "快捷方式 (*.lnk);;所有文件 (*.*)"
            )
            
            if not file_path:
                print("[上班按钮] 用户取消文件选择")
                return
            
            # 解析快捷方式获取名称和路径
            name = os.path.basename(file_path).replace('.lnk', '')
            
            # 调用JavaScript添加快捷方式
            script = f"""
            if (typeof addBrowserShortcut === 'function') {{
                addBrowserShortcut('{name}', '{file_path}');
            }}
            """
            self.app_window.browser.page().runJavaScript(script)
            
            print(f"[上班按钮] 已添加浏览器快捷方式: {name} - {file_path}")
            
        except Exception as e:
            print(f"[上班按钮] 打开文件选择对话框失败: {e}")

    @pyqtSlot(str, str)
    def show_alias_panel(self, aliases_json: str, current_input: str) -> None:
        """显示代名词选择面板（供 JavaScript 调用）
        
        Args:
            aliases_json: 代名词列表的 JSON 字符串
            current_input: 当前输入的字母
        """
        try:
            import json
            aliases = json.loads(aliases_json) if aliases_json else []
            self.app_window._show_alias_panel(aliases, current_input)
        except Exception as e:
            print(f"[PythonBridge] show_alias_panel 异常: {e}")

    @pyqtSlot(str, str, str, str, str)
    def show_dual_panel(self, aliases_json: str, current_input: str, category_name: str, phrases_json: str, selected_alias: str = None) -> None:
        """显示双栏面板（供 JavaScript 调用）
        
        Args:
            aliases_json: 代名词列表的 JSON 字符串
            current_input: 当前输入的字母
            category_name: 匹配的分类名称
            phrases_json: 话术列表的 JSON 字符串
            selected_alias: 选中的代名词（用于高亮）
        """
        try:
            import json
            aliases = json.loads(aliases_json) if aliases_json else []
            phrases = json.loads(phrases_json) if phrases_json else []
            self.app_window._show_dual_panel(aliases, current_input, category_name, phrases, selected_alias)
        except Exception as e:
            print(f"[PythonBridge] show_dual_panel 异常: {e}")

    @pyqtSlot(str, str, str)
    def update_dual_panel_phrases(self, category_name: str, alias: str, phrases_json: str) -> None:
        """更新双栏面板的话术列表（供 JavaScript 调用）
        
        Args:
            category_name: 分类名称
            alias: 代名词
            phrases_json: 话术列表的 JSON 字符串
        """
        try:
            import json
            phrases = json.loads(phrases_json) if phrases_json else []
            self.app_window._update_dual_panel_phrases(category_name, alias, phrases)
        except Exception as e:
            print(f"[PythonBridge] update_dual_panel_phrases 异常: {e}")

    @pyqtSlot(result=str)
    def select_backup_folder(self) -> str:
        """选择备份文件夹"""
        try:
            from PyQt6.QtWidgets import QFileDialog
            from pathlib import Path
            
            # 获取当前程序根目录作为起始目录
            current_dir = Path.cwd()
            
            # 显示文件夹选择对话框
            folder_path = QFileDialog.getExistingDirectory(
                self.app_window,
                "选择第二数据库备份文件夹",
                str(current_dir),
                QFileDialog.Option.ShowDirsOnly
            )
            
            if folder_path:
                print(f"[备份] 用户选择了备份文件夹: {folder_path}")
                return folder_path
            else:
                print("[备份] 用户取消了文件夹选择")
                return ""
                
        except Exception as e:
            print(f"[备份] 选择文件夹失败: {e}")
            return ""

    @pyqtSlot(str, result=bool)
    def start_second_backup(self, backup_path: str) -> bool:
        """启动第二数据库备份（默认最大10个备份）"""
        try:
            return self.app_window.start_second_backup(backup_path, 10)
        except Exception as e:
            print(f"[备份] 启动备份失败: {e}")
            return False

    @pyqtSlot(str, int, result=bool)
    def start_second_backup_with_config(self, backup_path: str, max_backups: int) -> bool:
        """启动带配置的第二数据库备份"""
        try:
            return self.app_window.start_second_backup(backup_path, max_backups)
        except Exception as e:
            print(f"[备份] 启动备份失败: {e}")
            return False

    @pyqtSlot(result=bool)
    def mark_phrases_changed(self) -> bool:
        """标记话术已变化（由前端调用）"""
        try:
            from pathlib import Path
            source_dir = Path.cwd() / "data"
            self.app_window._set_dirty_marker(source_dir)
            return True
        except Exception as e:
            print(f"[备份] 标记话术变化失败: {e}")
            return False

    @pyqtSlot(result=bool)
    def stop_second_backup(self) -> bool:
        """停止第二数据库备份"""
        try:
            return self.app_window.stop_second_backup()
        except Exception as e:
            print(f"[备份] 停止备份失败: {e}")
            return False

    @pyqtSlot(result=str)
    def select_import_backup_folder(self) -> str:
        """选择要导入的备份文件夹"""
        try:
            from PyQt6.QtWidgets import QFileDialog
            from pathlib import Path

            # 获取当前程序根目录作为起始目录
            current_dir = Path.cwd()

            # 显示文件夹选择对话框
            folder_path = QFileDialog.getExistingDirectory(
                self.app_window,
                "选择备份数据文件夹（选择包含 data 的文件夹或 data 文件夹本身）",
                str(current_dir),
                QFileDialog.Option.ShowDirsOnly
            )

            if folder_path:
                print(f"[导入] 用户选择了备份文件夹: {folder_path}")
                return folder_path
            else:
                print("[导入] 用户取消了文件夹选择")
                return ""

        except Exception as e:
            print(f"[导入] 选择文件夹失败: {e}")
            return ""

    @pyqtSlot(str, result=str)
    def import_backup_data(self, backup_path: str) -> str:
        """导入备份数据，返回结果消息（原子操作：先复制到临时目录，验证后再替换）"""
        try:
            from pathlib import Path
            import shutil
            from datetime import datetime

            backup_dir = Path(backup_path)
            if not backup_dir.exists():
                return "❌ 备份文件夹不存在"

            # 智能检测 data 文件夹位置
            # 情况1：用户直接选择了 data 文件夹
            # 情况2：用户选择了包含 data 的父文件夹
            if backup_dir.name == "data":
                source_data = backup_dir
            elif (backup_dir / "data").exists():
                source_data = backup_dir / "data"
            else:
                # 检查是否是轮转备份文件夹（backup_YYYYMMDD_HHMMSS）
                backup_data = backup_dir / "data"
                if backup_data.exists():
                    source_data = backup_data
                else:
                    return "❌ 未找到有效的 data 文件夹，请确保选择正确的备份目录"

            # 验证备份数据完整性
            if not (source_data / "phrases").exists():
                return "❌ 备份数据不完整：缺少 phrases 文件夹"

            # 获取当前 data 目录
            current_data = Path.cwd() / "data"

            # 创建当前 data 的备份（以防万一）
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_current = Path.cwd() / f"data_before_import_{timestamp}"
            if current_data.exists():
                print(f"[导入] 备份当前数据到: {backup_current}")
                shutil.copytree(current_data, backup_current)

            # === 原子导入：先复制到临时目录，验证成功后再替换 ===
            temp_data = Path.cwd() / f"_import_temp_{timestamp}"
            try:
                # 步骤1：复制到临时目录
                print(f"[导入] 复制备份数据到临时目录: {temp_data}")
                shutil.copytree(source_data, temp_data)

                # 步骤2：验证临时目录完整性
                if not (temp_data / "phrases").exists():
                    raise Exception("临时目录验证失败：缺少 phrases 文件夹")

                # 步骤3：删除当前 data 目录
                if current_data.exists():
                    print(f"[导入] 删除当前 data 目录")
                    shutil.rmtree(current_data)

                # 步骤4：将临时目录重命名为 data（重命名是原子操作）
                print(f"[导入] 重命名临时目录: {temp_data} -> {current_data}")
                temp_data.rename(current_data)

                print(f"[导入] ✅ 备份数据导入成功")
                return f"✅ 导入成功！请重启软件以加载新数据\n\n（当前数据已备份到: {backup_current.name}）"

            except Exception as inner_e:
                # 清理临时目录
                if temp_data.exists():
                    print(f"[导入] 清理临时目录: {temp_data}")
                    shutil.rmtree(temp_data, ignore_errors=True)
                # 如果当前 data 已被删除但备份还在，提示用户手动恢复
                if not current_data.exists() and backup_current.exists():
                    return (f"❌ 导入失败: {str(inner_e)}\n\n"
                            f"⚠️ 当前数据目录已被删除！"
                            f"请手动将 {backup_current.name} 重命名为 data，然后重启软件")
                raise  # 重新抛出外层异常处理

        except Exception as e:
            print(f"[导入] ❌ 导入失败: {e}")
            return f"❌ 导入失败: {str(e)}"


class DesktopApp(QMainWindow):
    """精简主窗口：加载现有 index.html，保留一致界面"""

    def __init__(self) -> None:
        print("[DesktopApp] 初始化开始")
        super().__init__()
        
        # 执行数据迁移
        migrate_old_data()
        
        # 使用新的数据目录
        self.config_dir = get_app_data_dir() / "phrases"
        print(f"[DesktopApp] 配置目录: {self.config_dir}")
        self.config_dir.mkdir(exist_ok=True)
        self.app_settings = QSettings(str(self.config_dir / "app.ini"), QSettings.Format.IniFormat)
        self.last_export_directory = self.app_settings.value("export/last_directory", str(self.config_dir), type=str)

        self.profile: QWebEngineProfile | None = None
        self.web_channel: QWebChannel | None = None
        self.python_bridge: PythonBridge | None = None
        self.text_editor_dialogs: dict[str, TextEditorDialog] = {}  # 支持多个编辑器窗口
        self.placeholder_dialogs: list[PlaceholderDialog] = []  # 支持多个占位符对话框
        self.calculator_dialog: CalculatorDialog | None = None  # 计算器窗口（补全功能使用）
        self.calculator_dialog_web: CalculatorDialogWeb | None = None  # 计算器窗口（底部工具栏使用）

        self._last_external_hwnd: int | None = None
        self._last_click_position: tuple[int, int] | None = None
        self._last_lbutton_down = False
        self._alias_sync_timer: QTimer | None = None
        self._floating_panel: FloatingWebViewPanel | None = None  # WebView悬浮话术面板（旧版）
        self._simple_floating_panel: SimpleFloatingPanel | None = None  # 简化版悬浮话术面板（新版）
        self._system_tray: QSystemTrayIcon | None = None  # 系统托盘图标
        self._alias_sync_key_states: dict[int, bool] = {}
        self._alias_sync_active = False
        self._alias_sync_focus_lost_count = 0
        self._last_valid_external_hwnd: int | None = None
        self._alias_sync_sequence_active = False
        self._alias_sync_last_reset_time = 0.0
        self._alias_sync_chinese_input_detected = False
        self._main_overlay_buttons: list[QPushButton] = []  # 主窗口透明序号按钮列表
        self._profile_hwnd_map: dict[str, int] = {}  # Profile -> 窗口句柄映射表
        self._profile_map_file: Path = get_app_data_dir() / "profile_hwnd_map.json"  # 映射持久化文件

        # 启动时加载、验证、扫描 Profile 映射
        self._load_profile_map()
        self._validate_profile_map()
        self._scan_existing_chrome_windows()

        self._setup_window()
        self._setup_console()
        self._setup_webview()
        self._setup_alias_sync()
        self._setup_floating_panel()
        self._setup_system_tray()
        self._load_app()

    def event(self, event: QEvent):
        try:
            if event.type() == QEvent.Type.WindowDeactivate:
                # 失焦后稍等一拍，确保前台窗口已切换到外部
                QTimer.singleShot(80, self._capture_last_external_foreground_window)
        except Exception:
            pass
        return super().event(event)

    def _capture_last_external_foreground_window(self) -> None:
        if not sys.platform.startswith('win'):
            return

        try:
            user32 = ctypes.windll.user32
            hwnd = int(user32.GetForegroundWindow())
            if hwnd == 0:
                return

            try:
                my_hwnd = int(self.winId())
            except Exception:
                my_hwnd = 0

            # 避免把自己记录进去
            if my_hwnd and hwnd == my_hwnd:
                return

            # 只有在窗口句柄发生变化时才更新和打印日志
            if self._last_external_hwnd != hwnd:
                self._last_external_hwnd = hwnd
                print(f"[_poll_alias_sync] 更新 _last_external_hwnd = {hwnd}")
        except Exception:
            return

    def paste_to_last_external(self) -> bool:
        """使用 WindowFromPoint + SetFocus + keybd_event 进行不移动鼠标的自动粘贴（基于 paste_prototype 的 instant 模式）"""
        if not sys.platform.startswith('win'):
            print("[paste_to_last_external] 非Windows平台，返回False")
            return False
        
        if not self._last_click_position:
            print(f"[paste_to_last_external] 没有鼠标位置记录，无法进行自动粘贴")
            print(f"[paste_to_last_external] 请先点击目标输入框，让系统记录位置")
            return False
        
        x, y = self._last_click_position
        print(f"[paste_to_last_external] 使用记录的鼠标位置: ({x}, {y})")
        
        try:
            import time
            user32 = ctypes.windll.user32
            
            # 步骤1：通过坐标找到输入框句柄
            print(f"[paste_to_last_external] 【步骤1】通过坐标找到输入框句柄")
            input_hwnd = user32.WindowFromPoint(int(x), int(y))
            print(f"[paste_to_last_external] 【步骤1】找到输入框句柄: {input_hwnd}")
            
            if not input_hwnd:
                print(f"[paste_to_last_external] 【步骤1】无法找到输入框窗口")
                return False
            
            # 步骤2：激活主窗口（使用 AttachThreadInput 确保 SetForegroundWindow 成功）
            main_hwnd = self._last_external_hwnd
            if main_hwnd:
                print(f"[paste_to_last_external] 【步骤2】激活主窗口 hwnd={main_hwnd}")
                try:
                    kernel32 = ctypes.windll.kernel32
                    foreground_hwnd = user32.GetForegroundWindow()
                    foreground_tid = user32.GetWindowThreadProcessId(foreground_hwnd, None)
                    target_tid = user32.GetWindowThreadProcessId(wintypes.HWND(main_hwnd), None)
                    
                    if foreground_tid and target_tid and foreground_tid != target_tid:
                        user32.AttachThreadInput(foreground_tid, target_tid, True)
                        user32.SetForegroundWindow(wintypes.HWND(main_hwnd))
                        user32.BringWindowToTop(wintypes.HWND(main_hwnd))
                        user32.AttachThreadInput(foreground_tid, target_tid, False)
                    else:
                        user32.SetForegroundWindow(wintypes.HWND(main_hwnd))
                        user32.BringWindowToTop(wintypes.HWND(main_hwnd))
                except Exception as e:
                    print(f"[paste_to_last_external] 【步骤2】窗口激活异常: {e}")
                    try:
                        user32.SetForegroundWindow(wintypes.HWND(main_hwnd))
                    except Exception:
                        pass
                
                time.sleep(0.05)
                current_fg = user32.GetForegroundWindow()
                print(f"[paste_to_last_external] 【步骤2】当前前台窗口: {current_fg}")
            
            # 步骤3：激活输入框（尝试多种方式）
            print(f"[paste_to_last_external] 【步骤3】激活输入框 hwnd={input_hwnd}")
            activation_success = False
            
            # 方式1：SetFocus
            try:
                focus_result = user32.SetFocus(wintypes.HWND(int(input_hwnd)))
                if focus_result:
                    print(f"[paste_to_last_external] 【步骤3】SetFocus成功")
                    activation_success = True
                else:
                    print(f"[paste_to_last_external] 【步骤3】SetFocus失败，尝试其他方式")
            except Exception as e:
                print(f"[paste_to_last_external] 【步骤3】SetFocus异常: {e}")
            
            # 方式2：BM_CLICK
            if not activation_success:
                try:
                    BM_CLICK = 0x00F5
                    send_result = user32.SendMessageW(wintypes.HWND(int(input_hwnd)), BM_CLICK, 0, 0)
                    print(f"[paste_to_last_external] 【步骤3】BM_CLICK发送结果: {send_result}")
                    activation_success = True
                except Exception as e:
                    print(f"[paste_to_last_external] 【步骤3】BM_CLICK异常: {e}")
            
            # 方式3：EM_SETFOCUS
            if not activation_success:
                try:
                    EM_SETFOCUS = 0x00B7
                    send_result = user32.SendMessageW(wintypes.HWND(int(input_hwnd)), EM_SETFOCUS, 0, 0)
                    print(f"[paste_to_last_external] 【步骤3】EM_SETFOCUS发送结果: {send_result}")
                    activation_success = True
                except Exception as e:
                    print(f"[paste_to_last_external] 【步骤3】EM_SETFOCUS异常: {e}")
            
            if not activation_success:
                print(f"[paste_to_last_external] 【步骤3】所有激活方式都失败")
                return False
            
            # 步骤4：延迟100ms让激活生效
            print(f"[paste_to_last_external] 【步骤4】延迟100ms让激活生效")
            time.sleep(0.1)
            
            # 步骤5：使用 keybd_event 发送 Ctrl+V
            print(f"[paste_to_last_external] 【步骤5】发送 Ctrl+V 粘贴指令")
            VK_CONTROL = 0x11
            VK_V = 0x56
            user32.keybd_event(VK_CONTROL, 0, 0, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_V, 0, 0, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_V, 0, 2, 0)
            time.sleep(0.01)
            user32.keybd_event(VK_CONTROL, 0, 2, 0)
            
            print(f"[paste_to_last_external] ✅ 粘贴完成，物理鼠标未移动")
            return True
            
        except Exception as e:
            print(f"[paste_to_last_external] ❌ 发生异常: {e}")
            import traceback
            traceback.print_exc()
            return False

    def paste_to_last_external_no_focus_steal(self) -> bool:
        """不抢焦点的自动粘贴 - 优先直接发Ctrl+V，若焦点已被抢则先归还再粘贴"""
        print("[paste_no_focus] ========== 开始自动粘贴流程 ==========")
        if not sys.platform.startswith('win'):
            print("[paste_no_focus] 非Windows平台，返回False")
            return False
        
        if not self._last_click_position:
            print("[paste_no_focus] 没有鼠标位置记录，返回False")
            return False
        
        x, y = self._last_click_position
        print(f"[paste_no_focus] 鼠标位置: ({x}, {y})")
        
        try:
            import time
            user32 = ctypes.windll.user32
            
            # 步骤1：通过坐标找到输入框句柄
            print("[paste_no_focus] 步骤1: 通过坐标查找输入框窗口")
            input_hwnd = user32.WindowFromPoint(int(x), int(y))
            if not input_hwnd:
                print("[paste_no_focus] 无法找到输入框窗口，返回False")
                return False
            print(f"[paste_no_focus] 找到输入框窗口句柄: {input_hwnd}")
            
            # 步骤2：检查当前前台窗口
            print("[paste_no_focus] 步骤2: 检查前台窗口")
            foreground_hwnd = user32.GetForegroundWindow()
            print(f"[paste_no_focus] 前台窗口句柄: {foreground_hwnd}")
            
            # 获取自身窗口句柄
            own_hwnd = int(self.winId()) if hasattr(self, 'winId') else 0
            print(f"[paste_no_focus] 自身窗口句柄: {own_hwnd}")
            
            if foreground_hwnd == own_hwnd:
                print("[paste_no_focus] 前台模式：焦点已被主窗口抢走，需要先归还")
                # 前台模式：焦点已被主窗口抢走，需要先还给外部窗口
                # 使用_last_external_hwnd恢复焦点
                target_hwnd = self._last_external_hwnd if self._last_external_hwnd else input_hwnd
                print(f"[paste_no_focus] 目标窗口句柄: {target_hwnd}")
                if target_hwnd:
                    try:
                        print("[paste_no_focus] 尝试恢复焦点到外部窗口")
                        kernel32 = ctypes.windll.kernel32
                        fg_tid = user32.GetWindowThreadProcessId(foreground_hwnd, None)
                        target_tid = user32.GetWindowThreadProcessId(wintypes.HWND(target_hwnd), None)
                        print(f"[paste_no_focus] 前台线程ID: {fg_tid}, 目标线程ID: {target_tid}")
                        if fg_tid and target_tid and fg_tid != target_tid:
                            print("[paste_no_focus] 调用AttachThreadInput")
                            user32.AttachThreadInput(fg_tid, target_tid, True)
                        print("[paste_no_focus] 调用SetForegroundWindow")
                        user32.SetForegroundWindow(wintypes.HWND(target_hwnd))
                        if fg_tid and target_tid and fg_tid != target_tid:
                            print("[paste_no_focus] 调用AttachThreadInput解除")
                            user32.AttachThreadInput(fg_tid, target_tid, False)
                        print("[paste_no_focus] 延迟150ms等待焦点切换完成")
                        time.sleep(0.15)  # 增加延迟到150ms，确保焦点切换完成
                        print("[paste_no_focus] 焦点恢复完成")
                    except Exception as e:
                        print(f"[paste_no_focus] 焦点恢复失败: {e}")
            else:
                print("[paste_no_focus] 悬浮窗模式：焦点在外部窗口，直接粘贴")
            
            # 步骤3：发送Ctrl+V
            print("[paste_no_focus] 步骤3: 发送Ctrl+V粘贴指令")
            print("[paste_no_focus] 延迟100ms确保不抢焦点模式已恢复")
            time.sleep(0.1)  # 增加延迟到100ms，确保不抢焦点模式已恢复
            VK_CONTROL = 0x11
            VK_V = 0x56
            print("[paste_no_focus] 按下CONTROL键")
            user32.keybd_event(VK_CONTROL, 0, 0, 0)
            time.sleep(0.01)
            print("[paste_no_focus] 按下V键")
            user32.keybd_event(VK_V, 0, 0, 0)
            time.sleep(0.01)
            print("[paste_no_focus] 释放V键")
            user32.keybd_event(VK_V, 0, 2, 0)
            time.sleep(0.01)
            print("[paste_no_focus] 释放CONTROL键")
            user32.keybd_event(VK_CONTROL, 0, 2, 0)
            
            print("[paste_no_focus] ✅ 粘贴完成")
            print("[paste_no_focus] ========== 自动粘贴流程结束 ==========")
            return True
            
        except Exception as e:
            print(f"[paste_no_focus] ❌ 发生异常: {e}")
            import traceback
            traceback.print_exc()
            print("[paste_no_focus] ========== 自动粘贴流程异常结束 ==========")
            return False

    def _setup_floating_panel(self) -> None:
        """初始化悬浮话术面板"""
        self._floating_panel = FloatingWebViewPanel(self)
        self._floating_panel.hide()
        
        # 初始化简化版悬浮窗
        self._simple_floating_panel = SimpleFloatingPanel(self)
        self._simple_floating_panel.hide()

    def _show_floating_panel(self, category_name: str, alias: str, phrases: list) -> None:
        """显示悬浮话术面板（旧版WebView版本）
        
        Args:
            category_name: 分类名称
            alias: 代名词
            phrases: 话术列表
        """
        print(f"[DesktopApp] _show_floating_panel 被调用: category={category_name}, alias={alias}, phrases数量={len(phrases) if phrases else 0}")
        if self._floating_panel:
            self._floating_panel.show_phrases(category_name, alias, phrases)
        else:
            print(f"[DesktopApp] 错误: _floating_panel 为 None")
    
    def show_simple_floating_panel(self, alias_info: str, phrases_json: str) -> None:
        """显示简化版悬浮话术面板（新版）
        
        Args:
            alias_info: 代名词信息，格式如 "a,问候和反馈同模版版"
            phrases_json: JSON格式的话术列表字符串
        """
        import json
        try:
            phrases = json.loads(phrases_json)
            print(f"[DesktopApp] show_simple_floating_panel 被调用: alias_info={alias_info}, phrases数量={len(phrases)}")
            
            if self._simple_floating_panel:
                self._simple_floating_panel.show_phrases(alias_info, phrases)
            else:
                print(f"[DesktopApp] 错误: _simple_floating_panel 为 None")
        except json.JSONDecodeError as e:
            print(f"[DesktopApp] JSON解析错误: {e}")
        except Exception as e:
            print(f"[DesktopApp] show_simple_floating_panel 错误: {e}")
    
    def show_aliases_and_phrases(self, aliases_json: str, phrases_json: str, trigger_text: str = "", all_phrases_json: str = "") -> None:
        """显示代名词列表和话术（新版主方法）"""
        if self._simple_floating_panel:
            self._simple_floating_panel.show_aliases_and_phrases(aliases_json, phrases_json, trigger_text, all_phrases_json)

    def _show_alias_panel(self, aliases: list, current_input: str) -> None:
        """显示代名词选择面板
        
        Args:
            aliases: 代名词列表
            current_input: 当前输入的字母
        """
        print(f"[DesktopApp] _show_alias_panel 被调用: {len(aliases)} 个候选, 当前输入: {current_input}")
        if self._floating_panel:
            self._floating_panel.show_aliases(aliases, current_input)
        else:
            print(f"[DesktopApp] 错误: _floating_panel 为 None")

    def _show_dual_panel(self, aliases: list, current_input: str, category_name: str, phrases: list, selected_alias: str = None) -> None:
        """显示双栏面板
        
        Args:
            aliases: 代名词列表
            current_input: 当前输入的字母
            category_name: 匹配的分类名称
            phrases: 话术列表
            selected_alias: 选中的代名词（用于高亮）
        """
        print(f"[DesktopApp] _show_dual_panel 被调用: {len(aliases)} 个代名词, {len(phrases)} 个话术, 选中: {selected_alias}")
        if self._floating_panel:
            self._floating_panel.show_dual_panel(aliases, current_input, category_name, phrases, selected_alias)
        else:
            print(f"[DesktopApp] 错误: _floating_panel 为 None")

    def _update_dual_panel_phrases(self, category_name: str, alias: str, phrases: list) -> None:
        """更新双栏面板的话术列表
        
        Args:
            category_name: 分类名称
            alias: 代名词
            phrases: 话术列表
        """
        print(f"[DesktopApp] _update_dual_panel_phrases 被调用: {category_name}, {len(phrases)} 个话术")
        if self._floating_panel:
            self._floating_panel.update_phrases(category_name, alias, phrases)
        else:
            print(f"[DesktopApp] 错误: _floating_panel 为 None")

    def _setup_system_tray(self) -> None:
        """初始化系统托盘图标"""
        self._system_tray = QSystemTrayIcon(self)
        
        # 托盘图标（使用应用图标或默认图标）
        icon = self.style().standardIcon(QStyle.StandardPixmap.SP_ComputerIcon)
        self._system_tray.setIcon(icon)
        self._system_tray.setToolTip("话术助手")
        
        # 托盘菜单
        tray_menu = QMenu()
        
        show_action = tray_menu.addAction("显示主窗口")
        show_action.triggered.connect(self._show_main_window)
        
        tray_menu.addSeparator()
        
        quit_action = tray_menu.addAction("退出")
        quit_action.triggered.connect(self._quit_app)
        
        self._system_tray.setContextMenu(tray_menu)
        self._system_tray.activated.connect(self._on_tray_activated)
        self._system_tray.show()
    
    def _on_tray_activated(self, reason) -> None:
        """托盘图标激活事件"""
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self._show_main_window()
    
    def _show_main_window(self) -> None:
        """显示主窗口"""
        self.showNormal()
        self.activateWindow()
        self.raise_()
    
    def _quit_app(self) -> None:
        """退出应用"""
        self._force_quit = True
        if self._system_tray:
            self._system_tray.hide()
        QApplication.quit()

    def _setup_alias_sync(self) -> None:
        if not sys.platform.startswith('win'):
            return
        self._alias_sync_timer = QTimer(self)
        self._alias_sync_timer.setInterval(200)  # 别名功能已停用，200ms足够（原20ms）
        self._alias_sync_timer.timeout.connect(self._poll_alias_sync)
        # ⚡ 定时器用于记录鼠标点击位置（自动粘贴功能需要）
        # 别名功能已停用（内部有 return），不会产生额外 CPU 开销
        self._alias_sync_timer.start()

    def _poll_alias_sync(self) -> None:
        try:
            if not self.browser or not self.browser.page():
                return

            # 监听鼠标左键点击，记录点击位置（用于自动粘贴）
            try:
                VK_LBUTTON = 0x01
                is_lbutton_down = bool(ctypes.windll.user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
                
                if self._last_lbutton_down and not is_lbutton_down:
                    # 左键释放时记录鼠标位置
                    class POINT(ctypes.Structure):
                        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
                    
                    point = POINT()
                    user32 = ctypes.windll.user32
                    if user32.GetCursorPos(ctypes.byref(point)):
                        # 只在外部窗口中记录
                        if not self._is_self_foreground():
                            self._last_click_position = (point.x, point.y)
                            # 同时更新外部窗口句柄，确保鼠标位置和窗口句柄同步
                            self._last_external_hwnd = user32.GetForegroundWindow()
                            print(f"[鼠标] 记录点击位置: ({point.x}, {point.y}), 窗口hwnd={self._last_external_hwnd}")
                
                self._last_lbutton_down = is_lbutton_down
            except Exception:
                pass

            # [别名功能已停用] 跳过别名键位检测，减少CPU占用
            # 鼠标位置记录已保留（自动粘贴功能需要）
            # 如需重新启用别名功能，删除下面这行 return 即可
            return

            current_foreground = self._get_foreground_hwnd()
            is_self_window = self._is_self_foreground()

            if is_self_window:
                return

            window_matched = (
                current_foreground
                and current_foreground == self._last_valid_external_hwnd
            )

            if window_matched:
                self._alias_sync_focus_lost_count = 0
                if not self._alias_sync_active:
                    print(f"[别名] 窗口匹配，重新激活监听")
                    self._alias_sync_active = True
                    self._alias_sync_key_states = {}
                    self._alias_sync_sequence_active = False
                    self._alias_sync_chinese_input_detected = False
                    self._dispatch_alias_restart()
                self._detect_and_dispatch_keys()
                return

            is_editable = self._is_external_editable_focus()

            if is_editable:
                if self._last_valid_external_hwnd != current_foreground:
                    print(f"[别名] 检测到新外部窗口 hwnd={current_foreground}")
                self._last_valid_external_hwnd = current_foreground
                self._alias_sync_focus_lost_count = 0
                self._alias_sync_active = True
                self._detect_and_dispatch_keys()
                return

            self._alias_sync_focus_lost_count += 1

            if self._alias_sync_focus_lost_count > 10:
                if self._alias_sync_active:
                    print(f"[别名] 焦点丢失超过阈值，停止监听")
                    self._dispatch_alias_reset()
                    self._alias_sync_active = False
                    self._alias_sync_sequence_active = False
                    self._last_valid_external_hwnd = None
                    self._alias_sync_key_states = {}
                    self._alias_sync_chinese_input_detected = False
        except Exception as e:
            print(f"[别名轮询] 异常：{e}")
            return

    def _is_self_foreground(self) -> bool:
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
            hwnd = int(user32.GetForegroundWindow())
            if hwnd == 0:
                return False
            current_pid = int(kernel32.GetCurrentProcessId())
            target_pid = wintypes.DWORD(0)
            user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(target_pid))
            return int(target_pid.value) == current_pid
        except Exception:
            return False

    def _detect_and_dispatch_keys(self) -> None:
        import time
        
        shift_down = self._is_vk_down(0x10)
        modifiers_down = self._is_vk_down(0x11) or self._is_vk_down(0x12) or self._is_vk_down(0x5B) or self._is_vk_down(0x5C)

        monitored = [
            (0x08, "Backspace", "Backspace"),
            (0x09, "Tab", "Tab"),
            (0x0D, "Enter", "Enter"),
            (0x1B, "Escape", "Escape"),
            (0x20, " ", "Space"),
            (0xC0, "`", "Backquote"),
            (0x30, "0", "Digit0"),
            (0x31, "1", "Digit1"),
            (0x32, "2", "Digit2"),
            (0x33, "3", "Digit3"),
            (0x34, "4", "Digit4"),
            (0x35, "5", "Digit5"),
            (0x36, "6", "Digit6"),
            (0x37, "7", "Digit7"),
            (0x38, "8", "Digit8"),
            (0x39, "9", "Digit9"),
            (0xBB, "=", "Equal"),
            (0xBD, "-", "Minus"),
            (0xBE, ".", "Period"),
            (0xBF, "/", "Slash"),
            (0xBA, ";", "Semicolon"),
            (0xDE, "'", "Quote"),
            (0xDC, "\\", "Backslash"),
            (0xDD, "]", "BracketRight"),
            (0xDB, "[", "BracketLeft"),
            (0xBC, ",", "Comma"),
            (0x60, "0", "Numpad0"),
            (0x61, "1", "Numpad1"),
            (0x62, "2", "Numpad2"),
            (0x63, "3", "Numpad3"),
            (0x64, "4", "Numpad4"),
            (0x65, "5", "Numpad5"),
            (0x66, "6", "Numpad6"),
            (0x67, "7", "Numpad7"),
            (0x68, "8", "Numpad8"),
            (0x69, "9", "Numpad9"),
        ]
        for code in range(ord('A'), ord('Z') + 1):
            monitored.append((code, chr(code + 32), f"Key{chr(code)}"))

        sequence_ending_key = False
        current_time = time.time()

        for vk, key, code in monitored:
            state = self._get_vk_state(vk)
            is_down = bool(state & 0x8000)
            was_down = self._alias_sync_key_states.get(vk, False)
            just_pressed = bool(state & 0x0001) or (is_down and not was_down)

            if just_pressed and not modifiers_down and not (vk == 0xC0 and shift_down):
                if vk in (0x08, 0x09):
                    self._dispatch_alias_key(key, code)
                elif vk in (0x0D, 0x20, 0x1B):
                    self._dispatch_alias_key(key, code)
                    
                    if current_time - self._alias_sync_last_reset_time > 0.5:
                        if vk == 0x20 and (self._alias_sync_chinese_input_detected or self._alias_sync_sequence_active):
                            sequence_ending_key = True
                            self._alias_sync_chinese_input_detected = False
                        elif vk == 0x1B:
                            sequence_ending_key = True
                            self._alias_sync_chinese_input_detected = False
                elif 0x41 <= vk <= 0x5A or vk == 0xC0:
                    self._dispatch_alias_key(key, code)
                    self._alias_sync_sequence_active = True
                    self._alias_sync_chinese_input_detected = False
                elif (0x30 <= vk <= 0x39 or 0x60 <= vk <= 0x69) and self._alias_sync_sequence_active:
                    if current_time - self._alias_sync_last_reset_time > 0.5:
                        sequence_ending_key = True
                        self._alias_sync_chinese_input_detected = True
                elif (vk >= 0xBA or vk == 0xBC) and self._alias_sync_sequence_active:
                    if current_time - self._alias_sync_last_reset_time > 0.5:
                        sequence_ending_key = True
                        self._alias_sync_chinese_input_detected = True

            self._alias_sync_key_states[vk] = is_down

        mouse_lbutton = self._get_vk_state(0x01)
        mouse_is_down = bool(mouse_lbutton & 0x8000)
        mouse_was_down = self._alias_sync_key_states.get(0x01, False)
        mouse_just_pressed = bool(mouse_lbutton & 0x0001) or (mouse_is_down and not mouse_was_down)
        self._alias_sync_key_states[0x01] = mouse_is_down

        if mouse_just_pressed and self._alias_sync_sequence_active:
            if current_time - self._alias_sync_last_reset_time > 0.5:
                sequence_ending_key = True
                self._alias_sync_chinese_input_detected = True

        if sequence_ending_key and self._alias_sync_sequence_active:
            self._alias_sync_key_states = {}
            self._alias_sync_sequence_active = False
            self._alias_sync_last_reset_time = current_time
            self._dispatch_alias_restart()

    def _get_vk_state(self, vk: int) -> int:
        try:
            return int(ctypes.windll.user32.GetAsyncKeyState(vk))
        except Exception:
            return 0

    def _get_foreground_hwnd(self) -> int | None:
        try:
            hwnd = int(ctypes.windll.user32.GetForegroundWindow())
            return hwnd if hwnd != 0 else None
        except Exception:
            return None

    def _is_vk_down(self, vk: int) -> bool:
        try:
            return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)
        except Exception:
            return False

    def _dispatch_alias_key(self, key: str, code: str) -> None:
        try:
            page = self.browser.page() if self.browser else None
            if not page:
                return
            script = (
                "window.__handleExternalAliasTriggerKey && "
                f"window.__handleExternalAliasTriggerKey({json.dumps(key)}, {json.dumps(code)});"
            )
            page.runJavaScript(script)
        except Exception:
            return

    def _dispatch_alias_reset(self) -> None:
        try:
            page = self.browser.page() if self.browser else None
            if not page:
                return
            page.runJavaScript("window.__resetAliasTrigger && window.__resetAliasTrigger();")
        except Exception:
            return

    def _dispatch_alias_restart(self) -> None:
        try:
            page = self.browser.page() if self.browser else None
            if not page:
                return
            page.runJavaScript(
                "window.__forceRestartAliasTrigger && window.__forceRestartAliasTrigger();"
            )
        except Exception:
            return

    def _is_external_editable_focus(self) -> bool:
        if not sys.platform.startswith('win'):
            return False
        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
            hwnd = int(user32.GetForegroundWindow())
            if hwnd == 0:
                return False

            current_pid = int(kernel32.GetCurrentProcessId())
            target_pid = wintypes.DWORD(0)
            user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(target_pid))
            target_pid_val = int(target_pid.value)
            
            if target_pid_val == current_pid:
                return False

            return True
        except Exception:
            return False

    # ---------------- Window / State ----------------
    def _setup_window(self) -> None:
        self.setWindowTitle("卓雅客服助手")
        self.setMinimumSize(380, 600)
        
        # 焦点保护状态（不再使用WindowDoesNotAcceptFocus，避免各种问题）
        self._focus_protection_enabled = False

        # 获取图标路径（支持打包环境和开发环境）
        icon_path = get_resource_path("icons" / Path("icon.svg"))
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))
            print(f"[DesktopApp] 使用图标: {icon_path}")
        else:
            print("[DesktopApp] 未找到图标文件")

        # 菜单：视图 -> 显示控制台；刷新
        menubar = self.menuBar()
        view_menu = menubar.addMenu("视图(&V)")

        self.toggle_console_action = QAction("显示控制台(&C)", self)
        self.toggle_console_action.setCheckable(True)
        # 控制台已禁用，不绑定触发

        self.refresh_action = QAction("刷新(F5)", self)
        self.refresh_action.setShortcut(QKeySequence("F5"))
        self.refresh_action.triggered.connect(self._refresh_page)
        # 将快捷键动作添加到窗口（菜单隐藏时也可生效）
        self.addAction(self.refresh_action)
        # 备用快捷键 Ctrl+R
        alt_refresh = QAction(self)
        alt_refresh.setShortcut(QKeySequence("Ctrl+R"))
        alt_refresh.triggered.connect(self._refresh_page)
        self.addAction(alt_refresh)

        # 备用快捷键（隐藏菜单后仍可使用）
        # 不再提供控制台/刷新快捷键

        # 恢复窗口大小与位置
        self._restore_window_geometry()

        # 定时保存窗口状态（降低频率，减少UI微小闪动）
        self._auto_save_timer = QTimer(self)
        self._auto_save_timer.timeout.connect(self._save_window_geometry_silent)
        self._auto_save_timer.start(60000)

        # 统一样式：去掉菜单栏/工具栏/分隔线的 1px 边线，避免黑线闪现
        base_styles = (
            "QMainWindow { background: #f5f5f5; }"
            "QMainWindow::separator { background: transparent; width:0px; height:0px; }"
            "QMenuBar { background: transparent; border: 0px; }"
            "QMenuBar::item { background: transparent; }"
            "QToolBar { border: 0px; background: transparent; }"
            "QDockWidget { border: 0px; }"
            "QStatusBar { border: 0px; }"
        )
        self.setStyleSheet(base_styles)

        # 去除窗口/中央区额外边距与边框，避免任何 1px 视觉缝隙
        self.setContentsMargins(0, 0, 0, 0)
        if hasattr(self, 'browser'):
            self.browser.setStyleSheet("border: 0px; background: transparent;")

        # 隐藏菜单栏（通过快捷键操作替代），避免菜单栏与中央区之间的分隔线闪现
        menubar.setVisible(False)
        
        # ====== 焦点保护控制方法 ======
    
    def _set_focus_protection(self, enabled: bool) -> None:
        """设置焦点保护模式（已禁用，保留接口兼容）"""
        self._focus_protection_enabled = enabled
        print(f"[焦点保护] 状态: {enabled} (实际控制已禁用)")
    
    def _enable_no_focus_mode(self) -> None:
        """启用不抢焦点模式（鼠标悬停序号时调用）"""
        print("【日志】鼠标进入序号按钮 → 已开启不抢焦点")
        
        # 使用 Windows API 设置 WS_EX_NOACTIVATE 扩展样式（防止窗口激活）
        if sys.platform.startswith('win'):
            try:
                import ctypes
                from ctypes import wintypes
                
                # 获取窗口句柄
                hwnd = int(self.winId())
                
                # 获取当前扩展样式
                GWL_EXSTYLE = -20
                WS_EX_NOACTIVATE = 0x08000000
                
                current_ex_style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                new_ex_style = current_ex_style | WS_EX_NOACTIVATE
                
                # 设置新的扩展样式
                ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex_style)
                print("【日志】WS_EX_NOACTIVATE 已设置（通过 Windows API）")
            except Exception as e:
                print(f"【日志】设置 WS_EX_NOACTIVATE 失败: {e}")
                # 回退到 Qt 的方式
                self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowDoesNotAcceptFocus)
                self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
                self.show()
                print("【日志】WindowDoesNotAcceptFocus 已设置（Qt 方式）")
    
    def _disable_no_focus_mode(self) -> None:
        """禁用不抢焦点模式（鼠标离开序号时调用）"""
        print("【日志】鼠标离开序号按钮 → 已关闭不抢焦点")
        
        # 使用 Windows API 移除 WS_EX_NOACTIVATE 扩展样式
        if sys.platform.startswith('win'):
            try:
                import ctypes
                from ctypes import wintypes
                
                # 获取窗口句柄
                hwnd = int(self.winId())
                
                # 获取当前扩展样式
                GWL_EXSTYLE = -20
                WS_EX_NOACTIVATE = 0x08000000
                
                current_ex_style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                new_ex_style = current_ex_style & ~WS_EX_NOACTIVATE
                
                # 设置新的扩展样式
                ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex_style)
                print("【日志】WS_EX_NOACTIVATE 已移除（通过 Windows API）")
            except Exception as e:
                print(f"【日志】移除 WS_EX_NOACTIVATE 失败: {e}")
                # 回退到 Qt 的方式
                flags = self.windowFlags() & ~Qt.WindowType.WindowDoesNotAcceptFocus
                self.setWindowFlags(flags)
                self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, False)
                self.show()
                print("【日志】WindowDoesNotAcceptFocus 已移除（Qt 方式）")
    
    def _temporarily_disable_focus_protection(self) -> None:
        """临时禁用焦点保护（点击输入框时调用）- 激活窗口"""
        # 直接激活窗口，让输入法能够获取焦点
        self.activateWindow()
        self.raise_()
        # 延迟再次激活，确保输入法候选框位置正确
        QTimer.singleShot(50, self.activateWindow)
    
    def _restore_focus_protection(self) -> None:
        """恢复焦点保护（点击非输入框区域时调用）- 空操作"""
        pass
    
    def _clear_main_overlay_buttons(self) -> None:
        """清除主窗口透明序号按钮"""
        for btn in self._main_overlay_buttons:
            btn.deleteLater()
        self._main_overlay_buttons.clear()

    def _create_main_overlay_buttons(self, positions_json: str) -> None:
        """创建透明序号按钮覆盖在主窗口WebView上
        
        Args:
            positions_json: JSON数组，每个元素包含 {x, y, w, h, content}
        """
        self._clear_main_overlay_buttons()
        
        if not positions_json:
            return
        
        import json
        try:
            positions = json.loads(positions_json)
        except json.JSONDecodeError:
            return
        
        if not positions:
            return
        
        # WebView在窗口中的位置
        if not hasattr(self, 'browser') or not self.browser:
            return
        webview_pos = self.browser.pos()
        
        for pos_data in positions:
            x = pos_data.get('x', 0)
            y = pos_data.get('y', 0)
            w = pos_data.get('w', 18)
            h = pos_data.get('h', 18)
            content = pos_data.get('content', '')
            
            if not content or w <= 0 or h <= 0:
                continue
            
            # 创建透明按钮
            btn = QPushButton(self)
            btn.setGeometry(
                webview_pos.x() + int(x) - 2,
                webview_pos.y() + int(y) - 2,
                int(w) + 4,
                int(h) + 4
            )
            btn.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    border: none;
                }
                QPushButton:hover {
                    background: rgba(102, 126, 234, 0.2);
                    border-radius: 9px;
                }
            """)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            btn.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
            
            # 绑定点击事件
            captured_content = content
            btn.clicked.connect(lambda checked=False, c=captured_content: self._on_overlay_button_click(c))
            
            btn.show()
            btn.raise_()
            
            self._main_overlay_buttons.append(btn)

    def _on_overlay_button_click(self, content: str) -> None:
        """透明序号按钮点击 - 复制并执行不抢焦点粘贴"""
        if content:
            clipboard = QApplication.clipboard()
            clipboard.setText(content)
            self.paste_to_last_external_no_focus_steal()

    def _restore_window_geometry(self) -> None:
        config_file = self.config_dir / "window.ini"
        settings = QSettings(str(config_file), QSettings.Format.IniFormat)
        geometry = settings.value("window/geometry")
        if geometry and isinstance(geometry, (bytes, QByteArray)):
            if isinstance(geometry, bytes):
                geometry = QByteArray(geometry)
            self.restoreGeometry(geometry)
        else:
            # 默认使用最小宽度
            self.resize(self.minimumWidth(), 1000)

        state = settings.value("window/state")
        if state and isinstance(state, (bytes, QByteArray)):
            if isinstance(state, bytes):
                state = QByteArray(state)
            self.restoreState(state)

    def _save_window_geometry_silent(self) -> None:
        config_file = self.config_dir / "window.ini"
        settings = QSettings(str(config_file), QSettings.Format.IniFormat)
        settings.setValue("window/geometry", self.saveGeometry())
        settings.setValue("window/state", self.saveState())
        settings.sync()

    # ---------------- Console ----------------
    def _setup_console(self) -> None:
        # 已禁用控制台
        self.console_dock = None
        self.console_text = None

    def _toggle_console(self) -> None:
        pass

    def _log_to_console(self, level: str, message: str) -> None:
        # 控制台已禁用
        return
    
    def _on_console_message(self, level, message: str, line_number: int, source_id: str) -> None:
        """JavaScript 控制台消息处理 - 输出到 Python 控制台"""
        # 🔧 过滤掉 QWebChannel 的内部错误（不影响功能）
        if "channel.execCallbacks" in message or "qwebchannel" in message.lower():
            return
        
        # 处理 JavaScriptConsoleMessageLevel 枚举类型
        level_str = "INFO"
        try:
            level_str = str(level).split('.')[-1] if hasattr(level, 'name') else str(level)
        except Exception:
            pass
        
        # 输出到 Python 控制台
        try:
            print(f"js: {level_str} {message}".encode('utf-8', errors='replace').decode('utf-8', errors='replace'))
        except Exception:
            pass
        # 如果是 savePhrase 相关的调试信息，额外打印尾部 repr / unicode_escape，便于查找零宽字符或不可见码点
        try:
            if "[DEBUG savePhrase]" in message:
                tail = message[-1000:]
                try:
                    print("[文本编辑器 JS DEBUG TAIL REPR]:", repr(tail))
                except Exception:
                    pass
                try:
                    print("[文本编辑器 JS DEBUG TAIL UNICODE_ESC]:", tail.encode('unicode_escape').decode('ascii', errors='ignore')[-1000:])
                except Exception:
                    pass
        except Exception:
            pass
    
    def _on_feature_permission_requested(self, origin: QUrl, feature) -> None:
        """处理功能权限请求（如剪贴板访问）"""
        from PyQt6.QtWebEngineCore import QWebEnginePage
        
        # 自动授予剪贴板读写权限
        if feature == QWebEnginePage.Feature.ClipboardReadWrite:
            page = self.browser.page()
            if page:
                page.setFeaturePermission(origin, feature, QWebEnginePage.PermissionPolicy.PermissionGrantedByUser)
                print(f"[权限] 已授予剪贴板访问权限: {origin.toString()}")
        else:
            print(f"[权限] 收到权限请求: {origin.toString()}, feature={feature}")
    
    def _check_and_cleanup_memory(self) -> None:
        """检查内存占用，超过阈值才触发清理"""
        try:
            import psutil
            proc = psutil.Process(os.getpid())
            total = proc.memory_info().rss
            for c in proc.children(recursive=True):
                try:
                    total += c.memory_info().rss
                except Exception:
                    pass

            threshold = 450 * 1024 * 1024  # 450MB
            if total < threshold:
                return

            # 最小清理间隔 2 分钟，避免频繁清理
            import time
            now = time.time()
            if now - getattr(self, '_last_cleanup_time', 0) < 120:
                return
            self._last_cleanup_time = now

            msg = f"[内存优化] 内存达 {total // 1024 // 1024}MB，触发清理"
            print(msg)
            try:
                from crash_monitor import _write as _log_write
                _log_write(msg)
            except Exception:
                pass

            self._cleanup_memory()
        except Exception:
            pass

    def _cleanup_memory(self) -> None:
        """定期内存清理"""
        try:
            # 1. 清理 WebEngine HTTP 缓存
            if hasattr(self, 'profile') and self.profile:
                self.profile.clearHttpCache()

            # 2. 遍历所有 WebEngineView（主窗口 + 子窗口如计算器/文本编辑器），触发 JS GC
            pages_cleaned = 0
            for widget in QApplication.topLevelWidgets():
                for view in widget.findChildren(QWebEngineView):
                    try:
                        page = view.page()
                        if page:
                            page.runJavaScript("if(window.gc){window.gc();}")
                            pages_cleaned += 1
                    except Exception:
                        pass

            # 3. Python 层 GC
            collected = gc.collect()

            msg = f"[内存优化] 清理完成: JS GC x{pages_cleaned}, Python GC 回收 {collected} 对象"
            print(msg)
            try:
                from crash_monitor import _write as _log_write
                _log_write(msg)
            except Exception:
                pass
        except Exception as e:
            print(f"[内存优化] 清理时出错: {e}")

    # ---------------- WebView ----------------
    def _setup_webview(self) -> None:
        self.browser = QWebEngineView()
        self.setCentralWidget(self.browser)

        # Profile 与设置
        app_data = self.config_dir
        cache_dir = app_data / "cache"
        cache_dir.mkdir(exist_ok=True)

        storage_dir = app_data / "webengine_profile"
        storage_dir.mkdir(exist_ok=True)

        self.profile = QWebEngineProfile("zhuoya_profile_slim", self)
        self.profile.setPersistentStoragePath(str(storage_dir))
        
        # 优化内存使用：减少缓存，因为这是离线应用
        self.profile.setCachePath(str(cache_dir))
        self.profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.MemoryHttpCache)  # 使用内存缓存而非磁盘缓存
        self.profile.setHttpCacheMaximumSize(5 * 1024 * 1024)  # 减少缓存大小到5MB
        self.profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies)  # 不保存cookies

        # 使用自定义 Profile 创建页面并绑定到视图，确保本地存储/IndexedDB 持久化到固定目录
        # 使用 NoContextMenuWebEnginePage 禁用原生右键菜单
        page = NoContextMenuWebEnginePage(self.profile, self.browser)
        self.browser.setPage(page)
        # 在 QWebEngineView 层面也禁用右键菜单
        self.browser.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
        
        # 授予剪贴板访问权限
        page.featurePermissionRequested.connect(self._on_feature_permission_requested)
        
        # 连接 JavaScript 控制台消息，用于调试
        page.javaScriptConsoleMessage = self._on_console_message

        # 注入全局错误处理（简化）
        script = QWebEngineScript()
        script.setName("DesktopErrorHandler")
        script.setSourceCode(
            """
            window.isDesktopApp = true;
            window.addEventListener('error', function(event) {
                console.error('❌ 未捕获的异常: ' + (event.message || '未知错误'));
            });
            window.addEventListener('unhandledrejection', function(event) {
                const reason = event.reason;
                const msg = reason && reason.message ? reason.message : String(reason || '未知 Promise 拒绝');
                console.error('❌ 未处理的 Promise 拒绝: ' + msg);
            });
            """
        )
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        script.setRunsOnSubFrames(False)
        self.profile.scripts().insert(script)

        # 应用设置
        settings = self.browser.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        
        # 内存优化设置
        settings.setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)  # 禁用插件
        settings.setAttribute(QWebEngineSettings.WebAttribute.WebGLEnabled, False)    # 禁用WebGL
        settings.setAttribute(QWebEngineSettings.WebAttribute.Accelerated2dCanvasEnabled, False)  # 禁用2D加速
        
        # 其他必要设置
        settings.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.ScrollAnimatorEnabled, True)
        
        # 设置内存监控清理：30秒检查一次，超 450MB 才触发
        self.memory_cleanup_timer = QTimer()
        self.memory_cleanup_timer.timeout.connect(self._check_and_cleanup_memory)
        self.memory_cleanup_timer.start(30 * 1000)  # 30秒检查

        # F12 开发者工具支持
        self.dev_tools_view = None
        self.browser.loadFinished.connect(self._on_load_finished)

        # 添加快捷键 F12 打开 DevTools
        from PyQt6.QtGui import QShortcut, QKeySequence
        self._dev_tools_shortcut = QShortcut(QKeySequence("F12"), self)
        self._dev_tools_shortcut.activated.connect(self._toggle_dev_tools)

        # 注入 Python 桥脚本（只注入一次到 profile）
        self._inject_python_bridge()
        
        # 建立初始的 WebChannel
        self._setup_web_channel()

    def _toggle_dev_tools(self) -> None:
        """切换 F12 开发者工具窗口"""
        try:
            page = self.browser.page()
            if not page:
                return

            if self.dev_tools_view and self.dev_tools_view.isVisible():
                # 如果 DevTools 已打开，则关闭
                self.dev_tools_view.close()
                self.dev_tools_view = None
            else:
                # 创建新的 DevTools 窗口
                self.dev_tools_view = QWebEngineView()
                self.dev_tools_view.setWindowTitle("开发者工具 - F12 关闭")
                self.dev_tools_view.resize(900, 600)

                # 设置 DevTools 页面
                page.setDevToolsPage(self.dev_tools_view.page())

                # 显示 DevTools 窗口
                self.dev_tools_view.show()

                # 确保主窗口保持在前面
                self.raise_()
                self.activateWindow()

                print("[DevTools] 开发者工具已打开，按 F12 关闭")
        except Exception as e:
            print(f"[DevTools] 打开开发者工具失败: {e}")

    def _inject_python_bridge(self) -> None:
        """注入 Python Bridge 脚本到 profile（只调用一次）"""
        # 检查脚本是否已经注入，避免重复
        scripts = self.profile.scripts()
        existing_scripts = scripts.toList()
        script_names_to_check = {"QtWebChannelLoader", "PythonBridgeSetup"}
        existing_names = {script.name() for script in existing_scripts}
        
        if script_names_to_check.issubset(existing_names):
            print("[优化] 脚本已存在，跳过重复注入")
            return

        # 先注入 Qt WebChannel 脚本加载器，确保 QWebChannel 可用
        loader = QWebEngineScript()
        loader.setName("QtWebChannelLoader")
        loader.setSourceCode(
            """
            (function(){
                function ensureQWebChannel(retry){
                    if (typeof QWebChannel === 'undefined'){
                        if (!document.head) {
                            if (retry > 0) {
                                setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                            }
                            return;
                        }
                        var s = document.createElement('script');
                        s.src = 'qrc:///qtwebchannel/qwebchannel.js';
                        s.onload = function(){ /* loaded */ };
                        s.onerror = function(){ 
                            console.error('[LOG] QWebChannel 脚本加载失败');
                        };
                        try {
                            document.head.appendChild(s);
                        } catch (e) {
                            console.error('[LOG] 无法注入 QWebChannel 脚本:', e);
                        }
                        if (retry > 0) setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                        return;
                    }
                }
                ensureQWebChannel(40);
            })();
            """
        )
        loader.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        loader.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        loader.setRunsOnSubFrames(False)
        self.profile.scripts().insert(loader)

        # 注入桥接初始化脚本（页面创建时就运行）
        bridge_script = QWebEngineScript()
        bridge_script.setName("PythonBridgeSetup")
        bridge_script.setSourceCode(
            """
            (function() {
                function setup(retry) {
                    // 检查必要的对象是否存在
                    if (typeof qt === 'undefined') {
                        console.log('[LOG] 等待 qt 对象... (剩余重试:', retry, ')');
                        if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 100);
                        console.error('[LOG] qt 对象未找到，Python Bridge 初始化失败');
                        return;
                    }
                    if (typeof QWebChannel === 'undefined') {
                        console.log('[LOG] 等待 QWebChannel... (剩余重试:', retry, ')');
                        if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 100);
                        console.error('[LOG] QWebChannel 未找到，Python Bridge 初始化失败');
                        return;
                    }
                    if (!qt.webChannelTransport) {
                        console.log('[LOG] 等待 webChannelTransport... (剩余重试:', retry, ')');
                        if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 100);
                        console.error('[LOG] webChannelTransport 未找到，Python Bridge 初始化失败');
                        return;
                    }
                    try {
                        new QWebChannel(qt.webChannelTransport, function(channel) {
                            if (!channel || !channel.objects) {
                                console.error('[LOG] QWebChannel 连接失败：channel 或 objects 为空');
                                return;
                            }
                            window.pythonBridge = channel.objects.pythonBridge;
                            if (!window.pythonBridge) {
                                console.error('[LOG] Python Bridge 对象未找到');
                                return;
                            }
                            console.log('[LOG] ✅ Python 桥接对象已注入');
                            console.log('[LOG] Python Bridge 可用方法:', Object.keys(window.pythonBridge || {}));
                            if (window.pythonBridge && typeof window.pythonBridge.open_text_editor === 'function') {
                                console.log('[LOG] ✅ open_text_editor 方法已就绪');
                            } else {
                                console.warn('[LOG] ⚠️ open_text_editor 方法未找到或不是函数');
                            }
                            if (window.pythonBridge && typeof window.pythonBridge.open_calculator === 'function') {
                                console.log('[LOG] ✅ open_calculator 方法已就绪');
                            } else {
                                console.warn('[LOG] ⚠️ open_calculator 方法未找到或不是函数');
                            }
                        });
                    } catch (error) {
                        console.error('[LOG] ❌ Python Bridge 初始化异常:', error);
                    }
                }
                if (typeof window.pythonBridge === 'undefined') {
                    console.log('[LOG] 开始初始化 Python Bridge...');
                    setup(100);  // 增加重试次数
                } else {
                    console.log('[LOG] Python Bridge 已存在，跳过初始化');
                }
            })();
            """
        )
        bridge_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        bridge_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        bridge_script.setRunsOnSubFrames(False)
        self.profile.scripts().insert(bridge_script)
        print("[优化] Python Bridge 脚本已注入到 profile")

    def _setup_web_channel(self) -> None:
        """设置 WebChannel（每次页面加载后调用）"""
        # 清理旧的 WebChannel
        if self.web_channel is not None:
            try:
                page = self.browser.page()
                if page:
                    page.setWebChannel(None)
            except Exception as e:
                print(f"[优化] 清理旧 WebChannel 时出错: {e}")
            try:
                self.web_channel.deleteLater()
            except Exception:
                pass
            self.web_channel = None
        
        # 清理旧的 Bridge
        if self.python_bridge is not None:
            try:
                self.python_bridge.deleteLater()
            except Exception:
                pass
            self.python_bridge = None
        
        # 创建新的 Bridge 和 WebChannel
        page = self.browser.page()
        if page:
            self.python_bridge = PythonBridge(self)
            self.web_channel = QWebChannel(page)
            self.web_channel.registerObject("pythonBridge", self.python_bridge)
            page.setWebChannel(self.web_channel)
            print("[优化] WebChannel 已重新建立")

    def _on_load_finished(self, success: bool) -> None:
        """页面加载完成回调"""
        if success:
            self.setWindowTitle("卓雅客服助手")
            self._log_to_console('info', '✅ 页面加载成功！')
            self._log_to_console('info', '🎉 应用已就绪，开始使用吧！')
            # 重新建立 WebChannel（不重复注入脚本）
            self._setup_web_channel()
        else:
            self.setWindowTitle("卓雅话术助手 - 加载失败")
            self._log_to_console('error', '❌ 页面加载失败！')
            QMessageBox.warning(
                self,
                "加载失败",
                "页面加载失败，请检查 HTML 文件是否正确。\n\n按 F12 打开控制台查看详细错误信息。"
            )

    # ---------------- Load ---------------- 
    def _load_app(self) -> None:
        # 直接使用根目录现有 index.html，以保持界面一致
        html_path = get_resource_path("index.html").resolve()
        if not html_path.exists():
            QMessageBox.critical(self, "错误", f"找不到 index.html 文件：\n{html_path}")
            sys.exit(1)
        self.browser.load(QUrl.fromLocalFile(str(html_path)))

    # ---------------- 自动分屏拼接功能 ----------------
    def launch_browser_with_split_screen(self, url: str, chrome_path: str = None, arguments: str = None, working_directory: str = None) -> bool:
        """启动浏览器并实现自动分屏拼接
        
        Args:
            url: 要打开的网址
            chrome_path: Chrome浏览器路径（可选）
            arguments: 启动参数（可选）
            working_directory: 工作目录（可选）
            
        Returns:
            bool: 是否成功启动并分屏
        """
        print(f"[分屏] 开始分屏功能，URL: {url}")
        if chrome_path:
            print(f"[分屏] 使用指定Chrome路径: {chrome_path}")
        if arguments:
            print(f"[分屏] 启动参数: {arguments}")
        
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        
        browser_hwnd = None
        
        # 从参数中提取 profile 信息
        target_profile = self._extract_profile_from_args(arguments)
        if target_profile:
            print(f"[分屏] 🎯 目标 Profile: {target_profile}")
        else:
            print(f"[分屏] ℹ️ 未指定 Profile，将使用默认浏览器")
        
        # === 第1步：尝试从映射表查找（最可靠）===
        map_lookup_failed = False
        if target_profile and hasattr(self, '_profile_hwnd_map') and target_profile in self._profile_hwnd_map:
            mapped_hwnd = self._profile_hwnd_map[target_profile]
            if user32.IsWindow(mapped_hwnd):
                browser_hwnd = mapped_hwnd
                print(f"[分屏] ✅ 从映射表找到窗口: {browser_hwnd} (profile: {target_profile})")
            else:
                print(f"[分屏] ⚠️ 映射表中的窗口已失效，清除: {target_profile}")
                del self._profile_hwnd_map[target_profile]
                map_lookup_failed = True

        # === 第2步：映射表失效时，直接启动新浏览器（跳过不可靠的进程命令行匹配）===
        # Chrome 多 Profile 共享进程，进程命令行匹配不可靠
        if not browser_hwnd and target_profile and map_lookup_failed:
            print(f"[分屏] 🚀 映射表失效，直接启动新浏览器 (profile: {target_profile})")
            browser_hwnd = self._launch_and_wait_for_browser(url, chrome_path, arguments, working_directory)
            if not browser_hwnd:
                print("[分屏] ❌ 启动浏览器失败")
                return False
            print(f"[分屏] ✅ 新浏览器已启动: {browser_hwnd}")

        # === 第3步：没有指定 profile 时，尝试复用上次窗口 ===
        if not browser_hwnd and not target_profile:
            if hasattr(self, '_last_split_browser_hwnd') and self._last_split_browser_hwnd:
                if user32.IsWindow(self._last_split_browser_hwnd):
                    browser_hwnd = self._last_split_browser_hwnd
                    print(f"[分屏] ✅ 复用上次浏览器窗口: {browser_hwnd} (无profile要求)")
                else:
                    print(f"[分屏] ⚠️ 上次浏览器窗口已销毁，清除记录")
                    self._last_split_browser_hwnd = None

        # === 第4步：没有就启动新浏览器 ===
        if not browser_hwnd:
            print(f"[分屏] 🚀 未找到合适的浏览器窗口，启动新浏览器")
            if target_profile:
                print(f"[分屏] 将启动 profile: {target_profile}")
            browser_hwnd = self._launch_and_wait_for_browser(url, chrome_path, arguments, working_directory)
            if not browser_hwnd:
                print("[分屏] ❌ 启动浏览器失败")
                return False
            print(f"[分屏] ✅ 新浏览器已启动: {browser_hwnd}")

        # === 第5步：保存记录并应用分屏布局 ===
        self._last_split_browser_hwnd = browser_hwnd

        # 记录 Profile -> 窗口句柄映射（用于多 Profile 窗口识别）
        if target_profile and browser_hwnd:
            self._profile_hwnd_map[target_profile] = browser_hwnd
            self._save_profile_map()  # 持久化保存
            print(f"[分屏] 📝 记录映射: {target_profile} -> hwnd={browser_hwnd}")
            print(f"[分屏] 📝 当前映射表: {self._profile_hwnd_map}")
        
        hwnd_assistant = int(self.winId())
        result = self._reapply_split_layout(hwnd_assistant, browser_hwnd)
        
        if result:
            print(f"[分屏] 分屏布局成功")
        else:
            print(f"[分屏] 分屏布局失败")
        
        return result
    
    def _launch_and_wait_for_browser(self, url: str, chrome_path: str = None, arguments: str = None, working_directory: str = None) -> int | None:
        """启动浏览器并等待窗口创建，返回窗口句柄"""
        import ctypes
        from ctypes import wintypes
        import time
        
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32 = ctypes.windll.user32
        
        # 启动前枚举所有现有窗口
        before_hwnds = set()
        
        def enum_before(hwnd, lparam):
            before_hwnds.add(hwnd)
            return True
        
        user32.EnumWindows(WNDENUMPROC(enum_before), 0)
        print(f"[分屏] 启动前窗口数量: {len(before_hwnds)}")
        
        # 启动浏览器
        browser_pid = self._launch_browser_get_pid(url, chrome_path, arguments, working_directory)
        if not browser_pid:
            print("[分屏] 浏览器启动失败")
            return None
        
        print(f"[分屏] 浏览器已启动，PID: {browser_pid}")
        
        # 轮询查找新窗口（最多15秒）
        browser_hwnd = None
        for i in range(75):  # 75 * 0.2 = 15秒
            time.sleep(0.2)
            hwnd = self._find_new_chrome_window(before_hwnds)
            if hwnd:
                browser_hwnd = hwnd
                print(f"[分屏] 检测到新浏览器窗口: {browser_hwnd} (第{i+1}次轮询)")
                break
            if i % 10 == 0 and i > 0:
                print(f"[分屏] 等待浏览器窗口... ({i*0.2:.0f}秒)")
        
        if not browser_hwnd:
            print("[分屏] 15秒内未检测到新浏览器窗口")
            return None
        
        print(f"[分屏] 浏览器窗口句柄: {browser_hwnd}")
        return browser_hwnd
    
    def _launch_browser_get_pid(self, url: str, chrome_path: str = None, arguments: str = None, working_directory: str = None) -> int | None:
        """启动浏览器并返回PID"""
        try:
            import subprocess
            import os
            
            # 使用传入的Chrome路径，如果没有则尝试查找
            chrome_exe = chrome_path
            if not chrome_exe:
                print("[分屏] 未指定Chrome路径，尝试查找...")
                # 尝试找到Chrome浏览器
                chrome_paths = [
                    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                    r"C:\Users\%USERNAME%\AppData\Local\Google\Chrome\Application\chrome.exe"
                ]
                
                for path in chrome_paths:
                    expanded_path = os.path.expandvars(path)
                    if os.path.exists(expanded_path):
                        chrome_exe = expanded_path
                        break
            
            if not chrome_exe:
                print("[分屏] 未找到Chrome浏览器")
                return None
            
            print(f"[分屏] 使用Chrome路径: {chrome_exe}")
            
            # 构建启动命令（只带 --new-window 和 profile，不带坐标参数）
            cmd = [chrome_exe, '--new-window', url]
            if arguments:
                # 解析参数并添加到命令中
                import shlex
                parsed_args = shlex.split(arguments)
                cmd.extend(parsed_args)
                print(f"[分屏] 添加参数: {arguments}")
            
            # 设置工作目录
            cwd = working_directory if working_directory and os.path.exists(working_directory) else None
            if cwd:
                print(f"[分屏] 使用工作目录: {cwd}")
            
            # 启动浏览器
            proc = subprocess.Popen(cmd, cwd=cwd, shell=False)
            print(f"[分屏] 浏览器已启动，PID: {proc.pid}")
            return proc.pid
            
        except Exception as e:
            print(f"[分屏] 启动浏览器失败: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    def _wait_for_browser_window(self, pid: int, timeout: int = 10) -> int | None:
        """等待浏览器窗口创建并返回HWND"""
        try:
            import time
            import win32gui
            import win32process
            
            start_time = time.time()
            
            while time.time() - start_time < timeout:
                def callback(hwnd, hwnd_list):
                    try:
                        _, window_pid = win32process.GetWindowThreadProcessId(hwnd)
                        if window_pid == pid and win32gui.IsWindowVisible(hwnd):
                            hwnd_list.append(hwnd)
                            return False  # 停止枚举
                    except:
                        pass
                    return True
                
                hwnd_list = []
                win32gui.EnumWindows(callback, hwnd_list)
                
                if hwnd_list:
                    return hwnd_list[0]
                
                time.sleep(0.5)  # 等待500ms再重试
            
            print(f"[分屏] 等待浏览器窗口超时 ({timeout}秒)")
            return None
            
        except Exception as e:
            print(f"[分屏] 等待浏览器窗口失败: {e}")
            return None
    
    def _find_new_chrome_window(self, before_hwnds: set) -> int | None:
        """在启动Chrome后查找新出现的Chrome窗口"""
        import ctypes
        from ctypes import wintypes
        
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user32 = ctypes.windll.user32
        
        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long)
            ]
        
        found = []
        
        def enum_proc(hwnd, lparam):
            if hwnd in before_hwnds:
                return True  # 不是新窗口，继续枚举
            
            # 检查类名是否为 Chrome 窗口
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, 256)
            if class_name.value == 'Chrome_WidgetWin_1':
                # 额外检查：窗口是否可见、有尺寸
                rect = RECT()
                if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    w = rect.right - rect.left
                    h = rect.bottom - rect.top
                    if w > 100 and h > 100:  # 过滤掉小窗口/隐藏窗口
                        found.append(hwnd)
            return True
        
        callback = WNDENUMPROC(enum_proc)
        user32.EnumWindows(callback, 0)
        
        return found[0] if found else None
    
    def _get_current_screen_rect(self) -> tuple[int, int, int, int] | None:
        """获取话术助手当前所在显示器的屏幕区域"""
        try:
            import win32api
            import win32gui
            
            # 获取主窗口句柄
            main_hwnd = int(self.winId())
            
            # 获取窗口所在的显示器
            monitor = win32api.MonitorFromWindow(main_hwnd)
            
            # 获取显示器信息
            monitor_info = win32api.GetMonitorInfo(monitor)
            
            # 使用工作区域高度，避免底部溢出遮挡任务栏
            work_area = monitor_info['Work']
            print(f"[分屏] 屏幕完整区域: {monitor_info['Monitor']}")
            print(f"[分屏] 工作区域: {work_area} (使用此区域避免任务栏遮挡)")
            
            return work_area
            
        except Exception as e:
            print(f"[分屏] 获取屏幕区域失败: {e}")
            return None
    
    def _calculate_split_layout(self, screen_rect: tuple[int, int, int, int]) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
        """计算分屏布局
        
        Args:
            screen_rect: 屏幕区域 (left, top, right, bottom)
            
        Returns:
            tuple: (话术助手区域, 浏览器区域)
        """
        left, top, right, bottom = screen_rect
        screen_width = right - left
        screen_height = bottom - top
        
        # 补偿参数
        assistant_offset = 16    # 话术助手位置减少16px，彻底抵消系统边框占地
        height_compensation = 9  # 窗口高度增加9px，补齐系统边框吃掉的高度
        
        # 调整后的工作区域（增加高度补偿）
        adjusted_bottom = bottom + height_compensation
        
        # 话术助手：固定宽382px，位置减少16px抵消边框占地，靠右，高度补偿
        assistant_rect = (
            right - 382 - assistant_offset,  # 左边距：减少16px抵消系统边框占地
            top,                            # 上边距
            right - assistant_offset,        # 右边距：同样减少16px
            adjusted_bottom                 # 下边距：增加9px补偿
        )
        
        # 浏览器：占满剩余宽度+3px重叠，靠左，高度补偿
        browser_rect = (
            left,                           # 左边距
            top,                            # 上边距
            right - 382 - assistant_offset + 3,  # 右边距：基于话术助手调整后位置+3px重叠
            adjusted_bottom                 # 下边距：增加9px补偿
        )
        
        print(f"[分屏] 布局计算 - 工作区: {screen_width}x{screen_height}")
        print(f"[分屏] 补偿参数: 助手偏移-{assistant_offset}px, 高度补偿+{height_compensation}px")
        print(f"[分屏] 话术助手区域: {assistant_rect} (382px宽，-{assistant_offset}px偏移抵消边框)")
        print(f"[分屏] 浏览器区域: {browser_rect} ({screen_width-382-assistant_offset+3}px宽，+3px重叠+{height_compensation}px高度)")
        
        return assistant_rect, browser_rect
    
    def _reapply_split_layout(self, hwnd_assistant: int, browser_hwnd: int) -> bool:
        """对已有窗口重新应用分屏布局（不启动新浏览器）"""
        try:
            import ctypes
            from ctypes import wintypes
            import time

            user32 = ctypes.windll.user32
            dwmapi = ctypes.windll.dwmapi

            # === 激活浏览器窗口到前台 ===
            print(f"[布局] 🔝 激活浏览器窗口到前台: hwnd={browser_hwnd}")
            # 如果窗口最小化，先恢复
            if user32.IsIconic(browser_hwnd):
                print(f"[布局] 窗口最小化，恢复中...")
                SW_RESTORE = 9
                user32.ShowWindow(browser_hwnd, SW_RESTORE)
                time.sleep(0.5)
            # 激活窗口到前台
            user32.SetForegroundWindow(browser_hwnd)
            time.sleep(0.3)
            
            # 定义结构体（必须在使用前定义）
            class RECT(ctypes.Structure):
                _fields_ = [
                    ("left", ctypes.c_long),
                    ("top", ctypes.c_long),
                    ("right", ctypes.c_long),
                    ("bottom", ctypes.c_long)
                ]
            
            class POINT(ctypes.Structure):
                _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
            
            class MONITORINFOEX(ctypes.Structure):
                _fields_ = [
                    ('cbSize', ctypes.c_ulong),
                    ('rcMonitor', RECT),
                    ('rcWork', RECT),
                    ('dwFlags', ctypes.c_ulong),
                    ('szDevice', ctypes.c_wchar * 32)
                ]
            
            # === 检测并处理窗口状态（最大化/全屏/最小化）===
            GWL_STYLE = -16
            WS_CAPTION = 0x00C00000
            WS_MAXIMIZE = 0x01000000
            SW_RESTORE = 9

            style = user32.GetWindowLongW(browser_hwnd, GWL_STYLE)
            is_maximized = bool(style & WS_MAXIMIZE)
            is_fullscreen = not (style & WS_CAPTION)
            is_minimized = bool(user32.IsIconic(browser_hwnd))

            print(f"[布局] 窗口状态检查: style=0x{style:X}")
            print(f"[布局]   最大化={is_maximized}, 全屏={is_fullscreen}, 最小化={is_minimized}")

            # 处理最小化
            if is_minimized:
                print("[布局] 📐 浏览器处于最小化，恢复窗口")
                user32.ShowWindow(browser_hwnd, SW_RESTORE)
                time.sleep(0.3)

            # 处理最大化（优先级最高，因为是最常见的场景）
            if is_maximized and not is_fullscreen:
                print("[布局] 📐 浏览器处于最大化状态，恢复为普通窗口")
                user32.SetForegroundWindow(browser_hwnd)
                time.sleep(0.2)
                user32.ShowWindow(browser_hwnd, SW_RESTORE)
                time.sleep(1.0)  # 等待窗口完全恢复动画
                # 验证恢复结果
                style_after = user32.GetWindowLongW(browser_hwnd, GWL_STYLE)
                if style_after & WS_MAXIMIZE:
                    print("[布局] ⚠️ 第一次恢复失败，再次尝试")
                    user32.ShowWindow(browser_hwnd, SW_RESTORE)
                    time.sleep(0.8)
                print("[布局] ✅ 已从最大化恢复为普通窗口")

            # 处理全屏（F11 全屏）
            elif is_fullscreen:
                print("[布局] 📐 浏览器处于全屏状态（无标题栏），尝试退出")

                # 先检查窗口大小是否等于屏幕大小（辅助判断）
                import win32api
                rect = RECT()
                user32.GetWindowRect(browser_hwnd, ctypes.byref(rect))
                monitor = win32api.MonitorFromWindow(browser_hwnd, 1)
                monitor_info = win32api.GetMonitorInfo(monitor)
                screen_rect = monitor_info['Monitor']

                # 如果窗口大小等于屏幕大小，也认为是全屏
                if (rect.left <= screen_rect[0] and rect.top <= screen_rect[1] and
                    rect.right >= screen_rect[2] and rect.bottom >= screen_rect[3]):
                    print("[布局]   通过窗口大小确认全屏")

                # 激活浏览器窗口
                user32.SetForegroundWindow(browser_hwnd)
                time.sleep(0.3)

                # 方法1：模拟按 F11 退出全屏
                VK_F11 = 0x7A
                KEYEVENTF_KEYUP = 0x0002
                user32.keybd_event(VK_F11, 0, 0, 0)
                time.sleep(0.1)
                user32.keybd_event(VK_F11, 0, KEYEVENTF_KEYUP, 0)
                print("[布局]   已发送 F11 键")
                time.sleep(1.0)

                # 验证是否成功退出全屏
                style_after = user32.GetWindowLongW(browser_hwnd, GWL_STYLE)
                still_fullscreen = not (style_after & WS_CAPTION)

                if still_fullscreen:
                    print("[布局]   F11 无效，尝试使用 ShowWindow(SW_RESTORE)")
                    user32.ShowWindow(browser_hwnd, SW_RESTORE)
                    time.sleep(0.5)

                    # 最终验证
                    style_final = user32.GetWindowLongW(browser_hwnd, GWL_STYLE)
                    if not (style_final & WS_CAPTION):
                        print("[布局] ❌ 退出全屏失败，放弃拼接")
                        return False
                    else:
                        print("[布局] ✅ 使用 ShowWindow 成功退出全屏")
                else:
                    print("[布局] ✅ 通过 F11 成功退出全屏")
            
            # 关阴影 + 设置边框颜色
            DWMWA_BORDER_COLOR = 34
            border_color = ctypes.c_uint32(0x002D2D2D)
            dwmapi.DwmSetWindowAttribute(hwnd_assistant, DWMWA_BORDER_COLOR,
                                          ctypes.byref(border_color), ctypes.sizeof(ctypes.c_uint32))
            dwmapi.DwmSetWindowAttribute(browser_hwnd, DWMWA_BORDER_COLOR,
                                          ctypes.byref(border_color), ctypes.sizeof(ctypes.c_uint32))
            
            DWMWA_NCRENDERING_POLICY = 2
            policy = ctypes.c_uint32(2)  # DWMNCRP_ENABLED
            dwmapi.DwmSetWindowAttribute(hwnd_assistant, DWMWA_NCRENDERING_POLICY,
                                          ctypes.byref(policy), ctypes.sizeof(ctypes.c_uint32))
            dwmapi.DwmSetWindowAttribute(browser_hwnd, DWMWA_NCRENDERING_POLICY,
                                          ctypes.byref(policy), ctypes.sizeof(ctypes.c_uint32))
            
            time.sleep(0.3)  # 确保 DWM 结算完成

            # === 读浏览器窗口矩形和 DWM 边界 ===
            # 等待窗口矩形有效（避免 (0,0,0,0)）
            browser_rect = RECT()
            for wait_i in range(10):
                user32.GetWindowRect(browser_hwnd, ctypes.byref(browser_rect))
                if browser_rect.left != 0 or browser_rect.top != 0 or browser_rect.right != 0 or browser_rect.bottom != 0:
                    break
                print(f"[布局] 等待窗口矩形就绪... ({wait_i+1}/10)")
                time.sleep(0.3)

            browser_dwm = RECT()
            dwmapi.DwmGetWindowAttribute(browser_hwnd, 9, ctypes.byref(browser_dwm), ctypes.sizeof(RECT))
            
            # === 读助手窗口矩形 ===
            assistant_rect = RECT()
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(assistant_rect))
            assistant_dwm = RECT()
            dwmapi.DwmGetWindowAttribute(hwnd_assistant, 9, ctypes.byref(assistant_dwm), ctypes.sizeof(RECT))
            
            # === 动态计算 DWM 内缩（不写死任何值） ===
            b_left_inset = browser_dwm.left - browser_rect.left      # 左侧 DWM 偏移
            b_right_inset = browser_rect.right - browser_dwm.right   # 右侧 DWM 偏移
            a_left_inset = assistant_dwm.left - assistant_rect.left
            
            print(f"[布局] 浏览器窗口: ({browser_rect.left},{browser_rect.top},{browser_rect.right},{browser_rect.bottom})")
            print(f"[布局] 浏览器DWM:  ({browser_dwm.left},{browser_dwm.top},{browser_dwm.right},{browser_dwm.bottom})")
            print(f"[布局] 浏览器内缩: 左{b_left_inset}px 右{b_right_inset}px")
            
            # === 获取显示器信息 ===
            center_x = (assistant_rect.left + assistant_rect.right) // 2
            center_y = (assistant_rect.top + assistant_rect.bottom) // 2
            pt = POINT(center_x, center_y)
            hMonitor = user32.MonitorFromPoint(pt, 1)
            
            monitor_info = MONITORINFOEX()
            monitor_info.cbSize = ctypes.sizeof(MONITORINFOEX)
            user32.GetMonitorInfoW(hMonitor, ctypes.byref(monitor_info))
            
            screen_left = monitor_info.rcMonitor.left
            screen_right = monitor_info.rcMonitor.right
            work_height = monitor_info.rcWork.bottom - monitor_info.rcWork.top
            
            # === 计算布局（所有值动态，不硬编码） ===
            assistant_width = assistant_rect.right - assistant_rect.left  # 396

            # === 判断助手在屏幕哪边 ===
            screen_center_x = (screen_left + screen_right) // 2
            assistant_center_x = (assistant_rect.left + assistant_rect.right) // 2
            assistant_on_left = assistant_center_x < screen_center_x

            print(f"[布局] 屏幕中心: {screen_center_x}, 助手中心: {assistant_center_x}")
            print(f"[布局] 助手在屏幕{'左侧' if assistant_on_left else '右侧'}")

            # GDI 边框补偿
            gdi_border = (assistant_width - 382) // 2  # 7px

            # DWM 视觉重叠量
            target_visual_overlap = 3   # DWM 视觉边界重叠 3px
            window_overlap = b_right_inset + a_left_inset + target_visual_overlap

            # 高度
            height_comp = 9
            final_height = work_height + height_comp

            if assistant_on_left:
                # === 助手在左，浏览器在右 ===
                # 助手 X：贴屏幕左边缘 - GDI 边框补偿（与右侧逻辑对称）
                assistant_x = screen_left - gdi_border

                # 浏览器 X：视觉边缘对齐 + 1px重叠消除缝隙
                # 助手视觉右边缘 = assistant_x + assistant_width - a_left_inset
                # 浏览器视觉左边缘 = browser_x + b_left_inset
                browser_x = assistant_x + assistant_width - a_left_inset - b_left_inset - 1

                # 浏览器宽度：从 browser_x 到屏幕右边缘 + 右侧内缩
                browser_width = screen_right - browser_x + b_right_inset

                print(f"[布局] 助手在左: assistant_x={assistant_x}")
                print(f"[布局] 浏览器在右: browser_x={browser_x}, width={browser_width}")
                print(f"[布局] 预期DWM视觉右贴边: {browser_x + browser_width - b_right_inset} == {screen_right}")
            else:
                # === 助手在右，浏览器在左（原有逻辑） ===
                # 浏览器 X：向左偏移，让 DWM 视觉左边界对齐屏幕左边缘
                browser_x = screen_left - b_left_inset  # 主屏: 0 - 7 = -7, 副屏: -2560 - 7 = -2567

                # 助手 X：贴屏幕右边缘 + GDI 边框补偿
                assistant_x = screen_right - assistant_width + gdi_border

                # 浏览器宽度：从 browser_x 到 assistant_x 的距离 + 重叠量
                browser_width = (assistant_x - browser_x) + window_overlap

                print(f"[布局] 浏览器在左: browser_x={browser_x} (左偏移{b_left_inset}px)")
                print(f"[布局] browser_width={browser_width} (重叠{window_overlap}px)")
                print(f"[布局] 助手在右: assistant_x={assistant_x}")
                print(f"[布局] 预期DWM视觉左贴边: {browser_x + b_left_inset} == {screen_left}")
            
            # === 两次 DeferWindowPos（第一次设位置，第二次确认） ===
            SWP_NOZORDER = 0x0004
            SWP_NOACTIVATE = 0x0010
            for attempt in range(2):
                hdwp = user32.BeginDeferWindowPos(2)
                hdwp = user32.DeferWindowPos(hdwp, browser_hwnd, 0,
                                              browser_x, 0, browser_width, final_height,
                                              SWP_NOZORDER | SWP_NOACTIVATE)
                hdwp = user32.DeferWindowPos(hdwp, hwnd_assistant, 0,
                                              assistant_x, 0, assistant_width, final_height,
                                              SWP_NOZORDER | SWP_NOACTIVATE)
                user32.EndDeferWindowPos(hdwp)
                time.sleep(0.1)
            
            # === 验证 ===
            final_br = RECT()
            user32.GetWindowRect(browser_hwnd, ctypes.byref(final_br))
            print(f"[验证] 最终浏览器: ({final_br.left},{final_br.top},{final_br.right},{final_br.bottom})")
            print(f"[验证] 浏览器左侧距屏幕: {final_br.left - screen_left}px (目标≤0)")
            
            return True
            
        except Exception as e:
            print(f"[分屏] 重新拼接失败: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    def _apply_split_layout(self, assistant_rect: tuple[int, int, int, int], browser_hwnd: int, browser_rect: tuple[int, int, int, int]) -> bool:
        """应用分屏布局 - 纯阴影关闭+重叠布局，不动窗口样式"""
        try:
            import win32gui
            import win32con
            import win32api
            import ctypes
            from ctypes import wintypes
            import time
            
            # 定义常量和结构体
            class MARGINS(ctypes.Structure):
                _fields_ = [
                    ("cxLeftWidth", ctypes.c_int),
                    ("cxRightWidth", ctypes.c_int),
                    ("cxTopHeight", ctypes.c_int),
                    ("cxBottomHeight", ctypes.c_int),
                ]
            
            class RECT(ctypes.Structure):
                _fields_ = [
                    ("left", ctypes.c_long),
                    ("top", ctypes.c_long),
                    ("right", ctypes.c_long),
                    ("bottom", ctypes.c_long)
                ]
            
            # 获取窗口句柄
            hwnd_assistant = int(self.winId())
            hwnd_browser = browser_hwnd
            
            # 获取API
            user32 = ctypes.windll.user32
            dwmapi = ctypes.windll.dwmapi
            
            # 常量
            DWMWA_EXTENDED_FRAME_BOUNDS = 9
            SWP_NOZORDER = 0x0004
            SWP_NOACTIVATE = 0x0010
            
            print("[分屏] === 纯阴影关闭+重叠布局，不动窗口样式 ===")
            
            # === 第1步：打印当前屏幕检测方式 ===
            print("[诊断] 屏幕获取方式: Qt QApplication.primaryScreen()")
            try:
                from PyQt6.QtWidgets import QApplication
                qt_screen = QApplication.primaryScreen()
                if qt_screen:
                    qt_screen_rect = qt_screen.geometry()
                    qt_available_rect = qt_screen.availableGeometry()
                    print(f"[诊断] Qt返回的屏幕区域: ({qt_screen_rect.left()}, {qt_screen_rect.top()}, {qt_screen_rect.right()}, {qt_screen_rect.bottom()})")
                    print(f"[诊断] Qt返回的工作区域: ({qt_available_rect.left()}, {qt_available_rect.top()}, {qt_available_rect.right()}, {qt_available_rect.bottom()})")
            except Exception as e:
                print(f"[诊断] Qt屏幕获取失败: {e}")
            
            print("[诊断] 屏幕获取方式: Win32 GetSystemMetrics")
            try:
                import win32api
                sm_cxscreen = win32api.GetSystemMetrics(0)  # SM_CXSCREEN
                sm_cyscreen = win32api.GetSystemMetrics(1)  # SM_CYSCREEN
                print(f"[诊断] GetSystemMetrics返回的屏幕区域: (0, 0, {sm_cxscreen}, {sm_cyscreen})")
            except Exception as e:
                print(f"[诊断] GetSystemMetrics失败: {e}")
            
            # === 第2步：打印所有显示器信息 ===
            print("[诊断] 枚举所有显示器...")
            try:
                # 定义结构体
                class MONITORINFOEX(ctypes.Structure):
                    _fields_ = [
                        ('cbSize', ctypes.c_ulong),
                        ('rcMonitor', RECT),
                        ('rcWork', RECT),
                        ('dwFlags', ctypes.c_ulong),
                        ('szDevice', ctypes.c_wchar * 32)
                    ]
                
                class POINT(ctypes.Structure):
                    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]
                
                # 枚举所有显示器及其区域
                monitors = []
                def monitor_enum_proc(hMonitor, hdc, rect, param):
                    monitors.append({
                        'handle': hMonitor,
                        'rect': (rect.left, rect.top, rect.right, rect.bottom)
                    })
                    return True
                
                user32.EnumDisplayMonitors(None, None, monitor_enum_proc, None)
                
                for i, m in enumerate(monitors):
                    info = MONITORINFOEX()
                    info.cbSize = ctypes.sizeof(MONITORINFOEX)
                    user32.GetMonitorInfoW(m['handle'], ctypes.byref(info))
                    is_primary = bool(info.dwFlags & 1)  # MONITORINFOF_PRIMARY
                    print(f"[诊断] 显示器{i}: 矩形={m['rect']}, 工作区=({info.rcWork.left},{info.rcWork.top},{info.rcWork.right},{info.rcWork.bottom}), 主屏={is_primary}")
                    
            except Exception as e:
                print(f"[诊断] 枚举显示器失败: {e}")
            
            # === 诊断1：检查DWM非客户区渲染策略 ===
            print("[诊断] 检查DWM非客户区渲染策略...")
            DWMWA_NCRENDERING_POLICY = 2
            policy = ctypes.c_int()
            result = dwmapi.DwmGetWindowAttribute(hwnd_assistant, DWMWA_NCRENDERING_POLICY,
                                                   ctypes.byref(policy), ctypes.sizeof(policy))
            print(f"[诊断] NCRENDERING_POLICY 查询结果: 0x{result:X}, 值: {policy.value}")
            print(f"[诊断] DWMNCRP_USEWINDOWSTYLE(0): {policy.value == 0}")
            print(f"[诊断] DWMNCRP_DISABLED(1): {policy.value == 1}")
            print(f"[诊断] DWMNCRP_ENABLED(2): {policy.value == 2}")
            
            # === 诊断2：检查窗口扩展风格 ===
            print("[诊断] 检查窗口扩展风格...")
            GWL_EXSTYLE = -20
            ex_style = user32.GetWindowLongPtrW(hwnd_assistant, GWL_EXSTYLE)
            print(f"[诊断] 扩展风格: 0x{ex_style:X}")
            print(f"[诊断] WS_EX_WINDOWEDGE (0x100): {bool(ex_style & 0x100)}")
            print(f"[诊断] WS_EX_CLIENTEDGE (0x200): {bool(ex_style & 0x200)}")
            
            # === 诊断3：阴影关闭前后边界对比 ===
            print("[诊断] 阴影关闭前后边界对比...")
            dwm_rect1 = RECT()
            win_rect1 = RECT()
            dwmapi.DwmGetWindowAttribute(hwnd_assistant, DWMWA_EXTENDED_FRAME_BOUNDS,
                                       ctypes.byref(dwm_rect1), ctypes.sizeof(dwm_rect1))
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(win_rect1))
            print(f"[诊断] 关阴影前 - 窗口: ({win_rect1.left},{win_rect1.top},{win_rect1.right},{win_rect1.bottom})")
            print(f"[诊断] 关阴影前 - DWM:  ({dwm_rect1.left},{dwm_rect1.top},{dwm_rect1.right},{dwm_rect1.bottom})")
            
            # === 步骤1：用DWM属性设置边框颜色和关闭阴影 ===
            print("[分屏] 步骤1：设置边框颜色和关闭阴影（不用negative margins）")
            
            # 步骤1：正确设置边框颜色为窗口背景色
            DWMWA_BORDER_COLOR = 34
            # COLORREF 格式：0x00BBGGRR
            border_color = ctypes.c_uint32(0x002D2D2D)  # 深灰，与助手窗口背景一致
            hr_border = dwmapi.DwmSetWindowAttribute(
                hwnd_assistant,
                DWMWA_BORDER_COLOR,
                ctypes.byref(border_color),
                ctypes.sizeof(ctypes.c_uint32)
            )
            print(f"[分屏] 设置边框颜色: {'成功' if hr_border == 0 else f'失败(0x{hr_border:X})'}")
            
            # 步骤2：用NCRENDERING_POLICY替代negative margins关阴影
            DWMWA_NCRENDERING_POLICY = 2
            DWMNCRP_ENABLED = 2  # DWM渲染非客户区，但窗口内容延伸到边框
            policy = ctypes.c_uint32(DWMNCRP_ENABLED)
            hr_policy = dwmapi.DwmSetWindowAttribute(
                hwnd_assistant,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(policy),
                ctypes.sizeof(ctypes.c_uint32)
            )
            print(f"[分屏] 设置NCRENDERING_POLICY: {'成功' if hr_policy == 0 else f'失败(0x{hr_policy:X})'}")
            
            # 浏览器窗口也设置相同的策略
            hr_policy_browser = dwmapi.DwmSetWindowAttribute(
                hwnd_browser,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(policy),
                ctypes.sizeof(ctypes.c_uint32)
            )
            print(f"[分屏] 浏览器设置NCRENDERING_POLICY: {'成功' if hr_policy_browser == 0 else f'失败(0x{hr_policy_browser:X})'}")
            
            time.sleep(0.2)  # 等待DWM结算
            
            # 设置后再次读取边界
            dwm_rect2 = RECT()
            win_rect2 = RECT()
            dwmapi.DwmGetWindowAttribute(hwnd_assistant, DWMWA_EXTENDED_FRAME_BOUNDS,
                                       ctypes.byref(dwm_rect2), ctypes.sizeof(dwm_rect2))
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(win_rect2))
            print(f"[诊断] 设置后 - 窗口: ({win_rect2.left},{win_rect2.top},{win_rect2.right},{win_rect2.bottom})")
            print(f"[诊断] 设置后 - DWM:  ({dwm_rect2.left},{dwm_rect2.top},{dwm_rect2.right},{dwm_rect2.bottom})")
            print(f"[诊断] 窗口边界变化: ({win_rect2.left-win_rect1.left},{win_rect2.top-win_rect1.top},{win_rect2.right-win_rect1.right},{win_rect2.bottom-win_rect1.bottom})")
            print(f"[诊断] DWM边界变化: ({dwm_rect2.left-dwm_rect1.left},{dwm_rect2.top-dwm_rect1.top},{dwm_rect2.right-dwm_rect1.right},{dwm_rect2.bottom-dwm_rect1.bottom})")
            
            if hr_border == 0 and hr_policy == 0 and hr_policy_browser == 0:
                print("[分屏] ✓ 边框颜色和NCRENDERING_POLICY设置成功")
            else:
                print(f"[分屏] ⚠ 设置部分失败: 边框=0x{hr_border:X}, 助手策略=0x{hr_policy:X}, 浏览器策略=0x{hr_policy_browser:X}")
            
            # === 第3步：检测话术助手当前在哪个显示器 ===
            print("[诊断] 检测话术助手当前所在显示器...")
            try:
                # 获取话术助手窗口的当前矩形
                assistant_rect = RECT()
                user32.GetWindowRect(hwnd_assistant, ctypes.byref(assistant_rect))
                
                # 计算窗口中心点
                center_x = (assistant_rect.left + assistant_rect.right) // 2
                center_y = (assistant_rect.top + assistant_rect.bottom) // 2
                
                # 用中心点定位所在显示器
                pt = POINT(center_x, center_y)
                hMonitor = user32.MonitorFromPoint(pt, 1)  # MONITOR_DEFAULTTONEAREST
                
                # 获取该显示器的信息
                monitor_info = MONITORINFOEX()
                monitor_info.cbSize = ctypes.sizeof(MONITORINFOEX)
                user32.GetMonitorInfoW(hMonitor, ctypes.byref(monitor_info))
                
                print(f"[诊断] 助手窗口中心: ({center_x}, {center_y})")
                print(f"[诊断] 所在显示器: hMonitor={hMonitor}")
                print(f"[诊断] 显示器完整区域: ({monitor_info.rcMonitor.left},{monitor_info.rcMonitor.top},{monitor_info.rcMonitor.right},{monitor_info.rcMonitor.bottom})")
                print(f"[诊断] 显示器工作区域: ({monitor_info.rcWork.left},{monitor_info.rcWork.top},{monitor_info.rcWork.right},{monitor_info.rcWork.bottom})")
                print(f"[诊断] 是否主屏: {bool(monitor_info.dwFlags & 1)}")
                
                # 保存显示器信息用于布局计算
                work_area = (monitor_info.rcWork.left, monitor_info.rcWork.top, 
                           monitor_info.rcWork.right, monitor_info.rcWork.bottom)
                screen_left = monitor_info.rcMonitor.left
                screen_right = monitor_info.rcMonitor.right
                
            except Exception as e:
                print(f"[诊断] 检测助手所在显示器失败: {e}")
            
            # === 步骤2：读取DWM扩展边界 ===
            print("[分屏] 步骤2：读取DWM扩展边界")
            
            browser_dwm = RECT()
            assistant_dwm = RECT()
            hr3 = dwmapi.DwmGetWindowAttribute(hwnd_browser, DWMWA_EXTENDED_FRAME_BOUNDS,
                                              ctypes.byref(browser_dwm), ctypes.sizeof(browser_dwm))
            hr4 = dwmapi.DwmGetWindowAttribute(hwnd_assistant, DWMWA_EXTENDED_FRAME_BOUNDS,
                                              ctypes.byref(assistant_dwm), ctypes.sizeof(assistant_dwm))
            
            if hr3 != 0 or hr4 != 0:
                print(f"[分屏] ✗ 读取DWM边界失败: 浏览器=0x{hr3:X}, 助手=0x{hr4:X}")
                return False
            
            # 获取窗口矩形
            browser_rect = RECT()
            user32.GetWindowRect(hwnd_browser, ctypes.byref(browser_rect))
            assistant_rect = RECT()
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(assistant_rect))
            
            # 计算DWM内缩量
            browser_left_inset = browser_dwm.left - browser_rect.left
            browser_right_inset = browser_rect.right - browser_dwm.right
            assistant_left_inset = assistant_dwm.left - assistant_rect.left
            assistant_right_inset = assistant_rect.right - assistant_dwm.right
            
            print(f"[分屏] 浏览器DWM内缩: 左{browser_left_inset}px 右{browser_right_inset}px")
            print(f"[分屏] 助手DWM内缩: 左{assistant_left_inset}px 右{assistant_right_inset}px")
            
            # === 步骤3：计算重叠布局 ===
            print("[分屏] 步骤3：计算重叠布局")
            
            # 使用之前保存的显示器信息
            if 'work_area' not in locals():
                print("[分屏] ✗ 未获取到显示器信息，使用默认主屏")
                # 回退到主屏获取方式
                monitor = win32api.MonitorFromWindow(hwnd_assistant)
                monitor_info = win32api.GetMonitorInfo(monitor)
                work_area = monitor_info['Work']
                screen_left = 0
                screen_right = work_area[2]
            
            # Win32 侧读取窗口实际矩形宽度
            assistant_rect = RECT()
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(assistant_rect))
            assistant_width = assistant_rect.right - assistant_rect.left  
            print(f"[分屏] 话术助手实际窗口宽度: {assistant_width}px")
            
            work_height = work_area[3] - work_area[1]
            work_left = work_area[0]
            work_right = work_area[2]
            screen_width = work_right - work_left
            
            # 底部补偿：基于DWM边界超出工作区的量，但加上限保护
            browser_bottom_overflow = browser_dwm.bottom - work_area[3]
            assistant_bottom_overflow = assistant_dwm.bottom - work_area[3]
            height_compensation = max(max(browser_bottom_overflow, assistant_bottom_overflow, 0) + 2, 6)
            if height_compensation > 12:    # 上限保护
                height_compensation = 9     # 回退到固定值
            final_height = work_height + height_compensation
            
            # 重叠量补偿GDI边框
            # 减少重叠量，消除浏览器遮挡助手
            visual_border_per_side = 7  # 每侧视觉边框约7px（150% DPI）
            target_visual_overlap = 1  # 目标视觉重叠1px（几乎无缝）
            overlap_pixels = visual_border_per_side * 2 + target_visual_overlap  # 7*2 + 1 = 15
            
            # 修正浏览器x坐标基于显示器左边界
            left_offset = 8  # 浏览器左移8px消除左侧空隙
            browser_x = screen_left - left_offset  # 基于显示器左边界计算
            
            # 补偿GDI边框，让助手右边缘对齐屏幕边缘
            gdi_border = (assistant_width - 382) // 2  # GDI边框厚度 = (实际宽度 - 视觉宽度) / 2
            assistant_x = work_right - assistant_width + gdi_border  # 助手右移，让GDI右边框超出屏幕
            
            # 修正浏览器宽度计算（基于新的助手位置）
            browser_width = (assistant_x - browser_x) + overlap_pixels
            
            print(f"[分屏] 布局计算 - 浏览器: x={browser_x}, width={browser_width}, height={final_height}")
            print(f"[分屏] 布局计算 - 助手: x={assistant_x}, width={assistant_width}, height={final_height}")
            print(f"[分屏] 窗口重叠: {overlap_pixels}px, 高度补偿: {height_compensation}px")
            print(f"[分屏] 显示器信息: screen_left={screen_left}, work_left={work_left}, work_right={work_right}")
            
            # === 步骤4：DeferWindowPos原子批量提交 ===
            print("[分屏] 步骤4：DeferWindowPos原子批量提交")
            
            try:
                # 开始原子批量操作
                hdwp = user32.BeginDeferWindowPos(2)
                if hdwp == 0:
                    raise Exception("BeginDeferWindowPos失败")
                
                # 添加浏览器到批量操作
                hdwp = user32.DeferWindowPos(hdwp, hwnd_browser, 0,
                                            browser_x, work_area[1], browser_width, final_height,
                                            SWP_NOZORDER | SWP_NOACTIVATE)
                if hdwp == 0:
                    raise Exception("DeferWindowPos浏览器失败")
                
                # 添加助手到批量操作
                hdwp = user32.DeferWindowPos(hdwp, hwnd_assistant, 0,
                                            assistant_x, work_area[1], assistant_width, final_height,
                                            SWP_NOZORDER | SWP_NOACTIVATE)
                if hdwp == 0:
                    raise Exception("DeferWindowPos助手失败")
                
                # 提交原子批量操作
                result = user32.EndDeferWindowPos(hdwp)
                print(f"[分屏] DeferWindowPos原子批量提交: {'成功' if result else '失败'}")
                
                if not result:
                    raise Exception("EndDeferWindowPos失败")
                    
            except Exception as e:
                print(f"[分屏] DeferWindowPos失败，降级为单独SetWindowPos: {e}")
                
                # 降级方案：分别设置窗口位置
                user32.SetWindowPos(hwnd_browser, 0, browser_x, work_area[1], 
                                  browser_width, final_height, SWP_NOZORDER | SWP_NOACTIVATE)
                time.sleep(0.05)
                user32.SetWindowPos(hwnd_assistant, 0, assistant_x, work_area[1], 
                                  assistant_width, final_height, SWP_NOZORDER | SWP_NOACTIVATE)
                print("[分屏] 降级方案完成")
            
            # === 步骤5：验证结果 ===
            print("[分屏] 步骤5：验证最终结果")
            time.sleep(0.05)
            
            final_browser = RECT()
            final_assistant = RECT()
            user32.GetWindowRect(hwnd_browser, ctypes.byref(final_browser))
            user32.GetWindowRect(hwnd_assistant, ctypes.byref(final_assistant))
            
            # 计算验证指标
            assistant_width_final = final_assistant.right - final_assistant.left
            assistant_overflow = final_assistant.right - work_area[2]
            window_gap = final_assistant.left - final_browser.right
            
            print(f"[分屏] 最终浏览器矩形: ({final_browser.left}, {final_browser.top}, {final_browser.right}, {final_browser.bottom})")
            print(f"[分屏] 最终助手矩形: ({final_assistant.left}, {final_assistant.top}, {final_assistant.right}, {final_assistant.bottom})")
            print(f"[分屏] 助手最终宽度: {assistant_width_final}px")
            print(f"[分屏] 助手右边界溢出: {assistant_overflow}px")
            print(f"[分屏] 窗口坐标间隙: {window_gap}px (负值表示重叠)")
            
            # 布局验证断言
            screen_left = work_area[0]
            screen_right = work_area[2]
            browser_right = final_browser.left + (final_browser.right - final_browser.left)
            
            # 详细验证日志
            expected_browser_x = screen_left - 8
            print(f"[验证] 浏览器: 左边界应≈{expected_browser_x}, 实际={final_browser.left}")
            print(f"[验证] 间隙: browser_right - assistant_x = {browser_right - final_assistant.left}px (应为负值表示重叠)")
            
            print("[分屏] 执行布局验证断言...")
            try:
                # 浏览器左边界必须在 screen_left 的 ±15px 范围内
                browser_left_diff = final_browser.left - screen_left
                assert screen_left - 15 <= final_browser.left <= screen_left + 5, \
                    f"浏览器x({final_browser.left})应接近屏幕左边界({screen_left}), 偏差{browser_left_diff}px"
                print(f"[分屏] ✓ 浏览器左边界验证通过: {final_browser.left} (偏差{browser_left_diff}px)")
                
                # 浏览器右边界与助手左边界的距离应在 (-50, 10) 之间（少量重叠）
                browser_right = final_browser.left + (final_browser.right - final_browser.left)
                gap = browser_right - final_assistant.left
                assert -50 <= gap <= 10, \
                    f"浏览器右({browser_right})与助手左({final_assistant.left})间隙={gap}px, 应在[-50, 10]"
                print(f"[分屏] ✓ 浏览器和助手间隙验证通过: {gap}px (应为负值表示重叠)")
                
                # 助手右边界不应超出屏幕
                assistant_right = final_assistant.left + (final_assistant.right - final_assistant.left)
                assert assistant_right <= screen_right + 2, \
                    f"助手右边界({assistant_right})溢出屏幕({screen_right})"
                print(f"[分屏] ✓ 助手右边界验证通过: {assistant_right} <= {screen_right + 2}")
                
                print("[分屏] ✓ 所有布局验证断言通过！")
                
            except AssertionError as e:
                print(f"[分屏] ✗ 布局验证失败: {e}")
                success = False
            
            # 验证成功标准
            success = True
            
            if assistant_overflow > 1:
                print(f"[分屏] ⚠ 助手右边界溢出屏幕 {assistant_overflow}px")
                success = False
            else:
                print(f"[分屏] ✓ 助手右边界未溢出屏幕")
            
            if abs(window_gap + overlap_pixels) > 2:  # 允许2px误差
                print(f"[分屏] ⚠ 窗口重叠不准确: 实际{abs(window_gap)}px, 预期{overlap_pixels}px")
                success = False
            else:
                print(f"[分屏] ✓ 窗口重叠符合预期")
            
            if success:
                print("[分屏] ✓ 纯阴影关闭+重叠布局完全成功！")
                # 标记浏览器已启动
                self._browser_launched = True
                return True
            else:
                print("[分屏] ⚠ 分屏布局部分成功，可能需要微调")
                # 即使部分成功也标记浏览器已启动，避免重复尝试
                self._browser_launched = True
                return True
            
        except Exception as e:
            print(f"[分屏] ✗ 应用分屏布局失败: {e}")
            import traceback
            traceback.print_exc()
            return False
    
    def _get_window_process_name(self, hwnd: int) -> str:
        """获取窗口所属进程名"""
        import ctypes
        from ctypes import wintypes
        
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        
        # 打开进程获取可执行文件名
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        hProcess = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hProcess:
            return ""
        
        exe_name = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        # QueryFullProcessImageNameW
        if kernel32.QueryFullProcessImageNameW(hProcess, 0, exe_name, ctypes.byref(size)):
            kernel32.CloseHandle(hProcess)
            full_path = exe_name.value
            return full_path.split('\\')[-1].lower()  # 返回如 "chrome.exe"
        
        kernel32.CloseHandle(hProcess)
        return ""
    
    def _extract_profile_from_args(self, arguments: str) -> str | None:
        """从启动参数中提取 profile 目录名"""
        if not arguments:
            return None

        import re

        # 匹配 --profile-directory="Profile 1" (带引号)
        match = re.search(r'--profile-directory[=\s]+"([^"]+)"', arguments)
        if match:
            profile = match.group(1)
            print(f"[Profile] 从参数提取到 profile-directory (带引号): {profile}")
            return profile

        # 匹配没有引号的情况：--profile-directory=Profile 1
        # 需要匹配到下一个参数 (--开头) 或行尾
        match = re.search(r'--profile-directory[=\s]+(.+?)(?:\s+--|$)', arguments)
        if match:
            profile = match.group(1).strip()
            print(f"[Profile] 从参数提取到 profile-directory (无引号): {profile}")
            return profile

        # 匹配 --user-data-dir="C:\path\to\dir" (带引号)
        match = re.search(r'--user-data-dir[=\s]+"([^"]+)"', arguments)
        if match:
            user_data = match.group(1)
            print(f"[Profile] 从参数提取到 user-data-dir (带引号): {user_data}")
            return user_data

        # 匹配没有引号的 --user-data-dir=C:\path
        match = re.search(r'--user-data-dir[=\s]+([^\s]+)', arguments)
        if match:
            user_data = match.group(1)
            print(f"[Profile] 从参数提取到 user-data-dir (无引号): {user_data}")
            return user_data
        
        return None
    
    def _get_window_profile(self, hwnd: int) -> str | None:
        """获取窗口对应浏览器的 profile"""
        try:
            import win32process
            
            # 获取进程ID
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            print(f"[Profile] 获取窗口 {hwnd} 的进程ID: {pid}")
            
            # 尝试使用 psutil 获取命令行（更可靠）
            try:
                import psutil
                proc = psutil.Process(pid)
                cmd_line = ' '.join(proc.cmdline())
                print(f"[Profile] psutil 获取到命令行: {cmd_line[:200]}...")
                profile = self._extract_profile_from_args(cmd_line)
                if profile:
                    print(f"[Profile] ✅ 提取到 profile: {profile}")
                    return profile
                else:
                    print(f"[Profile] ⚠️ 命令行中未找到 profile 参数")
            except ImportError:
                print("[Profile] psutil 未安装，尝试使用 wmi")
            except Exception as e:
                print(f"[Profile] psutil 获取失败: {e}")
            
            # 备用方案：使用 wmi 获取命令行
            try:
                import wmi  # type: ignore
                c = wmi.WMI()
                for process in c.Win32_Process(ProcessId=pid):
                    cmd_line = process.CommandLine
                    if cmd_line:
                        print(f"[Profile] wmi 获取到命令行: {cmd_line[:200]}...")
                        profile = self._extract_profile_from_args(cmd_line)
                        if profile:
                            print(f"[Profile] ✅ 提取到 profile: {profile}")
                            return profile
            except ImportError:
                print("[Profile] wmi 未安装")
            except Exception as e:
                print(f"[Profile] wmi 获取失败: {e}")
            
            print(f"[Profile] ❌ 无法获取窗口 {hwnd} 的 profile")
            return None
        except Exception as e:
            print(f"[Profile] 获取窗口 profile 失败: {e}")
            return None
    
    def _find_existing_browser_window(self, target_profile: str = None) -> int | None:
        """查找已存在的 Google Chrome 浏览器窗口，可选根据 profile 匹配"""
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long)
            ]

        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        found = []

        def enum_proc(hwnd, lparam):
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, 256)
            if class_name.value != 'Chrome_WidgetWin_1':
                return True

            # 检查窗口可见或最小化（排除隐藏窗口但保留最小化窗口）
            is_visible = user32.IsWindowVisible(hwnd)
            is_minimized = user32.IsIconic(hwnd)

            if not is_visible and not is_minimized:
                return True  # 跳过隐藏窗口

            # 获取窗口标题（最小化窗口也需要）
            title = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title, 512)

            # 检查进程名是否为 chrome.exe（包括最小化窗口）
            proc_name = self._get_window_process_name(hwnd)
            if proc_name != 'chrome.exe':
                # 跳过非 Chrome 进程（如豆包、Electron 应用等）
                return True

            # 最小化窗口的大小会被 Windows 缩小，所以先检查是否最小化
            if is_minimized:
                print(f"[查找] 发现最小化Chrome窗口: hwnd={hwnd}")
                if title.value:
                    print(f"[查找]   标题: {title.value}")
                found.append(hwnd)
                return True

            # 非最小化窗口检查大小
            rect = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            h = rect.bottom - rect.top
            if w < 200 or h < 200:
                return True

            if not title.value:
                return True

            print(f"[查找] 发现Chrome浏览器窗口: hwnd={hwnd}, title={title.value}, size={w}x{h}")
            found.append(hwnd)
            return True

        callback = WNDENUMPROC(enum_proc)
        user32.EnumWindows(callback, 0)

        if not found:
            print("[查找] ❌ 未找到Chrome浏览器窗口")
            return None

        print(f"[查找] 📋 找到 {len(found)} 个Chrome浏览器窗口")

        # === 调试：打印所有找到的窗口详情 ===
        for i, hwnd in enumerate(found):
            title = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, title, 512)
            is_minimized = user32.IsIconic(hwnd)
            is_visible = user32.IsWindowVisible(hwnd)
            print(f"[查找] 📋 窗口 #{i+1}: hwnd={hwnd}, visible={is_visible}, minimized={is_minimized}, title='{title.value}'")

        # 如果指定了 profile，尝试匹配
        if target_profile:
            print(f"[查找] 🔍 尝试匹配 profile: '{target_profile}'")

            # 策略1: 从映射表查找（最可靠）
            if hasattr(self, '_profile_hwnd_map') and target_profile in self._profile_hwnd_map:
                mapped_hwnd = self._profile_hwnd_map[target_profile]
                # 验证窗口是否还存在
                if user32.IsWindow(mapped_hwnd) and mapped_hwnd in found:
                    print(f"[查找] ✅ 从映射表找到匹配窗口: hwnd={mapped_hwnd}, profile='{target_profile}'")
                    return mapped_hwnd
                else:
                    print(f"[查找] ⚠️ 映射表中的窗口已失效，清除映射: {target_profile} -> hwnd={mapped_hwnd}")
                    del self._profile_hwnd_map[target_profile]

            # 策略2: 通过进程命令行匹配（启动时已建立映射，这里是备用）
            matched_hwnd = None
            for i, hwnd in enumerate(found):
                window_profile = self._get_window_profile(hwnd)
                print(f"[查找] 🔍 窗口 #{i+1} (hwnd={hwnd}) 获取到 profile: '{window_profile}' (目标: '{target_profile}')")
                if window_profile:
                    # 使用精确匹配
                    if window_profile == target_profile:
                        print(f"[查找] ✅ 通过命令行匹配到 profile '{target_profile}': hwnd={hwnd}")
                        matched_hwnd = hwnd
                        # 同时更新映射表并持久化
                        if hasattr(self, '_profile_hwnd_map'):
                            self._profile_hwnd_map[target_profile] = hwnd
                            self._save_profile_map()
                            print(f"[查找] 📝 更新映射表: {target_profile} -> hwnd={hwnd}")
                        break
                    else:
                        print(f"[查找] ❌ profile 不匹配: '{window_profile}' != '{target_profile}'")
                else:
                    print(f"[查找] ⚠️ 窗口 #{i+1} (hwnd={hwnd}) 无法获取 profile")

            if matched_hwnd:
                return matched_hwnd
            else:
                print(f"[查找] ⚠️ 未找到匹配 profile '{target_profile}' 的窗口")
                return None  # 返回 None 而不是第一个窗口，强制启动新浏览器

        # 如果没有指定 profile，返回第一个窗口
        print(f"[查找] ℹ️ 未指定 profile，使用第一个窗口: {found[0]}")
        return found[0]
    
    def _navigate_browser_to_url(self, hwnd: int, url: str) -> bool:
        """让现有浏览器导航到新URL"""
        try:
            import win32gui
            import win32con
            import time

            # 激活浏览器窗口
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.1)
            
            # 模拟Ctrl+L打开地址栏
            win32gui.SendMessage(hwnd, win32con.WM_COMMAND, 0x1004, 0)  # ID_FILE_OPEN_URL
            time.sleep(0.1)
            
            # 模拟输入URL
            import win32api
            import win32con
            
            # 清空地址栏并输入新URL
            win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
            win32api.keybd_event(ord('A'), 0, 0, 0)
            win32api.keybd_event(ord('A'), 0, win32con.KEYEVENTF_KEYUP, 0)
            win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(0.1)
            
            # 输入新URL
            for char in url:
                if char == ':':
                    win32api.keybd_event(win32con.VK_SHIFT, 0, 0, 0)
                    win32api.keybd_event(ord(';'), 0, 0, 0)
                    win32api.keybd_event(ord(';'), 0, win32con.KEYEVENTF_KEYUP, 0)
                    win32api.keybd_event(win32con.VK_SHIFT, 0, win32con.KEYEVENTF_KEYUP, 0)
                elif char == '/':
                    win32api.keybd_event(win32con.VK_SHIFT, 0, 0, 0)
                    win32api.keybd_event(ord('7'), 0, 0, 0)
                    win32api.keybd_event(ord('7'), 0, win32con.KEYEVENTF_KEYUP, 0)
                    win32api.keybd_event(win32con.VK_SHIFT, 0, win32con.KEYEVENTF_KEYUP, 0)
                else:
                    win32api.keybd_event(ord(char.upper()), 0, 0, 0)
                    win32api.keybd_event(ord(char.upper()), 0, win32con.KEYEVENTF_KEYUP, 0)
                time.sleep(0.01)
            
            # 按回车键
            win32api.keybd_event(win32con.VK_RETURN, 0, 0, 0)
            win32api.keybd_event(win32con.VK_RETURN, 0, win32con.KEYEVENTF_KEYUP, 0)
            
            print(f"[分屏] 已导航浏览器到: {url}")
            return True
            
        except Exception as e:
            print(f"[分屏] 导航浏览器失败: {e}")
            return False
    
    def _apply_split_screen_layout_to_existing_browser(self, browser_hwnd: int) -> bool:
        """对现有浏览器应用分屏布局"""
        try:
            import time
            
            print("[分屏] 对现有浏览器应用分屏布局")
            
            # 等待一下让浏览器稳定
            time.sleep(0.5)
            
            # 获取当前助手窗口矩形
            assistant_rect = self.geometry().getRect()
            assistant_rect = (assistant_rect.x(), assistant_rect.y(), 
                            assistant_rect.width(), assistant_rect.height())
            
            # 获取浏览器窗口矩形
            import win32gui
            browser_rect = win32gui.GetWindowRect(browser_hwnd)
            browser_rect = (browser_rect[0], browser_rect[1], 
                          browser_rect[2] - browser_rect[0], browser_rect[3] - browser_rect[1])
            
            # 应用分屏布局
            return self._apply_split_layout(assistant_rect, browser_hwnd, browser_rect)
            
        except Exception as e:
            print(f"[分屏] 对现有浏览器应用分屏布局失败: {e}")
            return False
    
    def _backup_window_styles(self, hwnd: int) -> tuple[int, bool] | None:
        """备份窗口原始样式"""
        try:
            import win32gui
            import win32con
            import ctypes
            from ctypes import wintypes
            
            # 备份扩展样式
            ex_style = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
            
            # 备份DWM阴影状态
            dwmapi = ctypes.windll.dwmapi
            DWMWA_NCRENDERING_POLICY = 2
            
            policy = ctypes.c_int()
            hr = dwmapi.DwmGetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(policy),
                ctypes.sizeof(policy)
            )
            
            shadow_enabled = (hr == 0 and policy.value != 1)  # 1 = DWMNCRP_DISABLED
            
            print(f"[分屏] 已备份窗口样式 - 扩展样式: 0x{ex_style:X}, DWM阴影: {shadow_enabled}")
            return ex_style, shadow_enabled
            
        except Exception as e:
            print(f"[分屏] 备份窗口样式失败: {e}")
            return None
    
    def _set_tool_window_style(self, hwnd: int) -> None:
        """给窗口添加WS_EX_TOOLWINDOW样式，缩小非客户区边框"""
        try:
            import win32gui
            import win32con
            
            # 获取当前扩展样式
            current_style = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
            
            # 添加WS_EX_TOOLWINDOW样式
            new_style = current_style | win32con.WS_EX_TOOLWINDOW
            
            # 设置新样式
            win32gui.SetWindowLong(hwnd, win32con.GWL_EXSTYLE, new_style)
            
            print(f"[分屏] 已设置WS_EX_TOOLWINDOW样式: 0x{new_style:X}")
            
        except Exception as e:
            print(f"[分屏] 设置TOOLWINDOW样式失败: {e}")
    
    def _restore_window_styles(self, hwnd: int, original_styles: tuple[int, bool]) -> None:
        """恢复窗口原始样式"""
        try:
            import win32gui
            import win32con
            import ctypes
            from ctypes import wintypes
            
            original_ex_style, original_shadow = original_styles
            
            # 恢复扩展样式
            win32gui.SetWindowLong(hwnd, win32con.GWL_EXSTYLE, original_ex_style)
            
            # 恢复DWM阴影状态
            dwmapi = ctypes.windll.dwmapi
            DWMWA_NCRENDERING_POLICY = 2
            DWMNCRP_ENABLED = 2
            
            if original_shadow:
                # 恢复阴影
                policy = ctypes.c_int(DWMNCRP_ENABLED)
            else:
                # 保持禁用（如果原本就是禁用的）
                policy = ctypes.c_int(1)  # DWMNCRP_DISABLED
            
            hr = dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(policy),
                ctypes.sizeof(policy)
            )
            
            # 刷新窗口
            win32gui.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                                win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | 
                                win32con.SWP_NOZORDER | win32con.SWP_FRAMECHANGED)
            
            print(f"[分屏] 已恢复窗口样式 - 扩展样式: 0x{original_ex_style:X}, DWM阴影: {original_shadow}")
            
        except Exception as e:
            print(f"[分屏] 恢复窗口样式失败: {e}")
    
    def _disable_dwm_shadow_only(self, hwnd: int) -> None:
        """只关闭窗口DWM投影阴影，不改变边框样式"""
        try:
            import ctypes
            from ctypes import wintypes
            
            # DWM相关常量 - 单独控制阴影
            DWMWA_NCRENDERING_POLICY = 2
            DWMWA_ALLOW_NCPAINT = 4
            DWMNCRP_ENABLED = 2
            
            # 加载dwmapi.dll
            dwmapi = ctypes.windll.dwmapi
            
            # 方法1：尝试禁用窗口边框
            hr1 = dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(ctypes.c_int(DWMNCRP_ENABLED)),
                ctypes.sizeof(ctypes.c_int)
            )
            
            # 方法2：尝试禁用非客户区绘制（这会关闭阴影但可能影响边框）
            allow_ncpaint = ctypes.c_int(0)  # 禁用非客户区绘制
            hr2 = dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_ALLOW_NCPAINT,
                ctypes.byref(allow_ncpaint),
                ctypes.sizeof(allow_ncpaint)
            )
            
            if hr1 == 0 and hr2 == 0:
                print("[分屏] 已尝试关闭DWM阴影（可能影响边框）")
            elif hr1 == 0:
                print("[分屏] 已设置DWM渲染策略，阴影状态未知")
            else:
                print(f"[分屏] 关闭DWM阴影失败，HRESULT1: 0x{hr1:X}, HRESULT2: 0x{hr2:X}")
                
        except Exception as e:
            print(f"[分屏] 关闭DWM阴影失败: {e}")
            # 如果专用方法失败，回退到原来的方法
            print("[分屏] 回退到标准DWM阴影关闭方法")
            self._disable_dwm_shadow(hwnd)
    
    def _disable_dwm_shadow(self, hwnd: int) -> None:
        """关闭窗口DWM投影阴影"""
        try:
            import ctypes
            from ctypes import wintypes
            
            # DWM相关常量
            DWMWA_NCRENDERING_POLICY = 2
            DWMNCRP_DISABLED = 1
            
            # 加载dwmapi.dll
            dwmapi = ctypes.windll.dwmapi
            
            # 设置DWM属性：禁用非客户区渲染
            hr = dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY,
                ctypes.byref(ctypes.c_int(DWMNCRP_DISABLED)),
                ctypes.sizeof(ctypes.c_int)
            )
            
            if hr == 0:  # S_OK
                print("[分屏] 已关闭DWM投影阴影")
            else:
                print(f"[分屏] 关闭DWM阴影失败，HRESULT: 0x{hr:X}")
                
        except Exception as e:
            print(f"[分屏] 关闭DWM阴影失败: {e}")
    
    def _get_dwm_extended_frame_bounds(self, hwnd: int) -> tuple[int, int, int, int] | None:
        """获取窗口的DWM真实扩展边界"""
        try:
            import ctypes
            from ctypes import wintypes
            
            # 定义RECT结构体
            class RECT(ctypes.Structure):
                _fields_ = [
                    ("left", ctypes.c_long),
                    ("top", ctypes.c_long),
                    ("right", ctypes.c_long),
                    ("bottom", ctypes.c_long)
                ]
            
            # DWM常量
            DWMWA_EXTENDED_FRAME_BOUNDS = 9
            
            # 加载dwmapi.dll
            dwmapi = ctypes.windll.dwmapi
            
            # 创建RECT结构体实例
            rect = RECT()
            
            # 获取扩展边界
            hr = dwmapi.DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                ctypes.byref(rect),
                ctypes.sizeof(rect)
            )
            
            if hr == 0:  # S_OK
                bounds = (rect.left, rect.top, rect.right, rect.bottom)
                print(f"[分屏] 窗口{hwnd} DWM边界: {bounds}")
                return bounds
            else:
                print(f"[分屏] 获取DWM边界失败，HRESULT: 0x{hr:X}")
                return None
                
        except Exception as e:
            print(f"[分屏] 获取DWM边界异常: {e}")
            return None
    
    def _calculate_dwm_compensation(self, assistant_bounds: tuple[int, int, int, int] | None, 
                                  browser_bounds: tuple[int, int, int, int] | None) -> tuple[int, int]:
        """计算DWM偏移补偿参数"""
        try:
            if not assistant_bounds or not browser_bounds:
                print("[分屏] DWM边界数据不完整，使用固定补偿")
                return 0, 4  # 固定：无左偏移，+4px宽度盖住边框溢出
            
            # 计算中间间隙（话术助手左边缘 - 浏览器右边缘）
            gap = assistant_bounds[0] - browser_bounds[2]
            
            # 重叠补偿：让浏览器宽度增加，盖住话术助手边框溢出部分
            overlap_compensation = max(4, gap + 1)  # 至少4px重叠，或根据间隙调整
            
            print(f"[分屏] DWM补偿计算 - 中间间隙: {gap}px, 重叠补偿: {overlap_compensation}px")
            
            return 0, overlap_compensation  # 无左偏移，只增加宽度
            
        except Exception as e:
            print(f"[分屏] 计算DWM补偿失败: {e}")
            return 0, 4  # 固定补偿：无左偏移，+4px宽度
    
    def _apply_final_layout(self, assistant_hwnd: int, browser_hwnd: int, 
                          left_offset: int, overlap_compensation: int) -> None:
        """应用最终窗口布局"""
        try:
            import win32gui
            import win32con
            import win32api
            
            # 获取当前工作区域
            monitor = win32api.MonitorFromWindow(assistant_hwnd)
            monitor_info = win32api.GetMonitorInfo(monitor)
            work_area = monitor_info['Work']
            
            left, top, right, bottom = work_area
            screen_width = right - left
            screen_height = bottom - top
            
            # 高度补偿
            height_compensation = 9
            adjusted_bottom = bottom + height_compensation
            
            # 计算最终位置
            # 浏览器：紧贴屏幕左边缘，宽度增加盖住边框溢出
            browser_left = left  # 紧贴屏幕左边缘，无偏移
            browser_width = screen_width - 382 + overlap_compensation  # 增加宽度盖住溢出
            browser_rect = (browser_left, top, browser_left + browser_width, adjusted_bottom)
            
            # 话术助手：固定382px宽，靠右
            assistant_left = right - 382
            assistant_rect = (assistant_left, top, right, adjusted_bottom)
            
            print(f"[分屏] 最终布局 - 浏览器: {browser_rect}, 话术助手: {assistant_rect}")
            
            # 设置浏览器位置
            self._set_window_position(browser_hwnd, browser_rect)
            
            # 延时50ms
            import time
            time.sleep(0.05)
            
            # 设置话术助手位置
            self._set_window_position(assistant_hwnd, assistant_rect)
            
            # 最终诊断
            browser_final = win32gui.GetWindowRect(browser_hwnd)
            assistant_final = win32gui.GetWindowRect(assistant_hwnd)
            final_gap = assistant_final[0] - browser_final[2]
            
            print(f"[分屏] 最终结果 - 浏览器: {browser_final}, 话术助手: {assistant_final}")
            print(f"[分屏] 最终间隙: {final_gap}px")
            
        except Exception as e:
            print(f"[分屏] 应用最终布局失败: {e}")
    
    def _set_window_position(self, hwnd: int, rect: tuple[int, int, int, int]) -> None:
        """设置窗口位置和大小"""
        try:
            import win32gui
            import win32con
            
            left, top, right, bottom = rect
            width = right - left
            height = bottom - top
            
            # 确保窗口可见（恢复状态）
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            
            # 设置窗口位置和大小，使用更严格的标志
            win32gui.SetWindowPos(
                hwnd,
                win32con.HWND_TOP,
                left, top, width, height,
                win32con.SWP_SHOWWINDOW | win32con.SWP_NOACTIVATE | win32con.SWP_NOZORDER | win32con.SWP_FRAMECHANGED
            )
            
            # 强制重绘窗口
            win32gui.SetWindowPos(hwnd, None, 0, 0, 0, 0, 
                                win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_NOZORDER | 
                                win32con.SWP_NOOWNERZORDER | win32con.SWP_FRAMECHANGED)
            
            print(f"[分屏] 窗口位置已设置: {left},{top} {width}x{height}")
            
        except Exception as e:
            print(f"[分屏] 设置窗口位置失败: {e}")
    
    def _launch_browser_fallback(self, url: str) -> bool:
        """备用浏览器启动方法（不使用分屏）"""
        try:
            import os
            os.startfile(url)
            print("[分屏] 使用备用方法启动浏览器")
            return True
        except Exception as e:
            print(f"[分屏] 备用启动方法失败: {e}")
            return False

    # ---------------- 备份功能 ----------------
    def start_second_backup(self, backup_path: str, max_backups: int = 10) -> bool:
        """启动第二数据库备份（轮转备份模式）"""
        try:
            from pathlib import Path
            import threading
            import time

            # 验证备份路径
            backup_dir = Path(backup_path)
            if not backup_dir.exists():
                print(f"[备份] ⚠️ 备份目录不存在: {backup_path}")
                return False

            # 获取源数据目录
            source_dir = Path.cwd() / "data"
            if not source_dir.exists():
                print(f"[备份] ⚠️ 源数据目录不存在: {source_dir}")
                return False

            # 停止现有备份
            self.stop_second_backup()

            # 保存配置
            self._max_backups = max(1, min(50, max_backups))  # 限制在 1-50 之间

            # 创建备份线程
            self._backup_thread = threading.Thread(
                target=self._backup_worker,
                args=(str(source_dir), str(backup_dir)),
                daemon=True
            )
            self._backup_running = True
            self._backup_thread.start()

            print(f"[备份] ✅ 已启动轮转备份: {source_dir} -> {backup_dir}")
            print(f"[备份] 📅 检测间隔: 60秒 | 📦 最大备份数: {self._max_backups}")
            return True

        except Exception as e:
            print(f"[备份] ❌ 启动备份失败: {e}")
            return False
    
    def stop_second_backup(self) -> bool:
        """停止第二数据库备份"""
        try:
            if hasattr(self, '_backup_running') and self._backup_running:
                self._backup_running = False
                if hasattr(self, '_backup_thread') and self._backup_thread.is_alive():
                    self._backup_thread.join(timeout=5)
                print("[备份] 已停止备份同步")
                return True
            return False
        except Exception as e:
            print(f"[备份] 停止备份失败: {e}")
            return False
    
    def _backup_worker(self, source_path: str, backup_path: str) -> None:
        """备份工作线程（轮转备份模式 - 脏标记机制）"""
        try:
            from pathlib import Path
            import time

            source_dir = Path(source_path)
            backup_root = Path(backup_path)
            max_backups = getattr(self, '_max_backups', 10)

            # 确保备份根目录存在
            backup_root.mkdir(parents=True, exist_ok=True)

            # 脏标记文件路径
            dirty_marker = source_dir / "phrases" / ".backup_dirty"

            print(f"[备份] 🔄 轮转备份模式启动（脏标记机制）")
            print(f"[备份] 📂 源目录: {source_dir}")
            print(f"[备份] 📂 备份根目录: {backup_root}")
            print(f"[备份] 📦 最大备份数: {max_backups}")

            # 启动时检查是否有未处理的脏标记
            if dirty_marker.exists():
                print(f"[备份] 🚀 发现未处理的脏标记，执行首次备份...")
                # 先清除脏标记，避免备份过程中新写入的脏标记被误清
                self._clear_dirty_marker(dirty_marker)
                self._create_rotating_backup(source_dir, backup_root, max_backups)
                # 备份完成后检查是否有新编辑（脏标记被重新设置）
                if dirty_marker.exists():
                    print(f"[备份] 📝 备份期间检测到新编辑，追加一次备份...")
                    self._clear_dirty_marker(dirty_marker)
                    self._create_rotating_backup(source_dir, backup_root, max_backups)

            while getattr(self, '_backup_running', False):
                try:
                    # 每30秒检查一次脏标记
                    for _ in range(30):
                        if not getattr(self, '_backup_running', False):
                            break
                        time.sleep(1)

                    if not getattr(self, '_backup_running', False):
                        break

                    # 检测脏标记（话术实际变化时由前端设置）
                    if dirty_marker.exists():
                        print(f"[备份] 📝 检测到话术变化标记，创建新备份...")
                        # 先清除脏标记，避免备份过程中新写入的脏标记被误清
                        self._clear_dirty_marker(dirty_marker)
                        self._create_rotating_backup(source_dir, backup_root, max_backups)
                        # 备份完成后检查是否有新编辑（脏标记被重新设置）
                        if dirty_marker.exists():
                            print(f"[备份] 📝 备份期间检测到新编辑，追加一次备份...")
                            self._clear_dirty_marker(dirty_marker)
                            self._create_rotating_backup(source_dir, backup_root, max_backups)

                except Exception as e:
                    print(f"[备份] 同步过程中出错: {e}")
                    time.sleep(5)  # 出错后等待5秒再重试

        except Exception as e:
            print(f"[备份] 备份线程异常: {e}")

    def _set_dirty_marker(self, source_dir: Path) -> None:
        """设置脏标记（由前端调用）"""
        try:
            dirty_marker = source_dir / "phrases" / ".backup_dirty"
            dirty_marker.parent.mkdir(parents=True, exist_ok=True)
            dirty_marker.write_text("dirty", encoding="utf-8")
            print(f"[备份] ✅ 已设置脏标记")
        except Exception as e:
            print(f"[备份] ⚠️ 设置脏标记失败: {e}")

    def _clear_dirty_marker(self, dirty_marker: Path) -> None:
        """清除脏标记"""
        try:
            if dirty_marker.exists():
                dirty_marker.unlink()
        except Exception as e:
            print(f"[备份] ⚠️ 清除脏标记失败: {e}")

    # ---------------- Profile 映射持久化 ----------------

    def _save_profile_map(self) -> None:
        """保存 Profile 映射到文件"""
        try:
            import json
            # 只保存有效的映射
            valid_map = {k: v for k, v in self._profile_hwnd_map.items() if v}
            self._profile_map_file.write_text(json.dumps(valid_map, indent=2), encoding="utf-8")
            print(f"[映射] 💾 已保存映射: {valid_map}")
        except Exception as e:
            print(f"[映射] ⚠️ 保存映射失败: {e}")

    def _load_profile_map(self) -> None:
        """从文件加载 Profile 映射"""
        try:
            import json
            if self._profile_map_file.exists():
                data = json.loads(self._profile_map_file.read_text(encoding="utf-8"))
                self._profile_hwnd_map = {k: v for k, v in data.items() if v}
                print(f"[映射] 📂 已加载映射: {self._profile_hwnd_map}")
            else:
                print(f"[映射] 📂 映射文件不存在，使用空映射")
        except Exception as e:
            print(f"[映射] ⚠️ 加载映射失败: {e}")
            self._profile_hwnd_map = {}

    def _validate_profile_map(self) -> None:
        """验证映射中的窗口是否还存在，删除失效的映射"""
        try:
            import ctypes
            user32 = ctypes.windll.user32

            invalid_keys = []
            for profile, hwnd in self._profile_hwnd_map.items():
                if not user32.IsWindow(hwnd):
                    invalid_keys.append(profile)
                    print(f"[映射] ❌ 窗口已失效: {profile} -> hwnd={hwnd}")

            for key in invalid_keys:
                del self._profile_hwnd_map[key]

            if invalid_keys:
                self._save_profile_map()
                print(f"[映射] 🧹 已清理 {len(invalid_keys)} 个失效映射")
            else:
                print(f"[映射] ✅ 所有映射有效")

        except Exception as e:
            print(f"[映射] ⚠️ 验证映射失败: {e}")

    def _scan_existing_chrome_windows(self) -> None:
        """启动时扫描现有 Chrome 窗口，通过标题提取 Profile 信息建立映射"""
        try:
            import ctypes
            from ctypes import wintypes
            import re

            user32 = ctypes.windll.user32

            WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            found = []

            def enum_proc(hwnd, lparam):
                # 检查窗口类名
                class_name = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, class_name, 256)
                if class_name.value != 'Chrome_WidgetWin_1':
                    return True

                # 检查窗口可见或最小化
                is_visible = user32.IsWindowVisible(hwnd)
                is_minimized = user32.IsIconic(hwnd)
                if not is_visible and not is_minimized:
                    return True

                # 检查进程名
                proc_name = self._get_window_process_name(hwnd)
                if proc_name != 'chrome.exe':
                    return True

                # 获取窗口标题
                title = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, title, 512)
                if title.value:
                    found.append((hwnd, title.value))

                return True

            callback = WNDENUMPROC(enum_proc)
            user32.EnumWindows(callback, 0)

            print(f"[映射] 🔍 扫描到 {len(found)} 个 Chrome 窗口")

            # 通过进程命令行提取 Profile 信息
            for hwnd, title in found:
                cmd_line = self._get_window_cmdline(hwnd)
                if cmd_line:
                    # 提取 Profile 信息
                    profile = self._extract_profile_from_args(cmd_line)
                    if profile:
                        # 只覆盖不存在的映射
                        if profile not in self._profile_hwnd_map:
                            self._profile_hwnd_map[profile] = hwnd
                            print(f"[映射] 📝 从命令行提取: {profile} -> hwnd={hwnd}, title='{title}'")
                    else:
                        # 没有 Profile 参数，可能是默认 Profile
                        if 'Default' not in self._profile_hwnd_map:
                            self._profile_hwnd_map['Default'] = hwnd
                            print(f"[映射] 📝 默认 Profile -> hwnd={hwnd}, title='{title}'")

            # 保存映射
            if self._profile_hwnd_map:
                self._save_profile_map()

        except Exception as e:
            print(f"[映射] ⚠️ 扫描 Chrome 窗口失败: {e}")

    def _get_window_cmdline(self, hwnd: int) -> str:
        """获取窗口对应的进程命令行"""
        try:
            import win32process

            _, pid = win32process.GetWindowThreadProcessId(hwnd)

            try:
                import psutil
                proc = psutil.Process(pid)
                return ' '.join(proc.cmdline())
            except:
                pass

            return ""
        except:
            return ""

    def _create_rotating_backup(self, source_dir: Path, backup_root: Path, max_backups: int) -> None:
        """创建新的轮转备份"""
        try:
            from datetime import datetime
            import shutil
            import random

            # 生成时间戳文件夹名（含毫秒 + 随机后缀，避免同秒碰撞）
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            rand_suffix = random.randint(1000, 9999)
            backup_name = f"backup_{timestamp}_{rand_suffix}"
            backup_dir = backup_root / backup_name

            # 创建新备份文件夹（如果极端情况下仍碰撞，加随机后缀重试）
            try:
                backup_dir.mkdir(parents=True, exist_ok=True)
            except FileExistsError:
                backup_name = f"backup_{timestamp}_{rand_suffix}_{random.randint(1000,9999)}"
                backup_dir = backup_root / backup_name
                backup_dir.mkdir(parents=True, exist_ok=True)
            data_dir = backup_dir / "data"

            print(f"[备份] 📦 创建新备份: {backup_name}")

            # 同步整个 data 目录到新文件夹
            self._sync_directory(source_dir, data_dir)

            print(f"[备份] ✅ 备份完成: {backup_name}")

            # 轮转删除旧备份
            self._rotate_backups(backup_root, max_backups)

        except Exception as e:
            print(f"[备份] ❌ 创建轮转备份失败: {e}")

    def _rotate_backups(self, backup_root: Path, max_count: int) -> None:
        """轮转备份，保留最近 max_count 个"""
        try:
            # 列出所有 backup_* 文件夹
            backup_dirs = []
            for item in backup_root.iterdir():
                if item.is_dir() and item.name.startswith("backup_"):
                    backup_dirs.append(item)

            # 按名称排序（时间戳格式保证正确排序）
            backup_dirs.sort(key=lambda x: x.name, reverse=True)

            # 删除超过 max_count 的旧备份
            if len(backup_dirs) > max_count:
                old_backups = backup_dirs[max_count:]
                for old_backup in old_backups:
                    try:
                        shutil.rmtree(old_backup)
                        print(f"[备份] 🗑️ 已删除旧备份: {old_backup.name}")
                    except Exception as e:
                        print(f"[备份] ⚠️ 删除旧备份失败 {old_backup.name}: {e}")

                # 提示当前备份数量
                remaining = len(backup_dirs) - len(old_backups)
                print(f"[备份] 📊 当前备份数量: {remaining}/{max_count}")

        except Exception as e:
            print(f"[备份] ⚠️ 轮转备份失败: {e}")

    def _check_database_health(self, db_dir: Path) -> tuple[bool, str]:
        """
        检查数据库目录健康状态
        返回: (是否健康, 错误信息)
        """
        try:
            # 1. 检查目录是否存在
            if not db_dir.exists():
                return False, "数据库目录不存在"
            
            # 2. 检查IndexedDB的LOCK文件
            indexeddb_dir = db_dir / "webengine_profile" / "IndexedDB" / "file__0.indexeddb.leveldb"
            if indexeddb_dir.exists():
                lock_file = indexeddb_dir / "LOCK"
                if lock_file.exists():
                    # LOCK文件存在，检查是否为空（正常情况下应该是空文件）
                    try:
                        if lock_file.stat().st_size > 0:
                            # LOCK文件非空，可能表示数据库被锁定
                            return False, "数据库LOCK文件异常（非空）"
                    except:
                        return False, "无法读取LOCK文件"
            
            # 3. 检查关键文件是否存在
            if indexeddb_dir.exists():
                # 检查 CURRENT 文件
                if not (indexeddb_dir / "CURRENT").exists():
                    return False, "缺少关键文件: CURRENT"
                
                # 检查 MANIFEST 文件（可能是 MANIFEST-000001 这样的格式）
                manifest_files = list(indexeddb_dir.glob("MANIFEST*"))
                if not manifest_files:
                    return False, "缺少关键文件: MANIFEST"
            
            # 4. 检查文件完整性（简单检查：文件大小是否合理）
            if indexeddb_dir.exists():
                for item in indexeddb_dir.iterdir():
                    if item.is_file():
                        # 检查文件大小是否异常（例如：0字节的ldb文件）
                        if item.suffix == '.ldb' and item.stat().st_size == 0:
                            return False, f"数据库文件异常: {item.name} 大小为0"
            
            return True, ""
            
        except Exception as e:
            return False, f"健康检查异常: {e}"
    
    # === 备份优化：排除无关文件/目录 ===
    # 这些是浏览器缓存和临时文件，不影响话术功能
    _SKIP_DIRS = {
        'DawnGraphiteCache',    # GPU 渲染缓存
        'DawnWebGPUCache',      # GPU 渲染缓存
        'GPUCache',             # GPU 缓存
        'Session Storage',      # 会话存储（重启就没了）
        'Shared Dictionary',    # 压缩字典
        'blob_storage',         # 二进制对象（除非话术有图片，否则可排除）
    }

    _SKIP_FILES = {
        'LOCK',                 # 数据库锁定文件
        '.backup_dirty',        # 脏标记文件
        'History',              # 浏览历史
        'History-journal',      # 浏览历史日志
        'Favicons',             # 网站图标
        'Favicons-journal',     # 网站图标日志
        'Network Persistent State',  # 网络状态
        'SharedStorage',        # 共享存储
        'SharedStorage-wal',    # 共享存储日志
        'Trust Tokens',         # 信任令牌
        'Trust Tokens-journal', # 信任令牌日志
        'Visited Links',        # 访问记录
        'QuotaManager',         # 配额管理
        'QuotaManager-journal', # 配额管理日志
    }

    def _sync_directory(self, source_dir: Path, backup_dir: Path) -> None:
        """同步目录内容（单向，排除无关缓存文件）"""
        try:
            import shutil

            # 确保备份目录存在
            backup_dir.mkdir(parents=True, exist_ok=True)

            # === 安全规则：同步前检查主数据库健康状态 ===
            # 如果是同步webengine_profile目录，先检查健康状态
            if source_dir.name == "webengine_profile":
                is_healthy, error_msg = self._check_database_health(source_dir.parent)
                if not is_healthy:
                    print(f"[备份] ⚠️ 主数据库异常，禁止同步: {error_msg}")
                    print(f"[备份] 🛡️ 保护备份库不被损坏的主库污染")
                    # 跳过本次同步，不覆盖备份
                    return

            # 同步文件和文件夹
            for item in source_dir.iterdir():
                if not getattr(self, '_backup_running', False):
                    break

                source_item = source_dir / item.name
                backup_item = backup_dir / item.name

                # === 跳过无关目录 ===
                if source_item.is_dir() and item.name in self._SKIP_DIRS:
                    continue

                if source_item.is_file():
                    # 同步文件
                    try:
                        # === 跳过无关文件 ===
                        if item.name in self._SKIP_FILES:
                            continue

                        # 检查文件是否需要更新
                        if (not backup_item.exists() or
                            source_item.stat().st_mtime > backup_item.stat().st_mtime or
                            source_item.stat().st_size != backup_item.stat().st_size):

                            shutil.copy2(source_item, backup_item)
                            print(f"[备份] 已同步文件: {source_item.name}")

                    except Exception as e:
                        print(f"[备份] 同步文件失败 {source_item.name}: {e}")

                elif source_item.is_dir():
                    # 递归同步子目录
                    self._sync_directory(source_item, backup_item)

        except Exception as e:
            print(f"[备份] 同步目录失败: {e}")

    # ---------------- Helpers ----------------
    def get_last_export_directory(self) -> str:
        return str(Path(self.last_export_directory) if self.last_export_directory else self.config_dir)
    
    def save_last_export_directory(self, directory: str) -> None:
        """保存上次导出目录"""
        try:
            self.last_export_directory = directory
            self.app_settings.setValue("export/last_directory", directory)
            self.app_settings.sync()
            print(f"[导出] 已保存导出目录: {directory}")
        except Exception as e:
            print(f"[导出] 保存导出目录失败: {e}")

    def _refresh_page(self) -> None:
        self.browser.reload()

    def open_text_editor(self, category_id: str, category_name: str) -> None:
        """打开文本编辑器窗口（支持同时打开多个）"""
        try:
            # 如果该分类的编辑器已经打开，则激活它
            if category_id in self.text_editor_dialogs:
                existing_dialog = self.text_editor_dialogs[category_id]
                if existing_dialog and not existing_dialog._is_closing:
                    existing_dialog.show()
                    existing_dialog.raise_()
                    existing_dialog.activateWindow()
                    print(f"[文本编辑器] 激活已存在的编辑器: {category_name}")
                    return
                else:
                    # 窗口已关闭，清理引用
                    del self.text_editor_dialogs[category_id]
            
            # 创建新窗口
            dialog = TextEditorDialog(self, category_id, category_name)
            self.text_editor_dialogs[category_id] = dialog
            
            # 监听窗口关闭事件，自动清理字典
            def on_dialog_destroyed():
                if category_id in self.text_editor_dialogs:
                    del self.text_editor_dialogs[category_id]
                    print(f"[文本编辑器] 已清理编辑器引用: {category_name}")
            
            dialog.destroyed.connect(on_dialog_destroyed)
            dialog.show()
            dialog.raise_()
            dialog.activateWindow()
            print(f"[文本编辑器] 打开新编辑器: {category_name}")
        except Exception as e:
            print(f"打开文本编辑器时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开文本编辑器：\n{e}")

    def open_announcement_dialog(self) -> None:
        """打开公告解读对话框"""
        try:
            # 如果公告解读对话框已经打开，则激活它
            if hasattr(self, 'announcement_dialog') and self.announcement_dialog and not self.announcement_dialog._is_closing:
                self.announcement_dialog.show()
                self.announcement_dialog.raise_()
                self.announcement_dialog.activateWindow()
                print("[公告解读] 激活已存在的对话框")
                return
            else:
                # 清理已关闭的引用
                if hasattr(self, 'announcement_dialog'):
                    self.announcement_dialog = None

            # 创建新对话框
            dialog = AnnouncementDialog(self)
            self.announcement_dialog = dialog

            def on_dialog_destroyed():
                self.announcement_dialog = None
                print("[公告解读] 已清理对话框引用")

            dialog.destroyed.connect(on_dialog_destroyed)
            dialog.show()
            dialog.raise_()
            dialog.activateWindow()
            print("[公告解读] 打开新对话框")
        except Exception as e:
            print(f"打开公告解读对话框时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开公告解读对话框：\n{e}")

    def open_placeholder_dialog(self, content: str, placeholders_json: str) -> None:
        """打开占位符补全对话框"""
        try:
            import json
            placeholders = json.loads(placeholders_json)
            
            # 创建新窗口
            dialog = PlaceholderDialog(self, content, placeholders)
            self.placeholder_dialogs.append(dialog)
            
            # 监听窗口关闭事件，自动清理列表
            def on_dialog_destroyed():
                if dialog in self.placeholder_dialogs:
                    self.placeholder_dialogs.remove(dialog)
                    print(f"[占位符对话框] 已清理对话框引用")
            
            dialog.destroyed.connect(on_dialog_destroyed)
            dialog.show()
            dialog.raise_()
            dialog.activateWindow()
            print(f"[占位符对话框] 打开新对话框")
        except Exception as e:
            print(f"打开占位符对话框时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开占位符对话框：\n{e}")

    def open_calculator(self) -> None:
        """打开计算器窗口（底部工具栏使用，使用calculator-dialog.html）"""
        try:
            # 如果计算器已经打开，则激活它
            if self.calculator_dialog_web and not self.calculator_dialog_web._is_closing:
                self.calculator_dialog_web.raise_()
                self.calculator_dialog_web.activateWindow()
                print("[计算器] 激活现有窗口（HTML版本）")
                return

            # 创建新窗口
            self.calculator_dialog_web = CalculatorDialogWeb(self)
            self.calculator_dialog_web.show()

            # 初始打开时相对主窗口水平居中
            self._center_calculator_on_parent()

            self.calculator_dialog_web.raise_()
            self.calculator_dialog_web.activateWindow()
            print("[计算器] 打开新窗口（HTML版本）")
        except Exception as e:
            print(f"打开计算器时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开计算器：\n{e}")

    def _center_calculator_on_parent(self) -> None:
        """将计算器窗口相对主窗口水平居中"""
        try:
            if not self.calculator_dialog_web:
                return
            calc = self.calculator_dialog_web
            # 主窗口几何区域
            parent_rect = self.frameGeometry()
            # 计算器窗口大小
            calc_width = calc.width()
            calc_height = calc.height()
            # 计算居中坐标
            x = parent_rect.x() + (parent_rect.width() - calc_width) // 2
            y = parent_rect.y() + (parent_rect.height() - calc_height) // 2
            # 确保不超出屏幕可见区域
            from PyQt6.QtWidgets import QApplication
            screen = QApplication.primaryScreen()
            if screen:
                screen_rect = screen.availableGeometry()
                x = max(screen_rect.left(), min(x, screen_rect.right() - calc_width))
                y = max(screen_rect.top(), min(y, screen_rect.bottom() - calc_height))
            calc.move(x, y)
        except Exception as e:
            print(f"[计算器] 居中定位失败: {e}")

    def open_calculator_for_input(self, input_id: str) -> None:
        """为指定输入框打开计算器窗口"""
        try:
            print(f"[计算器] open_calculator_for_input 被调用，input_id: {input_id}")
            print(f"[计算器] 当前 calculator_dialog 状态: {self.calculator_dialog}")
            
            # 如果计算器已经打开，则关闭它并重新创建
            if self.calculator_dialog and not self.calculator_dialog._is_closing:
                print(f"[计算器] 计算器已打开，先关闭它")
                self.calculator_dialog.close()
                self.calculator_dialog = None
            
            # 创建新窗口
            print(f"[计算器] 创建新的计算器窗口")
            self.calculator_dialog = CalculatorDialog(self)
            self.calculator_dialog.target_input_id = input_id
            
            # 设置回填回调
            def fill_callback(result: str) -> None:
                """回填计算结果到输入框"""
                print(f"[计算器] 回填结果: {result} 到输入框: {input_id}")

                # 通过 JavaScript 回填到输入框（优先使用全局变量，备用 getElementById）
                # 对 contentEditable：插入到光标位置（保留已有文字）
                # 对普通 input：直接替换值
                js_code = f"""
                (function(result) {{
                    try {{
                        const input = window._currentCalculatorInput || document.getElementById('{input_id}');
                        if (input) {{
                            if (input.contentEditable === 'true') {{
                                // 恢复保存的光标位置，在光标处插入文字
                                input.focus();
                                const sel = window.getSelection();
                                sel.removeAllRanges();
                                if (input._savedRange) {{
                                    sel.addRange(input._savedRange);
                                    input._savedRange = null;
                                }} else {{
                                    // 没有保存的范围，放到末尾
                                    const r = document.createRange();
                                    r.selectNodeContents(input);
                                    r.collapse(false);
                                    sel.addRange(r);
                                }}
                                // 删除选区内容（如果有选中的文字）
                                sel.deleteFromDocument();
                                // 在光标位置插入文字
                                const textNode = document.createTextNode(result);
                                sel.getRangeAt(0).insertNode(textNode);
                                // 移动光标到插入文字之后
                                sel.collapseToEnd();
                                input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            }} else {{
                                input.value = result;
                                input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            }}
                            delete input.dataset.openingCalculator;
                            window._currentCalculatorInput = null;
                            console.log('[LOG] 计算器结果已回填:', result);
                            setTimeout(() => {{
                                input.blur();
                            }}, 50);
                        }} else {{
                            console.error('[LOG] 找不到输入框:', '{input_id}');
                        }}
                    }} catch (e) {{
                        console.error('[LOG] 回填失败:', e);
                    }}
                }})('{result}');
                """
                
                if self.browser and self.browser.page():
                    self.browser.page().runJavaScript(js_code)
                
                # 自动关闭计算器窗口
                if self.calculator_dialog:
                    self.calculator_dialog.close()
            
            self.calculator_dialog.calculator.fill_callback = fill_callback
            self.calculator_dialog.show()
            self.calculator_dialog.raise_()
            self.calculator_dialog.activateWindow()
            print(f"[计算器] 为输入框 {input_id} 打开新窗口")
        except Exception as e:
            print(f"打开计算器时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开计算器：\n{e}")

    def open_window(self, url: str, title: str, width: int, height: int) -> None:
        """打开通用新窗口"""
        try:
            print(f"[新窗口] 收到请求 - URL: {url}, 标题: {title}, 尺寸: {width}x{height}")
            
            # 解析URL（可能包含查询参数）
            url_parts = url.split('?')
            file_name = url_parts[0]
            query_string = url_parts[1] if len(url_parts) > 1 else ''
            
            # 创建一个简单的对话框窗口
            dialog = QDialog(self)
            dialog.setWindowTitle(title)
            dialog.setContentsMargins(0, 0, 0, 0)
            
            # 恢复窗口大小和位置（使用文件名作为键）
            def restore_window_geometry():
                try:
                    config_dir = get_app_data_dir() / "desktop"
                    config_dir.mkdir(parents=True, exist_ok=True)
                    config_file = config_dir / "variant_dialog_window.ini"
                    settings = QSettings(str(config_file), QSettings.Format.IniFormat)
                    
                    # 使用文件名作为键
                    key = f"{file_name}/geometry"
                    geometry = settings.value(key)
                    if geometry and isinstance(geometry, (bytes, QByteArray)):
                        if isinstance(geometry, bytes):
                            geometry = QByteArray(geometry)
                        dialog.restoreGeometry(geometry)
                        print(f"[新窗口] 已恢复窗口大小和位置: {file_name}")
                    else:
                        # 默认大小
                        dialog.resize(width, height)
                        print(f"[新窗口] 使用默认窗口大小: {file_name}")
                except Exception as e:
                    print(f"[新窗口] 恢复窗口大小失败: {e}")
            dialog.resize(width, height)
            
            # 保存窗口大小和位置
            def save_window_geometry():
                try:
                    config_dir = get_app_data_dir() / "desktop"
                    config_dir.mkdir(parents=True, exist_ok=True)
                    config_file = config_dir / "variant_dialog_window.ini"
                    settings = QSettings(str(config_file), QSettings.Format.IniFormat)
                    
                    # 使用文件名作为键
                    key = f"{file_name}/geometry"
                    settings.setValue(key, dialog.saveGeometry())
                    settings.sync()
                    print(f"[新窗口] 已保存窗口大小和位置: {file_name}")
                except Exception as e:
                    print(f"[新窗口] 保存窗口大小失败: {e}")
            
            # 定时保存窗口状态（每60秒保存一次）
            auto_save_timer = QTimer(dialog)
            auto_save_timer.timeout.connect(save_window_geometry)
            auto_save_timer.start(60000)  # 每60秒保存一次
            
            # 重写关闭事件以保存窗口状态
            original_close_event = dialog.closeEvent
            def close_event_wrapper(event):
                # 停止定时器
                try:
                    auto_save_timer.stop()
                except Exception:
                    pass
                # 保存窗口状态
                save_window_geometry()
                if original_close_event:
                    original_close_event(event)
                else:
                    event.accept()
            
            dialog.closeEvent = close_event_wrapper
            
            # 恢复窗口大小和位置
            restore_window_geometry()
            
            # 定时保存窗口状态（每60秒保存一次）
            auto_save_timer = QTimer(dialog)
            auto_save_timer.timeout.connect(save_window_geometry)
            auto_save_timer.start(60000)  # 每60秒保存一次
            
            # 设置样式，确保无额外间距
            dialog.setStyleSheet(
                "QDialog { background: #f5f5f5; border: 0px; }"
                "QWebEngineView { border: 0px; background: transparent; }"
            )
            
            # 创建布局
            layout = QVBoxLayout(dialog)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(0)
            
            # 创建WebEngineView
            web_view = QWebEngineView(dialog)
            web_view.setContentsMargins(0, 0, 0, 0)
            layout.addWidget(web_view)
            
            # 使用主窗口的 profile 以确保共享 localStorage 和 Python Bridge
            try:
                if self.profile:
                    page = NoContextMenuWebEnginePage(self.profile, web_view)
                    web_view.setPage(page)
                else:
                    page = NoContextMenuWebEnginePage(web_view)
                    web_view.setPage(page)
            except Exception as e:
                print(f"警告：无法使用主窗口 profile: {e}")
                page = NoContextMenuWebEnginePage(web_view)
                web_view.setPage(page)
            
            web_view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
            
            # 注入 WebChannel 加载器脚本
            loader = QWebEngineScript()
            loader.setName("WindowQtWebChannelLoader")
            loader.setSourceCode(
                """
                (function(){
                    function ensureQWebChannel(retry){
                        if (typeof QWebChannel === 'undefined'){
                            if (!document.head) {
                                if (retry > 0) {
                                    setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                                }
                                return;
                            }
                            try {
                                var s = document.createElement('script');
                                s.src = 'qrc:///qtwebchannel/qwebchannel.js';
                                s.onload = function(){ /* loaded */ };
                                s.onerror = function(){ /* error */ };
                                document.head.appendChild(s);
                            } catch (error) {
                                console.error('[LOG] 无法加载 QWebChannel:', error);
                            }
                            if (retry > 0) setTimeout(function(){ ensureQWebChannel(retry-1); }, 50);
                            return;
                        }
                    }
                    ensureQWebChannel(40);
                })();
                """
            )
            loader.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            loader.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            loader.setRunsOnSubFrames(False)
            page.scripts().insert(loader)
            
            # 注入桥接初始化脚本
            bridge_script = QWebEngineScript()
            bridge_script.setName("WindowBridgeSetup")
            bridge_script.setSourceCode(
                """
                (function() {
                    function setup(retry) {
                        if (typeof qt === 'undefined' || typeof QWebChannel === 'undefined') {
                            if (retry > 0) return setTimeout(function(){ setup(retry - 1); }, 50);
                            return;
                        }
                        new QWebChannel(qt.webChannelTransport, function(channel) {
                            window.pythonBridge = channel.objects.pythonBridge;
                            console.log('[LOG] 新窗口 Python 桥接对象已注入');
                        });
                    }
                    if (typeof window.pythonBridge === 'undefined') {
                        setup(80);
                    }
                })();
                """
            )
            bridge_script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
            bridge_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
            bridge_script.setRunsOnSubFrames(False)
            page.scripts().insert(bridge_script)
            
            # 注入 Python Bridge（复用主窗口的 bridge）
            def setup_bridge():
                try:
                    if self.python_bridge:
                        # 创建新的 WebChannel 用于这个窗口
                        web_channel = QWebChannel(page)
                        web_channel.registerObject("pythonBridge", self.python_bridge)
                        page.setWebChannel(web_channel)
                        print(f"[新窗口] Python Bridge 已注入: {title}")
                except Exception as e:
                    print(f"[新窗口] 注入 Python Bridge 失败: {e}")
            
            # 在页面加载完成后注入 Bridge
            def on_load_finished(success: bool):
                if success:
                    setup_bridge()
            
            page.loadFinished.connect(on_load_finished)
            
            # 加载URL
            html_path = (Path(__file__).resolve().parent / file_name).absolute()
            print(f"[新窗口] 文件路径: {html_path}")
            
            if html_path.exists():
                web_url = QUrl.fromLocalFile(str(html_path))
                if query_string:
                    web_url.setQuery(query_string)
                    print(f"[新窗口] 查询参数: {query_string}")
                web_view.setUrl(web_url)
                print(f"[新窗口] 加载页面成功: {html_path}")
            else:
                print(f"[新窗口] ❌ 文件不存在: {html_path}")
                QMessageBox.warning(self, "错误", f"文件不存在：\n{html_path}")
                return
            
            dialog.show()
            dialog.raise_()
            dialog.activateWindow()
            print(f"[新窗口] ✅ 窗口已显示: {title}")
        except Exception as e:
            print(f"[新窗口] ❌ 打开新窗口时出错: {e}")
            import traceback
            traceback.print_exc()
            QMessageBox.warning(self, "错误", f"无法打开窗口：\n{e}")

    def _close_all_text_editor_windows(self) -> None:
        """关闭所有文本编辑器窗口"""
        if not self.text_editor_dialogs:
            return
        
        dialogs_to_close = list(self.text_editor_dialogs.values())
        for dialog in dialogs_to_close:
            try:
                if dialog and not dialog._is_closing:
                    dialog.close()
                    try:
                        dialog.deleteLater()
                    except Exception:
                        pass
            except Exception as e:
                print(f"[优化] 关闭文本编辑器窗口时出错: {e}")
        
        self.text_editor_dialogs.clear()

    def _close_all_placeholder_dialogs(self) -> None:
        """关闭所有占位符对话框"""
        if not self.placeholder_dialogs:
            return
        
        dialogs_to_close = list(self.placeholder_dialogs)
        for dialog in dialogs_to_close:
            try:
                if dialog and not dialog._is_closing:
                    dialog.close()
                    try:
                        dialog.deleteLater()
                    except Exception:
                        pass
            except Exception as e:
                print(f"[优化] 关闭占位符对话框时出错: {e}")
        
        self.placeholder_dialogs.clear()

    def _cleanup_webengine_resources(self) -> None:
        """在主窗口关闭时安全卸载 WebEngine 组件，防止残留进程占用"""
        try:
            # 停止内存清理定时器
            timer = getattr(self, "memory_cleanup_timer", None)
            if timer is not None:
                try:
                    timer.stop()
                    timer.deleteLater()
                except Exception:
                    pass
                self.memory_cleanup_timer = None
            
            # 停止其他定时器
            timer = getattr(self, "_auto_save_timer", None)
            if timer is not None:
                try:
                    timer.stop()
                finally:
                    timer.deleteLater()
                self._auto_save_timer = None
        except Exception:
            pass

        browser = getattr(self, "browser", None)
        page = browser.page() if browser else None

        if page is not None:
            try:
                page.loadFinished.disconnect(self._on_load_finished)
            except (TypeError, RuntimeError):
                pass
            try:
                page.setWebChannel(None)
            except Exception:
                pass

        if self.web_channel is not None:
            try:
                self.web_channel.deleteLater()
            except Exception:
                pass
            finally:
                self.web_channel = None

        if self.python_bridge is not None:
            try:
                self.python_bridge.deleteLater()
            except Exception:
                pass
            finally:
                self.python_bridge = None

        if browser is not None:
            try:
                browser.stop()
            except Exception:
                pass
            try:
                if self.centralWidget() is browser:
                    widget = self.takeCentralWidget()
                    if widget is not None:
                        widget.deleteLater()
                else:
                    browser.deleteLater()
            except Exception:
                pass
            finally:
                self.browser = None

        if self.profile is not None:
            try:
                self.profile.scripts().clear()
            except Exception:
                pass
            try:
                self.profile.deleteLater()
            except Exception:
                pass
            finally:
                self.profile = None

    def closeEvent(self, event) -> None:
        # 🆕 关闭确认拦截
        close_confirm_file = self.config_dir / "close_confirm.json"
        skip_confirm = getattr(self, '_force_quit', False)
        if not skip_confirm:
            try:
                if close_confirm_file.exists():
                    skip_confirm = json.loads(close_confirm_file.read_text(encoding='utf-8')).get('skip', False)
            except Exception:
                skip_confirm = False
        if not skip_confirm:
            msg = QMessageBox(self)
            msg.setIcon(QMessageBox.Icon.Warning)
            msg.setWindowTitle("关闭确认")
            msg.setText("确定要关闭话术助手吗？")
            msg.setInformativeText("关闭后将退出程序。如需后台运行，请最小化窗口。")
            checkbox = QCheckBox("下次不再提醒")
            msg.setCheckBox(checkbox)
            btn_yes = msg.addButton("确认关闭", QMessageBox.ButtonRole.AcceptRole)
            btn_no = msg.addButton("取消", QMessageBox.ButtonRole.RejectRole)
            msg.setDefaultButton(btn_no)
            msg.exec()
            if msg.clickedButton() == btn_no:
                event.ignore()
                return
            if checkbox.isChecked():
                try:
                    close_confirm_file.write_text(json.dumps({"skip": True}), encoding='utf-8')
                except Exception:
                    pass
        try:
            if self._alias_sync_timer is not None:
                self._alias_sync_timer.stop()
        except Exception:
            pass

        # 🔄 停止备份线程，避免守护线程被强制终止导致备份损坏
        try:
            self.stop_second_backup()
        except Exception as e:
            print(f"[备份] 停止备份时出错: {e}")

        # 关闭所有文本编辑器窗口
        try:
            self._close_all_text_editor_windows()
        except Exception as e:
            print(f"关闭文本编辑器窗口时出错: {e}")

        # 关闭所有占位符对话框
        try:
            self._close_all_placeholder_dialogs()
        except Exception as e:
            print(f"关闭占位符对话框时出错: {e}")

        self._cleanup_webengine_resources()

        try:
            self._save_window_geometry_silent()
        except Exception:
            pass

        event.accept()
        super().closeEvent(event)


def handle_exception(exc_type, exc_value, exc_traceback):
    """全局异常处理器，捕获未处理的异常"""
    import traceback
    print("=" * 80)
    print("[严重错误] 应用程序发生未处理的异常:")
    print("=" * 80)
    traceback.print_exception(exc_type, exc_value, exc_traceback)
    print("=" * 80)
    # 将错误信息写入文件以便后续分析
    try:
        with open("error_log.txt", "a", encoding="utf-8") as f:
            f.write(f"\n\n[{__import__('datetime').datetime.now()}]\n")
            traceback.print_exception(exc_type, exc_value, exc_traceback, file=f)
    except:
        pass


def main() -> None:
    print("[启动] 开始初始化应用程序...")
    # 设置全局异常处理器
    sys.excepthook = handle_exception
    
    try:
        QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
        app = QApplication(sys.argv)
        app.setApplicationName("卓雅话术助手")
        app.setOrganizationName("Zhuoya")
        app.setStyle("windows")
        print("[启动] QApplication 创建成功")
    except Exception as e:
        print(f"[启动] QApplication 创建失败: {e}")
        import traceback
        traceback.print_exc()
        return

    # 设置全局样式
    app.setStyleSheet("""
        QLineEdit {
            border: 1px solid #d0d0d0;
            border-radius: 6px;
            padding-top: 6px;
            padding-bottom: 6px;
            padding-left: 12px;
            padding-right: 12px;
            min-height: 28px;
            font-size: 14px;
            color: #333;
            background: #ffffff;
            margin: 0;
        }
        QLineEdit:focus {
            border-color: #0078d4;
            outline: none;
        }
        QCheckBox {
            font-size: 14px;
            color: #333;
            spacing: 8px;
        }
    """)

    try:
        print("[启动] 创建主窗口...")
        window = DesktopApp()
        print("[启动] 显示主窗口...")
        window.show()
        
        # 启动崩溃监控日志（心跳+renderProcessTerminated+异常），日志在 exe 同级 logs/crash_monitor.log
        try:
            from crash_monitor import setup_crash_monitor
            setup_crash_monitor(window)
        except Exception as e:
            print(f"[启动] 崩溃监控启动失败: {e}")
        
        # 第5步：验证窗口宽度（不中止流程）
        actual_width = window.width()
        print(f"[验证] 话术助手实际宽度: {actual_width}px (设定了382px)")
        if abs(actual_width - 382) <= 5:
            print("[验证] ✓ 窗口宽度在合理范围内，继续执行")
        else:
            print(f"[验证] ⚠ 窗口宽度偏差较大: {actual_width}px，但继续执行分屏流程")
        
        print("[启动] 进入事件循环...")
        sys.exit(app.exec())
    except Exception as e:
        print(f"[启动] 应用程序运行失败: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    main()
