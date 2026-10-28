// Studionet CLI for Timbre. Payable methods cannot go through `genlayer write`
// because that command cannot attach a message value.
//
//   npm run timbre -- <command> [args...]
//
// The signer is an encrypted CLI keystore. This process prints the address only.
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import password from "@inquirer/password";
import { Wallet } from "ethers";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus, type Address, type CalldataEncodable } from "genlayer-js/types";
import { interpretReceipt, receiptReport, type ReceiptSummary } from "./receipt.ts";

const TIMBRE_CODE = "contracts/timbre.py";
const INTAKE_CODE = "contracts/bounty_intake.py";

const USAGE = `commands (GEN amounts are decimals, converted to wei with BigInt):
  deploy-timbre
  deploy-intake <timbre_addr> <inbox_id>
  open <name> <criteria_url> <min_gen> <max_gen>
  update-criteria <inbox> <url>
  set-open <inbox> true|false
  send <inbox> <file.md or text> <stake_gen>
  send-url <inbox> <pinned_url> <stake_gen>
  preview <inbox> <file.md or text> <stake_gen>
  judge <msg> | reclaim <msg> | tip <msg> <gen> | withdraw
  forward <msg> | fund <gen> | award <entry> <gen>
  intake-withdraw | intake-stats | entries [offset] [limit]
  inbox <id> | message <id> | messages <inbox> [offset] [limit]
  credit <addr> | stats | inbox-stats <id>
env: GENLAYER_NETWORK=studionet, TIMBRE_CONTRACT, INTAKE_CONTRACT, TIMBRE_ACCOUNT
     (keystore name, for example timbre-a). Payable calls are prechecked and
     are not submitted when the precheck fails.`;

type Account = ReturnType<typeof createAccount>;
type Client = ReturnType<typeof createClient>;

let cachedAccount: Account | undefined;

function fail(message: string): never {
  throw new Error(message);
}

function assertStudionet(): void {
  const network = process.env.GENLAYER_NETWORK || "studionet";
  if (network !== "studionet") {
    fail(`GENLAYER_NETWORK=${network} is refused. This script uses Studionet only (genlayer-js 1.1.8).`);
  }
}

function show(value: unknown): void {
  console.log(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2));
}

function intArg(value: string, label: string): number {
  if (!/^\d+$/.test(value)) fail(`${label} must be a non-negative integer, got: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is too large: ${value}`);
  return parsed;
}

export function genToWei(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(amount);
  if (!match) fail(`invalid GEN amount: ${amount}`);
  const fraction = (match[2] ?? "").padEnd(18, "0");
  return BigInt(match[1]) * 10n ** 18n + BigInt(fraction);
}

function addressEnv(name: "TIMBRE_CONTRACT" | "INTAKE_CONTRACT"): Address {
  const value = process.env[name] ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`${name} is not set to a 0x address. See .env.example.`);
  }
  return value as Address;
}

function chainAddress(value: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`${label} must be a 0x address, got: ${value}`);
  return value as Address;
}

function messageText(input: string): string {
  const candidate = path.resolve(input);
  if (existsSync(candidate) && statSync(candidate).isFile()) return readFileSync(candidate, "utf8");
  return input;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function page(args: string[]): [number, number] {
  if (args.length > 2) fail("expected at most [offset] [limit]");
  const offset = args.length >= 1 ? intArg(args[0], "offset") : 0;
  const limit = args.length >= 2 ? intArg(args[1], "limit") : 20;
  if (limit < 1 || limit > 50) fail("limit must be between 1 and 50");
  return [offset, limit];
}

async function signer(): Promise<Account> {
  if (cachedAccount) return cachedAccount;
  const name = process.env.TIMBRE_ACCOUNT ?? "";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    fail("TIMBRE_ACCOUNT is not set to a keystore name (for example timbre-a).");
  }
  const file = path.join(os.homedir(), ".genlayer", "keystores", `${name}.json`);
  if (!existsSync(file)) {
    fail(`keystore ${name} was not found. Import it with: genlayer account import --name ${name}`);
  }
  const text = readFileSync(file, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    fail("keystore file is not JSON");
  }
  let payload: string;
  if (parsed.encrypted != null) {
    payload = typeof parsed.encrypted === "string" ? parsed.encrypted : JSON.stringify(parsed.encrypted);
  } else if (parsed.crypto != null || parsed.Crypto != null) {
    payload = text;
  } else {
    fail("unrecognized keystore format");
  }
  const passphrase = await password({ message: "Keystore password", mask: "*" });
  if (passphrase === "") fail("password is empty");
  let wallet: Wallet;
  try {
    wallet = await Wallet.fromEncryptedJson(payload, passphrase);
  } catch {
    fail("could not decrypt the keystore");
  }
  const secret = wallet.privateKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) fail("decrypted keystore did not yield an account");
  const account = createAccount(secret as `0x${string}`);
  console.log(`From ${account.address}`);
  cachedAccount = account;
  return account;
}

