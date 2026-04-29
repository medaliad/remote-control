#!/usr/bin/env python3
"""
VE Admin Remote Controller - one-click installer (Tkinter GUI).

What is new in this version (v3):
  * Pairing-code flow. The installer shows an 8-character code on launch
    and polls the signaling server. The admin opens a small browser page,
    types the same code plus the username this PC should register as,
    and clicks Send. The server relays the username back to this
    installer, which then auto-fills the field, persists the username to
    HKCU\\Software\\VEAdminAgent\\Username and config.json, and re-runs
    install.ps1. If the agent was already installed under a different
    username the scheduled task is replaced and re-registered.

The user can still type a username manually instead of waiting for the
browser hand-off.

Buttons:
  * Install   - runs the install.ps1 flow with the current Username.
  * Stop      - stops the VEAdminAgent scheduled task and frees port 8766.
  * Uninstall - runs uninstall.ps1.

Build to a .exe:  build_exe.bat
"""

import os
import json
import platform
import queue
import secrets
import shutil
import string
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from pathlib import Path
from tkinter import messagebox, scrolledtext, ttk

# --------------------------------------------------------------------------- #
# Distribution constants
# --------------------------------------------------------------------------- #

APP_TITLE       = "VE Admin Remote Controller"
TASK_NAME       = "VEAdminAgent"
INSTALL_FOLDER  = "VEAdminAgent"
AGENT_PORT      = 8766
SERVER_URL      = "https://remote-control-cdqo.onrender.com"
ALLOWED_ORIGIN  = SERVER_URL
LEGACY_SHORTCUT = r"Microsoft\Windows\Start Menu\Programs\Startup\Remote Control Agent.lnk"
PROVISION_POLL_SEC  = 3
PROVISION_TIMEOUT_SEC = 15 * 60
REGISTRY_KEY = r"Software\VEAdminAgent"

DESCRIPTION = (
    "VE Admin Remote Controller\n\n"
    "Type the username this PC should register as and click Install, OR\n"
    "open the VE Admin browser provisioning page, type the pairing code\n"
    "shown below, and the username will arrive automatically."
)

IS_WIN = sys.platform.startswith("win")
NO_WIN = 0x08000000 if IS_WIN else 0


# --------------------------------------------------------------------------- #
# Resource locator (handles dev mode + PyInstaller _MEIPASS)
# --------------------------------------------------------------------------- #

def resource_dir():
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return Path(base)
    return Path(__file__).resolve().parent


def find_icon():
    for p in [resource_dir() / "icon.ico", Path.cwd() / "icon.ico"]:
        try:
            if p.exists():
                return p
        except Exception:
            pass
    return None


# --------------------------------------------------------------------------- #
# Paths + helpers
# --------------------------------------------------------------------------- #

def have(exe):
    return shutil.which(exe) is not None


def install_dir():
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    return base / INSTALL_FOLDER


def windows_username():
    return os.environ.get("USERNAME") or os.environ.get("USER") or ""


def saved_username_from_config():
    cfg = install_dir() / "config.json"
    if not cfg.exists():
        return ""
    try:
        return str(json.loads(cfg.read_text(encoding="utf-8-sig")).get("autopairUser") or "")
    except Exception:
        return ""


def saved_username_from_registry():
    if not IS_WIN:
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as k:
            v, _ = winreg.QueryValueEx(k, "Username")
            return str(v or "")
    except Exception:
        return ""


def write_username_registry(name):
    if not IS_WIN:
        return
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as k:
            winreg.SetValueEx(k, "Username", 0, winreg.REG_SZ, name)
    except Exception:
        pass


def gen_pairing_code():
    # 8 chars from a no-look-alike alphabet - admin will type this in.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


# --------------------------------------------------------------------------- #
# GUI app
# --------------------------------------------------------------------------- #

