# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
from dataclasses import dataclass
import re

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
LIST_LIMIT = 50
QUEUED = "QUEUED"
AWARDED = "AWARDED"


def _expected(msg: str) -> gl.vm.UserError:
    return gl.vm.UserError(f"[EXPECTED] {msg}")


def _address(value: object, invalid: str) -> Address:
    if not isinstance(value, str) or _ADDR_RE.match(value) is None:
        raise _expected(invalid)
    try:
        return Address(value)
    except Exception:
        raise _expected(invalid)


def _whole(value: object, invalid: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _expected(invalid)
    return value


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


@allow_storage
@dataclass
class Entry:
    message_id: u256
    sender: Address
    status: str
    amount: u256


class BountyIntake(gl.Contract):
    """Pays only for Timbre messages already judged RELEVANT. No LLM."""

    timbre: str
    inbox_id: u256
    owner: Address
    pool: u256
    entries: TreeMap[u256, Entry]
    forwarded: TreeMap[u256, u256]
    next_entry: u256
    credits: TreeMap[Address, u256]
    total_credits: u256

    def __init__(self, timbre: str, inbox_id: int):
        self.timbre = _address(timbre, "invalid timbre address").as_hex
        self.inbox_id = u256(_whole(inbox_id, "invalid inbox"))
        self.owner = gl.message.sender_address
        self.pool = u256(0)
        self.next_entry = u256(0)
        self.total_credits = u256(0)

    def _owner_only(self, action: str) -> None:
        if gl.message.sender_address != self.owner:
            raise _expected(f"only the owner can {action}")

    def _read_message(self, message_id: int) -> dict:
        # The only Timbre read. It stays outside every nondet block.
        return gl.get_contract_at(Address(self.timbre)).view().get_message(message_id)

    def _credit(self, addr: Address, amount: int) -> None:
        current = int(self.credits[addr]) if addr in self.credits else 0
        self.credits[addr] = u256(current + amount)
        self.total_credits = u256(int(self.total_credits) + amount)

    def _entry(self, entry_id: int) -> Entry:
        if _whole(entry_id, "unknown entry") >= int(self.next_entry):
            raise _expected("unknown entry")
        return self.entries[u256(entry_id)]

    def _view(self, entry_id: int, entry: Entry) -> dict:
        return {
            "id": entry_id,
            "message_id": int(entry.message_id),
            "sender": entry.sender.as_hex,
            "status": entry.status,
            "amount": int(entry.amount),
        }

    @gl.public.write.payable
    def fund(self) -> int:
        self._owner_only("fund")
        amount = int(gl.message.value)
        if amount <= 0:
            raise _expected("fund must be greater than 0")
        self.pool = u256(int(self.pool) + amount)
        return int(self.pool)

    @gl.public.write
    def forward(self, message_id: int) -> int:
        message_id = _whole(message_id, "unknown message")
        key = u256(message_id)
        if key in self.forwarded:
            raise _expected("message already forwarded")
        message = self._read_message(message_id)
        if not isinstance(message, dict):
            raise _expected("message unreadable")
        if message.get("inbox_id") != int(self.inbox_id):
            raise _expected("message is from another inbox")
        if message.get("status") != "JUDGED":
            raise _expected("message is not judged")
        if message.get("verdict") != "RELEVANT":
            raise _expected("message is not relevant")
        entry_id = int(self.next_entry)
        self.entries[u256(entry_id)] = Entry(
            message_id=key,
            sender=_address(message.get("sender"), "message is not relevant"),
            status=QUEUED,
            amount=u256(0),
        )
        self.forwarded[key] = u256(entry_id)
        self.next_entry = u256(entry_id + 1)
        return entry_id

    @gl.public.write
    def award(self, entry_id: int, amount: int) -> None:
        self._owner_only("award")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
            raise _expected("award must be greater than 0")
        entry = self._entry(entry_id)
        if entry.status != QUEUED:
            raise _expected("entry already awarded")
        if amount > int(self.pool):
            raise _expected("amount exceeds pool")
        self.pool = u256(int(self.pool) - amount)
        entry.amount = u256(amount)
        entry.status = AWARDED
        self._credit(entry.sender, amount)

    @gl.public.write
    def withdraw(self) -> int:
        sender = gl.message.sender_address
        amount = int(self.credits[sender]) if sender in self.credits else 0
        if amount <= 0:
            raise _expected("nothing to withdraw")
        # Clear the ledger before the transfer.
        self.credits[sender] = u256(0)
        self.total_credits = u256(int(self.total_credits) - amount)
        _Recipient(sender).emit_transfer(value=u256(amount))
        return amount

    @gl.public.view
    def get_entry(self, id: int) -> dict:
        return self._view(id, self._entry(id))

    @gl.public.view
    def list_entries(self, offset: int, limit: int) -> list:
        offset = _whole(offset, "offset must be a non-negative integer")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= LIST_LIMIT:
            raise _expected("limit must be between 1 and 50")
        total = int(self.next_entry)
        if offset >= total:
            return []
        end = min(offset + limit, total)
        return [self._view(i, self.entries[u256(i)]) for i in range(offset, end)]

    @gl.public.view
    def get_credit(self, addr_hex: str) -> int:
        addr = _address(addr_hex, "invalid address")
        return int(self.credits[addr]) if addr in self.credits else 0

    @gl.public.view
    def stats(self) -> dict:
        return {
            "owner": self.owner.as_hex,
            "timbre": self.timbre,
            "inbox_id": int(self.inbox_id),
            "pool": int(self.pool),
            "entries": int(self.next_entry),
            "total_credits": int(self.total_credits),
        }
