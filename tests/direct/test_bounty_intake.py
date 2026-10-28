"""Direct-mode tests for BountyIntake.

genlayer-test 0.29.2 cannot call another contract from here: the runner
refuses a second Contract subclass in the same process, and the direct
WASI mock does not execute CallContract. _read_message is patched with
the dict shape Timbre.get_message returns.
"""

import pytest

TIMBRE = "0x" + "11" * 20


def _hex(addr):
    if hasattr(addr, "as_hex"):
        return addr.as_hex
    from genlayer.py.types import Address

    return Address(addr).as_hex


def _deploy(vm, deploy, owner, inbox_id=0):
    vm.sender = owner
    vm.value = 0
    return deploy("contracts/bounty_intake.py", TIMBRE, inbox_id)


def _message(sender, status="JUDGED", verdict="RELEVANT", inbox_id=0):
    return {
        "inbox_id": inbox_id,
        "status": status,
        "verdict": verdict,
        "sender": _hex(sender),
    }


def _patch(monkeypatch, contract, messages):
    # Patch the contract class. The handle returned to the test is a
    # calldata proxy, so type(contract) is not that class. Direct mode
    # drops an attribute set on the instance before monkeypatch.undo.
    real = object.__getattribute__(contract, "_instance")

    def read(self, message_id):
        return messages[message_id]

    monkeypatch.setattr(type(real), "_read_message", read)


def _fund(vm, contract, owner, amount):
    vm.sender = owner
    vm.value = amount
    try:
        return contract.fund()
    finally:
        vm.value = 0


def test_forward_accepts_a_relevant_message(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob)})
    direct_vm.sender = direct_bob
    assert intake.forward(0) == 0
    entry = intake.get_entry(0)
    assert entry["message_id"] == 0
    assert entry["sender"] == _hex(direct_bob)
    assert entry["status"] == "QUEUED"
    assert entry["amount"] == 0
    assert intake.list_entries(0, 10) == [entry]
    assert intake.stats()["entries"] == 1
    assert intake.stats()["owner"] == _hex(direct_alice)
    assert intake.stats()["inbox_id"] == 0


@pytest.mark.parametrize("verdict", ["OFF_TOPIC", "SPAM", "UNCERTAIN"])
def test_forward_rejects_other_verdicts(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch, verdict):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob, verdict=verdict)})
    with direct_vm.expect_revert("[EXPECTED] message is not relevant"):
        intake.forward(0)
    assert intake.stats()["entries"] == 0


@pytest.mark.parametrize("status", ["PENDING", "EXPIRED"])
def test_forward_rejects_pending_and_expired(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch, status):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob, status=status, verdict="")})
    with direct_vm.expect_revert("[EXPECTED] message is not judged"):
        intake.forward(0)
    assert intake.stats()["entries"] == 0


def test_forward_rejects_another_inbox_and_duplicates(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {
        0: _message(direct_bob),
        1: _message(direct_bob, inbox_id=1),
    })
    with direct_vm.expect_revert("[EXPECTED] message is from another inbox"):
        intake.forward(1)
    assert intake.forward(0) == 0
    with direct_vm.expect_revert("[EXPECTED] message already forwarded"):
        intake.forward(0)
    assert intake.stats()["entries"] == 1


def test_award_respects_the_pool(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob), 1: _message(direct_bob)})
    assert intake.forward(0) == 0
    assert intake.forward(1) == 1
    assert _fund(direct_vm, intake, direct_alice, 100) == 100

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("[EXPECTED] amount exceeds pool"):
        intake.award(0, 101)
    intake.award(0, 40)
    assert intake.stats()["pool"] == 60
    assert intake.get_credit(_hex(direct_bob)) == 40
    assert intake.get_entry(0)["status"] == "AWARDED"
    assert intake.get_entry(0)["amount"] == 40
    with direct_vm.expect_revert("[EXPECTED] entry already awarded"):
        intake.award(0, 10)
    with direct_vm.expect_revert("[EXPECTED] amount exceeds pool"):
        intake.award(1, 61)
    intake.award(1, 60)
    assert intake.stats()["pool"] == 0
    assert intake.get_credit(_hex(direct_bob)) == 100
    assert intake.stats()["total_credits"] == 100


def test_only_the_owner_can_fund_and_award(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob)})
    assert intake.forward(0) == 0
    direct_vm.sender = direct_bob
    direct_vm.value = 50
    try:
        with direct_vm.expect_revert("[EXPECTED] only the owner can fund"):
            intake.fund()
    finally:
        direct_vm.value = 0
    assert intake.stats()["pool"] == 0
    _fund(direct_vm, intake, direct_alice, 50)
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("[EXPECTED] only the owner can award"):
        intake.award(0, 50)
    assert intake.get_entry(0)["status"] == "QUEUED"
    assert intake.stats()["pool"] == 50


def test_withdraw_clears_credit_before_transfer(direct_vm, direct_deploy, direct_alice, direct_bob, monkeypatch, transfers):
    intake = _deploy(direct_vm, direct_deploy, direct_alice)
    _patch(monkeypatch, intake, {0: _message(direct_bob)})
    intake.forward(0)
    _fund(direct_vm, intake, direct_alice, 25)
    direct_vm.sender = direct_alice
    intake.award(0, 25)
    assert intake.get_credit(_hex(direct_bob)) == 25

    during = {}
    previous = direct_vm._gl_call_hook

    def hook(vm, request):
        if "EthSend" in request or "PostMessage" in request:
            during["credit"] = intake.get_credit(_hex(direct_bob))
        return previous(vm, request)

    direct_vm._gl_call_hook = hook
    direct_vm.sender = direct_bob
    assert intake.withdraw() == 25
    assert during["credit"] == 0
    assert intake.get_credit(_hex(direct_bob)) == 0
    assert intake.stats()["total_credits"] == 0
    assert transfers == [(_hex(direct_bob), 25)]
    with direct_vm.expect_revert("[EXPECTED] nothing to withdraw"):
        intake.withdraw()
