# Changelog entry appended at the bottom instead of the top.
cp -R "$TASK_DIR/solution/." .
git checkout -q HEAD -- CHANGELOG.md
printf '\n## 1.4.0\n\n- Apostrophes inside words.\n- --min-length option.\n- --json flag.\n' >> CHANGELOG.md
