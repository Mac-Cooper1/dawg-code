/**
 * Run by lock.test.ts as a separate process: takes the lock named on the command line, prints
 * "locked", and holds it until its standard input closes.
 */
import { acquireLock } from "../lock.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: hold-lock.ts <lock file>");
const lock = await acquireLock(file, "Test session");
process.stdout.write("locked\n");
process.stdin.resume();
process.stdin.on("end", async () => {
  await lock.release();
  process.exit(0);
});
