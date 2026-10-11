#!/usr/bin/python3
"""Private outbound readiness and encrypted checkpoint bridge; no Gateway writes."""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import struct
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid

try:
    import fcntl
    import resource
except ImportError:  # The installed service requires Linux; pure tests are portable.
    fcntl = None
    resource = None


MAX_CIPHER = 16 * 1024 * 1024
MAX_RESPONSE = 16 * 1024
MIN_AVAILABLE_BYTES = 1024 * 1024 * 1024
MIN_AVAILABLE_INODES = 1024
FUNCTION_PATH = "/functions/v1/reaper-gateway-operations"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}\Z")
ISO = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\Z")
MAGIC = b"MOCHIRII-GATEWAY-CHECKPOINT-v1\n"
AGE_VERSION = b"v1.3.2\n"
# Official v1.3.2 linux-amd64 release metadata. Installation must also verify
# the archive's Sigsum proof using the tag-pinned official SIGSUM.md policy.
AGE_ARCHIVE_SHA256 = "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10"
AGE_PROOF_SHA256 = "98402fa59b4e433426156b4a7e74a32e44902e0434c61158f7de18ffc84f1f97"
AGE_BINARY_SHA256 = "eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c"
CONTAINER = "mochirii-reaper-gateway"


class Unavailable(Exception):
    """Fixed category only; underlying payloads, paths and errors stay private."""


def require(condition: bool) -> None:
    if not condition:
        raise Unavailable()


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def parse_json(source: bytes) -> dict:
    require(b"\xef\xbb\xbf" not in source)
    try:
        result = json.loads(source.decode("utf-8", errors="strict"), object_pairs_hook=unique_object,
                            parse_constant=lambda _: (_ for _ in ()).throw(Unavailable()))
        require(type(result) is dict)
        return result
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Unavailable() from error


def iso_time(value: object) -> float:
    require(type(value) is str and ISO.fullmatch(value) is not None)
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
        require(parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") == value)
        return parsed.timestamp()
    except (ValueError, OverflowError) as error:
        raise Unavailable() from error


def now_iso(now: float) -> str:
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def check_metadata(info: os.stat_result, owner: int, mode: int, maximum: int) -> None:
    require(stat.S_ISREG(info.st_mode) and info.st_uid == owner and
            stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1 and 0 <= info.st_size <= maximum)


def check_directory(info: os.stat_result, owner: int) -> None:
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o700)


def check_ancestry(path: Path, owner: int) -> None:
    require(path.is_absolute())
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner) and
                stat.S_IMODE(info.st_mode) & 0o022 == 0)


def private_read(path: Path, maximum: int, owner: int = 0, mode: int = 0o600) -> bytes:
    check_ancestry(path, owner)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        check_metadata(os.fstat(descriptor), owner, mode, maximum)
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(maximum + 1)
        require(len(data) <= maximum)
        return data
    finally:
        os.close(descriptor)


def private_optional(path: Path, maximum: int) -> bytes | None:
    try:
        return private_read(path, maximum)
    except FileNotFoundError:
        return None


