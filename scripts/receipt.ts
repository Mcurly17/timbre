// Pure receipt check. Studio uses snake_case; other nodes use camelCase.
// A call counts only when status, consensus, and execution are all in the accepted sets.

export type ReceiptSummary = {
  hash: string;
  status: string | null;
  consensus: string | null;
  execution: string | null;
  explorer: string;
  ok: boolean;
};

const STATUS_NUMBER: Record<string, string> = {
  "0": "UNINITIALIZED",
  "1": "PENDING",
  "2": "PROPOSING",
  "3": "COMMITTING",
  "4": "REVEALING",
  "5": "ACCEPTED",
  "6": "UNDETERMINED",
  "7": "FINALIZED",
  "8": "CANCELED",
  "9": "APPEAL_REVEALING",
  "10": "APPEAL_COMMITTING",
  "11": "READY_TO_FINALIZE",
  "12": "VALIDATORS_TIMEOUT",
  "13": "LEADER_TIMEOUT",
};

const RESULT_NUMBER: Record<string, string> = {
  "0": "IDLE",
  "1": "AGREE",
  "2": "DISAGREE",
  "3": "TIMEOUT",
  "4": "DETERMINISTIC_VIOLATION",
  "5": "NO_MAJORITY",
  "6": "MAJORITY_AGREE",
  "7": "MAJORITY_DISAGREE",
};

const EXECUTION_NUMBER: Record<string, string> = {
  "0": "NOT_VOTED",
  "1": "FINISHED_WITH_RETURN",
  "2": "FINISHED_WITH_ERROR",
};

const OK_STATUS = new Set(["ACCEPTED", "FINALIZED"]);
const OK_CONSENSUS = new Set(["MAJORITY_AGREE", "AGREE"]);
const OK_EXECUTION = new Set(["FINISHED_WITH_RETURN", "SUCCESS"]);

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | null {
  return value !== null && typeof value === "object" ? (value as Loose) : null;
}

function named(value: unknown, numbers?: Record<string, string>): string | null {
  if (typeof value === "string" && value !== "" && !/^\d+$/.test(value)) return value;
  if (!numbers) return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    return numbers[String(value)] ?? null;
  }
  return null;
}

function firstNamed(numbers: Record<string, string> | undefined, ...values: unknown[]): string | null {
  for (const value of values) {
    const label = named(value, numbers);
    if (label) return label;
  }
  return null;
}

function leaderExecution(record: Loose): unknown {
  const data = asRecord(record.consensus_data) ?? asRecord(record.consensusData);
  if (!data) return undefined;
  const list = data.leader_receipt ?? data.leaderReceipt;
  const first = Array.isArray(list) ? list[0] : list;
  const leader = asRecord(first);
  return leader ? leader.execution_result : undefined;
}

export function interpretReceipt(receipt: unknown, hash = ""): ReceiptSummary {
  const record = asRecord(receipt) ?? {};
  const status = firstNamed(STATUS_NUMBER, record.statusName, record.status_name, record.status);
  const consensus = firstNamed(RESULT_NUMBER, record.resultName, record.result_name, record.result);
  const execution = firstNamed(
    EXECUTION_NUMBER,
    record.txExecutionResultName,
    record.tx_execution_result_name,
    leaderExecution(record),
    record.txExecutionResult,
    record.tx_execution_result,
  );
  const txHash =
    hash ||
    (typeof record.hash === "string" ? record.hash : "") ||
    (typeof record.tx_hash === "string" ? record.tx_hash : "");
  const ok =
    status !== null &&
    OK_STATUS.has(status) &&
    consensus !== null &&
    OK_CONSENSUS.has(consensus) &&
    execution !== null &&
    OK_EXECUTION.has(execution);
  return {
    hash: txHash,
    status,
    consensus,
    execution,
    explorer: `https://explorer-studio.genlayer.com/tx/${txHash}`,
    ok,
  };
}

export function receiptReport(summary: ReceiptSummary): Omit<ReceiptSummary, "ok"> {
  return {
    hash: summary.hash,
    status: summary.status,
    consensus: summary.consensus,
    execution: summary.execution,
    explorer: summary.explorer,
  };
}
