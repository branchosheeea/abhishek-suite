import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { datePhrase, formatDate, formatDateRange } from "../../lib/narrative/dates"
import { gap, joinList, joinWithArticle, ordinal, placeholderProblems, removeGaps, sentence, tidy, toSegments } from "../../lib/narrative/text"

describe("date phrases", () => {
  test("same-day inspection", () => {
    assert.equal(datePhrase("2026-03-12", "2026-03-12"), "on 12 March 2026")
    assert.equal(datePhrase("2026-03-12", ""), "on 12 March 2026", "a missing end date is a single day")
  })

  test("multi-day range in the same month", () => {
    assert.equal(datePhrase("2026-09-25", "2026-09-30"), "from 25 to 30 September 2026")
  })

  test("range crossing months, without repeating the year", () => {
    assert.equal(datePhrase("2026-09-28", "2026-10-03"), "from 28 September to 3 October 2026")
  })

  test("range crossing years shows both full dates", () => {
    assert.equal(datePhrase("2026-12-30", "2027-01-02"), "from 30 December 2026 to 2 January 2027")
  })

  test("end date earlier than start date, or invalid dates, give no phrase", () => {
    assert.equal(formatDateRange("2026-09-30", "2026-09-25"), null)
    assert.equal(datePhrase("2026-02-30", ""), "")
    assert.equal(datePhrase("", "2026-09-25"), "")
    assert.equal(formatDate("25/09/2026"), "")
  })
})

describe("list phrases", () => {
  test("joins one, two and three items with commas and 'and'", () => {
    assert.equal(joinList(["A"]), "A")
    assert.equal(joinList(["A", "B"]), "A and B")
    assert.equal(joinList(["A", "B", "C"]), "A, B and C")
    assert.equal(joinList([]), "")
  })

  test("adds the serial comma only when an item already contains 'and'", () => {
    assert.equal(joinList(["checking X and Y", "reviewing Z", "testing W"]), "checking X and Y, reviewing Z, and testing W")
  })

  test("shares 'the' for two nouns, repeats it for three or more", () => {
    assert.equal(joinWithArticle(["worklist"]), "the worklist")
    assert.equal(joinWithArticle(["worklist", "Defect and Damage Report List"]), "the worklist and Defect and Damage Report List")
    assert.equal(
      joinWithArticle(["worklist", "Defect and Damage Report List", "repair and maintenance plan"]),
      "the worklist, the Defect and Damage Report List, and the repair and maintenance plan",
    )
  })
})

describe("text clean-up", () => {
  test("removes empty punctuation and spacing left by omitted parts", () => {
    assert.equal(tidy("attended  the vessel , at Singapore,, to conduct ."), "attended the vessel, at Singapore, to conduct.")
    assert.equal(sentence("the vessel was inspected"), "The vessel was inspected.")
    assert.equal(sentence("Done."), "Done.")
  })

  test("gap markers are shown in the preview but removed from the text", () => {
    const raw = `attended the vessel ${gap("vessel name")} at Singapore`
    assert.equal(removeGaps(raw), "attended the vessel at Singapore")
    assert.deepEqual(toSegments(raw), [{ text: "attended the vessel " }, { gap: "vessel name" }, { text: " at Singapore" }])
  })

  test("detects unresolved placeholders", () => {
    assert.deepEqual(placeholderProblems("The vessel was attended."), [])
    assert.ok(placeholderProblems("The vessel [name] was attended.").length)
    assert.ok(placeholderProblems("Attended on {date}.").length)
    assert.ok(placeholderProblems("Location TBA.").length)
    assert.ok(placeholderProblems("Attended undefined.").length)
    assert.ok(placeholderProblems(`Attended ${gap("x")}.`).length)
    assert.ok(placeholderProblems("Attended , at port.").length)
  })

  test("ordinals", () => {
    assert.equal(ordinal(3), "third")
    assert.equal(ordinal(11), "11th")
    assert.equal(ordinal(22), "22nd")
  })
})
