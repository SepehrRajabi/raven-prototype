import { expect, test } from "bun:test";
import { mentionNames } from "./mentionNames";
import { labelsForPreference, type RavenShellData } from "./state";

test("mentions outside their conversation name you, the people you know and nobody else", () => {
  const data = {
    labels: labelsForPreference("space_room"),
    user: { id: "me", username: "mina" },
    preferences: { displayName: "Mina" },
    getPerson: (id: string) => (id === "ava" ? { id, name: "Ava" } : undefined),
    getNest: () => undefined,
  } as unknown as RavenShellData;
  const names = mentionNames(data, null);
  expect(names.person("me")?.name).toBe("Mina");
  expect(names.person("ava")?.name).toBe("Ava");
  expect(names.person("stranger")).toBeNull();
  expect(names.nest("text", "t1")).toBeNull();
});