def atomic_write(path: Path, source: bytes) -> None:
    check_ancestry(path, 0)
    try:
        check_metadata(path.lstat(), 0, 0o600, MAX_CIPHER + 4096)
    except FileNotFoundError:
        pass
    temporary = path.with_name(path.name + "." + str(uuid.uuid4()) + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
    try:
        position = 0
        while position < len(source):
            written = os.write(descriptor, source[position:])
            require(0 < written <= len(source) - position)
            position += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary.exists():
            temporary.unlink()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def env_file(source: bytes, allowed: set[str]) -> dict[str, str]:
    require(b"\0" not in source and b"\r" not in source and b"\xef\xbb\xbf" not in source)
    result = {}
    for line in source.decode("utf-8", errors="strict").splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(bool(separator) and key in allowed and key not in result and value == value.strip())
        require(all(ord(character) >= 32 and ord(character) != 127 for character in value))
        result[key] = value
    return result


class Config:
    def __init__(self, values: dict[str, str], image: str):
        self.url = values.get("REAPER_GATEWAY_OPERATIONS_URL", "")
        parsed = urlsplit(self.url)
        require(parsed.scheme == "https" and parsed.path == FUNCTION_PATH and not parsed.query and
                not parsed.fragment and parsed.netloc == parsed.hostname and "." in parsed.netloc and
                re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", parsed.netloc) is not None and
                ".." not in parsed.netloc)
        try:
            ipaddress.ip_address(parsed.netloc)
        except ValueError:
            pass
        else:
            raise Unavailable()
        self.host = parsed.netloc
        self.key = values.get("REAPER_GATEWAY_OPERATIONS_HMAC_KEY", "").encode("utf-8")
        require(32 <= len(self.key) <= 256)
        required = values.get("REAPER_GATEWAY_OPERATIONS_BACKUP_REQUIRED", "")
        require(required in ("true", "false"))
        self.backup_required = required == "true"
        self.recipient = values.get("REAPER_GATEWAY_OPERATIONS_AGE_RECIPIENT", "")
        if self.backup_required:
            require(re.fullmatch(r"age1[ac-hj-np-z02-9]{58}", self.recipient) is not None)
        require(IMAGE.fullmatch(image) is not None and len(image) <= 300)
        self.image = image


CONFIG_KEYS = {"REAPER_GATEWAY_OPERATIONS_URL", "REAPER_GATEWAY_OPERATIONS_HMAC_KEY",
               "REAPER_GATEWAY_OPERATIONS_BACKUP_REQUIRED", "REAPER_GATEWAY_OPERATIONS_AGE_RECIPIENT"}


@contextlib.contextmanager
def deadline(seconds: int):
    if not hasattr(signal, "setitimer"):
        yield
        return
    prior = signal.getsignal(signal.SIGALRM)
    def expire(_signal, _frame):
        raise Unavailable()
    signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior)


class Remote:
    def __init__(self, config: Config):
        self.config = config

    def request(self, method: str, suffix: str, body: bytes = b"", captured_at: str = "") -> dict:
        path = FUNCTION_PATH + suffix
        receipt_read = method == "GET" and suffix.startswith("/receipts/") and UUID.fullmatch(suffix[10:]) is not None
        upload = method == "POST" and suffix.startswith("/checkpoints/") and UUID.fullmatch(suffix[13:]) is not None
        heartbeat = method == "POST" and suffix == "/heartbeat"
        require(type(body) is bytes and (receipt_read or upload or heartbeat) and "?" not in path and "#" not in path)
        require((receipt_read and not body and not captured_at) or
                (heartbeat and len(body) <= 1024 and not captured_at) or
                (upload and 64 <= len(body) <= MAX_CIPHER and captured_at != ""))
        if upload:
            iso_time(captured_at)
        timestamp, nonce = str(int(time.time())), str(uuid.uuid4())
        digest = hashlib.sha256(body).hexdigest()
        canonical = "\n".join(("v1", method, path, timestamp, nonce, digest, captured_at)).encode("utf-8")
        headers = {"accept": "application/json", "accept-encoding": "identity", "content-length": str(len(body)),
                   "x-reaper-timestamp": timestamp, "x-reaper-nonce": nonce, "x-reaper-content-sha256": digest,
                   "x-reaper-signature": hmac.new(self.config.key, canonical, hashlib.sha256).hexdigest()}
        if method == "POST":
            headers["content-type"] = "application/octet-stream" if captured_at else "application/json"
        if captured_at:
            headers["x-reaper-captured-at"] = captured_at
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        connection = http.client.HTTPSConnection(self.config.host, 443, timeout=5, context=context)
        try:
            with deadline(15 if captured_at else 5):
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                allowed = (200, 202, 409) if captured_at else (200,)
                require(response.status in allowed and
                        response.getheader("content-type", "").lower() in ("application/json", "application/json; charset=utf-8") and
                        response.getheader("content-encoding", "identity").lower() == "identity")
                length = response.getheader("content-length")
                require(length is None or (re.fullmatch(r"0|[1-9][0-9]{0,5}", length) is not None and int(length) <= MAX_RESPONSE))
                raw = response.read(MAX_RESPONSE + 1)
                require(len(raw) <= MAX_RESPONSE and (length is None or len(raw) == int(length)))
                value = parse_json(raw)
                if upload:
                    require((response.status, value.get("state")) in (
                        (200, "accepted"), (202, "pending"), (409, "blocked"), (409, "retired")))
                return value
        finally:
            connection.close()


