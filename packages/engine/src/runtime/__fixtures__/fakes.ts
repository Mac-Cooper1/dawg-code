/**
 * Small stand-ins for the prompt assembler, compactor, token estimator and model profile, which
 * another part of the engine provides. Deterministic, so requests can be compared byte for byte.
 */
import type { ContentPart } from "@dawg/protocol";
import { quoteNoteMarkers } from "../../prompt/index.ts";
import type {
  CompactionInput,
  CompactionResult,
  Compactor,
  Message,
  ModelProfile,
  PromptAssembler,
  SessionEnvironment,
  SystemNote,
  TokenEstimator,
  UserMessage,
} from "../../contracts/index.ts";

export function noteMessage(text: string): UserMessage {
  return { role: "user", kind: "note", content: [{ type: "text", text }] };
}

export const fakeAssembler: PromptAssembler = {
  prefix({ tools, instructions }) {
    const content =
      instructions === "" ? "You are a test agent." : `You are a test agent.\n\n${instructions}`;
    return {
      system: { role: "system", content },
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    };
  },
  sessionContext(env: SessionEnvironment): UserMessage {
    return noteMessage(
      `<session-context cwd="${env.cwd}" date="${env.date}" dirs="${env.additionalDirectories.join(",")}"/>`,
    );
  },
  note(note: SystemNote): UserMessage {
    return noteMessage(`<note>${JSON.stringify(note)}</note>`);
  },
  prompt(content: readonly ContentPart[]): UserMessage {
    return {
      role: "user",
      content: content.map((p) => (p.type === "text" ? { type: "text", text: quoteNoteMarkers(p.text) } : p)),
      kind: "prompt",
    };
  },
  quote: quoteNoteMarkers,
};

export interface FakeCompactorOptions {
  /** Ask the model for the summary (through the compaction's client), as the real one does. */
  useModel?: boolean;
  /** Shorten the largest tool result instead of compacting, when there is one. */
  trim?: boolean;
  /** Throw instead of compacting. */
  fail?: boolean;
}

export function fakeCompactor(options: FakeCompactorOptions = {}): Compactor & {
  calls: CompactionInput[];
} {
  const calls: CompactionInput[] = [];
  return {
    calls,
    async compact(input: CompactionInput): Promise<CompactionResult> {
      calls.push(input);
      if (options.fail) throw new Error("compaction failed on purpose");
      let summary = `Summary of ${input.history.length} messages.`;
      if (options.useModel) {
        for await (const event of input.client.stream({
          messages: [
            input.prefix.system,
            ...input.history,
            noteMessage("Summarise the conversation so far."),
          ],
          tools: input.prefix.tools,
          signal: input.signal,
        })) {
          if (event.type === "finished") summary = event.reply.content;
        }
      }
      const first = input.history[0];
      const messages: Message[] = [];
      if (first !== undefined) messages.push(first);
      messages.push(noteMessage(`<summary>${summary}</summary>`));
      return { summary, messages, usage: null };
    },
    trimLargestResult(history, _targetTokens) {
      if (!options.trim) return null;
      let largest = -1;
      let size = 0;
      history.forEach((m, i) => {
        if (m.role !== "tool") return;
        const n = JSON.stringify(m.content).length;
        if (n > size) {
          size = n;
          largest = i;
        }
      });
      if (largest < 0) return null;
      return history.map((m, i) =>
        i === largest && m.role === "tool"
          ? { ...m, content: [{ type: "text" as const, text: "[trimmed]" }] }
          : m,
      );
    },
  };
}

export const fakeEstimator: TokenEstimator = {
  estimate({ messages, tools }) {
    return Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 4);
  },
};

export const fakeProfile: ModelProfile = {
  id: "test",
  sampling: { temperature: 0 },
  defaultEffort: null,
  maxOutputTokens: 1024,
  compactionThreshold: 0.65,
  parallelToolCalls: false,
  chatTemplateKwargs: null,
};
