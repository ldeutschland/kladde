import { calculations } from "./compute";
import { dateFormats, numberFormats, type FieldType } from "./types";
import { actionsFor, operators } from "./rules";

export const guideTopics = ["formulas", "properties", "automations"] as const;
export type GuideTopic = (typeof guideTopics)[number];

const typeGroups: [string, FieldType][] = [
  ["text, url, email, phone, person and the title", "text"],
  ["number, autoId", "number"],
  ["date, created, edited", "date"],
  ["select, status", "select"],
  ["relation (value = row ID)", "relation"],
  ["multi", "multi"],
  ["checkbox", "checkbox"],
  ["formula, rollup", "formula"],
];

const actionGroups: [string, FieldType][] = [
  ["text, url, email, phone, person", "text"],
  ["number", "number"],
  ["date", "date"],
  ["checkbox", "checkbox"],
  ["multi", "multi"],
  ["select, status, relation", "select"],
];

const FORMULAS = `FORMULAS
A formula computes one value per row whenever the database is read. Nothing is stored, so results are always current.

Syntax
- prop("Name") reads a property of this row by name or ID (case-insensitive). title() reads the row title.
- Literals: 12, 3.5, "text" or 'text', true, false, [1, 2, 3] for a list.
- Operators from strongest to weakest: ^ | * / % | + - | < <= > >= | = == != <> | and && | or ||. Unary: - not !.
- + joins text when one side is text, otherwise it adds numbers.
- Method style: x.f(a) means f(x, a), for example prop("Tags").length() or prop("Tasks").filter(current.prop("Done")).
- Variables: let(name, value, expression) and lets(a, 1, b, a * 2, expression).
- map, filter, find, findIndex, some and every take an expression that sees current (the item) and index (0-based).
- Not available: regular expressions, random numbers, the current time. today() is the current date.

Values per property type
- number, autoId: number; empty is null. null counts as 0 in + - * / and is skipped by sum, min, max, average, median.
- text, url, email, phone, person, select, status: text; empty is null.
- checkbox: true or false. formula: its result. rollup: its calculated value.
- multi: list of option names.
- relation: list of linked rows. current.prop("Name") and current.title() read a linked row, one level deep.
- date, created, edited: text "YYYY-MM-DD"; a date range is "YYYY-MM-DD/YYYY-MM-DD" (use dateStart, dateEnd).

Functions
- Logic: if(cond, then, else?), ifs(c1, v1, c2, v2, ..., else?), and(...), or(...), not(x), empty(x), ifError(x, fallback), let(name, value, expr), lets(n1, v1, n2, v2, ..., expr)
- Text: concat(...), join(list, separator) or join(separator, a, b, ...), lower(x), upper(x), trim(x), length(text or list), contains(text, part) (case-insensitive; on a list it matches whole items), startsWith(x, part), endsWith(x, part), replace(x, find, with) (first match), replaceAll(x, find, with), slice(text or list, start, end?), repeat(x, n) (n <= 200), split(text, separator) -> list, indexOf(text, part) -> 0-based position or -1, format(x) -> text, toNumber(x)
- Numbers: round(x, digits?), floor(x), ceil(x), abs(x), sign(x), sqrt(x), pow(x, y), exp(x), ln(x), log10(x), mod(x, y), pi(), min(...), max(...), sum(...), average(...), median(...) (these accept numbers and lists)
- Dates: today(), dateAdd(date, n, unit), dateSubtract(date, n, unit), dateBetween(a, b, unit) = a minus b, unit "days" | "weeks" | "months" | "years"; dateStart(date), dateEnd(date), year(d), month(d), day(d), weekday(d) (1 = Monday), week(d) (ISO week), formatDate(date, pattern?) with YYYY YY MMMM MMM MM M DD D dddd ddd and [literal text]
- Lists: list(...) or [...], count(x), first(x), last(x), at(list, i) (negative counts from the end), sort(x), reverse(x), unique(x), flat(x), includes(list, item), map(list, expr), filter(list, cond), find(list, cond), findIndex(list, cond), some(list, cond), every(list, cond)
- Linked rows: prop(row, "Name") = row.prop("Name"), title(row) = row.title()

Display: the property's number format applies to numeric results (config.format, config.bar). true/false show as a checkbox. Lists show as "a, b, c". A failing formula leaves the cell empty; wrap risky parts in ifError(x, fallback).
Limits: 2000 characters, 1000 items per list, 20000 evaluation steps, nesting depth 60.

Examples
- Gross price: round(prop("Net") * 1.19, 2)
- Days left: if(empty(prop("Due")), "", dateBetween(prop("Due"), today(), "days"))
- Status label: ifs(prop("Done"), "done", prop("Due") < today(), "overdue", "open")
- Progress of linked tasks (format "percent", bar true): let(t, prop("Tasks"), if(t.length() = 0, 0, t.filter(current.prop("Done")).length() / t.length()))
- Hours still open: sum(prop("Tasks").filter(not current.prop("Done")).map(current.prop("Hours")))
- Sorted names of linked rows: prop("Tasks").map(current.title()).sort().join(", ")
- Readable date: formatDate(prop("Date"), "dddd, D. MMMM YYYY")
- Initials: split(prop("Name"), " ").map(slice(current, 0, 1)).join("")`;

