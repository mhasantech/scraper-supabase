#!/usr/bin/env python3
"""Fetch DSE historical rows through bdshare and write NDJSON for Node."""
import json
import sys
from datetime import date, timedelta
from pathlib import Path


def date_chunks(start: str, end: str, days: int = 90):
    cur = date.fromisoformat(start)
    last = date.fromisoformat(end)
    while cur <= last:
        chunk_end = min(cur + timedelta(days=days - 1), last)
        yield cur.isoformat(), chunk_end.isoformat()
        cur = chunk_end + timedelta(days=1)


def main():
    if len(sys.argv) != 4:
        print("Usage: dse_history_fetch.py START_DATE END_DATE OUTPUT_NDJSON", file=sys.stderr)
        return 2

    start, end, output = sys.argv[1:]

    try:
        from bdshare import get_historical_data
    except Exception as exc:
        print(f"❌ bdshare import failed: {exc}", file=sys.stderr)
        print("Install with: pip install -r requirements.txt", file=sys.stderr)
        return 1

    print(f"🐍 bdshare historical fetch: {start} -> {end}", flush=True)
    print("🌐 Source: DSE historical archive via bdshare (retries + fallback)", flush=True)

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("", encoding="utf-8")

    rows_written = 0
    unique_keys = set()
    total_source_rows = 0

    def num(v, integer=False):
        if v is None:
            return 0 if integer else 0.0
        try:
            return int(float(v)) if integer else float(v)
        except (TypeError, ValueError):
            return 0 if integer else 0.0

    with output_path.open("a", encoding="utf-8") as fh:
        for chunk_start, chunk_end in date_chunks(start, end, days=90):
            print(f"📦 Fetching chunk: {chunk_start} -> {chunk_end}", flush=True)
            try:
                df = get_historical_data(
                    start=chunk_start,
                    end=chunk_end,
                    code="All Instrument",
                    retry_count=3,
                    pause=0.4,
                )
            except Exception as exc:
                print(f"❌ DSE chunk failed ({chunk_start} -> {chunk_end}): {exc}", file=sys.stderr)
                return 1

            if df is None or df.empty:
                print(f"⚠️ No rows returned for {chunk_start} -> {chunk_end}")
                continue

            total_source_rows += len(df)
            df = df.reset_index()
            required = ["date", "symbol", "ltp", "high", "low", "open", "ycp", "trade", "value", "volume"]
            missing = [c for c in required if c not in df.columns]
            if missing:
                print(f"❌ Unexpected bdshare columns; missing: {missing}", file=sys.stderr)
                print(f"Available columns: {list(df.columns)}", file=sys.stderr)
                return 1

            for rec in df[required].to_dict(orient="records"):
                ticker = str(rec.get("symbol") or "").strip().upper()
                date_value = str(rec.get("date") or "").strip()
                if not ticker or not date_value:
                    continue
                if len(date_value) > 10 and date_value[4] == '-':
                    date_value = date_value[:10]

                key = (ticker, date_value)
                if key in unique_keys:
                    continue
                unique_keys.add(key)

                row = {
                    "ticker": ticker,
                    "date": date_value,
                    "ltp": num(rec.get("ltp")),
                    "high": num(rec.get("high")),
                    "low": num(rec.get("low")),
                    "open": num(rec.get("open")),
                    "ycp": num(rec.get("ycp")),
                    "volume": num(rec.get("volume"), True),
                    "trade": num(rec.get("trade"), True),
                    "value_mn": num(rec.get("value")),
                }
                fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                rows_written += 1

            print(f"   source rows: {len(df)} | unique accumulated: {len(unique_keys)}", flush=True)

    print(f"📦 bdshare source rows fetched: {total_source_rows}", flush=True)
    print(f"💾 NDJSON rows written: {rows_written}", flush=True)
    print(f"🧾 Unique ticker/date pairs: {len(unique_keys)}", flush=True)

    if rows_written == 0:
        print("❌ No usable historical rows were written.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
