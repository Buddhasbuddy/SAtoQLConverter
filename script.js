(() => {
  "use strict";

  const D2L_NS = "http://desire2learn.com/xsd/d2lcp_v2p0";
  const OUTPUT_NAME = "Brightspace_QuestionLibrary_Migration.zip";
  const XML_DEC = '<?xml version="1.0" encoding="UTF-8"?>';

  const fileInput = document.getElementById("file-input");
  const dropZone = document.getElementById("drop-zone");
  const resetButton = document.getElementById("reset-button");
  const analysisPanel = document.getElementById("analysis-panel");
  const sourceSummary = document.getElementById("source-summary");
  const analysisStatus = document.getElementById("analysis-status");
  const assessmentList = document.getElementById("assessment-list");
  const analysisWarnings = document.getElementById("analysis-warnings");
  const convertButton = document.getElementById("convert-button");
  const resultPanel = document.getElementById("result-panel");
  const resultStatus = document.getElementById("result-status");
  const validationList = document.getElementById("validation-list");
  const resultMessages = document.getElementById("result-messages");
  const downloadLink = document.getElementById("download-link");

  let state = freshState();

  function freshState() {
    return {
      sourceKind: null,
      sourceName: "",
      assessments: [],
      warnings: [],
      outputUrl: null,
      inputFiles: []
    };
  }

  fileInput.addEventListener("change", () => handleFiles([...fileInput.files]));
  resetButton.addEventListener("click", resetApp);
  convertButton.addEventListener("click", convertAndPackage);

  ["dragenter", "dragover"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });

  dropZone.addEventListener("drop", event => {
    const files = [...event.dataTransfer.files];
    if (files.length) handleFiles(files);
  });

  async function handleFiles(files) {
    resetOutputOnly();
    state = freshState();
    state.inputFiles = files;
    resetButton.disabled = false;
    analysisPanel.classList.remove("hidden");
    assessmentList.innerHTML = "";
    analysisWarnings.innerHTML = "";
    setStatus(analysisStatus, "Analyzing…", "");
    convertButton.disabled = true;

    try {
      const zipFiles = files.filter(f => /\.zip$/i.test(f.name));
      const xmlFiles = files.filter(f => /\.xml$/i.test(f.name));

      if (zipFiles.length > 1) throw new Error("Select one Brightspace ZIP at a time.");
      if (zipFiles.length && xmlFiles.length) {
        state.warnings.push("A ZIP and loose XML files were selected together. The ZIP will be used and loose XML files will be ignored.");
      }

      if (zipFiles.length) {
        state.sourceKind = "zip";
        state.sourceName = zipFiles[0].name;
        state.assessments = await analyzeZip(zipFiles[0]);
      } else {
        if (!xmlFiles.length) throw new Error("Select a Brightspace export ZIP or at least one Self-Assessment XML file.");
        state.sourceKind = "xml";
        state.sourceName = xmlFiles.length === 1 ? xmlFiles[0].name : `${xmlFiles.length} XML files`;
        state.assessments = await analyzeLooseXml(xmlFiles);
      }

      if (!state.assessments.length) throw new Error("No Brightspace Self-Assessments were found in the selected source.");

      renderAnalysis();
      setStatus(analysisStatus, "Ready", "success");
      convertButton.disabled = false;
    } catch (error) {
      console.error(error);
      sourceSummary.textContent = "The selected source could not be analyzed.";
      showMessage(analysisWarnings, error.message || String(error), "error");
      setStatus(analysisStatus, "Error", "error");
    }
  }

  async function analyzeLooseXml(files) {
    const byName = new Map(files.map(f => [normalizePath(f.name), f]));
    const manifestFile = files.find(f => /^imsmanifest(?:\([^)]*\))?\.xml$/i.test(f.name) || /^imsmanifest\.xml$/i.test(f.name));
    let candidates = [];

    if (manifestFile) {
      const manifestDoc = parseXml(await manifestFile.text(), manifestFile.name);
      const hrefs = selfAssessmentHrefsFromManifest(manifestDoc);
      for (const href of hrefs) {
        const match = findLooseFile(byName, href);
        if (match) candidates.push(match);
        else state.warnings.push(`Manifest references ${href}, but that XML file was not selected.`);
      }
    }

    if (!candidates.length) {
      candidates = files.filter(f => /^selfassess_d2l_.*\.xml$/i.test(f.name));
    }

    const unique = [...new Map(candidates.map(f => [f.name, f])).values()];
    const results = [];
    for (const file of unique) {
      results.push(parseSelfAssessment(await file.text(), file.name));
    }
    return results;
  }

  async function analyzeZip(file) {
    const archive = new SelectiveZipReader(file);
    await archive.init();

    const manifestEntry = archive.findEntry("imsmanifest.xml");
    let candidateEntries = [];

    if (manifestEntry) {
      const manifestText = await archive.readText(manifestEntry);
      const manifestDoc = parseXml(manifestText, "imsmanifest.xml");
      const hrefs = selfAssessmentHrefsFromManifest(manifestDoc);
      for (const href of hrefs) {
        const entry = archive.findEntry(href);
        if (entry) candidateEntries.push(entry);
        else state.warnings.push(`Manifest references ${href}, but that file was not found in the ZIP.`);
      }
    }

    if (!candidateEntries.length) {
      candidateEntries = archive.entries.filter(entry => /(^|\/)selfassess_d2l_.*\.xml$/i.test(entry.name));
      if (!manifestEntry) state.warnings.push("No imsmanifest.xml was found. Self-Assessments were discovered by filename instead.");
    }

    const unique = [...new Map(candidateEntries.map(e => [e.name, e])).values()];
    const results = [];
    for (const entry of unique) {
      const text = await archive.readText(entry);
      results.push(parseSelfAssessment(text, entry.name));
    }
    return results;
  }

  function selfAssessmentHrefsFromManifest(doc) {
    const resources = [...doc.getElementsByTagNameNS("*", "resource")];
    return resources
      .filter(resource => {
        const materialType = resource.getAttributeNS(D2L_NS, "material_type") || resource.getAttribute("d2l_2p0:material_type");
        return materialType === "d2lselfassess";
      })
      .map(resource => resource.getAttribute("href"))
      .filter(Boolean)
      .map(normalizePath);
  }

  function findLooseFile(byName, href) {
    const normalized = normalizePath(href);
    if (byName.has(normalized)) return byName.get(normalized);
    const basename = normalized.split("/").pop();
    const matches = [...byName.entries()].filter(([name]) => name.split("/").pop() === basename);
    return matches.length === 1 ? matches[0][1] : null;
  }

  function parseSelfAssessment(xmlText, sourceName) {
    const doc = parseXml(xmlText, sourceName);
    const assessment = firstByLocalName(doc, "assessment");
    if (!assessment) throw new Error(`${sourceName}: no <assessment> element was found.`);

    const title = assessment.getAttribute("title") || sourceName.replace(/\.xml$/i, "");
    const sections = [...assessment.getElementsByTagName("section")];
    const container = sections.find(s => s.getAttribute("ident") === "CONTAINER_SECTION");
    if (!container) throw new Error(`${sourceName}: no CONTAINER_SECTION was found.`);

    const items = [...container.getElementsByTagName("item")];
    const questions = items.map((item, index) => ({
      index,
      node: item,
      type: getQuestionType(item),
      fingerprint: fingerprint(item),
      references: extractLocalReferences(item)
    }));

    return { sourceName, title, doc, questions };
  }

  function renderAnalysis() {
    const totalQuestions = state.assessments.reduce((sum, a) => sum + a.questions.length, 0);
    sourceSummary.textContent = `${state.sourceName}: ${state.assessments.length} Self-Assessment${state.assessments.length === 1 ? "" : "s"}, ${totalQuestions} question${totalQuestions === 1 ? "" : "s"}.`;

    assessmentList.innerHTML = "";
    state.assessments.forEach(assessment => {
      const typeCounts = countTypes(assessment.questions);
      const card = document.createElement("article");
      card.className = "assessment-card";
      const left = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = assessment.title;
      const source = document.createElement("p");
      source.textContent = assessment.sourceName;
      const chips = document.createElement("div");
      chips.className = "type-list";
      for (const [type, count] of Object.entries(typeCounts)) {
        const chip = document.createElement("span");
        chip.className = "type-chip";
        chip.textContent = `${type}: ${count}`;
        chips.appendChild(chip);
      }
      left.append(title, source, chips);
      const count = document.createElement("div");
      count.className = "question-count";
      count.textContent = `${assessment.questions.length} question${assessment.questions.length === 1 ? "" : "s"}`;
      card.append(left, count);
      assessmentList.appendChild(card);
    });

    analysisWarnings.innerHTML = "";
    state.warnings.forEach(w => showMessage(analysisWarnings, w, "warning"));
  }

  async function convertAndPackage() {
    convertButton.disabled = true;
    resultPanel.classList.remove("hidden");
    resultMessages.innerHTML = "";
    validationList.innerHTML = "";
    downloadLink.classList.add("hidden");
    setStatus(resultStatus, "Converting…", "");

    try {
      const { manifestXml, questionDbXml, mappings } = buildQuestionLibrary(state.assessments);
      const validation = validateConversion(state.assessments, manifestXml, questionDbXml, mappings);
      renderValidation(validation.checks);

      if (!validation.ok) {
        setStatus(resultStatus, "Validation failed", "error");
        showMessage(resultMessages, "The package was not generated because one or more validation checks failed.", "error");
        convertButton.disabled = false;
        return;
      }

      const zipBlob = createStoredZip([
        { name: "imsmanifest.xml", text: manifestXml },
        { name: "questiondb.xml", text: questionDbXml }
      ]);

      // Validate the ZIP we are actually returning.
      const outputFile = new File([zipBlob], OUTPUT_NAME, { type: "application/zip" });
      const zipCheck = new SelectiveZipReader(outputFile);
      await zipCheck.init();
      const manifestEntry = zipCheck.findEntry("imsmanifest.xml");
      const questionEntry = zipCheck.findEntry("questiondb.xml");
      if (!manifestEntry || !questionEntry) throw new Error("Final ZIP validation failed: required XML files were not found at ZIP root.");
      parseXml(await zipCheck.readText(manifestEntry), "final imsmanifest.xml");
      parseXml(await zipCheck.readText(questionEntry), "final questiondb.xml");

      if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
      state.outputUrl = URL.createObjectURL(zipBlob);
      downloadLink.href = state.outputUrl;
      downloadLink.classList.remove("hidden");
      setStatus(resultStatus, "Package passed local validation", "success");
    } catch (error) {
      console.error(error);
      setStatus(resultStatus, "Error", "error");
      showMessage(resultMessages, error.message || String(error), "error");
    } finally {
      convertButton.disabled = false;
    }
  }

  function buildQuestionLibrary(assessments) {
    const outDoc = parseXml(`${XML_DEC}<questestinterop xmlns:d2l_2p0="${D2L_NS}"><objectbank ident="QLIB_1"></objectbank></questestinterop>`, "generated Question Library scaffold");
    const objectBank = firstByLocalName(outDoc, "objectbank");
    const mappings = [];
    let sectionId = 1;
    let itemId = 1001;

    assessments.forEach((assessment, assessmentIndex) => {
      const section = outDoc.createElement("section");
      section.setAttributeNS(D2L_NS, "d2l_2p0:id", String(sectionId++));
      section.setAttribute("ident", `SECT_SELFASSESS_${assessmentIndex + 1}`);
      section.setAttribute("title", assessment.title);

      section.appendChild(createSectionPresentation(outDoc));
      section.appendChild(createSectionExtension(outDoc));

      assessment.questions.forEach(question => {
        const copied = outDoc.importNode(question.node, true);
        copied.setAttributeNS(D2L_NS, "d2l_2p0:id", String(itemId++));
        removeIdentityMetadata(copied);
        section.appendChild(copied);
        mappings.push({ assessmentIndex, questionIndex: question.index, source: question.node, copied });
      });

      objectBank.appendChild(section);
    });

    const questionDbXml = serializeXml(outDoc);
    const manifestXml = `${XML_DEC}\n<manifest identifier="MANIFEST_SELFASSESS_QUESTION_LIBRARY" xmlns:d2l_2p0="${D2L_NS}" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources><resource identifier="res_question_library" type="webcontent" d2l_2p0:material_type="d2lquestionlibrary" d2l_2p0:link_target="" href="questiondb.xml" title="Question Library" /></resources></manifest>`;

    return { manifestXml, questionDbXml, mappings };
  }

  function createSectionPresentation(doc) {
    const presentation = doc.createElement("presentation_material");
    const flow1 = doc.createElement("flow_mat");
    const flow2 = doc.createElement("flow_mat");
    const material = doc.createElement("material");
    const mattext = doc.createElement("mattext");
    mattext.setAttribute("texttype", "text/plain");
    material.appendChild(mattext);
    flow2.appendChild(material);
    flow1.appendChild(flow2);
    presentation.appendChild(flow1);
    return presentation;
  }

  function createSectionExtension(doc) {
    const extension = doc.createElement("sectionproc_extension");
    const displayName = doc.createElementNS(D2L_NS, "d2l_2p0:display_section_name");
    displayName.textContent = "no";
    const displayLine = doc.createElementNS(D2L_NS, "d2l_2p0:display_section_line");
    displayLine.textContent = "no";
    const typeDisplay = doc.createElementNS(D2L_NS, "d2l_2p0:type_display_section");
    typeDisplay.textContent = "0";
    extension.append(displayName, displayLine, typeDisplay);
    return extension;
  }

  function removeIdentityMetadata(item) {
    const fields = [...item.getElementsByTagName("qti_metadatafield")];
    fields.forEach(field => {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const value = label ? label.textContent.trim() : "";
      if (value === "qmd_globalid" || value === "qmd_displayid") field.remove();
    });
  }

  function validateConversion(assessments, manifestXml, questionDbXml) {
    const checks = [];
    const pass = message => checks.push({ status: "pass", message });
    const fail = message => checks.push({ status: "fail", message });

    let manifestDoc;
    let questionDoc;
    try { manifestDoc = parseXml(manifestXml, "generated imsmanifest.xml"); pass("Generated imsmanifest.xml is well-formed XML."); }
    catch (e) { fail(e.message); }
    try { questionDoc = parseXml(questionDbXml, "generated questiondb.xml"); pass("Generated questiondb.xml is well-formed XML."); }
    catch (e) { fail(e.message); }

    if (!manifestDoc || !questionDoc) return { ok: false, checks };

    const resources = [...manifestDoc.getElementsByTagNameNS("*", "resource")];
    const qResource = resources.find(r => (r.getAttributeNS(D2L_NS, "material_type") || r.getAttribute("d2l_2p0:material_type")) === "d2lquestionlibrary");
    if (qResource && qResource.getAttribute("href") === "questiondb.xml") pass("Manifest contains a Question Library resource pointing to questiondb.xml.");
    else fail("Manifest Question Library resource is missing or does not point to questiondb.xml.");

    const root = questionDoc.documentElement;
    const objectBank = directChildren(root).find(e => e.localName === "objectbank");
    if (root.localName === "questestinterop" && objectBank) pass("Question Library hierarchy begins questestinterop > objectbank.");
    else fail("Required questestinterop > objectbank hierarchy is missing.");

    if (!objectBank) return { ok: false, checks };
    const sections = directChildren(objectBank).filter(e => e.localName === "section");
    if (sections.length === assessments.length) pass(`Created ${sections.length} Question Library folder${sections.length === 1 ? "" : "s"}, matching the source.`);
    else fail(`Expected ${assessments.length} Question Library folders but generated ${sections.length}.`);

    let structureOk = true;
    assessments.forEach((assessment, aIndex) => {
      const section = sections[aIndex];
      if (!section) { structureOk = false; return; }
      if (section.getAttribute("title") !== assessment.title) structureOk = false;
      const outItems = directChildren(section).filter(e => e.localName === "item");
      if (outItems.length !== assessment.questions.length) structureOk = false;

      assessment.questions.forEach((sourceQuestion, qIndex) => {
        const outItem = outItems[qIndex];
        if (!outItem) { structureOk = false; return; }
        const sourceFp = sourceQuestion.fingerprint;
        const outputFp = fingerprint(outItem);
        if (!fingerprintsMatch(sourceFp, outputFp)) structureOk = false;
        if (containsIdentityMetadata(outItem)) structureOk = false;
        if (!arraysEqual(sourceQuestion.references, extractLocalReferences(outItem))) structureOk = false;
      });
    });

    if (structureOk) pass("Every folder title, question count, question type, response structure, answer processing, feedback structure, and local src/href reference matches the source.");
    else fail("One or more migrated questions differ structurally from the source.");

    const allSectionsAndItems = [
      ...sections,
      ...sections.flatMap(section => directChildren(section).filter(e => e.localName === "item"))
    ];
    const ids = allSectionsAndItems.map(node => node.getAttributeNS(D2L_NS, "id") || node.getAttribute("d2l_2p0:id"));
    if (ids.every(Boolean) && new Set(ids).size === ids.length) pass("Every generated section and question has a unique d2l_2p0:id.");
    else fail("Generated section/question d2l_2p0:id values are missing or duplicated.");

    if (!questionDbXml.includes('xmlns:ns0="http://www.w3.org/2000/xmlns/"') && !questionDbXml.includes("ns0:d2l_2p0=")) pass("No known invalid XML namespace serialization was found.");
    else fail("Invalid XML namespace serialization was detected.");

    const total = assessments.reduce((sum, a) => sum + a.questions.length, 0);
    const outTotal = sections.reduce((sum, section) => sum + directChildren(section).filter(e => e.localName === "item").length, 0);
    if (total === outTotal) pass(`All ${total} source questions are present in the output.`);
    else fail(`Source has ${total} questions but output has ${outTotal}.`);

    return { ok: checks.every(c => c.status !== "fail"), checks };
  }

  function fingerprint(item) {
    const tagCounts = [
      "presentation", "resprocessing", "hint", "itemfeedback",
      "response_lid", "response_str", "response_num", "response_label",
      "respcondition", "varequal", "setvar"
    ].reduce((acc, name) => {
      acc[name] = countByLocalName(item, name);
      return acc;
    }, {});

    return {
      type: getQuestionType(item),
      counts: tagCounts,
      mattext: [...item.getElementsByTagName("mattext")].map(n => n.textContent)
    };
  }

  function fingerprintsMatch(a, b) {
    if (a.type !== b.type) return false;
    for (const key of Object.keys(a.counts)) if (a.counts[key] !== b.counts[key]) return false;
    return arraysEqual(a.mattext, b.mattext);
  }

  function containsIdentityMetadata(item) {
    return [...item.getElementsByTagName("qti_metadatafield")].some(field => {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const value = label ? label.textContent.trim() : "";
      return value === "qmd_globalid" || value === "qmd_displayid";
    });
  }

  function getQuestionType(item) {
    for (const field of [...item.getElementsByTagName("qti_metadatafield")]) {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const entry = [...field.children].find(child => child.localName === "fieldentry");
      if (label?.textContent.trim() === "qmd_questiontype") return entry?.textContent.trim() || "Unknown";
    }
    return "Unknown";
  }

  function extractLocalReferences(item) {
    const refs = [];
    for (const mattext of [...item.getElementsByTagName("mattext")]) {
      const text = mattext.textContent || "";
      const regex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
      let match;
      while ((match = regex.exec(text))) {
        const value = match[1];
        if (!/^(?:https?:|data:|mailto:|tel:|#)/i.test(value)) refs.push(value);
      }
    }
    return refs;
  }

  function countTypes(questions) {
    return questions.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {});
  }

  function countByLocalName(root, localName) {
    return [...root.getElementsByTagName("*")].filter(n => n.localName === localName).length;
  }

  function directChildren(node) {
    return [...node.children];
  }

  function firstByLocalName(root, name) {
    return [...root.getElementsByTagName("*")].find(n => n.localName === name) || null;
  }

  function parseXml(text, name = "XML") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const parserError = doc.getElementsByTagName("parsererror")[0];
    if (parserError) throw new Error(`${name}: invalid XML (${parserError.textContent.replace(/\s+/g, " ").trim()}).`);
    return doc;
  }

  function serializeXml(doc) {
    const serialized = new XMLSerializer().serializeToString(doc);
    return serialized.startsWith("<?xml") ? serialized : `${XML_DEC}\n${serialized}`;
  }

  function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  }

  function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function renderValidation(checks) {
    validationList.innerHTML = "";

    const manifestPassed = checks.some(check =>
      check.status === "pass" &&
      check.message === "Generated imsmanifest.xml is well-formed XML."
    );

    const questionDbPassed = checks.some(check =>
      check.status === "pass" &&
      check.message === "Generated questiondb.xml is well-formed XML."
    );

    if (manifestPassed) addValidationRow("Generated imsmanifest.xml", "pass");
    if (questionDbPassed) addValidationRow("Generated questiondb.xml", "pass");
  }

  function addValidationRow(message, status) {
    const row = document.createElement("div");
    row.className = `validation-row ${status}`;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = status === "pass" ? "✓" : status === "warn" ? "!" : "×";
    const text = document.createElement("span");
    text.textContent = message;
    row.append(icon, text);
    validationList.appendChild(row);
  }

  function showMessage(container, text, kind = "info") {
    const div = document.createElement("div");
    div.className = `message ${kind}`;
    div.textContent = text;
    container.appendChild(div);
  }

  function setStatus(element, text, kind) {
    element.textContent = text;
    element.className = "status-pill" + (kind ? ` ${kind}` : "");
  }

  function resetOutputOnly() {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    resultPanel.classList.add("hidden");
    downloadLink.classList.add("hidden");
    downloadLink.removeAttribute("href");
  }

  function resetApp() {
    resetOutputOnly();
    state = freshState();
    fileInput.value = "";
    analysisPanel.classList.add("hidden");
    assessmentList.innerHTML = "";
    analysisWarnings.innerHTML = "";
    resetButton.disabled = true;
    convertButton.disabled = true;
  }

  // Selective ZIP reader: reads only the central directory and entries requested.
  // Supports the standard ZIP format (sufficient for Brightspace's <= 2 GB packages),
  // stored entries (method 0), and Deflate entries (method 8).
  class SelectiveZipReader {
    constructor(file) {
      this.file = file;
      this.entries = [];
    }

    async init() {
      const tailLength = Math.min(this.file.size, 65557);
      const tailStart = this.file.size - tailLength;
      const tail = new Uint8Array(await this.file.slice(tailStart).arrayBuffer());
      const eocdPos = findSignatureBackwards(tail, 0x06054b50);
      if (eocdPos < 0) throw new Error(`${this.file.name}: ZIP end-of-central-directory record was not found.`);

      const view = new DataView(tail.buffer, tail.byteOffset + eocdPos);
      const totalEntries = view.getUint16(10, true);
      const centralSize = view.getUint32(12, true);
      const centralOffset = view.getUint32(16, true);
      if (centralOffset === 0xffffffff || centralSize === 0xffffffff || totalEntries === 0xffff) {
        throw new Error("ZIP64 packages are not supported. Brightspace packages under 2 GB should normally use the standard ZIP format.");
      }

      const central = new Uint8Array(await this.file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
      let offset = 0;
      for (let i = 0; i < totalEntries; i++) {
        if (readU32(central, offset) !== 0x02014b50) throw new Error(`${this.file.name}: invalid ZIP central directory.`);
        const flags = readU16(central, offset + 8);
        const method = readU16(central, offset + 10);
        const crc = readU32(central, offset + 16);
        const compressedSize = readU32(central, offset + 20);
        const uncompressedSize = readU32(central, offset + 24);
        const nameLength = readU16(central, offset + 28);
        const extraLength = readU16(central, offset + 30);
        const commentLength = readU16(central, offset + 32);
        const localOffset = readU32(central, offset + 42);
        const nameBytes = central.slice(offset + 46, offset + 46 + nameLength);
        const name = normalizePath(new TextDecoder("utf-8").decode(nameBytes));
        this.entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
      }
    }

    findEntry(path) {
      const normalized = normalizePath(path);
      const exact = this.entries.find(e => e.name === normalized);
      if (exact) return exact;
      const basename = normalized.split("/").pop();
      const matches = this.entries.filter(e => e.name.split("/").pop() === basename);
      return matches.length === 1 ? matches[0] : null;
    }

    async readText(entry) {
      const bytes = await this.readBytes(entry);
      return new TextDecoder("utf-8").decode(bytes);
    }

    async readBytes(entry) {
      if (entry.flags & 0x0001) throw new Error(`${entry.name}: encrypted ZIP entries are not supported.`);
      const localHeader = new Uint8Array(await this.file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      if (readU32(localHeader, 0) !== 0x04034b50) throw new Error(`${entry.name}: invalid ZIP local header.`);
      const nameLength = readU16(localHeader, 26);
      const extraLength = readU16(localHeader, 28);
      const dataStart = entry.localOffset + 30 + nameLength + extraLength;
      const compressedBlob = this.file.slice(dataStart, dataStart + entry.compressedSize);

      if (entry.method === 0) return new Uint8Array(await compressedBlob.arrayBuffer());
      if (entry.method === 8) {
        if (typeof DecompressionStream === "undefined") throw new Error("This browser does not provide DecompressionStream, which is required to read compressed Brightspace ZIP files.");
        let stream;
        try {
          stream = compressedBlob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        } catch {
          throw new Error("This browser cannot decompress standard ZIP Deflate entries. Use a current Chromium-based browser.");
        }
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}.`);
    }
  }

  function findSignatureBackwards(bytes, signature) {
    for (let i = bytes.length - 4; i >= 0; i--) if (readU32(bytes, i) === signature) return i;
    return -1;
  }

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  // Creates a standards-compliant ZIP using the STORE method (no compression).
  // The output contains only the two small XML files, so compression is unnecessary.
  function createStoredZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const { dosDate, dosTime } = toDosDateTime(now);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let centralSize = 0;

    files.forEach(file => {
      const nameBytes = encoder.encode(file.name);
      const data = encoder.encode(file.text);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      centralSize += central.length;
      localOffset += local.length + data.length;
    });

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, localOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: "application/zip" });
  }

  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate, dosTime };
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Exposed for a lightweight browser test harness and future modularization.
  window.SAQL = {
    parseXml,
    parseSelfAssessment,
    buildQuestionLibrary,
    validateConversion,
    createStoredZip,
    SelectiveZipReader
  };
})();
