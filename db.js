/**
 * IndexedDB 数据库管理
 * 替代 Python 的 SQLite 数据库
 */

// IndexedDB 数据库管理模块已加载

const DB_NAME = 'ZhuoyaPhrasesDB';
const DB_VERSION = 15; // v15: 为分类表添加代名词字段（enable_alias/alias）

class PhraseDatabase {
    constructor() {
        this.db = null;
        this._dirtyMarkTimer = null;  // 脏标记防抖定时器
        // ⚡ 全量话术内存缓存
        this._phrasesCache = null;         // 内存缓存数组，null 表示未加载
        this._phrasesCacheDirty = true;    // 缓存脏标记，true 表示需要从 DB 重新拉取
    }

    // 🔄 通知话术已变化（触发轮转备份 + 标记缓存过期）
    _notifyPhrasesChanged() {
        // ⚡ 标记内存缓存过期，下次查询重新拉取
        this._phrasesCacheDirty = true;

        // 使用防抖机制，避免频繁调用（500ms 内多次变化只触发一次）
        if (this._dirtyMarkTimer) {
            clearTimeout(this._dirtyMarkTimer);
        }
        this._dirtyMarkTimer = setTimeout(() => {
            if (window.pythonBridge && typeof window.pythonBridge.mark_phrases_changed === 'function') {
                try {
                    window.pythonBridge.mark_phrases_changed();
                    console.log('[备份] ✅ 已标记话术变化');
                } catch (error) {
                    console.warn('[备份] 标记话术变化失败:', error);
                }
            }
        }, 500);
    }

