"""Shared fixtures for Timbre direct-mode tests."""

import os
import sys
import tempfile

import pytest

if sys.platform == "win32":
    # genlayer-test 0.29.2 unlinks its stdin temp file while fd 0 still holds it,
    # which Windows refuses (WinError 32). Keep the same payload, on a delete-on-close file.
    from gltest.direct import loader as _gltest_loader

    def _inject_message_to_fd0_windows(vm):
        from genlayer.py import calldata
        from genlayer.py.types import Address

        def _addr(a):
            return Address(a) if isinstance(a, bytes) else a

        encoded = calldata.encode({
            "contract_address": _addr(vm._contract_address),
            "sender_address": _addr(vm.sender),
            "origin_address": _addr(vm.origin),
            "stack": [],
            "value": vm._value,
            "datetime": vm._datetime,
            "is_init": False,
            "chain_id": vm._chain_id,
            "entry_kind": 0,
            "entry_data": b"",
            "entry_stage_data": None,
        })
        with tempfile.TemporaryFile() as tmp:
            tmp.write(encoded)
            tmp.flush()
            os.lseek(tmp.fileno(), 0, os.SEEK_SET)
            vm._original_stdin_fd = os.dup(0)
            os.dup2(tmp.fileno(), 0)

    _gltest_loader._inject_message_to_fd0 = _inject_message_to_fd0_windows

T0 = "2026-10-27T12:00:00Z"
CONTRACT = "contracts/timbre.py"


def to_hex(addr):
    """Checksummed hex matching contract view output. Call after direct_deploy."""
    if hasattr(addr, "as_hex"):
        return addr.as_hex
    from genlayer.py.types import Address

    return Address(addr).as_hex


@pytest.fixture
def contract(direct_vm, direct_deploy):
    direct_vm.warp(T0)
    return direct_deploy(CONTRACT)


@pytest.fixture
def transfers(direct_vm):
    """Record EthSend and PostMessage transfers as (checksummed address, value)."""
    sent = []

    def hook(vm, request):
        for op in ("EthSend", "PostMessage"):
            if op in request:
                sent.append(
                    (to_hex(request[op]["address"]), int(request[op].get("value", 0)))
                )
        return None

    direct_vm._gl_call_hook = hook
    return sent


@pytest.fixture
def prompts(direct_vm):
    """Capture every prompt handed to the mocked LLM."""
    captured = []
    original = direct_vm._match_llm_mock

    def capture(prompt):
        captured.append(prompt)
        return original(prompt)

    direct_vm._match_llm_mock = capture
    return captured
