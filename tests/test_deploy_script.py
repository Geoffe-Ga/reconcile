"""Tests for deploy/deploy.sh: its tool check, and the VAPID key it makes.

The tool tests run a copy of deploy.sh in a temp tree, on a PATH that holds
only ``dirname`` and a stub for each tool, so nothing is built, synced or
deployed. With every tool there, the script stops at its settings check,
because the tests give it no RECONCILE_* setting and no deploy/.env.

The key tests run deploy.sh's own ``make_vapid_key`` function on a temp
directory, with a ``runuser`` stub in place of switching users (#89).
"""

from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess  # nosec B404 - runs our own script in a temp tree
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "deploy.sh"
BASH = shutil.which("bash") or "bash"
DIRNAME = shutil.which("dirname") or "/usr/bin/dirname"
# Every command deploy.sh runs on the founder's machine (#155 added git, #505
# node, which derives the tests' steward pins for the guard).
TOOLS = ("git", "npm", "node", "rsync", "ssh", "curl", "base64")
STUB_RAN = "stub ran:"
NO_SETTINGS = (
    "deploy: set RECONCILE_DEPLOY_HOST (deploy@<vm>) in the environment"
    " or deploy/.env.\n"
)


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """deploy/deploy.sh beside a bin/ holding dirname and a stub per tool."""
    (tmp_path / "deploy").mkdir()
    shutil.copy(DEPLOY, tmp_path / "deploy" / "deploy.sh")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "dirname").symlink_to(DIRNAME)
    for tool in TOOLS:
        stub = bin_dir / tool
        stub.write_text(
            f'#!{BASH}\necho "{STUB_RAN} {tool} $*"\nexit 99\n', encoding="utf-8"
        )
        stub.chmod(0o755)
    return tmp_path


def _deploy(tree: Path) -> subprocess.CompletedProcess[str]:
    """Run the copied deploy.sh with only tree/bin on PATH and no settings."""
    return subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(tree / "deploy" / "deploy.sh")],
        env={"PATH": str(tree / "bin")},
        capture_output=True,
        text=True,
        check=False,
    )


def test_with_every_tool_it_reaches_the_settings_check(tree: Path) -> None:
    """The control: with all the tools, the tool check passes and runs none."""
    result = _deploy(tree)
    assert result.returncode == 1
    assert result.stderr == NO_SETTINGS
    assert STUB_RAN not in result.stdout


@pytest.mark.parametrize("missing", TOOLS)
def test_a_missing_tool_stops_the_deploy_first(tree: Path, missing: str) -> None:
    """Without one tool, deploy.sh dies naming it, before using any tool."""
    (tree / "bin" / missing).unlink()
    result = _deploy(tree)
    assert result.returncode == 1
    assert result.stderr == f"deploy: {missing} isn't on PATH.\n"
    assert STUB_RAN not in result.stdout


# --- The VAPID key (#89) ----------------------------------------------------

UNIT = ROOT / "deploy" / "reconcile-relay.service"
OPENSSL = shutil.which("openssl")
needs_openssl = pytest.mark.skipif(OPENSSL is None, reason="needs the openssl CLI")


def _vm_function(name: str) -> str:
    """The text of one of deploy.sh's functions, as run_on_vm ships it."""
    match = re.search(
        rf"^{name}\(\) \{{\n.*?^\}}\n", DEPLOY.read_text(), re.MULTILINE | re.DOTALL
    )
    assert match is not None, f"deploy.sh has no {name}()"
    return match.group(0)


