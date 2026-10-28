tinyparse 2.3.1: parse_date("2026-02-30") returns 2 March instead of raising ValueError.

Repro:
pip install tinyparse==2.3.1
python -c "from tinyparse import parse_date; print(parse_date('2026-02-30'))"

Expected: ValueError
Actual: 2026-03-02
