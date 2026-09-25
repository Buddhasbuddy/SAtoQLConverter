Brightspace Self-Assessment → Question Library Converter

A static browser-based converter designed for GitHub Pages.

What it does

Accepts a Brightspace course-export ZIP or one or more selfassess_d2l_*.xml files.

Creates one top-level Question Library section for each Self-Assessment.

Copies each complete Brightspace <item> into the Question Library rather than rebuilding questions from text or type.

Preserves question types, response structures, correct-answer processing, hints, feedback, HTML, formulas, and other D2L XML.

Assigns new d2l_2p0:id values and removes only qmd_globalid and qmd_displayid identity metadata.

Preserves existing local src and href references exactly.

Does not package course images/media because the output is intended to be imported back into the same course.

Generates a ZIP containing only:

imsmanifest.xml

questiondb.xml

Performs structural and source-preservation validation before enabling the download.

Hosting on GitHub Pages

Put index.html, style.css, and script.js in the repository root.

Open Settings → Pages.

Choose Deploy from a branch.

Select main and / (root).

Save.

No server, API, or build step is required.

Browser support

Use a current Chromium-based browser (Edge or Chrome recommended). The converter uses DecompressionStream('deflate-raw') to selectively read compressed entries from Brightspace ZIP files.

ZIP behaviour

The input ZIP reader reads the ZIP central directory and then opens only files needed for the conversion. It does not intentionally extract unrelated course content.

The generated ZIP uses the standard ZIP STORE method because it contains only two small XML files.

Important assumption

This converter is designed for the workflow where the generated Question Library package is imported back into the same Brightspace course. For that reason, course-file paths referenced inside question HTML are preserved and media files are not copied into the output package.
