# Wrong: off-by-one on the backoff exponent (20 * 2^3 = 160).
cat > ANSWER.md <<'MD'
## Q1
Answer: 6
## Q2
Answer: 160 seconds
## Q3
Answer: SHA-512
## Q4
Answer: 408, 429
## Q5
Answer: dead_letters.jsonl
MD
