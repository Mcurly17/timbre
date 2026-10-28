import assert from "node:assert/strict";
import test from "node:test";
import { interpretReceipt } from "../../scripts/receipt.ts";

const HASH = "0x" + "ab".repeat(32);

test("camelCase ACCEPTED + MAJORITY_AGREE + FINISHED_WITH_RETURN succeeds", () => {
  const out = interpretReceipt(
    {
      statusName: "ACCEPTED",
      resultName: "MAJORITY_AGREE",
      txExecutionResultName: "FINISHED_WITH_RETURN",
    },
    HASH,
  );
  assert.equal(out.ok, true);
  assert.equal(out.status, "ACCEPTED");
  assert.equal(out.consensus, "MAJORITY_AGREE");
  assert.equal(out.execution, "FINISHED_WITH_RETURN");
  assert.equal(out.explorer, `https://explorer-studio.genlayer.com/tx/${HASH}`);
});

test("snake_case FINALIZED + leader SUCCESS succeeds", () => {
  const out = interpretReceipt({
    status_name: "FINALIZED",
    result_name: "AGREE",
    consensus_data: { leader_receipt: [{ execution_result: "SUCCESS" }] },
  }, HASH);
  assert.equal(out.ok, true);
  assert.equal(out.consensus, "AGREE");
  assert.equal(out.execution, "SUCCESS");
});

test("numeric status 5 and result 6 are ACCEPTED and MAJORITY_AGREE", () => {
  const out = interpretReceipt({ status: 5, result: 6, txExecutionResultName: "SUCCESS" }, HASH);
  assert.equal(out.ok, true);
  assert.equal(out.status, "ACCEPTED");
  assert.equal(out.consensus, "MAJORITY_AGREE");
});

test("NO_MAJORITY is not a success", () => {
  const out = interpretReceipt({
    statusName: "ACCEPTED",
    resultName: "NO_MAJORITY",
    txExecutionResultName: "FINISHED_WITH_RETURN",
  }, HASH);
  assert.equal(out.ok, false);
  assert.equal(out.consensus, "NO_MAJORITY");
});

test("execution error is not a success", () => {
  const out = interpretReceipt({
    status_name: "FINALIZED",
    result_name: "MAJORITY_AGREE",
    consensus_data: { leader_receipt: [{ execution_result: "FINISHED_WITH_ERROR" }] },
  }, HASH);
  assert.equal(out.ok, false);
  assert.equal(out.execution, "FINISHED_WITH_ERROR");
});

test("UNDETERMINED is not a success, including numeric status 6", () => {
  const named = interpretReceipt({
    statusName: "UNDETERMINED",
    resultName: "MAJORITY_AGREE",
    txExecutionResultName: "SUCCESS",
  }, HASH);
  const numbered = interpretReceipt({ status: 6, result: 6, tx_execution_result: 1 }, HASH);
  assert.equal(named.ok, false);
  assert.equal(named.status, "UNDETERMINED");
  assert.equal(numbered.ok, false);
  assert.equal(numbered.status, "UNDETERMINED");
  assert.equal(numbered.execution, "FINISHED_WITH_RETURN");
});
