# Architecture

Timbre stores inboxes, messages, and credits. The judgment itself is not a pure function of that storage. The criteria text, an optional message file, and the model output all come from outside the contract, and the validators have to agree on two fields before any credit moves.

## What the contract does, and what comes from outside

The contract checks what it can check locally, before any network read:

- the inbox exists and is open;
- the caller is not the owner of that inbox;
- the stake is inside `[min_stake, max_stake]`;
- exactly one of `text` and `text_url` is set, and `text` has a bounded shape;
- a URL, when required, is pinned to a commit;
- pending-message caps (3 per sender per inbox, 50 per inbox).

`send_message` stores the message as `PENDING` and snapshots `criteria_url`. It does not fetch the criteria. A later `update_criteria` does not change that snapshot.

`judge` is the only method that reads the outside world. Inside one nondeterministic block the leader:

1. fetches the pinned criteria text;
2. uses the stored `text`, or fetches `text_url`;
3. asks the model for one label in a closed set of four, plus a short reason and the criterion ids it thinks were met;
4. returns that object together with `sha256` of the criteria text.

Validators run the same function. They accept the leader only when `label` and `criteria_digest` are equal. The explanation is not part of the comparison. On agreement, the contract writes the verdict and credits the stake. It does not transfer. `withdraw` is a separate call: zero the credit, then emit the transfer.

What stays outside the contract:

- the criteria document and any `text_url` file, served from a pinned URL the validators fetch;
- the model that produces the label (the sender and the owner do not pick it, and neither of them can pass a verdict in);
- leader selection, rotation, and an `UNDETERMINED` result when no majority forms (network behavior; the contract state is unchanged);
- `msg.value`, and the Studionet rule that a refused payable call keeps the value that was attached;
- `BountyIntake`, which only reads `get_message` and never re-judges.

`preview_send` repeats the local send checks as a view, so the CLI can refuse a payable call before any value is attached.

## Message lifecycle

A message is created `PENDING`, with `judge_deadline` set to seven days after `sent_at`.

From `PENDING` there are two exits:

- `judge` agrees, while `now` is still within the deadline. Status becomes `JUDGED`. `verdict` is `RELEVANT`, `OFF_TOPIC`, `SPAM`, or `UNCERTAIN`, and the stake is credited as that verdict requires.
- `reclaim` after the deadline. Status becomes `EXPIRED`. The full stake is credited back to the sender.

Two failures leave the message `PENDING`:

- the validators disagree, or the model output is not a label in the closed set (`[LLM_ERROR]`). The transaction does not commit. `judge` can be called again.
- a fetch of the criteria or of `text_url` is transient (5xx, 429, timeout). The call reverts. `judge` can be retried, or `reclaim` refunds the stake once the deadline has passed.

`judge` on a message that is not `PENDING` reverts. `reclaim` before the deadline reverts. Closing the inbox blocks new sends and does not block judgment of what is already pending.

## Solvency

Neither contract takes a fee. Credits are pull payments: the ledger entry is removed before `emit_transfer`, so a failed transfer cannot leave a credit that can be withdrawn twice, and a transfer is never attempted from inside `judge` or `award`.

### Timbre

Every settlement path in the direct tests checks:

```text
sum of PENDING stakes + total_credits == value received - value withdrawn
```

`PENDING` stakes are still held. `total_credits` is the sum of credits not yet withdrawn. The right-hand side is the value that has entered the contract and not left it.

`RELEVANT` and `UNCERTAIN` credit the whole stake to the sender. `SPAM` credits the whole stake to the owner. `EXPIRED` credits the whole stake to the sender. `OFF_TOPIC` splits with `owner_part = stake * 5000 // 10000` and gives the sender `stake - owner_part`, so the two credits sum to the stake. A `tip` adds its value to the sender's credit and to `total_credits`, and the same identity still holds because that value was received.

### BountyIntake

`fund` adds `msg.value` to `pool`. `award` subtracts `amount` from `pool` and adds the same `amount` to the sender's credit and to `total_credits`. `withdraw` subtracts the credit from `total_credits` and only then transfers it.

So at every quiet point:

```text
pool + total_credits == sum of fund values - sum of withdraw transfers
```

An award moves wei from the pool to a credit and does not change that sum. `award` reverts when `amount` is greater than `pool`. The direct tests check that bound, and they check that `withdraw` clears the credit before the transfer. They do not deploy Timbre and BountyIntake in one process: the runner allows one contract, so `forward`'s read of Timbre is mocked there. The live `get_message` call is part of the Studionet demo, not of those tests.

## Errors

User errors carry a prefix. Inside the nondeterministic block, validators compare those errors as follows. `[EXPECTED]` and `[EXTERNAL]` (including `[EXTERNAL][SENDER]`) agree only when the message text is identical. `[TRANSIENT]` agrees when both sides are transient, without comparing the rest of the text. `[LLM_ERROR]` is a disagreement, so the leader rotates.

| Prefix | When it is raised | What `judge` does with it |
|---|---|---|
| `[EXPECTED]` | A local rule failed: unknown id, owner messaging their own inbox, stake out of range, empty credit, and the other checks that do not touch the network. | The call reverts. No credit moves. On `send_message` this is why `preview_send` exists: on Studionet the attached value would stay. |
| `[EXTERNAL]` | The criteria file is a 4xx, larger than 8000 characters, or not text. | Settled as `UNCERTAIN`. The stake is credited back to the sender. |
| `[EXTERNAL][SENDER]` | `text_url` is a 4xx, larger than 8000 characters, or not text. Raised as `[EXTERNAL][SENDER] message file unavailable: …`. | Settled as `SPAM`. The stake is credited to the owner. The sender does not get a refund for a file they failed to keep available. |
| `[TRANSIENT]` | The criteria URL or `text_url` returns 5xx or 429, or the fetch times out. | The call reverts. The message stays `PENDING`. |
| `[LLM_ERROR]` | The model output has no usable object, or `label` is not one of the four values (after `OFF-TOPIC` and `OFF TOPIC` are normalized). | Treated as disagreement. No state change. The message stays `PENDING`. |
