"""
VE Admin Remote Controller - one-click installer (Tkinter GUI), v5.

Flow:
  1. Asks for a username (pre-filled with the OS user or last saved value).
  2. Pre-cleans port 8766 + any old VEAdminAgent task.
  3. Installs Node.js LTS via winget if missing.
  4. Calls install.ps1 to copy files, run npm install, and register the
     scheduled task.
  5. Writes config.json directly with autopairUrl/autopairUser - belt and
     braces in case install.ps1 silently dropped a value - and verifies
     the file before declaring success.
  6. Saves the username to HKCU\\Software\\VEAdminAgent\\Username so the
     next run pre-fills it.

Mirrors the manual flow that's known to work:
    $env:AUTOPAIR_URL  = "https://remote-control-cdqo.onrender.com"
    $env:AUTOPAIR_USER = "dali"
    npm install
    npm start

Build: build_exe.bat
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, scrolledtext, ttk

APP_TITLE        = "VE Admin Remote Controller"
TASK_NAME        = "VEAdminAgent"
INSTALL_FOLDER   = "VEAdminAgent"
AGENT_PORT       = 8766
DEFAULT_URL      = "https://remote-control-cdqo.onrender.com"
LEGACY_SHORTCUT  = r"Microsoft\Windows\Start Menu\Programs\Startup\Remote Control Agent.lnk"
REGISTRY_KEY     = r"Software\VEAdminAgent"


BRAND_PRIMARY_DARK = "#013059"
BRAND_ACCENT       = "#008BF9"
BRAND_BLUE         = "#209BD7"
BRAND_BLUE_LIGHT   = "#09BCFF"
BG_CANVAS          = "#F8FAFC"
SURFACE            = "#FFFFFF"
TEXT_900           = "#0F172A"
TEXT_700           = "#334155"
TEXT_500           = "#64748B"
TEXT_400           = "#94A3B8"
LINE               = "#E2E8F0"


STATE_STYLES = {
    "idle":     {"dot": "#94A3B8", "bg": "#F1F5F9", "fg": "#475569", "label": "Idle"},
    "working":  {"dot": "#F59E0B", "bg": "#FEF3C7", "fg": "#92400E", "label": "Working..."},
    "running":  {"dot": "#10B981", "bg": "#D1FAE5", "fg": "#065F46", "label": "Running"},
    "stopped":  {"dot": "#94A3B8", "bg": "#F1F5F9", "fg": "#475569", "label": "Stopped"},
    "failed":   {"dot": "#EF4444", "bg": "#FEE2E2", "fg": "#991B1B", "label": "Failed"},
}

HEADING  = "Connect Your PC to VE Admin for Remote Support"
SUBTITLE = (
   "Enter the username and password for this machine. The installer will automatically set up everything needed. After clicking Start, your manager can securely access and control your PC remotely to help monitor and fix any PMC-related issues."
)

IS_WIN = sys.platform.startswith("win")
NO_WIN = 0x08000000 if IS_WIN else 0


LOG_FONT_FAMILY  = "Consolas" if IS_WIN else "Menlo"
LOG_FONT_SIZE    = 9


STATUS_CHECK_TIMEOUT_S = 5
POLL_INTERVAL_MS       = 4000
DRAIN_INTERVAL_MS      = 100


TASK_STATE_PS_CMD = (
    "(Get-ScheduledTask -TaskName '" + TASK_NAME + "' "
    "-ErrorAction SilentlyContinue).State"
)


def resource_dir() -> Path:
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


def find_logo():
    """Locate the brand logo PNG to display at the top of the installer.
    Preference order:
      1. virtual_eye_logo.png — the wordmark from veadmin_new's login
         (white-on-transparent so it composites on the dark blue header).
      2. logo02.png — older PMC mark, fallback for older builds.
    Falling back to None just hides the image band; the rest of the
    layout still renders with a text title."""
    candidates = [
        resource_dir() / "virtual_eye_logo.png",
        resource_dir() / "logo02.png",
        resource_dir() / "logo.png",
        Path.cwd() / "virtual_eye_logo.png",
        Path.cwd() / "logo02.png",
    ]
    for p in candidates:
        try:
            if p.exists():
                return p
        except Exception:
            pass
    return None


def install_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    return base / INSTALL_FOLDER


def have(exe: str) -> bool:
    return shutil.which(exe) is not None


def normalize_username(name: str) -> str:
    """Server stores agents under .trim().toLowerCase(); match here so the
    value we save is the canonical form the manager will look up."""
    return (name or "").strip().lower()


def _read_registry_value(value_name: str) -> str:
    """Read a single string value from HKCU\\Software\\VEAdminAgent.
    Returns "" if Windows isn't available, the key doesn't exist, or the
    value is missing. Used for both Username and Password — the latter is
    stored as plaintext in HKCU only (per-user hive, not readable by other
    users on the box). Don't move this to HKLM unless we encrypt it."""
    if not IS_WIN:
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as k:
            v, _ = winreg.QueryValueEx(k, value_name)
            return str(v or "")
    except Exception:
        return ""


