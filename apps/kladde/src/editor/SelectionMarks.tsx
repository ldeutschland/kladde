import type { CSSProperties } from "react";

export function SelectionMarks({
  selection,
}: {
  selection: { marks: CSSProperties[]; box: CSSProperties | null };
}) {
  return (
    <>
      {selection.marks.map((mark, index) => (
        <div
          className="blockpick"
          key={index}
          style={mark}
          aria-hidden="true"
        />
      ))}
      {selection.box && (
        <div className="selectbox" style={selection.box} aria-hidden="true" />
      )}
    </>
  );
}
