from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import cgi
import datetime
import json
import math
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "src" / "ar-config.js"
CONFIG_REPO_PATH = "src/ar-config.js"
LIBRARY_PATH = ROOT / "src" / "ar-library.js"
TARGETS_DIR = ROOT / "assets" / "targets"
OVERLAYS_DIR = ROOT / "assets" / "overlays"
TARGETS_MIND_PATH = ROOT / "assets" / "targets.mind"
DELETED_DIR = ROOT / "assets" / "_deleted"
COMMIT_MESSAGE = "Update AR overlay config"
MAX_ACTIVE_TARGETS = 15
MAX_MULTIPART_BYTES = 120 * 1024 * 1024
MAX_OPTIMIZER_INPUT_BYTES = 2 * 1024 * 1024 * 1024
DELETED_RETENTION_DAYS = 7
LIBRARY_DEPLOY_MESSAGE = "feat: deploy multi-target AR library"
DEPLOY_LOCK = threading.Lock()
OVERLAY_EXTENSIONS = {".mp4", ".mov", ".webm"}
PACKED_CACHE_DIR = Path(tempfile.gettempdir()) / "print-ar-packed-cache"
PACKED_CACHE_TTL_SECONDS = 15 * 60
PACKED_DOWNLOADS = {}
PACKED_DOWNLOAD_LOCK = threading.Lock()
PACKED_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")

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
        if self.path not in {"/api/deploy-overlay", "/api/optimizer/status", "/api/optimizer/convert", "/api/library/save-target", "/api/library/delete-target", "/api/library/deleted-targets", "/api/library/restore-target", "/api/library/clear-deleted-targets", "/api/library/save-overlay", "/api/library/prepare-deploy", "/api/library/deploy"}:
            self.send_error(404)
            return
        self._validate_local_request()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._request_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/optimizer/packed/"):
            try:
                self._validate_local_request()
                token = path.rsplit("/", 1)[-1]
                self._send_packed_download(token)
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
            return

        super().do_GET()

    def do_POST(self):
        if self.path == "/api/optimizer/status":
            try:
                self._validate_local_request()
                self._read_json_body()
                result = optimizer_status()
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
            return

        if self.path == "/api/optimizer/convert":
            try:
                self._validate_local_request()
                form = self._read_multipart_body(max_bytes=MAX_OPTIMIZER_INPUT_BYTES)
                result = optimize_overlay_video(form)
                self.send_binary(
                    result["data"],
                    "video/webm",
                    optimizer_response_headers(result),
                )
            except DeployError as error:
                payload = {"ok": False, "error": str(error), "details": error.details}
                if error.details.get("stage"):
                    payload["stage"] = error.details["stage"]
                if error.details.get("fileName"):
                    payload["fileName"] = error.details["fileName"]
                self.send_json(payload, status=error.status)
            except UnicodeDecodeError as error:
                self.send_json(
                    {
                        "ok": False,
                        "error": "Optimizer output could not be decoded safely.",
                        "details": {"message": str(error)},
                    },
                    status=500,
                )
            except Exception as error:
                self.send_json(
                    {"ok": False, "error": "Unexpected helper error.", "details": {"message": str(error)}},
                    status=500,
                )
            return

        if self.path == "/api/library/deploy":
            try:
                self._validate_local_request()
                payload = self._read_json_body()
                result = deploy_library(payload)
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
            return

        if self.path == "/api/library/prepare-deploy":
            try:
                self._validate_local_request()
                payload = self._read_json_body()
                result = prepare_library_deploy(payload)
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
            return

        if self.path == "/api/library/save-overlay":
            try:
                self._validate_local_request()
                payload = self._read_json_body()
                result = save_library_overlay(payload)
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
            return

        if self.path == "/api/library/save-target":
            try:
                self._validate_local_request()
                form = self._read_multipart_body()
                result = save_library_target(form)
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
            return

        if self.path == "/api/library/deleted-targets":
            try:
                self._validate_local_request()
                self._read_json_body()
                result = list_deleted_targets()
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
            return

        if self.path == "/api/library/delete-target":
            try:
                self._validate_local_request()
                form = self._read_multipart_body()
                result = delete_library_target(form)
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
            return

        if self.path == "/api/library/restore-target":
            try:
                self._validate_local_request()
                form = self._read_multipart_body()
                result = restore_library_target(form)
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
            return

        if self.path == "/api/library/clear-deleted-targets":
            try:
                self._validate_local_request()
                payload = self._read_json_body()
                result = clear_deleted_targets(payload)
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
            return

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

    def _read_multipart_body(self, max_bytes=MAX_MULTIPART_BYTES):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            raise DeployError("Missing multipart body.")
        if length > max_bytes:
            raise DeployError("Request body is too large.", details={"maximumBytes": max_bytes})

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            raise DeployError("Expected multipart/form-data.")

        return cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": content_type,
                "CONTENT_LENGTH": str(length),
            },
        )

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

    def send_binary(self, body, content_type, headers=None, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_packed_download(self, token):
        cleanup_packed_cache()
        metadata = pop_packed_download(token)
        path = metadata["path"]
        if not path.exists() or not path.is_file():
            raise DeployError("Packed download file was not found.", status=410, details={"token": token})

        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{metadata["fileName"]}"')
        self.end_headers()
        self.wfile.write(body)
        delete_cached_packed_file(path)


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


def run_subprocess_text(command, cwd=ROOT):
    return subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def optimizer_status():
    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    available = bool(ffmpeg_path and ffprobe_path)
    install_hint = (
        "FFmpeg is not available. Install FFmpeg, add ffmpeg.exe and ffprobe.exe to PATH, "
        "then restart run_creator.bat."
    )

    return {
        "available": available,
        "ffmpegPath": ffmpeg_path,
        "ffprobePath": ffprobe_path,
        "installHint": "FFmpeg is ready for optimizer setup." if available else install_hint,
    }


def optimizer_response_headers(result):
    headers = {
        "X-Original-Size": str(result["originalSize"]),
        "X-Optimized-Size": str(result["optimizedSize"]),
        "X-Output-File-Name": result["fileName"],
    }
    if "packedCreated" in result:
        headers["X-Packed-Created"] = "true" if result["packedCreated"] else "false"
    if result.get("packedFileName"):
        headers["X-Packed-File-Name"] = result["packedFileName"]
    if result.get("packedRelativePath"):
        headers["X-Packed-Relative-Path"] = result["packedRelativePath"]
    if result.get("packedSizeBytes") is not None:
        headers["X-Packed-Size-Bytes"] = str(result["packedSizeBytes"])
    if result.get("packedDownloadToken"):
        headers["X-Packed-Download-Token"] = result["packedDownloadToken"]
    if result.get("packedDownloadPath"):
        headers["X-Packed-Download-Path"] = result["packedDownloadPath"]
    if result.get("packedSkippedReason"):
        headers["X-Packed-Skipped-Reason"] = result["packedSkippedReason"]
    if result.get("packedError"):
        headers["X-Packed-Error"] = result["packedError"]
    return headers


def sanitize_download_filename(filename):
    name = Path(str(filename or "packed-alpha.mp4")).name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .")
    if not name:
        name = "packed-alpha.mp4"
    if not name.lower().endswith(".mp4"):
        name = f"{name}.mp4"
    return name[:120]


def cache_packed_download(source_path, download_filename):
    cleanup_packed_cache()
    PACKED_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    while True:
        with PACKED_DOWNLOAD_LOCK:
            if token not in PACKED_DOWNLOADS:
                break
        token = secrets.token_urlsafe(32)

    cached_path = PACKED_CACHE_DIR / f"{token}.mp4"
    shutil.copyfile(source_path, cached_path)
    metadata = {
        "path": cached_path,
        "fileName": sanitize_download_filename(download_filename),
        "createdAt": time.time(),
        "size": cached_path.stat().st_size,
    }
    with PACKED_DOWNLOAD_LOCK:
        PACKED_DOWNLOADS[token] = metadata
    return {
        "token": token,
        "path": f"/api/optimizer/packed/{token}",
        "size": metadata["size"],
    }


def pop_packed_download(token):
    if not PACKED_TOKEN_PATTERN.fullmatch(str(token or "")):
        raise DeployError("Invalid packed download token.", status=404)

    with PACKED_DOWNLOAD_LOCK:
        metadata = PACKED_DOWNLOADS.pop(token, None)
    if not metadata:
        raise DeployError("Packed download token was not found or was already used.", status=404)

    if time.time() - metadata["createdAt"] > PACKED_CACHE_TTL_SECONDS:
        delete_cached_packed_file(metadata["path"])
        raise DeployError("Packed download token expired.", status=410, details={"token": token})

    cached_path = metadata["path"].resolve()
    cache_root = PACKED_CACHE_DIR.resolve()
    if cached_path.parent != cache_root or cached_path.name != f"{token}.mp4":
        delete_cached_packed_file(metadata["path"])
        raise DeployError("Packed download token resolved to an invalid path.", status=404)

    return metadata


def delete_cached_packed_file(path):
    try:
        resolved = Path(path).resolve()
        if resolved.parent == PACKED_CACHE_DIR.resolve() and resolved.exists():
            resolved.unlink()
    except OSError:
        pass


def cleanup_packed_cache():
    now = time.time()
    expired_paths = []
    with PACKED_DOWNLOAD_LOCK:
        expired_tokens = [
            token
            for token, metadata in PACKED_DOWNLOADS.items()
            if now - metadata["createdAt"] > PACKED_CACHE_TTL_SECONDS
        ]
        for token in expired_tokens:
            metadata = PACKED_DOWNLOADS.pop(token, None)
            if metadata:
                expired_paths.append(metadata["path"])

    for path in expired_paths:
        delete_cached_packed_file(path)

    if not PACKED_CACHE_DIR.exists():
        return
    for path in PACKED_CACHE_DIR.glob("*.mp4"):
        try:
            if now - path.stat().st_mtime > PACKED_CACHE_TTL_SECONDS:
                delete_cached_packed_file(path)
        except OSError:
            pass


def optimize_overlay_video(form):
    status = optimizer_status()
    if not status["available"]:
        raise DeployError(status["installHint"], status=409)

    overlay_video = required_form_file(form, "overlayVideo")
    stage = optimizer_stage(optional_form_text(form, "stage"))
    resolution = optimizer_choice(required_form_text(form, "resolution"), {"720", "1080"}, "resolution")
    frame_rate = optimizer_choice(required_form_text(form, "frameRate"), {"24", "30"}, "frameRate")
    quality = optimizer_choice(required_form_text(form, "quality"), {"small", "balanced", "high"}, "quality")
    source_ext = overlay_extension(overlay_video.filename)
    output_name = f"{Path(overlay_video.filename or 'overlay').stem}-optimized.webm"
    crf_by_quality = {
        "small": "42",
        "balanced": "34",
        "high": "28",
    }

    with tempfile.TemporaryDirectory(prefix="print-ar-optimizer-") as temp_dir:
        temp_path = Path(temp_dir)
        input_path = temp_path / f"input{source_ext}"
        output_path = temp_path / "output.webm"
        write_temp_upload(overlay_video, input_path)

        vf = f"fps={frame_rate},scale='min({resolution},iw)':-2:flags=lanczos"
        command = [
            status["ffmpegPath"],
            "-y",
            "-i",
            str(input_path),
            "-an",
            "-vf",
            vf,
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-auto-alt-ref",
            "0",
            "-b:v",
            "0",
            "-crf",
            crf_by_quality[quality],
            "-deadline",
            "good",
            "-row-mt",
            "1",
            str(output_path),
        ]
        result = run_subprocess_text(command)
        if result.returncode != 0:
            raise DeployError(
                "FFmpeg conversion failed.",
                status=500,
                details={
                    "stage": stage,
                    "fileName": overlay_video.filename,
                    "stderr": tail_output(result.stdout, result.stderr),
                    "returncode": result.returncode,
                },
            )
        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise DeployError("FFmpeg did not create an optimized video.", status=500)
        if output_path.stat().st_size > MAX_MULTIPART_BYTES:
            raise DeployError(
                "Optimized video is still too large to save and deploy. Try Small quality or 720 px.",
                status=413,
                details={"optimizedSize": output_path.stat().st_size, "maximumBytes": MAX_MULTIPART_BYTES},
            )

        packed_result = {
            "packedCreated": False,
            "packedFileName": None,
            "packedRelativePath": None,
            "packedSizeBytes": None,
            "packedDownloadToken": None,
            "packedDownloadPath": None,
            "packedSkippedReason": None,
            "packedError": None,
        }
        alpha_status = input_alpha_status(input_path, status["ffprobePath"])
        packed_result["inputHasAlpha"] = alpha_status["hasAlpha"]
        packed_result["inputPixFmt"] = alpha_status.get("pixFmt")
        packed_result["inputCodecName"] = alpha_status.get("codecName")
        if alpha_status["hasAlpha"]:
            packed_name = packed_alpha_output_name(overlay_video.filename)
            packed_path = temp_path / packed_name
            try:
                packed = create_packed_alpha_mp4(
                    input_path,
                    packed_path,
                    resolution,
                    frame_rate,
                    status["ffmpegPath"],
                    quality,
                )
                packed_result.update(
                    {
                        "packedCreated": True,
                        "packedFileName": packed["fileName"],
                        "packedRelativePath": packed_path.relative_to(temp_path).as_posix(),
                        "packedSizeBytes": packed["size"],
                    }
                )
                cached = cache_packed_download(packed_path, packed["fileName"])
                packed_result["packedDownloadToken"] = cached["token"]
                packed_result["packedDownloadPath"] = cached["path"]
            except DeployError as error:
                packed_result["packedError"] = str(error)
                packed_result["packedErrorDetails"] = error.details
        else:
            packed_result["packedSkippedReason"] = alpha_status.get("error") or "Input video stream does not expose an alpha channel."

        data = output_path.read_bytes()
        return {
            "data": data,
            "fileName": output_name,
            "originalSize": input_path.stat().st_size,
            "optimizedSize": len(data),
            **packed_result,
        }


def packed_alpha_output_name(filename):
    return f"{Path(filename or 'overlay').stem}-packed.mp4"


def input_alpha_status(input_path, ffprobe_path):
    command = [
        ffprobe_path,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,pix_fmt",
        "-of",
        "json",
        str(input_path),
    ]
    result = run_subprocess_text(command)
    if result.returncode != 0:
        return {
            "hasAlpha": False,
            "pixFmt": None,
            "codecName": None,
            "error": f"Could not verify alpha channel: {tail_output(result.stdout, result.stderr)}",
        }

    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return {
            "hasAlpha": False,
            "pixFmt": None,
            "codecName": None,
            "error": f"Could not parse ffprobe alpha metadata: {error}",
        }

    streams = metadata.get("streams") or []
    stream = streams[0] if streams else {}
    pix_fmt = str(stream.get("pix_fmt") or "").lower()
    return {
        "hasAlpha": pix_fmt_has_alpha(pix_fmt),
        "pixFmt": pix_fmt or None,
        "codecName": stream.get("codec_name"),
    }


def pix_fmt_has_alpha(pix_fmt):
    return (
        pix_fmt.startswith("yuva")
        or pix_fmt.startswith("gbrap")
        or pix_fmt in {"rgba", "argb", "bgra", "abgr", "ya8", "ayuv64le", "ayuv64be"}
    )


def create_packed_alpha_mp4(input_path, output_path, resolution, frame_rate, ffmpeg_path, quality="balanced"):
    crf_by_quality = {
        "small": "32",
        "balanced": "26",
        "high": "20",
    }
    scale_filter = f"scale='min({resolution},iw)':-2:flags=lanczos"
    filter_complex = (
        f"[0:v]fps={frame_rate},split=2[color_src][alpha_src];"
        f"[color_src]{scale_filter},format=rgb24[color];"
        f"[alpha_src]alphaextract,{scale_filter},format=gray[alpha];"
        "[color][alpha]vstack=inputs=2,format=yuv420p[packed]"
    )
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(input_path),
        "-an",
        "-filter_complex",
        filter_complex,
        "-map",
        "[packed]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        crf_by_quality[quality],
        "-preset",
        "medium",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    result = run_subprocess_text(command)
    if result.returncode != 0:
        raise DeployError(
            "FFmpeg packed alpha conversion failed.",
            status=500,
            details={"stderr": tail_output(result.stdout, result.stderr), "returncode": result.returncode},
        )
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise DeployError("FFmpeg did not create a packed alpha MP4.", status=500)
    return {
        "fileName": output_path.name,
        "path": str(output_path),
        "size": output_path.stat().st_size,
        "command": command,
    }


def optimizer_choice(value, allowed, label):
    text = str(value or "").strip()
    if text not in allowed:
        raise DeployError(f"Invalid optimizer {label}.", details={"value": value, "allowed": sorted(allowed)})
    return text


def optimizer_stage(value):
    text = str(value or "overlay").strip().lower()
    if text not in {"overlay", "intro", "loop"}:
        return "overlay"
    return text


def write_temp_upload(field, path):
    with path.open("wb") as handle:
        while True:
            chunk = field.file.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)


