import { describe, it, expect } from "vitest";
import { extractClassifyInput } from "../src/proxy/index.js";

describe("extractClassifyInput — task valido", () => {
  it("prende il testo dell'ultimo turno user come task", () => {
    const r = extractClassifyInput({
      model: "claude-x",
      messages: [
        { role: "user", content: "primo" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "trova il bug nel checkout" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.task).toBe("trova il bug nel checkout");
  });

  it("concatena i blocchi testuali dell'ultimo user, ignorando i non-testuali", () => {
    const r = extractClassifyInput({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "riga uno" },
            { type: "image", source: {} },
            { type: "text", text: "riga due" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.task).toBe("riga uno\nriga due");
  });

  it("stima contextTokens da system + turni precedenti, escluso il task", () => {
    // system 8 char + primo msg 'a'*40 = 48 char ⇒ ceil(48/4) = 12 token.
    const r = extractClassifyInput({
      system: "12345678",
      messages: [
        { role: "user", content: "a".repeat(40) },
        { role: "user", content: "task finale" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.task).toBe("task finale");
      expect(r.value.contextTokens).toBe(12);
    }
  });

  it("system come array di blocchi testuali è conteggiato", () => {
    const r = extractClassifyInput({
      system: [{ type: "text", text: "abcd" }],
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.contextTokens).toBe(1); // ceil(4/4)
  });

  it("estrae i nomi dei tool da tools[]", () => {
    const r = extractClassifyInput({
      messages: [{ role: "user", content: "fai qualcosa" }],
      tools: [
        { name: "edit", description: "…", input_schema: {} },
        { name: "bash" },
        { description: "senza nome" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toolsAvailable).toEqual(["edit", "bash"]);
  });

  it("tools assente → toolsAvailable omesso", () => {
    const r = extractClassifyInput({ messages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty("toolsAvailable");
  });

  it("un solo turno user senza system → contextTokens 0", () => {
    const r = extractClassifyInput({ messages: [{ role: "user", content: "ciao" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.contextTokens).toBe(0);
  });

  it("ritaglia gli spazi del task", () => {
    const r = extractClassifyInput({ messages: [{ role: "user", content: "  spazi  " }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.task).toBe("spazi");
  });
});

describe("extractClassifyInput — errori", () => {
  it("body non oggetto → err", () => {
    expect(extractClassifyInput(null).ok).toBe(false);
    expect(extractClassifyInput("x").ok).toBe(false);
    expect(extractClassifyInput([]).ok).toBe(false);
  });

  it("messages non array → err", () => {
    expect(extractClassifyInput({ messages: "no" }).ok).toBe(false);
    expect(extractClassifyInput({}).ok).toBe(false);
  });

  it("nessun messaggio user → err", () => {
    expect(extractClassifyInput({ messages: [{ role: "assistant", content: "solo io" }] }).ok).toBe(
      false,
    );
  });

  it("ultimo user senza testo → err", () => {
    expect(
      extractClassifyInput({
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      }).ok,
    ).toBe(false);
    expect(extractClassifyInput({ messages: [{ role: "user", content: "   " }] }).ok).toBe(false);
  });
});
