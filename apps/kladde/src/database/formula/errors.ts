export const formulaErrors = [
  "syntax",
  "unknownFunction",
  "unknownName",
  "unknownProperty",
  "arguments",
  "notNumber",
  "notDate",
  "tooComplex",
  "cycle",
] as const;
export type FormulaErrorCode = (typeof formulaErrors)[number];

export class FormulaError extends Error {
  constructor(
    public code: FormulaErrorCode,
    public detail = "",
  ) {
    super(code + (detail ? ": " + detail : ""));
  }
}
