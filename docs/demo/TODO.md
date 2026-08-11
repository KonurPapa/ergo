<!-- Keep this file scannable. Full briefs, build records and test notes live in AGENT_CONTEXT.md, keyed by item number. -->

# Major TODOs for beta:
- ~~zones~~
- ~~dropbox/g-drive import/export~~
- ~~export page data~~
- conditions
- ~~comparisons between revisions~~



## Missing features todos:

1. **conditions:**
    - search feature in schedules panel (filter the tree as you type — condition name/tag, group, schedule)
    - **human review** - verify the various condition details work correctly:
        - assemblies
        - slope calc
        - QTY (all types)
        - grid
2. ~~**AI features:**~~
    - ~~dismissing an AI suggestion should keep it in the AI panel; When the user clicks the button, it/they toggle back on again~~
    - **schedules:**
        - the schedules auto-extractor never dismisses, even after schedules are applied (it doesn't go away, even though it's supposed to once the user starts reviewing the results)
    - **scale-finder:**
        - 
    - **title/sheet name:**
        - 
3. **UI:**
    - all buttons need a keyboard shortcut (do we already have this?)
    - dropbox icon isn't rendering correctly (it looks like just outlines) - look up the actual Dropbox icon so you know exactly how to render it. If a final check doesn't exactly match an image of the real icon, just download a copy of the real icon and use that instead.
    - cursor needs to be set when hovering over AI toast notifications; currently if in area mode, it disappears and starts moving the point-select tool on the takeoff PDF below it
    - AI toast notifications should always be the highest level z-index; currently they display underneath sidebar buttons
    - move 'switch plan file' dropdown to lower beside the 'sheets' button
    - make the 'rendering sheet...' text more obvious (maybe bigger, or with an outline)
    - after the top expanded section closes (e.g. when a schedule is found, after the user selects what to do with it and the bar closes again), the schedules floating panel needs to readjust back to the size it took up on the screen. This may apply to other floating panels as well, specifically when anchored across an entire side, but I notice it most clearly with the schedules panel: the panel shrinks down to accomodate the expanded schedule-extractor section above, but then doesn't go back to previous size once it's closed
    - if a project/sheet has already been renamed from the default filename(s), AI should not try to find a name or suggest a rename
    - 'resume this takeoff' tooltip persists after the takeoff is loaded and we're on the takeoff canvas page (requires the user to physically mouse over it for it to disappear)
4. **zones/breakouts:**
    - **human review**
5. Make sure the takeoff MCP has complete access to do anything within the tool
6. **Import/Export:**
    - ~~per-section subtotal row; a second XLSX sheet per zone; column choice into the Bluebeam legend~~
    - ~~remove the worksheet (the legend sheet) from the PDF export (unnecessary). This is the first page(s) of the PDF. Per-page legends should be preserved.~~
    - ~~add a callouts toggle to the export screen (off by default), which will prevent callouts from being exported to the PDF output~~
    - ~~**bluebeam issues:**~~
        - ~~shapes need to export w/ opacity level - currently they export with a 100% opacity level, which makes them hard to see on top of the PDFs~~
        - ~~count shapes are exporting incorrectly - they show up in the markup list in BlueBeam, but not as shapes on the takeoff itself~~
    - **human review** — open the Bluebeam export in Revu: shape opacity + count symbols on the sheet
7. see if we can reduce the amount of space in-progress takeoffs take up in localStorage
    - currently on the home page it says '3.5GB', but creating a new takeoff and adding some test areas didn't increase this number at all. How is this calculated? is it even accurate?
8. ~~make takeoff edits compatible w/ BlueBeam~~
    - ~~this should either use the same formatting, or have an import/export mode specifically for BlueBeam that reformats back and forth for compatibility~~
9. **FoxIt functionality:**
    - stamps