def save_library_target(form):
    library = parse_library_json(required_form_text(form, "library"))
    target_id = required_form_text(form, "targetId")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}", target_id):
        raise DeployError("targetId must be a lowercase slug.", details={"targetId": target_id})

    target = find_target(library, target_id)
    if not target:
        raise DeployError("targetId was not found in library payload.", details={"targetId": target_id})

    target_image = required_form_file(form, "targetImage")
    overlay_video = required_form_file(form, "overlayVideo")
    overlay_loop_video = optional_form_file(form, "overlayLoopVideo")
    overlay_packed_video = optional_form_file(form, "overlayPackedVideo")
    overlay_loop_packed_video = optional_form_file(form, "overlayLoopPackedVideo")
    targets_mind = required_form_file(form, "targetsMind")

    target_ext = image_extension(target_image.filename)
    overlay_ext = overlay_extension(overlay_video.filename)
    overlay_loop_ext = overlay_extension(overlay_loop_video.filename) if overlay_loop_video is not None else None
    packed_path = target.get("overlayPackedPath")
    loop_path = target.get("overlayLoopPath")
    loop_packed_path = target.get("overlayLoopPackedPath")

    if target.get("imagePath") != f"./assets/targets/{target_id}{target_ext}":
        raise DeployError("library imagePath does not match targetId.", details={"imagePath": target.get("imagePath")})
    if target.get("overlayPath") != f"./assets/overlays/{target_id}{overlay_ext}":
        raise DeployError("library overlayPath does not match targetId.", details={"overlayPath": target.get("overlayPath")})
    if overlay_loop_video is not None:
        expected_loop_path = f"./assets/overlays/{target_id}-loop{overlay_loop_ext}"
        if loop_path != expected_loop_path:
            raise DeployError(
                "library overlayLoopPath does not match targetId.",
                details={"overlayLoopPath": loop_path, "expected": expected_loop_path},
            )
    elif loop_path:
        raise DeployError(
            "Library target expects a loop overlay, but overlayLoopVideo was not uploaded.",
            details={"overlayLoopPath": loop_path},
        )

    if overlay_packed_video is not None:
        packed_ext = overlay_extension(overlay_packed_video.filename)
        if packed_ext != ".mp4":
            raise DeployError(
                "Packed alpha overlay must be an MP4.",
                details={"filename": overlay_packed_video.filename},
            )
        expected_packed_path = f"./assets/overlays/{target_id}-packed.mp4"
        if packed_path != expected_packed_path:
            raise DeployError(
                "library overlayPackedPath does not match targetId.",
                details={
                    "overlayPackedPath": packed_path,
                    "expected": expected_packed_path,
                },
            )
    elif packed_path:
        raise DeployError(
            "Library target expects a packed overlay, but overlayPackedVideo was not uploaded.",
            details={"overlayPackedPath": packed_path},
        )
    if overlay_loop_packed_video is not None:
        loop_packed_ext = overlay_extension(overlay_loop_packed_video.filename)
        if loop_packed_ext != ".mp4":
            raise DeployError(
                "Packed alpha loop overlay must be an MP4.",
                details={"filename": overlay_loop_packed_video.filename},
            )
        expected_loop_packed_path = f"./assets/overlays/{target_id}-loop-packed.mp4"
        if loop_packed_path != expected_loop_packed_path:
            raise DeployError(
                "library overlayLoopPackedPath does not match targetId.",
                details={
                    "overlayLoopPackedPath": loop_packed_path,
                    "expected": expected_loop_packed_path,
                },
            )
    elif loop_packed_path:
        raise DeployError(
            "Library target expects a packed loop overlay, but overlayLoopPackedVideo was not uploaded.",
            details={"overlayLoopPackedPath": loop_packed_path},
        )

    normalized_library = normalize_library(library)

    TARGETS_DIR.mkdir(parents=True, exist_ok=True)
    OVERLAYS_DIR.mkdir(parents=True, exist_ok=True)
    write_uploaded_file(target_image, TARGETS_DIR / f"{target_id}{target_ext}")
    write_uploaded_file(overlay_video, OVERLAYS_DIR / f"{target_id}{overlay_ext}")
    if overlay_loop_video is not None:
        write_uploaded_file(overlay_loop_video, OVERLAYS_DIR / f"{target_id}-loop{overlay_loop_ext}")
    if overlay_packed_video is not None:
        write_uploaded_file(
            overlay_packed_video,
            OVERLAYS_DIR / f"{target_id}-packed.mp4",
        )
    if overlay_loop_packed_video is not None:
        write_uploaded_file(
            overlay_loop_packed_video,
            OVERLAYS_DIR / f"{target_id}-loop-packed.mp4",
        )
    write_uploaded_file(targets_mind, TARGETS_MIND_PATH)
    write_library_js(normalized_library)

    written_files = [
        f"assets/targets/{target_id}{target_ext}",
        f"assets/overlays/{target_id}{overlay_ext}",
    ]
    if overlay_loop_video is not None:
        written_files.append(f"assets/overlays/{target_id}-loop{overlay_loop_ext}")
    if overlay_packed_video is not None:
        written_files.append(f"assets/overlays/{target_id}-packed.mp4")
    if overlay_loop_packed_video is not None:
        written_files.append(f"assets/overlays/{target_id}-loop-packed.mp4")
    written_files.extend([
        "assets/targets.mind",
        "src/ar-library.js",
    ])

    return {
        "changed": True,
        "targetId": target_id,
        "activeTargets": len([target for target in normalized_library["targets"] if target.get("enabled")]),
        "writtenFiles": written_files,
        "library": normalized_library,
    }


