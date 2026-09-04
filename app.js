/**
 * 侧边栏主脚本
 */

// 应用版本
const APP_VERSION = 'v1.5.0';

// 调试开关 - 设为 true 可显示详细调试日志
const DEBUG_MODE = false;
const dbgLog = (...args) => { if (DEBUG_MODE) console.log(...args); };

const IS_DESKTOP_ENV = typeof window !== 'undefined' && !!window.isDesktopApp;

// JavaScript全局异常处理器
if (typeof window !== 'undefined') {
    window.onerror = function(message, source, lineno, colno, error) {
        console.error('=== JavaScript全局异常 ===');
        console.error('错误信息:', message);
        console.error('文件:', source);
        console.error('行号:', lineno, '列号:', colno);
        console.error('错误对象:', error);
        console.error('========================');
        
        // 尝试将错误信息发送到Python端记录
        if (window.py_bridge && window.py_bridge.logError) {
            window.py_bridge.logError(`JS Error: ${message} at ${source}:${lineno}:${colno}`);
        }
        return false;
    };
    
    // 捕获未处理的Promise rejection
    window.addEventListener('unhandledrejection', function(event) {
        console.error('=== 未处理的Promise Rejection ===');
        console.error('原因:', event.reason);
        console.error('========================');
        
        if (window.py_bridge && window.py_bridge.logError) {
            window.py_bridge.logError(`Unhandled Promise Rejection: ${event.reason}`);
        }
    });
}

const THEME_CLASS_LIST = [
    'theme-purple', 'theme-red', 'theme-orange', 'theme-green',
    'theme-light-gray', 'theme-metal-gray', 'theme-champagne', 'theme-cloud-gray',
    'theme-dark-blue', 'theme-dark-gray', 'theme-dark-purple', 'theme-dark-green'
];

const SEARCH_PLACEHOLDER_DEFAULT = '搜索话术...';
const LAST_SEARCH_STORAGE_KEY = 'lastSearchKeyword';
const SEARCH_HISTORY_STORAGE_KEY = 'searchKeywordHistory';
const MAX_SEARCH_HISTORY_ITEMS = 8;


function getActiveThemeClass() {
    const body = typeof document !== 'undefined' ? document.body : null;
    if (!body) return null;
    return THEME_CLASS_LIST.find(themeClass => body.classList.contains(themeClass)) || null;
}

// 加载“复制后自动聚焦”开关
async function loadAutoFocusAfterCopySettings() {
    try {
        const checkbox = document.getElementById('autoFocusAfterCopy');
        if (!checkbox) return;
        const current = await db.getSetting('autoFocusAfterCopy', 'false');
        checkbox.checked = current === 'true';

        const cloned = checkbox.cloneNode(true);
        checkbox.parentNode.replaceChild(cloned, checkbox);
        cloned.checked = current === 'true';
        cloned.addEventListener('change', () => {
            saveAutoFocusAfterCopySettings(cloned.checked);
        });
    } catch (e) {
        // ignore
    }
}

async function saveAutoFocusAfterCopySettings(isChecked) {
    try {
        await db.setSetting('autoFocusAfterCopy', isChecked ? 'true' : 'false');
    } catch (e) {
        // ignore
    }
}

async function copyFirstImageFromPhrase(phrase, autoPaste = false) {
    try {
        const pid = phrase && phrase.id ? Number(phrase.id) : null;
        if (!pid) return;

        // 直接使用传入的 phrase 数据（渲染时已是最新），跳过全库查询
        const images = phrase && phrase.images ? phrase.images : [];
        if (!images || images.length === 0) {
            showToast('❌ 未找到图片', 'error');
            return;
        }

        const imageData = images[0];
        const response = await fetch(imageData);
        const blob = await response.blob();
        console.log('[图片复制] blob type:', blob.type, 'size:', blob.size);
        await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
        ]);
        console.log('[图片复制] 已写入剪贴板');

        if (autoPaste) {
            showToast('✅ 已复制并自动粘贴');
            // clipboard.write 已 await，剪贴板已就绪
            await new Promise(resolve => setTimeout(resolve, 50));
            console.log('[图片复制] 延迟完成，开始自动粘贴');
            // 自动粘贴到外部窗口
            try {
                if (window.pythonBridge && typeof window.pythonBridge.paste_no_focus_steal === 'function') {
                    const success = await window.pythonBridge.paste_no_focus_steal();
                    if (success) {
                        console.log('图片图标点击：图片已自动粘贴（不抢焦点模式）');
                    } else {
                        console.log('图片图标点击：自动粘贴失败');
                    }
                }
            } catch (e) {
                console.error('自动粘贴失败', e);
            }
        } else {
            showToast('✅ 已复制');
            await tryAutoFocusAfterCopy();
        }
    } catch (error) {
        console.error('[图片复制] 失败详情:', error.name, error.message, error);
        showToast('❌ 复制失败: ' + (error.name || '未知错误'), 'error');
    }
}

// ==================== 更多(子话术) - 展开渲染（里程碑2：只读） ====================

const __moreExpandedParents = new Set();
let __childPhraseParentId = null;
let __childPhraseParentCategoryId = null;

function ensureMoreChildrenExpanded(parentId, parentEl) {
    try {
        const pid = Number(parentId);
        if (!pid || !parentEl) return;
        if (!__moreExpandedParents.has(pid)) return;

        const next = parentEl.nextElementSibling;
        if (next && next.classList && next.classList.contains('phrase-children-container')) {
            return;
        }

        // Render async after current call stack so DOM is stable.
        setTimeout(() => {
            (async () => {
                try {
                    // Parent might have been re-rendered.
                    const el = document.querySelector(`.phrase-item[data-id="${pid}"]`) || parentEl;
                    if (!el || !__moreExpandedParents.has(pid)) return;

                    const existingNext = el.nextElementSibling;
                    if (existingNext && existingNext.classList && existingNext.classList.contains('phrase-children-container')) {
                        return;
                    }

                    const container = document.createElement('div');
                    container.className = 'phrase-children-container';
                    container.dataset.parentId = String(pid);
                    await renderChildrenIntoContainer(pid, container);
                    el.insertAdjacentElement('afterend', container);
                } catch (e) {
                    // ignore
                }
            })();
        }, 0);
    } catch (e) {
        // ignore
    }
}

function createChildPhraseItem(phrase, showCategory = false) {
    const cloned = { ...phrase, enable_variants: false };
    const el = createPhraseItem(cloned, showCategory, false);
    try {
        el.classList.add('child-phrase-item');
        el.dataset.parentId = String(phrase.parent_id);

        // 子话术：覆盖默认的编辑/删除行为（默认会走 editPhrase/deletePhrase）
        const editBtn = el.querySelector('.edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                let parentCatId = null;
                try {
                    const phrases = await db.searchPhrases();
                    const parentPhrase = (phrases || []).find(p => p.id === Number(phrase.parent_id));
                    if (parentPhrase) parentCatId = parentPhrase.category_id;
                } catch (err) {
                    parentCatId = null;
                }
                openChildPhraseDialog(phrase.parent_id, phrase.id, parentCatId);
            }, true);
        }

        const deleteBtn = el.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const result = await showDeleteConfirmDialog(
                    '🗑️ 删除子话术',
                    '确定要删除这条子话术吗？'
                );
                if (result === 'cancel') return;
                try {
                    if (result === 'permanent') {
                        await db.permanentlyDeletePhrase(phrase.id);
                        showToast('✅ 子话术已永久删除');
                    } else {
                        await db.deletePhrase(phrase.id);
                        showToast('✅ 子话术已移到回收站');
                    }
                    await refreshMoreChildren(phrase.parent_id);
                } catch (err) {
                    console.error('删除子话术失败:', err);
                    showToast('❌ 删除失败', 'error');
                }
            }, true);
        }

        const actions = el.querySelector('.phrase-actions');
        if (actions) {
            const upBtn = document.createElement('button');
            upBtn.className = 'phrase-action-btn child-move-up-btn';
            upBtn.type = 'button';
            upBtn.dataset.text = '上移';
            upBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await moveChildPhrase(phrase.id, phrase.parent_id, -1);
            });

            const downBtn = document.createElement('button');
            downBtn.className = 'phrase-action-btn child-move-down-btn';
            downBtn.type = 'button';
            downBtn.dataset.text = '下移';
            downBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await moveChildPhrase(phrase.id, phrase.parent_id, 1);
            });

            actions.insertBefore(downBtn, actions.firstChild);
            actions.insertBefore(upBtn, downBtn);
        }
    } catch (e) {
        // ignore
    }
    return el;
}

async function moveChildPhrase(childId, parentId, direction) {
    try {
        const pid = Number(parentId);
        const cid = Number(childId);
        if (!pid || !cid || !db || typeof db.getChildPhrases !== 'function') return;

        const siblings = await db.getChildPhrases(pid, false);
        const idx = siblings.findIndex(p => p.id === cid);
        if (idx < 0) return;

        const targetIdx = idx + direction;
        if (targetIdx < 0 || targetIdx >= siblings.length) return;

        const a = siblings[idx];
        const b = siblings[targetIdx];
        const orderA = typeof a.sort_order === 'number' ? a.sort_order : idx;
        const orderB = typeof b.sort_order === 'number' ? b.sort_order : targetIdx;

        await db.batchUpdatePhraseSortOrder([
            { id: a.id, sort_order: orderB },
            { id: b.id, sort_order: orderA }
        ]);

        await refreshMoreChildren(pid);
    } catch (e) {
        showToast('❌ 子话术排序失败', 'error');
    }
}

function openChildPhraseDialog(parentId, childPhraseId = null, parentCategoryId = null) {
    __childPhraseParentId = Number(parentId);
    __childPhraseParentCategoryId = parentCategoryId === null || parentCategoryId === undefined ? null : Number(parentCategoryId);

    // 复用现有对话框
    openPhraseDialog(childPhraseId, (__childPhraseParentCategoryId || currentSelectedCategoryId || '1'));

    // 子话术模式：隐藏分类选择；子话术不展示“更多”开关
    try {
        const dialogTitle = document.getElementById('dialogTitle');
        if (dialogTitle) dialogTitle.textContent = childPhraseId ? '编辑子话术' : '添加子话术';

        const catGroup = document.querySelector('#phraseCategory')?.closest('.form-group');
        if (catGroup) catGroup.style.display = 'none';

        const enableVariantsRow = document.getElementById('enableVariants')?.closest('.feature-option');
        if (enableVariantsRow) enableVariantsRow.style.display = 'none';

        const enableVariantsEl = document.getElementById('enableVariants');
        if (enableVariantsEl) enableVariantsEl.checked = false;

        const actAsTitleRow = document.getElementById('actAsTitle')?.closest('.feature-option');
        if (actAsTitleRow) actAsTitleRow.style.display = 'none';
        const actAsTitleEl = document.getElementById('actAsTitle');
        if (actAsTitleEl) actAsTitleEl.checked = false;
        const actTitleTextEditorRowEl = document.getElementById('actTitleTextEditorRow');
        if (actTitleTextEditorRowEl) actTitleTextEditorRowEl.style.display = 'none';
    } catch (e) {
        // ignore
    }
}

function clearChildPhraseDialogMode() {
    __childPhraseParentId = null;
    __childPhraseParentCategoryId = null;
    try {
        const catGroup = document.querySelector('#phraseCategory')?.closest('.form-group');
        if (catGroup) catGroup.style.display = '';

        const enableVariantsRow = document.getElementById('enableVariants')?.closest('.feature-option');
        if (enableVariantsRow) enableVariantsRow.style.display = '';

        const actAsTitleRow = document.getElementById('actAsTitle')?.closest('.feature-option');
        if (actAsTitleRow) actAsTitleRow.style.display = '';
    } catch (e) {
        // ignore
    }
}

async function refreshMoreChildren(parentId) {
    try {
        const pid = Number(parentId);
        const parentEl = document.querySelector(`.phrase-item[data-id="${pid}"]`);
        if (!parentEl) return;

        const next = parentEl.nextElementSibling;
        if (!next || !next.classList || !next.classList.contains('phrase-children-container')) {
            return;
        }

        // 保持展开状态，仅刷新内容
        next.innerHTML = '';
        await renderChildrenIntoContainer(pid, next);
    } catch (e) {
        // ignore
    }
}

async function renderChildrenIntoContainer(parentId, container) {
    const pid = Number(parentId);
    if (!container) return;

    let children = [];
    try {
        if (db && typeof db.getChildPhrases === 'function') {
            children = await db.getChildPhrases(pid, false);
        }
    } catch (e) {
        children = [];
    }

    if (!children || children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'phrase-children-empty';
        empty.innerHTML = `<div class="phrase-children-empty-text">暂无子话术</div>`;
        container.appendChild(empty);
    } else {
        const frag = document.createDocumentFragment();
        children.forEach(ch => {
            try {
                const childEl = createChildPhraseItem(ch, false);
                frag.appendChild(childEl);
            } catch (e) {
                // ignore
            }
        });
        container.appendChild(frag);
    }

    // footer + add button (always at bottom)
    const footer = document.createElement('div');
    footer.className = 'phrase-children-footer';
    footer.innerHTML = `<button class="phrase-children-add-btn" type="button">添加子话术</button>`;
    const addBtn = footer.querySelector('.phrase-children-add-btn');
    if (addBtn) {
        addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            let parentCatId = null;
            try {
                const phrases = await db.searchPhrases();
                const parentPhrase = (phrases || []).find(p => p.id === pid);
                if (parentPhrase) parentCatId = parentPhrase.category_id;
            } catch (err) {
                parentCatId = null;
            }

            openChildPhraseDialog(pid, null, parentCatId);
        });
    }
    container.appendChild(footer);
}

async function toggleMoreChildren(parentId, parentEl) {
    try {
        const pid = parseInt(parentId, 10);
        if (!parentEl) {
            parentEl = document.querySelector(`.phrase-item[data-id="${pid}"]`);
        }
        if (!parentEl) return;

        const isExpanded = __moreExpandedParents.has(pid);

        const cornerTextEl = parentEl.querySelector('.phrase-more-corner-text');

        if (isExpanded) {
            // collapse
            const next = parentEl.nextElementSibling;
            if (next && next.classList && next.classList.contains('phrase-children-container')) {
                next.remove();
            }
            __moreExpandedParents.delete(pid);
            parentEl.classList.remove('more-expanded');
            if (cornerTextEl) cornerTextEl.textContent = '+';
            return;
        }

        // expand
        __moreExpandedParents.add(pid);
        parentEl.classList.add('more-expanded');
        if (cornerTextEl) cornerTextEl.textContent = '-';

        const container = document.createElement('div');
        container.className = 'phrase-children-container';
        container.dataset.parentId = String(pid);
        await renderChildrenIntoContainer(pid, container);

        // insert right after the parent card
        parentEl.insertAdjacentElement('afterend', container);
    } catch (e) {
        // ignore
    }
}

function applyThemeClass(element, themeClass) {
    if (!element || !themeClass) return;
    element.classList.remove(...THEME_CLASS_LIST);
    element.classList.add(themeClass);
}

if (IS_DESKTOP_ENV) {
    const DESKTOP_STORAGE_KEY = '__zhuoya_desktop_storage__';

    const loadDesktopStorage = () => {
        try {
            const raw = localStorage.getItem(DESKTOP_STORAGE_KEY);
            if (!raw) {
                return {};
            }
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            console.warn('⚠️ 桌面存储初始化失败，使用空对象:', error);
            return {};
        }
    };

    let desktopStorageData = loadDesktopStorage();

    const persistDesktopStorage = () => {
        try {
            localStorage.setItem(DESKTOP_STORAGE_KEY, JSON.stringify(desktopStorageData));
        } catch (error) {
            console.error('❌ 桌面存储写入失败:', error);
        }
    };

    const normalizeGetResult = (keys) => {
        if (keys === null || keys === undefined) {
            return { ...desktopStorageData };
        }
        if (Array.isArray(keys)) {
            return keys.reduce((acc, key) => {
                acc[key] = desktopStorageData[key];
                return acc;
            }, {});
        }
        if (typeof keys === 'string') {
            return { [keys]: desktopStorageData[keys] };
        }
        if (typeof keys === 'object') {
            return Object.keys(keys).reduce((acc, key) => {
                acc[key] = Object.prototype.hasOwnProperty.call(desktopStorageData, key)
                    ? desktopStorageData[key]
                    : keys[key];
                return acc;
            }, {});
        }
        return {};
    };

    const desktopStorage = {
        async get(keys) {
            return normalizeGetResult(keys);
        },
        async set(items) {
            if (!items || typeof items !== 'object') {
                return;
            }
            desktopStorageData = {
                ...desktopStorageData,
                ...items
            };
            persistDesktopStorage();
        },
        async remove(keys) {
            if (Array.isArray(keys)) {
                keys.forEach(key => delete desktopStorageData[key]);
            } else if (typeof keys === 'string') {
                delete desktopStorageData[keys];
            }
            persistDesktopStorage();
        },
        async clear() {
            desktopStorageData = {};
            persistDesktopStorage();
        }
    };

    window.chrome = window.chrome || {};
    window.chrome.storage = window.chrome.storage || {};
    if (!window.chrome.storage.local) {
        window.chrome.storage.local = desktopStorage;
    }

    window.chrome.runtime = window.chrome.runtime || {};
    if (typeof window.chrome.runtime.sendMessage !== 'function') {
        window.chrome.runtime.sendMessage = async () => ({
            success: false,
            error: '桌面环境不支持 runtime 消息'
        });
    }

    window.chrome.tabs = window.chrome.tabs || {};
    if (typeof window.chrome.tabs.query !== 'function') {
        window.chrome.tabs.query = async () => [];
    }
    if (typeof window.chrome.tabs.sendMessage !== 'function') {
        window.chrome.tabs.sendMessage = async () => {
            throw new Error('桌面环境不支持 tabs.sendMessage');
        };
    }
}

// 🔍 检查 db.js 是否正确加载
if (typeof db === 'undefined') {
    console.error('❌ [app.js] CRITICAL: db.js 加载失败！');
    document.body.innerHTML = '<div style="padding: 20px; color: red; font-size: 16px;">❌ 数据库模块加载失败<br><br>请检查：<br>1. db.js 文件是否存在<br>2. 浏览器控制台错误信息<br>3. 尝试重新加载扩展</div>';
    throw new Error('db.js 未加载');
}

let currentEditingPhraseId = null;
let savedSelectionRange = null; // 保存编辑框中的选中范围
let currentEditingCategoryId = null;
let lastCategoryDialogParentId = null;
let allCategoriesCache = [];

let currentSelectedCategoryId = ''; // 当前选中的分类ID，空字符串表示"所有分类"
let isSortModeActive = false; // 排序模式是否激活
let isCategorySortModeActive = false; // 分类排序模式是否激活
let isSubcategoryPopoverOutsideHandlerBound = false; // 是否已绑定点击外部关闭二级分类弹层
let _orphanPhraseCount = -1;

// 客户标签页管理
let customerTabs = [];
let activeCustomerTabId = 1;
let nextCustomerTabId = 2;

// 搜索覆盖状态管理
let searchCoverTabId = null;  // 当前被搜索覆盖的标签ID
let isSearchCovering = false;  // 是否处于搜索覆盖状态

// 全局搜索函数
let globalPerformSearch = null;  // 保存performSearch函数的引用
let globalRefreshSearchPlaceholder = null;  // 保存refreshSearchPlaceholder函数的引用

// 🎯 存储每个标签页的话术使用记录 { tabId: Set<phraseId> }
let tabUsageMap = new Map();

// ========== 占位符编辑状态全局缓存 ==========
// 存储格式: { phraseId: { isEditMode: boolean, placeholderValues: { placeholderName: value } } }
let placeholderEditCache = {};

// 🧩 标题卡片折叠设置缓存
let enableTitleCollapseSetting = 'false';

// ========== 浏览器快捷方式管理 ==========
let browserShortcuts = [];
let browserToDelete = null;

// 从localStorage加载浏览器快捷方式
function loadBrowserShortcuts() {
    const saved = localStorage.getItem('browserShortcuts');
    if (saved) {
        try {
            browserShortcuts = JSON.parse(saved);
        } catch (e) {
            console.error('加载浏览器快捷方式失败:', e);
            browserShortcuts = [];
        }
    }
}

// 保存浏览器快捷方式到localStorage
function saveBrowserShortcuts() {
    localStorage.setItem('browserShortcuts', JSON.stringify(browserShortcuts));
}

// 渲染浏览器快捷方式列表
function renderBrowserShortcuts() {
    const list = document.getElementById('workBrowserList');
    if (!list) return;

    if (browserShortcuts.length === 0) {
        list.innerHTML = `
            <div class="work-popover-empty">
                <div class="work-popover-empty-icon">🌐</div>
                <div>暂无浏览器快捷方式</div>
                <div style="font-size: 12px; margin-top: 4px;">点击下方按钮添加</div>
            </div>
        `;
        return;
    }

    list.innerHTML = browserShortcuts.map((shortcut, index) => `
        <div class="work-browser-item" data-index="${index}" data-path="${shortcut.path}">
            <div class="work-browser-icon">
                <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNjY2IiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PHBhdGggZD0iTTEyIDJhMTAgMTAgMCAwIDEgMTAgMTB2MmEyIDIgMCAwIDEtMiAySDJhMiAyIDAgMCAxLTItMnYtMmExMCAxMCAwIDAgMSAxMC0xeiIvPjwvc3ZnPg==" alt="browser">
            </div>
            <div class="work-browser-name">${shortcut.name}</div>
            <button class="work-browser-delete" data-index="${index}" title="删除">×</button>
        </div>
    `).join('');

    // 绑定点击事件
    list.querySelectorAll('.work-browser-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('work-browser-delete')) {
                e.stopPropagation();
                const index = parseInt(e.target.dataset.index);
                showDeleteBrowserConfirmDialog(index);
            } else {
                const path = item.dataset.path;
                openBrowser(path);
            }
        });
    });
}

// 添加浏览器快捷方式
function addBrowserShortcut(name, path) {
    browserShortcuts.push({ name, path });
    saveBrowserShortcuts();
    renderBrowserShortcuts();
}

// 删除浏览器快捷方式
function deleteBrowserShortcut(index) {
    browserShortcuts.splice(index, 1);
    saveBrowserShortcuts();
    renderBrowserShortcuts();
}

// 显示删除浏览器快捷方式确认对话框
function showDeleteBrowserConfirmDialog(index) {
    browserToDelete = index;
    const dialog = document.getElementById('deleteBrowserConfirmDialog');
    if (dialog) {
        dialog.style.display = 'flex';
    }
}

// 隐藏删除浏览器快捷方式确认对话框
function hideDeleteBrowserConfirmDialog() {
    const dialog = document.getElementById('deleteBrowserConfirmDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}

// 确认删除浏览器快捷方式
function confirmDeleteBrowser() {
    if (browserToDelete !== null) {
        deleteBrowserShortcut(browserToDelete);
        browserToDelete = null;
    }
    hideDeleteBrowserConfirmDialog();
}

// 打开浏览器
function openBrowser(path) {
    if (window.pythonBridge && typeof window.pythonBridge.open_browser === 'function') {
        // 获取保存的默认网址
        const defaultUrl = getWorkDefaultUrl();
        window.pythonBridge.open_browser(path, defaultUrl);
        // 关闭上班弹窗
        closeWorkPopover();
    } else {
        console.error('Python bridge not available');
    }
}

// 打开文件选择对话框
function openFileDialog() {
    if (window.pythonBridge && typeof window.pythonBridge.open_file_dialog === 'function') {
        window.pythonBridge.open_file_dialog();
    } else {
        console.error('Python bridge not available');
    }
}

// 切换上班弹窗显示状态
function toggleWorkPopover() {
    const popover = document.getElementById('workPopover');
    const workBtn = document.getElementById('workBtn');
    if (!popover) return;

    if (popover.classList.contains('show')) {
        popover.classList.remove('show');
        if (workBtn) workBtn.classList.remove('active');
    } else {
        popover.classList.add('show');
        if (workBtn) workBtn.classList.add('active');
        renderBrowserShortcuts();
    }
}

// 关闭上班弹窗
function closeWorkPopover() {
    const popover = document.getElementById('workPopover');
    const workBtn = document.getElementById('workBtn');
    if (popover) {
        popover.classList.remove('show');
    }
    if (workBtn) {
        workBtn.classList.remove('active');
    }
}

// 点击空白区域关闭上班弹窗
document.addEventListener('click', (e) => {
    const popover = document.getElementById('workPopover');
    const workBtn = document.getElementById('workBtn');
    
    if (!popover || !popover.classList.contains('show')) {
        return;
    }
    
    // 检查点击是否在上班按钮或上班弹窗内部
    if (workBtn && workBtn.contains(e.target)) {
        return;
    }
    
    if (popover.contains(e.target)) {
        return;
    }
    
    // 点击空白区域，关闭弹窗
    closeWorkPopover();
});

function refreshPhraseUsageVisual(phraseId, options = {}) {
    const { flash = false } = options;
    const usageSet = tabUsageMap.get(activeCustomerTabId) || new Set();
    const shouldMark = usageSet.has(phraseId);
    const phraseNodes = document.querySelectorAll(`.phrase-item[data-id="${phraseId}"]`);
    if (phraseNodes.length === 0) return;

    phraseNodes.forEach(node => {
        if (shouldMark) {
            node.classList.add('phrase-used');
            if (flash) {
                node.classList.remove('phrase-used-just');
                void node.offsetWidth;
                node.classList.add('phrase-used-just');
            }
        } else {
            node.classList.remove('phrase-used');
            node.classList.remove('phrase-used-just');
        }
    });
}

const RECYCLE_CATEGORY_NAMES = new Set(['🗑️话术回收', '话术回收', '回收站']);

function normalizeCategoryName(name) {
    return (name || '').trim();
}

function normalizeNumeric(value, fallback = 0) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const num = Number(value);
    return Number.isNaN(num) ? fallback : num;
}

function getCategoryId(category) {
    return category ? normalizeNumeric(category.id, 0) : 0;
}

function getCategoryParentId(category) {
    return category ? normalizeNumeric(category.parent_id, 0) : 0;
}

function isRecycleCategory(category) {
    if (!category) return false;
    return getCategoryId(category) === 1 && RECYCLE_CATEGORY_NAMES.has(normalizeCategoryName(category.name));
}

function getFirstNonRecycleCategory(categories = []) {
    return categories.find(cat => !isRecycleCategory(cat));
}

function hideAllSubcategoryPopovers() {
    document.querySelectorAll('.subcategory-popover.visible').forEach(pop => {
        pop.classList.remove('visible');
    });
}

function ensureSubcategoryPopoverOutsideHandler() {
    if (isSubcategoryPopoverOutsideHandlerBound) return;
    document.addEventListener('pointerdown', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            hideAllSubcategoryPopovers();
            return;
        }
        if (target.closest('.subcategory-popover')) {
            return;
        }
        if (target.closest('.category-nav-item')) {
            return;
        }
        hideAllSubcategoryPopovers();
    });
    isSubcategoryPopoverOutsideHandlerBound = true;
}

// 初始化客户标签页
function initCustomerTabs(skipRestore = false) {
    // 从localStorage恢复标签页
    const savedTabs = localStorage.getItem('customerTabs');
    if (savedTabs) {
        try {
            const parsed = JSON.parse(savedTabs);
            customerTabs = parsed.tabs || [];
            activeCustomerTabId = parsed.activeTabId || 1;
            nextCustomerTabId = parsed.nextTabId || 2;

            // 🔧 去重：根据ID去重，防止重复标签页
            const uniqueTabs = [];
            const seenIds = new Set();
            customerTabs.forEach(tab => {
                if (!seenIds.has(tab.id)) {
                    seenIds.add(tab.id);
                    uniqueTabs.push(tab);
                }
            });
            customerTabs = uniqueTabs;

            // 🔧 确保每个标签页都有 isPinPinned 字段
            customerTabs.forEach(tab => {
                if (tab.isPinPinned === undefined || tab.isPinPinned === null) {
                    tab.isPinPinned = false;
                }
            });

            // 🔧 兼容旧数据：识别回收站标签页并补全 isRecycleBin 标志（不再清空 selectedCategory）
            customerTabs.forEach(tab => {
                const isRecycleTab = (tab.selectedCategory === '1' || tab.selectedCategory === 1) &&
                    RECYCLE_CATEGORY_NAMES.has(normalizeCategoryName(tab.categoryName));
                if (isRecycleTab) {
                    tab.isRecycleBin = true;
                    console.log('🗑️ 识别到回收站标签页:', tab.name);
                } else if (tab.isRecycleBin === undefined || tab.isRecycleBin === null) {
                    tab.isRecycleBin = false;
                }
            });

            // 🔧 检查是否有重复的分类名称（相同的categoryName和selectedCategory）
            const categoryMap = new Map();
            customerTabs.forEach((tab, index) => {
                const key = `${tab.categoryName}-${tab.selectedCategory}`;
                if (categoryMap.has(key)) {
                    // 检测到重复分类，移除重复的标签页
                    const duplicateTabId = categoryMap.get(key);
                    const duplicateIndex = customerTabs.findIndex(t => t.id === duplicateTabId);
                    if (duplicateIndex !== -1) {
                        customerTabs.splice(duplicateIndex, 1);
                    }
                } else {
                    categoryMap.set(key, tab.id);
                }
            });
        } catch (e) {
            console.error('恢复标签页失败:', e);
        }
    }

    // 没有标签页时不自动创建，保持空状态
    if (customerTabs.length === 0) {
        activeCustomerTabId = 0;
        nextCustomerTabId = 1;
    }

    renderCustomerTabs();
    // 在初始化时跳过状态恢复，等待 restoreLastSelectedCategory 完成
    if (!skipRestore && customerTabs.length > 0) {
        restoreTabState();
    }

    // 更新钉住按钮状态
    updatePinButtonFromTabState();
}

// 保存标签页状态
function saveCustomerTabs() {
    // 保存当前标签页的状态
    saveCurrentTabState();

    localStorage.setItem('customerTabs', JSON.stringify({
        tabs: customerTabs,
        activeTabId: activeCustomerTabId,
        nextTabId: nextCustomerTabId
    }));
}

// 保存当前标签页的状态
async function saveCurrentTabState() {
    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
    if (currentTab) {
        const searchInput = document.getElementById('searchInput');
        const phraseList = document.getElementById('phraseList');

        currentTab.searchText = searchInput ? searchInput.value : '';
        currentTab.selectedCategory = currentSelectedCategoryId;
        currentTab.scrollPosition = phraseList ? phraseList.scrollTop : 0;
        
        // 获取并保存分类名称
        if (currentSelectedCategoryId) {
            try {
                const category = await db.getCategory(parseInt(currentSelectedCategoryId));
                if (category && category.name) {
                    currentTab.categoryName = category.name;
                    currentTab.isRecycleBin = isRecycleCategory(category);
                    console.log('✅ 保存分类名称:', category.name);
                } else {
                    console.warn('⚠️ 未找到分类 ID:', currentSelectedCategoryId);
                    currentTab.categoryName = '';
                    currentTab.isRecycleBin = false;
                }
            } catch (e) {
                console.error('❌ 获取分类名称失败:', e);
                currentTab.categoryName = '';
                currentTab.isRecycleBin = false;
            }
        } else {
            currentTab.categoryName = '';
            currentTab.isRecycleBin = false;
        }
    }
}

// 更新当前标签页的按钮状态
function updateCurrentTabPinState(isPinned) {
    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
    if (currentTab) {
        currentTab.isPinPinned = isPinned;
        saveCustomerTabs();
    }
}

// 根据标签页状态更新按钮颜色
function updatePinButtonFromTabState() {
    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
    const pinBtn = document.getElementById('pinFloatBtn');
    if (!pinBtn) return;
    const svgPath = pinBtn.querySelector('path');
    if (!svgPath) return;
    if (currentTab && currentTab.isPinPinned) {
        // 红色（定住状态）
        svgPath.setAttribute('fill', '#cc0000');
        svgPath.setAttribute('stroke', '#cc0000');
    } else {
        // 蓝色（未定住状态）- 没有标签页时也重置为蓝色
        svgPath.setAttribute('fill', '#007CF7');
        svgPath.setAttribute('stroke', '#007CF7');
    }
}

// 恢复标签页状态
function restoreTabState() {
    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
    if (currentTab) {
        const searchInput = document.getElementById('searchInput');
        const phraseList = document.getElementById('phraseList');

        if (searchInput) {
            searchInput.value = currentTab.searchText || '';
        }

        currentSelectedCategoryId = currentTab.selectedCategory || '';

        // 重新加载分类和话术
        loadCategories().then(() => {
            // 回收站标签走专用渲染，否则普通加载
            const renderPromise = currentTab.isRecycleBin ? loadRecycleBin() : loadPhrases();
            renderPromise.then(() => {
                if (phraseList && currentTab.scrollPosition) {
                    phraseList.scrollTop = currentTab.scrollPosition;
                }
                // 更新钉住按钮状态
                updatePinButtonFromTabState();
            });
        });
    }
}

// 渲染客户标签页（顶部和侧边栏双向同步）
// ⚠️ AI注意：顶部标签栏已隐藏（CSS display:none），但侧边栏标签依赖此函数中的顶部标签渲染逻辑，请勿删除或修改顶部标签栏相关代码！
function renderCustomerTabs() {
    // 渲染顶部标签栏（已隐藏但逻辑仍被侧边栏依赖）
    const tabsContainer = document.getElementById('customerTabs');
    if (tabsContainer) {
        tabsContainer.innerHTML = customerTabs.map(tab => {
            // 如果有分类名称，显示分类名称；否则显示默认名称
            let displayName = tab.categoryName || tab.name;
            // 过滤掉垃圾桶图标，只显示文字部分
            displayName = displayName.replace(/^🗑️/, '');
            return `
                <div class="customer-tab ${tab.id === activeCustomerTabId ? 'active' : ''}" data-tab-id="${tab.id}">
                    <span class="tab-label">${displayName}</span>
                    ${customerTabs.length > 1 ? `<button class="tab-close" title="关闭标签">×</button>` : ''}
                </div>
            `;
        }).join('');
        
        // 绑定顶部标签栏事件
        tabsContainer.querySelectorAll('.customer-tab').forEach(tabEl => {
            const tabId = parseInt(tabEl.dataset.tabId);
            
            // 点击标签切换
            tabEl.addEventListener('click', (e) => {
                if (!e.target.classList.contains('tab-close')) {
                    // 如果当前处于搜索覆盖状态，点击任何标签都退出搜索状态
                    if (isSearchCovering) {
                        const searchInput = document.getElementById('searchInput');
                        const clearSearch = document.getElementById('clearSearch');
                        const searchDropdown = document.getElementById('searchDropdown');

                        // 清空搜索框
                        if (searchInput) {
                            searchInput.value = '';
                        }
                        if (clearSearch) {
                            clearSearch.style.display = 'none';
                        }
                        if (searchDropdown) {
                            searchDropdown.classList.remove('show');
                        }

                        // 恢复标签原内容
                        if (globalPerformSearch) {
                            globalPerformSearch();
                        }
                        if (globalRefreshSearchPlaceholder) {
                            globalRefreshSearchPlaceholder();
                        }
                        updateMarqueeVisibility();

                        // 重置搜索覆盖状态
                        searchCoverTabId = null;
                        isSearchCovering = false;

                        // 如果点击的是当前被搜索覆盖的标签，不执行标签切换
                        if (tabId === searchCoverTabId && tabId === activeCustomerTabId) {
                            return;
                        }
                    }

                    switchCustomerTab(tabId);
                }
            });
            
            // 关闭标签
            const closeBtn = tabEl.querySelector('.tab-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeCustomerTab(tabId);
                });
            }

            // 悬浮显示/隐藏关闭按钮
            tabEl.addEventListener('mouseenter', () => {
                if (closeBtn) {
                    closeBtn.style.opacity = '1';
                    closeBtn.style.pointerEvents = 'auto';
                    closeBtn.style.visibility = 'visible';
                }
            });

            tabEl.addEventListener('mouseleave', () => {
                if (closeBtn) {
                    closeBtn.style.opacity = '0';
                    closeBtn.style.pointerEvents = 'none';
                    closeBtn.style.visibility = 'visible';
                }
            });
        });
    }
    
    // 渲染侧边栏标签栏（完全镜像顶部标签，但不显示关闭按钮）
    const sidebarTabsContainer = document.getElementById('sidebarCustomerTabs');
    if (sidebarTabsContainer) {
        sidebarTabsContainer.innerHTML = customerTabs.map(tab => {
            // 如果有分类名称，显示分类名称；否则显示默认名称
            let displayName = tab.categoryName || tab.name;
            // 过滤掉垃圾桶图标，只显示文字部分
            displayName = displayName.replace(/^🗑️/, '');
            return `
                <div class="sidebar-customer-tab ${tab.id === activeCustomerTabId ? 'active' : ''}" data-tab-id="${tab.id}">
                    ${displayName}
                </div>
            `;
        }).join('');
        
        // 初始化侧边栏标签右键菜单
        const sidebarTabContextMenu = initSidebarTabContextMenu();
        
        // 绑定侧边栏标签栏事件
        sidebarTabsContainer.querySelectorAll('.sidebar-customer-tab').forEach(tabEl => {
            const tabId = parseInt(tabEl.dataset.tabId);

            // 初始化拖拽功能
            initTabDragAndDrop(tabEl, tabId);

            // 点击标签切换（同步到顶部）
            tabEl.addEventListener('click', (e) => {
                // 如果正在拖拽，不触发点击事件
                if (isDragging) {
                    console.log('🚫 拖拽中，忽略点击事件');
                    return;
                }
                
                // 如果当前处于搜索覆盖状态，点击任何标签都退出搜索状态
                if (isSearchCovering) {
                    const searchInput = document.getElementById('searchInput');
                    const clearSearch = document.getElementById('clearSearch');
                    const searchDropdown = document.getElementById('searchDropdown');

                    // 清空搜索框
                    if (searchInput) {
                        searchInput.value = '';
                    }
                    if (clearSearch) {
                        clearSearch.style.display = 'none';
                    }
                    if (searchDropdown) {
                        searchDropdown.classList.remove('show');
                    }

                    // 恢复标签原内容
                    if (globalPerformSearch) {
                        globalPerformSearch();
                    }
                    if (globalRefreshSearchPlaceholder) {
                        globalRefreshSearchPlaceholder();
                    }
                    updateMarqueeVisibility();

                    // 重置搜索覆盖状态
                    searchCoverTabId = null;
                    isSearchCovering = false;

                    // 如果点击的是当前被搜索覆盖的标签，不执行标签切换
                    if (tabId === searchCoverTabId && tabId === activeCustomerTabId) {
                        return;
                    }
                }

                switchCustomerTab(tabId);
            });

            // 右键菜单
            if (sidebarTabContextMenu) {
                tabEl.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    sidebarTabContextMenu.showContextMenu(e.clientX, e.clientY, tabId);
                });
            }
        });

        // 添加日志查看标签容器的实际高度和滚动属性
        if (!sidebarTabsContainer) {
            return;
        }

        const computedStyle = window.getComputedStyle(sidebarTabsContainer);

        // 监听标签按钮高度变化，记录被挤压事件
        const tabButtons = sidebarTabsContainer.querySelectorAll('.sidebar-customer-tab');
        const tabObserver = new ResizeObserver((entries) => {
            entries.forEach(entry => {
                const height = entry.contentRect.height;
                if (height < 40 && DEBUG_MODE) {
                    console.log('⚠️ 标签被挤压！标签ID: ' + entry.target.dataset.tabId + ', 实际高度: ' + height + 'px (应至少40px)');
                }
            });
        });

        tabButtons.forEach(tab => {
            tabObserver.observe(tab);
        });

        // 动态设置maxHeight以启用滚动
        updateSidebarTabsHeight();
    }
}

// 清除当前标签页的话术使用标记
function clearTabMarks() {
    // 清除 tabUsageMap 中当前标签的使用记录
    tabUsageMap.set(activeCustomerTabId, new Set());
    
    // 移除所有话术卡片的 phrase-used 类
    const phraseItems = document.querySelectorAll('.phrase-item.phrase-used');
    phraseItems.forEach(item => {
        item.classList.remove('phrase-used');
        item.classList.remove('phrase-used-just');
    });
    
    console.log('✅ 已清除当前标签页的话术使用标记');
}

// ========== 标签拖拽排序功能 ==========
let draggedTabElement = null;
let draggedTabId = null;
let dragStartTimer = null;
let isDragging = false;

function initTabDragAndDrop(tabEl, tabId) {
    let mouseDownTime = 0;
    
    // 鼠标按下时记录时间，但不立即开始拖拽
    tabEl.addEventListener('mousedown', (e) => {
        // 只响应左键
        if (e.button !== 0) return;
        
        mouseDownTime = Date.now();
        
        // 延迟150ms后才允许拖拽，避免与点击冲突
        dragStartTimer = setTimeout(() => {
            tabEl.setAttribute('draggable', 'true');
        }, 150);
    });
    
    // 鼠标抬起时清除定时器
    tabEl.addEventListener('mouseup', () => {
        if (dragStartTimer) {
            clearTimeout(dragStartTimer);
            dragStartTimer = null;
        }
        tabEl.setAttribute('draggable', 'false');
        
        // 如果按下时间很短（小于150ms），说明是点击而不是拖拽
        const pressDuration = Date.now() - mouseDownTime;
        if (pressDuration < 150) {
            isDragging = false;
        }
    });
    
    // 拖拽开始
    tabEl.addEventListener('dragstart', (e) => {
        isDragging = true;
        draggedTabElement = tabEl;
        draggedTabId = tabId;
        
        tabEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/html', tabEl.innerHTML);
        
        console.log('🎯 开始拖拽标签:', tabId);
    });
    
    // 拖拽结束
    tabEl.addEventListener('dragend', (e) => {
        tabEl.classList.remove('dragging');
        tabEl.setAttribute('draggable', 'false');
        
        // 移除所有拖拽经过的样式
        document.querySelectorAll('.sidebar-customer-tab').forEach(tab => {
            tab.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        
        draggedTabElement = null;
        draggedTabId = null;
        
        // 延迟重置拖拽状态，避免触发点击事件
        setTimeout(() => {
            isDragging = false;
        }, 100);
        
        console.log('✅ 拖拽结束');
    });
    
    // 拖拽经过
    tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        
        if (!draggedTabElement || draggedTabElement === tabEl) {
            return;
        }
        
        e.dataTransfer.dropEffect = 'move';
        
        // 计算鼠标在元素中的位置（上半部分还是下半部分）
        const rect = tabEl.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        // 移除所有拖拽样式
        document.querySelectorAll('.sidebar-customer-tab').forEach(tab => {
            tab.classList.remove('drag-over-top', 'drag-over-bottom');
        });
        
        // 根据鼠标位置添加相应的样式
        if (e.clientY < midpoint) {
            tabEl.classList.add('drag-over-top');
        } else {
            tabEl.classList.add('drag-over-bottom');
        }
    });
    
    // 拖拽离开
    tabEl.addEventListener('dragleave', (e) => {
        tabEl.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    
    // 放置
    tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!draggedTabElement || draggedTabElement === tabEl) {
            return;
        }
        
        // 移除拖拽样式
        tabEl.classList.remove('drag-over-top', 'drag-over-bottom');
        
        // 获取拖拽的标签和目标标签的索引
        const draggedIndex = customerTabs.findIndex(tab => tab.id === draggedTabId);
        const targetIndex = customerTabs.findIndex(tab => tab.id === tabId);
        
        if (draggedIndex === -1 || targetIndex === -1) {
            console.error('❌ 找不到标签索引');
            return;
        }
        
        // 计算鼠标在元素中的位置
        const rect = tabEl.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midpoint;
        
        // 重新排列数组
        const [draggedTab] = customerTabs.splice(draggedIndex, 1);
        let newIndex = customerTabs.findIndex(tab => tab.id === tabId);
        
        if (!insertBefore) {
            newIndex++;
        }
        
        customerTabs.splice(newIndex, 0, draggedTab);
        
        console.log('📦 标签重新排序:', customerTabs.map(t => t.id));
        
        // 保存并重新渲染
        saveCustomerTabs();
        renderCustomerTabs();
    });
}


// 初始化侧边栏标签右键菜单
function initSidebarTabContextMenu() {
    const contextMenu = document.getElementById('sidebarTabContextMenu');
    if (!contextMenu) {
        console.error('❌ 找不到侧边栏标签右键菜单元素');
        return;
    }
    
    let currentContextTabId = null;
    let justShownMenu = false;
    let tabToDelete = null;
    
    function showContextMenu(x, y, tabId) {
        currentContextTabId = tabId;
        
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('show');
        
        justShownMenu = true;
        setTimeout(() => {
            justShownMenu = false;
        }, 100);
        
        // 调整位置防止超出视口
        const menuRect = contextMenu.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        let adjustedX = x;
        let adjustedY = y;
        
        if (x + menuRect.width > viewportWidth) {
            adjustedX = viewportWidth - menuRect.width - 10;
            if (adjustedX < 10) adjustedX = 10;
        }
        
        if (y + menuRect.height > viewportHeight) {
            adjustedY = viewportHeight - menuRect.height - 10;
            if (adjustedY < 10) adjustedY = 10;
        }
        
        contextMenu.style.left = adjustedX + 'px';
        contextMenu.style.top = adjustedY + 'px';
    }
    
    function hideContextMenu() {
        contextMenu.classList.remove('show');
        currentContextTabId = null;
    }
    
    function showDeleteConfirmDialog(tabId) {
        tabToDelete = tabId;
        const dialog = document.getElementById('deleteTabConfirmDialog');
        if (dialog) {
            dialog.style.display = 'flex';
        }
    }
    
    function hideDeleteConfirmDialog() {
        const dialog = document.getElementById('deleteTabConfirmDialog');
        if (dialog) {
            dialog.style.display = 'none';
        }
        tabToDelete = null;
    }
    
    async function handleMenuAction(action) {
        const tabId = currentContextTabId;
        if (!tabId) return;

        switch (action) {
            case 'clearMarks':
                hideContextMenu();
                // 切换到该标签页后再清除标记
                if (tabId !== activeCustomerTabId) {
                    await switchCustomerTab(tabId);
                }
                clearTabMarks();
                break;
            case 'deleteUnpinned':
                hideContextMenu();
                // 删除所有未钉住的标签（不含当前右键的标签）
                const unpinnedTabs = customerTabs.filter(tab => !tab.isPinPinned && tab.id !== tabId);
                if (unpinnedTabs.length === 0) {
                    console.log('没有未钉住的标签可删除');
                    break;
                }
                // 从后往前删，避免索引变化
                for (let i = unpinnedTabs.length - 1; i >= 0; i--) {
                    await closeCustomerTab(unpinnedTabs[i].id);
                }
                break;
            case 'deleteTab':
                hideContextMenu();
                showDeleteConfirmDialog(tabId);
                break;
            default:
                console.warn('⚠️ 未知的侧边栏标签右键菜单操作:', action);
        }
    }
    
    // 菜单项点击事件
    const menuItems = contextMenu.querySelectorAll('.context-menu-item[data-action]');
    menuItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const action = item.dataset.action;
            await handleMenuAction(action);
        });
    });
    
    // 删除确认对话框按钮事件
    const cancelDeleteBtn = document.getElementById('cancelDeleteTab');
    const confirmDeleteBtn = document.getElementById('confirmDeleteTab');
    
    if (cancelDeleteBtn) {
        cancelDeleteBtn.addEventListener('click', () => {
            hideDeleteConfirmDialog();
        });
    }
    
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            if (tabToDelete !== null) {
                closeCustomerTab(tabToDelete);
            }
            hideDeleteConfirmDialog();
        });
    }
    
    // 删除浏览器快捷方式确认对话框按钮事件
    const cancelDeleteBrowserBtn = document.getElementById('cancelDeleteBrowser');
    const confirmDeleteBrowserBtn = document.getElementById('confirmDeleteBrowser');
    
    if (cancelDeleteBrowserBtn) {
        cancelDeleteBrowserBtn.addEventListener('click', () => {
            hideDeleteBrowserConfirmDialog();
        });
    }
    
    if (confirmDeleteBrowserBtn) {
        confirmDeleteBrowserBtn.addEventListener('click', () => {
            confirmDeleteBrowser();
        });
    }
    
    // 全局点击事件：点击菜单外部时隐藏
    document.addEventListener('click', (e) => {
        if (justShownMenu) return;
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });
    // 窗口失焦时也关闭菜单（如点击桌面）
    window.addEventListener('blur', () => {
        hideContextMenu();
    });
    
    return { showContextMenu, hideContextMenu };
}

// 切换客户标签页
async function switchCustomerTab(tabId) {
    if (tabId === activeCustomerTabId) return;

    // 保存当前标签页状态
    await saveCurrentTabState();

    // 切换到新标签页
    activeCustomerTabId = tabId;
    renderCustomerTabs();
    restoreTabState();
    saveCustomerTabs();

    // 根据标签页状态更新按钮颜色
    updatePinButtonFromTabState();

    // 切换标签时重置搜索覆盖状态
    searchCoverTabId = null;
    isSearchCovering = false;
}

// 添加新的客户标签页
async function addCustomerTab() {
    try {
        await saveCurrentTabState();

        const categories = await db.getAllCategories();
        const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);

        let defaultCategoryId = currentTab ? currentTab.selectedCategory : '';
        let defaultCategoryName = currentTab ? currentTab.categoryName : '';

        if (defaultCategoryId) {
            const matched = categories.find(
                cat => cat.id.toString() === defaultCategoryId.toString()
            );
            if (!matched || isRecycleCategory(matched)) {
                const fallback = getFirstNonRecycleCategory(categories);
                if (fallback) {
                    defaultCategoryId = fallback.id.toString();
                    defaultCategoryName = fallback.name;
                } else if (!matched) {
                    defaultCategoryId = '';
                    defaultCategoryName = '';
                } else {
                    defaultCategoryId = matched.id.toString();
                    defaultCategoryName = matched.name;
                }
            } else {
                defaultCategoryId = matched.id.toString();
                defaultCategoryName = matched.name;
            }
        } else {
            const fallback = getFirstNonRecycleCategory(categories);
            if (fallback) {
                defaultCategoryId = fallback.id.toString();
                defaultCategoryName = fallback.name;
            }
        }

        const newTab = {
            id: nextCustomerTabId++,
            name: '标签页',
            searchText: '',
            selectedCategory: defaultCategoryId || '',
            categoryName: defaultCategoryName || '',
            scrollPosition: 0,
            isPinPinned: false,
            isRecycleBin: false
        };

        customerTabs.push(newTab);
        tabUsageMap.set(newTab.id, new Set());
        await switchCustomerTab(newTab.id);
        saveCustomerTabs();
    } catch (error) {
        console.error('添加标签页失败:', error);
        showToast('❌ 无法添加新标签页', 'error');
    }
}

// 创建新标签页（带名称和分类）
async function addCustomerTabWithName(name, categoryId = '') {
    try {
        await saveCurrentTabState();

        let defaultCategoryId = categoryId || '';
        let defaultCategoryName = name || '标签页';

        if (!defaultCategoryId) {
            const categories = await db.getAllCategories();
            const fallback = getFirstNonRecycleCategory(categories);
            if (fallback) {
                defaultCategoryId = fallback.id.toString();
                defaultCategoryName = fallback.name;
            }
        }

        const newTab = {
            id: nextCustomerTabId++,
            name: defaultCategoryName,
            searchText: '',
            selectedCategory: defaultCategoryId || '',
            categoryName: defaultCategoryName || '',
            scrollPosition: 0,
            isPinPinned: false
        };

        customerTabs.push(newTab);
        tabUsageMap.set(newTab.id, new Set());
        await switchCustomerTab(newTab.id);
        saveCustomerTabs();
    } catch (error) {
        console.error('添加标签页失败:', error);
        showToast('❌ 无法添加新标签页', 'error');
    }
}

// 关闭客户标签页
function closeCustomerTab(tabId) {
    const index = customerTabs.findIndex(tab => tab.id === tabId);
    if (index === -1) return;

    customerTabs.splice(index, 1);
    tabUsageMap.delete(tabId);

    if (tabId === activeCustomerTabId) {
        if (customerTabs.length > 0) {
            const newActiveTab = customerTabs[Math.max(0, index - 1)];
            activeCustomerTabId = newActiveTab.id;
            restoreTabState();
        } else {
            // 所有标签都已关闭
            activeCustomerTabId = 0;
            currentSelectedCategoryId = '';
            // 清除分类的选中状态
            updatePrimaryCategoryTilesActiveState();
            // 显示空状态
            const phraseList = document.getElementById('phraseList');
            if (phraseList) {
                phraseList.innerHTML = `
                    <div class="empty-state">
                        <p>📋 暂无标签页</p>
                        <p>请在上方分类中选择一个分类开始使用</p>
                    </div>
                `;
            }
        }
    }

    renderCustomerTabs();
    saveCustomerTabs();
}

// 动态计算侧边栏标签容器高度
let sidebarHeightObserver = null;

function updateSidebarTabsHeight() {
    try {
        const contentAreaWrapper = document.querySelector('.content-area-wrapper');
        const leftSidebarArea = document.querySelector('.left-sidebar-area');
        const sidebarTabsContainer = document.getElementById('sidebarCustomerTabs');
        const addBtn = document.getElementById('addSidebarCategoryBtn');
        const pinNotch = document.querySelector('.pin-notch');

        if (!contentAreaWrapper || !leftSidebarArea || !sidebarTabsContainer) {
            return;
        }

        // 从content-area-wrapper开始计算高度
        const wrapperHeight = contentAreaWrapper.offsetHeight;
        const sidebarHeight = leftSidebarArea.offsetHeight;

        // 计算固定元素的高度
        let fixedHeight = 0;
        if (pinNotch) {
            fixedHeight += pinNotch.offsetHeight;
        }
        if (addBtn) {
            fixedHeight += addBtn.offsetHeight;
            // 加上margin-top
            const addBtnStyle = window.getComputedStyle(addBtn);
            const marginTop = parseInt(addBtnStyle.marginTop) || 0;
            fixedHeight += marginTop;
        }

        // 计算标签容器可用高度
        let availableHeight = sidebarHeight - fixedHeight;
        if (availableHeight <= 0 || sidebarHeight === 0) {
            // 如果sidebarHeight为0，使用wrapperHeight
            availableHeight = wrapperHeight - fixedHeight;
        }

        // 设置标签容器高度
        sidebarTabsContainer.style.height = `${availableHeight}px`;
        sidebarTabsContainer.style.maxHeight = `${availableHeight}px`;
        sidebarTabsContainer.style.overflowY = 'auto';
    } catch (error) {
        console.error('计算侧边栏高度失败:', error);
    }
}

// 设置ResizeObserver监听侧边栏高度变化
function setupSidebarHeightObserver() {
    const contentAreaWrapper = document.querySelector('.content-area-wrapper');
    const leftSidebarArea = document.querySelector('.left-sidebar-area');
    if (!contentAreaWrapper || !leftSidebarArea) return;

    // 清除旧的observer
    if (sidebarHeightObserver) {
        sidebarHeightObserver.disconnect();
    }

    // 创建新的observer，监听content-area-wrapper
    sidebarHeightObserver = new ResizeObserver(() => {
        updateSidebarTabsHeight();
    });

    sidebarHeightObserver.observe(contentAreaWrapper);
    sidebarHeightObserver.observe(leftSidebarArea);
    console.log('侧边栏高度监听器已设置');
}

// 初始化函数
async function initApp() {
    try {
        // 检查依赖
        if (typeof db === 'undefined') {
            throw new Error('db.js 未正确加载，请检查文件引用顺序');
        }
        
        if (typeof db.getAllPhrases !== 'function') {
            throw new Error('db.getAllPhrases 不是函数 - db 对象可能未正确初始化');
        }
        
        // ⚡ 优化：初始化数据库和默认数据
        await db.init();
        if (typeof db.ensureRecycleCategory === 'function') {
            await db.ensureRecycleCategory();
        }
        await db.initDefaultData();

        // 🧹 桌面版一次性迁移：关闭无图片附件的话术的图片功能
        if (IS_DESKTOP_ENV && typeof db.bulkDisableImagesForNoAttachment === 'function') {
            const migrated = await db.getSetting('images_migrated_disable', 'false');
            if (migrated !== 'true') {
                try {
                    const count = await db.bulkDisableImagesForNoAttachment();
                    await db.setSetting('images_migrated_disable', 'true');
                    if (count > 0) {
                        showToast(`✅ 已清理 ${count} 条无图片话术的图片开关`);
                    }
                } catch (e) {
                    // 忽略迁移失败
                }
            }
        }

        // 🚫 桌面版禁用云同步（减少启动时间），同时兼容不支持 SyncManager 的环境
        const shouldInitCloudSync = typeof window.isDesktopApp === 'undefined' || !window.isDesktopApp;
        if (shouldInitCloudSync && typeof SyncManager !== 'undefined') {
            try {
                window.syncManager = new SyncManager(db);
                await window.syncManager.init();
            } catch (syncError) {
                console.warn('⚠️ 云同步初始化失败，已跳过:', syncError);
            }
        } else if (!shouldInitCloudSync) {
            console.info('ℹ️ 当前为桌面环境，已跳过云同步初始化');
        } else {
            console.info('ℹ️ 当前环境不支持 SyncManager，已跳过云同步初始化');
        }
        
        // 初始化客户标签页（在恢复主题之前，确保DOM元素存在）
        initCustomerTabs(true);  // 传入 true 跳过状态恢复

        // ⚡ 优化：并行加载所有可独立操作的任务
        await Promise.all([
            // 恢复分类选择
            restoreLastSelectedCategory().then(() => {
                // 🔧 使用当前激活标签的分类ID，而不是上次选择的分类
                const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
                if (currentTab && currentTab.selectedCategory) {
                    currentSelectedCategoryId = currentTab.selectedCategory;
                }
            }),
            // 恢复字体大小
            restoreFontSize(),
            // 加载排序按钮状态
            updateSortButtonState()
        ]);
        
        // 🎨 恢复主题（优先确保界面色彩正确）
        await restoreTheme();

        // 加载分类和话术（这两个需要串行，因为话术依赖分类）
        // 初始加载时不显示选中背景，避免背景偏移问题
        await loadCategories(false);

        // 🔧 加载分类后，更新一级分类的选中状态（因为loadCategories(false)不显示选中背景）
        updatePrimaryCategoryTilesActiveState();

        // ⚡ 优化：尽早隐藏加载提示，让界面更快显示
        hideLoadingOverlay();

        // 没有标签页时显示提示，不加载话术
        if (customerTabs.length === 0) {
            const phraseList = document.getElementById('phraseList');
            if (phraseList) {
                phraseList.innerHTML = `
                    <div class="empty-state">
                        <p>📋 暂无标签页</p>
                        <p>请在上方分类中选择一个分类开始使用</p>
                    </div>
                `;
            }
        } else {
            const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
            if (currentTab && currentTab.isRecycleBin) {
                await loadRecycleBin();
            } else {
                await loadPhrases();
            }
        }

        // 设置事件监听（需要 await 因为现在是 async 函数）
        await setupEventListeners();

        // 初始化侧边栏标签容器高度
        setupSidebarHeightObserver();

        // 更新钉住按钮状态
        updatePinButtonFromTabState();

        // 🔄 软件启动时自动恢复备份同步
        await autoRestoreBackupSync();
    } catch (error) {
        console.error('❌ 应用初始化失败:', error.message);
        console.error('错误堆栈:', error.stack);
        
        // 隐藏加载提示
        hideLoadingOverlay();
        
        // 显示友好的错误提示
        const errorMsg = `初始化失败: ${error.message}`;
        showToast(errorMsg, 'error');
        
        // 尝试在页面上显示错误
        const container = document.querySelector('.container');
        if (container) {
            container.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #f44336;">
                    <h2>❌ 初始化失败</h2>
                    <p style="margin: 10px 0;">${error.message}</p>
                    <p style="font-size: 12px; color: #999;">请按 F12 打开控制台查看详细错误信息</p>
                    <button onclick="location.reload()" style="margin-top: 15px; padding: 8px 16px; cursor: pointer;">
                        🔄 重新加载
                    </button>
                </div>
            `;
        }
    }
}

// 隐藏加载提示
function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.add('fade-out');
        // 动画结束后移除元素
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
}

// 多种方式确保初始化
if (document.readyState === 'loading') {
    // 文档还在加载中
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    // 文档已经加载完成，立即初始化
    initApp();
}


// 设置事件监听
async function setupEventListeners() {
    try {
        console.log('开始设置事件监听...');
        
        // 搜索框
        const searchInput = document.getElementById('searchInput');
        const clearSearch = document.getElementById('clearSearch');
        const refreshBtn = document.getElementById('refreshBtn');
        const searchDropdown = document.getElementById('searchDropdown');
        
        if (!searchInput || !clearSearch) {
            console.error('❌ 搜索框元素不存在');
            console.error('searchInput:', searchInput);
            console.error('clearSearch:', clearSearch);
            throw new Error('搜索框元素不存在');
        }
        console.log('✅ 搜索框元素找到');
        
        // 刷新按钮事件绑定
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                console.log('🔄 点击了刷新按钮');
                try {
                    // 重新加载分类和话术
                    await loadCategories();
                    await loadPhrases();
                    showToast('✅ 数据已刷新');
                } catch (error) {
                    console.error('刷新失败:', error);
                    showToast('❌ 刷新失败: ' + error.message, 'error');
                }
            });
            console.log('✅ 刷新按钮事件已绑定');
        } else {
            // 桌面版使用 F5 快捷键刷新，不需要刷新按钮
            console.log('ℹ️ 刷新按钮不存在（桌面版使用 F5 快捷键刷新）');
        }
        
        // 不保存或使用最后一次搜索关键词（避免影响字幕/观看体验）
        const getLastSearchKeyword = () => '';
        const saveLastSearchKeyword = (keyword) => { /* noop */ };

        const refreshSearchPlaceholder = () => {
            if (!searchInput) return;
            // 不在 placeholder 中显示历史关键词或提示文字，保持空以不干扰字幕显示
            searchInput.placeholder = '';
        };

        // 保存refreshSearchPlaceholder函数到全局变量
        globalRefreshSearchPlaceholder = refreshSearchPlaceholder;

        // 搜索按钮
        const searchBtn = document.getElementById('searchBtn');
        
        // 执行搜索的函数
        const performSearch = (options = {}) => {
            const {
                useLastKeyword = false,
                shouldRecordHistory = false,
                presetKeyword
            } = options;

            if (typeof presetKeyword === 'string') {
                searchInput.value = presetKeyword;
            }

            let keyword = searchInput.value.trim();
            
            // 不回退到最后一次搜索关键词（避免自动填充）
            
            const hasKeyword = keyword !== '';
            
            // 如果有关键词，检查当前是否在管理页面
            if (hasKeyword) {
                const manageTab = document.getElementById('manageTab');
                const isInManagePage = manageTab && manageTab.classList.contains('active');

                // 如果在管理页面，自动切换到话术页面
                if (isInManagePage) {
                    switchTab('search');
                }

                // 记录搜索历史（只要有关键词就记录）
                recordSearchHistory(keyword);

                // 设置搜索覆盖状态
                searchCoverTabId = activeCustomerTabId;
                isSearchCovering = true;
            } else {
                // 清空搜索时重置覆盖状态
                searchCoverTabId = null;
                isSearchCovering = false;
            }

            loadPhrases();
            // 保存搜索状态到当前标签页
            saveCustomerTabs();
            refreshSearchPlaceholder();
        };

        // 保存performSearch函数到全局变量
        globalPerformSearch = performSearch;

        const handleSearchHistorySelect = (keyword) => {
            const normalizedKeyword = (keyword || '').trim();
            if (!normalizedKeyword) {
                return;
            }
            
            // 立即隐藏placeholder，避免短暂显示
            const searchBox = document.querySelector('.search-box');
            if (searchBox) {
                searchBox.classList.add('input-has-value');
            }
            
            searchInput.value = normalizedKeyword;
            clearSearch.style.display = 'block';

            // 立即更新字幕显示状态，确保字幕被隐藏（因为搜索框现在有值了）
            updateMarqueeVisibility();

            if (searchDropdown) {
                searchDropdown.classList.remove('show');
            }

            performSearch({
                presetKeyword: normalizedKeyword,
                useLastKeyword: false,
                shouldRecordHistory: true
            });
        };

        const searchHistoryOptions = {
            onKeywordSelect: handleSearchHistorySelect
        };

        // 记录搜索历史
        const recordSearchHistory = async (keyword) => {
            try {
                // 从 localStorage 获取搜索历史
                const historyStr = localStorage.getItem('searchHistory');
                let history = historyStr ? JSON.parse(historyStr) : [];

                console.log('[LOG] 记录搜索历史 - 关键词:', keyword);
                console.log('[LOG] 记录搜索历史 - 原始历史:', history);

                // 移除重复的关键词
                const originalLength = history.length;
                history = history.filter(item => item !== keyword);
                console.log('[LOG] 记录搜索历史 - 移除重复后长度:', history.length, '(移除了', originalLength - history.length, '个重复项)');

                // 添加到开头
                history.unshift(keyword);
                console.log('[LOG] 记录搜索历史 - 添加到开头后:', history);

                // 限制最大数量（这里不应该截断存储的历史，只在显示时截断）
                // const maxCapacity = calculateSearchHistoryCapacity();
                // if (history.length > maxCapacity) {
                //     history = history.slice(0, maxCapacity);
                // }

                // 保存到 localStorage（保存完整历史）
                localStorage.setItem('searchHistory', JSON.stringify(history));
                console.log('[LOG] 记录搜索历史 - 保存完成，最终历史:', history);
            } catch (error) {
                console.warn('[LOG] 保存搜索历史失败:', error);
            }
        };

        // 加载搜索历史到下拉框上半部分
        const loadSearchHistory = async () => {
            try {
                const topSection = document.querySelector('.search-dropdown-top');
                if (!topSection) {
                    console.warn('[LOG] 未找到 .search-dropdown-top 元素');
                    return;
                }

                // 从 localStorage 获取搜索历史
                const historyStr = localStorage.getItem('searchHistory');
                let history = [];
                if (historyStr) {
                    try {
                        history = JSON.parse(historyStr);
                        console.log('[LOG] 加载搜索历史 - 原始历史:', history);
                    } catch (parseError) {
                        console.warn('[LOG] 解析搜索历史失败:', parseError);
                        history = [];
                    }
                }

                // 计算能容纳的最大数量并限制显示
                const maxCapacity = calculateSearchHistoryCapacity();
                console.log('[LOG] 加载搜索历史 - 计算的最大容量:', maxCapacity);
                if (history.length > maxCapacity) {
                    const originalLength = history.length;
                    history = history.slice(0, maxCapacity);
                    console.log('[LOG] 加载搜索历史 - 显示时截断:', originalLength, '->', history.length);
                } else {
                    console.log('[LOG] 加载搜索历史 - 无需截断，当前长度:', history.length);
                }

                // 渲染历史列表
                topSection.innerHTML = '';

                if (history.length === 0) {
                    topSection.innerHTML = `
                        <div class="search-history-empty">暂无搜索记录</div>
                    `;
                    console.log('[LOG] 搜索历史为空，显示空状态');
                    return;
                }

                // 创建列表容器
                const listContainer = document.createElement('div');
                listContainer.className = 'search-history-list';

                history.forEach(keyword => {
                    const item = document.createElement('div');
                    item.className = 'search-history-item';
                    item.textContent = keyword;
                    item.addEventListener('click', () => {
                        console.log('[LOG] 点击搜索历史:', keyword);
                        handleSearchHistorySelect(keyword);
                    });
                    listContainer.appendChild(item);
                });

                topSection.appendChild(listContainer);
                console.log('[LOG] 搜索历史加载完成，共', history.length, '条记录');
            } catch (error) {
                console.warn('[LOG] 加载搜索历史失败:', error);
            }
        };
        
        // 输入事件：实时搜索
        searchInput.addEventListener('input', (e) => {
            const value = e.target.value;
            clearSearch.style.display = value ? 'block' : 'none';
            performSearch({ useLastKeyword: false }); // 实时搜索不使用最后搜索关键词
            // 控制字幕显示
            updateMarqueeVisibility();
        });

        searchInput.addEventListener('focus', async () => {
            // 不显示 placeholder（避免遮挡/影响字幕）
            searchInput.placeholder = '';
            // 隐藏字幕
            updateMarqueeVisibility();
            // 显示弹窗
            if (searchDropdown) {
                searchDropdown.classList.add('show');
                await Promise.all([
                    loadSearchHistory(),
                    loadSubCategoryClickHistory()
                ]);
            }
        });

        searchInput.addEventListener('blur', () => {
            refreshSearchPlaceholder();
            // 控制字幕显示
            updateMarqueeVisibility();
            // 隐藏弹窗（延迟执行，以便点击弹窗内容时不会立即关闭）
            if (searchDropdown) {
                setTimeout(() => {
                    searchDropdown.classList.remove('show');
                }, 200);
            }
        });
        
        // 当窗口在操作系统层级失去/获得焦点时也更新字幕显示（处理点击到其他程序窗口的情况）
        window.addEventListener('blur', () => {
            updateMarqueeVisibility();
        });
        window.addEventListener('focus', () => {
            updateMarqueeVisibility();
        });
        
        // 回车键搜索
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSearch({ useLastKeyword: true, shouldRecordHistory: true }); // 按回车时使用最后搜索关键词
            }
        });
        
        // 搜索按钮点击事件
        if (searchBtn) {
            searchBtn.addEventListener('click', () => {
                // 立即隐藏placeholder，避免短暂显示
                const searchBox = document.querySelector('.search-box');
                if (searchBox) {
                    searchBox.classList.add('input-has-value');
                }
                performSearch({ useLastKeyword: true, shouldRecordHistory: true }); // 点击搜索按钮时使用最后搜索关键词
            });
            console.log('✅ 搜索按钮事件已绑定');
        }
        
        // 清除按钮事件
        clearSearch.addEventListener('click', () => {
            searchInput.value = '';
            clearSearch.style.display = 'none';
            performSearch();
            refreshSearchPlaceholder();
            // 清除搜索内容后立即更新字幕显示状态（因为搜索框现在为空了）
            updateMarqueeVisibility();
            // 重置搜索覆盖状态
            searchCoverTabId = null;
            isSearchCovering = false;
        });
        console.log('✅ 搜索框事件已绑定');

        refreshSearchPlaceholder();
        
        // 分类导航已改为左侧边栏，不再需要下拉框事件监听器
        
        // 标签页切换（已移除标签栏，不再需要）
        // const tabBtns = document.querySelectorAll('.tab-btn');
        // console.log(`找到 ${tabBtns.length} 个标签页按钮`);
        // tabBtns.forEach(btn => {
        //     btn.addEventListener('click', () => {
        //         if (btn.id === 'toggleSortModeBtn') {
        //             return;
        //         }
        //         const tabName = btn.dataset.tab;
        //         switchTab(tabName);
        //     });
        // });
        console.log('✅ 标签页已移除，无需绑定切换事件');
        
        // 管理按钮（现在在设置对话框中，可选）
        const addPhraseBtn = document.getElementById('addPhraseBtn');
        const addCategoryBtn = document.getElementById('addCategoryBtn');
        const importBtn = document.getElementById('importBtn');
        const exportBtn = document.getElementById('exportBtn');
        const diagnosticBtn = document.getElementById('diagnosticBtn');
        
        // 这些按钮现在是可选的，因为它们在设置对话框中
        console.log('🔍 检查管理按钮:', {
            addPhraseBtn: !!addPhraseBtn,
            addCategoryBtn: !!addCategoryBtn,
            importBtn: !!importBtn,
            exportBtn: !!exportBtn,
            diagnosticBtn: !!diagnosticBtn
        });
        
        if (addPhraseBtn) {
            addPhraseBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了添加话术按钮');
                openPhraseDialog();
            });
        }
        
        // 悬浮添加话术按钮
        const hoverAddPhraseBtn = document.getElementById('hoverAddPhraseBtn');
        const tabsContainer = document.getElementById('tabsContainer');
        if (hoverAddPhraseBtn && tabsContainer) {
            hoverAddPhraseBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了悬浮添加话术按钮');
                openPhraseDialog();
            });
            
            // 显示按钮的函数（暴露给外部调用）
            window.showHoverAddPhraseBtn = () => {
                if (tabsContainer.classList.contains('show-hover-add-btn')) {
                    hoverAddPhraseBtn.style.opacity = '1';
                    hoverAddPhraseBtn.style.pointerEvents = 'auto';
                    hoverAddPhraseBtn.style.transform = 'translateY(-50%)';
                }
            };
            
            // 隐藏按钮的函数（使用延迟，避免快速移动时闪烁）
            let hideTimeout = null;
            window.hideHoverAddPhraseBtn = () => {
                // 清除之前的延迟
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                }
                // 延迟隐藏，给鼠标移动到按钮上的时间
                hideTimeout = setTimeout(() => {
                    hoverAddPhraseBtn.style.opacity = '0';
                    hoverAddPhraseBtn.style.pointerEvents = 'none';
                    hoverAddPhraseBtn.style.transform = 'translateY(-50%)';
                }, 100);
            };
            
            // 取消隐藏
            const cancelHide = () => {
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }
            };
            
            // 跟踪鼠标是否在"话术"标签按钮上
            let isMouseOverSearchTab = false;
            
            // 检查鼠标是否在"话术"标签按钮上
            window.checkMouseOverTabsContainer = () => {
                return isMouseOverSearchTab;
            };
            
            // 只在"话术"标签按钮上显示悬浮按钮
            const searchTabBtn = document.querySelector('.tab-btn[data-tab="search"]');
            if (searchTabBtn) {
                searchTabBtn.addEventListener('mouseenter', () => {
                    // 只有在"话术"标签页激活时才显示按钮
                    if (searchTabBtn.classList.contains('active')) {
                        isMouseOverSearchTab = true;
                        cancelHide();
                        window.showHoverAddPhraseBtn();
                    }
                });
                
                searchTabBtn.addEventListener('mouseleave', (e) => {
                    isMouseOverSearchTab = false;
                    // 检查鼠标是否移到了按钮上
                    const relatedTarget = e.relatedTarget;
                    if (relatedTarget && (relatedTarget === hoverAddPhraseBtn || hoverAddPhraseBtn.contains(relatedTarget))) {
                        return; // 鼠标移到了按钮上，不隐藏
                    }
                    window.hideHoverAddPhraseBtn();
                });
            }
            
            // 按钮上的事件处理
            hoverAddPhraseBtn.addEventListener('mouseenter', () => {
                cancelHide();
                window.showHoverAddPhraseBtn();
            });
            
            hoverAddPhraseBtn.addEventListener('mouseleave', () => {
                window.hideHoverAddPhraseBtn();
            });
            
            // 设置初始状态（默认"话术"标签页是激活的）
            // searchTabBtn 已经在上面声明了，这里直接使用
            if (searchTabBtn && searchTabBtn.classList.contains('active')) {
                tabsContainer.classList.add('show-hover-add-btn');
            }
            console.log('✅ 悬浮添加话术按钮事件已绑定');
        }
        
        if (addCategoryBtn) {
            addCategoryBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了添加分类按钮');
                // 传入 0 强制默认选中顶级分类
                openCategoryDialog(null, '', 0);
            });
        }
        
        // 侧边栏"设置"按钮（原"添加分类"按钮）
        const addCategorySidebarBtn = document.getElementById('addCategorySidebarBtn');
        if (addCategorySidebarBtn) {
            addCategorySidebarBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了侧边栏设置按钮');
                openSettingsDialog();
            });
        }
        
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了导入按钮（待开发）');
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了导出按钮（待开发）');
            });
        }
        
        // 使用日志按钮
        const usageLogBtn = document.getElementById('usageLogBtn');
        if (usageLogBtn) {
            usageLogBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了使用日志按钮');
                openUsageLogDialog();
            });
        }
    
    // 清除日志按钮
    const clearUsageLogBtn = document.getElementById('clearUsageLogBtn');
    if (clearUsageLogBtn) {
        clearUsageLogBtn.addEventListener('click', async () => {
            const confirmClear = window.confirm('确定清除所有使用统计（话术/分类的使用次数和最后使用时间）吗？此操作不可恢复。');
            if (!confirmClear) return;
            try {
                await db.resetUsageStats();
                showToast('✅ 使用统计已清除');
                // 重新生成日志内容
                const content = document.getElementById('usageLogContent');
                if (content) {
                    content.textContent = await generateUsageLog();
                }
            } catch (error) {
                console.error('清除使用统计失败:', error);
                showToast('❌ 清除使用统计失败: ' + error.message, 'error');
            }
        });
    }
        
        // 数据诊断按钮
        if (diagnosticBtn) {
            diagnosticBtn.addEventListener('click', async () => {
                console.log('🔍 数据诊断按钮被点击');
                console.log('showDiagnosticDialog 类型:', typeof showDiagnosticDialog);
                try {
                    await showDiagnosticDialog();
                    console.log('✅ showDiagnosticDialog 执行完成');
                } catch (error) {
                    console.error('❌ showDiagnosticDialog 执行错误:', error);
                }
            });
            console.log('✅ 数据诊断按钮事件已绑定');
        }

        // 侧边栏"公告解读"按钮
        const announcementBtn = document.getElementById('announcementBtn');
        if (announcementBtn) {
            announcementBtn.addEventListener('click', () => {
                console.log('📢 点击公告解读按钮');

                // 优先使用 Python Bridge 打开外部窗口（桌面应用模式）
                if (window.pythonBridge && typeof window.pythonBridge.open_announcement_dialog === 'function') {
                    try {
                        console.log('📢 尝试通过 Python Bridge 打开公告解读对话框...');
                        window.pythonBridge.open_announcement_dialog();
                        console.log('📢 Python Bridge 调用成功');
                        return;
                    } catch (error) {
                        console.error('❌ 无法通过 Python Bridge 打开公告解读对话框:', error);
                        console.warn('降级到浏览器内嵌模式');
                    }
                } else {
                    console.warn('⚠️ Python Bridge 不可用，将使用浏览器内嵌模式');
                }

                // 降级方案：直接打开HTML文件（仅在浏览器环境中有效）
                try {
                    const announcementUrl = 'announcement-dialog.html';
                    window.open(announcementUrl, 'announcementDialog',
                        'width=900,height=700,scrollbars=yes,resizable=yes,status=no,toolbar=no,menubar=no');
                    console.log('📢 已通过浏览器内嵌模式打开公告解读对话框');
                } catch (fallbackError) {
                    console.error('❌ 浏览器内嵌模式也失败:', fallbackError);
                    showToast('📢 无法打开公告解读对话框', 'error');
                }
            });
            console.log('✅ 公告解读按钮事件已绑定');
        }

        // 侧边栏"排序"按钮
        const toggleSortModeBtn = document.getElementById('toggleSortModeBtn');
        if (toggleSortModeBtn) {
            toggleSortModeBtn.addEventListener('click', toggleSortMode);
            console.log('✅ 排序模式切换按钮事件已绑定');
        }

        // 竖形标签按钮点击事件
        const verticalTabButtons = document.querySelectorAll('.vertical-tab-button');
        verticalTabButtons.forEach(button => {
            button.addEventListener('click', function() {
                // 移除所有按钮的active状态
                verticalTabButtons.forEach(btn => btn.classList.remove('active'));
                // 为当前按钮添加active状态
                this.classList.add('active');
            });
        });
        console.log('✅ 竖形标签按钮事件已绑定');
        
        // 初始化分类右键菜单
        initCategoryContextMenu();
        
        // 分类排序模式切换按钮
        const toggleCategorySortModeBtn = document.getElementById('toggleCategorySortModeBtn');
        if (toggleCategorySortModeBtn) {
            toggleCategorySortModeBtn.addEventListener('click', toggleCategorySortMode);
            console.log('✅ 分类排序模式切换按钮事件已绑定');
        }
        
        // 客户标签页按钮
        const addCustomerTabBtn = document.getElementById('addCustomerTab');
        if (addCustomerTabBtn) {
            addCustomerTabBtn.addEventListener('click', addCustomerTab);
            console.log('✅ 客户标签页按钮事件已绑定');
        }
        
        // 侧边栏添加标签按钮事件（与顶部加号按钮功能同步）
        const addSidebarCustomerTabBtn = document.getElementById('addSidebarCustomerTab');
        if (addSidebarCustomerTabBtn) {
            addSidebarCustomerTabBtn.addEventListener('click', addCustomerTab);
            console.log('✅ 侧边栏客户标签页按钮事件已绑定');
        }
        


        
        // 标签滚轮滚动事件
        const customerTabs = document.getElementById('customerTabs');
        if (customerTabs) {
            customerTabs.addEventListener('wheel', (e) => {
                // 阻止默认的垂直滚动
                e.preventDefault();
                // 水平滚动，滚轮向下为正值，向上为负值
                customerTabs.scrollBy({ left: e.deltaY, behavior: 'smooth' });
            });
            
            console.log('✅ 标签滚轮滚动事件已绑定');
        }
        
        // 快速功能按钮
        const addPhraseQuickBtn = document.getElementById('addPhraseQuickBtn');
        const settingsQuickBtn = document.getElementById('settingsQuickBtn');
        
        if (addPhraseQuickBtn) {
            addPhraseQuickBtn.addEventListener('click', () => {
                console.log('[LOG] 点击了快速添加话术按钮');
                openPhraseDialog();
            });
        }
        
        if (settingsQuickBtn) {
            console.log('✅ 找到+分类按钮，绑定点击事件');
            settingsQuickBtn.addEventListener('click', () => {
                console.log('🎯 点击了+分类按钮！');
                // 传入 0 强制默认选中顶级分类
                openCategoryDialog(null, '', 0);
            });
        } else {
            console.error('❌ 未找到+分类按钮 #settingsQuickBtn');
        }
        
        // 侧边栏添加标签按钮（与顶部标签栏加号按钮功能同步）
        const addSidebarCategoryBtn = document.getElementById('addSidebarCategoryBtn');
        if (addSidebarCategoryBtn) {
            addSidebarCategoryBtn.addEventListener('click', addCustomerTab);
        }
        
        // 字体大小调节按钮
        const fontDecreaseBtn = document.getElementById('fontDecreaseBtn');
        const fontIncreaseBtn = document.getElementById('fontIncreaseBtn');
        
        if (fontDecreaseBtn && fontIncreaseBtn) {
            fontDecreaseBtn.addEventListener('click', decreaseFontSize);
            fontIncreaseBtn.addEventListener('click', increaseFontSize);
            console.log('✅ 字体调节按钮事件已绑定');
        }
        
        // 空状态的"添加话术"按钮
        const emptyAddPhraseBtn = document.getElementById('emptyAddPhraseBtn');
        if (emptyAddPhraseBtn) {
            emptyAddPhraseBtn.addEventListener('click', () => openPhraseDialog());
            console.log('✅ 空状态添加话术按钮事件已绑定');
        }

        // 空状态的"添加分类"按钮
        const emptyAddCategoryBtn = document.getElementById('emptyAddCategoryBtn');
        if (emptyAddCategoryBtn) {
            emptyAddCategoryBtn.addEventListener('click', () => openCategoryDialog(0));
            console.log('✅ 空状态添加分类按钮事件已绑定');
        }
        
        // 🎨 主题颜色切换按钮
        const themeColorBoxes = document.querySelectorAll('.theme-color-box');
        if (themeColorBoxes.length > 0) {
            themeColorBoxes.forEach(box => {
                box.addEventListener('click', async () => {
                    const theme = box.dataset.theme;
                    console.log('[LOG] 🎨 主题颜色框被点击，主题:', theme);
                    await changeTheme(theme);
                });
            });
            console.log('[LOG] ✅ 主题颜色切换按钮事件已绑定，共', themeColorBoxes.length, '个按钮');
        } else {
            console.warn('[LOG] ⚠️ 未找到主题颜色切换按钮');
        }
        
        // 样式清除按钮
        const clearTextColorBtn = document.getElementById('clearTextColor');
        const clearBgColorBtn = document.getElementById('clearBgColor');
        const applyStyleBtn = document.getElementById('applyStyleBtn');
        
        if (clearTextColorBtn) {
            clearTextColorBtn.addEventListener('click', () => {
                // 清除选中文字的文字颜色样式
                clearStyleFromSelection('textColor');
                // 重置颜色选择器为默认值
                const textColorEl = document.getElementById('phraseTextColor');
                if (textColorEl) {
                    textColorEl.value = '#333333';
                    const textColorDisplay = document.getElementById('phraseTextColorDisplay');
                    if (textColorDisplay) {
                        textColorDisplay.style.background = '#333333';
                    }
                }
            });
        }
        if (clearBgColorBtn) {
            clearBgColorBtn.addEventListener('click', () => {
                // 清除选中文字的背景颜色样式
                clearStyleFromSelection('bgColor');
                // 重置颜色选择器为默认值
                const bgColorEl = document.getElementById('phraseBgColor');
                if (bgColorEl) {
                    bgColorEl.value = '#ffffff';
                    const bgColorDisplay = document.getElementById('phraseBgColorDisplay');
                    if (bgColorDisplay) {
                        bgColorDisplay.style.background = '#ffffff';
                    }
                }
            });
        }
        
        // 自动应用样式到选中文字（当样式控件改变时）
        const textColorEl = document.getElementById('phraseTextColor');
        const bgColorEl = document.getElementById('phraseBgColor');
        const isBoldEl = document.getElementById('phraseIsBold');
        
        // 为样式控件添加change事件，自动应用到选中文字
        if (textColorEl) {
            textColorEl.addEventListener('change', () => {
                // 更新显示的颜色背景
                const displayEl = document.getElementById('phraseTextColorDisplay');
                if (displayEl) {
                    displayEl.style.background = textColorEl.value;
                }
                applyStyleToSelection('textColor');
            });
        }
        if (bgColorEl) {
            bgColorEl.addEventListener('change', () => {
                // 更新显示的颜色背景
                const displayEl = document.getElementById('phraseBgColorDisplay');
                if (displayEl) {
                    displayEl.style.background = bgColorEl.value;
                }
                applyStyleToSelection('bgColor');
            });
        }
        if (isBoldEl) {
            isBoldEl.addEventListener('change', () => {
                applyStyleToSelection('bold');
            });
        }
        
        // 设置项（只保留字幕设置）
        // 旧的字幕设置已移除，使用新的字幕开关
        
        console.log('✅ 设置项事件已绑定');
        
        // 话术对话框
        console.log('设置话术对话框事件...');
        const phraseDialog = document.getElementById('phraseDialog');
        const phraseDialogContent = document.querySelector('#phraseDialog .dialog');
        const phraseDialogCloseBtn = document.querySelector('#phraseDialog .close-btn');
        const phraseDialogCancelBtn = document.querySelector('#phraseDialog .btn-secondary');
        const phraseDialogSaveBtn = document.querySelector('#phraseDialog .btn-primary');
        
        // 点击背景关闭对话框
        if (phraseDialog) {
            phraseDialog.addEventListener('click', (e) => {
                if (e.target === phraseDialog) {
                    console.log('点击背景关闭话术对话框');
                    closePhraseDialog();
                }
            });
            console.log('  → 话术对话框背景点击事件已绑定');
        }
        
        // 阻止对话框内容的点击事件冒泡
        if (phraseDialogContent) {
            phraseDialogContent.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        // 话术内容输入框：粘贴时去掉格式，只保留纯文本
        const phraseContentEl = document.getElementById('phraseContent');
        if (phraseContentEl) {
            phraseContentEl.addEventListener('paste', (e) => {
                e.preventDefault();
                const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
                if (text) document.execCommand('insertText', false, text);
            });
            // 内容变化时检查是否含 {***}，决定补全复选框是否可勾选
            const enablePlaceholderEl = document.getElementById('enablePlaceholder');
            const checkPlaceholder = () => {
                const content = phraseContentEl.value || phraseContentEl.textContent || '';
                const hasPlaceholder = /\{[^}]+\}/.test(content);
                if (enablePlaceholderEl) {
                    enablePlaceholderEl.disabled = !hasPlaceholder;
                    if (!hasPlaceholder) enablePlaceholderEl.checked = false;
                }
            };
            phraseContentEl.addEventListener('input', checkPlaceholder);
            // 初始化时也检查一次
            checkPlaceholder();
        }
        
        if (phraseDialogCloseBtn) {
            phraseDialogCloseBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dbgLog('关闭按钮被点击（事件监听器）');
                closePhraseDialog();
            });
            console.log('  → 话术对话框关闭按钮事件已绑定');
        } else {
            console.warn('  ⚠️ 话术对话框关闭按钮未找到');
        }
        
        if (phraseDialogCancelBtn) {
            phraseDialogCancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('取消按钮被点击（事件监听器）');
                closePhraseDialog();
            });
            console.log('  → 话术对话框取消按钮事件已绑定');
        } else {
            console.warn('  ⚠️ 话术对话框取消按钮未找到');
        }
        
        if (phraseDialogSaveBtn) {
            phraseDialogSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('保存按钮被点击（事件监听器）');
                savePhraseDialog();
            });
            console.log('  → 话术对话框保存按钮事件已绑定');
        } else {
            console.warn('  ⚠️ 话术对话框保存按钮未找到');
        }
        
        // 分类对话框
        console.log('设置分类对话框事件...');
        const categoryDialog = document.getElementById('categoryDialog');
        const categoryDialogContent = document.querySelector('#categoryDialog .dialog');
        const categoryDialogCloseBtn = categoryDialog?.querySelector('.close-btn');
        const categoryDialogCancelBtn = categoryDialog?.querySelector('.btn-secondary');
        const categoryDialogSaveBtn = document.getElementById('categoryDialogSaveBtn');
        
        // 点击背景关闭对话框
        if (categoryDialog) {
            categoryDialog.addEventListener('click', (e) => {
                if (e.target === categoryDialog) {
                    console.log('点击背景关闭分类对话框');
                    closeCategoryDialog();
                }
            });
            console.log('  → 分类对话框背景点击事件已绑定');
        }
        
        // 阻止对话框内容的点击事件冒泡
        if (categoryDialogContent) {
            categoryDialogContent.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        
        if (categoryDialogCloseBtn) {
            categoryDialogCloseBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeCategoryDialog();
            });
            console.log('  → 分类对话框关闭按钮事件已绑定');
        }
        
        if (categoryDialogCancelBtn) {
            categoryDialogCancelBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeCategoryDialog();
            });
            console.log('  → 分类对话框取消按钮事件已绑定');
        }
        
        if (categoryDialogSaveBtn) {
            categoryDialogSaveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                saveCategoryDialog();
            });
            console.log('  → 分类对话框保存按钮事件已绑定');
        }
        
        // 分类列表的事件委托（用于编辑和删除按钮）
        const categoryList = document.getElementById('categoryList');
        if (categoryList) {
            categoryList.addEventListener('click', (e) => {
                // 编辑按钮
                if (e.target.classList.contains('edit-category-btn')) {
                    const categoryId = parseInt(e.target.dataset.id);
                    const categoryName = e.target.dataset.name;
                    console.log('点击编辑分类:', categoryId, categoryName);
                    editCategory(categoryId, categoryName);
                }
                // 删除按钮
                else if (e.target.classList.contains('delete-category-btn')) {
                    const categoryId = parseInt(e.target.dataset.id);
                    console.log('点击删除分类:', categoryId);
                    deleteCategory(categoryId);
                }
            });
            console.log('✅ 分类列表事件委托已绑定');
        }
        
        // 上班按钮事件
        const workBtn = document.getElementById('workBtn');
        if (workBtn) {
            workBtn.addEventListener('click', toggleWorkPopover);
            console.log('✅ 上班按钮事件已绑定');
        }
        
        // 上班弹窗关闭按钮事件
        const closeWorkPopoverBtn = document.getElementById('closeWorkPopover');
        if (closeWorkPopoverBtn) {
            closeWorkPopoverBtn.addEventListener('click', closeWorkPopover);
            console.log('✅ 上班弹窗关闭按钮事件已绑定');
        }
        
        // 添加浏览器按钮事件
        const addBrowserBtn = document.getElementById('addBrowserBtn');
        if (addBrowserBtn) {
            addBrowserBtn.addEventListener('click', openFileDialog);
            console.log('✅ 添加浏览器按钮事件已绑定');
        }
        
        // 初始化浏览器快捷方式
        loadBrowserShortcuts();

        // 🎯 事件委托：序号和图片指示器的不抢焦点模式
        const phraseList = document.getElementById('phraseList');
        if (phraseList) {
            // 鼠标进入序号或图片指示器
            phraseList.addEventListener('mouseenter', (e) => {
                const target = e.target;
                // 检查是否是序号占位元素或其子元素
                if (target.classList && (target.classList.contains('phrase-number-placeholder') ||
                    target.closest('.phrase-number-placeholder'))) {
                    console.log('[JS] 鼠标进入序号占位元素（事件委托）');
                    // 添加蓝色样式
                    const phraseItem = target.closest('.phrase-item');
                    if (phraseItem) {
                        const contentEl = phraseItem.querySelector('.phrase-content');
                        if (contentEl) {
                            contentEl.classList.add('hovering-number');
                        }
                    }
                    // 启用不抢焦点模式
                    try {
                        if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                            window.pythonBridge.enable_no_focus_mode();
                        }
                    } catch (error) {
                        // ignore
                    }
                }
                // 检查是否是图片指示器或其子元素
                else if (target.classList && (target.classList.contains('phrase-image-indicator') ||
                    target.closest('.phrase-image-indicator'))) {
                    console.log('[JS] 鼠标进入图片图标（事件委托）');
                    try {
                        if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                            window.pythonBridge.enable_no_focus_mode();
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }, true);  // 使用捕获阶段

            // 鼠标离开序号或图片指示器
            phraseList.addEventListener('mouseleave', (e) => {
                const target = e.target;
                // 检查是否是序号占位元素或其子元素
                if (target.classList && (target.classList.contains('phrase-number-placeholder') ||
                    target.closest('.phrase-number-placeholder'))) {
                    console.log('[JS] 鼠标离开序号占位元素（事件委托）');
                    // 移除蓝色样式
                    const phraseItem = target.closest('.phrase-item');
                    if (phraseItem) {
                        const contentEl = phraseItem.querySelector('.phrase-content');
                        if (contentEl) {
                            contentEl.classList.remove('hovering-number');
                        }
                    }
                    // 禁用不抢焦点模式
                    try {
                        if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                            window.pythonBridge.disable_no_focus_mode();
                        }
                    } catch (error) {
                        // ignore
                    }
                }
                // 检查是否是图片指示器或其子元素
                else if (target.classList && (target.classList.contains('phrase-image-indicator') ||
                    target.closest('.phrase-image-indicator'))) {
                    console.log('[JS] 鼠标离开图片图标（事件委托）');
                    try {
                        if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                            window.pythonBridge.disable_no_focus_mode();
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }, true);  // 使用捕获阶段

            console.log('✅ 不抢焦点模式事件委托已绑定');
        }

        // 初始化搜索框
        console.log('✅ 所有事件监听器设置成功');
    } catch (error) {
        console.error('❌ 设置事件监听时出错:', error);
    }
}

// 切换标签页
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${tabName}Tab`);
    });
    
    // 控制悬浮添加话术按钮的显示（只在"话术"标签页时显示）
    const hoverAddPhraseBtn = document.getElementById('hoverAddPhraseBtn');
    const tabsContainer = document.getElementById('tabsContainer');
    if (hoverAddPhraseBtn && tabsContainer) {
        if (tabName === 'search') {
            tabsContainer.classList.add('show-hover-add-btn');
            // 切换到"话术"标签页时，短暂显示按钮
            // 如果鼠标在容器上，则保持显示；否则短暂显示后隐藏
            if (window.showHoverAddPhraseBtn) {
                window.showHoverAddPhraseBtn();
                // 延迟检查鼠标是否在容器上
                setTimeout(() => {
                    if (window.checkMouseOverTabsContainer && !window.checkMouseOverTabsContainer()) {
                        // 鼠标不在容器上，隐藏按钮
                        if (window.hideHoverAddPhraseBtn) {
                            window.hideHoverAddPhraseBtn();
                        }
                    }
                    // 如果鼠标在容器上，按钮会保持显示（因为mouseenter事件会处理）
                }, 800); // 显示0.8秒后检查
            }
        } else {
            tabsContainer.classList.remove('show-hover-add-btn');
            // 立即隐藏按钮（如果当前正在显示）
            hoverAddPhraseBtn.style.opacity = '0';
            hoverAddPhraseBtn.style.pointerEvents = 'none';
            hoverAddPhraseBtn.style.transform = 'translateY(-50%)';
        }
    }
    
    if (tabName === 'manage') {
        loadCategoryList();
    }
}

// 加载分类（用于筛选）
// showActiveState: 是否显示选中状态的背景（默认true，初始加载时传false避免偏移）
async function loadCategories(showActiveState = true) {
    const categories = await db.getAllCategories();
    allCategoriesCache = categories;
    const recycleCategory = categories.find(cat => isRecycleCategory(cat));
    
    const categoryNav = document.getElementById('primaryCategoryTiles') || document.getElementById('categoryNav');
    const phraseCategory = document.getElementById('phraseCategory');
    
    if (!categoryNav || !phraseCategory) {
        console.error('❌ 分类导航元素不存在');
        return;
    }
    
    categoryNav.innerHTML = '';

    // 🔍 先找到当前选中分类的父级一级分类ID（用于active判断）
    let parentCategoryIdToKeep = null;
    if (currentSelectedCategoryId && showActiveState) {
        const selectedCat = categories.find(c => c.id.toString() === currentSelectedCategoryId);
        if (selectedCat && getCategoryParentId(selectedCat) !== 0) {
            // 选中的是二级分类，找到其父级一级分类ID
            parentCategoryIdToKeep = getCategoryParentId(selectedCat).toString();
            console.log('🔍 loadCategories - 选中二级分类，父级一级分类ID:', parentCategoryIdToKeep);
            if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                window.pythonBridge.log_to_terminal(`🔍 loadCategories - 选中二级分类，父级一级分类ID: ${parentCategoryIdToKeep}`);
            }
        }
    }

    if (_orphanPhraseCount < 0) {
        const orphans = await db.searchPhrases('', 0);
        _orphanPhraseCount = orphans.length;
    }

    if (_orphanPhraseCount > 0) {
        const orphanItem = document.createElement('div');
        orphanItem.className = 'category-nav-item' + (currentSelectedCategoryId === '0' ? ' active' : '');
        orphanItem.innerHTML = `
            <span>📦 未分类 (${_orphanPhraseCount})</span>
        `;
        orphanItem.addEventListener('click', () => selectCategory(0));
        categoryNav.appendChild(orphanItem);
    }

    // 🔍 检查当前选中的分类是否是二级分类（仅用于 active 判断，不做 parent-located 标记）
    // 各个分类选项（仅顶级，排除回收站 id=1）
    categories.forEach(cat => {
        if (isRecycleCategory(cat)) return;
        if (getCategoryParentId(cat) !== 0) return; // 只显示顶级分类

        const item = document.createElement('div');
        // 根据参数决定是否添加 active 类
        // 1. 直接选中一级分类
        // 2. 选中二级分类时，其父级一级分类也保持active状态
        const isActive = showActiveState && (
            currentSelectedCategoryId === cat.id.toString() ||
            (parentCategoryIdToKeep && parentCategoryIdToKeep === cat.id.toString())
        );
        item.className = 'category-nav-item' + (isActive ? ' active' : '');
        item.dataset.id = String(cat.id);

        const labelSpan = document.createElement('span');
        labelSpan.className = 'cat-label';
        labelSpan.textContent = cat.name;
        item.appendChild(labelSpan);

        if (cat.show_text_editor === true) {
            const textIconBtn = document.createElement('button');
            textIconBtn.type = 'button';
            textIconBtn.className = 'category-text-editor-btn';
            textIconBtn.textContent = '📝';
            textIconBtn.title = '打开文本编辑器';
            textIconBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await openCategoryTextEditor(cat.id, cat.name);
            });
            item.appendChild(textIconBtn);
        }

        // 点击行为：如果该分类被标记为“作为按钮显示”，点击不切换分类（预留后续自定义行为）
        item.addEventListener('click', () => selectCategory(cat.id));
        
        // 绑定右键菜单事件
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCategoryContextMenu(e, cat.id);
        });

        if (isCategorySortModeActive) {
            item.draggable = true;
            item.addEventListener('dragstart', handleNavCategoryDragStart);
            item.addEventListener('dragover', handleNavCategoryDragOver);
            item.addEventListener('dragleave', handleNavCategoryDragLeave);
            item.addEventListener('drop', handleNavCategoryDrop);
            item.addEventListener('dragend', handleNavCategoryDragEnd);
        }

        // 悬浮显示二级分类弹层（仅顶级分类且存在子分类时）
        const catIdNum = getCategoryId(cat);
        const children = categories.filter(c => getCategoryParentId(c) === catIdNum);
        if (getCategoryParentId(cat) === 0 && children.length > 0) {
            const clearHideTimer = (pop) => {
                const timer = popoverHideTimers.get(pop);
                if (timer) {
                    clearTimeout(timer);
                    popoverHideTimers.delete(pop);
                }
            };
            
            const setHideTimer = (pop, delay = 300) => {
                clearHideTimer(pop);
                const timer = setTimeout(() => {
                    // 隐藏前再次检查右键菜单是否显示
                    const contextMenu = document.getElementById('categoryContextMenu');
                    if (contextMenu && contextMenu.classList.contains('show')) {
                        // 如果右键菜单显示，不隐藏弹层，重新设置定时器
                        setHideTimer(pop, 300);
                        return;
                    }
                    pop.classList.remove('visible');
                    popoverHideTimers.delete(pop);
                }, delay);
                popoverHideTimers.set(pop, timer);
            };
            
            // ⚠️ 弹层模式说明（PyQt 桌面版）
            // 当前 PyQt 根目录版本中，只推荐和持续优化「平铺模式（tabs）」。
            // 下面的 showPopover 逻辑仅作为历史兼容代码保留，UI 中也已经将弹层模式单选项禁用。
            // 后续如需调整二级分类交互，请优先考虑 tabs 平铺区域，而不要再投入时间优化弹层样式/动效。
            const showPopover = async () => {
                // 🆕 检查二级分类显示模式，如果是平铺模式则不显示弹层
                const subcategoryMode = await db.getSetting('subcategoryDisplayMode', 'tabs');
                if (subcategoryMode === 'tabs') {
                    console.log('[CAT] 平铺模式下不显示弹层');
                    return;
                }
                
                // 🔧 立即关闭所有其他弹层，避免重叠
                document.querySelectorAll(`.subcategory-popover[data-parent]:not([data-parent='${cat.id}'])`).forEach(otherPop => {
                    clearHideTimer(otherPop);
                    otherPop.classList.remove('visible');
                });
                
                let pop = document.querySelector(`.subcategory-popover[data-parent='${cat.id}']`);
                if (!pop) {
                    pop = document.createElement('div');
                    pop.classList.add('subcategory-popover');
                    pop.dataset.parent = String(cat.id);
                    pop.innerHTML = `
                        <div class="popover-list"></div>
                    `;
                    // 修复：确保 document.body 存在再调用 appendChild
                    if (document.body) {
                    document.body.appendChild(pop);
                    console.log('[CAT] 创建弹层元素 parent=', cat.id);
                    } else {
                        console.error('[CAT] document.body 不存在，无法创建弹层');
                        return;
                    }
                    
                    // 只在创建时绑定一次事件监听器，避免重复绑定
                    pop.addEventListener('mouseenter', () => {
                        clearHideTimer(pop);
                    });
                    
                    pop.addEventListener('mouseleave', () => {
                        // 缩短延迟隐藏时间到 150ms，减少重叠
                        setHideTimer(pop, 150);
                    });
                } else {
                    // 如果弹层已存在，清除之前的定时器
                    clearHideTimer(pop);
                }
                const activeThemeClass = getActiveThemeClass();
                if (activeThemeClass) {
                    applyThemeClass(pop, activeThemeClass);
                }
                let list = pop.querySelector('.popover-list');
                if (!list) {
                    // 兼容旧结构：动态补上列表容器
                    list = document.createElement('div');
                    list.className = 'popover-list';
                    pop.appendChild(list);
                }
                list.innerHTML = '';
                console.log('[CAT] 顶级分类', cat.id, cat.name, '子分类数量=', children.length);
                children.forEach(ch => {
                    const row = document.createElement('div');
                    row.className = 'popover-item';
                    row.dataset.id = String(ch.id);
                    row.dataset.parentId = String(cat.id);
                    if (String(ch.id) === currentSelectedCategoryId) {
                        row.classList.add('active');
                    }

                    if (isCategorySortModeActive) {
                        row.draggable = true;
                        row.addEventListener('dragstart', handleSubcategoryDragStart);
                        row.addEventListener('dragover', handleSubcategoryDragOver);
                        row.addEventListener('dragleave', handleSubcategoryDragLeave);
                        row.addEventListener('drop', handleSubcategoryDrop);
                        row.addEventListener('dragend', handleSubcategoryDragEnd);
                    } else {
                        row.draggable = false;
                    }
                    
                    // 创建分类名称容器
                    const nameContainer = document.createElement('div');
                    nameContainer.className = 'popover-item-name-container';
                    
                    // 创建分类名称
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'popover-item-name';
                    nameSpan.textContent = ch.name;
                    nameContainer.appendChild(nameSpan);
                    
                    // 只有当 show_text_editor 为 true 时才创建按钮
                    const showTextEditor = ch.show_text_editor === true;
                    let textIconBtn = null;
                    if (showTextEditor) {
                        // 创建文本图标按钮（沿用原有 emoji）
                        textIconBtn = document.createElement('button');
                        textIconBtn.className = 'popover-text-icon-btn';
                        textIconBtn.textContent = '📝';
                        textIconBtn.title = '打开文本编辑器';
                        textIconBtn.style.display = 'inline-flex';
                        textIconBtn.style.alignItems = 'center';
                        textIconBtn.style.justifyContent = 'center';
                        textIconBtn.style.background = 'transparent';
                        textIconBtn.style.border = 'none';
                        textIconBtn.style.padding = '0';
                        textIconBtn.style.fontSize = '14px';
                        textIconBtn.style.lineHeight = '1';
                        textIconBtn.style.cursor = 'pointer';
                        textIconBtn.style.opacity = '0.8';
                        textIconBtn.addEventListener('click', async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            hidePopover();
                            await openCategoryTextEditor(ch.id, ch.name);
                        });
                    }
                    
                    if (textIconBtn) {
                        nameContainer.appendChild(textIconBtn);
                    }
                    row.appendChild(nameContainer);
                    
                    row.addEventListener('click', async (e) => {
                        // 如果点击的是文本图标按钮，不触发分类选择
                        if (e.target.classList.contains('popover-text-icon-btn')) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();

                        // 立即更新视觉反馈：清除同容器内已有 active，再为当前按钮添加 active
                        try {
                            const listEl = row.parentElement;
                            if (listEl) {
                                listEl.querySelectorAll('.popover-item.active').forEach(el => el.classList.remove('active'));
                            }
                            row.classList.add('active');
                        } catch (err) {
                            console.warn('[UI] 更新弹层按钮 active 状态失败', err);
                        }

                        hidePopover();

                        // 保存二级分类点击记录
                        await saveSubCategoryClickHistory(ch.id, ch.name, cat.id, cat.name);

                        await selectCategory(ch.id);
                    });
                    
                    // 绑定右键菜单事件（二级分类-弹层）
                    row.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        showCategoryContextMenu(e, ch.id);
                    });
                    list.appendChild(row);
                });
                const rect = item.getBoundingClientRect();
                let left = Math.round(rect.right + 6);
                
                // 防止超出右侧，必要时显示在左侧
                const estimatedWidth = 240;
                if (left + estimatedWidth > window.innerWidth) {
                    left = Math.max(10, Math.round(rect.left - estimatedWidth - 6));
                }
                
                // 🔧 智能判断向上还是向下显示
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;
                const estimatedHeight = Math.min(600, children.length * 36 + 50); // 估算弹层高度
                
                let top;
                let maxHeight;

                // 如果下方空间不足且上方空间更大，向上显示；否则向下显示。
                // 使用可用空间作为 maxHeight（不再硬限制为 600px），并保留最小高度 180px。
                if (spaceBelow < estimatedHeight && spaceAbove > spaceBelow) {
                    // 向上显示：可用高度为 rect.top - 10（离页面顶 10px）
                    maxHeight = Math.max(180, Math.floor(rect.top - 10));
                    top = Math.max(10, Math.round(rect.top - maxHeight));
                    console.log('[CAT] 向上显示弹层 (使用可用高度)', { maxHeight });
                } else {
                    // 向下显示：可用高度为 window.innerHeight - rect.top - 10（离页面底 10px）
                    maxHeight = Math.max(180, Math.floor(window.innerHeight - rect.top - 10));
                    top = Math.round(rect.top);
                    console.log('[CAT] 向下显示弹层 (使用可用高度)', { maxHeight });
                }

                pop.style.left = `${left}px`;
                pop.style.top = `${top}px`;
                pop.style.maxHeight = `${maxHeight}px`;
                console.log('[CAT] 显示弹层 at', { left, top, maxHeight, spaceBelow, spaceAbove });
                pop.classList.add('visible');
            };
            const hidePopover = () => {
                const pop = document.querySelector(`.subcategory-popover[data-parent='${cat.id}']`);
                if (pop) {
                    clearHideTimer(pop);
                    pop.classList.remove('visible');
                }
            };
            const hideLater = () => {
                const pop = document.querySelector(`.subcategory-popover[data-parent='${cat.id}']`);
                if (pop) {
                    setHideTimer(pop, 150);
                }
            };
            item.addEventListener('mouseenter', showPopover);
            item.addEventListener('mouseleave', hideLater);
        }
        categoryNav.appendChild(item);
    });
    
    // 🎬 更新滑动指示器位置
    updateCategoryIndicator();
    
    

    // 📏 计算并设置侧边栏最小宽度（延迟确保DOM完全渲染）
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            calculateAndSetSidebarMinWidth();
        });
    });

    // 更新编辑对话框的分类下拉框（使用自定义下拉框）
    // 先按父级分组，确保正确的层级关系
    const categoryGroups = {};
    const rootCategories = [];

    categories.forEach(cat => {
        const parentId = cat.parent_id || 0;
        if (parentId === 0) {
            rootCategories.push(cat);
        } else {
            if (!categoryGroups[parentId]) {
                categoryGroups[parentId] = [];
            }
            categoryGroups[parentId].push(cat);
        }
    });

    const dropdown = phraseCategory.querySelector('.custom-select-dropdown');
    if (dropdown) {
        dropdown.innerHTML = '';

        // 渲染可折叠分组结构
        rootCategories.forEach(cat => {
            const subCategories = categoryGroups[cat.id] || [];
            const hasSubCategories = subCategories.length > 0;

            // 创建分组容器
            const group = document.createElement('li');
            group.className = 'custom-select-group';
            group.dataset.categoryId = cat.id;

            // 创建分组标题（一级分类）
            const header = document.createElement('div');
            header.className = 'custom-select-group-header';
            header.dataset.value = cat.id;
            header.setAttribute('role', 'option');

            // 箭头图标（有子分类时才显示）
            if (hasSubCategories) {
                const arrow = document.createElement('span');
                arrow.className = 'custom-select-group-arrow';
                arrow.textContent = '▶';
                header.appendChild(arrow);
            } else {
                // 没有子分类时添加占位，保持对齐
                const spacer = document.createElement('span');
                spacer.className = 'custom-select-group-arrow';
                spacer.style.visibility = 'hidden';
                header.appendChild(spacer);
            }

            // 标题文本
            const title = document.createElement('span');
            title.className = 'custom-select-group-title';
            title.textContent = cat.name.replace(/^🗑️/, '');
            header.appendChild(title);

            group.appendChild(header);

            // 创建二级分类容器
            if (hasSubCategories) {
                const itemsContainer = document.createElement('ul');
                itemsContainer.className = 'custom-select-group-items';

                subCategories.forEach(subCat => {
                    const subLi = document.createElement('li');
                    subLi.className = 'custom-select-option';
                    subLi.dataset.value = subCat.id;
                    subLi.dataset.parentId = cat.id;
                    subLi.textContent = subCat.name.replace(/^🗑️/, '');
                    subLi.setAttribute('role', 'option');
                    itemsContainer.appendChild(subLi);
                });

                group.appendChild(itemsContainer);
            }

            dropdown.appendChild(group);
        });

        // 初始化自定义下拉框事件
        initCustomSelect('phraseCategory');
    }

    // 初始化跳转分类下拉框（自定义可折叠分组样式）
    const phraseJumpCategory = document.getElementById('phraseJumpCategory');
    if (phraseJumpCategory) {
        const jumpDropdown = phraseJumpCategory.querySelector('.custom-select-dropdown');
        if (jumpDropdown) {
            jumpDropdown.innerHTML = '';

            const noJumpLi = document.createElement('li');
            noJumpLi.className = 'custom-select-option selected';
            noJumpLi.dataset.value = '';
            noJumpLi.setAttribute('role', 'option');
            noJumpLi.textContent = '-- 不跳转 --';
            jumpDropdown.appendChild(noJumpLi);

            rootCategories.forEach(cat => {
                if (isRecycleCategory(cat)) return;

                const group = document.createElement('li');
                group.className = 'custom-select-group';
                group.dataset.categoryId = cat.id;

                const subCategories = categoryGroups[cat.id] || [];
                const hasSubCategories = subCategories.length > 0;

                const header = document.createElement('div');
                header.className = 'custom-select-group-header';
                header.dataset.value = cat.id;
                header.setAttribute('role', 'option');

                if (hasSubCategories) {
                    const arrow = document.createElement('span');
                    arrow.className = 'custom-select-group-arrow';
                    arrow.textContent = '▶';
                    header.appendChild(arrow);
                } else {
                    const spacer = document.createElement('span');
                    spacer.className = 'custom-select-group-arrow';
                    spacer.style.visibility = 'hidden';
                    header.appendChild(spacer);
                }

                const title = document.createElement('span');
                title.className = 'custom-select-group-title';
                title.textContent = cat.name.replace(/^🗑️/, '');
                header.appendChild(title);
                group.appendChild(header);

                if (hasSubCategories) {
                    const itemsContainer = document.createElement('ul');
                    itemsContainer.className = 'custom-select-group-items';
                    subCategories.forEach(subCat => {
                        if (isRecycleCategory(subCat)) return;
                        const subLi = document.createElement('li');
                        subLi.className = 'custom-select-option';
                        subLi.dataset.value = subCat.id;
                        subLi.dataset.parentId = cat.id;
                        subLi.textContent = subCat.name.replace(/^🗑️/, '');
                        subLi.setAttribute('role', 'option');
                        itemsContainer.appendChild(subLi);
                    });
                    group.appendChild(itemsContainer);
                }

                jumpDropdown.appendChild(group);
            });

            initCustomSelect('phraseJumpCategory');
        }
    }

    // 容器空白区域右键 → 只显示"添加分类"
    categoryNav.addEventListener('contextmenu', (e) => {
        if (e.target === categoryNav || e.target.classList.contains('category-nav-scroll')) {
            e.preventDefault();
            window._isBlankAreaRightClick = true;
            showCategoryContextMenu(e, 0);
        }
    });

    ensureSubcategoryPopoverOutsideHandler();
}

// 💾 恢复上次选择的分类
async function restoreLastSelectedCategory() {
    // 没有标签页时不恢复分类选择
    if (customerTabs.length === 0) {
        currentSelectedCategoryId = '';
        return;
    }
    try {
        const result = await chrome.storage.local.get(['lastSelectedCategory']);
        const categories = await db.getAllCategories();
        const recycleCategory = categories.find(cat => isRecycleCategory(cat));
        const firstRegularCategory = getFirstNonRecycleCategory(categories);

        if (result.lastSelectedCategory !== undefined) {
            const storedValue = result.lastSelectedCategory;
            if (storedValue === '1' || storedValue === 1) {
                if (recycleCategory) {
                    // 是回收站分类，保留选择；由 restoreTabState/启动渲染根据标签 isRecycleBin 走 loadRecycleBin
                    currentSelectedCategoryId = '1';
                    console.log('🗑️ 恢复回收站分类');
                } else {
                    // id 为 1 但不是回收站，保留原有选择
                    currentSelectedCategoryId = storedValue.toString();
                    console.log('恢复分类 ID=1（非回收站）:', currentSelectedCategoryId);
                }
            } else {
                currentSelectedCategoryId = storedValue;
                console.log('恢复上次选择的分类:', currentSelectedCategoryId || '(全部)');
            }
        } else {
            if (firstRegularCategory) {
                currentSelectedCategoryId = firstRegularCategory.id.toString();
                console.log('首次使用，选择第一个普通分类:', currentSelectedCategoryId, firstRegularCategory.name);
                chrome.storage.local.set({ lastSelectedCategory: currentSelectedCategoryId });
            } else if (categories.length > 0) {
                currentSelectedCategoryId = categories[0].id.toString();
                console.log('首次使用，仅有1个分类，选择:', currentSelectedCategoryId);
                chrome.storage.local.set({ lastSelectedCategory: currentSelectedCategoryId });
            } else {
                currentSelectedCategoryId = '';
            }
        }

        // 🔧 标签状态已由 initCustomerTabs 从 localStorage 恢复，不覆盖
        // 只同步 currentSelectedCategoryId 为当前激活标签的值
        const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
        if (currentTab && currentTab.selectedCategory) {
            currentSelectedCategoryId = currentTab.selectedCategory;
            console.log('📋 使用当前标签的分类:', currentSelectedCategoryId, currentTab.categoryName);
        } else if (currentSelectedCategoryId) {
            // 仅当标签没有 selectedCategory 时，才用 lastSelectedCategory 填充
            const selectedCat = categories.find(c => c.id.toString() === currentSelectedCategoryId);
            if (selectedCat && currentTab) {
                currentTab.selectedCategory = currentSelectedCategoryId;
                currentTab.categoryName = selectedCat.name;
                saveCustomerTabs();
                renderCustomerTabs();
                console.log('✅ 填充标签分类名:', selectedCat.name);
            }
        }

        // 🔧 恢复分类选择后，更新一级分类的选中状态
        console.log('🔍 restoreLastSelectedCategory - 调用 updatePrimaryCategoryTilesActiveState');
        if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
            window.pythonBridge.log_to_terminal('🔍 restoreLastSelectedCategory - 调用 updatePrimaryCategoryTilesActiveState');
        }
        updatePrimaryCategoryTilesActiveState();
    } catch (error) {
        console.error('恢复分类选择失败:', error);
        try {
            const categories = await db.getAllCategories();
            const fallback = getFirstNonRecycleCategory(categories) || categories[0];
            if (fallback) {
                currentSelectedCategoryId = fallback.id.toString();
            }
        } catch (e) {
            console.error('获取默认分类失败:', e);
        }
    }
}

// 计算搜索记录区域能容纳的最大记录数（基于实际渲染测量）
function calculateSearchHistoryCapacity() {
    const topSection = document.querySelector('.search-dropdown-top');
    if (!topSection) {
        console.log('[LOG] calculateSearchHistoryCapacity - 未找到 .search-dropdown-top，返回默认值:', MAX_SEARCH_HISTORY_ITEMS);
        return MAX_SEARCH_HISTORY_ITEMS; // 降级到默认值
    }

    const maxHeight = topSection.offsetHeight || 120; // 容器高度
    console.log('[LOG] calculateSearchHistoryCapacity - 容器高度:', maxHeight, 'offsetHeight:', topSection.offsetHeight);
    
    // 由于是wrap布局，需要实际测量
    // 创建一个临时测试容器，完全模拟真实环境
    const testContainer = document.createElement('div');
    testContainer.style.position = 'absolute';
    testContainer.style.visibility = 'hidden';
    testContainer.style.width = topSection.offsetWidth + 'px';
    testContainer.style.height = maxHeight + 'px';
    testContainer.style.padding = '3px';
    testContainer.style.boxSizing = 'border-box';
    
    const testWrapper = document.createElement('div');
    testWrapper.className = 'search-history-wrapper';
    testWrapper.style.width = '100%';
    
    const testHeader = document.createElement('div');
    testHeader.className = 'search-history-header';
    testHeader.textContent = '最近搜索';
    testWrapper.appendChild(testHeader);
    
    const testList = document.createElement('div');
    testList.className = 'search-history-list';
    testWrapper.appendChild(testList);
    
    testContainer.appendChild(testWrapper);
    document.body.appendChild(testContainer);
    
    // 添加测试item直到超出容器高度
    let count = 0;
    const testKeywords = ['测试1', '测试2', '测试3', '测试4', '测试5', '测试6', '测试7', '测试8', '测试9', '测试10', '测试11', '测试12', '测试13', '测试14', '测试15', '测试16', '测试17', '测试18', '测试19', '测试20'];
    
    for (const keyword of testKeywords) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-history-item';
        item.textContent = keyword;
        testList.appendChild(item);
        
        // 强制重排
        void testContainer.offsetHeight;
        
        // 检查是否超出容器高度（使用scrollHeight判断，允许1px的误差，避免因舍入误差导致少算一行）
        // scrollHeight是内容总高度（包括padding），offsetHeight是容器可见高度
        if (testContainer.scrollHeight > testContainer.offsetHeight + 1) {
            testList.removeChild(item);
            break;
        }
        count++;
    }
    
    // 清理
    document.body.removeChild(testContainer);

    const result = Math.max(1, count || MAX_SEARCH_HISTORY_ITEMS);
    console.log('[LOG] calculateSearchHistoryCapacity - 计算结果:', result, '(测试了', count, '个项目)');
    return result;
}

async function saveSearchKeywordHistory(keyword) {
    const normalizedKeyword = (keyword || '').trim();
    if (!normalizedKeyword) {
        return;
    }

    try {
        const result = await chrome.storage.local.get(SEARCH_HISTORY_STORAGE_KEY);
        let history = Array.isArray(result[SEARCH_HISTORY_STORAGE_KEY])
            ? [...result[SEARCH_HISTORY_STORAGE_KEY]]
            : [];

        history = history.filter(item => item !== normalizedKeyword);
        history.unshift(normalizedKeyword);

        // 动态计算容量并限制（现在长文本不换行了，计算会更准确）
        const maxCapacity = calculateSearchHistoryCapacity();
        if (history.length > maxCapacity) {
            history = history.slice(0, maxCapacity);
        }

        await chrome.storage.local.set({
            [SEARCH_HISTORY_STORAGE_KEY]: history
        });
    } catch (error) {
        console.warn('保存搜索记录失败:', error);
    }
}

async function loadSearchKeywordHistory(options = {}) {
    const topSection = document.querySelector('.search-dropdown-top');
    if (!topSection) return;

    const { onKeywordSelect } = options;

    try {
        topSection.innerHTML = '';

        const result = await chrome.storage.local.get(SEARCH_HISTORY_STORAGE_KEY);
        let history = Array.isArray(result[SEARCH_HISTORY_STORAGE_KEY])
            ? result[SEARCH_HISTORY_STORAGE_KEY]
            : [];

        // 动态计算能容纳的最大数量并限制显示
        const maxCapacity = calculateSearchHistoryCapacity();
        if (history.length > maxCapacity) {
            history = history.slice(0, maxCapacity);
            // 同步更新存储，移除超出容量的记录（FIFO）
            await chrome.storage.local.set({
                [SEARCH_HISTORY_STORAGE_KEY]: history
            });
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'search-history-wrapper';

        const header = document.createElement('div');
        header.className = 'search-history-header';
        header.textContent = '最近搜索';
        wrapper.appendChild(header);

        if (history.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'search-history-empty';
            empty.textContent = '暂无搜索记录';
            wrapper.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'search-history-list';

            history.forEach(keyword => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'search-history-item';
                item.textContent = keyword;
                item.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                });
                if (typeof onKeywordSelect === 'function') {
                    item.addEventListener('click', () => onKeywordSelect(keyword));
                }
                list.appendChild(item);
            });

            wrapper.appendChild(list);
        }

        topSection.appendChild(wrapper);
    } catch (error) {
        console.warn('加载搜索记录失败:', error);
        topSection.innerHTML = `
            <div class="search-history-wrapper">
                <div class="search-history-header">最近搜索</div>
                <div class="search-history-empty">加载失败</div>
            </div>
        `;
    }
}

// 计算二级分类记录区域能容纳的最大记录数（基于实际渲染测量）
function calculateSubCategoryHistoryCapacity() {
    const bottomSection = document.querySelector('.search-dropdown-bottom');
    if (!bottomSection) return 5; // 降级到默认值
    
    // 获取实际容器高度（需要考虑flex布局）
    // 如果容器还没有渲染，使用默认值
    let maxHeight = bottomSection.offsetHeight;
    if (!maxHeight || maxHeight === 0) {
        // 如果获取不到高度，尝试从CSS计算
        const computedStyle = window.getComputedStyle(bottomSection);
        maxHeight = parseInt(computedStyle.maxHeight) || 200;
    }
    
    // 如果高度太小，使用默认值
    if (maxHeight < 50) {
        return 5;
    }
    
    // 获取容器宽度
    let containerWidth = bottomSection.offsetWidth;
    if (!containerWidth || containerWidth === 0) {
        containerWidth = 300; // 默认宽度
    }
    
    // 创建临时测试容器，完全模拟真实环境（与实际渲染结构一致，不包含header）
    const testContainer = document.createElement('div');
    testContainer.style.position = 'absolute';
    testContainer.style.visibility = 'hidden';
    testContainer.style.width = containerWidth + 'px';
    testContainer.style.height = maxHeight + 'px';
    testContainer.style.padding = '0 3px';
    testContainer.style.boxSizing = 'border-box';
    testContainer.style.overflow = 'hidden';
    
    // 创建列表容器（与实际渲染结构一致）
    const testList = document.createElement('div');
    testList.className = 'subcategory-history-list';
    testContainer.appendChild(testList);
    
    document.body.appendChild(testContainer);
    
    // 强制重排，确保布局计算完成
    void testContainer.offsetHeight;
    void testList.offsetHeight;
    
    // 添加测试item直到超出容器高度
    let count = 0;
    const testNames = ['测试分类1', '测试分类2', '测试分类3', '测试分类4', '测试分类5', '测试分类6', '测试分类7', '测试分类8', '测试分类9', '测试分类10'];
    
    for (const name of testNames) {
        const item = document.createElement('div');
        item.className = 'subcategory-history-item';
        item.innerHTML = `<div class="subcategory-history-name">${name}</div>`;
        testList.appendChild(item);
        
        // 强制重排，确保布局计算完成
        void testContainer.offsetHeight;
        void testList.offsetHeight;
        
        // 检查整个容器是否超出最大高度（使用scrollHeight判断，允许1px的误差）
        // scrollHeight是内容总高度（包括padding），offsetHeight是容器可见高度
        if (testContainer.scrollHeight > testContainer.offsetHeight + 1) {
            testList.removeChild(item);
            break;
        }
        count++;
    }
    
    // 清理
    document.body.removeChild(testContainer);
    
    // 确保返回值至少为1，但不超过合理的最大值
    return Math.max(1, Math.min(count || 5, 10));
}

// 保存二级分类点击记录
async function saveSubCategoryClickHistory(categoryId, categoryName, parentCategoryId, parentCategoryName) {
    try {
        const result = await chrome.storage.local.get('subCategoryClickHistory');
        let history = result.subCategoryClickHistory || [];
        
        // 移除已存在的相同分类记录
        history = history.filter(item => item.categoryId !== categoryId);
        
        // 添加到最前面
        history.unshift({
            categoryId: categoryId,
            categoryName: categoryName,
            parentCategoryId: parentCategoryId,
            parentCategoryName: parentCategoryName,
            clickTime: Date.now()
        });
        
        // 动态计算容量并限制（FIFO：超出容量的最旧记录会被移除）
        const maxCapacity = calculateSubCategoryHistoryCapacity();
        if (history.length > maxCapacity) {
            history = history.slice(0, maxCapacity);
        }
        
        await chrome.storage.local.set({ subCategoryClickHistory: history });
    } catch (error) {
        console.warn('保存二级分类点击记录失败:', error);
    }
}

// 加载并显示二级分类点击记录
async function loadSubCategoryClickHistory() {
    try {
        const historySection = document.querySelector('.search-dropdown-bottom');
        if (!historySection) return;
        
        const result = await chrome.storage.local.get('subCategoryClickHistory');
        let history = result.subCategoryClickHistory || [];
        
        // 计算能容纳的最大数量并限制显示
        const maxCapacity = calculateSubCategoryHistoryCapacity();
        if (history.length > maxCapacity) {
            history = history.slice(0, maxCapacity);
            // 同步更新存储，移除超出容量的记录（FIFO）
            await chrome.storage.local.set({ subCategoryClickHistory: history });
        }
        
        // 渲染记录列表
        historySection.innerHTML = '';
        
        if (history.length === 0) {
            historySection.innerHTML = `
                <div class="subcategory-history-empty">暂无使用记录</div>
            `;
            return;
        }
        
        // 创建列表容器
        const listContainer = document.createElement('div');
        listContainer.className = 'subcategory-history-list';
        
        // 获取所有分类信息
        const categories = allCategoriesCache || await db.getAllCategories();
        
        // 创建分类ID映射，用于快速查找
        const categoryMap = new Map();
        categories.forEach(cat => {
            categoryMap.set(cat.id.toString(), cat);
        });
        
        // 验证并过滤存在的分类
        const validHistory = [];
        for (const item of history) {
            const categoryId = item.categoryId.toString();
            const category = categoryMap.get(categoryId);
            
            // 如果分类不存在，尝试从数据库查询（可能缓存未更新）
            if (!category) {
                try {
                    const dbCategory = await db.getCategory(item.categoryId);
                    if (!dbCategory) {
                        // 分类不存在，跳过
                        continue;
                    }
                } catch (error) {
                    // 查询失败，跳过
                    continue;
                }
            }
            
            validHistory.push(item);
        }
        
        // 如果没有有效记录，显示空状态
        if (validHistory.length === 0) {
            historySection.innerHTML = `
                <div class="subcategory-history-empty">暂无使用记录</div>
            `;
            return;
        }
        
        // 渲染记录列表（validHistory已经通过maxCapacity限制过了）
        validHistory.forEach(item => {
            const recordItem = document.createElement('div');
            recordItem.className = 'subcategory-history-item';
            recordItem.innerHTML = `
                <div class="subcategory-history-name">${escapeHtml(item.categoryName)}</div>
            `;
            
            // 点击选择分类
            recordItem.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const searchDropdown = document.getElementById('searchDropdown');
                if (searchDropdown) {
                    searchDropdown.classList.remove('show');
                }
                
                // 再次验证分类是否存在
                try {
                    const category = await db.getCategory(item.categoryId);
                    if (!category) {
                        console.warn('分类不存在，已从历史记录中移除:', item.categoryId);
                        // 从历史记录中移除
                        const result = await chrome.storage.local.get('subCategoryClickHistory');
                        let history = result.subCategoryClickHistory || [];
                        history = history.filter(h => h.categoryId !== item.categoryId);
                        await chrome.storage.local.set({ subCategoryClickHistory: history });
                        // 重新加载历史记录
                        await loadSubCategoryClickHistory();
                        return;
                    }
                    await selectCategory(item.categoryId);
                } catch (error) {
                    console.error('选择分类失败:', error);
                }
            });
            
            listContainer.appendChild(recordItem);
        });
        
        historySection.appendChild(listContainer);
    } catch (error) {
        console.warn('加载二级分类点击记录失败:', error);
    }
}

// ⚡ 分类切换防抖（快速连点只执行最后一次）
let _selectCategoryDebounceTimer = null;
let _selectCategoryPendingResolve = null;

// 选择分类
// skipAnimation: 是否跳过动画和左侧导航刷新（用于平铺区域内的快速切换）
async function selectCategory(categoryId, skipAnimation = false) {
    // 防抖：30ms 内的连续调用只执行最后一次
    if (_selectCategoryDebounceTimer) {
        clearTimeout(_selectCategoryDebounceTimer);
        if (_selectCategoryPendingResolve) {
            _selectCategoryPendingResolve('debounced');
            _selectCategoryPendingResolve = null;
        }
    }
    return new Promise((resolve) => {
        _selectCategoryPendingResolve = resolve;
        _selectCategoryDebounceTimer = setTimeout(async () => {
            _selectCategoryDebounceTimer = null;
            _selectCategoryPendingResolve = null;
            const result = await _selectCategoryInner(categoryId, skipAnimation);
            resolve(result);
        }, skipAnimation ? 10 : 30);
    });
}
async function _selectCategoryInner(categoryId, skipAnimation) {
    console.log('🔍 选择分类:', categoryId, '(类型:', typeof categoryId + ')', skipAnimation ? '(快速切换)' : '');

    let normalizedId = categoryId == null ? '' : categoryId.toString();

    // 🆕 检查是否是一级分类且没有话术，如果是则自动选择第一个二级分类
    if (normalizedId) {
        const categories = await db.getAllCategories();
        const selectedCat = categories.find(c => String(getCategoryId(c)) === normalizedId);
        if (selectedCat && getCategoryParentId(selectedCat) === 0) {
            // 是一级分类，检查是否有话术
            const phrases = await db.searchPhrases('', selectedCat.id, false, false);
            const directPhrases = (phrases || []).filter(p => p.parent_id === null || p.parent_id === undefined);
            if (directPhrases.length === 0) {
                // 一级分类没有话术，查找第一个二级分类
                const firstChild = categories.find(c => getCategoryParentId(c) === getCategoryId(selectedCat));
                if (firstChild) {
                    console.log('📂 一级分类无话术，自动选择二级分类:', firstChild.name);
                    normalizedId = String(getCategoryId(firstChild));
                    // 更新标签页名称
                    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
                    if (currentTab) {
                        currentTab.categoryName = firstChild.name;
                    }
                }
            }
        }
    }

    // 🆕 检查是否重复点击当前分类，如果是则什么都不做
    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
    if (currentTab && currentTab.selectedCategory === normalizedId) {
        console.log('🔁 重复点击当前分类，不执行任何操作');
        return;
    }

    // 🆕 检查是否有标签页已经选中了该分类，如果有则跳转到最早的标签页
    const existingTabs = customerTabs.filter(tab => tab.selectedCategory === normalizedId && tab.id !== activeCustomerTabId);
    if (existingTabs.length > 0) {
        // 按 tabId 排序，跳转到最早的标签页
        existingTabs.sort((a, b) => a.id - b.id);
        const targetTab = existingTabs[0];
        console.log('🔄 跳转到已有标签页:', targetTab.id, '分类:', normalizedId);
        await switchCustomerTab(targetTab.id);
        // 更新一级分类的选中状态
        updatePrimaryCategoryTilesActiveState();
        return;
    }

    // 🆕 检查是否为钉住状态（红色按钮），覆盖同父级下的未钉住标签或新建
    if (currentTab && currentTab.isPinPinned) {
        await saveCurrentTabState();
        const categories = await db.getAllCategories();
        let categoryName = '';
        if (normalizedId) {
            const matched = categories.find(cat => cat.id.toString() === normalizedId);
            categoryName = matched ? matched.name : '';
        }

        // 获取目标分类的父级ID（仅二级分类有有效parent_id时才覆盖同级）
        const targetCat = categories.find(cat => cat.id.toString() === normalizedId);
        const targetParentId = targetCat ? (targetCat.parent_id || 0) : 0;

        // 在同父级下找最早的未钉住标签（排除当前钉住的）
        // 仅当目标是二级分类（parent_id有效）时才覆盖，否则直接新建
        const unpinnedTab = targetParentId > 0 ? customerTabs
            .filter(tab => {
                if (tab.isPinPinned || tab.id === activeCustomerTabId) return false;
                if (!tab.selectedCategory) return false;
                const tabCat = categories.find(cat => cat.id.toString() === tab.selectedCategory);
                const tabParentId = tabCat ? (tabCat.parent_id || 0) : 0;
                return tabParentId === targetParentId;
            })
            .sort((a, b) => a.id - b.id)[0] : null;

        if (unpinnedTab) {
            // 覆盖同父级下未钉住标签的分类
            console.log('📌 钉住状态，覆盖同父级未钉住标签:', unpinnedTab.id, '→ 分类:', categoryId);
            unpinnedTab.selectedCategory = normalizedId;
            unpinnedTab.categoryName = categoryName;
            unpinnedTab.scrollPosition = 0;
            await switchCustomerTab(unpinnedTab.id);
            saveCustomerTabs();
        } else {
            // 无同父级未钉住标签，新建
            console.log('📌 钉住状态，新建标签页:', categoryId);
            const newTab = {
                id: nextCustomerTabId++,
                name: '标签页',
                searchText: '',
                selectedCategory: normalizedId,
                categoryName: categoryName,
                scrollPosition: 0,
                isPinPinned: false
            };
            customerTabs.push(newTab);
            tabUsageMap.set(newTab.id, new Set());
            await switchCustomerTab(newTab.id);
            saveCustomerTabs();
        }
        // 更新一级分类的选中状态
        updatePrimaryCategoryTilesActiveState();
        // 如果选中的是一级分类且自身没有话术，自动选中第一个二级分类
        if (currentSelectedCategoryId && currentSelectedCategoryId !== '') {
            const cats = await db.getAllCategories();
            const selCat = cats.find(c => String(getCategoryId(c)) === String(currentSelectedCategoryId));
            if (selCat && getCategoryParentId(selCat) === 0) {
                const ch = cats.filter(c => getCategoryParentId(c) === getCategoryId(selCat));
                if (ch.length > 0) {
                    const phs = await db.searchPhrases('', currentSelectedCategoryId, false, false);
                    const direct = (phs || []).filter(p => p.parent_id === null || p.parent_id === undefined);
                    if (direct.length === 0) {
                        currentSelectedCategoryId = String(getCategoryId(ch[0]));
                        // 更新标签页名称为二级分类名
                        const tab = customerTabs.find(t => t.id === activeCustomerTabId);
                        if (tab) {
                            tab.selectedCategory = currentSelectedCategoryId;
                            tab.categoryName = ch[0].name;
                        }
                        await loadPhrases();
                        saveCustomerTabs();
                        renderCustomerTabs();
                    }
                }
            }
        }
        return;
    }

    // 🆕 隐藏右键菜单
    const contextMenu = document.getElementById('categoryContextMenu');
    if (contextMenu) {
        contextMenu.classList.remove('show');
    }

    // 检查是否在管理页面
    const manageTab = document.getElementById('manageTab');
    const isInManagePage = manageTab && manageTab.classList.contains('active');

    // 如果在管理页面，直接选中该分类并切换到话术页面
    let isRepeatClick = false;
    if (isInManagePage) {
        currentSelectedCategoryId = normalizedId;
        switchTab('search');
    } else {
        if (currentSelectedCategoryId === normalizedId) {
            isRepeatClick = true;
            // 即使重复点击，也要清除搜索关键词和关闭弹层
        } else {
            currentSelectedCategoryId = normalizedId;
        }
    }
    
    // 🧹 清除搜索框内容，切换到分类浏览模式
    // 注意：即使重复点击，也要清除搜索关键词，这样才能关闭搜索弹层
    const searchInput = document.getElementById('searchInput');
    const clearSearch = document.getElementById('clearSearch');
    const searchDropdown = document.getElementById('searchDropdown');
    if (searchInput) {
        searchInput.value = '';
        if (clearSearch) {
            clearSearch.style.display = 'none';
        }
        // 关闭搜索下拉框
        if (searchDropdown) {
            searchDropdown.classList.remove('show');
        }
        // 刷新搜索框占位符
        // 不显示历史关键词或默认 placeholder，保持空字符串以不干扰字幕显示
        searchInput.placeholder = '';
    }
    
    // 🧹 关闭所有搜索相关的二级分类弹层
    hideAllSubcategoryPopovers();
    
    // 如果是重复点击，清除搜索关键词和关闭弹层后，需要重新加载话术以更新状态
    if (isRepeatClick) {
        console.log('🔄 重复点击，清除搜索关键词和关闭弹层，重新加载话术');
        // 手动触发 input 事件，让 performSearch 更新搜索状态
        if (searchInput) {
            const inputEvent = new Event('input', { bubbles: true });
            searchInput.dispatchEvent(inputEvent);
        }
        return;
    }
    
    // 💾 保存当前选择的分类到本地存储
    chrome.storage.local.set({ lastSelectedCategory: currentSelectedCategoryId });

    // 📊 记录分类使用次数（非重复点击且不是"全部"）
    if (!isRepeatClick && currentSelectedCategoryId && currentSelectedCategoryId !== '') {
        try {
            const categoryIdNum = parseInt(currentSelectedCategoryId);
            if (!isNaN(categoryIdNum)) {
                await db.incrementCategoryUseCount(categoryIdNum);
            }
        } catch (error) {
            console.warn('记录分类使用次数失败:', error);
        }
    }

    // 如果没有标签页，自动创建一个
    if (customerTabs.length === 0) {
        const categories = allCategoriesCache || await db.getAllCategories();
        const matched = categories.find(cat => cat.id.toString() === normalizedId);
        const categoryName = matched ? matched.name : '';
        const newTab = {
            id: nextCustomerTabId++,
            name: categoryName || '标签页',
            searchText: '',
            selectedCategory: normalizedId,
            categoryName: categoryName,
            scrollPosition: 0,
            isPinPinned: false
        };
        customerTabs.push(newTab);
        activeCustomerTabId = newTab.id;
    }

    // 保存到当前客户标签页并更新标签页显示
    await saveCurrentTabState();
    renderCustomerTabs();
    saveCustomerTabs();
    
    if (!skipAnimation) {
        updatePrimaryCategoryTilesActiveState();
        hideAllSubcategoryPopovers();
        
        const phraseList = document.getElementById('phraseList');
        if (phraseList) {
            phraseList.classList.add('animating');
            setTimeout(() => {
                phraseList.classList.remove('animating');
            }, 400);
        }
    } else {
        updatePrimaryCategoryTilesActiveState();
    }
    
    await loadPhrases();
    
    // 🧹 最后再次确保关闭所有弹层（防止 loadPhrases 中显示搜索弹层）
    // 因为点击一级分类时，应该显示分类话术，而不是搜索弹层
    hideAllSubcategoryPopovers();
}

// 更新排序按钮的可用状态
async function updateSortButtonState() {
    const toggleBtn = document.getElementById('toggleSortModeBtn');
    if (!toggleBtn) return;
    
    const sortMode = await db.getSetting('sort_mode', 'manual');
    if (sortMode === 'manual') {
        toggleBtn.disabled = false;
        toggleBtn.title = isSortModeActive ? '点击退出排序模式' : '点击进入排序模式';
    } else {
        toggleBtn.disabled = true;
        toggleBtn.title = '请在设置中切换到"手动排序"模式';
        // 如果排序模式是激活的，关闭它
        if (isSortModeActive) {
            isSortModeActive = false;
            window._sortModeActive = false;                    // 加这一行
            localStorage.setItem('_sortModeActive', '0');      // 加这一行
            toggleBtn.classList.remove('sort-mode-active');
            const phraseList = document.getElementById('phraseList');
            if (phraseList) {
                phraseList.classList.remove('sort-mode-active');
            }
        }
    }
}

// 清除之前由脚本写入的内联间距样式，恢复由 CSS 控制的布局
function clearInlineSpacing(phraseList) {
    if (!phraseList) return;
    try {
        const elems = phraseList.querySelectorAll('.phrase-item, .phrase-group-normal, .subcategory-tabs-container, .add-phrase-card');
        elems.forEach(el => {
            try {
                el.style.marginTop = '';
                el.style.marginBottom = '';
                el.style.paddingTop = '';
                el.style.paddingBottom = '';
                // 保留 transform/transition 的清理由上层逻辑控制
            } catch (inner) {
                // 忽略单个元素错误
            }
        });
        console.log('[LAYOUT] cleared inline spacing styles');
    } catch (err) {
        console.error('[LAYOUT] clearInlineSpacing failed', err);
    }
}

// Debug helpers: 默认禁用布局补偿以便对比（复测时可在控制台设置为 false）
window.__disableLayoutCompensation = true;

function logDetailedLayoutDiagnostics(prefix = '') {
    try {
        const phraseList = document.getElementById('phraseList');
        if (!phraseList) {
            console.log('[LAYOUT-DETAIL]', prefix, 'phraseList not found');
            return;
        }
        const children = Array.from(phraseList.children);
        console.log('[LAYOUT-DETAIL]', prefix, '--- start ---');
        children.forEach((child, idx) => {
            try {
                const cs = window.getComputedStyle(child);
                const rect = child.getBoundingClientRect();
                const inline = child.getAttribute('style') || '';
                const prev = child.previousElementSibling;
                const next = child.nextElementSibling;
                console.log(`[LAYOUT-DETAIL] ${prefix} idx=${idx} id=${child.dataset.id||''} classes="${child.className}" inline="${inline.replace(/\\s+/g,' ')}" top=${rect.top.toFixed(1)} height=${rect.height.toFixed(1)} marginTop=${cs.marginTop} marginBottom=${cs.marginBottom} prev="${prev?prev.className:''}" next="${next?next.className:''}"`);
            } catch (e) {
                console.error('[LAYOUT-DETAIL] item diag failed', e);
            }
        });
        console.log('[LAYOUT-DETAIL]', prefix, '--- end ---');
    } catch (err) {
        console.error('[LAYOUT-DETAIL] diag failed', err);
    }
}

// 切换排序模式
function toggleSortMode() {
    isSortModeActive = !isSortModeActive;
    
    // 🎯 同步更新全局状态，确保重新渲染时不会丢失
    window._sortModeActive = isSortModeActive;
    // 加这一行：写入 localStorage 作为持久兜底
    localStorage.setItem('_sortModeActive', isSortModeActive ? '1' : '0');
    
    const toggleBtn = document.getElementById('toggleSortModeBtn');
    const phraseList = document.getElementById('phraseList');
    
    if (toggleBtn) {
        if (isSortModeActive) {
            toggleBtn.classList.add('sort-mode-active');
            toggleBtn.title = '点击退出排序模式';
            if (phraseList) {
                phraseList.classList.add('sort-mode-active');
            }
            showToast('✅ 已进入排序模式，可拖动话术调整顺序');
            // 清除之前可能应用的视觉补偿（translate）以便排序时不受影响
            try {
                const titles = Array.from(document.querySelectorAll('.phrase-item.title-phrase-item'));
                titles.forEach(t => {
                    try {
                        t.style.transform = '';
                        t.style.transition = '';
                    } catch (e) {
                        console.error('[LAYOUT] failed to clear title transform', e);
                    }
                });
            } catch (e) {
                console.error('[LAYOUT] clear transforms failed', e);
            }
        } else {
            toggleBtn.classList.remove('sort-mode-active');
            toggleBtn.title = '点击进入排序模式';
            if (phraseList) {
                phraseList.classList.remove('sort-mode-active');
            }
            showToast('已退出排序模式');
            // 清理可能的空分组（避免空容器占位导致间距异常），然后输出布局诊断信息
            try {
                const phraseList = document.getElementById('phraseList');
                if (phraseList) {
                    // 先清除之前可能写入的内联间距样式，避免这些样式在后续补偿计算中干扰
                    try {
                        clearInlineSpacing(phraseList);
                    } catch (ciErr) {
                        console.error('[LAYOUT] clearInlineSpacing error', ciErr);
                    }
                    const groups = Array.from(phraseList.querySelectorAll('.phrase-group-normal'));
                    groups.forEach(g => {
                        try {
                            // 如果组内没有任何实际的话术项（.phrase-item）且没有添加卡，则移除该组
                            const hasPhraseItem = g.querySelector('.phrase-item') !== null;
                            const hasAddCard = g.querySelector('.add-phrase-card') !== null;
                            if (!hasPhraseItem && !hasAddCard) {
                                g.remove();
                                console.log('[LAYOUT] removed empty .phrase-group-normal');
                            }
                        } catch (innerErr) {
                            console.error('[LAYOUT] group cleanup failed', innerErr);
                        }
                    });
                    // 明确强制所有标题卡片的上边距为 0，避免计算出来的 marginTop 导致顶部空隙
                    try {
                        const titles = Array.from(phraseList.querySelectorAll('.phrase-item.title-phrase-item'));
                        titles.forEach(t => {
                            try {
                                // 不再强制写入 inline margin，清理任何残留的 inline margin，让 CSS 控制间距
                                t.style.marginTop = '';
                                t.style.marginBottom = '';
                            } catch (stErr) {
                                console.error('[LAYOUT] failed to clear inline margin for title', stErr);
                            }
                        });
                        if (titles.length > 0) {
                            console.log('[LAYOUT] cleared inline margins on', titles.length, 'title-phrase-item(s)');
                        }
                    } catch (errTitles) {
                        console.error('[LAYOUT] title margin enforcement failed', errTitles);
                    }
                    // 额外防护：清理 subcategory-tabs-container 的负 margin（避免与标题 margin 折叠）
                    try {
                        const tabs = Array.from(phraseList.querySelectorAll('.subcategory-tabs-container'));
                        tabs.forEach(tb => {
                            try {
                                // 清除脚本写入的 inline marginTop，使用 CSS 的优先规则进行布局控制
                                tb.style.marginTop = '';
                            } catch (tbErr) {
                                console.error('[LAYOUT] failed to clear tabs inline margin', tbErr);
                            }
                        });
                    } catch (tabsErr) {
                        console.error('[LAYOUT] tabs normalization failed', tabsErr);
                    }
                    // 如果标题前有分组容器，确保它的 marginBottom 为 0，防止与标题 margin 叠加
                    try {
                        const titles = Array.from(phraseList.querySelectorAll('.phrase-item.title-phrase-item'));
                        titles.forEach(t => {
                            const prev = t.previousElementSibling;
                            if (prev && prev.classList && prev.classList.contains('phrase-group-normal')) {
                                try {
                                    // 清除由脚本设置的 marginBottom，以避免与标题的 margin 折叠产生意外间距
                                    prev.style.marginBottom = '';
                                } catch (pErr) {
                                    console.error('[LAYOUT] failed to clear prev group marginBottom', pErr);
                                }
                            }
                        });
                    } catch (prevErr) {
                        console.error('[LAYOUT] prev group margin normalization failed', prevErr);
                    }
                    // 最后强制回流并重新输出布局（帮助浏览器重新计算）
                    try {
                        void phraseList.offsetHeight;
                        console.log('[LAYOUT] forced reflow after cleanup');
                    } catch (rfErr) {
                        console.error('[LAYOUT] reflow failed', rfErr);
                    }
                }
            } catch (err) {
                console.error('[LAYOUT] cleanup groups failed', err);
            }
            // 输出退出排序时的布局诊断信息到控制台，便于在 Python 终端观察间距/DOM 状态
            try {
                if (typeof logPhraseListLayout === 'function') {
                    logPhraseListLayout();
                } else {
                    console.log('[LAYOUT] logPhraseListLayout not defined');
                }
            } catch (err) {
                console.error('[LAYOUT] failed to run diagnostics:', err);
            }
        }
    }
    // 在退出排序后的最后阶段，补偿任何剩余的视觉间隙（通过 translateY）
    try {
        if (!isSortModeActive) {
            const phraseList = document.getElementById('phraseList');
            if (phraseList) {
                // 记录更详细的诊断，便于对比禁用补偿前后的状态
                logDetailedLayoutDiagnostics('before-simple-comp');

                if (window.__disableLayoutCompensation) {
                    console.log('[LAYOUT] simple compensation disabled by debug flag');
                } else {
                    const titles = Array.from(phraseList.querySelectorAll('.phrase-item.title-phrase-item'));
                    titles.forEach(t => {
                        try {
                            // 标题卡片的间距由 CSS 规则精确控制（例如 title+title 需要 3px）。
                            // 这里若根据 marginTop 做 translateY，会把这些“有意的间距”抵消成 0px。
                            // 因此：禁用 simple compensation 对标题的上移补偿，只清理残留 transform。
                            t.style.transform = '';
                            t.style.transition = '';
                            return;

                            // 跳过当前紧跟在平铺容器（.subcategory-tabs-container）之后的标题，
                            // 这些场景的 marginTop 是由 CSS 明确设置（例如 4px），不应由脚本补偿
                            const prevSibling = t.previousElementSibling;
                            if (prevSibling && prevSibling.classList && prevSibling.classList.contains('subcategory-tabs-container')) {
                                // 确保没有残留的 transform
                                t.style.transform = '';
                                return;
                            }

                            const cs = window.getComputedStyle(t);
                            const mt = parseFloat(cs.marginTop) || 0;
                            // 如果计算出来的上边距仍然大于0且不是由已知 CSS 结构意图产生，则向上平移以视觉补偿（上限6px）
                            if (mt > 0.5) {
                                const shift = Math.min(mt, 6);
                                t.style.transition = 'transform 0.08s ease';
                                t.style.transform = `translateY(${-shift}px)`;
                                console.log('[LAYOUT] applied translateY to compensate margin on title', t.dataset.id || '');
                            } else {
                                // 清除可能残留的 transform
                                t.style.transform = '';
                            }
                        } catch (innerErr) {
                            console.error('[LAYOUT] apply translate failed', innerErr);
                        }
                    });
                }

                // 输出诊断以验证补偿前后差异
                logDetailedLayoutDiagnostics('after-simple-comp');
            }
        }
    } catch (err) {
        console.error('[LAYOUT] final translate compensation failed', err);
    }
    // 动态补偿：根据上一个元素的实际 bottom 计算期望 top（prev.bottom + spacing）
    // 如果标题实际 top 高于期望 top，则向上平移差值进行视觉对齐（更可靠于不同布局）
    try {
        if (!isSortModeActive) {
            const phraseList = document.getElementById('phraseList');
            if (phraseList) {
                logDetailedLayoutDiagnostics('before-dynamic-comp');

                if (window.__disableLayoutCompensation) {
                    console.log('[LAYOUT] dynamic compensation disabled by debug flag');
                } else {
                    const spacing = 3; // 期望的视觉间距（px）
                    const titles = Array.from(phraseList.querySelectorAll('.phrase-item.title-phrase-item'));
                    titles.forEach(t => {
                        try {
                            const prev = t.previousElementSibling;
                            if (!prev) return;

                            // 关键修复：当上一个元素带有 transform（例如首标题使用 translateY 微调），
                            // getBoundingClientRect() 会把 transform 计入坐标，但 transform 不参与文档流。
                            // 这会导致脚本误判“间距过大”，从而把当前标题上移，最终把 CSS 设定的 3px 间距抵消成 0。
                            // 因此：当前标题的前一个元素是标题卡片时（或前一个元素存在 transform），禁止对当前标题做动态 translate 补偿。
                            if (prev.classList && prev.classList.contains('title-phrase-item')) {
                                t.style.transform = '';
                                t.style.transition = '';
                                return;
                            }
                            try {
                                const prevCs = window.getComputedStyle(prev);
                                if (prevCs && prevCs.transform && prevCs.transform !== 'none') {
                                    t.style.transform = '';
                                    t.style.transition = '';
                                    return;
                                }
                            } catch (csErr) {
                                // ignore
                            }

                            const prevRect = prev.getBoundingClientRect();
                            const titleRect = t.getBoundingClientRect();
                            const expectedTop = prevRect.top + prevRect.height + spacing;
                            const delta = Math.round(titleRect.top - expectedTop);
                            if (delta > 1) {
                                // 向上平移 delta 像素进行视觉补偿
                                t.style.transition = 'transform 0.12s ease';
                                t.style.transform = `translateY(${-delta}px)`;
                                console.log('[LAYOUT] dynamic compensation applied translateY', -delta, 'to title', t.dataset.id || '');
                            } else {
                                // 清除残留 transform
                                t.style.transform = '';
                            }
                        } catch (dErr) {
                            console.error('[LAYOUT] dynamic compensation failed for a title', dErr);
                        }
                    });
                }

                // 强制回流后再输出诊断，确保 transform 生效
                void phraseList.offsetHeight;
                logDetailedLayoutDiagnostics('after-dynamic-comp');
                logPhraseListLayout();
            }
        }
    } catch (err) {
        console.error('[LAYOUT] dynamic compensation final failed', err);
    }
    
    // 重新加载话术列表以显示/隐藏拖拽手柄
    loadPhrases();
}

// 输出 phraseList 的布局诊断信息（包括每个子元素的 margin/高度/相邻元素）
function logPhraseListLayout() {
    try {
        const phraseList = document.getElementById('phraseList');
        if (!phraseList) {
            console.log('[LAYOUT] phraseList not found');
            return;
        }
        const children = Array.from(phraseList.children);
        console.log('[LAYOUT] ===== phraseList layout diagnostics start =====');
        children.forEach((child, idx) => {
            try {
                const cs = window.getComputedStyle(child);
                const rect = child.getBoundingClientRect();
                const prev = child.previousElementSibling;
                const next = child.nextElementSibling;
                // 增强输出：包含 display、子元素计数和节点计数，便于发现隐藏文本节点/空容器
                const display = cs.display;
                const childElCount = child.childElementCount;
                const childNodeCount = child.childNodes ? child.childNodes.length : 0;
                console.log(`[LAYOUT] idx=${idx} id=${child.dataset.id||''} classes="${child.className}" top=${rect.top.toFixed(1)} height=${rect.height.toFixed(1)} display=${display} childElCount=${childElCount} childNodeCount=${childNodeCount} marginTop=${cs.marginTop} marginBottom=${cs.marginBottom} prev="${prev?prev.className:''}" next="${next?next.className:''}"`);
                if (child.classList && child.classList.contains('title-phrase-item')) {
                    const nextEl = child.nextElementSibling;
                    if (nextEl && nextEl.classList && nextEl.classList.contains('phrase-group-normal')) {
                        console.log(`[LAYOUT]   title has group next (children=${nextEl.children.length}, childElCount=${nextEl.childElementCount})`);
                    }
                }
            } catch (innerErr) {
                console.error('[LAYOUT] item diag failed', innerErr);
            }
        });
        console.log('[LAYOUT] ===== phraseList layout diagnostics end =====');
    } catch (err) {
        console.error('[LAYOUT] diag error', err);
    }
}

// 显示弹层（支持搜索时高亮关键词）
async function showPopoverForCategory(parentCategoryId, keyword = '', matchedSubCategoryId = null) {
    const categories = allCategoriesCache || await db.getAllCategories();
    const parentCategory = categories.find(c => getCategoryId(c) === parentCategoryId);
    if (!parentCategory) {
        console.warn('[CAT] 未找到父级分类:', parentCategoryId);
        return;
    }
    
    // 找到父级分类对应的DOM元素
    const categoryNav = document.getElementById('categoryNav');
    if (!categoryNav) return;
    
    const categoryItems = categoryNav.querySelectorAll('.category-nav-item');
    let parentItem = null;
    for (const item of categoryItems) {
        const labelSpan = item.querySelector('.cat-label');
        if (labelSpan && labelSpan.textContent === parentCategory.name) {
            parentItem = item;
            break;
        }
    }
    
    if (!parentItem) {
        console.warn('[CAT] 未找到父级分类的DOM元素:', parentCategory.name);
        return;
    }
    
    ensureSubcategoryPopoverOutsideHandler();
    
    // 获取子分类
    const catIdNum = getCategoryId(parentCategory);
    const children = categories.filter(c => getCategoryParentId(c) === catIdNum);
    if (children.length === 0) return;
    
    // 获取或创建弹层
    let pop = document.querySelector(`.subcategory-popover[data-parent='${parentCategoryId}']`);
    if (!pop) {
        pop = document.createElement('div');
        pop.classList.add('subcategory-popover');
        pop.dataset.parent = String(parentCategoryId);
        pop.innerHTML = `
            <div class="popover-list"></div>
        `;
        if (document.body) {
            document.body.appendChild(pop);
            console.log('[CAT] 创建弹层元素 parent=', parentCategoryId);
        } else {
            console.error('[CAT] document.body 不存在，无法创建弹层');
            return;
        }
    }
    
    // 应用主题
    const activeThemeClass = getActiveThemeClass();
    if (activeThemeClass) {
        applyThemeClass(pop, activeThemeClass);
    }
    
    // 渲染子分类列表
    let list = pop.querySelector('.popover-list');
    if (!list) {
        list = document.createElement('div');
        list.className = 'popover-list';
        pop.appendChild(list);
    }
    list.innerHTML = '';
    
    children.forEach(ch => {
        const row = document.createElement('div');
        row.className = 'popover-item';
        if (String(ch.id) === currentSelectedCategoryId) {
            row.classList.add('active');
        }
        
        // 创建分类名称容器
        const nameContainer = document.createElement('div');
        nameContainer.className = 'popover-item-name-container';
        
        // 创建分类名称（如果匹配且有关键词，则高亮）
        const nameSpan = document.createElement('span');
        nameSpan.className = 'popover-item-name';
        if (matchedSubCategoryId && ch.id === matchedSubCategoryId && keyword) {
            // 高亮关键词（弹层文字是白色，使用黄色高亮）
            nameSpan.innerHTML = highlightTextForPopover(ch.name, keyword);
        } else {
            nameSpan.textContent = ch.name;
        }
        nameContainer.appendChild(nameSpan);
        
        // 只有当 show_text_editor 为 true 时才创建按钮
        const showTextEditor = ch.show_text_editor === true;
        let textIconBtn = null;
        if (showTextEditor) {
            textIconBtn = document.createElement('button');
            textIconBtn.className = 'popover-text-icon-btn';
            textIconBtn.textContent = '📝';
            textIconBtn.title = '打开文本编辑器';
            textIconBtn.style.display = 'inline-flex';
            textIconBtn.style.alignItems = 'center';
            textIconBtn.style.justifyContent = 'center';
            textIconBtn.style.background = 'transparent';
            textIconBtn.style.border = 'none';
            textIconBtn.style.padding = '0';
            textIconBtn.style.fontSize = '14px';
            textIconBtn.style.lineHeight = '1';
            textIconBtn.style.cursor = 'pointer';
            textIconBtn.style.opacity = '0.8';
            textIconBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const hidePopover = () => {
                    const pop = document.querySelector(`.subcategory-popover[data-parent='${parentCategoryId}']`);
                    if (pop) pop.classList.remove('visible');
                };
                hidePopover();
                await openCategoryTextEditor(ch.id, ch.name);
            });
        }
        
        if (textIconBtn) {
            nameContainer.appendChild(textIconBtn);
        }
        row.appendChild(nameContainer);
        
        row.addEventListener('click', async (e) => {
            if (e.target.classList.contains('popover-text-icon-btn')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const hidePopover = () => {
                const pop = document.querySelector(`.subcategory-popover[data-parent='${parentCategoryId}']`);
                if (pop) pop.classList.remove('visible');
            };
            hidePopover();
            
            // 保存二级分类点击记录
            await saveSubCategoryClickHistory(ch.id, ch.name, parentCategoryId, parentCategory.name);
            
            await selectCategory(ch.id);
        });
        list.appendChild(row);
    });
    
    // 计算位置
    const rect = parentItem.getBoundingClientRect();
    let left = Math.round(rect.right + 6);
    const estimatedWidth = 240;
    if (left + estimatedWidth > window.innerWidth) {
        left = Math.max(10, Math.round(rect.left - estimatedWidth - 6));
    }

    // 智能根据可用空间设置位置和高度，优先向下显示；保留最小高度 180px，离页面边缘保留 10px
    const spaceBelow = window.innerHeight - rect.top;
    const spaceAbove = rect.top;
    let top = Math.round(rect.top);
    let maxHeight;
    // 如果下方空间明显不足而上方空间更大，则向上显示
    if (spaceBelow < 200 && spaceAbove > spaceBelow) {
        maxHeight = Math.max(180, Math.floor(rect.top - 10));
        top = Math.max(10, Math.round(rect.top - maxHeight));
    } else {
        maxHeight = Math.max(180, Math.floor(window.innerHeight - rect.top - 10));
        top = Math.round(rect.top);
    }

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${maxHeight}px`;
    console.log('[CAT] 显示弹层 at', { left, top, maxHeight });
    pop.classList.add('visible');
}

// 为弹层高亮文本（弹层文字是白色，使用黄色高亮）
function highlightTextForPopover(rawText, keyword) {
    if (!keyword) return escapeHtml(rawText);
    const escaped = escapeHtml(rawText);
    try {
        const pattern = new RegExp(escapeRegex(keyword), 'gi');
        return escaped.replace(pattern, (m) => `<mark class="popover-search-highlight">${m}</mark>`);
    } catch (e) {
        return escaped;
    }
}

// 加载话术列表
// forceRefreshTabs: 是否强制重新渲染平铺区域（用于删除分类等场景）
async function loadPhrases(forceRefreshTabs = false) {
    const searchInput = document.getElementById('searchInput');
    const phraseList = document.getElementById('phraseList');
    
    // 检查元素是否存在
    if (!searchInput || !phraseList) {
        console.error('❌ 话术列表相关元素不存在');
        return;
    }

    const keyword = searchInput.value;
    const isSearching = keyword.trim() !== '';
    
    // 如果搜索关键词为空，关闭所有弹层
    // 如果搜索关键词不为空，先关闭所有弹层（准备显示新的匹配弹层）
    hideAllSubcategoryPopovers();
    
    // 如果正在搜索，则搜索全部话术（不限制分类）
    // 如果不是搜索，则按当前选中的分类过滤
    const categoryId = isSearching ? null : currentSelectedCategoryId;
    
    console.log('📝 加载话术 - 关键词:', keyword || '(无)', '分类ID:', categoryId || '(全部)', '类型:', typeof categoryId);
    
    // 如果正在搜索，同时搜索二级分类名称
    // 注意：只有在真正的搜索模式下（categoryId 为 null）才显示搜索弹层
    // 如果 categoryId 不为空，说明是分类浏览模式，不应该显示搜索弹层
    let matchedSubCategory = null;
    if (isSearching && keyword && categoryId === null) {
        const categories = allCategoriesCache || await db.getAllCategories();
        const lowerKeyword = keyword.toLowerCase();
        // 只搜索二级分类（parent_id !== 0）
        matchedSubCategory = categories.find(cat => {
            const parentId = getCategoryParentId(cat);
            return parentId !== 0 && 
                   cat.name.toLowerCase().includes(lowerKeyword);
        });
        
        if (matchedSubCategory) {
            const parentId = getCategoryParentId(matchedSubCategory);
            console.log('[CAT] 搜索到匹配的二级分类:', matchedSubCategory.name, '父级分类ID:', parentId);
            // 显示弹层并高亮匹配的二级分类
            await showPopoverForCategory(parentId, keyword, getCategoryId(matchedSubCategory));
        }
    }
    
    // 🔧 只显示直接属于该分类的话术，不包含子分类的话术
    // 🔧 “更多(子话术)”：主列表只渲染父话术（parent_id 为 null），避免子话术混入主排序/分组
    const allMatchedPhrases = await db.searchPhrases(keyword, categoryId, false, false, allCategoriesCache);
    const phrases = (allMatchedPhrases || []).filter(p => p.parent_id === null || p.parent_id === undefined);

    console.log('✅ 找到', phrases.length, '条话术');
    console.log('🔍 [调试] loadPhrases - categoryId:', categoryId);
    console.log('🔍 [调试] loadPhrases - allMatchedPhrases:', allMatchedPhrases?.length);
    console.log('🔍 [调试] loadPhrases - phrases (filtered):', phrases.length);
    console.log('🔍 [调试] loadPhrases - currentSelectedCategoryId:', currentSelectedCategoryId);
    
    if (phrases.length === 0) {
        // 🔍 检查是否整个数据库都是空的
        const allPhrases = await db.getAllPhrases();
        
        if (allPhrases.length === 0) {
            // 🚨 数据库完全为空，显示导入提示（桌面版不显示177条默认话术按钮）
            const isDesktop = typeof window !== 'undefined' && window.isDesktopApp;
            const defaultDataImported = await db.getSetting('defaultDataImported', 'false');
            const shouldShowDefaultImport = !isDesktop && defaultDataImported !== 'true';
            phraseList.innerHTML = `
                <div class="empty-state">
                    <p>😊 暂无话术</p>
                    <p>请使用"导入"功能导入您的JSON或CSV文件</p>
                    ${shouldShowDefaultImport ? `
                        <p>首次使用应该会自动导入 177 条默认话术</p>
                        <p>如果没有自动导入，请点击下方按钮：</p>
                        <button id="importDefaultBtn" class="btn btn-primary" style="margin-top: 15px;">
                            📥 导入默认话术 (177 条)
                        </button>
                    ` : `
                        <p>您可以新建话术或通过导入功能批量导入数据</p>
                    `}
                </div>
            `;
            
            // 添加导入按钮事件（仅浏览器插件版）
            if (shouldShowDefaultImport) {
                const importBtn = document.getElementById('importDefaultBtn');
                if (importBtn) {
                    importBtn.addEventListener('click', async () => {
                        importBtn.disabled = true;
                        importBtn.textContent = '导入中...';
                        
                        try {
                            // 调用后台脚本导入
                            const response = await chrome.runtime.sendMessage({ 
                                action: 'importDefaultPhrases' 
                            });
                            
                            if (response.success) {
                                showToast(`✅ 成功导入 ${response.count} 条默认话术！`);
                                // 刷新页面
                                await loadCategories();
                                await loadPhrases();
                            } else {
                                showToast('❌ 导入失败: ' + response.error);
                                importBtn.disabled = false;
                                importBtn.textContent = '📥 重试导入';
                            }
                        } catch (error) {
                            console.error('导入失败:', error);
                            showToast('❌ 导入失败: ' + error.message);
                            importBtn.disabled = false;
                            importBtn.textContent = '📥 重试导入';
                        }
                    });
                }
            }
        } else {
            // 有话术但搜索/筛选结果为空
            phraseList.innerHTML = '';
            
            // 🆕 即使话术为空，也显示平铺二级分类区域
            const subcategoryMode = await db.getSetting('subcategoryDisplayMode', 'tabs');
            if (subcategoryMode === 'tabs' && !isSearching && categoryId) {
                const categories = allCategoriesCache || await db.getAllCategories();
                const currentCategory = categories.find(c => String(getCategoryId(c)) === String(categoryId));
                
                if (currentCategory) {
                    const parentId = getCategoryParentId(currentCategory);
                    const isTopLevel = parentId === 0;
                    const targetParentId = isTopLevel ? categoryId : parentId;
                    
                    const tabsArea = await renderSubcategoryTabsArea(targetParentId);
                    if (tabsArea) {
                        phraseList.appendChild(tabsArea);
                    }
                }
            }
            
            // 添加空状态提示
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'empty-state';
            emptyDiv.innerHTML = `
                <p>😊 暂无话术</p>
                <p>点击下方按钮开始添加内容</p>
                <div style="margin-top: 15px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
                    <button id="emptyAddPhraseBtn" class="btn btn-primary">
                        ➕ 添加话术
                    </button>
                    <button id="emptyAddCategoryBtn" class="btn btn-secondary">
                        ➕ 添加分类
                    </button>
                </div>
            `;
            phraseList.appendChild(emptyDiv);
            
            // 添加按钮事件
            const emptyAddBtn = document.getElementById('emptyAddPhraseBtn');
            if (emptyAddBtn) {
                emptyAddBtn.addEventListener('click', () => {
                    openPhraseDialog();
                });
            }
            const emptyAddCategoryBtn = document.getElementById('emptyAddCategoryBtn');
            if (emptyAddCategoryBtn) {
                emptyAddCategoryBtn.addEventListener('click', () => {
                    openCategoryDialog(0);  // 打开添加分类对话框，parentId=0 表示一级分类
                });
            }
        }
        return;
    }
    
    // 获取当前排序模式
    const sortMode = await db.getSetting('sort_mode', 'manual');
    // 🎯 从全局状态读取 isSortModeActive，确保重新渲染时不会丢失
    // window 属性 → localStorage → false (多级兜底)
    const isSortModeActive = window._sortModeActive 
        || localStorage.getItem('_sortModeActive') === '1'
        || false;
    // 只有在手动排序模式且激活了排序模式时才显示拖拽手柄
    const showDragHandle = sortMode === 'manual' && isSortModeActive;

    if (DEBUG_MODE) {
        console.log('[拖拽调试] 📋 排序模式检查:', 'sortMode=' + sortMode, 'isSortModeActive=' + isSortModeActive, 'showDragHandle=' + showDragHandle);
    }
    
    // 🆕 检查二级分类显示模式
    // ⚠️ 说明：PyQt 桌面版目前主打「tabs 平铺模式」，这里仍读取 'popover' 只是为了兼容旧数据；
    // 常规开发时请把精力放在 tabs 相关的渲染和样式上，避免再去微调弹层模式。
    const subcategoryMode = await db.getSetting('subcategoryDisplayMode', 'tabs');

    // 🧩 读取标题折叠全局设置（作为当前渲染时的缓存）
    try {
        enableTitleCollapseSetting = await db.getSetting('enableTitleCollapse', enableTitleCollapseSetting || 'false');
    } catch (e) {
        enableTitleCollapseSetting = 'false';
    }
    
    // 🎯 优化：检查是否可以只更新平铺区域的激活状态，而不重新渲染
    let shouldPreserveTabsArea = false;
    let existingTabsArea = null;
    
    // 如果强制刷新，则不保留平铺区域
    if (!forceRefreshTabs && subcategoryMode === 'tabs' && !isSearching && categoryId) {
        const categories = allCategoriesCache || await db.getAllCategories();
        const currentCategory = categories.find(c => String(getCategoryId(c)) === String(categoryId));
        
        if (currentCategory) {
            const parentId = getCategoryParentId(currentCategory);
            const isTopLevel = parentId === 0;
            const targetParentId = isTopLevel ? categoryId : parentId;
            
            // 检查是否已经有平铺区域
            existingTabsArea = phraseList.querySelector('.subcategory-tabs-container');
            if (existingTabsArea) {
                // 检查父级ID是否相同
                const existingParentId = existingTabsArea.dataset.parentId;
                if (existingParentId === String(targetParentId)) {
                    // 父级相同，可以只更新激活状态
                    shouldPreserveTabsArea = true;
                }
            }
        }
    }
    
    // 如果需要保留平铺区域，只清空话术卡片部分
    if (shouldPreserveTabsArea && existingTabsArea && !forceRefreshTabs) {
        // 只删除话术卡片，保留平铺区域
        const phrasesCards = Array.from(phraseList.children).filter(child => 
            !child.classList.contains('subcategory-tabs-container')
        );
        phrasesCards.forEach(card => card.remove());
        
        // 更新平铺区域的激活状态
        updateSubcategoryTabsActiveState();
    } else {
        // 完全清空列表
        phraseList.innerHTML = '';
        
        // 创建新的平铺区域
        if (subcategoryMode === 'tabs' && !isSearching && categoryId) {
            const categories = allCategoriesCache || await db.getAllCategories();
            const currentCategory = categories.find(c => String(getCategoryId(c)) === String(categoryId));
            
            if (currentCategory) {
                const parentId = getCategoryParentId(currentCategory);
                const isTopLevel = parentId === 0;
                
                // 如果是一级分类，显示它的二级分类
                // 如果是二级分类，显示它所属的一级分类的二级分类
                const targetParentId = isTopLevel ? categoryId : parentId;
                
                const tabsArea = await renderSubcategoryTabsArea(targetParentId);
                if (tabsArea) {
                    phraseList.appendChild(tabsArea);
                }
            }
        }
    }
    
    // 只有在搜索时才显示分类标签
    // 🧩 标题分组：按 title_order 排标题，组内按 sort_order 排话术，每个分组内序号从1开始
    const categories = allCategoriesCache || await db.getAllCategories();

    // 为每个话术添加跳转分类名称
    phrases.forEach(phrase => {
        if (phrase.jump_category_id) {
            const jumpCategory = categories.find(cat => cat.id === phrase.jump_category_id);
            if (jumpCategory) {
                phrase.jump_category_name = jumpCategory.name.replace(/^🗑️/, '');
            }
        }
    });


    // ===== 作为标题（act_as_title）：独立字段，localStorage 旁路持久化，不触发旧 is_title 标题分组 =====
    if (!window.__actAsTitleHelpers) {
        const _getSet = () => { try { return new Set(JSON.parse(localStorage.getItem('act_as_title_ids') || '[]')); } catch (e) { return new Set(); } };
        window.__actAsTitleHelpers = {
            has: (id) => _getSet().has(Number(id)),
            set: (id, v) => { const s = _getSet(); const n = Number(id); if (v) s.add(n); else s.delete(n); localStorage.setItem('act_as_title_ids', JSON.stringify([...s])); },
        };
    }
    phrases.forEach(p => { p.act_as_title = window.__actAsTitleHelpers.has(p.id); });
    if (!window.__actTitleTextEditorHelpers) {
        const _getSet2 = () => { try { return new Set(JSON.parse(localStorage.getItem('act_title_text_editor_ids') || '[]')); } catch (e) { return new Set(); } };
        window.__actTitleTextEditorHelpers = {
            has: (id) => _getSet2().has(Number(id)),
            set: (id, v) => { const s = _getSet2(); const n = Number(id); if (v) s.add(n); else s.delete(n); localStorage.setItem('act_title_text_editor_ids', JSON.stringify([...s])); },
        };
    }
    phrases.forEach(p => { p.act_title_text_editor = window.__actTitleTextEditorHelpers.has(p.id); });

    // 【已废弃·原标题功能】以下 is_title 标题分组逻辑已舍弃，改用 act_as_title 子话术方案。请勿在此处修改标题分组行为。
    // 分离标题和话术
    const titles = phrases.filter(p => p.is_title === true);
    const nonTitles = phrases.filter(p => !p.is_title);

    // 标题按 title_order 排序
    titles.sort((a, b) => (a.title_order ?? 999999) - (b.title_order ?? 999999));

    // 构建分组：每个标题 + 其归属的话术（按 sort_order 就近归属）
    const segments = titles.map(title => ({ title, phrases: [] }));

    // 没有标题时，所有话术归入一个默认分组
    if (segments.length === 0) {
        segments.push({ title: null, phrases: [...nonTitles] });
    } else {
        // 按 sort_order 就近归属：每个话术归属于 sort_order 不大于它的最近标题
        nonTitles.sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));
        nonTitles.forEach(phrase => {
            let assignedTitle = null;
            for (const title of titles) {
                if ((title.sort_order ?? -999999) <= (phrase.sort_order ?? 999999)) {
                    assignedTitle = title;
                } else {
                    break;
                }
            }
            if (assignedTitle) {
                const seg = segments.find(s => s.title && s.title.id === assignedTitle.id);
                if (seg) seg.phrases.push(phrase);
            } else {
                // 没有前序标题的话术 → 归入无标题分组（插到最前面）
                if (segments.length > 0 && segments[0].title === null) {
                    segments[0].phrases.unshift(phrase);
                } else {
                    segments.unshift({ title: null, phrases: [phrase] });
                }
            }
        });
    }

    // 【已废弃·原标题功能】以下 segment.title 标题卡片渲染已舍弃，改用 act_as_title 子话术方案。请勿在此处修改。
    // 渲染分组
    segments.forEach(segment => {
        // 渲染标题卡片
        if (segment.title) {
            const titleItem = createPhraseItem(segment.title, isSearching, showDragHandle);
            phraseList.appendChild(titleItem);
        }

        // 渲染话术分组容器
        const group = document.createElement('div');
        group.className = 'phrase-list phrase-group-normal';

        // 折叠处理
        if (segment.title &&
            (enableTitleCollapseSetting === 'true' || enableTitleCollapseSetting === true) &&
            segment.title.is_collapsed === true) {
            group.style.display = 'none';
        }

        // 渲染组内话术
        segment.phrases.forEach(phrase => {
            const item = createPhraseItem(phrase, isSearching, showDragHandle);
            group.appendChild(item);
        });

        phraseList.appendChild(group);
    });

    // 在话术卡片列表最后添加一个一行样式的"添加话术/添加分类"按钮卡片
    const addPhraseCard = document.createElement('div');
    addPhraseCard.className = 'phrase-item add-phrase-card';
    // 两个入口紧凑排列，竖线分隔：添加话术 | 添加分类
    addPhraseCard.innerHTML = `
        <div class="add-phrase-card-inner">
            <button class="add-phrase-btn add-phrase-normal">添加话术</button>
            <div class="add-phrase-divider"></div>
            <button class="add-phrase-btn add-category-btn">添加分类</button>
        </div>
    `;
    
    // 添加悬停效果（移除向上偏移动画）
    addPhraseCard.addEventListener('mouseenter', () => {
        addPhraseCard.style.borderColor = 'var(--theme-primary, #667eea)';
        addPhraseCard.style.background = 'var(--theme-hover-bg, #f5f7ff)';
        // 移除了 addPhraseCard.style.transform = 'translateY(-1px)';
    });
    addPhraseCard.addEventListener('mouseleave', () => {
        addPhraseCard.style.borderColor = '#d0d0d0';
        addPhraseCard.style.background = '#fafafa';
        // 移除了 addPhraseCard.style.transform = 'translateY(0)';
    });
    
    // 点击事件
    const addPhraseBtn = addPhraseCard.querySelector('.add-phrase-normal');
    const addCategoryBtn = addPhraseCard.querySelector('.add-category-btn');
    if (addPhraseBtn) {
        addPhraseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openPhraseDialog();
        });
    }
    if (addCategoryBtn) {
        addCategoryBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCategoryDialog(0);  // 打开添加分类对话框，parentId=0 表示一级分类
        });
    }
    
    phraseList.appendChild(addPhraseCard);

    // 默认收起所有子话术（不再自动展开）
    // 注释掉以下代码以实现默认收起
    /*
    // 默认展开所有子话术（使用 requestAnimationFrame 减少闪烁）
    requestAnimationFrame(() => {
        try {
            const moreCornerBtns = phraseList.querySelectorAll('.phrase-more-corner');
            if (moreCornerBtns.length === 0) return;
            
            const toExpand = [];
            for (const btn of moreCornerBtns) {
                const parentItem = btn.closest('.phrase-item');
                if (parentItem) {
                    const phraseId = parseInt(parentItem.dataset.id, 10);
                    if (phraseId && !__moreExpandedParents.has(phraseId)) {
                        toExpand.push({ phraseId, parentItem, btn });
                    }
                }
            }
            
            if (toExpand.length === 0) return;
            
            // 批量添加到展开集合
            for (const { phraseId, parentItem, btn } of toExpand) {
                __moreExpandedParents.add(phraseId);
                parentItem.classList.add('more-expanded');
                const textEl = btn.querySelector('.phrase-more-corner-text');
                if (textEl) textEl.textContent = '-';
            }
            
            // 异步渲染子话术容器
            setTimeout(() => {
                for (const { phraseId, parentItem } of toExpand) {
                    ensureMoreChildrenExpanded(phraseId, parentItem);
                }
            }, 0);
        } catch (e) {
            console.warn('[子话术] 默认展开失败:', e);
        }
    });
    */
    
    // 更新每个话术卡片的单行/多行状态（影响操作按钮垂直位置）
    try {
        if (typeof updatePhraseCardLineMode === 'function') {
            updatePhraseCardLineMode();
        }
    } catch (e) {
        console.error('[LAYOUT] updatePhraseCardLineMode failed', e);
    }
}

// 加载回收站
async function loadRecycleBin() {
    const phraseList = document.getElementById('phraseList');
    
    // 检查元素是否存在
    if (!phraseList) {
        console.error('❌ 话术列表元素不存在');
        return;
    }
    
    console.log('🗑️ 加载回收站');
    
    // 获取已删除的话术
    const deletedPhrases = await db.getDeletedPhrases();
    
    console.log('✅ 找到', deletedPhrases.length, '条已删除话术');
    
    if (deletedPhrases.length === 0) {
        phraseList.innerHTML = `
            <div class="empty-state">
                <p>🗑️ 回收站是空的</p>
                <p>删除的话术会出现在这里</p>
            </div>
        `;
        return;
    }
    
    phraseList.innerHTML = '';
    // 回收站不显示拖拽手柄，但显示分类信息
    deletedPhrases.forEach(phrase => {
        const item = createRecycleBinItem(phrase);
        phraseList.appendChild(item);
    });
}

// 创建回收站话术项
function createRecycleBinItem(phrase) {
    const div = document.createElement('div');
    div.className = 'phrase-item recycle-item';
    div.dataset.id = phrase.id;
    
    // 解析标签（确保 tags 是字符串）
    const tagsStr = phrase.tags && typeof phrase.tags === 'string' ? phrase.tags : '';
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
    
    // 格式化标签为 "#标签1 #标签2" 格式
    const tagsForDisplay = tags.length > 0 ? tags.map(tag => `#${tag}`).join(' ') : '';
    
    // 获取分类名称
    const categoryName = phrase.category_name || '未分类';
    const categoryLabelHtml = phrase.category_id ?
        `<span class="phrase-category-label-inline phrase-category-clickable" data-category-id="${phrase.category_id}" title="点击跳转到该分类">${escapeHtml(categoryName)}</span>` :
        `<span class="phrase-category-label-inline">${escapeHtml(categoryName)}</span>`;
    
    // 显示内容：如果有HTML格式，使用HTML；否则使用纯文本
    const displayContent = phrase.content_html || escapeHtml(phrase.content);

    // 构建标签 HTML
    const tagsHtml = tagsForDisplay ? `<span class="phrase-tags-inline">${escapeHtml(tagsForDisplay)}</span>` : '';
    // 将标签插入到内容的最后一行内部
    const contentWithTags = appendTagsToLastLine(
        `${categoryLabelHtml}${displayContent}`,
        tagsHtml
    );

    div.innerHTML = `
        <div class="phrase-content" data-tags="${escapeHtml(tagsForDisplay)}">
            <button class="phrase-restore-btn-inline" data-id="${phrase.id}" title="恢复话术">🔄</button>
            ${contentWithTags}
        </div>
        <button class="phrase-delete-permanently-btn-inline" data-id="${phrase.id}" title="永久删除">🗑️ 永久</button>
    `;
    
    // 恢复按钮事件（内联按钮）
    const restoreBtn = div.querySelector('.phrase-restore-btn-inline');
    if (restoreBtn) {
        restoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await restorePhrase(phrase.id);
        });
    }
    
    // 永久删除按钮事件
    const deletePermanentlyBtn = div.querySelector('.phrase-delete-permanently-btn-inline');
    if (deletePermanentlyBtn) {
        deletePermanentlyBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await deletePermanently(phrase.id);
        });
    }
    
    // 统一用 JS 控制悬停态，避免某些环境下 :hover 兼容问题（参考普通话术卡片实现）
    div.addEventListener('mouseenter', () => {
        div.classList.add('hovering');
    });
    div.addEventListener('mouseleave', () => {
        div.classList.remove('hovering');
    });
    
    // 点击话术复制到剪贴板（只复制纯文本内容）
    div.addEventListener('click', async (e) => {
        // 如果点击的是按钮或可点击的分类名称，不触发复制
        if (e.target.classList.contains('phrase-restore-btn-inline') ||
            e.target.classList.contains('phrase-delete-permanently-btn-inline') ||
            e.target.classList.contains('phrase-category-clickable')) {
            return;
        }

        // 检查是否有选中的文本，如果有则不执行复制操作，让用户使用快捷键复制选中的文本
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
            // 有选中的文本，不执行复制整个话术的操作
            return;
        }

        // 复制纯文本内容到剪贴板
        // 检查是否有占位符填充值
        const cachedData = placeholderEditCache[phrase.id];
        let contentToCopy = phrase.content;
        if (cachedData && cachedData.placeholderValues) {
            contentToCopy = getFilledContent(phrase.content, cachedData.placeholderValues);
        }
        
        const success = await copyToClipboard(contentToCopy);
        if (success) {
            showToast('已复制');
            console.log('✅ 已复制回收站话术:', contentToCopy);
        } else {
            console.error('复制失败');
            showToast('复制失败', 'error');
        }
    });
    
    return div;
}

// 根据内容高度判断卡片是单行还是多行，控制 .singleline/.multiline 类以决定按钮位置
function updatePhraseCardLineMode() {
    try {
        const phraseList = document.getElementById('phraseList');
        if (!phraseList) return;
        const cards = Array.from(phraseList.querySelectorAll('.phrase-item'));
        cards.forEach(card => {
            try {
                // 找到内容元素：普通话术或标题
                const contentEl = card.querySelector('.phrase-content, .title-phrase-content');
                if (!contentEl) return;
                // 更可靠的多行检测方法：
                // 首选：使用 getClientRects()，当文本在视觉上换行时会返回多个矩形
                // 备选：根据计算行高和 scrollHeight 做判断（部分浏览器/环境下 rects 可能不准确）
                let isMultiline = false;
                try {
                    const rects = contentEl.getClientRects();
                    if (rects && rects.length > 1) {
                        isMultiline = true;
                    }
                } catch (rErr) {
                    // ignore
                }

                if (!isMultiline) {
                    // 备选检测：基于行高估算
                    const cs = window.getComputedStyle(contentEl);
                    let lineHeight = parseFloat(cs.lineHeight);
                    if (!lineHeight || isNaN(lineHeight)) {
                        // 尝试计算：使用字体大小 * 1.2 作为估算（常见默认）
                        const fontSize = parseFloat(cs.fontSize) || 14;
                        lineHeight = fontSize * 1.2;
                    }
                    const estimatedLines = Math.round(contentEl.scrollHeight / Math.max(1, lineHeight));
                    if (estimatedLines > 1) {
                        isMultiline = true;
                    }
                }
                card.classList.toggle('multiline', isMultiline);
                card.classList.toggle('singleline', !isMultiline);
            } catch (inner) {
                // ignore
            }
        });
    } catch (err) {
        console.error('[LAYOUT] updatePhraseCardLineMode error', err);
    }
}

// 在窗口变化时重新计算（响应字体/布局变化）
window.addEventListener('resize', () => {
    try { updatePhraseCardLineMode(); } catch (e) {}
    try { updateSidebarTabsHeight(); } catch (e) {}

    // 监控搜索框容器和话术列表中二级分类容器的间距
    const header = document.querySelector('.header');
    const phraseList = document.getElementById('phraseList');
    if (header && phraseList) {
        const headerBottomPadding = window.getComputedStyle(header).paddingBottom;
        const phraseListTopMargin = window.getComputedStyle(phraseList).marginTop;
        const headerBottom = header.getBoundingClientRect().bottom;
        const phraseListTop = phraseList.getBoundingClientRect().top;
        const actualGap = phraseListTop - headerBottom;

        // 如果话术列表中有二级分类容器，也监控它的间距
        const subcategoryContainer = phraseList.querySelector('.subcategory-tabs-container');
    }
});

// 监控话术列表 DOM 变化（新增/编辑/样式变更）并 debounce 更新 line mode
(function setupPhraseListObserver() {
    try {
        const phraseList = document.getElementById('phraseList');
        if (!phraseList) return;
        let timer = null;
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                updatePhraseCardLineMode();
                timer = null;
            }, 80);
        };
        const mo = new MutationObserver((mutations) => {
            schedule();
        });
        mo.observe(phraseList, { childList: true, subtree: true, characterData: true });
        // 初始一次
        schedule();
    } catch (e) {
        // ignore
    }
})();

/**
 * 将标签插入到内容的最后一行内部（避免多行内容时标签换行）
 * @param {string} contentHtml - 话术内容 HTML
 * @param {string} tagsHtml - 标签 HTML（如 '<span class="phrase-tags-inline">#标签</span>'）
 * @returns {string} 合并后的 HTML
 */
function appendTagsToLastLine(contentHtml, tagsHtml) {
    if (!tagsHtml) return contentHtml || '';
    if (!contentHtml) return tagsHtml;

    // 检查是否包含 </div>（多行内容）
    const lastDivClose = contentHtml.lastIndexOf('</div>');
    if (lastDivClose !== -1) {
        // 将标签插入到最后一个 </div> 之前
        return contentHtml.slice(0, lastDivClose) + tagsHtml + contentHtml.slice(lastDivClose);
    }

    // 没有 </div>，直接追加
    return contentHtml + tagsHtml;
}

// ===== 作为标题：注入样式（序号隐藏 + 主题背景色 + 文字色，模仿标题卡片/二级分类容器），不改 styles.css =====
(function () {
    if (document.getElementById('__actAsTitleStyle')) return;
    const s = document.createElement('style');
    s.id = '__actAsTitleStyle';
    s.textContent = '.phrase-item.act-as-title{counter-increment:none !important;} .phrase-item.act-as-title .phrase-content::before{content:"\\200B" !important;display:inline-block !important;vertical-align:top !important;line-height:1 !important;transform:translateY(2px) !important;color:transparent !important;margin-right:0 !important;margin-left:0 !important;font-size:14px !important;-webkit-user-select:none;user-select:none;} body[data-phrase-font-size="xs"] .phrase-item.act-as-title .phrase-content::before{font-size:11px !important;} body[data-phrase-font-size="small"] .phrase-item.act-as-title .phrase-content::before{font-size:12px !important;} body[data-phrase-font-size="normal"] .phrase-item.act-as-title .phrase-content::before{font-size:14px !important;} body[data-phrase-font-size="large"] .phrase-item.act-as-title .phrase-content::before{font-size:16px !important;} body[data-phrase-font-size="xl"] .phrase-item.act-as-title .phrase-content::before{font-size:18px !important;} body[data-phrase-font-size="xxl"] .phrase-item.act-as-title .phrase-content::before{font-size:20px !important;} body[data-phrase-font-size="xxxl"] .phrase-item.act-as-title .phrase-content::before{font-size:22px !important;} .phrase-item.act-as-title .phrase-number-placeholder{display:none !important;} .phrase-item.act-as-title .phrase-content{color:inherit !important;} body.theme-purple .phrase-item.act-as-title{background:linear-gradient(180deg,#667eea 0%,#764ba2 100%) !important;border-color:rgba(102,126,234,0.5) !important;color:#fff !important;} body.theme-red .phrase-item.act-as-title{background:linear-gradient(180deg,#eb3349 0%,#f45c43 100%) !important;border-color:rgba(235,51,73,0.5) !important;color:#fff !important;} body.theme-orange .phrase-item.act-as-title{background:linear-gradient(180deg,#ff6b35 0%,#f7931e 100%) !important;border-color:rgba(255,107,53,0.5) !important;color:#fff !important;} body.theme-green .phrase-item.act-as-title{background:linear-gradient(180deg,#56ab2f 0%,#a8e063 100%) !important;border-color:rgba(86,171,47,0.5) !important;color:#fff !important;} body.theme-light-gray .phrase-item.act-as-title{background:#f0f0f0 !important;border-color:rgba(148,163,184,0.5) !important;color:#333 !important;} body.theme-metal-gray .phrase-item.act-as-title{background:linear-gradient(180deg,#94a3b8 0%,#64748b 100%) !important;border-color:rgba(100,116,139,0.5) !important;color:#fff !important;} body.theme-champagne .phrase-item.act-as-title{background:linear-gradient(180deg,#e8c4a0 0%,#d4a574 100%) !important;border-color:rgba(212,165,116,0.5) !important;color:#333 !important;} body.theme-cloud-gray .phrase-item.act-as-title{background:linear-gradient(180deg,#d6d3d1 0%,#a8a29e 100%) !important;border-color:rgba(168,162,158,0.5) !important;color:#333 !important;} body.theme-dark-blue .phrase-item.act-as-title{background:#1e293b !important;border-color:#475569 !important;color:#fff !important;} body.theme-dark-gray .phrase-item.act-as-title{background:#374151 !important;border-color:#4b5563 !important;color:#fff !important;} body.theme-dark-purple .phrase-item.act-as-title{background:#4c1d95 !important;border-color:#4c1d95 !important;color:#fff !important;} body.theme-dark-green .phrase-item.act-as-title{background:#064e3b !important;border-color:#047857 !important;color:#fff !important;} .phrase-item.act-as-title{background:var(--title-card-bg,rgba(102,126,234,0.06)) !important;border-color:var(--title-border,rgba(102,126,234,0.4)) !important;} .phrase-item.act-as-title{cursor:pointer !important;} .phrase-item.act-as-title .phrase-content{justify-content:center !important;text-align:center !important;cursor:pointer !important;-webkit-user-select:none !important;user-select:none !important;} .phrase-item.act-as-title .phrase-content *{cursor:pointer !important;-webkit-user-select:none !important;user-select:none !important;} .phrase-item.act-as-title .phrase-tags-inline{color:inherit !important;} .phrase-item.act-as-title .phrase-jump-link{color:inherit !important;}';
    (document.head || document.documentElement).appendChild(s);
})();

// ===== 暗蓝/暗灰/暗紫底部按钮跟随各自主题色（暗绿已跟随不改），不改 styles.css =====
(function () {
    if (document.getElementById('__darkBottomThemeStyle')) return;
    const s = document.createElement('style');
    s.id = '__darkBottomThemeStyle';
    s.textContent = 'body.theme-dark-blue .app-bottom-spacer .sidebar-btn,body.theme-dark-blue .app-bottom-spacer .font-size-btn{background:rgba(59,130,246,0.18) !important;border-color:rgba(96,165,250,0.45) !important;color:#dbeafe !important;} body.theme-dark-blue .app-bottom-spacer .sidebar-btn:hover,body.theme-dark-blue .app-bottom-spacer .font-size-btn:hover{background:rgba(59,130,246,0.32) !important;border-color:rgba(96,165,250,0.7) !important;} body.theme-dark-gray .app-bottom-spacer .sidebar-btn,body.theme-dark-gray .app-bottom-spacer .font-size-btn{background:rgba(148,163,184,0.18) !important;border-color:rgba(203,213,225,0.45) !important;color:#e2e8f0 !important;} body.theme-dark-gray .app-bottom-spacer .sidebar-btn:hover,body.theme-dark-gray .app-bottom-spacer .font-size-btn:hover{background:rgba(148,163,184,0.32) !important;border-color:rgba(203,213,225,0.7) !important;} body.theme-dark-purple .app-bottom-spacer .sidebar-btn,body.theme-dark-purple .app-bottom-spacer .font-size-btn{background:rgba(139,92,246,0.18) !important;border-color:rgba(167,139,250,0.45) !important;color:#ede9fe !important;} body.theme-dark-purple .app-bottom-spacer .sidebar-btn:hover,body.theme-dark-purple .app-bottom-spacer .font-size-btn:hover{background:rgba(139,92,246,0.32) !important;border-color:rgba(167,139,250,0.7) !important;}';
    (document.head || document.documentElement).appendChild(s);
})();

// ===== 说明页面右键菜单模仿文本编辑器浅色样式（白底深色文字），仅作用于 #descriptionContextMenu，不改 styles.css =====
(function () {
    if (document.getElementById('__contextMenuThemeStyle')) return;
    const s = document.createElement('style');
    s.id = '__contextMenuThemeStyle';
    const themes = ['body.theme-purple', 'body.theme-red', 'body.theme-orange', 'body.theme-green'];
    const sel = (sub) => themes.map(t => t + ' #descriptionContextMenu' + (sub ? ' ' + sub : '')).join(',');
    s.textContent = ''
        + sel('') + '{background:#fff !important;border-color:#c0c0c0 !important;color:#333 !important;}'
        + sel('.context-menu-item') + '{color:#333 !important;}'
        + sel('.context-menu-item:hover') + '{background:#f5f5f5 !important;color:#333 !important;}'
        + sel('.context-menu-item:active') + '{background:#e0e0e0 !important;}'
        + sel('.context-menu-item.disabled:hover') + '{background:#fff !important;}'
        + sel('.context-menu-separator') + '{background:#e0e0e0 !important;}'
        + sel('.context-menu-label') + '{color:#666 !important;}'
        + sel('.context-menu-input-group label') + '{color:#333 !important;}'
        + sel('.context-menu-input-group select') + ',' + sel('.context-menu-input-group input[type="color"]') + '{background:rgba(255,255,255,0.9) !important;border-color:#ddd !important;color:#333 !important;}';
    (document.head || document.documentElement).appendChild(s);
})();

// ===== 说明编辑器文字颜色固定深色（背景是浅灰 #f5f5f5，深色主题下继承的浅色文字看不清），不改 styles.css =====
(function () {
    if (document.getElementById('__descriptionContentStyle')) return;
    const s = document.createElement('style');
    s.id = '__descriptionContentStyle';
    s.textContent = '#descriptionContent{color:#333 !important;}';
    (document.head || document.documentElement).appendChild(s);
})();

// ===== 深色主题话术卡片渲染为金属灰效果（白底深色文字），避免深色背景+浅色文字覆盖富文本颜色，不改 styles.css =====
(function () {
    if (document.getElementById('__darkPhraseCardStyle')) return;
    const s = document.createElement('style');
    s.id = '__darkPhraseCardStyle';
    const D = ['body.theme-dark-blue', 'body.theme-dark-gray', 'body.theme-dark-purple', 'body.theme-dark-green'];
    const sel = (sub) => D.map(t => t + ' ' + sub).join(',');
    s.textContent = ''
        + sel('.phrase-item') + '{background:rgba(255,255,255,0.88) !important;border-color:rgba(100,116,139,0.4) !important;color:#333 !important;}'
        + sel('.phrase-content') + '{color:#333 !important;}'
        + sel('.phrase-item:hover') + '{background:rgba(203,213,225,0.85) !important;border-color:#64748b !important;}'
        + sel('.phrase-item.drag-over') + '{background:rgba(100,116,139,0.12) !important;border-top-color:#64748b !important;}';
    (document.head || document.documentElement).appendChild(s);
})();

// ===== 打开新右键菜单前关闭所有已显示的右键菜单，避免多个菜单并存 =====
(function () {
    if (window.__contextMenuCloseAllInit) return;
    window.__contextMenuCloseAllInit = true;
    document.addEventListener('contextmenu', () => {
        document.querySelectorAll('.context-menu.show, .universal-context-menu.show, .phrase-selection-context-menu.show')
            .forEach(m => m.classList.remove('show'));
    }, true);
})();


// 创建话术项
function createPhraseItem(phrase, showCategory = false, showDragHandle = true) {
    const div = document.createElement('div');
    // 【已废弃·原标题功能】isTitle 分支沿用旧标题卡片样式，已舍弃该方案，改用 act_as_title 子话术方案。请勿在此处修改 isTitle 逻辑。
    const isTitle = phrase.is_title === true;
    div.className = 'phrase-item' + (isTitle ? ' title-phrase-item' : '');
    if (phrase.act_as_title === true) div.classList.add('act-as-title');
    div.dataset.id = phrase.id;
    
    // 🎯 检查当前标签页是否已使用该话术
    const currentUsageSet = tabUsageMap.get(activeCustomerTabId) || new Set();
    if (currentUsageSet.has(phrase.id)) {
        div.classList.add('phrase-used');
    }
    
    // 只有在手动排序模式下才启用拖拽（标题和话术都支持拖拽）
    if (showDragHandle) {
        div.draggable = true;
    }
    
    // 🎯 标题卡片拖拽调试日志
    if (DEBUG_MODE) {
        console.log('[拖拽调试] 🔴 标题卡片 drag 检查 - isTitle=' + isTitle + ' draggable=' + div.draggable + ' showDragHandle=' + showDragHandle);
    }
    
    // 解析标签（确保 tags 是字符串）
    const tagsStr = phrase.tags && typeof phrase.tags === 'string' ? phrase.tags : '';
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
    const tagsHtml = tags.map(tag => `<span class="phrase-tag">${tag}</span>`).join('');
    
    // 格式化标签为 "#标签1 #标签2" 格式（用于显示在话术末尾）
    const tagsForDisplay = tags.length > 0 ? tags.map(tag => `#${tag}`).join(' ') : '';
    
    // 获取分类名称（只在搜索时显示）
    const categoryName = phrase.category_name || '未分类';
    const categoryLabelHtml = showCategory && phrase.category_id ?
        `<span class="phrase-category-label phrase-category-clickable" data-category-id="${phrase.category_id}" title="点击跳转到该分类">${escapeHtml(categoryName)}</span>` :
        showCategory ? `<span class="phrase-category-label">${escapeHtml(categoryName)}</span>` : '';
    
    // 拖拽手柄（只在手动排序模式下显示，标题和话术都显示）
    const dragHandleHtml = showDragHandle ? '<div class="drag-handle" title="拖动排序"></div>' : '';
    
    // 扩展功能按钮（标题卡片不显示这些扩展按钮）
    const placeholderBtn = !isTitle && phrase.enable_placeholder && phrase.act_as_title !== true ?
        `<button class="phrase-action-btn placeholder-btn" data-id="${phrase.id}" data-text="补全" title="补全占位符"></button>` : '';
    const imagesBtn = !isTitle && phrase.enable_images && phrase.act_as_title !== true ?
        `<button class="phrase-action-btn images-btn" data-id="${phrase.id}" data-text="图片" title="查看/管理图片"></button>` : '';
    const descriptionBtn = !isTitle && phrase.enable_description ?
        `<button class="phrase-action-btn description-btn" data-id="${phrase.id}" data-text="说明" title="查看/编辑使用说明"></button>` : '';
    const variantsBtn = '';

    // 跳转链接（如果设置了跳转分类则显示）
    const jumpLinkHtml = !isTitle && phrase.jump_category_id ?
        `<span class="phrase-jump-link" data-category-id="${phrase.jump_category_id}" title="点击跳转到 ${escapeHtml(phrase.jump_category_name || '该分类')}">${escapeHtml(phrase.jump_category_name || '跳转')}➤</span>` : '';

    // 判断是否在回收站（category_id = 1）
    const isInRecycleBin = phrase.category_id === 1;
    const restoreBtn = isInRecycleBin ?
        `<button class="phrase-restore-btn" data-id="${phrase.id}" title="恢复话术">🔄</button>` : '';

    // 图片图标（如果话术有图片则显示）
    const hasImages = phrase.images && phrase.images.length > 0;
    const imageIndicator = hasImages ?
        `<span class="phrase-image-indicator" title="此话术包含 ${phrase.images.length} 张图片">🖼️</span>` : '';
    
    // 显示内容：如果有HTML格式，使用HTML；否则使用纯文本
    let displayContent;
    const currentSearch = (document.getElementById('searchInput')?.value || '').trim();
    if (isTitle) {
        const rawTitle = phrase.title_text || phrase.content || '';
        displayContent = currentSearch ? highlightText(rawTitle, currentSearch) : escapeHtml(rawTitle);
    } else if (phrase.content_html) {
        // 使用HTML格式内容（支持部分文字样式）
        displayContent = phrase.content_html;
        if (currentSearch) {
            // 在HTML中高亮搜索关键词（需要保留HTML标签）
            displayContent = highlightTextInHtml(displayContent, currentSearch);
        }
    } else {
        // 使用纯文本内容
        displayContent = currentSearch ? highlightText(phrase.content, currentSearch) : escapeHtml(phrase.content);
    }
    
    // 渲染占位符（如果启用补全功能）
    // 注意：这里暂时不渲染占位符，而是在进入编辑模式时重新渲染

    // 应用整体样式（这些样式会应用到整个卡片）
    // 注意：如果 content_html 存在，说明有部分文字样式，此时不应该应用整体样式
    const styleAttrs = [];
    if (!phrase.content_html && !isTitle) {
        // 只有在没有部分样式且不是标题卡片时，才应用整体样式
        if (phrase.text_color) {
            styleAttrs.push(`color: ${phrase.text_color}`);
        }
        if (phrase.bg_color) {
            styleAttrs.push(`background-color: ${phrase.bg_color}`);
        }
        if (phrase.is_bold) {
            styleAttrs.push(`font-weight: bold`);
        }
    }
    const styleStr = styleAttrs.length > 0 ? ` style="${styleAttrs.join('; ')}"` : '';

    if (isTitle) {
        // 标题卡片：粗体 + 特殊背景，只有编辑/删除按钮，不参与点击复制
        // 检查是否显示文本编辑按钮
        const showTextEditor = phrase.show_text_editor === true;
        const textEditorBtn = showTextEditor ? `<button class="phrase-action-btn text-editor-btn" data-id="${phrase.id}" data-text="📝" title="打开文本编辑器"></button>` : '';

        div.innerHTML = `
            ${dragHandleHtml}
            <div class="phrase-content title-phrase-content">
                ${categoryLabelHtml}${displayContent}
            </div>
            <div class="phrase-actions">
                ${textEditorBtn}
                <button class="phrase-action-btn edit-title-btn" data-id="${phrase.id}" data-text="编辑"></button>
                <button class="phrase-action-btn delete-title-btn" data-id="${phrase.id}" data-text="删除"></button>
            </div>
        `;
        // 记录折叠状态，供后续折叠逻辑使用
        div.dataset.collapsed = phrase.is_collapsed === true ? 'true' : 'false';
    } else {
        // 构建标签 HTML（根据 tag_prefix 决定样式类）
        const tagPrefixClass = phrase.tag_prefix ? ' tag-prefix' : '';
        const tagsHtml = tagsForDisplay ? `<span class="phrase-tags-inline${tagPrefixClass}">${escapeHtml(tagsForDisplay)}</span>` : '';
        // 根据 tag_prefix 决定标签位置
        let contentWithTags;
        if (phrase.tag_prefix) {
            // 标签前置：序号 → 图片指示器 → 标签 → 话术内容
            contentWithTags = `${categoryLabelHtml}${imageIndicator}${tagsHtml}${displayContent}`;
        } else {
            // 标签后置（默认）：序号 → 图片指示器 → 话术内容 → 标签
            contentWithTags = appendTagsToLastLine(
                `${categoryLabelHtml}${imageIndicator}${displayContent}`,
                tagsHtml
            );
        }

        div.innerHTML = `
            ${dragHandleHtml}
            ${restoreBtn}
            <div class="phrase-content" data-tags="${escapeHtml(tagsForDisplay)}"${styleStr}>
                <span class="phrase-number-placeholder" title="点击序号可自动粘贴"></span>
                ${contentWithTags}
            </div>
            ${jumpLinkHtml ? `<div class="phrase-jump-row">${jumpLinkHtml}</div>` : ''}
            <div class="phrase-actions">
                ${placeholderBtn}
                ${imagesBtn}
                ${descriptionBtn}
                ${variantsBtn}
                <button class="phrase-action-btn edit-btn" data-id="${phrase.id}" data-text="编辑"></button>
                <button class="phrase-action-btn delete-btn" data-id="${phrase.id}" data-text="删除"></button>
            </div>
        `;
    }
    
    // 🎯 为拖拽手柄单独设置 draggable，使其成为拖拽触发点（必须在 innerHTML 设置之后）
    if (showDragHandle) {
        const dragHandle = div.querySelector('.drag-handle');
        if (dragHandle) {
            dragHandle.draggable = true;

            // 阻止拖拽手柄的事件冒泡，防止触发折叠逻辑（不阻止默认行为，允许拖拽启动）
            dragHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });

            // 🎯 为拖拽手柄绑定拖拽事件，使其能触发父元素的拖拽逻辑
            dragHandle.addEventListener('dragstart', (e) => {
                // 触发父元素的 dragstart 事件
                div.dispatchEvent(new DragEvent('dragstart', e));
            });

            dragHandle.addEventListener('dragend', (e) => {
                div.dispatchEvent(new DragEvent('dragend', e));
            });
        }
    }

    // 统一用 JS 控制悬停态，避免某些环境下 :hover 兼容问题
    div.addEventListener('mouseenter', () => {
        div.classList.add('hovering');
    });
    div.addEventListener('mouseleave', () => {
        div.classList.remove('hovering');
    });
    
    // 如果不显示拖拽手柄，调整左边距
    if (!showDragHandle) {
        div.style.paddingLeft = '6px';
    }
    
    // 缩减右边距
    div.style.paddingRight = (!isTitle && phrase.enable_variants && phrase.act_as_title !== true) ? '24px' : '6px';

    if (!isTitle && phrase.enable_variants && phrase.act_as_title !== true) {
        div.classList.add('has-more-corner');
        const cornerBtn = document.createElement('button');
        cornerBtn.type = 'button';
        cornerBtn.className = 'phrase-more-corner';
        cornerBtn.setAttribute('aria-label', '展开/收起子话术');
        cornerBtn.innerHTML = `<span class="phrase-more-corner-text">+</span>`;
        cornerBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await openVariantsDialog(phrase.id, div);
        });
        cornerBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        div.appendChild(cornerBtn);

        try {
            if (__moreExpandedParents && __moreExpandedParents.has && __moreExpandedParents.has(phrase.id)) {
                div.classList.add('more-expanded');
                const textEl = cornerBtn.querySelector('.phrase-more-corner-text');
                if (textEl) textEl.textContent = '-';
                ensureMoreChildrenExpanded(phrase.id, div);
            }
        } catch (e) {
            // ignore
        }
    }

    // 作为标题：点击 .phrase-content 文字展开/折叠子话术（替代角标）
    if (phrase.act_as_title === true) {
        const _actContentEl = div.querySelector('.phrase-content');
        if (_actContentEl) {
            _actContentEl.style.cursor = 'pointer';
            _actContentEl.style.userSelect = 'none';
            _actContentEl.style.webkitUserSelect = 'none';
            _actContentEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                await toggleMoreChildren(phrase.id, div);
            });
        }
        if (phrase.act_title_text_editor === true && _actContentEl) {
            const _teBtn = document.createElement('button');
            _teBtn.type = 'button';
            _teBtn.title = '打开文本编辑器';
            _teBtn.textContent = '📝';
            _teBtn.style.cssText = 'margin-right:-4px;cursor:pointer;border:none;background:transparent;font-size:14px;padding:0;vertical-align:middle;transform:translateY(-2px);';
            _teBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (typeof openCategoryTextEditor === 'function') {
                    openCategoryTextEditor(phrase.category_id, phrase.title_text || phrase.content || '文本编辑器');
                }
            });
            _actContentEl.insertBefore(_teBtn, _actContentEl.firstChild);
        }
        try {
            if (__moreExpandedParents && __moreExpandedParents.has && __moreExpandedParents.has(phrase.id)) {
                div.classList.add('more-expanded');
                ensureMoreChildrenExpanded(phrase.id, div);
            }
        } catch (e) {
            // ignore
        }
    }
    
    // 检查是否关闭了点击复制功能（标题卡片/作为标题 一律不启用点击复制，改为点击折叠子话术）
    const disableClickCopy = isTitle || phrase.act_as_title === true || phrase.disable_click_copy || false;
    
    // 只有在未关闭点击复制时才绑定点击事件
    if (!disableClickCopy) {
        // 提升响应：改为 mousedown 触发，感觉更"即时"
    // 记录 mousedown 位置，用于判断是否发生了拖拽选择
    let mouseDownX = 0;
    let mouseDownY = 0;
    let mouseDownTime = 0;

    div.addEventListener('mousedown', (e) => {
        mouseDownX = e.clientX;
        mouseDownY = e.clientY;
        mouseDownTime = Date.now();
    });

    const handleActivate = async (e) => {
        // 如果点击的是拖拽手柄、操作按钮、恢复按钮、可点击分类名称，忽略
        if (e.target.classList.contains('drag-handle') ||
            e.target.classList.contains('phrase-action-btn') ||
            e.target.classList.contains('phrase-restore-btn') ||
            e.target.classList.contains('phrase-category-clickable')) {
            return;
        }

        // 检查是否有选中的文本（划选后 mouseup 时选择已完成）
        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
            // 有选中的文本，不执行复制整个话术的操作，让用户使用右键菜单或 Ctrl+C 复制
            return;
        }

        // 检查是否发生了拖拽（mousedown 到 mouseup 距离 > 5px），即使选择文本为空也视为拖拽意图
        const dx = e.clientX - mouseDownX;
        const dy = e.clientY - mouseDownY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const elapsed = Date.now() - mouseDownTime;
        if (distance > 5 && elapsed > 100) {
            // 拖拽距离较大且耗时较长，视为选择操作，不触发整句复制
            return;
        }

        // 检查是否点击了序号区域（左上角 25x25px 的正方形区域）
        const contentEl = div.querySelector('.phrase-content');
        if (contentEl) {
            const rect = contentEl.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;

            // 序号区域：左侧 0-25px 且 顶部 0-25px 的正方形区域
            const isClickingNumber = clickX >= 0 && clickX <= 25 && clickY >= 0 && clickY <= 25;

            if (isClickingNumber) {
                // 点击了序号区域，执行自动粘贴
                e.stopPropagation();
                e.preventDefault();

                // 防重复：200ms 内忽略重复触发
                const now = Date.now();
                const lastAt = parseInt(div.dataset.lastActivateAt || '0', 10);
                if (now - lastAt < 200) return;
                div.dataset.lastActivateAt = String(now);

                // 先复制话术到剪贴板
                await insertPhraseToPage(phrase);

                // 然后尝试不抢焦点自动粘贴到外部窗口
                try {
                    if (window.pythonBridge && typeof window.pythonBridge.paste_no_focus_steal === 'function') {
                        const success = await window.pythonBridge.paste_no_focus_steal();
                        if (success) {
                            console.log('序号点击：话术已自动粘贴（不抢焦点模式）');
                        } else {
                            console.log('序号点击：自动粘贴失败，话术已复制到剪贴板');
                        }
                    } else if (window.pythonBridge && typeof window.pythonBridge.paste_to_last_external === 'function') {
                        const success = await window.pythonBridge.paste_to_last_external();
                        if (!success) {
                            console.log('序号点击：自动粘贴失败，话术已复制到剪贴板');
                        }
                    } else {
                        console.log('序号点击：Python Bridge 不可用，话术已复制到剪贴板');
                    }
                } catch (error) {
                    console.error('序号点击自动粘贴时出错:', error);
                }
                return;
            }
        }

        // 点击了话术内容区域，执行普通复制
        // 防重复：200ms 内忽略重复触发
        const now = Date.now();
        const lastAt = parseInt(div.dataset.lastActivateAt || '0', 10);
        if (now - lastAt < 200) return;
        div.dataset.lastActivateAt = String(now);
        await insertPhraseToPage(phrase);
    };

    // 主容器：使用 mouseup 触发，以便在选择完成后检测选中文本
    div.addEventListener('mouseup', handleActivate);

    // 注：mouseup 比 mousedown 更适合文本选择检测，因为选择操作在 mouseup 前完成

    // 冗余保障：直接在内容区域也绑定点击复制，避免父级点击在某些环境不触发
    const contentEl = div.querySelector('.phrase-content');
    if (contentEl) {

        const contentActivate = async (e) => {
            // 不再 stopPropagation，避免干扰浏览器默认的文本选择行为

            // 如果点击的是可点击的分类名称，跳过复制
            if (e.target.classList.contains('phrase-category-clickable')) {
                return;
            }

            // 检查是否有选中的文本（划选后 mouseup 时选择已完成）
            const selection = window.getSelection();
            if (selection && selection.toString().trim().length > 0) {
                // 有选中的文本，不执行复制整个话术的操作
                return;
            }

            // 检查是否发生了拖拽选择意图
            const dx = e.clientX - mouseDownX;
            const dy = e.clientY - mouseDownY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const elapsed = Date.now() - mouseDownTime;
            if (distance > 5 && elapsed > 100) {
                return;
            }

            // 检查是否点击了序号区域（左上角 25x25px 的正方形区域）
            const rect = contentEl.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;

            // 序号区域：左侧 0-25px 且 顶部 0-25px 的正方形区域
            const isClickingNumber = clickX >= 0 && clickX <= 25 && clickY >= 0 && clickY <= 25;
            
            if (isClickingNumber) {
                // 点击了序号区域，执行自动粘贴
                e.preventDefault();
                
                // 防重复：200ms 内忽略重复触发
                const now = Date.now();
                const lastAt = parseInt(div.dataset.lastActivateAt || '0', 10);
                if (now - lastAt < 200) return;
                div.dataset.lastActivateAt = String(now);
                
                // 先复制话术到剪贴板
                await insertPhraseToPage(phrase);
                
                // 然后尝试不抢焦点自动粘贴到外部窗口
                try {
                    if (window.pythonBridge && typeof window.pythonBridge.paste_no_focus_steal === 'function') {
                        const success = await window.pythonBridge.paste_no_focus_steal();
                        if (success) {
                            console.log('序号点击：话术已自动粘贴（不抢焦点模式）');
                        } else {
                            console.log('序号点击：自动粘贴失败，话术已复制到剪贴板');
                        }
                    } else if (window.pythonBridge && typeof window.pythonBridge.paste_to_last_external === 'function') {
                        const success = await window.pythonBridge.paste_to_last_external();
                        if (!success) {
                            console.log('序号点击：自动粘贴失败，话术已复制到剪贴板');
                        }
                    } else {
                        console.log('序号点击：Python Bridge 不可用，话术已复制到剪贴板');
                    }
                } catch (error) {
                    console.error('序号点击自动粘贴时出错:', error);
                }
                return;
            }
            
            // 点击了话术内容区域，执行普通复制
            // 与父级共用同一防抖时间戳
            const now = Date.now();
            const lastAt = parseInt(div.dataset.lastActivateAt || '0', 10);
            if (now - lastAt < 200) return;
            div.dataset.lastActivateAt = String(now);
            await insertPhraseToPage(phrase);
        };
        contentEl.addEventListener('mouseup', contentActivate);

        // 右键菜单：复制选中文本
        contentEl.addEventListener('contextmenu', (e) => {
            const sel = window.getSelection();
            const selectedText = sel ? sel.toString().trim() : '';
            if (selectedText.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                showPhraseSelectionContextMenu(e.pageX, e.pageY, selectedText);
            }
        });

        // 监听复制事件，记录复制内容
        contentEl.addEventListener('copy', (e) => {
            const sel = window.getSelection();
            const selectedText = sel ? sel.toString() : '';
            console.log('[复制日志] copy 事件触发');
            console.log('[复制日志] 选区文本:', JSON.stringify(selectedText));
            console.log('[复制日志] 选区文本长度:', selectedText.length);
            console.log('[复制日志] 末尾字符:', JSON.stringify(selectedText.slice(-5)));
            console.log('[复制日志] 末尾字符码:', selectedText.slice(-5).split('').map(c => c.charCodeAt(0)));
            console.log('[复制日志] clipboardData text/plain:', e.clipboardData.getData('text/plain'));
            console.log('[复制日志] clipboardData text/html:', e.clipboardData.getData('text/html'));
            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                const clonedContents = range.cloneContents();
                console.log('[复制日志] 选区HTML:', clonedContents.innerHTML);
                console.log('[复制日志] 选区是否包含phrase-actions容器:', !!clonedContents.querySelector('.phrase-actions'));
                console.log('[复制日志] 选区是否包含phrase-action-btn:', !!clonedContents.querySelector('.phrase-action-btn'));

                // 如果选区包含按钮容器，手动清理
                if (clonedContents.querySelector('.phrase-actions')) {
                    e.preventDefault();
                    // 检测选区结束位置是否在按钮容器附近
                    const range = sel.getRangeAt(0);
                    const endContainer = range.endContainer;
                    const endOffset = range.endOffset;
                    const actionsContainer = div.querySelector('.phrase-actions');

                    // 判断选区是否结束在按钮容器附近
                    let isNearActions = false;
                    if (actionsContainer) {
                        // 检查选区结束节点是否在按钮容器之前
                        const nodeAfterSelection = endContainer.nodeType === Node.TEXT_NODE
                            ? endContainer.nextSibling
                            : endContainer.childNodes[endOffset];

                        // 如果选区后面是按钮容器，说明选区结束在按钮容器附近
                        if (nodeAfterSelection && (nodeAfterSelection === actionsContainer || actionsContainer.contains(nodeAfterSelection))) {
                            isNearActions = true;
                        }
                    }

                    let cleanText = selectedText;
                    // 只有选区结束在按钮容器附近时，才去除末尾的换行符
                    if (isNearActions) {
                        cleanText = cleanText.replace(/\n+$/, '');
                        console.log('[复制日志] 选区结束在按钮容器附近，去除末尾换行符');
                    } else {
                        console.log('[复制日志] 选区结束不在按钮容器附近，保留所有换行符');
                    }
                    console.log('[复制日志] 清理后的文本:', JSON.stringify(cleanText));
                    // 设置到 clipboardData
                    e.clipboardData.setData('text/plain', cleanText);
                    e.clipboardData.setData('text/html', clonedContents.innerHTML);
                }
            }
        });
        }
    } else {
        // 如果关闭了点击复制，确保文本可以选择（默认情况下文本就是可选择的）
        // 可以添加一些视觉提示，比如改变鼠标样式
        div.style.cursor = 'text';
        const contentEl = div.querySelector('.phrase-content');
        if (contentEl) {
            contentEl.style.cursor = 'text';
            // 确保用户可以选择文本
            contentEl.style.userSelect = 'text';
            contentEl.style.webkitUserSelect = 'text';
        }
    }
    
    // 只有在手动排序模式下才设置拖拽事件（标题卡片也支持拖拽）
    if (showDragHandle) {
        if (DEBUG_MODE) {
            console.log('[拖拽调试] 🎯 设置拖拽事件:', {
                phraseId: phrase.id,
                isTitle: isTitle,
                showDragHandle: showDragHandle,
                draggable: div.draggable
            });
        }
        setupDragEvents(div);
    } else {
        if (DEBUG_MODE) {
            console.log('[拖拽调试] ❌ 跳过拖拽事件设置:', {
                phraseId: phrase.id,
                isTitle: isTitle,
                showDragHandle: showDragHandle,
                sortMode: sortMode,
                isSortModeActive: isSortModeActive
            });
        }
    }

    // 显式绑定右下角操作按钮点击（避免被 mousedown 激活逻辑抢先处理）
    const bindBtn = (selector, handler) => {
        const btn = div.querySelector(selector);
        if (btn) {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await handler();
            });
        }
    };
    if (isTitle) {
        bindBtn('.text-editor-btn', async () => openCategoryTextEditor(phrase.category_id, phrase.title_text || phrase.content || '标题文本编辑器'));
        bindBtn('.edit-title-btn', async () => editTitlePhrase(phrase.id));
        bindBtn('.delete-title-btn', async () => deleteTitlePhrase(phrase.id));
    } else {
        bindBtn('.edit-btn', async () => editPhrase(phrase.id));
        bindBtn('.delete-btn', async () => deletePhrase(phrase.id));
        
        // 补全按钮点击事件
        const placeholderBtn = div.querySelector('.placeholder-btn');
        if (placeholderBtn) {
            // 添加数据属性跟踪编辑状态
            div.dataset.originalContent = phrase.content_html || phrase.content || '';
            
            // 从全局缓存恢复编辑状态和占位符填充值
            const phraseId = phrase.id;
            const cachedData = placeholderEditCache[phraseId];
            if (cachedData && cachedData.isEditMode) {
                div.dataset.placeholderEdit = 'true';
                div.dataset.placeholderValues = JSON.stringify(cachedData.placeholderValues || {});
                placeholderBtn.dataset.text = '清补全';
                console.log('[LOG] 从全局缓存恢复编辑状态:', phraseId, cachedData);
                
                // 重新渲染话术内容，将占位符渲染为可点击元素
                const contentEl = div.querySelector('.phrase-content');
                if (contentEl) {
                    // 保存序号占位元素（避免被innerHTML替换掉）
                    const numberPlaceholder = contentEl.querySelector('.phrase-number-placeholder');

                    const renderedContent = renderPlaceholders(phrase.content || '', 'true', cachedData.placeholderValues || {});
                    const finalContent = currentSearch ? highlightText(renderedContent, currentSearch) : renderedContent;
                    const tagPrefixClass = phrase.tag_prefix ? ' tag-prefix' : '';
                    const tagsHtml = tagsForDisplay ? `<span class="phrase-tags-inline${tagPrefixClass}">${escapeHtml(tagsForDisplay)}</span>` : '';
                    if (phrase.tag_prefix) {
                        contentEl.innerHTML = categoryLabelHtml + imageIndicator + tagsHtml + finalContent;
                    } else {
                        contentEl.innerHTML = appendTagsToLastLine(categoryLabelHtml + imageIndicator + finalContent, tagsHtml);
                    }

                    // 重新插入序号占位元素
                    if (numberPlaceholder) {
                        contentEl.insertBefore(numberPlaceholder, contentEl.firstChild);
                        // 重新绑定序号占位元素的事件
                        let isNoFocusModeEnabled = false;
                        numberPlaceholder.addEventListener('mouseenter', () => {
                            console.log('[JS] 鼠标进入序号占位元素（从缓存恢复）');
                            const contentEl = div.querySelector('.phrase-content');
                            if (contentEl) {
                                contentEl.classList.add('hovering-number');
                            }
                            if (!isNoFocusModeEnabled) {
                                isNoFocusModeEnabled = true;
                                try {
                                    if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                                        window.pythonBridge.enable_no_focus_mode();
                                    }
                                } catch (e) {
                                    console.error('启用不抢焦点模式失败', e);
                                }
                            }
                        });
                        numberPlaceholder.addEventListener('mouseleave', () => {
                            console.log('[JS] 鼠标离开序号占位元素（从缓存恢复）');
                            const contentEl = div.querySelector('.phrase-content');
                            if (contentEl) {
                                contentEl.classList.remove('hovering-number');
                            }
                            if (isNoFocusModeEnabled) {
                                isNoFocusModeEnabled = false;
                                try {
                                    if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                                        window.pythonBridge.disable_no_focus_mode();
                                    }
                                } catch (e) {
                                    console.error('关闭不抢焦点模式失败', e);
                                }
                            }
                        });
                    }

                    // 绑定占位符点击事件
                    bindPlaceholderClickEvents(div);
                }
            } else {
                div.dataset.placeholderEdit = 'false';
                div.dataset.placeholderValues = JSON.stringify({});
                placeholderBtn.dataset.text = '补全';
            }
            
            placeholderBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isEditMode = div.dataset.placeholderEdit === 'true';
                const contentEl = div.querySelector('.phrase-content');
                const phraseId = phrase.id;
                
                if (isEditMode) {
                    // 清补全模式：清空所有填充，恢复原状
                    div.dataset.placeholderEdit = 'false';
                    div.dataset.placeholderValues = JSON.stringify({});
                    placeholderBtn.dataset.text = '补全';
                    div.classList.add('was-placeholder-edit');
                    // 清除全局缓存
                    delete placeholderEditCache[phraseId];
                    // 恢复原始内容
                    if (contentEl) {
                        // 保存序号占位元素（避免被innerHTML替换掉）
                        const numberPlaceholder = contentEl.querySelector('.phrase-number-placeholder');

                        const originalContent = div.dataset.originalContent || phrase.content_html || phrase.content || '';
                        const restoredContent = currentSearch ? highlightTextInHtml(originalContent, currentSearch) : originalContent;
                        const tagPrefixClass = phrase.tag_prefix ? ' tag-prefix' : '';
                        const tagsHtml = tagsForDisplay ? `<span class="phrase-tags-inline${tagPrefixClass}">${escapeHtml(tagsForDisplay)}</span>` : '';
                        if (phrase.tag_prefix) {
                            contentEl.innerHTML = categoryLabelHtml + imageIndicator + tagsHtml + restoredContent;
                        } else {
                            contentEl.innerHTML = appendTagsToLastLine(categoryLabelHtml + imageIndicator + restoredContent, tagsHtml);
                        }

                        // 重新插入序号占位元素
                        if (numberPlaceholder) {
                            contentEl.insertBefore(numberPlaceholder, contentEl.firstChild);
                            // 重新绑定序号占位元素的事件
                            let isNoFocusModeEnabled = false;
                            numberPlaceholder.addEventListener('mouseenter', () => {
                                console.log('[JS] 鼠标进入序号占位元素（清补全）');
                                const contentEl = div.querySelector('.phrase-content');
                                if (contentEl) {
                                    contentEl.classList.add('hovering-number');
                                }
                                if (!isNoFocusModeEnabled) {
                                    isNoFocusModeEnabled = true;
                                    try {
                                        if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                                            window.pythonBridge.enable_no_focus_mode();
                                        }
                                    } catch (e) {
                                        console.error('启用不抢焦点模式失败', e);
                                    }
                                }
                            });
                            numberPlaceholder.addEventListener('mouseleave', () => {
                                console.log('[JS] 鼠标离开序号占位元素（清补全）');
                                const contentEl = div.querySelector('.phrase-content');
                                if (contentEl) {
                                    contentEl.classList.remove('hovering-number');
                                }
                                if (isNoFocusModeEnabled) {
                                    isNoFocusModeEnabled = false;
                                    try {
                                        if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                                            window.pythonBridge.disable_no_focus_mode();
                                        }
                                    } catch (e) {
                                        console.error('关闭不抢焦点模式失败', e);
                                    }
                                }
                            });
                        }
                    }
                    console.log('[LOG] 清补全模式，恢复原状，清除全局缓存');
                } else {
                    // 进入编辑模式
                    div.dataset.placeholderEdit = 'true';
                    placeholderBtn.dataset.text = '清补全';
                    div.classList.remove('was-placeholder-edit');
                    // 保存到全局缓存
                    const cachedData = placeholderEditCache[phraseId] || { isEditMode: false, placeholderValues: {} };
                    cachedData.isEditMode = true;
                    cachedData.placeholderValues = JSON.parse(div.dataset.placeholderValues || '{}');
                    placeholderEditCache[phraseId] = cachedData;
                    // 重新渲染话术内容，将占位符渲染为可点击元素
                    if (contentEl) {
                        // 保存序号占位元素（避免被innerHTML替换掉）
                        const numberPlaceholder = contentEl.querySelector('.phrase-number-placeholder');

                        // 优先使用 content_html（如果有样式），否则使用 content
                        const sourceContent = phrase.content_html || phrase.content || '';
                        const renderedContent = renderPlaceholders(sourceContent, 'true');
                        const finalContent = currentSearch ? highlightText(renderedContent, currentSearch) : renderedContent;
                        const tagPrefixClass = phrase.tag_prefix ? ' tag-prefix' : '';
                        const tagsHtml = tagsForDisplay ? `<span class="phrase-tags-inline${tagPrefixClass}">${escapeHtml(tagsForDisplay)}</span>` : '';
                        if (phrase.tag_prefix) {
                            contentEl.innerHTML = categoryLabelHtml + imageIndicator + tagsHtml + finalContent;
                        } else {
                            contentEl.innerHTML = appendTagsToLastLine(categoryLabelHtml + imageIndicator + finalContent, tagsHtml);
                        }

                        // 重新插入序号占位元素
                        if (numberPlaceholder) {
                            contentEl.insertBefore(numberPlaceholder, contentEl.firstChild);
                            // 重新绑定序号占位元素的事件
                            let isNoFocusModeEnabled = false;
                            numberPlaceholder.addEventListener('mouseenter', () => {
                                console.log('[JS] 鼠标进入序号占位元素（进入编辑模式）');
                                const contentEl = div.querySelector('.phrase-content');
                                if (contentEl) {
                                    contentEl.classList.add('hovering-number');
                                }
                                if (!isNoFocusModeEnabled) {
                                    isNoFocusModeEnabled = true;
                                    try {
                                        if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                                            window.pythonBridge.enable_no_focus_mode();
                                        }
                                    } catch (e) {
                                        console.error('启用不抢焦点模式失败', e);
                                    }
                                }
                            });
                            numberPlaceholder.addEventListener('mouseleave', () => {
                                console.log('[JS] 鼠标离开序号占位元素（进入编辑模式）');
                                const contentEl = div.querySelector('.phrase-content');
                                if (contentEl) {
                                    contentEl.classList.remove('hovering-number');
                                }
                                if (isNoFocusModeEnabled) {
                                    isNoFocusModeEnabled = false;
                                    try {
                                        if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                                            window.pythonBridge.disable_no_focus_mode();
                                        }
                                    } catch (e) {
                                        console.error('关闭不抢焦点模式失败', e);
                                    }
                                }
                            });
                        }

                        // 绑定占位符点击事件
                        bindPlaceholderClickEvents(div);
                    }
                    console.log('[LOG] 进入补全编辑模式，保存到全局缓存');
                }
            });
        }
        bindBtn('.images-btn', async () => openImagesDialog(phrase));
        // 让图片指示器可点击：直接复制首张图片（跳过对话框，提升服务速度）
        const imageIndicatorEl = div.querySelector('.phrase-image-indicator');
        if (imageIndicatorEl) {
            if (disableClickCopy) {
                // 关闭点击复制时，图片指示器仅作展示，不可点击自动粘贴
                imageIndicatorEl.style.cursor = 'default';
                imageIndicatorEl.title = '已关闭点击复制';
            } else {
                // 点击时复制图片并自动粘贴（mouseenter/mouseleave 已由事件委托处理）
                imageIndicatorEl.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    // 确保不抢焦点模式已开启（兜底，正常情况下事件委托已开启）
                    try {
                        if (window.pythonBridge && typeof window.pythonBridge.enable_no_focus_mode === 'function') {
                            window.pythonBridge.enable_no_focus_mode();
                        }
                    } catch (err) {
                        // ignore
                    }
                    try {
                        await copyFirstImageFromPhrase(phrase, true);
                    } finally {
                        // 粘贴完成后关闭不抢焦点模式
                        try {
                            if (window.pythonBridge && typeof window.pythonBridge.disable_no_focus_mode === 'function') {
                                window.pythonBridge.disable_no_focus_mode();
                            }
                        } catch (err) {
                            // ignore
                        }
                    }
                });
                // 指示可点击（不改变布局）
                imageIndicatorEl.style.cursor = 'pointer';
            }
        }
        bindBtn('.description-btn', async () => openDescriptionDialog(phrase));
        // variants toggle moved to bottom-right corner badge

        // 绑定跳转链接点击事件
        const jumpLink = div.querySelector('.phrase-jump-link');
        if (jumpLink) {
            jumpLink.addEventListener('click', async (e) => {
                e.stopPropagation();
                const categoryId = jumpLink.dataset.categoryId;
                if (categoryId) {
                    // 切换到指定分类
                    await selectCategory(categoryId);
                    showToast(`✅ 已跳转到分类`);
                }
            });
        }

        // 绑定分类名称点击事件（搜索结果中点击分类名称跳转到该分类）
        const categoryLabel = div.querySelector('.phrase-category-clickable');
        if (categoryLabel) {
            categoryLabel.addEventListener('click', async (e) => {
                e.stopPropagation();
                const categoryId = categoryLabel.dataset.categoryId;
                if (categoryId) {
                    // 🧹 先清除搜索框并失焦，确保字幕能立即恢复
                    const searchInput = document.getElementById('searchInput');
                    if (searchInput && searchInput.value) {
                        searchInput.value = '';
                        searchInput.blur();
                        updateMarqueeVisibility();
                        // 重置搜索覆盖状态
                        searchCoverTabId = null;
                        isSearchCovering = false;
                    }
                    const result = await selectCategory(categoryId);
                    // 只在实际导航成功时显示 toast（跳转到已有标签页时不显示）
                    if (result === 'navigated') {
                        showToast(`✅ 已跳转到分类`);
                    }
                }
            });
        }
    }

    // 标题卡片点击折叠/展开行为（仅在开启折叠功能时生效）
    if (isTitle) {
        const toggleTitleCollapse = async (e) => {
            // 点击编辑/删除按钮不触发展开/收起
            if (e.target.closest('.phrase-action-btn')) {
                return;
            }
            // 拖拽手柄不触发折叠
            if (e.target.classList && e.target.classList.contains('drag-handle')) {
                return;
            }
            const enableCollapse = (enableTitleCollapseSetting === 'true' || enableTitleCollapseSetting === true);
            if (!enableCollapse) {
                console.log('[TITLE_COLLAPSE] disabled by setting:', enableTitleCollapseSetting);
                return;
            }

            // 防重复触发：避免 mousedown + click 连续切换两次
            const now = Date.now();
            const lastAt = parseInt(div.dataset.lastTitleToggleAt || '0', 10);
            if (now - lastAt < 250) return;
            div.dataset.lastTitleToggleAt = String(now);

            // 标题下一块应该是它对应的话术分组容器
            const groupEl = div.nextElementSibling;
            if (!groupEl || !groupEl.classList.contains('phrase-group-normal')) {
                console.log('[TITLE_COLLAPSE] missing groupEl after title', phrase.id);
                return;
            }

            // 如果标题下没有任何话术内容（也没有添加卡），则不做展开/收起，避免出现“展开空气”导致的间距跳动
            // 说明：空分组容器仍可能存在于 DOM 中，但不应参与布局
            try {
                const hasPhraseItem = groupEl.querySelector('.phrase-item') !== null;
                const hasAddCard = groupEl.querySelector('.add-phrase-card') !== null;
                if (!hasPhraseItem && !hasAddCard) {
                    groupEl.style.display = 'none';
                    return;
                }
            } catch (checkErr) {
                // 若检测失败，则降级为保持原逻辑（不阻断折叠功能）
            }

            const currentlyCollapsed = div.dataset.collapsed === 'true';
            const newCollapsed = !currentlyCollapsed;
            div.dataset.collapsed = newCollapsed ? 'true' : 'false';
            groupEl.style.display = newCollapsed ? 'none' : '';
            console.log('[TITLE_COLLAPSE] toggled', { id: phrase.id, newCollapsed });
            try {
                await db.setTitleCollapse(phrase.id, newCollapsed);
            } catch (error) {
                console.error('❌ 更新标题折叠状态失败:', error);
            }
        };

        div.addEventListener('mousedown', (e) => {
            try { e.preventDefault(); } catch (_) {}
            toggleTitleCollapse(e);
        });

        div.addEventListener('click', (e) => {
            toggleTitleCollapse(e);
        });
    }

    return div;
}

// ==================== 话术选中文本右键菜单 ====================
let _phraseSelMenu = null;
let _phraseSelMenuText = ''; // 保存右键菜单触发时的选中文本

function showPhraseSelectionContextMenu(x, y, text) {
    // 保存选中文本到模块变量，避免点击菜单项时选区已丢失
    _phraseSelMenuText = text || '';

    if (!_phraseSelMenu) {
        const menu = document.createElement('div');
        menu.id = 'phraseSelectionContextMenu';
        menu.className = 'phrase-selection-context-menu';
        menu.innerHTML = `<div class="phrase-selection-context-item" data-command="copy">📋 复制</div>`;
        menu.addEventListener('mousedown', (e) => {
            // 阻止 mousedown 事件冒泡，防止选区被清除
            e.preventDefault();
        });
        menu.addEventListener('click', async (e) => {
            const item = e.target.closest('.phrase-selection-context-item');
            if (!item) return;
            const cmd = item.dataset.command;
            if (cmd === 'copy') {
                // 优先使用保存的选中文本，避免因焦点变化导致选区丢失
                let selectedText = _phraseSelMenuText;
                // 如果保存的文本为空，尝试重新获取选区（兜底）
                if (!selectedText) {
                    const sel = window.getSelection();
                    selectedText = sel ? sel.toString().trim() : '';
                }
                if (selectedText) {
                    const ok = await copyToClipboard(selectedText);
                    if (ok) {
                        showToast('已复制选中内容');
                    } else {
                        showToast('复制失败', 'error');
                    }
                } else {
                    showToast('未选中可复制的文本', 'error');
                }
            }
            hidePhraseSelectionContextMenu();
        });
        document.body.appendChild(menu);
        _phraseSelMenu = menu;

        // 点击其他地方隐藏菜单
        document.addEventListener('mousedown', (e) => {
            if (_phraseSelMenu && !_phraseSelMenu.contains(e.target)) {
                hidePhraseSelectionContextMenu();
            }
        }, true);
        document.addEventListener('scroll', hidePhraseSelectionContextMenu, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hidePhraseSelectionContextMenu();
        });
    }

    _phraseSelMenu.style.left = x + 'px';
    _phraseSelMenu.style.top = y + 'px';
    _phraseSelMenu.classList.add('show');

    // 边界检测
    const menuRect = _phraseSelMenu.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    let adjustedX = x;
    let adjustedY = y;
    if (x + menuRect.width > winW) adjustedX = winW - menuRect.width - 4;
    if (y + menuRect.height > winH) adjustedY = winH - menuRect.height - 4;
    _phraseSelMenu.style.left = adjustedX + 'px';
    _phraseSelMenu.style.top = adjustedY + 'px';
}

function hidePhraseSelectionContextMenu() {
    if (_phraseSelMenu) {
        _phraseSelMenu.classList.remove('show');
    }
    _phraseSelMenuText = ''; // 清除保存的选中文本
}

// 插入话术到网页
async function insertPhraseToPage(phrase) {
    const rollbackUsage = () => {
        const usageSet = tabUsageMap.get(activeCustomerTabId);
        if (usageSet) {
            usageSet.delete(phrase.id);
        }
        refreshPhraseUsageVisual(phrase.id);
    };
    const markUsageSuccess = () => {
        refreshPhraseUsageVisual(phrase.id, { flash: true });
    };

    try {
        // 🎯 预先标记该话术在当前标签页的使用状态（若失败会回滚）
        const currentUsageSet = tabUsageMap.get(activeCustomerTabId) || new Set();
        currentUsageSet.add(phrase.id);
        tabUsageMap.set(activeCustomerTabId, currentUsageSet);
        
        // 🚀 桌面版快速路径：直接复制并返回，避免读取设置/写入等耗时操作
        const isDesktopEnvFast = typeof window !== 'undefined' && window.isDesktopApp;
        if (isDesktopEnvFast) {
            // 先立即提示，提高感知速度，再异步执行复制
            showToast('已复制');
            markUsageSuccess();
            
            // 检查是否有占位符填充值
            const cachedData = placeholderEditCache[phrase.id];
            let contentToCopy = phrase.content;
            if (cachedData && cachedData.placeholderValues) {
                contentToCopy = getFilledContent(phrase.content, cachedData.placeholderValues);
            }
            
            copyToClipboard(contentToCopy).then(async (ok) => {
                if (!ok) {
                    showToast('❌ 复制失败', 'error');
                    rollbackUsage();
                } else {
                    await tryAutoFocusAfterCopy();
                    // 桌面快速路径也要计入使用次数/时间，供使用日志统计
                    try {
                        const incSetting = await db.getSetting('incrementUseCount', 'true');
                        if (incSetting === 'true') {
                            await db.incrementUseCount(phrase.id);
                        }
                    } catch (err) {
                        console.warn('[usage] 桌面计数更新失败:', err);
                    }
                }
            });
            return;
        }

        // 检查是否启用了"点击复制"模式
        const copyOnClickSetting = await db.getSetting('copyOnClick', 'true');
        const isDesktopEnvironment = typeof window !== 'undefined' && window.isDesktopApp;
        const shouldUseCopyMode = copyOnClickSetting === 'true' || isDesktopEnvironment;
        const forcedCopyMode = isDesktopEnvironment && copyOnClickSetting !== 'true';

        if (shouldUseCopyMode) {
            if (forcedCopyMode) {
                // 桌面版：强制复制模式（非必要，不等待）
                db.setSetting('copyOnClick', 'true').catch(() => {});
            }

            // 复制模式：复制到剪贴板（桌面版恒走这里）
            // 检查是否有占位符填充值
            const cachedData = placeholderEditCache[phrase.id];
            let contentToCopy = phrase.content;
            if (cachedData && cachedData.placeholderValues) {
                contentToCopy = getFilledContent(phrase.content, cachedData.placeholderValues);
            }
            
            const success = await copyToClipboard(contentToCopy);
            if (success) {
                showToast('已复制');
                await tryAutoFocusAfterCopy();
                markUsageSuccess();
            } else {
                showToast('❌ 复制失败', 'error');
                rollbackUsage();
            }
            return;
        }

        if (!window.chrome || !window.chrome.tabs || typeof window.chrome.tabs.query !== 'function' || typeof window.chrome.tabs.sendMessage !== 'function') {
            throw new Error('当前环境不支持直接插入到网页，请在设置中启用“点击复制”模式');
        }

        // 插入模式：插入到页面
        const [tab] = await window.chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab || !tab.id) {
            throw new Error('未找到可用的浏览器标签页');
        }

        // 发送消息到内容脚本
        await window.chrome.tabs.sendMessage(tab.id, {
            action: 'insertText',
            text: phrase.content
        });
        markUsageSuccess();
        
        // 自动更新使用次数（简化逻辑，默认记录）
        await db.incrementUseCount(phrase.id);
        await loadPhrases();
        
        // 显示复制成功提示（移除了插入通知，改为复制提示）
        showToast('📋 话术已复制到剪贴板');
    } catch (error) {
        rollbackUsage();
        console.error('操作话术失败:', error);
        // 桌面应用默认使用复制模式
        showToast('❌ 复制失败', 'error');
    }
}

// ============================================
// 自定义下拉框管理函数
// 解决原生 select option:hover 在 Chromium/Qt WebEngine 中不可靠的问题
// ============================================

/**
 * 获取自定义下拉框的当前值
 * @param {string} selectId - 下拉框元素的 ID
 * @returns {string} 当前选中项的 data-value
 */
function getCustomSelectValue(selectId) {
    const container = document.getElementById(selectId);
    if (!container) return '';
    // 先查找子选项，再查找分组标题（一级分类）
    const selected = container.querySelector('.custom-select-option.selected') ||
                     container.querySelector('.custom-select-group-header.selected');
    return selected ? selected.dataset.value : '';
}

/**
 * 设置自定义下拉框的值
 * @param {string} selectId - 下拉框元素的 ID
 * @param {string} value - 要设置的值
 */
function setCustomSelectValue(selectId, value) {
    const container = document.getElementById(selectId);
    if (!container) return;

    // 移除所有选中状态（包括分组标题和子选项）
    container.querySelectorAll('.custom-select-option.selected, .custom-select-group-header.selected').forEach(opt => {
        opt.classList.remove('selected');
    });

    // 收起所有分组
    container.querySelectorAll('.custom-select-group.expanded').forEach(group => {
        group.classList.remove('expanded');
    });

    // 先尝试查找子选项
    let targetOption = container.querySelector(`.custom-select-option[data-value="${value}"]`);
    let displayName = '';

    // 如果找不到子选项，尝试查找分组标题（一级分类）
    if (!targetOption) {
        targetOption = container.querySelector(`.custom-select-group-header[data-value="${value}"]`);
    }

    if (targetOption) {
        // 找到了选项，设置选中状态
        targetOption.classList.add('selected');
        displayName = targetOption.textContent;

        // 自动展开父级分组
        const parentGroup = targetOption.closest('.custom-select-group');
        if (parentGroup) {
            parentGroup.classList.add('expanded');
        }
    } else {
        // 没找到子选项，尝试查找分组标题（一级分类）
        const targetHeader = container.querySelector(`.custom-select-group-header[data-value="${value}"]`);
        if (targetHeader) {
            targetHeader.classList.add('selected');
            displayName = targetHeader.querySelector('.custom-select-group-title')?.textContent || targetHeader.textContent;
        }
    }

    // 更新触发按钮显示的文本
    if (displayName) {
        const trigger = container.querySelector('.custom-select-value');
        if (trigger) trigger.textContent = displayName;
    }
}

/**
 * 初始化自定义下拉框的事件监听
 * @param {string} selectId - 下拉框元素的 ID
 */
function initCustomSelect(selectId) {
    const container = document.getElementById(selectId);
    if (!container || container.dataset.customSelectInit) return;
    container.dataset.customSelectInit = 'true';

    const trigger = container.querySelector('.custom-select-trigger');
    const dropdown = container.querySelector('.custom-select-dropdown');

    if (!trigger || !dropdown) return;

    // 点击触发按钮展开/收起下拉框
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = container.classList.contains('open');

        // 先关闭所有其他下拉框
        document.querySelectorAll('.custom-select.open').forEach(el => {
            if (el !== container) el.classList.remove('open');
        });

        container.classList.toggle('open', !isOpen);
        container.setAttribute('aria-expanded', !isOpen);
    });

    // 键盘支持
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger.click();
        } else if (e.key === 'Escape') {
            container.classList.remove('open');
            container.setAttribute('aria-expanded', 'false');
        }
    });

    // 点击分组标题 - 展开/收起分组 + 选中一级分类
    dropdown.addEventListener('click', (e) => {
        const groupHeader = e.target.closest('.custom-select-group-header');
        if (groupHeader) {
            const group = groupHeader.closest('.custom-select-group');
            if (group) {
                // 检查点击的是否是箭头（兼容文本节点）
                const arrowEl = groupHeader.querySelector('.custom-select-group-arrow');
                const isArrowClick = arrowEl && (
                    e.target === arrowEl ||
                    arrowEl.contains(e.target) ||
                    e.target.parentNode === arrowEl
                );

                // 切换展开/收起状态
                group.classList.toggle('expanded');

                // 如果只点击了箭头，只展开/收起，不关闭下拉框
                if (isArrowClick) {
                    return;
                }

                // 点击了标题文本，选中该一级分类
                dropdown.querySelectorAll('.custom-select-option.selected, .custom-select-group-header.selected').forEach(opt => {
                    opt.classList.remove('selected');
                });
                groupHeader.classList.add('selected');

                // 更新触发按钮显示的文本
                const titleText = groupHeader.querySelector('.custom-select-group-title')?.textContent || groupHeader.textContent;
                const triggerValue = container.querySelector('.custom-select-value');
                if (triggerValue) triggerValue.textContent = titleText;

                // 收起整个下拉框
                container.classList.remove('open');
                container.setAttribute('aria-expanded', 'false');

                // 触发 change 事件
                container.dispatchEvent(new CustomEvent('change', {
                    detail: { value: groupHeader.dataset.value },
                    bubbles: true
                }));
            }
            return;
        }

        // 点击二级分类选项选中
        const option = e.target.closest('.custom-select-option');
        if (option) {
            // 移除所有选中状态
            dropdown.querySelectorAll('.custom-select-option.selected, .custom-select-group-header.selected').forEach(opt => {
                opt.classList.remove('selected');
            });

            // 设置选中状态
            option.classList.add('selected');

            // 更新触发按钮显示的文本
            const triggerValue = container.querySelector('.custom-select-value');
            if (triggerValue) triggerValue.textContent = option.textContent;

            // 收起下拉框
            container.classList.remove('open');
            container.setAttribute('aria-expanded', 'false');

            // 触发 change 事件（兼容旧代码）
            container.dispatchEvent(new CustomEvent('change', {
                detail: { value: option.dataset.value },
                bubbles: true
            }));
        }
    });

    // 点击外部关闭下拉框
    document.addEventListener('click', (e) => {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
            container.setAttribute('aria-expanded', 'false');
        }
    });
}

// 从缓存刷新话术对话框的分类下拉框（确保新添加的分类立即可见）
function refreshPhraseCategoryDropdown() {
    const phraseCategory = document.getElementById('phraseCategory');
    if (!phraseCategory) return;
    const categories = allCategoriesCache || [];

    // 保存当前选中的值
    const currentValue = getCustomSelectValue('phraseCategory');

    // 获取下拉列表容器
    const dropdown = phraseCategory.querySelector('.custom-select-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';

    // 按父级分组
    const categoryGroups = {};
    const rootCategories = [];
    categories.forEach(cat => {
        const parentId = cat.parent_id || 0;
        if (parentId === 0) {
            rootCategories.push(cat);
        } else {
            if (!categoryGroups[parentId]) categoryGroups[parentId] = [];
            categoryGroups[parentId].push(cat);
        }
    });

    // 渲染可折叠分组结构
    rootCategories.forEach(cat => {
        const subCategories = categoryGroups[cat.id] || [];
        const hasSubCategories = subCategories.length > 0;

        // 创建分组容器
        const group = document.createElement('li');
        group.className = 'custom-select-group';
        group.dataset.categoryId = cat.id;

        // 创建分组标题（一级分类）
        const header = document.createElement('div');
        header.className = 'custom-select-group-header';
        header.dataset.value = cat.id;
        header.setAttribute('role', 'option');

        // 箭头图标（有子分类时才显示）
        if (hasSubCategories) {
            const arrow = document.createElement('span');
            arrow.className = 'custom-select-group-arrow';
            arrow.textContent = '▶';
            header.appendChild(arrow);
        } else {
            // 没有子分类时添加占位，保持对齐
            const spacer = document.createElement('span');
            spacer.className = 'custom-select-group-arrow';
            spacer.style.visibility = 'hidden';
            header.appendChild(spacer);
        }

        // 标题文本
        const title = document.createElement('span');
        title.className = 'custom-select-group-title';
        title.textContent = cat.name.replace(/^🗑️/, '');
        header.appendChild(title);

        group.appendChild(header);

        // 创建二级分类容器
        if (hasSubCategories) {
            const itemsContainer = document.createElement('ul');
            itemsContainer.className = 'custom-select-group-items';

            subCategories.forEach(subCat => {
                const subLi = document.createElement('li');
                subLi.className = 'custom-select-option';
                subLi.dataset.value = subCat.id;
                subLi.dataset.parentId = cat.id;
                subLi.textContent = subCat.name.replace(/^🗑️/, '');
                subLi.setAttribute('role', 'option');
                itemsContainer.appendChild(subLi);
            });

            group.appendChild(itemsContainer);
        }

        dropdown.appendChild(group);
    });

    // 恢复之前选中的值，如果没有则默认选中第一个
    if (currentValue) {
        setCustomSelectValue('phraseCategory', currentValue);
    } else if (rootCategories.length > 0) {
        setCustomSelectValue('phraseCategory', rootCategories[0].id);
    }

    // 初始化事件监听
    initCustomSelect('phraseCategory');

    // 同步刷新 phraseJumpCategory 下拉框（自定义可折叠分组样式，排除当前选中的分类）
    const phraseJumpCategory = document.getElementById('phraseJumpCategory');
    if (phraseJumpCategory) {
        const jumpDropdown = phraseJumpCategory.querySelector('.custom-select-dropdown');
        if (jumpDropdown) {
            jumpDropdown.innerHTML = '';

            // 添加"不跳转"选项
            const noJumpLi = document.createElement('li');
            noJumpLi.className = 'custom-select-option selected';
            noJumpLi.dataset.value = '';
            noJumpLi.setAttribute('role', 'option');
            noJumpLi.textContent = '-- 不跳转 --';
            jumpDropdown.appendChild(noJumpLi);

            rootCategories.forEach(cat => {
                if (isRecycleCategory(cat)) return;

                const group = document.createElement('li');
                group.className = 'custom-select-group';
                group.dataset.categoryId = cat.id;

                const subCategories = categoryGroups[cat.id] || [];
                const hasSubCategories = subCategories.length > 0;

                const header = document.createElement('div');
                header.className = 'custom-select-group-header';
                header.dataset.value = cat.id;
                header.setAttribute('role', 'option');

                if (hasSubCategories) {
                    const arrow = document.createElement('span');
                    arrow.className = 'custom-select-group-arrow';
                    arrow.textContent = '▶';
                    header.appendChild(arrow);
                } else {
                    const spacer = document.createElement('span');
                    spacer.className = 'custom-select-group-arrow';
                    spacer.style.visibility = 'hidden';
                    header.appendChild(spacer);
                }

                const title = document.createElement('span');
                title.className = 'custom-select-group-title';
                title.textContent = cat.name.replace(/^🗑️/, '');
                header.appendChild(title);
                group.appendChild(header);

                if (hasSubCategories) {
                    const itemsContainer = document.createElement('ul');
                    itemsContainer.className = 'custom-select-group-items';
                    subCategories.forEach(subCat => {
                        if (isRecycleCategory(subCat)) return;
                        const subLi = document.createElement('li');
                        subLi.className = 'custom-select-option';
                        subLi.dataset.value = subCat.id;
                        subLi.dataset.parentId = cat.id;
                        subLi.textContent = subCat.name.replace(/^🗑️/, '');
                        subLi.setAttribute('role', 'option');
                        itemsContainer.appendChild(subLi);
                    });
                    group.appendChild(itemsContainer);
                }

                jumpDropdown.appendChild(group);
            });

            // 初始化事件监听
            initCustomSelect('phraseJumpCategory');
        }
    }
}

// 打开话术编辑对话框
function openPhraseDialog(phraseId = null, presetCategoryId = null, isRestoringFromRecycle = false) {
    console.log('openPhraseDialog() 被调用, phraseId:', phraseId, 'presetCategoryId:', presetCategoryId, 'isRestoringFromRecycle:', isRestoringFromRecycle);
    
    currentEditingPhraseId = phraseId;
    // 标记当前编辑的话术是否是从回收站恢复的
    window._isRestoringPhrase = isRestoringFromRecycle;
    const dialog = document.getElementById('phraseDialog');
    const title = document.getElementById('dialogTitle');
    
    if (!dialog) {
        console.error('❌ 找不到 phraseDialog 元素');
        return;
    }
    // 先重置复选框，防止上一次编辑状态残留
    const enablePlaceholderEl = document.getElementById('enablePlaceholder');
    const enableImagesEl = document.getElementById('enableImages');
    const disableClickCopyEl = document.getElementById('disableClickCopy');
    const enableDescriptionEl = document.getElementById('enableDescription');
    const enableVariantsEl = document.getElementById('enableVariants');
    if (enablePlaceholderEl) enablePlaceholderEl.checked = false;
    if (enableImagesEl) enableImagesEl.checked = false;
    if (disableClickCopyEl) disableClickCopyEl.checked = false;
    if (enableDescriptionEl) enableDescriptionEl.checked = false;
    if (enableVariantsEl) enableVariantsEl.checked = false;
    const actAsTitleEl = document.getElementById('actAsTitle');
    const actTitleTextEditorEl = document.getElementById('actTitleTextEditor');
    const actTitleTextEditorRow = document.getElementById('actTitleTextEditorRow');
    if (actTitleTextEditorEl) actTitleTextEditorEl.checked = false;
    if (actTitleTextEditorRow) actTitleTextEditorRow.style.display = 'none';
    if (actAsTitleEl) {
        actAsTitleEl.checked = false;
        actAsTitleEl.onchange = function () {
            const lock = this.checked;
            if (disableClickCopyEl) { disableClickCopyEl.disabled = lock; if (lock) disableClickCopyEl.checked = false; }
            if (enableVariantsEl) { enableVariantsEl.disabled = lock; if (lock) enableVariantsEl.checked = false; }
            if (enableImagesEl) { enableImagesEl.disabled = lock; if (lock) enableImagesEl.checked = false; }
            if (enablePlaceholderEl) { enablePlaceholderEl.disabled = lock; if (lock) enablePlaceholderEl.checked = false; }
            if (actTitleTextEditorRow) actTitleTextEditorRow.style.display = lock ? '' : 'none';
            if (!lock && actTitleTextEditorEl) actTitleTextEditorEl.checked = false;
        };
    }
    
    // 重置样式控件
    const textColorEl = document.getElementById('phraseTextColor');
    const bgColorEl = document.getElementById('phraseBgColor');
    const isBoldEl = document.getElementById('phraseIsBold');
    if (textColorEl) {
        textColorEl.value = '#333333';
        const textColorDisplay = document.getElementById('phraseTextColorDisplay');
        if (textColorDisplay) {
            textColorDisplay.style.background = '#333333';
        }
    }
    if (bgColorEl) {
        bgColorEl.value = '#ffffff';
        const bgColorDisplay = document.getElementById('phraseBgColorDisplay');
        if (bgColorDisplay) {
            bgColorDisplay.style.background = '#ffffff';
        }
    }
    if (isBoldEl) isBoldEl.checked = false;
    
    if (phraseId) {
        dbgLog('编辑模式');
        title.textContent = '编辑话术';
        refreshPhraseCategoryDropdown();
        loadPhraseData(phraseId);
    } else {
        console.log('添加模式');
        title.textContent = '添加话术';
        const contentEl = document.getElementById('phraseContent');
        if (contentEl.contentEditable === 'true') {
            contentEl.innerHTML = '';
        } else {
            contentEl.value = '';
        }
        // 刷新分类下拉框，确保新添加的分类立即可见
        refreshPhraseCategoryDropdown();
        // 根据内容检查补全勾选框是否可选
        if (contentEl) contentEl.dispatchEvent(new Event('input'));
        // 优先使用预设分类ID，否则使用当前分类，最后使用"未分类"(id=1)
        const defaultCategoryId = presetCategoryId || currentSelectedCategoryId || '1';
        setCustomSelectValue('phraseCategory', defaultCategoryId);
        document.getElementById('phraseTags').value = '';
        document.getElementById('enablePlaceholder').checked = false;
        document.getElementById('enableImages').checked = false;
        document.getElementById('disableClickCopy').checked = false;
        document.getElementById('enableDescription').checked = false;
        document.getElementById('enableVariants').checked = false;
        document.getElementById('tagPrefix').checked = false;
        console.log('✅ 默认选中分类:', defaultCategoryId);
        console.log('🔍 [调试] presetCategoryId:', presetCategoryId);
        console.log('🔍 [调试] currentSelectedCategoryId:', currentSelectedCategoryId);
        console.log('🔍 [调试] defaultCategoryId:', defaultCategoryId);
    }
    
    dialog.style.display = 'flex';
    dbgLog('✅ 对话框已打开, display:', dialog.style.display);
    
    // 为编辑框添加事件监听，保存选中范围
    const contentEl = document.getElementById('phraseContent');
    if (contentEl && contentEl.contentEditable === 'true') {
        // 清除之前保存的范围
        savedSelectionRange = null;
        
        // 监听鼠标抬起和键盘选择，保存选中范围并更新样式控件
        const saveSelection = () => {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                if (!range.collapsed && contentEl.contains(range.commonAncestorContainer)) {
                    savedSelectionRange = range.cloneRange();
                    // 根据选中文字的实际样式更新样式控件
                    updateStyleControlsFromSelection();
                } else {
                    savedSelectionRange = null;
                    // 没有选中内容时，重置样式控件为默认值
                    updateStyleControlsFromSelection();
                }
            } else {
                savedSelectionRange = null;
                // 没有选中内容时，重置样式控件为默认值
                updateStyleControlsFromSelection();
            }
        };
        
        // 移除旧的事件监听器（如果存在）
        if (contentEl._saveSelectionHandler) {
            contentEl.removeEventListener('mouseup', contentEl._saveSelectionHandler);
            contentEl.removeEventListener('keyup', contentEl._saveSelectionHandler);
        }
        
        // 添加新的事件监听器
        contentEl._saveSelectionHandler = saveSelection;
        contentEl.addEventListener('mouseup', saveSelection);
        contentEl.addEventListener('keyup', saveSelection);

        // ====== DEBUG: 监控每一次按键 ======
        if (contentEl._debugKeydownHandler) {
            contentEl.removeEventListener('keydown', contentEl._debugKeydownHandler);
        }
        contentEl._debugKeydownHandler = function(e) {
            if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return;
            const sel = window.getSelection();
            const cursorInfo = sel && sel.rangeCount > 0 ? (() => {
                const r = sel.getRangeAt(0);
                const node = r.startContainer;
                const nodeType = node.nodeType === Node.TEXT_NODE ? 'TEXT' : 'ELEM-' + (node.tagName || '?').toLowerCase();
                return `offset=${r.startOffset} @${nodeType}`;
            })() : 'no_sel';

            dbgLog(`[KBD] "${e.key}" code=${e.code} shift=${e.shiftKey} ctrl=${e.ctrlKey} cursor={${cursorInfo}}`);

            setTimeout(() => {
                const html = contentEl.innerHTML || '';
                dbgLog(`[KBD] AFTER len=${html.length} head80="${html.slice(0, 80)}"`);
            }, 50);
        };
        contentEl.addEventListener('keydown', contentEl._debugKeydownHandler);
        dbgLog('[DEBUG] ✅ 已添加 keydown 调试日志监听器');
        // ====== END DEBUG ======
    }
}

// ==================== 标题卡片相关功能 ====================

/**
 * 打开添加/编辑标题的 HTML 对话框（带位置选择器）
 */
async function openTitleDialog(mode = 'add', phraseId = null) {
    const titleDialog = document.getElementById('titleDialog');
    const titleDialogTitle = document.getElementById('titleDialogTitle');
    const titleInput = document.getElementById('titleDialogInput');
    const showEditorCheckbox = document.getElementById('titleDialogShowEditor');
    const positionSelect = document.getElementById('titleDialogPosition');
    const saveBtn = document.getElementById('titleDialogSaveBtn');

    if (!titleDialog || !titleInput || !positionSelect) return;

    const isEdit = mode === 'edit' && phraseId;
    titleDialogTitle.textContent = isEdit ? '编辑标题' : '添加标题';

    const defaultCategoryId = currentSelectedCategoryId || '1';
    const numericCatId = parseInt(defaultCategoryId, 10);

    let currentTitle = '';
    let currentShowEditor = false;
    if (isEdit) {
        const phrase = await db.getPhrase(phraseId);
        if (!phrase) {
            showToast('❌ 未找到标题', 'error');
            return;
        }
        currentTitle = phrase.title_text || phrase.content || '';
        currentShowEditor = phrase.show_text_editor || false;
    }

    titleInput.value = currentTitle;
    if (showEditorCheckbox) showEditorCheckbox.checked = currentShowEditor;

    positionSelect.dataset.currentTitleId = isEdit ? String(phraseId) : '';
    await buildTitlePositionSelect(positionSelect, numericCatId, isEdit ? phraseId : null);

    titleDialog.style.display = 'flex';
    setTimeout(() => titleInput.focus(), 100);
    if (isEdit) titleInput.select();

    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

    newSaveBtn.addEventListener('click', async () => {
        const titleText = titleInput.value.trim();
        if (!titleText) {
            showToast('❌ 标题内容不能为空', 'error');
            return;
        }
        const showEditor = showEditorCheckbox ? showEditorCheckbox.checked : false;
        const positionValue = getCustomSelectValue('titleDialogPosition');

        try {
            if (isEdit) {
                // 更新标题文本
                await db.updateTitlePhrase(phraseId, titleText, showEditor);
                // 检查位置是否变化
                await handleTitlePositionChange(positionSelect, phraseId, numericCatId);
                showToast('✅ 标题已更新');
            } else {
                // 解析插入位置
                // 'title_X' → 插入到标题 X 之上
                // 'phrase_X' → 插入到话术 X 之上（该标题的第一个位置）
                if (positionValue.startsWith('title_')) {
                    const targetTitleId = parseInt(positionValue.replace('title_', ''), 10);
                    await db.addTitlePhraseBeforeTitle(titleText, numericCatId, showEditor, targetTitleId);
                } else if (positionValue.startsWith('phrase_')) {
                    const targetPhraseId = parseInt(positionValue.replace('phrase_', ''), 10);
                    await db.addTitlePhraseBeforePhrase(titleText, numericCatId, showEditor, targetPhraseId);
                } else {
                    // 兜底：追加到最后
                    await db.addTitlePhrase(titleText, numericCatId, showEditor, null);
                }
                showToast('✅ 标题已添加');
            }
            titleDialog.style.display = 'none';
            await loadPhrases();
        } catch (error) {
            console.error('保存标题失败:', error);
            showToast('❌ 保存失败', 'error');
        }
    });

    const closeBtn = titleDialog.querySelector('.close-btn');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener('click', () => {
        titleDialog.style.display = 'none';
    });
}

async function buildTitlePositionSelect(selectEl, categoryId, currentTitleId = null) {
    const dropdown = selectEl.querySelector('.custom-select-dropdown');
    if (!dropdown) return;

    const allPhrases = await db.searchPhrases('', categoryId);
    // 显示所有标题（包括正在编辑的标题）
    const titles = allPhrases.filter(p => p.is_title)
        .sort((a, b) => (a.title_order ?? 999999) - (b.title_order ?? 999999));

    dropdown.innerHTML = '';

    if (titles.length === 0) {
        // 没有标题：显示扁平序号列表
        const nonTitles = allPhrases.filter(p => !p.is_title);
        nonTitles.sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999)).forEach((phrase, idx) => {
            const label = (phrase.content || '').substring(0, 20) || '（空话术）';
            addPositionOption(dropdown, 'phrase_' + phrase.id, (idx + 1) + '. ' + label, false);
        });
    } else {
        // 有标题：先显示第一个标题之前的短语（扁平），再显示各标题分组
        const firstTitle = titles[0];
        const firstTitleSortOrder = firstTitle.sort_order ?? Infinity;

        // 1. 第一个标题之前的短语（扁平序号）
        const phrasesBeforeFirst = allPhrases
            .filter(p => !p.is_title && (p.sort_order ?? 0) < firstTitleSortOrder)
            .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

        phrasesBeforeFirst.forEach((phrase, idx) => {
            const label = (phrase.content || '').substring(0, 20) || '（空话术）';
            addPositionOption(dropdown, 'phrase_' + phrase.id, (idx + 1) + '. ' + label, false);
        });

        // 2. 各标题分组
        titles.forEach((title, titleIdx) => {
            const group = document.createElement('li');
            group.className = 'custom-select-group';
            group.dataset.titleId = title.id;

            // 先计算该标题下的话术
            const nextTitleSortOrder = titleIdx < titles.length - 1 ? (titles[titleIdx + 1].sort_order ?? Infinity) : Infinity;
            const titlePhrases = allPhrases
                .filter(p => !p.is_title &&
                    (p.sort_order ?? 0) > (title.sort_order ?? -Infinity) &&
                    (p.sort_order ?? 0) < nextTitleSortOrder)
                .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

            const header = document.createElement('div');
            header.className = 'custom-select-group-header';
            header.dataset.value = 'title_' + title.id;

            // 展开箭头（只有当下面的的话术数量 > 0 时才显示）
            const arrow = document.createElement('span');
            arrow.className = 'custom-select-group-arrow';
            arrow.textContent = '▶';
            if (titlePhrases.length === 0) {
                arrow.style.visibility = 'hidden';
            }
            header.appendChild(arrow);

            // 标题名
            const titleName = document.createElement('span');
            titleName.className = 'custom-select-group-title';
            const nameText = (title.title_text || title.content || '（无标题）').substring(0, 15);
            titleName.textContent = nameText;
            header.appendChild(titleName);

            // ↑↓ 排序按钮
            const orderBtns = document.createElement('div');
            orderBtns.className = 'title-order-btns';

            const upBtn = document.createElement('button');
            upBtn.className = 'title-order-btn' + (titleIdx === 0 ? ' disabled' : '');
            upBtn.textContent = '↑';
            upBtn.title = '上移';
            upBtn.dataset.direction = 'up';
            orderBtns.appendChild(upBtn);

            const downBtn = document.createElement('button');
            downBtn.className = 'title-order-btn' + (titleIdx === titles.length - 1 ? ' disabled' : '');
            downBtn.textContent = '↓';
            downBtn.title = '下移';
            downBtn.dataset.direction = 'down';
            orderBtns.appendChild(downBtn);

            header.appendChild(orderBtns);
            group.appendChild(header);

            // 标题下的话术列表（可展开）
            const itemsContainer = document.createElement('ul');
            itemsContainer.className = 'custom-select-group-items';

            if (titlePhrases.length === 0) {
                const emptyLi = document.createElement('li');
                emptyLi.className = 'custom-select-option';
                emptyLi.style.color = '#999';
                emptyLi.style.fontStyle = 'italic';
                emptyLi.textContent = '（暂无话术）';
                itemsContainer.appendChild(emptyLi);
            } else {
                titlePhrases.forEach((phrase, pIdx) => {
                    const li = document.createElement('li');
                    li.className = 'custom-select-option';
                    li.dataset.value = 'phrase_' + phrase.id;
                    const label = (phrase.content || '').substring(0, 15) || '（空话术）';
                    li.textContent = (pIdx + 1) + '. ' + label;
                    itemsContainer.appendChild(li);
                });
            }

            group.appendChild(itemsContainer);
            dropdown.appendChild(group);
        });
    }

    initCustomSelect('titleDialogPosition');
    // 默认选中第一个可选位置
    const firstOption = dropdown.querySelector('.custom-select-option');
    if (firstOption) {
        setCustomSelectValue('titleDialogPosition', firstOption.dataset.value);
    }

    // 绑定 ↑↓ 排序按钮事件
    bindTitleOrderButtons(selectEl);
}

/**
 * 绑定标题选择器中的 ↑↓ 排序按钮事件
 */
function bindTitleOrderButtons(selectEl) {
    const dropdown = selectEl.querySelector('.custom-select-dropdown');
    if (!dropdown) return;

    dropdown.addEventListener('click', async (e) => {
        const orderBtn = e.target.closest('.title-order-btn');
        if (!orderBtn || orderBtn.classList.contains('disabled')) return;

        e.stopPropagation(); // 阻止冒泡，避免触发标题选择

        const direction = orderBtn.dataset.direction; // 'up' | 'down'
        const group = orderBtn.closest('.custom-select-group');
        if (!group) return;

        const titleId = parseInt(group.dataset.titleId, 10);
        const categoryId = parseInt(currentSelectedCategoryId || '1', 10);

        // 交换相邻标题的 title_order
        try {
            const allPhrases = await db.searchPhrases('', categoryId);
            const titles = allPhrases
                .filter(p => p.is_title)
                .sort((a, b) => (a.title_order ?? 999999) - (b.title_order ?? 999999));

            const currentIdx = titles.findIndex(t => t.id === titleId);
            if (currentIdx === -1) return;

            const swapIdx = direction === 'up' ? currentIdx - 1 : currentIdx + 1;
            if (swapIdx < 0 || swapIdx >= titles.length) return;

            // 交换 title_order
            const currentTitle = titles[currentIdx];
            const swapTitle = titles[swapIdx];
            const tempOrder = currentTitle.title_order;
            currentTitle.title_order = swapTitle.title_order;
            swapTitle.title_order = tempOrder;

            // 保存到数据库
            await db.updateTitlePhraseOrder(currentTitle.id, currentTitle.title_order);
            await db.updateTitlePhraseOrder(swapTitle.id, swapTitle.title_order);

            // 刷新选择器
            const currentTitleId = selectEl.dataset.currentTitleId ? parseInt(selectEl.dataset.currentTitleId, 10) : null;
            await buildTitlePositionSelect(selectEl, categoryId, currentTitleId);

            // 同时更新页面上的标题顺序
            await loadPhrases();

            showToast('✅ 标题顺序已调整');
        } catch (err) {
            console.error('排序标题失败:', err);
            showToast('❌ 排序失败', 'error');
        }
    });
}

/**
 * 处理编辑标题时的位置变化
 */
async function handleTitlePositionChange(selectEl, phraseId, categoryId) {
    const positionValue = getCustomSelectValue('titleDialogPosition');
    const allPhrases = await db.searchPhrases('', categoryId);
    const currentTitle = allPhrases.find(p => p.id === phraseId);
    if (!currentTitle) return;

    let targetTitleId = null;
    let insertBefore = false;

    if (positionValue.startsWith('title_')) {
        targetTitleId = parseInt(positionValue.replace('title_', ''), 10);
        if (targetTitleId === phraseId) return; // 位置没变
        insertBefore = true;
    } else if (positionValue.startsWith('phrase_')) {
        const targetPhraseId = parseInt(positionValue.replace('phrase_', ''), 10);
        const targetPhrase = allPhrases.find(p => p.id === targetPhraseId);
        if (!targetPhrase) return;
        // 找到该话术归属的标题
        const phraseSortOrder = targetPhrase.sort_order ?? 0;
        const titles = allPhrases
            .filter(p => p.is_title && p.id !== phraseId && (p.sort_order ?? -Infinity) <= phraseSortOrder)
            .sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));
        if (titles.length === 0) {
            // 插入到最前面
            targetTitleId = null;
        } else {
            targetTitleId = titles[0].id;
            insertBefore = true;
        }
    }

    if (targetTitleId === phraseId) return; // 位置没变

    try {
        if (insertBefore && targetTitleId) {
            await db.repositionTitle(phraseId, targetTitleId);
        } else {
            // 插入到最前面
            await db.repositionTitleToStart(phraseId);
        }
    } catch (err) {
        console.error('移动标题失败:', err);
        showToast('❌ 移动标题失败', 'error');
    }
}

function addPositionOption(dropdown, value, text, selected = false) {
    const li = document.createElement('li');
    li.className = 'custom-select-option' + (selected ? ' selected' : '');
    li.dataset.value = value;
    li.setAttribute('role', 'option');
    li.textContent = text;
    dropdown.appendChild(li);
}

async function openTitlePhraseDialog() {
    return openTitleDialog('add');
}

async function editTitlePhrase(phraseId) {
    return openTitleDialog('edit', phraseId);
}

/**
 * 删除标题卡片（仅删除标题本身，不删除下面的话术）
 */
async function deleteTitlePhrase(phraseId) {
    let childCount = 0;
    try {
        const children = await db.getChildPhrases(phraseId, false);
        childCount = (children || []).length;
    } catch (e) {
        childCount = 0;
    }
    let message = '只会删除标题本身，不会删除下面的话术。\n确定要删除这个标题吗？';
    if (childCount > 0) {
        message += `\n\n⚠️ 该标题下还有 ${childCount} 条子话术。\n删除后子话术不会一起删除，但会失去归属。`;
    }
    const result = await showDeleteConfirmDialog(
        '🗑️ 删除标题',
        message,
        { showPermanentDelete: false }
    );
    if (result === 'cancel') return;
    try {
        await db.deletePhrase(phraseId);
        showToast('✅ 标题已删除');
        await loadPhrases();
    } catch (error) {
        console.error('删除标题失败:', error);
        showToast('❌ 删除标题失败', 'error');
    }
}

// 加载话术数据到编辑框
async function loadPhraseData(phraseId) {
    // 🔧 如果是从回收站恢复，需要从回收站加载数据
    let phrase;
    if (window._isRestoringPhrase) {
        const deletedPhrases = await db.getDeletedPhrases();
        phrase = deletedPhrases.find(p => p.id === phraseId);
    } else {
        const phrases = await db.searchPhrases();
        phrase = phrases.find(p => p.id === phraseId);
    }
    
    if (phrase) {
        const contentEl = document.getElementById('phraseContent');
        // 支持contenteditable和textarea两种模式
        if (contentEl.contentEditable === 'true') {
            // 如果有HTML内容，先归一化尾部再设置，避免历史 content_html 中残留空块导致编辑器显示多余空行
            if (phrase.content_html) {
                (function normalizeAndSet(html) {
                    const temp = document.createElement('div');
                    temp.innerHTML = html || '';

                    // 与保存端相同的尾部删除逻辑
                    (function removeTrailingEmptyNodes(root) {
                        const ZERO_WIDTH = /\u200B/g;
                        let madeChange = true;
                        while (madeChange) {
                            madeChange = false;
                            const node = root.lastChild;
                            if (!node) break;

                            if (node.nodeType === Node.TEXT_NODE) {
                                const txt = (node.textContent || '').replace(ZERO_WIDTH, '');
                                if (txt.trim() === '') {
                                    root.removeChild(node);
                                    madeChange = true;
                                    continue;
                                }
                                const trimmedEnd = txt.replace(/[\r\n]+$/g, '');
                                if (trimmedEnd !== txt) {
                                    node.textContent = trimmedEnd;
                                    madeChange = true;
                                    continue;
                                }
                                break;
                            }

                            if (node.nodeType === Node.ELEMENT_NODE) {
                                const tag = (node.tagName || '').toLowerCase();
                                if (tag === 'br') {
                                    root.removeChild(node);
                                    madeChange = true;
                                    continue;
                                }
                                const innerText = (node.textContent || '').replace(ZERO_WIDTH, '').trim();
                                if (innerText === '') {
                                    root.removeChild(node);
                                    madeChange = true;
                                    continue;
                                }
                                let onlyBrOrEmpty = true;
                                for (let i = 0; i < node.childNodes.length; i++) {
                                    const c = node.childNodes[i];
                                    if (c.nodeType === Node.ELEMENT_NODE && (c.tagName || '').toLowerCase() === 'br') {
                                        continue;
                                    }
                                    if (c.nodeType === Node.TEXT_NODE && (c.textContent || '').replace(ZERO_WIDTH, '').trim() === '') {
                                        continue;
                                    }
                                    onlyBrOrEmpty = false;
                                    break;
                                }
                                if (onlyBrOrEmpty) {
                                    root.removeChild(node);
                                    madeChange = true;
                                    continue;
                                }
                                break;
                            }

                            root.removeChild(node);
                            madeChange = true;
                        }
                    })(temp);

                    // 额外做字符串层面的末尾清理，防止某些浏览器生成的特殊空标签残留
                    let cleaned = (temp.innerHTML || '').replace(/(?:\s|&nbsp;|<br[^>]*>|<div[^>]*>\s*<\/div>|<p[^>]*>\s*<\/p>)+$/i, '').trim();
                    contentEl.innerHTML = cleaned;
                    // EXTRA DEBUG: inspect contentEl after assignment to catch editor-side mutations
                    try {
                        const elHtml = contentEl.innerHTML || '';
                        dbgLog('[DEBUG savePhrase] contentEl.innerHTML length AFTER SET:', elHtml.length);
                        dbgLog('[DEBUG savePhrase] contentEl.innerHTML TAIL AFTER SET:', elHtml.slice(-500));
                        function collectTailPathFromEl(root, maxDepth) {
                            const path = [];
                            let cur = root;
                            let depth = 0;
                            maxDepth = maxDepth || 12;
                            while (cur && cur.lastChild && depth < maxDepth) {
                                const last = cur.lastChild;
                                path.push({
                                    nodeType: last.nodeType,
                                    tag: last.nodeType === Node.ELEMENT_NODE ? (last.tagName || '').toLowerCase() : null,
                                    innerHTMLlen: last.nodeType === Node.ELEMENT_NODE ? ((last.innerHTML || '').length) : null,
                                    textLen: (last.textContent || '').length,
                                    preview: (last.nodeType === Node.ELEMENT_NODE ? (last.innerHTML || '').slice(-200) : (last.textContent || '').slice(-200))
                                });
                                if (last.nodeType === Node.ELEMENT_NODE) {
                                    cur = last;
                                } else break;
                                depth++;
                            }
                            return path;
                        }
                        dbgLog('[DEBUG savePhrase] contentEl TAIL PATH AFTER SET:', JSON.stringify(collectTailPathFromEl(contentEl, 12)));
                        // detect any trailing empty elements along the tail path
                        try {
                            let cur = contentEl;
                            const empties = [];
                            while (cur && cur.lastChild) {
                                const last = cur.lastChild;
                                if (last.nodeType === Node.ELEMENT_NODE) {
                                    const txt = (last.textContent || '').replace(/\u200B/g, '').trim();
                                    if (txt === '') {
                                        empties.push({ tag: (last.tagName || '').toLowerCase(), innerHTMLlen: (last.innerHTML || '').length });
                                    }
                                    cur = last;
                                } else break;
                            }
                            dbgLog('[DEBUG savePhrase] detected trailing empty elements AFTER SET:', JSON.stringify(empties));
                        } catch (e) { console.warn('[DEBUG savePhrase] tail empties detect failed', e); }
                    } catch (e) {
                        console.warn('[DEBUG savePhrase] failed to inspect contentEl after set', e);
                    }
                    // 延时二次清理：有些富文本编辑器会在我们赋值后异步规范化/重构 DOM，
                    // 这里在短延时后再检查并清理尾部空节点，保证编辑器最终状态也被清理。
                    try {
                        setTimeout(function() {
                            try {
                                (function removeTrailingEmptyNodesOnEl(root) {
                                    const ZERO_WIDTH = /\u200B/g;
                                    let madeChange = true;
                                    while (madeChange) {
                                        madeChange = false;
                                        const node = root.lastChild;
                                        if (!node) break;
                                        if (node.nodeType === Node.TEXT_NODE) {
                                            const txt = (node.textContent || '').replace(ZERO_WIDTH, '');
                                            if (txt.trim() === '') {
                                                root.removeChild(node);
                                                madeChange = true;
                                                continue;
                                            }
                                            const trimmedEnd = txt.replace(/[\r\n]+$/g, '');
                                            if (trimmedEnd !== txt) {
                                                node.textContent = trimmedEnd;
                                                madeChange = true;
                                                continue;
                                            }
                                            break;
                                        }
                                        if (node.nodeType === Node.ELEMENT_NODE) {
                                            const tag = (node.tagName || '').toLowerCase();
                                            if (tag === 'br') {
                                                root.removeChild(node);
                                                madeChange = true;
                                                continue;
                                            }
                                            const innerText = (node.textContent || '').replace(ZERO_WIDTH, '').trim();
                                            if (innerText === '') {
                                                root.removeChild(node);
                                                madeChange = true;
                                                continue;
                                            }
                                            let onlyBrOrEmpty = true;
                                            for (let i = 0; i < node.childNodes.length; i++) {
                                                const c = node.childNodes[i];
                                                if (c.nodeType === Node.ELEMENT_NODE && (c.tagName || '').toLowerCase() === 'br') {
                                                    continue;
                                                }
                                                if (c.nodeType === Node.TEXT_NODE && (c.textContent || '').replace(ZERO_WIDTH, '').trim() === '') {
                                                    continue;
                                                }
                                                onlyBrOrEmpty = false;
                                                break;
                                            }
                                            if (onlyBrOrEmpty) {
                                                root.removeChild(node);
                                                madeChange = true;
                                                continue;
                                            }
                                            break;
                                        }
                                        root.removeChild(node);
                                        madeChange = true;
                                    }
                                })(contentEl);

                                // 记录延时清理后的状态
                                const elHtml = contentEl.innerHTML || '';
                                dbgLog('[DEBUG savePhrase] delayed cleanup AFTER LOAD - contentEl.innerHTML length:', elHtml.length);
                                dbgLog('[DEBUG savePhrase] delayed cleanup AFTER LOAD - contentEl.innerHTML TAIL:', elHtml.slice(-500));
                                // detect trailing empties again
                                try {
                                    let cur = contentEl;
                                    const empties = [];
                                    while (cur && cur.lastChild) {
                                        const last = cur.lastChild;
                                        if (last.nodeType === Node.ELEMENT_NODE) {
                                            const txt = (last.textContent || '').replace(/\u200B/g, '').trim();
                                            if (txt === '') {
                                                empties.push({ tag: (last.tagName || '').toLowerCase(), innerHTMLlen: (last.innerHTML || '').length });
                                            }
                                            cur = last;
                                        } else break;
                                    }
                                    dbgLog('[DEBUG savePhrase] delayed cleanup AFTER LOAD - detected trailing empty elements:', JSON.stringify(empties));
                                } catch (e) {
                                    console.warn('[DEBUG savePhrase] delayed cleanup AFTER LOAD - tail empties detect failed', e);
                                }
                            } catch (e) {
                                console.warn('[DEBUG savePhrase] delayed cleanup AFTER LOAD failed', e);
                            }
                        }, 60);
                    } catch (e) {
                        console.warn('[DEBUG savePhrase] failed to schedule delayed cleanup', e);
                    }
                    // MutationObserver：实时监控 load 后编辑器可能的异步重构，检测到变更时立即清理尾部空节点并记录日志
                    try {
                        (function setupMutObserver(rootEl) {
                            if (!rootEl || typeof MutationObserver === 'undefined') return;
                            let obsCount = 0;
                            const maxObs = 8;
                            const maxMs = 1000;
                            const ZERO_WIDTH = /\u200B/g;
                            const observer = new MutationObserver(function(mutations) {
                                obsCount++;
                                try {
                                    // 与延时清理相同的清理逻辑
                                    (function removeTrailingEmptyNodesOnEl(root) {
                                        let madeChange = true;
                                        while (madeChange) {
                                            madeChange = false;
                                            const node = root.lastChild;
                                            if (!node) break;
                                            if (node.nodeType === Node.TEXT_NODE) {
                                                const txt = (node.textContent || '').replace(ZERO_WIDTH, '');
                                                if (txt.trim() === '') {
                                                    root.removeChild(node);
                                                    madeChange = true;
                                                    continue;
                                                }
                                                const trimmedEnd = txt.replace(/[\r\n]+$/g, '');
                                                if (trimmedEnd !== txt) {
                                                    node.textContent = trimmedEnd;
                                                    madeChange = true;
                                                    continue;
                                                }
                                                break;
                                            }
                                            if (node.nodeType === Node.ELEMENT_NODE) {
                                                const tag = (node.tagName || '').toLowerCase();
                                                if (tag === 'br') {
                                                    root.removeChild(node);
                                                    madeChange = true;
                                                    continue;
                                                }
                                                const innerText = (node.textContent || '').replace(ZERO_WIDTH, '').trim();
                                                if (innerText === '') {
                                                    root.removeChild(node);
                                                    madeChange = true;
                                                    continue;
                                                }
                                                let onlyBrOrEmpty = true;
                                                for (let i = 0; i < node.childNodes.length; i++) {
                                                    const c = node.childNodes[i];
                                                    if (c.nodeType === Node.ELEMENT_NODE && (c.tagName || '').toLowerCase() === 'br') {
                                                        continue;
                                                    }
                                                    if (c.nodeType === Node.TEXT_NODE && (c.textContent || '').replace(ZERO_WIDTH, '').trim() === '') {
                                                        continue;
                                                    }
                                                    onlyBrOrEmpty = false;
                                                    break;
                                                }
                                                if (onlyBrOrEmpty) {
                                                    root.removeChild(node);
                                                    madeChange = true;
                                                    continue;
                                                }
                                                break;
                                            }
                                            root.removeChild(node);
                                            madeChange = true;
                                        }
                                    })(rootEl);

                                    // 记录清理后的状态
                                    const elHtml2 = rootEl.innerHTML || '';
                                    dbgLog('[DEBUG savePhrase] mutObserver - cleanup - contentEl.innerHTML length:', elHtml2.length);
                                    dbgLog('[DEBUG savePhrase] mutObserver - cleanup - contentEl.innerHTML TAIL:', elHtml2.slice(-500));
                                    try {
                                        let cur = rootEl;
                                        const empties = [];
                                        while (cur && cur.lastChild) {
                                            const last = cur.lastChild;
                                            if (last.nodeType === Node.ELEMENT_NODE) {
                                                const txt = (last.textContent || '').replace(ZERO_WIDTH, '').trim();
                                                if (txt === '') {
                                                    empties.push({ tag: (last.tagName || '').toLowerCase(), innerHTMLlen: (last.innerHTML || '').length });
                                                }
                                                cur = last;
                                            } else break;
                                        }
                                        dbgLog('[DEBUG savePhrase] mutObserver - detected trailing empty elements:', JSON.stringify(empties));
                                    } catch (e) {
                                        console.warn('[DEBUG savePhrase] mutObserver - tail empties detect failed', e);
                                    }
                                } catch (e) {
                                    console.warn('[DEBUG savePhrase] mutObserver - cleanup failed', e);
                                }

                                if (obsCount >= maxObs) {
                                    try {
                                        observer.disconnect();
                                        dbgLog('[DEBUG savePhrase] mutObserver - disconnected after maxObs');
                                    } catch (e) {}
                                }
                            });
                            observer.observe(rootEl, { childList: true, subtree: true, characterData: true });
                            // 安全超时：无论如何在 maxMs 后断开
                            setTimeout(function() {
                                try {
                                    observer.disconnect();
                                    dbgLog('[DEBUG savePhrase] mutObserver - timeout disconnect');
                                } catch (e) {}
                            }, maxMs);
                        })(contentEl);
                    } catch (e) {
                        console.warn('[DEBUG savePhrase] failed to setup MutationObserver', e);
                    }
                })(phrase.content_html);
            } else {
                contentEl.textContent = phrase.content;
            }
        } else {
            contentEl.value = phrase.content;
        }
        // 触发占位符检查：根据内容是否包含{}决定补全勾选框是否可选
        if (contentEl) contentEl.dispatchEvent(new Event('input'));
        setCustomSelectValue('phraseCategory', phrase.category_id);
        document.getElementById('phraseTags').value = phrase.tags || '';
        document.getElementById('enablePlaceholder').checked = phrase.enable_placeholder || false;
        document.getElementById('enableImages').checked = !!phrase.enable_images;
        document.getElementById('disableClickCopy').checked = phrase.disable_click_copy || false;
        document.getElementById('enableDescription').checked = phrase.enable_description || false;
        document.getElementById('enableVariants').checked = phrase.enable_variants || false;
        document.getElementById('tagPrefix').checked = phrase.tag_prefix || false;
        const _actAsTitleEl = document.getElementById('actAsTitle');
        if (_actAsTitleEl) {
            const _isActTitle = (window.__actAsTitleHelpers && window.__actAsTitleHelpers.has(phrase.id)) || phrase.act_as_title === true;
            _actAsTitleEl.checked = _isActTitle;
            const _dccEl = document.getElementById('disableClickCopy');
            const _evEl = document.getElementById('enableVariants');
            const _eiEl = document.getElementById('enableImages');
            const _epEl = document.getElementById('enablePlaceholder');
            if (_isActTitle) {
                if (_dccEl) { _dccEl.disabled = true; _dccEl.checked = false; }
                if (_evEl) { _evEl.disabled = true; _evEl.checked = false; }
                if (_eiEl) { _eiEl.disabled = true; _eiEl.checked = false; }
                if (_epEl) { _epEl.disabled = true; _epEl.checked = false; }
            } else {
                if (_dccEl) _dccEl.disabled = false;
                if (_evEl) _evEl.disabled = false;
                if (_eiEl) _eiEl.disabled = false;
                if (_epEl) _epEl.disabled = false;
            }
            const _teRow = document.getElementById('actTitleTextEditorRow');
            const _teEl = document.getElementById('actTitleTextEditor');
            if (_teRow) _teRow.style.display = _isActTitle ? '' : 'none';
            if (_teEl) _teEl.checked = _isActTitle && (window.__actTitleTextEditorHelpers && window.__actTitleTextEditorHelpers.has(phrase.id));
        }
        setCustomSelectValue('phraseJumpCategory', phrase.jump_category_id ? String(phrase.jump_category_id) : '');
        
        // 加载样式数据（这些是整体样式，不是部分文字样式）
        const textColorEl = document.getElementById('phraseTextColor');
        const bgColorEl = document.getElementById('phraseBgColor');
        const isBoldEl = document.getElementById('phraseIsBold');
        if (textColorEl) {
            textColorEl.value = phrase.text_color || '#333333';
            const textColorDisplay = document.getElementById('phraseTextColorDisplay');
            if (textColorDisplay) {
                textColorDisplay.style.background = textColorEl.value;
            }
        }
        if (bgColorEl) {
            bgColorEl.value = phrase.bg_color || '#ffffff';
            const bgColorDisplay = document.getElementById('phraseBgColorDisplay');
            if (bgColorDisplay) {
                bgColorDisplay.style.background = bgColorEl.value;
            }
        }
        if (isBoldEl) isBoldEl.checked = phrase.is_bold || false;
    }
}

// 关闭话术对话框
async function closePhraseDialog() {
    dbgLog('closePhraseDialog() 被调用');

    // 关闭任意对话框都清理子话术模式（避免影响下次普通添加/编辑）
    clearChildPhraseDialogMode();
    
    // 🔧 如果是从回收站恢复的话术，且用户没有保存就关闭了，需要确保话术仍然在回收站中
    // 由于我们不再提前恢复话术，所以这里不需要回滚操作
    // 但我们需要清除标记
    if (window._isRestoringPhrase && currentEditingPhraseId) {
        console.log('⚠️ 用户关闭了从回收站恢复的话术编辑对话框，未保存');
        // 话术仍然在回收站中（is_deleted = true），不需要额外操作
    }
    
    const dialog = document.getElementById('phraseDialog');
    if (dialog) {
        dialog.style.display = 'none';
        dbgLog('✅ 对话框已关闭');
    } else {
        console.error('❌ 找不到 phraseDialog 元素');
    }
    currentEditingPhraseId = null;
    window._isRestoringPhrase = false; // 清除标记
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
}

// 保存话术
async function savePhraseDialog() {
    console.log('savePhraseDialog() 被调用');
    
    const contentEl = document.getElementById('phraseContent');
    let content, contentHtml;
    
    // 支持contenteditable和textarea两种模式
    if (contentEl.contentEditable === 'true') {
        // 不直接保存原始 innerHTML（可能包含尾部空的 <div>/<p>/<br>），先清理末尾空块并同时提取纯文本
        const rawHtml = contentEl.innerHTML || '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = rawHtml;
        console.log('[SAVE] raw len=' + rawHtml.length + ' head80="' + rawHtml.slice(0, 80).replace(/\n/g, '\\n') + '"');
        // --- EXTRA DEBUG: print tail and leading nodes
        try {
            const fullHtmlDebug = (tempDiv.innerHTML || '');
            console.log(`[SAVE] BEFORE: len=${fullHtmlDebug.length} head100="${fullHtmlDebug.slice(0, 100)}"`);

            // ====== DEBUG: 分析开头节点 ======
            const leadingPath = [];
            let cur = tempDiv;
            let depth = 0;
            while (cur && cur.firstChild && depth < 10) {
                const first = cur.firstChild;
                const tag = first.nodeType === Node.ELEMENT_NODE ? (first.tagName || '').toLowerCase() : null;
                const textLen = (first.textContent || '').length;
                const innerHtmlLen = first.nodeType === Node.ELEMENT_NODE ? (first.innerHTML || '').length : null;
                const isEmpty = first.nodeType === Node.TEXT_NODE
                    ? (first.textContent || '').trim() === ''
                    : (first.nodeType === Node.ELEMENT_NODE && ((first.textContent || '').trim() === '' || tag === 'br'));
                leadingPath.push({ depth, tag, textLen, empty: isEmpty });
                if (first.nodeType === Node.ELEMENT_NODE && first.firstChild) {
                    cur = first;
                } else {
                    break;
                }
                depth++;
            }
            console.log('[SAVE] LEADING PATH: ' + JSON.stringify(leadingPath));
            if (tempDiv.firstChild) {
                const fc = tempDiv.firstChild;
                console.log('[SAVE] FIRST CHILD:', fc.nodeType === Node.ELEMENT_NODE ? fc.tagName.toLowerCase() : (fc.nodeType === Node.TEXT_NODE ? 'TEXT' : 'OTHER'), 'isEmpty:', fc.nodeType === Node.TEXT_NODE ? (fc.textContent || '').trim() === '' : (fc.tagName.toLowerCase() === 'br' || (fc.textContent || '').trim() === ''));
            }
            // ====== END DEBUG ======
        } catch (e) {
            console.warn('[SAVE] debug print failed', e);
        }

        // 更严格地删除尾部空白节点（包括连续的 <br>、空元素、空文本节点、以及只包含不可见字符的节点）
        (function removeTrailingEmptyNodes(root) {
            const ZERO_WIDTH = /\u200B/g;

            function isNodeEmpty(node) {
                if (!node) return true;
                if (node.nodeType === Node.TEXT_NODE) {
                    return ((node.textContent || '').replace(ZERO_WIDTH, '').trim() === '');
                }
                if (node.nodeType === Node.ELEMENT_NODE) {
                    const tag = (node.tagName || '').toLowerCase();
                    if (tag === 'br') return true;
                    // If any child is non-empty, node is not empty
                    for (let i = 0; i < node.childNodes.length; i++) {
                        if (!isNodeEmpty(node.childNodes[i])) return false;
                    }
                    return true;
                }
                return true;
            }

            // Walk down the tail path to the deepest last-child and clean empties there first.
            let currentRoot = root;
            while (currentRoot && currentRoot.lastChild) {
                let node = currentRoot.lastChild;
                // If the last child is an element with its own children, descend into it to clean deep empties.
                if (node.nodeType === Node.ELEMENT_NODE && node.lastChild) {
                    currentRoot = node;
                    continue;
                }

                // If the last child is empty, remove it and then backtrack (set currentRoot to parent).
                if (isNodeEmpty(node)) {
                    node.parentNode.removeChild(node);
                    currentRoot = node.parentNode;
                    continue;
                }

                // If it's a text node with trailing newlines, trim them.
                if (node.nodeType === Node.TEXT_NODE) {
                    const txt = (node.textContent || '').replace(ZERO_WIDTH, '');
                    const trimmedEnd = txt.replace(/[\r\n]+$/g, '');
                    if (trimmedEnd !== txt) {
                        node.textContent = trimmedEnd;
                        // If trimming made it empty, remove it and backtrack.
                        if (trimmedEnd.trim() === '') {
                            node.parentNode.removeChild(node);
                            currentRoot = node.parentNode;
                            continue;
                        }
                    }
                }
                // If node is non-empty and not trim-able, we're done.
                break;
            }
        })(tempDiv);

        // debug: show innerHTML after cleaning
        console.log('[SAVE] AFTER clean len=' + ((tempDiv.innerHTML || '').length) + ' head80="' + ((tempDiv.innerHTML || '').slice(0, 80)) + '"');

        // 进一步清理 HTML 字符串末尾和开头常见的空白结构
        let cleanedHtml = tempDiv.innerHTML || '';
        // 移除开头的空白块
        cleanedHtml = cleanedHtml.replace(/^(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>|<div[^>]*>(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>)*<\/div>|<p[^>]*>(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>)*<\/p>)+/i, '');
        // 移除末尾的空白块
        cleanedHtml = cleanedHtml.replace(/(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>|<div[^>]*>(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>)*<\/div>|<p[^>]*>(?:\s|&nbsp;|\u200B|\uFEFF|<br[^>]*>)*<\/p>)+$/i, '');
        contentHtml = cleanedHtml.trim();
        console.log('[SAVE] FINAL len=' + (contentHtml || '').length + ' head80="' + ((contentHtml || '').slice(0, 80)) + '"');
        if (contentHtml && contentHtml.match(/^<(?:br)[^>]*>/i)) {
            console.warn('[SAVE] ⚠️ FINAL STARTS WITH BR:', contentHtml.match(/^<[^>]+>/)[0]);
        }
        // EXTRA DEBUG: collect tail path info from tempDiv and cleanedHtml (removed for brevity)
        try {
            // 额外一次基于 DOM 的尾部空节点清理（处理 regex 未覆盖的边缘情况）
            const tmp2 = document.createElement('div');
            tmp2.innerHTML = contentHtml || '';
            (function ensureNoTrailingEmptyHtml(root) {
                const ZERO_WIDTH = /\u200B/g;
                function isNodeEmpty(node) {
                    if (!node) return true;
                    if (node.nodeType === Node.TEXT_NODE) {
                        return ((node.textContent || '').replace(ZERO_WIDTH, '').trim() === '');
                    }
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const tag = (node.tagName || '').toLowerCase();
                        if (tag === 'br') return true;
                        for (let i = 0; i < node.childNodes.length; i++) {
                            if (!isNodeEmpty(node.childNodes[i])) return false;
                        }
                        return true;
                    }
                    return true;
                }

                let cur = root;
                while (cur && cur.lastChild) {
                    let node = cur.lastChild;
                    if (node.nodeType === Node.ELEMENT_NODE && node.lastChild) {
                        cur = node;
                        continue;
                    }
                    if (isNodeEmpty(node)) {
                        node.parentNode.removeChild(node);
                        cur = node.parentNode;
                        continue;
                    }
                    if (node.nodeType === Node.TEXT_NODE) {
                        const txt = (node.textContent || '').replace(ZERO_WIDTH, '');
                        const trimmedEnd = txt.replace(/[\r\n]+$/g, '');
                        if (trimmedEnd !== txt) {
                            node.textContent = trimmedEnd;
                            if (trimmedEnd.trim() === '') {
                                node.parentNode.removeChild(node);
                                cur = node.parentNode;
                                continue;
                            }
                        }
                    }
                    break;
                }
            })(tmp2);
            contentHtml = (tmp2.innerHTML || '').trim();
        } catch (e) {
            console.warn('[SAVE] tail cleanup failed', e);
        }

        // 提取纯文本并去除尾部不可见与空白字符（保留中间换行）
        let rawText = tempDiv.textContent || tempDiv.innerText || '';
        // 移除零宽字符与 BOM，并删除末尾空白/换行
        rawText = rawText.replace(/[\u200B\uFEFF]/g, '').replace(/[\s\u00A0]+$/g, '').replace(/[\r\n]+$/g, '');
        content = rawText;
        console.log('[SAVE] final plain len=' + ((content || '').length));

        // 如果 contentHtml 只是包了一层 div（内部无嵌套 div），就去掉这层包裹，避免卡片渲染块级 div 造成首行空行
        if (contentHtml && /^<div>((?:(?!<div\b)[\s\S])*)<\/div>$/i.test(contentHtml)) {
            const inner = RegExp.$1;
            console.log('[SAVE] unwrap div: inner_len=' + inner.length + ' head40="' + inner.slice(0, 40) + '"');
            contentHtml = inner;
        }
    } else {
        content = contentEl.value.trim();
        contentHtml = null;
    }
    
    let categoryId = parseInt(getCustomSelectValue('phraseCategory'));
    const tags = document.getElementById('phraseTags').value.trim();
    const enablePlaceholder = document.getElementById('enablePlaceholder').checked;
    const enableImages = document.getElementById('enableImages').checked;
    const disableClickCopy = document.getElementById('disableClickCopy').checked;
    const enableDescription = document.getElementById('enableDescription').checked;
    const enableVariants = document.getElementById('enableVariants').checked;
    const actAsTitle = document.getElementById('actAsTitle').checked;
    const actTitleTextEditor = document.getElementById('actTitleTextEditor').checked;
    // 作为标题：独立字段 act_as_title，与 disableClickCopy/enableVariants 互斥不联动，各自独立存
    if (window.__actAsTitleHelpers && currentEditingPhraseId) {
        window.__actAsTitleHelpers.set(currentEditingPhraseId, actAsTitle);
    }
    if (window.__actTitleTextEditorHelpers && currentEditingPhraseId) {
        window.__actTitleTextEditorHelpers.set(currentEditingPhraseId, actAsTitle && actTitleTextEditor);
    }

    const tagPrefix = document.getElementById('tagPrefix').checked;
    const jumpCategoryRaw = getCustomSelectValue('phraseJumpCategory');
    const jumpCategoryId = jumpCategoryRaw === '' ? 0 : parseInt(jumpCategoryRaw); // 0 = 清除跳转

    console.log('🔍 [调试] 保存话术 - categoryId:', categoryId);
    console.log('🔍 [调试] 保存话术 - currentSelectedCategoryId:', currentSelectedCategoryId);
    console.log('🔍 [调试] 保存话术 - enableImages:', enableImages);
    
    // 获取样式数据（整体样式）
    const textColorEl = document.getElementById('phraseTextColor');
    const bgColorEl = document.getElementById('phraseBgColor');
    const isBoldEl = document.getElementById('phraseIsBold');
    
    // 检查 contentHtml 中是否包含样式标签（部分文字样式）
    // 如果包含样式标签，说明用户只对部分文字应用了样式，不应该保存整体样式
    let hasPartialStyle = false;
    if (contentHtml) {
        // 检查是否包含带 style 属性的标签（如 <span style="...">）
        const styleTagRegex = /<[^>]+\s+style\s*=/i;
        hasPartialStyle = styleTagRegex.test(contentHtml);
    }
    
    // 如果 contentHtml 中包含部分样式，不保存整体样式；否则保存整体样式
    let textColor = null;
    let bgColor = null;
    let isBold = false;
    
    if (!hasPartialStyle) {
        // 没有部分样式，才保存整体样式
        textColor = textColorEl && textColorEl.value !== '#333333' ? textColorEl.value : null;
        bgColor = bgColorEl && bgColorEl.value !== '#ffffff' ? bgColorEl.value : null;
        isBold = isBoldEl ? isBoldEl.checked : false;
    }
    
    console.log('保存数据:', { content, contentHtml, categoryId, tags, enablePlaceholder, enableImages, disableClickCopy, textColor, bgColor, isBold, hasPartialStyle, editingId: currentEditingPhraseId });
    
    if (!content) {
        showToast('❌ 请输入话术内容', 'error');
        console.warn('内容为空，取消保存');
        return;
    }
    
    // 获取说明内容（如果启用了说明功能，需要从当前话术获取）
    let description = '';
    if (enableDescription && currentEditingPhraseId) {
        // 编辑模式：从数据库获取现有说明
        const phrases = await db.searchPhrases();
        const existingPhrase = phrases.find(p => p.id === currentEditingPhraseId);
        if (existingPhrase) {
            description = existingPhrase.description || '';
        }
    }
    
    try {
        // 🔧 保存标记，因为closePhraseDialog会清除它
        const wasRestoring = window._isRestoringPhrase;
        
        if (currentEditingPhraseId) {
            console.log('更新话术 ID:', currentEditingPhraseId);

            // 子话术模式下：分类选择隐藏，强制使用父话术分类，避免误写回收站/未分类
            if (__childPhraseParentId && typeof __childPhraseParentCategoryId === 'number' && !Number.isNaN(__childPhraseParentCategoryId)) {
                categoryId = __childPhraseParentCategoryId;
            }
            
            // 🔧 如果是从回收站恢复的话术，保存时需要同时恢复它
            if (wasRestoring) {
                await db.updatePhrase(currentEditingPhraseId, content, categoryId, tags, enablePlaceholder, enableImages, textColor, bgColor, isBold, contentHtml, disableClickCopy, enableDescription, description, enableVariants, jumpCategoryId, tagPrefix);
                // 恢复话术（设置 is_deleted = false）
                await db.restorePhrase(currentEditingPhraseId);
                showToast('✅ 话术已恢复并更新');
            } else {
                await db.updatePhrase(currentEditingPhraseId, content, categoryId, tags, enablePlaceholder, enableImages, textColor, bgColor, isBold, contentHtml, disableClickCopy, enableDescription, description, enableVariants, jumpCategoryId, tagPrefix);
                showToast('✅ 话术已更新');
            }
        } else {
            console.log('添加新话术');

            if (__childPhraseParentId && db && typeof db.addChildPhrase === 'function') {
                if (typeof __childPhraseParentCategoryId === 'number' && !Number.isNaN(__childPhraseParentCategoryId)) {
                    categoryId = __childPhraseParentCategoryId;
                }
                await db.addChildPhrase(__childPhraseParentId, content, categoryId, tags, enablePlaceholder, enableImages, textColor, bgColor, isBold, contentHtml, disableClickCopy, enableDescription, description, false, jumpCategoryId);
                showToast('✅ 子话术已添加');
            } else {
                const _newPhraseId = await db.addPhrase(content, categoryId, tags, enablePlaceholder, enableImages, textColor, bgColor, isBold, contentHtml, disableClickCopy, enableDescription, description, enableVariants, jumpCategoryId, tagPrefix);
                if (actAsTitle && _newPhraseId && window.__actAsTitleHelpers) {
                    window.__actAsTitleHelpers.set(_newPhraseId, true);
                }
                if (actAsTitle && actTitleTextEditor && _newPhraseId && window.__actTitleTextEditorHelpers) {
                    window.__actTitleTextEditorHelpers.set(_newPhraseId, true);
                }
                showToast('✅ 话术已添加');
            }
        }
        
        console.log('✅ 话术保存成功');
        console.log('🔍 [调试] 保存成功 - categoryId:', categoryId);
        console.log('🔍 [调试] 保存成功 - currentSelectedCategoryId:', currentSelectedCategoryId);
        console.log('🔍 [调试] 保存成功 - content:', content.substring(0, 50));
        _orphanPhraseCount = -1;

        // closePhraseDialog 会清理 __childPhraseParentId，所以提前保存一份
        const justSavedChildParentId = __childPhraseParentId;
        closePhraseDialog();

        // 子话术保存：只刷新容器（保持父卡展开状态）；否则走原逻辑刷新列表
        if (justSavedChildParentId) {
            await refreshMoreChildren(justSavedChildParentId);
        } else {
            await loadPhrases();
        }
        // 🔧 如果是从回收站恢复的，也需要刷新回收站列表
        if (wasRestoring) {
            await loadRecycleBin();
        }
    } catch (error) {
        console.error('保存话术失败:', error);
        showToast('❌ 保存失败', 'error');
    }
}

// 将RGB颜色值转换为十六进制
function rgbToHex(rgb) {
    if (!rgb) return null;
    if (rgb.startsWith('#')) return rgb;
    const match = rgb.match(/\d+/g);
    if (match && match.length >= 3) {
        const r = parseInt(match[0]).toString(16).padStart(2, '0');
        const g = parseInt(match[1]).toString(16).padStart(2, '0');
        const b = parseInt(match[2]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    }
    return null;
}

// 根据选中文字的实际样式更新样式控件状态
function updateStyleControlsFromSelection() {
    const contentEl = document.getElementById('phraseContent');
    if (!contentEl || contentEl.contentEditable !== 'true') {
        return;
    }
    
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        // 没有选中，重置为默认值
        const textColorEl = document.getElementById('phraseTextColor');
        const bgColorEl = document.getElementById('phraseBgColor');
        const isBoldEl = document.getElementById('phraseIsBold');
        if (textColorEl) textColorEl.value = '#333333';
        if (bgColorEl) bgColorEl.value = '#ffffff';
        if (isBoldEl) isBoldEl.checked = false;
        return;
    }
    
    const range = selection.getRangeAt(0);
    if (range.collapsed || !contentEl.contains(range.commonAncestorContainer)) {
        // 如果没有选中内容，重置为默认值
        const textColorEl = document.getElementById('phraseTextColor');
        const bgColorEl = document.getElementById('phraseBgColor');
        const isBoldEl = document.getElementById('phraseIsBold');
        
        if (textColorEl) textColorEl.value = '#333333';
        if (bgColorEl) bgColorEl.value = '#ffffff';
        if (isBoldEl) isBoldEl.checked = false;
        return;
    }
    
    // 获取选中范围的容器节点
    const container = range.commonAncestorContainer;
    let element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    
    // 用于存储找到的样式
    let foundBold = false;
    let foundTextColor = null;
    let foundBgColor = null;
    
    // 向上查找包含样式的元素（从最接近选中文字的元素开始）
    while (element && element !== contentEl) {
        if (element.nodeType === Node.ELEMENT_NODE) {
            const computedStyle = window.getComputedStyle(element);
            
            // 检测加粗（如果还没找到）
            if (!foundBold) {
                const fontWeight = computedStyle.fontWeight;
                const isBold = fontWeight === 'bold' || fontWeight === '700' || 
                              parseInt(fontWeight) >= 700 ||
                              element.style.fontWeight === 'bold';
                if (isBold) {
                    foundBold = true;
                }
            }
            
            // 检测文字颜色（如果还没找到，优先使用内联样式）
            if (!foundTextColor) {
                if (element.style.color) {
                    const hex = rgbToHex(element.style.color);
                    if (hex) {
                        foundTextColor = hex;
                    }
                } else {
                    const color = computedStyle.color;
                    if (color && color !== 'rgb(51, 51, 51)' && color !== '#333333') {
                        const hex = rgbToHex(color);
                        if (hex && hex !== '#333333') {
                            foundTextColor = hex;
                        }
                    }
                }
            }
            
            // 检测背景颜色（如果还没找到，优先使用内联样式）
            if (!foundBgColor) {
                if (element.style.backgroundColor) {
                    const hex = rgbToHex(element.style.backgroundColor);
                    if (hex) {
                        foundBgColor = hex;
                    }
                } else {
                    const bgColor = computedStyle.backgroundColor;
                    if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent' && 
                        bgColor !== 'rgb(255, 255, 255)' && bgColor !== '#ffffff') {
                        const hex = rgbToHex(bgColor);
                        if (hex && hex !== '#ffffff') {
                            foundBgColor = hex;
                        }
                    }
                }
            }
            
            // 如果找到了所有样式，可以提前退出
            if (foundBold && foundTextColor !== null && foundBgColor !== null) {
                break;
            }
        }
        
        element = element.parentElement;
    }
    
    // 更新样式控件
    const textColorEl = document.getElementById('phraseTextColor');
    const bgColorEl = document.getElementById('phraseBgColor');
    const isBoldEl = document.getElementById('phraseIsBold');
    
    if (isBoldEl) {
        isBoldEl.checked = foundBold;
    }
    if (textColorEl) {
        textColorEl.value = foundTextColor || '#333333';
    }
    if (bgColorEl) {
        bgColorEl.value = foundBgColor || '#ffffff';
    }
}

// 清除选中文字的样式
// styleType: 'textColor' | 'bgColor' | 'bold' | 'all'
function clearStyleFromSelection(styleType) {
    const contentEl = document.getElementById('phraseContent');
    if (!contentEl || contentEl.contentEditable !== 'true') {
        return;
    }
    
    // 获取选中范围（优先使用保存的范围，如果没有则使用当前选中）
    let range = null;
    const selection = window.getSelection();
    
    if (savedSelectionRange) {
        try {
            range = savedSelectionRange.cloneRange();
            if (!contentEl.contains(range.commonAncestorContainer)) {
                savedSelectionRange = null;
                return;
            }
        } catch (e) {
            savedSelectionRange = null;
            return;
        }
    } else if (selection && selection.rangeCount > 0) {
        range = selection.getRangeAt(0);
        if (range.collapsed || !contentEl.contains(range.commonAncestorContainer)) {
            return;
        }
    } else {
        return;
    }
    
    if (range.toString().trim() === '') {
        return;
    }
    
    try {
        // 获取选中范围的开始和结束容器
        const startContainer = range.startContainer;
        const endContainer = range.endContainer;
        
        // 向上查找包含样式的元素
        let startElement = startContainer.nodeType === Node.TEXT_NODE ? startContainer.parentElement : startContainer;
        let endElement = endContainer.nodeType === Node.TEXT_NODE ? endContainer.parentElement : endContainer;
        
        // 收集所有需要处理的元素（从开始到结束的所有span元素）
        const allElements = new Set();
        
        // 从开始元素向上查找
        let current = startElement;
        while (current && current !== contentEl) {
            if (current.nodeType === Node.ELEMENT_NODE && range.intersectsNode(current)) {
                allElements.add(current);
            }
            current = current.parentElement;
        }
        
        // 从结束元素向上查找
        current = endElement;
        while (current && current !== contentEl) {
            if (current.nodeType === Node.ELEMENT_NODE && range.intersectsNode(current)) {
                allElements.add(current);
            }
            current = current.parentElement;
        }
        
        // 使用TreeWalker查找选中范围内的所有span元素
        const walker = document.createTreeWalker(
            range.commonAncestorContainer,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    if (node.nodeType === Node.ELEMENT_NODE && 
                        node.tagName === 'SPAN' && 
                        range.intersectsNode(node)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_SKIP;
                }
            }
        );
        
        let node;
        while (node = walker.nextNode()) {
            allElements.add(node);
        }
        
        // 处理所有元素
        const elementsToRemove = [];
        allElements.forEach(el => {
            if (el.tagName === 'SPAN' && el.hasAttribute('style')) {
                // 清除指定的样式
                if (styleType === 'textColor' || styleType === 'all') {
                    el.style.removeProperty('color');
                }
                if (styleType === 'bgColor' || styleType === 'all') {
                    el.style.removeProperty('background-color');
                }
                if (styleType === 'bold' || styleType === 'all') {
                    el.style.removeProperty('font-weight');
                }
                
                // 如果样式为空，移除style属性
                if (!el.style.cssText || el.style.cssText.trim() === '') {
                    el.removeAttribute('style');
                    // 如果span没有其他属性，标记为需要移除
                    if (el.attributes.length === 0) {
                        elementsToRemove.push(el);
                    }
                }
            }
        });
        
        // 移除空的span元素，将其内容提升到父元素
        elementsToRemove.forEach(el => {
            const parent = el.parentNode;
            if (parent) {
                // 将span的所有子节点移到父元素
                while (el.firstChild) {
                    parent.insertBefore(el.firstChild, el);
                }
                parent.removeChild(el);
            }
        });
        
        // 更新控件状态
        updateStyleControlsFromSelection();
        
        // 清除选中状态
        if (selection) {
            selection.removeAllRanges();
        }
        savedSelectionRange = null;
        
        // 重新聚焦
        contentEl.focus();
    } catch (error) {
        console.error('清除样式失败:', error);
    }
}

// 应用样式到选中的文字
// styleType: 'textColor' | 'bgColor' | 'bold' | null (null表示应用所有样式)
function applyStyleToSelection(styleType = null) {
    const contentEl = document.getElementById('phraseContent');
    if (!contentEl || contentEl.contentEditable !== 'true') {
        return; // 如果不是contenteditable，不处理
    }
    
    // 获取选中范围（优先使用保存的范围，如果没有则使用当前选中）
    let range = null;
    const selection = window.getSelection();
    
    if (savedSelectionRange) {
        // 使用保存的范围
        try {
            range = savedSelectionRange.cloneRange();
            // 验证范围是否仍然有效
            if (!contentEl.contains(range.commonAncestorContainer)) {
                savedSelectionRange = null;
                return;
            }
        } catch (e) {
            savedSelectionRange = null;
            return;
        }
    } else if (selection && selection.rangeCount > 0) {
        // 使用当前选中的范围
        range = selection.getRangeAt(0);
        if (range.collapsed || !contentEl.contains(range.commonAncestorContainer)) {
            return; // 没有选中内容或不在编辑框内
        }
    } else {
        return; // 没有选中文字
    }
    
    // 检查选中内容是否为空
    if (range.toString().trim() === '') {
        return;
    }
    
    // 获取样式值
    const textColorEl = document.getElementById('phraseTextColor');
    const bgColorEl = document.getElementById('phraseBgColor');
    const isBoldEl = document.getElementById('phraseIsBold');
    
    // 根据styleType决定应用哪些样式
    let textColor = null;
    let bgColor = null;
    let isBold = false;
    
    if (styleType === 'textColor') {
        // 只应用文字颜色
        textColor = textColorEl && textColorEl.value !== '#333333' ? textColorEl.value : null;
    } else if (styleType === 'bgColor') {
        // 只应用背景颜色
        bgColor = bgColorEl && bgColorEl.value !== '#ffffff' ? bgColorEl.value : null;
    } else if (styleType === 'bold') {
        // 只应用加粗
        isBold = isBoldEl ? isBoldEl.checked : false;
        // 如果取消加粗，清除加粗样式
        if (!isBold) {
            clearStyleFromSelection('bold');
            return;
        }
    } else {
        // 应用所有样式（兼容旧代码）
        textColor = textColorEl && textColorEl.value !== '#333333' ? textColorEl.value : null;
        bgColor = bgColorEl && bgColorEl.value !== '#ffffff' ? bgColorEl.value : null;
        isBold = isBoldEl ? isBoldEl.checked : false;
    }
    
    // 如果没有样式需要应用，不处理
    if (!textColor && !bgColor && !isBold) {
        return;
    }
    
    try {
        // 创建span元素包裹选中文字
        const span = document.createElement('span');
        
        // 构建样式
        const styles = [];
        if (textColor) {
            styles.push(`color: ${textColor}`);
        }
        if (bgColor) {
            styles.push(`background-color: ${bgColor}`);
        }
        if (isBold) {
            styles.push(`font-weight: bold`);
        }
        
        if (styles.length > 0) {
            span.style.cssText = styles.join('; ');
        }
        
        // 包裹选中内容
        try {
            range.surroundContents(span);
        } catch (e) {
            // 如果surroundContents失败（比如选中内容跨越了多个节点），使用另一种方法
            const contents = range.extractContents();
            span.appendChild(contents);
            range.insertNode(span);
        }
        
        // 清除选中状态和保存的范围
        if (selection) {
            selection.removeAllRanges();
        }
        savedSelectionRange = null;
        
        // 将焦点重新设置到编辑框
        contentEl.focus();
    } catch (error) {
        console.error('应用样式失败:', error);
        savedSelectionRange = null;
    }
}

// 编辑话术
async function editPhrase(phraseId) {
    openPhraseDialog(phraseId);
}

// 删除话术（软删除，移到回收站）
async function deletePhrase(phraseId) {
    let childCount = 0;
    try {
        const children = await db.getChildPhrases(phraseId, false);
        childCount = (children || []).length;
    } catch (e) {
        childCount = 0;
    }
    let message = '确定要删除这条话术吗？';
    if (childCount > 0) {
        message += `\n\n⚠️ 该话术下还有 ${childCount} 条子话术。\n删除本话术后，子话术不会一起删除，但会失去归属。\n如需一并清理，请先删除子话术。`;
    }
    const result = await showDeleteConfirmDialog(
        '🗑️ 删除话术',
        message
    );
    
    if (result === 'cancel') return;
    
    try {
        if (result === 'permanent') {
            await db.permanentlyDeletePhrase(phraseId);
            _orphanPhraseCount = -1;
            showToast('✅ 话术已永久删除');
        } else {
            await db.deletePhrase(phraseId);
            _orphanPhraseCount = -1;
            showToast('✅ 话术已移到回收站');
        }
        await loadPhrases();
    } catch (error) {
        console.error('删除话术失败:', error);
        showToast('❌ 删除失败', 'error');
    }
}

// 恢复话术（从回收站恢复）
async function restorePhrase(phraseId) {
    try {
        // 🔧 获取已删除的话术信息
        const deletedPhrases = await db.getDeletedPhrases();
        const phrase = deletedPhrases.find(p => p.id === phraseId);
        
        if (!phrase) {
            showToast('❌ 话术不存在', 'error');
        return;
    }
    
        // 检查原分类是否存在
        const categories = await db.getAllCategories();
        const originalCategory = categories.find(c => getCategoryId(c) === phrase.category_id);
        
        // 如果原分类不存在，先恢复到回收站，然后打开编辑对话框让用户选择分类
        if (!originalCategory || phrase.category_id === 0) {
            const categoryName = phrase.category_name || '未分类';
            
            if (!confirm(`该话术原本属于"${categoryName}"，但该分类已不存在。\n\n点击"确定"后将打开编辑窗口，请选择新的分类。`)) {
                return;
            }
            
            // 🔧 不要先恢复话术，保持 is_deleted = true，等用户保存时再恢复
            // 这样如果用户关闭对话框而不保存，话术仍然在回收站中
            
            // 关闭回收站，打开编辑对话框
            closePhraseDialog(); // 确保没有其他对话框打开
            await openPhraseDialog(phraseId, null, true); // 第三个参数表示这是从回收站恢复的
            
            showToast('💡 请选择新的分类');
            
        } else {
            // 原分类存在，直接恢复
            if (!confirm(`确定要恢复这条话术吗？\n话术将回到"${originalCategory.name}"分类。`)) {
                return;
            }
            
        await db.restorePhrase(phraseId);
        showToast('✅ 话术已恢复');
            await loadRecycleBin();
        }
    } catch (error) {
        console.error('恢复话术失败:', error);
        showToast('❌ 恢复失败', 'error');
    }
}

// 显示简单确认对话框（返回 Promise<boolean>）
function showConfirmDialog(title, message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); z-index: 10000; display: flex; align-items: center; justify-content: center;';
        
        const dialogHtml = `
            <div style="background: white; border-radius: 8px; padding: 20px; min-width: 300px; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #333;">${escapeHtml(title)}</div>
                <div style="color: #666; font-size: 14px; margin-bottom: 20px; line-height: 1.5;">${escapeHtml(message)}</div>
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button id="confirmCancelBtn" style="padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 14px; color: #666;">取消</button>
                    <button id="confirmOkBtn" style="padding: 8px 16px; border: none; background: #dc2626; color: white; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">确认删除</button>
                </div>
            </div>
        `;
        
        overlay.innerHTML = dialogHtml;
        document.body.appendChild(overlay);
        
        const cancelBtn = overlay.querySelector('#confirmCancelBtn');
        const okBtn = overlay.querySelector('#confirmOkBtn');
        
        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        
        cancelBtn.addEventListener('click', () => close(false));
        okBtn.addEventListener('click', () => close(true));
        
        // 点击遮罩层关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                close(false);
            }
        });
        
        // ESC 键关闭
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                close(false);
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);
    });
}

function showDeleteConfirmDialog(title, message, options = {}) {
    // options: { maxWidth: '360px', showPermanentDelete: true }
    const maxWidth = options.maxWidth || '420px';
    const showPermanentDelete = options.showPermanentDelete !== false;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); z-index: 10000000; display: flex; align-items: center; justify-content: center;';

        const dialogHtml = `
            <div style="background: white; border-radius: 8px; padding: 20px; min-width: 280px; max-width: ${maxWidth}; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #333;">${escapeHtml(title)}</div>
                <div style="color: #666; font-size: 14px; margin-bottom: ${showPermanentDelete ? '16px' : '20px'}; line-height: 1.5; white-space: pre-line;">${escapeHtml(message)}</div>
                ${showPermanentDelete ? `
                <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px; padding: 8px 10px; background: #fff5f5; border: 1px solid #fecaca; border-radius: 6px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="permanentDeleteCheck" style="width: 16px; height: 16px; accent-color: #dc2626; cursor: pointer;">
                    <span style="font-size: 13px; color: #991b1b; font-weight: 500;">永久删除（不进入回收站，不可恢复）</span>
                </label>
                ` : ''}
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button id="deleteCancelBtn" style="padding: 8px 16px; border: 1px solid #ddd; background: white; border-radius: 4px; cursor: pointer; font-size: 14px; color: #666;">取消</button>
                    <button id="deleteOkBtn" style="padding: 8px 16px; border: none; background: #dc2626; color: white; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500;">确认删除</button>
                </div>
            </div>
        `;

        overlay.innerHTML = dialogHtml;
        document.body.appendChild(overlay);

        const cancelBtn = overlay.querySelector('#deleteCancelBtn');
        const okBtn = overlay.querySelector('#deleteOkBtn');
        const permCheck = overlay.querySelector('#permanentDeleteCheck');

        const close = (result) => {
            overlay.remove();
            resolve(result);
        };

        cancelBtn.addEventListener('click', () => close('cancel'));
        okBtn.addEventListener('click', () => {
            close(showPermanentDelete && permCheck.checked ? 'permanent' : 'soft');
        });
        
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close('cancel');
        });
        
        const handleEsc = (e) => {
            if (e.key === 'Escape') {
                close('cancel');
                document.removeEventListener('keydown', handleEsc);
            }
        };
        document.addEventListener('keydown', handleEsc);
    });
}

// 永久删除话术
async function deletePermanently(phraseId) {
    try {
        // 获取话术信息用于预览
        const phrase = await db.getPhraseById(phraseId);
        if (!phrase) {
            showToast('❌ 话术不存在', 'error');
        return;
    }
    
        // 显示确认对话框
        const confirmed = await showConfirmDialog(
            '🗑️ 永久删除',
            '确定要永久删除这条话术吗？此操作不可恢复。'
        );
        
        if (!confirmed) {
            return;
        }
        
        // 执行删除
        await db.permanentlyDeletePhrase(phraseId);
        showToast('✅ 话术已永久删除');
        await loadRecycleBin(); // 刷新回收站列表
    } catch (error) {
        console.error('永久删除话术失败:', error);
        showToast('❌ 删除失败: ' + (error.message || '未知错误'), 'error');
    }
}

// 加载分类列表（管理页面）
async function loadCategoryList() {
    const categories = await db.getAllCategories();
    const categoryList = document.getElementById('categoryList');
    
    // 🎯 优化：使用 DocumentFragment 批量添加，减少重排和抖动
    const fragment = document.createDocumentFragment();
    
    // 只有在排序模式激活时才显示拖拽手柄
    const showDragHandle = isCategorySortModeActive;
    
    // 预先缓存每个分类的话术数量，避免重复查询
    
    // 🚀 性能优化：延迟分批渲染配置
    const BATCH_SIZE = 20; // 每批渲染20个分类
    const RENDER_DELAY = 16; // 16ms延迟，约60fps
    let renderBatchIndex = 0;
    
    // 清空现有内容
    categoryList.innerHTML = '';
    
    // 🎯 预加载拖拽浮层模板，避免首次拖拽卡顿
    if (isCategorySortModeActive) {
        preloadDragElements();
    }

    // 按顺序渲染顶级分类，并在其下方追加子分类
    const appendCategoryItem = (category, options = {}) => {
        const {
            isChild = false,
        } = options;
        const item = document.createElement('div');
        item.className = 'category-item' + (isChild ? ' category-item-child' : '');
        item.dataset.id = category.id;
        
        if (showDragHandle) {
            item.draggable = true;
            item.addEventListener('dragstart', handleCategoryDragStart);
            item.addEventListener('dragover', handleCategoryDragOver);
            item.addEventListener('drop', handleCategoryDrop);
            item.addEventListener('dragend', handleCategoryDragEnd);
        }
        
        const branch = isChild
            ? '<span class="category-branch-symbol">↳</span>'
            : '';

        item.innerHTML = `
            ${showDragHandle ? '<span class="drag-handle">☰</span>' : ''}
            ${branch}
            <div class="category-item-main">
                <span class="category-name">${category.name}</span>
                
            </div>
            <div class="category-actions">
                <button class="category-action-btn edit-category-btn" data-id="${category.id}" data-name="${category.name}">编辑</button>
                <button class="category-action-btn delete-category-btn" data-id="${category.id}">删除</button>
            </div>
        `;
        fragment.appendChild(item);
    };

    const topLevelCategories = categories.filter(cat => {
        if (isRecycleCategory(cat)) return false;
        return getCategoryParentId(cat) === 0;
    });

    topLevelCategories.forEach(parentCategory => {
        appendCategoryItem(parentCategory);

        const children = categories.filter(cat => {
            if (isRecycleCategory(cat)) return false;
            return getCategoryParentId(cat) === getCategoryId(parentCategory);
        });

        children.forEach((child) => {
            appendCategoryItem(child, { isChild: true });
        });
    });

    // 如果有缺失父级或孤立的子分类，也进行兜底展示
    const orphanCategories = [];
    categories.forEach(category => {
        if (isRecycleCategory(category)) return;
        if (getCategoryParentId(category) === 0) return;

        const alreadyRendered = fragment.querySelector(`.category-item[data-id="${category.id}"]`);
        if (!alreadyRendered) {
            orphanCategories.push(category);
            appendCategoryItem(category, { isChild: true });
        }
    });
    
    if (orphanCategories.length > 0) {
        console.warn('[分类列表] ⚠️ 发现孤立分类（缺失父级）:', orphanCategories.map(c => `${c.name} (ID: ${c.id}, parent_id: ${c.parent_id})`));
    }
    
    // 🚀 性能优化：分批渲染函数
    const renderBatch = () => {
        const items = Array.from(fragment.children);
        const startIndex = renderBatchIndex * BATCH_SIZE;
        const endIndex = Math.min(startIndex + BATCH_SIZE, items.length);

        if (startIndex >= items.length) {
            return; // 渲染完成
        }

        // 批量添加当前批次的元素
        const batchFragment = document.createDocumentFragment();
        for (let i = startIndex; i < endIndex; i++) {
            batchFragment.appendChild(items[i]);
        }

        categoryList.appendChild(batchFragment);

        renderBatchIndex++;

        // 继续下一批渲染
        setTimeout(renderBatch, RENDER_DELAY);
    };

    // 🚀 开始分批渲染
    renderBatch();
    
    // 🚀 性能优化：闲置时静默预渲染剩余节点
    if (isCategorySortModeActive) {
        scheduleIdleRendering();
    }
}

// 🚀 闲置时静默预渲染剩余节点，不阻塞主线程
function scheduleIdleRendering() {
    if (!window.requestIdleCallback) {
        console.log('[分类列表] ⚠️ 浏览器不支持 requestIdleCallback');
        return;
    }
    
    console.log('[分类列表] 🚀 启动闲置预渲染');
    
    const deadline = {
        timeRemaining: () => 50 // 模拟50ms剩余时间
    };
    
    const renderIdleCategories = (deadline) => {
        while (deadline.timeRemaining() > 10) {
            // 预渲染一些虚拟DOM节点，但不实际插入
            const virtualFragment = document.createDocumentFragment();
            for (let i = 0; i < 5; i++) {
                const dummyItem = document.createElement('div');
                dummyItem.className = 'category-item dummy';
                dummyItem.style.cssText = 'display: none;';
                virtualFragment.appendChild(dummyItem);
            }
            
            // 预热渲染引擎
            void virtualFragment.children.length;
            
            if (Math.random() > 0.7) break; // 随机退出，避免长时间占用
        }
        
        // 如果还有时间，继续预渲染
        if (deadline.timeRemaining() > 5) {
            requestIdleCallback(renderIdleCategories);
        } else {
            console.log('[分类列表] ✅ 闲置预渲染完成');
        }
    };
    
    requestIdleCallback(renderIdleCategories);
}

// 打开分类对话框
async function openCategoryDialog(categoryId = null, categoryName = '', presetParentId = null) {
    currentEditingCategoryId = categoryId;
    const dialog = document.getElementById('categoryDialog');
    const nameInput = document.getElementById('categoryName');
    const parentSelect = document.getElementById('categoryParent');
    const titleEl = document.getElementById('categoryDialogTitle');
    const showTextEditorCheckbox = document.getElementById('categoryShowTextEditor');
    const isEditMode = Boolean(categoryId);

    if (!dialog) {
        console.error('❌ 分类对话框元素不存在');
        return;
    }

    dialog.dataset.mode = isEditMode ? 'edit' : 'create';

    if (nameInput) {
    nameInput.value = categoryName;
        nameInput.placeholder = isEditMode ? '请输入新的分类名称...' : '请输入分类名称...';
    }

    if (titleEl) {
        titleEl.textContent = isEditMode ? '编辑分类' : '添加分类';
    }

    try {
        if (isEditMode && categoryId) {
            const category = await db.getCategory(categoryId);
            if (showTextEditorCheckbox) {
                showTextEditorCheckbox.checked = category && category.show_text_editor === true;
            }
        } else {
            if (showTextEditorCheckbox) {
                showTextEditorCheckbox.checked = false;
            }
        }
    } catch (error) {
        console.error('❌ 加载分类数据失败:', error);
        if (showTextEditorCheckbox) {
            showTextEditorCheckbox.checked = false;
        }
    }

    // 始终显示父级分类选择（编辑模式下也可选择父级，实现分类移动）
    const parentGroup = document.getElementById('categoryParentGroup');
    if (parentGroup) {
        parentGroup.style.display = 'block';
    }

    const ensureCacheReady = async () => {
        if (Array.isArray(allCategoriesCache) && allCategoriesCache.length > 0) {
            return;
        }
        try {
            allCategoriesCache = await db.getAllCategories();
        } catch (error) {
            console.error('❌ 加载分类数据失败:', error);
            allCategoriesCache = [];
        }
    };

    const toNumberOrNull = (value) => {
        if (value === undefined || value === null || value === '') return null;
        const num = Number(value);
        return Number.isNaN(num) ? null : num;
    };

    try {
        await ensureCacheReady();

        const topLevelCategories = (allCategoriesCache || []).filter(cat => {
            if (isRecycleCategory(cat)) return false;
            // 编辑模式下排除自身（不能选自己作为父级）
            if (isEditMode && getCategoryId(cat) === categoryId) return false;
            return getCategoryParentId(cat) === 0;
        });

    if (parentSelect) {
        // 更新自定义下拉框
        const dropdown = parentSelect.querySelector('.custom-select-dropdown');
        if (dropdown) {
            dropdown.innerHTML = '';

            // 添加"顶级分类"选项
            const defaultLi = document.createElement('li');
            defaultLi.className = 'custom-select-option';
            defaultLi.dataset.value = '0';
            defaultLi.textContent = '（无）顶级分类';
            defaultLi.setAttribute('role', 'option');
            dropdown.appendChild(defaultLi);

            // 添加一级分类选项
            topLevelCategories.forEach(cat => {
                const li = document.createElement('li');
                li.className = 'custom-select-option';
                li.dataset.value = getCategoryId(cat);
                li.textContent = cat.name;
                li.setAttribute('role', 'option');
                dropdown.appendChild(li);
            });

            // 初始化自定义下拉框事件
            initCustomSelect('categoryParent');
        }

        const ensureValidSelection = (candidateId) => {
            const normalized = toNumberOrNull(candidateId);
            if (normalized === null) return false;
            const option = parentSelect.querySelector(`.custom-select-option[data-value="${String(normalized)}"]`);
            if (option) {
                setCustomSelectValue('categoryParent', String(normalized));
                return true;
            }
            return false;
        };

            let appliedParent = null;
        if (categoryId) {
                const cat = (allCategoriesCache || []).find(c => getCategoryId(c) === categoryId);
                if (cat && ensureValidSelection(getCategoryParentId(cat) || 0)) {
                    appliedParent = getCategoryParentId(cat) || 0;
                }
        } else {
                const candidates = [];

                if (presetParentId !== null && presetParentId !== undefined) {
                    candidates.push(presetParentId);
                }

                // 当前选中分类优先于上次缓存：内容区入口跟随当前分类，切换分类后立即生效
                if (currentSelectedCategoryId) {
                    const selectedCat = (allCategoriesCache || []).find(
                        c => String(getCategoryId(c)) === String(currentSelectedCategoryId)
                    );
                    if (selectedCat && !isRecycleCategory(selectedCat)) {
                        const selectedParentId = getCategoryParentId(selectedCat);
                        if (selectedParentId === 0) {
                            candidates.push(getCategoryId(selectedCat));
                        } else {
                            candidates.push(selectedParentId);
                        }
                    } else {
                        candidates.push(currentSelectedCategoryId);
                    }
                }

                if (lastCategoryDialogParentId !== null && lastCategoryDialogParentId !== undefined) {
                    candidates.push(lastCategoryDialogParentId);
                }

                candidates.push(0); // 兜底顶级分类

                for (const candidate of candidates) {
                    if (ensureValidSelection(candidate)) {
                        appliedParent = toNumberOrNull(candidate);
                        break;
                    }
                }

                if (appliedParent === null) {
                    setCustomSelectValue('categoryParent', '0');
                    appliedParent = 0;
                }
            }

            // 初始化自定义下拉框事件（如果还没有初始化）
            initCustomSelect('categoryParent');

            lastCategoryDialogParentId = normalizeNumeric(
                appliedParent !== null ? appliedParent : getCustomSelectValue('categoryParent'),
                0
            );
        }
    } catch (error) {
        console.error('❌ 打开分类对话框失败:', error);
    }

    dialog.style.display = 'flex';

    if (nameInput) {
        requestAnimationFrame(() => {
            nameInput.focus();
            if (!categoryName) {
                nameInput.select();
            } else {
                const length = nameInput.value.length;
                nameInput.setSelectionRange(length, length);
            }
        });
    }
}

// 关闭分类对话框
function closeCategoryDialog() {
    document.getElementById('categoryDialog').style.display = 'none';
    currentEditingCategoryId = null;
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
}

// 保存分类
async function saveCategoryDialog() {
    try {
        const name = document.getElementById('categoryName').value.trim();
        const parentId = parseInt(getCustomSelectValue('categoryParent') || '0');
        const showTextEditorCheckbox = document.getElementById('categoryShowTextEditor');
        const showTextEditor = showTextEditorCheckbox ? showTextEditorCheckbox.checked : false;

        if (!name) {
            showToast('❌ 请输入分类名称', 'error');
            return;
        }

        const normalizedName = normalizeCategoryName(name);

        if (currentEditingCategoryId) {
            // 编辑模式：更新分类名称、父级分类和 show_text_editor 状态
            await db.updateCategory(currentEditingCategoryId, name, parentId, showTextEditor, null, false, null);
            showToast('✅ 分类已更新');
        } else {
            // 添加模式：需要验证父级分类
            const parentCategory = (allCategoriesCache || []).find(cat => getCategoryId(cat) === parentId);

            if (parentId === 1) {
                showToast('❌ 不能选择"话术回收"作为父级', 'error');
                return;
            }

            // 允许添加一级分类（parentId=0）或二级分类（parentId>0）
            if (parentCategory || parentId === 0) {
                const newCategoryId = await db.addCategory(name, parentId, null, showTextEditor, false, false, null);
                console.log(`[保存分类] ✅ 分类已添加: ${name} (ID: ${newCategoryId}, parent_id: ${parentId})`);
                showToast('✅ 分类已添加');
            } else {
                showToast('❌ 父级分类不存在', 'error');
                return;
            }
        }

        lastCategoryDialogParentId = parentId;

        const isEditMode = !!currentEditingCategoryId;
        const editingId = currentEditingCategoryId;

        closeCategoryDialog();

        const previousSelectedCategoryId = currentSelectedCategoryId;
        allCategoriesCache = await db.getAllCategories();

        if (isEditMode) {
            updateCategoryNameInUI(editingId, name);
            // 刷新分类导航，更新文本编辑按钮等UI元素
            await loadCategories();

            // 分类移动后，导航到被移动的分类本身并刷新平铺区域
            const targetCategoryId = String(editingId);
            const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
            if (currentTab) {
                currentTab.selectedCategory = targetCategoryId;
                currentTab.searchText = '';
                currentSelectedCategoryId = targetCategoryId;
                saveCustomerTabs();
            }
            await loadCategories();
            await loadPhrases(true);
        } else {
            if (previousSelectedCategoryId) {
                currentSelectedCategoryId = previousSelectedCategoryId;
            }
            // 只更新分类缓存，不重新渲染分类导航（除非在管理页面）
            allCategoriesCache = await db.getAllCategories();
            // 只有在管理页面打开时才需要加载分类列表，避免不必要的性能开销
            const categoryDialog = document.getElementById('categoryDialog');
            if (categoryDialog && categoryDialog.style.display !== 'none') {
                await loadCategories();
                await loadCategoryList();
            }
        }

        if (!isEditMode) {
            if (parentId !== 0) {
                // 添加二级分类后，切换到新分类
                console.log('🔄 刷新平铺二级分类区域，父分类ID:', parentId, '类型:', typeof parentId);
                const newSubCat = allCategoriesCache.find(c => {
                    const nameMatch = c.name === name;
                    const parentMatch = String(c.parent_id) === String(parentId);
                    if (nameMatch) console.log('[DEBUG] 找到同名分类:', c.name, 'parent_id:', c.parent_id, '类型:', typeof c.parent_id, 'parentId:', parentId, 'parentMatch:', parentMatch);
                    return nameMatch && parentMatch;
                });
                if (newSubCat) {
                    const newSubCategoryId = String(getCategoryId(newSubCat));

                    await saveCurrentTabState();

                    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
                    if (currentTab && !currentTab.isPinPinned) {
                        // 当前标签页未钉住 → 覆盖当前标签页
                        currentTab.selectedCategory = newSubCategoryId;
                        currentTab.categoryName = name;
                        currentTab.searchText = '';
                        currentTab.scrollPosition = 0;
                        currentSelectedCategoryId = newSubCategoryId;

                        saveCustomerTabs();
                        renderCustomerTabs();
                        updatePrimaryCategoryTilesActiveState();
                        await loadPhrases();

                        console.log('✅ 覆盖当前标签页，切换到二级分类:', name);
                    } else {
                        // 当前标签页钉住了 → 新建标签页
                        const newTab = {
                            id: nextCustomerTabId++,
                            name: '标签页',
                            searchText: '',
                            selectedCategory: newSubCategoryId,
                            categoryName: name,
                            scrollPosition: 0,
                            isPinPinned: false
                        };
                        customerTabs.push(newTab);
                        activeCustomerTabId = newTab.id;
                        currentSelectedCategoryId = newSubCategoryId;

                        saveCustomerTabs();
                        renderCustomerTabs();
                        updatePrimaryCategoryTilesActiveState();
                        await loadPhrases();

                        console.log('✅ 钉住状态，新建标签页并切换到二级分类:', name);
                    }
                } else {
                    await loadPhrases(true);
                }
            } else {
                // 添加一级分类后，刷新分类导航栏
                console.log('🔄 刷新一级分类导航栏');
                await loadCategories();

                const newCat = allCategoriesCache.find(c => c.name === name && c.parent_id === 0);
                if (newCat) {
                    const newCategoryId = String(getCategoryId(newCat));

                    // 保存当前标签页状态
                    await saveCurrentTabState();

                    const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
                    if (currentTab && !currentTab.isPinPinned) {
                        // 当前标签页未钉住 → 覆盖当前标签页
                        currentTab.selectedCategory = newCategoryId;
                        currentTab.categoryName = name;
                        currentTab.searchText = '';
                        currentTab.scrollPosition = 0;
                        currentSelectedCategoryId = newCategoryId;

                        saveCustomerTabs();
                        renderCustomerTabs();
                        updatePrimaryCategoryTilesActiveState();
                        await loadPhrases();

                        console.log('✅ 覆盖当前标签页，切换到分类:', name);
                    } else {
                        // 当前标签页钉住了 → 新建标签页
                        const newTab = {
                            id: nextCustomerTabId++,
                            name: '标签页',
                            searchText: '',
                            selectedCategory: newCategoryId,
                            categoryName: name,
                            scrollPosition: 0,
                            isPinPinned: false
                        };
                        customerTabs.push(newTab);
                        activeCustomerTabId = newTab.id;
                        currentSelectedCategoryId = newCategoryId;

                        saveCustomerTabs();
                        renderCustomerTabs();
                        updatePrimaryCategoryTilesActiveState();
                        await loadPhrases();

                        console.log('✅ 钉住状态，新建标签页并切换到分类:', name);
                    }
                }
            }
        }
    } catch (error) {
        console.error('保存分类失败:', error);
        if (error.message.includes('unique')) {
            showToast('❌ 分类名称已存在', 'error');
        } else {
            showToast('❌ 保存失败', 'error');
        }
    }
}

// 编辑分类
async function editCategory(categoryId, categoryName) {
    return openCategoryDialog(categoryId, categoryName);
}

// 🗑️ 永久删除某个分类下的所有话术
async function permanentlyDeleteCategoryPhrases(categoryId) {
    try {
        // 获取该分类下的所有话术（包括已删除的）
        const allPhrases = await db.searchPhrases('', '');
        const phrasesToDelete = allPhrases.filter(p => p.category_id === categoryId);
        
        let deletedCount = 0;
        for (const phrase of phrasesToDelete) {
            try {
                await db.permanentlyDeletePhrase(phrase.id);
                deletedCount++;
            } catch (error) {
                console.error(`删除话术失败 (ID: ${phrase.id}):`, error);
            }
        }
        
        return deletedCount;
    } catch (error) {
        console.error('删除分类话术失败:', error);
        return 0;
    }
}

// 删除分类（级联删除所有子分类和话术）
async function deleteCategory(categoryId) {
    // 🔥 检查该分类下是否有话术
    const phraseCount = await db.getCategoryPhraseCount(categoryId);
    
    // 🔍 检查该分类下是否有二级分类（如果是一级分类）
    const categories = allCategoriesCache || await db.getAllCategories();
    const categoryToDelete = categories.find(c => getCategoryId(c) === categoryId);
    const childCategories = categories.filter(c => getCategoryParentId(c) === categoryId);
    
    if (!categoryToDelete) {
        showToast('❌ 分类不存在', 'error');
        return;
    }
    
    // 构建确认消息
    let confirmMessage = '';
    let totalPhrasesToDelete = phraseCount;

    // 如果是一级分类，且有二级分类，提示将级联删除
    if (childCategories.length > 0) {
        const childNames = childCategories.map(c => `"${c.name}"`).join('、');
        confirmMessage = `⚠️ 级联删除警告！\n\n`;
        confirmMessage += `该一级分类下有 ${childCategories.length} 个二级分类：\n${childNames}\n\n`;

        // 统计二级分类下的话术总数
        let totalChildPhrases = 0;
        for (const child of childCategories) {
            const count = await db.getCategoryPhraseCount(getCategoryId(child));
            totalChildPhrases += count;
        }
        totalPhrasesToDelete += totalChildPhrases;

        confirmMessage += `📊 删除统计：\n`;
        confirmMessage += `• 将删除 ${childCategories.length + 1} 个分类（1个一级 + ${childCategories.length}个二级）\n`;
        confirmMessage += `• 将永久删除 ${totalPhrasesToDelete} 条话术（一级${phraseCount}条 + 二级${totalChildPhrases}条）\n\n`;
        confirmMessage += `🔥 注意：这是永久删除，无法恢复！`;
    } else {
        // 二级分类或没有子分类的一级分类
        const categoryType = getCategoryParentId(categoryToDelete) === 0 ? '一级分类' : '二级分类';
        confirmMessage = `⚠️ 删除${categoryType}警告！\n\n`;
        confirmMessage += `分类名称："${categoryToDelete.name}"\n`;
        if (phraseCount > 0) {
            confirmMessage += `该分类下有 ${phraseCount} 条话术\n\n`;
            confirmMessage += `🔥 注意：分类和话术将被永久删除，无法恢复！`;
        } else {
            confirmMessage += `该分类下没有话术`;
        }
    }

    const result = await showDeleteConfirmDialog('🗑️ 删除分类', confirmMessage, { maxWidth: '340px', showPermanentDelete: false });
    if (result === 'cancel') {
        console.log('❌ 用户取消删除');
        return;
    }
    
    try {
        let totalDeletedPhrases = 0;
        
        // 如果是一级分类，先删除其下所有二级分类及话术
        if (childCategories.length > 0) {
            for (const child of childCategories) {
                // 先删除二级分类下的所有话术
                const childPhraseCount = await permanentlyDeleteCategoryPhrases(getCategoryId(child));
                totalDeletedPhrases += childPhraseCount;
                console.log(`🗑️ 已删除二级分类 "${child.name}" 的 ${childPhraseCount} 条话术`);
                
                // 再删除二级分类
                await db.deleteCategory(getCategoryId(child));
                console.log(`🗑️ 已删除二级分类: "${child.name}" (ID: ${getCategoryId(child)})`);
            }
        }
        
        // 删除该分类下的所有话术
        const categoryPhraseCount = await permanentlyDeleteCategoryPhrases(categoryId);
        totalDeletedPhrases += categoryPhraseCount;
        console.log(`🗑️ 已删除分类 "${categoryToDelete.name}" 的 ${categoryPhraseCount} 条话术`);
        
        // 最后删除该分类本身
        await db.deleteCategory(categoryId);
        console.log(`🗑️ 已删除分类: "${categoryToDelete.name}" (ID: ${categoryId})`);
        
        const deletedCategoryCount = childCategories.length + 1;
        showToast(`✅ 已删除 ${deletedCategoryCount} 个分类，永久删除 ${totalDeletedPhrases} 条话术`);
        
        // 检查是否需要刷新平铺区域
        let shouldRefreshTabs = false;
        
        // 如果删除的是当前选中的分类，切换到其父级分类
        // 判断删除的是一级分类还是二级分类
        const parentId = getCategoryParentId(categoryToDelete);

        if (parentId !== 0) {
            // 删除的是二级分类：切换到父级分类
            console.log('🔄 删除的是二级分类，切换到父级:', parentId);

            // 更新当前标签页的 selectedCategory 为父级
            const currentTab = customerTabs.find(tab => tab.id === activeCustomerTabId);
            if (currentTab) {
                currentTab.selectedCategory = String(parentId);
                // 获取父级分类名称
                const parentCategory = categories.find(c => getCategoryId(c) === parentId);
                if (parentCategory) {
                    currentTab.categoryName = parentCategory.name;
                }
                currentSelectedCategoryId = String(parentId);

                // 🆕 检查父级分类是否还有剩余的二级分类，如果有且父级没有话术，则自动选中第一个
                const remainingChildren = allCategoriesCache.filter(c => getCategoryParentId(c) === parentId);
                if (remainingChildren.length > 0) {
                    const parentPhrases = await db.searchPhrases('', parentId, false, false);
                    const directPhrases = (parentPhrases || []).filter(p => p.parent_id === null || p.parent_id === undefined);
                    if (directPhrases.length === 0) {
                        // 父级没有话术，自动选中第一个二级分类
                        const firstChild = remainingChildren[0];
                        console.log('📂 父级无话术，自动选中第一个二级分类:', firstChild.name);
                        currentTab.selectedCategory = String(getCategoryId(firstChild));
                        currentTab.categoryName = firstChild.name;
                        currentSelectedCategoryId = String(getCategoryId(firstChild));
                    }
                }
            }

            // 保存并刷新
            saveCustomerTabs();
            renderCustomerTabs();

        } else {
            // 删除的是一级分类：删除对应的标签页
            const deletedTabIndex = customerTabs.findIndex(tab =>
                String(tab.selectedCategory) === String(categoryId)
            );

            if (deletedTabIndex !== -1) {
                const deletedTab = customerTabs[deletedTabIndex];
                console.log('🗑️ 删除对应的标签页:', deletedTab.id, deletedTab.categoryName || deletedTab.name);

                // 删除标签页
                customerTabs.splice(deletedTabIndex, 1);

                // 如果删除的是当前激活的标签页，切换到相邻标签页
                if (deletedTab.id === activeCustomerTabId) {
                    if (customerTabs.length > 0) {
                        const newActiveTab = customerTabs[Math.max(0, deletedTabIndex - 1)];
                        activeCustomerTabId = newActiveTab.id;
                        currentSelectedCategoryId = newActiveTab.selectedCategory || '';
                        console.log('🔄 切换到相邻标签页:', newActiveTab.id);
                    } else {
                        // 没有标签页了，创建一个默认的
                        customerTabs = [{
                            id: 1,
                            name: '标签页',
                            searchText: '',
                            selectedCategory: '',
                            categoryName: '',
                            scrollPosition: 0,
                            isPinPinned: false
                        }];
                        activeCustomerTabId = 1;
                        currentSelectedCategoryId = '';
                        nextCustomerTabId = 2;
                    }
                }

                // 保存并刷新
                saveCustomerTabs();
                renderCustomerTabs();
            }
        }

        await loadCategories();

        // 只有在设置对话框打开时才刷新分类列表
        const categoryDialog = document.getElementById('categoryDialog');
        if (categoryDialog && categoryDialog.style.display !== 'none') {
            await loadCategoryList();
        }

        // 加载当前选中分类的话术
        await loadPhrases(true);
    } catch (error) {
        console.error('删除分类失败:', error);
        showToast('❌ 删除失败', 'error');
    }
}

// 🧹 分析孤儿分类
async function analyzeOrphanCategories() {
    try {
        const categories = await db.getAllCategories();
        
        // 创建分类ID映射，用于检查父级是否存在
        const categoryIdMap = new Map();
        categories.forEach(cat => {
            categoryIdMap.set(getCategoryId(cat), cat);
        });
        
        // 查找孤儿分类（parent_id 指向不存在的分类）
        const orphanCategories = [];
        
        categories.forEach(cat => {
            const parentId = getCategoryParentId(cat);
            
            // 跳过回收站和一级分类
            if (isRecycleCategory(cat) || parentId === 0) {
                return;
            }
            
            // 检查父级分类是否存在
            if (!categoryIdMap.has(parentId)) {
                orphanCategories.push({
                    id: getCategoryId(cat),
                    name: cat.name,
                    parent_id: parentId,
                    sort_order: cat.sort_order,
                    parent_exists: false
                });
            }
        });
        
        return orphanCategories;
    } catch (error) {
        console.error('❌ 分析孤儿分类失败:', error);
        return [];
    }
}

// 🔍 控制台调试函数：查看孤儿分类详情
async function debugOrphanCategories() {
    console.log('🔍 开始分析孤儿分类...');
    
    const orphans = await analyzeOrphanCategories();
    
    if (orphans.length === 0) {
        console.log('✅ 没有发现孤儿分类');
        return;
    }
    
    console.log(`⚠️ 发现 ${orphans.length} 个孤儿分类：`);
    console.table(orphans);
    
    // 统计每个孤儿分类下的话术
    console.log('\n📊 详细信息：');
    for (const orphan of orphans) {
        const phraseCount = await db.getCategoryPhraseCount(orphan.id);
        console.log(`• "${orphan.name}" (ID: ${orphan.id}, 父级ID: ${orphan.parent_id}) - ${phraseCount} 条话术`);
    }
    
    console.log('\n💡 提示：在管理页面点击"清理孤儿分类"按钮可以删除这些分类');
    console.log('或者在控制台运行: cleanOrphanCategories()');
    
    return orphans;
}

// 🗑️ 批量删除指定的分类（根据ID数组，级联删除话术）
async function deleteSpecificCategories(categoryIds) {
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
        alert('❌ 请提供要删除的分类ID数组\n\n示例：deleteSpecificCategories([5, 8, 12])');
        return;
    }
    
    try {
        const categories = await db.getAllCategories();
        const categoryIdMap = new Map();
        categories.forEach(cat => {
            categoryIdMap.set(getCategoryId(cat), cat);
        });
        
        // 验证并获取要删除的分类详情
        const toDelete = [];
        const notFound = [];
        
        categoryIds.forEach(id => {
            const cat = categoryIdMap.get(id);
            if (cat) {
                toDelete.push(cat);
            } else {
                notFound.push(id);
            }
        });
        
        if (notFound.length > 0) {
            console.warn('⚠️ 以下分类ID不存在:', notFound);
        }
        
        if (toDelete.length === 0) {
            alert('❌ 没有找到任何有效的分类ID');
            return;
        }
        
        // 统计要删除的分类和话术总数
        let message = `⚠️ 批量删除警告！\n\n`;
        message += `准备删除 ${toDelete.length} 个分类：\n\n`;
        
        let totalPhrases = 0;
        let hasTopLevelCategory = false;
        
        for (const cat of toDelete) {
            const phraseCount = await db.getCategoryPhraseCount(getCategoryId(cat));
            totalPhrases += phraseCount;
            const parentId = getCategoryParentId(cat);
            const isTopLevel = parentId === 0;
            if (isTopLevel) hasTopLevelCategory = true;
            
            const parentInfo = isTopLevel ? '（一级分类）' : `（二级分类，父级ID: ${parentId}）`;
            message += `• "${cat.name}" (ID: ${getCategoryId(cat)}) ${parentInfo}`;
            if (phraseCount > 0) {
                message += ` - ${phraseCount} 条话术`;
            }
            message += '\n';
        }
        
        if (notFound.length > 0) {
            message += `\n⚠️ 以下ID不存在，将跳过：${notFound.join(', ')}\n`;
        }
        
        message += `\n📊 删除统计：\n`;
        message += `• 将删除 ${toDelete.length} 个分类\n`;
        message += `• 将永久删除 ${totalPhrases} 条话术\n\n`;
        message += `🔥 注意：这是永久删除，无法恢复！\n\n`;
        message += `确定要删除这些分类吗？`;
        
        if (!confirm(message)) {
            console.log('❌ 用户取消删除');
            return;
        }
        
        // 执行删除
        let deletedCategoryCount = 0;
        let deletedPhraseCount = 0;
        
        for (const cat of toDelete) {
            try {
                const catId = getCategoryId(cat);
                
                // 先删除该分类下的所有话术
                const phraseCount = await permanentlyDeleteCategoryPhrases(catId);
                deletedPhraseCount += phraseCount;
                console.log(`🗑️ 已删除分类 "${cat.name}" 的 ${phraseCount} 条话术`);
                
                // 再删除分类本身
                await db.deleteCategory(catId);
                deletedCategoryCount++;
                console.log(`✅ 已删除分类: "${cat.name}" (ID: ${catId})`);
            } catch (error) {
                console.error(`❌ 删除失败: "${cat.name}" (ID: ${getCategoryId(cat)})`, error);
            }
        }
        
        // 刷新界面
        await loadCategories();
        await loadCategoryList();
        
        alert(`✅ 删除完成！\n\n成功删除 ${deletedCategoryCount} 个分类，永久删除 ${deletedPhraseCount} 条话术。`);
        console.log(`✅ 批量删除完成，共删除 ${deletedCategoryCount} 个分类，${deletedPhraseCount} 条话术`);
        
    } catch (error) {
        console.error('❌ 批量删除失败:', error);
        alert('❌ 删除失败，请查看控制台错误信息');
    }
}

// 📝 弹出输入框，让用户输入要删除的分类ID
async function promptBatchDeleteCategories() {
    const input = prompt(
        '🗑️ 批量删除分类\n\n' +
        '请输入要删除的分类ID，多个ID用逗号分隔：\n\n' +
        '示例：34, 35, 36, 37, 38, 39\n\n' +
        '💡 提示：可以先点击"查看所有二级分类"查看分类ID'
    );
    
    if (!input) {
        console.log('❌ 用户取消输入');
        return;
    }
    
    // 解析输入的ID
    const idsStr = input.trim();
    if (!idsStr) {
        alert('❌ 请输入至少一个分类ID');
        return;
    }
    
    try {
        // 分割字符串，转换为数字数组
        const ids = idsStr
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(s => {
                const num = parseInt(s, 10);
                if (isNaN(num)) {
                    throw new Error(`"${s}" 不是有效的数字`);
                }
                return num;
            });
        
        if (ids.length === 0) {
            alert('❌ 没有找到有效的分类ID');
            return;
        }
        
        console.log('📝 准备删除的分类ID:', ids);
        
        // 调用批量删除函数
        await deleteSpecificCategories(ids);
        
    } catch (error) {
        alert(`❌ 输入格式错误：${error.message}\n\n请使用逗号分隔的数字，例如：34, 35, 36`);
        console.error('输入解析错误:', error);
    }
}

// 暴露到全局，方便控制台调试和按钮调用
if (typeof window !== 'undefined') {
    window.debugOrphanCategories = debugOrphanCategories;
    window.analyzeOrphanCategories = analyzeOrphanCategories;
    window.viewOrphanCategories = viewOrphanCategories;
    window.viewAllSubcategories = viewAllSubcategories;
    window.cleanOrphanCategories = cleanOrphanCategories;
    window.deleteSpecificCategories = deleteSpecificCategories;
    window.promptBatchDeleteCategories = promptBatchDeleteCategories;
}

// 📋 查看所有二级分类详情
async function viewAllSubcategories() {
    try {
        const categories = await db.getAllCategories();
        
        // 创建分类ID映射
        const categoryIdMap = new Map();
        categories.forEach(cat => {
            categoryIdMap.set(getCategoryId(cat), cat);
        });
        
        // 找出所有二级分类
        const subcategories = [];
        
        categories.forEach(cat => {
            const parentId = getCategoryParentId(cat);
            
            // 跳过回收站和一级分类
            if (isRecycleCategory(cat) || parentId === 0) {
                return;
            }
            
            // 获取父级分类信息
            const parentCategory = categoryIdMap.get(parentId);
            const parentName = parentCategory ? parentCategory.name : '❌ 父级不存在';
            
            subcategories.push({
                '二级分类ID': getCategoryId(cat),
                '二级分类名称': cat.name,
                '父级ID': parentId,
                '父级名称': parentName,
                '排序': cat.sort_order || 0
            });
        });
        
        if (subcategories.length === 0) {
            alert('📋 数据库中没有二级分类。\n\n所有分类都是顶级分类。');
            return;
        }
        
        // 按父级ID分组
        const grouped = {};
        subcategories.forEach(sub => {
            const parentId = sub['父级ID'];
            if (!grouped[parentId]) {
                grouped[parentId] = [];
            }
            grouped[parentId].push(sub);
        });
        
        // 构建详细信息
        let message = `📋 数据库中共有 ${subcategories.length} 个二级分类：\n\n`;
        
        Object.keys(grouped).forEach(parentId => {
            const subs = grouped[parentId];
            const parentName = subs[0]['父级名称'];
            message += `📂 ${parentName} (ID: ${parentId})：\n`;
            subs.forEach(sub => {
                message += `   • ${sub['二级分类名称']} (ID: ${sub['二级分类ID']})\n`;
            });
            message += '\n';
        });
        
        message += '💡 提示：请查看Python控制台，那里有完整的表格显示。\n';
        message += '告诉我哪些是不需要的二级分类，我来帮您分析和清理。';
        
        alert(message);
        
        // 在控制台输出详细表格
        console.log('📋 所有二级分类详情：');
        console.table(subcategories);
        
        console.log('\n📊 按父级分组：');
        Object.keys(grouped).forEach(parentId => {
            const subs = grouped[parentId];
            const parentName = subs[0]['父级名称'];
            console.log(`\n📂 ${parentName} (ID: ${parentId})：`);
            console.table(subs);
        });
        
        return subcategories;
        
    } catch (error) {
        console.error('❌ 查看二级分类失败:', error);
        alert('❌ 查看失败，请查看控制台错误信息');
    }
}

// 🔍 查看孤儿分类详情（不删除）
async function viewOrphanCategories() {
    try {
        // 先分析孤儿分类
        const orphanCategories = await analyzeOrphanCategories();
        
        if (orphanCategories.length === 0) {
            alert('✅ 恭喜！数据库中没有发现孤儿分类。\n\n所有二级分类的父级都存在。');
            return;
        }
        
        // 统计每个孤儿分类下的话术数量
        const orphanDetails = [];
        for (const orphan of orphanCategories) {
            const phraseCount = await db.getCategoryPhraseCount(orphan.id);
            orphanDetails.push({
                ...orphan,
                phraseCount
            });
        }
        
        // 构建详细信息
        let message = `🔍 发现 ${orphanCategories.length} 个孤儿分类（父级分类已被删除）：\n\n`;
        orphanDetails.forEach((orphan, index) => {
            message += `${index + 1}. "${orphan.name}"\n`;
            message += `   • 分类ID: ${orphan.id}\n`;
            message += `   • 父级ID: ${orphan.parent_id}（已不存在）\n`;
            message += `   • 话术数量: ${orphan.phraseCount} 条\n`;
            message += '\n';
        });
        
        const totalPhrases = orphanDetails.reduce((sum, o) => sum + o.phraseCount, 0);
        message += `📊 统计：共 ${orphanCategories.length} 个孤儿分类，包含 ${totalPhrases} 条话术\n\n`;
        message += '💡 提示：这些孤儿分类不会显示在"添加话术"的分类下拉框中。';
        
        alert(message);
        
        // 在控制台输出详细表格
        console.log('🔍 孤儿分类详情：');
        console.table(orphanDetails);
        
    } catch (error) {
        console.error('❌ 查看孤儿分类失败:', error);
        alert('❌ 查看失败，请查看控制台错误信息');
    }
}

// 🗑️ 清理孤儿分类
async function cleanOrphanCategories() {
    try {
        // 先分析孤儿分类
        const orphanCategories = await analyzeOrphanCategories();
        
        if (orphanCategories.length === 0) {
            alert('✅ 恭喜！数据库中没有发现孤儿分类。\n\n所有二级分类的父级都存在。');
            return;
        }
        
        // 统计每个孤儿分类下的话术数量
        const orphanDetails = [];
        for (const orphan of orphanCategories) {
            const phraseCount = await db.getCategoryPhraseCount(orphan.id);
            orphanDetails.push({
                ...orphan,
                phraseCount
            });
        }
        
        // 构建确认消息
        let message = `🔍 发现 ${orphanCategories.length} 个孤儿分类（父级分类已被删除）：\n\n`;
        orphanDetails.forEach((orphan, index) => {
            message += `${index + 1}. "${orphan.name}" (ID: ${orphan.id}, 父级ID: ${orphan.parent_id})`;
            if (orphan.phraseCount > 0) {
                message += ` - 包含 ${orphan.phraseCount} 条话术`;
            }
            message += '\n';
        });
        
        const totalPhrases = orphanDetails.reduce((sum, o) => sum + o.phraseCount, 0);
        if (totalPhrases > 0) {
            message += `\n⚠️ 警告：删除后，这 ${totalPhrases} 条话术将变成未分类状态。\n`;
        }
        message += '\n确定要删除这些孤儿分类吗？';
        
        if (!confirm(message)) {
            console.log('❌ 用户取消清理孤儿分类');
            return;
        }
        
        // 执行删除
        let deletedCount = 0;
        for (const orphan of orphanCategories) {
            try {
                await db.deleteCategory(orphan.id);
                deletedCount++;
                console.log(`✅ 已删除孤儿分类: "${orphan.name}" (ID: ${orphan.id})`);
            } catch (error) {
                console.error(`❌ 删除孤儿分类失败: "${orphan.name}" (ID: ${orphan.id})`, error);
            }
        }
        
        // 刷新界面
        await loadCategories();
        await loadCategoryList();
        
        alert(`✅ 清理完成！\n\n已删除 ${deletedCount} 个孤儿分类。`);
        console.log(`✅ 清理完成，共删除 ${deletedCount} 个孤儿分类`);
        
    } catch (error) {
        console.error('❌ 清理孤儿分类失败:', error);
        alert('❌ 清理失败，请查看控制台错误信息');
    }
}

// 切换分类排序模式
function toggleCategorySortMode() {
    isCategorySortModeActive = !isCategorySortModeActive;
    
    const toggleBtn = document.getElementById('toggleCategorySortModeBtn');
    const categoryList = document.getElementById('categoryList');
    
    if (toggleBtn) {
        if (isCategorySortModeActive) {
            toggleBtn.classList.add('sort-mode-active');
            toggleBtn.title = '点击退出排序模式';
            showToast('✅ 已进入排序模式，可拖动分类调整顺序');
        } else {
            toggleBtn.classList.remove('sort-mode-active');
            toggleBtn.title = '点击进入排序模式';
            showToast('已退出排序模式');
        }
    }
    
    if (categoryList) {
        categoryList.classList.toggle('sort-mode-active', isCategorySortModeActive);
        // 重新加载分类列表以显示/隐藏拖拽手柄
        loadCategoryList();
    }
    
    if (document.body) {
        document.body.classList.toggle('category-sort-mode', isCategorySortModeActive);
    }

    // 同步刷新左侧分类导航以展示或移除拖拽手柄
    loadCategories();
    
    // 更新平铺二级分类区域的排序模式状态
    updateSubcategoryTabsSortMode();
}

// 分类拖拽开始
let draggedCategoryElement = null;
let draggedNavCategoryElement = null;
let draggedSubcategoryElement = null;
let subcategoryDragParentId = null;

// 🚀 性能优化：拖拽节流防抖配置
let dragThrottleTimer = null;
let isDraggingActive = false;
const DRAG_THROTTLE_DELAY = 16; // 16ms节流，约60fps

// 🎯 性能优化：布局缓存配置
let layoutCache = new Map();
let dragPreviewCache = null;
let isLayoutCacheEnabled = false;

// 🚀 预加载拖拽浮层模板，避免首次拖拽卡顿
function preloadDragElements() {
    if (dragPreviewCache) return; // 已预加载
    
    console.log('[拖拽优化] 🚀 预加载拖拽浮层模板');
    
    // 创建隐藏的拖拽预览模板
    dragPreviewCache = document.createElement('div');
    dragPreviewCache.className = 'drag-preview-template';
    dragPreviewCache.style.cssText = `
        position: absolute;
        top: -9999px;
        left: -9999px;
        opacity: 0.8;
        pointer-events: none;
        z-index: 9999;
        background: rgba(33, 150, 243, 0.1);
        border: 2px dashed #2196F3;
        border-radius: 4px;
        padding: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    document.body.appendChild(dragPreviewCache);
    
    // 预热布局缓存
    isLayoutCacheEnabled = true;
    console.log('[拖拽优化] ✅ 拖拽浮层预加载完成');
}

// 🎯 布局缓存：检查平铺模式重复判断
function checkTileModeCache(categoryId) {
    const cacheKey = `tile-mode-${categoryId}`;
    
    if (layoutCache.has(cacheKey)) {
        return layoutCache.get(cacheKey);
    }
    
    // 执行平铺模式检查
    const result = document.body.classList.contains('tile-mode') && 
                  !document.querySelector(`[CAT]`);
    
    // 缓存结果（5秒过期）
    layoutCache.set(cacheKey, result);
    setTimeout(() => {
        layoutCache.delete(cacheKey);
    }, 5000);
    
    return result;
}

// 🚀 清理布局缓存
function clearLayoutCache() {
    layoutCache.clear();
    console.log('[拖拽优化] 🧹 布局缓存已清理');
}

function handleCategoryDragStart(e) {
    draggedCategoryElement = e.target;
    e.target.style.opacity = '0.5';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', e.target.innerHTML);
    isDraggingActive = true;
}

function handleCategoryDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    // 🚀 节流防抖：避免频繁触发布局重绘
    if (dragThrottleTimer) {
        clearTimeout(dragThrottleTimer);
    }
    
    dragThrottleTimer = setTimeout(() => {
        if (!isDraggingActive) return;
        
        const target = e.target.closest('.category-item');
        if (target && target !== draggedCategoryElement) {
            // 🎯 布局缓存：批量更新样式，减少回流
            requestAnimationFrame(() => {
                // 清除所有边框高亮
                document.querySelectorAll('.category-item').forEach(item => {
                    item.style.borderTop = '';
                });
                // 设置当前目标高亮
                target.style.borderTop = '2px solid #2196F3';
            });
        }
    }, DRAG_THROTTLE_DELAY);
    
    return false;
}

function handleCategoryDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    const target = e.target.closest('.category-item');
    if (target && draggedCategoryElement !== target) {
        // 🚀 性能优化：批量更新DOM，减少回流
        requestAnimationFrame(() => {
            // 移除所有边框高亮
            document.querySelectorAll('.category-item').forEach(item => {
                item.style.borderTop = '';
            });
            
            // 获取拖拽元素和目标元素的位置
            const categoryList = document.getElementById('categoryList');
            const items = Array.from(categoryList.querySelectorAll('.category-item'));
            const draggedIndex = items.indexOf(draggedCategoryElement);
            const targetIndex = items.indexOf(target);
            
            // 移动元素
            if (draggedIndex < targetIndex) {
                target.parentNode.insertBefore(draggedCategoryElement, target.nextSibling);
            } else {
                target.parentNode.insertBefore(draggedCategoryElement, target);
            }
            
            // 🚀 节流防抖：延迟更新数据库，避免频繁计算sort_order
            if (dragThrottleTimer) {
                clearTimeout(dragThrottleTimer);
            }
            
            dragThrottleTimer = setTimeout(() => {
                updateCategoriesOrder();
            }, 100); // 100ms延迟批量更新
        });
    }
    
    return false;
}

function handleCategoryDragEnd(e) {
    isDraggingActive = false;
    
    // 清理节流定时器
    if (dragThrottleTimer) {
        clearTimeout(dragThrottleTimer);
        dragThrottleTimer = null;
    }
    
    // 🚀 性能优化：批量更新样式，减少回流
    requestAnimationFrame(() => {
        if (e.target) {
            e.target.style.opacity = '';
        }
        
        // 移除所有边框高亮
        document.querySelectorAll('.category-item').forEach(item => {
            item.style.borderTop = '';
        });
    });
    
    // 清理拖拽状态
    draggedCategoryElement = null;
}

function handleNavCategoryDragStart(e) {
    if (!isCategorySortModeActive) {
        return;
    }
    const target = e.currentTarget;
    if (!target || !target.dataset.id) {
        return;
    }
    draggedNavCategoryElement = target;
    target.classList.add('nav-dragging');
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', target.dataset.id);
    }
}

function handleNavCategoryDragOver(e) {
    if (!isCategorySortModeActive) {
        return;
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    const target = e.currentTarget;
    if (!target || target === draggedNavCategoryElement) {
        return false;
    }
    target.classList.add('nav-drag-over');
    return false;
}

function handleNavCategoryDragLeave(e) {
    const target = e.currentTarget;
    if (target) {
        target.classList.remove('nav-drag-over');
    }
}

async function handleNavCategoryDrop(e) {
    if (!isCategorySortModeActive) {
        return false;
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    const target = e.currentTarget;
    const dragged = draggedNavCategoryElement;
    if (!target || !dragged || target === dragged) {
        return false;
    }
    target.classList.remove('nav-drag-over');

    // 优先使用 primaryCategoryTiles，这是实际存放一级分类的元素
    const nav = document.getElementById('primaryCategoryTiles') || document.getElementById('categoryNav');
    if (!nav) {
        return false;
    }

    const items = Array.from(nav.querySelectorAll('.category-nav-item[data-id]'));
    const draggedIndex = items.indexOf(dragged);
    const targetIndex = items.indexOf(target);

    if (draggedIndex === -1 || targetIndex === -1) {
        return false;
    }

    if (draggedIndex < targetIndex) {
        target.after(dragged);
    } else {
        nav.insertBefore(dragged, target);
    }

    await persistTopLevelOrderFromNav();
    return false;
}

function handleNavCategoryDragEnd() {
    if (draggedNavCategoryElement) {
        draggedNavCategoryElement.classList.remove('nav-dragging');
        draggedNavCategoryElement = null;
    }
    document.querySelectorAll('.category-nav-item.nav-drag-over').forEach(item => {
        item.classList.remove('nav-drag-over');
    });
    // 确保所有拖拽状态清理
    document.querySelectorAll('.nav-dragging, .nav-drag-over').forEach(item => {
        item.classList.remove('nav-dragging', 'nav-drag-over');
    });
}

function handleSubcategoryDragStart(e) {
    if (!isCategorySortModeActive) {
        return;
    }
    const target = e.currentTarget;
    if (!target || !target.dataset.id) {
        return;
    }
    draggedSubcategoryElement = target;
    subcategoryDragParentId = Number(target.dataset.parentId || target.closest('.subcategory-popover')?.dataset.parent || target.closest('.subcategory-tabs-container')?.dataset.parentId || 0);
    target.classList.add('popover-dragging');
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', target.dataset.id);
    }
    // 调试：显示父级ID
    console.log('[二级排序] 拖拽开始，父级ID:', subcategoryDragParentId, '元素ID:', target.dataset.id);
}

function handleSubcategoryDragOver(e) {
    if (!isCategorySortModeActive) {
        return;
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    const target = e.currentTarget;
    if (!target || target === draggedSubcategoryElement) {
        return false;
    }
    target.classList.add('popover-drag-over');
    return false;
}

function handleSubcategoryDragLeave(e) {
    const target = e.currentTarget;
    if (target) {
        target.classList.remove('popover-drag-over');
    }
}

async function handleSubcategoryDrop(e) {
    if (!isCategorySortModeActive) {
        return false;
    }
    if (e.preventDefault) {
        e.preventDefault();
    }
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    const target = e.currentTarget;
    const dragged = draggedSubcategoryElement;
    if (!target || !dragged || target === dragged) {
        return false;
    }
    target.classList.remove('popover-drag-over');
    
    const list = target.parentElement;
    if (!list) {
        return false;
    }
    
    const items = Array.from(list.querySelectorAll('.popover-item[data-id]'));
    const draggedIndex = items.indexOf(dragged);
    const targetIndex = items.indexOf(target);
    
    if (draggedIndex === -1 || targetIndex === -1) {
        return false;
    }
    
    if (draggedIndex < targetIndex) {
        target.after(dragged);
    } else {
        list.insertBefore(dragged, target);
    }
    
    // 查找容器：可能是弹层或平铺区域
    const container = target.closest('.subcategory-popover') || target.closest('.subcategory-tabs-container');
    if (container) {
        // 直接从被拖拽元素或容器获取父级ID，避免依赖全局变量
        const parentId = Number(dragged.dataset.parentId || container.dataset.parentId || container.dataset.parent || subcategoryDragParentId);
        if (Number.isFinite(parentId) && parentId > 0) {
            await persistSubcategoryOrder(container, parentId);
        } else {
            console.warn('⚠️ 无法获取父级分类ID', {
                draggedDatasetParentId: dragged.dataset.parentId,
                containerDatasetParentId: container.dataset.parentId,
                containerDatasetParent: container.dataset.parent,
                subcategoryDragParentId
            });
            showToast('❌ 排序失败：无法获取父级分类ID', 'error');
        }
    }
    return false;
}

function handleSubcategoryDragEnd() {
    if (draggedSubcategoryElement) {
        draggedSubcategoryElement.classList.remove('popover-dragging');
        draggedSubcategoryElement = null;
    }
    subcategoryDragParentId = null;
    document.querySelectorAll('.subcategory-popover .popover-item.popover-drag-over').forEach(item => {
        item.classList.remove('popover-drag-over');
    });
}

// 更新分类排序到数据库
// 分类排序防抖
let _categoryOrderDebounceTimer = null;
// 顶级分类排序防抖和锁
let _topLevelSortDebounceTimer = null;
let _topLevelSortInProgress = false;
// 子分类排序防抖和锁
let _subCategorySortDebounceTimers = new Map();
let _subCategorySortInProgress = false;

async function updateCategoriesOrder() {
    // 防抖：300ms内只执行一次
    if (_categoryOrderDebounceTimer) {
        clearTimeout(_categoryOrderDebounceTimer);
    }
    _categoryOrderDebounceTimer = setTimeout(async () => {
        try {
            const categoryList = document.getElementById('categoryList');
            if (!categoryList) {
                return;
            }
            const items = Array.from(categoryList.querySelectorAll('.category-item'));
            const orderedIds = items
                .map(item => Number(item.dataset.id))
                .filter(id => Number.isFinite(id));
            
            if (orderedIds.length === 0) {
                return;
            }
            
            await rebuildCategorySortOrder({ fullOrder: orderedIds });
            console.log('✅ 分类排序已更新');
        } catch (error) {
            console.error('更新分类排序失败:', error);
            showToast('❌ 排序保存失败', 'error');
        }
    }, 300);
}

async function persistTopLevelOrderFromNav() {
    // 防抖：300ms内只执行一次
    if (_topLevelSortDebounceTimer) {
        clearTimeout(_topLevelSortDebounceTimer);
    }
    _topLevelSortDebounceTimer = setTimeout(async () => {
        // 如果已经有排序操作在进行，则跳过
        if (_topLevelSortInProgress) {
            console.log('[分类排序] 顶级分类排序正在进行，跳过本次操作');
            return;
        }
        
        _topLevelSortInProgress = true;
        try {
            // 优先使用 primaryCategoryTiles，这是实际存放一级分类的元素
            const nav = document.getElementById('primaryCategoryTiles') || document.getElementById('categoryNav');
            if (!nav) {
                return;
            }
            const orderedIds = Array.from(nav.querySelectorAll('.category-nav-item[data-id]'))
                .map(item => Number(item.dataset.id))
                .filter(id => Number.isFinite(id));
            if (orderedIds.length === 0) {
                return;
            }
            await rebuildCategorySortOrder({ topLevelOrder: orderedIds });
        } catch (error) {
            console.error('侧边栏分类排序失败:', error);
            showToast('❌ 排序保存失败', 'error');
        } finally {
            _topLevelSortInProgress = false;
        }
    }, 300);
}

async function persistSubcategoryOrder(containerElement, explicitParentId = null) {
    try {
        if (!containerElement) {
            showToast('❌ 排序失败：容器不存在', 'error');
            return;
        }
        // 支持弹层（data-parent）和平铺区域（data-parent-id），也接受外部传入的父级ID
        const parentId = explicitParentId !== null
            ? Number(explicitParentId)
            : Number(containerElement.dataset.parent || containerElement.dataset.parentId || subcategoryDragParentId);
        if (!Number.isFinite(parentId) || parentId <= 0) {
            console.warn('⚠️ 无法获取父级分类ID');
            showToast('❌ 排序失败：父级ID无效 (' + parentId + ')', 'error');
            return;
        }
        
        // 为每个父级ID单独防抖
        const timerKey = `sub_${parentId}`;
        if (_subCategorySortDebounceTimers.has(timerKey)) {
            clearTimeout(_subCategorySortDebounceTimers.get(timerKey));
        }
        
        _subCategorySortDebounceTimers.set(timerKey, setTimeout(async () => {
            // 如果已经有子分类排序操作在进行，则跳过
            if (_subCategorySortInProgress) {
                console.log('[分类排序] 子分类排序正在进行，跳过本次操作');
                return;
            }
            
            _subCategorySortInProgress = true;
            try {
                const orderedIds = Array.from(containerElement.querySelectorAll('.popover-item[data-id]'))
                    .map(item => Number(item.dataset.id))
                    .filter(id => Number.isFinite(id));
                if (orderedIds.length === 0) {
                    console.warn('⚠️ 未找到任何二级分类');
                    return;
                }
                console.log('💾 保存二级分类排序，父级ID:', parentId, '排序:', orderedIds);
                await rebuildCategorySortOrder({
                    childOrderMap: new Map([[parentId, orderedIds]])
                });
                console.log('✅ 二级分类排序已保存');
            } catch (error) {
                console.error('二级分类排序失败:', error);
                showToast('❌ 排序保存失败', 'error');
            } finally {
                _subCategorySortInProgress = false;
            }
        }, 300));
    } catch (error) {
        console.error('二级分类排序失败:', error);
        showToast('❌ 排序保存失败', 'error');
    }
}

// ⚡ 只刷新下拉框选项，不重建分类导航DOM（排序后调用，避免全量重渲染）
async function refreshCategorySelects() {
    const categories = allCategoriesCache;
    if (!Array.isArray(categories) || categories.length === 0) return;

    const rootCategories = categories.filter(cat => getCategoryParentId(cat) === 0 && !isRecycleCategory(cat));

    const phraseJumpCategory = document.getElementById('phraseJumpCategory');
    if (phraseJumpCategory) {
        const currentJump = getCustomSelectValue('phraseJumpCategory');
        const jumpDropdown = phraseJumpCategory.querySelector('.custom-select-dropdown');
        if (jumpDropdown) {
            jumpDropdown.innerHTML = '';
            const noJumpLi = document.createElement('li');
            noJumpLi.className = 'custom-select-option' + (!currentJump ? ' selected' : '');
            noJumpLi.dataset.value = '';
            noJumpLi.setAttribute('role', 'option');
            noJumpLi.textContent = '-- 不跳转 --';
            jumpDropdown.appendChild(noJumpLi);

            rootCategories.forEach(cat => {
                const group = document.createElement('li');
                group.className = 'custom-select-group';
                group.dataset.categoryId = cat.id;
                const children = categories.filter(c => getCategoryParentId(c) === cat.id);
                const hasSub = children.length > 0;

                const header = document.createElement('div');
                header.className = 'custom-select-group-header';
                header.dataset.value = cat.id;
                header.setAttribute('role', 'option');
                if (hasSub) {
                    const arrow = document.createElement('span');
                    arrow.className = 'custom-select-group-arrow';
                    arrow.textContent = '▶';
                    header.appendChild(arrow);
                } else {
                    const spacer = document.createElement('span');
                    spacer.className = 'custom-select-group-arrow';
                    spacer.style.visibility = 'hidden';
                    header.appendChild(spacer);
                }
                const title = document.createElement('span');
                title.className = 'custom-select-group-title';
                title.textContent = cat.name.replace(/^🗑️/, '');
                header.appendChild(title);
                group.appendChild(header);

                if (hasSub) {
                    const itemsContainer = document.createElement('ul');
                    itemsContainer.className = 'custom-select-group-items';
                    children.forEach(sub => {
                        const subLi = document.createElement('li');
                        subLi.className = 'custom-select-option';
                        subLi.dataset.value = sub.id;
                        subLi.dataset.parentId = cat.id;
                        subLi.textContent = sub.name.replace(/^🗑️/, '');
                        subLi.setAttribute('role', 'option');
                        itemsContainer.appendChild(subLi);
                    });
                    group.appendChild(itemsContainer);
                }
                jumpDropdown.appendChild(group);
            });
            if (currentJump) setCustomSelectValue('phraseJumpCategory', currentJump);
        }
    }

    // 刷新分类对话框的父级分类下拉框
    const categoryParent = document.getElementById('categoryParent');
    if (categoryParent) {
        const currentParent = categoryParent.value;
        categoryParent.innerHTML = '<option value="0">（无）顶级分类</option>';
        rootCategories.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat.id;
            opt.textContent = cat.name.replace(/^🗑️/, '');
            categoryParent.appendChild(opt);
        });
        if (currentParent) categoryParent.value = currentParent;
    }
}

async function rebuildCategorySortOrder(options = {}) {
    const { fullOrder = null, topLevelOrder = null, childOrderMap = null } = options;
    let categories = Array.isArray(allCategoriesCache) && allCategoriesCache.length > 0
        ? [...allCategoriesCache]
        : await db.getAllCategories();
    
    if (!Array.isArray(categories) || categories.length === 0) {
        return;
    }
    
    const applyUpdates = async (orderedCategories) => {
        const updates = orderedCategories.map((category, index) => ({
            id: getCategoryId(category),
            sort_order: index
        }));
        await db.batchUpdateCategorySortOrder(updates);
        
        // 更新缓存中的排序顺序（不重新渲染UI，DOM已经是正确顺序）
        orderedCategories.forEach((category, index) => {
            category.sort_order = index;
        });
        allCategoriesCache = orderedCategories;

        // 只在管理页面打开时才刷新分类列表，避免不必要的全局刷新
        const categoryDialog = document.getElementById('categoryDialog');
        if (categoryDialog && categoryDialog.style.display !== 'none') {
            await loadCategoryList();
        }

        // ⚡ 性能优化：排序时DOM顺序已经正确，只需同步下拉框选项，不需要重新渲染整个分类导航
        // 只刷新话术对话框中的分类选择下拉框
        await refreshCategorySelects();
    };
    
    // 完整顺序覆盖：直接按照给定顺序展开
    if (Array.isArray(fullOrder) && fullOrder.length > 0) {
        const normalizedFullOrder = Array.from(
            new Set(fullOrder.map(id => Number(id)).filter(id => Number.isFinite(id)))
        );
        
        categories.forEach(category => {
            if (!normalizedFullOrder.includes(category.id)) {
                normalizedFullOrder.push(category.id);
            }
        });
        
        const orderedCategories = normalizedFullOrder
            .map(id => categories.find(cat => getCategoryId(cat) === id))
            .filter(Boolean);
        
        await applyUpdates(orderedCategories);
        return;
    }
    
    const result = [];
    const appendedIds = new Set();
    
    const addToResult = (category) => {
        if (category && !appendedIds.has(category.id)) {
            result.push(category);
            appendedIds.add(category.id);
        }
    };
    
    const normalizedChildOrderMap = new Map();
    if (childOrderMap instanceof Map) {
        childOrderMap.forEach((ids, parentId) => {
            const normalized = Array.from(
                new Set((ids || []).map(id => Number(id)).filter(id => Number.isFinite(id)))
            );
            if (normalized.length > 0) {
                normalizedChildOrderMap.set(Number(parentId), normalized);
            }
        });
    }
    
    const appendChildren = (parentCategory) => {
        if (!parentCategory) {
            return;
        }
        const overrideIds = normalizedChildOrderMap.get(parentCategory.id);
        if (overrideIds) {
            const siblings = categories.filter(cat => getCategoryParentId(cat) === parentCategory.id);
            siblings.forEach(sibling => {
                if (!overrideIds.includes(sibling.id)) {
                    overrideIds.push(sibling.id);
                }
            });
            overrideIds.forEach(childId => {
                const child = categories.find(cat => getCategoryId(cat) === childId && getCategoryParentId(cat) === parentCategory.id);
                addToResult(child);
            });
        } else {
            categories.forEach(cat => {
                if (getCategoryParentId(cat) === parentCategory.id) {
                    addToResult(cat);
                }
            });
        }
    };
    
    // 固定回收站等特殊分类在最前
    categories.filter(isRecycleCategory).forEach(addToResult);
    
    const topLevelCategories = categories.filter(cat => getCategoryParentId(cat) === 0 && !isRecycleCategory(cat));
    let orderedTopLevels = topLevelCategories.slice();
    
    if (Array.isArray(topLevelOrder) && topLevelOrder.length > 0) {
        const normalizedTopLevels = Array.from(
            new Set(topLevelOrder.map(id => Number(id)).filter(id => Number.isFinite(id)))
        );
        orderedTopLevels = [];
        normalizedTopLevels.forEach(id => {
            const match = topLevelCategories.find(cat => getCategoryId(cat) === id);
            if (match) {
                orderedTopLevels.push(match);
            }
        });
        topLevelCategories.forEach(cat => {
            if (!normalizedTopLevels.includes(cat.id)) {
                orderedTopLevels.push(cat);
            }
        });
    }
    
    orderedTopLevels.forEach(parentCat => {
        addToResult(parentCat);
        appendChildren(parentCat);
    });
    
    // 兜底：追加任何遗漏的分类（孤儿分类等）
    categories.forEach(addToResult);
    
    await applyUpdates(result);
}
// 导入话术
async function importPhrases() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            let phrasesToImport = [];
            let data = null; // 🔧 提升到外层作用域
            let isNewFormat = false; // 🔧 提升到外层作用域
            let categoryIdMap = null; // 🔧 提升到外层作用域，用于导入文本编辑器内容
            
            if (file.name.endsWith('.json')) {
                data = JSON.parse(text);
                
                // 🎯 检测数据格式版本
                isNewFormat = data.version === "2.0" && data.categories && data.phrases;
                
                // 支持三种格式：
                // 1. 新格式 v2.0：包含 categories 和 phrases
                // 2. 旧格式：直接的话术数组
                // 3. 旧格式：包含 phrases 字段的对象
                let phrases = isNewFormat ? data.phrases : (Array.isArray(data) ? data : (data.phrases || []));
                
                // 创建分类名称到ID的映射
                const categoryMap = new Map();
                let existingCategories = await db.getAllCategories();
                existingCategories.forEach(cat => {
                    categoryMap.set(cat.name, cat.id);
                });
                
                // 🆕 如果是新格式，先导入分类数据
                if (isNewFormat && data.categories && data.categories.length > 0) {
                    console.log('📦 检测到新格式数据，开始导入分类...');
                    
                    // 创建分类ID映射（旧ID -> 新ID）
                    categoryIdMap = new Map();
                    
                    for (const cat of data.categories) {
                        // 跳过回收站（ID=1），使用系统回收站
                        if (cat.id === 1 || cat.name === '🗑️话术回收' || cat.name === '话术回收') {
                            categoryIdMap.set(cat.id, 1);
                            console.log(`✅ 跳过回收站，映射到系统回收站 (ID: 1)`);
                            continue;
                        }
                        
                        // 检查分类是否已存在
                        if (categoryMap.has(cat.name)) {
                            // 分类已存在，使用现有ID
                            const existingId = categoryMap.get(cat.name);
                            categoryIdMap.set(cat.id, existingId);
                            console.log(`✅ 分类已存在: "${cat.name}" (旧ID: ${cat.id} -> 新ID: ${existingId})`);
                        } else {
                            // 创建新分类，保留 parent_id 和 show_text_editor 属性
                            const newId = await db.addCategory(
                                cat.name,
                                cat.parent_id || 0,
                                cat.sort_order || 0,
                                cat.show_text_editor || false,
                                cat.display_as_button || false,
                                cat.enable_alias === true,
                                cat.alias || null
                            );
                            categoryMap.set(cat.name, newId);
                            categoryIdMap.set(cat.id, newId);
                            console.log(`✅ 创建新分类: "${cat.name}" (旧ID: ${cat.id} -> 新ID: ${newId}, parent: ${cat.parent_id}, editor: ${cat.show_text_editor})`);
                        }
                    }
                    
                    // 🔧 第二遍：更新二级分类的 parent_id（因为父分类可能在后面才创建）
                    for (const cat of data.categories) {
                        if (cat.parent_id && cat.parent_id !== 0 && cat.id !== 1) {
                            const newId = categoryIdMap.get(cat.id);
                            const newParentId = categoryIdMap.get(cat.parent_id);
                            
                            if (newId && newParentId) {
                                await db.updateCategory(
                                    newId,
                                    cat.name,
                                    newParentId,
                                    cat.show_text_editor,
                                    cat.display_as_button || false,
                                    cat.enable_alias === true,
                                    cat.alias || null
                                );
                                console.log(`✅ 更新二级分类: "${cat.name}" (ID: ${newId}, parent: ${newParentId})`);
                            }
                        }
                    }
                    
                    // 刷新分类列表
                    existingCategories = await db.getAllCategories();
                    existingCategories.forEach(cat => {
                        categoryMap.set(cat.name, cat.id);
                    });
                    
                    console.log('✅ 分类导入完成，共导入 ' + data.categories.length + ' 个分类');
                }
                
                // 获取默认分类ID（使用第一个实际存在的分类，如果没有则使用回收站）
                const initialDefaultCategory = getFirstNonRecycleCategory(existingCategories);
                let defaultCategoryId = initialDefaultCategory
                    ? initialDefaultCategory.id
                    : (existingCategories.length > 0 ? existingCategories[0].id : 1);
                
                // 处理每个话术
                for (const phrase of phrases) {
                    let categoryId = defaultCategoryId; // 默认使用第一个分类或回收站
                    
                    // 🎯 优先使用分类名称进行匹配，支持 category 和 category_name 两个字段
                    const categoryField = phrase.category || phrase.category_name;
                    if (categoryField && typeof categoryField === 'string') {
                        const categoryName = categoryField.trim();
                        
                        // 跳过回收站分类（如果 JSON 中有回收站分类，使用系统回收站）
                        if (categoryName === '🗑️话术回收' || categoryName === '话术回收' || categoryName === '回收站') {
                            categoryId = 1; // 使用系统回收站
                            console.log(`✅ 使用系统回收站 (ID: 1)`);
                        } else if (categoryName === '未分类' || categoryName === '📦 未分类') {
                            // 🔧 如果分类名称是"未分类"，保持 category_id = 0，不创建分类
                            categoryId = 0;
                            console.log(`✅ 话术标记为未分类 (category_id: 0)`);
                        } else if (!categoryMap.has(categoryName)) {
                            // 🆕 创建新分类
                            const newCategoryId = await db.addCategory(categoryName);
                            categoryMap.set(categoryName, newCategoryId);
                            categoryId = newCategoryId;
                            console.log(`✅ 自动创建新分类: "${categoryName}" (ID: ${newCategoryId})`);
                            
                            // 更新现有分类列表（用于后续话术）
                            existingCategories = await db.getAllCategories();
                            const nextDefault = getFirstNonRecycleCategory(existingCategories);
                            if (nextDefault) {
                                defaultCategoryId = nextDefault.id;
                            }
                        } else {
                            // ✅ 使用现有分类的ID（忽略话术中原有的ID，以分类名称为准）
                            categoryId = categoryMap.get(categoryName);
                            console.log(`✅ 匹配现有分类: "${categoryName}" (ID: ${categoryId})`);
                        }
                    } else if (phrase.category_id !== undefined && phrase.category_id !== null) {
                        // 🔍 仅当没有分类名称时，才尝试使用 category_id
                        // 🔧 如果 category_id 是 0，保持为 0（未分类）
                        if (phrase.category_id === 0) {
                            categoryId = 0;
                            console.log(`✅ 话术的 category_id 为 0，保持未分类状态`);
                        } else {
                            // 检查这个ID是否存在于系统中
                            const categoryExists = existingCategories.some(cat => cat.id === phrase.category_id);
                            if (categoryExists) {
                                categoryId = phrase.category_id;
                                console.log(`✅ 使用话术中的分类ID: ${categoryId}`);
                            } else {
                                // ⚠️ 话术的分类ID不存在，且没有分类名称，使用默认分类
                                console.warn(`⚠️ 分类ID ${phrase.category_id} 不存在且无分类名称，使用默认分类 ${defaultCategoryId}`);
                            }
                        }
                    } else {
                        console.log(`ℹ️ 话术无分类信息，使用默认分类 ${defaultCategoryId}`)
                    }
                    
                    phrasesToImport.push({
                        id: phrase.id || null, // 🔄 保存旧ID，用于建立映射（变形话术需要）
                        content: phrase.content,
                        content_html: phrase.content_html || null, // 🎨 HTML内容（包含部分样式）
                        category_id: categoryId,
                        tags: Array.isArray(phrase.tags) ? phrase.tags.join(',') : (phrase.tags || ''),
                        // 🔥 导入扩展功能字段（占位符 + 图片 + 使用说明 + 样式）
                        has_placeholders: phrase.has_placeholders || false,
                        placeholder_names: phrase.placeholder_names || [],
                        enable_placeholder: phrase.enable_placeholder || false,
                        images: phrase.images || [],
                        // 🔧 修复：默认不启用图片功能，只有当原数据明确设置为 true 时才启用
                        // 这样可以避免导入旧数据时所有卡片都默认显示图片按钮
                        enable_images: phrase.enable_images === true ? true : false,
                        // 使用说明相关字段
                        enable_description: phrase.enable_description === true ? true : false,
                        description: phrase.description || '',
                        // 🎨 样式相关字段
                        text_color: phrase.text_color || null,
                        bg_color: phrase.bg_color || null,
                        is_bold: phrase.is_bold || false,
                        // 🔄 变形话术相关字段
                        enable_variants: phrase.enable_variants === true ? true : false,
                        parent_id: phrase.parent_id || null, // 🔄 父话术ID（null表示主话术，数字表示是某个话术的变形）
                        // 🔗 跳转相关字段
                        jump_category_id: phrase.jump_category_id || null,
                        // 🚫 点击复制开关
                        disable_click_copy: phrase.disable_click_copy === true ? true : false,
                        // 🗑️ 删除/回收站状态（用于导入还原）
                        is_deleted: phrase.is_deleted === true,
                        deleted_time: phrase.deleted_time || null,
                        // 标题卡片相关字段（兼容旧数据，未提供时使用默认值）
                        is_title: phrase.is_title === true,
                        title_text: phrase.title_text || null,
                        title_id: phrase.title_id === undefined ? null : phrase.title_id,
                        is_collapsed: phrase.is_collapsed === true,
                        show_text_editor: phrase.show_text_editor === true
                    });
                }
                
            } else if (file.name.endsWith('.csv')) {
                // 简单的CSV解析
                const lines = text.split('\n').slice(1); // 跳过标题行
                phrasesToImport = lines.map(line => {
                    const [content, category_id, tags] = line.split(',');
                    return {
                        content: content?.trim(),
                        category_id: parseInt(category_id) || 1,
                        tags: tags?.trim() || ''
                    };
                }).filter(p => p.content);
            }
            
            if (phrasesToImport && phrasesToImport.length > 0) {
                // 统计导入信息
                const categoryStats = {};
                phrasesToImport.forEach(p => {
                    categoryStats[p.category_id] = (categoryStats[p.category_id] || 0) + 1;
                });
                
                console.log('📊 导入统计:', JSON.stringify(categoryStats, null, 2));
                console.log('📝 导入详情 (前5条):', JSON.stringify(phrasesToImport.slice(0, 5).map(p => ({
                    content: p.content.substring(0, 30) + '...',
                    category_id: p.category_id,
                    has_placeholders: p.has_placeholders,
                    placeholder_names: p.placeholder_names,
                    enable_placeholder: p.enable_placeholder,
                    images_count: (p.images || []).length,
                    enable_images: p.enable_images
                })), null, 2));
                
                // 🔧 去重检查：按分类去重，避免在同一分类内重复导入相同内容的话术
                // 🔄 注意：变形话术（parent_id 不为 null）不应该和主话术去重
                console.log('[LOG] 开始去重检查（按分类，排除变形话术）...');
                const existingPhrases = await db.getAllPhrases();
                
                // 按分类建立内容映射（只包含主话术，不包含变形话术）
                const existingContentsByCategory = new Map();
                existingPhrases.forEach(p => {
                    // 🔄 只检查主话术（parent_id 为 null），变形话术不参与去重
                    if (p.parent_id !== null && p.parent_id !== undefined) {
                        return; // 跳过变形话术
                    }
                    const catId = p.category_id;
                    if (!existingContentsByCategory.has(catId)) {
                        existingContentsByCategory.set(catId, new Set());
                    }
                    existingContentsByCategory.get(catId).add(p.content.trim());
                });
                
                // 分离主话术和变形话术
                const mainPhrasesToImport = phrasesToImport.filter(p => !p.parent_id || p.parent_id === null);
                const variantPhrasesToImport = phrasesToImport.filter(p => p.parent_id && p.parent_id !== null);
                
                // 只对主话术进行去重检查
                const uniqueMainPhrases = mainPhrasesToImport.filter(p => {
                    const content = p.content.trim();
                    const catId = p.category_id;
                    
                    // 检查该分类内是否已存在相同内容的主话术
                    if (existingContentsByCategory.has(catId) && 
                        existingContentsByCategory.get(catId).has(content)) {
                        console.log(`⚠️ 跳过重复主话术（分类${catId}）: ${content.substring(0, 30)}...`);
                        return false;
                    }
                    
                    // 添加到映射，防止导入数据内部在同一分类重复
                    if (!existingContentsByCategory.has(catId)) {
                        existingContentsByCategory.set(catId, new Set());
                    }
                    existingContentsByCategory.get(catId).add(content);
                    return true;
                });
                
                // 🔄 变形话术不过滤，直接导入（因为变形话术的 parent_id 不同，即使内容相同也是不同的话术）
                const uniquePhrasesToImport = [...uniqueMainPhrases, ...variantPhrasesToImport];
                
                console.log(`[LOG] 去重统计: 主话术 ${mainPhrasesToImport.length} -> ${uniqueMainPhrases.length}, 变形话术 ${variantPhrasesToImport.length} 条（不过滤）`);
                
                const skippedCount = phrasesToImport.length - uniquePhrasesToImport.length;
                if (skippedCount > 0) {
                    console.log(`⚠️ 已跳过 ${skippedCount} 条重复话术`);
                }
                
                if (uniquePhrasesToImport.length === 0) {
                    showToast('ℹ️ 没有新话术需要导入（所有话术已存在）', 'info');
                    return;
                }
                
                console.log(`[LOG] 开始导入 ${uniquePhrasesToImport.length} 条话术到数据库...`);
                const phraseIdMap = await db.importPhrases(uniquePhrasesToImport);
                console.log('[LOG] 话术导入完成，等待事务提交...');
                console.log(`[LOG] 话术ID映射表大小: ${phraseIdMap ? phraseIdMap.size : 0}`);
                
                // 🔧 等待一小段时间，确保数据库事务完成
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // 🔧 验证导入是否成功
                const allPhrasesAfterImport = await db.getAllPhrases();
                console.log('[LOG] 导入后话术总数:', allPhrasesAfterImport.length);
                
                // 🎯 统计导入的类目
                const allCategories = await db.getAllCategories();
                const importedCategoryNames = new Set();
                phrasesToImport.forEach(p => {
                    const cat = allCategories.find(c => c.id === p.category_id);
                    if (cat) importedCategoryNames.add(cat.name);
                });
                
                // 🆕 导入文本编辑器内容（如果有）
                if (isNewFormat && data.editor_contents) {
                    try {
                        console.log('📝 开始导入文本编辑器内容...');
                        console.log('📝 editor_contents 数据:', JSON.stringify(Object.keys(data.editor_contents)));
                        console.log('📝 categoryIdMap:', categoryIdMap ? `存在 (${categoryIdMap.size} 个映射)` : '不存在');
                        let editorCount = 0;
                        
                        // editor_contents 是一个对象，key是旧的分类ID，value是内容
                        for (const [oldCatId, content] of Object.entries(data.editor_contents)) {
                            // 找到对应的新分类ID
                            const oldId = parseInt(oldCatId);
                            const newId = categoryIdMap ? categoryIdMap.get(oldId) : oldId;
                            
                            console.log(`📝 映射: 旧分类ID ${oldId} -> 新分类ID ${newId}, 内容长度: ${content ? content.length : 0}`);
                            
                            if (newId && content) {
                                await db.setSetting(`category_text_${newId}`, content);
                                editorCount++;
                                console.log(`✅ 导入文本编辑器内容: 分类ID ${oldId} -> ${newId}`);
                            } else {
                                console.warn(`⚠️ 跳过: newId=${newId}, content=${content ? '有' : '无'}`);
                            }
                        }
                        
                        console.log(`✅ 文本编辑器内容导入完成，共 ${editorCount} 个`);
                    } catch (error) {
                        console.error('⚠️ 文本编辑器内容导入失败:', error);
                        // 不中断导入流程，继续执行
                    }
                }
                
                // 🆕 导入使用说明（如果有）
                if (isNewFormat && data.usage_guide) {
                    try {
                        await db.setSetting('usageGuide', data.usage_guide);
                        console.log('✅ 使用说明导入完成');
                    } catch (error) {
                        console.error('⚠️ 使用说明导入失败:', error);
                        // 不中断导入流程，继续执行
                    }
                }
                
                // 🆕 导入字幕设置（如果有）
                if (isNewFormat) {
                    try {
                        if (data.marquee_text !== undefined) {
                            await db.setSetting('marqueeText', data.marquee_text);
                            console.log('✅ 字幕内容导入完成');
                        }
                        if (data.marquee_enabled !== undefined) {
                            await db.setSetting('newShowMarquee', data.marquee_enabled);
                            console.log('✅ 字幕开关导入完成');
                        }
                    } catch (error) {
                        console.error('⚠️ 字幕设置导入失败:', error);
                        // 不中断导入流程，继续执行
                    }
                }
                
                // 🔄 导入变形话术数据（如果有）
                if (isNewFormat && data.variants_data && phraseIdMap) {
                    try {
                        console.log('🔄 开始导入变形话术数据...');
                        console.log(`🔄 variants_data 数据: ${Object.keys(data.variants_data).length} 个父话术的变形`);
                        let variantsCount = 0;
                        
                        // variants_data 是一个对象，key是旧的父话术ID，value是变形话术数组
                        for (const [oldParentId, variants] of Object.entries(data.variants_data)) {
                            const oldId = parseInt(oldParentId);
                            const newId = phraseIdMap.get(oldId);
                            
                            console.log(`🔄 映射变形话术: 旧父话术ID ${oldId} -> 新父话术ID ${newId}, 变形数量: ${variants ? variants.length : 0}`);
                            
                            if (newId && variants && Array.isArray(variants) && variants.length > 0) {
                                try {
                                    const storageKey = `variants_${newId}`;
                                    localStorage.setItem(storageKey, JSON.stringify(variants));
                                    variantsCount += variants.length;
                                    console.log(`✅ 导入变形话术: 父话术ID ${oldId} -> ${newId}, 数量: ${variants.length}`);
                                } catch (storageError) {
                                    console.error(`⚠️ 保存变形话术到localStorage失败 (parent_id=${newId}):`, storageError);
                                }
                            } else {
                                console.warn(`⚠️ 跳过变形话术: oldId=${oldId}, newId=${newId}, variants=${variants ? '有' : '无'}`);
                            }
                        }
                        
                        console.log(`✅ 变形话术数据导入完成，共 ${variantsCount} 条变形话术`);
                    } catch (error) {
                        console.error('⚠️ 变形话术数据导入失败:', error);
                        // 不中断导入流程，继续执行
                    }
                } else if (isNewFormat && data.variants_data) {
                    console.warn('⚠️ 有变形话术数据但缺少ID映射表，无法导入变形话术');
                }
                
                // 🎉 显示导入成功提示（包含详细信息）
                let successMessage = `✅ 成功导入 ${uniquePhrasesToImport.length} 条话术，${importedCategoryNames.size} 个类目`;
                if (skippedCount > 0) {
                    successMessage += `\n⚠️ 跳过 ${skippedCount} 条重复话术`;
                }
                if (isNewFormat) {
                    const extras = [];
                    if (data.editor_contents && Object.keys(data.editor_contents).length > 0) {
                        extras.push(`${Object.keys(data.editor_contents).length} 个文本编辑器`);
                    }
                    if (data.usage_guide) {
                        extras.push('使用说明');
                    }
                    if (data.marquee_text !== undefined) {
                        extras.push('字幕设置');
                    }
                    if (data.variants_data && Object.keys(data.variants_data).length > 0) {
                        const totalVariants = Object.values(data.variants_data).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
                        extras.push(`${totalVariants} 条变形话术`);
                    }
                    if (extras.length > 0) {
                        successMessage += `\n包含: ${extras.join('、')}`;
                    }
                }
                showToast(successMessage, 'success', 4000);
                console.log('[LOG] 导入的类目:', Array.from(importedCategoryNames));
                
                // 🔧 重新加载分类列表和话术列表
                await loadCategories();
                await loadPhrases();
                
                // 🔧 如果导入了字幕设置，立即应用
                if (isNewFormat && data.marquee_enabled !== undefined) {
                    const marqueeBar = document.getElementById('marqueeBar');
                    const newMarqueeToggle = document.getElementById('newMarqueeToggle');
                    if (marqueeBar && newMarqueeToggle) {
                        const isEnabled = data.marquee_enabled === 'true' || data.marquee_enabled === true;
                        newMarqueeToggle.checked = isEnabled;
                        if (isEnabled) {
                            marqueeBar.classList.remove('hidden');
                            if (data.marquee_text) {
                                updateMarqueeText(data.marquee_text);
                            }
                        } else {
                            marqueeBar.classList.add('hidden');
                        }
                        console.log('✅ 字幕设置已应用');
                    }
                }
                
                console.log('[LOG] 导入完成，界面已刷新');
            }
        } catch (error) {
            console.error('导入失败:', error);
            showToast('❌ 导入失败: ' + error.message, 'error');
        }
    };
    
    input.click();
}

// 导出话术
async function exportPhrases() {
    try {
        // 🎯 导出完整数据：分类 + 话术 + 文本编辑器内容 + 使用说明
        const categories = await db.getAllCategories();
        const phrases = await db.exportAllPhrases();
        
        // 🆕 导出文本编辑器内容
        const editorContents = {};
        for (const cat of categories) {
            const content = await db.getSetting(`category_text_${cat.id}`, '');
            console.log(`📝 检查分类 ${cat.id} (${cat.name}) 的文本编辑器内容:`, content ? `有内容 (${content.length}字符)` : '无内容');
            if (content) {
                editorContents[cat.id] = content;
            }
        }
        console.log(`📝 导出文本编辑器内容总数: ${Object.keys(editorContents).length} 个`);
        
        // 🆕 导出使用说明
        const usageGuide = await db.getSetting('usageGuide', '');
        
        // 🆕 导出字幕设置
        const marqueeText = await db.getSetting('marqueeText', '重要提醒：请确保在使用话术前仔细核对内容，避免发送错误信息！');
        const newShowMarquee = await db.getSetting('newShowMarquee', 'false');
        
        // 🔄 导出变形话术（从localStorage中读取）
        const variantsData = {};
        try {
            // 遍历所有localStorage的key，找出所有以 variants_ 开头的
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('variants_')) {
                    const parentId = key.replace('variants_', '');
                    try {
                        const variants = JSON.parse(localStorage.getItem(key) || '[]');
                        if (variants && variants.length > 0) {
                            variantsData[parentId] = variants;
                            console.log(`🔄 导出变形话术: parent_id=${parentId}, 数量=${variants.length}`);
                        }
                    } catch (e) {
                        console.warn(`⚠️ 解析变形话术失败 (key=${key}):`, e);
                    }
                }
            }
            console.log(`🔄 导出变形话术总数: ${Object.keys(variantsData).length} 个父话术的变形`);
        } catch (error) {
            console.error('⚠️ 导出变形话术时出错:', error);
        }
        
        // 构建完整的导出数据结构
        const exportData = {
            version: "2.0", // 新版本格式
            export_time: new Date().toISOString(),
            categories: categories.map(cat => ({
                id: cat.id,
                name: cat.name,
                parent_id: cat.parent_id || 0,
                sort_order: cat.sort_order || 0,
                show_text_editor: cat.show_text_editor || false,
                enable_alias: cat.enable_alias === true,
                alias: cat.alias || null
            })),
            phrases: phrases.map(phrase => ({
                id: phrase.id, // 🔄 导出话术ID，用于导入时建立映射（变形话术需要）
                content: phrase.content,
                content_html: phrase.content_html || null, // 🎨 HTML内容（包含部分样式）
                category_id: phrase.category_id,
                category: phrase.category_name, // 🔑 关键字段：分类名称（用于兼容）
                tags: phrase.tags,
                use_count: phrase.use_count,
                created_time: phrase.created_time,
                last_used: phrase.last_used,
                // 占位符相关字段
                has_placeholders: phrase.has_placeholders,
                placeholder_names: phrase.placeholder_names,
                enable_placeholder: phrase.enable_placeholder,
                // 图片相关字段
                images: phrase.images,
                enable_images: phrase.enable_images,
                // 使用说明相关字段
                enable_description: phrase.enable_description || false,
                description: phrase.description || '',
                // 🎨 样式相关字段
                text_color: phrase.text_color || null,
                bg_color: phrase.bg_color || null,
                is_bold: phrase.is_bold || false,
                // 🚫 点击复制开关
                disable_click_copy: phrase.disable_click_copy === true ? true : false,
                // 🗑️ 删除/回收站状态
                is_deleted: phrase.is_deleted === true,
                deleted_time: phrase.deleted_time || null,
                // 🔄 变形话术相关字段
                enable_variants: phrase.enable_variants || false,
                parent_id: phrase.parent_id || null, // 🔄 父话术ID（null表示主话术，数字表示是某个话术的变形）
                // 🔗 跳转相关字段
                jump_category_id: phrase.jump_category_id || null,
                // 标题卡片相关字段
                is_title: phrase.is_title === true,
                title_text: phrase.title_text || null,
                title_id: phrase.title_id === undefined ? null : phrase.title_id,
                is_collapsed: phrase.is_collapsed === true,
                show_text_editor: phrase.show_text_editor === true
            })),
            // 🆕 文本编辑器内容（按分类ID存储）
            editor_contents: editorContents,
            // 🆕 使用说明
            usage_guide: usageGuide,
            // 🆕 字幕设置
            marquee_text: marqueeText,
            marquee_enabled: newShowMarquee,
            // 🔄 变形话术数据（按父话术ID存储）
            variants_data: variantsData
        };
        
        const json = JSON.stringify(exportData, null, 2);
        
        const filename = `zhuoya-phrases-${new Date().toISOString().split('T')[0]}.json`;
        
        if (window.isDesktopApp && window.pythonBridge && typeof window.pythonBridge.handle_save_file_request === 'function') {
            try {
                console.log('[LOG] 尝试通过 Python 桥接保存文件...');
                const savedPath = await window.pythonBridge.handle_save_file_request(json, filename);
                if (savedPath) {
                    showToast(`✅ 话术已导出\n保存位置: ${savedPath}`, 'success', 6000);
                    return;
                }
                console.log('[LOG] 用户取消了保存或未返回路径');
                showToast('ℹ️ 导出已取消', 'info');
                return;
            } catch (bridgeError) {
                console.warn('[LOG] Python 桥接保存失败，改用备用方案:', bridgeError);
            }
        }
        
        // 备用方法：使用 Blob URL 下载
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
        
        // 在桌面版中尝试获取保存目录提示
        let fallbackDirectory = null;
        if (window.isDesktopApp && window.pythonBridge && typeof window.pythonBridge.get_last_export_directory === 'function') {
            try {
                fallbackDirectory = await window.pythonBridge.get_last_export_directory();
            } catch (dirError) {
                console.warn('[LOG] 获取导出目录失败:', dirError);
            }
        }
        
        // 统计导出信息
        const totalVariants = Object.values(variantsData).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
        const variantsInfo = totalVariants > 0 ? `\n包含 ${Object.keys(variantsData).length} 个话术的 ${totalVariants} 条变形话术` : '';
        
        if (window.isDesktopApp) {
            const directoryMsg = fallbackDirectory
                ? `文件已保存到: ${fallbackDirectory}`
                : '文件已保存到下载目录';
            showToast(`✅ 话术已导出${variantsInfo}\n${directoryMsg}\n文件名: ${filename}`, 'success', 6000);
        } else {
            showToast(`✅ 话术已导出${variantsInfo}`, 'success', 4000);
        }
    } catch (error) {
        console.error('导出失败:', error);
        showToast('❌ 导出失败: ' + error.message, 'error');
    }
}

// 加载标题卡片折叠开关
async function loadTitleCollapseSettings() {
    try {
        enableTitleCollapseSetting = await db.getSetting('enableTitleCollapse', 'false');
        const checkbox = document.getElementById('enableTitleCollapse');
        if (checkbox) {
            checkbox.checked = (enableTitleCollapseSetting === 'true' || enableTitleCollapseSetting === true);
            // 重新绑定事件（避免重复绑定）
            const cloned = checkbox.cloneNode(true);
            checkbox.parentNode.replaceChild(cloned, checkbox);
            cloned.checked = (enableTitleCollapseSetting === 'true' || enableTitleCollapseSetting === true);
            cloned.addEventListener('change', () => {
                console.log('🧩 标题折叠开关被点击, checked =', cloned.checked);
                saveTitleCollapseSettings(cloned.checked);
            });
        }
    } catch (error) {
        console.error('❌ 加载标题折叠设置失败:', error);
    }
}

// 加载限制二级分类容器高度设置
async function loadLimitSubcategoryHeightSettings() {
    try {
        const limitSetting = await db.getSetting('limitSubcategoryHeight', 'true');
        const checkbox = document.getElementById('limitSubcategoryHeight');
        if (checkbox) {
            checkbox.checked = limitSetting === 'true';
            // 防止重复绑定：替换节点
            const cloned = checkbox.cloneNode(true);
            checkbox.parentNode.replaceChild(cloned, checkbox);
            cloned.checked = limitSetting === 'true';
            cloned.addEventListener('change', () => {
                console.log('📏 限制二级分类容器高度开关被点击, checked =', cloned.checked);
                saveLimitSubcategoryHeightSettings(cloned.checked);
            });
        }
    } catch (error) {
        console.error('❌ 加载限制二级分类容器高度设置失败:', error);
    }
}

// 保存限制二级分类容器高度设置
async function saveLimitSubcategoryHeightSettings(isChecked) {
    try {
        const value = isChecked ? 'true' : 'false';
        await db.setSetting('limitSubcategoryHeight', value);
        console.log('✅ 已保存 limitSubcategoryHeight =', value);
        // 重新渲染话术列表以应用设置
        await loadPhrases(true);
    } catch (error) {
        console.error('❌ 保存限制二级分类容器高度设置失败:', error);
        showToast('❌ 保存设置失败', 'error');
    }
}

// 保存标题卡片折叠开关
async function saveTitleCollapseSettings(isChecked) {
    try {
        enableTitleCollapseSetting = isChecked ? 'true' : 'false';
        await db.setSetting('enableTitleCollapse', enableTitleCollapseSetting);
        try {
            const saved = await db.getSetting('enableTitleCollapse', enableTitleCollapseSetting);
            enableTitleCollapseSetting = saved;
        } catch (e) {
            // ignore
        }
        console.log('✅ 标题折叠设置已保存:', enableTitleCollapseSetting);
        showToast(isChecked ? '✅ 已开启标题折叠' : 'ℹ️ 已关闭标题折叠');
        // 重新渲染话术列表以应用最新折叠行为
        await loadPhrases(true);
    } catch (error) {
        console.error('❌ 保存标题折叠设置失败:', error);
        showToast('❌ 保存标题折叠设置失败', 'error');
    }
}

// 加载设置
async function loadSettings() {
    console.log('📖 开始加载设置...');
    
    // 🔧 简化设置：只保留字幕相关设置
    const showMarquee = await db.getSetting('showMarquee', 'false'); // 默认不显示字幕
    const marqueeText = await db.getSetting('marqueeText', '重要提醒：请确保在使用话术前仔细核对内容，避免发送错误信息！');
    
    console.log('📖 从数据库加载的设置:', {
        showMarquee,
        marqueeText
    });
    
    // 滚动字幕显示控制
    const showMarqueeCheckbox = document.getElementById('showMarquee');
    const marqueeBar = document.getElementById('marqueeBar');
    
    console.log('🔍 字幕控制调试:', {
        showMarqueeCheckbox: !!showMarqueeCheckbox,
        marqueeBar: !!marqueeBar,
        showMarquee: showMarquee,
        shouldShow: showMarquee === 'true'
    });
    
    if (showMarqueeCheckbox) {
        showMarqueeCheckbox.checked = showMarquee === 'true';
        console.log('✅ 复选框状态已设置:', showMarqueeCheckbox.checked);
    }
    
    if (marqueeBar) {
        console.log('📍 字幕栏当前类名:', marqueeBar.className);
        
        if (showMarquee === 'true') {
            console.log('✅ 显示字幕');
            marqueeBar.classList.remove('hidden');
            // 只有在显示字幕时才更新内容
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    updateMarqueeText(marqueeText);
                });
            } else {
                updateMarqueeText(marqueeText);
            }
        } else {
            console.log('❌ 隐藏字幕');
            marqueeBar.classList.add('hidden');
            // 隐藏时清理字幕资源
            if (window.MarqueeManager) {
                window.MarqueeManager.cleanup();
            }
        }
        
        console.log('📍 字幕栏更新后类名:', marqueeBar.className);
    } else {
        console.error('❌ 未找到字幕栏元素 #marqueeBar');
    }
    
    console.log('✅ 设置已应用到界面');
}

// 保存设置
async function saveSettings() {
    const showMarquee = document.getElementById('showMarquee')?.checked ?? false;
    // 字幕内容现在通过点击字幕编辑，不再从输入框获取
    const marqueeText = await db.getSetting('marqueeText', '重要提醒：请确保在使用话术前仔细核对内容，避免发送错误信息！');
    
    console.log('📝 保存设置 - 开始:', {
        showMarquee,
        showMarqueeType: typeof showMarquee,
        marqueeText
    });
    
    await db.setSetting('showMarquee', showMarquee.toString());
    await db.setSetting('marqueeText', marqueeText);
    
    console.log('💾 已保存到数据库:', {
        showMarquee: showMarquee.toString()
    });
    
    // 更新滚动字幕显示状态和内容
    const marqueeBar = document.getElementById('marqueeBar');
    if (marqueeBar) {
        console.log('📍 保存时字幕栏当前类名:', marqueeBar.className);
        
        if (showMarquee) {
            console.log('✅ 用户勾选了字幕，显示字幕');
            // 先显示，避免闪烁
            marqueeBar.classList.remove('hidden');
            // 延迟更新内容，避免卡顿
            setTimeout(() => {
                updateMarqueeText(marqueeText);
            }, 100);
        } else {
            console.log('❌ 用户取消勾选字幕，隐藏字幕');
            // 先清理资源，再隐藏
            if (window.MarqueeManager) {
                window.MarqueeManager.cleanup();
            }
            marqueeBar.classList.add('hidden');
        }
        
        console.log('📍 保存后字幕栏类名:', marqueeBar.className);
    }
    
    console.log('✅ 所有设置已保存到数据库');
    
    showToast('✅ 设置已保存');
}

// 更新字幕内容显示
function updateMarqueeText(text) {
    if (!text || text.trim() === '') {
        text = '重要提醒：请确保在使用话术前仔细核对内容，避免发送错误信息！';
    }
    
    // 使用 MarqueeManager 更新字幕内容
    if (window.MarqueeManager) {
        window.MarqueeManager.update(text);
    } else {
        console.warn('MarqueeManager 未加载，无法更新字幕');
    }
}

// 显示数据诊断对话框
async function showDiagnosticDialog() {
    console.log('[LOG] showDiagnosticDialog : function');
    console.log('[LOG] 开始 showDiagnosticDialog');
    console.log('[LOG] 开始获取数据...');
    
    try {
        const allPhrases = await db.getAllPhrases();
        console.log('[LOG] 获取话术成功:', allPhrases.length);
        
        const allCategories = await db.getAllCategories();
        console.log('[LOG] 获取分类成功:', allCategories.length);
        // 🔧 确保 allCategories 是数组（即使为空）
        if (!Array.isArray(allCategories)) {
            console.warn('[LOG] 警告: getAllCategories 返回的不是数组:', typeof allCategories);
            // 如果返回的不是数组，转换为数组
            if (allCategories === null || allCategories === undefined) {
                allCategories = [];
            } else {
                allCategories = Array.isArray(allCategories) ? allCategories : [];
            }
        }
        
        const deletedPhrases = await db.getDeletedPhrases();
        console.log('[LOG] 获取回收站话术成功:', deletedPhrases.length);
    
    // 🔍 查找孤儿话术 (category_id=0 或 null)
    const orphanPhrases = allPhrases.filter(p => p.category_id === 0 || p.category_id === null);
    
    // 🔍 查找引用不存在分类的话术
    const categoryIds = new Set(allCategories.map(c => c.id));
    const brokenPhrases = allPhrases.filter(p => 
        p.category_id && p.category_id !== 0 && !categoryIds.has(p.category_id)
    );
    
    let diagnosticHtml = `
        <div style="padding: 20px; max-height: 500px; overflow-y: auto;">
            <h3 style="margin-top: 0;">📊 数据诊断报告</h3>
            
            <div style="margin-bottom: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px;">
                <h4 style="margin-top: 0;">📈 数据统计</h4>
                <p><strong>总话术数：</strong>${allPhrases.length} 条</p>
                <p><strong>总分类数：</strong>${allCategories.length} 个</p>
                <p><strong>回收站话术：</strong>${deletedPhrases.length} 条</p>
            </div>
    `;
    
    if (orphanPhrases.length > 0 || brokenPhrases.length > 0) {
        diagnosticHtml += `
            <div style="margin-bottom: 20px; padding: 15px; background: #fff3cd; border-radius: 8px; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0; color: #856404;">⚠️ 发现问题</h4>
        `;
        
        if (orphanPhrases.length > 0) {
            diagnosticHtml += `
                <div style="margin-bottom: 15px;">
                    <p><strong>📦 未分类话术：</strong>${orphanPhrases.length} 条</p>
                    <p style="font-size: 12px; color: #666;">这些话术没有分配到任何分类（category_id=0）</p>
                    <button id="fixOrphanBtn" class="btn btn-warning" style="margin-top: 10px;">
                        🔧 修复：分配到第一个分类
                    </button>
                    <p style="font-size: 11px; color: #999; margin-top: 5px;">
                        提示：你也可以在左侧导航中点击"📦 未分类"查看这些话术
                    </p>
                </div>
            `;
        }
        
        if (brokenPhrases.length > 0) {
            diagnosticHtml += `
                <div style="margin-bottom: 15px;">
                    <p><strong>🔗 分类引用错误：</strong>${brokenPhrases.length} 条</p>
                    <p style="font-size: 12px; color: #666;">这些话术引用了不存在的分类ID</p>
                    <button id="fixBrokenBtn" class="btn btn-warning" style="margin-top: 10px;">
                        🔧 修复：重置为第一个分类
                    </button>
                </div>
            `;
        }
        
        diagnosticHtml += `</div>`;
    } else {
        diagnosticHtml += `
            <div style="padding: 15px; background: #d4edda; border-radius: 8px; border-left: 4px solid #28a745;">
                <p style="margin: 0; color: #155724;"><strong>✅ 数据完好</strong></p>
                <p style="margin: 5px 0 0 0; font-size: 12px; color: #155724;">未发现数据异常</p>
            </div>
        `;
    }
    
    diagnosticHtml += `
            <div style="margin-top: 20px; padding: 15px; background: #e7f3ff; border-radius: 8px;">
                <h4 style="margin-top: 0;">💡 提示</h4>
                <ul style="margin: 0; padding-left: 20px; font-size: 13px;">
                    <li>导出话术时会包含分类名称，方便在其他浏览器导入</li>
                    <li>导入话术时会自动匹配或创建分类</li>
                    <li>删除的话术会进入回收站，可以恢复或永久删除</li>
                    <li><strong>数据存储位置：</strong>IndexedDB（持久化存储，重新加载插件不会丢失）</li>
                </ul>
            </div>
            
            <div style="margin-top: 20px; padding: 15px; background: #fff5f5; border-radius: 8px; border-left: 4px solid #dc3545;">
                <h4 style="margin-top: 0; color: #721c24;">🗑️ 危险操作</h4>
                <p style="font-size: 13px; color: #721c24; margin-bottom: 10px;">
                    清除所有数据将删除所有话术和分类（不包括回收站），此操作<strong>不可恢复</strong>！
                </p>
                <button id="clearAllDataBtn" class="btn btn-danger" style="background: #dc3545; color: white;">
                    ⚠️ 清除所有数据
                </button>
            </div>
        </div>
    `;
    
    console.log('开始构建对话框 HTML...');
    
    const dialogHtml = `
        <div class="modal-backdrop" id="diagnosticBackdrop">
            <div class="modal-content" style="max-width: 600px;">
                ${diagnosticHtml}
                <div class="dialog-actions" style="margin-top: 20px; text-align: right;">
                    <button class="btn" id="closeDiagnosticBtn">关闭</button>
                </div>
            </div>
        </div>
    `;
    
    console.log('[LOG] 对话框 HTML 构建完成，长度:', dialogHtml.length);
    
    const container = document.createElement('div');
    // 🔧 使用 textContent 和 innerHTML 组合，确保中文正确显示
    container.innerHTML = dialogHtml;
    console.log('[LOG] 容器创建完成，准备添加到 body...');
    
    document.body.appendChild(container);
    console.log('[LOG] 对话框已添加到 DOM');
    console.log('[LOG] body 子元素数量:', document.body.children.length);
    
    // 🔧 确保对话框显示
    const backdrop = container.querySelector('#diagnosticBackdrop');
    if (backdrop) {
        backdrop.style.display = 'flex';
        console.log('[LOG] 对话框已显示');
    } else {
        console.error('[LOG] 错误: 找不到对话框元素');
    }
    
    // 绑定关闭按钮
    const closeBtn = container.querySelector('#closeDiagnosticBtn');
    
    const closeDialog = () => {
        container.remove();
    };
    
    if (closeBtn) {
        closeBtn.addEventListener('click', closeDialog);
    } else {
        console.error('[LOG] 错误: 找不到关闭按钮');
    }
    
    if (backdrop) {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeDialog();
        });
    }
    
    // 修复孤儿话术按钮
    const fixOrphanBtn = document.getElementById('fixOrphanBtn');
    if (fixOrphanBtn) {
        fixOrphanBtn.addEventListener('click', async () => {
            if (!confirm(`确定要将 ${orphanPhrases.length} 条未分类话术分配到第一个分类吗？`)) {
                return;
            }
            
            fixOrphanBtn.disabled = true;
            fixOrphanBtn.textContent = '修复中...';
            
            try {
                // 获取第一个非回收站的分类
                const targetCategory = allCategories.find(c => c.id !== 1);
                if (!targetCategory) {
                    showToast('❌ 没有可用的分类', 'error');
                    return;
                }
                
                // 更新所有孤儿话术
                for (const phrase of orphanPhrases) {
                    await db.updatePhrase(phrase.id, {
                        ...phrase,
                        category_id: targetCategory.id
                    });
                }
                
                showToast(`✅ 已将 ${orphanPhrases.length} 条话术分配到"${targetCategory.name}"`);
                closeDialog();
                await loadCategories();
                await loadPhrases();
            } catch (error) {
                console.error('修复失败:', error);
                showToast('❌ 修复失败: ' + error.message, 'error');
                fixOrphanBtn.disabled = false;
                fixOrphanBtn.textContent = '🔧 修复：分配到第一个分类';
            }
        });
    }
    
    // 修复错误引用按钮
    const fixBrokenBtn = document.getElementById('fixBrokenBtn');
    if (fixBrokenBtn) {
        fixBrokenBtn.addEventListener('click', async () => {
            if (!confirm(`确定要修复 ${brokenPhrases.length} 条引用错误的话术吗？`)) {
                return;
            }
            
            fixBrokenBtn.disabled = true;
            fixBrokenBtn.textContent = '修复中...';
            
            try {
                // 获取第一个非回收站的分类
                const targetCategory = allCategories.find(c => c.id !== 1);
                if (!targetCategory) {
                    showToast('❌ 没有可用的分类', 'error');
                    return;
                }
                
                // 更新所有错误引用的话术
                for (const phrase of brokenPhrases) {
                    await db.updatePhrase(phrase.id, {
                        ...phrase,
                        category_id: targetCategory.id
                    });
                }
                
                showToast(`✅ 已修复 ${brokenPhrases.length} 条话术`);
                closeDialog();
                await loadCategories();
                await loadPhrases();
            } catch (error) {
                console.error('修复失败:', error);
                showToast('❌ 修复失败: ' + error.message, 'error');
                fixBrokenBtn.disabled = false;
                fixBrokenBtn.textContent = '🔧 修复：重置为第一个分类';
            }
        });
    }
    
    // 清除所有数据按钮（只保留回收站）
    const clearAllDataBtn = document.getElementById('clearAllDataBtn');
    if (clearAllDataBtn) {
        clearAllDataBtn.addEventListener('click', async () => {
            const confirmText = '清除所有数据';
            const userInput = prompt(
                `⚠️ 此操作将删除所有话术和分类，只保留回收站：\n\n` +
                `这是一个不可恢复的操作！\n\n` +
                `如果确定要继续，请输入："${confirmText}"`
            );
            
            if (userInput !== confirmText) {
                if (userInput !== null) {
                    showToast('❌ 输入不正确，操作已取消', 'error');
                }
                return;
            }
            
            clearAllDataBtn.disabled = true;
            clearAllDataBtn.textContent = '清除中...';
            
            try {
                // 调用数据库的清空函数
                const result = await db.clearAllPhrasesAndResetCategories();
                
                showToast(`✅ 已清除 ${result.phrasesDeleted} 条话术和 ${result.categoriesDeleted} 个分类，只保留回收站`);
                closeDialog();
                await loadCategories();
                await loadPhrases();
            } catch (error) {
                console.error('清除数据失败:', error);
                showToast('❌ 清除数据失败: ' + error.message, 'error');
                clearAllDataBtn.disabled = false;
                clearAllDataBtn.textContent = '⚠️ 清除所有数据';
            }
        });
    }
    
    console.log('🎉 showDiagnosticDialog 执行完成！');
    
    } catch (error) {
        console.error('❌ showDiagnosticDialog 执行出错:', error);
        console.error('错误堆栈:', error.stack);
        alert('打开诊断对话框时出错：\n' + error.message + '\n\n请查看 Console 获取详细信息');
    }
}

// 将 Python 桥方法封装为 Promise（兼容 QWebChannel 的回调风格）
function callPythonCopy(text) {
    return new Promise((resolve) => {
        try {
            if (!window.pythonBridge || typeof window.pythonBridge.copy_text !== 'function') {
                return resolve(false);
            }
            const fn = window.pythonBridge.copy_text;
            // QWebChannel 生成的方法通常接受 (args..., callback)
            if (fn.length >= 2) {
                fn.call(window.pythonBridge, text, (ok) => resolve(!!ok));
            } else {
                // 某些实现可能直接返回布尔值
                const ret = fn.call(window.pythonBridge, text);
                if (typeof ret === 'boolean') return resolve(ret);
                // 无返回值时，认为成功
                resolve(true);
            }
        } catch (_) {
            resolve(false);
        }
    });
}

// 从 Python 桥读取剪贴板文本
function callPythonGetText() {
    return new Promise((resolve) => {
        try {
            if (!window.pythonBridge || typeof window.pythonBridge.get_text !== 'function') {
                return resolve(null);
            }
            const fn = window.pythonBridge.get_text;
            // QWebChannel 生成的方法通常接受 (callback)
            if (fn.length >= 1) {
                fn.call(window.pythonBridge, (text) => resolve(text || ""));
            } else {
                // 某些实现可能直接返回字符串
                const ret = fn.call(window.pythonBridge);
                resolve(ret || "");
            }
        } catch (_) {
            resolve(null);
        }
    });
}

// 从 Python 桥读取剪贴板HTML
function callPythonGetHtml() {
    return new Promise((resolve) => {
        try {
            if (!window.pythonBridge || typeof window.pythonBridge.get_html !== 'function') {
                return resolve(null);
            }
            const fn = window.pythonBridge.get_html;
            // QWebChannel 生成的方法通常接受 (callback)
            if (fn.length >= 1) {
                fn.call(window.pythonBridge, (html) => resolve(html || null));
            } else {
                // 某些实现可能直接返回字符串
                const ret = fn.call(window.pythonBridge);
                resolve(ret || null);
            }
        } catch (_) {
            resolve(null);
        }
    });
}

// 通用剪贴板读取函数（优先调用 Python 桥，兼容 PyQt6 WebEngine）
async function readFromClipboard() {
    // 方法0: 优先通过 Python 桥读取，最可靠（等待桥接就绪，最多重试10次）
    try {
        for (let i = 0; i < 10; i++) {
            if (window.pythonBridge && typeof window.pythonBridge.get_text === 'function') {
                const text = await callPythonGetText();
                if (text !== null) {
                    console.log('[LOG] 通过 Python 桥读取剪贴板成功，长度:', text.length);
                    return text;
                }
                break; // 桥接在，但读取失败，跳过后续重试
            }
            await new Promise(r => setTimeout(r, 50));
        }
    } catch (e) {
        console.log('[LOG] Python 桥读取失败，尝试 Clipboard API:', e);
    }

    // 方法1: 现代 Clipboard API
    if (navigator.clipboard && navigator.clipboard.readText) {
        try {
            const text = await navigator.clipboard.readText();
            console.log('[LOG] 通过 Clipboard API 读取剪贴板成功，长度:', text ? text.length : 0);
            return text || "";
        } catch (error) {
            console.log('[LOG] Clipboard API 读取失败:', error);
        }
    }
    
    // 无法读取剪贴板
    console.warn('[LOG] 所有剪贴板读取方法都失败');
    return null;
}

// 读取剪贴板HTML格式（优先调用 Python 桥，兼容 PyQt6 WebEngine）
async function readFromClipboardAsHtml() {
    // 方法0: 优先通过 Python 桥读取HTML，最可靠（等待桥接就绪，最多重试10次）
    try {
        for (let i = 0; i < 10; i++) {
            if (window.pythonBridge && typeof window.pythonBridge.get_html === 'function') {
                const html = await callPythonGetHtml();
                if (html !== null && html !== "") {
                    console.log('[LOG] 通过 Python 桥读取剪贴板HTML成功，长度:', html.length);
                    return html;
                }
                break; // 桥接在，但读取失败或为空，跳过后续重试
            }
            await new Promise(r => setTimeout(r, 50));
        }
    } catch (e) {
        console.log('[LOG] Python 桥读取HTML失败，尝试 Clipboard API:', e);
    }

    // 方法1: 现代 Clipboard API（读取HTML格式）
    if (navigator.clipboard && navigator.clipboard.read) {
        try {
            const clipboardItems = await navigator.clipboard.read();
            for (const clipboardItem of clipboardItems) {
                for (const type of clipboardItem.types) {
                    if (type === 'text/html') {
                        const blob = await clipboardItem.getType(type);
                        const html = await blob.text();
                        if (html) {
                            console.log('[LOG] 通过 Clipboard API 读取HTML成功，长度:', html.length);
                            return html;
                        }
                    }
                }
            }
        } catch (error) {
            console.log('[LOG] Clipboard API 读取HTML失败:', error);
        }
    }
    
    // 没有HTML格式，返回null（调用方会回退到纯文本）
    return null;
}

// 通用剪贴板复制函数（优先调用 Python 桥，兼容 PyQt6 WebEngine）
async function copyToClipboard(text) {
    // 方法0: 优先通过 Python 桥复制，最可靠（等待桥接就绪，最多重试10次）
    try {
        for (let i = 0; i < 10; i++) {
            if (window.pythonBridge && typeof window.pythonBridge.copy_text === 'function') {
                const ok = await callPythonCopy(text);
                if (ok) return true;
                break; // 桥接在，但复制失败，跳过后续重试
            }
            await new Promise(r => setTimeout(r, 50));
        }
    } catch (e) {
        // 忽略并继续尝试后续方法
    }

    // 方法1: 现代 Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            // 继续尝试备用方法
        }
    }
    
    // 方法2: document.execCommand
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return !!success;
    } catch (error) {
        return false;
    }
}

async function tryAutoFocusAfterCopy() {
    try {
        const enabled = await db.getSetting('autoFocusAfterCopy', 'false');
        if (enabled !== 'true') return;
    } catch (e) {
        return;
    }

    try {
        // Best-effort desktop mode: paste to the last external focused window (tracked in Python).
        // 需求：就算失败，也不要把焦点抢回本应用输入框。
        if (window.pythonBridge && typeof window.pythonBridge.paste_to_last_external === 'function') {
            const ok = await window.pythonBridge.paste_to_last_external();
            if (ok) return;
        }

        // No-op on failure.
        return;
    } catch (e) {
        // ignore
    }
}

// 显示提示消息
function showToast(message, type = 'success', duration = 700) {
    // 复用单例，避免短时间内出现两个提示造成“卡跳”视觉
    if (!window.__toastEl) {
        window.__toastEl = document.createElement('div');
        window.__toastEl.className = 'toast';
        document.body.appendChild(window.__toastEl);
    }
    const el = window.__toastEl;
    // 重置状态
    el.className = 'toast';
    if (type) el.classList.add(`toast-${type}`);
    el.textContent = message;
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';

    // 清理旧计时器
    if (window.__toastTimer) {
        clearTimeout(window.__toastTimer);
        window.__toastTimer = null;
    }
    // 使用自定义显示时长，默认3秒
    window.__toastTimer = setTimeout(() => {
        el.classList.add('toast-hide');
        // 等动画结束后不移除节点，保留单例以便下次快速复用
    }, duration);
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 生成安全的正则（转义特殊字符）
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 高亮匹配的关键词（在已转义的 HTML 文本上替换）
function highlightText(rawText, keyword) {
    if (!keyword) return escapeHtml(rawText);
    const escaped = escapeHtml(rawText);
    try {
        const pattern = new RegExp(escapeRegex(keyword), 'gi');
        return escaped.replace(pattern, (m) => `<mark class="search-highlight">${m}</mark>`);
    } catch (e) {
        // 正则异常时，回退为不高亮
        return escaped;
    }
}

// 在HTML内容中高亮搜索关键词（保留HTML标签）
function highlightTextInHtml(htmlContent, keyword) {
    if (!keyword || !htmlContent) return htmlContent;
    try {
        // 创建一个临时容器来解析HTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        
        // 递归处理所有文本节点
        function highlightNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                const pattern = new RegExp(escapeRegex(keyword), 'gi');
                if (pattern.test(text)) {
                    const highlighted = text.replace(pattern, (m) => `<mark class="search-highlight">${m}</mark>`);
                    const tempSpan = document.createElement('span');
                    tempSpan.innerHTML = highlighted;
                    const fragment = document.createDocumentFragment();
                    while (tempSpan.firstChild) {
                        fragment.appendChild(tempSpan.firstChild);
                    }
                    node.parentNode.replaceChild(fragment, node);
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                // 递归处理子节点（从后往前，避免索引问题）
                const children = Array.from(node.childNodes);
                children.forEach(child => highlightNode(child));
            }
        }
        
        highlightNode(tempDiv);
        return tempDiv.innerHTML;
    } catch (e) {
        console.error('HTML高亮失败:', e);
        return htmlContent;
    }
}

// 🎨 切换主题
async function changeTheme(theme) {
    console.log('[LOG] ========== 开始切换主题 ==========');
    console.log('[LOG] 目标主题:', theme);
    try {
        const themeClass = `theme-${theme}`;
        // 更新侧边栏的主题类
        const sidebar = document.querySelector('.sidebar');
        const container = document.querySelector('.container');
        const body = document.body;
        console.log('[LOG] DOM 元素查找完成 - sidebar:', !!sidebar, 'container:', !!container, 'body:', !!body);
        
        if (sidebar) {
            applyThemeClass(sidebar, themeClass);
        }
        
        // 同时也给容器添加主题类，这样搜索框等元素也能应用主题
        if (container) {
            applyThemeClass(container, themeClass);
        }
        
        // 🔥 给 body 也添加主题类，这样对话框等全局元素也能应用主题
        if (body) {
            applyThemeClass(body, themeClass);
        }
        
        // 🔧 给标签页栏也添加主题类
        const tabsBar = document.querySelector('.customer-tabs-bar');
        if (tabsBar) {
            applyThemeClass(tabsBar, themeClass);
        }
        
        // 🔄 同步已有的二级分类弹层主题
        document.querySelectorAll('.subcategory-popover').forEach(popover => {
            applyThemeClass(popover, themeClass);
        });
        
        // 🔄 同步文本编辑器主题
        const textEditor = document.getElementById('categoryTextEditor');
        if (textEditor) {
            applyThemeClass(textEditor, themeClass);
        }
        
        // 更新色块的激活状态
        const themeColorBoxes = document.querySelectorAll('.theme-color-box');
        themeColorBoxes.forEach(box => {
            if (box.dataset.theme === theme) {
                box.classList.add('active');
            } else {
                box.classList.remove('active');
            }
        });
        
        // 🔧 保存主题选择到数据库（桌面版使用数据库而不是chrome.storage）
        console.log('[LOG] 准备保存主题到数据库...');
        // 确保数据库已初始化
        if (!db.db) {
            console.warn('[LOG] 警告: 数据库未初始化，等待初始化...');
            await db.init();
            console.log('[LOG] 数据库初始化完成');
        }
        
        console.log('[LOG] 调用 db.setSetting("selectedTheme", "' + theme + '")...');
        await db.setSetting('selectedTheme', theme);
        console.log('[LOG] ✅ 主题已保存到数据库:', theme);

        // 同步保存到 localStorage，防止 IndexedDB 在某些环境下不可用
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem('selectedTheme', theme);
                console.log('[LOG] 主题已写入 localStorage 作为备用');
            } catch (storageError) {
                console.warn('[LOG] 写入 localStorage 失败:', storageError);
            }
        }
        
        // 🔧 验证保存是否成功（延迟验证，确保事务完成）
        console.log('[LOG] 设置延迟验证（100ms 后）...');
        setTimeout(async () => {
            console.log('[LOG] 开始验证保存的主题...');
            const savedTheme = await db.getSetting('selectedTheme', 'purple');
            console.log('[LOG] 验证结果 - 保存值:', savedTheme, '期望值:', theme);
            if (savedTheme !== theme) {
                console.warn('[LOG] ⚠️ 警告: 主题保存后验证失败，保存值:', savedTheme, '期望值:', theme);
                // 重试保存
                console.log('[LOG] 重试保存主题...');
                await db.setSetting('selectedTheme', theme);
                console.log('[LOG] ✅ 已重试保存主题');
            } else {
                console.log('[LOG] ✅ 主题验证成功！');
            }
        }, 100);
        console.log('[LOG] ========== 主题切换完成 ==========');
    } catch (error) {
        console.error('[LOG] ❌ 切换主题失败:', error);
        console.error('[LOG] 错误堆栈:', error.stack);
    }
}

// 🎨 恢复主题设置
async function restoreTheme() {
    try {
        // 🔧 从数据库读取主题设置（桌面版使用数据库而不是chrome.storage）
        let theme = await db.getSetting('selectedTheme', null);
        if (!theme && typeof localStorage !== 'undefined') {
            theme = localStorage.getItem('selectedTheme');
        }
        if (!theme) {
            theme = 'purple';
            console.log('[LOG] 主题未设置，回退到默认主题');
        } else {
            console.log('[LOG] 恢复主题:', theme);
            if (typeof localStorage !== 'undefined') {
                try {
                    localStorage.setItem('selectedTheme', theme);
                } catch (storageError) {
                    console.warn('[LOG] 同步 localStorage 失败:', storageError);
                }
            }
        }
        
        // 应用主题（不保存，因为已经是从数据库读取的）
        const sidebar = document.querySelector('.sidebar');
        const container = document.querySelector('.container');
        const body = document.body;
        const themeClass = `theme-${theme}`;
        
        if (sidebar) {
            applyThemeClass(sidebar, themeClass);
        }
        
        if (container) {
            applyThemeClass(container, themeClass);
        }
        
        if (body) {
            applyThemeClass(body, themeClass);
        }
        
        // 🔧 给标签页栏也添加主题类
        const tabsBar = document.querySelector('.customer-tabs-bar');
        if (tabsBar) {
            applyThemeClass(tabsBar, themeClass);
        } else {
            console.warn('[LOG] 警告: customer-tabs-bar 元素未找到，主题可能无法应用到标签页栏');
        }
        
        // 🔄 同步已有的二级分类弹层主题
        document.querySelectorAll('.subcategory-popover').forEach(popover => {
            applyThemeClass(popover, themeClass);
        });
        
        // 🔄 同步文本编辑器主题
        const textEditor = document.getElementById('categoryTextEditor');
        if (textEditor) {
            applyThemeClass(textEditor, themeClass);
        }
        
        // 更新色块的激活状态
        const themeColorBoxes = document.querySelectorAll('.theme-color-box');
        themeColorBoxes.forEach(box => {
            if (box.dataset.theme === theme) {
                box.classList.add('active');
            } else {
                box.classList.remove('active');
            }
        });
        
        console.log('[LOG] 恢复主题设置完成:', theme);
        console.log('[LOG] 应用主题的元素:', {
            sidebar: !!sidebar,
            container: !!container,
            body: !!body,
            tabsBar: !!tabsBar
        });
    } catch (error) {
        console.error('恢复主题设置失败:', error);
        // 如果出错，使用默认紫色主题
        const sidebar = document.querySelector('.sidebar');
        const container = document.querySelector('.container');
        const body = document.body;
        if (sidebar) sidebar.classList.add('theme-purple');
        if (container) container.classList.add('theme-purple');
        if (body) body.classList.add('theme-purple');
    }
}

// ==================== 字体大小调节功能 ====================

// 字体大小级别
const FONT_SIZES = ['normal', 'large', 'xl', 'xxl', 'xxxl'];
const FONT_SIZE_NAMES = {
    'normal': '标准',
    'large': '大',
    'xl': '超大',
    'xxl': '最大',
    'xxxl': '特大'
};

// 获取当前字体大小
function getCurrentFontSize() {
    const currentSize = document.body.getAttribute('data-phrase-font-size') || 'normal';
    return currentSize;
}

// 设置字体大小
async function setFontSize(size) {
    try {
        if (!FONT_SIZES.includes(size)) {
            size = 'normal';
        }
        document.body.setAttribute('data-phrase-font-size', size);
        
        // 保存到本地存储
        await chrome.storage.local.set({ phraseFontSize: size });
        
        // 显示提示
        const sizeName = FONT_SIZE_NAMES[size] || size;
        showToast(`✅ 字体已调整为 ${sizeName}`);
        
        console.log('✅ 字体大小已设置为:', size);
    } catch (error) {
        console.error('设置字体大小失败:', error);
    }
}

// 缩小字体
async function decreaseFontSize() {
    const currentSize = getCurrentFontSize();
    const currentIndex = FONT_SIZES.indexOf(currentSize);
    
    if (currentIndex > 0) {
        const newSize = FONT_SIZES[currentIndex - 1];
        await setFontSize(newSize);
    } else {
        showToast('⚠️ 已是最小字体', 'info');
    }
}

// 放大字体
async function increaseFontSize() {
    const currentSize = getCurrentFontSize();
    const currentIndex = FONT_SIZES.indexOf(currentSize);
    
    if (currentIndex < FONT_SIZES.length - 1) {
        const newSize = FONT_SIZES[currentIndex + 1];
        await setFontSize(newSize);
    } else {
        showToast('⚠️ 已是最大字体', 'info');
    }
}

// 恢复字体大小设置
async function restoreFontSize() {
    try {
        const result = await chrome.storage.local.get(['phraseFontSize']);
        const rawFontSize = result.phraseFontSize || 'large';
        const fontSize = FONT_SIZES.includes(rawFontSize) ? rawFontSize : 'large';

        // 应用字体大小
        document.body.setAttribute('data-phrase-font-size', fontSize);
        console.log('✅ 恢复字体大小设置:', fontSize);
    } catch (error) {
        console.error('恢复字体大小设置失败:', error);
        // 如果出错，使用默认标准字体
        document.body.setAttribute('data-phrase-font-size', 'large');
    }
}

// ==================== 拖拽排序功能 ====================

let draggedElement = null;
let draggedOverElement = null;

// 设置拖拽事件
function setupDragEvents(element) {
    console.log('[拖拽调试] 🔗 绑定拖拽事件到元素:', {
        element: element,
        className: element.className,
        draggable: element.draggable,
        datasetId: element.dataset.id
    });
    
    element.addEventListener('dragstart', handleDragStart);
    element.addEventListener('dragend', handleDragEnd);
    element.addEventListener('dragover', handleDragOver);
    element.addEventListener('drop', handleDrop);
    element.addEventListener('dragenter', handleDragEnter);
    element.addEventListener('dragleave', handleDragLeave);
    
    console.log('[拖拽调试] ✅ 拖拽事件绑定完成');
}

function handleDragStart(e) {
    console.log('[拖拽调试] 🚀 拖拽开始:', {
        element: this,
        className: this.className,
        datasetId: this.dataset.id,
        isTitle: this.classList.contains('title-phrase-item'),
        draggable: this.draggable
    });
    
    draggedElement = this;
    this.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    
    // Debug logging for title drag start
    try {
        const id = this.dataset && this.dataset.id ? this.dataset.id : 'unknown';
        console.log('[DRAG START] id=', id, 'class=', this.className);
    } catch (err) {
        console.error('[DRAG START] logging failed', err);
    }
}

function handleDragEnd(e) {
    this.style.opacity = '1';
    
    // 移除所有拖拽时的样式
    const items = document.querySelectorAll('.phrase-item');
    items.forEach(item => {
        item.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';

    // 自动滚动功能：当拖拽接近容器顶部或底部时自动滚动
    const phraseList = document.getElementById('phraseList');
    if (phraseList && draggedElement) {
        const rect = phraseList.getBoundingClientRect();
        const mouseY = e.clientY;
        const scrollThreshold = 80; // 距离边缘80像素时开始滚动
        const scrollSpeed = 15; // 滚动速度

        if (mouseY < rect.top + scrollThreshold) {
            // 接近顶部，向上滚动
            phraseList.scrollTop -= scrollSpeed;
        } else if (mouseY > rect.bottom - scrollThreshold) {
            // 接近底部，向下滚动
            phraseList.scrollTop += scrollSpeed;
        }
    }

    return false;
}

function handleDragEnter(e) {
    if (this !== draggedElement) {
        this.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

// ==================== 统一扁平化排序辅助函数 ====================

/**
 * 从 DOM 构建扁平有序列表（标题 + 话术按顺序）
 * 每个话术记录其归属的标题 ID（最近的前置标题）
 * subcategory-tabs-container 归属到最近的前置标题
 */
function buildFlatItems(phraseList) {
    const items = [];
    const children = Array.from(phraseList.children);
    let currentTitleId = null;

    for (const child of children) {
        if (child.classList.contains('title-phrase-item')) {
            items.push({ type: 'title', id: child.dataset.id });
            currentTitleId = child.dataset.id;
        } else if (child.classList.contains('subcategory-tabs-container')) {
            // 平铺容器归属到最近的前置标题
            items.push({ type: 'tabs', id: child.dataset.parentId || 'tabs_' + items.length, titleId: currentTitleId, element: child });
        } else if (child.classList.contains('phrase-group-normal')) {
            const phrases = Array.from(child.querySelectorAll('.phrase-item'));
            phrases.forEach(p => {
                items.push({ type: 'phrase', id: p.dataset.id, titleId: currentTitleId });
            });
        } else if (child.classList.contains('phrase-item')) {
            items.push({ type: 'phrase', id: child.dataset.id, titleId: currentTitleId });
        }
        // 跳过 add-phrase-card
    }
    return items;
}

/**
 * 提取标题及其归属的话术/平铺容器作为一个连续块
 */
function extractTitleBlock(flatItems, titleIndex) {
    const block = [flatItems[titleIndex]];
    for (let i = titleIndex + 1; i < flatItems.length; i++) {
        if (flatItems[i].type === 'title') break;
        block.push(flatItems[i]);
    }
    return block;
}

/**
 * 重新计算每个话术的归属标题（最近的前置标题）
 */
function reassignOwnership(flatItems) {
    let currentTitleId = null;
    for (const item of flatItems) {
        if (item.type === 'title') {
            currentTitleId = item.id;
        } else {
            item.titleId = currentTitleId;
        }
    }
}

/**
 * 根据扁平列表重建 DOM
 * 标题直接追加，话术归入 phrase-group-normal 容器，平铺容器紧跟标题
 */
function rebuildDOM(phraseList, flatItems) {
    // 收集所有 .phrase-item 元素（按 ID 索引）
    const elements = {};
    phraseList.querySelectorAll('.phrase-item').forEach(el => {
        elements[el.dataset.id] = el;
    });

    // 收集所有平铺容器（按 parentId 索引）
    const tabsElements = {};
    phraseList.querySelectorAll('.subcategory-tabs-container').forEach(el => {
        const pid = el.dataset.parentId;
        if (pid) tabsElements[pid] = el;
    });

    // 清空列表（元素已保留在 elements 中）
    phraseList.innerHTML = '';

    // 重建：遍历 flatItems，按归属分组
    let pendingGroup = null;

    for (const item of flatItems) {
        // 标题
        if (item.type === 'title') {
            // 先追加之前累积的话术组
            if (pendingGroup && pendingGroup.children.length > 0) {
                phraseList.appendChild(pendingGroup);
            }
            pendingGroup = null;
            // 追加标题
            const titleEl = elements[item.id];
            if (titleEl) phraseList.appendChild(titleEl);
            continue;
        }

        // 平铺容器：紧跟在标题后面
        if (item.type === 'tabs') {
            // 先追加之前累积的话术组
            if (pendingGroup && pendingGroup.children.length > 0) {
                phraseList.appendChild(pendingGroup);
            }
            pendingGroup = null;
            // 追加平铺容器（优先使用原始元素，否则跳过）
            const tabsEl = item.element || tabsElements[item.id] || tabsElements[item.titleId];
            if (tabsEl) phraseList.appendChild(tabsEl);
            continue;
        }

        // 话术：归入 pendingGroup
        const el = elements[item.id];
        if (!el) continue;
        if (!pendingGroup) {
            pendingGroup = document.createElement('div');
            pendingGroup.className = 'phrase-list phrase-group-normal';
        }
        pendingGroup.appendChild(el);
    }

    // 追加最后一组话术
    if (pendingGroup && pendingGroup.children.length > 0) {
        phraseList.appendChild(pendingGroup);
    }
}

/**
 * 在剩余列表中找到插入位置
 * @param {boolean} isDownward - 是否向下拖拽（原位置在目标之前）
 */
function findInsertIndex(remaining, targetId, isDownward) {
    const targetIdx = remaining.findIndex(item => item.id === targetId);
    if (targetIdx === -1) return remaining.length;
    return isDownward ? targetIdx + 1 : targetIdx;
}

// ==================== 统一排序 handleDrop ====================

async function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    if (draggedElement === this) return false;

    try {
        const phraseList = document.getElementById('phraseList');
        const isDraggedTitle = draggedElement.classList.contains('title-phrase-item');

        // 1. 构建扁平有序列表
        const flatItems = buildFlatItems(phraseList);

        // 2. 查找拖拽和目标索引
        const draggedId = draggedElement.dataset.id;
        const targetId = this.dataset.id;
        const draggedIdx = flatItems.findIndex(i => i.id === draggedId);
        const targetIdx = flatItems.findIndex(i => i.id === targetId);
        if (draggedIdx === -1 || targetIdx === -1) return false;

        // 3. 提取要移动的块（标题+归属话术 或 单个话术）
        const blockItems = isDraggedTitle
            ? extractTitleBlock(flatItems, draggedIdx)
            : [flatItems[draggedIdx]];

        // 4. 从列表中移除该块
        const blockIds = new Set(blockItems.map(i => i.id));
        const remaining = flatItems.filter(i => !blockIds.has(i.id));

        // 5. 计算插入位置
        const isDownward = draggedIdx < targetIdx;
        const insertAt = findInsertIndex(remaining, targetId, isDownward);

        // 6. 插入块并重建归属关系
        const newOrder = [...remaining.slice(0, insertAt), ...blockItems, ...remaining.slice(insertAt)];
        reassignOwnership(newOrder);

        // 7. 重建 DOM
        rebuildDOM(phraseList, newOrder);

        // 8. 保存到数据库
        await updatePhrasesOrder();

        // 9. 保留滚动位置（滚动到被拖拽的元素）
        requestAnimationFrame(() => {
            const movedEl = phraseList.querySelector(`.phrase-item[data-id="${draggedId}"]`);
            if (movedEl) {
                movedEl.scrollIntoView({ block: 'nearest', behavior: 'auto' });
            }
        });
    } catch (err) {
        console.error('[DROP] 排序失败:', err);
    }

    return false;
}

// 🎯 更新分组内的话术序号
function updatePhraseNumbersInGroup(groupElement) {
    try {
        const phraseItems = groupElement.querySelectorAll('.phrase-item');
        phraseItems.forEach((item, index) => {
            const numberPlaceholder = item.querySelector('.phrase-number-placeholder');
            if (numberPlaceholder) {
                numberPlaceholder.textContent = (index + 1) + '. ';
            }
        });
        console.log('[DROP-TITLE] 已更新分组内序号，共', phraseItems.length, '项');
    } catch (error) {
        console.error('[DROP-TITLE] 更新分组序号失败:', error);
    }
}

// 更新话术排序到数据库
async function updatePhrasesOrder() {
    try {
        const phraseList = document.getElementById('phraseList');
        // 获取所有直接子元素（包括标题卡片、分组容器、平铺容器等）
        const children = Array.from(phraseList.children);
        
        // 收集所有话术项（包括标题卡片和普通话术）
        const phraseItems = [];
        
        children.forEach(child => {
            // 跳过非话术项（如平铺容器、添加按钮等）
            if (child.classList.contains('subcategory-tabs-container') || 
                child.classList.contains('add-phrase-card')) {
                return;
            }
            
            // 如果是标题卡片，添加到列表
            if (child.classList.contains('title-phrase-item')) {
                phraseItems.push(child);
            }
            // 如果是分组容器，获取其中的话术项
            else if (child.classList.contains('phrase-group-normal')) {
                const groupItems = Array.from(child.querySelectorAll('.phrase-item'));
                phraseItems.push(...groupItems);
            }
            // 如果是直接的话术项（不在分组中）
            else if (child.classList.contains('phrase-item')) {
                phraseItems.push(child);
            }
        });
        
        // 更新排序（过滤掉无效ID）
        const updates = phraseItems
            .map((item, index) => ({
                id: parseInt(item.dataset.id),
                sort_order: index
            }))
            .filter(u => !isNaN(u.id));

        if (updates.length > 0) {
            await db.batchUpdatePhraseSortOrder(updates);
            console.log('✅ 话术排序已更新，共', updates.length, '项');
        }
    } catch (error) {
        console.error('更新话术排序失败:', error);
        showToast('❌ 排序保存失败', 'error');
    }
}

// 🎬 更新分类滑动指示器的位置
function updateCategoryIndicator() {
    const categoryNav = document.getElementById('primaryCategoryTiles') || document.getElementById('categoryNav');
    if (!categoryNav) return;
    
    const activeItem = categoryNav.querySelector('.category-nav-item.active');
    
    if (activeItem) {
        // 有激活的分类
        categoryNav.classList.add('has-active');
        
        // 计算激活项的位置
        const navRect = categoryNav.getBoundingClientRect();
        const itemRect = activeItem.getBoundingClientRect();
        
        // 获取滚动偏移
        const scrollTop = categoryNav.scrollTop;
        
        // 计算相对于容器顶部的位置
        const top = itemRect.top - navRect.top + scrollTop;
        const height = itemRect.height;
        
        // 计算相对于容器左侧的位置和宽度，使选中框与item的实际宽度一致
        const left = itemRect.left - navRect.left;
        const width = itemRect.width;
        
        // 更新指示器位置和尺寸
        categoryNav.style.setProperty('--indicator-top', `${top}px`);
        categoryNav.style.setProperty('--indicator-height', `${height}px`);
        categoryNav.style.setProperty('--indicator-left', `${left}px`);
        categoryNav.style.setProperty('--indicator-width', `${width}px`);
    } else {
        // 没有激活的分类
        categoryNav.classList.remove('has-active');
    }
}

// 计算并设置侧边栏最小宽度
function calculateAndSetSidebarMinWidth() {
    const categoryNav = document.getElementById('categoryNav');
    const sidebar = document.querySelector('.sidebar');
    if (!categoryNav || !sidebar) return;
    
    const items = categoryNav.querySelectorAll('.category-nav-item');
    if (items.length === 0) return;
    
    let maxWidth = 0;
    
    items.forEach(item => {
        // 直接测量实际DOM元素的宽度（包括所有内容）
        const itemRect = item.getBoundingClientRect();
        const itemWidth = itemRect.width;
        maxWidth = Math.max(maxWidth, itemWidth);
    });
    
    // 加上滚动条宽度（6px）和更紧凑的安全边距（2px）
    const scrollbarWidth = 6;
    const safetyPadding = 2;
    const calculatedWidth = Math.ceil(maxWidth) + scrollbarWidth + safetyPadding;
    
    // 🔧 设置固定的最小宽度（刚好包裹4个字+文本编辑器按钮）
    // 约等于：4个字(56px) + 文本编辑器按钮(24px) + 内边距(8px) + 滚动条(6px) = 94px
    const FIXED_MIN_WIDTH = 94;
    const minSidebarWidth = Math.max(calculatedWidth, FIXED_MIN_WIDTH);
    
    // 设置侧边栏最小宽度和宽度
    sidebar.style.minWidth = `${minSidebarWidth}px`;
    sidebar.style.width = `${minSidebarWidth}px`;
    
    console.log('[SIDEBAR] 计算最小宽度:', minSidebarWidth, 'px (计算宽度:', calculatedWidth, 'px, 固定最小:', FIXED_MIN_WIDTH, 'px)');
}

// 监听滚动和窗口大小改变，更新选中框位置
let indicatorUpdateTimer = null;
function scheduleIndicatorUpdate() {
    if (indicatorUpdateTimer) clearTimeout(indicatorUpdateTimer);
    indicatorUpdateTimer = setTimeout(updateCategoryIndicator, 10);
}

// 在DOM加载完成后添加事件监听器
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const categoryNav = document.getElementById('categoryNav');
        if (categoryNav) {
            categoryNav.addEventListener('scroll', scheduleIndicatorUpdate);
            window.addEventListener('resize', () => {
                scheduleIndicatorUpdate();
                calculateAndSetSidebarMinWidth();
            });
        }
    });
} else {
    const categoryNav = document.getElementById('categoryNav');
    if (categoryNav) {
        categoryNav.addEventListener('scroll', scheduleIndicatorUpdate);
        window.addEventListener('resize', () => {
            scheduleIndicatorUpdate();
            calculateAndSetSidebarMinWidth();
        });
    }
}

// 添加动画样式
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// ==================== 占位符补全功能 ====================

let currentPlaceholderPhrase = null;
let placeholderValues = {};

/**
 * 获取填充后的话术内容（替换占位符为填充值）
 * @param {string} content - 原始话术内容
 * @param {object} placeholderValues - 占位符填充值
 * @returns {string} - 填充后的文本内容
 */
function getFilledContent(content, placeholderValues = {}) {
    if (!content) return content;
    
    // 匹配占位符格式 {占位符名称}
    const placeholderRegex = /\{([^}]+)\}/g;
    
    return content.replace(placeholderRegex, (match, placeholderName) => {
        const filledValue = placeholderValues[placeholderName];
        if (filledValue) {
            return filledValue;
        } else {
            return match; // 未填充，保持原样
        }
    });
}

/**
 * 渲染占位符为可点击元素
 * @param {string} content - 话术内容
 * @param {string} placeholderEdit - 编辑模式状态 ('true' 或 'false')
 * @returns {string} - 渲染后的HTML
 */
function renderPlaceholders(content, placeholderEdit = 'false', placeholderValues = {}) {
    if (!content) return content;

    // 匹配占位符格式 {占位符名称}
    const placeholderRegex = /\{([^}]+)\}/g;

    if (placeholderEdit === 'true') {
        // 编辑模式：将占位符渲染为可点击的span元素或已填充的内容
        return content.replace(placeholderRegex, (match, placeholderName) => {
            const filledValue = placeholderValues[placeholderName];
            if (filledValue) {
                // 已填充：显示为绿色下划线的可点击元素
                return `<span class="placeholder-filled" data-placeholder="${escapeHtml(placeholderName)}" title="点击重新编辑">${escapeHtml(filledValue)}</span>`;
            } else {
                // 未填充：显示为虚线下划线的可点击元素
                return `<span class="placeholder-edit" data-placeholder="${escapeHtml(placeholderName)}" title="点击编辑${placeholderName}">${match}</span>`;
            }
        });
    } else {
        // 非编辑模式：保持原样
        return content;
    }
}

/**
 * 绑定占位符点击事件
 * @param {HTMLElement} div - 话术卡片元素
 */
function bindPlaceholderClickEvents(div) {
    // 绑定未填充的占位符点击事件
    const editPlaceholders = div.querySelectorAll('.placeholder-edit');
    editPlaceholders.forEach(placeholder => {
        placeholder.addEventListener('click', (e) => {
            e.stopPropagation();
            const placeholderName = placeholder.dataset.placeholder;
            const placeholderValues = JSON.parse(div.dataset.placeholderValues || '{}');

            // 未填充，显示下划线输入框
            editPlaceholder(placeholder, placeholderName, '', div);
        });
    });

    // 绑定已填充的占位符点击事件
    const filledPlaceholders = div.querySelectorAll('.placeholder-filled');
    filledPlaceholders.forEach(placeholder => {
        placeholder.addEventListener('click', (e) => {
            e.stopPropagation();
            const placeholderName = placeholder.dataset.placeholder;
            const placeholderValues = JSON.parse(div.dataset.placeholderValues || '{}');

            // 已填充，重新显示下划线编辑
            editPlaceholder(placeholder, placeholderName, placeholderValues[placeholderName] || '', div);
        });
    });
}

/**
 * 为输入框打开计算器面板
 * @param {HTMLInputElement} input - 目标输入框
 */
// 全局变量，保存当前计算器对应的目标输入框
let _currentCalculatorInput = null;

function openCalculatorForInput(input) {
    // 保存目标输入框引用
    _currentCalculatorInput = input;

    // 保存光标位置（contentEditable 元素）
    if (input.contentEditable === 'true') {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            input._savedRange = sel.getRangeAt(0).cloneRange();
        }
    }

    // 设置标志，防止 blur 事件触发补全结束
    input.dataset.openingCalculator = 'true';

    // 调用 Python 方法打开 PyQt6 计算器
    if (window.pythonBridge && window.pythonBridge.openCalculatorForInput) {
        const inputId = input.id || '';
        console.log('[LOG] 调用 Python 打开计算器，输入框 ID:', inputId);
        window.pythonBridge.openCalculatorForInput(inputId);
    } else {
        console.error('[LOG] pythonBridge 或 openCalculatorForInput 方法不可用');
        // 如果调用失败，清除标志
        delete input.dataset.openingCalculator;
        _currentCalculatorInput = null;
    }
}

/**
 * 创建计算器面板
 * @returns {HTMLElement} - 计算器面板元素
 */
function createCalculatorPanel() {
    const panel = document.createElement('div');
    panel.id = 'placeholderCalculatorPanel';
    panel.className = 'calculator-panel';
    panel.style.cssText = `
        display: none;
        flex-direction: column;
        width: 280px;
        background: #ffffff;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    panel.innerHTML = `
        <div class="calculator-header" style="
            padding: 10px 15px;
            background: #f5f5f5;
            border-bottom: 1px solid #e0e0e0;
            border-radius: 8px 8px 0 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        ">
            <span style="font-weight: 600; font-size: 14px; color: #333;">计算器</span>
            <span class="calculator-close" style="
                cursor: pointer;
                font-size: 18px;
                color: #999;
                line-height: 1;
            ">&times;</span>
        </div>
        <div class="calculator-display" style="
            padding: 15px;
            background: #fafafa;
            border-bottom: 1px solid #e0e0e0;
        ">
            <div class="calculator-history" style="
                font-size: 12px;
                color: #999;
                text-align: right;
                min-height: 16px;
                margin-bottom: 5px;
            "></div>
            <div class="calculator-expression" style="
                font-size: 24px;
                font-weight: 600;
                color: #333;
                text-align: right;
                min-height: 30px;
            ">0</div>
        </div>
        <div class="calculator-buttons" style="
            padding: 10px;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
        ">
            <button class="calc-btn" data-action="clear" style="
                padding: 12px;
                font-size: 16px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
            ">C</button>
            <button class="calc-btn" data-action="backspace" style="
                padding: 12px;
                font-size: 16px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
            ">⌫</button>
            <button class="calc-btn" data-action="percent" style="
                padding: 12px;
                font-size: 16px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
            ">%</button>
            <button class="calc-btn" data-action="operator" data-value="/" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #ff9800;
                color: white;
                cursor: pointer;
            ">÷</button>
            
            <button class="calc-btn" data-action="number" data-value="7" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">7</button>
            <button class="calc-btn" data-action="number" data-value="8" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">8</button>
            <button class="calc-btn" data-action="number" data-value="9" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">9</button>
            <button class="calc-btn" data-action="operator" data-value="*" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #ff9800;
                color: white;
                cursor: pointer;
            ">×</button>
            
            <button class="calc-btn" data-action="number" data-value="4" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">4</button>
            <button class="calc-btn" data-action="number" data-value="5" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">5</button>
            <button class="calc-btn" data-action="number" data-value="6" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">6</button>
            <button class="calc-btn" data-action="operator" data-value="-" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #ff9800;
                color: white;
                cursor: pointer;
            ">−</button>
            
            <button class="calc-btn" data-action="number" data-value="1" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">1</button>
            <button class="calc-btn" data-action="number" data-value="2" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">2</button>
            <button class="calc-btn" data-action="number" data-value="3" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">3</button>
            <button class="calc-btn" data-action="operator" data-value="+" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #ff9800;
                color: white;
                cursor: pointer;
            ">+</button>
            
            <button class="calc-btn" data-action="number" data-value="0" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
                grid-column: span 2;
            ">0</button>
            <button class="calc-btn" data-action="decimal" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: white;
                cursor: pointer;
            ">.</button>
            <button class="calc-btn" data-action="calculate" style="
                padding: 12px;
                font-size: 18px;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                background: #ff9800;
                color: white;
                cursor: pointer;
            ">=</button>
        </div>
        <div class="calculator-footer" style="
            padding: 10px;
            border-top: 1px solid #e0e0e0;
            display: flex;
            gap: 8px;
        ">
            <button class="calc-fill-btn" style="
                flex: 1;
                padding: 10px;
                font-size: 14px;
                font-weight: 600;
                border: none;
                border-radius: 4px;
                background: #4caf50;
                color: white;
                cursor: pointer;
            ">回填</button>
        </div>
    `;
    
    // 绑定按钮事件
    panel.querySelectorAll('.calc-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const value = btn.dataset.value;
            
            handleCalculatorAction(action, value);
        });
    });
    
    // 绑定关闭按钮
    panel.querySelector('.calculator-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeCalculatorPanel();
    });
    
    // 绑定回填按钮
    panel.querySelector('.calc-fill-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        fillBackToInput();
    });
    
    return panel;
}

/**
 * 关闭计算器面板
 */
function closeCalculatorPanel() {
    const panel = document.getElementById('placeholderCalculatorPanel');
    if (panel) {
        panel.style.display = 'none';
    }
}

// 计算器状态
let calcState = {
    expression: '0',
    history: '',
    lastOperator: null,
    waitingForOperand: false,
    justCalculated: false
};

/**
 * 重置计算器状态
 */
function resetCalculatorState() {
    calcState = {
        expression: '0',
        history: '',
        lastOperator: null,
        waitingForOperand: false,
        justCalculated: false
    };
    updateCalculatorDisplay();
}

/**
 * 设置计算器表达式
 * @param {string} value - 表达式值
 */
function setCalculatorExpression(value) {
    calcState.expression = value || '0';
    calcState.history = '';
    calcState.lastOperator = null;
    calcState.waitingForOperand = false;
    calcState.justCalculated = false;
    updateCalculatorDisplay();
}

/**
 * 处理计算器按钮点击
 * @param {string} action - 动作类型
 * @param {string} value - 按钮值
 */
function handleCalculatorAction(action, value) {
    switch (action) {
        case 'number':
            handleNumber(value);
            break;
        case 'operator':
            handleOperator(value);
            break;
        case 'decimal':
            handleDecimal();
            break;
        case 'clear':
            resetCalculatorState();
            break;
        case 'backspace':
            handleBackspace();
            break;
        case 'percent':
            handlePercent();
            break;
        case 'calculate':
            handleCalculate();
            break;
    }
    updateCalculatorDisplay();
}

/**
 * 处理数字输入
 * @param {string} value - 数字值
 */
function handleNumber(value) {
    if (calcState.justCalculated) {
        calcState.expression = value;
        calcState.justCalculated = false;
        calcState.history = '';
    } else if (calcState.waitingForOperand) {
        calcState.expression += value;
        calcState.waitingForOperand = false;
    } else if (calcState.expression === '0') {
        calcState.expression = value;
    } else {
        calcState.expression += value;
    }
}

/**
 * 处理运算符
 * @param {string} value - 运算符
 */
function handleOperator(value) {
    if (calcState.justCalculated) {
        calcState.justCalculated = false;
    }
    
    if (calcState.waitingForOperand) {
        calcState.expression = calcState.expression.slice(0, -1) + value;
    } else {
        calcState.expression += value;
        calcState.lastOperator = value;
        calcState.waitingForOperand = true;
    }
}

/**
 * 处理小数点
 */
function handleDecimal() {
    if (calcState.waitingForOperand) {
        calcState.expression += '0.';
        calcState.waitingForOperand = false;
    } else if (!calcState.expression.includes('.')) {
        const lastNumber = calcState.expression.split(/[\+\-\*\/]/).pop();
        if (!lastNumber.includes('.')) {
            calcState.expression += '.';
        }
    }
}

/**
 * 处理退格
 */
function handleBackspace() {
    if (calcState.justCalculated) {
        resetCalculatorState();
        return;
    }
    
    if (calcState.expression.length > 1) {
        calcState.expression = calcState.expression.slice(0, -1);
    } else {
        calcState.expression = '0';
    }
}

/**
 * 处理百分比
 */
function handlePercent() {
    try {
        const result = eval(calcState.expression) / 100;
        calcState.expression = String(result);
        calcState.justCalculated = true;
    } catch (e) {
        calcState.expression = 'Error';
    }
}

/**
 * 处理计算
 */
function handleCalculate() {
    if (calcState.expression.includes('=')) {
        calcState.expression = calcState.expression.split('=')[1].trim();
        return;
    }
    
    try {
        const expr = calcState.expression
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .replace(/−/g, '-');
        
        const result = eval(expr);
        
        if (isNaN(result) || !isFinite(result)) {
            calcState.expression = 'Error';
        } else {
            const originalExpr = calcState.expression;
            calcState.history = originalExpr + '=' + formatCalculatorResult(result);
            calcState.expression = formatCalculatorResult(result);
            calcState.justCalculated = true;
        }
    } catch (e) {
        calcState.expression = 'Error';
    }
}

/**
 * 格式化计算结果
 * @param {number} result - 计算结果
 * @returns {string} - 格式化后的字符串
 */
function formatCalculatorResult(result) {
    if (Number.isInteger(result)) {
        return String(result);
    }
    // 保留最多8位小数，去除末尾的0
    return parseFloat(result.toFixed(8)).toString();
}

/**
 * 更新计算器显示
 */
function updateCalculatorDisplay() {
    const panel = document.getElementById('placeholderCalculatorPanel');
    if (!panel) return;
    
    const expressionEl = panel.querySelector('.calculator-expression');
    const historyEl = panel.querySelector('.calculator-history');
    
    if (expressionEl) {
        expressionEl.textContent = calcState.expression;
    }
    if (historyEl) {
        historyEl.textContent = calcState.history;
    }
}

/**
 * 回填到输入框
 */
function fillBackToInput() {
    const panel = document.getElementById('placeholderCalculatorPanel');
    if (!panel) return;
    
    const targetInput = panel.targetInput;
    if (!targetInput) {
        console.warn('[LOG] 未找到目标输入框');
        return;
    }
    
    // 获取当前表达式（如果是计算结果，使用表达式；如果是Error，使用0）
    let valueToFill = calcState.expression;
    if (valueToFill === 'Error') {
        valueToFill = '0';
    } else if (calcState.justCalculated && calcState.history) {
        // 如果刚刚计算完成，使用结果
        valueToFill = calcState.expression;
    }
    
    // 回填到输入框
    targetInput.value = valueToFill;
    
    // 触发输入事件以确保数据保存
    targetInput.dispatchEvent(new Event('input'));
    
    // 关闭计算器面板
    closeCalculatorPanel();
    
    console.log('[LOG] 回填到输入框:', valueToFill);
}

/**
 * 编辑占位符
 * @param {HTMLElement} placeholder - 占位符元素
 * @param {string} placeholderName - 占位符名称
 * @param {string} currentValue - 当前值
 * @param {HTMLElement} div - 话术卡片元素
 */
function editPlaceholder(placeholder, placeholderName, currentValue, div) {
    // 确保 placeholderName 是字符串
    if (typeof placeholderName !== 'string') {
        console.error('[补全] editPlaceholder: placeholderName 不是字符串:', placeholderName);
        placeholderName = String(placeholderName || '');
    }

    // 检测占位符名称是否以 = 结尾（表示需要计算器功能）
    const isCalculatorPlaceholder = placeholderName.trim().endsWith('=');
    const cleanPlaceholderName = isCalculatorPlaceholder ? placeholderName.trim().slice(0, -1).trim() : placeholderName;

    console.log('[补全] editPlaceholder 被调用:', {
        placeholderName,
        isCalculatorPlaceholder,
        cleanPlaceholderName,
        currentValue
    });
    
    // === contentEditable 方案：placeholder 提示 + 自然折行 ===
    const wrapper = document.createElement('span');
    wrapper.className = 'placeholder-input';
    wrapper.style.display = 'inline';
    wrapper.style.wordBreak = 'break-all';
    wrapper.contentEditable = 'true';
    wrapper.dataset.placeholderName = placeholderName;
    wrapper.setAttribute('data-placeholder', cleanPlaceholderName);
    wrapper.id = `calc-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 初始状态：有值用 inline 自然折行，空时用 inline-block + min-width 显示输入区域
    if (currentValue) {
        wrapper.textContent = currentValue;
    } else {
        wrapper.classList.add('is-empty');
        wrapper.style.display = 'inline-block';
        wrapper.style.minWidth = '3em';
    }

    // 聚焦时：灰色提示消失，保持 inline-block 让光标有位置
    wrapper.addEventListener('focus', () => {
        if (wrapper.classList.contains('is-empty')) {
            wrapper.classList.remove('is-empty');
            wrapper.textContent = '';
            // 保持 inline-block + min-width，光标有位置
        }
    });

    // 输入时：有内容后切回 inline 让文字自然折行
    wrapper.addEventListener('input', () => {
        if (wrapper.textContent.length > 0 && wrapper.style.display !== 'inline') {
            wrapper.style.display = 'inline';
            wrapper.style.minWidth = '';
        }
    });

    // 失焦时：空内容恢复灰色提示和 inline-block
    wrapper.addEventListener('blur', () => {
        if (!wrapper.textContent.trim()) {
            wrapper.textContent = '';
            wrapper.classList.add('is-empty');
            wrapper.style.display = 'inline-block';
            wrapper.style.minWidth = '3em';
        }
    });

    // 在占位符位置插入
    const parent = placeholder.parentNode;
    const anchor = placeholder.nextSibling;
    parent.insertBefore(wrapper, anchor);
    placeholder.remove();

    // Enter 完成
    wrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); wrapper.blur(); }
    });

    // 光标放到末尾（方便继续输入或退格删除）
    wrapper.focus();
    const range = document.createRange();
    range.selectNodeContents(wrapper);
    range.collapse(false); // false = 折叠到末尾
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // 计算器图标
    if (isCalculatorPlaceholder) {
        const icon = document.createElement('span');
        icon.className = 'calculator-icon';
        icon.innerHTML = '🧮';
        icon.style.cssText = 'cursor:pointer;font-size:14px;margin-left:2px;user-select:none;';
        icon.title = '点击打开计算器';
        icon.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); openCalculatorForInput(wrapper); });
        parent.insertBefore(icon, anchor);
    }

    // 输入完成处理
    let completed = false;
    const handleComplete = () => {
        setTimeout(() => {
            if (completed) return;
            if (document.activeElement === wrapper) return;
            if (wrapper.dataset.openingCalculator === 'true') return;
            completed = true;
            const newValue = wrapper.textContent.trim();

            const placeholderValues = JSON.parse(div.dataset.placeholderValues || '{}');
            placeholderValues[placeholderName] = newValue;
            div.dataset.placeholderValues = JSON.stringify(placeholderValues);
            const phraseId = div.dataset.id;
            if (phraseId && placeholderEditCache[phraseId]) placeholderEditCache[phraseId].placeholderValues = placeholderValues;

            const icon = parent.querySelector('.calculator-icon');
            if (icon) icon.remove();

            const filledSpan = document.createElement('span');
            filledSpan.className = 'placeholder-filled';
            filledSpan.dataset.placeholder = placeholderName;
            filledSpan.textContent = newValue || `{${placeholderName}}`;
            filledSpan.title = '点击重新编辑';
            wrapper.parentNode.insertBefore(filledSpan, wrapper);
            wrapper.remove();
            filledSpan.addEventListener('click', (e) => { e.stopPropagation(); editPlaceholder(filledSpan, placeholderName, newValue, div); });
        }, 150);
    };
    wrapper.addEventListener('blur', handleComplete);
}

async function openPlaceholderDialog(phrase) {
    console.log('[LOG] 打开占位符对话框:', phrase);
    
    // 优先使用 Python Bridge 打开外部窗口（桌面应用模式）
    if (window.pythonBridge && typeof window.pythonBridge.open_placeholder_dialog === 'function') {
        try {
            console.log('[LOG] 尝试通过 Python Bridge 打开占位符对话框...');
            const placeholders = phrase.placeholder_names || [];
            const content = phrase.content || '';
            const placeholdersJson = JSON.stringify(placeholders);
            
            window.pythonBridge.open_placeholder_dialog(content, placeholdersJson);
            console.log('[LOG] Python Bridge 调用成功');
            return;
        } catch (error) {
            console.error('[LOG] Python Bridge 调用失败，回退到内嵌对话框:', error);
        }
    }
    
    // 回退到内嵌对话框（浏览器模式）
    console.log('[LOG] 使用内嵌占位符对话框');
    currentPlaceholderPhrase = phrase;
    placeholderValues = {};
    
    const dialog = document.getElementById('placeholderDialog');
    const inputsContainer = document.getElementById('placeholderInputs');
    const preview = document.getElementById('placeholderPreview');
    
    // 生成占位符输入框
    inputsContainer.innerHTML = '';
    if (phrase.placeholder_names && phrase.placeholder_names.length > 0) {
        phrase.placeholder_names.forEach(placeholder => {
            const inputGroup = document.createElement('div');
            inputGroup.className = 'placeholder-input-group';
            inputGroup.innerHTML = `
                <label>${placeholder}：</label>
                <input type="text" data-placeholder="${placeholder}" placeholder="请输入${placeholder}">
            `;
            inputsContainer.appendChild(inputGroup);
            
            // 添加实时预览
            const input = inputGroup.querySelector('input');
            input.addEventListener('input', updatePlaceholderPreview);
        });
    } else {
        inputsContainer.innerHTML = '<p style="color: #999; text-align: center;">该话术没有占位符</p>';
    }
    
    // 初始预览
    updatePlaceholderPreview();
    
    dialog.style.display = 'flex';
}

function updatePlaceholderPreview() {
    if (!currentPlaceholderPhrase) return;
    
    const preview = document.getElementById('placeholderPreview');
    const inputs = document.querySelectorAll('#placeholderInputs input');
    
    // 收集所有占位符的值
    placeholderValues = {};
    inputs.forEach(input => {
        const placeholder = input.dataset.placeholder;
        placeholderValues[placeholder] = input.value;
    });
    
    // 替换占位符生成预览
    let result = currentPlaceholderPhrase.content;
    Object.keys(placeholderValues).forEach(placeholder => {
        const value = placeholderValues[placeholder] || `{${placeholder}}`;
        result = result.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), value);
    });
    
    preview.textContent = result;
}

function closePlaceholderDialog() {
    const dialog = document.getElementById('placeholderDialog');
    dialog.style.display = 'none';
    currentPlaceholderPhrase = null;
    placeholderValues = {};
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
}

// 点击预览结果复制并关闭
async function copyAndClosePlaceholder() {
    const preview = document.getElementById('placeholderPreview');
    const text = preview.textContent.trim();
    
    // 如果没有内容，不执行复制
    if (!text) {
        return;
    }
    
    const success = await copyToClipboard(text);
    if (success) {
        showToast('✅ 已复制');
        await tryAutoFocusAfterCopy();
        
        // 更新使用次数
        const incrementUseCount = await db.getSetting('incrementUseCount', 'true');
        if (incrementUseCount === 'true' && currentPlaceholderPhrase) {
            await db.incrementUseCount(currentPlaceholderPhrase.id);
        }
        
        // 自动关闭弹窗
        closePlaceholderDialog();
    } else {
        console.error('复制失败');
        showToast('❌ 复制失败', 'error');
    }
}

// ==================== 占位符弹窗事件绑定 ====================
// 使用 addEventListener 代替 onclick（CSP 安全）

// 关闭按钮
document.addEventListener('DOMContentLoaded', () => {
    // 桌面版隐藏无效设置，并强制复制模式
    try {
        if (IS_DESKTOP_ENV) {
            const hideSettingById = (id) => {
                const input = document.getElementById(id);
                if (input && input.closest('.setting-item')) {
                    input.closest('.setting-item').style.display = 'none';
                }
            };
            hideSettingById('autoFocusInput');
            hideSettingById('showNotification');
            hideSettingById('incrementUseCount');
            hideSettingById('copyOnClick');

            // 写入/校正设置，确保复制模式
            db.setSetting('copyOnClick', 'true').catch(() => {});
            db.setSetting('incrementUseCount', 'false').catch(() => {});
        }
    } catch (e) {
        console.warn('隐藏设置项失败:', e);
    }

    const closePlaceholderBtn = document.getElementById('closePlaceholderBtn');
    if (closePlaceholderBtn) {
        closePlaceholderBtn.addEventListener('click', closePlaceholderDialog);
    }
    
    // 预览区点击复制
    const placeholderPreview = document.getElementById('placeholderPreview');
    if (placeholderPreview) {
        placeholderPreview.addEventListener('click', copyAndClosePlaceholder);
        
        // 添加悬停效果
        placeholderPreview.addEventListener('mouseenter', function() {
            this.style.background = '#c8e6c9';
        });
        placeholderPreview.addEventListener('mouseleave', function() {
            this.style.background = '#e8f5e9';
        });
    }
    
    // 设置按钮事件（标签栏的设置按钮已移除，只保留侧边栏的）
    // const settingsBtn = document.getElementById('settingsBtn');
    // if (settingsBtn) {
    //     settingsBtn.addEventListener('click', openSettingsDialog);
    // }
    
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', closeSettingsDialog);
    }
    
    // 使用日志对话框事件
    const closeUsageLogBtn = document.getElementById('closeUsageLogBtn');
    if (closeUsageLogBtn) {
        closeUsageLogBtn.addEventListener('click', closeUsageLogDialog);
    }
    
    const closeUsageLogBtn2 = document.getElementById('closeUsageLogBtn2');
    if (closeUsageLogBtn2) {
        closeUsageLogBtn2.addEventListener('click', closeUsageLogDialog);
    }
    
    const copyUsageLogBtn = document.getElementById('copyUsageLogBtn');
    if (copyUsageLogBtn) {
        copyUsageLogBtn.addEventListener('click', async () => {
            const content = document.getElementById('usageLogContent');
            if (content) {
                const success = await copyToClipboard(content.textContent);
                if (success) {
                    showToast('✅ 日志已复制到剪贴板');
                } else {
                    showToast('❌ 复制失败', 'error');
                }
            }
        });
    }
    
    // 图片管理弹窗事件
    const closeImagesBtn = document.getElementById('closeImagesBtn');
    if (closeImagesBtn) {
        closeImagesBtn.addEventListener('click', closeImagesDialog);
    }
    
    // 底部关闭按钮已移除
    
    // 说明对话框事件监听
    const closeDescriptionBtn = document.getElementById('closeDescriptionBtn');
    if (closeDescriptionBtn) {
        closeDescriptionBtn.addEventListener('click', closeDescriptionDialog);
    }
    
    // 说明对话框已改为自动保存，不再需要取消和保存按钮
    
    // 监听说明对话框编辑器大小变化，保存高度（contenteditable div）
    const descriptionContent = document.getElementById('descriptionContent');
    if (descriptionContent) {
        let resizeTimer = null;
        let lastHeight = descriptionContent.offsetHeight;
        
        // 使用MutationObserver监听style属性变化（CSS resize会修改style.height）
        const mutationObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const currentHeight = descriptionContent.offsetHeight;
                    if (currentHeight !== lastHeight) {
                        lastHeight = currentHeight;
                        // 防抖处理
                        clearTimeout(resizeTimer);
                        resizeTimer = setTimeout(async () => {
                            const height = descriptionContent.style.height || currentHeight + 'px';
                            if (height && height !== 'auto') {
                                try {
                                    await chrome.storage.local.set({ descriptionDialogHeight: height });
                                    console.log('✅ 说明对话框高度已保存:', height);
                                } catch (error) {
                                    console.error('保存说明对话框高度失败:', error);
                                }
                            }
                        }, 300);
                    }
                }
            }
        });
        
        mutationObserver.observe(descriptionContent, {
            attributes: true,
            attributeFilter: ['style']
        });
        
        // 也使用ResizeObserver作为备用方案
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const currentHeight = entry.contentRect.height;
                if (currentHeight !== lastHeight) {
                    lastHeight = currentHeight;
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(async () => {
                        const height = descriptionContent.style.height || currentHeight + 'px';
                        if (height && height !== 'auto') {
                            try {
                                await chrome.storage.local.set({ descriptionDialogHeight: height });
                                console.log('✅ 说明对话框高度已保存:', height);
                            } catch (error) {
                                console.error('保存说明对话框高度失败:', error);
                            }
                        }
                    }, 300);
                }
            }
        });
        
        resizeObserver.observe(descriptionContent);
        
        // 监听鼠标释放事件，确保拖拽结束时保存
        descriptionContent.addEventListener('mouseup', async () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(async () => {
                const height = descriptionContent.style.height || descriptionContent.offsetHeight + 'px';
                if (height && height !== 'auto') {
                    try {
                        await chrome.storage.local.set({ descriptionDialogHeight: height });
                        console.log('✅ 说明对话框高度已保存:', height);
                    } catch (error) {
                        console.error('保存说明对话框高度失败:', error);
                    }
                }
            }, 100);
        });
    }
    
    const addImageBtn = document.getElementById('addImageBtn');
    const imageFileInput = document.getElementById('imageFileInput');
    if (addImageBtn && imageFileInput) {
        addImageBtn.addEventListener('click', () => {
            imageFileInput.click();
        });
        imageFileInput.addEventListener('change', handleImageUpload);
    }
    
    // 粘贴图片按钮
    const pasteImageBtn = document.getElementById('pasteImageBtn');
    if (pasteImageBtn) {
        pasteImageBtn.addEventListener('click', async () => {
            try {
                const clipboardItems = await navigator.clipboard.read();
                for (const item of clipboardItems) {
                    for (const type of item.types) {
                        if (type.startsWith('image/')) {
                            const blob = await item.getType(type);
                            await addImageFromBlob(blob);
                            showToast('✅ 图片已从剪贴板添加');
                            return;
                        }
                    }
                }
                showToast('⚠️ 剪贴板中没有图片');
            } catch (err) {
                console.error('粘贴图片失败:', err);
                showToast('❌ 粘贴失败，请先截图或复制图片');
            }
        });
    }
    
    // 🖼️ 图片管理对话框粘贴事件
    const imagesDialog = document.getElementById('imagesDialog');
    if (imagesDialog) {
        imagesDialog.addEventListener('paste', handleImagePaste);
    }
    
    console.log('✅ 占位符功能事件已绑定 - 版本 3.1 (CSP 兼容 + 粘贴图片)');
});

// 点击弹窗外部关闭
document.addEventListener('click', (e) => {
    const placeholderDialog = document.getElementById('placeholderDialog');
    if (e.target === placeholderDialog) {
        closePlaceholderDialog();
    }
});

// 全局键盘快捷键
document.addEventListener('keydown', (e) => {
    // ESC键关闭弹窗
    if (e.key === 'Escape') {
        const placeholderDialog = document.getElementById('placeholderDialog');
        if (placeholderDialog && placeholderDialog.style.display !== 'none') {
            closePlaceholderDialog();
        }
    }
    
    // Ctrl+Shift+F5 强制刷新缓存（隐藏快捷键）
    if (e.ctrlKey && e.shiftKey && e.key === 'F5') {
        e.preventDefault();
        console.log('🔄 强制刷新缓存...');
        showToast('🔄 正在清除缓存并刷新...', 'info');
        setTimeout(() => {
            location.reload(true);
        }, 500);
    }
});

// ==================== 图片管理功能 ====================

let currentImagesPhrase = null;

async function openImagesDialog(phrase) {
    // 从数据库重新加载最新的话术数据，确保图片信息是最新的
    try {
        const phrases = await db.searchPhrases();
        currentImagesPhrase = phrases.find(p => p.id === phrase.id);
        
        // 如果找不到话术，使用传入的对象
        if (!currentImagesPhrase) {
            currentImagesPhrase = phrase;
        }
    } catch (error) {
        console.error('加载话术数据失败:', error);
        currentImagesPhrase = phrase;
    }
    
    const dialog = document.getElementById('imagesDialog');
    const container = document.getElementById('imagesContainer');
    
    // 渲染图片列表
    renderImages();
    
    dialog.style.display = 'flex';
}

function renderImages() {
    const container = document.getElementById('imagesContainer');
    
    if (!currentImagesPhrase || !currentImagesPhrase.images || currentImagesPhrase.images.length === 0) {
        container.innerHTML = `
            <div class="images-empty" id="imagesEmptyArea">
                <div class="images-empty-icon">🖼️</div>
                <div class="images-empty-title">暂无图片</div>
                <div class="images-empty-subtitle">点击此处上传图片</div>
                <div class="images-empty-hint">或按 Ctrl+V 粘贴剪贴板中的图片</div>
            </div>
        `;
        
        // 绑定空白区域点击事件，触发文件选择
        const emptyArea = container.querySelector('#imagesEmptyArea');
        if (emptyArea) {
            emptyArea.addEventListener('click', () => {
                document.getElementById('imageFileInput')?.click();
            });
        }
        return;
    }
    
    container.innerHTML = '';
    currentImagesPhrase.images.forEach((imageData, index) => {
        const item = document.createElement('div');
        item.className = 'image-item';
        
        const wrapper = document.createElement('div');
        wrapper.className = 'image-wrapper';
        
        const img = document.createElement('img');
        img.src = imageData;
        img.alt = `图片 ${index + 1}`;
        img.dataset.index = index;
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'image-delete-btn';
        deleteBtn.dataset.index = index;
        deleteBtn.textContent = '🗑️ 删除';
        
        // 删除按钮点击事件
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(index);
        });
        
        // 图片点击复制事件
        img.addEventListener('click', (e) => {
            e.stopPropagation();
            copyImage(index);
        });
        
        wrapper.appendChild(img);
        wrapper.appendChild(deleteBtn);
        item.appendChild(wrapper);
        
        // 在整个item上监听hover，控制删除按钮显隐
        item.addEventListener('mouseenter', () => {
            deleteBtn.style.opacity = '1';
            deleteBtn.style.pointerEvents = 'auto';
        });
        
        item.addEventListener('mouseleave', () => {
            deleteBtn.style.opacity = '0';
            deleteBtn.style.pointerEvents = 'none';
        });
        
        container.appendChild(item);
    });
}

async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    await addImageFile(file);
    
    // 清空文件输入
    event.target.value = '';
}

// 处理粘贴图片
async function handleImagePaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) {
                await addImageFile(file);
            }
            break;
        }
    }
}

// 从Blob添加图片（用于粘贴功能）
async function addImageFromBlob(blob) {
    if (!currentImagesPhrase) {
        showToast('❌ 请先打开图片管理', 'error');
        return;
    }
    
    // 检查文件类型
    if (!blob.type.startsWith('image/')) {
        showToast('❌ 剪贴板内容不是图片', 'error');
        return;
    }
    
    // 检查文件大小（限制为2MB）
    if (blob.size > 2 * 1024 * 1024) {
        showToast('❌ 图片大小不能超过2MB', 'error');
        return;
    }
    
    try {
        // 读取Blob为Base64
        const reader = new FileReader();
        reader.onload = async (e) => {
            const imageData = e.target.result;

            // 添加图片到数据库
            await db.addImageToPhrase(currentImagesPhrase.id, imageData);

            // 重新加载话术数据
            const phrases = await db.searchPhrases();
            currentImagesPhrase = phrases.find(p => p.id === currentImagesPhrase.id);

            // 重新渲染图片列表
            renderImages();

            // 刷新话术列表（更新图片指示器）
            await loadPhrases();
        };
        reader.readAsDataURL(blob);
    } catch (error) {
        console.error('粘贴图片失败:', error);
        showToast('❌ 添加图片失败', 'error');
    }
}

// 通用的添加图片文件函数
async function addImageFile(file) {
    if (!currentImagesPhrase) {
        showToast('❌ 请先打开图片管理', 'error');
        return;
    }
    
    // 检查文件类型
    if (!file.type.startsWith('image/')) {
        showToast('❌ 请选择图片文件', 'error');
        return;
    }
    
    // 检查文件大小（限制为2MB）
    if (file.size > 2 * 1024 * 1024) {
        showToast('❌ 图片大小不能超过2MB', 'error');
        return;
    }
    
    try {
        // 读取文件为Base64
        const reader = new FileReader();
        reader.onload = async (e) => {
            const imageData = e.target.result;

            // 添加图片到数据库
            await db.addImageToPhrase(currentImagesPhrase.id, imageData);

            // 重新加载话术数据
            const phrases = await db.searchPhrases();
            currentImagesPhrase = phrases.find(p => p.id === currentImagesPhrase.id);

            // 重新渲染图片列表
            renderImages();

            // 刷新话术列表（更新图片指示器）
            await loadPhrases();

            showToast('✅ 图片已添加');
        };
        reader.readAsDataURL(file);
    } catch (error) {
        console.error('上传图片失败:', error);
        showToast('❌ 上传失败', 'error');
    }
}

function previewImage(index) {
    if (!currentImagesPhrase || !currentImagesPhrase.images[index]) return;
    
    const imageData = currentImagesPhrase.images[index];
    const win = window.open();
    win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>图片预览</title>
            <style>
                body {
                    margin: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    background: #000;
                }
                img {
                    max-width: 100%;
                    max-height: 100vh;
                }
            </style>
        </head>
        <body>
            <img src="${imageData}" alt="预览">
        </body>
        </html>
    `);
}

async function copyImage(index) {
    if (!currentImagesPhrase || !currentImagesPhrase.images[index]) return;
    
    try {
        const imageData = currentImagesPhrase.images[index];
        
        // 将Base64转换为Blob
        const response = await fetch(imageData);
        const blob = await response.blob();
        
        // 复制到剪贴板
        await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
        ]);
        
        showToast('✅ 已复制');
        
        // 复制成功后关闭对话框（100ms，快速关闭）
        setTimeout(() => {
            closeImagesDialog();
        }, 100);
    } catch (error) {
        console.error('复制图片失败:', error);
        showToast('❌ 复制失败（可能不支持图片复制）', 'error');
    }
}

async function deleteImage(index) {
    if (!currentImagesPhrase) return;

    const result = await showDeleteConfirmDialog(
        '🗑️ 删除图片',
        '确定要删除这张图片吗？',
        { showPermanentDelete: false }
    );
    if (result === 'cancel') return;

    try {
        await db.removeImageFromPhrase(currentImagesPhrase.id, index);

        // 重新加载话术数据
        const phrases = await db.searchPhrases();
        currentImagesPhrase = phrases.find(p => p.id === currentImagesPhrase.id);

        // 重新渲染图片列表
        renderImages();

        // 刷新话术列表（更新图片指示器）
        await loadPhrases();

        showToast('✅ 图片已删除');
    } catch (error) {
        console.error('删除图片失败:', error);
        showToast('❌ 删除失败', 'error');
    }
}

function closeImagesDialog() {
    const dialog = document.getElementById('imagesDialog');
    dialog.style.display = 'none';
    currentImagesPhrase = null;
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
    
    // 清空容器
    const container = document.getElementById('imagesContainer');
    if (container) {
        container.innerHTML = '';
    }
}

// ==================== 设置对话框功能 ====================

async function openSettingsDialog() {
    console.log('🔧 打开设置对话框');
    const dialog = document.getElementById('settingsDialog');
    dialog.style.display = 'flex';
    
    // 绑定搜索框字幕开关事件
    const searchMarqueeToggle = document.getElementById('searchMarqueeToggle');
    if (searchMarqueeToggle) {
        // 加载字幕开关状态
        const enabled = localStorage.getItem('searchMarqueeEnabled') !== 'false';
        searchMarqueeToggle.checked = enabled;

        searchMarqueeToggle.addEventListener('change', () => {
            const enabled = searchMarqueeToggle.checked;
            localStorage.setItem('searchMarqueeEnabled', enabled);
            updateMarqueeVisibility();
        });
    }

    // 绑定字幕编辑按钮事件
    const editSearchMarqueeBtn = document.getElementById('editSearchMarqueeBtn');
    if (editSearchMarqueeBtn) {
        editSearchMarqueeBtn.addEventListener('click', openSearchMarqueeDialog);
    }

    // 加载当前设置
    loadSubcategoryModeSettings();
    loadTitleCollapseSettings();
    loadLimitSubcategoryHeightSettings();
    loadAutoFocusAfterCopySettings();

    // 绑定回收站按钮事件
    const recycleBinBtn = document.getElementById('recycleBinBtn');
    if (recycleBinBtn) {
        recycleBinBtn.addEventListener('click', async () => {
            console.log('🗑️ 点击设置页面的回收站按钮');

            // 获取回收站分类ID
            const categories = await db.getAllCategories();
            const recycleCategory = categories.find(cat => isRecycleCategory(cat));

            if (recycleCategory) {
                // 设置当前选中的分类为回收站分类
                currentSelectedCategoryId = recycleCategory.id.toString();
                console.log('✅ 选中回收站分类:', currentSelectedCategoryId);

                // 保存当前选择的分类到本地存储
                chrome.storage.local.set({ lastSelectedCategory: currentSelectedCategoryId });

                // 保存到当前客户标签页并更新标签页显示
                await saveCurrentTabState();
                renderCustomerTabs();
                saveCustomerTabs();

                // 更新分类导航的激活状态
                await loadCategories();
            }

            // 🗑️ 显示回收站视图
            await loadRecycleBin();

            // 切换到"话术"标签页
            const tabBtns = document.querySelectorAll('.tab-btn');
            const searchTabBtn = Array.from(tabBtns).find(btn => btn.dataset.tab === 'search');
            if (searchTabBtn) {
                searchTabBtn.click();
            }

            // 关闭设置对话框
            closeSettingsDialog();
        });
    }

    
    // 绑定启用备份复选框事件
    const enableSecondBackup = document.getElementById('enableSecondBackup');
    const secondBackupSettings = document.getElementById('secondBackupSettings');

    if (enableSecondBackup && secondBackupSettings) {
        // 加载备份开关状态
        const backupEnabled = await db.getSetting('enableSecondBackup', 'false') === 'true';
        enableSecondBackup.checked = backupEnabled;

        // 根据开关状态显示/隐藏设置区域
        if (backupEnabled) {
            secondBackupSettings.style.display = 'block';
            // 加载备份路径
            const backupPath = await db.getSetting('secondBackupPath', '');
            const backupPathInput = document.getElementById('secondBackupPath');
            if (backupPathInput) {
                backupPathInput.value = backupPath;
            }
            // 加载最大备份数量
            const maxBackupCount = await db.getSetting('maxBackupCount', '10');
            const maxBackupCountInput = document.getElementById('maxBackupCount');
            if (maxBackupCountInput) {
                maxBackupCountInput.value = maxBackupCount;
            }
        }
        
        // 绑定复选框变化事件
        enableSecondBackup.addEventListener('change', async () => {
            const enabled = enableSecondBackup.checked;
            await db.setSetting('enableSecondBackup', enabled.toString());

            if (enabled) {
                secondBackupSettings.style.display = 'block';
                console.log('✅ 已启用第二数据库备份');

                // 如果已有备份路径，立即启动备份
                const backupPathInput = document.getElementById('secondBackupPath');
                const backupPath = backupPathInput ? backupPathInput.value : '';
                if (backupPath) {
                    console.log(`[备份] ✅ 检测到已有备份路径，立即启动: ${backupPath}`);
                    const maxBackupCountInput = document.getElementById('maxBackupCount');
                    const maxBackupCount = maxBackupCountInput ? parseInt(maxBackupCountInput.value) || 10 : 10;

                    if (window.pythonBridge && typeof window.pythonBridge.start_second_backup_with_config === 'function') {
                        try {
                            const success = await window.pythonBridge.start_second_backup_with_config(backupPath, maxBackupCount);
                            if (success) {
                                showToast('✅ 轮转备份已启动', 'success', 700);
                            } else {
                                showToast('❌ 备份启动失败', 'error', 700);
                            }
                        } catch (error) {
                            console.error('启动备份失败:', error);
                            showToast('❌ 备份启动失败', 'error', 700);
                        }
                    }
                }
            } else {
                secondBackupSettings.style.display = 'none';
                console.log('❌ 已禁用第二数据库备份');
                // 禁用时也停止备份同步
                if (window.pythonBridge && typeof window.pythonBridge.stop_second_backup === 'function') {
                    try {
                        await window.pythonBridge.stop_second_backup();
                    } catch (error) {
                        console.error('停止备份同步失败:', error);
                    }
                }
            }
        });
    }
    
    // 绑定浏览文件夹按钮事件
    const browseBackupPathBtn = document.getElementById('browseBackupPathBtn');
    if (browseBackupPathBtn) {
        browseBackupPathBtn.addEventListener('click', async () => {
            console.log('📁 点击浏览备份文件夹按钮');

            if (window.pythonBridge && typeof window.pythonBridge.select_backup_folder === 'function') {
                try {
                    const selectedPath = await window.pythonBridge.select_backup_folder();
                    if (selectedPath) {
                        // 更新路径输入框
                        const backupPathInput = document.getElementById('secondBackupPath');
                        if (backupPathInput) {
                            backupPathInput.value = selectedPath;
                        }

                        // 保存路径到数据库
                        await db.setSetting('secondBackupPath', selectedPath);

                        // 保存最大备份数量
                        const maxBackupCountInput = document.getElementById('maxBackupCount');
                        const maxBackupCount = maxBackupCountInput ? parseInt(maxBackupCountInput.value) || 10 : 10;
                        await db.setSetting('maxBackupCount', maxBackupCount.toString());

                        // 启动备份同步
                        if (enableSecondBackup && enableSecondBackup.checked) {
                            if (window.pythonBridge && typeof window.pythonBridge.start_second_backup_with_config === 'function') {
                                try {
                                    const success = await window.pythonBridge.start_second_backup_with_config(selectedPath, maxBackupCount);
                                    if (success) {
                                        showToast('✅ 轮转备份已启动', 'success', 700);
                                    } else {
                                        showToast('❌ 备份启动失败', 'error', 700);
                                    }
                                } catch (error) {
                                    console.error('启动备份失败:', error);
                                    showToast('❌ 备份启动失败', 'error', 700);
                                }
                            }
                        }

                        showToast('✅ 备份路径已设置', 'success', 700);
                        console.log('✅ 备份路径已设置:', selectedPath);
                    } else {
                        console.log('❌ 用户取消了文件夹选择');
                    }
                } catch (error) {
                    console.error('选择备份文件夹失败:', error);
                    showToast('❌ 选择文件夹失败', 'error', 700);
                }
            } else {
                console.error('❌ Python桥接方法 select_backup_folder 不可用');
                showToast('❌ 功能不可用', 'error', 700);
            }
        });
    }

    // 绑定最大备份数量变化事件
    const maxBackupCountInput = document.getElementById('maxBackupCount');
    if (maxBackupCountInput) {
        maxBackupCountInput.addEventListener('change', async () => {
            const value = parseInt(maxBackupCountInput.value) || 10;
            const clampedValue = Math.max(1, Math.min(50, value));
            maxBackupCountInput.value = clampedValue;
            await db.setSetting('maxBackupCount', clampedValue.toString());
            console.log(`[备份] 最大备份数量已更新: ${clampedValue}`);
        });
    }

    // 绑定导入备份按钮事件
    const importBackupBtn = document.getElementById('importBackupBtn');
    if (importBackupBtn) {
        importBackupBtn.addEventListener('click', async () => {
            console.log('📂 点击导入备份按钮');

            if (!window.pythonBridge || typeof window.pythonBridge.select_import_backup_folder !== 'function') {
                showToast('❌ 功能不可用', 'error', 700);
                return;
            }

            try {
                // 选择备份文件夹
                const selectedPath = await window.pythonBridge.select_import_backup_folder();
                if (!selectedPath) {
                    console.log('❌ 用户取消了文件夹选择');
                    return;
                }

                // 确认导入
                const confirmed = confirm(
                    '⚠️ 导入备份将替换当前所有数据！\n\n' +
                    '此操作会：\n' +
                    '1. 备份当前数据（以防万一）\n' +
                    '2. 用备份数据替换当前数据\n' +
                    '3. 需要重启软件才能生效\n\n' +
                    '确定要继续吗？'
                );

                if (!confirmed) {
                    console.log('❌ 用户取消了导入');
                    return;
                }

                // 执行导入
                showToast('⏳ 正在导入备份数据...', 'info', 3000);
                const result = await window.pythonBridge.import_backup_data(selectedPath);

                // 显示结果
                if (result.startsWith('✅')) {
                    alert(result);
                    // 提示重启
                    const restartConfirmed = confirm('需要重启软件才能加载新数据，是否现在关闭软件？');
                    if (restartConfirmed) {
                        window.close();
                    }
                } else {
                    showToast(result, 'error', 5000);
                }

            } catch (error) {
                console.error('导入备份失败:', error);
                showToast('❌ 导入失败: ' + error.message, 'error', 5000);
            }
        });
    }

}

// ========== 上班默认网址管理 ==========

const DEFAULT_WORK_URL = 'https://www.baidu.com';

// 获取当前设置的默认网址
function getWorkDefaultUrl() {
    return localStorage.getItem('workDefaultUrl') || DEFAULT_WORK_URL;
}

// 保存默认网址
function saveWorkDefaultUrl(url) {
    localStorage.setItem('workDefaultUrl', url);
}

// 显示设置默认网址弹窗
function showSetDefaultUrlDialog() {
    const dialog = document.getElementById('setDefaultUrlDialog');
    const input = document.getElementById('defaultUrlInput');
    if (dialog && input) {
        input.value = getWorkDefaultUrl();
        dialog.style.display = 'flex';
    }
}

// 关闭设置默认网址弹窗
function closeSetDefaultUrlDialog() {
    const dialog = document.getElementById('setDefaultUrlDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}

// 保存默认网址
function saveDefaultUrl() {
    const input = document.getElementById('defaultUrlInput');
    if (input) {
        let url = input.value.trim();
        if (!url) {
            showToast('❌ 请输入网址', 'error');
            return;
        }
        // 如果没有协议前缀，自动添加 https://
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        saveWorkDefaultUrl(url);
        showToast('✅ 默认网址已保存', 'success');
        closeSetDefaultUrlDialog();
    }
}

// 恢复默认网址
function resetDefaultUrl() {
    const input = document.getElementById('defaultUrlInput');
    if (input) {
        input.value = DEFAULT_WORK_URL;
    }
}

// 打开默认网址
function openDefaultWorkUrl() {
    const url = getWorkDefaultUrl();
    if (window.pythonBridge && typeof window.pythonBridge.open_url === 'function') {
        window.pythonBridge.open_url(url);
    } else {
        // 如果没有 open_url 方法，尝试用 open_browser
        if (window.pythonBridge && typeof window.pythonBridge.open_browser === 'function') {
            window.pythonBridge.open_browser(url);
        }
    }
    closeWorkPopover();
}

function closeSettingsDialog() {
    const dialog = document.getElementById('settingsDialog');
    dialog.style.display = 'none';
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
}

/**
 * 软件启动时自动恢复备份同步
 */
async function autoRestoreBackupSync() {
    try {
        console.log('[备份] 🔄 检查备份配置...');

        // 读取备份配置
        const backupEnabled = await db.getSetting('enableSecondBackup', 'false') === 'true';
        const backupPath = await db.getSetting('secondBackupPath', '');
        const maxBackupCount = parseInt(await db.getSetting('maxBackupCount', '10')) || 10;

        if (!backupEnabled) {
            console.log('[备份] ⚠️ 备份功能未启用，跳过自动同步');
            return;
        }

        if (!backupPath) {
            console.log('[备份] ⚠️ 未找到备份路径配置，跳过自动同步');
            return;
        }

        console.log(`[备份] ✅ 软件启动，开始自动恢复轮转备份: ${backupPath}`);
        console.log(`[备份] 📦 最大备份数量: ${maxBackupCount}`);

        // 检查 Python Bridge 是否可用
        if (window.pythonBridge && typeof window.pythonBridge.start_second_backup_with_config === 'function') {
            const success = await window.pythonBridge.start_second_backup_with_config(backupPath, maxBackupCount);
            if (success) {
                console.log('[备份] ✅ 轮转备份已自动恢复');
            } else {
                console.log('[备份] ❌ 轮转备份自动恢复失败');
            }
        } else {
            console.log('[备份] ❌ Python Bridge 不可用，无法自动恢复备份');
        }
    } catch (error) {
        console.error('[备份] ❌ 自动恢复备份同步时出错:', error);
    }
}

// 打开使用日志对话框
async function openUsageLogDialog() {
    const dialog = document.getElementById('usageLogDialog');
    const content = document.getElementById('usageLogContent');
    
    if (!dialog || !content) {
        console.error('❌ 使用日志对话框元素未找到');
        return;
    }
    
    dialog.style.display = 'flex';
    
    // 生成日志内容
    try {
        const logText = await generateUsageLog();
        content.textContent = logText;
    } catch (error) {
        console.error('生成使用日志失败:', error);
        content.textContent = '❌ 生成使用日志失败: ' + error.message;
    }
}

// 关闭使用日志对话框
function closeUsageLogDialog() {
    const dialog = document.getElementById('usageLogDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
}

// 生成使用日志
async function generateUsageLog() {
    const allPhrases = await db.getAllPhrases();
    const allCategories = await db.getAllCategories();
    
    // 创建分类ID到名称的映射
    const categoryMap = new Map();
    allCategories.forEach(cat => {
        categoryMap.set(cat.id, cat.name);
    });
    
    // 过滤出未删除的话术
    const activePhrases = allPhrases.filter(p => !p.is_deleted);
    
    // 1. 使用频率统计
    const phrasesWithUsage = activePhrases
        .filter(p => (p.use_count || 0) > 0)
        .map(p => ({
            id: p.id,
            content: p.content.substring(0, 50) + (p.content.length > 50 ? '...' : ''),
            category: categoryMap.get(p.category_id) || '未分类',
            use_count: p.use_count || 0,
            last_used: p.last_used || null
        }))
        .sort((a, b) => b.use_count - a.use_count);
    
    // 2. 最常用话术排行（Top 20）
    const topPhrases = phrasesWithUsage.slice(0, 20);
    
    // 3. 使用时间分布
    const timeDistribution = {
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
        older: 0
    };
    
    const now = new Date();
    phrasesWithUsage.forEach(p => {
        if (!p.last_used) return;
        const lastUsed = new Date(p.last_used);
        const diffDays = Math.floor((now - lastUsed) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
            timeDistribution.today++;
        } else if (diffDays <= 7) {
            timeDistribution.thisWeek++;
        } else if (diffDays <= 30) {
            timeDistribution.thisMonth++;
        } else {
            timeDistribution.older++;
        }
    });
    
    // 生成日志文本
    let log = '═══════════════════════════════════════════════════════════\n';
    log += '📊 卓雅话术助手 - 使用统计日志\n';
    log += '═══════════════════════════════════════════════════════════\n';
    log += `生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
    
    // 总体统计
    log += '【总体统计】\n';
    log += `总话术数: ${activePhrases.length}\n`;
    log += `已使用话术数: ${phrasesWithUsage.length}\n`;
    log += `未使用话术数: ${activePhrases.length - phrasesWithUsage.length}\n`;
    log += `总使用次数: ${phrasesWithUsage.reduce((sum, p) => sum + p.use_count, 0)}\n\n`;
    
    // 使用时间分布
    log += '【使用时间分布】\n';
    log += `今天使用: ${timeDistribution.today} 条\n`;
    log += `本周使用: ${timeDistribution.thisWeek} 条\n`;
    log += `本月使用: ${timeDistribution.thisMonth} 条\n`;
    log += `更早使用: ${timeDistribution.older} 条\n\n`;
    
    // 最常用话术排行
    log += '【最常用话术 Top 20】\n';
    if (topPhrases.length === 0) {
        log += '暂无使用记录\n\n';
    } else {
        topPhrases.forEach((p, index) => {
            const lastUsedStr = p.last_used 
                ? new Date(p.last_used).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '从未使用';
            log += `${(index + 1).toString().padStart(2, ' ')}. [${p.category}] ${p.content}\n`;
            log += `    使用次数: ${p.use_count} | 最后使用: ${lastUsedStr}\n`;
        });
        log += '\n';
    }
    
    // 分类使用统计（分类点击次数）
    log += '【分类使用统计（分类点击次数）】\n';
    const categoriesWithUsage = allCategories
        .filter(cat => (cat.use_count || 0) > 0)
        .map(cat => ({
            id: cat.id,
            name: cat.name,
            parent_id: cat.parent_id || 0,
            use_count: cat.use_count || 0,
            last_used: cat.last_used || null,
            isTopLevel: (cat.parent_id || 0) === 0
        }))
        .sort((a, b) => b.use_count - a.use_count);
    
    // 一级分类统计
    const topLevelCategories = categoriesWithUsage.filter(c => c.isTopLevel);
    if (topLevelCategories.length === 0) {
        log += '一级分类：暂无使用记录\n';
    } else {
        log += '一级分类：\n';
        topLevelCategories.forEach((cat, index) => {
            const lastUsedStr = cat.last_used 
                ? new Date(cat.last_used).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '从未使用';
            log += `  ${(index + 1).toString().padStart(2, ' ')}. ${cat.name}: 点击 ${cat.use_count} 次 | 最后使用: ${lastUsedStr}\n`;
        });
    }
    
    // 二级分类统计
    const subCategories = categoriesWithUsage.filter(c => !c.isTopLevel);
    if (subCategories.length === 0) {
        log += '二级分类：暂无使用记录\n\n';
    } else {
        log += '二级分类：\n';
        subCategories.forEach((cat, index) => {
            const parentName = categoryMap.get(cat.parent_id) || '未知';
            const lastUsedStr = cat.last_used 
                ? new Date(cat.last_used).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                : '从未使用';
            log += `  ${(index + 1).toString().padStart(2, ' ')}. [${parentName}] ${cat.name}: 点击 ${cat.use_count} 次 | 最后使用: ${lastUsedStr}\n`;
        });
        log += '\n';
    }
    
    // 话术使用统计（按分类分组）
    log += '【话术使用统计（按分类分组）】\n';
    const categoryStats = new Map();
    phrasesWithUsage.forEach(p => {
        const catName = p.category;
        if (!categoryStats.has(catName)) {
            categoryStats.set(catName, []);
        }
        categoryStats.get(catName).push(p);
    });
    
    // 按分类使用总次数排序
    const sortedCategoryStats = Array.from(categoryStats.entries())
        .map(([catName, phrases]) => ({
            name: catName,
            phrases: phrases.sort((a, b) => b.use_count - a.use_count),
            totalUsage: phrases.reduce((sum, p) => sum + p.use_count, 0)
        }))
        .sort((a, b) => b.totalUsage - a.totalUsage);
    
    if (sortedCategoryStats.length === 0) {
        log += '暂无使用记录\n\n';
    } else {
        sortedCategoryStats.forEach((catData, catIndex) => {
            log += `\n【${catData.name}】（共 ${catData.phrases.length} 条话术，总使用 ${catData.totalUsage} 次）\n`;
            catData.phrases.forEach((p, index) => {
                const lastUsedStr = p.last_used 
                    ? new Date(p.last_used).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : '从未使用';
                log += `  ${(index + 1).toString().padStart(2, ' ')}. ${p.content}\n`;
                log += `      使用次数: ${p.use_count} | 最后使用: ${lastUsedStr}\n`;
            });
        });
        log += '\n';
    }
    
    // 详细使用记录（最近使用的50条，按时间排序）
    log += '【最近使用记录（最近50条，按时间排序）】\n';
    const recentPhrases = phrasesWithUsage
        .filter(p => p.last_used)
        .sort((a, b) => new Date(b.last_used) - new Date(a.last_used))
        .slice(0, 50);
    
    if (recentPhrases.length === 0) {
        log += '暂无使用记录\n';
    } else {
        recentPhrases.forEach((p, index) => {
            const lastUsed = new Date(p.last_used);
            const timeStr = lastUsed.toLocaleString('zh-CN', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            log += `${(index + 1).toString().padStart(2, ' ')}. [${timeStr}] [${p.category}] ${p.content}\n`;
        });
    }
    
    log += '\n═══════════════════════════════════════════════════════════\n';
    log += '日志结束\n';
    
    return log;
}


// ==================== 二级分类显示模式设置 ====================

// 渲染平铺的二级分类区域（复用弹层渲染逻辑）
async function renderSubcategoryTabsArea(parentCategoryId) {
    
    const categories = allCategoriesCache || await db.getAllCategories();
    const parentCategory = categories.find(c => String(getCategoryId(c)) === String(parentCategoryId));
    
    if (!parentCategory) {
        console.log('[TABS] 未找到父分类');
        return null;
    }
    
    const catIdNum = getCategoryId(parentCategory);
    const children = categories.filter(c => getCategoryParentId(c) === catIdNum);
    if (children.length === 0) {
        return null;
    }
    
    // 创建容器（使用 popover-list 样式，但改为横向布局）
    const container = document.createElement('div');
    container.className = 'popover-list subcategory-tabs-container';
    container.dataset.parentId = String(parentCategoryId); // 保存父级ID，用于判断是否需要重新渲染
    
    // 根据设置决定是否限制高度（默认为 true）
    try {
        const limitSetting = await db.getSetting('limitSubcategoryHeight', 'true');
        if (limitSetting === 'true') {
            container.classList.add('limited-height');
        }
    } catch (e) {
        console.warn('[TABS] 读取 limitSubcategoryHeight 设置失败:', e);
    }
    // 🎨 应用主题样式
    const activeThemeClass = getActiveThemeClass();
    if (activeThemeClass) {
        applyThemeClass(container, activeThemeClass);
    }
    
    // 🔄 复用弹层的按钮创建逻辑
    children.forEach(ch => {
        const row = document.createElement('div');
        row.className = 'popover-item';
        row.dataset.categoryId = String(ch.id); // 用于查找激活状态
        row.dataset.id = String(ch.id); // 保留原有属性
        row.dataset.parentId = String(parentCategoryId);
        if (String(ch.id) === currentSelectedCategoryId) {
            row.classList.add('active');
        }

        if (isCategorySortModeActive) {
            row.draggable = true;
            row.addEventListener('dragstart', handleSubcategoryDragStart);
            row.addEventListener('dragover', handleSubcategoryDragOver);
            row.addEventListener('dragleave', handleSubcategoryDragLeave);
            row.addEventListener('drop', handleSubcategoryDrop);
            row.addEventListener('dragend', handleSubcategoryDragEnd);
        } else {
            row.draggable = false;
        }
        
        // 创建分类名称容器
        const nameContainer = document.createElement('div');
        nameContainer.className = 'popover-item-name-container';
        
        // 创建分类名称
        const nameSpan = document.createElement('span');
        nameSpan.className = 'popover-item-name';
        nameSpan.textContent = ch.name;
        nameContainer.appendChild(nameSpan);
        
        // 只有当 show_text_editor 为 true 时才创建按钮
        const showTextEditor = ch.show_text_editor === true;
        let textIconBtn = null;
        if (showTextEditor) {
            textIconBtn = document.createElement('button');
            textIconBtn.className = 'popover-text-icon-btn';
            textIconBtn.textContent = '📝';
            textIconBtn.title = '打开文本编辑器';
            textIconBtn.style.display = 'inline-flex';
            textIconBtn.style.alignItems = 'center';
            textIconBtn.style.justifyContent = 'center';
            textIconBtn.style.background = 'transparent';
            textIconBtn.style.border = 'none';
            textIconBtn.style.padding = '0';
            textIconBtn.style.fontSize = '14px';
            textIconBtn.style.lineHeight = '1';
            textIconBtn.style.cursor = 'pointer';
            textIconBtn.style.opacity = '0.8';
            textIconBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await openCategoryTextEditor(ch.id, ch.name);
            });
        }
        
        if (textIconBtn) {
            nameContainer.appendChild(textIconBtn);
        }
        row.appendChild(nameContainer);
        
        row.addEventListener('click', async (e) => {
            if (e.target.classList.contains('popover-text-icon-btn')) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();

            // 立即更新视觉反馈：清除同容器内已有 active，再为当前按钮添加 active
            try {
                const parent = row.parentElement;
                if (parent) {
                    parent.querySelectorAll('.popover-item.active').forEach(el => el.classList.remove('active'));
                }
                row.classList.add('active');
            } catch (err) {
                console.warn('[UI] 更新平铺按钮 active 状态失败', err);
            }

            // 保存二级分类点击记录
            await saveSubCategoryClickHistory(ch.id, ch.name, parentCategoryId, parentCategory.name);

            // 使用快速切换模式，不刷新左侧导航和动画
            await selectCategory(ch.id, true);
        });

        // 绑定右键菜单事件（二级分类-平铺）
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showCategoryContextMenu(e, ch.id);
        });
        
        container.appendChild(row);
    });

    // 容器空白区域右键 → 只显示"添加分类"（父级为当前一级分类）
    container.addEventListener('contextmenu', (e) => {
        if (e.target === container) {
            e.preventDefault();
            window._isBlankAreaRightClick = true;
            showCategoryContextMenu(e, parentCategoryId);
        }
    });

    return container;
}

// 更新平铺二级分类区域的激活状态（不重新渲染）
function updateSubcategoryTabsActiveState() {
    const phraseList = document.getElementById('phraseList');
    if (!phraseList) {
        console.log('⚠️ 未找到 phraseList');
        return false;
    }
    const tabsContainer = phraseList.querySelector('.subcategory-tabs-container');
    if (!tabsContainer) {
        console.log('⚠️ 未找到平铺区域容器');
        return false;
    }
    
    // 移除所有按钮的 active 类
    
    // 移除所有按钮的 active 类
    const allButtons = tabsContainer.querySelectorAll('.popover-item');
    allButtons.forEach(btn => {
        btn.classList.remove('active');
    });
    
    // 为当前选中的分类添加 active 类
    if (currentSelectedCategoryId) {
        const activeBtn = tabsContainer.querySelector(`[data-category-id="${currentSelectedCategoryId}"]`);
        if (activeBtn) {
            activeBtn.classList.add('active');
        }
    }
    
    return true;
}

function updatePrimaryCategoryTilesActiveState() {
    const tilesContainer = document.getElementById('primaryCategoryTiles');
    if (!tilesContainer) return false;

    const items = tilesContainer.querySelectorAll('.category-nav-item');
    if (items.length === 0) return false;

    // 先找到当前选中分类的父级一级分类ID
    let parentCategoryIdToKeep = null;
    if (currentSelectedCategoryId && allCategoriesCache) {
        const selectedCat = allCategoriesCache.find(c => c.id.toString() === currentSelectedCategoryId);
        // 输出到终端
        const logMsg1 = `[DEBUG] selectedCat: ${selectedCat ? selectedCat.name : 'null'}, currentSelectedCategoryId: ${currentSelectedCategoryId}`;
        console.log(logMsg1);
        if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
            window.pythonBridge.log_to_terminal(logMsg1);
        }

        if (selectedCat) {
            const parentId = getCategoryParentId(selectedCat);
            const logMsg2 = `[DEBUG] parentId: ${parentId}, type: ${typeof parentId}`;
            console.log(logMsg2);
            if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                window.pythonBridge.log_to_terminal(logMsg2);
            }

            if (parentId !== 0) {
                // 选中的是二级分类，找到其父级一级分类ID
                parentCategoryIdToKeep = parentId.toString();
                const logMsg3 = `[DEBUG] parentCategoryIdToKeep: ${parentCategoryIdToKeep}`;
                console.log(logMsg3);
                if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                    window.pythonBridge.log_to_terminal(logMsg3);
                }
            }
        }
    }

    const logMsg5 = `[DEBUG] 开始遍历一级分类按钮，共 ${items.length} 个`;
    console.log(logMsg5);
    if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
        window.pythonBridge.log_to_terminal(logMsg5);
    }

    items.forEach(item => {
        const itemId = item.dataset.id;
        const hadActive = item.classList.contains('active');
        item.classList.remove('active');

        if (!itemId && currentSelectedCategoryId === '0') {
            item.classList.add('active');
            return;
        }

        // 直接选中一级分类
        if (itemId && currentSelectedCategoryId && itemId === currentSelectedCategoryId) {
            item.classList.add('active');
            const logMsg6 = `[DEBUG] 直接选中一级分类: ${itemId}, 之前active: ${hadActive}, 现在active: ${item.classList.contains('active')}`;
            console.log(logMsg6);
            if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                window.pythonBridge.log_to_terminal(logMsg6);
            }
        }
        // 选中二级分类时，保持其父级一级分类的active状态
        else if (itemId && parentCategoryIdToKeep && itemId === parentCategoryIdToKeep) {
            item.classList.add('active');
            const logMsg7 = `[DEBUG] ✅ 添加active到一级分类: ${itemId}, 之前active: ${hadActive}, 现在active: ${item.classList.contains('active')}`;
            console.log(logMsg7);
            if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                window.pythonBridge.log_to_terminal(logMsg7);
            }
        }
        else {
            if (hadActive) {
                const logMsg8 = `[DEBUG] ❌ 移除active从一级分类: ${itemId}`;
                console.log(logMsg8);
                if (window.pythonBridge && window.pythonBridge.log_to_terminal) {
                    window.pythonBridge.log_to_terminal(logMsg8);
                }
            }
        }
    });

    updateCategoryIndicator();
    return true;
}

function updateCategoryNameInUI(categoryId, newName) {
    if (!categoryId) return;
    
    const catIdStr = String(categoryId);
    
    if (allCategoriesCache) {
        const cat = allCategoriesCache.find(c => String(getCategoryId(c)) === catIdStr);
        if (cat) {
            cat.name = newName;
        }
    }
    
    const primaryTile = document.querySelector(`.category-nav-item[data-id="${catIdStr}"] .cat-label`);
    if (primaryTile) {
        primaryTile.textContent = newName;
    }
    
    const subcategoryTab = document.querySelector(`.popover-item[data-category-id="${catIdStr}"] .popover-item-name`);
    if (subcategoryTab) {
        subcategoryTab.textContent = newName;
    }
    
    const popoverItem = document.querySelector(`.popover-item[data-id="${catIdStr}"] .popover-item-name`);
    if (popoverItem) {
        popoverItem.textContent = newName;
    }
}

// 更新平铺二级分类区域的排序模式状态（不重新渲染）
function updateSubcategoryTabsSortMode() {
    const phraseList = document.getElementById('phraseList');
    if (!phraseList) return false;
    const tabsContainer = phraseList.querySelector('.subcategory-tabs-container');
    if (!tabsContainer) {
        return false;
    }
    
    console.log('🔄 更新平铺区域排序模式状态，排序模式:', isCategorySortModeActive);
    
    const allButtons = tabsContainer.querySelectorAll('.popover-item');
    allButtons.forEach(btn => {
        if (isCategorySortModeActive) {
            // 进入排序模式
            btn.draggable = true;
            // 移除旧的事件监听器（如果有）
            btn.removeEventListener('dragstart', handleSubcategoryDragStart);
            btn.removeEventListener('dragover', handleSubcategoryDragOver);
            btn.removeEventListener('dragleave', handleSubcategoryDragLeave);
            btn.removeEventListener('drop', handleSubcategoryDrop);
            btn.removeEventListener('dragend', handleSubcategoryDragEnd);
            // 添加新的事件监听器
            btn.addEventListener('dragstart', handleSubcategoryDragStart);
            btn.addEventListener('dragover', handleSubcategoryDragOver);
            btn.addEventListener('dragleave', handleSubcategoryDragLeave);
            btn.addEventListener('drop', handleSubcategoryDrop);
            btn.addEventListener('dragend', handleSubcategoryDragEnd);
        } else {
            // 退出排序模式
            btn.draggable = false;
            // 移除事件监听器
            btn.removeEventListener('dragstart', handleSubcategoryDragStart);
            btn.removeEventListener('dragover', handleSubcategoryDragOver);
            btn.removeEventListener('dragleave', handleSubcategoryDragLeave);
            btn.removeEventListener('drop', handleSubcategoryDrop);
            btn.removeEventListener('dragend', handleSubcategoryDragEnd);
        }
    });
    
    console.log('✅ 已更新平铺区域排序模式，共', allButtons.length, '个按钮');
    return true;
}

// 创建二级分类标签按钮（复用弹层样式）
function createSubcategoryTabButton(category, parentCategoryId, isAllButton) {
    console.log('🎨 创建按钮:', category.name, 'ID:', category.id);
    
    const btn = document.createElement('div');
    btn.className = 'popover-item'; // 复用弹层的样式类
    if (String(category.id) === currentSelectedCategoryId) {
        btn.classList.add('active');
    }
    
    // 只设置必要的样式，保留CSS类的其他样式
    btn.style.display = 'inline-flex';
    btn.style.margin = '0';
    btn.style.flexShrink = '0';
    
    console.log('  按钮类名:', btn.className);
    
    // 创建分类名称容器
    const nameContainer = document.createElement('div');
    nameContainer.className = 'popover-item-name-container';
    
    // 创建分类名称
    const nameSpan = document.createElement('span');
    nameSpan.className = 'popover-item-name';
    nameSpan.textContent = category.name;
    nameContainer.appendChild(nameSpan);
    
    // 如果有文本编辑器按钮
    const showTextEditor = category.show_text_editor === true;
    let textIconBtn = null;
    if (showTextEditor && !isAllButton) {
        textIconBtn = document.createElement('button');
        textIconBtn.className = 'popover-text-icon-btn';
        textIconBtn.textContent = '📝';
        textIconBtn.title = '打开文本编辑器';
        textIconBtn.style.display = 'inline-flex';
        textIconBtn.style.alignItems = 'center';
        textIconBtn.style.justifyContent = 'center';
        textIconBtn.style.background = 'transparent';
        textIconBtn.style.border = 'none';
        textIconBtn.style.padding = '0';
        textIconBtn.style.fontSize = '14px';
        textIconBtn.style.lineHeight = '1';
        textIconBtn.style.cursor = 'pointer';
        textIconBtn.style.opacity = '0.8';
        textIconBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await openCategoryTextEditor(category.id, category.name);
        });
    }
    
    if (textIconBtn) {
        nameContainer.appendChild(textIconBtn);
    }
    btn.appendChild(nameContainer);
    
    // 点击事件
    btn.addEventListener('click', async (e) => {
        if (e.target.classList.contains('popover-text-icon-btn')) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();

        // 立即更新视觉反馈：清除同容器内已有 active，再为当前按钮添加 active
        try {
            const parent = btn.parentElement;
            if (parent) {
                parent.querySelectorAll('.popover-item.active').forEach(el => el.classList.remove('active'));
            }
            btn.classList.add('active');
        } catch (err) {
            console.warn('[UI] 更新按钮 active 状态失败', err);
        }

        if (!isAllButton) {
            // 保存二级分类点击记录
            const categories = allCategoriesCache || await db.getAllCategories();
            const parentCategory = categories.find(c => getCategoryId(c) === parentCategoryId);
            if (parentCategory) {
                await saveSubCategoryClickHistory(category.id, category.name, parentCategoryId, parentCategory.name);
            }
        }

        await selectCategory(category.id);
    });
    
    return btn;
}

async function loadSubcategoryModeSettings() {
    // 从数据库获取设置，默认为 'popover'（弹层模式）
    // ⚠️ PyQt 根目录版本说明：界面上已将”弹层模式”单选框禁用，实际只允许用户选择 tabs 平铺模式。
    // 这里仍然读取/保存 mode 只是为了兼容老数据和浏览器插件版本，不再对弹层模式做样式/交互优化。
    const mode = await db.getSetting('subcategoryDisplayMode', 'tabs');

    // 设置单选按钮状态
    const popoverRadio = document.getElementById('subcategoryModePopover');
    const tabsRadio = document.getElementById('subcategoryModeTabs');

    if (popoverRadio && tabsRadio) {
        popoverRadio.checked = mode === 'popover';
        tabsRadio.checked = mode === 'tabs';
        
        // 绑定事件（移除旧的事件监听器）
        const clonedPopover = popoverRadio.cloneNode(true);
        const clonedTabs = tabsRadio.cloneNode(true);
        popoverRadio.parentNode.replaceChild(clonedPopover, popoverRadio);
        tabsRadio.parentNode.replaceChild(clonedTabs, tabsRadio);
        
        clonedPopover.addEventListener('change', () => {
            console.log('🎯 弹层模式被选中');
            if (clonedPopover.checked) {
                saveSubcategoryModeSettings('popover');
            }
        });
        
        clonedTabs.addEventListener('change', () => {
            console.log('🎯 平铺模式被选中');
            if (clonedTabs.checked) {
                saveSubcategoryModeSettings('tabs');
            }
        });
        
    } else {
        console.error('❌ 未找到二级分类显示模式单选按钮');
    }
}

async function saveSubcategoryModeSettings(mode) {
    // 保存到数据库
    await db.setSetting('subcategoryDisplayMode', mode);
    
    showToast(`✅ 已切换到${mode === 'popover' ? '弹层' : '平铺'}模式`);
    
    // 重新加载话术列表以应用新模式
    await loadPhrases();
}

// ==================== 说明管理功能 ====================

// ==================== 变形话术功能 ====================

async function openVariantsDialog(phraseId, parentEl = null) {
    try {
        await toggleMoreChildren(phraseId, parentEl);
    } catch (e) {
        // ignore
    }
}

// ...
// ==================== 使用说明功能 ====================

let currentDescriptionPhrase = null;

async function openDescriptionDialog(phrase) {
    currentDescriptionPhrase = phrase;
    
    const dialog = document.getElementById('descriptionDialog');
    const editor = document.getElementById('descriptionContent');
    
    if (!dialog || !editor) {
        console.error('找不到说明对话框元素');
        return;
    }
    
    // 加载现有说明内容（支持 HTML）
    const phrases = await db.searchPhrases();
    const currentPhrase = phrases.find(p => p.id === phrase.id);
    if (currentPhrase && currentPhrase.description) {
        // 🔧 只有当有实际内容时才设置，避免空白字符影响 placeholder 显示
        const trimmedDescription = currentPhrase.description.trim();
        editor.innerHTML = trimmedDescription || '';
    } else {
        editor.innerHTML = '';
    }
    
    // 🔧 确保编辑器完全为空时，移除所有子节点（包括文本节点）
    if (!editor.innerHTML.trim()) {
        editor.innerHTML = '';
        // 清空所有子节点，确保 :empty 伪类生效
        while (editor.firstChild) {
            editor.removeChild(editor.firstChild);
        }
    }
    
    // 恢复保存的编辑器高度
    try {
        const result = await chrome.storage.local.get(['descriptionDialogHeight']);
        if (result.descriptionDialogHeight) {
            editor.style.height = result.descriptionDialogHeight;
        }
    } catch (error) {
        console.error('恢复说明对话框高度失败:', error);
    }
    
    dialog.style.display = 'flex';
    
    // 🔧 添加输入监听，动态控制 placeholder 显示
    const updatePlaceholder = () => {
        const text = editor.textContent.trim();
        if (text === '') {
            editor.setAttribute('data-empty', 'true');
        } else {
            editor.removeAttribute('data-empty');
        }
    };
    
    // 初始检查
    updatePlaceholder();
    
    // 监听输入事件
    if (!editor._placeholderListenerAdded) {
        editor.addEventListener('input', updatePlaceholder);
        editor.addEventListener('blur', updatePlaceholder);
        editor._placeholderListenerAdded = true;
    }
    
    // 聚焦到编辑器
    setTimeout(() => editor.focus(), 100);
    
    // 初始化右键菜单（如果还没初始化）
    if (!editor._contextMenuInitialized) {
        initDescriptionContextMenu();
        editor._contextMenuInitialized = true;
    }
}

async function saveDescription() {
    if (!currentDescriptionPhrase) {
        return;
    }
    
    const editor = document.getElementById('descriptionContent');
    if (!editor) {
        return;
    }
    
    // 获取 HTML 内容（富文本）
    const description = editor.innerHTML.trim();
    
    try {
        // 获取当前话术数据
        const phrases = await db.searchPhrases();
        const phrase = phrases.find(p => p.id === currentDescriptionPhrase.id);
        
        if (!phrase) {
            showToast('❌ 话术不存在', 'error');
            return;
        }
        
        // 更新说明内容
        await db.updatePhrase(
            phrase.id,
            phrase.content,
            phrase.category_id,
            phrase.tags || '',
            phrase.enable_placeholder !== undefined ? phrase.enable_placeholder : null,
            phrase.enable_images !== undefined ? phrase.enable_images : null,
            phrase.text_color || null,
            phrase.bg_color || null,
            phrase.is_bold || false,
            phrase.content_html || null,
            phrase.disable_click_copy !== undefined ? phrase.disable_click_copy : null,
            phrase.enable_description !== undefined ? phrase.enable_description : null,
            description
        );
        
        showToast('✅ 说明已保存');
        closeDescriptionDialog();
    } catch (error) {
        console.error('保存说明失败:', error);
        showToast('❌ 保存失败', 'error');
    }
}

async function closeDescriptionDialog() {
    // 关闭时自动保存说明
    if (currentDescriptionPhrase) {
        const editor = document.getElementById('descriptionContent');
        if (editor) {
            // 获取 HTML 内容（富文本）
            const description = editor.innerHTML.trim();
            
            try {
                // 获取当前话术数据
                const phrases = await db.searchPhrases();
                const phrase = phrases.find(p => p.id === currentDescriptionPhrase.id);
                
                if (phrase) {
                    // 更新说明内容
                    await db.updatePhrase(
                        phrase.id,
                        phrase.content,
                        phrase.category_id,
                        phrase.tags || '',
                        phrase.enable_placeholder !== undefined ? phrase.enable_placeholder : null,
                        phrase.enable_images !== undefined ? phrase.enable_images : null,
                        phrase.text_color || null,
                        phrase.bg_color || null,
                        phrase.is_bold || false,
                        phrase.content_html || null,
                        phrase.disable_click_copy !== undefined ? phrase.disable_click_copy : null,
                        phrase.enable_description !== undefined ? phrase.enable_description : null,
                        description
                    );
                    // 静默保存，不显示提示
                }
            } catch (error) {
                console.error('自动保存说明失败:', error);
                // 静默失败，不影响关闭操作
            }
        }
    }
    
    // 关闭时自动锁定编辑器
    const editor = document.getElementById('descriptionContent');
    if (editor) {
        // 锁定编辑器
        editor.contentEditable = 'false';
        
        // 🔧 清理内容，确保下次打开时 placeholder 正确显示
        if (!editor.textContent.trim()) {
            editor.innerHTML = '';
            editor.setAttribute('data-empty', 'true');
        }
        
        // 更新锁定菜单显示
        const lockMenuIcon = document.getElementById('descLockMenuIcon');
        const lockMenuText = document.getElementById('descLockMenuText');
        if (lockMenuIcon) {
            lockMenuIcon.textContent = '🔒';
        }
        if (lockMenuText) {
            lockMenuText.textContent = '解锁编辑';
        }
        
        // 更新右键菜单状态 - 禁用所有编辑功能
        const contextMenu = document.getElementById('descriptionContextMenu');
        if (contextMenu) {
            const menuItems = contextMenu.querySelectorAll('.context-menu-item');
            menuItems.forEach(item => {
                // 锁定/解锁选项始终可用
                if (item.dataset.command === 'toggleLock') {
                    item.classList.remove('disabled');
                } else {
                    item.classList.add('disabled');
                }
            });
        }
        
        // 禁用字体和颜色选择器
        const ctxFontSize = document.getElementById('descCtxFontSize');
        const ctxFontFamily = document.getElementById('descCtxFontFamily');
        const ctxTextColor = document.getElementById('descCtxTextColor');
        const ctxBgColor = document.getElementById('descCtxBgColor');
        
        if (ctxFontSize) ctxFontSize.disabled = true;
        if (ctxFontFamily) ctxFontFamily.disabled = true;
        if (ctxTextColor) ctxTextColor.disabled = true;
        if (ctxBgColor) ctxBgColor.disabled = true;
        
        console.log('[LOG] 使用说明已自动锁定');
    }
    
    const dialog = document.getElementById('descriptionDialog');
    if (dialog) {
        dialog.style.display = 'none';
    }
    currentDescriptionPhrase = null;
    
    // 隐藏通用右键菜单
    if (window.hideUniversalContextMenu) {
        window.hideUniversalContextMenu();
    }
    
    // 刷新话术列表
    loadPhrases();
}

// 将图片管理函数暴露到全局作用域，供HTML onclick使用
window.openImagesDialog = openImagesDialog;

// ==================== 分类右键菜单功能 ====================

// 当前右键菜单关联的分类ID
let currentContextMenuCategoryId = null;

// 全局弹层隐藏定时器管理（key: 弹层元素, value: 定时器ID）
const popoverHideTimers = new WeakMap();

// 初始化分类右键菜单
function initCategoryContextMenu() {
    const contextMenu = document.getElementById('categoryContextMenu');
    if (!contextMenu) {
        console.error('❌ 找不到分类右键菜单元素');
        return;
    }
    
    // 标记是否刚刚显示了菜单
    let justShownMenu = false;
    
    // 显示/隐藏右键菜单
    function showContextMenu(x, y, categoryId) {
        currentContextMenuCategoryId = categoryId;

        // 空白区域右键只显示"添加分类"
        if (window._isBlankAreaRightClick) {
            contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.style.display = item.dataset.action === 'addCategory' ? '' : 'none';
            });
            contextMenu.querySelectorAll('.context-menu-separator').forEach(s => { s.style.display = 'none'; });
            window._isBlankAreaRightClick = false;
        } else {
            contextMenu.querySelectorAll('.context-menu-item').forEach(item => { item.style.display = ''; });
            contextMenu.querySelectorAll('.context-menu-separator').forEach(s => { s.style.display = ''; });
        }

        // 先临时显示菜单以获取其尺寸
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('show');
        
        // 标记刚刚显示了菜单，防止立即被全局点击事件隐藏
        justShownMenu = true;
        setTimeout(() => {
            justShownMenu = false;
        }, 100);
        
        // 获取菜单的实际尺寸
        const menuRect = contextMenu.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;
        
        // 获取视口尺寸
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // 计算调整后的位置
        let adjustedX = x;
        let adjustedY = y;
        
        // 智能定位逻辑：计算左右剩余空间
        const spaceToRight = viewportWidth - x;
        const spaceToLeft = x;
        const RIGHT_MARGIN = 40;  // 菜单距右边缘的最小间距

        // 智能判断显示方向：哪边空间够就往哪边显示
        if (spaceToRight < menuWidth + RIGHT_MARGIN && spaceToLeft >= menuWidth) {
            // 右边空间不够（含缓冲），左边够：向左弹出
            adjustedX = Math.max(10, x - menuWidth);
        } else if (spaceToRight >= menuWidth + RIGHT_MARGIN) {
            // 右边空间充裕：向右弹出
            adjustedX = x;
        } else {
            // 两边都紧张：哪边空间大就往哪边 + 始终保留 10px 边距
            if (spaceToLeft > spaceToRight) {
                adjustedX = Math.max(10, x - menuWidth);
            } else {
                adjustedX = Math.max(10, viewportWidth - menuWidth - 10);
            }
        }
        
        // 检查下边界：如果菜单超出下边界，向上移动
        if (y + menuHeight > viewportHeight) {
            adjustedY = viewportHeight - menuHeight - 10; // 留10px边距
            // 确保不会超出上边界
            if (adjustedY < 10) {
                adjustedY = 10;
            }
        }
        
        // 应用调整后的位置
        contextMenu.style.left = adjustedX + 'px';
        contextMenu.style.top = adjustedY + 'px';
        
        // 清除所有弹层的隐藏定时器，防止弹层在右键菜单显示时消失
        document.querySelectorAll('.subcategory-popover.visible').forEach(pop => {
            const timer = popoverHideTimers.get(pop);
            if (timer) {
                clearTimeout(timer);
                popoverHideTimers.delete(pop);
            }
        });
    }
    
    function hideContextMenu() {
        contextMenu.classList.remove('show');
        currentContextMenuCategoryId = null;
    }
    
    // 鼠标进入右键菜单时，清除所有弹层的隐藏定时器
    contextMenu.addEventListener('mouseenter', () => {
        document.querySelectorAll('.subcategory-popover.visible').forEach(pop => {
            const timer = popoverHideTimers.get(pop);
            if (timer) {
                clearTimeout(timer);
                popoverHideTimers.delete(pop);
            }
        });
    });
    
    // 鼠标离开右键菜单时，延迟隐藏弹层
    contextMenu.addEventListener('mouseleave', () => {
        // 检查右键菜单是否仍然显示
        if (!contextMenu.classList.contains('show')) {
            document.querySelectorAll('.subcategory-popover.visible').forEach(pop => {
                const timer = popoverHideTimers.get(pop);
                if (timer) {
                    clearTimeout(timer);
                    popoverHideTimers.delete(pop);
                }
                // 设置新的隐藏定时器
                const newTimer = setTimeout(() => {
                    const contextMenu = document.getElementById('categoryContextMenu');
                    if (!contextMenu || !contextMenu.classList.contains('show')) {
                        pop.classList.remove('visible');
                        popoverHideTimers.delete(pop);
                    }
                }, 300);
                popoverHideTimers.set(pop, newTimer);
            });
        }
    });
    
    // 全局点击事件：点击菜单外部时隐藏
    document.addEventListener('click', (e) => {
        if (justShownMenu) return;
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });
    // 窗口失焦时也关闭菜单（如点击桌面）
    window.addEventListener('blur', () => {
        hideContextMenu();
    });
    
    const findCategoryInCache = (categoryId) => {
        if (!categoryId) return null;
        return (allCategoriesCache || []).find(
            cat => String(getCategoryId(cat)) === String(categoryId)
        ) || null;
    };
    
    const resolveCategoryName = async (categoryId) => {
        const cached = findCategoryInCache(categoryId);
        if (cached && cached.name) {
            return cached.name;
        }
        try {
            const category = await db.getCategory(categoryId);
            return category && category.name ? category.name : '';
        } catch (error) {
            console.error('❌ 获取分类名称失败:', error);
            return '';
        }
    };
    
    async function handleMenuAction(action) {
        const categoryId = currentContextMenuCategoryId;
        if (categoryId === null || categoryId === undefined) {
            return;
        }
        
        const categoryIdNumber = Number(categoryId);
        const categoryIdString = categoryId.toString();
        
        switch (action) {
            case 'addPhrase':
                console.log('[LOG] 从右键菜单添加话术，分类ID:', categoryIdString);
                hideContextMenu();
                openPhraseDialog(null, categoryIdString);
                break;
            case 'addCategory':
                console.log('[LOG] 从右键菜单添加分类，父级分类ID:', categoryIdNumber);
                hideContextMenu();
                // 传入当前右键的分类ID作为父级
                openCategoryDialog(null, '', categoryIdNumber);
                break;
            case 'editCategory': {
                hideContextMenu();
                const categoryName = await resolveCategoryName(categoryIdNumber);
                await editCategory(categoryIdNumber, categoryName);
                break;
            }
            case 'deleteCategory':
                hideContextMenu();
                await deleteCategory(categoryIdNumber);
                break;
            default:
                console.warn('⚠️ 未知的分类右键菜单操作:', action);
        }
    }
    
    // 右键菜单项点击事件
    const menuItems = contextMenu.querySelectorAll('.context-menu-item[data-action]');
    menuItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const action = item.dataset.action;
            await handleMenuAction(action);
        });
    });
    
    // 将显示函数暴露到全局，供分类项调用
    window.showCategoryContextMenu = function(e, categoryId) {
        showContextMenu(e.pageX, e.pageY, categoryId);
    };
    
    console.log('✅ 分类右键菜单已初始化');
}

// ==================== 使用说明右键菜单功能 ====================

// 初始化使用说明编辑器的右键菜单
function initDescriptionContextMenu() {
    const contextMenu = document.getElementById('descriptionContextMenu');
    const editor = document.getElementById('descriptionContent');
    if (!contextMenu || !editor) return;

    // 锁定状态（默认锁定）
    let isLocked = true;

    // 保存选择范围
    let savedSelection = null;

    // 保存当前选择范围
    function saveSelection() {
        try {
            const selection = window.getSelection();
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                if (editor.contains(range.commonAncestorContainer) || 
                    range.commonAncestorContainer === editor ||
                    editor.contains(range.commonAncestorContainer.parentNode)) {
                    savedSelection = range.cloneRange();
                } else {
                    editor.focus();
                    const newRange = document.createRange();
                    newRange.selectNodeContents(editor);
                    newRange.collapse(false);
                    savedSelection = newRange;
                }
            } else {
                editor.focus();
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                savedSelection = range;
            }
        } catch (error) {
            console.error('保存选择范围失败:', error);
            try {
                editor.focus();
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                savedSelection = range;
            } catch (e) {
                savedSelection = null;
            }
        }
    }

    // 恢复选择范围
    function restoreSelection() {
        try {
            editor.focus();
            const selection = window.getSelection();
            selection.removeAllRanges();
            
            if (savedSelection) {
                try {
                    const container = savedSelection.commonAncestorContainer;
                    if (editor.contains(container) || container === editor || 
                        (container.nodeType === Node.TEXT_NODE && editor.contains(container.parentNode))) {
                        selection.addRange(savedSelection);
                    } else {
                        throw new Error('Selection range is outside editor');
                    }
                } catch (e) {
                    const range = document.createRange();
                    if (editor.childNodes.length > 0) {
                        const lastNode = editor.childNodes[editor.childNodes.length - 1];
                        if (lastNode.nodeType === Node.TEXT_NODE) {
                            range.setStart(lastNode, lastNode.textContent.length);
                        } else {
                            range.setStartAfter(lastNode);
                        }
                        range.collapse(true);
                    } else {
                        range.setStart(editor, 0);
                        range.collapse(true);
                    }
                    selection.addRange(range);
                }
            } else {
                const range = document.createRange();
                if (editor.childNodes.length > 0) {
                    const lastNode = editor.childNodes[editor.childNodes.length - 1];
                    if (lastNode.nodeType === Node.TEXT_NODE) {
                        range.setStart(lastNode, lastNode.textContent.length);
                    } else {
                        range.setStartAfter(lastNode);
                    }
                    range.collapse(true);
                } else {
                    range.setStart(editor, 0);
                    range.collapse(true);
                }
                selection.addRange(range);
            }
        } catch (error) {
            console.error('恢复选择范围失败:', error);
            editor.focus();
        }
    }

    // 将光标移动到触发右键的精确位置，保证粘贴发生在期望行
    function moveCaretToPoint(event) {
        if (!event || !editor) return;
        try {
            editor.focus();
            const selection = window.getSelection();
            if (!selection) return;
            
            let range = null;
            if (document.caretRangeFromPoint) {
                range = document.caretRangeFromPoint(event.clientX, event.clientY);
            } else if (document.caretPositionFromPoint) {
                const caretPosition = document.caretPositionFromPoint(event.clientX, event.clientY);
                if (caretPosition) {
                    range = document.createRange();
                    range.setStart(caretPosition.offsetNode, caretPosition.offset);
                    range.collapse(true);
                }
            }
            
            if (!range) return;
            
            const container = range.commonAncestorContainer;
            const isInsideEditor = editor.contains(container) ||
                container === editor ||
                (container.nodeType === Node.TEXT_NODE && editor.contains(container.parentNode));
            
            if (isInsideEditor) {
                selection.removeAllRanges();
                selection.addRange(range);
            }
        } catch (error) {
            console.warn('[LOG] 无法将光标移动到右键位置:', error);
        }
    }

    // 更新锁定状态
    function updateLockState() {
        // 设置编辑区域
        editor.contentEditable = !isLocked;
        
        // 🔧 更新 placeholder 状态
        const text = editor.textContent.trim();
        if (text === '') {
            editor.setAttribute('data-empty', 'true');
        } else {
            editor.removeAttribute('data-empty');
        }

        // 更新右键菜单中的锁定图标和文本
        const lockMenuIcon = document.getElementById('descLockMenuIcon');
        const lockMenuText = document.getElementById('descLockMenuText');
        if (lockMenuIcon) {
            lockMenuIcon.textContent = isLocked ? '🔒' : '🔓';
        }
        if (lockMenuText) {
            lockMenuText.textContent = isLocked ? '解锁编辑' : '锁定编辑';
        }

        // 更新右键菜单状态
        const menuItems = contextMenu.querySelectorAll('.context-menu-item');
        menuItems.forEach(item => {
            // 锁定/解锁选项始终可用
            if (item.dataset.command === 'toggleLock') {
                item.classList.remove('disabled');
            } else {
                if (isLocked) {
                    item.classList.add('disabled');
                } else {
                    item.classList.remove('disabled');
                }
            }
        });

        // 禁用/启用字体和颜色选择器
        const ctxFontSize = document.getElementById('descCtxFontSize');
        const ctxFontFamily = document.getElementById('descCtxFontFamily');
        const ctxTextColor = document.getElementById('descCtxTextColor');
        const ctxBgColor = document.getElementById('descCtxBgColor');
        
        if (ctxFontSize) ctxFontSize.disabled = isLocked;
        if (ctxFontFamily) ctxFontFamily.disabled = isLocked;
        if (ctxTextColor) ctxTextColor.disabled = isLocked;
        if (ctxBgColor) ctxBgColor.disabled = isLocked;
    }

    // 加载锁定状态（始终默认锁定）
    function loadLockState() {
        // 始终默认锁定，不加载保存的状态
        isLocked = true;
        console.log('[LOG] 使用说明锁定状态已设置为默认锁定（true）');
    }

    // 显示/隐藏右键菜单
    function showContextMenu(x, y) {
        saveSelection();
        
        // 先临时显示菜单以获取其尺寸
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('show');
        
        // 获取菜单的实际尺寸
        const menuRect = contextMenu.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;
        
        // 获取视口尺寸
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // 计算调整后的位置
        let adjustedX = x;
        let adjustedY = y;
        
        // 检查右边界：如果菜单超出右边界，向左移动
        if (x + menuWidth > viewportWidth) {
            adjustedX = viewportWidth - menuWidth - 10; // 留10px边距
            // 确保不会超出左边界
            if (adjustedX < 10) {
                adjustedX = 10;
            }
        }
        
        // 检查下边界：如果菜单超出下边界，向上移动
        if (y + menuHeight > viewportHeight) {
            adjustedY = viewportHeight - menuHeight - 10; // 留10px边距
            // 确保不会超出上边界
            if (adjustedY < 10) {
                adjustedY = 10;
            }
        }
        
        // 应用调整后的位置
        contextMenu.style.left = adjustedX + 'px';
        contextMenu.style.top = adjustedY + 'px';
    }

    function hideContextMenu() {
        contextMenu.classList.remove('show');
    }

    // 编辑区域右键事件
    let contextMenuJustShown = false;
    let isPasting = false; // 标志：正在执行粘贴操作
    let pasteTimeoutId = null; // 粘贴超时保护定时器ID
    let lastPasteTime = 0; // 上次粘贴时间戳（用于防抖）
    // 注意：isContextMenuPaste 标志现在使用 window.isContextMenuPaste（在 text-editor.html 中设置）
    editor.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // 如果正在粘贴，检查是否超时（防止卡死）
        if (isPasting) {
            // 如果粘贴标志已经设置了超过2秒，可能是异常情况，强制重置
            if (pasteTimeoutId) {
                clearTimeout(pasteTimeoutId);
                pasteTimeoutId = null;
            }
            isPasting = false;
            console.warn('[LOG] 粘贴标志异常，已强制重置');
        }
        
        // 保存当前选择范围
        saveSelection();
        
        // 只在没有选择文本时才移动光标到右键点击位置
        const selection = window.getSelection();
        if (!isLocked && (!selection || selection.toString().trim() === '')) {
            moveCaretToPoint(e);
        } else {
            editor.focus();
        }
        
        showContextMenu(e.pageX, e.pageY);
        // 设置标志，防止右键点击后立即触发 click 事件关闭菜单
        contextMenuJustShown = true;
        setTimeout(() => {
            contextMenuJustShown = false;
        }, 100);
    });

    // 粘贴事件监听器 - 确保所有粘贴方式都能正常工作
    editor.addEventListener('paste', (e) => {
        // 完全不阻止默认行为，让浏览器处理所有粘贴操作
        // 这样Ctrl+V和右键菜单粘贴都能正常工作
    });

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        // 如果正在粘贴，强制关闭菜单（因为粘贴操作开始时已经关闭了菜单）
        if (isPasting) {
            hideContextMenu();
            return;
        }
        // 如果菜单刚刚显示，忽略这次点击（防止右键后立即关闭）
        if (contextMenuJustShown) {
            return;
        }
        // 只要点击的不是右键菜单本身，就隐藏菜单
        if (!contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    // 右键菜单项点击事件
    const menuItems = contextMenu.querySelectorAll('.context-menu-item[data-command]');
    menuItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.stopPropagation();
            const command = item.dataset.command;
            
            // 锁定/解锁功能不需要检查锁定状态
            if (command === 'toggleLock') {
                try {
                    isLocked = !isLocked;
                    updateLockState();
                    hideContextMenu();
                } catch (error) {
                    console.error('[LOG] 切换锁定状态失败:', error);
                }
                return;
            }
            
            // 粘贴功能允许在锁定状态下执行（临时解锁）
            let wasLocked = false;
            if (command === 'paste') {
                // 保存锁定状态并强制临时解锁
                wasLocked = isLocked;
                editor.contentEditable = 'true'; // 强制启用编辑
                
                // 立即恢复选择范围并聚焦编辑器
                restoreSelection();
                editor.focus();
            } else {
                // 其他命令需要检查锁定状态
                if (isLocked) {
                    hideContextMenu();
                    return;
                }
                // 恢复选择范围并聚焦编辑器
                restoreSelection();
                editor.focus();
            }
            
            try {
                // 特殊处理复制、粘贴、剪切命令
                if (command === 'copy') {
                    // 使用 execCommand 复制（更可靠）
                    const success = document.execCommand('copy', false, null);
                    if (success) {
                        showToast('✅ 已复制到剪贴板');
                    } else {
                        // 如果 execCommand 失败，尝试使用 Clipboard API
                        try {
                            const selection = window.getSelection();
                            if (selection && selection.toString()) {
                                await navigator.clipboard.writeText(selection.toString());
                                showToast('✅ 已复制到剪贴板');
                            } else {
                                await navigator.clipboard.writeText(editor.textContent || editor.innerText);
                                showToast('✅ 已复制到剪贴板');
                            }
                        } catch (err) {
                            console.error('复制失败:', err);
                            showToast('❌ 复制失败，请检查权限', 'error');
                        }
                    }
                    hideContextMenu();
                } else if (command === 'cut') {
                    // 使用 execCommand 剪切（更可靠）
                    const selection = window.getSelection();
                    if (selection && selection.toString()) {
                        const success = document.execCommand('cut', false, null);
                        if (success) {
                            showToast('✅ 已剪切到剪贴板');
                        } else {
                            // 如果 execCommand 失败，尝试手动实现
                            try {
                                const text = selection.toString();
                                await navigator.clipboard.writeText(text);
                                // 删除选中的文本
                                if (selection.rangeCount > 0) {
                                    const range = selection.getRangeAt(0);
                                    range.deleteContents();
                                    // 更新selection
                                    selection.removeAllRanges();
                                    const newRange = document.createRange();
                                    newRange.setStart(range.startContainer, range.startOffset);
                                    newRange.collapse(true);
                                    selection.addRange(newRange);
                                }
                                showToast('✅ 已剪切到剪贴板');
                            } catch (err) {
                                console.error('剪切失败:', err);
                                showToast('❌ 剪切失败，请检查权限', 'error');
                            }
                        }
                    } else {
                        showToast('⚠️ 请先选择要剪切的文本', 'warning');
                    }
                    hideContextMenu();
                } else if (command === 'paste') {
                    console.log('[LOG] ========== 右键菜单粘贴开始 ==========');
                    
                    try {
                        // 确保编辑器可编辑并聚焦
                        editor.contentEditable = 'true';
                        editor.focus();
                        
                        // 获取当前选择范围
                        const selection = window.getSelection();
                        let range;
                        if (selection && selection.rangeCount > 0) {
                            range = selection.getRangeAt(0);
                        } else {
                            // 如果没有选择范围，创建一个在编辑器末尾的范围
                            range = document.createRange();
                            range.selectNodeContents(editor);
                            range.collapse(false);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }
                        
                        console.log('[LOG] 尝试从剪贴板读取文本');
                        
                        // 使用 Clipboard API 读取剪贴板内容
                        navigator.clipboard.readText().then(text => {
                            console.log('[LOG] 成功读取剪贴板，文本长度:', text.length);
                            
                            if (text) {
                                // 删除选中的内容（如果有）
                                range.deleteContents();
                                
                                // 创建文本节点并插入
                                const textNode = document.createTextNode(text);
                                range.insertNode(textNode);
                                
                                // 将光标移动到插入文本的末尾
                                range.setStartAfter(textNode);
                                range.collapse(true);
                                selection.removeAllRanges();
                                selection.addRange(range);
                                
                                // 触发input事件确保内容保存
                                const inputEvent = new Event('input', { bubbles: true });
                                editor.dispatchEvent(inputEvent);
                                
                                showToast('✅ 已粘贴');
                                console.log('[LOG] 粘贴成功');
                            } else {
                                console.log('[LOG] 剪贴板为空');
                                showToast('⚠️ 剪贴板为空', 'warning');
                            }
                        }).catch(err => {
                            console.error('[LOG] 读取剪贴板失败:', err);
                            // 如果 Clipboard API 失败，尝试使用 execCommand
                            console.log('[LOG] 尝试使用 execCommand 粘贴');
                            const success = document.execCommand('paste', false, null);
                            if (success) {
                                showToast('✅ 已粘贴');
                            } else {
                                showToast('❌ 粘贴失败，请使用 Ctrl+V', 'error');
                            }
                        });
                    } catch (err) {
                        console.error('[LOG] 粘贴过程出错:', err);
                        showToast('❌ 粘贴失败', 'error');
                    }
                    
                    // 立即关闭菜单
                    hideContextMenu();
                    
                    // 短暂延迟后恢复锁定状态
                    setTimeout(() => {
                        if (wasLocked) {
                            editor.contentEditable = 'false';
                        }
                        console.log('[LOG] ✅ 右键菜单粘贴完成，状态已恢复');
                    }, 100);
                } else {
                    // 其他命令使用 execCommand
                    const success = document.execCommand(command, false, null);
                    if (!success) {
                        console.warn('命令执行可能失败:', command);
                    }
                    hideContextMenu();
                }
            } catch (error) {
                console.error('执行命令失败:', command, error);
                // 所有命令执行后都应该关闭菜单
                if (command === 'copy' || command === 'cut') {
                    showToast('❌ 操作失败，请检查权限', 'error');
                    hideContextMenu();
                } else if (command === 'paste') {
                    // 粘贴操作的错误已经在内部处理，但确保菜单关闭
                    if (wasLocked) {
                        editor.contentEditable = 'false';
                    }
                    hideContextMenu();
                } else {
                    hideContextMenu();
                }
            }
        });
    });

    // 初始化锁定状态
    loadLockState();
    updateLockState();

    // 字体大小选择（自定义下拉框）
    const ctxFontSize = document.getElementById('descCtxFontSize');
    if (ctxFontSize) {
        initCustomSelect('descCtxFontSize');
        const _fsTrigger = ctxFontSize.querySelector('.custom-select-trigger');
        if (_fsTrigger) _fsTrigger.addEventListener('click', (e) => {
            if (isLocked) { e.stopPropagation(); e.preventDefault(); }
        }, true);
        ctxFontSize.addEventListener('change', (e) => {
            if (isLocked) {
                hideContextMenu();
                return;
            }
            const value = (e.detail && e.detail.value) || e.target.value;
            restoreSelection();
            editor.focus();
            try {
                document.execCommand('fontSize', false, value);
            } catch (error) {
                console.error('设置字体大小失败:', error);
            }
            hideContextMenu();
        });
    }

    // 字体选择（自定义下拉框）
    const ctxFontFamily = document.getElementById('descCtxFontFamily');
    if (ctxFontFamily) {
        initCustomSelect('descCtxFontFamily');
        const _ffTrigger = ctxFontFamily.querySelector('.custom-select-trigger');
        if (_ffTrigger) _ffTrigger.addEventListener('click', (e) => {
            if (isLocked) { e.stopPropagation(); e.preventDefault(); }
        }, true);
        ctxFontFamily.addEventListener('change', (e) => {
            if (isLocked) {
                hideContextMenu();
                return;
            }
            const value = (e.detail && e.detail.value) || e.target.value;
            restoreSelection();
            editor.focus();
            try {
                document.execCommand('fontName', false, value);
            } catch (error) {
                console.error('设置字体失败:', error);
            }
            hideContextMenu();
        });
    }

    // 文字颜色选择
    const ctxTextColor = document.getElementById('descCtxTextColor');
    if (ctxTextColor) {
        ctxTextColor.addEventListener('change', (e) => {
            if (isLocked) {
                hideContextMenu();
                return;
            }
            restoreSelection();
            editor.focus();
            try {
                document.execCommand('foreColor', false, e.target.value);
            } catch (error) {
                console.error('设置文字颜色失败:', error);
            }
            hideContextMenu();
        });
    }

    // 背景颜色选择
    const ctxBgColor = document.getElementById('descCtxBgColor');
    if (ctxBgColor) {
        ctxBgColor.addEventListener('change', (e) => {
            if (isLocked) {
                hideContextMenu();
                return;
            }
            restoreSelection();
            editor.focus();
            try {
                document.execCommand('backColor', false, e.target.value);
            } catch (error) {
                console.error('设置背景颜色失败:', error);
            }
            hideContextMenu();
        });
    }
}
window.closeImagesDialog = closeImagesDialog;
window.handleImageUpload = handleImageUpload;
window.previewImage = previewImage;
window.copyImage = copyImage;
window.deleteImage = deleteImage;

// 点击弹窗外部关闭
document.addEventListener('click', (e) => {
    const imagesDialog = document.getElementById('imagesDialog');
    if (e.target === imagesDialog) {
        closeImagesDialog();
    }
    
    const descriptionDialog = document.getElementById('descriptionDialog');
    if (e.target === descriptionDialog) {
        closeDescriptionDialog();
    }
    
    const settingsDialog = document.getElementById('settingsDialog');
    if (e.target === settingsDialog) {
        closeSettingsDialog();
    }
});

// ESC键关闭弹窗
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const imagesDialog = document.getElementById('imagesDialog');
        if (imagesDialog && imagesDialog.style.display !== 'none') {
            closeImagesDialog();
        }
        
        const descriptionDialog = document.getElementById('descriptionDialog');
        if (descriptionDialog && descriptionDialog.style.display !== 'none') {
            closeDescriptionDialog();
        }
        
        const settingsDialog = document.getElementById('settingsDialog');
        if (settingsDialog && settingsDialog.style.display !== 'none') {
            closeSettingsDialog();
        }
        
        // 也检查文本编辑器
        const textEditor = document.getElementById('categoryTextEditor');
        if (textEditor && textEditor.style.display !== 'none') {
            closeCategoryTextEditor();
        }
    }
});

// ==================== 分类文本编辑器 ====================

let currentCategoryTextEditorCategoryId = null;
let categoryTextEditorSaveTimer = null;

// 打开分类文本编辑器
async function openCategoryTextEditor(categoryId, categoryName) {
    console.log('📝 打开分类文本编辑器:', categoryId, categoryName);
    console.log('📝 Python Bridge 检查:', {
        hasPythonBridge: typeof window.pythonBridge !== 'undefined',
        hasOpenTextEditor: window.pythonBridge && typeof window.pythonBridge.open_text_editor !== 'undefined',
        pythonBridge: window.pythonBridge
    });
    
    // 优先使用 Python Bridge 打开外部窗口（桌面应用模式）
    if (window.pythonBridge && typeof window.pythonBridge.open_text_editor === 'function') {
        try {
            console.log('📝 尝试通过 Python Bridge 打开文本编辑器...');
            window.pythonBridge.open_text_editor(categoryId, categoryName);
            console.log('📝 Python Bridge 调用成功');
            return;
        } catch (error) {
            console.error('❌ 无法通过 Python Bridge 打开文本编辑器:', error);
            console.warn('降级到内嵌模式');
        }
    } else {
        console.warn('⚠️ Python Bridge 不可用，使用内嵌模式');
    }
    
    // 降级到内嵌模式（浏览器模式或 Python Bridge 不可用时）
    // 创建编辑器（如果不存在）
    let editor = document.getElementById('categoryTextEditor');
    if (!editor) {
        if (!document.body) {
            console.error('❌ document.body 不存在，无法创建编辑器');
            return;
        }
        editor = createCategoryTextEditor();
        try {
            document.body.appendChild(editor);
        } catch (error) {
            console.error('❌ 无法添加编辑器到 DOM:', error);
            return;
        }
    }
    
    currentCategoryTextEditorCategoryId = categoryId;
    
    // 设置标题
    const titleEl = editor.querySelector('.text-editor-title');
    if (titleEl) {
        titleEl.textContent = categoryName || '文本编辑器';
    }
    
    // 加载已保存的文本内容
    const savedText = await db.getSetting(`category_text_${categoryId}`, '');
    const editorContent = editor.querySelector('.text-editor-content');
    if (editorContent) {
        editorContent.innerHTML = savedText || '';
        // 聚焦到编辑器
        setTimeout(() => {
            editorContent.focus();
        }, 100);
    }
    
    // 应用当前主题
    const activeThemeClass = getActiveThemeClass();
    if (activeThemeClass) {
        applyThemeClass(editor, activeThemeClass);
    }
    
    // 显示编辑器
    editor.style.display = 'flex';
    
    // 绑定保存事件（防抖）- 使用 once: false 允许重复绑定，但防抖机制会处理
    if (editorContent) {
        // 移除可能存在的旧监听器（通过重新绑定来覆盖）
        editorContent.removeEventListener('input', handleCategoryTextEditorInput);
        editorContent.addEventListener('input', handleCategoryTextEditorInput);
        
        // 聚焦到编辑器
        setTimeout(() => {
            editorContent.focus();
        }, 100);
    }
}

// 创建文本编辑器DOM
function createCategoryTextEditor() {
    const editor = document.createElement('div');
    editor.id = 'categoryTextEditor';
    editor.className = 'category-text-editor';
    
    editor.innerHTML = `
        <div class="text-editor-container">
            <div class="text-editor-header">
                <h3 class="text-editor-title">文本编辑器</h3>
                <button class="text-editor-close" onclick="closeCategoryTextEditor()" title="关闭">×</button>
            </div>
            <div class="text-editor-toolbar">
                <button class="toolbar-btn" data-command="bold" title="加粗 (Ctrl+B)">
                    <strong>B</strong>
                </button>
                <button class="toolbar-btn" data-command="italic" title="斜体 (Ctrl+I)">
                    <em>I</em>
                </button>
                <button class="toolbar-btn" data-command="underline" title="下划线 (Ctrl+U)">
                    <u>U</u>
                </button>
                <div class="toolbar-separator"></div>
                <button class="toolbar-btn" data-command="formatBlock" data-value="h2" title="标题">
                    H
                </button>
                <button class="toolbar-btn" data-command="insertUnorderedList" title="无序列表">
                    •
                </button>
                <button class="toolbar-btn" data-command="insertOrderedList" title="有序列表">
                    1.
                </button>
                <div class="toolbar-separator"></div>
                <button class="toolbar-btn" data-command="justifyLeft" title="左对齐">◀</button>
                <button class="toolbar-btn" data-command="justifyCenter" title="居中">⬌</button>
                <button class="toolbar-btn" data-command="justifyRight" title="右对齐">▶</button>
                <div class="toolbar-separator"></div>
                <button class="toolbar-btn" data-command="removeFormat" title="清除格式">✕</button>
            </div>
            <div class="text-editor-content" contenteditable="true" spellcheck="false"></div>
            <div class="text-editor-footer">
                <span class="text-editor-status">已自动保存</span>
            </div>
        </div>
    `;
    
    // 绑定工具栏按钮事件
    const toolbarBtns = editor.querySelectorAll('.toolbar-btn');
    toolbarBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const command = btn.dataset.command;
            const value = btn.dataset.value;
            const contentEl = editor.querySelector('.text-editor-content');
            if (contentEl) {
                contentEl.focus();
                if (value) {
                    document.execCommand(command, false, value);
                } else {
                    document.execCommand(command, false, null);
                }
            }
        });
    });
    
    // 绑定快捷键
    editor.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'b') {
                e.preventDefault();
                document.execCommand('bold', false, null);
            } else if (e.key === 'i') {
                e.preventDefault();
                document.execCommand('italic', false, null);
            } else if (e.key === 'u') {
                e.preventDefault();
                document.execCommand('underline', false, null);
            }
        }
    });
    
    // 点击外部关闭
    editor.addEventListener('click', (e) => {
        if (e.target === editor) {
            closeCategoryTextEditor();
        }
    });
    
    return editor;
}

// 处理编辑器输入（防抖保存）
function handleCategoryTextEditorInput() {
    if (!currentCategoryTextEditorCategoryId) return;
    
    // 清除之前的定时器
    if (categoryTextEditorSaveTimer) {
        clearTimeout(categoryTextEditorSaveTimer);
    }
    
    // 更新状态
    const statusEl = document.querySelector('.text-editor-status');
    if (statusEl) {
        statusEl.textContent = '正在保存...';
        statusEl.style.color = '#999';
    }
    
    // 设置新的定时器（1秒后保存）
    categoryTextEditorSaveTimer = setTimeout(async () => {
        await saveCategoryTextEditor();
    }, 1000);
}

// 保存分类文本
async function saveCategoryTextEditor() {
    if (!currentCategoryTextEditorCategoryId) return;
    
    const editor = document.getElementById('categoryTextEditor');
    if (!editor) return;
    
    const contentEl = editor.querySelector('.text-editor-content');
    if (!contentEl) return;
    
    const content = contentEl.innerHTML;
    
    try {
        await db.setSetting(`category_text_${currentCategoryTextEditorCategoryId}`, content);
        
        // 更新状态
        const statusEl = editor.querySelector('.text-editor-status');
        if (statusEl) {
            statusEl.textContent = '已自动保存';
            statusEl.style.color = '#4caf50';
            
            // 2秒后恢复默认颜色
            setTimeout(() => {
                if (statusEl) {
                    statusEl.style.color = '#999';
                }
            }, 2000);
        }
        
        console.log('✅ 分类文本已保存:', currentCategoryTextEditorCategoryId);
    } catch (error) {
        console.error('❌ 保存分类文本失败:', error);
        const statusEl = editor.querySelector('.text-editor-status');
        if (statusEl) {
            statusEl.textContent = '保存失败';
            statusEl.style.color = '#f44336';
        }
    }
}

// 关闭分类文本编辑器
function closeCategoryTextEditor() {
    // 先保存一次
    if (currentCategoryTextEditorCategoryId) {
        saveCategoryTextEditor();
    }
    
    const editor = document.getElementById('categoryTextEditor');
    if (editor) {
        editor.style.display = 'none';
    }
    
    currentCategoryTextEditorCategoryId = null;
    
    // 清除定时器
    if (categoryTextEditorSaveTimer) {
        clearTimeout(categoryTextEditorSaveTimer);
        categoryTextEditorSaveTimer = null;
    }
}

// 暴露到全局
window.openCategoryTextEditor = openCategoryTextEditor;
window.closeCategoryTextEditor = closeCategoryTextEditor;

// ==================== 通用右键菜单 ====================
// 为所有普通文本输入区域提供简单的右键菜单（复制、粘贴、剪切）

let universalContextMenu = null;
let currentContextTarget = null;

// 创建通用右键菜单
function createUniversalContextMenu() {
    if (universalContextMenu) return universalContextMenu;
    
    const menu = document.createElement('div');
    menu.id = 'universalContextMenu';
    menu.className = 'universal-context-menu';
    menu.innerHTML = `
        <div class="universal-context-item" data-command="copy">
            <span>📋 复制</span>
        </div>
        <div class="universal-context-item" data-command="paste">
            <span>📄 粘贴</span>
        </div>
        <div class="universal-context-item" data-command="cut">
            <span>✂️ 剪切</span>
        </div>
    `;
    
    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
        .universal-context-menu {
            position: fixed;
            background: white;
            border: 1px solid #ccc;
            border-radius: 4px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 4px 0;
            z-index: 9999999;
            display: none;
            min-width: 100px;
            font-size: 14px;
            pointer-events: auto;
        }
        
        .universal-context-menu.show {
            display: block;
        }
        
        .universal-context-item {
            padding: 6px 12px;
            cursor: pointer;
            user-select: none;
        }
        
        .universal-context-item:hover {
            background-color: #f0f0f0;
        }
        
        .universal-context-item:active {
            background-color: #e0e0e0;
        }
    `;
    
    document.head.appendChild(style);
    document.body.appendChild(menu);
    
    // 绑定菜单项点击事件
    menu.addEventListener('click', async (e) => {
        const item = e.target.closest('.universal-context-item');
        if (!item || !currentContextTarget) return;
        
        const command = item.dataset.command;
        e.stopPropagation();
        
        try {
            // 确保目标元素获得焦点
            currentContextTarget.focus();
            
            if (command === 'copy') {
                // 复制
                const success = document.execCommand('copy', false, null);
                if (!success) {
                    // 备用方案：使用 Clipboard API
                    const selection = window.getSelection();
                    if (selection && selection.toString()) {
                        await navigator.clipboard.writeText(selection.toString());
                    } else if (currentContextTarget.value) {
                        await navigator.clipboard.writeText(currentContextTarget.value);
                    }
                }
                console.log('[LOG] ✅ 通用右键菜单：已复制');
                
            } else if (command === 'paste') {
                // 粘贴
                try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                        // 对于 input 和 textarea
                        if (currentContextTarget.tagName === 'INPUT' || currentContextTarget.tagName === 'TEXTAREA') {
                            const start = currentContextTarget.selectionStart;
                            const end = currentContextTarget.selectionEnd;
                            const value = currentContextTarget.value;
                            currentContextTarget.value = value.substring(0, start) + text + value.substring(end);
                            currentContextTarget.selectionStart = currentContextTarget.selectionEnd = start + text.length;
                            
                            // 触发 input 事件
                            const inputEvent = new Event('input', { bubbles: true });
                            currentContextTarget.dispatchEvent(inputEvent);
                        } else {
                            // 对于 contenteditable 元素
                            document.execCommand('insertText', false, text);
                        }
                        console.log('[LOG] ✅ 通用右键菜单：已粘贴');
                    }
                } catch (err) {
                    console.error('[LOG] 通用右键菜单粘贴失败:', err);
                    // 备用方案：使用 execCommand
                    document.execCommand('paste', false, null);
                }
                
            } else if (command === 'cut') {
                // 剪切
                const success = document.execCommand('cut', false, null);
                if (!success) {
                    // 备用方案：手动实现
                    let textToCut = '';
                    if (currentContextTarget.tagName === 'INPUT' || currentContextTarget.tagName === 'TEXTAREA') {
                        const start = currentContextTarget.selectionStart;
                        const end = currentContextTarget.selectionEnd;
                        if (start !== end) {
                            textToCut = currentContextTarget.value.substring(start, end);
                            currentContextTarget.value = currentContextTarget.value.substring(0, start) + currentContextTarget.value.substring(end);
                            currentContextTarget.selectionStart = currentContextTarget.selectionEnd = start;
                        }
                    } else {
                        const selection = window.getSelection();
                        if (selection && selection.toString()) {
                            textToCut = selection.toString();
                            selection.deleteFromDocument();
                        }
                    }
                    
                    if (textToCut) {
                        await navigator.clipboard.writeText(textToCut);
                        // 触发 input 事件
                        const inputEvent = new Event('input', { bubbles: true });
                        currentContextTarget.dispatchEvent(inputEvent);
                    }
                }
                console.log('[LOG] ✅ 通用右键菜单：已剪切');
            }
        } catch (error) {
            console.error('[LOG] 通用右键菜单操作失败:', command, error);
        }
        
        hideUniversalContextMenu();
    });
    
    universalContextMenu = menu;
    return menu;
}

// 显示通用右键菜单
function showUniversalContextMenu(x, y, target) {
    if (!universalContextMenu) {
        createUniversalContextMenu();
    }
    
    currentContextTarget = target;
    
    // 先临时显示菜单以获取尺寸
    universalContextMenu.style.left = x + 'px';
    universalContextMenu.style.top = y + 'px';
    universalContextMenu.classList.add('show');
    
    // 获取菜单尺寸和窗口尺寸
    const menuRect = universalContextMenu.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    
    // 智能位置调整：优先避免遮挡选中文本
    let adjustedX = x + 10; // 默认向右偏移10px避免遮挡
    let adjustedY = y + 3;  // 默认向下偏移3px
    
    // 检查右边界，如果超出则尝试左侧显示
    if (adjustedX + menuRect.width > windowWidth) {
        // 尝试显示在左侧
        const leftX = x - menuRect.width - 10;
        if (leftX >= 10) {
            adjustedX = leftX; // 左侧有足够空间
        } else {
            adjustedX = windowWidth - menuRect.width - 10; // 贴右边界
        }
    }
    
    // 确保不超出左边界
    if (adjustedX < 10) {
        adjustedX = 10;
    }
    
    // 检查下边界，如果超出则尝试上方显示
    if (adjustedY + menuRect.height > windowHeight) {
        // 尝试显示在上方
        const topY = y - menuRect.height - 3;
        if (topY >= 10) {
            adjustedY = topY; // 上方有足够空间
        } else {
            adjustedY = windowHeight - menuRect.height - 10; // 贴下边界
        }
    }
    
    // 确保不超出上边界
    if (adjustedY < 10) {
        adjustedY = 10;
    }
    
    // 应用调整后的位置
    universalContextMenu.style.left = adjustedX + 'px';
    universalContextMenu.style.top = adjustedY + 'px';
    
    console.log('[LOG] 通用右键菜单已显示:');
    console.log('  - 原始位置:', x, y);
    console.log('  - 调整后位置:', adjustedX, adjustedY);
    console.log('  - 目标元素:', target.tagName, target.className);
    console.log('  - 菜单尺寸:', menuRect.width, 'x', menuRect.height);
    console.log('  - 窗口尺寸:', windowWidth, 'x', windowHeight);
}

// 隐藏通用右键菜单
function hideUniversalContextMenu() {
    if (universalContextMenu) {
        universalContextMenu.classList.remove('show');
    }
    currentContextTarget = null;
}

// 暴露到全局，供其他地方调用
window.hideUniversalContextMenu = hideUniversalContextMenu;

// 初始化通用右键菜单
function initUniversalContextMenu() {
    // 创建菜单
    createUniversalContextMenu();
    
    // 为指定的元素添加右键菜单
    const selectors = [
        'input[type="text"]',
        'input[type="search"]', 
        'input[type="password"]',
        'textarea',
        '.category-name-input',
        '.search-input',
        '.script-input',
        '.subtitle-input',
        '.edit-input',
        '.text-input',
        '[contenteditable="true"]:not(#descriptionContent):not(#editorContent)',
        // 添加更多可能的字幕编辑元素
        '[data-editable="true"]',
        '.editable',
        '.inline-edit',
        '.subtitle-edit',
        // 计算器显示屏
        '.calculator-expression',
        '.calculator-history'
    ];
    
    // 添加调试：监听所有右键点击，帮助识别元素
    document.addEventListener('contextmenu', (e) => {
        const target = e.target;
        console.log('[LOG] 右键点击元素详情:');
        console.log('  - tagName:', target.tagName);
        console.log('  - className:', target.className);
        console.log('  - id:', target.id);
        console.log('  - type:', target.type);
        console.log('  - contentEditable:', target.contentEditable);
        console.log('  - isInput:', target.tagName === 'INPUT');
        console.log('  - isTextarea:', target.tagName === 'TEXTAREA');
        console.log('  - 坐标:', e.pageX, e.pageY);
    });
    
    selectors.forEach(selector => {
        document.addEventListener('contextmenu', (e) => {
            const target = e.target.closest(selector);
            if (target) {
                // 排除已有专用右键菜单的元素
                if (target.id === 'descriptionContent' || target.id === 'editorContent') {
                    return;
                }
                
                console.log('[LOG] 通用右键菜单匹配元素:');
                console.log('  - 匹配的选择器:', selector);
                console.log('  - 目标元素:', target);
                console.log('  - 事件被阻止:', true);
                console.log('  - 准备显示菜单...');
                e.preventDefault();
                e.stopPropagation();
                showUniversalContextMenu(e.pageX, e.pageY, target);
            }
        });
    });
    
    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
        if (universalContextMenu && !universalContextMenu.contains(e.target)) {
            hideUniversalContextMenu();
        }
    }, true); // 使用捕获阶段，确保能捕获到所有点击
    
    // 右键菜单外的鼠标按下也隐藏菜单
    document.addEventListener('mousedown', (e) => {
        if (universalContextMenu && !universalContextMenu.contains(e.target)) {
            hideUniversalContextMenu();
        }
    }, true);
    
    // 页面滚动时隐藏菜单
    document.addEventListener('scroll', hideUniversalContextMenu, true);
    
    // 窗口大小变化时隐藏菜单
    window.addEventListener('resize', hideUniversalContextMenu);
    
    // 键盘按下时隐藏菜单（如ESC键）
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideUniversalContextMenu();
        }
    });
    
    console.log('[LOG] 通用右键菜单已初始化');
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        initUniversalContextMenu();
        initCustomPlaceholder();
        initSearchMarquee();
        initCalculatorButton();
    }, 1000); // 延迟1秒确保所有元素都已加载
});

// ==================== 搜索框字幕编辑功能 ====================

// 打开搜索框字幕编辑对话框
function openSearchMarqueeDialog() {
    console.log('✏️ 打开搜索框字幕编辑对话框');
    const dialog = document.getElementById('searchMarqueeDialog');
    const textarea = document.getElementById('searchMarqueeContent');

    if (!dialog || !textarea) return;

    // 加载当前字幕内容
    const currentTexts = localStorage.getItem('searchMarqueeTexts');
    if (currentTexts) {
        textarea.value = currentTexts;
    } else {
        // 默认内容
        textarea.value = '重要提醒：请确保在使用话术前仔细核对内容，避免发送错误信息！';
    }

    dialog.style.display = 'flex';

    // 绑定事件
    const closeBtn = document.getElementById('closeSearchMarqueeBtn');
    const cancelBtn = document.getElementById('cancelSearchMarqueeBtn');
    const saveBtn = document.getElementById('saveSearchMarqueeBtn');

    const closeDialog = () => {
        dialog.style.display = 'none';
    };

    if (closeBtn) closeBtn.addEventListener('click', closeDialog);
    if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const content = textarea.value.trim();
            if (content) {
                // 保存到localStorage
                localStorage.setItem('searchMarqueeTexts', content);

                // 更新字幕显示内容
                updateSearchMarqueeContent(content);

                closeDialog();
                showToast('✅ 字幕内容已保存');
            } else {
                showToast('❌ 字幕内容不能为空', 'error');
            }
        });
    }
}

// 更新搜索框字幕内容
function updateSearchMarqueeContent(content) {
    const marqueeText = document.getElementById('marqueeText');
    const marqueeTextDuplicate = document.getElementById('marqueeTextDuplicate');

    if (!marqueeText || !marqueeTextDuplicate) return;

    // 将内容按行分割并用 • 连接
    const lines = content.split('\n').map(line => line.trim()).filter(line => line);
    const displayText = lines.join('   •   ');

    marqueeText.textContent = displayText;
    marqueeTextDuplicate.textContent = displayText;
}

// 修改字幕显示控制函数，添加开关检查
function updateMarqueeVisibility() {
    const searchInput = document.getElementById('searchInput');
    const marqueeOverlay = document.getElementById('searchMarquee');
    const marqueeTrack = document.getElementById('marqueeTrack');
    const searchBox = document.querySelector('.search-box');

    if (!searchInput || !marqueeOverlay || !marqueeTrack) return;

    // 检查字幕开关
    const enabled = localStorage.getItem('searchMarqueeEnabled') !== 'false';

    const isEmpty = searchInput.value.trim() === '';
    // 当窗口失去焦点时，视为未聚焦（避免在切换到其他程序时仍认为输入框有焦点）
    const isFocused = document.hasFocus ? (document.hasFocus() && document.activeElement === searchInput) : (document.activeElement === searchInput);
    const shouldShow = enabled && isEmpty && !isFocused;

    if (shouldShow) {
        marqueeOverlay.style.display = 'flex';
        // 确保动画状态正确
        if (!marqueeTrack.classList.contains('animate')) {
            marqueeTrack.classList.add('animate');
        }
        // 当字幕显示时，隐藏自定义placeholder
        if (searchBox) {
            searchBox.classList.add('marquee-showing');
        }
    } else {
        marqueeOverlay.style.display = 'none';
        marqueeTrack.classList.remove('animate');
        // 当字幕隐藏时，显示自定义placeholder
        if (searchBox) {
            searchBox.classList.remove('marquee-showing');
        }
    }
}

// 计算器状态
let calculatorState = {
    expression: '0',
    lastOperator: null,
    waitingForOperand: false,
    justCalculated: false
};

// 初始化计算器按钮
function initCalculatorButton() {
    const calculatorBtn = document.getElementById('calculatorBtn');
    if (!calculatorBtn) return;

    // 移除所有旧的事件监听器
    const newBtn = calculatorBtn.cloneNode(true);
    calculatorBtn.parentNode.replaceChild(newBtn, calculatorBtn);

    // 重新获取元素引用
    const freshBtn = document.getElementById('calculatorBtn');

    freshBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        console.log('[LOG] 计算器按钮被点击 - 打开calculator-dialog.html计算器 [2025-04-20-01]');

        // 调用 Python Bridge 打开 calculator-dialog.html 计算器
        if (window.pythonBridge && typeof window.pythonBridge.open_calculator === 'function') {
            console.log('[LOG] 调用 Python Bridge open_calculator [2025-04-20-01]');
            window.pythonBridge.open_calculator();
        } else {
            console.error('[LOG] pythonBridge 或 open_calculator 方法不可用 [2025-04-20-01]');
            showToast('❌ 计算器功能不可用', 'error');
        }
    }, { once: false, capture: true });

    console.log('[LOG] 计算器按钮已初始化 - 关联到calculator-dialog.html计算器');
}

// 切换计算器显示/隐藏
function toggleCalculator() {
    const modal = document.getElementById('calculatorModal');
    if (!modal) return;

    if (modal.style.display === 'flex') {
        hideCalculator();
    } else {
        showCalculator();
    }
}

// 显示计算器
function showCalculator() {
    const modal = document.getElementById('calculatorModal');
    if (!modal) return;

    modal.style.display = 'flex';
    // 恢复上次的计算结果，如果没有则重置
    restoreCalculatorState();
    initCalculatorEvents();
    initCalculatorDrag();
}

// 隐藏计算器
function hideCalculator() {
    const modal = document.getElementById('calculatorModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 初始化计算器拖动功能
function initCalculatorDrag() {
    const modal = document.getElementById('calculatorModal');
    const container = modal.querySelector('.calculator-container');
    const header = modal.querySelector('.calculator-header');
    if (!header || !container) return;
    
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    
    // 设置初始位置为居中
    if (!container.style.left) {
        container.style.position = 'fixed';
        container.style.left = '50%';
        container.style.top = '50%';
        container.style.transform = 'translate(-50%, -50%)';
    }
    
    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        const rect = container.getBoundingClientRect();
        initialX = e.clientX - rect.left;
        initialY = e.clientY - rect.top;
        
        if (e.target === header || header.contains(e.target)) {
            isDragging = true;
        }
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            
            container.style.left = currentX + 'px';
            container.style.top = currentY + 'px';
            container.style.transform = 'none';
        }
    }
    
    function dragEnd() {
        if (isDragging) {
            isDragging = false;
        }
    }
}

// 重置计算器
function resetCalculator() {
    calculatorState = {
        expression: '0',
        lastOperator: null,
        waitingForOperand: false,
        justCalculated: false,
        history: '' // 🔧 添加历史记录
    };
    updateDisplay();
    // 清空保存的状态
    saveCalculatorState();
}

// 保存计算器状态到 localStorage
function saveCalculatorState() {
    try {
        localStorage.setItem('calculatorExpression', calculatorState.expression);
        localStorage.setItem('calculatorHistory', calculatorState.history || '');
    } catch (e) {
        console.warn('[Calculator] 保存状态失败:', e);
    }
}

// 恢复计算器状态从 localStorage
function restoreCalculatorState() {
    try {
        const savedExpression = localStorage.getItem('calculatorExpression');
        const savedHistory = localStorage.getItem('calculatorHistory');
        
        if (savedExpression && savedExpression !== 'Error' && savedExpression !== '0') {
            // 恢复保存的表达式
            calculatorState.expression = savedExpression;
            // 如果有历史记录，说明是计算结果
            if (savedHistory && savedHistory.includes('=')) {
                calculatorState.justCalculated = true;
            }
        } else {
            // 没有保存的状态，使用默认值
            calculatorState.expression = '0';
        }
        
        // 恢复历史记录
        calculatorState.history = savedHistory || '';
        calculatorState.lastOperator = null;
        calculatorState.waitingForOperand = false;
        updateDisplay();
    } catch (e) {
        console.warn('[Calculator] 恢复状态失败:', e);
        resetCalculator();
    }
}

// 更新显示
function updateDisplay() {
    const display = document.getElementById('calculatorExpression');
    const historyDisplay = document.getElementById('calculatorHistory');
    
    if (display) {
        // 将 * 替换为 x 显示
        const displayText = calculatorState.expression.replace(/\*/g, 'x');
        display.textContent = displayText;
        
        // 🔧 根据长度自动调整字体大小
        display.classList.remove('long-expression', 'very-long-expression');
        if (displayText.length > 20) {
            display.classList.add('very-long-expression');
        } else if (displayText.length > 12) {
            display.classList.add('long-expression');
        }
    }
    
    // 🔧 更新历史记录显示
    if (historyDisplay) {
        const historyText = (calculatorState.history || '').replace(/\*/g, 'x');
        historyDisplay.textContent = historyText;
    }
    
    // 每次更新显示时保存状态
    saveCalculatorState();
}

// 初始化计算器事件
function initCalculatorEvents() {
    const buttons = document.querySelectorAll('.calc-btn');
    
    // 计算器按钮
    buttons.forEach(btn => {
        btn.onclick = () => handleButtonClick(btn);
    });
    
    // 键盘支持
    document.addEventListener('keydown', handleKeyPress);
}

// 处理按钮点击
function handleButtonClick(btn) {
    const action = btn.dataset.action;
    const value = btn.dataset.value;
    
    if (action) {
        handleAction(action);
    } else if (value) {
        handleInput(value);
    }
}

// 处理键盘输入
function handleKeyPress(e) {
    const modal = document.getElementById('calculatorModal');
    if (!modal || !modal.classList.contains('show')) return;
    
    e.preventDefault();
    
    const key = e.key;
    
    if (key >= '0' && key <= '9' || key === '.') {
        handleInput(key);
    } else if (key === '+' || key === '-') {
        handleInput(key);
    } else if (key === '*') {
        handleInput('*');
    } else if (key === '/') {
        handleInput('/');
    } else if (key === '%') {
        handleInput('%');
    } else if (key === 'Enter' || key === '=') {
        handleAction('equals');
    } else if (key === 'Escape' || key === 'c' || key === 'C') {
        handleAction('clear');
    } else if (key === 'Backspace') {
        handleAction('backspace');
    }
}

// 处理输入
function handleInput(value) {
    if (calculatorState.justCalculated) {
        if (isOperator(value)) {
            // 🔧 连续运算：直接使用当前结果继续计算
            // 当前 expression 已经是结果了，不需要提取
            calculatorState.justCalculated = false;
        } else {
            // 输入数字，重新开始
            calculatorState.history = ''; // 清空历史记录
            resetCalculator();
        }
    }
    
    if (isOperator(value)) {
        handleOperator(value);
    } else {
        handleNumber(value);
    }
    
    updateDisplay();
}

// 处理数字输入
function handleNumber(value) {
    if (calculatorState.waitingForOperand) {
        // 如果在等待操作数，不要替换整个表达式，而是继续添加
        calculatorState.expression += value;
        calculatorState.waitingForOperand = false;
    } else {
        if (calculatorState.expression === '0') {
            calculatorState.expression = value;
        } else {
            calculatorState.expression += value;
        }
    }
}

// 处理运算符
function handleOperator(operator) {
    // %符号的特殊处理 - 直接添加，不需要等待操作数
    if (operator === '%') {
        calculatorState.expression += operator;
        return;
    }
    
    // 其他运算符的处理
    calculatorState.expression += operator;
    calculatorState.lastOperator = operator;
    calculatorState.waitingForOperand = true;
}

// 处理操作
function handleAction(action) {
    switch (action) {
        case 'clear':
            resetCalculator();
            break;
        case 'backspace':
            backspace();
            break;
        case 'equals':
            calculate();
            break;
    }
    updateDisplay();
}

// 退格
function backspace() {
    if (calculatorState.expression.length > 1) {
        calculatorState.expression = calculatorState.expression.slice(0, -1);
    } else {
        calculatorState.expression = '0';
    }
}

// 计算
function calculate() {
    try {
        // 如果已经有结果了，不重复计算
        if (calculatorState.expression.includes('=')) {
            return;
        }
        
        // 替换显示符号为计算符号
        let expr = calculatorState.expression
            .replace(/×/g, '*')
            .replace(/÷/g, '/');
        
        // 处理百分号
        expr = expr.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
        
        const result = eval(expr);
        
        if (isNaN(result) || !isFinite(result)) {
            calculatorState.expression = 'Error';
        } else {
            // 🔧 保留原始表达式到历史记录
            const originalExpr = calculatorState.expression;
            calculatorState.history = originalExpr + '=' + formatResult(result);
            // 当前显示只显示结果
            calculatorState.expression = formatResult(result);
            calculatorState.justCalculated = true;
        }
        // 计算完成后立即保存结果
        updateDisplay();
    } catch (error) {
        calculatorState.expression = 'Error';
        updateDisplay();
    }
}

// 格式化结果
function formatResult(result) {
    // 如果是整数，直接返回
    if (Number.isInteger(result)) {
        return result.toString();
    }
    
    // 如果是小数，最多保留8位小数，并去除末尾的0
    const rounded = Math.round(result * 100000000) / 100000000;
    let str = rounded.toString();
    
    // 如果包含小数点，去除末尾的0
    if (str.includes('.')) {
        str = str.replace(/\.?0+$/, '');
    }
    
    return str;
}

// 判断是否为运算符
function isOperator(value) {
    return ['+', '-', '*', '/', '%'].includes(value);
}


// 初始化搜索框字幕功能
function initSearchMarquee() {
    const searchInput = document.getElementById('searchInput');
    const marqueeOverlay = document.getElementById('searchMarquee');
    const marqueeInteract = document.querySelector('.marquee-interact');
    const marqueeTrack = document.getElementById('marqueeTrack');

    if (!searchInput || !marqueeOverlay || !marqueeInteract) return;

    let __marqueeHoverTimer = null;
    let __marqueePaused = false;
    const setMarqueePaused = (paused) => {
        if (__marqueePaused === paused) return;
        __marqueePaused = paused;
        if (!marqueeTrack) return;
        // 用 rAF 合并布局/样式变更，降低 WebEngine 压力
        requestAnimationFrame(() => {
            if (paused) marqueeTrack.classList.add('paused');
            else marqueeTrack.classList.remove('paused');
        });
    };

    // 设置字幕覆盖层尺寸匹配输入框
    function updateMarqueeSize() {
        const rect = searchInput.getBoundingClientRect();
        marqueeOverlay.style.width = rect.width + 'px';
        marqueeOverlay.style.height = rect.height + 'px';
        marqueeOverlay.style.left = '0';
        marqueeOverlay.style.top = '0';
    }

    // 点击字幕区域聚焦输入框
    marqueeInteract.addEventListener('click', () => {
        searchInput.focus();
    });

    // 鼠标悬停暂停动画
    marqueeInteract.addEventListener('mouseenter', () => {
        if (__marqueeHoverTimer) clearTimeout(__marqueeHoverTimer);
        __marqueeHoverTimer = setTimeout(() => setMarqueePaused(true), 80);
    });

    marqueeInteract.addEventListener('mouseleave', () => {
        if (__marqueeHoverTimer) clearTimeout(__marqueeHoverTimer);
        __marqueeHoverTimer = setTimeout(() => setMarqueePaused(false), 80);
    });

    // 窗口大小改变时更新尺寸
    window.addEventListener('resize', updateMarqueeSize);
    updateMarqueeSize();

    // 加载字幕内容
    const savedContent = localStorage.getItem('searchMarqueeTexts');
    if (savedContent) {
        updateSearchMarqueeContent(savedContent);
    }

    // 初始状态更新
    updateMarqueeVisibility();
}

// 初始化自定义placeholder控制
function initCustomPlaceholder() {
    const searchInput = document.getElementById('searchInput');
    const searchBox = document.querySelector('.search-box');

    if (!searchInput || !searchBox) return;
    
    // 更新自定义placeholder的文本内容
    function updateCustomPlaceholderText() {
        const style = document.querySelector('#custom-placeholder-style');
        if (!style) {
            const newStyle = document.createElement('style');
            newStyle.id = 'custom-placeholder-style';
            document.head.appendChild(newStyle);
        }
        
        // 获取当前的placeholder文本（如果为空则不显示任何文字）
        const placeholderText = searchInput.placeholder || "";
        
        // 动态更新CSS content
        const styleElement = document.getElementById('custom-placeholder-style');
        styleElement.textContent = `
            .search-box::before {
                content: "${placeholderText}" !important;
            }
        `;
    }
    
    // 检查输入框状态并更新类名
    function updatePlaceholderVisibility() {
        const hasValue = searchInput.value.trim() !== '';
        
        // 简化逻辑：只根据是否有内容来决定显示/隐藏
        // 有内容 = 隐藏placeholder
        // 无内容 = 显示placeholder（无论是否有焦点）
        
        if (hasValue) {
            searchBox.classList.add('input-has-value');
        } else {
            searchBox.classList.remove('input-has-value');
        }
        
        console.log('[LOG] placeholder状态:', {
            value: searchInput.value,
            hasValue: hasValue,
            shouldHide: hasValue
        });
    }
    
    // 监听placeholder属性变化
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'placeholder') {
                updateCustomPlaceholderText();
            }
        });
    });
    
    observer.observe(searchInput, {
        attributes: true,
        attributeFilter: ['placeholder']
    });
    
    // 监听焦点事件
    searchInput.addEventListener('focus', () => {
        // 获得焦点时也要检查，但不强制隐藏
        updatePlaceholderVisibility();
        console.log('[LOG] 搜索框获得焦点');
    });
    
    searchInput.addEventListener('blur', () => {
        // 失去焦点时检查
        updatePlaceholderVisibility();
        console.log('[LOG] 搜索框失去焦点');
    });
    
    // 监听输入事件
    searchInput.addEventListener('input', () => {
        updatePlaceholderVisibility();
    });
    
    // 使用Object.defineProperty拦截value设置，实现零延迟响应
    const originalValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(searchInput, 'value', {
        get() {
            return originalValueDescriptor.get.call(this);
        },
        set(newValue) {
            const oldValue = originalValueDescriptor.get.call(this);
            originalValueDescriptor.set.call(this, newValue);
            
            // 值变化时立即更新placeholder
            if (oldValue !== newValue) {
                updatePlaceholderVisibility();
                console.log('[LOG] value被设置:', newValue);
            }
        },
        configurable: true
    });
    
    // 保留定时检查作为备用（以防某些情况下拦截失败）
    let lastValue = searchInput.value;
    const checkInterval = setInterval(() => {
        if (searchInput.value !== lastValue) {
            lastValue = searchInput.value;
            updatePlaceholderVisibility();
            console.log('[LOG] 定时检测到值变化:', searchInput.value);
        }
    }, 100); // 降低频率，只作为备用
    
    // 初始化
    updateCustomPlaceholderText();
    updatePlaceholderVisibility();
    
    console.log('[LOG] 自定义placeholder控制已初始化');
}

// ====== 后台模式常驻窗口接口函数 ======

/**
 * 获取搜狗快捷一级分类下的二级分类
 * returns Promise<Array> 二级分类列表
 */
window.__getSogouSubCategories = async function() {
    try {
        const categories = await db.getAllCategories();
        
        // 找到搜狗快捷这个一级分类
        const sogouCategory = categories.find(cat => {
            const name = getCategoryName(cat);
            return name && name.includes('搜狗快捷');
        });
        
        if (!sogouCategory) {
            console.warn('[后台模式] 未找到搜狗快捷分类');
            return [];
        }
        
        const sogouCategoryId = getCategoryId(sogouCategory);
        console.log('[后台模式] 找到搜狗快捷分类ID:', sogouCategoryId);
        
        // 获取该分类下的所有二级分类
        const subCategories = categories.filter(cat => {
            const parentId = getCategoryParentId(cat);
            return parentId && String(parentId) === String(sogouCategoryId);
        });
        
        console.log('[后台模式] 获取到搜狗快捷下的二级分类:', subCategories.length, '个');
        return subCategories.map(cat => ({
            id: getCategoryId(cat),
            name: getCategoryName(cat),
            parentId: getCategoryParentId(cat)
        }));
    } catch (error) {
        console.error('[后台模式] 获取搜狗快捷二级分类失败:', error);
        return [];
    }
};

/**
 * 获取指定分类的话术
 * param {string} categoryId 分类ID
 * returns {Promise<Array>} 话术列表
 */
window.__getPhrasesForCategory = async function(categoryId) {
    try {
        const phrases = await db.getPhrasesByCategory(categoryId);
        console.log('[后台模式] 获取分类', categoryId, '的话术:', phrases.length, '个');
        return phrases;
    } catch (error) {
        console.error('[后台模式] 获取话术失败:', error);
        return [];
    }
};

console.log('[LOG] 后台模式常驻窗口接口函数已注册');

// ====== 焦点保护控制 ======
// 点击输入框时激活窗口，确保输入法能正常工作

document.addEventListener('click', (e) => {
    const target = e.target;
    
    // 检查是否点击了输入框或文本区域
    const isInput = target.tagName === 'INPUT' || 
                    target.tagName === 'TEXTAREA' || 
                    target.isContentEditable ||
                    target.closest('input, textarea, [contenteditable="true"]');
    
    if (isInput) {
        // 点击输入框，激活窗口
        if (window.pythonBridge && typeof window.pythonBridge.disable_focus_protection === 'function') {
            window.pythonBridge.disable_focus_protection();
        }
    }
}, true);

// ====== 鼠标悬停触发焦点开关 ======
// 鼠标悬停到话术序号按钮时，开启不抢焦点模式
// 鼠标离开时，恢复正常模式
// 通过透明占位元素实现：只有触碰序号区域才触发