10. **Comparisons between revisions:**
    - ~~drop an addendum/revision set into a project as a **layer** over the sheets it replaces — either more PDFs in this project, or another project's plan set~~
        - ~~sheets pair up by their title-block sheet number, not page order, so one inserted sheet doesn't shift the whole set~~
    - ~~layers behave like image-editing software: show/hide, reorder, per-layer color + opacity, and a Base / Revision / Both toggle~~
    - ~~two modes: a quick plan-only overlay (just show me what moved), and the full compare below~~
    - ~~full compare marks every changed area on the sheet and tells me **what it cost me** — which of my shapes sit in a changed area, what conditions they belong to, and the qty difference against the snapshot taken before the revision~~
    - ~~plan-set level: "9 of these 312 sheets actually changed", sorted most-changed first, so nobody reviews 300 unchanged sheets~~
    - ~~ignore the title block by default (rev tables and dates change every issue and that isn't a real change)~~
    - ~~next/previous-change shortcuts to walk the changed areas on a sheet~~
    - ~~exports:~~
        - ~~changed-sheets report (CSV/XLSX/PDF) — sheet, what changed, affected conditions, qty delta~~
        - ~~diff PDF where the revisions are real PDF layers: hidden layers stay inside the file, off by default, and toggle back on if that PDF is re-imported here~~
    - let me draw my own ignore boxes on a sheet (the title block is already ignored; the box is stored + honored, there's just no tool to draw one yet)
    - **human review** — run a real addendum through it: check the pairing, the change areas, and open the diff PDF's layer panel in Revu
11. in-progress takeoffs need to write to Neon DB so data isn't totally lost if user resets their browser/PC
12. **storage of keystrokes/actions & actual plan data for AI training**
    - should also be saved on a per-client basis, so the AI can recognize specific customer styles/preferences and specs
13. **Basic AI takeoff:**
    - start w/ one-click areas & count creation based on schedule (if exists)
    - prompt to takeoff?
14. **ALL projects should have a legend on-screen, the way BlueBeam projects do:**
    - add the legend panel as a sidebar button below the schedules button
        - it should start as hidden, but toggleable by either clicking the button or the legend on the takeoff sheet itself
15. **a series of tutorial popups to onboard new users, explaining the software's features and how to use them**
    - drop the help screenshots into `web/public/help/` — shot list in [SCREENSHOTS.md](SCREENSHOTS.md)
    - move the 'app buttons' section out of its current section and into the 'header toolbar' section
16. instead of completely clearing, exported takeoffs should save for 24 hours (in case something happens to the user's exported PDF and they still need to resume the takeoff)
    - for now this can be in the browser, under a new section on the homepage beneath the 'resume a takeoff' section called something like 'recent exports'
    - later, we may want this to be saved to our cloud DB instead of saving locally, so we can set dynamic data retention policies



# Later Features:

1. when building schedules, pull client requirements
2. figure out exactly what 'plays' are, and get them working the way we want
3. **Direct connections to other services:**
    - Export to G-drive / Dropbox (creating folder structure based on project name found in Monday)
        - real path structure keyed on the Monday project (not just one flat parent); include the marked-set PDF, not only CSV/JSON
        - if not found, can build ~75% and ask user for the rest
        - there should also be a quick-access button to open the folder directly
    - This needs to be able to be configured / toggled in settings
4. in every customer folder there should be ‘000 blank worksheet’ which should be used as an export template
    - this will be for clients who have standards outside of the default export layout
    - this should have a configurable setting to grab a sample project and use that as a template (for our purposes, this will grab '000 blank worksheet' from the project folder by default)
5. AI 'chat with my takeoff' feature
    - should be able to answer questions about the takeoff data, the project, and the takeoff itself
    - should be able to provide summaries and analysis of the takeoff data
    - should be able to do anything with the takeoff based on the user's prompts (this is why the MCP having full access to all takeoff actions is critical)
    - should always follow up by tellign the user what it found / intends to change, so the user can approve or deny the changes before they're made



## Questions for team (AI should NOT answer these - these are for human review):

1. Do we ever need bulk-edit for takeoff conditions/groups?
2. what about conditions details formatting w/ pallet qty? is this ever a toggleable mode?
3. how do we actually want worksheets formatted?
    - what is the hierarchy for zones/schedules/groups/pages?
     