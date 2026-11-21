#!/usr/bin/env bash
# The task requires running the script to produce the report.
set -eu
python3 summarize.py data/expenses.csv reports/summary.json
