# -*- mode: python ; coding: utf-8 -*-
# 卓雅话术助手 PyInstaller 打包配置

import os

block_cipher = None

# 项目根目录
base_dir = os.path.abspath('.')

a = Analysis(
    ['main.py'],
    pathex=[base_dir],
    binaries=[],
    datas=[
        # HTML 文件
        (os.path.join(base_dir, 'index.html'), '.'),
        (os.path.join(base_dir, 'styles.css'), '.'),
        (os.path.join(base_dir, 'app.js'), '.'),
        (os.path.join(base_dir, 'db.js'), '.'),
        (os.path.join(base_dir, 'text-editor.html'), '.'),
        (os.path.join(base_dir, 'calculator-dialog.html'), '.'),
        (os.path.join(base_dir, 'announcement-dialog.html'), '.'),
        (os.path.join(base_dir, 'placeholder-dialog.html'), '.'),
        (os.path.join(base_dir, 'variant-dialog.html'), '.'),
        # Python 模块
        (os.path.join(base_dir, 'calculator.py'), '.'),
        # 图标目录
        (os.path.join(base_dir, 'icons', 'icon.svg'), 'icons'),
        (os.path.join(base_dir, 'icons', 'icon16.png'), 'icons'),
        (os.path.join(base_dir, 'icons', 'icon48.png'), 'icons'),
        (os.path.join(base_dir, 'icons', 'icon128.png'), 'icons'),
    ],
    hiddenimports=['calculator'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='卓雅客服助手',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,  # 不显示控制台窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(base_dir, 'icons', 'icon.ico'),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='卓雅客服助手',
)