def delete_library_target(form):
    library = parse_library_json(required_form_text(form, "library"))
    target_id = required_form_text(form, "targetId")
    base_updated_at = required_form_text(form, "baseUpdatedAt")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}", target_id):
        raise DeployError("targetId must be a lowercase slug.", details={"targetId": target_id})

    targets_mind = required_form_file(form, "targetsMind")
    current_library = read_library_js()
    current_target = find_target(current_library, target_id)
    if not current_target:
        raise DeployError("targetId was not found in src/ar-library.js.", status=404, details={"targetId": target_id})

    current_updated_at = str(current_target.get("updatedAt") or "")
    if current_updated_at != base_updated_at:
        raise DeployError(
            "Target changed since Creator loaded. Refresh creator.html before deleting.",
            status=409,
            details={
                "targetId": target_id,
                "currentUpdatedAt": current_updated_at,
                "baseUpdatedAt": base_updated_at,
            },
        )

    if find_target(library, target_id):
        raise DeployError("Deleted target is still present in the next library payload.", details={"targetId": target_id})

    normalized_library = normalize_library(library)
    active_targets = [target for target in normalized_library["targets"] if target.get("enabled")]
    if not active_targets:
        raise DeployError("Cannot delete the last enabled target in this prototype.")

    moved_files = move_target_assets_to_deleted(current_target)
    write_uploaded_file(targets_mind, TARGETS_MIND_PATH)
    write_library_js(normalized_library)

    return {
        "changed": True,
        "targetId": target_id,
        "activeTargets": len(active_targets),
        "writtenFiles": [
            "assets/targets.mind",
            "src/ar-library.js",
        ],
        "movedFiles": moved_files,
        "library": normalized_library,
    }