@pytest.fixture
def vm(tmp_path: Path) -> Path:
    """A state directory, and a runuser stub that runs its command as us.

    The stub notes the user it was asked for, so a test can see who the key
    would have been made as.
    """
    state = tmp_path / "var-lib-reconcile"
    state.mkdir()
    bin_dir = tmp_path / "vm-bin"
    bin_dir.mkdir()
    stub = bin_dir / "runuser"
    stub.write_text(
        f"#!{BASH}\n"
        '[[ "$1" == -u && "$3" == -- ]] || exit 97\n'
        'printf "%s\\n" "$2" >> "$RUNUSER_LOG"\n'
        "shift 3\n"
        'exec "$@"\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    return tmp_path


def _make_key(vm: Path, path: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run deploy.sh's make_vapid_key on the temp state directory."""
    script = _vm_function("make_vapid_key") + 'make_vapid_key "$@"\n'
    return subprocess.run(
        [
            BASH,
            "-c",
            script,
            "make_vapid_key",
            str(vm / "var-lib-reconcile"),
            "reconcile",
        ],
        env={
            "PATH": path or os.pathsep.join([str(vm / "vm-bin"), os.environ["PATH"]]),
            "RUNUSER_LOG": str(vm / "runuser.log"),
        },
        capture_output=True,
        text=True,
        check=False,
    )


def _runuser_calls(vm: Path) -> list[str]:
    """The users runuser was asked to run as."""
    log = vm / "runuser.log"
    return log.read_text().splitlines() if log.exists() else []


@needs_openssl
def test_the_first_deploy_makes_a_private_p256_key_as_reconcile(vm: Path) -> None:
    """openssl ecparam -genkey -noout, as the reconcile user, readable only by it."""
    result = _make_key(vm)

    key_file = vm / "var-lib-reconcile" / "vapid.pem"
    assert (result.returncode, result.stderr) == (0, "")
    assert key_file.stat().st_mode & 0o777 == 0o600
    key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    assert isinstance(key.curve, ec.SECP256R1)
    assert _runuser_calls(vm) == ["reconcile"]
    assert sorted(p.name for p in key_file.parent.iterdir()) == ["vapid.pem"]


@needs_openssl
def test_a_later_deploy_leaves_the_key_alone(vm: Path) -> None:
    """Every device's subscription is bound to the key, so it never changes."""
    _make_key(vm)
    key_file = vm / "var-lib-reconcile" / "vapid.pem"
    first = key_file.read_bytes()

    result = _make_key(vm)

    assert result.returncode == 0
    assert key_file.read_bytes() == first
    assert _runuser_calls(vm) == ["reconcile"]


def test_an_existing_key_is_never_overwritten(vm: Path) -> None:
    """Whatever is at vapid.pem stays; the relay refuses it if it's bad."""
    key_file = vm / "var-lib-reconcile" / "vapid.pem"
    key_file.write_bytes(b"the founder's key\n")

    result = _make_key(vm)

    assert result.returncode == 0
    assert key_file.read_bytes() == b"the founder's key\n"
    assert _runuser_calls(vm) == []


def test_a_failed_openssl_leaves_no_key_and_fails_the_deploy(vm: Path) -> None:
    """A half-made key is never put in place, so the next deploy tries again."""
    (vm / "vm-bin" / "openssl").write_text(f"#!{BASH}\nexit 1\n", encoding="utf-8")
    (vm / "vm-bin" / "openssl").chmod(0o755)

    result = _make_key(vm)

    assert result.returncode != 0
    assert not (vm / "var-lib-reconcile" / "vapid.pem").exists()


def test_the_key_is_made_before_the_relay_restarts() -> None:
    """install_on_vm makes the key, then restarts, so the relay starts with push."""
    install = _vm_function("install_on_vm")

    assert "make_vapid_key /var/lib/reconcile reconcile" in install
    assert install.index("make_vapid_key") < install.index("systemctl restart")


def test_the_unit_points_at_the_key_and_a_drop_in_sets_the_subject() -> None:
    """The relay reads the key deploy.sh makes and names the site as its subject."""
    unit = UNIT.read_text()
    install = _vm_function("install_on_vm")

    assert (
        "Environment=RECONCILE_RELAY_VAPID_KEY=/var/lib/reconcile/vapid.pem\n" in unit
    )
    assert "RECONCILE_RELAY_VAPID_SUBJECT=https://%s" in install
    assert "/etc/systemd/system/reconcile-relay.service.d/" in install


def test_run_on_vm_ships_the_key_helper_with_install_on_vm(tmp_path: Path) -> None:
    """The VM gets make_vapid_key's definition in the same payload, then the call."""
    helpers = re.search(r"^VM_HELPERS=.*$", DEPLOY.read_text(), re.MULTILINE)
    assert helpers is not None
    script = "\n".join(
        [
            helpers.group(0),
            *(
                _vm_function(name)
                for name in ("die", "make_vapid_key", "install_on_vm")
            ),
            _vm_function("run_on_vm"),
            "host=deploy@vm.example",
            "run_on_vm sudo install_on_vm /opt/reconcile/src site.example",
        ]
    )
    bin_dir = tmp_path / "ssh-bin"
    bin_dir.mkdir()
    (bin_dir / "ssh").write_text(
        f'#!{BASH}\nprintf "%s\\n" "$@" > "$SSH_LOG"\n', encoding="utf-8"
    )
    (bin_dir / "ssh").chmod(0o755)
    log = tmp_path / "ssh.log"

    result = subprocess.run(
        [BASH, "-c", script],
        env={
            "PATH": os.pathsep.join([str(bin_dir), os.environ["PATH"]]),
            "SSH_LOG": str(log),
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert (result.returncode, result.stderr) == (0, "")
    flag, host, command = log.read_text().splitlines()
    match = re.fullmatch(
        r"printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| sudo bash -s --"
        r" '/opt/reconcile/src' 'site\.example'",
        command,
    )
    assert (flag, host) == ("-t", "deploy@vm.example")
    assert match is not None, command
    payload = base64.b64decode(match.group(1)).decode()
    assert payload.index("make_vapid_key ()") < payload.index("install_on_vm ()")
    assert payload.rstrip().endswith('install_on_vm "$@"')


# --- The steward's pins (#505) ------------------------------------------------

# What the node stub prints in place of client/scripts/stewardTestPins.mjs.
TEST_SIGN = "the-tests-sign-pin"
TEST_BOX = "the-tests-box-pin"
TEST_PINS_OUT = (
    f"RECONCILE_STEWARD_PIN_SIGN={TEST_SIGN}\nRECONCILE_STEWARD_PIN_BOX={TEST_BOX}\n"
)


def _refuse(
    tmp_path: Path, dist_text: str, node_out: str = TEST_PINS_OUT, node_code: int = 0
) -> subprocess.CompletedProcess[str]:
    """Run deploy.sh's refuse_test_pins on a dist holding ``dist_text``.

    A ``node`` stub prints ``node_out`` and exits ``node_code``, as the
    test-pins script would.
    """
    dist = tmp_path / "dist" / "assets"
    dist.mkdir(parents=True)
    (dist / "index.js").write_text(dist_text, encoding="utf-8")
    bin_dir = tmp_path / "pins-bin"
    bin_dir.mkdir()
    out = tmp_path / "node.out"
    out.write_text(node_out, encoding="utf-8")
    (bin_dir / "node").write_text(
        f'#!{BASH}\nprintf "%s\\n" "$*" > "$NODE_LOG"\ncat "{out}"\nexit {node_code}\n',
        encoding="utf-8",
    )
    (bin_dir / "node").chmod(0o755)
    script = "\n".join(
        [
            _vm_function("die"),
            _vm_function("refuse_test_pins"),
            'PROJECT_ROOT="$1"',
            'refuse_test_pins "$2"',
        ]
    )
    return subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, "-c", script, "refuse", "/repo", str(tmp_path / "dist")],
        env={
            "PATH": os.pathsep.join([str(bin_dir), os.environ["PATH"]]),
            "NODE_LOG": str(tmp_path / "node.log"),
        },
        capture_output=True,
        text=True,
        check=False,
    )


NO_PINS = "deploy: couldn't derive the tests' steward pins to check the build.\n"
REFUSED = (
    "deploy: the build pins the tests' steward key, whose secret anyone can"
    " derive. Set RECONCILE_STEWARD_PIN_SIGN and RECONCILE_STEWARD_PIN_BOX to the"
    " real steward's keys, or leave both unset (deploy/README.md).\n"
)


def test_a_build_without_the_tests_pins_passes(tmp_path: Path) -> None:
    """A build with null pins, or the real steward's, deploys."""
    result = _refuse(tmp_path, 'const p=null;const q={sign:"real",box:"real2"};')

    assert (result.returncode, result.stderr) == (0, "")
    assert (tmp_path / "node.log").read_text() == (
        "/repo/client/scripts/stewardTestPins.mjs\n"
    )


@pytest.mark.parametrize("pin", [TEST_SIGN, TEST_BOX])
def test_a_build_holding_either_test_pin_is_refused(tmp_path: Path, pin: str) -> None:
    """The tests' key can never ship: its secret is public."""
    result = _refuse(tmp_path, f'const p={{"k":"{pin}"}};')

    assert (result.returncode, result.stderr) == (1, REFUSED)


@pytest.mark.parametrize(
    ("node_out", "node_code"),
    [
        (TEST_PINS_OUT, 1),
        ("", 0),
        (f"RECONCILE_STEWARD_PIN_SIGN={TEST_SIGN}\n", 0),
        (f"RECONCILE_STEWARD_PIN_SIGN=\nRECONCILE_STEWARD_PIN_BOX={TEST_BOX}\n", 0),
    ],
)
def test_the_guard_fails_closed_without_both_test_pins(
    tmp_path: Path, node_out: str, node_code: int
) -> None:
    """If it can't learn both of the tests' pins, it refuses rather than pass."""
    result = _refuse(tmp_path, "const p=null;", node_out, node_code)

    assert (result.returncode, result.stderr) == (1, NO_PINS)


def test_the_guard_runs_after_the_build_and_before_the_sync() -> None:
    """The deploy checks the very files it is about to sync."""
    text = DEPLOY.read_text()
    guard = text.index('refuse_test_pins "$PROJECT_ROOT/client/dist"')

    assert text.index("run build --silent") < guard < text.index('"${SYNC[@]}"')


def test_deploy_env_may_hold_the_two_pins(tmp_path: Path) -> None:
    """deploy/.env takes the pins, and the build sees them; other names stay refused."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        "RECONCILE_STEWARD_PIN_SIGN=sign-key\nRECONCILE_STEWARD_PIN_BOX='box-key'\n",
        encoding="utf-8",
    )
    script = "\n".join(
        [
            _vm_function("die"),
            _vm_function("load_env_file"),
            f'DEPLOY_DIR="{tmp_path}"',
            "load_env_file",
            'bash -c \'printf "%s %s\\n" "$RECONCILE_STEWARD_PIN_SIGN"'
            ' "$RECONCILE_STEWARD_PIN_BOX"\'',
        ]
    )

    result = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, "-c", script],
        env={"PATH": os.environ["PATH"]},
        capture_output=True,
        text=True,
        check=False,
    )

    assert (result.returncode, result.stderr) == (0, "")
    assert result.stdout == "sign-key box-key\n"