def command(arguments: list[str], maximum: int = 4096, source: bytes | None = None,
            output=None, timeout: int = 4) -> tuple[int, bytes]:
    def child_limit():
        if resource is not None:
            resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))
    with tempfile.TemporaryFile() as temporary:
        target = output if output is not None else temporary
        result = subprocess.run(arguments, input=source, stdout=target, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                preexec_fn=child_limit if os.name == "posix" else None)
        if output is not None:
            return result.returncode, b""
        temporary.seek(0)
        data = temporary.read(maximum + 1)
        require(len(data) <= maximum)
        return result.returncode, data


def readiness(image: str, latch: Path) -> bool:
    try:
        try:
            private_read(latch, 256)
        except FileNotFoundError:
            pass
        else:
            return False
        if command(["/usr/bin/systemctl", "is-active", "--quiet", CONTAINER + ".service"])[0] != 0:
            return False
        code, expected = command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", image])
        require(code == 0 and re.fullmatch(rb"sha256:[0-9a-f]{64}\n", expected) is not None)
        template = "{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.Image}}|{{index .Config.Labels \"com.docker.compose.project\"}}|{{index .Config.Labels \"com.docker.compose.service\"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"
        code, inspected = command(["/usr/bin/docker", "inspect", "--type", "container", "--format", template, CONTAINER])
        require(code == 0)
        fields = inspected.decode("ascii").rstrip("\n").split("|")
        require(len(fields) == 8 and re.fullmatch(r"[0-9a-f]{64}", fields[0]) is not None and
                fields[1:6] == ["/" + CONTAINER, image, expected.decode("ascii").strip(), CONTAINER, "gateway"] and
                fields[6] == "running" and fields[7] in ("healthy", "unhealthy"))
        return command(["/usr/bin/docker", "exec", fields[0], "/nodejs/bin/node", "dist/healthcheck.js"])[0] == 0
    except (Unavailable, OSError, ValueError, subprocess.SubprocessError):
        return False


def storage_capacity(gateway: Path, operations: Path) -> bool:
    """Observe private directory metadata only; reserves are not disk quotas."""
    try:
        for path, owner in ((gateway, 65532), (operations, 0)):
            check_ancestry(path, owner)
            before = path.lstat()
            check_directory(before, owner)
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) |
                                 getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            try:
                opened = os.fstat(descriptor)
                check_directory(opened, owner)
                volume = os.fstatvfs(descriptor)
                after = os.fstat(descriptor)
                current = path.lstat()
                identity = (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid)
                require(all((info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid) == identity
                            for info in (opened, after, current)))
                check_ancestry(path, owner)
                counts = (volume.f_frsize, volume.f_blocks, volume.f_bfree, volume.f_bavail,
                          volume.f_files, volume.f_ffree, volume.f_favail, volume.f_flag)
                require(all(type(value) is int and value >= 0 for value in counts) and
                        volume.f_frsize > 0 and 0 <= volume.f_bavail <= volume.f_bfree <= volume.f_blocks and
                        0 <= volume.f_favail <= volume.f_ffree <= volume.f_files and
                        not volume.f_flag & getattr(os, "ST_RDONLY", 1))
                require(volume.f_bavail * volume.f_frsize > MIN_AVAILABLE_BYTES and
                        volume.f_favail > MIN_AVAILABLE_INODES)
            finally:
                os.close(descriptor)
        return True
    except (Unavailable, OSError, ValueError, AttributeError):
        return False