def list_deleted_targets():
    deleted_targets = []
    if not DELETED_DIR.exists():
        return {"deletedTargets": deleted_targets}

    for folder in DELETED_DIR.iterdir():
        if not folder.is_dir():
            continue
        try:
            manifest = read_deleted_manifest(folder.name)
        except DeployError:
            continue
        deleted_targets.append(manifest)

    deleted_targets.sort(key=lambda item: item.get("deletedAt", ""), reverse=True)
    return {"deletedTargets": deleted_targets}


def restore_library_target(form):
    library = parse_library_json(required_form_text(form, "library"))
    target_id = required_form_text(form, "targetId")
    deleted_folder = required_form_text(form, "deletedFolder")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}", target_id):
        raise DeployError("targetId must be a lowercase slug.", details={"targetId": target_id})

    targets_mind = required_form_file(form, "targetsMind")
    current_library = read_library_js()
    if find_target(current_library, target_id):
        raise DeployError("Target already exists in src/ar-library.js.", status=409, details={"targetId": target_id})

    deleted_manifest = read_deleted_manifest(deleted_folder)
    if deleted_manifest.get("targetId") != target_id:
        raise DeployError(
            "Deleted target metadata does not match targetId.",
            details={"targetId": target_id, "deletedTargetId": deleted_manifest.get("targetId")},
        )

    restored_target = find_target(library, target_id)
    if not restored_target:
        raise DeployError("Restored target is missing from the next library payload.", details={"targetId": target_id})

    normalized_library = normalize_library(library)
    active_targets = [target for target in normalized_library["targets"] if target.get("enabled")]
    if not active_targets:
        raise DeployError("Restored library must contain at least one enabled target.")

    moved_files = restore_target_assets(deleted_manifest)
    write_uploaded_file(targets_mind, TARGETS_MIND_PATH)
    write_library_js(normalized_library)

    return {
        "changed": True,
        "targetId": target_id,
        "activeTargets": len(active_targets),
        "writtenFiles": [
            "assets/targets.mind",
            "src/ar-library.js",
            *moved_files,
        ],
        "library": normalized_library,
    }


