# Everything but the version bump.
cp -R "$TASK_DIR/solution/." .
git checkout -q HEAD -- wordtally/__init__.py