def checkpoint(snapshot_path: Path, status_path: Path, now: float | None = None) -> tuple[dict, dict, bytes]:
    require(snapshot_path.parent == status_path.parent)
    check_directory(snapshot_path.parent.lstat(), 65532)
    for _attempt in range(2):
        marker = parse_json(private_read(status_path, 1024, owner=65532))
        source = private_read(snapshot_path, MAX_CIPHER, owner=65532)
        snapshot = parse_json(source)
        require(set(marker) == {"schemaVersion", "checkpointId", "checkpointSha256", "checkpointCreatedAt", "checkedAt"} and
                set(snapshot) == {"schemaVersion", "checkpointId", "createdAt", "forwardingEnabled", "admissionHeld", "entries"})
        require(type(snapshot["schemaVersion"]) is int and snapshot["schemaVersion"] == 1 and
                type(marker["schemaVersion"]) is int and marker["schemaVersion"] == 1 and
                type(snapshot["checkpointId"]) is str and UUID.fullmatch(snapshot["checkpointId"]) is not None and
                type(snapshot["forwardingEnabled"]) is bool and snapshot["forwardingEnabled"] and
                type(snapshot["admissionHeld"]) is bool and type(snapshot["entries"]) is list and len(snapshot["entries"]) <= 256)
        created = iso_time(snapshot["createdAt"])
        checked = iso_time(marker["checkedAt"])
        current = time.time() if now is None else now
        require(created <= checked <= current and current - checked <= 900)
        if (marker["checkpointId"] != snapshot["checkpointId"] or marker["checkpointCreatedAt"] != snapshot["createdAt"] or
                marker["checkpointSha256"] != hashlib.sha256(source).hexdigest()):
            continue
        previous = ""
        for entry in snapshot["entries"]:
            require(type(entry) is dict and set(entry) == {"filename", "record"} and type(entry["record"]) is dict and
                    type(entry["filename"]) is str and
                    re.fullmatch(r"[0-9]{16}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json", entry["filename"]) is not None and
                    entry["filename"] > previous)
            previous = entry["filename"]
        return snapshot, marker, source
    raise Unavailable()


META_KEYS = {"version", "request_id", "captured_at", "plaintext_sha256", "ciphertext_sha256", "ciphertext_bytes"}


def metadata(value: dict) -> dict:
    require(set(value) == META_KEYS and type(value["version"]) is int and value["version"] == 1 and
            type(value["request_id"]) is str and UUID.fullmatch(value["request_id"]) is not None and
            type(value["plaintext_sha256"]) is str and SHA.fullmatch(value["plaintext_sha256"]) is not None and
            type(value["ciphertext_sha256"]) is str and SHA.fullmatch(value["ciphertext_sha256"]) is not None and
            type(value["ciphertext_bytes"]) is int and 64 <= value["ciphertext_bytes"] <= MAX_CIPHER)
    iso_time(value["captured_at"])
    return value