function client(account?: Account): Client {
  return createClient({ chain: studionet, account });
}

async function read(address: Address, functionName: string, args: CalldataEncodable[] = []): Promise<unknown> {
  return client().readContract({ address, functionName, args, jsonSafeReturn: true });
}

async function settle(rpc: Client, hash: string): Promise<ReceiptSummary> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) fail("the node did not return a transaction hash");
  let receipt: unknown;
  for (let attempt = 1; ; attempt++) {
    try {
      receipt = await rpc.waitForTransactionReceipt({
        hash: hash as `0x${string}`,
        status: TransactionStatus.ACCEPTED,
        retries: 200,
        interval: 3000,
      });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      const message = error instanceof Error ? error.message : "receipt read failed";
      console.error(`receipt read failed for ${hash} (attempt ${attempt}), retrying without resending: ${message}`);
      await new Promise((done) => setTimeout(done, 3000));
    }
  }
  const summary = interpretReceipt(receipt, hash);
  const deployed = deployedAddress(receipt);
  const report = receiptReport(summary);
  if (deployed) {
    show({
      ...report,
      contractAddress: deployed,
      studio: `https://studio.genlayer.com/?import-contract=${deployed}`,
      addressExplorer: `https://explorer-studio.genlayer.com/address/${deployed}`,
    });
  } else {
    show(report);
  }
  if (!summary.ok) process.exitCode = 1;
  return summary;
}

