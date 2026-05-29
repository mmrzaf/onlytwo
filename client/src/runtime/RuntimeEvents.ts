export type RuntimeEvent =
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "state" };
