"""Read-only inventory for an explicitly selected SSH host. Never serialize secrets."""
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess

home = pathlib.Path.home()
agents = []
warnings = []

def read_small(file):
    try:
        if file.stat().st_size > 262144:
            return ""
        return file.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""

def env_metadata(file):
    result = {}
    for line in read_small(file).splitlines():
        match = re.match(r'''^\s*(?:export\s+)?(API_SERVER_ENABLED|API_SERVER_PORT)\s*=\s*["']?([^"'\s#]+)''', line)
        if match:
            result[match[1]] = match[2]
    return result

def binary(name):
    resolved = shutil.which(name)
    if resolved:
        return resolved
    for folder in [home / ".local/bin", home / ".cargo/bin", home / ".hermes/hermes-agent/.venv/bin", pathlib.Path("/opt/homebrew/bin"), pathlib.Path("/usr/local/bin")]:
        p = folder / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None

def valid_port(value, default):
    try:
        number = int(value)
        return number if 0 < number < 65536 else default
    except (TypeError, ValueError):
        return default

homes = [home / ".hermes"]
try:
    homes += sorted(p for p in (home / ".hermes/profiles").iterdir() if p.is_dir())[:128]
except OSError:
    pass
for root in homes:
    if not root.is_dir():
        continue
    profile = "default" if root == home / ".hermes" else root.name
    meta = env_metadata(root / ".env")
    enabled = meta.get("API_SERVER_ENABLED", "").lower() in ("true", "1", "yes")
    port = valid_port(meta.get("API_SERVER_PORT"), 8642)
    agents.append({"name": "Hermes / " + profile, "provider": "hermes", "protocol": "openai", "command": binary("hermes") or "hermes", "args": [], "cwd": str(home), "hermesHome": str(root), "endpoint": "http://127.0.0.1:%d/v1" % port, "model": "hermes-agent" if profile == "default" else profile, "readiness": "configured" if enabled else "setup", "detail": "Gateway API configured. Enter its API token." if enabled else "Profile found. Enable its gateway API before connecting. Do not launch a second writer against a running profile."})
for provider, label in [("codex", "Codex"), ("claude", "Claude Code")]:
    command = binary(provider)
    if command:
        agents.append({"name": label, "provider": provider, "protocol": provider, "command": command, "args": [], "cwd": str(home), "detail": "Uses this SSH account's existing CLI login."})
root = home / ".openclaw"
if binary("openclaw") or root.is_dir():
    try:
        config = json.loads(read_small(root / "openclaw.json") or "{}")
    except (ValueError, TypeError):
        config = {}
        warnings.append("OpenClaw JSON5 config could not be parsed; verify the gateway port manually.")
    gateway = config.get("gateway", {})
    port = valid_port(gateway.get("port"), 18789)
    entries = config.get("agents", {}).get("list", [{"id": "default"}])
    if not isinstance(entries, list):
        entries = [{"id": "default"}]
    for entry in entries[:64]:
        if not isinstance(entry, dict):
            continue
        agent_id = str(entry.get("id", "default"))[:100]
        agents.append({"name": str(entry.get("name", "OpenClaw / " + agent_id))[:80], "provider": "openclaw", "protocol": "openai", "command": binary("openclaw") or "openclaw", "args": [], "cwd": str(home), "endpoint": "http://127.0.0.1:%d/v1" % port, "model": "openclaw/" + agent_id, "readiness": "setup", "detail": "Enable gateway.http.endpoints.chatCompletions and enter the gateway token."})
# Only inspect session names and current program names, never terminal output or env.
if binary("tmux"):
    try:
        result = subprocess.run([binary("tmux"), "list-panes", "-a", "-F", "#{session_name}\\t#{pane_current_command}"], capture_output=True, text=True, timeout=3)
        seen = set()
        for line in result.stdout[:16384].splitlines():
            parts = line.replace("\\t", "\t").split("\t", 1)
            session_name = parts[0]
            current = parts[1] if len(parts) > 1 else "shell"
            if session_name.startswith("agenthub-") or session_name in seen or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", session_name):
                continue
            seen.add(session_name)
            agents.append({"name": ("Session / " + session_name)[:80], "provider": "custom", "protocol": "terminal", "command": "sh", "args": [], "cwd": str(home), "tmuxSession": session_name, "readiness": "running", "detail": "Attach to existing tmux session (" + current + "). No new agent process is started."})
    except (OSError, subprocess.TimeoutExpired):
        warnings.append("tmux session inventory was unavailable.")
else:
    warnings.append("Install tmux on this host to keep remote terminal processes alive across SSH disconnects. Gateway API connections do not need tmux.")
docker = binary("docker")
if docker:
    try:
        result = subprocess.run([docker, "ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Command}}"], capture_output=True, text=True, timeout=4)
        for line in result.stdout[:32768].splitlines()[:128]:
            parts = line.split("\t")
            if len(parts) < 5:
                continue
            container_id, name, image, ports, command = parts[:5]
            haystack = " ".join([name, image, command]).lower()
            if "hermes" not in haystack:
                continue
            matches = re.findall(r"(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)->8642/tcp", ports)
            for port in matches[:8]:
                endpoint = "http://127.0.0.1:%s/v1" % port
                hermes_home = ""
                try:
                    home_result = subprocess.run([docker, "exec", container_id, "printenv", "HERMES_HOME"], capture_output=True, text=True, timeout=2)
                    hermes_home = home_result.stdout.strip()[:2048]
                except (OSError, subprocess.TimeoutExpired):
                    hermes_home = ""
                docker_args = ["exec", "-i"]
                if hermes_home:
                    docker_args += ["-e", "HOME=" + hermes_home, "-e", "HERMES_HOME=" + hermes_home, "-w", hermes_home]
                docker_args += [name, "hermes"]
                agents.append({"name": ("Hermes Docker / " + name)[:80], "provider": "hermes", "protocol": "openai", "command": "docker", "args": docker_args, "cwd": hermes_home or str(home), "hermesHome": hermes_home, "endpoint": endpoint, "model": "hermes-agent", "readiness": "running", "detail": ("Docker container publishes a private Hermes gateway from " + (hermes_home or "its container data directory") + ". Import the gateway token from the container .env, or enter it manually.")[:500]})
            if not matches and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", name):
                hermes_home = ""
                try:
                    home_result = subprocess.run([docker, "exec", name, "printenv", "HERMES_HOME"], capture_output=True, text=True, timeout=2)
                    hermes_home = home_result.stdout.strip()[:2048]
                except (OSError, subprocess.TimeoutExpired):
                    hermes_home = ""
                docker_args = ["exec", "-i"]
                if hermes_home:
                    docker_args += ["-e", "HOME=" + hermes_home, "-e", "HERMES_HOME=" + hermes_home, "-w", hermes_home]
                docker_args += [name, "hermes"]
                agents.append({"name": ("Hermes Docker / " + name)[:80], "provider": "hermes", "protocol": "acp", "command": "docker", "args": docker_args, "cwd": hermes_home or str(home), "hermesHome": hermes_home, "model": "", "readiness": "running", "detail": ("Docker container has no host gateway port, so Opaya can connect through Hermes ACP with docker exec. " + (("HERMES_HOME is " + hermes_home + ".") if hermes_home else ""))[:500]})
    except (OSError, subprocess.TimeoutExpired):
        warnings.append("Docker inventory was unavailable.")
print(json.dumps({"machine": {"hostname": socket.gethostname(), "home": str(home)}, "agents": agents, "warnings": warnings}))
