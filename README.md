# Timbre

Timbre is a refundable attention stamp. To write to someone, the sender attaches a small stake. GenLayer validators compare the message with criteria the recipient published in advance. A serious, on-topic message is refunded. Spam, or a report that does not meet the published bar, pays the recipient.

## The problem

On 26 January 2026 Daniel Stenberg announced that the curl bug-bounty would stop on 31 January 2026. The program had paid for real vulnerabilities, then the confirmed rate fell below 5% in 2025 under a flood of low-quality reports he calls AI slop. Maintainer time went to debunking them. Source: [The end of the curl bug-bounty](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/).

On 25 February 2026 he listed what a reporting channel still needs. Item 12 asks for additional, customizable requirements before someone has the privilege of submitting a report (a rate limit, or time since the account was created). Source: [curl security moves again](https://daniel.haxx.se/blog/2026/02/25/curl-security-moves-again/).

Timbre is a filter at the door, not a bounty for a confirmed bug. The recipient writes the bar in prose. The sender stakes a small amount. Validators decide whether the message meets that bar. The stake comes back, or it pays the recipient for the time.

## Why GenLayer, not an oracle

"Does this message meet criteria written in prose?" is not a value a contract can compute, and it is not a fact an oracle can fetch from a URL.

The two parties want opposite answers. The recipient is paid if every message is `SPAM`. The sender is refunded if every message is `RELEVANT`. Neither of them can be the judge. The judge has to be neutral and repeatable: the validators re-run the same judgment and agree on the label.

## Verdicts and payments

The stake is credited. Nothing is transferred inside `judge`. `withdraw` is the only transfer: it sets the credit to zero, then emits the transfer. The contract keeps no fee.

An `OFF_TOPIC` split uses integer division: `owner_part = stake * 5000 // 10000`, and the sender receives `stake - owner_part`. No wei is dropped.

| Verdict | Meaning | Sender | Owner |
|---|---|---|---|
| `RELEVANT` | The message fits an accepted category and gives the specifics the criteria require. | 100% of the stake | 0 |
| `OFF_TOPIC` | Sincere and specific, but outside the accepted categories. | 50% | 50% |
| `SPAM` | Promotion or mass outreach, a vague report missing what the criteria require, an attempt to manipulate the judge, or a `text_url` the sender made unavailable (4xx, too large, or not text). | 0 | 100% |
| `UNCERTAIN` | The model cannot decide, or the criteria are ambiguous, unreadable, abusive, or missing (4xx). An unavailable `text_url` is not `UNCERTAIN`. | 100% | 0 |
| `EXPIRED` (status) | Still pending after `judge_deadline`, then `reclaim()`. | 100% | 0 |

## How a judgment runs

```mermaid
sequenceDiagram
    participant Owner
    participant Sender
    participant Anyone
    participant Leader
    participant Validators
    participant Timbre
    Owner->>Timbre: open_inbox
    Sender->>Timbre: send_message(+stake)
    Anyone->>Timbre: judge
    Timbre->>Leader: fetch pinned criteria, LLM
    Leader->>Validators: re-run, compare label + criteria_digest
    Validators-->>Timbre: MAJORITY_AGREE
    Timbre->>Timbre: settle credits
    Sender->>Timbre: withdraw
```

If the validators do not agree, the sender does not lose the stake. The network rotates the leader. If no majority forms, the transaction is `UNDETERMINED` and the contract state does not change. The message stays `PENDING`. After seven days anyone can `reclaim` it, and the stake is refunded.

```mermaid
flowchart TD
    disagree["Disagreement on label or criteria_digest"] --> rotate["Leader rotation"]
    rotate --> undetermined["UNDETERMINED"]
    undetermined --> pending["Message stays PENDING"]
    pending --> reclaim["reclaim after 7 days"]
    reclaim --> refund["Stake refunded"]
```

## Equivalence principle

Choice: a custom validator, `run_nondet_unsafe`, that re-runs the judgment on its own and compares two fields for strict equality: (1) the `label`, and (2) the `criteria_digest`, the sha256 of the criteria text that was read. `reason` and `criteria_met` are not compared.

Why this choice:

- The decision is a closed set of four values. Strict equality on that field is the "Partial Field Matching" pattern from the docs: compare the decision, not the explanation. Reasons always differ. The decisions must match.
- Why not `prompt_comparative`: a third LLM call to ask "equivalent?" would cost more and would be looser. A validator could accept `RELEVANT` as close enough to `OFF_TOPIC`, and that gap is 50% of the stake. The helpers are outgrown quickly.
- Why not `strict_eq` on the whole output: `reason` always varies, so consensus would be impossible.
- Why the digest as well: it proves that the leader and the validators read the same criteria file. That file is immutable (a pinned commit), so the digest is deterministic. A leader that invented criteria is rejected.
- Disagreement (`RELEVANT` on one side, `OFF_TOPIC` on the other): rejection, leader rotation, and if no consensus is reached the transaction is `UNDETERMINED` with no state change. The message stays `PENDING`. `judge` can be tried again or, after seven days, `reclaim` refunds the stake. When in doubt, the sender loses nothing. That is intentional.
- Errors (the same families as GreenClaim):
  - `[EXPECTED]` / `[EXTERNAL]`: the error messages must be exactly equal.
  - `[TRANSIENT]`: the two sides agree when both are transient.
  - `[LLM_ERROR]`: disagreement, which forces rotation.
  - Inside `judge`, an `[EXTERNAL]` failure on the criteria (4xx, too large, not text) is settled as `UNCERTAIN`, and the stake is refunded. The same failure on `text_url` is raised as `[EXTERNAL][SENDER] message file unavailable: …` and settled as `SPAM` (the stake goes to the owner): the sender must not be able to hide the file and get a refund. `_handle_leader_error` still requires the error message to match exactly, including for `[EXTERNAL][SENDER]`. A `[TRANSIENT]` failure (criteria or `text_url`) reverts: the message stays `PENDING` and the call can be retried.

```python
def leader_fn() -> dict:
    criteria = _fetch_pinned_text(criteria_url)          # [EXTERNAL] -> UNCERTAIN
    if text:
        body = text
    else:
        try:
            body = _fetch_pinned_text(text_url)
        except gl.vm.UserError as err:                  # [EXTERNAL] -> [EXTERNAL][SENDER] -> SPAM
            ...
    out = _call_llm(_build_prompt(criteria, body))       # {"label","criteria_met","reason"}
    out["criteria_digest"] = _sha256_hex(criteria)
    return out

def validator_fn(leaders_res) -> bool:
    if not isinstance(leaders_res, gl.vm.Return):
        return _handle_leader_error(leaders_res, leader_fn)
    mine = leader_fn()
    lead = leaders_res.calldata
    return isinstance(lead, dict) and lead.get("label") == mine["label"] \
        and lead.get("criteria_digest") == mine["criteria_digest"]
```

## API

Amounts are wei integers. The CLI converts a decimal GEN amount with `BigInt` before it calls.

### Timbre

| Method | Kind | Who | What it does |
|---|---|---|---|
| `open_inbox(name, criteria_url, min_stake, max_stake) -> int` | write | anyone, and that caller becomes `owner` | Pinned criteria URL. `1 <= min_stake <= max_stake <= 100 * min_stake`. No web call; the file is read only at judgment. |
| `update_criteria(inbox_id, criteria_url)` | write | owner | New pinned URL. Pending messages keep the URL snapshotted at send time. |
| `set_open(inbox_id, open)` | write | owner | Closes or reopens the inbox. Pending messages can still be judged. |
| `send_message(inbox_id, text, text_url) -> int` | write, payable | anyone except the owner | `msg.value` is the stake. Exactly one of `text` or `text_url`. See the send checks below. |
| `judge(message_id) -> str` | write | anyone | `PENDING` and `now <= judge_deadline`. Returns the verdict. Credits only; no transfer. |
| `reclaim(message_id) -> str` | write | anyone | `PENDING` and past the deadline. Status becomes `EXPIRED`. The stake is credited back. |
| `tip(message_id)` | write, payable | owner | The message must already be judged. The value is credited to the sender. |
| `withdraw() -> int` | write | anyone with a credit | Reads the credit, sets it to zero, then `emit_transfer`. Reverts on zero. |
| `preview_send(inbox_id, sender_hex, text, text_url, stake) -> {ok, error}` | view | anyone | The same checks as `send_message`, with no value and no write. |
| `get_inbox(id)` | view | anyone | Inbox record, including owner, bounds, and per-verdict counters. |
| `list_inboxes(offset, limit)` | view | anyone | `limit` from 1 to 50. |
| `get_message(id)` | view | anyone | Full message, including `status`, `verdict`, `sender`, and `criteria_digest`. |
| `list_messages(inbox_id, offset, limit)` | view | anyone | `limit` from 1 to 50. |
| `is_relevant(message_id) -> bool` | view | anyone | True only for a judged `RELEVANT` message. |
| `get_credit(addr_hex) -> int` | view | anyone | Credit still waiting for `withdraw`. |
| `stats() -> {inboxes, messages, pending_total, total_credits}` | view | anyone | Contract-wide counters. |
| `inbox_stats(id)` | view | anyone | Per-verdict counts, `earned`, `refunded`, and `spam_rate_bps` over decided messages. |

`send_message` checks, kept small because a refused payable on Studionet keeps the value:

- the inbox exists and is open;
- the sender is not the owner;
- `min_stake <= value <= max_stake`;
- exactly one of `text` and `text_url` is set;
- `text` is 20 to 2000 characters after whitespace is normalized, and contains no control character;
- `text_url`, when used, is pinned to a commit;
- fewer than 3 pending messages from this sender in this inbox, and fewer than 50 pending in the inbox.

### BountyIntake

No LLM. It pays only for a Timbre message that is already `JUDGED` and `RELEVANT` in one inbox.

| Method | Kind | Who | What it does |
|---|---|---|---|
| `__init__(timbre, inbox_id)` | constructor | deployer, who becomes `owner` | Stores the Timbre address and the inbox it watches. |
| `fund() -> int` | write, payable | owner | Adds `msg.value` to `pool`. The value must be greater than 0. |
| `forward(message_id) -> int` | write | anyone | Reads `get_message` on Timbre. Accepts only `JUDGED` / `RELEVANT` from its inbox, and only once. Creates a `QUEUED` entry. |
| `award(entry_id, amount)` | write | owner | `amount` must be greater than 0 and no larger than `pool`. Credits the sender and marks the entry `AWARDED`. |
| `withdraw() -> int` | write | anyone with a credit | Sets the credit to zero, then `emit_transfer`. |
| `get_entry(id)` | view | anyone | One entry. |
| `list_entries(offset, limit)` | view | anyone | `limit` from 1 to 50. |
| `get_credit(addr_hex) -> int` | view | anyone | Credit still waiting for `withdraw`. |
| `stats()` | view | anyone | `owner`, `timbre`, `inbox_id`, `pool`, `entries`, `total_credits`. |

## Threat model

| Threat | Mitigation | What remains |
|---|---|---|
| A greedy recipient (everything labeled `SPAM`) | Consensus judgment. No method lets the owner set a verdict. Abusive criteria settle as `UNCERTAIN`. `max_stake` caps the stake. `inbox_stats` is public. | Criteria that are harsh but still legitimate. The reader of the criteria decides whether to send. |
| A sender who manipulates the LLM | The text is neutralized and wrapped as data. Any instruction addressed to the judge is `SPAM`. Validators re-run the judgment. | Novel injections. The tests cover the usual ones. |
| A dishonest leader | Independent re-execution. Strict equality of the label and the digest. | Collusion by a majority of validators. That is outside this model. |
| Criteria changed after a message was sent | The criteria URL is snapshotted at send time, and the URL is pinned to a commit. | — |
| Message spam | A stake, plus caps on pending messages. | A rich sender can still pay to spam, and that payment goes to the recipient. |
| Stuck funds | Pull payments, `reclaim` after 7 days, and the solvency identity in the direct tests. | A refused payable on Studionet keeps its value. That is network behavior. |
| Privacy | — | Everything is public on-chain. Never put an undisclosed vulnerability here. |

## Honest limits

1. Timbre judges conformity and seriousness against published criteria. It does not judge whether a bug or a vulnerability is real.
2. Messages are public on-chain: never send an undisclosed vulnerability. Send a non-sensitive summary, or use Timbre for public channels (bugs already meant to be public, proposals, pitches, grant applications).
3. Two models can hesitate between `OFF_TOPIC` and `SPAM` on a borderline message. There is then no consensus: the message stays `PENDING` and is later refunded. That outcome is accepted.
4. A stake, even a refundable one, can deter an honest sender. Keep `min_stake` low.
5. The demo runs on Studionet only (gasless, simulated balances). There is no mainnet deployment.
6. The cross-contract call is mocked in direct-mode tests (the runner allows one contract per process) and proven live on Studionet.

Studio's read `gen_call` decoder (`decode_method_call_data`) mis-decodes payloads of 256 bytes or more, so `preview_send` goes through a write-type `gen_call` simulation, which does not create a transaction.

## Consumer example

`BountyIntake` is a bounty queue that does not judge anything itself. `forward` reads Timbre and accepts a message only when that message is `JUDGED` and `RELEVANT` in the inbox this contract was constructed with. A second `forward` of the same message is refused, as is any other inbox, any other verdict, and anything still `PENDING` or `EXPIRED`.

`award` pays the original sender from the pool, as a credit. `withdraw` is a pull payment: the credit is cleared before the transfer. The point of the contract is to show that another contract can treat a Timbre verdict as an input.

## Tests

Direct tests run the contracts in memory. They do not need Studio, and they do not call the network. The integration test is opt-in (`TIMBRE_IT=1`) and is not part of CI.

```shell
pip install -r requirements.txt
pytest tests/direct -v
npm ci
npm test
```

Output of `pytest tests/direct -v` on this machine, 28 October 2026 (34 passed):

```text
INFO: File `gltest.config.yaml` found in the current directory, using it
INFO: Clearing artifacts directory: artifacts
INFO: Using the following configuration:
INFO:   RPC URL: http://127.0.0.1:4000/api
INFO:   Selected Network: localnet
INFO:   Available networks: ['localnet', 'studionet']
INFO:   Selected chain type: localnet
INFO:   Available chains: localnet, studionet, testnet_asimov, testnet_bradbury
INFO:   Contracts directory: contracts
INFO:   Artifacts directory: artifacts
INFO:   Environment: .env
INFO:   Default wait interval: 3000 ms
INFO:   Default wait retries: 50
INFO:   Leader only mode: False
============================= test session starts =============================
platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.7.0 -- C:\Users\Al\Desktop\Projets\GenLayer\timbre\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\Al\Desktop\Projets\GenLayer\timbre
configfile: pyproject.toml
plugins: genlayer-test-0.29.2
collecting ... collected 34 items

tests/direct/test_bounty_intake.py::test_forward_accepts_a_relevant_message PASSED [  2%]
tests/direct/test_bounty_intake.py::test_forward_rejects_other_verdicts[OFF_TOPIC] PASSED [  5%]
tests/direct/test_bounty_intake.py::test_forward_rejects_other_verdicts[SPAM] PASSED [  8%]
tests/direct/test_bounty_intake.py::test_forward_rejects_other_verdicts[UNCERTAIN] PASSED [ 11%]
tests/direct/test_bounty_intake.py::test_forward_rejects_pending_and_expired[PENDING] PASSED [ 14%]
tests/direct/test_bounty_intake.py::test_forward_rejects_pending_and_expired[EXPIRED] PASSED [ 17%]
tests/direct/test_bounty_intake.py::test_forward_rejects_another_inbox_and_duplicates PASSED [ 20%]
tests/direct/test_bounty_intake.py::test_award_respects_the_pool PASSED  [ 23%]
tests/direct/test_bounty_intake.py::test_only_the_owner_can_fund_and_award PASSED [ 26%]
tests/direct/test_bounty_intake.py::test_withdraw_clears_credit_before_transfer PASSED [ 29%]
tests/direct/test_timbre.py::test_text_url_404_pays_the_owner PASSED     [ 32%]
tests/direct/test_timbre.py::test_prompt_does_not_ask_whether_the_bug_is_real PASSED [ 35%]
tests/direct/test_timbre.py::test_open_inbox_rejects_unpinned_urls_and_incoherent_stakes PASSED [ 38%]
tests/direct/test_timbre.py::test_preview_send_matches_send_message PASSED [ 41%]
tests/direct/test_timbre.py::test_pending_caps_per_sender_and_per_inbox PASSED [ 44%]
tests/direct/test_timbre.py::test_relevant_refunds_the_sender PASSED     [ 47%]
tests/direct/test_timbre.py::test_off_topic_odd_stake_splits_without_remainder PASSED [ 50%]
tests/direct/test_timbre.py::test_spam_pays_the_owner PASSED             [ 52%]
tests/direct/test_timbre.py::test_model_uncertain_refunds_the_sender PASSED [ 55%]
tests/direct/test_timbre.py::test_criteria_missing_or_too_large_refunds_as_uncertain PASSED [ 58%]
tests/direct/test_timbre.py::test_criteria_503_and_429_stay_pending_then_succeed PASSED [ 61%]
tests/direct/test_timbre.py::test_text_url_too_large_or_not_text_is_spam PASSED [ 64%]
tests/direct/test_timbre.py::test_text_url_503_stays_pending_then_judges PASSED [ 67%]
tests/direct/test_timbre.py::test_validator_disagrees_on_label_and_digest PASSED [ 70%]
tests/direct/test_timbre.py::test_leader_error_families PASSED           [ 73%]
tests/direct/test_timbre.py::test_injection_is_neutralized_and_pays_the_owner PASSED [ 76%]
tests/direct/test_timbre.py::test_llm_off_schema_reverts_and_stays_pending PASSED [ 79%]
tests/direct/test_timbre.py::test_update_criteria_keeps_the_snapshot PASSED [ 82%]
tests/direct/test_timbre.py::test_reclaim_refunds_only_after_the_window PASSED [ 85%]
tests/direct/test_timbre.py::test_withdraw_clears_the_credit_before_the_transfer PASSED [ 88%]
tests/direct/test_timbre.py::test_tip_is_owner_only_and_only_after_judgment PASSED [ 91%]
tests/direct/test_timbre.py::test_closed_inbox_blocks_send_but_not_judgment PASSED [ 94%]
tests/direct/test_timbre.py::test_pickling_and_calldata_roundtrip PASSED [ 97%]
tests/direct/test_timbre.py::test_get_message_builds_the_forward_mock PASSED [100%]

============================= 34 passed in 1.90s ==============================
```

## Live demo

Studionet run. Unless a row says otherwise, the receipt is `ACCEPTED`, consensus is `MAJORITY_AGREE`, and execution is `SUCCESS`. The procedure is in [DEPLOY.md](DEPLOY.md).

The first send of 01-good-report failed client-side because of a Studio read-decoder bug on payloads ≥ 256 bytes (see [docs/studio-rlp-bug.md](docs/studio-rlp-bug.md)); fixed in scripts by simulating as a write. That's why the good report is message 3, not 0.

Timbre [0x41F2…db25](https://explorer-studio.genlayer.com/address/0x41F2559149cc987087A35d7c76f6cf002D49db25), deploy [0x25e9…a257](https://explorer-studio.genlayer.com/tx/0x25e91dfc0b2c677248df2611b6e2d1b23ff964597e73ab9b30de50e26ee2a257). Owner A [0xf5Fe…3dFF](https://explorer-studio.genlayer.com/address/0xf5Fe96d62733d40f25822b20C5E46A0E17483dFF). Sender B [0x7411…BC56](https://explorer-studio.genlayer.com/address/0x74115084812fc662AaAE47B5Fd4Ef60cd5E7BC56).

Inbox 0, "tinyparse maintainers". URL stored on-chain: [demo/INBOX.md](https://raw.githubusercontent.com/Mcurly17/timbre/2cf7474e595935aec65d5619003c920c8c60c005/demo/INBOX.md), sha256 `ff6a8d558582ae27ac82dfb9eb24bf19ef55e0e7230acaa63f539f95c94521b1`.

Same file on main: https://raw.githubusercontent.com/Mcurly17/timbre/9252ac77f47969f3ff0a35732d53e27c50452aee/demo/INBOX.md — identical sha256 (ff6a8d55…21b1). 2cf7474 is a pre-rewrite commit (history was later rewritten to drop Co-authored-by trailers), so it is no longer reachable from main; the digest stored on-chain is what the contract checks.

BountyIntake [0x3fc0…3956](https://explorer-studio.genlayer.com/address/0x3fc03f1564989cEDF2D030B7871d262402943956) watches inbox 0. Deploy [0x807c…b5b5](https://explorer-studio.genlayer.com/tx/0x807c05dfaaeb8b4887fc3f2a43f05c0d0fe53b2fb3a677e9fcc22d9a31f4b5b5).

| id | file | send | judge | verdict | payout |
|---|---|---|---|---|---|
| 0 | `demo/messages/02-ai-slop.md` | [0x6b33…80cf](https://explorer-studio.genlayer.com/tx/0x6b33f4a9f84a9d59985a4ab6bc36c9d08830da14456af960cc65d2444c0480cf) | [0x1d1d…28e3](https://explorer-studio.genlayer.com/tx/0x1d1d6f1ea0aa5a2acff1c71661625402e5f1c8312c45b12b2671d6364ad928e3) | `SPAM` (S2) | 100% to owner |
| 1 | `demo/messages/03-spam.md` | [0xfc37…3f61](https://explorer-studio.genlayer.com/tx/0xfc3771ce912840cf65a53cc59a8f24dec3b251680e8a6c11b282d5b02b1f3f61) | [0x66b8…b76f](https://explorer-studio.genlayer.com/tx/0x66b8bd18a18c07a1a84ac6ea79df23d141f51d0a8a5b89b3dc6c5d534988b76f) | `SPAM` (S1) | 100% to owner |
| 2 | `demo/messages/04-injection.md` | [0xdf60…6af3](https://explorer-studio.genlayer.com/tx/0xdf6063a9c9e98586ee6dc25bae0f7ad4851e80c5be3236fc7feec00eae9e6af3) | [0x32dc…1c4d](https://explorer-studio.genlayer.com/tx/0x32dc6c866a8b7bb41051cb39b030262df47f9e840c7a2ba51bb204de4a861c4d) | `SPAM` (S3, injection ignored) | 100% to owner |
| 3 | `demo/messages/01-good-report.md` | [0x8761…8e34](https://explorer-studio.genlayer.com/tx/0x8761f35aa06d062a81c874bd19f7b508ec089ee0f64cb2097ee0d50a4c278e34) | [0x4307…ad48](https://explorer-studio.genlayer.com/tx/0x430793f8f15330f2eada88ca374557d76bc33d3500532a6f81894e1145dead48) | `RELEVANT` | refunded |
| 4 | `demo/messages/05-off-topic.md` | [0x9230…78b8](https://explorer-studio.genlayer.com/tx/0x9230540e0abb6b6f6eeaf0832f5b1389a908f4f1660c88f2d051cc6df6da78b8) | [0xedbe…527b](https://explorer-studio.genlayer.com/tx/0xedbe0a060bd72281150da6e4c541443b2c51ce1b872b1286df6b6fbfb3b0527b) | `OFF_TOPIC` | 50/50 |

Credits before withdrawal: owner A 0.035 GEN, sender B 0.015 GEN. That matches the rules for three `SPAM` stakes, one `RELEVANT` refund, and one `OFF_TOPIC` split. Withdraw A [0xc0cb…c106](https://explorer-studio.genlayer.com/tx/0xc0cb92a86b5aac2f910ce5fe1ea30ee63364f6864655eb8694d8bcfc60afc106). Withdraw B [0xb5dc…a345](https://explorer-studio.genlayer.com/tx/0xb5dc75d04eb254f1569def8ad92b70d8fabdbb460b4930785ae222a6b2e8a345).

BountyIntake read Timbre on-chain. `forward` of message 3 (`RELEVANT`) [0x2f8f…d8cb](https://explorer-studio.genlayer.com/tx/0x2f8f211717976978b81b87c665bc93072f3679f81e33ea5f6ef78ab80327d8cb). `fund` 0.05 GEN [0x2d08…fcb1](https://explorer-studio.genlayer.com/tx/0x2d0818bba6b60cd4f8126ad10785b43be414db19cb8f62d6801a440b6c4bfcb1). `award` entry 0, 0.02 GEN [0x672e…c191](https://explorer-studio.genlayer.com/tx/0x672ef083a3b1cff9be7b2894adec4eb8b60795600b8be69d4e2da800e458c191). `intake-withdraw` by B [0x4caa…f5b0](https://explorer-studio.genlayer.com/tx/0x4caae078eb65c13472d66e50b27c5a14fcb769584b0e17e537cbae018eedf5b0). Final `intake-stats`: entries 1, pool 0.03 GEN, `total_credits` 0.

### Refusals

- Sending a 4th pending message (`05-off-topic.md`) was refused by the precheck: max 3 pending per sender per inbox. No transaction was sent.
- Owner preview on their own inbox was refused: "owner cannot message own inbox". No transaction was sent.
- `forward` of message 0 (`SPAM`) was refused before submission: the intake only accepts `JUDGED` + `RELEVANT`. No transaction was sent.
- `award` with an empty pool reverted on-chain, execution `ERROR`: [0x2350…7dd3](https://explorer-studio.genlayer.com/tx/0x235041a48311719ea8b0f03260be2a9155df36ab5e2191de2f9753061d7b7dd3). `intake-withdraw` with zero credit also reverted, execution `ERROR`: [0x2d4f…a4b3](https://explorer-studio.genlayer.com/tx/0x2d4f8e8831351e43f3cea06c0e6f13a089771b1fae60928d37dddc21b43aa4b3).

Studio import: [Timbre](https://studio.genlayer.com/?import-contract=0x41F2559149cc987087A35d7c76f6cf002D49db25), [BountyIntake](https://studio.genlayer.com/?import-contract=0x3fc03f1564989cEDF2D030B7871d262402943956).

## Credits

This repository started from the [genlayerlabs](https://github.com/genlayerlabs) project boilerplate. That boilerplate is MIT-licensed, copyright 2024 YeagerAI. See [LICENSE](LICENSE).
