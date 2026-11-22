import js from "@eslint/js";
import ts from "typescript-eslint";

const statementSpacing = [
  "error",
  {
    blankLine: "always",
    prev: "*",
    next: ["function", "class", "export", "block-like", "return"],
  },
  {
    blankLine: "always",
    prev: ["function", "class", "block-like", "import", "const", "let"],
    next: "*",
  },
  { blankLine: "any", prev: ["const", "let"], next: ["const", "let"] },
  { blankLine: "any", prev: "import", next: "import" },
  { blankLine: "any", prev: "export", next: "export" },
  { blankLine: "any", prev: "*", next: ["case", "default"] },
];

export default [
  ...ts.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      ...js.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "padding-line-between-statements": statementSpacing,
    },
  },
];
