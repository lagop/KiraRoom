import { editChangesRows, planRowEdit } from "./visit-edit";

/**
 * Saving the appointment form deleted every service row of the visit and
 * created them again: times, status and notes of each service were lost.
 */

const rows = [
  { id: "r1", serviceId: "colour", professionalId: "ana", isParallel: false, order: 0, status: "completed" },
  { id: "r2", serviceId: "cut", professionalId: "ana", isParallel: false, order: 1, status: "pending" },
  { id: "r3", serviceId: "nails", professionalId: "bea", isParallel: true, order: 2, status: "pending" },
];

describe("planRowEdit", () => {
  it("the same services resent: every row stays, nothing to write", () => {
    const edit = planRowEdit(rows, [
      { serviceId: "colour", professionalId: "ana" },
      { serviceId: "cut", professionalId: "ana" },
      { serviceId: "nails", professionalId: "bea", isParallel: true },
    ]);
    expect(edit.keep.map((k) => k.row.id)).toEqual(["r1", "r2", "r3"]);
    expect(edit.add).toEqual([]);
    expect(edit.remove).toEqual([]);
    expect(editChangesRows(edit)).toBe(false);
  });

  it("a service added, one dropped: the others are the same rows", () => {
    const edit = planRowEdit(rows, [
      { serviceId: "colour", professionalId: "ana" },
      { serviceId: "nails", professionalId: "bea", isParallel: true },
      { serviceId: "mask", professionalId: null },
    ]);
    expect(edit.keep.map((k) => [k.row.id, k.order])).toEqual([
      ["r1", 0],
      ["r3", 1],
    ]);
    expect(edit.add).toEqual([{ order: 2, serviceId: "mask", professionalId: null, isParallel: false }]);
    expect(edit.remove.map((r) => r.id)).toEqual(["r2"]);
    // r3 keeps its place among the rows that stay: its times stay.
    expect(edit.keep.find((k) => k.row.id === "r3")!.retime).toBe(false);
  });

  it("another professional for a row is a change, not a new row", () => {
    const edit = planRowEdit(rows, [
      { serviceId: "colour", professionalId: "ana" },
      { serviceId: "cut", professionalId: "bea" },
      { serviceId: "nails", professionalId: "bea", isParallel: true },
    ]);
    const cut = edit.keep.find((k) => k.row.id === "r2")!;
    expect(cut).toMatchObject({ professionalId: "bea", changed: true, retime: false });
    expect(edit.add).toEqual([]);
  });

  it("a row moved before another, or switched to parallel, is laid out again", () => {
    const edit = planRowEdit(rows, [
      { serviceId: "cut", professionalId: "ana" },
      { serviceId: "colour", professionalId: "ana", isParallel: true },
      { serviceId: "nails", professionalId: "bea", isParallel: true },
    ]);
    expect(edit.keep.map((k) => [k.row.id, k.retime])).toEqual([
      ["r2", true],
      ["r1", true],
      ["r3", false],
    ]);
  });

  it("two of the same service: matched in order, the same professional first", () => {
    const twice = [
      { id: "a", serviceId: "cut", professionalId: "ana", isParallel: false, order: 0 },
      { id: "b", serviceId: "cut", professionalId: "bea", isParallel: false, order: 1 },
    ];
    const edit = planRowEdit(twice, [{ serviceId: "cut", professionalId: "bea" }]);
    expect(edit.keep.map((k) => k.row.id)).toEqual(["b"]);
    expect(edit.remove.map((r) => r.id)).toEqual(["a"]);
  });
});