function deployedAddress(receipt: unknown): string | null {
  const record = asRecord(receipt);
  if (!record) return null;
  const data = asRecord(record.data);
  const decoded = asRecord(record.txDataDecoded);
  const value = data?.contract_address ?? decoded?.contractAddress;
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

async function transact(address: Address, functionName: string, args: CalldataEncodable[], value = 0n): Promise<void> {
  const account = await signer();
  const rpc = client(account);
  const hash = await rpc.writeContract({ address, functionName, args, value });
  await settle(rpc, String(hash));
}

async function deploy(codePath: string, args: CalldataEncodable[]): Promise<void> {
  const account = await signer();
  const rpc = client(account);
  const code = new Uint8Array(readFileSync(codePath));
  const hash = await rpc.deployContract({ code, args });
  await settle(rpc, String(hash));
}

function previewProblem(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return "preview_send returned an unreadable result";
  const error = typeof record.error === "string" ? record.error : "";
  if (record.ok === false || error !== "") return error || "preview_send refused the message";
  return null;
}

async function loadPreview(inbox: number, text: string, textUrl: string, stake: bigint, from: string): Promise<unknown> {
  return read(addressEnv("TIMBRE_CONTRACT"), "preview_send", [inbox, from, text, textUrl, stake]);
}

async function requireTipAllowed(messageId: number, from: string): Promise<void> {
  const timbre = addressEnv("TIMBRE_CONTRACT");
  const message = asRecord(await read(timbre, "get_message", [messageId]));
  if (!message) fail("refusing to tip, no value was submitted: message is unreadable");
  if (message.status !== "JUDGED") {
    fail(`refusing to tip, no value was submitted: message status is ${String(message.status)}`);
  }
  const inboxId = asInt(message.inbox_id);
  if (inboxId === null) fail("refusing to tip, no value was submitted: message has no inbox");
  const inbox = asRecord(await read(timbre, "get_inbox", [inboxId]));
  if (!inbox || !sameAddress(inbox.owner, from)) {
    fail("refusing to tip, no value was submitted: only the inbox owner can tip");
  }
}

async function requireFundAllowed(from: string): Promise<void> {
  const stats = asRecord(await read(addressEnv("INTAKE_CONTRACT"), "stats"));
  if (!stats || !sameAddress(stats.owner, from)) {
    fail("refusing to fund, no value was submitted: only the intake owner can fund");
  }
}

async function requireForwardable(messageId: number): Promise<void> {
  const intake = asRecord(await read(addressEnv("INTAKE_CONTRACT"), "stats"));
  const message = asRecord(await read(addressEnv("TIMBRE_CONTRACT"), "get_message", [messageId]));
  const watched = intake ? asInt(intake.inbox_id) : null;
  const inboxId = message ? asInt(message.inbox_id) : null;
  const status = message && typeof message.status === "string" ? message.status : "";
  const verdict = message && typeof message.verdict === "string" ? message.verdict : "";
  if (watched === null || inboxId !== watched || status !== "JUDGED" || verdict !== "RELEVANT") {
    fail(
      `refusing forward, nothing was submitted: message ${messageId} is ${status || "unknown"}/${verdict || "none"} in inbox ${inboxId}, intake watches inbox ${watched}`,
    );
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  assertStudionet();
  const need = (count: number) => {
    if (args.length !== count) fail(`${command} expects ${count} arguments\n${USAGE}`);
  };
  const timbre = () => addressEnv("TIMBRE_CONTRACT");
  const intake = () => addressEnv("INTAKE_CONTRACT");

  switch (command) {
    case "deploy-timbre":
      need(0);
      return deploy(TIMBRE_CODE, []);
    case "deploy-intake":
      need(2);
      return deploy(INTAKE_CODE, [chainAddress(args[0], "timbre address"), intArg(args[1], "inbox")]);
    case "open":
      need(4);
      return transact(timbre(), "open_inbox", [args[0], args[1], genToWei(args[2]), genToWei(args[3])]);
    case "update-criteria":
      need(2);
      return transact(timbre(), "update_criteria", [intArg(args[0], "inbox"), args[1]]);
    case "set-open":
      need(2);
      if (args[1] !== "true" && args[1] !== "false") fail("set-open expects true or false");
      return transact(timbre(), "set_open", [intArg(args[0], "inbox"), args[1] === "true"]);
    case "send":
    case "send-url":
    case "preview": {
      need(3);
      timbre();
      const inbox = intArg(args[0], "inbox");
      const stake = genToWei(args[2]);
      const text = command === "send-url" ? "" : messageText(args[1]);
      const textUrl = command === "send-url" ? args[1] : "";
      const account = await signer();
      const preview = await loadPreview(inbox, text, textUrl, stake, account.address);
      const problem = previewProblem(preview);
      if (command === "preview") {
        show(preview);
        if (problem) fail(problem);
        return;
      }
      if (problem) fail(`refusing to send, no value was submitted: ${problem}`);
      return transact(timbre(), "send_message", [inbox, text, textUrl], stake);
    }
    case "judge":
      need(1);
      return transact(timbre(), "judge", [intArg(args[0], "message")]);
    case "reclaim":
      need(1);
      return transact(timbre(), "reclaim", [intArg(args[0], "message")]);
    case "tip": {
      need(2);
      timbre();
      const account = await signer();
      const messageId = intArg(args[0], "message");
      const amount = genToWei(args[1]);
      if (amount <= 0n) fail("tip must be greater than 0");
      await requireTipAllowed(messageId, account.address);
      return transact(timbre(), "tip", [messageId], amount);
    }
    case "withdraw":
      need(0);
      return transact(timbre(), "withdraw", []);
    case "forward": {
      need(1);
      const messageId = intArg(args[0], "message");
      await requireForwardable(messageId);
      return transact(intake(), "forward", [messageId]);
    }
    case "fund": {
      need(1);
      intake();
      const account = await signer();
      const amount = genToWei(args[0]);
      if (amount <= 0n) fail("fund must be greater than 0");
      await requireFundAllowed(account.address);
      return transact(intake(), "fund", [], amount);
    }
    case "award":
      need(2);
      return transact(intake(), "award", [intArg(args[0], "entry"), genToWei(args[1])]);
    case "intake-withdraw":
      need(0);
      return transact(intake(), "withdraw", []);
    case "intake-stats":
      need(0);
      return show(await read(intake(), "stats"));
    case "entries":
      return show(await read(intake(), "list_entries", page(args)));
    case "inbox":
      need(1);
      return show(await read(timbre(), "get_inbox", [intArg(args[0], "inbox")]));
    case "message":
      need(1);
      return show(await read(timbre(), "get_message", [intArg(args[0], "message")]));
    case "messages": {
      if (args.length < 1 || args.length > 3) fail(`messages expects <inbox> [offset] [limit]\n${USAGE}`);
      const inbox = intArg(args[0], "inbox");
      const [offset, limit] = page(args.slice(1));
      return show(await read(timbre(), "list_messages", [inbox, offset, limit]));
    }
    case "credit":
      need(1);
      return show(await read(timbre(), "get_credit", [chainAddress(args[0], "address")]));
    case "stats":
      need(0);
      return show(await read(timbre(), "stats"));
    case "inbox-stats":
      need(1);
      return show(await read(timbre(), "inbox_stats", [intArg(args[0], "inbox")]));
    default:
      fail(`unknown command: ${command}\n${USAGE}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