class InstallerApp:
    def __init__(self, root):
        self.root = root
        self.log_queue = queue.Queue()
        self.worker = None
        self.pair_code = gen_pairing_code()
        self.pair_thread = None
        self.pair_stop = threading.Event()
        self.pair_received_user = None  # set by polling thread

        root.title(APP_TITLE)
        root.geometry("760x620")
        root.minsize(640, 480)

        ico = find_icon()
        if ico is not None:
            try:
                root.iconbitmap(default=str(ico))
            except Exception:
                pass

        # ---- Description ----
        tk.Label(
            root, text=DESCRIPTION, justify="left", anchor="w",
            wraplength=720, padx=12, pady=10,
        ).pack(fill="x")

        # ---- Pairing code panel ----
        pair = tk.Frame(root, padx=12, pady=8, bg="#0c2a4a")
        pair.pack(fill="x", padx=12)
        tk.Label(
            pair, text="Pairing code (type this in the browser provisioning page):",
            bg="#0c2a4a", fg="#cfe6ff", anchor="w",
        ).pack(anchor="w")
        self.pair_var = tk.StringVar(value=self._formatted_code())
        tk.Label(
            pair, textvariable=self.pair_var, bg="#0c2a4a", fg="#ffffff",
            font=("Consolas" if IS_WIN else "Menlo", 22, "bold"),
            anchor="w",
        ).pack(anchor="w", pady=(2, 4))
        self.pair_status = tk.StringVar(value="Waiting for browser...")
        tk.Label(
            pair, textvariable=self.pair_status,
            bg="#0c2a4a", fg="#9ec5ee", anchor="w",
        ).pack(anchor="w")

        # ---- Username row ----
        urow = tk.Frame(root)
        urow.pack(fill="x", padx=12, pady=(8, 6))
        tk.Label(urow, text="Username:", width=10, anchor="w").pack(side="left")
        initial_user = (
            saved_username_from_registry()
            or saved_username_from_config()
            or windows_username()
        )
        self.user_var = tk.StringVar(value=initial_user)
        self.user_entry = ttk.Entry(urow, textvariable=self.user_var)
        self.user_entry.pack(side="left", fill="x", expand=True)

        # ---- Buttons ----
        bar = tk.Frame(root)
        bar.pack(fill="x", padx=12)
        self.btn_install = ttk.Button(bar, text="Install", command=self.on_install)
        self.btn_install.pack(side="left")
        self.btn_stop = ttk.Button(
            bar, text="Stop", command=self.on_stop, state="disabled"
        )
        self.btn_stop.pack(side="left", padx=6)
        self.btn_uninstall = ttk.Button(
            bar, text="Uninstall", command=self.on_uninstall
        )
        self.btn_uninstall.pack(side="right")

        # ---- Log ----
        self.log_widget = scrolledtext.ScrolledText(
            root, height=16, wrap="word", state="disabled",
            bg="#111", fg="#ddd", insertbackground="#ddd",
            font=("Consolas" if IS_WIN else "Menlo", 10),
        )
        self.log_widget.pack(fill="both", expand=True, padx=12, pady=10)

        # ---- Status bar ----
        self.status = tk.StringVar(value="Idle.")
        tk.Label(
            root, textvariable=self.status, anchor="w", relief="sunken",
        ).pack(fill="x", side="bottom")

        self.root.after(100, self._drain_log)
        self._refresh_buttons()

        # Fire off the pairing-code claim + polling loop in the background.
        self._start_pairing()

    def _formatted_code(self):
        # Insert a hyphen for readability: ABCD-2345
        c = self.pair_code
        return f"{c[:4]}-{c[4:]}"

    # ------- log plumbing -------

    def log(self, msg):
        self.log_queue.put(msg)

    def _drain_log(self):
        try:
            while True:
                line = self.log_queue.get_nowait()
                self.log_widget.configure(state="normal")
                self.log_widget.insert("end", line + "\n")
                self.log_widget.see("end")
                self.log_widget.configure(state="disabled")
        except queue.Empty:
            pass
        self.root.after(100, self._drain_log)

    def _run_stream(self, cmd, cwd=None, shell=False):
        if isinstance(cmd, (list, tuple)):
            self.log("$ " + " ".join(str(c) for c in cmd))
        else:
            self.log("$ " + str(cmd))
        proc = subprocess.Popen(
            cmd, cwd=cwd, shell=shell,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            creationflags=NO_WIN,
        )
        for line in proc.stdout:
            self.log(line.rstrip())
        proc.wait()
        return proc.returncode

    def _run_powershell(self, ps_args):
        return self._run_stream(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass"] + ps_args
        )

    # ------- pairing-code flow (HTTP polling) -------

    def _start_pairing(self):
        self.pair_thread = threading.Thread(target=self._pair_worker, daemon=True)
        self.pair_thread.start()

    def _pair_worker(self):
        # 1) claim the code with the server
        try:
            self._http_post(
                f"{SERVER_URL}/api/provision/claim",
                {"code": self.pair_code},
            )
            self.log(f"[pair] claimed code {self._formatted_code()} on server")
        except Exception as e:
            self.log(f"[pair] could not claim code on server: {e}")
            self.root.after(0, lambda: self.pair_status.set(
                "Server unreachable - manual mode only."
            ))
            return

        # 2) poll until either a username arrives or we time out
        deadline = time.time() + PROVISION_TIMEOUT_SEC
        while not self.pair_stop.is_set() and time.time() < deadline:
            try:
                resp = self._http_get(
                    f"{SERVER_URL}/api/provision/poll?code={self.pair_code}"
                )
                user = (resp or {}).get("username")
                if user:
                    self.root.after(0, self._on_pair_received, str(user))
                    return
            except Exception as e:
                # Don't spam the log on transient errors
                pass
            self.pair_stop.wait(PROVISION_POLL_SEC)

        if not self.pair_stop.is_set():
            self.root.after(0, lambda: self.pair_status.set(
                "Pairing code expired - type the username manually."
            ))

    def _on_pair_received(self, username):
        self.log(f"[pair] received username '{username}' from browser")
        self.pair_status.set(f"Received from browser: {username}")
        # Replace the field even if the user typed something else - the
        # browser is authoritative.
        self.user_var.set(username)
        # Persist immediately so even if install fails, future launches
        # remember the assignment.
        write_username_registry(username)
        # Replace and re-register: kick off install automatically.
        if self.worker is None or not self.worker.is_alive():
            self.on_install()

    def _http_get(self, url):
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read().decode("utf-8")
            return json.loads(data) if data else {}

    def _http_post(self, url, body):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            txt = r.read().decode("utf-8")
            return json.loads(txt) if txt else {}

    # ------- button handlers -------

    def on_install(self):
        if self.worker and self.worker.is_alive():
            return
        user = self.user_var.get().strip()
        if not user:
            messagebox.showwarning(
                APP_TITLE,
                "Please enter the username this PC should register as,\n"
                "or wait for it to arrive from the browser.",
            )
            return
        self.btn_install.configure(state="disabled")
        self.btn_uninstall.configure(state="disabled")
        self.user_entry.configure(state="disabled")
        self.status.set("Installing...")
        self.worker = threading.Thread(
            target=self._do_install, args=(user,), daemon=True,
        )
        self.worker.start()

    def on_stop(self):
        self.status.set("Stopping agent...")
        self.worker = threading.Thread(target=self._do_stop, daemon=True)
        self.worker.start()

    def on_uninstall(self):
        if not messagebox.askyesno(
            APP_TITLE,
            "Stop the agent, remove the auto-start task, and delete\n"
            f"{install_dir()} ?",
        ):
            return
        self.btn_install.configure(state="disabled")
        self.btn_uninstall.configure(state="disabled")
        self.status.set("Uninstalling...")
        self.worker = threading.Thread(target=self._do_uninstall, daemon=True)
        self.worker.start()

    # ------- background work -------

    def _do_install(self, username):
        try:
            if not IS_WIN:
                raise RuntimeError("Installs on Windows only.")
            self.log(f"[info] target user  : {username}")
            self.log(f"[info] install dir  : {install_dir()}")

            # Persist the username early - even if install fails, future
            # launches still know who this PC belongs to.
            write_username_registry(username)

            # If we are switching usernames, the old scheduled task and the
            # old agent on port 8766 will be killed during pre-flight.
            self._preflight_cleanup()
            self._ensure_node()
            self._run_install_ps1(username)

            self.log("[done] install complete - agent is running and will "
                     "auto-start on every login.")
            self.status.set("Agent installed and running.")
            self.pair_status.set(f"Registered as: {username}")
        except Exception as e:
            self.log(f"[error] {e}")
            self.status.set("Failed. See log.")
            messagebox.showerror(APP_TITLE, str(e))
        finally:
            self.root.after(0, self._refresh_buttons)
            self.root.after(0, lambda: self.user_entry.configure(state="normal"))

    def _do_stop(self):
        try:
            self.log("[..] stopping VEAdminAgent scheduled task...")
            self._run_powershell([
                "-Command",
                f"try {{ Stop-ScheduledTask -TaskName '{TASK_NAME}' "
                f"-ErrorAction Stop; Write-Host 'task stopped' }} "
                f"catch {{ Write-Host '       (task was not running)' }}",
            ])
            self._kill_port(AGENT_PORT)
            self.status.set("Agent stopped.")
        except Exception as e:
            self.log(f"[error] {e}")
            self.status.set("Stop failed. See log.")
        finally:
            self.root.after(0, self._refresh_buttons)

    def _do_uninstall(self):
        try:
            ps1 = resource_dir() / "uninstall.ps1"
            if ps1.exists():
                self.log("[..] running uninstall.ps1 ...")
                rc = self._run_powershell(["-File", str(ps1)])
                if rc != 0:
                    raise RuntimeError(f"uninstall.ps1 exited with code {rc}")
            else:
                self._run_powershell([
                    "-Command",
                    f"try {{ Stop-ScheduledTask -TaskName '{TASK_NAME}' "
                    f"-ErrorAction SilentlyContinue }} catch {{}}; "
                    f"try {{ Unregister-ScheduledTask -TaskName '{TASK_NAME}' "
                    f"-Confirm:$false -ErrorAction SilentlyContinue }} catch {{}}",
                ])
                self._kill_port(AGENT_PORT)
                d = install_dir()
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)
                    self.log(f"[ok] removed {d}")
            self.log("[done] uninstalled.")
            self.status.set("Uninstalled.")
        except Exception as e:
            self.log(f"[error] {e}")
            self.status.set("Uninstall failed. See log.")
        finally:
            self.root.after(0, self._refresh_buttons)
            self.root.after(0, lambda: self.user_entry.configure(state="normal"))

    # ------- install steps -------

    def _preflight_cleanup(self):
        self.log("[1/3] pre-flight cleanup...")
        self._kill_port(AGENT_PORT)
        self._run_powershell([
            "-Command",
            f"try {{ Stop-ScheduledTask -TaskName '{TASK_NAME}' "
            f"-ErrorAction SilentlyContinue }} catch {{}}",
        ])
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            legacy = Path(appdata) / LEGACY_SHORTCUT
            if legacy.exists():
                try:
                    legacy.unlink()
                    self.log(f"       removed legacy shortcut: {legacy}")
                except Exception as e:
                    self.log(f"       (could not remove legacy shortcut: {e})")

    def _kill_port(self, port):
        self._run_powershell([
            "-Command",
            f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen "
            f"-ErrorAction SilentlyContinue; "
            f"if ($c) {{ foreach ($x in $c) {{ "
            f"  try {{ Stop-Process -Id $x.OwningProcess -Force "
            f"        -ErrorAction Stop; "
            f"        Write-Host \"       killed PID $($x.OwningProcess) on {port}\" }} "
            f"  catch {{ Write-Host \"       could not kill PID $($x.OwningProcess)\" }} "
            f"}} }} else {{ Write-Host '       no process on port {port}' }}",
        ])

    def _ensure_node(self):
        self.log("[2/3] checking Node.js...")
        ok = False
        try:
            r = subprocess.run(
                ["node", "--version"], capture_output=True, text=True,
                creationflags=NO_WIN,
            )
            if r.returncode == 0:
                ver = r.stdout.strip()
                self.log(f"       found {ver}")
                if ver.startswith("v"):
                    try:
                        major = int(ver.lstrip("v").split(".")[0])
                        ok = major >= 20
                        if not ok:
                            self.log("       too old; need v20+")
                    except Exception:
                        ok = False
        except FileNotFoundError:
            pass

        if ok:
            return

        if not have("winget"):
            raise RuntimeError(
                "Node.js v20+ not found and winget is not available.\n"
                "Please install Node.js LTS from https://nodejs.org "
                "and run this installer again."
            )
        self.log("       installing Node.js LTS via winget "
                 "(click Yes if Windows asks for permission)...")
        self._run_stream([
            "winget", "install", "--id", "OpenJS.NodeJS.LTS",
            "--silent",
            "--accept-package-agreements", "--accept-source-agreements",
        ])
        self._refresh_path_from_registry()
        if not have("node"):
            raise RuntimeError(
                "Node.js install via winget did not make node.exe "
                "visible. Please reboot and try again, or install "
                "Node.js LTS manually from https://nodejs.org."
            )

    def _refresh_path_from_registry(self):
        try:
            import winreg
        except ImportError:
            return
        parts = []
        for hive, sub in [
            (winreg.HKEY_LOCAL_MACHINE,
             r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
            (winreg.HKEY_CURRENT_USER, r"Environment"),
        ]:
            try:
                with winreg.OpenKey(hive, sub) as k:
                    val, _ = winreg.QueryValueEx(k, "Path")
                    if val:
                        parts.append(val)
            except OSError:
                pass
        if parts:
            os.environ["PATH"] = ";".join(parts)
            self.log("       refreshed PATH from registry")

    def _run_install_ps1(self, username):
        self.log("[3/3] running install.ps1 ...")
        ps1 = resource_dir() / "install.ps1"
        if not ps1.exists():
            raise RuntimeError(
                f"install.ps1 not found at {ps1}. "
                "The .exe may have been built without bundling agent files."
            )
        rc = self._run_powershell([
            "-File", str(ps1),
            "-ServerUrl", SERVER_URL,
            "-Username", username,
            "-AllowedOrigin", ALLOWED_ORIGIN,
            "-NonInteractive",
        ])
        if rc != 0:
            raise RuntimeError(f"install.ps1 exited with code {rc}")

    # ------- button state -------

    def _refresh_buttons(self):
        running = False
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"(Get-ScheduledTask -TaskName '{TASK_NAME}' "
                 f"-ErrorAction SilentlyContinue).State"],
                capture_output=True, text=True, creationflags=NO_WIN,
            )
            running = "Running" in (r.stdout or "")
        except Exception:
            pass
        self.btn_install.configure(state="disabled" if running else "normal")
        self.btn_stop.configure(state="normal" if running else "disabled")
        self.btn_uninstall.configure(state="normal")


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #

def main():
    root = tk.Tk()
    try:
        if IS_WIN:
            ttk.Style().theme_use("vista")
    except tk.TclError:
        pass
    app = InstallerApp(root)

    def on_close():
        app.pair_stop.set()
        root.destroy()
    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


if __name__ == "__main__":
    main()
