# Deploy Timbre on Studionet

This script sends the payable calls (`send_message`, `tip`, `fund`). The `genlayer write` command cannot attach a message value, so it is not used for those methods.

## Prerequisites

- Node.js 22 or newer
- `npm install` in this repository (genlayer-js 1.1.8 is pinned)
- The GenLayer CLI

## Import the two test accounts yourself

The CLI asks for the key with masked input. Do not put a key in `.env`, and do not pass a key on the command line. Do not add a key flag to the import command.

```sh
genlayer account import --name timbre-a
genlayer account import --name timbre-b
```

`npm run timbre` reads `~/.genlayer/keystores/<TIMBRE_ACCOUNT>.json`, asks for the keystore password (the prompt is masked with `*`), and prints only `From 0x…`.

## Network

```sh
genlayer network set studionet
```

Copy `.env.example` to `.env`:

```
GENLAYER_NETWORK=studionet
TIMBRE_CONTRACT=
INTAKE_CONTRACT=
TIMBRE_ACCOUNT=timbre-a
```

Any other `GENLAYER_NETWORK` is refused. Switch accounts by changing `TIMBRE_ACCOUNT` to `timbre-a` or `timbre-b`.

## Test GEN

Each account needs a Studionet balance. Open [GenLayer Studio](https://studio.genlayer.com/) and use the faucet button if a balance is empty.

## Order

Validators read `demo/INBOX.md` from its commit-pinned raw URL. The file is visible to them only after a public push.

1. Push this repository to a public remote. Copy the 40-character commit SHA. If the remote is not `Mcurly17/timbre`, use that owner and repository name in the URL below.
2. `npm run timbre -- deploy-timbre`
3. Put the printed address in `TIMBRE_CONTRACT`.
4. Run the demo below (section 11 of the spec).
5. `npm run timbre -- deploy-intake <timbre_addr> 0`
6. Put that address in `INTAKE_CONTRACT`.
7. Fund the intake, forward the RELEVANT message, award it, and withdraw. That sequence is the live cross-contract call. Direct-mode tests cannot make it: the runner loads only one contract per process.

A step counts only when the receipt status is `ACCEPTED` or `FINALIZED`, the consensus is `MAJORITY_AGREE` or `AGREE`, and the execution is `FINISHED_WITH_RETURN` or `SUCCESS`. Keep each hash. If a verdict differs from the table, write the label the chain returned. Do not rewrite history.

Payable calls are prechecked. On Studionet a refused payable keeps the value, so `send`, `send-url`, `tip`, and `fund` are not submitted when the precheck fails. `forward` reads `get_message` first and is not submitted unless that message is `JUDGED` / `RELEVANT` in the intake's inbox.

## Demo

Account A (`TIMBRE_ACCOUNT=timbre-a`):

```sh
npm run timbre -- open "tinyparse maintainers" "https://raw.githubusercontent.com/Mcurly17/timbre/<SHA>/demo/INBOX.md" 0.01 0.1
```

Account B (`TIMBRE_ACCOUNT=timbre-b`). Contract message ids start at 0. Demo row 1 is message 0.

```sh
npm run timbre -- send 0 demo/messages/01-good-report.md 0.01
npm run timbre -- send 0 demo/messages/02-ai-slop.md 0.01
npm run timbre -- send 0 demo/messages/03-spam.md 0.01
npm run timbre -- send 0 demo/messages/04-injection.md 0.01
npm run timbre -- send 0 demo/messages/05-off-topic.md 0.01
```

Either account can judge:

```sh
npm run timbre -- judge 0
npm run timbre -- judge 1
npm run timbre -- judge 2
npm run timbre -- judge 3
npm run timbre -- judge 4
```

Expected labels: 0 `RELEVANT`, 1 `SPAM` (vague report, rule S2), 2 `SPAM`, 3 `SPAM` (injection), 4 `OFF_TOPIC`.

```sh
TIMBRE_ACCOUNT=timbre-a npm run timbre -- withdraw
TIMBRE_ACCOUNT=timbre-b npm run timbre -- withdraw
```

The owner must not message their own inbox. Use preview only. Do not send value:

```sh
TIMBRE_ACCOUNT=timbre-a npm run timbre -- preview 0 "hello from the owner of this inbox, which must be refused" 0.01
```

## BountyIntake

Account A, after message 0 is `RELEVANT`:

```sh
npm run timbre -- deploy-intake <TIMBRE_CONTRACT> 0
npm run timbre -- fund 0.05
npm run timbre -- forward 0
npm run timbre -- award 0 0.02
```

`forward 1` is the first `SPAM` message and must be refused before submission.

Account B collects the award:

```sh
TIMBRE_ACCOUNT=timbre-b npm run timbre -- intake-withdraw
```

## Links

- Import into Studio: `https://studio.genlayer.com/?import-contract=0x…`
- Address on the explorer: `https://explorer-studio.genlayer.com/address/0x…`
- Transaction on the explorer: `https://explorer-studio.genlayer.com/tx/0x…`

`deploy-timbre` and `deploy-intake` print these links when the receipt succeeds.
