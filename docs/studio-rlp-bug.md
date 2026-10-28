# Studio read `gen_call` mis-decodes RLP payloads of 256 bytes or more

Reproducible bug in [genlayer-studio](https://github.com/genlayerlabs/genlayer-studio) `main`, read on 28 October 2026. No issue has been opened from this note.

## Summary

`gen_call` with `type: "read"` fails for a valid RLP payload once the outer list is 256 bytes or longer:

```text
GenLayer RPC error (gen_call): RLP string ends with N superfluous bytes
```

The same bytes decode with `rlp.decode`. `gen_call` with `type: "write"` accepts them and does not create a transaction. `viem` 2.57.12 and `pyrlp` both accept the payload (`fromRlp` reports no trailing bytes).

## Environment

- Network: Studionet
- Client: genlayer-js 1.1.8, viem 2.57.12
- Contract used for the probe: `0x41F2559149cc987087A35d7c76f6cf002D49db25`
- `from` argument inside the call: `0x74115084812fc662AaAE47B5Fd4Ef60cd5E7BC56`
- Stake argument: `10000000000000000` (0.01 GEN). The RPC `value` was omitted.

## Function

`TransactionParser.decode_method_call_data` in `backend/protocol_rpc/transactions_parser.py`, lines 604–620:

```python
def decode_method_call_data(self, data: str) -> DecodedMethodCallData:
    raw_bytes = eth_utils.hexadecimal.decode_hex(data)

    # Remove the null byte
    if raw_bytes[-1] == 0:
        raw_bytes = raw_bytes[:-1]

        # Try to decode the outer list first
        if raw_bytes[0] >= 0xF8:  # Long list
            raw_bytes = raw_bytes[2:]  # Skip list prefix and length
        elif raw_bytes[0] >= 0xC0:  # Short list
            raw_bytes = raw_bytes[1:]  # Skip list prefix

        # Now try to decode the inner string
        raw_bytes = rlp.decode(raw_bytes)

    return DecodedMethodCallData(raw_bytes)
```

`backend/protocol_rpc/endpoints.py` calls it for `gen_call` when `type == "read"` (line 1545, inside `_gen_call_with_validator`). `type == "write"` calls `decode_method_send_data` (line 1565), which uses `rlp.decode` with `MethodSendTransactionPayload`.

## Cause

The payload is `rlp.encode([calldata, leader_only])`. genlayer-js encodes `leader_only=false` as the single byte `0x00`, so the function always strips the last byte and then slices the list header by hand.

A long list whose payload is 56 to 255 bytes is prefixed by `0xF8` plus one length byte. Skipping two bytes is correct for that form. At 256 bytes the prefix is `0xF9` plus two length bytes: a three-byte header. Skipping two bytes leaves the low length byte in the buffer. `rlp.decode` then treats that byte as a new item and reports everything after it as superfluous.

The count depends on that leftover byte:

- `0x00` to `0x7F` is a one-byte item, so superfluous = `len(payload) - 4` (one stripped byte, two skipped bytes, one consumed byte).
- `0x80` to `0xB7` is a short string. For a 300-character probe the header is `f90184`, the leftover byte is `0x84`, and the error is 383 rather than 387.

## Reproduction

`readContract` sends `type: "read"` and no account is required.

```js
client.readContract({
  address: "0x41F2559149cc987087A35d7c76f6cf002D49db25",
  functionName: "preview_send",
  args: [0, "0x74115084812fc662AaAE47B5Fd4Ef60cd5E7BC56", text, "", 10000000000000000n],
  jsonSafeReturn: true,
})
```

`text` is one line of ASCII `"a"` repeated N times. The same failure happens with a real multi-line message; newlines are not the trigger.

## Observed output

| text | chars | data bytes | first bytes | result |
|---|---:|---:|---|---|
| ASCII | 150 | 239 | `f8edb8ea` | `{"error":"","ok":true}` |
| ASCII | 168 | 257 | `f8ffb8fc` | `{"error":"","ok":true}` |
| ASCII | 169 | 259 | `f90100b8` | `RLP string ends with 255 superfluous bytes` |
| ASCII | 200 | 291 | `f90120b9` | `RLP string ends with 287 superfluous bytes` |
| ASCII | 230 | 321 | `f9013eb9` | `RLP string ends with 317 superfluous bytes` |
| ASCII | 250 | 341 | `f90152b9` | `RLP string ends with 337 superfluous bytes` |
| ASCII | 300 | 391 | `f90184b9` | `RLP string ends with 383 superfluous bytes` |
| `demo/messages/01-good-report.md` | 253 | 344 | `f90155b9` | `RLP string ends with 340 superfluous bytes` |
| that file, newlines replaced by spaces | 245 | 336 | `f9014db9` | `RLP string ends with 332 superfluous bytes` |

Each error is also wrapped as viem `InternalRpcError`: `An internal error was received.` Details are the RLP sentence above. Version string: `viem@2.57.12`.

168 characters is the last success. 169 is the first failure. The outer list payload goes from 255 bytes (`0xF8 0xFF`) to 256 bytes (`0xF9 0x01 0x00`).

Replaying `decode_method_call_data` locally on the captured bytes reproduces those sentences exactly. `rlp.decode` of the same bytes, with `MethodSendTransactionPayload`, returns the calldata and `leader_only=False` for every row, including the failures.

A `gen_call` with `type: "write"`, no `value`, and the 253-character file returns the contract result `{"error":"","ok":true}` (`0x16056572726f7204026f6b10`). The captured data prefix is the same `0xf90155b901511604` that the read path rejects.

## Suggested fix

Decode the list with RLP, the same way `decode_method_send_data` already does. `MethodSendTransactionPayload` accepts `leader_only=false` as `0x00` and accepts a two-byte length.

```python
def decode_method_call_data(self, data: str) -> DecodedMethodCallData:
    decoded = rlp.decode(HexBytes(data), MethodSendTransactionPayload)
    return DecodedMethodCallData(decoded["calldata"])
```

Do not special-case `0xF8` with a fixed two-byte skip.