def _write_registry_value(value_name: str, value: str) -> None:
    if not IS_WIN:
        return
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGISTRY_KEY) as k:
            winreg.SetValueEx(k, value_name, 0, winreg.REG_SZ, value)
    except Exception:
        pass


def saved_username_from_registry() -> str:
    return _read_registry_value("Username")


def saved_password_from_registry() -> str:
    return _read_registry_value("Password")


def saved_username_from_config() -> str:
    cfg = install_dir() / "config.json"
    try:
        return str(json.loads(cfg.read_text(encoding="utf-8")).get("autopairUser") or "")
    except Exception:
        return ""


def saved_password_from_config() -> str:
    cfg = install_dir() / "config.json"
    try:
        return str(json.loads(cfg.read_text(encoding="utf-8")).get("autopairPassword") or "")
    except Exception:
        return ""


def write_username_registry(name: str) -> None:
    _write_registry_value("Username", name)


def write_password_registry(password: str) -> None:
    _write_registry_value("Password", password)


def os_username_default() -> str:
    return (os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()


class InstallerApp:
    def __init__(self, root):
        self.root = root
        self.log_queue = queue.Queue()
        self.worker = None

        root.title(APP_TITLE)


        root.geometry("720x700")
        root.minsize(640, 640)
        root.configure(bg=BG_CANVAS)

        ico = find_icon()
        if ico is not None:
            try:
                root.iconbitmap(default=str(ico))
            except Exception:
                pass


        base_family = "Segoe UI" if IS_WIN else "Helvetica"


        self._font_h1   = (base_family, 24, "bold")
        self._font_body = (base_family, 11)
        self._font_lbl  = (base_family, 9, "bold")
        self._font_btn  = (base_family, 11, "bold")
        self._font_sub  = (base_family, 10)
        self._font_micro = (base_family, 9)


        style = ttk.Style(root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass


        style.configure(
            "Brand.TButton",
            background=BRAND_ACCENT, foreground="#FFFFFF",
            font=self._font_btn, borderwidth=0, focusthickness=0,
            padding=(24, 12),
        )
        style.map(
            "Brand.TButton",
            background=[("active", BRAND_PRIMARY_DARK), ("disabled", "#9CC2E5")],
            foreground=[("disabled", "#E2E8F0")],
        )


        style.configure(
            "Ghost.TButton",
            background=SURFACE, foreground=TEXT_700,
            font=self._font_body, borderwidth=1, relief="solid",
            padding=(16, 10),
        )
        style.map(
            "Ghost.TButton",
            background=[("active", "#F1F5F9"), ("disabled", "#F8FAFC")],
            foreground=[("disabled", "#94A3B8")],
            bordercolor=[("active", BRAND_BLUE), ("!active", LINE)],
        )


        style.configure(
            "Brand.TEntry",
            fieldbackground="#FFFFFF", foreground=TEXT_900,
            bordercolor=LINE, lightcolor=LINE, darkcolor=LINE,
            padding=10, relief="flat",
        )
        style.map(
            "Brand.TEntry",
            bordercolor=[("focus", BRAND_BLUE)],
            lightcolor=[("focus", BRAND_BLUE)],
            darkcolor=[("focus", BRAND_BLUE)],
        )


        style.configure(
            "Brand.TCheckbutton",
            background=SURFACE, foreground=TEXT_500, font=self._font_micro,
        )
        style.map("Brand.TCheckbutton",
                  background=[("active", SURFACE)],
                  foreground=[("active", BRAND_BLUE)])


        outer = tk.Frame(root, bg=BG_CANVAS)
        outer.pack(fill="both", expand=True)


        logo_path = find_logo()
        self._logo_image = None
        if logo_path is not None:
            try:
                img = tk.PhotoImage(file=str(logo_path))


                w = img.width()
                if w > 240:
                    factor = max(1, w // 180)
                    img = img.subsample(factor, factor)
                self._logo_image = img
            except Exception:
                self._logo_image = None

        hero = tk.Frame(outer, bg=BRAND_PRIMARY_DARK, height=130)
        hero.pack(fill="x")
        hero.pack_propagate(False)
        if self._logo_image is not None:
            tk.Label(
                hero, image=self._logo_image,
                bg=BRAND_PRIMARY_DARK, bd=0,
            ).pack(expand=True)
        else:

            tk.Label(
                hero, text="virtual eye",
                bg=BRAND_PRIMARY_DARK, fg="#FFFFFF",
                font=(base_family, 22, "bold"),
            ).pack(expand=True)


        tk.Frame(outer, bg=BRAND_ACCENT, height=2).pack(fill="x")


        card_wrap = tk.Frame(outer, bg=BG_CANVAS)
        card_wrap.pack(fill="both", expand=True, padx=40, pady=(32, 28))

        card = tk.Frame(card_wrap, bg=SURFACE, highlightthickness=1,
                        highlightbackground=LINE)
        card.pack(fill="both", expand=True)

        inner = tk.Frame(card, bg=SURFACE)
        inner.pack(fill="both", expand=True, padx=44, pady=36)


        tk.Label(
            inner, text=HEADING, bg=SURFACE, fg=BRAND_PRIMARY_DARK,
            font=self._font_h1, anchor="w", justify="left",
        ).pack(fill="x")
        tk.Label(
            inner, text=SUBTITLE, bg=SURFACE, fg=TEXT_500,
            font=self._font_sub, anchor="w", justify="left",
            wraplength=480,
        ).pack(fill="x", pady=(8, 24))


        prefilled_user = (
            saved_username_from_registry()
            or saved_username_from_config()
            or os_username_default()
        )
        prefilled_pwd = (
            saved_password_from_registry()
            or saved_password_from_config()
        )
        self.user_var = tk.StringVar(value=prefilled_user)
        self.pwd_var = tk.StringVar(value=prefilled_pwd)
        self._pwd_visible = tk.BooleanVar(value=False)


        creds = tk.Frame(inner, bg=SURFACE)
        creds.pack(fill="x", pady=(0, 28))
        creds.grid_columnconfigure(0, weight=1, uniform="creds_col")
        creds.grid_columnconfigure(1, weight=0, minsize=24)
        creds.grid_columnconfigure(2, weight=1, uniform="creds_col")


        tk.Label(
            creds, text="USERNAME", bg=SURFACE, fg=TEXT_500,
            font=self._font_lbl, anchor="w",
        ).grid(row=0, column=0, sticky="ew")

        self.user_entry = ttk.Entry(
            creds, textvariable=self.user_var, style="Brand.TEntry",
            font=self._font_body,
        )
        self.user_entry.grid(row=1, column=0, sticky="ew", pady=(8, 6), ipady=8)

        tk.Label(
            creds,
            text="Lowercased automatically. The manager looks up this name to open a session.",
            bg=SURFACE, fg=TEXT_400, font=self._font_micro,
            anchor="w", justify="left", wraplength=300,
        ).grid(row=2, column=0, sticky="ew")


        pwd_header = tk.Frame(creds, bg=SURFACE)
        pwd_header.grid(row=0, column=2, sticky="ew")
        tk.Label(
            pwd_header, text="PASSWORD", bg=SURFACE, fg=TEXT_500,
            font=self._font_lbl, anchor="w",
        ).pack(side="left")

        def _toggle_pwd():
            self.pwd_entry.configure(show="" if self._pwd_visible.get() else "*")

        ttk.Checkbutton(
            pwd_header, text="Show", variable=self._pwd_visible,
            command=_toggle_pwd, style="Brand.TCheckbutton",
        ).pack(side="right")

        self.pwd_entry = ttk.Entry(
            creds, textvariable=self.pwd_var, show="*",
            style="Brand.TEntry", font=self._font_body,
        )
        self.pwd_entry.grid(row=1, column=2, sticky="ew", pady=(8, 6), ipady=8)


        self.url_var = tk.StringVar(value=DEFAULT_URL)


        bar = tk.Frame(inner, bg=SURFACE)
        bar.pack(fill="x")
        self.btn_install = ttk.Button(
            bar, text="Start", command=self.on_install,
            style="Brand.TButton",
        )
        self.btn_install.pack(side="left")
        self.btn_stop = ttk.Button(
            bar, text="Stop", command=self.on_stop, state="disabled",
            style="Ghost.TButton",
        )
        self.btn_stop.pack(side="left", padx=(8, 0))
        self.btn_uninstall = ttk.Button(
            bar, text="Uninstall", command=self.on_uninstall,
            style="Ghost.TButton",
        )
        self.btn_uninstall.pack(side="right")


        self.status = tk.StringVar(value="Idle.")


        status_row = tk.Frame(inner, bg=SURFACE)
        status_row.pack(fill="x", pady=(14, 0))

        self._status_pill = tk.Frame(
            status_row, bg=STATE_STYLES["idle"]["bg"],
            highlightthickness=0, bd=0,
        )
        self._status_pill.pack(side="left")

        self._status_dot = tk.Canvas(
            self._status_pill, width=10, height=10,
            bg=STATE_STYLES["idle"]["bg"],
            highlightthickness=0, bd=0,
        )
        self._status_dot.pack(side="left", padx=(10, 6), pady=6)

        self._status_dot_id = self._status_dot.create_oval(
            1, 1, 9, 9,
            fill=STATE_STYLES["idle"]["dot"],
            outline=STATE_STYLES["idle"]["dot"],
        )

        self._status_label = tk.Label(
            self._status_pill,
            text=STATE_STYLES["idle"]["label"],
            bg=STATE_STYLES["idle"]["bg"],
            fg=STATE_STYLES["idle"]["fg"],
            font=self._font_lbl,
        )
        self._status_label.pack(side="left", padx=(0, 12), pady=6)


        self._status_detail = tk.Label(
            status_row, textvariable=self.status,
            bg=SURFACE, fg=TEXT_500, font=self._font_sub,
            anchor="w", justify="left",
        )
        self._status_detail.pack(side="left", padx=(10, 0))


        self._status_state = "idle"
        self._pulse_phase = 0
        self._pulse_after_id = None


        self._log_visible = tk.BooleanVar(value=False)

        details_row = tk.Frame(inner, bg=SURFACE)
        details_row.pack(fill="x", pady=(8, 0))
        self._details_btn = ttk.Checkbutton(
            details_row, text="Show details", variable=self._log_visible,
            command=self._toggle_log, style="Brand.TCheckbutton",
        )
        self._details_btn.pack(side="left")

        self._log_holder = tk.Frame(inner, bg=SURFACE)

        self.log_widget = scrolledtext.ScrolledText(
            self._log_holder, height=10, wrap="word", state="disabled",
            bg="#0F172A", fg="#E2E8F0", insertbackground="#E2E8F0",
            font=(LOG_FONT_FAMILY, LOG_FONT_SIZE),
            borderwidth=0, highlightthickness=1, highlightbackground=LINE,
        )
        self.log_widget.pack(fill="both", expand=True)

        self.user_entry.bind("<Return>", lambda _e: self.on_install())
        self.pwd_entry.bind("<Return>", lambda _e: self.on_install())

        self.root.after(100, self._drain_log)
        self._refresh_buttons()
        self.root.after(1500, self._poll_status)

    def _toggle_log(self):
        """Show/hide the dark log panel under the form. Hidden by default
        so first-time installers see a clean three-field card; admins or
        anyone debugging an install can flip it on. We also re-anchor the
        toggle row so it sits flush with the bottom of the visible
        content regardless of state."""
        if self._log_visible.get():
            self._log_holder.pack(fill="both", expand=True, pady=(8, 0))


            try:
                cur_w = self.root.winfo_width()
                cur_h = self.root.winfo_height()
                if cur_h < 860:
                    self.root.geometry(f"{max(cur_w, 720)}x860")
            except Exception:
                pass
        else:
            self._log_holder.pack_forget()

    def _set_status_state(self, state, detail=None):
        """Update the colored status pill (idle / working / running / stopped /
        failed) and, optionally, the detail line beside it. Pure UI: never
        affects the install / stop / uninstall flow."""
        if state not in STATE_STYLES:
            state = "idle"
        s = STATE_STYLES[state]
        try:
            self._status_pill.configure(bg=s["bg"])
            self._status_dot.configure(bg=s["bg"])
            self._status_dot.itemconfigure(
                self._status_dot_id, fill=s["dot"], outline=s["dot"],
            )
            self._status_label.configure(
                bg=s["bg"], fg=s["fg"], text=s["label"],
            )
        except tk.TclError:

            return
        self._status_state = state
        if detail is not None:
            self.status.set(detail)


        if self._pulse_after_id is not None:
            try:
                self.root.after_cancel(self._pulse_after_id)
            except Exception:
                pass
            self._pulse_after_id = None
        if state == "running":
            self._pulse_phase = 0
            self._pulse_running_dot()

    def _pulse_running_dot(self):
        """Soft fade between the brand green and a slightly lighter shade so
        users can tell at a glance the indicator is live, not a stale UI
        snapshot. Cosmetic only."""
        if self._status_state != "running":
            return
        shades = ["#10B981", "#34D399", "#10B981", "#059669"]
        color = shades[self._pulse_phase % len(shades)]
        try:
            self._status_dot.itemconfigure(
                self._status_dot_id, fill=color, outline=color,
            )
        except tk.TclError:
            return
        self._pulse_phase += 1
        self._pulse_after_id = self.root.after(700, self._pulse_running_dot)

    def log(self, msg):
        self.log_queue.put(msg)

    def _drain_log(self):
        """Pull every queued line in one shot and append them in a single
        Tk text-widget write. Cheaper than the previous per-line
        configure/insert/configure cycle when npm install or the autopair
        bring-up flushes a burst of output."""
        lines = []
        try:
            while True:
                lines.append(self.log_queue.get_nowait())
        except queue.Empty:
            pass
        if lines:
            self.log_widget.configure(state="normal")
            self.log_widget.insert("end", "\n".join(lines) + "\n")
            self.log_widget.see("end")
            self.log_widget.configure(state="disabled")
        self.root.after(DRAIN_INTERVAL_MS, self._drain_log)

    @staticmethod
    def _format_cmd_for_log(cmd, hide_args):
        """Render `cmd` as a single shell-style string for the log panel,
        masking any value whose preceding token is in `hide_args` (we use
        this to keep -Password out of the visible log)."""
        if not isinstance(cmd, (list, tuple)):
            return str(cmd)
        out = []
        cmd_list = list(cmd)
        i = 0
        while i < len(cmd_list):
            tok = str(cmd_list[i])
            out.append(tok)
            if tok in hide_args and i + 1 < len(cmd_list):
                out.append("***")
                i += 2
                continue
            i += 1
        return " ".join(out)

    def _run_stream(self, cmd, cwd=None, shell=False, hide_args=None):
        hide_args = hide_args or set()
        self.log("$ " + self._format_cmd_for_log(cmd, hide_args))


        with subprocess.Popen(
            cmd, cwd=cwd, shell=shell,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            creationflags=NO_WIN,
        ) as proc:
            for line in proc.stdout:
                self.log(line.rstrip())
            return proc.wait()

    def _run_powershell(self, ps_args, hide_args=None):
        return self._run_stream(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass"] + ps_args,
            hide_args=hide_args,
        )

    def on_install(self):
        if self.worker and self.worker.is_alive():
            return
        username = normalize_username(self.user_var.get())


        password = (self.pwd_var.get() or "").strip()


        url = DEFAULT_URL
        if not username:
            messagebox.showwarning(
                APP_TITLE,
                "Please enter a username (the manager will use this to "
                "open a session against this PC).",
            )
            return
        if not password:
            messagebox.showwarning(
                APP_TITLE,
                "Please enter a password.",
            )
            return
        self.user_var.set(username)
        self._lock_form(True)
        self._set_status_state("working", "Installing...")
        self.worker = threading.Thread(
            target=self._do_install, args=(url, username, password), daemon=True,
        )
        self.worker.start()

    def on_stop(self):
        self._set_status_state("working", "Stopping agent...")
        self.worker = threading.Thread(target=self._do_stop, daemon=True)
        self.worker.start()

    def on_uninstall(self):
        if not messagebox.askyesno(
            APP_TITLE,
            "Stop the agent, remove the auto-start task, and delete\n"
            f"{install_dir()} ?",
        ):
            return
        self._lock_form(True)
        self._set_status_state("working", "Uninstalling...")
        self.worker = threading.Thread(target=self._do_uninstall, daemon=True)
        self.worker.start()

    def _lock_form(self, locked):
        st = "disabled" if locked else "normal"
        self.btn_install.configure(state=st)
        self.btn_uninstall.configure(state=st)
        self.user_entry.configure(state=st)
        self.pwd_entry.configure(state=st)

    def _do_install(self, url, username, password):
        try:
            if not IS_WIN:
                raise RuntimeError("Installs on Windows only.")
            self.log(f"[info] server     : {url}")
            self.log(f"[info] username   : {username}")


            self.log(f"[info] password   : ({len(password)} chars)")
            self.log(f"[info] install dir: {install_dir()}")
            write_username_registry(username)
            write_password_registry(password)


            self._preflight_cleanup()
            self._ensure_node()


            self._run_install_ps1(url, username, password)


            self._write_config_json(url, username, password)
            self._verify_config_json(url, username, password)


            self.log("[..] clearing port and any stale agent before sign-in...")
            self._kill_port(AGENT_PORT)
            self._start_task()
            self._wait_for_port_listen(AGENT_PORT, timeout_s=15)
            self.log("[done] install complete - agent is running and will "
                     "auto-start on every login.")
            self.root.after(
                0,
                lambda u=username: self._set_status_state(
                    "running", f"Agent started - registered as: {u}",
                ),
            )
        except Exception as e:
            self.log(f"[error] {e}")
            err_text = str(e)
            self.root.after(
                0,
                lambda: self._set_status_state(
                    "failed", "Failed. See log.",
                ),
            )

            self.root.after(
                0,
                lambda msg=err_text: messagebox.showerror(APP_TITLE, msg),
            )
        finally:
            self.root.after(0, self._refresh_buttons)
            self.root.after(0, lambda: self._lock_form(False))

    def _write_config_json(self, url, username, password):
        cfg_path = install_dir() / "config.json"
        existing = {}
        if cfg_path.exists():
            try:
                existing = json.loads(cfg_path.read_text(encoding="utf-8"))
                if not isinstance(existing, dict):
                    existing = {}
            except Exception as e:
                self.log(f"[warn] existing config.json unreadable: {e}; rewriting")
                existing = {}
        merged = dict(existing)
        merged["autopairUrl"]      = url
        merged["autopairUser"]     = username
        merged["autopairPassword"] = password
        merged["allowedOrigin"]    = url
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(
            json.dumps(merged, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        self.log(
            f"[ok] wrote config.json -> autopairUrl={url}, "
            f"autopairUser={username}, autopairPassword=({len(password)} chars)"
        )

    def _verify_config_json(self, url, username, password):
        cfg_path = install_dir() / "config.json"
        if not cfg_path.exists():
            raise RuntimeError(f"config.json missing at {cfg_path}")
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception as e:
            raise RuntimeError(f"config.json is not valid JSON: {e}")
        if data.get("autopairUrl") != url:
            raise RuntimeError(
                f"config.json autopairUrl is {data.get('autopairUrl')!r}, "
                f"expected {url!r}"
            )
        if data.get("autopairUser") != username:
            raise RuntimeError(
                f"config.json autopairUser is {data.get('autopairUser')!r}, "
                f"expected {username!r}"
            )
        if data.get("autopairPassword") != password:

            raise RuntimeError("config.json autopairPassword does not match form input")
        self.log("[ok] verified config.json (autopair will be enabled on next start)")

    def _start_task(self):
        """Start the VEAdminAgent scheduled task. Idempotent: if it's already
        running this is a no-op, which is what we want — the new config has
        already landed on disk and a running agent will be restarted by the
        Stop+kill that happens just before this call."""
        self.log("[..] starting scheduled task...")
        self._run_powershell([
            "-Command",
            "Start-ScheduledTask -TaskName '" + TASK_NAME + "'",
        ])

    def _restart_task(self):
        """Stop+kill+start. Kept for the previous Stop button code path; the
        install flow uses the explicit STOP → KILL → START sequence in
        _do_install instead so it can interleave config writes."""
        self.log("[..] restarting scheduled task...")
        self._run_powershell([
            "-Command",
            "Stop-ScheduledTask -TaskName '" + TASK_NAME + "' -ErrorAction SilentlyContinue",
        ])
        self._kill_port(AGENT_PORT)
        self._start_task()

    def _wait_for_port_listen(self, port, timeout_s=15):
        """Block until something is LISTENING on `port`, or `timeout_s`
        elapses. We use this to confirm the freshly-started agent actually
        bound the WS port — without it, "install succeeded" can be a lie
        if the task launched, hit EADDRINUSE, and is mid-respawn-backoff.
        Logs whether the wait succeeded but does NOT raise: the scheduled
        task auto-respawns, so a slow first bind isn't a fatal install
        failure."""
        ps = (
            "$deadline = (Get-Date).AddSeconds(" + str(int(timeout_s)) + "); "
            "while ((Get-Date) -lt $deadline) { "
            "  $c = Get-NetTCPConnection -LocalPort " + str(port) + " "
            "       -State Listen -ErrorAction SilentlyContinue; "
            "  if ($c) { "
            "    Write-Host \"       agent is listening on port " + str(port) + " (PID $($c[0].OwningProcess))\"; "
            "    exit 0 "
            "  } "
            "  Start-Sleep -Milliseconds 500 "
            "} "
            "Write-Host \"       (timeout) agent didn't bind port " + str(port) + " within " + str(int(timeout_s)) + "s; \"; "
            "Write-Host \"       check %LocalAppData%\\VEAdminAgent\\agent.log for crash details.\"; "
            "exit 1"
        )
        self._run_powershell(["-Command", ps])

    def _do_stop(self):


        try:
            self.log("[..] stopping VEAdminAgent scheduled task...")
            self._run_powershell([
                "-Command",
                "try { Stop-ScheduledTask -TaskName '" + TASK_NAME + "' "
                "-ErrorAction Stop; Write-Host '       task stopped' } "
                "catch { Write-Host '       (task was not running)' }",
            ])
            self.log("[..] killing port + any stray agent processes...")
            self._kill_port(AGENT_PORT)
            self.root.after(
                0,
                lambda: self._set_status_state("stopped", "Agent stopped."),
            )
        except Exception as e:
            self.log(f"[error] {e}")
            self.root.after(
                0,
                lambda: self._set_status_state("failed", "Stop failed. See log."),
            )
        finally:
            self.root.after(0, self._refresh_buttons)

    def _do_uninstall(self):


        try:
            self.log("[..] pre-uninstall: killing port + stale agent processes...")
            self._kill_port(AGENT_PORT)
            ps1 = resource_dir() / "uninstall.ps1"
            if ps1.exists():
                self.log("[..] running uninstall.ps1 ...")
                rc = self._run_powershell(["-File", str(ps1)])
                if rc != 0:
                    raise RuntimeError(f"uninstall.ps1 exited with code {rc}")
            else:
                self._run_powershell([
                    "-Command",
                    "try { Stop-ScheduledTask -TaskName '" + TASK_NAME + "' "
                    "-ErrorAction SilentlyContinue } catch {}; "
                    "try { Unregister-ScheduledTask -TaskName '" + TASK_NAME + "' "
                    "-Confirm:$false -ErrorAction SilentlyContinue } catch {}",
                ])
                self._kill_port(AGENT_PORT)
                d = install_dir()
                if d.exists():
                    shutil.rmtree(d, ignore_errors=True)
                    self.log(f"[ok] removed {d}")

            self.log("[..] post-uninstall: final port + process sweep...")
            self._kill_port(AGENT_PORT)
            self.log("[done] uninstalled.")
            self.root.after(
                0,
                lambda: self._set_status_state("idle", "Uninstalled."),
            )
        except Exception as e:
            self.log(f"[error] {e}")
            self.root.after(
                0,
                lambda: self._set_status_state(
                    "failed", "Uninstall failed. See log.",
                ),
            )
        finally:
            self.root.after(0, self._refresh_buttons)
            self.root.after(0, lambda: self._lock_form(False))

    def _preflight_cleanup(self):
        self.log("[..] pre-flight cleanup...")
        self._kill_port(AGENT_PORT)
        self._run_powershell([
            "-Command",
            "try { Stop-ScheduledTask -TaskName '" + TASK_NAME + "' "
            "-ErrorAction SilentlyContinue } catch {}",
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


        ps = (
            "$ErrorActionPreference='Continue'; "

            f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen "
            f"-ErrorAction SilentlyContinue; "
            f"if ($c) {{ foreach ($x in $c) {{ "
            f"  try {{ Stop-Process -Id $x.OwningProcess -Force -ErrorAction Stop; "
            f"        Write-Host \"       killed PID $($x.OwningProcess) on {port}\" }} "
            f"  catch {{ Write-Host \"       could not kill PID $($x.OwningProcess) on {port}\" }} "
            f"}} }} else {{ Write-Host '       no process on port {port}' }}; "

            "$needles = @('VEAdminAgent\\\\agent.js','VEAdminAgent\\\\run-agent.ps1','agent.js'); "
            "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue "
            "  | Where-Object { $_.Name -in @('node.exe','powershell.exe','pwsh.exe') } "
            "  | Where-Object { "
            "      $cl = [string]$_.CommandLine; "
            "      ($cl -match 'VEAdminAgent') -or ($cl -match 'run-agent\\.ps1') "
            "    }; "
            "if ($procs) { foreach ($p in $procs) { "
            "  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; "
            "        Write-Host \"       killed stale $($p.Name) PID $($p.ProcessId)\" } "
            "  catch { Write-Host \"       could not kill $($p.Name) PID $($p.ProcessId)\" } "
            "} } else { Write-Host '       no stale agent processes' }; "

            "Start-Sleep -Milliseconds 500"
        )
        self._run_powershell(["-Command", ps])

    def _ensure_node(self):
        self.log("[..] checking Node.js...")
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
                "Node.js install via winget did not make node.exe visible. "
                "Please reboot and try again, or install Node.js LTS manually "
                "from https://nodejs.org."
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

    def _run_install_ps1(self, url, username, password):
        self.log("[..] running install.ps1 (copies files, npm install, "
                 "writes config.json, registers scheduled task)...")
        ps1 = resource_dir() / "install.ps1"
        if not ps1.exists():
            raise RuntimeError(
                f"install.ps1 not found at {ps1}. "
                "The .exe may have been built without bundling agent files."
            )


        rc = self._run_powershell([
            "-File", str(ps1),
            "-ServerUrl", url,
            "-Username", username,
            "-Password", password,
            "-AllowedOrigin", url,
            "-NonInteractive",
            "-NoStart",
        ], hide_args={"-Password"})
        if rc != 0:
            raise RuntimeError(f"install.ps1 exited with code {rc}")

    def _refresh_buttons(self):
        """Kick off a non-blocking refresh. The previous implementation ran
        powershell.exe synchronously on the Tk event loop, which froze the
        GUI for 200-500ms each tick. The actual probe now runs on a worker
        thread; results are marshaled back via root.after, and an in-flight
        flag stops overlapping refreshes from spawning duplicate processes."""
        if getattr(self, "_status_check_in_flight", False):
            return
        self._status_check_in_flight = True
        threading.Thread(
            target=self._check_running_state, daemon=True,
        ).start()

    def _check_running_state(self):
        """Worker-thread probe of the VEAdminAgent scheduled-task state.
        Bounded by STATUS_CHECK_TIMEOUT_S so a stuck powershell.exe can't
        wedge the poll forever. Always hands off to the UI thread for the
        actual widget updates."""
        running = False
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command", TASK_STATE_PS_CMD],
                capture_output=True, text=True, creationflags=NO_WIN,
                timeout=STATUS_CHECK_TIMEOUT_S,
            )
            running = "Running" in (r.stdout or "")
        except Exception:
            pass
        finally:
            self._status_check_in_flight = False
        try:
            self.root.after(0, self._apply_button_state, running)
        except tk.TclError:

            pass

    def _apply_button_state(self, running):
        """UI-thread half of the running-state refresh: button enable/disable
        plus best-effort status-pill sync. Pure UI."""
        self.btn_install.configure(state="normal")
        self.btn_stop.configure(state="normal" if running else "disabled")
        self.btn_uninstall.configure(state="normal")


        if self._status_state in ("working", "failed"):
            return
        if running and self._status_state != "running":
            saved = (
                saved_username_from_registry()
                or saved_username_from_config()
            )
            detail = (
                f"Agent started - registered as: {saved}"
                if saved else "Agent started."
            )
            self._set_status_state("running", detail)
        elif (not running) and self._status_state == "running":

            self._set_status_state("stopped", "Agent is not running.")

    def _poll_status(self):
        """Periodic indicator sync. The actual probe is async (see
        _refresh_buttons), so this method itself is cheap — it just
        re-queues itself and avoids piling up checks while a worker
        install/stop/uninstall is in progress."""
        try:
            if not (self.worker and self.worker.is_alive()):
                self._refresh_buttons()
        except Exception:
            pass
        self.root.after(POLL_INTERVAL_MS, self._poll_status)


def main():
    root = tk.Tk()


    InstallerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
