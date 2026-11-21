# Alternative fix: keep the directory in the repo with a .gitkeep (gitignore adjusted).
python3 "$TASK_DIR/../_tools/replace.py" .gitignore 'src/generated/' 'src/generated/*
!src/generated/.gitkeep'
mkdir -p src/generated && touch src/generated/.gitkeep
python3 "$TASK_DIR/../_tools/replace.py" data/units.csv "0.3408" "0.3048"