class Store:
    def __init__(self, directory: Path):
        self.directory = directory

    def accepted(self) -> dict | None:
        source = private_optional(self.directory / "accepted.json", 1024)
        return None if source is None else metadata(parse_json(source))

    def pending(self) -> tuple[dict, bytes] | None:
        source = private_optional(self.directory / "pending.bin", len(MAGIC) + 4 + 1024 + MAX_CIPHER)
        if source is None:
            return None
        require(source.startswith(MAGIC) and len(source) > len(MAGIC) + 4)
        size = struct.unpack(">I", source[len(MAGIC):len(MAGIC) + 4])[0]
        require(1 <= size <= 1024 and len(source) > len(MAGIC) + 4 + size)
        offset = len(MAGIC) + 4
        meta = metadata(parse_json(source[offset:offset + size]))
        cipher = source[offset + size:]
        require(cipher.startswith(b"age-encryption.org/v1\n") and len(cipher) == meta["ciphertext_bytes"] and
                hashlib.sha256(cipher).hexdigest() == meta["ciphertext_sha256"])
        return meta, cipher

    def save_pending(self, meta: dict, cipher: bytes) -> None:
        require(self.pending() is None)
        encoded = canonical_json(metadata(meta))
        atomic_write(self.directory / "pending.bin", MAGIC + struct.pack(">I", len(encoded)) + encoded + cipher)

    def accept(self, meta: dict) -> None:
        atomic_write(self.directory / "accepted.json", canonical_json(metadata(meta)))

    def clear_accepted_pending(self, meta: dict) -> None:
        pending = self.pending()
        require(self.accepted() == meta and pending is not None and pending[0] == meta)
        (self.directory / "pending.bin").unlink()
        fsync_directory(self.directory)


