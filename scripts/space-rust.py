import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

RAW_STRING = re.compile(r'b?r(#*)"')
CHAR_LITERAL = re.compile(r"""'(?:\\(?:[nrt\\0'"]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\})|[^\\'\n])'""")
MATCH_KEYWORD = re.compile(r"\bmatch\b")
MACRO_CALL = re.compile(r"!\s*$")
ITEM_START = re.compile(r"^(#\[|(pub(\([\w:]+\))? )?((async|const|unsafe|extern \"C\") )*(fn|struct|enum|trait|impl|union|macro_rules!)\b)")
BLOCK_START = re.compile(r"^(if|for|while|loop|match|unsafe)\b")
RETURN_START = re.compile(r"^return\b")
USE_START = re.compile(r"^(pub(\([\w:]+\))? )?(use|mod|extern crate)\b")
LET_START = re.compile(r"^let\b")
CONTINUATION_PREFIXES = ("}", ")", "]", "else", ".", "?", ",", "=>", "|", "&", "+", "-", "*", "/", "as ", "where")
BLOCK_ENDS = ("}", "};")
STATEMENT_ENDINGS = (";", "{", "}")
SPACED_BRACE_KINDS = ("code",)


@dataclass
class LineState:
    starts_in_literal: bool = False
    ends_in_literal: bool = False
    start_stack: tuple[str, ...] = ()
    end_stack: tuple[str, ...] = ()


@dataclass
class Scanner:
    text: str
    position: int = 0
    stack: list[str] = field(default_factory=list)
    line_start: int = 0
    states: list[LineState] = field(default_factory=list)
    current: LineState = field(default_factory=LineState)


def is_word_char(character: str) -> bool:
    return character.isalnum() or character == "_"


def finish_line(scanner: Scanner, in_literal: bool) -> None:
    scanner.current.ends_in_literal = in_literal
    scanner.current.end_stack = tuple(scanner.stack)
    scanner.states.append(scanner.current)
    scanner.current = LineState(in_literal, False, tuple(scanner.stack), ())
    scanner.line_start = scanner.position + 1


def skip_literal_until(scanner: Scanner, end: int) -> None:
    newline = scanner.text.find("\n", scanner.position, end)
    while newline != -1:
        scanner.position = newline
        finish_line(scanner, True)
        newline = scanner.text.find("\n", newline + 1, end)
    scanner.position = end


def closing_quote(text: str, start: int) -> int:
    index = start + 1
    while index < len(text) and text[index] != '"':
        index += 2 if text[index] == "\\" else 1
    return index + 1


def brace_kind(scanner: Scanner) -> str:
    before = scanner.text[scanner.line_start:scanner.position]
    segment = re.split(r"[{}]", before)[-1]
    if MACRO_CALL.search(segment):
        return "macro"
    if MATCH_KEYWORD.search(segment):
        return "match"
    return "code"


def scan_literal(scanner: Scanner) -> bool:
    text, position = scanner.text, scanner.position
    previous = text[position - 1] if position else " "
    raw = RAW_STRING.match(text, position) if not is_word_char(previous) else None
    if raw:
        terminator = '"' + raw.group(1)
        end = text.find(terminator, raw.end())
        skip_literal_until(scanner, end + len(terminator))
        return True
    if text[position] == '"':
        skip_literal_until(scanner, closing_quote(text, position))
        return True
    if text[position] == "'":
        character = CHAR_LITERAL.match(text, position)
        scanner.position = character.end() if character else position + 1
        return True
    return False


def scan_comment(scanner: Scanner) -> bool:
    text, position = scanner.text, scanner.position
    if text.startswith("//", position):
        newline = text.find("\n", position)
        scanner.position = newline if newline != -1 else len(text)
        return True
    if text.startswith("/*", position):
        skip_literal_until(scanner, text.find("*/", position) + 2)
        return True
    return False


def scan_bracket(scanner: Scanner) -> None:
    character = scanner.text[scanner.position]
    if character == "{":
        scanner.stack.append(brace_kind(scanner))
    elif character in "([":
        scanner.stack.append(character)
    elif character in ")]}" and scanner.stack:
        scanner.stack.pop()
    scanner.position += 1


def scan(text: str) -> list[LineState]:
    scanner = Scanner(text)
    while scanner.position < len(text):
        if text[scanner.position] == "\n":
            finish_line(scanner, False)
            scanner.position += 1
        elif not scan_comment(scanner) and not scan_literal(scanner):
            scan_bracket(scanner)
    finish_line(scanner, False)
    return scanner.states


def indentation(line: str) -> int:
    return len(line) - len(line.lstrip())


def statement_start(lines: list[str], states: list[LineState], index: int) -> int:
    depth = len(states[index].end_stack)
    start = index
    while start > 0 and (len(states[start].start_stack) > depth or not lines[start - 1].strip().endswith(STATEMENT_ENDINGS)):
        if not lines[start - 1].strip():
            break
        start -= 1
    return start


def in_spaced_block(state: LineState) -> bool:
    return not state.start_stack or state.start_stack[-1] in SPACED_BRACE_KINDS


def can_separate(lines: list[str], states: list[LineState], index: int) -> bool:
    before, after = lines[index], lines[index + 1]
    if not before.strip() or not after.strip():
        return False
    if states[index].ends_in_literal or states[index + 1].starts_in_literal:
        return False
    if indentation(before) != indentation(after) or not in_spaced_block(states[index + 1]):
        return False
    return not after.strip().startswith(CONTINUATION_PREFIXES)


def ends_group(lines: list[str], states: list[LineState], index: int, group: re.Pattern[str]) -> bool:
    if not lines[index].rstrip().endswith(";") or group.match(lines[index + 1].strip()):
        return False
    return bool(group.match(lines[statement_start(lines, states, index)].strip()))


def is_tail_expression(lines: list[str], states: list[LineState], index: int) -> bool:
    depth = len(states[index].start_stack)
    following = index + 1
    while following < len(lines) and len(states[following].start_stack) > depth:
        following += 1
    if following >= len(lines) or lines[following - 1].rstrip().endswith(";"):
        return False
    closing = lines[following]
    return closing.strip().startswith("}") and indentation(closing) < indentation(lines[index])


def needs_blank_line(lines: list[str], states: list[LineState], index: int) -> bool:
    if not can_separate(lines, states, index):
        return False
    before, after = lines[index].strip(), lines[index + 1].strip()
    if before in BLOCK_ENDS:
        return True
    if not before.endswith(";"):
        return False
    if RETURN_START.match(after) or BLOCK_START.match(after) or ITEM_START.match(after):
        return True
    if is_tail_expression(lines, states, index + 1):
        return True
    return ends_group(lines, states, index, LET_START) or ends_group(lines, states, index, USE_START)


def space(text: str) -> str:
    lines = text.split("\n")
    states = scan(text)
    spaced: list[str] = []
    for index, line in enumerate(lines):
        spaced.append(line)
        if index + 1 < len(lines) and needs_blank_line(lines, states, index):
            spaced.append("")
    return "\n".join(spaced)


def main(paths: list[str]) -> None:
    for name in paths:
        path = Path(name)
        original = path.read_text()
        spaced = space(original)
        if spaced != original:
            path.write_text(spaced)


if __name__ == "__main__":
    main(sys.argv[1:])