def clear_deleted_targets(payload):
    if str(payload.get("confirmationText") or "") != "DELETE":
        raise DeployError("Type DELETE to permanently clear deleted targets.", status=409)

    deleted_folders = []
    if not DELETED_DIR.exists():
        return {"deletedCount": 0, "deletedFolders": deleted_folders}

    for folder in DELETED_DIR.iterdir():
        if not folder.is_dir():
            continue
        manifest_path = folder / "delete-manifest.json"
        if not manifest_path.exists():
            continue
        resolved = folder.resolve()
        if DELETED_DIR.resolve() not in resolved.parents:
            raise DeployError("Deleted folder cannot escape assets/_deleted.", details={"path": str(folder)})
        deleted_folders.append(normalize_repo_path(folder.relative_to(ROOT)))

    for repo_path in deleted_folders:
        shutil.rmtree(ROOT / repo_path)

    return {
        "deletedCount": len(deleted_folders),
        "deletedFolders": deleted_folders,
    }


def save_library_overlay(payload):
    target_id = str(payload.get("targetId", "")).strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}", target_id):
        raise DeployError("targetId must be a lowercase slug.", details={"targetId": target_id})

    next_overlay = overlay_to_library(validate_overlay(payload.get("overlay"), "overlay"))
    base_updated_at = str(payload.get("baseUpdatedAt") or "")
    library = read_library_js()
    target = find_target(library, target_id)
    if not target:
        raise DeployError("targetId was not found in src/ar-library.js.", status=404, details={"targetId": target_id})

    current_updated_at = str(target.get("updatedAt") or "")
    if base_updated_at and current_updated_at != base_updated_at:
        raise DeployError(
            "Target changed since Creator loaded. Refresh creator.html before saving.",
            status=409,
            details={
                "targetId": target_id,
                "currentUpdatedAt": current_updated_at,
                "baseUpdatedAt": base_updated_at,
            },
        )

    target["overlay"] = next_overlay
    target["updatedAt"] = utc_now()
    write_library_js(library)

    return {
        "changed": True,
        "targetId": target_id,
        "updatedAt": target["updatedAt"],
        "writtenFiles": ["src/ar-library.js"],
        "library": library,
    }


def prepare_library_deploy(payload):
    library = read_library_js()
    if payload.get("baseLibraryVersion") != library.get("version"):
        raise DeployError(
            "Library version changed since Creator loaded. Refresh creator.html before preparing deploy.",
            status=409,
            details={"currentVersion": library.get("version"), "baseLibraryVersion": payload.get("baseLibraryVersion")},
        )

    check_stale_targets(payload, library)
    raw_targets = library.get("targets", [])
    enabled_raw_targets = [target for target in raw_targets if target.get("enabled")]
    expected_indexes = list(range(len(enabled_raw_targets)))
    actual_indexes = [target.get("targetIndex") for target in enabled_raw_targets]
    normalized_library = normalize_library(library)
    errors = []
    warnings = []
    files_to_deploy = ["src/ar-library.js", "assets/targets.mind"]
    referenced_targets = set()
    referenced_overlays = set()
    latest_enabled_image_mtime = None
    enabled_targets = [target for target in normalized_library["targets"] if target.get("enabled")]

    if not TARGETS_MIND_PATH.exists():
        errors.append("assets/targets.mind is missing.")
    elif TARGETS_MIND_PATH.stat().st_size <= 0:
        errors.append("assets/targets.mind is empty.")

    for target in normalized_library["targets"]:
        image_repo_path = target["imagePath"][2:]
        image_path = ROOT / image_repo_path
        referenced_targets.add(normalize_repo_path(image_repo_path))
        files_to_deploy.append(normalize_repo_path(image_repo_path))

        if not image_path.exists():
            errors.append(f"{target['id']} image file is missing: {target['imagePath']}")
        elif target.get("enabled"):
            image_mtime = image_path.stat().st_mtime
            latest_enabled_image_mtime = image_mtime if latest_enabled_image_mtime is None else max(latest_enabled_image_mtime, image_mtime)

        for key in ("overlayPath", "overlayLoopPath", "overlayPackedPath", "overlayLoopPackedPath"):
            if not target.get(key):
                continue
            overlay_repo_path = target[key][2:]
            overlay_path = ROOT / overlay_repo_path
            referenced_overlays.add(normalize_repo_path(overlay_repo_path))
            files_to_deploy.append(normalize_repo_path(overlay_repo_path))
            if not overlay_path.exists():
                errors.append(f"{target['id']} {key} file is missing: {target[key]}")

    if actual_indexes != expected_indexes:
        errors.append(f"Enabled targetIndex values must be {expected_indexes}, got {actual_indexes}.")

    if len(enabled_targets) > int(normalized_library.get("maxActiveTargets", MAX_ACTIVE_TARGETS)):
        errors.append("Enabled targets exceed maxActiveTargets.")

    if latest_enabled_image_mtime is not None and TARGETS_MIND_PATH.exists() and TARGETS_MIND_PATH.stat().st_size > 0:
        if TARGETS_MIND_PATH.stat().st_mtime < latest_enabled_image_mtime:
            errors.append("assets/targets.mind is older than an enabled target image. Recompile active targets before deploy.")

    warnings.extend(orphan_asset_warnings(TARGETS_DIR, referenced_targets, "target image"))
    warnings.extend(orphan_asset_warnings(OVERLAYS_DIR, referenced_overlays, "overlay"))

    files_to_deploy = sorted(set(files_to_deploy))
    git_changes = git_working_tree_changes()
    deploy_set = set(files_to_deploy)
    unrelated_changes = [change for change in git_changes if change["path"] not in deploy_set]

    return {
        "ready": not errors,
        "errors": errors,
        "filesToDeploy": files_to_deploy,
        "warnings": warnings,
        "unrelatedChanges": unrelated_changes,
        "librarySummary": {
            "totalTargets": len(normalized_library["targets"]),
            "enabledTargets": len(enabled_targets),
        },
    }


