// A stand-in CLI agent for the `command` adapter: it makes two model requests through the
// endpoint it was given, solves the edit-greeting task and reports what it could see.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , baseUrl, model, prompt, reportPath] = process.argv;
for (let i = 0; i < 2; i++) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  await res.json();
}
writeFileSync(join(process.cwd(), "greeting.txt"), "hello, world\n");
writeFileSync(
  reportPath,
  JSON.stringify({
    cwd: process.cwd(),
    home: process.env.HOME,
    prompt,
    envKeys: Object.keys(process.env).sort(),
    openaiKey: process.env.OPENAI_API_KEY,
  }),
);
