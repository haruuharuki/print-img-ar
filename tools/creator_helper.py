from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import json
import math
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "src" / "ar-config.js"
CONFIG_REPO_PATH = "src/ar-config.js"
COMMIT_MESSAGE = "Update AR overlay config"

NUMBER_RANGES = {
    "width": (0.1, 2.5),
    "height": (0.1, 2.5),
    "position.x": (-1.5, 1.5),
    "position.y": (-1.5, 1.5),
    "position.z": (-0.2, 0.4),
    "rotation.x": (-180.0, 180.0),
    "rotation.y": (-180.0, 180.0),
    "rotation.z": (-180.0, 180.0),
}


class DeployError(Exception):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.status = status
        self.details = details or {}


class CreatorHelperHandler(SimpleHTTPRequestHandler):
    server_version = "CreatorHelper/0.1"

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), format % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path != "/api/deploy-overlay":
            self.send_error(404)
            return
        self._validate_local_request()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._request_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path != "/api/deploy-overlay":
            self.send_json({"ok": False, "error": "Unknown endpoint."}, status=404)
            return

        try:
            self._validate_local_request()
            payload = self._read_json_body()
            result = deploy_overlay(payload)
            self.send_json({"ok": True, **result})
        except DeployError as error:
            self.send_json(
                {"ok": False, "error": str(error), "details": error.details},
                status=error.status,
            )
        except Exception as error:
            self.send_json(
                {"ok": False, "error": "Unexpected helper error.", "details": {"message": str(error)}},
                status=500,
            )

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise DeployError("Missing JSON body.")
        if length > 32768:
            raise DeployError("Request body is too large.")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise DeployError("Invalid JSON body.", details={"message": str(error)})

    def _validate_local_request(self):
        client_host = self.client_address[0]
        if client_host != "127.0.0.1":
            raise DeployError("Rejected non-local request.", status=403)

        host = self.headers.get("Host", "")
        allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in allowed_hosts:
            raise DeployError("Rejected unexpected Host header.", status=403, details={"host": host})

        origin = self.headers.get("Origin")
        if origin:
            allowed_origins = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
            if origin not in allowed_origins:
                raise DeployError("Rejected unexpected Origin header.", status=403, details={"origin": origin})

    def _request_origin(self):
        origin = self.headers.get("Origin")
        if origin:
            return origin
        return f"http://127.0.0.1:{self.server.server_port}"

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def deploy_overlay(payload):
    dry_run = bool(payload.get("dryRun", False))
    next_overlay = validate_overlay(payload.get("overlay"), "overlay")
    base_overlay = None
    if payload.get("baseOverlay") is not None:
        base_overlay = validate_overlay(payload.get("baseOverlay"), "baseOverlay")

    config_text = CONFIG_PATH.read_text(encoding="utf-8")
    current_overlay = extract_overlay(config_text)

    if base_overlay and current_overlay != base_overlay and current_overlay != next_overlay:
        raise DeployError(
            "src/ar-config.js changed since Creator loaded. Refresh creator.html before deploying.",
            status=409,
            details={"currentOverlay": current_overlay, "baseOverlay": base_overlay},
        )

    next_config_text = replace_overlay(config_text, next_overlay)
    content_changed = next_config_text != config_text

    ensure_git_ready_for_deploy()

    if dry_run:
        return {
            "dryRun": True,
            "changed": content_changed or path_has_git_changes(),
            "contentChanged": content_changed,
            "message": "Dry run passed. No files were written, committed, or pushed.",
            "overlay": next_overlay,
        }

    if content_changed:
        CONFIG_PATH.write_text(next_config_text, encoding="utf-8")

    if not path_has_git_changes(include_untracked=True):
        return {
            "dryRun": False,
            "changed": False,
            "deployed": False,
            "message": "No overlay changes to deploy.",
            "overlay": next_overlay,
        }

    run_git(["add", "--", CONFIG_REPO_PATH])
    staged = staged_files()
    if staged != [CONFIG_REPO_PATH]:
        raise DeployError(
            "Refusing to commit because staged files are not exactly src/ar-config.js.",
            status=409,
            details={"stagedFiles": staged},
        )

    run_git(["commit", "-m", COMMIT_MESSAGE, "--", CONFIG_REPO_PATH])
    commit_sha = run_git(["rev-parse", "HEAD"]).stdout.strip()
    push_result = run_git(["push", "origin", "main"])

    return {
        "dryRun": False,
        "changed": True,
        "deployed": True,
        "commitSha": commit_sha,
        "message": "Overlay config pushed. Netlify should auto-deploy from origin main.",
        "pushOutput": tail_output(push_result.stdout, push_result.stderr),
        "overlay": next_overlay,
    }


def validate_overlay(value, label):
    if not isinstance(value, dict):
        raise DeployError(f"{label} must be an object.")

    width = finite_number(value.get("width"), f"{label}.width")
    height = finite_number(value.get("height"), f"{label}.height")
    position = validate_vector(value.get("position"), f"{label}.position")
    rotation = validate_vector(value.get("rotation"), f"{label}.rotation")

    flat = {
        "width": width,
        "height": height,
        "position.x": position["x"],
        "position.y": position["y"],
        "position.z": position["z"],
        "rotation.x": rotation["x"],
        "rotation.y": rotation["y"],
        "rotation.z": rotation["z"],
    }
    for key, number in flat.items():
        minimum, maximum = NUMBER_RANGES[key]
        if number < minimum or number > maximum:
            raise DeployError(
                f"{key} is out of range.",
                details={"value": number, "minimum": minimum, "maximum": maximum},
            )

    return {
        "width": clean_number(width),
        "height": clean_number(height),
        "position": {axis: clean_number(position[axis]) for axis in ("x", "y", "z")},
        "rotation": {axis: clean_number(rotation[axis]) for axis in ("x", "y", "z")},
    }