    // 🔄 迁移：为已有标题初始化 title_order（按 sort_order 顺序分配）
    async _migrateTitleOrder() {
        const allPhrases = await this.getAllPhrases();
        const titlesWithoutOrder = allPhrases
            .filter(p => p.is_title && p.title_order == null)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

        if (titlesWithoutOrder.length === 0) return;

        // 按 sort_order 顺序分配 title_order: 0, 1, 2, ...
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const total = titlesWithoutOrder.length;

            transaction.oncomplete = () => {
                this._notifyPhrasesChanged();
                console.log(`[迁移] 已为 ${total} 个标题初始化 title_order`);
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);

            titlesWithoutOrder.forEach((title, i) => {
                title.title_order = i;
                store.put(title);
            });
        });
    }

    // ⚡ 加载全量话术到内存缓存（仅在缓存过期时调用）
    async _loadPhrasesCache() {
        return new Promise((resolve, reject) => {
            try {
                const transaction = this.db.transaction(['phrases'], 'readonly');
                const store = transaction.objectStore('phrases');
                const request = store.getAll();
                request.onsuccess = () => {
                    this._phrasesCache = request.result || [];
                    this._phrasesCacheDirty = false;
                    console.log(`[缓存] ✅ 已加载 ${this._phrasesCache.length} 条话术到内存`);
                    resolve(this._phrasesCache);
                };
                request.onerror = () => {
                    console.warn('[缓存] 加载失败，降级为实时查询');
                    reject(request.error);
                };
            } catch (e) {
                console.warn('[缓存] 加载异常，降级为实时查询');
                reject(e);
            }
        });
    }

    // 初始化数据库
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                // ⚡ 预加载话术缓存（不阻塞 init 返回）
                this._loadPhrasesCache().catch(() => {});
                // 🔄 迁移：为已有标题初始化 title_order
                this._migrateTitleOrder().catch(() => {});
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;
                const transaction = event.target.transaction;

                // 创建话术表
                if (!db.objectStoreNames.contains('phrases')) {
                    const phraseStore = db.createObjectStore('phrases', { 
                        keyPath: 'id', 
                        autoIncrement: true 
                    });
                    phraseStore.createIndex('content', 'content', { unique: false });
                    phraseStore.createIndex('category_id', 'category_id', { unique: false });
                    phraseStore.createIndex('tags', 'tags', { unique: false });
                    phraseStore.createIndex('use_count', 'use_count', { unique: false });
                    phraseStore.createIndex('sort_order', 'sort_order', { unique: false });
                }
                
                // 版本1升级到版本2：为现有话术添加sort_order字段
                if (oldVersion < 2 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    
                    // 为现有索引添加sort_order
                    if (!phraseStore.indexNames.contains('sort_order')) {
                        phraseStore.createIndex('sort_order', 'sort_order', { unique: false });
                    }
                    
                    // 为现有数据添加sort_order字段（按ID顺序）
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach((phrase, index) => {
                            if (phrase.sort_order === undefined) {
                                phrase.sort_order = index;
                                phraseStore.put(phrase);
                            }
                        });
                    };
                }
                
                // 版本2升级到版本3：为现有话术添加占位符和图片字段
                if (oldVersion < 3 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    
                    // 为现有数据添加新字段
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.has_placeholders === undefined) {
                                phrase.has_placeholders = false;
                                phrase.placeholder_names = [];
                                phrase.images = []; // 存储图片的base64数据
                                phrase.enable_placeholder = false;
                                phrase.enable_images = false;
                                phraseStore.put(phrase);
                            }
                        });
                    };
                }

                // 创建分类表
                if (!db.objectStoreNames.contains('categories')) {
                    const categoryStore = db.createObjectStore('categories', { 
                        keyPath: 'id', 
                        autoIncrement: false  // 🔥 手动管理ID，递增不复用
                    });
                    categoryStore.createIndex('name', 'name', { unique: true });
                }
                
                // 版本3升级到版本4：将现有分类表转为手动ID管理
                if (oldVersion < 4 && db.objectStoreNames.contains('categories')) {
                    // ⚠️ IndexedDB 不支持修改 objectStore 配置，只能通过迁移数据实现
                    // 由于已存在数据，我们保持表结构不变，但在 addCategory 中实现手动ID逻辑
                    console.log('📝 升级到版本4：分类表将使用手动递增ID管理');
                }
                
                // 版本4升级到版本5：为话术表添加 is_deleted 字段（软删除）
                if (oldVersion < 5 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    
                    // 添加 is_deleted 索引
                    if (!phraseStore.indexNames.contains('is_deleted')) {
                        phraseStore.createIndex('is_deleted', 'is_deleted', { unique: false });
                    }
                    
                    // 为现有数据添加 is_deleted 字段（默认 false）
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.is_deleted === undefined) {
                                // 🔥 如果话术的 category_id = 1（旧的回收站），标记为已删除
                                phrase.is_deleted = (phrase.category_id === 1);
                                // 如果原来在回收站，恢复到"未分类"（category_id = 0）
                                if (phrase.is_deleted && phrase.category_id === 1) {
                                    phrase.category_id = 0;
                                }
                                phraseStore.put(phrase);
                            }
                        });
                    };
                    
                    console.log('📝 升级到版本5：话术表添加 is_deleted 字段（软删除）');
                }

                // 版本5升级到版本6：为分类补齐 parent_id/sort_order 缺省
                if (oldVersion < 6 && db.objectStoreNames.contains('categories')) {
                    const categoryStore = transaction.objectStore('categories');
                    const getAll = categoryStore.getAll();
                    getAll.onsuccess = () => {
                        const cats = getAll.result || [];
                        cats.forEach((c, idx) => {
                            if (c.parent_id === undefined || c.parent_id === null) c.parent_id = 0;
                            if (typeof c.sort_order !== 'number') c.sort_order = idx;
                            categoryStore.put(c);
                        });
                    };
                }

                // 版本6升级到版本7：为话术表添加样式字段（text_color, bg_color, is_bold）
                if (oldVersion < 7 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.text_color === undefined) phrase.text_color = null;
                            if (phrase.bg_color === undefined) phrase.bg_color = null;
                            if (phrase.is_bold === undefined) phrase.is_bold = false;
                            phraseStore.put(phrase);
                        });
                    };
                    console.log('📝 升级到版本7：话术表添加样式字段（text_color, bg_color, is_bold）');
                }

                // 版本7升级到版本8：为话术表添加content_html字段（支持部分文字样式）
                if (oldVersion < 8 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.content_html === undefined) {
                                phrase.content_html = null; // 默认为null，表示没有HTML格式
                            }
                            phraseStore.put(phrase);
                        });
                    };
                    console.log('📝 升级到版本8：话术表添加content_html字段（支持部分文字样式）');
                }

                // 版本8升级到版本9：为话术表添加disable_click_copy字段（关闭点击复制）
                if (oldVersion < 9 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.disable_click_copy === undefined) {
                                phrase.disable_click_copy = false; // 默认为false，允许点击复制
                            }
                            phraseStore.put(phrase);
                        });
                    };
                    console.log('📝 升级到版本9：话术表添加disable_click_copy字段（关闭点击复制）');
                }

                // 版本9升级到版本10：为分类表添加show_text_editor字段（控制是否显示文本编辑按钮）
                if (oldVersion < 10 && db.objectStoreNames.contains('categories')) {
                    const categoryStore = transaction.objectStore('categories');
                    const getAllRequest = categoryStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const categories = getAllRequest.result;
                        categories.forEach(category => {
                            if (category.show_text_editor === undefined) {
                                category.show_text_editor = false; // 默认为false，不显示文本编辑按钮
                            }
                            categoryStore.put(category);
                        });
                    };
                    console.log('📝 升级到版本10：分类表添加show_text_editor字段（控制是否显示文本编辑按钮）');
                }

                // 版本10升级到版本11：为话术表添加parent_id和enable_variants字段（支持变形话术）
                if (oldVersion < 11 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    
                    // 添加parent_id索引
                    if (!phraseStore.indexNames.contains('parent_id')) {
                        phraseStore.createIndex('parent_id', 'parent_id', { unique: false });
                    }
                    
                    // 为现有数据添加新字段
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result;
                        phrases.forEach(phrase => {
                            if (phrase.parent_id === undefined) {
                                phrase.parent_id = null; // null表示主话术，数字表示是某个话术的变形
                                phrase.enable_variants = false; // 是否启用变形按钮
                                phraseStore.put(phrase);
                            }
                        });
                    };
                    console.log('🔄 升级到版本11：话术表添加parent_id和enable_variants字段（支持变形话术）');
                }

                // 版本11升级到版本12：为分类表添加use_count和last_used字段（支持分类使用统计）
                if (oldVersion < 12 && db.objectStoreNames.contains('categories')) {
                    const categoryStore = transaction.objectStore('categories');
                    
                    // 为现有数据添加新字段
                    const getAllRequest = categoryStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const categories = getAllRequest.result;
                        categories.forEach(category => {
                            if (category.use_count === undefined) {
                                category.use_count = 0;
                                category.last_used = null;
                                categoryStore.put(category);
                            }
                        });
                    };
                    console.log('🔄 升级到版本12：分类表添加use_count和last_used字段（支持分类使用统计）');
                }

                // 版本12升级到版本13：为话术表添加标题卡片相关字段
                // is_title: 是否标题卡片
                // title_text: 标题内容
                // title_id: 预留字段（普通话术所属标题ID，后续折叠/分组使用）
                // is_collapsed: 标题是否折叠（后续折叠功能使用，当前阶段默认false）
                if (oldVersion < 13 && db.objectStoreNames.contains('phrases')) {
                    const phraseStore = transaction.objectStore('phrases');
                    const getAllRequest = phraseStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const phrases = getAllRequest.result || [];
                        phrases.forEach(phrase => {
                            if (phrase.is_title === undefined) {
                                phrase.is_title = false;
                            }
                            if (phrase.title_text === undefined) {
                                phrase.title_text = null;
                            }
                            if (phrase.title_id === undefined) {
                                phrase.title_id = null;
                            }
                            if (phrase.is_collapsed === undefined) {
                                phrase.is_collapsed = false;
                            }
                            phraseStore.put(phrase);
                        });
                    };
                    console.log('📝 升级到版本13：话术表添加标题卡片字段（is_title/title_text/title_id/is_collapsed）');
                }

                // 版本13升级到版本14：为分类表添加 display_as_button 字段（控制该分类是否以按钮样式显示）
                if (oldVersion < 14 && db.objectStoreNames.contains('categories')) {
                    const categoryStore = transaction.objectStore('categories');
                    const getAllRequest = categoryStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const categories = getAllRequest.result || [];
                        categories.forEach(category => {
                            if (category.display_as_button === undefined) {
                                category.display_as_button = false; // 默认为 false
                                categoryStore.put(category);
                            }
                        });
                    };
                    console.log('📝 升级到版本14：分类表添加 display_as_button 字段（控制分类以按钮样式显示）');
                }

                // 版本14升级到版本15：为分类表添加代名词字段（enable_alias/alias）
                if (oldVersion < 15 && db.objectStoreNames.contains('categories')) {
                    const categoryStore = transaction.objectStore('categories');
                    const getAllRequest = categoryStore.getAll();
                    getAllRequest.onsuccess = () => {
                        const categories = getAllRequest.result || [];
                        categories.forEach(category => {
                            if (category.enable_alias === undefined) {
                                category.enable_alias = false;
                            }
                            if (category.alias === undefined) {
                                category.alias = null;
                            }
                            categoryStore.put(category);
                        });
                    };
                    console.log('📝 升级到版本15：分类表添加代名词字段（enable_alias/alias）');
                }

                // 创建设置表
                if (!db.objectStoreNames.contains('settings')) {
                    db.createObjectStore('settings', { keyPath: 'key' });
                }
            };
        });
    }

    async addChildPhrase(parentId, content, category_id = 1, tags = '', enablePlaceholder = false, enableImages = false, textColor = null, bgColor = null, isBold = false, contentHtml = null, disableClickCopy = false, enableDescription = false, description = '', enableVariants = false, jumpCategoryId = null) {
        const pid = parentId === null || parentId === undefined ? null : Number(parentId);
        if (!pid || Number.isNaN(pid)) {
            throw new Error('parentId 无效');
        }

        // 确保 tags 是字符串
        const tagsStr = tags ? String(tags) : '';

        // 子话术排序：仅在同一个 parent_id 的子集合内递增
        let maxSiblingOrder = -1;
        try {
            const siblings = await this.getChildPhrases(pid, false);
            if (siblings && siblings.length > 0) {
                maxSiblingOrder = Math.max(...siblings.map(p => (typeof p.sort_order === 'number' ? p.sort_order : -1)));
            }
        } catch (e) {
            maxSiblingOrder = -1;
        }

        // 自动检测占位符（从纯文本内容中检测）
        const placeholders = this.extractPlaceholders(content);

        const phrase = {
            content,
            content_html: contentHtml,
            category_id,
            tags: tagsStr,
            use_count: 0,
            sort_order: maxSiblingOrder + 1,
            created_time: new Date().toISOString(),
            last_used: null,
            has_placeholders: placeholders.length > 0,
            placeholder_names: placeholders,
            images: [],
            enable_placeholder: enablePlaceholder,
            enable_images: enableImages,
            is_deleted: false,
            text_color: textColor,
            bg_color: bgColor,
            is_bold: isBold,
            disable_click_copy: disableClickCopy,
            enable_description: enableDescription,
            description: description || '',
            enable_variants: enableVariants,
            parent_id: pid,
            jump_category_id: jumpCategoryId || null, // 0 → null
            is_title: false,
            title_text: null,
            title_id: null,
            is_collapsed: false,
            title_order: null        // 标题专用排序（仅 is_title=true 时有效）
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const request = store.add(phrase);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // 批量关闭“启用图片功能”（仅对没有任何图片附件的话术）
    async bulkDisableImagesForNoAttachment() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getAllRequest = store.getAll();

            getAllRequest.onsuccess = () => {
                const phrases = getAllRequest.result || [];
                let updatedCount = 0;

                phrases.forEach(p => {
                    const hasNoImages = !p.images || (Array.isArray(p.images) && p.images.length === 0);
                    if (hasNoImages && p.enable_images === true) {
                        p.enable_images = false;
                        store.put(p);
                        updatedCount++;
                    }
                });

                transaction.oncomplete = () => resolve(updatedCount);
                transaction.onerror = () => reject(transaction.error);
            };
            getAllRequest.onerror = () => reject(getAllRequest.error);
        });
    }

    // ==================== 工具方法 ====================
    
    // 提取话术中的占位符
    extractPlaceholders(content) {
        const regex = /\{([^}]+)\}/g;
        const placeholders = [];
        let match;
        
        while ((match = regex.exec(content)) !== null) {
            const placeholder = match[1];
            if (!placeholders.includes(placeholder)) {
                placeholders.push(placeholder);
            }
        }
        
        return placeholders;
    }
    
    // 添加图片到话术
    async addImageToPhrase(phraseId, imageBase64) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(phraseId);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    if (!phrase.images) {
                        phrase.images = [];
                    }
                    phrase.images.push(imageBase64);
                    
                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => {
                        this._notifyPhrasesChanged();
                        resolve();
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 从话术删除图片
    async removeImageFromPhrase(phraseId, imageIndex) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(phraseId);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    if (phrase.images && phrase.images.length > imageIndex) {
                        phrase.images.splice(imageIndex, 1);
                        
                        const updateRequest = store.put(phrase);
                        updateRequest.onsuccess = () => {
                            this._notifyPhrasesChanged();
                            resolve();
                        };
                        updateRequest.onerror = () => reject(updateRequest.error);
                    } else {
                        reject(new Error('Image not found'));
                    }
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // ==================== 话术相关操作 ====================
    
    async addPhrase(content, category_id = 1, tags = '', enablePlaceholder = false, enableImages = false, textColor = null, bgColor = null, isBold = false, contentHtml = null, disableClickCopy = false, enableDescription = false, description = '', enableVariants = false, jumpCategoryId = null, tagPrefix = false) {
        // 确保 tags 是字符串
        const tagsStr = tags ? String(tags) : '';
        
        // 获取当前最大的sort_order
        const allPhrases = await this.getAllPhrases();
        const maxSortOrder = allPhrases.length > 0 
            ? Math.max(...allPhrases.map(p => p.sort_order || 0)) 
            : -1;
        
        // 自动检测占位符（从纯文本内容中检测）
        const placeholders = this.extractPlaceholders(content);
        
        const phrase = {
            content,
            content_html: contentHtml,  // 🎨 HTML格式内容（支持部分文字样式）
            category_id,
            tags: tagsStr,
            use_count: 0,
            sort_order: maxSortOrder + 1,
            created_time: new Date().toISOString(),
            last_used: null,
            has_placeholders: placeholders.length > 0,
            placeholder_names: placeholders,
            images: [],
            enable_placeholder: enablePlaceholder,
            enable_images: enableImages,
            is_deleted: false,  // 🗑️ 软删除标记（默认未删除）
            text_color: textColor,  // 🎨 字体颜色（整体样式）
            bg_color: bgColor,  // 🎨 背景颜色（整体样式）
            is_bold: isBold,  // 🎨 是否加粗（整体样式）
            disable_click_copy: disableClickCopy,  // 🚫 是否关闭点击复制（默认false，允许点击复制）
            enable_description: enableDescription,  // 📋 是否启用说明功能
            description: description || '',  // 📋 使用说明内容
            enable_variants: enableVariants,  // 🔄 是否启用变形功能
            parent_id: null,  // 🔄 父话术ID（null表示主话术）
            jump_category_id: jumpCategoryId || null,  // 🔗 跳转分类ID（0 → null）
            tag_prefix: tagPrefix,  // 📌 标签前置（标签显示在话术前面）
            // 标题卡片相关字段（普通话术默认不是标题）
            is_title: false,
            title_text: null,
            title_id: null,
            is_collapsed: false,
            title_order: null        // 标题专用排序（仅 is_title=true 时有效）
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const request = store.add(phrase);

            request.onsuccess = () => {
                // 🔄 标记话术已变化（触发轮转备份）
                this._notifyPhrasesChanged();
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 添加标题卡片（仅包含标题文本，不可点击复制）
     * @param {string} title 标题文本
     * @param {number} category_id 所属分类ID
     */
    async addTitlePhrase(title, category_id = 1, show_text_editor = false, titleOrder = null) {
        const titleText = title ? String(title).trim() : '';
        if (!titleText) {
            throw new Error('标题内容不能为空');
        }

        const allPhrases = await this.getAllPhrases();

        // 计算 sort_order（用于组内排序，追加到末尾）
        const maxSortOrder = allPhrases.length > 0
            ? Math.max(...allPhrases.map(p => p.sort_order || 0))
            : -1;

        // 计算 title_order（用于标题之间的排序）
        // 如果未指定，追加到末尾；否则使用指定值
        let newTitleOrder = titleOrder;
        if (newTitleOrder === null) {
            const titleOrders = allPhrases
                .filter(p => p.is_title && p.title_order != null)
                .map(p => p.title_order);
            newTitleOrder = titleOrders.length > 0 ? Math.max(...titleOrders) + 1 : 0;
        }

        const phrase = {
            content: titleText,
            content_html: null,
            category_id,
            tags: '',
            use_count: 0,
            sort_order: maxSortOrder + 1,
            created_time: new Date().toISOString(),
            last_used: null,
            has_placeholders: false,
            placeholder_names: [],
            images: [],
            enable_placeholder: false,
            enable_images: false,
            is_deleted: false,
            text_color: null,
            bg_color: null,
            is_bold: false,
            disable_click_copy: true,   // 标题卡片不参与点击复制
            enable_description: false,
            description: '',
            enable_variants: false,
            parent_id: null,
            // 标题卡片相关字段
            is_title: true,
            title_text: titleText,
            title_id: null,
            is_collapsed: false,
            title_order: newTitleOrder,
            show_text_editor: show_text_editor
        };
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const request = store.add(phrase);

            request.onsuccess = () => {
                // 🔄 标记话术已变化（触发轮转备份 + 标记缓存过期）
                this._notifyPhrasesChanged();
                resolve(request.result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 在最前面插入标题（所有现有标题 title_order + 1，新标题为 0）
     */
    async addTitlePhraseAtStart(title, category_id = 1, show_text_editor = false) {
        const titleText = title ? String(title).trim() : '';
        if (!titleText) {
            throw new Error('标题内容不能为空');
        }

        const allPhrases = await this.getAllPhrases();

        // 计算 sort_order
        const maxSortOrder = allPhrases.length > 0
            ? Math.max(...allPhrases.map(p => p.sort_order || 0))
            : -1;

        const phrase = {
            content: titleText,
            content_html: null,
            category_id,
            tags: '',
            use_count: 0,
            sort_order: maxSortOrder + 1,
            created_time: new Date().toISOString(),
            last_used: null,
            has_placeholders: false,
            placeholder_names: [],
            images: [],
            enable_placeholder: false,
            enable_images: false,
            is_deleted: false,
            text_color: null,
            bg_color: null,
            is_bold: false,
            disable_click_copy: true,
            enable_description: false,
            description: '',
            enable_variants: false,
            parent_id: null,
            is_title: true,
            title_text: titleText,
            title_id: null,
            is_collapsed: false,
            title_order: 0,
            show_text_editor: show_text_editor
        };

        // 插入到最前面
        const sorted = allPhrases
            .filter(p => !p.is_deleted)
            .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

        sorted.unshift(phrase);

        return this._saveReorderedList(sorted);
    }

    /**
     * 在指定标题之前插入新标题（同时更新 sort_order 和 title_order）
     */
    async addTitlePhraseBeforeTitle(title, category_id, show_text_editor, targetTitleId) {
        const titleText = title ? String(title).trim() : '';
        if (!titleText) {
            throw new Error('标题内容不能为空');
        }

        const allPhrases = await this.getAllPhrases();
        const sorted = allPhrases
            .filter(p => !p.is_deleted)
            .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

        const targetIdx = sorted.findIndex(p => p.id === targetTitleId);
        if (targetIdx === -1) {
            // 找不到目标标题，追加到最后
            return this.addTitlePhrase(title, category_id, show_text_editor, null);
        }

        const phrase = {
            content: titleText, content_html: null, category_id, tags: '', use_count: 0,
            sort_order: 0, created_time: new Date().toISOString(),
            last_used: null, has_placeholders: false, placeholder_names: [], images: [],
            enable_placeholder: false, enable_images: false, is_deleted: false,
            text_color: null, bg_color: null, is_bold: false, disable_click_copy: true,
            enable_description: false, description: '', enable_variants: false,
            parent_id: null, is_title: true, title_text: titleText, title_id: null,
            is_collapsed: false, title_order: 0,
            show_text_editor: show_text_editor
        };

        // 插入到目标位置
        sorted.splice(targetIdx, 0, phrase);

        return this._saveReorderedList(sorted);
    }

    /**
     * 在指定话术之前插入新标题
     */
    async addTitlePhraseBeforePhrase(title, category_id, show_text_editor, targetPhraseId) {
        const allPhrases = await this.getAllPhrases();
        const targetPhrase = allPhrases.find(p => p.id === targetPhraseId);
        if (!targetPhrase) {
            return this.addTitlePhrase(title, category_id, show_text_editor, null);
        }

        // 找到该话术归属的标题（最近的前置标题）
        const phraseSortOrder = targetPhrase.sort_order ?? 0;
        const titles = allPhrases
            .filter(p => p.is_title && (p.sort_order ?? -Infinity) <= phraseSortOrder)
            .sort((a, b) => (b.sort_order ?? 0) - (a.sort_order ?? 0));

        const owningTitle = titles.length > 0 ? titles[0] : null;

        if (!owningTitle) {
            // 话术没有归属标题，插入到最前面
            return this.addTitlePhraseAtStart(title, category_id, show_text_editor);
        }

        // 插入到归属标题之前
        return this.addTitlePhraseBeforeTitle(title, category_id, show_text_editor, owningTitle.id);
    }

    /**
     * 移动标题到指定标题之前（重新排序）
     * 同时更新 sort_order 和 title_order
     */
    async repositionTitle(titleId, beforeTitleId) {
        const allPhrases = await this.getAllPhrases();
        // 按 sort_order 排序的扁平列表
        const sorted = allPhrases
            .filter(p => !p.is_deleted)
            .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

        const currentIdx = sorted.findIndex(p => p.id === titleId);
        const targetIdx = sorted.findIndex(p => p.id === beforeTitleId);
        if (currentIdx === -1 || targetIdx === -1 || currentIdx === targetIdx) return;

        // 从原位置移除
        const [movedTitle] = sorted.splice(currentIdx, 1);
        // 重新计算目标索引
        const newTargetIdx = sorted.findIndex(p => p.id === beforeTitleId);
        // 插入到目标位置之前
        sorted.splice(newTargetIdx, 0, movedTitle);

        // 重新分配 sort_order 和 title_order
        return this._saveReorderedList(sorted);
    }

    /**
     * 移动标题到最前面
     */
    async repositionTitleToStart(titleId) {
        const allPhrases = await this.getAllPhrases();
        const sorted = allPhrases
            .filter(p => !p.is_deleted)
            .sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));

        const currentIdx = sorted.findIndex(p => p.id === titleId);
        if (currentIdx <= 0) return; // 已经在最前面

        // 移除并插入到开头
        const [movedTitle] = sorted.splice(currentIdx, 1);
        sorted.unshift(movedTitle);

        return this._saveReorderedList(sorted);
    }

    /**
     * 保存重新排序后的列表（同时更新 sort_order 和 title_order）
     */
    async _saveReorderedList(sorted) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');

            transaction.oncomplete = () => {
                this._notifyPhrasesChanged();
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);

            // 分配 sort_order（扁平序号）
            sorted.forEach((item, i) => {
                item.sort_order = i;
                store.put(item);
            });

            // 重新计算 title_order（仅标题）
            const titles = sorted.filter(p => p.is_title);
            titles.forEach((title, i) => {
                title.title_order = i;
                store.put(title);
            });
        });
    }

    /**
     * 更新标题卡片文本（只改标题，不动其他字段）
     */
    async updateTitlePhrase(id, newTitle, show_text_editor) {
        const titleText = newTitle ? String(newTitle).trim() : '';
        if (!titleText) {
            throw new Error('标题内容不能为空');
        }
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);
            
            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (!phrase) {
                    reject(new Error('标题卡片不存在'));
                    return;
                }
                
                phrase.is_title = true;
                phrase.title_text = titleText;
                // 让 content 与标题保持一致，便于搜索/导出
                phrase.content = titleText;
                // 更新显示文本编辑按钮的设置
                if (typeof show_text_editor !== 'undefined') {
                    phrase.show_text_editor = show_text_editor;
                }
                
                const updateRequest = store.put(phrase);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            };
            
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * 更新标题的 title_order（用于排序）
     */
    async updateTitlePhraseOrder(id, newTitleOrder) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (!phrase) {
                    reject(new Error('标题卡片不存在'));
                    return;
                }
                phrase.title_order = newTitleOrder;
                const updateRequest = store.put(phrase);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    /**
     * 更新标题卡片的折叠状态（仅更新 is_collapsed 字段）
     */
    async setTitleCollapse(id, isCollapsed) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);
            
            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (!phrase) {
                    reject(new Error('标题卡片不存在'));
                    return;
                }
                // 确保是标题卡片（如果不是也允许写入，以保证兼容）
                phrase.is_collapsed = !!isCollapsed;
                const updateRequest = store.put(phrase);
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = () => reject(updateRequest.error);
            };
            
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    async updatePhrase(id, content, category_id, tags, enablePlaceholder = null, enableImages = null, textColor = null, bgColor = null, isBold = null, contentHtml = null, disableClickCopy = null, enableDescription = null, description = null, enableVariants = null, jumpCategoryId = null, tagPrefix = null) {
        // 确保 tags 是字符串
        const tagsStr = tags ? String(tags) : '';
        
        // 自动检测占位符（从纯文本内容中检测）
        const placeholders = this.extractPlaceholders(content);
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    phrase.content = content;
                    phrase.category_id = category_id;
                    phrase.tags = tagsStr;
                    phrase.has_placeholders = placeholders.length > 0;
                    phrase.placeholder_names = placeholders;
                    
                    // 更新HTML内容（如果提供了参数）
                    if (contentHtml !== null) {
                        phrase.content_html = contentHtml;
                    }
                    
                    // 更新扩展功能开关（如果提供了参数）
                    if (enablePlaceholder !== null) {
                        phrase.enable_placeholder = enablePlaceholder;
                    }
                    if (enableImages !== null) {
                        phrase.enable_images = enableImages;
                    }
                    
                    // 更新样式字段（如果提供了参数）
                    if (textColor !== null) {
                        phrase.text_color = textColor;
                    }
                    if (bgColor !== null) {
                        phrase.bg_color = bgColor;
                    }
                    if (isBold !== null) {
                        phrase.is_bold = isBold;
                    }
                    
                    // 确保字段存在（向后兼容）
                    if (phrase.enable_placeholder === undefined) {
                        phrase.enable_placeholder = false;
                    }
                    if (phrase.enable_images === undefined) {
                        phrase.enable_images = false;
                    }
                    if (!phrase.images) {
                        phrase.images = [];
                    }
                    if (phrase.text_color === undefined) {
                        phrase.text_color = null;
                    }
                    if (phrase.bg_color === undefined) {
                        phrase.bg_color = null;
                    }
                    if (phrase.is_bold === undefined) {
                        phrase.is_bold = false;
                    }
                    
                    // 更新关闭点击复制字段（如果提供了参数）
                    if (disableClickCopy !== null) {
                        phrase.disable_click_copy = disableClickCopy;
                    }
                    
                    // 确保字段存在（向后兼容）
                    if (phrase.disable_click_copy === undefined) {
                        phrase.disable_click_copy = false;
                    }
                    
                    // 更新说明功能字段（如果提供了参数）
                    if (enableDescription !== null) {
                        phrase.enable_description = enableDescription;
                    }
                    if (description !== null) {
                        phrase.description = description || '';
                    }
                    
                    // 确保字段存在（向后兼容）
                    if (phrase.enable_description === undefined) {
                        phrase.enable_description = false;
                    }
                    if (phrase.description === undefined) {
                        phrase.description = '';
                    }
                    
                    // 更新变形功能字段（如果提供了参数）
                    if (enableVariants !== null) {
                        phrase.enable_variants = enableVariants;
                    }

                    // 确保字段存在（向后兼容）
                    if (phrase.enable_variants === undefined) {
                        phrase.enable_variants = false;
                    }

                    // 更新跳转分类字段（0 = 清除跳转，null = 不修改）
                    if (jumpCategoryId === 0) {
                        phrase.jump_category_id = null;
                    } else if (jumpCategoryId !== null) {
                        phrase.jump_category_id = jumpCategoryId;
                    }

                    // 确保字段存在（向后兼容）
                    if (phrase.jump_category_id === undefined) {
                        phrase.jump_category_id = null;
                    }

                    // 更新标签前置字段（如果提供了参数）
                    if (tagPrefix !== null) {
                        phrase.tag_prefix = tagPrefix;
                    }

                    // 确保字段存在（向后兼容）
                    if (phrase.tag_prefix === undefined) {
                        phrase.tag_prefix = false;
                    }

                    // 确保标题卡片字段存在（向后兼容）
                    if (phrase.is_title === undefined) {
                        phrase.is_title = false;
                    }
                    if (phrase.title_text === undefined) {
                        phrase.title_text = null;
                    }
                    if (phrase.title_id === undefined) {
                        phrase.title_id = null;
                    }
                    if (phrase.is_collapsed === undefined) {
                        phrase.is_collapsed = false;
                    }
                    
                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => {
                        // 🔄 标记话术已变化（触发轮转备份）
                        this._notifyPhrasesChanged();
                        resolve();
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 🗑️ 软删除话术（移到回收站）
    async deletePhrase(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    phrase.is_deleted = true;  // 🔥 标记为已删除
                    phrase.deleted_time = new Date().toISOString();  // 记录删除时间

                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => {
                        // 🔄 标记话术已变化（触发轮转备份）
                        this._notifyPhrasesChanged();
                        resolve();
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }
    
    // 🔥 永久删除话术（真正删除）
    async permanentlyDeletePhrase(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const request = store.delete(id);

            request.onsuccess = () => {
                // 🔄 标记话术已变化（触发轮转备份）
                this._notifyPhrasesChanged();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 🔄 恢复话术（从回收站恢复）
    async restorePhrase(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    phrase.is_deleted = false;  // 🔥 恢复为未删除
                    delete phrase.deleted_time;  // 删除删除时间

                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => {
                        // 🔄 标记话术已变化（触发轮转备份）
                        this._notifyPhrasesChanged();
                        resolve();
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 获取所有话术（不带过滤）
    async getAllPhrases() {
        return this.searchPhrases('', null);
    }
    
    // 🗑️ 获取回收站中的话术
    async getDeletedPhrases() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases', 'categories'], 'readonly');
            const phraseStore = transaction.objectStore('phrases');
            const request = phraseStore.getAll();

            request.onsuccess = async () => {
                let phrases = request.result;

                // 获取所有分类用于显示分类名和判断回收站分类
                const categories = await this.getAllCategories();
                const categoryMap = {};
                const RECYCLE_CATEGORY_NAMES = new Set(['🗑️话术回收', '话术回收', '回收站']);
                
                // 找出所有回收站分类的ID（可能有多个）
                const recycleCategoryIds = new Set();
                categories.forEach(cat => {
                    categoryMap[cat.id] = cat.name;
                    // 检查是否是回收站分类（ID=1 或名称匹配）
                    if (cat.id === 1 || RECYCLE_CATEGORY_NAMES.has(cat.name.trim())) {
                        recycleCategoryIds.add(cat.id);
                    }
                });

                // 保留已删除的话术，或者属于回收站分类的话术（兼容旧数据）
                phrases = phrases.filter(p => {
                    if (p.is_deleted) return true;
                    // 如果 category_id 属于回收站分类，也包含进来（旧数据兼容）
                    if (recycleCategoryIds.has(p.category_id)) {
                        return true;
                    }
                    return false;
                });

                // 添加分类名
                phrases = phrases.map(phrase => ({
                    ...phrase,
                    category_name: categoryMap[phrase.category_id] || '未分类'
                }));

                // 按删除时间降序排序（最新删除的在前面）
                // 对于没有 deleted_time 的旧数据，放在最后
                phrases.sort((a, b) => {
                    const timeA = a.deleted_time || '';
                    const timeB = b.deleted_time || '';
                    if (timeA && timeB) {
                        return timeB.localeCompare(timeA);
                    }
                    if (timeA) return -1; // a 有删除时间，排在前面
                    if (timeB) return 1;  // b 有删除时间，排在前面
                    return 0; // 都没有删除时间，保持原顺序
                });

                resolve(phrases);
            };

            request.onerror = () => reject(request.error);
        });
    }

    // ⚡ 搜索话术（优先读内存缓存，支持外部传入分类缓存）
    async searchPhrases(keyword = '', category_id = null, includeDeleted = false, includeChildren = false, cachedCategories = null) {
        // 获取数据源：优先内存缓存，否则从 DB 加载
        let allPhrases;
        if (this._phrasesCache && !this._phrasesCacheDirty) {
            allPhrases = this._phrasesCache;
        } else {
            try {
                const cache = await this._loadPhrasesCache();
                allPhrases = cache;
            } catch (e) {
                // 降级：直接查 DB
                allPhrases = await new Promise((resolve, reject) => {
                    const tx = this.db.transaction(['phrases'], 'readonly');
                    const req = tx.objectStore('phrases').getAll();
                    req.onsuccess = () => resolve(req.result || []);
                    req.onerror = () => reject(req.error);
                });
            }
        }

        let phrases = allPhrases;

        // 🗑️ 先过滤已删除（先 filter 后 map，减少后续遍历量）
        if (!includeDeleted) {
            phrases = phrases.filter(p => !p.is_deleted);
        }

        // 按分类筛选
        if (category_id !== null && category_id !== '') {
            const catId = parseInt(category_id);
            if (catId === 0) {
                phrases = phrases.filter(p => p.category_id === 0 || p.category_id === null);
            } else {
                phrases = phrases.filter(p => p.category_id === catId);
            }
        }

        // 按关键词搜索
        if (keyword) {
            const lowerKeyword = keyword.toLowerCase();
            phrases = phrases.filter(p =>
                p.content.toLowerCase().includes(lowerKeyword) ||
                (p.tags && typeof p.tags === 'string' && p.tags.toLowerCase().includes(lowerKeyword))
            );
        }

        // ⚡ 用外部传入的分类缓存构建 categoryMap（不查 DB）
        const categories = cachedCategories || await this.getAllCategories();
        const categoryMap = {};
        categories.forEach(cat => { categoryMap[cat.id] = cat.name; });

        // 最后 map 追加分类名（遍历量已最小化）
        phrases = phrases.map(phrase => ({
            ...phrase,
            category_name: categoryMap[phrase.category_id] || '未分类'
        }));

        // 排序
        const sortMode = await this.getSetting('sort_mode', 'manual');
        if (sortMode === 'click_count') {
            phrases.sort((a, b) => (b.use_count || 0) - (a.use_count || 0) || b.id - a.id);
        } else {
            phrases.sort((a, b) => (a.sort_order ?? 999999) - (b.sort_order ?? 999999));
        }

        return phrases;
    }

    async getPhraseById(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readonly');
            const store = transaction.objectStore('phrases');
            const request = store.get(id);

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onerror = () => reject(request.error);
        });
    }
    
    // 别名方法，方便调用
    async getPhrase(id) {
        return this.getPhraseById(id);
    }

    async getChildPhrases(parentId, includeDeleted = false) {
        return new Promise((resolve, reject) => {
            try {
                const pid = parseInt(parentId, 10);
                const transaction = this.db.transaction(['phrases'], 'readonly');
                const store = transaction.objectStore('phrases');
                let index = null;
                try {
                    index = store.index('parent_id');
                } catch (e) {
                    index = null;
                }

                if (!index) {
                    const reqAll = store.getAll();
                    reqAll.onsuccess = async () => {
                        try {
                            let phrases = (reqAll.result || []).filter(p => {
                                const ppid = p.parent_id === undefined ? null : p.parent_id;
                                return ppid === pid;
                            });
                            if (!includeDeleted) {
                                phrases = phrases.filter(p => !p.is_deleted);
                            }
                            const categories = await this.getAllCategories();
                            const categoryMap = {};
                            categories.forEach(cat => {
                                categoryMap[cat.id] = cat.name;
                            });
                            phrases = phrases.map(phrase => ({
                                ...phrase,
                                category_name: categoryMap[phrase.category_id] || '未分类'
                            }));
                            phrases.sort((a, b) => {
                                const orderA = a.sort_order !== undefined ? a.sort_order : 999999;
                                const orderB = b.sort_order !== undefined ? b.sort_order : 999999;
                                return orderA - orderB;
                            });
                            resolve(phrases);
                        } catch (innerErr) {
                            reject(innerErr);
                        }
                    };
                    reqAll.onerror = () => reject(reqAll.error);
                    return;
                }

                const req = index.getAll(pid);
                req.onsuccess = async () => {
                    try {
                        let phrases = req.result || [];
                        if (!includeDeleted) {
                            phrases = phrases.filter(p => !p.is_deleted);
                        }
                        const categories = await this.getAllCategories();
                        const categoryMap = {};
                        categories.forEach(cat => {
                            categoryMap[cat.id] = cat.name;
                        });
                        phrases = phrases.map(phrase => ({
                            ...phrase,
                            category_name: categoryMap[phrase.category_id] || '未分类'
                        }));
                        phrases.sort((a, b) => {
                            const orderA = a.sort_order !== undefined ? a.sort_order : 999999;
                            const orderB = b.sort_order !== undefined ? b.sort_order : 999999;
                            return orderA - orderB;
                        });
                        resolve(phrases);
                    } catch (innerErr) {
                        reject(innerErr);
                    }
                };
                req.onerror = () => reject(req.error);
            } catch (err) {
                reject(err);
            }
        });
    }

    async incrementUseCount(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    phrase.use_count = (phrase.use_count || 0) + 1;
                    phrase.last_used = new Date().toISOString();
                    
                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 增加分类使用次数
    async incrementCategoryUseCount(categoryId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            const getRequest = store.get(categoryId);

            getRequest.onsuccess = () => {
                const category = getRequest.result;
                if (category) {
                    category.use_count = (category.use_count || 0) + 1;
                    category.last_used = new Date().toISOString();
                    
                    const updateRequest = store.put(category);
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Category not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 清空话术与分类的使用统计
    async resetUsageStats() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases', 'categories'], 'readwrite');

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);

            // 重置话术
            const phraseStore = transaction.objectStore('phrases');
            const phraseReq = phraseStore.getAll();
            phraseReq.onsuccess = () => {
                const phrases = phraseReq.result || [];
                phrases.forEach(p => {
                    p.use_count = 0;
                    p.last_used = null;
                    phraseStore.put(p);
                });
            };

            // 重置分类
            const categoryStore = transaction.objectStore('categories');
            const catReq = categoryStore.getAll();
            catReq.onsuccess = () => {
                const cats = catReq.result || [];
                cats.forEach(c => {
                    c.use_count = 0;
                    c.last_used = null;
                    categoryStore.put(c);
                });
            };
        });
    }

    // 更新话术排序
    async updatePhraseSortOrder(phraseId, newSortOrder) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(phraseId);

            getRequest.onsuccess = () => {
                const phrase = getRequest.result;
                if (phrase) {
                    phrase.sort_order = newSortOrder;
                    const updateRequest = store.put(phrase);
                    updateRequest.onsuccess = () => {
                        // 🔄 标记话术已变化（触发轮转备份）
                        this._notifyPhrasesChanged();
                        resolve();
                    };
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Phrase not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 批量更新话术排序
    async batchUpdatePhraseSortOrder(updates) {
        return new Promise((resolve, reject) => {
            // 如果没有更新项，直接返回成功
            if (!updates || updates.length === 0) {
                resolve();
                return;
            }

            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');

            // ✅ 使用 transaction.oncomplete 确保事务已提交后才 resolve
            // （putRequest.onsuccess 只代表单个 put 完成，不代表事务已提交）
            transaction.oncomplete = () => {
                this._notifyPhrasesChanged();
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('事务被中止'));

            updates.forEach(update => {
                try {
                    const getRequest = store.get(update.id);
                    getRequest.onsuccess = () => {
                        const phrase = getRequest.result;
                        if (phrase) {
                            phrase.sort_order = update.sort_order;
                            store.put(phrase);
                        }
                    };
                    getRequest.onerror = () => {
                        console.warn('[排序] 跳过无效ID:', update.id);
                    };
                } catch (e) {
                    console.warn('[排序] 跳过更新项:', update.id, e);
                }
            });
        });
    }

    // ==================== 分类相关操作 ====================
    
    async batchUpdateCategorySortOrder(updates) {
        return new Promise((resolve, reject) => {
            // 如果没有更新项，直接返回成功
            if (!updates || updates.length === 0) {
                resolve();
                return;
            }
            
            const transaction = this.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            
            let completed = 0;
            const total = updates.length;
            let hasError = false;
            
            // 事务错误处理
            transaction.onerror = () => {
                if (!hasError) {
                    hasError = true;
                    reject(transaction.error);
                }
            };
            
            transaction.oncomplete = () => {
                if (!hasError) {
                    resolve();
                }
            };
            
            updates.forEach(update => {
                const getRequest = store.get(update.id);
                getRequest.onsuccess = () => {
                    const category = getRequest.result;
                    if (category) {
                        category.sort_order = update.sort_order;
                        const putRequest = store.put(category);
                        putRequest.onsuccess = () => {
                            completed++;
                            if (completed === total && !hasError) {
                                resolve();
                            }
                        };
                        putRequest.onerror = () => {
                            if (!hasError) {
                                hasError = true;
                                reject(putRequest.error);
                            }
                        };
                    } else {
                        // 如果分类不存在，也算完成一个
                        completed++;
                        if (completed === total && !hasError) {
                            resolve();
                        }
                    }
                };
                getRequest.onerror = () => {
                    if (!hasError) {
                        hasError = true;
                        reject(getRequest.error);
                    }
                };
            });
        });
    }

    async getAllCategories() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readonly');
            const store = transaction.objectStore('categories');
            const request = store.getAll();

            request.onsuccess = () => {
                const categories = (request.result || []).map(c => ({
                    ...c,
                    parent_id: (c.parent_id === undefined || c.parent_id === null) ? 0 : Number(c.parent_id),
                    enable_alias: c.enable_alias === true,
                    alias: c.alias ? String(c.alias).trim().toLowerCase() : null
                }));
                categories.sort((a, b) => a.sort_order - b.sort_order);
                resolve(categories);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async ensureRecycleCategory() {
        const RECYCLE_NAMES = ['🗑️话术回收', '话术回收', '回收站'];

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            const getRequest = store.get(1);

            getRequest.onsuccess = () => {
                const existing = getRequest.result;

                if (existing) {
                    if (!RECYCLE_NAMES.includes(existing.name)) {
                        console.log('ℹ️ 分类 ID=1 已被占用，跳过创建回收站分类');
                        resolve();
                        return;
                    }

                    const updated = {
                        ...existing,
                        name: '🗑️话术回收',
                        parent_id: 0,
                        sort_order: typeof existing.sort_order === 'number' ? Math.min(existing.sort_order, -1) : -1
                    };

                    const updateRequest = store.put(updated);
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    const recycleCategory = {
                        id: 1,
                        name: '🗑️话术回收',
                        parent_id: 0,
                        sort_order: -1
                    };
                    const addRequest = store.put(recycleCategory);
                    addRequest.onsuccess = () => resolve();
                    addRequest.onerror = () => reject(addRequest.error);
                }
            };

            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    async getCategory(categoryId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readonly');
            const store = transaction.objectStore('categories');
            const request = store.get(categoryId);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async addCategory(name, parent_id = 0, sort_order = null, show_text_editor = false, display_as_button = false, enable_alias = false, alias = null) {
        // 自动计算排序值
        if (sort_order === null || sort_order === undefined) {
            const categories = await this.getAllCategories();
            if (categories.length > 0) {
                const maxSort = Math.max(...categories.map(cat => (typeof cat.sort_order === 'number' ? cat.sort_order : -1)));
                sort_order = maxSort + 1;
            } else {
                sort_order = 0;
            }
        }

        // 🔥 手动分配ID：找到最小的可用ID（填补删除后的空缺）
        const nextId = await this.getNextCategoryId();
        const category = { 
            id: nextId, 
            name, 
            parent_id, 
            sort_order, 
            show_text_editor: show_text_editor === true,
            display_as_button: display_as_button === true,
            enable_alias: enable_alias === true,
            alias: enable_alias === true && alias ? String(alias).trim().toLowerCase() : null,
            use_count: 0,
            last_used: null
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            const request = store.add(category);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    // 🔥 获取下一个可用的分类ID（递增，永不复用）
    async getNextCategoryId() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readonly');
            const store = transaction.objectStore('categories');
            const request = store.getAll();

            request.onsuccess = () => {
                const categories = request.result;
                
                // 如果没有分类，从1开始
                if (categories.length === 0) {
                    resolve(1);
                    return;
                }
                
                // 🎯 找到最大的ID，然后+1（永不复用删除的ID）
                const maxId = Math.max(...categories.map(cat => cat.id));
                resolve(maxId + 1);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async updateCategory(id, name, parent_id = null, show_text_editor = null, display_as_button = null, enable_alias = null, alias = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            const getRequest = store.get(id);

            getRequest.onsuccess = () => {
                const category = getRequest.result;
                if (category) {
                    category.name = name;
                    if (parent_id !== null && parent_id !== undefined) {
                        category.parent_id = parent_id;
                    }
                    if (show_text_editor !== null && show_text_editor !== undefined) {
                        category.show_text_editor = show_text_editor === true;
                    }
                    if (display_as_button !== null && display_as_button !== undefined) {
                        category.display_as_button = display_as_button === true;
                    }
                    if (enable_alias !== null && enable_alias !== undefined) {
                        category.enable_alias = enable_alias === true;
                        category.alias = category.enable_alias && alias ? String(alias).trim().toLowerCase() : null;
                    }
                    
                    const updateRequest = store.put(category);
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = () => reject(updateRequest.error);
                } else {
                    reject(new Error('Category not found'));
                }
            };
            getRequest.onerror = () => reject(getRequest.error);
        });
    }

    // 获取某个父级下的直接子分类
    async getChildrenCategories(parentId) {
        const all = await this.getAllCategories();
        return all.filter(c => c.parent_id === parseInt(parentId));
    }

    async deleteCategory(id) {
        return new Promise(async (resolve, reject) => {
            try {
                // 🔥 直接删除分类，不迁移话术
                // 孤儿话术会显示为"未分类"（由 searchPhrases 第301行的 categoryMap 处理）
                const transaction = this.db.transaction(['categories'], 'readwrite');
                const store = transaction.objectStore('categories');
                const request = store.delete(id);

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    async getCategoryPhraseCount(categoryId) {
        const phrases = await this.searchPhrases('', categoryId);
        return phrases.length;
    }

    // ==================== 设置相关操作 ====================

    async getSetting(key, defaultValue = '') {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.get(key);

            request.onsuccess = () => {
                const result = request.result;
                resolve(result ? result.value : defaultValue);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async setSetting(key, value) {
        console.log(`💾 setSetting: key="${key}", value="${value}"`);
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readwrite');
            const store = transaction.objectStore('settings');
            const request = store.put({ key, value });
            
            request.onsuccess = () => {
                console.log(`✅ setSetting 成功: ${key} = ${value}`);
                resolve();
            };
            request.onerror = () => {
                console.error(`❌ setSetting 失败: ${key}`, request.error);
                reject(request.error);
            };
        });
    }

    async getAllSettings() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['settings'], 'readonly');
            const store = transaction.objectStore('settings');
            const request = store.getAll();
            
            request.onsuccess = () => {
                const settings = {};
                request.result.forEach(item => {
                    settings[item.key] = item.value;
                });
                resolve(settings);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // ==================== 初始化默认数据 ====================

    async initDefaultData() {
        // 🔧 首先初始化默认设置（无论数据是否导入，都需要设置默认值）
        const settingsInitialized = await this.getSetting('settingsInitialized');
        if (!settingsInitialized) {
            // 🔧 改进：更合理的默认值
            // - autoFocusInput 默认 false：不自动聚焦，避免干扰用户操作
            // - copyOnClick 默认 true：默认使用复制模式，更安全
            await this.setSetting('autoFocusInput', 'false');
            await this.setSetting('showNotification', 'true');
            await this.setSetting('incrementUseCount', 'true');
            await this.setSetting('copyOnClick', 'true');
            await this.setSetting('settingsInitialized', 'true');  // 标记已初始化
            console.log('✅ 默认设置已初始化（自动聚焦：关闭，点击复制：开启）');
        }
        
        // ⚡ 优化：桌面版直接跳过等待，加快启动速度
        if (typeof window !== 'undefined' && window.isDesktopApp) {
            // 桌面版：直接检查是否有分类（排除回收站），不等待 background.js
            const categories = await this.getAllCategories();
            // 排除回收站分类（ID=1或名称包含"回收"）
            const userCategories = categories.filter(c => c.id !== 1 && !c.name.includes('回收'));
            if (userCategories.length > 0) {
                console.log(`✅ 发现 ${userCategories.length} 个用户分类，跳过创建示例数据`);
                await this.setSetting('defaultDataImported', 'true');
                return;
            }
            // 📝 首次运行：创建预制示例数据
            console.log('📝 首次运行，创建预制示例数据...');
            await this._createDefaultSampleData();
            await this.setSetting('defaultDataImported', 'true');
            return;
        }
        
        // 🔥 浏览器插件版：检查是否已从 background.js 导入了默认话术
        const imported = await this.getSetting('defaultDataImported');
        if (imported === 'true') {
            console.log('✅ 默认话术已从 JSON 导入，跳过创建示例数据');
            return;
        }
        
        // 🔥 浏览器插件版：快速检查是否有分类（不等待）
        const categories = await this.getAllCategories();
        if (categories.length > 0) {
            console.log(`✅ 发现 ${categories.length} 个分类，跳过创建示例数据`);
            await this.setSetting('defaultDataImported', 'true');
            return;
        }
        
        // 🆘 如果没有分类，创建默认分类（不创建示例话术，让用户自己导入）
        console.log('📝 创建默认分类...');
        
        // 🔥 添加默认分类
        await this.addCategory('常用问候', 0, 0);
        await this.addCategory('工作沟通', 0, 1);
        await this.addCategory('客户服务', 0, 2);
        await this.addCategory('技术支持', 0, 3);
        
        // 设置标记，防止下次再创建
        await this.setSetting('defaultDataImported', 'true');
        console.log('✅ 已创建4个默认分类');
    }

    // ==================== 预制示例数据 ====================

    async _createDefaultSampleData() {
        /**
         * 首次运行时创建预制的示例数据
         * 结构：6个一级分类 → 每个包含1个二级分类 → 每个二级分类包含示例话术
         */
        try {
            console.log('📝 开始创建预制示例数据...');

            // 定义预制数据结构
            const sampleData = [
                {
                    name: '💬 日常沟通',
                    subCategories: [
                        {
                            name: '问候语',
                            phrases: [
                                '你好！很高兴认识你~',
                                '早上好！今天心情怎么样？',
                                '好久不见，最近忙什么呢？',
                                '嗨！有什么我可以帮忙的吗？'
                            ]
                        }
                    ]
                },
                {
                    name: '💼 工作办公',
                    subCategories: [
                        {
                            name: '邮件模板',
                            phrases: [
                                '您好，附件是本次会议的纪要，请查收。',
                                '感谢您的邮件，我已收到并会尽快处理。',
                                '关于这个项目，我建议我们安排一次线上会议讨论。',
                                '请确认以上信息是否正确，如有问题请随时联系我。'
                            ]
                        }
                    ]
                },
                {
                    name: '🛒 电商客服',
                    subCategories: [
                        {
                            name: '售后回复',
                            phrases: [
                                '亲，非常抱歉给您带来不好的体验，我们马上为您处理！',
                                '您好，您的包裹已经发出，预计3-5天到达，请耐心等待~',
                                '感谢您的反馈，我们会持续改进产品质量和服务！',
                                '已经为您申请退款，预计1-3个工作日到账，请注意查收。'
                            ]
                        }
                    ]
                },
                {
                    name: '📱 社交媒体',
                    subCategories: [
                        {
                            name: '朋友圈文案',
                            phrases: [
                                '生活不止眼前的苟且，还有诗和远方的田野 🌾',
                                '今日份的小确幸，记录每一个美好瞬间 ✨',
                                '努力成为更好的自己，加油！💪',
                                '周末愉快！享受属于自己的小时光 ☀️'
                            ]
                        }
                    ]
                },
                {
                    name: '🎓 学习教育',
                    subCategories: [
                        {
                            name: '学习笔记',
                            phrases: [
                                '今天的知识点已经整理完成，记得复习哦！',
                                '这个概念很重要，建议多做几道练习题巩固一下。',
                                '遇到难题不要怕，一步一步来，总能找到解决方法的。',
                                '学习是一个循序渐进的过程，保持耐心和坚持！'
                            ]
                        }
                    ]
                },
                {
                    name: '🏠 生活服务',
                    subCategories: [
                        {
                            name: '预约提醒',
                            phrases: [
                                '您好，您的预约已确认，请准时到达哦~',
                                '温馨提示：明天的预约时间是下午3点，请提前10分钟到场。',
                                '如需取消或改期，请提前24小时联系我们，谢谢理解！',
                                '感谢您的预约，期待为您服务！'
                            ]
                        }
                    ]
                }
            ];

            // 创建一级分类和二级分类
            for (let i = 0; i < sampleData.length; i++) {
                const primaryCat = sampleData[i];

                // 创建一级分类
                const primaryCatId = await this.addCategory(primaryCat.name, 0, i);
                console.log(`✅ 创建一级分类: ${primaryCat.name} (ID: ${primaryCatId})`);

                // 创建二级分类
                for (let j = 0; j < primaryCat.subCategories.length; j++) {
                    const subCat = primaryCat.subCategories[j];
                    const subCatId = await this.addCategory(subCat.name, primaryCatId, j);
                    console.log(`  ✅ 创建二级分类: ${subCat.name} (ID: ${subCatId})`);

                    // 创建话术
                    for (let k = 0; k < subCat.phrases.length; k++) {
                        const phraseContent = subCat.phrases[k];
                        await this.addPhrase(phraseContent, subCatId, '', false, false);
                        console.log(`    ✅ 创建话术: ${phraseContent.substring(0, 20)}...`);
                    }
                }
            }

            console.log('✅ 预制示例数据创建完成！');
        } catch (error) {
            console.error('❌ 创建预制示例数据失败:', error);
        }
    }

    // ==================== 清空数据 ====================

    async clearAllPhrasesAndResetCategories() {
        /**
         * 清空所有话术和分类，只保留回收站（id=1）
         * 返回：{ phrasesDeleted: number, categoriesDeleted: number }
         */
        let phrasesDeleted = 0;
        let categoriesDeleted = 0;
        
        // 1. 删除所有话术（包括已删除的）
        const allPhrases = await this.getAllPhrases();
        for (const phrase of allPhrases) {
            await this.deletePhrase(phrase.id);
            phrasesDeleted++;
        }
        
        // 2. 获取所有分类
        const allCategories = await this.getAllCategories();
        
        // 3. 删除所有分类（除了回收站 id=1）
        for (const category of allCategories) {
            if (category.id === 1) continue; // 跳过回收站
            await this.deleteCategory(category.id);
            categoriesDeleted++;
        }
        
        return {
            phrasesDeleted,
            categoriesDeleted
        };
    }

    // 🆕 整库替换用：硬删所有话术（store.clear），不产生软删孤儿
    async clearAllPhrasesPermanently() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['phrases'], 'readwrite');
            const store = tx.objectStore('phrases');
            const req = store.clear();
            tx.oncomplete = () => {
                this._phrasesCacheDirty = true;
                this._phrasesCache = null;
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            req.onerror = () => reject(req.error);
        });
    }

    // ==================== 导入导出 ====================

    async exportAllPhrases() {
        // 🆕 导出绕过缓存直接查 DB，避免缓存时序漏话术
        const allPhrases = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['phrases'], 'readonly');
            const req = tx.objectStore('phrases').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        // 补 category_name（和 searchPhrases 一致）
        const categories = await this.getAllCategories();
        const categoryMap = {};
        categories.forEach(cat => { categoryMap[cat.id] = cat.name; });
        return allPhrases.map(phrase => ({
            ...phrase,
            category_name: categoryMap[phrase.category_id] || '未分类'
        }));
    }

    async importPhrases(phrases) {
        // 获取当前最大的sort_order
        const allPhrases = await this.getAllPhrases();
        let maxSortOrder = allPhrases.length > 0 
            ? Math.max(...allPhrases.map(p => p.sort_order || 0)) 
            : -1;
        
        // 🔄 分离主话术和子话术（parent_id 不为 null）
        const mainPhrases = phrases.filter(p => !p.parent_id || p.parent_id === null);
        const variantPhrases = phrases.filter(p => p.parent_id && p.parent_id !== null);
        
        // 🔄 建立话术ID映射（旧ID -> 新ID）
        const phraseIdMap = new Map();
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['phrases'], 'readwrite');
            const store = tx.objectStore('phrases');
            let mainCompletedCount = 0;
            const mainCount = mainPhrases.length;
            let variantCompletedCount = 0;
            const variantCount = variantPhrases.length;
            const totalCount = phrases.length;
            
            // 🔧 修复：等事务真正提交(oncomplete)后再 resolve，避免 loadPhrases 读到未提交数据
            let _resolved = false;
            const _finish = () => {
                if (_resolved) return;
                _resolved = true;
                let _done = false;
                const _r = () => { if (!_done) { _done = true; this._phrasesCacheDirty = true; this._phrasesCache = null; resolve(phraseIdMap); } };
                try { tx.addEventListener('complete', _r); } catch (e) { _r(); }
                setTimeout(_r, 300); // 兜底：事务已结束时 oncomplete 不触发
            };
            
            // 先导入主话术
            if (mainPhrases.length === 0) {
                // 如果没有主话术，直接导入变形话术（这种情况不应该发生，但为了安全）
                importVariants();
            } else {
                for (const phrase of mainPhrases) {
                    const importedIsDeleted = phrase.is_deleted === true;
                    const phraseToAdd = {
                        content: phrase.content,
                        content_html: phrase.content_html || null,  // 🎨 HTML内容（包含部分样式）
                        category_id: phrase.category_id || 0,  // 默认为0（孤儿数据），会显示为"未分类"
                        tags: phrase.tags || '',
                        use_count: phrase.use_count || 0,
                        sort_order: (typeof phrase.sort_order === 'number') ? phrase.sort_order : (++maxSortOrder),  // 优先保留原排序，否则递增
                        created_time: phrase.created_time || new Date().toISOString(),
                        last_used: phrase.last_used || null,
                        // 🖼️ 图片相关字段
                        images: phrase.images || [],
                        // 🔧 修复：默认不启用图片功能，只有当原数据明确设置为 true 时才启用
                        enable_images: phrase.enable_images === true ? true : false,
                        // 📝 占位符相关字段
                        has_placeholders: phrase.has_placeholders || false,
                        placeholder_names: phrase.placeholder_names || [],
                        enable_placeholder: phrase.enable_placeholder || false,
                        // 🎨 样式相关字段
                        text_color: phrase.text_color || null,
                        bg_color: phrase.bg_color || null,
                        is_bold: phrase.is_bold || false,
                        disable_click_copy: phrase.disable_click_copy === true ? true : false,
                        // 🗑️ 回收站/删除状态
                        is_deleted: importedIsDeleted,
                        deleted_time: importedIsDeleted ? (phrase.deleted_time || new Date().toISOString()) : undefined,
                        // 📋 使用说明相关字段
                        enable_description: phrase.enable_description === true ? true : false,
                        description: phrase.description || '',
                        // 🔄 变形话术相关字段
                        enable_variants: phrase.enable_variants === true ? true : false,
                            parent_id: null,  // 主话术的 parent_id 为 null
                            // 🔗 跳转相关字段
                            jump_category_id: phrase.jump_category_id === undefined ? null : phrase.jump_category_id,
                            // 标题卡片相关字段
                            is_title: phrase.is_title === true,
                            title_text: phrase.title_text || null,
                            title_id: phrase.title_id === undefined ? null : phrase.title_id,
                            is_collapsed: phrase.is_collapsed === true,
                            show_text_editor: phrase.show_text_editor === true
                    };
                    
                    const request = store.add(phraseToAdd);
                    request.onsuccess = () => {
                        // 建立ID映射（如果有旧ID的话）
                        if (phrase.id) {
                            phraseIdMap.set(phrase.id, request.result);
                            console.log(`✅ 主话术ID映射: ${phrase.id} -> ${request.result}`);
                        }
                        mainCompletedCount++;
                        // 🔄 所有主话术导入完成后，再导入变形话术
                        if (mainCompletedCount === mainCount) {
                            console.log(`✅ 所有主话术导入完成，开始导入变形话术...`);
                            importVariants();
                        }
                    };
                    request.onerror = () => {
                        console.error(`❌ 导入主话术失败:`, phrase.content.substring(0, 30));
                        mainCompletedCount++;
                        if (mainCompletedCount === mainCount) {
                            importVariants();
                        }
                    };
                }
            }
            
            // 导入变形话术的函数（在所有主话术导入完成后调用）
            function importVariants() {
                if (variantPhrases.length === 0) {
                    console.log('✅ 没有变形话术需要导入');
                    // 在所有话术导入完成后，修正 title_id 映射（旧ID -> 新ID），确保标题引用正确
                    finalizeImport();
                    return;
                }
                
                console.log(`🔄 开始导入 ${variantPhrases.length} 条变形话术...`);
                
                // 然后导入变形话术（需要映射 parent_id）
                for (const phrase of variantPhrases) {
                    const newParentId = phraseIdMap.get(phrase.parent_id);
                    if (!newParentId) {
                        console.warn(`⚠️ 变形话术的父话术ID ${phrase.parent_id} 未找到，跳过该变形话术: ${phrase.content.substring(0, 30)}...`);
                        variantCompletedCount++;
                        if (variantCompletedCount === variantCount) {
                            console.log('✅ 所有变形话术处理完成');
                            _finish();
                        }
                        continue;
                    }

                    const importedIsDeleted = phrase.is_deleted === true;
                    const importedChildOrder = (typeof phrase.sort_order === 'number') ? phrase.sort_order : null;
                    
                    const phraseToAdd = {
                        content: phrase.content,
                        content_html: phrase.content_html || null,
                        category_id: phrase.category_id || 0,
                        tags: phrase.tags || '',
                        use_count: phrase.use_count || 0,
                        // 子话术：优先保留原 sort_order（用于父内排序）；否则回退为全局递增
                        sort_order: importedChildOrder !== null ? importedChildOrder : (++maxSortOrder),
                        created_time: phrase.created_time || new Date().toISOString(),
                        last_used: phrase.last_used || null,
                        images: phrase.images || [],
                        enable_images: phrase.enable_images === true ? true : false,
                        has_placeholders: phrase.has_placeholders || false,
                        placeholder_names: phrase.placeholder_names || [],
                        enable_placeholder: phrase.enable_placeholder || false,
                        text_color: phrase.text_color || null,
                        bg_color: phrase.bg_color || null,
                        is_bold: phrase.is_bold || false,
                        disable_click_copy: phrase.disable_click_copy === true ? true : false,
                        is_deleted: importedIsDeleted,
                        deleted_time: importedIsDeleted ? (phrase.deleted_time || new Date().toISOString()) : undefined,
                        enable_description: phrase.enable_description === true ? true : false,
                        description: phrase.description || '',
                        // 🔄 变形话术相关字段
                        enable_variants: false,  // 变形话术本身不启用变形功能
                                parent_id: newParentId,  // 映射到新的父话术ID
                                jump_category_id: phrase.jump_category_id === undefined ? null : phrase.jump_category_id,
                                // 标题卡片相关字段（变形话术理论上不会是标题，这里仅做兼容）
                                is_title: phrase.is_title === true,
                                title_text: phrase.title_text || null,
                                title_id: phrase.title_id === undefined ? null : phrase.title_id,
                                is_collapsed: phrase.is_collapsed === true,
                                show_text_editor: phrase.show_text_editor === true
                    };
                    
                    const request = store.add(phraseToAdd);
                    request.onsuccess = () => {
                        if (phrase.id) {
                            phraseIdMap.set(phrase.id, request.result);
                            console.log(`✅ 变形话术ID映射: ${phrase.id} -> ${request.result}, parent_id: ${newParentId}`);
                        }
                        variantCompletedCount++;
                        if (variantCompletedCount === variantCount) {
                            console.log('✅ 所有变形话术导入完成');
                            // 在所有话术导入完成后，修正 title_id 映射（旧ID -> 新ID），确保标题引用正确
                            finalizeImport();
                        }
                    };
                    request.onerror = () => {
                        console.error(`❌ 导入变形话术失败:`, phrase.content.substring(0, 30));
                        variantCompletedCount++;
                        if (variantCompletedCount === variantCount) {
                            _finish();
                        }
                    };
                }
            }
            
            // 将所有话术条目的 title_id（如果存在旧ID）映射为新ID，确保导入后标题与内容的引用关系正确
            function finalizeImport() {
                try {
                    const tx2 = this.db.transaction(['phrases'], 'readwrite');
                    const store2 = tx2.objectStore('phrases');
                    const getAllReq = store2.getAll();
                    getAllReq.onsuccess = () => {
                        const allPhrases = getAllReq.result || [];
                        let pendingUpdates = 0;

                        allPhrases.forEach(p => {
                            if (p && p.title_id !== undefined && p.title_id !== null) {
                                const oldTitleId = p.title_id;
                                const mapped = phraseIdMap.get(oldTitleId);
                                if (mapped && mapped !== oldTitleId) {
                                    p.title_id = mapped;
                                    pendingUpdates++;
                                    const putReq = store2.put(p);
                                    putReq.onsuccess = () => {
                                        pendingUpdates--;
                                        if (pendingUpdates === 0) {
                                            console.log('✅ title_id 映射修正完成');
                                            _finish();
                                        }
                                    };
                                    putReq.onerror = () => {
                                        console.warn('⚠️ 更新 title_id 时出错，继续完成导入');
                                        pendingUpdates--;
                                        if (pendingUpdates === 0) _finish();
                                    };
                                }
                            }
                        });

                        // 如果没有需要更新的条目，直接 resolve
                        if (pendingUpdates === 0) {
                            console.log('ℹ️ 无需修正 title_id');
                            _finish();
                        }
                    };
                    getAllReq.onerror = () => {
                        console.warn('⚠️ 读取所有话术以修正 title_id 失败，跳过修正');
                        _finish();
                    };
                } catch (e) {
                    console.error('⚠️ finalizeImport 异常，跳过 title_id 修正:', e);
                    _finish();
                }
            }
            
            // 如果没有话术，直接resolve
            if (totalCount === 0) {
                _finish();
            }
        });
    }

    // 🔧 去重功能：删除每个分类内重复的话术（保留第一条）
    async removeDuplicatePhrases() {
        const allPhrases = await this.getAllPhrases();
        
        // 按分类分组
        const phrasesByCategory = new Map();
        allPhrases.forEach(phrase => {
            const catId = phrase.category_id;
            if (!phrasesByCategory.has(catId)) {
                phrasesByCategory.set(catId, []);
            }
            phrasesByCategory.get(catId).push(phrase);
        });

        const duplicateIds = [];
        
        // 在每个分类内查找重复
        phrasesByCategory.forEach((phrases, categoryId) => {
            const contentMap = new Map(); // content -> 第一个phrase的ID
            
            phrases.forEach(phrase => {
                const content = phrase.content.trim();
                if (contentMap.has(content)) {
                    // 在同一分类内发现重复，记录要删除的ID
                    duplicateIds.push(phrase.id);
                } else {
                    // 第一次出现，记录
                    contentMap.set(content, phrase.id);
                }
            });
        });

        if (duplicateIds.length === 0) {
            return { removed: 0, total: allPhrases.length };
        }

        // 删除重复的话术
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['phrases'], 'readwrite');
            const store = tx.objectStore('phrases');

            duplicateIds.forEach(id => {
                store.delete(id);
            });

            tx.oncomplete = () => {
                resolve({ 
                    removed: duplicateIds.length, 
                    total: allPhrases.length,
                    remaining: allPhrases.length - duplicateIds.length
                });
            };
            tx.onerror = () => reject(tx.error);
        });
    }
    // ==================== 变形话术管理 ====================
    
    // 获取指定话术的所有变形
    async getVariantsByParentId(parentId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readonly');
            const store = transaction.objectStore('phrases');
            const index = store.index('parent_id');
            const request = index.getAll(parentId);
            
            request.onsuccess = () => {
                const variants = request.result || [];
                // 按sort_order排序
                variants.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
                resolve(variants);
            };
            request.onerror = () => reject(request.error);
        });
    }
    
    // 添加变形话术
    async addVariant(parentId, content) {
        // 确保 parentId 是数字
        const numericParentId = typeof parentId === 'string' ? parseInt(parentId) : parentId;
        console.log('🔍 addVariant - parentId:', parentId, '转换后:', numericParentId);
        
        const parent = await this.getPhrase(numericParentId);
        console.log('🔍 查询到的父话术:', parent);
        
        if (!parent) {
            throw new Error('父话术不存在');
        }
        
        const variants = await this.getVariantsByParentId(numericParentId);
        const maxSortOrder = variants.length > 0 
            ? Math.max(...variants.map(v => v.sort_order || 0))
            : -1;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            
            const variant = {
                content: content,
                category_id: parent.category_id,
                tags: parent.tags || [],
                use_count: 0,
                sort_order: maxSortOrder + 1,
                parent_id: numericParentId,
                enable_variants: false,
                has_placeholders: false,
                placeholder_names: [],
                images: [],
                enable_placeholder: false,
                enable_images: false,
                enable_description: false,
                description: ''
            };
            
            const addRequest = store.add(variant);
            
            addRequest.onsuccess = () => {
                variant.id = addRequest.result;
                resolve(variant);
            };
            addRequest.onerror = () => reject(addRequest.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }
    
    // 删除变形话术
    async deleteVariant(variantId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const deleteRequest = store.delete(variantId);
            
            deleteRequest.onsuccess = () => resolve();
            deleteRequest.onerror = () => reject(deleteRequest.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }
    
    // 更新变形话术内容
    async updateVariantContent(variantId, newContent) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['phrases'], 'readwrite');
            const store = transaction.objectStore('phrases');
            const getRequest = store.get(variantId);
            
            getRequest.onsuccess = () => {
                const variant = getRequest.result;
                if (!variant) {
                    reject(new Error('变形话术不存在'));
                    return;
                }
                
                variant.content = newContent;
                const updateRequest = store.put(variant);
                
                updateRequest.onsuccess = () => resolve(variant);
                updateRequest.onerror = () => reject(updateRequest.error);
            };
            getRequest.onerror = () => reject(getRequest.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }
}

// 创建全局数据库实例
const db = new PhraseDatabase();

// 将数据库实例暴露到全局 window 对象，供其他脚本使用
window.db = db;
console.log('✅ 数据库实例已暴露到 window.db');
