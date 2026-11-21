# Correct answers in a different but allowed style: bold labels, next-line answer,
# headings with question text, words for numbers, mixed case.
cat > ANSWER.md <<'MD'
# Answers

### Q1. Total attempts with relay.ini
**Answer:** six attempts
Because `max_attempts = 6` in relay.ini overrides the default of 4.

### Question 2 — wait after the third failure
- Answer:
  `80` s
(20 * 2**2; the code default base would give 60)

## **Q3**
> **Answer**: HMAC-`SHA512`

## Q4:
Answer: HTTP _408_ (request timeout) and _429_ (too many requests)

## Q5
Answer: var/relay/`dead_letters.jsonl`
deliveries.jsonl is only the attempt log.
MD
