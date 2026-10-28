"""Live cross-contract call. Skipped unless TIMBRE_IT=1.

Direct mode cannot deploy Timbre and BountyIntake in one process, so this
test talks to a running node (gltest.config.yaml, default localnet).
"""

import json
import os

import pytest

SHA = "0123456789abcdef0123456789abcdef01234567"
CRITERIA_URL = f"https://raw.githubusercontent.com/tinyparse/inbox/{SHA}/demo/INBOX.md"
TEXT = "tinyparse 2.3.1 parse_date('2026-02-30') raises ValueError as expected."
CRITERIA = "Accepted: A1 bug report with version and reproduction steps."


@pytest.mark.integration
@pytest.mark.skipif(os.environ.get("TIMBRE_IT") != "1", reason="set TIMBRE_IT=1 to run the live Timbre call")
def test_forward_reads_a_relevant_message_from_timbre():
    from gltest import get_accounts, get_contract_factory, get_validator_factory
    from gltest.assertions import tx_execution_failed, tx_execution_succeeded

    accounts = get_accounts()
    owner, sender = accounts[0], accounts[1]
    validators = get_validator_factory().batch_create_mock_validators(
        5,
        mock_llm_response={
            "nondet_exec_prompt": {
                "neutral judge": json.dumps({
                    "label": "RELEVANT",
                    "criteria_met": ["A1"],
                    "reason": "version and repro are present",
                })
            }
        },
        mock_web_response={
            "nondet_web_request": {
                CRITERIA_URL: {"method": "GET", "status": 200, "body": CRITERIA}
            }
        },
    )
    context = {"validators": [item.to_dict() for item in validators]}

    timbre = get_contract_factory("Timbre").deploy(account=owner)
    opened = timbre.open_inbox("tinyparse", CRITERIA_URL, 1, 100).transact()
    assert tx_execution_succeeded(opened)
    sent = timbre.connect(sender).send_message(0, TEXT, "").transact(value=1)
    assert tx_execution_succeeded(sent)
    judged = timbre.judge(0).transact(transaction_context=context)
    assert tx_execution_succeeded(judged)
    assert timbre.get_message(0).call()["verdict"] == "RELEVANT"

    intake = get_contract_factory("BountyIntake").deploy(args=[timbre.address, 0], account=owner)
    forwarded = intake.forward(0).transact()
    assert tx_execution_succeeded(forwarded)
    entry = intake.get_entry(0).call()
    assert entry["message_id"] == 0
    assert entry["status"] == "QUEUED"
    assert entry["sender"] == sender.address
    duplicate = intake.forward(0).transact()
    assert tx_execution_failed(duplicate, match_std_err="message already forwarded")