def encrypt(source: bytes, config: Config, age_path: Path, directory: Path) -> bytes:
    check_ancestry(age_path, 0)
    descriptor = os.open(age_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        check_metadata(os.fstat(descriptor), 0, 0o755, 64 * 1024 * 1024)
        with os.fdopen(descriptor, "rb", closefd=False) as binary:
            digest = hashlib.file_digest(binary, "sha256").hexdigest()
        require(digest == AGE_BINARY_SHA256)
    finally:
        os.close(descriptor)
    code, version = command([str(age_path), "--version"], maximum=64)
    require(code == 0 and version == AGE_VERSION)
    with tempfile.TemporaryFile(dir=directory) as output:
        code, _ = command([str(age_path), "--encrypt", "--recipient", config.recipient, "--output", "-"],
                          maximum=MAX_CIPHER, source=source, output=output, timeout=10)
        require(code == 0)
        output.seek(0)
        cipher = output.read(MAX_CIPHER + 1)
    require(64 <= len(cipher) <= MAX_CIPHER and cipher.startswith(b"age-encryption.org/v1\n"))
    return cipher


def receipt(value: dict, expected: dict) -> str:
    require(set(value) == {"version", "request_id", "state", "captured_at", "ciphertext_sha256", "ciphertext_bytes"} and
            type(value["version"]) is int and value["version"] == 1 and value["request_id"] == expected["request_id"] and
            value["state"] in ("missing", "pending", "accepted", "blocked", "retired"))
    if value["state"] == "missing":
        require(value["captured_at"] is None and value["ciphertext_sha256"] is None and value["ciphertext_bytes"] is None)
    else:
        require(value["captured_at"] == expected["captured_at"] and value["ciphertext_sha256"] == expected["ciphertext_sha256"] and
                type(value["ciphertext_bytes"]) is int and value["ciphertext_bytes"] == expected["ciphertext_bytes"])
    return value["state"]


def sync_pending(store: Store, remote: Remote) -> None:
    pending = store.pending()
    require(pending is not None)
    meta, cipher = pending
    if store.accepted() == meta:
        store.clear_accepted_pending(meta)
        return
    state = receipt(remote.request("GET", "/receipts/" + meta["request_id"]), meta)
    if state == "missing":
        state = receipt(remote.request("POST", "/checkpoints/" + meta["request_id"], cipher, meta["captured_at"]), meta)
    require(state == "accepted")
    store.accept(meta)
    store.clear_accepted_pending(meta)


def backup(config: Config, store: Store, remote: Remote, snapshot_path: Path, status_path: Path,
           age_path: Path, now: float | None) -> tuple[str, str, str, bool]:
    pending = store.pending()
    if pending is not None:
        sync_pending(store, remote)
    snapshot, marker, source = checkpoint(snapshot_path, status_path, now)
    if pending is not None:
        # Finish at most one pending upload per timer run. A newer live state
        # remains unhealthy until the next run rather than extending deadlines.
        require(pending[0]["request_id"] == snapshot["checkpointId"])
    accepted = store.accepted()
    if accepted is None or accepted["request_id"] != snapshot["checkpointId"]:
        cipher = encrypt(source, config, age_path, store.directory)
        meta = {"version": 1, "request_id": snapshot["checkpointId"], "captured_at": snapshot["createdAt"],
                "plaintext_sha256": hashlib.sha256(source).hexdigest(), "ciphertext_sha256": hashlib.sha256(cipher).hexdigest(),
                "ciphertext_bytes": len(cipher)}
        store.save_pending(meta, cipher)
        sync_pending(store, remote)
        accepted = store.accepted()
    require(accepted is not None and accepted["request_id"] == snapshot["checkpointId"] and
            accepted["captured_at"] == snapshot["createdAt"] and accepted["plaintext_sha256"] == hashlib.sha256(source).hexdigest())
    held = snapshot["admissionHeld"] or any(entry["record"].get("status") == "blocked" for entry in snapshot["entries"])
    return snapshot["checkpointId"], snapshot["createdAt"], marker["checkedAt"], held


def run_once(config: Config, store: Store, remote: Remote, snapshot_path: Path, status_path: Path,
             age_path: Path, latch: Path, now: float | None = None) -> bool:
    observed = time.time() if now is None else now
    healthy = readiness(config.image, latch)
    capacity = storage_capacity(snapshot_path.parent, store.directory)
    healthy = healthy and capacity
    checkpoint_id = captured_at = checked_at = None
    if config.backup_required:
        try:
            checkpoint_id, captured_at, checked_at, held = backup(config, store, remote, snapshot_path, status_path, age_path, now)
            healthy = healthy and not held
        except (Unavailable, OSError, ValueError, subprocess.SubprocessError, http.client.HTTPException):
            healthy = False
    heartbeat = {"version": 1, "request_id": str(uuid.uuid4()), "observed_at": now_iso(observed), "healthy": healthy,
                 "checkpoint_id": checkpoint_id, "checkpoint_captured_at": captured_at, "checkpoint_checked_at": checked_at}
    result = remote.request("POST", "/heartbeat", canonical_json(heartbeat))
    require(type(result.get("version")) is int and
            result == {"version": 1, "request_id": heartbeat["request_id"], "state": "accepted"})
    return healthy


def main() -> int:
    try:
        require(os.name == "posix" and os.geteuid() == 0 and fcntl is not None and len(sys.argv) == 1)
        os.umask(0o077)
        values = env_file(private_read(Path("/etc/mochirii-reaper/gateway-operations.env"), 4096), CONFIG_KEYS)
        release = env_file(private_read(Path("/etc/mochirii-reaper/gateway-release.env"), 1024), {"REAPER_GATEWAY_IMAGE"})
        config = Config(values, release.get("REAPER_GATEWAY_IMAGE", ""))
        directory = Path("/var/lib/mochirii-reaper-gateway-operations")
        check_directory(directory.lstat(), 0)
        descriptor = os.open(directory / "lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            check_metadata(os.fstat(descriptor), 0, 0o600, 0)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            healthy = run_once(config, Store(directory), Remote(config),
                               Path("/var/lib/mochirii-reaper/gateway/checkpoint.json"),
                               Path("/var/lib/mochirii-reaper/gateway/checkpoint-status.json"),
                               Path("/opt/mochirii-reaper/bin/age"),
                               Path("/var/lib/mochirii-reaper-gateway-health/recovery-latched"))
            print("Gateway operations: ready" if healthy else "Gateway operations: unavailable")
            return 0 if healthy else 1
        finally:
            os.close(descriptor)
    except Exception:
        print("Gateway operations: unavailable", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
