# Wrong: guesses the usual SHA-256 and the delivery log as the dead-letter file.
cat > ANSWER.md <<'MD'
## Q1
Answer: 6
## Q2
Answer: 80
## Q3
Answer: HMAC-SHA256
## Q4
Answer: 408 and 429
## Q5
Answer: deliveries.jsonl
MD
