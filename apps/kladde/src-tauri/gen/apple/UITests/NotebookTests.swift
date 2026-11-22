import XCTest

final class NotebookTests: XCTestCase {
    func testPageSurvivesRestart() {
        let app = XCUIApplication()
        app.launch()
        let onboarding = app.buttons["Lokal starten"]
        if onboarding.waitForExistence(timeout: 8) { onboarding.tap() }
        let create = app.buttons.matching(identifier: "Neue Seite").firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 25))
        create.tap()
        let title = app.textFields["Titel"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        let marker = "Kladde" + String(Int.random(in: 100000...999999))
        title.tap()
        title.typeText(String(marker))
        let saved = app.staticTexts["Lokal gespeichert"]
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        let titleBeforeRestart = title.value as? String ?? ""
        XCTAssertTrue(titleBeforeRestart.contains(marker), titleBeforeRestart)
        app.terminate()
        app.launch()
        let page = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", String(marker))).firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 20), app.debugDescription)
        page.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertTrue((title.value as? String)?.contains(marker) == true)
    }
}