def deploy_library(payload):
    if not DEPLOY_LOCK.acquire(blocking=False):
        raise DeployError("A library deploy is already running.", status=409)

    committed = False
    commit_sha = ""
    files_to_deploy = []

    try:
        validation = prepare_library_deploy(payload)
        if not validation["ready"]:
            raise DeployError("validation failed.", status=409, details={"errors": validation["errors"], "warnings": validation["warnings"]})

        files_to_deploy = validation["filesToDeploy"]
        confirmed_files = payload.get("confirmedFiles")
        if not isinstance(confirmed_files, list):
            raise DeployError("confirmedFiles must be an array.")
        confirmed_set = {normalize_repo_path(path) for path in confirmed_files}
        deploy_set = set(files_to_deploy)
        if confirmed_set != deploy_set:
            raise DeployError(
                "confirmedFiles does not match the current deploy file set.",
                status=409,
                details={"confirmedFiles": sorted(confirmed_set), "filesToDeploy": files_to_deploy},
            )

        validate_deploy_paths(files_to_deploy)
        unstage_all()
        ensure_library_git_ready()

        if not deploy_set_has_changes(files_to_deploy):
            return {
                "deployed": False,
                "changed": False,
                "message": "Nothing new to deploy.",
                "filesDeployed": files_to_deploy,
                "librarySummary": validation["librarySummary"],
            }

        run_git(["add", "--", *files_to_deploy])
        staged = staged_files()
        staged_set = set(staged)
        unexpected_staged = sorted(staged_set - deploy_set)
        if unexpected_staged:
            unstage_all()
            raise DeployError(
                "staged files do not match the deploy file set.",
                status=409,
                details={
                    "expectedDeploySet": files_to_deploy,
                    "actualStagedChangedFiles": staged,
                    "unexpectedStagedFiles": unexpected_staged,
                },
            )
        if not staged:
            return {
                "deployed": False,
                "changed": False,
                "message": "No library changes to deploy.",
                "filesDeployed": files_to_deploy,
                "librarySummary": validation["librarySummary"],
            }

        run_git(["commit", "-m", LIBRARY_DEPLOY_MESSAGE, "--", *files_to_deploy])
        committed = True
        commit_sha = run_git(["rev-parse", "HEAD"]).stdout.strip()

        try:
            run_git(["push", "origin", "main"])
        except DeployError as error:
            raise DeployError(
                "Local commit created but push failed.",
                status=500,
                details={"commitSha": commit_sha, "pushError": error.details},
            )

        return {
            "deployed": True,
            "commitSha": commit_sha,
            "shortCommitSha": commit_sha[:7],
            "branch": "main",
            "remote": "origin/main",
            "filesDeployed": files_to_deploy,
            "librarySummary": validation["librarySummary"],
            "message": "Library deployed successfully.",
        }
    except Exception:
        if files_to_deploy and not committed:
            unstage_all()
        raise
    finally:
        DEPLOY_LOCK.release()


def validate_deploy_paths(paths):
    allowed_prefixes = ("assets/targets/", "assets/overlays/")
    allowed_exact = {"src/ar-library.js", "assets/targets.mind"}

    for path in paths:
        repo_path = normalize_repo_path(path)
        if repo_path != path:
            raise DeployError("Deploy path must use normalized separators.", details={"path": path})
        if repo_path.startswith("/") or re.match(r"^[A-Za-z]:", repo_path) or ".." in Path(repo_path).parts:
            raise DeployError("Deploy path cannot escape the repository.", details={"path": path})
        if repo_path not in allowed_exact and not repo_path.startswith(allowed_prefixes):
            raise DeployError("Deploy path is outside the library deploy allowlist.", details={"path": path})
        resolved = (ROOT / repo_path).resolve()
        if ROOT.resolve() not in resolved.parents:
            raise DeployError("Deploy path resolves outside the repository.", details={"path": path})
        if not resolved.exists():
            raise DeployError("Deploy path does not exist.", details={"path": path})


def ensure_library_git_ready():
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


def deploy_set_has_changes(paths):
    for path in paths:
        if not is_tracked(path):
            return True
    result = run_subprocess_text(["git", "diff", "--quiet", "--", *paths])
    if result.returncode == 1:
        return True
    if result.returncode == 0:
        return False
    raise DeployError(
        "git diff failed.",
        status=500,
        details={"stdout": result.stdout, "stderr": result.stderr, "returncode": result.returncode},
    )


def unstage_files(paths):
    if not paths:
        return
    result = run_subprocess_text(["git", "restore", "--staged", "--", *paths])
    if result.returncode != 0:
        raise DeployError(
            "git restore --staged failed.",
            status=500,
            details={"stdout": result.stdout, "stderr": result.stderr, "returncode": result.returncode},
        )


def unstage_all():
    result = run_subprocess_text(["git", "restore", "--staged", "--", "."])
    if result.returncode != 0:
        raise DeployError(
            "git restore --staged -- . failed.",
            status=500,
            details={"stdout": result.stdout, "stderr": result.stderr, "returncode": result.returncode},
        )


def check_stale_targets(payload, library):
    base_states = payload.get("baseTargetStates")
    if not isinstance(base_states, list):
        raise DeployError("baseTargetStates must be an array.")

    current_targets = {target.get("id"): str(target.get("updatedAt") or "") for target in library.get("targets", [])}
    base_ids = [str(state.get("id", "")).strip() for state in base_states if isinstance(state, dict)]
    if set(base_ids) != set(current_targets):
        raise DeployError(
            "Library targets changed since Creator loaded. Refresh creator.html before preparing deploy.",
            status=409,
            details={"currentTargetIds": sorted(current_targets), "baseTargetIds": sorted(base_ids)},
        )

    for state in base_states:
        if not isinstance(state, dict):
            raise DeployError("Each baseTargetStates item must be an object.")
        target_id = str(state.get("id", "")).strip()
        if target_id not in current_targets:
            raise DeployError("Target changed since Creator loaded. Refresh creator.html before preparing deploy.", status=409, details={"targetId": target_id})
        base_updated_at = str(state.get("updatedAt") or "")
        if current_targets[target_id] != base_updated_at:
            raise DeployError(
                "Target changed since Creator loaded. Refresh creator.html before preparing deploy.",
                status=409,
                details={"targetId": target_id, "currentUpdatedAt": current_targets[target_id], "baseUpdatedAt": base_updated_at},
            )


def orphan_asset_warnings(directory, referenced_paths, label):
    if not directory.exists():
        return []

    warnings = []
    for path in directory.iterdir():
        if not path.is_file():
            continue
        repo_path = normalize_repo_path(path.relative_to(ROOT))
        if repo_path not in referenced_paths:
            warnings.append(f"Orphan {label}: {repo_path}")
    return warnings


def git_working_tree_changes():
    result = run_git(["status", "--porcelain", "--untracked-files=all"])
    changes = []
    for line in result.stdout.splitlines():
        if not line:
            continue
        status = line[:2]
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        changes.append({"status": status.strip() or status, "path": normalize_repo_path(path)})
    return changes


def normalize_repo_path(path):
    return str(path).replace("\\", "/")


def read_library_js():
    text = LIBRARY_PATH.read_text(encoding="utf-8")
    match = re.search(r"window\.AR_LIBRARY\s*=\s*(\{[\s\S]*\})\s*;", text)
    if not match:
        raise DeployError("Cannot find window.AR_LIBRARY in src/ar-library.js.", status=500)
    try:
        library = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise DeployError("Invalid JSON in src/ar-library.js.", status=500, details={"message": str(error)})
    if not isinstance(library, dict) or not isinstance(library.get("targets"), list):
        raise DeployError("src/ar-library.js must contain a library with targets.", status=500)
    return library


def required_form_text(form, name):
    field = form[name] if name in form else None
    if field is None or getattr(field, "file", None) is not None and field.filename:
        raise DeployError(f"Missing form field: {name}")
    value = field.value
    if value is None or value == "":
        raise DeployError(f"Missing form field: {name}")
    return value


