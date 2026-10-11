"""Synthetic host bridge tests. Never invokes Docker, age, providers or credentials."""

import contextlib
import hashlib
import hmac
import importlib.util
import io
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("gateway_operations", ROOT / "deploy" / "gateway-operations.py")
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)

IDENTITY = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
CREATED = "2026-10-11T00:00:00.000Z"
CHECKED = "2026-10-11T00:05:00.000Z"
NOW = ops.iso_time(CHECKED)
IMAGE = "registry.example.test/community/gateway@sha256:" + "a" * 64
CIPHER = b"age-encryption.org/v1\n" + b"synthetic-ciphertext-" * 8
KEY = "synthetic-operations-test-key-only-1234567890"


def config(backup=True):
    return ops.Config({"REAPER_GATEWAY_OPERATIONS_URL": "https://operations.example.test" + ops.FUNCTION_PATH,
                       "REAPER_GATEWAY_OPERATIONS_HMAC_KEY": KEY,
                       "REAPER_GATEWAY_OPERATIONS_BACKUP_REQUIRED": str(backup).lower(),
                       "REAPER_GATEWAY_OPERATIONS_AGE_RECIPIENT": "age1" + "q" * 58}, IMAGE)


def document(identity=IDENTITY):
    return {"schemaVersion": 1, "checkpointId": identity, "createdAt": CREATED,
            "forwardingEnabled": True, "admissionHeld": False, "entries": []}


def meta(identity=IDENTITY, source=None):
    source = ops.canonical_json(document(identity)) if source is None else source
    return {"version": 1, "request_id": identity, "captured_at": CREATED,
            "plaintext_sha256": hashlib.sha256(source).hexdigest(),
            "ciphertext_sha256": hashlib.sha256(CIPHER).hexdigest(), "ciphertext_bytes": len(CIPHER)}


def remote_receipt(metadata, state):
    return {"version": 1, "request_id": metadata["request_id"], "state": state,
            "captured_at": None if state == "missing" else metadata["captured_at"],
            "ciphertext_sha256": None if state == "missing" else metadata["ciphertext_sha256"],
            "ciphertext_bytes": None if state == "missing" else metadata["ciphertext_bytes"]}


class FakeRemote:
    def __init__(self):
        self.states = {}
        self.calls = []
        self.lose_ack = False

    def request(self, method, suffix, body=b"", captured_at=""):
        self.calls.append((method, suffix, body, captured_at))
        if suffix == "/heartbeat":
            heartbeat = ops.parse_json(body)
            return {"version": 1, "request_id": heartbeat["request_id"], "state": "accepted"}
        identity = suffix.rsplit("/", 1)[1]
        if method == "GET":
            return self.states.get(identity, remote_receipt(meta(identity), "missing"))
        expected = {"request_id": identity, "captured_at": captured_at,
                    "ciphertext_sha256": hashlib.sha256(body).hexdigest(), "ciphertext_bytes": len(body)}
        self.states[identity] = remote_receipt(expected, "accepted")
        if self.lose_ack:
            self.lose_ack = False
            raise OSError("synthetic lost acknowledgement, contains no credential")
        return self.states[identity]