function propertiesGuide() {
  return `PROPERTIES
Types and the value format for upsert_rows
- text, url (https://...), email, phone, person: text
- number: a plain number such as 42 or -3.5
- select, status: one option name; multi: option names separated by commas. Give options when creating.
- date: YYYY-MM-DD or a range YYYY-MM-DD/YYYY-MM-DD
- checkbox: true or false
- relation: needs target (database ID). Value: linked row IDs separated by commas.
- created, edited: filled automatically, read only
- formula: needs formula (call database_guide with topic formulas), read only
- rollup: read only; config relation, property and rollup
- autoId: numbered automatically, existing rows are numbered when the property is added; config prefix
- button: runs a manual automation for its row; config rule

config keys (in add and change)
- format: ${numberFormats.join(", ")} (number, formula, rollup; percent shows 0.25 as 25 %)
- bar: true shows numbers as a progress bar; bar_max is the value of a full bar (default 100, or 1 with percent)
- date_format: ${dateFormats.join(", ")} (date, created, edited, rollup)
- relation: name or ID of a relation property of this database (rollup)
- property: name or ID of a property of the related database, "" for its title (rollup)
- rollup: ${calculations.join(", ")}
- prefix: up to 10 letters or digits (autoId), shown as PREFIX-7
- rule: name or ID of an automation with trigger manual (button)

Changing properties: update_database_schema with change: [{ id, name?, type?, options?, target?, formula?, config? }]. Only the given keys change; config keys are merged. Values that no longer match new options stay stored but are invalid. Formulas and settings are checked before saving; an error names the problem, fix it and call again. The result shows formula results for up to three rows.`;
}

function operatorLines() {
  return typeGroups
    .map(([label, type]) => "- " + label + ": " + operators(type).join(", "))
    .join("\n");
}

function actionLines() {
  return actionGroups
    .map(([label, type]) => "- " + label + ": " + actionsFor(type).join(", "))
    .join("\n");
}

function automationsGuide() {
  return `AUTOMATIONS
An automation changes properties of a row when it runs. Create, change or remove one with set_automation; inspect_database lists existing automations with IDs.

Parts
- name (required when creating), enabled (default true)
- trigger: create (a row is added), change (a property changes; watch = property name or ID, empty for any property), manual (runs from the automations panel or a button property)
- filters: conditions the row must meet, each { field, op, value, end? }; field empty means the title. match: all (default) or any.
- actions: up to 16 steps { field, action, value } that run in order. Later steps and later automations see earlier results.

Filter operators per property type
${operatorLines()}
Values: dates YYYY-MM-DD; pastDays and nextDays take a number of days; between takes value and end; options by name; relations by row ID. emptyValue, filledValue, checked, unchecked, today, thisWeek, thisMonth and thisYear need no value.

Actions per property type
${actionLines()}
- set: value in the property's format (topic properties); clear: empties the property
- copy: value = name or ID of another property (formulas and rollups allowed)
- stamp: today's date; dateOffset: value = days from today (-3650 to 3650)
- increment: adds value (may be negative); toggle: flips a checkbox; append: adds text after a space
- addOption, removeOption: value = option name (multi)
- formula: value = a formula whose result is written (topic formulas). Linked rows are not loaded here, so current.prop on relations fails.

Rules
- Targets cannot be formula, rollup, autoId, created, edited or button properties.
- Changes made by automations do not trigger other automations, so there are no loops.
- At most 32 automations per database and 32 filters per automation.
- Errors name the step and the problem; fix them and call again.

Examples
- Stamp the completion date: trigger change, watch "Status", filters [{ field: "Status", op: "equals", value: "Done" }], actions [{ field: "Completed", action: "stamp" }]
- Defaults for new rows: trigger create, actions [{ field: "Status", action: "set", value: "To do" }, { field: "Due", action: "dateOffset", value: "7" }]
- Button: set_automation with trigger manual and name "Start", then add a property { type: "button", config: { rule: "Start" } }
- Due date from start and duration: trigger change, watch "Start", actions [{ field: "Due", action: "formula", value: "dateAdd(prop(\\"Start\\"), prop(\\"Days\\"), \\"days\\")" }]`;
}

export function databaseGuide(topic: string) {
  if (topic === "formulas") return FORMULAS;
  if (topic === "properties") return propertiesGuide();
  if (topic === "automations") return automationsGuide();
  throw Error("Unknown topic. Use one of: " + guideTopics.join(", "));
}