def optional_form_text(form, name):
    field = form[name] if name in form else None
    if field is None or getattr(field, "file", None) is not None and field.filename:
        return ""
    return field.value or ""


def required_form_file(form, name):
    field = form[name] if name in form else None
    if field is None or not getattr(field, "filename", ""):
        raise DeployError(f"Missing uploaded file: {name}")
    return field


def optional_form_file(form, name):
    field = form[name] if name in form else None
    if field is None or not getattr(field, "filename", ""):
        return None
    return field


def parse_library_json(text):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise DeployError("Invalid library JSON.", details={"message": str(error)})
    if not isinstance(value, dict):
        raise DeployError("library must be an object.")
    return value


def find_target(library, target_id):
    for target in library.get("targets", []):
        if target.get("id") == target_id:
            return target
    return None


def normalize_library(library):
    if library.get("version") != 1:
        raise DeployError("Unsupported library version.", details={"version": library.get("version")})
    if library.get("targetFile") != "./assets/targets.mind":
        raise DeployError("library targetFile must be ./assets/targets.mind.")
    targets = library.get("targets")
    if not isinstance(targets, list):
        raise DeployError("library.targets must be an array.")

    seen_ids = set()
    active_index = 0
    normalized_targets = []
    for target in targets:
        normalized = normalize_target(target)
        target_id = normalized["id"]
        if target_id in seen_ids:
            raise DeployError("Duplicate target id.", details={"targetId": target_id})
        seen_ids.add(target_id)
        if normalized["enabled"]:
            if active_index >= MAX_ACTIVE_TARGETS:
                raise DeployError("Too many enabled targets.", details={"maximum": MAX_ACTIVE_TARGETS})
            normalized["targetIndex"] = active_index
            active_index += 1
        else:
            normalized["targetIndex"] = None
        normalized_targets.append(normalized)

    return {
        "version": 1,
        "maxActiveTargets": MAX_ACTIVE_TARGETS,
        "targetFile": "./assets/targets.mind",
        "targets": normalized_targets,
    }


def normalize_target(target):
    if not isinstance(target, dict):
        raise DeployError("Each target must be an object.")
    target_id = str(target.get("id", "")).strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}", target_id):
        raise DeployError("Invalid target id.", details={"targetId": target_id})

    image_path = validate_asset_path(target.get("imagePath"), "assets/targets/", {".png", ".jpg", ".jpeg", ".webp"})
    overlay_path = validate_asset_path(target.get("overlayPath"), "assets/overlays/", OVERLAY_EXTENSIONS)
    overlay_loop_path = None
    if target.get("overlayLoopPath"):
        overlay_loop_path = validate_asset_path(target.get("overlayLoopPath"), "assets/overlays/", OVERLAY_EXTENSIONS)
    overlay = validate_overlay(target.get("overlay"), f"target {target_id} overlay")

    overlay_packed_path = None
    overlay_loop_packed_path = None
    overlay_mode = str(target.get("overlayMode") or "video").strip()

    if target.get("overlayPackedPath"):
        overlay_packed_path = validate_asset_path(
            target.get("overlayPackedPath"),
            "assets/overlays/",
            {".mp4"},
        )
        if overlay_mode not in {"auto-alpha", "packed-alpha"}:
            raise DeployError(
                "Invalid overlayMode for packed alpha target.",
                details={
                    "overlayMode": overlay_mode,
                    "allowed": ["auto-alpha", "packed-alpha"],
                },
            )
    else:
        overlay_mode = "video"
    if target.get("overlayLoopPackedPath"):
        overlay_loop_packed_path = validate_asset_path(
            target.get("overlayLoopPackedPath"),
            "assets/overlays/",
            {".mp4"},
        )
        if not overlay_packed_path:
            raise DeployError(
                "overlayLoopPackedPath requires overlayPackedPath.",
                details={"overlayLoopPackedPath": overlay_loop_packed_path},
            )
        if not overlay_loop_path:
            raise DeployError(
                "overlayLoopPackedPath requires overlayLoopPath.",
                details={"overlayLoopPackedPath": overlay_loop_packed_path},
            )

    normalized = {
        "id": target_id,
        "name": str(target.get("name") or target_id).strip()[:80],
        "enabled": bool(target.get("enabled", True)),
        "targetIndex": target.get("targetIndex"),
        "imagePath": image_path,
        "overlayPath": overlay_path,
        "overlayType": "video",
        "overlay": overlay_to_library(overlay),
        "video": normalize_video(target.get("video")),
        "updatedAt": str(target.get("updatedAt") or utc_now()),
    }

    if overlay_packed_path:
        normalized["overlayPackedPath"] = overlay_packed_path
        normalized["overlayMode"] = overlay_mode
    if overlay_loop_path:
        normalized["overlayLoopPath"] = overlay_loop_path
    if overlay_loop_packed_path:
        normalized["overlayLoopPackedPath"] = overlay_loop_packed_path

    return normalized


def validate_asset_path(value, prefix, extensions):
    if not isinstance(value, str) or not value.startswith(f"./{prefix}"):
        raise DeployError("Invalid asset path.", details={"path": value, "prefix": f"./{prefix}"})
    relative = value[2:]
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise DeployError("Asset path cannot escape the repository.", details={"path": value})
    if path.suffix.lower() not in extensions:
        raise DeployError("Unsupported asset extension.", details={"path": value, "extensions": sorted(extensions)})
    return value


def image_extension(filename):
    suffix = Path(filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise DeployError("Target image must be PNG, JPG, or WebP.", details={"filename": filename})
    return suffix


def overlay_extension(filename):
    suffix = Path(filename or "").suffix.lower()
    if suffix not in OVERLAY_EXTENSIONS:
        raise DeployError("Overlay video must be MP4, MOV, or WebM.", details={"filename": filename})
    return suffix


def normalize_video(value):
    source = value if isinstance(value, dict) else {}
    return {
        "autoplay": bool(source.get("autoplay", True)),
        "loop": bool(source.get("loop", True)),
        "muted": bool(source.get("muted", True)),
        "playsInline": bool(source.get("playsInline", True)),
    }


def overlay_to_library(overlay):
    return {
        "width": overlay["width"],
        "height": overlay["height"],
        "position": vector_string(overlay["position"]),
        "rotation": vector_string(overlay["rotation"]),
    }


def write_uploaded_file(field, path):
    resolved = path.resolve()
    if ROOT.resolve() not in resolved.parents:
        raise DeployError("Refusing to write outside repository.", details={"path": str(path)})
    with resolved.open("wb") as handle:
        while True:
            chunk = field.file.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)