class Fixture:
    def __enter__(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.snapshot = self.directory / "checkpoint.json"
        self.status = self.directory / "checkpoint-status.json"
        self.age = self.directory / "age"
        self.latch = self.directory / "recovery-latched"
        self.store = ops.Store(self.directory)
        self.stack = contextlib.ExitStack()
        # Fixtures intentionally use temporary user-owned paths on Windows and
        # unprivileged Linux CI. Pure metadata tests below exercise root rules.
        self.stack.enter_context(mock.patch.object(ops, "check_ancestry"))
        self.stack.enter_context(mock.patch.object(ops, "check_directory"))
        original = ops.check_metadata
        def fixture_metadata(info, owner, mode, maximum):
            adjusted = SimpleNamespace(st_mode=info.st_mode, st_uid=owner, st_nlink=info.st_nlink, st_size=info.st_size)
            if os.name == "nt":
                adjusted.st_mode = stat.S_IFMT(info.st_mode) | mode
            original(adjusted, owner, mode, maximum)
        self.stack.enter_context(mock.patch.object(ops, "check_metadata", side_effect=fixture_metadata))
        if os.name == "nt":
            self.stack.enter_context(mock.patch.object(ops, "fsync_directory"))
        self.write()
        return self

    def write(self, snapshot=None, checked_at=CHECKED):
        value = document() if snapshot is None else snapshot
        source = ops.canonical_json(value)
        marker = {"schemaVersion": 1, "checkpointId": value["checkpointId"],
                  "checkpointSha256": hashlib.sha256(source).hexdigest(),
                  "checkpointCreatedAt": value["createdAt"], "checkedAt": checked_at}
        self.snapshot.write_bytes(source)
        self.status.write_bytes(ops.canonical_json(marker))
        self.snapshot.chmod(0o600)
        self.status.chmod(0o600)
        return source

    def run(self, remote, backup=True, now=NOW):
        with mock.patch.object(ops, "readiness", return_value=True), mock.patch.object(ops, "encrypt", return_value=CIPHER) as encryption:
            result = ops.run_once(config(backup), self.store, remote, self.snapshot, self.status, self.age, self.latch, now)
            return result, encryption.call_count

    def __exit__(self, *args):
        self.stack.close()
        self.temporary.cleanup()


class ValidationTests(unittest.TestCase):
    def test_json_rejects_duplicate_nested_keys_nonfinite_bom_and_invalid_utf8(self):
        for source in (b'{"a":1,"a":2}', b'{"a":{"b":1,"b":2}}', b'{"a":NaN}',
                       b'\xef\xbb\xbf{}', b'{"a":"\xff"}', b'[]'):
            with self.subTest(source=source), self.assertRaises(ops.Unavailable):
                ops.parse_json(source)

    def test_json_allows_same_key_in_distinct_objects(self):
        self.assertEqual(ops.parse_json(b'{"a":{"x":1},"b":{"x":2}}')["b"]["x"], 2)

    def test_exact_iso_format(self):
        self.assertEqual(ops.now_iso(NOW), CHECKED)
        for value in (CREATED[:-5] + "Z", "2026-02-30T00:00:00.000Z", CREATED.replace("Z", "+00:00"), 1):
            with self.subTest(value=value), self.assertRaises(ops.Unavailable):
                ops.iso_time(value)

    def test_env_file_rejects_unknown_duplicate_export_controls_and_trim(self):
        for source in (b"A=x\nA=y", b"B=x", b"export A=x", b"A=x\r\n", b"A= x", b"A=x\0"):
            with self.subTest(source=source), self.assertRaises(ops.Unavailable):
                ops.env_file(source, {"A"})
        self.assertEqual(ops.env_file(b"# comment\nA=one=two\n", {"A"}), {"A": "one=two"})

    def test_configuration_bounds_and_fixed_origin(self):
        valid = {"REAPER_GATEWAY_OPERATIONS_URL": "https://operations.example.test" + ops.FUNCTION_PATH,
                 "REAPER_GATEWAY_OPERATIONS_HMAC_KEY": KEY, "REAPER_GATEWAY_OPERATIONS_BACKUP_REQUIRED": "false"}
        self.assertFalse(ops.Config(valid, IMAGE).backup_required)
        for url in ("http://operations.example.test" + ops.FUNCTION_PATH,
                    "https://user@operations.example.test" + ops.FUNCTION_PATH,
                    "https://127.0.0.1" + ops.FUNCTION_PATH,
                    valid["REAPER_GATEWAY_OPERATIONS_URL"] + "?x=1",
                    valid["REAPER_GATEWAY_OPERATIONS_URL"] + "/maintenance"):
            changed = dict(valid, REAPER_GATEWAY_OPERATIONS_URL=url)
            with self.subTest(url=url), self.assertRaises(ops.Unavailable):
                ops.Config(changed, IMAGE)
        for changed in (dict(valid, REAPER_GATEWAY_OPERATIONS_HMAC_KEY="short"),
                        dict(valid, REAPER_GATEWAY_OPERATIONS_BACKUP_REQUIRED="true")):
            with self.assertRaises(ops.Unavailable):
                ops.Config(changed, IMAGE)

    def test_metadata_rejects_owner_mode_links_file_type_and_size(self):
        good = dict(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_nlink=1, st_size=10)
        ops.check_metadata(SimpleNamespace(**good), 0, 0o600, 10)
        for changes in ({"st_uid": 1}, {"st_mode": stat.S_IFREG | 0o644}, {"st_nlink": 2},
                        {"st_mode": stat.S_IFLNK | 0o600}, {"st_size": 11}, {"st_size": -1}):
            with self.subTest(changes=changes), self.assertRaises(ops.Unavailable):
                ops.check_metadata(SimpleNamespace(**dict(good, **changes)), 0, 0o600, 10)

    def test_directory_requires_exact_private_owner(self):
        good = dict(st_mode=stat.S_IFDIR | 0o700, st_uid=65532)
        ops.check_directory(SimpleNamespace(**good), 65532)
        for changes in ({"st_uid": 0}, {"st_mode": stat.S_IFDIR | 0o755}, {"st_mode": stat.S_IFLNK | 0o700}):
            with self.assertRaises(ops.Unavailable):
                ops.check_directory(SimpleNamespace(**dict(good, **changes)), 65532)

    def test_receipts_require_exact_identity_and_types(self):
        expected = meta()
        valid = remote_receipt(expected, "accepted")
        self.assertEqual(ops.receipt(valid, expected), "accepted")
        for changes in ({"version": True}, {"request_id": OTHER}, {"ciphertext_sha256": "0" * 64},
                        {"ciphertext_bytes": True}, {"captured_at": CHECKED}, {"extra": 1}, {"state": "unknown"}):
            with self.subTest(changes=changes), self.assertRaises(ops.Unavailable):
                ops.receipt(dict(valid, **changes), expected)


class CheckpointTests(unittest.TestCase):
    def test_matches_snapshot_hash_and_separate_fresh_marker(self):
        with Fixture() as fixture:
            snapshot, marker, source = ops.checkpoint(fixture.snapshot, fixture.status, NOW)
            self.assertEqual(snapshot["checkpointId"], IDENTITY)
            self.assertEqual(marker["checkedAt"], CHECKED)
            self.assertEqual(hashlib.sha256(source).hexdigest(), marker["checkpointSha256"])

    def test_atomic_publication_race_gets_one_bounded_retry(self):
        with Fixture() as fixture:
            old_marker = fixture.status.read_bytes()
            new_source = fixture.write(document(OTHER))
            new_marker = fixture.status.read_bytes()
            with mock.patch.object(ops, "private_read", side_effect=[old_marker, new_source, new_marker, new_source]) as read:
                self.assertEqual(ops.checkpoint(fixture.snapshot, fixture.status, NOW)[0]["checkpointId"], OTHER)
                self.assertEqual(read.call_count, 4)

    def test_persistent_hash_mismatch_stale_future_and_disabled_are_rejected(self):
        with Fixture() as fixture:
            for timestamp in ("2026-10-10T23:00:00.000Z", "2026-10-11T00:05:00.001Z"):
                fixture.write(checked_at=timestamp)
                with self.assertRaises(ops.Unavailable):
                    ops.checkpoint(fixture.snapshot, fixture.status, NOW)
            fixture.write(dict(document(), forwardingEnabled=False))
            with self.assertRaises(ops.Unavailable):
                ops.checkpoint(fixture.snapshot, fixture.status, NOW)
            fixture.write()
            marker = ops.parse_json(fixture.status.read_bytes())
            marker["checkpointSha256"] = "0" * 64
            fixture.status.write_bytes(ops.canonical_json(marker))
            with self.assertRaises(ops.Unavailable):
                ops.checkpoint(fixture.snapshot, fixture.status, NOW)

    def test_unknown_fields_duplicate_entries_and_capacity_are_rejected(self):
        with Fixture() as fixture:
            entry = {"filename": "0000000000000001-" + IDENTITY + ".json", "record": {}}
            for snapshot in (dict(document(), extra=True), dict(document(), entries=[entry, entry]),
                             dict(document(), entries=[entry] * 257),
                             dict(document(), entries=[dict(entry, filename="../checkpoint.json")])):
                fixture.write(snapshot)
                with self.subTest(snapshot=len(snapshot.get("entries", []))), self.assertRaises(ops.Unavailable):
                    ops.checkpoint(fixture.snapshot, fixture.status, NOW)


class DurableFlowTests(unittest.TestCase):
    def test_new_checkpoint_is_durable_before_send_and_unchanged_state_is_not_reencrypted(self):
        with Fixture() as fixture:
            remote = FakeRemote()
            original_request = remote.request
            def request(method, suffix, body=b"", captured_at=""):
                if suffix.startswith("/checkpoints/"):
                    pending = ops.Store(fixture.directory).pending()
                    self.assertEqual(pending[0]["request_id"], IDENTITY)
                    self.assertEqual(pending[1], body)
                return original_request(method, suffix, body, captured_at)
            remote.request = request
            self.assertEqual(fixture.run(remote), (True, 1))
            self.assertIsNone(fixture.store.pending())
            fixture.write(checked_at="2026-10-11T00:06:00.000Z")
            self.assertEqual(fixture.run(remote, now=NOW + 60), (True, 0))
            uploads = [call for call in remote.calls if call[1].startswith("/checkpoints/")]
            self.assertEqual(len(uploads), 1)
            heartbeat = ops.parse_json(remote.calls[-1][2])
            self.assertEqual(heartbeat["checkpoint_checked_at"], "2026-10-11T00:06:00.000Z")
            self.assertEqual(heartbeat["checkpoint_captured_at"], CREATED)

    def test_lost_ack_restart_reconciles_same_uuid_without_reupload(self):
        with Fixture() as fixture:
            remote = FakeRemote()
            remote.lose_ack = True
            self.assertEqual(fixture.run(remote), (False, 1))
            pending = fixture.store.pending()
            self.assertEqual(pending[1], CIPHER)
            self.assertEqual(fixture.run(remote), (True, 0))
            self.assertIsNone(ops.Store(fixture.directory).pending())
            self.assertEqual(len([call for call in remote.calls if call[0] == "POST" and call[1].startswith("/checkpoints/")]), 1)

    def test_missing_after_network_failure_retries_identical_ciphertext(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            remote = FakeRemote()
            self.assertEqual(fixture.run(remote), (True, 0))
            upload = next(call for call in remote.calls if call[1].startswith("/checkpoints/"))
            self.assertEqual((upload[1], upload[2], upload[3]), ("/checkpoints/" + IDENTITY, CIPHER, CREATED))

    def test_pending_blocked_and_retired_hold_without_post_or_reencryption(self):
        for state in ("pending", "blocked", "retired"):
            with self.subTest(state=state), Fixture() as fixture:
                fixture.store.save_pending(meta(), CIPHER)
                remote = FakeRemote()
                remote.states[IDENTITY] = remote_receipt(meta(), state)
                self.assertEqual(fixture.run(remote), (False, 0))
                self.assertEqual(fixture.store.pending()[1], CIPHER)
                self.assertFalse(any(call[1].startswith("/checkpoints/") for call in remote.calls))
                self.assertFalse(ops.parse_json(remote.calls[-1][2])["healthy"])

    def test_accepted_before_local_cleanup_is_recovered_without_network_write(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            fixture.store.accept(meta())
            remote = FakeRemote()
            self.assertEqual(fixture.run(remote), (True, 0))
            self.assertEqual([call[1] for call in remote.calls], ["/heartbeat"])

    def test_pending_receipt_can_reconcile_even_if_current_capture_is_stale(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            fixture.write(checked_at="2026-10-10T23:00:00.000Z")
            remote = FakeRemote()
            remote.states[IDENTITY] = remote_receipt(meta(), "accepted")
            self.assertEqual(fixture.run(remote), (False, 0))
            self.assertEqual(fixture.store.accepted(), meta())
            self.assertIsNone(fixture.store.pending())

    def test_changed_state_waits_one_cycle_after_old_pending_is_reconciled(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            fixture.write(document(OTHER))
            remote = FakeRemote()
            remote.states[IDENTITY] = remote_receipt(meta(), "accepted")
            self.assertEqual(fixture.run(remote), (False, 0))
            self.assertEqual(fixture.run(remote), (True, 1))
            self.assertEqual(fixture.store.accepted()["request_id"], OTHER)

    def test_same_uuid_with_changed_plaintext_fails_closed(self):
        with Fixture() as fixture:
            fixture.store.accept(meta())
            fixture.write(dict(document(), admissionHeld=True))
            remote = FakeRemote()
            self.assertEqual(fixture.run(remote), (False, 0))
            self.assertEqual([call[1] for call in remote.calls], ["/heartbeat"])

    def test_held_or_blocked_live_state_is_backed_up_then_reported_unhealthy(self):
        for held, blocked in ((True, False), (False, True), (True, True)):
            with self.subTest(held=held, blocked=blocked), Fixture() as fixture:
                snapshot = dict(document(), admissionHeld=held)
                if blocked:
                    snapshot["entries"] = [{"filename": "0000000000000001-" + OTHER + ".json",
                                            "record": {"status": "blocked"}}]
                source = fixture.write(snapshot)
                remote = FakeRemote()
                self.assertEqual(fixture.run(remote), (False, 1))
                self.assertEqual(fixture.store.accepted()["plaintext_sha256"], hashlib.sha256(source).hexdigest())
                self.assertIsNone(fixture.store.pending())
                self.assertEqual([call[1] for call in remote.calls],
                                 ["/receipts/" + IDENTITY, "/checkpoints/" + IDENTITY, "/heartbeat"])
                heartbeat = ops.parse_json(remote.calls[-1][2])
                self.assertFalse(heartbeat["healthy"])
                self.assertEqual(heartbeat["checkpoint_id"], IDENTITY)
                self.assertEqual(fixture.run(remote), (False, 0))

    def test_capture_refresh_after_run_start_is_validated_against_clock_after_read(self):
        with Fixture() as fixture:
            fixture.write(checked_at="2026-10-11T00:05:01.000Z")
            fixture.store.accept(meta())
            remote = FakeRemote()
            with mock.patch.object(ops, "readiness", return_value=True), mock.patch.object(ops.time, "time", side_effect=[NOW, NOW + 2]):
                self.assertTrue(ops.run_once(config(), fixture.store, remote, fixture.snapshot, fixture.status, fixture.age, fixture.latch))
            heartbeat = ops.parse_json(remote.calls[-1][2])
            self.assertEqual(heartbeat["observed_at"], CHECKED)
            self.assertEqual(heartbeat["checkpoint_checked_at"], "2026-10-11T00:05:01.000Z")

    def test_cipher_corruption_is_preserved_and_not_sent(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            pending_path = fixture.directory / "pending.bin"
            original = pending_path.read_bytes()
            pending_path.write_bytes(original[:-1] + b"!")
            remote = FakeRemote()
            self.assertEqual(fixture.run(remote), (False, 0))
            self.assertEqual(pending_path.read_bytes(), original[:-1] + b"!")
            self.assertEqual([call[1] for call in remote.calls], ["/heartbeat"])

    def test_backup_disabled_does_not_read_checkpoint_age_or_mutate_pending(self):
        with Fixture() as fixture:
            fixture.store.save_pending(meta(), CIPHER)
            remote = FakeRemote()
            with mock.patch.object(ops, "checkpoint", side_effect=AssertionError("not permitted")):
                self.assertEqual(fixture.run(remote, backup=False), (True, 0))
            self.assertIsNotNone(fixture.store.pending())
            heartbeat = ops.parse_json(remote.calls[-1][2])
            self.assertTrue(all(heartbeat[key] is None for key in ("checkpoint_id", "checkpoint_captured_at", "checkpoint_checked_at")))

    def test_atomic_write_failure_retains_prior_state_and_cleans_owned_temporary(self):
        with Fixture() as fixture:
            target = fixture.directory / "accepted.json"
            ops.atomic_write(target, b"old")
            with mock.patch.object(ops.os, "write", return_value=0), self.assertRaises(ops.Unavailable):
                ops.atomic_write(target, b"new")
            self.assertEqual(target.read_bytes(), b"old")
            self.assertEqual(list(fixture.directory.glob("accepted.json.*.tmp")), [])
            with mock.patch.object(ops.os, "replace", side_effect=OSError("synthetic failure")), self.assertRaises(OSError):
                ops.atomic_write(target, b"new")
            self.assertEqual(target.read_bytes(), b"old")


class ReadinessTests(unittest.TestCase):
    def runner(self, changed=None):
        fields = ["c" * 64, "/mochirii-reaper-gateway", IMAGE, "sha256:" + "d" * 64,
                  "mochirii-reaper-gateway", "gateway", "running", "healthy"]
        if changed:
            fields[changed[0]] = changed[1]
        def command(arguments, **_kwargs):
            if arguments[0].endswith("systemctl"):
                return 0, b""
            if arguments[1:3] == ["image", "inspect"]:
                return 0, ("sha256:" + "d" * 64 + "\n").encode()
            if arguments[1] == "inspect":
                return 0, ("|".join(fields) + "\n").encode()
            return 0, b""
        return command

    def test_readiness_only_observes_owned_container_and_exact_exec_probe(self):
        with mock.patch.object(ops, "private_read", side_effect=FileNotFoundError), mock.patch.object(ops, "command", side_effect=self.runner()) as command:
            self.assertTrue(ops.readiness(IMAGE, Path("/synthetic/recovery-latched")))
            arguments = [call.args[0] for call in command.call_args_list]
            self.assertEqual(arguments[-1], ["/usr/bin/docker", "exec", "c" * 64, "/nodejs/bin/node", "dist/healthcheck.js"])
            self.assertFalse(any("restart" in item or "gateway-health.sh" in item for call in arguments for item in call))

    def test_foreign_stopped_starting_missing_health_and_exec_failure_fail_closed(self):
        for changed in ((1, "/foreign"), (2, IMAGE + "wrong"), (3, "sha256:" + "e" * 64),
                        (4, "foreign"), (5, "foreign"), (6, "exited"), (7, "starting"), (7, "none")):
            with self.subTest(changed=changed), mock.patch.object(ops, "private_read", side_effect=FileNotFoundError), mock.patch.object(ops, "command", side_effect=self.runner(changed)):
                self.assertFalse(ops.readiness(IMAGE, Path("/synthetic/recovery-latched")))
        with mock.patch.object(ops, "private_read", side_effect=FileNotFoundError), mock.patch.object(ops, "command", return_value=(1, b"")):
            self.assertFalse(ops.readiness(IMAGE, Path("/synthetic/recovery-latched")))

    def test_recovery_latch_and_invalid_latch_metadata_never_probe_or_restart(self):
        for result in (b"", ops.Unavailable()):
            with mock.patch.object(ops, "private_read", side_effect=result if isinstance(result, Exception) else None, return_value=result), mock.patch.object(ops, "command") as command:
                self.assertFalse(ops.readiness(IMAGE, Path("/synthetic/recovery-latched")))
                command.assert_not_called()

    def test_stopped_gateway_still_emits_unhealthy_heartbeat(self):
        with Fixture() as fixture, mock.patch.object(ops, "readiness", return_value=False):
            remote = FakeRemote()
            self.assertFalse(ops.run_once(config(False), fixture.store, remote, fixture.snapshot, fixture.status, fixture.age, fixture.latch, NOW))
            self.assertFalse(ops.parse_json(remote.calls[-1][2])["healthy"])


class TransportTests(unittest.TestCase):
    def response(self, status=200, source=b'{"version":1}', headers=None):
        headers = {"content-type": "application/json", "content-length": str(len(source))} if headers is None else headers
        return SimpleNamespace(status=status, getheader=lambda key, default=None: headers.get(key, default),
                               read=lambda maximum: source[:maximum])

    def send(self, response, captured_at=""):
        connection = mock.Mock()
        connection.getresponse.return_value = response
        with mock.patch.object(ops.http.client, "HTTPSConnection", return_value=connection), mock.patch.object(ops.time, "time", return_value=NOW), mock.patch.object(ops.uuid, "uuid4", return_value=IDENTITY):
            remote = ops.Remote(config())
            if captured_at:
                value = remote.request("POST", "/checkpoints/" + IDENTITY, CIPHER, captured_at)
            else:
                value = remote.request("GET", "/receipts/" + IDENTITY)
        return value, connection

    def test_exact_hmac_and_raw_cipher_bytes_with_fresh_auth(self):
        expected = remote_receipt(meta(), "accepted")
        value, connection = self.send(self.response(source=ops.canonical_json(expected)), CREATED)
        self.assertEqual(value, expected)
        args, kwargs = connection.request.call_args
        self.assertEqual(args, ("POST", ops.FUNCTION_PATH + "/checkpoints/" + IDENTITY))
        self.assertEqual(kwargs["body"], CIPHER)
        headers = kwargs["headers"]
        canonical = "\n".join(("v1", "POST", args[1], str(int(NOW)), IDENTITY, hashlib.sha256(CIPHER).hexdigest(), CREATED)).encode()
        self.assertEqual(headers["x-reaper-signature"], hmac.new(KEY.encode(), canonical, hashlib.sha256).hexdigest())
        self.assertEqual(headers["content-type"], "application/octet-stream")
        connection.close.assert_called_once()

    def test_redirect_encoding_oversize_wrong_length_and_duplicate_json_are_rejected(self):
        cases = (self.response(status=302), self.response(status=503),
                 self.response(headers={"content-type": "application/json", "content-encoding": "gzip"}),
                 self.response(source=b"x" * (ops.MAX_RESPONSE + 1)),
                 self.response(headers={"content-type": "application/json", "content-length": "999"}),
                 self.response(source=b'{"version":1,"version":1}'), self.response(headers={"content-type": "text/html"}))
        for response in cases:
            with self.subTest(status=response.status), self.assertRaises(ops.Unavailable):
                self.send(response)

    def test_upload_status_is_bound_to_receipt_state_and_get_always_requires_200(self):
        bindings = ((200, "accepted"), (202, "pending"), (409, "blocked"), (409, "retired"))
        for status, state in bindings:
            expected = remote_receipt(meta(), state)
            self.assertEqual(self.send(self.response(status=status, source=ops.canonical_json(expected)), CREATED)[0], expected)
        for status in (200, 202, 409):
            for state in ("missing", "accepted", "pending", "blocked", "retired", "identity_conflict"):
                if (status, state) not in bindings:
                    with self.subTest(status=status, state=state), self.assertRaises(ops.Unavailable):
                        self.send(self.response(status=status, source=ops.canonical_json(remote_receipt(meta(), state))), CREATED)
        for state in ("missing", "accepted", "pending", "blocked", "retired"):
            expected = remote_receipt(meta(), state)
            self.assertEqual(self.send(self.response(source=ops.canonical_json(expected)))[0], expected)
            for status in (202, 409):
                with self.subTest(status=status, state=state), self.assertRaises(ops.Unavailable):
                    self.send(self.response(status=status, source=ops.canonical_json(expected)))
        with self.assertRaises(ops.Unavailable):
            self.send(self.response(status=201), CREATED)

    def test_no_unreviewed_routes_query_or_receipt_body(self):
        remote = ops.Remote(config())
        for method, suffix, body in (("POST", "/maintenance", b""), ("GET", "/receipts/" + IDENTITY + "?x=1", b""),
                                     ("GET", "/receipts/" + IDENTITY, b"payload")):
            with self.subTest(suffix=suffix), self.assertRaises(ops.Unavailable):
                remote.request(method, suffix, body)


class EncryptionTests(unittest.TestCase):
    def test_unverified_binary_is_never_executed(self):
        with Fixture() as fixture, mock.patch.object(ops, "command") as command:
            fixture.age.write_bytes(b"synthetic unverified binary")
            fixture.age.chmod(0o755)
            with self.assertRaises(ops.Unavailable):
                ops.encrypt(b"synthetic private checkpoint", config(), fixture.age, fixture.directory)
            command.assert_not_called()

    def test_verified_version_encrypts_only_public_recipient_with_plaintext_on_stdin(self):
        with Fixture() as fixture:
            binary = b"synthetic pinned fixture, never executed"
            plaintext = b"synthetic private checkpoint"
            fixture.age.write_bytes(binary)
            fixture.age.chmod(0o755)
            def command(arguments, **kwargs):
                if arguments[-1] == "--version":
                    return 0, ops.AGE_VERSION
                self.assertEqual(arguments, [str(fixture.age), "--encrypt", "--recipient", config().recipient, "--output", "-"])
                self.assertEqual(kwargs["source"], plaintext)
                kwargs["output"].write(CIPHER)
                return 0, b""
            with mock.patch.object(ops, "AGE_BINARY_SHA256", hashlib.sha256(binary).hexdigest()), mock.patch.object(ops, "command", side_effect=command):
                self.assertEqual(ops.encrypt(plaintext, config(), fixture.age, fixture.directory), CIPHER)

    def test_wrong_version_and_over_cap_cipher_fail_closed(self):
        with Fixture() as fixture:
            binary = b"synthetic pinned fixture, never executed"
            fixture.age.write_bytes(binary)
            fixture.age.chmod(0o755)
            with mock.patch.object(ops, "AGE_BINARY_SHA256", hashlib.sha256(binary).hexdigest()), mock.patch.object(ops, "command", return_value=(0, b"v0.0.0\n")) as command:
                with self.assertRaises(ops.Unavailable):
                    ops.encrypt(b"checkpoint", config(), fixture.age, fixture.directory)
                self.assertEqual(command.call_count, 1)
            def oversized(arguments, **kwargs):
                if arguments[-1] == "--version":
                    return 0, ops.AGE_VERSION
                kwargs["output"].write(CIPHER)
                return 0, b""
            with mock.patch.object(ops, "AGE_BINARY_SHA256", hashlib.sha256(binary).hexdigest()), mock.patch.object(ops, "command", side_effect=oversized), mock.patch.object(ops, "MAX_CIPHER", 128):
                with self.assertRaises(ops.Unavailable):
                    ops.encrypt(b"checkpoint", config(), fixture.age, fixture.directory)


class InstallationTests(unittest.TestCase):
    def test_service_and_timer_are_independent_and_do_not_export_secrets(self):
        service = (ROOT / "deploy" / "mochirii-reaper-gateway-operations.service").read_text()
        timer = (ROOT / "deploy" / "mochirii-reaper-gateway-operations.timer").read_text()
        self.assertIn("ExecStart=/usr/bin/python3 -I -B", service)
        self.assertNotIn("EnvironmentFile=", service)
        self.assertIn("LimitCORE=0", service)
        self.assertNotIn("PartOf=", service + timer)
        self.assertNotIn("Requisite=", service + timer)
        self.assertIn("OnBootSec=60s", timer)
        self.assertIn("OnUnitActiveSec=60s", timer)
        self.assertIn("WantedBy=timers.target", timer)

    def test_main_fails_closed_without_root_platform_and_prints_no_private_error(self):
        with mock.patch.object(ops.os, "name", "nt"), mock.patch.object(ops.sys, "stderr", new_callable=io.StringIO) as output, mock.patch.object(ops, "private_read") as read:
            self.assertEqual(ops.main(), 1)
            self.assertEqual(output.getvalue(), "Gateway operations: unavailable\n")
            read.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
