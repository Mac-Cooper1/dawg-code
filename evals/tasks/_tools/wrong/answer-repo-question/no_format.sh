# Right facts but ignores the requested format (no Q headings / Answer lines).
cat > ANSWER.md <<'MD'
Relay makes 6 attempts with relay.ini, waits 80 seconds after the third failure,
signs with SHA-512, retries 408 and 429, and buries jobs in dead_letters.jsonl.
MD
