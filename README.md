Brightspace Self-Assessment Converter


What it does

Accepts a Brightspace course-export ZIP or one or more selfassess_d2l_*.xml files.

The user can choose between two outputs:

- Question Library: creates one top-level Question Library folder for each Self-Assessment.
- Quizzes: creates one inactive Brightspace Quiz for each Self-Assessment.

Copies each complete Brightspace <item> into the Question Library rather than rebuilding questions from text or type.

Preserves question types, response structures, correct-answer processing, hints, feedback, HTML, formulas, and other D2L XML.

Assigns new d2l_2p0:id values and removes only qmd_globalid and qmd_displayid identity metadata.

Preserves existing local src and href references exactly.

Does not package course images/media because the output is intended to be imported back into the same course.

Question Library mode generates a ZIP containing only:

imsmanifest.xml

questiondb.xml

Quiz mode generates a ZIP containing:

imsmanifest.xml

one quiz_d2l_migrated_*.xml file per Self-Assessment

Performs structural and source-preservation validation before enabling the download.


Browser support

Use a current Chromium-based browser (Edge or Chrome recommended). The converter uses DecompressionStream('deflate-raw') to selectively read compressed entries from Brightspace ZIP files.

ZIP behaviour

The input ZIP reader reads the ZIP central directory and then opens only files needed for the conversion. It does not intentionally extract unrelated course content.

The generated ZIP uses the standard ZIP STORE method because it contains only two small XML files.

Important assumption

This converter is designed for the workflow where the generated Question Library package is imported back into the same Brightspace course. For that reason, course-file paths referenced inside question HTML are preserved and media files are not copied into the output package.


Quiz conversion behaviour

Each Self-Assessment becomes one Brightspace Quiz with the same title.

The complete source question/item XML is copied into the Quiz. Existing Self-Assessment sections are preserved.

New Quizzes are generated inactive with no dates, no time limit, no Respondus LockDown Browser requirement, and one allowed attempt so instructors can review settings before making the Quiz available.

Self-Assessment questions commonly have qmd_weighting=0. In Quiz mode, zero or missing question weights are changed to 1.000000000 so the Quiz does not contain zero-point questions. Existing positive weights are preserved.

qmd_globalid and qmd_displayid are removed from copied questions to avoid carrying source-specific identity metadata into the new Quiz.

The Quiz package manifest identifies each generated resource with d2l_2p0:material_type="d2lquiz".
