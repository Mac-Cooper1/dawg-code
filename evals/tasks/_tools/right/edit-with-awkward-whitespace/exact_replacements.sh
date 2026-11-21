# What a good edit tool does: exact substring replacements, plus a scratch file (allowed).
R="$TASK_DIR/../_tools/replace.py"
python3 "$R" src/settings.js "timeoutMs:      1500," "timeoutMs:      2500,"
python3 "$R" src/settings.js $'\t"legacy-xml",\t\t\n' ''
python3 "$R" src/settings.js $'\tcolour:' $'\tcolor:'
python3 "$R" src/settings.js "theme.colour;" "theme.color;"
echo "scratch notes" > NOTES.tmp
node --test >/dev/null
