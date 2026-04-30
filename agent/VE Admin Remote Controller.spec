# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['installer_gui.py'],
    pathex=[],
    binaries=[],
    datas=[('icon.ico', '.'), ('virtual_eye_logo.png', '.'), ('install.ps1', '.'), ('agent.js', '.'), ('package.json', '.'), ('package-lock.json', '.'), ('node_modules', 'node_modules'), ('logo02.png', '.'), ('uninstall.ps1', '.'), ('start-agent.cmd', '.'), ('start-agent-hidden.vbs', '.'), ('HOW-TO-USE.txt', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='VE Admin Remote Controller',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['icon.ico'],
)