def validate_vector(value, label):
    if isinstance(value, str):
        parts = value.split()
        if len(parts) != 3:
            raise DeployError(f"{label} must contain exactly 3 numbers.")
        numbers = [finite_number(part, f"{label}.{axis}") for part, axis in zip(parts, ("x", "y", "z"))]
        return {"x": numbers[0], "y": numbers[1], "z": numbers[2]}

    if isinstance(value, dict):
        return {
            "x": finite_number(value.get("x"), f"{label}.x"),
            "y": finite_number(value.get("y"), f"{label}.y"),
            "z": finite_number(value.get("z"), f"{label}.z"),
        }

    raise DeployError(f"{label} must be an object or a string.")


def finite_number(value, label):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise DeployError(f"{label} must be a number.")
    if not math.isfinite(number):
        raise DeployError(f"{label} must be finite.")
    return number


def clean_number(value):
    return float(f"{value:.4f}")


def extract_overlay(config_text):
    block = overlay_match(config_text).group(0)
    width = required_number(block, r"width:\s*([-+]?\d+(?:\.\d+)?)", "overlay.width")
    height = required_number(block, r"height:\s*([-+]?\d+(?:\.\d+)?)", "overlay.height")
    position = required_vector(block, r'position:\s*"([^"]+)"', "overlay.position")
    rotation = required_vector(block, r'rotation:\s*"([^"]+)"', "overlay.rotation")
    return validate_overlay(
        {"width": width, "height": height, "position": position, "rotation": rotation},
        "current overlay",
    )


def required_number(text, pattern, label):
    match = re.search(pattern, text)
    if not match:
        raise DeployError(f"Cannot find {label} in src/ar-config.js.", status=500)
    return match.group(1)


def required_vector(text, pattern, label):
    match = re.search(pattern, text)
    if not match:
        raise DeployError(f"Cannot find {label} in src/ar-config.js.", status=500)
    return match.group(1)


def replace_overlay(config_text, overlay):
    match = overlay_match(config_text)
    newline = "\r\n" if "\r\n" in config_text else "\n"
    leading = match.group("leading")
    indent = match.group("indent")
    next_block = leading + newline.join(
        [
            f"{indent}overlay: {{",
            f"{indent}  width: {format_number(overlay['width'])},",
            f"{indent}  height: {format_number(overlay['height'])},",
            f'{indent}  position: "{vector_string(overlay["position"])}",',
            f'{indent}  rotation: "{vector_string(overlay["rotation"])}"',
            f"{indent}}}",
        ]
    )
    return config_text[: match.start("block")] + next_block + config_text[match.end("block") :]


def overlay_match(config_text):
    pattern = re.compile(
        r"(?P<block>(?P<leading>\r?\n)(?P<indent>[ \t]*)overlay:\s*\{\s*\r?\n[\s\S]*?\r?\n[ \t]*\}(?=[ \t]*,))"
    )
    match = pattern.search(config_text)
    if not match:
        raise DeployError("Cannot find overlay block in src/ar-config.js.", status=500)
    return match


def vector_string(vector):
    return f"{format_number(vector['x'])} {format_number(vector['y'])} {format_number(vector['z'])}"


def format_number(value):
    return f"{value:.4f}".rstrip("0").rstrip(".")


def ensure_git_ready_for_deploy():
    branch = run_git(["branch", "--show-current"]).stdout.strip()
    if branch != "main":
        raise DeployError("Refusing to deploy unless the current branch is main.", status=409, details={"branch": branch})

    staged = staged_files()
    if staged:
        raise DeployError(
            "Refusing to deploy while staged changes already exist.",
            status=409,
            details={"stagedFiles": staged},
        )


def path_has_git_changes(include_untracked=False):
    tracked = is_tracked(CONFIG_REPO_PATH)
    if tracked:
        result = subprocess.run(
            ["git", "diff", "--quiet", "--", CONFIG_REPO_PATH],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode == 1:
            return True
        if result.returncode not in (0, 1):
            raise DeployError(
                "git diff failed.",
                status=500,
                details={"stdout": result.stdout, "stderr": result.stderr},
            )
        return False

    if include_untracked and CONFIG_PATH.exists():
        return True
    return False


def is_tracked(path):
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", path],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def staged_files():
    result = run_git(["diff", "--cached", "--name-only"])
    return [line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()]


def run_git(args):
    result = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise DeployError(
            f"git {' '.join(args)} failed.",
            status=500,
            details={"stdout": result.stdout, "stderr": result.stderr, "returncode": result.returncode},
        )
    return result


def tail_output(stdout, stderr):
    text = "\n".join(part for part in (stdout.strip(), stderr.strip()) if part)
    lines = text.splitlines()
    return "\n".join(lines[-20:])


def main():
    parser = argparse.ArgumentParser(description="Local creator helper for Print Image AR Starter.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()

    if args.host != "127.0.0.1":
        raise SystemExit("creator_helper.py only supports --host 127.0.0.1")

    server = ThreadingHTTPServer((args.host, args.port), CreatorHelperHandler)
    print(f"Creator helper running at http://{args.host}:{args.port}/creator.html")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping creator helper.")


if __name__ == "__main__":
    main()
