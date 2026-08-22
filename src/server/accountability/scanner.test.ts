import { describe, expect, it } from "vitest";
import { extractCommitmentTitles, filterNewCommitments } from "./scanner";

describe("commitment scanner extraction", () => {
  it("parses strict JSON commitments", () => {
    expect(extractCommitmentTitles('{"commitments":[{"title":"Fill scholarship form"},{"title":"Book dad doctor appointment"}]}')).toEqual([
      "Fill scholarship form",
      "Book dad doctor appointment",
    ]);
  });

  it("tolerates fenced or prose-wrapped replies", () => {
    const raw = 'Sure! ```json\\n{"commitments":[{"title":"Pay electricity bill"}]}``` hope that helps';
    expect(extractCommitmentTitles(raw)).toEqual(["Pay electricity bill"]);
  });

  it("caps results and rejects junk titles", () => {
    const raw = JSON.stringify({
      commitments: [
        { title: "" },
        { title: "ab" },
        { title: "Fill the internship application form" },
        { title: "Book badminton court for saturday" },
        { title: "Return library books before monday" },
        42,
      ],
    });
    expect(extractCommitmentTitles(raw)).toEqual(["Fill the internship application form", "Book badminton court for saturday"]);
  });

  it("returns empty on garbage instead of throwing", () => {
    expect(extractCommitmentTitles("not json at all")).toEqual([]);
    expect(extractCommitmentTitles(undefined)).toEqual([]);
  });
});

describe("filterNewCommitments", () => {
  it("drops scanned titles already covered by open loops", () => {
    const result = filterNewCommitments(
      ["Pick up Bluedart courier", "Fill the scholarship form", "Buy groceries"],
      ["Solve at least 1 LeetCode problem daily", "bluedart courier pickup"],
    );
    expect(result).toEqual(["Fill the scholarship form", "Buy groceries"]);
  });

  it("caps to two per turn", () => {
    const result = filterNewCommitments(["Task one here", "Task two here", "Task three here"], []);
    expect(result).toHaveLength(2);
  });
});