def move_target_assets_to_deleted(target):
    deleted_at = utc_now()
    folder_name = f"{target['id']}-{deleted_at.replace(':', '').replace('-', '').replace('Z', 'Z')}"
    destination_dir = DELETED_DIR / folder_name
    destination_dir.mkdir(parents=True, exist_ok=False)
    moved_files = []

    for key in ("imagePath", "overlayPath"):
        source = resolve_repo_asset_path(target.get(key))
        if not source.exists():
            continue
        destination = destination_dir / source.name
        shutil.move(str(source), str(destination))
        moved_files.append(normalize_repo_path(destination.relative_to(ROOT)))

    metadata = {
        "targetId": target["id"],
        "targetName": target.get("name") or target["id"],
        "deletedAt": deleted_at,
        "deleteAfterDays": DELETED_RETENTION_DAYS,
        "originalTarget": target,
        "movedFiles": moved_files,
    }
    metadata_path = destination_dir / "delete-manifest.json"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    moved_files.append(normalize_repo_path(metadata_path.relative_to(ROOT)))
    return moved_files


def read_deleted_manifest(folder_name):
    folder = resolve_deleted_folder(folder_name)
    manifest_path = folder / "delete-manifest.json"
    if not manifest_path.exists():
        raise DeployError("Deleted target manifest was not found.", status=404, details={"deletedFolder": folder_name})

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DeployError("Deleted target manifest is invalid.", details={"message": str(error)})

    original_target = manifest.get("originalTarget")
    if not isinstance(original_target, dict):
        raise DeployError("Deleted target manifest is missing originalTarget.", details={"deletedFolder": folder_name})

    manifest["folderName"] = folder.name
    manifest["deletedPath"] = normalize_repo_path(folder.relative_to(ROOT))
    manifest["imagePath"] = deleted_preview_path(manifest, {".png", ".jpg", ".jpeg", ".webp"})
    manifest["overlayPath"] = deleted_preview_path(manifest, OVERLAY_EXTENSIONS)
    manifest["expiresAt"] = deleted_expiry(manifest.get("deletedAt"))
    return manifest


def resolve_deleted_folder(folder_name):
    name = str(folder_name or "").strip()
    if not name or Path(name).name != name:
        raise DeployError("Invalid deleted folder.", details={"deletedFolder": folder_name})
    folder = (DELETED_DIR / name).resolve()
    if DELETED_DIR.resolve() not in folder.parents:
        raise DeployError("Deleted folder cannot escape assets/_deleted.", details={"deletedFolder": folder_name})
    if not folder.exists() or not folder.is_dir():
        raise DeployError("Deleted target folder was not found.", status=404, details={"deletedFolder": folder_name})
    return folder


def deleted_preview_path(manifest, extensions):
    for repo_path in manifest.get("movedFiles", []):
        path = Path(str(repo_path))
        if path.suffix.lower() in extensions:
            return f"./{normalize_repo_path(repo_path)}"
    return ""


def deleted_expiry(deleted_at):
    try:
        expires_at = parse_utc_timestamp(str(deleted_at or "")) + datetime.timedelta(days=DELETED_RETENTION_DAYS)
    except ValueError:
        return ""
    return expires_at.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def restore_target_assets(deleted_manifest):
    folder = resolve_deleted_folder(deleted_manifest["folderName"])
    original_target = deleted_manifest["originalTarget"]
    planned_moves = []

    for key in ("imagePath", "overlayPath"):
        destination = resolve_repo_asset_path(original_target.get(key))
        source = folder / destination.name
        if not source.exists():
            raise DeployError(
                "Deleted asset file is missing.",
                status=404,
                details={"source": normalize_repo_path(source.relative_to(ROOT))},
            )
        if destination.exists():
            raise DeployError(
                "Refusing to restore because the destination asset already exists.",
                status=409,
                details={"destination": normalize_repo_path(destination.relative_to(ROOT))},
            )
        planned_moves.append((source, destination))

    moved_files = []
    for source, destination in planned_moves:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
        moved_files.append(normalize_repo_path(destination.relative_to(ROOT)))

    manifest_path = folder / "delete-manifest.json"
    if manifest_path.exists():
        manifest_path.unlink()
    try:
        folder.rmdir()
    except OSError:
        pass

    return moved_files


def resolve_repo_asset_path(value):
    if not isinstance(value, str) or not value.startswith("./assets/"):
        raise DeployError("Invalid target asset path.", details={"path": value})
    relative = Path(value[2:])
    if relative.is_absolute() or ".." in relative.parts:
        raise DeployError("Asset path cannot escape the repository.", details={"path": value})
    resolved = (ROOT / relative).resolve()
    if ROOT.resolve() not in resolved.parents:
        raise DeployError("Asset path resolves outside repository.", details={"path": value})
    return resolved


def write_library_js(library):
    text = "(function () {\n  window.AR_LIBRARY = "
    text += json.dumps(library, ensure_ascii=False, indent=2)
    text += ";\n})();\n"
    LIBRARY_PATH.write_text(text, encoding="utf-8")


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
        result = run_subprocess_text(["git", "diff", "--quiet", "--", CONFIG_REPO_PATH])
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
    result = run_subprocess_text(["git", "ls-files", "--error-unmatch", path])
    return result.returncode == 0


def staged_files():
    result = run_git(["diff", "--cached", "--name-only"])
    return [line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()]


def run_git(args):
    result = run_subprocess_text(["git", *args])
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


def cleanup_expired_deleted_assets():
    if not DELETED_DIR.exists():
        return []

    deleted_paths = []
    now = datetime.datetime.now(datetime.timezone.utc)
    for folder in DELETED_DIR.iterdir():
        if not folder.is_dir():
            continue
        manifest_path = folder / "delete-manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            deleted_at = parse_utc_timestamp(str(manifest.get("deletedAt") or ""))
        except (json.JSONDecodeError, ValueError):
            continue

        age = now - deleted_at
        if age.days < DELETED_RETENTION_DAYS:
            continue

        shutil.rmtree(folder)
        deleted_paths.append(normalize_repo_path(folder.relative_to(ROOT)))

    return deleted_paths


def parse_utc_timestamp(value):
    if not value.endswith("Z"):
        raise ValueError("timestamp must end with Z")
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def main():
    parser = argparse.ArgumentParser(description="Local creator helper for Print Image AR Starter.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    args = parser.parse_args()

    if args.host != "127.0.0.1":
        raise SystemExit("creator_helper.py only supports --host 127.0.0.1")

    removed_deleted_assets = cleanup_expired_deleted_assets()
    cleanup_packed_cache()
    for path in removed_deleted_assets:
        print(f"Removed expired deleted asset folder: {path}")

    server = ThreadingHTTPServer((args.host, args.port), CreatorHelperHandler)
    print(f"Creator helper running at http://{args.host}:{args.port}/creator.html")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping creator helper.")


if __name__ == "__main__":
    main()
